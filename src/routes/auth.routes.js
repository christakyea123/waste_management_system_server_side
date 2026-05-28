const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  registerCustomer, login, logout, getMe,
  updatePassword, updateProfile, initAdmin,
  forgotPassword, resetPassword, getPublicRoutes, getPublicPricing,
  searchUsernames,
} = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { authLimiter, registrationLimiter, smsLimiter } = require('../middleware/rateLimit.middleware');
const { uploadProfile, handleMulterError } = require('../middleware/upload.middleware');

const { SERVICE_AREAS } = require('../models/Customer');

const registerValidation = [
  body('fullName').trim().notEmpty().withMessage('Full name is required'),
  // Email is optional now. Only validate it when a non-empty value is supplied.
  body('email')
    .optional({ checkFalsy: true })
    .isEmail().normalizeEmail().withMessage('Valid email required'),
  body('phone')
    .matches(/^(\+233|0)[0-9]{9}$/)
    .withMessage('Valid Ghanaian phone number required'),
  // No password field for customers — the phone number is the password,
  // set server-side. Any client-sent password is ignored.
  body('residentialAddress').trim().notEmpty().withMessage('Residential address is required'),
  body('area')
    .trim().notEmpty().withMessage('Service area is required')
    .isIn(SERVICE_AREAS).withMessage('Please select a valid service area'),
  body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
  body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
];

// Login supports two shapes:
//   - Customer:  { username, phone }     (phone is the password)
//   - Staff:     { identifier|email, password }
const loginValidation = [
  body().custom((value) => {
    const hasCustomer = value.username && (value.phone || value.password);
    const hasStaff = (value.identifier || value.email) && value.password;
    if (!hasCustomer && !hasStaff) {
      throw new Error('Provide your username and phone number to sign in');
    }
    return true;
  }),
];

router.post('/register', registrationLimiter, uploadProfile.single('profileImage'), handleMulterError, registerValidation, validate, registerCustomer);
router.post('/login', authLimiter, loginValidation, validate, login);
router.post('/logout', protect, logout);
router.get('/me', protect, getMe);
router.put('/update-password', protect, [
  body('currentPassword').notEmpty().withMessage('Current password required'),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be 8+ characters'),
], validate, updatePassword);
router.put('/update-profile', protect, uploadProfile.single('profileImage'), handleMulterError, updateProfile);
router.post('/forgot-password', smsLimiter, [
  body('phone').notEmpty().withMessage('Phone number is required'),
], validate, forgotPassword);
router.post('/reset-password', [
  body('phone').notEmpty().withMessage('Phone number is required'),
  body('code').isLength({ min: 6, max: 6 }).withMessage('Enter the 6-digit code'),
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], validate, resetPassword);
router.post('/init-admin', initAdmin);

// Public: username search for the login page (type-to-find)
router.get('/usernames', searchUsernames);

// Public: get active routes for registration form
router.get('/routes', getPublicRoutes);

// Public: current service pricing for the homepage
router.get('/pricing', getPublicPricing);

module.exports = router;
