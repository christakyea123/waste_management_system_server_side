const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Collection = require('../models/Collection');
const Complaint = require('../models/Complaint');
const Notification = require('../models/Notification');
const ApiResponse = require('../utils/apiResponse');
const { paginate } = require('../utils/pagination');

// @desc    Get customer dashboard
// @route   GET /api/v1/customer/dashboard
// @access  Customer
const getDashboard = async (req, res) => {
  const customer = await Customer.findOne({ user: req.user._id })
    .populate('user', '-password')
    .populate('assignedDriver');

  if (!customer) return ApiResponse.error(res, 'Customer profile not found', 404);

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const [
    currentInvoice,
    totalPaid,
    outstandingBalance,
    lastCollection,
    nextCollection,
    totalCollections,
    missedCollections,
    unreadNotifications,
    openComplaints,
  ] = await Promise.all([
    Invoice.findOne({ customer: customer._id, month, year }),
    Payment.aggregate([
      { $match: { customer: customer._id, status: 'success' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Invoice.aggregate([
      { $match: { customer: customer._id, status: { $in: ['pending', 'overdue'] } } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]),
    Collection.findOne({ customer: customer._id, status: 'picked' }).sort({ collectedAt: -1 }),
    Collection.findOne({ customer: customer._id, status: 'scheduled', scheduledDate: { $gte: now } }).sort({ scheduledDate: 1 }),
    Collection.countDocuments({ customer: customer._id }),
    Collection.countDocuments({ customer: customer._id, status: 'missed' }),
    Notification.countDocuments({ recipient: req.user._id, isRead: false }),
    Complaint.countDocuments({ customer: customer._id, status: { $in: ['open', 'in_review'] } }),
  ]);

  const collectionRate = totalCollections > 0
    ? Math.round(((totalCollections - missedCollections) / totalCollections) * 100)
    : 100;

  return ApiResponse.success(res, {
    customer,
    stats: {
      totalPaid: totalPaid[0]?.total || 0,
      outstandingBalance: outstandingBalance[0]?.total || 0,
      lastCollectionDate: lastCollection?.collectedAt || null,
      nextCollectionDate: nextCollection?.scheduledDate || null,
      totalCollections,
      missedCollections,
      collectionRate,
      unreadNotifications,
      openComplaints,
    },
    currentInvoice,
  });
};

// @desc    Get customer collection history
// @route   GET /api/v1/customer/collections
// @access  Customer
const getCollections = async (req, res) => {
  const customer = await Customer.findOne({ user: req.user._id });
  if (!customer) return ApiResponse.error(res, 'Customer not found', 404);

  const { page, limit, status, month, year } = req.query;
  const query = { customer: customer._id };
  if (status) query.status = status;
  if (month) query.month = parseInt(month);
  if (year) query.year = parseInt(year);

  const { data, pagination } = await paginate(Collection, query, {
    page: page || 1,
    limit: limit || 10,
    populate: { path: 'driver', populate: { path: 'user', select: 'fullName phone' } },
    sort: { scheduledDate: -1 },
  });

  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Get customer invoices
// @route   GET /api/v1/customer/invoices
// @access  Customer
const getInvoices = async (req, res) => {
  const customer = await Customer.findOne({ user: req.user._id });
  if (!customer) return ApiResponse.error(res, 'Customer not found', 404);

  const { page, limit, status } = req.query;
  const query = { customer: customer._id };
  if (status) query.status = status;

  const { data, pagination } = await paginate(Invoice, query, {
    page,
    limit,
    sort: { createdAt: -1 },
  });

  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Get customer payment history
// @route   GET /api/v1/customer/payments
// @access  Customer
const getPayments = async (req, res) => {
  const customer = await Customer.findOne({ user: req.user._id });
  if (!customer) return ApiResponse.error(res, 'Customer not found', 404);

  const { page, limit } = req.query;
  const { data, pagination } = await paginate(Payment, { customer: customer._id, status: 'success' }, {
    page,
    limit,
    populate: { path: 'invoice', select: 'invoiceNumber month year' },
    sort: { paidAt: -1 },
  });

  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Get customer notifications
// @route   GET /api/v1/customer/notifications
// @access  Customer
const getNotifications = async (req, res) => {
  const { page, limit } = req.query;
  const { data, pagination } = await paginate(Notification, { recipient: req.user._id }, {
    page,
    limit,
    sort: { createdAt: -1 },
  });

  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Mark notification as read
// @route   PUT /api/v1/customer/notifications/:id/read
// @access  Customer
const markNotificationRead = async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, recipient: req.user._id },
    { isRead: true, readAt: new Date(), status: 'read' },
    { new: true }
  );

  if (!notification) return ApiResponse.error(res, 'Notification not found', 404);
  return ApiResponse.success(res, { notification }, 'Marked as read');
};

// @desc    Submit complaint
// @route   POST /api/v1/customer/complaints
// @access  Customer
const submitComplaint = async (req, res) => {
  const customer = await Customer.findOne({ user: req.user._id });
  if (!customer) return ApiResponse.error(res, 'Customer not found', 404);

  const { category, subject, description } = req.body;
  const complaint = await Complaint.create({
    customer: customer._id,
    category,
    subject,
    description,
  });

  return ApiResponse.created(res, { complaint }, 'Complaint submitted successfully');
};

// @desc    Get customer complaints
// @route   GET /api/v1/customer/complaints
// @access  Customer
const getComplaints = async (req, res) => {
  const customer = await Customer.findOne({ user: req.user._id });
  if (!customer) return ApiResponse.error(res, 'Customer not found', 404);

  const complaints = await Complaint.find({ customer: customer._id }).sort({ createdAt: -1 });
  return ApiResponse.success(res, { complaints });
};

// @desc    Update customer location
// @route   PUT /api/v1/customer/location
// @access  Customer
const updateLocation = async (req, res) => {
  const { latitude, longitude, address } = req.body;
  const customer = await Customer.findOneAndUpdate(
    { user: req.user._id },
    {
      location: {
        type: 'Point',
        coordinates: [parseFloat(longitude), parseFloat(latitude)],
        formattedAddress: address,
      },
      residentialAddress: address,
    },
    { new: true }
  );

  if (!customer) return ApiResponse.error(res, 'Customer not found', 404);
  return ApiResponse.success(res, { customer }, 'Location updated');
};

module.exports = {
  getDashboard, getCollections, getInvoices, getPayments,
  getNotifications, markNotificationRead, submitComplaint, getComplaints, updateLocation,
};
