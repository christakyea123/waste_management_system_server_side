const crypto = require('crypto');
const User = require('../models/User');
const Customer = require('../models/Customer');
const Driver = require('../models/Driver');
const Route = require('../models/Route');
const ActivityLog = require('../models/ActivityLog');
const { sendTokenResponse } = require('../utils/generateToken');
const ApiResponse = require('../utils/apiResponse');
const smsService = require('../services/sms.service');
const invoiceService = require('../services/invoice.service');
const logger = require('../utils/logger');
const { uploadToCloudinary } = require('../config/cloudinary');

// @desc    Register customer
// @route   POST /api/v1/auth/register
// @access  Public
const registerCustomer = async (req, res) => {
  const {
    fullName, email, phone, residentialAddress, area,
    latitude, longitude, binType, emergencyContact, collectionRoute,
  } = req.body;

  // Phone-as-password: customers don't set a password. The phone number IS the
  // password (hashed like any other), so they only ever provide phone + username
  // at login. Ignore any client-supplied password.
  const password = phone;

  // Email is optional — normalise blank/empty to undefined so it isn't stored
  // as '' (which would collide on the sparse-unique index for every emailless
  // user and fail the format validator).
  const normalisedEmail = email && email.trim() ? email.trim().toLowerCase() : undefined;

  // Build the uniqueness check from whatever identifiers were actually supplied.
  const orClauses = [{ phone }];
  if (normalisedEmail) orClauses.push({ email: normalisedEmail });
  const existingUser = await User.findOne({ $or: orClauses });
  if (existingUser) {
    const clash = normalisedEmail && existingUser.email === normalisedEmail ? 'Email' : 'Phone number';
    return ApiResponse.error(res, `${clash} already registered`, 409);
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

  // Auto-generate a unique login username (e.g. "kwame.mensah47"). Generated
  // server-side so uniqueness is guaranteed — any client-sent value is ignored.
  const username = await User.generateUniqueUsername(fullName);

  // role is always 'customer' for self-registration — never trust client input
  const user = await User.create({
    fullName, email: normalisedEmail, phone, password, username, role: 'customer',
    profileImage,
    profileImagePublicId,
  });

  const customer = await Customer.create({
    user: user._id,
    residentialAddress,
    area,
    location: {
      type: 'Point',
      coordinates: [parseFloat(longitude) || 0, parseFloat(latitude) || 0],
      formattedAddress: residentialAddress,
    },
    binType: binType || 'standard',
    emergencyContact: emergencyContact ? JSON.parse(emergencyContact) : {},
    collectionRoute: collectionRoute || null,
  });

  // Subscription billing: issue the first monthly invoice immediately on
  // registration (the customer owes the plan fee whether or not pickups happen,
  // like any monthly subscription). The Customer pre-save hook has already set
  // monthlyFee from the plan, so the invoice picks up the correct amount.
  const now = new Date();
  invoiceService
    .ensureMonthlyInvoice(customer._id, now.getMonth() + 1, now.getFullYear())
    .catch((e) => logger.error(`Registration invoice failed for ${customer.customerId}: ${e.message}`));

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
  const { email, identifier, username, phone, password } = req.body;

  // Two supported login modes:
  //   1. Customer phone-as-password: { username, phone } — look up by username,
  //      verify the phone matches (phone is stored as the hashed password).
  //   2. Staff email/phone + password: { identifier|email, password } — the
  //      classic flow, used by admins and drivers.
  // Normalise a phone to a canonical 0XXXXXXXXX form so "+233.." and "0.." match.
  const canonPhone = (p) => {
    const c = (p || '').toString().replace(/[\s-]/g, '');
    if (c.startsWith('+233')) return `0${c.slice(4)}`;
    if (c.startsWith('233')) return `0${c.slice(3)}`;
    return c;
  };

  let user;
  let authed = false;

  if (username) {
    // Customer phone-as-password: look up by username, then check the entered
    // phone matches the account's phone (phone IS the password, so a direct,
    // format-tolerant comparison is equivalent and avoids hash format issues).
    user = await User.findOne({ username: String(username).trim().toLowerCase() });
    const entered = phone || password;
    authed = !!(user && entered && canonPhone(entered) === canonPhone(user.phone));
  } else {
    // Staff email/phone + password (admins, drivers, legacy clients).
    const raw = (identifier || email || '').trim();
    const looksLikeEmail = raw.includes('@');
    let query;
    if (looksLikeEmail) {
      query = { email: raw.toLowerCase() };
    } else {
      const cleaned = raw.replace(/[\s-]/g, '');
      const variants = [cleaned];
      if (cleaned.startsWith('0')) variants.push(`+233${cleaned.slice(1)}`);
      if (cleaned.startsWith('+233')) variants.push(`0${cleaned.slice(4)}`);
      query = { phone: { $in: variants } };
    }
    user = await User.findOne(query).select('+password');
    authed = !!(user && password && (await user.comparePassword(password)));
  }

  if (!authed) {
    return ApiResponse.error(res, 'Invalid credentials', 401);
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
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('token', '', {
    expires: new Date(0), // immediately expired — browser deletes it
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'strict',
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
    profile = await Customer.findOne({ user: user._id })
      .populate({ path: 'assignedDriver', populate: { path: 'user', select: 'fullName phone email profileImage' } });
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

// @desc    Search login accounts (public — used by the customer & driver login
//          pages so a user can find their username by typing their name OR
//          username, then confirm with their phone).
// @route   GET /api/v1/auth/usernames?q=sam&role=customer
// @access  Public
// Matches the query against the username (prefix) OR the full name (anywhere),
// so a user who only remembers their name can still find their account.
// Returns { username, fullName } pairs so the dropdown can show a friendly label.
// Note: requires a query of >= 2 chars and returns at most 10 matches, so the
// full user base can't be dumped in one request. `role` defaults to customer;
// the driver login page passes role=driver.
const searchUsernames = async (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (q.length < 2) return ApiResponse.success(res, { usernames: [], results: [] });
  // Only allow the two phone-as-password roles to be searched.
  const role = req.query.role === 'driver' ? 'driver' : 'customer';
  // Escape regex metacharacters in the user input before building the matches.
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const users = await User.find({
    role,
    username: { $exists: true, $ne: null },
    $or: [
      { username: { $regex: `^${safe}`, $options: 'i' } }, // username starts with q
      { fullName: { $regex: safe, $options: 'i' } },        // name contains q
    ],
  })
    .select('username fullName')
    .sort({ fullName: 1 })
    .limit(10);

  const results = users
    .filter((u) => u.username)
    .map((u) => ({ username: u.username, fullName: u.fullName || '' }));

  // `usernames` kept for backwards-compatibility; `results` is the richer shape.
  return ApiResponse.success(res, {
    usernames: results.map((r) => r.username),
    results,
  });
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
  searchUsernames,
};
