const Driver = require('../models/Driver');
const Customer = require('../models/Customer');
const Collection = require('../models/Collection');
const User = require('../models/User');
const Notification = require('../models/Notification');
const ApiResponse = require('../utils/apiResponse');
const { paginate } = require('../utils/pagination');
const smsService = require('../services/sms.service');
const logger = require('../utils/logger');
const { uploadToCloudinary } = require('../config/cloudinary');

// @desc    Get driver dashboard
// @route   GET /api/v1/driver/dashboard
// @access  Driver
const getDashboard = async (req, res) => {
  const driver = await Driver.findOne({ user: req.user._id })
    .populate('user', '-password')
    .populate('assignedRoute');

  if (!driver) return ApiResponse.error(res, 'Driver profile not found', 404);

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const todayStart = new Date(now.setHours(0, 0, 0, 0));
  const todayEnd = new Date(now.setHours(23, 59, 59, 999));

  const [
    todayCollections,
    todayCompleted,
    monthlyCollections,
    monthlyCompleted,
    assignedCustomers,
    pendingToday,
  ] = await Promise.all([
    Collection.countDocuments({ driver: driver._id, scheduledDate: { $gte: todayStart, $lte: todayEnd } }),
    Collection.countDocuments({ driver: driver._id, scheduledDate: { $gte: todayStart, $lte: todayEnd }, status: 'picked' }),
    Collection.countDocuments({ driver: driver._id, month, year }),
    Collection.countDocuments({ driver: driver._id, month, year, status: 'picked' }),
    Customer.countDocuments({ assignedDriver: driver._id, accountStatus: 'active' }),
    Collection.find({
      driver: driver._id,
      status: 'scheduled',
      scheduledDate: { $gte: todayStart, $lte: todayEnd },
    })
      .populate({
        path: 'customer',
        populate: { path: 'user', select: 'fullName phone' },
      })
      .limit(20),
  ]);

  return ApiResponse.success(res, {
    driver,
    stats: {
      todayCollections,
      todayCompleted,
      todayPending: todayCollections - todayCompleted,
      monthlyCollections,
      monthlyCompleted,
      assignedCustomers,
      performanceRate: monthlyCollections > 0
        ? Math.round((monthlyCompleted / monthlyCollections) * 100) : 100,
    },
    pendingToday,
  });
};

// @desc    Get driver's assigned customers
// @route   GET /api/v1/driver/customers
// @access  Driver
const getAssignedCustomers = async (req, res) => {
  const driver = await Driver.findOne({ user: req.user._id });
  if (!driver) return ApiResponse.error(res, 'Driver not found', 404);

  const { page, limit, search } = req.query;
  const query = { assignedDriver: driver._id, accountStatus: 'active' };

  const { data, pagination } = await paginate(Customer, query, {
    page,
    limit,
    populate: { path: 'user', select: 'fullName phone email profileImage' },
    sort: { 'location.coordinates': 1 },
  });

  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Get driver's collection schedule
// @route   GET /api/v1/driver/collections
// @access  Driver
const getCollections = async (req, res) => {
  const driver = await Driver.findOne({ user: req.user._id });
  if (!driver) return ApiResponse.error(res, 'Driver not found', 404);

  const { page, limit, status, date } = req.query;
  const query = { driver: driver._id };
  if (status) query.status = status;
  if (date) {
    const d = new Date(date);
    const start = new Date(d.setHours(0, 0, 0, 0));
    const end = new Date(d.setHours(23, 59, 59, 999));
    query.scheduledDate = { $gte: start, $lte: end };
  }

  const { data, pagination } = await paginate(Collection, query, {
    page,
    limit,
    populate: {
      path: 'customer',
      populate: { path: 'user', select: 'fullName phone' },
    },
    sort: { scheduledDate: 1 },
  });

  return ApiResponse.paginated(res, data, pagination);
};

// @desc    Mark collection status
// @route   PUT /api/v1/driver/collections/:id
// @access  Driver
const updateCollectionStatus = async (req, res) => {
  const { status, notes, missedReason, rescheduleDate, latitude, longitude } = req.body;
  const driver = await Driver.findOne({ user: req.user._id });
  if (!driver) return ApiResponse.error(res, 'Driver not found', 404);

  const collection = await Collection.findOne({ _id: req.params.id, driver: driver._id });
  if (!collection) return ApiResponse.error(res, 'Collection not found', 404);

  // Idempotency: only increment counters when transitioning from 'scheduled'
  const previousStatus = collection.status;
  const isNewCompletion = previousStatus === 'scheduled' || previousStatus === 'in_progress';

  collection.status = status;
  if (notes) collection.notes = notes;
  if (missedReason) collection.missedReason = missedReason;
  if (rescheduleDate) collection.rescheduleDate = new Date(rescheduleDate);
  if (status === 'picked') {
    collection.collectedAt = collection.collectedAt || new Date();
    collection.completedByDriver = true;
    if (isNewCompletion) driver.totalCollections += 1;
  }
  if (status === 'missed' && isNewCompletion) {
    driver.missedCollections += 1;
  }
  if (latitude && longitude) {
    collection.location = { latitude: parseFloat(latitude), longitude: parseFloat(longitude) };
  }
  if (req.file) {
    try {
      const result = await uploadToCloudinary(req.file.buffer, 'waste_management/evidence');
      collection.evidencePhoto = result.secure_url;
      collection.evidencePhotoPublicId = result.public_id;
    } catch (uploadErr) {
      logger.error(`Evidence photo upload failed: ${uploadErr.message}`);
    }
  }

  await Promise.all([collection.save(), driver.save()]);

  // Update customer collection stats only on first status transition
  if (isNewCompletion) {
    if (status === 'picked') {
      await Customer.findByIdAndUpdate(collection.customer, { $inc: { totalCollections: 1 } });
    } else if (status === 'missed') {
      await Customer.findByIdAndUpdate(collection.customer, { $inc: { missedCollections: 1 } });
    }
  }

  // Notify customer via SMS
  const customer = await Customer.findById(collection.customer).populate('user', 'phone fullName');
  if (customer?.user) {
    if (status === 'picked') {
      smsService.sendCollectionConfirmation(customer.user).catch((e) => logger.error(e.message));
    } else if (status === 'missed') {
      smsService.sendMissedCollection(customer.user, missedReason || 'Unknown reason').catch((e) => logger.error(e.message));
    }
  }

  // Save notification record
  await Notification.create({
    recipient: customer?.user?._id,
    type: status === 'picked' ? 'collection_completed' : 'collection_missed',
    title: status === 'picked' ? 'Waste Collected' : 'Collection Missed',
    message: status === 'picked'
      ? 'Your waste has been successfully collected.'
      : `Your waste collection was missed. Reason: ${missedReason}`,
    channel: 'sms',
    status: 'sent',
  });

  return ApiResponse.success(res, { collection }, 'Collection status updated');
};

// @desc    Update driver location
// @route   PUT /api/v1/driver/location
// @access  Driver
const updateLocation = async (req, res) => {
  const { latitude, longitude } = req.body;
  const driver = await Driver.findOneAndUpdate(
    { user: req.user._id },
    {
      currentLocation: {
        type: 'Point',
        coordinates: [parseFloat(longitude), parseFloat(latitude)],
        lastUpdated: new Date(),
      },
    },
    { new: true }
  );

  if (!driver) return ApiResponse.error(res, 'Driver not found', 404);
  return ApiResponse.success(res, { location: driver.currentLocation }, 'Location updated');
};

module.exports = { getDashboard, getAssignedCustomers, getCollections, updateCollectionStatus, updateLocation };
