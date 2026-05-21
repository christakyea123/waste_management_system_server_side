const twilio = require('twilio');
const logger = require('../utils/logger');
const Notification = require('../models/Notification');

class SmsService {
  constructor() {
    this.accountSid = process.env.TWILIO_ACCOUNT_SID;
    this.authToken = process.env.TWILIO_AUTH_TOKEN;
    this.fromNumber = process.env.TWILIO_PHONE_NUMBER;
    this._client = null;
  }

  get client() {
    if (!this._client) {
      if (!this.accountSid || !this.authToken) {
        throw new Error('Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing)');
      }
      this._client = twilio(this.accountSid, this.authToken);
    }
    return this._client;
  }

  // Normalize any Ghanaian phone to E.164 (+233XXXXXXXXX)
  normalizePhone(phone) {
    const cleaned = phone.replace(/[\s\-().]/g, '');
    if (cleaned.startsWith('+')) return cleaned;
    if (cleaned.startsWith('233')) return `+${cleaned}`;
    if (cleaned.startsWith('0')) return `+233${cleaned.slice(1)}`;
    return `+${cleaned}`;
  }

  async send(to, message) {
    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      logger.warn(`SMS skipped (Twilio not configured) → ${to}: ${message.slice(0, 60)}...`);
      return { success: false, error: 'Twilio not configured' };
    }

    const toFormatted = this.normalizePhone(to);

    try {
      const msg = await this.client.messages.create({
        body: message,
        from: this.fromNumber,
        to: toFormatted,
      });

      logger.info(`SMS sent to ${toFormatted} | SID: ${msg.sid} | Status: ${msg.status}`);
      return { success: true, data: { sid: msg.sid, status: msg.status } };
    } catch (error) {
      logger.error(`SMS failed to ${toFormatted}: [${error.code}] ${error.message}`);
      return { success: false, error: error.message, code: error.code };
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
