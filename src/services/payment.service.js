const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');

class PaystackService {
  constructor() {
    this.secretKey = process.env.PAYSTACK_SECRET_KEY;
    this.publicKey = process.env.PAYSTACK_PUBLIC_KEY;
    this.baseUrl = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
  }

  get headers() {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
    };
  }

  // Initialize a payment transaction
  async initializePayment(customer, invoice, callbackUrl) {
    try {
      // Idempotency: reuse existing pending payment to avoid duplicate records
      const existing = await Payment.findOne({
        invoice: invoice._id,
        status: { $in: ['pending', 'success'] },
      });
      if (existing?.status === 'success') {
        throw new Error('Invoice is already paid');
      }
      if (existing?.status === 'pending') {
        logger.info(`Reusing existing pending payment: ${existing.paystackReference}`);
        return { success: true, data: existing.metadata.initData, reference: existing.paystackReference };
      }

      const reference = `WM-${invoice.invoiceNumber}-${Date.now()}`;
      const amountInKobo = Math.round(invoice.totalAmount * 100);

      const payload = {
        email: customer.user.email,
        amount: amountInKobo,
        reference,
        currency: 'GHS',
        callback_url: callbackUrl,
        metadata: {
          customerId: customer._id.toString(),
          customerId_str: customer.customerId,
          invoiceId: invoice._id.toString(),
          invoiceNumber: invoice.invoiceNumber,
          customerName: customer.user.fullName,
        },
        channels: ['card', 'mobile_money', 'bank'],
      };

      const response = await axios.post(`${this.baseUrl}/transaction/initialize`, payload, {
        headers: this.headers,
        timeout: 15000,
      });

      if (!response.data.status) throw new Error('Failed to initialize payment');

      // Create pending payment record
      await Payment.create({
        customer: customer._id,
        invoice: invoice._id,
        amount: invoice.totalAmount,
        paystackReference: reference,
        status: 'pending',
        metadata: { initData: response.data.data },
      });

      logger.info(`Payment initialized: ${reference} for customer ${customer.customerId}`);
      return { success: true, data: response.data.data, reference };
    } catch (error) {
      logger.error(`Payment initialization failed: ${error.message}`);
      throw error;
    }
  }

  // Verify a transaction
  async verifyPayment(reference) {
    try {
      const response = await axios.get(`${this.baseUrl}/transaction/verify/${reference}`, {
        headers: this.headers,
        timeout: 15000,
      });

      const txData = response.data.data;

      if (!response.data.status) {
        return { success: false, message: 'Verification failed' };
      }

      const payment = await Payment.findOne({ paystackReference: reference });
      if (!payment) return { success: false, message: 'Payment record not found' };

      // Idempotency: skip reprocessing an already-settled payment
      if (payment.status === 'success') {
        logger.info(`Payment already processed: ${reference}`);
        return { success: true, payment, paystackData: payment.paystackData };
      }

      if (txData.status === 'success') {
        payment.status = 'success';
        payment.paidAt = new Date(txData.paid_at);
        payment.channel = txData.channel;
        payment.paystackData = txData;
        await payment.save();

        // Update invoice
        await Invoice.findByIdAndUpdate(payment.invoice, {
          status: 'paid',
          paidDate: new Date(),
          paymentReference: reference,
        });

        logger.info(`Payment verified successfully: ${reference}`);
        return { success: true, payment, paystackData: txData };
      } else {
        payment.status = txData.status === 'abandoned' ? 'abandoned' : 'failed';
        payment.paystackData = txData;
        await payment.save();

        return { success: false, message: `Payment ${txData.status}`, payment };
      }
    } catch (error) {
      logger.error(`Payment verification failed: ${error.message}`);
      throw error;
    }
  }

  // Validate Paystack webhook signature
  validateWebhook(payload, signature) {
    const hash = crypto
      .createHmac('sha512', this.secretKey)
      .update(payload)
      .digest('hex');
    return hash === signature;
  }

  // Handle webhook events
  async handleWebhook(event, data) {
    logger.info(`Paystack webhook received: ${event}`);

    switch (event) {
      case 'charge.success':
        return this.verifyPayment(data.reference);
      case 'transfer.success':
        logger.info(`Transfer success: ${data.reference}`);
        break;
      case 'transfer.failed':
        logger.warn(`Transfer failed: ${data.reference}`);
        break;
      default:
        logger.info(`Unhandled webhook event: ${event}`);
    }
  }

  // Get transaction list
  async getTransactions(perPage = 50, page = 1) {
    const response = await axios.get(`${this.baseUrl}/transaction`, {
      headers: this.headers,
      params: { perPage, page },
    });
    return response.data;
  }
}

module.exports = new PaystackService();
