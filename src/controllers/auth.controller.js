const crypto = require('crypto');
const User = require('../models/User');
const Customer = require('../models/Customer');
const Driver = require('../models/Driver');
const Route = require('../models/Route');
const ActivityLog = require('../models/ActivityLog');
const { sendTokenResponse } = require('../utils/generateToken');
const ApiResponse = require('../utils/apiResponse');
const smsService = require('../services/sms.service');
const logger = require('../utils/logger');
const { uploadToCloudinary } = require('../config/cloudinary');

// @desc    Register customer
// @route   POST /api/v1/auth/register
// @access  Public
const registerCustomer = async (req, res) => {
  const {
    fullName, email, phone, password, residentialAddress,
    latitude, longitude, binType, emergencyContact, collectionRoute,
  } = req.body;

  const existingUser = await User.findOne({ $or: [{ email }, { phone }] });
  if (existingUser) {
    return ApiResponse.error(res, 'Email or phone number already registered', 409);
  }

  // Upload profile image to Cloudinary if provided
  let profileImage = null;
  let profileImagePublicId = null;
  if (req.file) {
    try {
      const result = await uploadToCloudinary(req.file.buffer, 'waste_management/profiles');
      profileImage = result.secure_url;
      profileImagePublicId = result.public_id;
    } catch (uploadErr) {
      logger.error(`Profile image upload failed: ${uploadErr.message}`);
    }
  }

  // role is always 'customer' for self-registration — never trust client input
  const user = await User.create({
    fullName, email, phone, password, role: 'customer',
    profileImage,
    profileImagePublicId,
  });

  const customer = await Customer.create({
    user: user._id,
    residentialAddress,
    location: {
      type: 'Point',
      coordinates: [parseFloat(longitude) || 0, parseFloat(latitude) || 0],
      formattedAddress: residentialAddress,
    },
    binType: binType || 'basic',
    emergencyContact: emergencyContact ? JSON.parse(emergencyContact) : {},
    collectionRoute: collectionRoute || null,
  });

  // Send welcome SMS to customer
  smsService.sendWelcome(user).catch((e) => logger.error(`Welcome SMS failed: ${e.message}`));

  // Alert admin
  const admins = await User.find({ role: { $in: ['admin', 'superadmin'] }, isActive: true });
  for (const admin of admins) {
    smsService
      .sendRegistrationAlert(admin, { ...user.toObject(), residentialAddress })
      .catch((e) => logger.error(`Admin alert SMS failed: ${e.message}`));
  }

  await ActivityLog.create({
    user: user._id,
    action: 'REGISTER',
    resource: 'Customer',
    resourceId: customer._id.toString(),
    ipAddress: req.ip,
  });

  sendTokenResponse(user, 201, res);
};

// @desc    Login
// @route   POST /api/v1/auth/login
// @access  Public
const login = async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    return ApiResponse.error(res, 'Invalid email or password', 401);
  }

  if (!user.isActive) {
    return ApiResponse.error(res, 'Your account has been suspended. Contact support.', 403);
  }

  user.lastLogin = new Date();
  await user.save();

  await ActivityLog.create({
    user: user._id,
    action: 'LOGIN',
    resource: 'User',
    resourceId: user._id.toString(),
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  sendTokenResponse(user, 200, res);
};

// @desc    Logout
// @route   POST /api/v1/auth/logout
// @access  Private
const logout = async (req, res) => {
  res.cookie('token', '', {
    expires: new Date(0), // immediately expired — browser deletes it
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });
  return ApiResponse.success(res, {}, 'Logged out successfully');
};

// @desc    Get current user profile
// @route   GET /api/v1/auth/me
// @access  Private
const getMe = async (req, res) => {
  const user = await User.findById(req.user._id);
  let profile = null;

  if (user.role === 'customer') {
    profile = await Customer.findOne({ user: user._id }).populate('assignedDriver');
  } else if (user.role === 'driver') {
    profile = await Driver.findOne({ user: user._id }).populate('assignedRoute');
  }

  return ApiResponse.success(res, { user, profile });
};

// @desc    Update password
// @route   PUT /api/v1/auth/update-password
// @access  Private
const updatePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(currentPassword))) {
    return ApiResponse.error(res, 'Current password is incorrect', 400);
  }

  user.password = newPassword;
  await user.save();

  return ApiResponse.success(res, {}, 'Password updated successfully');
};

// @desc    Update profile
// @route   PUT /api/v1/auth/update-profile
// @access  Private
const updateProfile = async (req, res) => {
  const { fullName, phone } = req.body;
  const updateData = {};

  if (fullName) updateData.fullName = fullName;
  if (phone) updateData.phone = phone;
  if (req.file) {
    try {
      const result = await uploadToCloudinary(req.file.buffer, 'waste_management/profiles');
      updateData.profileImage = result.secure_url;
      updateData.profileImagePublicId = result.public_id;
    } catch (uploadErr) {
      logger.error(`Profile image upload failed: ${uploadErr.message}`);
      return ApiResponse.error(res, `Image upload failed: ${uploadErr.message}`, 400);
    }
  }

  const user = await User.findByIdAndUpdate(req.user._id, updateData, {
    new: true,
    runValidators: true,
  });

  return ApiResponse.success(res, { user }, 'Profile updated successfully');
};

