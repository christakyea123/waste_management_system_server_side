const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  getDashboard, getCustomers, getCustomer, updateCustomer, deleteCustomer,
  createDriver, getDriver, getDrivers, updateDriver, deleteDriver, assignCustomers,
  sendBulkSms, getRevenueAnalytics, getCollectionAnalytics, getActivityLogs,
  getInvoices, generateInvoices, sendPaymentReminders, sendInvoiceReminder,
  getAdminComplaints, updateComplaint,
  getRoutes, createRoute, updateRoute, deleteRoute,
  getPricing, updatePricing,
} = require('../controllers/admin.controller');
const { protect } = require('../middleware/auth.middleware');
const { isAdmin, isSuperAdmin } = require('../middleware/rbac.middleware');
const { validate } = require('../middleware/validate.middleware');
const { uploadProfile, handleMulterError } = require('../middleware/upload.middleware');

router.use(protect, isAdmin);

// Dashboard
router.get('/dashboard', getDashboard);

// Customer management
router.get('/customers', getCustomers);
router.get('/customers/:id', getCustomer);
router.put('/customers/:id', updateCustomer);
router.delete('/customers/:id', isSuperAdmin, deleteCustomer);

// Driver management
router.post('/drivers', uploadProfile.single('profileImage'), handleMulterError, [
  body('fullName').trim().notEmpty().withMessage('Full name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('phone').matches(/^(\+233|0)[0-9]{9}$/).withMessage('Valid phone required'),
  body('password').isLength({ min: 8 }).withMessage('Password 8+ chars required'),
  body('truckNumber').notEmpty().withMessage('Truck number required'),
], validate, createDriver);
router.get('/drivers', getDrivers);
router.get('/drivers/:id', getDriver);
router.put('/drivers/:id', updateDriver);
router.delete('/drivers/:id', isSuperAdmin, deleteDriver);
router.post('/drivers/:id/assign', assignCustomers);

// Billing
router.get('/invoices', getInvoices);
router.post('/invoices/generate', generateInvoices);
router.post('/invoices/send-reminders', sendPaymentReminders);
router.post('/invoices/:id/remind', sendInvoiceReminder);

// Analytics
router.get('/analytics/revenue', getRevenueAnalytics);
router.get('/analytics/collections', getCollectionAnalytics);

// Notifications
router.post('/notifications/bulk-sms', [
  body('message').notEmpty().withMessage('Message required'),
  body('targetGroup').notEmpty().withMessage('Target group required'),
], validate, sendBulkSms);

// Logs
router.get('/activity-logs', getActivityLogs);

// Complaints
router.get('/complaints', getAdminComplaints);
router.put('/complaints/:id', updateComplaint);

// Settings
router.get('/settings/pricing', getPricing);
router.put('/settings/pricing', [
  body('basic').optional().isFloat({ min: 0 }).withMessage('Basic price must be a positive number'),
  body('standard').optional().isFloat({ min: 0 }).withMessage('Standard price must be a positive number'),
  body('premium').optional().isFloat({ min: 0 }).withMessage('Premium price must be a positive number'),
], validate, updatePricing);

// Routes
router.get('/routes', getRoutes);
router.post('/routes', [
  body('name').notEmpty().withMessage('Route name required'),
  body('zone').notEmpty().withMessage('Zone required'),
], validate, createRoute);
router.put('/routes/:id', updateRoute);
router.delete('/routes/:id', isSuperAdmin, deleteRoute);

module.exports = router;
