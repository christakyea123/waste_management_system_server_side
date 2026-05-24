const Collection = require('../models/Collection');
const Customer = require('../models/Customer');
const invoiceService = require('./invoice.service');
const logger = require('../utils/logger');

/**
 * Auto-scheduling service.
 *
 * Replaces the old "admin manually picks a date and bulk-creates" workflow.
 * Every active customer with an assigned driver has their pickups materialized
 * into Collection rows on a rolling window so:
 *   - The driver portal always shows the upcoming week of work.
 *   - The admin dashboard can render "today/tomorrow by driver" without any
 *     materialization at query time.
 *   - Counters (collectionsCount / missedCount on Invoice) update naturally
 *     when the driver marks rows picked/missed.
 *
 * Frequency mapping (see Customer.js BIN_FREQUENCY):
 *   biweekly      → twice a month  (anchor day, every 14 days)
 *   weekly        → once a week    (anchor day, every 7 days)
 *   twice_weekly  → twice a week   (anchor day + anchor+3 days, every 7 days)
 */

// Mongoose day enum is lowercase; JS Date.getDay() is 0=Sunday..6=Saturday.
const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

// Default rolling window. 30 days covers ~4 weeks for weekly, ~8 pickups for
// twice-weekly, ~2 pickups for biweekly — enough lookahead for the driver UI
// without blowing out the Collection collection between cron runs.
const DEFAULT_WINDOW_DAYS = parseInt(process.env.SCHEDULE_WINDOW_DAYS, 10) || 30;

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const ymd = (d) => {
  const x = startOfDay(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

const computeTargetDates = (frequency, anchorDayName, from, windowEnd) => {
  const anchorIdx = DAY_INDEX[anchorDayName] ?? 1; // default Monday
  const targets = [];

  // Find the first occurrence of the anchor day on or after `from`.
  let cursor = startOfDay(from);
  const offsetToAnchor = (anchorIdx - cursor.getDay() + 7) % 7;
  cursor.setDate(cursor.getDate() + offsetToAnchor);

  if (frequency === 'biweekly') {
    while (cursor <= windowEnd) {
      targets.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 14);
    }
  } else if (frequency === 'twice_weekly') {
    // Primary anchor + a second pickup 3 days later. If anchor is Friday we
    // wrap into Monday rather than Sunday (which is outside the Mon–Sat enum).
    while (cursor <= windowEnd) {
      targets.push(new Date(cursor));
      const second = new Date(cursor);
      second.setDate(second.getDate() + 3);
      // Clamp to Mon–Sat: if we'd land on Sunday, bump to Monday.
      if (second.getDay() === 0) second.setDate(second.getDate() + 1);
      if (second <= windowEnd) targets.push(second);
      cursor.setDate(cursor.getDate() + 7);
    }
  } else {
    // 'weekly' or anything we don't recognise — fall back to once-a-week.
    while (cursor <= windowEnd) {
      targets.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 7);
    }
  }

  return targets;
};

/**
 * Materialise upcoming Collection rows for one customer.
 * Idempotent: skips any (customer, scheduledDate) pair that already exists.
 *
 * Returns { created, skipped, reason? }.
 */
const generateForCustomer = async (customer, opts = {}) => {
  // The caller may pass a plain id or a populated document — normalise.
  let doc = customer;
  if (typeof customer === 'string' || customer instanceof require('mongoose').Types.ObjectId) {
    doc = await Customer.findById(customer);
  }
  if (!doc) return { created: 0, skipped: 0, reason: 'customer_not_found' };
  if (doc.accountStatus !== 'active') return { created: 0, skipped: 0, reason: 'inactive' };
  if (!doc.assignedDriver) return { created: 0, skipped: 0, reason: 'no_driver' };

  const from = opts.from ? startOfDay(opts.from) : startOfDay(new Date());
  const days = opts.days || DEFAULT_WINDOW_DAYS;
  const windowEnd = new Date(from);
  windowEnd.setDate(windowEnd.getDate() + days);
  windowEnd.setHours(23, 59, 59, 999);

  const frequency = doc.collectionSchedule?.frequency || 'biweekly';
  const anchorDay = doc.collectionSchedule?.day || 'monday';
  const targets = computeTargetDates(frequency, anchorDay, from, windowEnd);

  if (targets.length === 0) return { created: 0, skipped: 0 };

  // Existing rows in the window — match on the calendar day, not the millisecond,
  // so a row scheduled "today 09:00" still blocks another for "today 00:00".
  const existing = await Collection.find({
    customer: doc._id,
    scheduledDate: { $gte: from, $lte: windowEnd },
  }).select('scheduledDate');
  const taken = new Set(existing.map((c) => ymd(c.scheduledDate)));

  const fresh = targets.filter((d) => !taken.has(ymd(d)));
  if (fresh.length === 0) return { created: 0, skipped: targets.length };

  const baseId = Date.now();
  let counter = await Collection.countDocuments();
  const docs = fresh.map((d) => {
    counter += 1;
    return {
      collectionId: `COL-${baseId}-${String(counter).padStart(4, '0')}`,
      customer: doc._id,
      driver: doc.assignedDriver,
      scheduledDate: d,
      month: d.getMonth() + 1,
      year: d.getFullYear(),
    };
  });

  await Collection.insertMany(docs, { ordered: false });

  // Auto-bill: ensure each month touched by these pickups has an invoice so
  // the customer dashboard "Current Invoice" panel never goes empty.
  const monthsTouched = new Set(docs.map((d) => `${d.year}-${d.month}`));
  for (const key of monthsTouched) {
    const [year, month] = key.split('-').map(Number);
    await invoiceService.ensureMonthlyInvoice(doc._id, month, year).catch((err) => {
      logger.error(`ensureMonthlyInvoice failed for ${doc.customerId} ${key}: ${err.message}`);
    });
  }

  return { created: docs.length, skipped: targets.length - docs.length };
};

/**
 * Generate / extend the rolling window for every active assigned customer.
 * Safe to call at startup AND from a daily cron — idempotent.
 */
const generateForAll = async (opts = {}) => {
  const customers = await Customer.find({
    accountStatus: 'active',
    assignedDriver: { $ne: null },
  }).select('_id customerId accountStatus assignedDriver collectionSchedule');

  let totalCreated = 0;
  let totalSkipped = 0;
  for (const c of customers) {
    try {
      const r = await generateForCustomer(c, opts);
      totalCreated += r.created;
      totalSkipped += r.skipped;
    } catch (err) {
      logger.error(`generateForCustomer ${c.customerId} failed: ${err.message}`);
    }
  }

  if (totalCreated > 0) {
    logger.info(`Auto-scheduler: created ${totalCreated} pickups (skipped ${totalSkipped} existing)`);
  }
  return { customers: customers.length, created: totalCreated, skipped: totalSkipped };
};

/**
 * Wipe a customer's *future* scheduled (not-yet-picked) collections.
 * Used when an admin reassigns a customer's driver — old future bookings
 * still pointing at the previous driver would be misleading.
 */
const clearFutureScheduled = async (customerId, { from = new Date() } = {}) => {
  const cutoff = startOfDay(from);
  const result = await Collection.deleteMany({
    customer: customerId,
    status: 'scheduled',
    scheduledDate: { $gte: cutoff },
  });
  return result.deletedCount || 0;
};

module.exports = {
  generateForCustomer,
  generateForAll,
  clearFutureScheduled,
  computeTargetDates, // exported for testing
};
