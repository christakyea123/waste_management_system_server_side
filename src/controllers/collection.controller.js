const Collection = require('../models/Collection');
const Customer = require('../models/Customer');
const Driver = require('../models/Driver');
const ApiResponse = require('../utils/apiResponse');
const { paginate } = require('../utils/pagination');
const smsService = require('../services/sms.service');
const invoiceService = require('../services/invoice.service');
const logger = require('../utils/logger');

// @desc    Create collection schedule
// @route   POST /api/v1/collections
// @access  Admin
const createCollection = async (req, res) => {
  const { customerId, driverId, scheduledDate } = req.body;

  const [customer, driver] = await Promise.all([
    Customer.findById(customerId).populate('user', 'phone fullName'),
    Driver.findById(driverId),
  ]);

  if (!customer) return ApiResponse.error(res, 'Customer not found', 404);
  if (!driver) return ApiResponse.error(res, 'Driver not found', 404);

  const d = new Date(scheduledDate);
  const dayStart = new Date(new Date(d).setHours(0, 0, 0, 0));
  const dayEnd = new Date(new Date(d).setHours(23, 59, 59, 999));

  // Idempotency: prevent duplicate collection for same customer on same day
  const duplicate = await Collection.findOne({
    customer: customer._id,
    scheduledDate: { $gte: dayStart, $lte: dayEnd },
  });
  if (duplicate) return ApiResponse.error(res, 'Collection already scheduled for this customer on that date', 409);

  const collection = await Collection.create({
    customer: customer._id,
    driver: driver._id,
    scheduledDate: d,
    month: d.getMonth() + 1,
    year: d.getFullYear(),
  });

  // Subscription billing: make sure the customer's monthly invoice exists for
  // the pickup's month (created up front, full plan fee). Idempotent.
  invoiceService
    .ensureMonthlyInvoice(customer._id, d.getMonth() + 1, d.getFullYear())
    .catch((e) => logger.error(`ensureMonthlyInvoice failed: ${e.message}`));

  // Send reminder SMS
  smsService
    .sendCollectionReminder(customer.user, scheduledDate)
    .catch((e) => logger.error(`Collection reminder SMS failed: ${e.message}`));

  return ApiResponse.created(res, { collection }, 'Collection scheduled');
};

// @desc    Bulk create collection schedule
// @route   POST /api/v1/collections/bulk
// @access  Admin
const bulkCreateCollections = async (req, res) => {
  const { driverId, scheduledDate, zone } = req.body;

  const driver = await Driver.findById(driverId);
  if (!driver) return ApiResponse.error(res, 'Driver not found', 404);

  const query = { accountStatus: 'active' };
  if (zone) {
    query.collectionZone = new RegExp(`^${zone}$`, 'i'); // Case-insensitive match
  } else {
    query.assignedDriver = driver._id;
  }

  const customers = await Customer.find(query);
  if (!customers.length) {
    const msg = zone ? `No active customers found in zone '${zone}'` : 'No customers assigned to this driver';
    return ApiResponse.error(res, msg, 404);
  }

  const d = new Date(scheduledDate);
  const dayStart = new Date(new Date(d).setHours(0, 0, 0, 0));
  const dayEnd = new Date(new Date(d).setHours(23, 59, 59, 999));

  // Idempotency: exclude customers who already have a collection scheduled that day
  const existing = await Collection.find({
    customer: { $in: customers.map((c) => c._id) },
    scheduledDate: { $gte: dayStart, $lte: dayEnd },
  }).select('customer');
  const existingSet = new Set(existing.map((e) => e.customer.toString()));

  const baseId = Date.now();
  let collectionCount = await Collection.countDocuments();

  const collectionsData = customers
    .filter((c) => !existingSet.has(c._id.toString()))
    .map((c, i) => {
      collectionCount++;
      return {
        collectionId: `COL-${baseId}-${String(collectionCount).padStart(4, '0')}`,
        customer: c._id,
        driver: driver._id,
        scheduledDate: d,
        month: d.getMonth() + 1,
        year: d.getFullYear(),
      };
    });

  if (!collectionsData.length) {
    return ApiResponse.success(res, { count: 0, skipped: existing.length }, 'All collections already scheduled for this date');
  }

  const collections = await Collection.insertMany(collectionsData, { ordered: false });

  // Subscription billing: ensure each scheduled customer has the month's invoice.
  // De-dupe by customer (all rows share the same scheduledDate here) and
  // fire-and-forget so the response stays snappy on large bulk creates.
  const invMonth = d.getMonth() + 1;
  const invYear = d.getFullYear();
  const uniqueCustomers = [...new Set(collections.map((c) => c.customer.toString()))];
  Promise.all(
    uniqueCustomers.map((cid) => invoiceService.ensureMonthlyInvoice(cid, invMonth, invYear))
  ).catch((e) => logger.error(`Bulk ensureMonthlyInvoice failed: ${e.message}`));

  return ApiResponse.created(
    res,
    { count: collections.length, skipped: existingSet.size },
    `${collections.length} collections scheduled${existingSet.size ? `, ${existingSet.size} already existed` : ''}`
  );
};

// @desc    Get all collections (Admin)
// @route   GET /api/v1/collections
// @access  Admin
const getCollections = async (req, res) => {
  const { page, limit, status, driverId, month, year, date } = req.query;
  const query = {};

  if (status) query.status = status;
  if (driverId) query.driver = driverId;
  if (month) query.month = parseInt(month);
  if (year) query.year = parseInt(year);
  if (date) {
    const d = new Date(date);
    query.scheduledDate = {
      $gte: new Date(d.setHours(0, 0, 0, 0)),
      $lte: new Date(d.setHours(23, 59, 59, 999)),
    };
  }

  const { data, pagination } = await paginate(Collection, query, {
    page,
    limit,
    populate: [
      { path: 'customer', populate: { path: 'user', select: 'fullName phone' } },
      { path: 'driver', populate: { path: 'user', select: 'fullName phone' } },
    ],
    sort: { scheduledDate: 1 },
  });

  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Get single collection
// @route   GET /api/v1/collections/:id
// @access  Admin/Driver
const getCollection = async (req, res) => {
  const collection = await Collection.findById(req.params.id)
    .populate({ path: 'customer', populate: { path: 'user', select: 'fullName phone email' } })
    .populate({ path: 'driver', populate: { path: 'user', select: 'fullName phone' } });

  if (!collection) return ApiResponse.error(res, 'Collection not found', 404);
  return ApiResponse.success(res, { collection });
};

// @desc    Delete collection
// @route   DELETE /api/v1/collections/:id
// @access  Admin
const deleteCollection = async (req, res) => {
  const collection = await Collection.findByIdAndDelete(req.params.id);
  if (!collection) return ApiResponse.error(res, 'Collection not found', 404);
  return ApiResponse.success(res, {}, 'Collection deleted');
};

module.exports = { createCollection, bulkCreateCollections, getCollections, getCollection, deleteCollection };
