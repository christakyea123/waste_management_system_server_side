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

  // Verify a transaction.
  // Returns { success, payment, paystackData, justSettled, message? }.
  // `justSettled` is true only on the call that actually transitioned the payment
  // from pending → success, so callers (controller, webhook) can avoid double-sending
  // SMS / firing duplicate side effects when the webhook and the user callback race.
  async verifyPayment(reference) {
    try {
      const existing = await Payment.findOne({ paystackReference: reference });
      if (!existing) return { success: false, message: 'Payment record not found' };

      // Fast path: already settled — skip the Paystack round-trip.
      if (existing.status === 'success') {
        return { success: true, payment: existing, paystackData: existing.paystackData, justSettled: false };
      }

      const response = await axios.get(`${this.baseUrl}/transaction/verify/${reference}`, {
        headers: this.headers,
        timeout: 15000,
      });

      const txData = response.data.data;
      if (!response.data.status || !txData) {
        return { success: false, message: 'Verification failed' };
      }

      // Failure path: record and exit (no invoice mutation).
      if (txData.status !== 'success') {
        const failureStatus = txData.status === 'abandoned' ? 'abandoned' : 'failed';
        await Payment.findOneAndUpdate(
          { paystackReference: reference, status: 'pending' },
          { status: failureStatus, paystackData: txData },
        );
        const updated = await Payment.findOne({ paystackReference: reference });
        return { success: false, message: `Payment ${txData.status}`, payment: updated };
      }

      // Tamper checks before we trust the success signal.
      // 1) Currency must match what we stored on the invoice.
      const expectedCurrency = existing.currency || 'GHS';
      if (txData.currency && txData.currency !== expectedCurrency) {
        logger.error(`Currency mismatch on ${reference}: paystack=${txData.currency} expected=${expectedCurrency}`);
        return { success: false, message: 'Payment currency mismatch' };
      }
      // 2) Amount must match the stored amount (kobo precision).
      const expectedKobo = Math.round(existing.amount * 100);
      if (typeof txData.amount === 'number' && txData.amount !== expectedKobo) {
        logger.error(`Amount mismatch on ${reference}: paystack=${txData.amount} expected=${expectedKobo}`);
        return { success: false, message: 'Payment amount mismatch' };
      }

      // Atomic flip: only the first concurrent caller (webhook OR user callback)
      // succeeds in matching {status:'pending'} and gets justSettled=true.
      const settled = await Payment.findOneAndUpdate(
        { paystackReference: reference, status: 'pending' },
        {
          status: 'success',
          paidAt: txData.paid_at ? new Date(txData.paid_at) : new Date(),
          channel: txData.channel,
          paystackData: txData,
        },
        { new: true },
      );

      // Lost the race: another caller already flipped it. Return success but justSettled=false.
      if (!settled) {
        const latest = await Payment.findOne({ paystackReference: reference });
        if (latest?.status === 'success') {
          return { success: true, payment: latest, paystackData: latest.paystackData, justSettled: false };
        }
        return { success: false, message: 'Payment state changed during verification' };
      }

      // Conditional invoice flip — only mark paid if still unpaid.
      // Prevents stomping `paidDate` if a parallel call already wrote it.
      await Invoice.findOneAndUpdate(
        { _id: settled.invoice, status: { $ne: 'paid' } },
        { status: 'paid', paidDate: new Date(), paymentReference: reference },
      );

      logger.info(`Payment verified successfully: ${reference}`);
      return { success: true, payment: settled, paystackData: txData, justSettled: true };
    } catch (error) {
      logger.error(`Payment verification failed: ${error.message}`);
      throw error;
    }
  }

  // Validate Paystack webhook signature using a constant-time comparison
  // so an attacker cannot byte-by-byte probe the HMAC via timing differences.
  validateWebhook(payload, signature) {
    if (!signature || typeof signature !== 'string') return false;
    const expected = crypto
      .createHmac('sha512', this.secretKey)
      .update(payload)
      .digest('hex');
    if (expected.length !== signature.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
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
