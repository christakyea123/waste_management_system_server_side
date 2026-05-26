const PDFDocument = require('pdfkit');
const Invoice = require('../models/Invoice');
const Customer = require('../models/Customer');
const Collection = require('../models/Collection');
const logger = require('../utils/logger');
const smsService = require('./sms.service');
const { pickupsPerMonth } = (() => {
  // Lazy require to avoid the schedule <-> invoice circular at module load.
  let cached;
  return {
    pickupsPerMonth: (freq) => {
      if (!cached) cached = require('./schedule.service');
      return cached.pickupsPerMonth(freq);
    },
  };
})();

// Round to 2dp without trailing FP noise (e.g. 16.6666... -> 16.67).
const money = (n) => Math.round(n * 100) / 100;

// Compute the per-pickup price for a customer based on their plan.
// monthlyFee / pickupsPerMonth(frequency). Falls back to monthlyFee if frequency
// is missing or unrecognised so we never bill a customer 0.
const perPickupAmount = (customer) => {
  const freq = customer?.collectionSchedule?.frequency;
  const count = pickupsPerMonth(freq);
  const fee = customer?.monthlyFee || 0;
  if (!count || count <= 0) return money(fee);
  return money(fee / count);
};

class InvoiceService {
  // Ensure a per-pickup invoice exists for the given Collection. Called every
  // time a Collection row is created (auto-scheduler, admin create, bulk create)
  // so the customer dashboard always has a bill per pickup, priced at
  // plan.monthlyFee / plan.pickupsPerMonth. Returns the invoice (existing or new).
  async ensurePickupInvoice(collection) {
    try {
      if (!collection || !collection._id) return null;

      const existing = await Invoice.findOne({ pickup: collection._id });
      if (existing) return existing;

      const customer = await Customer.findById(collection.customer);
      if (!customer) return null;

      const dueDay = parseInt(process.env.BILLING_DUE_DAY) || 25;
      // Due on the billing day of the pickup's month, but never before the
      // pickup itself (mid-month registration shouldn't backdate the due date).
      const pickupDate = new Date(collection.scheduledDate);
      const month = collection.month || pickupDate.getMonth() + 1;
      const year = collection.year || pickupDate.getFullYear();
      let dueDate = new Date(year, month - 1, dueDay);
      if (dueDate < pickupDate) dueDate = new Date(pickupDate.getTime() + 7 * 24 * 60 * 60 * 1000);

      const amount = perPickupAmount(customer);
      const pickupLabel = pickupDate.toLocaleDateString('en-GH', { year: 'numeric', month: 'short', day: 'numeric' });

      const invoice = await Invoice.create({
        customer: customer._id,
        pickup: collection._id,
        month,
        year,
        amount,
        dueDate,
        description: `Waste collection pickup on ${pickupLabel}`,
      });

      logger.info(`Pickup invoice ${invoice.invoiceNumber} created for ${customer.customerId} (${pickupLabel}, GHS ${amount.toFixed(2)})`);
      return invoice;
    } catch (err) {
      // Likely a duplicate from a race on the unique {collection} index — re-fetch.
      logger.error(`ensurePickupInvoice(${collection?._id}) failed: ${err.message}`);
      if (collection?._id) return Invoice.findOne({ pickup: collection._id });
      return null;
    }
  }

  // Sync an existing pickup invoice's counter fields to the current Collection
  // status (e.g. picked → 1/0, missed → 0/1). Called after the driver updates
  // the pickup so the invoice card on the customer dashboard reflects reality.
  async syncPickupInvoice(collection) {
    if (!collection?._id) return null;
    const invoice = await Invoice.findOne({ pickup: collection._id });
    if (!invoice) return null;
    invoice.collectionsCount = collection.status === 'picked' ? 1 : 0;
    invoice.missedCount = collection.status === 'missed' ? 1 : 0;
    await invoice.save();
    return invoice;
  }

