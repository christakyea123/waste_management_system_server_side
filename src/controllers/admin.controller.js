const User = require('../models/User');
const Customer = require('../models/Customer');
const Driver = require('../models/Driver');
const Collection = require('../models/Collection');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Notification = require('../models/Notification');
const ActivityLog = require('../models/ActivityLog');
const Complaint = require('../models/Complaint');
const Route = require('../models/Route');
const Settings = require('../models/Settings');
const ApiResponse = require('../utils/apiResponse');
const { paginate } = require('../utils/pagination');
const smsService = require('../services/sms.service');
const invoiceService = require('../services/invoice.service');
const scheduleService = require('../services/schedule.service');
const logger = require('../utils/logger');
const { uploadToCloudinary } = require('../config/cloudinary');

// @desc    Get admin dashboard stats
// @route   GET /api/v1/admin/dashboard
// @access  Admin
const getDashboard = async (req, res) => {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const startOfMonth = new Date(year, month - 1, 1);
  const endOfMonth = new Date(year, month, 0, 23, 59, 59);

  const [
    totalCustomers,
    activeCustomers,
    totalDrivers,
    activeDrivers,
    monthlyCollections,
    completedCollections,
    missedCollections,
    totalRevenue,
    monthlyRevenue,
    pendingInvoices,
    overdueInvoices,
    recentRegistrations,
  ] = await Promise.all([
    Customer.countDocuments(),
    Customer.countDocuments({ accountStatus: 'active' }),
    Driver.countDocuments(),
    Driver.countDocuments({ status: { $in: ['available', 'on_route'] } }),
    Collection.countDocuments({ month, year }),
    Collection.countDocuments({ month, year, status: 'picked' }),
    Collection.countDocuments({ month, year, status: 'missed' }),
    Payment.aggregate([{ $match: { status: 'success' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Payment.aggregate([
      { $match: { status: 'success', paidAt: { $gte: startOfMonth, $lte: endOfMonth } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Invoice.countDocuments({ status: 'pending' }),
    Invoice.countDocuments({ status: 'overdue' }),
    Customer.find().sort({ createdAt: -1 }).limit(5).populate('user', 'fullName email phone createdAt'),
  ]);

  const collectionRate = monthlyCollections > 0
    ? Math.round((completedCollections / monthlyCollections) * 100)
    : 0;

  return ApiResponse.success(res, {
    customers: { total: totalCustomers, active: activeCustomers },
    drivers: { total: totalDrivers, active: activeDrivers },
    collections: {
      total: monthlyCollections,
      completed: completedCollections,
      missed: missedCollections,
      completionRate: collectionRate,
    },
    revenue: {
      total: totalRevenue[0]?.total || 0,
      monthly: monthlyRevenue[0]?.total || 0,
    },
    invoices: { pending: pendingInvoices, overdue: overdueInvoices },
    recentRegistrations,
  });
};

// @desc    Get all customers
// @route   GET /api/v1/admin/customers
// @access  Admin
const getCustomers = async (req, res) => {
  const { page, limit, search, status, binType, zone } = req.query;
  const query = {};

  if (status) query.accountStatus = status;
  if (binType) query.binType = binType;
  if (zone) query.collectionZone = zone;

  let userIds = null;
  if (search) {
    const users = await User.find({
      $or: [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ],
    }).select('_id');
    userIds = users.map((u) => u._id);
    query.user = { $in: userIds };
  }

  const { data, pagination } = await paginate(Customer, query, {
    page,
    limit,
    populate: [
      { path: 'user', select: 'fullName email phone profileImage isActive lastLogin' },
      { path: 'assignedDriver', populate: { path: 'user', select: 'fullName phone' } },
    ],
    sort: { createdAt: -1 },
  });

  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Get single customer
// @route   GET /api/v1/admin/customers/:id
// @access  Admin
const getCustomer = async (req, res) => {
  const customer = await Customer.findById(req.params.id)
    .populate('user', '-password')
    .populate({ path: 'assignedDriver', populate: { path: 'user', select: 'fullName phone email' } })
    .populate('collectionRoute', 'name zone');

  if (!customer) return ApiResponse.error(res, 'Customer not found', 404);

  const recentCollections = await Collection.find({ customer: customer._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .populate('driver', 'driverId');

  const invoices = await Invoice.find({ customer: customer._id })
    .sort({ createdAt: -1 })
    .limit(6);

  return ApiResponse.success(res, { customer, recentCollections, invoices });
};

// @desc    Update customer
// @route   PUT /api/v1/admin/customers/:id
// @access  Admin
const updateCustomer = async (req, res) => {
  const { accountStatus, assignedDriver, collectionZone, binType, notes, collectionSchedule } = req.body;
  const customer = await Customer.findById(req.params.id);
  if (!customer) return ApiResponse.error(res, 'Customer not found', 404);

  // Snapshot the fields the auto-scheduler cares about *before* mutating, so we
  // can decide whether the pickup calendar needs regenerating after save.
  const prev = {
    assignedDriver: String(customer.assignedDriver || ''),
    binType: customer.binType,
    day: customer.collectionSchedule?.day,
    frequency: customer.collectionSchedule?.frequency,
    accountStatus: customer.accountStatus,
  };

  if (accountStatus) customer.accountStatus = accountStatus;
  if (assignedDriver !== undefined) customer.assignedDriver = assignedDriver || null;
  if (collectionZone) customer.collectionZone = collectionZone;
  if (binType) customer.binType = binType;
  if (notes !== undefined) customer.notes = notes;
  if (collectionSchedule) customer.collectionSchedule = { ...customer.collectionSchedule?.toObject?.() || {}, ...collectionSchedule };

  await customer.save();

  if (accountStatus === 'suspended') {
    const user = await User.findById(customer.user);
    if (user) {
      await User.findByIdAndUpdate(user._id, { isActive: false });
      smsService
        .send(user.phone, `035 F Arkoh: Dear ${user.fullName}, your account has been suspended. Please contact customer support to resolve this.`)
        .catch(logger.error);
    }
  }

  if (accountStatus === 'active') {
    await User.findByIdAndUpdate(customer.user, { isActive: true });
  }

  // Auto-scheduling: any change that affects WHO picks up or WHEN means we
  // should rebuild the rolling window for this customer. Skip if they just
  // got suspended — no point materialising pickups we won't honour.
  const driverChanged = prev.assignedDriver !== String(customer.assignedDriver || '');
  const binChanged = customer.binType !== prev.binType;
  const dayChanged = customer.collectionSchedule?.day !== prev.day;
  const freqChanged = customer.collectionSchedule?.frequency !== prev.frequency;
  const becameActive = prev.accountStatus !== 'active' && customer.accountStatus === 'active';
  const scheduleAffected = driverChanged || binChanged || dayChanged || freqChanged || becameActive;

  if (scheduleAffected && customer.accountStatus === 'active') {
    try {
      // Clear future scheduled rows first so a driver reassignment doesn't
      // leave the old driver staring at pickups that are no longer theirs.
      const cleared = await scheduleService.clearFutureScheduled(customer._id);
      const result = await scheduleService.generateForCustomer(customer);
      logger.info(`Auto-schedule for ${customer.customerId}: cleared ${cleared}, created ${result.created}`);
    } catch (err) {
      logger.error(`Auto-schedule failed for ${customer.customerId}: ${err.message}`);
    }
  } else if (customer.accountStatus !== 'active' && (driverChanged || becameActive === false)) {
    // Customer was deactivated or had driver removed — clear future pickups.
    await scheduleService.clearFutureScheduled(customer._id).catch(() => {});
  }

  return ApiResponse.success(res, { customer }, 'Customer updated successfully');
};

// @desc    Delete customer
// @route   DELETE /api/v1/admin/customers/:id
// @access  SuperAdmin
const deleteCustomer = async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) return ApiResponse.error(res, 'Customer not found', 404);

  await User.findByIdAndDelete(customer.user);
  await Customer.findByIdAndDelete(customer._id);

  return ApiResponse.success(res, {}, 'Customer deleted successfully');
};

// @desc    Create driver account
// @route   POST /api/v1/admin/drivers
// @access  Admin
const createDriver = async (req, res) => {
  const { fullName, email, phone, truckNumber, licenseNumber, zone } = req.body;

  // Phone-as-password (same flow as customers): the driver logs in with an
  // auto-generated username + their phone number. Admin never sets a password.
  const password = phone;

  // Email is optional. Normalise blank to undefined so it doesn't collide on
  // the sparse-unique index or fail the email format validator.
  const normalisedEmail = email && email.trim() ? email.trim().toLowerCase() : undefined;

  const orClauses = [{ phone }];
  if (normalisedEmail) orClauses.push({ email: normalisedEmail });
  const existing = await User.findOne({ $or: orClauses });
  if (existing) {
    const clash = normalisedEmail && existing.email === normalisedEmail ? 'Email' : 'Phone number';
    return ApiResponse.error(res, `${clash} already in use`, 409);
  }

  let profileImage = null;
  let profileImagePublicId = null;
  if (req.file) {
    try {
      const result = await uploadToCloudinary(req.file.buffer, 'waste_management/profiles');
      profileImage = result.secure_url;
      profileImagePublicId = result.public_id;
    } catch (uploadErr) {
      logger.error(`Driver profile image upload failed: ${uploadErr.message}`);
    }
  }

  // Auto-generate a unique login username (e.g. "kojo.driver42").
  const username = await User.generateUniqueUsername(fullName);

  const user = await User.create({
    fullName, email: normalisedEmail, phone, password, username, role: 'driver',
    profileImage,
    profileImagePublicId,
    isVerified: true,
  });

  const driver = await Driver.create({
    user: user._id,
    truckNumber,
    licenseNumber,
    zone,
  });

  smsService
    .send(phone, `035 F Arkoh: Welcome ${fullName}. Driver ID: ${driver.driverId}. Log in with username "${username}" and your phone number as the password.`)
    .catch((e) => logger.error(`Driver welcome SMS failed: ${e.message}`));

  // Return the generated username so the admin UI can show it.
  return ApiResponse.created(res, { driver, username }, 'Driver created successfully');
};

// @desc    Get single driver
// @route   GET /api/v1/admin/drivers/:id
// @access  Admin
const getDriver = async (req, res) => {
  const driver = await Driver.findById(req.params.id)
    .populate('user', '-password')
    .populate('assignedRoute')
    .populate({ path: 'assignedCustomers', populate: { path: 'user', select: 'fullName phone email' } });

  if (!driver) return ApiResponse.error(res, 'Driver not found', 404);

  const recentCollections = await Collection.find({ driver: driver._id })
    .sort({ scheduledDate: -1 })
    .limit(10)
    .populate('customer', 'customerId');

  return ApiResponse.success(res, { driver, recentCollections });
};

// @desc    Get all drivers
// @route   GET /api/v1/admin/drivers
// @access  Admin
const getDrivers = async (req, res) => {
  const { page, limit, search, status } = req.query;
  const query = {};

  if (status) query.status = status;

  let userIds = null;
  if (search) {
    const users = await User.find({
      $or: [
        { fullName: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ],
    }).select('_id');
    userIds = users.map((u) => u._id);
    query.user = { $in: userIds };
  }

  const { data, pagination } = await paginate(Driver, query, {
    page,
    limit,
    populate: { path: 'user', select: 'fullName email phone profileImage isActive' },
    sort: { createdAt: -1 },
  });

  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Update driver
// @route   PUT /api/v1/admin/drivers/:id
// @access  Admin
const updateDriver = async (req, res) => {
  const { truckNumber, licenseNumber, zone, status, assignedRoute } = req.body;
  const driver = await Driver.findById(req.params.id);
  if (!driver) return ApiResponse.error(res, 'Driver not found', 404);

  if (truckNumber) driver.truckNumber = truckNumber;
  if (licenseNumber) driver.licenseNumber = licenseNumber;
  if (zone) driver.zone = zone;
  if (status) driver.status = status;
  if (assignedRoute !== undefined) driver.assignedRoute = assignedRoute;

  await driver.save();

  if (req.body.fullName || req.body.phone) {
    await User.findByIdAndUpdate(driver.user, {
      ...(req.body.fullName && { fullName: req.body.fullName }),
      ...(req.body.phone && { phone: req.body.phone }),
    });
  }

  return ApiResponse.success(res, { driver }, 'Driver updated successfully');
};

// @desc    Delete driver
// @route   DELETE /api/v1/admin/drivers/:id
// @access  SuperAdmin
const deleteDriver = async (req, res) => {
  const driver = await Driver.findById(req.params.id);
  if (!driver) return ApiResponse.error(res, 'Driver not found', 404);

  await User.findByIdAndDelete(driver.user);
  await Driver.findByIdAndDelete(driver._id);

  return ApiResponse.success(res, {}, 'Driver deleted successfully');
};

// @desc    Assign customers to driver
// @route   POST /api/v1/admin/drivers/:id/assign
// @access  Admin
const assignCustomers = async (req, res) => {
  const { customerIds } = req.body;
  const driver = await Driver.findById(req.params.id);
  if (!driver) return ApiResponse.error(res, 'Driver not found', 404);

  await Customer.updateMany(
    { _id: { $in: customerIds } },
    { $set: { assignedDriver: driver._id } }
  );

  driver.assignedCustomers = [...new Set([...driver.assignedCustomers.map(String), ...customerIds])];
  await driver.save();

  // Auto-schedule pickups for every newly-assigned customer. Run in background
  // so the admin response doesn't wait on many round-trips. Any failures get
  // logged; the daily cron will pick stragglers up on the next run.
  Promise.all(
    customerIds.map(async (id) => {
      await scheduleService.clearFutureScheduled(id).catch(() => {});
      return scheduleService.generateForCustomer(id);
    })
  ).catch((err) => logger.error(`Bulk assign auto-schedule failed: ${err.message}`));

  return ApiResponse.success(res, { driver }, 'Customers assigned successfully');
};

// @desc    Send bulk SMS
// @route   POST /api/v1/admin/notifications/bulk-sms
// @access  Admin
const sendBulkSms = async (req, res) => {
  const { message, targetGroup, customPhones } = req.body;

  let phones = [];

  if (targetGroup === 'all_customers') {
    const users = await User.find({ role: 'customer', isActive: true }).select('phone');
    phones = users.map((u) => u.phone);
  } else if (targetGroup === 'overdue_customers') {
    const invoices = await Invoice.find({ status: 'overdue' }).populate({
      path: 'customer',
      populate: { path: 'user', select: 'phone' },
    });
    phones = invoices.map((i) => i.customer?.user?.phone).filter(Boolean);
  } else if (targetGroup === 'all_drivers') {
    const users = await User.find({ role: 'driver', isActive: true }).select('phone');
    phones = users.map((u) => u.phone);
  } else if (customPhones?.length) {
    phones = customPhones;
  }

  const uniquePhones = [...new Set(phones)];
  const results = await smsService.sendBulk(uniquePhones, message);
  const successCount = results.filter((r) => r.status === 'fulfilled' && r.value?.success).length;

  return ApiResponse.success(res, { sent: successCount, total: uniquePhones.length }, 'Bulk SMS completed');
};

// @desc    Get customers with outstanding (unpaid) invoice balances.
//          Powers the admin dashboard "Customers Owing" panel — each row shows
//          who owes how much across all their pending/overdue invoices.
// @route   GET /api/v1/admin/outstanding
// @access  Admin
const getOutstanding = async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  const rows = await Invoice.aggregate([
    { $match: { status: { $in: ['pending', 'overdue'] } } },
    {
      $group: {
        _id: '$customer',
        outstanding: { $sum: '$totalAmount' },
        invoiceCount: { $sum: 1 },
        oldestDueDate: { $min: '$dueDate' },
        hasOverdue: { $max: { $cond: [{ $eq: ['$status', 'overdue'] }, 1, 0] } },
      },
    },
    { $sort: { outstanding: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'customers',
        localField: '_id',
        foreignField: '_id',
        as: 'customer',
      },
    },
    { $unwind: '$customer' },
    {
      $lookup: {
        from: 'users',
        localField: 'customer.user',
        foreignField: '_id',
        as: 'user',
      },
    },
    { $unwind: '$user' },
    {
      $project: {
        _id: 0,
        customerId: '$customer._id',
        customerNumber: '$customer.customerId',
        fullName: '$user.fullName',
        phone: '$user.phone',
        email: '$user.email',
        profileImage: '$user.profileImage',
        binType: '$customer.binType',
        outstanding: 1,
        invoiceCount: 1,
        oldestDueDate: 1,
        hasOverdue: 1,
      },
    },
  ]);

  const totalOutstanding = rows.reduce((s, r) => s + (r.outstanding || 0), 0);
  return ApiResponse.success(res, {
    customers: rows,
    totalOutstanding,
    customerCount: rows.length,
  });
};

// @desc    Manually trigger the auto-scheduler for all active customers.
//         Normally runs at startup + daily, but admins may want to re-sync
//         after a bulk change (e.g. they reassigned several drivers at once).
// @route   POST /api/v1/admin/auto-schedule/run
// @access  Admin
const runAutoSchedule = async (req, res) => {
  const result = await scheduleService.generateForAll();
  return ApiResponse.success(res, result, `Auto-scheduled ${result.created} new pickup(s) across ${result.customers} customer(s)`);
};

// @desc    Live pickup schedule for the next N days, grouped by driver. Powers
//         the admin dashboard "who picks who, when" panel. Returns flat rows
//         and a `byDriver` index so the frontend can pivot either way.
// @route   GET /api/v1/admin/live-schedule
// @access  Admin
const getLiveSchedule = async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 30);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  end.setHours(23, 59, 59, 999);

  const rows = await Collection.find({
    scheduledDate: { $gte: start, $lte: end },
  })
    .populate({ path: 'customer', populate: { path: 'user', select: 'fullName phone' } })
    .populate({ path: 'driver', populate: { path: 'user', select: 'fullName phone profileImage' } })
    .sort({ scheduledDate: 1 })
    .lean();

  // Group by driver id (or 'unassigned'). Each driver entry carries the
  // driver header + a list of {date, status, customer} entries.
  const byDriver = {};
  for (const r of rows) {
    const drvKey = r.driver?._id?.toString() || 'unassigned';
    if (!byDriver[drvKey]) {
      byDriver[drvKey] = {
        driverId: drvKey,
        driverName: r.driver?.user?.fullName || 'Unassigned',
        driverPhone: r.driver?.user?.phone || null,
        driverImage: r.driver?.user?.profileImage || null,
        truckNumber: r.driver?.truckNumber || null,
        pickups: [],
        counts: { scheduled: 0, picked: 0, missed: 0, total: 0 },
      };
    }
    byDriver[drvKey].pickups.push({
      _id: r._id,
      scheduledDate: r.scheduledDate,
      status: r.status,
      collectedAt: r.collectedAt,
      customerId: r.customer?.customerId,
      customerName: r.customer?.user?.fullName || 'N/A',
      customerPhone: r.customer?.user?.phone || null,
      customerAddress: r.customer?.residentialAddress || null,
    });
    byDriver[drvKey].counts.total += 1;
    if (r.status in byDriver[drvKey].counts) byDriver[drvKey].counts[r.status] += 1;
  }

  // Summary counts across the whole window — useful for the dashboard header.
  const summary = {
    days,
    total: rows.length,
    scheduled: rows.filter((r) => r.status === 'scheduled').length,
    picked: rows.filter((r) => r.status === 'picked').length,
    missed: rows.filter((r) => r.status === 'missed').length,
    driversWithWork: Object.keys(byDriver).length,
  };

  return ApiResponse.success(res, {
    summary,
    drivers: Object.values(byDriver),
    rows,
  });
};

// @desc    Get revenue analytics
// @route   GET /api/v1/admin/analytics/revenue
// @access  Admin
const getRevenueAnalytics = async (req, res) => {
  const { year = new Date().getFullYear() } = req.query;

  const monthlyRevenue = await Payment.aggregate([
    {
      $match: {
        status: 'success',
        paidAt: {
          $gte: new Date(`${year}-01-01`),
          $lte: new Date(`${year}-12-31`),
        },
      },
    },
    {
      $group: {
        _id: { $month: '$paidAt' },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const months = Array.from({ length: 12 }, (_, i) => {
    const found = monthlyRevenue.find((r) => r._id === i + 1);
    return { month: i + 1, total: found?.total || 0, count: found?.count || 0 };
  });

  const customerGrowth = await Customer.aggregate([
    { $match: { createdAt: { $gte: new Date(`${year}-01-01`), $lte: new Date(`${year}-12-31`) } } },
    { $group: { _id: { $month: '$createdAt' }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  return ApiResponse.success(res, { monthlyRevenue: months, customerGrowth, year });
};

// @desc    Get collection analytics
// @route   GET /api/v1/admin/analytics/collections
// @access  Admin
const getCollectionAnalytics = async (req, res) => {
  const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;

  const stats = await Collection.aggregate([
    { $match: { month: parseInt(month), year: parseInt(year) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const driverPerformance = await Collection.aggregate([
    { $match: { month: parseInt(month), year: parseInt(year) } },
    {
      $group: {
        _id: '$driver',
        total: { $sum: 1 },
        picked: { $sum: { $cond: [{ $eq: ['$status', 'picked'] }, 1, 0] } },
        missed: { $sum: { $cond: [{ $eq: ['$status', 'missed'] }, 1, 0] } },
      },
    },
    {
      $lookup: {
        from: 'drivers',
        localField: '_id',
        foreignField: '_id',
        as: 'driver',
      },
    },
    { $unwind: '$driver' },
    {
      $lookup: {
        from: 'users',
        localField: 'driver.user',
        foreignField: '_id',
        as: 'driverUser',
      },
    },
    { $unwind: '$driverUser' },
    {
      $project: {
        driverId: '$driver.driverId',
        name: '$driverUser.fullName',
        total: 1,
        picked: 1,
        missed: 1,
        rate: { $multiply: [{ $divide: ['$picked', '$total'] }, 100] },
      },
    },
    { $sort: { rate: -1 } },
  ]);

  return ApiResponse.success(res, { stats, driverPerformance, month, year });
};

// @desc    Get activity logs
// @route   GET /api/v1/admin/activity-logs
// @access  Admin
const getActivityLogs = async (req, res) => {
  const { page, limit } = req.query;
  const { data, pagination } = await paginate(ActivityLog, {}, {
    page,
    limit,
    populate: { path: 'user', select: 'fullName email role' },
    sort: { createdAt: -1 },
  });
  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Get all invoices
// @route   GET /api/v1/admin/invoices
// @access  Admin
const getInvoices = async (req, res) => {
  const { page, limit, status, month, year, customer } = req.query;
  const query = {};
  if (status) query.status = status;
  if (month) query.month = parseInt(month);
  if (year) query.year = parseInt(year);
  if (customer) query.customer = customer;

  const { data, pagination } = await paginate(Invoice, query, {
    page,
    limit,
    populate: {
      path: 'customer',
      populate: { path: 'user', select: 'fullName email phone' },
    },
    sort: { createdAt: -1 },
  });

  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Generate monthly invoices
// @route   POST /api/v1/admin/invoices/generate
// @access  Admin
const generateInvoices = async (req, res) => {
  const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.body;
  const results = await invoiceService.generateMonthlyInvoices(parseInt(month), parseInt(year));
  return ApiResponse.success(res, results, `Invoices generated: ${results.created} created, ${results.skipped} skipped`);
};

// @desc    Send payment reminders for all pending/overdue invoices
// @route   POST /api/v1/admin/invoices/send-reminders
// @access  Admin
const sendPaymentReminders = async (req, res) => {
  const sent = await invoiceService.sendPaymentReminders();
  return ApiResponse.success(res, { sent }, `${sent} payment reminder(s) sent`);
};

// @desc    Send reminder for a single invoice
// @route   POST /api/v1/admin/invoices/:id/remind
// @access  Admin
const sendInvoiceReminder = async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).populate({
    path: 'customer',
    populate: { path: 'user' },
  });
  if (!invoice) return ApiResponse.error(res, 'Invoice not found', 404);
  if (!invoice.customer?.user) return ApiResponse.error(res, 'Customer user not found', 404);

  const result = await smsService.sendPaymentReminder(
    invoice.customer.user,
    invoice.totalAmount || invoice.amount,
    invoice.dueDate,
    invoice.invoiceNumber
  );

  if (!result.success) return ApiResponse.error(res, 'Failed to send reminder', 500);

  invoice.remindersSent = (invoice.remindersSent || 0) + 1;
  invoice.lastReminderDate = new Date();
  await invoice.save();

  return ApiResponse.success(res, { invoice }, 'Reminder sent');
};

// @desc    Get all complaints (admin view)
// @route   GET /api/v1/admin/complaints
// @access  Admin
const getAdminComplaints = async (req, res) => {
  const { page, limit, status, category } = req.query;
  const query = {};
  if (status) query.status = status;
  if (category) query.category = category;
  const { data, pagination } = await paginate(Complaint, query, {
    page,
    limit,
    populate: {
      path: 'customer',
      populate: { path: 'user', select: 'fullName phone email' },
    },
    sort: { createdAt: -1 },
  });
  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Update complaint status/resolution
// @route   PUT /api/v1/admin/complaints/:id
// @access  Admin
const updateComplaint = async (req, res) => {
  const { status, priority, resolution } = req.body;
  const complaint = await Complaint.findById(req.params.id);
  if (!complaint) return ApiResponse.error(res, 'Complaint not found', 404);
  if (status) complaint.status = status;
  if (priority) complaint.priority = priority;
  if (resolution !== undefined) complaint.resolution = resolution;
  if (status === 'resolved' && !complaint.resolvedAt) {
    complaint.resolvedAt = new Date();
    complaint.resolvedBy = req.user._id;
  }
  await complaint.save();
  return ApiResponse.success(res, { complaint }, 'Complaint updated');
};

// @desc    Get all routes
// @route   GET /api/v1/admin/routes
// @access  Admin
const getRoutes = async (req, res) => {
  const { page, limit, zone } = req.query;
  const query = {};
  if (zone) query.zone = { $regex: zone, $options: 'i' };
  const { data, pagination } = await paginate(Route, query, {
    page,
    limit,
    populate: { path: 'assignedDriver', populate: { path: 'user', select: 'fullName phone' } },
    sort: { createdAt: -1 },
  });
  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Create route
// @route   POST /api/v1/admin/routes
// @access  Admin
const createRoute = async (req, res) => {
  const { name, zone, description, collectionDays, estimatedDuration, assignedDriver } = req.body;
  const route = await Route.create({ name, zone, description, collectionDays, estimatedDuration, assignedDriver });
  return ApiResponse.created(res, { route }, 'Route created successfully');
};

// @desc    Update route
// @route   PUT /api/v1/admin/routes/:id
// @access  Admin
const updateRoute = async (req, res) => {
  const route = await Route.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true })
    .populate({ path: 'assignedDriver', populate: { path: 'user', select: 'fullName phone' } });
  if (!route) return ApiResponse.error(res, 'Route not found', 404);
  return ApiResponse.success(res, { route }, 'Route updated');
};

// @desc    Delete route
// @route   DELETE /api/v1/admin/routes/:id
// @access  SuperAdmin
const deleteRoute = async (req, res) => {
  const route = await Route.findByIdAndDelete(req.params.id);
  if (!route) return ApiResponse.error(res, 'Route not found', 404);
  return ApiResponse.success(res, {}, 'Route deleted');
};

// @desc    Get current service pricing
// @route   GET /api/v1/admin/settings/pricing
// @access  Admin
const getPricing = async (req, res) => {
  const pricing = await Settings.getPricing();
  return ApiResponse.success(res, { pricing });
};

// @desc    Update service pricing (affects new customer invoices going forward)
// @route   PUT /api/v1/admin/settings/pricing
// @access  Admin
const updatePricing = async (req, res) => {
  const { basic, standard, premium } = req.body;
  const updates = {};
  if (basic !== undefined)    updates['pricing.basic']    = Number(basic);
  if (standard !== undefined) updates['pricing.standard'] = Number(standard);
  if (premium !== undefined)  updates['pricing.premium']  = Number(premium);

  for (const [k, v] of Object.entries(updates)) {
    if (!Number.isFinite(v) || v < 0) {
      return ApiResponse.error(res, `Invalid value for ${k.replace('pricing.', '')}`, 400);
    }
  }

  updates.updatedBy = req.user._id;
  const doc = await Settings.findByIdAndUpdate(
    'app',
    { $set: updates },
    { new: true, upsert: true, runValidators: true }
  );

  return ApiResponse.success(res, { pricing: doc.pricing }, 'Pricing updated');
};

module.exports = {
  getDashboard, getCustomers, getCustomer, updateCustomer, deleteCustomer,
  createDriver, getDriver, getDrivers, updateDriver, deleteDriver, assignCustomers,
  sendBulkSms, getOutstanding, getLiveSchedule, runAutoSchedule, getRevenueAnalytics, getCollectionAnalytics, getActivityLogs,
  getInvoices, generateInvoices, sendPaymentReminders, sendInvoiceReminder,
  getAdminComplaints, updateComplaint,
  getRoutes, createRoute, updateRoute, deleteRoute,
  getPricing, updatePricing,
};
