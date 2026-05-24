const cron = require('node-cron');
const logger = require('./logger');
const invoiceService = require('../services/invoice.service');
const scheduleService = require('../services/schedule.service');

const initScheduler = () => {
  // One-time backfill on startup: create invoices for any past collections that
  // never got billed (e.g. mid-month registrations before the 1st-of-month cron).
  invoiceService
    .backfillMissingInvoices()
    .catch((err) => logger.error(`Startup invoice backfill failed: ${err.message}`));

  // Startup: materialise the rolling pickup window for every active customer
  // with a driver. Idempotent — skips dates that already have a Collection row.
  scheduleService
    .generateForAll()
    .catch((err) => logger.error(`Startup auto-schedule failed: ${err.message}`));

  // Daily at 1 AM Ghana time: extend the rolling window so drivers always have
  // ~30 days of upcoming work materialised. Cheap because of the idempotent skip.
  cron.schedule('0 1 * * *', async () => {
    logger.info('Running daily auto-schedule extension...');
    try {
      const r = await scheduleService.generateForAll();
      logger.info(`Auto-schedule extension: ${r.created} new pickups across ${r.customers} customers`);
    } catch (err) {
      logger.error(`Auto-schedule cron failed: ${err.message}`);
    }
  });

  // Generate monthly invoices on the 1st of every month at 6 AM
  cron.schedule('0 6 1 * *', async () => {
    logger.info('Running monthly invoice generation...');
    try {
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();
      const result = await invoiceService.generateMonthlyInvoices(month, year);
      logger.info(`Monthly invoices generated: ${JSON.stringify(result)}`);
    } catch (err) {
      logger.error(`Invoice generation cron failed: ${err.message}`);
    }
  });

  // Mark overdue invoices daily at midnight
  cron.schedule('0 0 * * *', async () => {
    logger.info('Checking for overdue invoices...');
    try {
      const count = await invoiceService.markOverdueInvoices();
      logger.info(`Marked ${count} invoices as overdue`);
    } catch (err) {
      logger.error(`Overdue check cron failed: ${err.message}`);
    }
  });

  // Send payment reminders daily at 9 AM
  cron.schedule('0 9 * * *', async () => {
    logger.info('Sending payment reminders...');
    try {
      const sent = await invoiceService.sendPaymentReminders();
      logger.info(`Payment reminders sent: ${sent}`);
    } catch (err) {
      logger.error(`Payment reminder cron failed: ${err.message}`);
    }
  });

  logger.info('Cron scheduler initialized');
};

module.exports = { initScheduler };