// @desc    Create initial superadmin (run once)
// @desc    Forgot password — send OTP via SMS
// @route   POST /api/v1/auth/forgot-password
// @access  Public
const forgotPassword = async (req, res) => {
  const { phone } = req.body;

  // Match both 0XXXXXXXXX and +233XXXXXXXXX formats
  const cleaned = phone.replace(/\s+/g, '').replace(/-/g, '');
  const variants = [cleaned];
  if (cleaned.startsWith('0')) variants.push(`+233${cleaned.slice(1)}`);
  if (cleaned.startsWith('+233')) variants.push(`0${cleaned.slice(4)}`);

  const user = await User.findOne({ phone: { $in: variants } });
  if (!user) {
    return ApiResponse.error(res, 'No account found with this phone number', 404);
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const hashedOtp = crypto.createHash('sha256').update(otp).digest('hex');

  user.passwordResetToken = hashedOtp;
  user.passwordResetExpires = new Date(Date.now() + 15 * 60 * 1000);
  await user.save({ validateBeforeSave: false });

  smsService.send(user.phone, `035 F Arkoh: Hi ${user.fullName}, your password reset code is ${otp}. Valid 15 minutes. Do not share this code.`)
    .catch((e) => logger.error(`Password reset SMS failed: ${e.message}`));

  logger.info(`Password reset OTP for ${user.phone}: ${otp}`);

  const data = process.env.NODE_ENV === 'development' ? { otp } : {};
  return ApiResponse.success(res, data, 'Reset code sent to your phone');
};

// @desc    Reset password using OTP
// @route   POST /api/v1/auth/reset-password
// @access  Public
const resetPassword = async (req, res) => {
  const { phone, code, newPassword } = req.body;

  const cleaned = phone.replace(/\s+/g, '').replace(/-/g, '');
  const variants = [cleaned];
  if (cleaned.startsWith('0')) variants.push(`+233${cleaned.slice(1)}`);
  if (cleaned.startsWith('+233')) variants.push(`0${cleaned.slice(4)}`);

  const hashedCode = crypto.createHash('sha256').update(code.trim()).digest('hex');

  const user = await User.findOne({
    phone: { $in: variants },
    passwordResetToken: hashedCode,
    passwordResetExpires: { $gt: Date.now() },
  });

  if (!user) {
    return ApiResponse.error(res, 'Invalid or expired reset code. Please request a new one.', 400);
  }

  user.password = newPassword;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  logger.info(`Password reset for ${user.phone}`);
  return ApiResponse.success(res, {}, 'Password reset successfully. You can now log in.');
};

// @route   POST /api/v1/auth/init-admin
// @access  Public (protected by secret key — INIT_SECRET must be set in env)
const initAdmin = async (req, res) => {
  const { secret, fullName, email, phone, password } = req.body;
  const expectedSecret = process.env.INIT_SECRET || process.env.ADMIN_INIT_SECRET;

  // Always require a secret — reject if env var is missing or secret doesn't match
  if (!expectedSecret || secret !== expectedSecret) {
    return ApiResponse.error(res, 'Invalid init secret', 403);
  }

  const exists = await User.findOne({ role: 'superadmin' });
  if (exists) {
    return ApiResponse.error(res, 'Superadmin already exists', 409);
  }

  const admin = await User.create({
    fullName: fullName || 'Super Admin',
    email: email || process.env.ADMIN_EMAIL || 'admin@wastemanagement.com',
    phone: phone || process.env.ADMIN_PHONE || '0200000000',
    password: password || process.env.ADMIN_PASSWORD || 'Admin@123456',
    role: 'superadmin',
    isVerified: true,
    isActive: true,
  });

  return ApiResponse.created(res, { email: admin.email }, 'Superadmin created successfully');
};

// @desc    Get active routes (public — used by registration form)
// @route   GET /api/v1/auth/routes
// @access  Public
const getPublicRoutes = async (req, res) => {
  const routes = await Route.find({ isActive: true })
    .select('name zone description')
    .sort({ zone: 1, name: 1 });
  return ApiResponse.success(res, { routes });
};

// @desc    Get current service pricing (public — used by homepage)
// @route   GET /api/v1/auth/pricing
// @access  Public
const getPublicPricing = async (req, res) => {
  const Settings = require('../models/Settings');
  const pricing = await Settings.getPricing();
  // Short cache so admin price changes propagate within a minute but the homepage stays snappy.
  res.set('Cache-Control', 'public, max-age=60');
  return ApiResponse.success(res, { pricing });
};

module.exports = {
  registerCustomer, login, logout, getMe, updatePassword, updateProfile,
  initAdmin, forgotPassword, resetPassword, getPublicRoutes, getPublicPricing,
};
