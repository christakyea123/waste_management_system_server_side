const PDFDocument = require('pdfkit');
const Invoice = require('../models/Invoice');
const Customer = require('../models/Customer');
const Collection = require('../models/Collection');
const logger = require('../utils/logger');
const smsService = require('./sms.service');
// Lazy require to avoid the schedule <-> invoice circular at module load.
let _schedule;
const pickupsPerMonth = (freq) => {
  if (!_schedule) _schedule = require('./schedule.service');
  return _schedule.pickupsPerMonth(freq);
};

class InvoiceService {
  // Ensure a single monthly subscription invoice exists for a customer/month.
  //
  // Billing model (per owner): the customer pays the full plan fee for the
  // month as a subscription — whether or not pickups actually happen, like any
  // monthly plan. The invoice is created UP FRONT (on registration and on the
  // 1st of each month) so payment is never delayed waiting for month-end.
  //
  // Idempotent: one invoice per {customer, month, year}. Returns the invoice
  // (existing or newly created).
  async ensureMonthlyInvoice(customerId, month, year) {
    try {
      const existing = await Invoice.findOne({ customer: customerId, month, year });
      if (existing) return existing;

      const customer = await Customer.findById(customerId);
      if (!customer) return null;

      const dueDay = parseInt(process.env.BILLING_DUE_DAY) || 25;
      let dueDate = new Date(year, month - 1, dueDay);
      // If we're creating this invoice after the due day has already passed
      // (e.g. someone registers on the 28th), give them 7 days rather than a
      // due date in the past.
      const now = new Date();
      if (dueDate < now) dueDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });

      const invoice = await Invoice.create({
        customer: customer._id,
        month,
        year,
        amount: customer.monthlyFee,
        dueDate,
        description: `Waste collection service for ${monthName} ${year}`,
      });

      logger.info(`Monthly invoice ${invoice.invoiceNumber} created for ${customer.customerId} (${monthName} ${year}, GHS ${(customer.monthlyFee || 0).toFixed(2)})`);
      return invoice;
    } catch (err) {
      // Likely a duplicate from a race — re-fetch whatever's there.
      logger.error(`ensureMonthlyInvoice(${customerId}, ${month}, ${year}) failed: ${err.message}`);
      return Invoice.findOne({ customer: customerId, month, year });
    }
  }

  // Recalculate the informational pickup counters on a month's invoice from the
  // actual Collection rows. Called after a driver marks a pickup picked/missed
  // so the invoice card on the customer dashboard reflects reality. Does NOT
  // change the amount — billing is a flat monthly subscription.
  async refreshInvoiceCounters(customerId, month, year) {
    const invoice = await Invoice.findOne({ customer: customerId, month, year });
    if (!invoice) return null;
    const collections = await Collection.find({ customer: customerId, month, year }).select('status');
    invoice.collectionsCount = collections.filter((c) => c.status === 'picked').length;
    invoice.missedCount = collections.filter((c) => c.status === 'missed').length;
    await invoice.save();
    return invoice;
  }

  // Startup safety net: make sure every active customer has the current month's
  // subscription invoice, so a customer who registered before this billing model
  // (or whose registration invoice failed) still has something to pay. Cheap and
  // idempotent — skips anyone who already has this month's invoice.
  async backfillMissingInvoices() {
    try {
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();
      const customers = await Customer.find({
        accountStatus: { $in: ['active', 'pending'] },
      }).select('_id customerId');

      let created = 0;
      for (const c of customers) {
        const existing = await Invoice.findOne({ customer: c._id, month, year }).select('_id');
        if (existing) continue;
        const made = await this.ensureMonthlyInvoice(c._id, month, year);
        if (made) created++;
      }
      if (created > 0) logger.info(`Backfilled ${created} missing monthly invoice(s) for ${month}/${year}`);
      return created;
    } catch (err) {
      logger.error(`backfillMissingInvoices failed: ${err.message}`);
      return 0;
    }
  }

  // Generate the monthly subscription invoice for every active customer. Run by
  // the 1st-of-month cron. Idempotent — ensureMonthlyInvoice skips anyone who
  // already has an invoice for the period.
  async generateMonthlyInvoices(month, year) {
    try {
      const customers = await Customer.find({ accountStatus: 'active' }).select('_id customerId');
      const results = { created: 0, skipped: 0, errors: 0 };

      for (const c of customers) {
        try {
          const existing = await Invoice.findOne({ customer: c._id, month, year }).select('_id');
          if (existing) { results.skipped++; continue; }
          const made = await this.ensureMonthlyInvoice(c._id, month, year);
          if (made) results.created++;
          else results.errors++;
        } catch (err) {
          logger.error(`Failed to create monthly invoice for customer ${c.customerId}: ${err.message}`);
          results.errors++;
        }
      }

      logger.info(`Monthly invoice generation: ${JSON.stringify(results)}`);
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
      .populate({ path: 'customer', populate: { path: 'user' } });
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

        // Header
        doc.fontSize(22).fillColor('#2E7D32').text('035 F Arkoh Waste Management', { align: 'center' });
        doc.fontSize(12).fillColor('#666').text('Professional Waste Collection Services', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#2E7D32').stroke();
        doc.moveDown(1);

        // Invoice title
        doc.fontSize(20).fillColor('#333').text('MONTHLY INVOICE', { align: 'center' });
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
        if (customer.user.email) doc.text(customer.user.email);
        doc.text(customer.user.phone || 'N/A');
        doc.text(customer.residentialAddress || 'N/A');
        if (customer.area) doc.text(`Area: ${customer.area}`);
        doc.text(`Customer ID: ${customer.customerId}`);
        doc.moveDown(1);

        // Service details
        doc.fontSize(12).fillColor('#2E7D32').text('SERVICE DETAILS');
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
        doc.moveDown(0.3);

        const frequency = customer.collectionSchedule?.frequency || 'weekly';
        const ppm = pickupsPerMonth(frequency);

        doc.fontSize(10).fillColor('#333');
        doc.text(`Service Period: ${monthName} ${invoice.year}`, 50, doc.y);
        doc.text(`Bin Type: ${customer.binType?.toUpperCase() || 'STANDARD'}`, 50);
        doc.text(`Plan Frequency: ${frequency} (${ppm} pickup${ppm === 1 ? '' : 's'} / month)`, 50);
        doc.text(`Scheduled Pickups: ${ppm}`, 50);
        doc.text(`Completed Pickups: ${invoice.collectionsCount || 0}`, 50);
        doc.text(`Missed Pickups: ${invoice.missedCount || 0}`, 50);
        doc.moveDown(1);

        // Amount breakdown
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
        doc.moveDown(0.5);

        const baseAmount = invoice.amount || 0;
        const lateFee = invoice.lateFee || 0;
        const discount = invoice.discount || 0;
        const total = invoice.totalAmount || baseAmount;

        doc.fontSize(11);
        doc.text(`Monthly Subscription:`, 300, doc.y, { continued: true });
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
