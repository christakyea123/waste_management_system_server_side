const express = require('express');
const router = express.Router();
const {
  initializePayment, verifyPayment, handleWebhook,
  downloadInvoicePdf, getAllPayments,
} = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth.middleware');
const { isAdmin, isCustomer } = require('../middleware/rbac.middleware');
const { paymentLimiter } = require('../middleware/rateLimit.middleware');

// Public webhook (no auth — verified by signature)
router.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// Protected routes
router.post('/initialize', protect, paymentLimiter, initializePayment);
router.get('/verify/:reference', protect, verifyPayment);
router.get('/invoice/:id/pdf', protect, downloadInvoicePdf);
router.get('/', protect, isAdmin, getAllPayments);

module.exports = router;
