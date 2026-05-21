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
    populate: { path: 'user', select: 'fullName email phone profileImage isActive lastLogin' },
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
    .populate('assignedDriver')
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

  if (accountStatus) customer.accountStatus = accountStatus;
  if (assignedDriver !== undefined) customer.assignedDriver = assignedDriver || null;
  if (collectionZone) customer.collectionZone = collectionZone;
  if (binType) customer.binType = binType;
  if (notes !== undefined) customer.notes = notes;
  if (collectionSchedule) customer.collectionSchedule = collectionSchedule;

  await customer.save();

  if (accountStatus === 'suspended') {
    const user = await User.findById(customer.user);
    if (user) {
      await User.findByIdAndUpdate(user._id, { isActive: false });
      smsService
        .send(user.phone, `Your WasteManagement account has been suspended. Contact support@wastemanagement.com`)
        .catch(logger.error);
    }
  }

  if (accountStatus === 'active') {
    await User.findByIdAndUpdate(customer.user, { isActive: true });
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
  const { fullName, email, phone, password, truckNumber, licenseNumber, zone } = req.body;

  const existing = await User.findOne({ $or: [{ email }, { phone }] });
  if (existing) return ApiResponse.error(res, 'Email or phone already in use', 409);

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

  const user = await User.create({
    fullName, email, phone, password, role: 'driver',
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
    .send(phone, `Welcome to WasteManagement Driver Portal! Your Driver ID is ${driver.driverId}. Password: ${password} Login at wastemanagement.com/driver`)
    .catch((e) => logger.error(`Driver welcome SMS failed: ${e.message}`));

  return ApiResponse.created(res, { driver }, 'Driver created successfully');
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
  const { page, limit, status, month, year } = req.query;
  const query = {};
  if (status) query.status = status;
  if (month) query.month = parseInt(month);
  if (year) query.year = parseInt(year);

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
  sendBulkSms, getRevenueAnalytics, getCollectionAnalytics, getActivityLogs,
  getInvoices, generateInvoices, sendPaymentReminders, sendInvoiceReminder,
  getAdminComplaints, updateComplaint,
  getRoutes, createRoute, updateRoute, deleteRoute,
  getPricing, updatePricing,
};
