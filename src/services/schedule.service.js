const Collection = require('../models/Collection');
const Customer = require('../models/Customer');
const invoiceService = require('./invoice.service');
const logger = require('../utils/logger');

/**
 * Auto-scheduling service.
 *
 * Calendar-month scheduling: every active customer with an assigned driver gets
 * EXACTLY the number of pickups their plan entitles them to, per calendar month:
 *   basic    (biweekly)     → 2 pickups / month (Basic plan)
 *   standard (weekly)       → 4 pickups / month (Standard plan)
 *   premium  (twice_weekly) → 8 pickups / month (Premium plan)
 *
 * Why per-month instead of a rolling window: the customer pays a flat monthly
 * subscription that explicitly buys N pickups. Scheduling 3 biweekly pickups
 * inside a 30-day rolling window (which happens when the anchor day aligns)
 * would give a Basic customer a free pickup every other month.
 *
 * Billing is decoupled from scheduling: each customer gets ONE monthly
 * subscription invoice (full plan fee), created up front on registration and on
 * the 1st of each month — see invoice.service.ensureMonthlyInvoice. Materialising
 * a month's pickups also ensures that month's invoice exists as a safety net.
 */

const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

// Pickups per calendar month for each frequency. Drives both the scheduler and
// the per-pickup invoice amount (monthlyFee / pickupsPerMonth).
const PICKUPS_PER_MONTH = {
  biweekly: 2,
  weekly: 4,
  twice_weekly: 8,
};

const pickupsPerMonth = (frequency) => PICKUPS_PER_MONTH[frequency] || 2;

// How many months ahead to materialise. Two months = current + next, so drivers
// always see at least 30 days of work even at month-end.
const MONTHS_AHEAD = parseInt(process.env.SCHEDULE_MONTHS_AHEAD, 10) || 2;

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const ymd = (d) => {
  const x = startOfDay(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

// Pick dates inside [monthStart, monthEnd] for one frequency / anchor combo.
// Returns at most pickupsPerMonth(frequency) Date objects, all within the month.
const computeMonthlyDates = (frequency, anchorDayName, year, month) => {
  const anchorIdx = DAY_INDEX[anchorDayName] ?? 1; // default Monday
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0); // last day of month
  monthEnd.setHours(23, 59, 59, 999);

  // First occurrence of the anchor weekday on or after the 1st.
  const firstAnchor = new Date(monthStart);
  const offset = (anchorIdx - firstAnchor.getDay() + 7) % 7;
  firstAnchor.setDate(firstAnchor.getDate() + offset);

  const cap = pickupsPerMonth(frequency);
  const dates = [];

  if (frequency === 'biweekly') {
    // Two pickups, ~2 weeks apart. Anchor week + (anchor + 14 days).
    let cursor = new Date(firstAnchor);
    while (dates.length < cap && cursor <= monthEnd) {
      dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 14);
    }
  } else if (frequency === 'twice_weekly') {
    // Two pickups per week (anchor + anchor+3) for ~4 weeks = 8.
    let cursor = new Date(firstAnchor);
    while (dates.length < cap && cursor <= monthEnd) {
      dates.push(new Date(cursor));
      if (dates.length >= cap) break;
      const second = new Date(cursor);
      second.setDate(second.getDate() + 3);
      // Skip Sunday (outside the Mon-Sat enum) — bump to Monday.
      if (second.getDay() === 0) second.setDate(second.getDate() + 1);
      if (second <= monthEnd) dates.push(second);
      cursor.setDate(cursor.getDate() + 7);
    }
  } else {
    // 'weekly' (or unknown) — one pickup per week of the month.
    let cursor = new Date(firstAnchor);
    while (dates.length < cap && cursor <= monthEnd) {
      dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 7);
    }
  }

  return dates.slice(0, cap);
};

/**
 * Materialise pickup rows for one customer, one calendar month.
 * Caps creation at (pickupsPerMonth - existingCount) so re-running this never
 * over-schedules a customer who already has rows for the month.
 *
 * Returns { created, skipped, reason? }.
 */
const generateForCustomerMonth = async (customer, year, month) => {
  let doc = customer;
  if (typeof customer === 'string' || customer instanceof require('mongoose').Types.ObjectId) {
    doc = await Customer.findById(customer);
  }
  if (!doc) return { created: 0, skipped: 0, reason: 'customer_not_found' };
  if (doc.accountStatus !== 'active') return { created: 0, skipped: 0, reason: 'inactive' };
  if (!doc.assignedDriver) return { created: 0, skipped: 0, reason: 'no_driver' };

  const frequency = doc.collectionSchedule?.frequency || 'biweekly';
  const anchorDay = doc.collectionSchedule?.day || 'monday';
  const cap = pickupsPerMonth(frequency);

  // Existing rows already in this month — we never create more than `cap`
  // total, regardless of how many times this runs.
  const existing = await Collection.find({
    customer: doc._id,
    month,
    year,
  }).select('scheduledDate');

  if (existing.length >= cap) {
    return { created: 0, skipped: existing.length };
  }

  const taken = new Set(existing.map((c) => ymd(c.scheduledDate)));
  const targets = computeMonthlyDates(frequency, anchorDay, year, month);
  const fresh = targets.filter((d) => !taken.has(ymd(d)));

  // Cap to the remaining slots so we hit exactly `cap` total for the month.
  const slotsLeft = cap - existing.length;
  const toCreate = fresh.slice(0, slotsLeft);
  if (toCreate.length === 0) return { created: 0, skipped: existing.length };

  const baseId = Date.now();
  let counter = await Collection.countDocuments();
  const docs = toCreate.map((d) => {
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

  const created = await Collection.insertMany(docs, { ordered: false });

  // Subscription billing: ensure the customer's single monthly invoice exists
  // for this month (full plan fee, created up front). One invoice per month,
  // not per pickup.
  try {
    await invoiceService.ensureMonthlyInvoice(doc._id, month, year);
  } catch (err) {
    logger.error(`ensureMonthlyInvoice failed for ${doc.customerId} ${month}/${year}: ${err.message}`);
  }

  return { created: created.length, skipped: existing.length };
};

/**
 * Materialise pickups for one customer for the current + next N months.
 * Idempotent — safe to call from startup and from the daily cron.
 */
const generateForCustomer = async (customer, opts = {}) => {
  const monthsAhead = opts.monthsAhead || MONTHS_AHEAD;
  const now = opts.from ? new Date(opts.from) : new Date();

  let totalCreated = 0;
  let totalSkipped = 0;
  let reason = null;
  for (let i = 0; i < monthsAhead; i++) {
    const target = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const year = target.getFullYear();
    const month = target.getMonth() + 1;
    const r = await generateForCustomerMonth(customer, year, month);
    totalCreated += r.created;
    totalSkipped += r.skipped;
    if (r.reason) { reason = r.reason; break; }
  }
  return { created: totalCreated, skipped: totalSkipped, ...(reason ? { reason } : {}) };
};

/**
 * Generate / extend pickup schedules for every active, driver-assigned customer.
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
  generateForCustomerMonth,
  generateForAll,
  clearFutureScheduled,
  computeMonthlyDates,
  pickupsPerMonth,
  PICKUPS_PER_MONTH,
};
