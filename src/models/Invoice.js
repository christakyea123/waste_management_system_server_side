const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: {
      type: String,
      unique: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    year: {
      type: Number,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    paidDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'overdue', 'failed', 'cancelled'],
      default: 'pending',
    },
    paymentReference: {
      type: String,
      default: null,
    },
    description: {
      type: String,
      default: '',
    },
    collectionsCount: {
      type: Number,
      default: 0,
    },
    missedCount: {
      type: Number,
      default: 0,
    },
    lateFee: {
      type: Number,
      default: 0,
    },
    discount: {
      type: Number,
      default: 0,
    },
    totalAmount: {
      type: Number,
    },
    pdfUrl: {
      type: String,
      default: null,
    },
    remindersSent: {
      type: Number,
      default: 0,
    },
    lastReminderDate: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// invoiceNumber already indexed via unique:true above
invoiceSchema.index({ customer: 1 });
invoiceSchema.index({ status: 1 });
invoiceSchema.index({ month: 1, year: 1 });
invoiceSchema.index({ dueDate: 1 });

invoiceSchema.pre('save', async function (next) {
  if (!this.invoiceNumber) {
    const count = await mongoose.model('Invoice').countDocuments();
    const d = new Date();
    this.invoiceNumber = `INV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}-${String(count + 1).padStart(5, '0')}`;
  }
  // Calculate total
  this.totalAmount = (this.amount + (this.lateFee || 0)) - (this.discount || 0);
  next();
});

module.exports = mongoose.model('Invoice', invoiceSchema);
