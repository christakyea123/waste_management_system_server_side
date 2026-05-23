const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  registerCustomer, login, logout, getMe,
  updatePassword, updateProfile, initAdmin,
  forgotPassword, resetPassword, getPublicRoutes, getPublicPricing,
} = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth.middleware');
const { validate } = require('../middleware/validate.middleware');
const { authLimiter, registrationLimiter, smsLimiter } = require('../middleware/rateLimit.middleware');
const { uploadProfile, handleMulterError } = require('../middleware/upload.middleware');

const registerValidation = [
  body('fullName').trim().notEmpty().withMessage('Full name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('phone')
    .matches(/^(\+233|0)[0-9]{9}$/)
    .withMessage('Valid Ghanaian phone number required'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters'),
  body('residentialAddress').trim().notEmpty().withMessage('Residential address is required'),
  body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
  body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
];

const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
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

// Public: get active routes for registration form
router.get('/routes', getPublicRoutes);

// Public: current service pricing for the homepage
router.get('/pricing', getPublicPricing);

module.exports = router;
