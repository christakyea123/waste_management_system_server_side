const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema(
  {
    ticketNumber: {
      type: String,
      unique: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    category: {
      type: String,
      enum: ['missed_collection', 'billing_issue', 'driver_conduct', 'service_quality', 'other'],
      required: true,
    },
    subject: {
      type: String,
      required: true,
      maxlength: 200,
    },
    description: {
      type: String,
      required: true,
      maxlength: 1000,
    },
    status: {
      type: String,
      enum: ['open', 'in_review', 'resolved', 'closed'],
      default: 'open',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resolution: {
      type: String,
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    attachments: [String],
  },
  { timestamps: true }
);

complaintSchema.pre('save', async function (next) {
  if (!this.ticketNumber) {
    const count = await mongoose.model('Complaint').countDocuments();
    this.ticketNumber = `TKT-${Date.now()}-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

complaintSchema.index({ customer: 1 });
complaintSchema.index({ status: 1 });

module.exports = mongoose.model('Complaint', complaintSchema);
