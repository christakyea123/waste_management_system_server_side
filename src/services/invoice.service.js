const PDFDocument = require('pdfkit');
const Invoice = require('../models/Invoice');
const Customer = require('../models/Customer');
const Collection = require('../models/Collection');
const User = require('../models/User');
const logger = require('../utils/logger');
const smsService = require('./sms.service');

class InvoiceService {
  // Generate monthly invoices for all active customers
  async generateMonthlyInvoices(month, year) {
    try {
      const customers = await Customer.find({ accountStatus: 'active' }).populate('user');
      const results = { created: 0, skipped: 0, errors: 0 };

      for (const customer of customers) {
        try {
          const existing = await Invoice.findOne({ customer: customer._id, month, year });
          if (existing) { results.skipped++; continue; }

          const dueDay = parseInt(process.env.BILLING_DUE_DAY) || 25;
          const dueDate = new Date(year, month - 1, dueDay);

          const collections = await Collection.find({
            customer: customer._id,
            month,
            year,
          });

          const collectedCount = collections.filter((c) => c.status === 'picked').length;
          const missedCount = collections.filter((c) => c.status === 'missed').length;
          const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long' });

          await Invoice.create({
            customer: customer._id,
            month,
            year,
            amount: customer.monthlyFee,
            dueDate,
            collectionsCount: collectedCount,
            missedCount,
            description: `Waste collection service for ${monthName} ${year}`,
          });

          results.created++;
        } catch (err) {
          logger.error(`Failed to create invoice for customer ${customer.customerId}: ${err.message}`);
          results.errors++;
        }
      }

      logger.info(`Monthly invoices generated: ${JSON.stringify(results)}`);
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
    const invoice = await Invoice.findById(invoiceId).populate({
      path: 'customer',
      populate: { path: 'user' },
    });
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
        doc.fontSize(24).fillColor('#2E7D32').text('WASTE MANAGEMENT SYSTEM', { align: 'center' });
        doc.fontSize(12).fillColor('#666').text('Professional Waste Collection Services', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#2E7D32').stroke();
        doc.moveDown(1);

        // Invoice title
        doc.fontSize(20).fillColor('#333').text('INVOICE', { align: 'center' });
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

        // Service details table
        doc.fontSize(12).fillColor('#2E7D32').text('SERVICE DETAILS');
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
        doc.moveDown(0.3);

        doc.fontSize(10).fillColor('#333');
        doc.text(`Service Period: ${monthName} ${invoice.year}`, 50, doc.y);
        doc.text(`Bin Type: ${customer.binType?.toUpperCase() || 'BASIC'}`, 50);
        doc.text(`Scheduled Collections: ${invoice.collectionsCount || 0}`, 50);
        doc.text(`Missed Collections: ${invoice.missedCount || 0}`, 50);
        doc.moveDown(1);

        // Amount breakdown
        doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
        doc.moveDown(0.5);

        const baseAmount = invoice.amount || 0;
        const lateFee = invoice.lateFee || 0;
        const discount = invoice.discount || 0;
        const total = invoice.totalAmount || baseAmount;

        doc.fontSize(11);
        doc.text(`Base Amount:`, 300, doc.y, { continued: true });
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
        doc.text('Payment can be made online at wastemanagement.com/pay', { align: 'center' });
        doc.text('Thank you for your business!', { align: 'center' });

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = new InvoiceService();