  // Walk every Collection and make sure each has a matching per-pickup invoice.
  // Used at startup to recover from rows created before per-pickup billing was
  // wired up.
  //
  // Production-safety guards (per-pickup billing was introduced after legacy
  // monthly invoices already existed in prod):
  //   1. BACKFILL_FROM env var — only backfill collections scheduled on or
  //      after this date (ISO YYYY-MM-DD). If unset, defaults to "now" so a
  //      fresh deploy never silently re-bills historical pickups.
  //   2. Skip any collection whose {customer, month, year} already has a paid
  //      monthly invoice — that money is already collected, creating a new
  //      per-pickup invoice would double-bill the customer.
  //
  // To deliberately backfill the entire history (e.g. on a clean dev DB), set
  // BACKFILL_FROM=1970-01-01.
  async backfillMissingInvoices() {
    try {
      const cutoff = process.env.BACKFILL_FROM
        ? new Date(process.env.BACKFILL_FROM)
        : new Date();
      if (isNaN(cutoff.getTime())) {
        logger.warn(`Invalid BACKFILL_FROM='${process.env.BACKFILL_FROM}' — skipping backfill for safety`);
        return 0;
      }
      // Use start-of-day so a date like '2026-05-26' includes pickups during that day.
      cutoff.setHours(0, 0, 0, 0);

      const collections = await Collection.find({
        scheduledDate: { $gte: cutoff },
      }).select('_id customer scheduledDate month year status');

      let created = 0;
      let skippedAlreadyPaid = 0;
      for (const c of collections) {
        const existing = await Invoice.findOne({ pickup: c._id });
        if (existing) continue;

        // Don't double-bill: if a paid monthly invoice already covers this
        // pickup's {customer, month, year}, skip it. Legacy monthly invoices
        // have pickup=null, so this filter naturally excludes any per-pickup
        // invoices that share the same month.
        const paidMonthly = await Invoice.findOne({
          customer: c.customer,
          month: c.month,
          year: c.year,
          status: 'paid',
          pickup: null,
        }).select('_id');
        if (paidMonthly) { skippedAlreadyPaid++; continue; }

        const made = await this.ensurePickupInvoice(c);
        if (made) {
          created++;
          await this.syncPickupInvoice(c);
        }
      }
      if (created > 0 || skippedAlreadyPaid > 0) {
        logger.info(`Backfill (from ${cutoff.toISOString().slice(0, 10)}): created ${created}, skipped ${skippedAlreadyPaid} already-paid month(s)`);
      }
      return created;
    } catch (err) {
      logger.error(`backfillMissingInvoices failed: ${err.message}`);
      return 0;
    }
  }

  // Sweep: ensure every scheduled pickup in the given month has its per-pickup
  // invoice. Kept for the 1st-of-month cron as a belt-and-suspenders against
  // any Collection that slipped through ensurePickupInvoice at creation time.
  async generateMonthlyInvoices(month, year) {
    try {
      const collections = await Collection.find({ month, year }).select('_id customer scheduledDate month year status');
      const results = { created: 0, skipped: 0, errors: 0 };

      for (const c of collections) {
        try {
          const existing = await Invoice.findOne({ pickup: c._id });
          if (existing) { results.skipped++; continue; }

          // Same double-bill guard as backfillMissingInvoices.
          const paidMonthly = await Invoice.findOne({
            customer: c.customer,
            month: c.month,
            year: c.year,
            status: 'paid',
            pickup: null,
          }).select('_id');
          if (paidMonthly) { results.skipped++; continue; }

          const made = await this.ensurePickupInvoice(c);
          if (made) {
            await this.syncPickupInvoice(c);
            results.created++;
          } else {
            results.errors++;
          }
        } catch (err) {
          logger.error(`Failed to create pickup invoice for collection ${c._id}: ${err.message}`);
          results.errors++;
        }
      }

      logger.info(`Monthly pickup invoice sweep: ${JSON.stringify(results)}`);
      return results;
    } catch (error) {
      logger.error(`generateMonthlyInvoices failed: ${error.message}`);
      throw error;
    }
  }

  // Mark overdue invoices
  async markOverdueInvoices() {
    const now = new Date();
    const result = await Invoice.updateMany(
      { status: 'pending', dueDate: { $lt: now } },
      { $set: { status: 'overdue' } }
    );
    logger.info(`Marked ${result.modifiedCount} invoices as overdue`);
    return result.modifiedCount;
  }

  // Send payment reminders for pending invoices
  async sendPaymentReminders() {
    const now = new Date();
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const invoices = await Invoice.find({
      status: { $in: ['pending', 'overdue'] },
      dueDate: { $lte: threeDaysFromNow },
    }).populate({
      path: 'customer',
      populate: { path: 'user' },
    });

    let sent = 0;
    for (const invoice of invoices) {
      try {
        if (!invoice.customer?.user) continue;
        const result = await smsService.sendPaymentReminder(
          invoice.customer.user,
          invoice.totalAmount || invoice.amount,
          invoice.dueDate,
          invoice.invoiceNumber
        );
        if (result.success) {
          invoice.remindersSent += 1;
          invoice.lastReminderDate = new Date();
          await invoice.save();
          sent++;
        }
      } catch (err) {
        logger.error(`Reminder failed for invoice ${invoice.invoiceNumber}: ${err.message}`);
      }
    }

    logger.info(`Payment reminders sent: ${sent}`);
    return sent;
  }

