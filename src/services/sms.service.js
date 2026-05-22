const axios = require('axios');
const logger = require('../utils/logger');
const Notification = require('../models/Notification');

/**
 * mNotify SMS provider.
 *
 * Docs: https://readthedocs.mnotify.com/  (Quick SMS endpoint)
 *   POST {base}/sms/quick?key={MNOTIFY_API_KEY}
 *   body: { recipient: ["233244..."], sender, message, is_schedule: "false", schedule_date: "" }
 *
 * Success response carries `code` / `status`. mNotify currently returns:
 *   "code": "2000"  -> queued for delivery
 *   anything else   -> failure (insufficient balance, invalid sender, etc.)
 *
 * The public method surface (`send`, `sendBulk`, `sendWelcome`, …) is unchanged
 * from the previous Twilio implementation so no controller has to know which
 * provider is wired in behind it.
 */
class SmsService {
  constructor() {
    this.apiKey = process.env.MNOTIFY_API_KEY;
    this.senderId = process.env.MNOTIFY_SENDER_ID;
    this.baseUrl = process.env.MNOTIFY_BASE_URL || 'https://api.mnotify.com/api';
  }

  // mNotify wants recipients as Ghanaian numbers in 233XXXXXXXXX form (no plus,
  // no leading zero). We accept anything callers throw at us and normalise.
  normalizePhone(phone) {
    const cleaned = String(phone || '').replace(/[\s\-().]/g, '');
    if (cleaned.startsWith('+233')) return cleaned.slice(1);   // +233244... -> 233244...
    if (cleaned.startsWith('233'))  return cleaned;
    if (cleaned.startsWith('0'))    return `233${cleaned.slice(1)}`;
    return cleaned;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.senderId);
  }

  async send(to, message) {
    if (!this.isConfigured()) {
      logger.warn(`SMS skipped (mNotify not configured) → ${to}: ${message.slice(0, 60)}...`);
      return { success: false, error: 'mNotify not configured' };
    }

    const recipient = this.normalizePhone(to);

    try {
      const res = await axios.post(
        `${this.baseUrl}/sms/quick`,
        {
          recipient: [recipient],
          sender: this.senderId,
          message,
          is_schedule: 'false',
          schedule_date: '',
        },
        {
          // API key goes on the query string per mNotify spec.
          params: { key: this.apiKey },
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000,
          // Don't throw on 4xx so we can read mNotify's structured error body
          // and convert it into a graceful { success: false } result instead of
          // bubbling an exception up into a controller and 500-ing the request.
          validateStatus: (status) => status < 500,
        },
      );

      const data = res.data || {};
      // mNotify success marker is `code: "2000"`. Some plans return `status: "success"`
      // instead, so we treat either as the green path.
      const code = String(data.code || '');
      const status = String(data.status || '').toLowerCase();
      const ok = code === '2000' || status === 'success';

      if (!ok) {
        const reason = data.message || data.error || `HTTP ${res.status}`;
        logger.error(`SMS failed to ${recipient}: [${code || res.status}] ${reason}`);
        return { success: false, error: reason, code: code || String(res.status) };
      }

      // mNotify returns a message id in `summary.message_id` or `data.message_id`
      // depending on the response shape. Grab whichever is present so we can
      // store it on the Notification row for traceability.
      const messageId =
        data?.summary?.message_id ||
        data?.summary?.batch_id ||
        data?.data?.message_id ||
        null;

      logger.info(`SMS sent to ${recipient} | id: ${messageId || 'n/a'} | code: ${code || 'ok'}`);
      return { success: true, data: { sid: messageId, status: 'queued', raw: data } };
    } catch (error) {
      // Reaches here only on a true network/timeout failure or 5xx, since
      // 4xx is captured above via validateStatus.
      logger.error(`SMS failed to ${recipient}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async sendBulk(recipients, message) {
    const results = await Promise.allSettled(
      recipients.map((phone) => this.send(phone, message))
    );
    return results;
  }

  async sendWelcome(user) {
    const msg = `Welcome to WasteManagement! Dear ${user.fullName}, your account has been created successfully. For support call 0800-WASTE. Thank you for choosing us!`;
    return this.send(user.phone, msg);
  }

  async sendRegistrationAlert(admin, customer) {
    const msg = `NEW REGISTRATION: ${customer.fullName} (${customer.phone}) registered. Address: ${customer.residentialAddress}. Please assign a driver.`;
    return this.send(admin.phone, msg);
  }

  async sendPaymentSuccess(user, amount, invoiceNumber) {
    const msg = `Payment Confirmed! Dear ${user.fullName}, your payment of GHS ${amount} for invoice ${invoiceNumber} was successful. Thank you!`;
    return this.send(user.phone, msg);
  }

  async sendPaymentReminder(user, amount, dueDate, invoiceNumber) {
    const due = new Date(dueDate).toLocaleDateString('en-GH');
    const msg = `Payment Reminder: Dear ${user.fullName}, your waste collection fee of GHS ${amount} (Invoice: ${invoiceNumber}) is due on ${due}. Pay at wastemanagement.com to avoid service interruption.`;
    return this.send(user.phone, msg);
  }

  async sendCollectionReminder(user, date) {
    const d = new Date(date).toLocaleDateString('en-GH');
    const msg = `Collection Reminder: Dear ${user.fullName}, your waste will be collected on ${d}. Please ensure your bin is placed outside by 6:00 AM.`;
    return this.send(user.phone, msg);
  }

  async sendCollectionConfirmation(user) {
    const msg = `Collection Complete: Dear ${user.fullName}, your waste has been collected today. Thank you for keeping your bin ready. See you next collection!`;
    return this.send(user.phone, msg);
  }

  async sendMissedCollection(user, reason) {
    const msg = `Missed Collection: Dear ${user.fullName}, we were unable to collect your waste today. Reason: ${reason}. It will be rescheduled. We apologize for the inconvenience.`;
    return this.send(user.phone, msg);
  }

  async saveNotification(recipientId, type, title, message, channel = 'sms', smsResult = null) {
    try {
      await Notification.create({
        recipient: recipientId,
        type,
        title,
        message,
        channel,
        status: smsResult?.success ? 'sent' : 'failed',
        sentAt: smsResult?.success ? new Date() : null,
        smsMessageId: smsResult?.data?.sid || null,
      });
    } catch (err) {
      logger.error(`Failed to save notification record: ${err.message}`);
    }
  }
}

module.exports = new SmsService();
