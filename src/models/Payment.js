const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    transactionId: {
      type: String,
      unique: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invoice',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'GHS',
    },
    paymentMethod: {
      type: String,
      enum: ['paystack', 'cash', 'bank_transfer', 'mobile_money'],
      default: 'paystack',
    },
    status: {
      type: String,
      enum: ['pending', 'success', 'failed', 'refunded', 'abandoned'],
      default: 'pending',
    },
    paystackReference: {
      type: String,
      default: null,
    },
    paystackData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    channel: {
      type: String,
      default: null,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    receiptUrl: {
      type: String,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// transactionId already indexed via unique:true above
paymentSchema.index({ customer: 1 });
paymentSchema.index({ invoice: 1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ paystackReference: 1 });

paymentSchema.pre('save', function (next) {
  if (!this.transactionId) {
    this.transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
  }
  next();
});

module.exports = mongoose.model('Payment', paymentSchema);