  // Generate PDF invoice
  async generatePDF(invoiceId) {
    const invoice = await Invoice.findById(invoiceId)
      .populate({ path: 'customer', populate: { path: 'user' } })
      .populate('pickup');
    if (!invoice) throw new Error('Invoice not found');

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const buffers = [];

        doc.on('data', (chunk) => buffers.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        const { customer } = invoice;
        const monthName = new Date(invoice.year, invoice.month - 1).toLocaleString('default', { month: 'long' });
        const pickupDate = invoice.pickup?.scheduledDate
          ? new Date(invoice.pickup.scheduledDate).toLocaleDateString('en-GH')
          : null;

        // Header
        doc.fontSize(22).fillColor('#2E7D32').text('035 F Arkoh Waste Management', { align: 'center' });
        doc.fontSize(12).fillColor('#666').text('Professional Waste Collection Services', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#2E7D32').stroke();
        doc.moveDown(1);

        // Invoice title
        doc.fontSize(20).fillColor('#333').text('PICKUP INVOICE', { align: 'center' });
        doc.moveDown(1);

        // Invoice details
        doc.fontSize(11).fillColor('#333');
        doc.text(`Invoice Number: ${invoice.invoiceNumber}`, 50);
        doc.text(`Date: ${new Date().toLocaleDateString('en-GH')}`);
        doc.text(`Due Date: ${new Date(invoice.dueDate).toLocaleDateString('en-GH')}`);
        doc.text(`Status: ${invoice.status.toUpperCase()}`);
        doc.moveDown(1);

        // Bill to
        doc.fontSize(12).fillColor('#2E7D32').text('BILL TO:', 50);
        doc.fontSize(11).fillColor('#333');
        doc.text(customer.user.fullName || 'N/A');
        doc.text(customer.user.email || 'N/A');
        doc.text(customer.user.phone || 'N/A');
        doc.text(customer.residentialAddress || 'N/A');
        doc.text(`Customer ID: ${customer.customerId}`);
        doc.moveDown(1);

        // Pickup details
        doc.fontSize(12).fillColor('#2E7D32').text('PICKUP DETAILS');
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
        doc.moveDown(0.3);

        const frequency = customer.collectionSchedule?.frequency || 'biweekly';
        const ppm = pickupsPerMonth(frequency);

        doc.fontSize(10).fillColor('#333');
        if (pickupDate) doc.text(`Pickup Date: ${pickupDate}`, 50, doc.y);
        doc.text(`Service Period: ${monthName} ${invoice.year}`, 50);
        doc.text(`Bin Type: ${customer.binType?.toUpperCase() || 'BASIC'}`, 50);
        doc.text(`Plan Frequency: ${frequency} (${ppm} pickup${ppm === 1 ? '' : 's'} / month)`, 50);
        doc.text(`Plan Monthly Fee: GHS ${(customer.monthlyFee || 0).toFixed(2)}`, 50);
        doc.text(`Status: ${invoice.pickup?.status || 'scheduled'}`, 50);
        doc.moveDown(1);

        // Amount breakdown
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
        doc.moveDown(0.5);

        const baseAmount = invoice.amount || 0;
        const lateFee = invoice.lateFee || 0;
        const discount = invoice.discount || 0;
        const total = invoice.totalAmount || baseAmount;

        doc.fontSize(11);
        doc.text(`Per-Pickup Amount:`, 300, doc.y, { continued: true });
        doc.text(`GHS ${baseAmount.toFixed(2)}`, { align: 'right' });
        if (lateFee > 0) {
          doc.text(`Late Fee:`, 300, doc.y, { continued: true });
          doc.text(`GHS ${lateFee.toFixed(2)}`, { align: 'right' });
        }
        if (discount > 0) {
          doc.text(`Discount:`, 300, doc.y, { continued: true });
          doc.text(`-GHS ${discount.toFixed(2)}`, { align: 'right' });
        }

        doc.moveTo(300, doc.y).lineTo(545, doc.y).strokeColor('#333').stroke();
        doc.moveDown(0.3);
        doc.fontSize(13).fillColor('#2E7D32');
        doc.text(`TOTAL:`, 300, doc.y, { continued: true });
        doc.text(`GHS ${total.toFixed(2)}`, { align: 'right' });
        doc.moveDown(2);

        // Footer
        doc.fontSize(10).fillColor('#666');
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
        doc.moveDown(0.5);
        doc.text('Thank you for your business!', { align: 'center' });

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = new InvoiceService();
