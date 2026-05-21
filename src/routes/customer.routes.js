const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const {
  getDashboard, getCollections, getInvoices, getPayments,
  getNotifications, markNotificationRead, submitComplaint, getComplaints, updateLocation,
} = require('../controllers/customer.controller');
const { protect } = require('../middleware/auth.middleware');
const { isCustomer } = require('../middleware/rbac.middleware');
const { validate } = require('../middleware/validate.middleware');

router.use(protect, isCustomer);

router.get('/dashboard', getDashboard);
router.get('/collections', getCollections);
router.get('/invoices', getInvoices);
router.get('/payments', getPayments);
router.get('/notifications', getNotifications);
router.put('/notifications/:id/read', markNotificationRead);
router.post('/complaints', [
  body('category').notEmpty().withMessage('Category required'),
  body('subject').trim().notEmpty().withMessage('Subject required'),
  body('description').trim().isLength({ min: 10 }).withMessage('Description must be at least 10 characters'),
], validate, submitComplaint);
router.get('/complaints', getComplaints);
router.put('/location', [
  body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
  body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
], validate, updateLocation);

module.exports = router;
