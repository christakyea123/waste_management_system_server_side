const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const ApiResponse = require('../utils/apiResponse');
const paystackService = require('../services/payment.service');
const smsService = require('../services/sms.service');
const invoiceService = require('../services/invoice.service');
const logger = require('../utils/logger');

// @desc    Initialize payment for an invoice
// @route   POST /api/v1/payments/initialize
// @access  Customer
const initializePayment = async (req, res) => {
  const { invoiceId } = req.body;

  const customer = await Customer.findOne({ user: req.user._id }).populate('user');
  if (!customer) return ApiResponse.error(res, 'Customer not found', 404);

  const invoice = await Invoice.findOne({ _id: invoiceId, customer: customer._id });
  if (!invoice) return ApiResponse.error(res, 'Invoice not found', 404);

  if (invoice.status === 'paid') {
    return ApiResponse.error(res, 'Invoice already paid', 400);
  }

  const callbackUrl = `${process.env.FRONTEND_URL}/customer/payment-callback.html`;
  const result = await paystackService.initializePayment(customer, invoice, callbackUrl);

  return ApiResponse.success(res, {
    authorizationUrl: result.data.authorization_url,
    accessCode: result.data.access_code,
    reference: result.reference,
  }, 'Payment initialized');
};

// @desc    Verify payment after callback
// @route   GET /api/v1/payments/verify/:reference
// @access  Customer / Admin
const verifyPayment = async (req, res) => {
  const { reference } = req.params;

  // Ownership check: customers may only verify their own references.
  // Admin/superadmin can verify any (useful for support tooling).
  if (req.user.role === 'customer') {
    const customer = await Customer.findOne({ user: req.user._id }).select('_id');
    if (!customer) return ApiResponse.error(res, 'Customer profile not found', 404);
    const owned = await Payment.findOne({ paystackReference: reference, customer: customer._id }).select('_id');
    if (!owned) return ApiResponse.error(res, 'Payment not found', 404);
  }

  const result = await paystackService.verifyPayment(reference);

  if (result.success) {
    const customer = await Customer.findById(result.payment.customer).populate('user');
    if (customer?.user && result.justSettled) {
      const invoice = await Invoice.findById(result.payment.invoice);
      smsService
        .sendPaymentSuccess(customer.user, result.payment.amount, invoice?.invoiceNumber)
        .catch((e) => logger.error(`Payment SMS failed: ${e.message}`));
    }
    return ApiResponse.success(res, { payment: result.payment }, 'Payment verified successfully');
  }

  return ApiResponse.error(res, result.message || 'Payment verification failed', 400);
};

// @desc    Paystack webhook handler
// @route   POST /api/v1/payments/webhook
// @access  Public (Paystack server)
const handleWebhook = async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  // express.raw() yields a Buffer — use toString() to get the raw JSON string for HMAC
  const rawBody = req.body.toString('utf8');

  if (!paystackService.validateWebhook(rawBody, signature)) {
    logger.warn('Invalid Paystack webhook signature');
    return res.status(401).json({ message: 'Invalid signature' });
  }

  const payload = JSON.parse(rawBody);
  const { event, data } = payload;
  await paystackService.handleWebhook(event, data);

  res.status(200).json({ received: true });
};

// @desc    Download invoice as PDF
// @route   GET /api/v1/payments/invoice/:id/pdf
// @access  Customer/Admin
const downloadInvoicePdf = async (req, res) => {
  try {
    const customer = await Customer.findOne({ user: req.user._id });
    const query = { _id: req.params.id };
    if (req.user.role === 'customer' && customer) {
      query.customer = customer._id;
    }

    const invoice = await Invoice.findOne(query);
    if (!invoice) return ApiResponse.error(res, 'Invoice not found', 404);

    const pdfBuffer = await invoiceService.generatePDF(invoice._id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice-${invoice.invoiceNumber}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    logger.error(`PDF generation failed: ${error.message}`);
    return ApiResponse.error(res, 'Failed to generate PDF', 500);
  }
};

// @desc    Get payment history (Admin)
// @route   GET /api/v1/payments
// @access  Admin
const getAllPayments = async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const query = {};
  if (status) query.status = status;

  const skip = (page - 1) * limit;
  const [payments, total] = await Promise.all([
    Payment.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate({ path: 'customer', populate: { path: 'user', select: 'fullName email phone' } })
      .populate('invoice', 'invoiceNumber month year'),
    Payment.countDocuments(query),
  ]);

  return ApiResponse.paginated(res, payments, {
    total, page: parseInt(page), limit: parseInt(limit),
    pages: Math.ceil(total / limit),
  });
};

module.exports = { initializePayment, verifyPayment, handleWebhook, downloadInvoicePdf, getAllPayments };
