const mongoose = require('mongoose');

const collectionSchema = new mongoose.Schema(
  {
    collectionId: {
      type: String,
      unique: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      required: true,
    },
    scheduledDate: {
      type: Date,
      required: true,
    },
    collectedAt: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: ['scheduled', 'picked', 'missed', 'rescheduled', 'blocked_access'],
      default: 'scheduled',
    },
    notes: {
      type: String,
      maxlength: 500,
    },
    evidencePhoto: {
      type: String,
      default: null,
    },
    evidencePhotoPublicId: {
      type: String,
      default: null,
    },
    location: {
      latitude: Number,
      longitude: Number,
    },
    missedReason: {
      type: String,
      enum: ['blocked_access', 'no_bin_out', 'customer_not_home', 'road_issue', 'truck_breakdown', 'other'],
      default: null,
    },
    rescheduleDate: {
      type: Date,
      default: null,
    },
    month: {
      type: Number,
      required: true,
    },
    year: {
      type: Number,
      required: true,
    },
    completedByDriver: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

collectionSchema.index({ customer: 1 });
collectionSchema.index({ driver: 1 });
collectionSchema.index({ status: 1 });
collectionSchema.index({ scheduledDate: 1 });
collectionSchema.index({ month: 1, year: 1 });

collectionSchema.pre('save', async function (next) {
  if (!this.collectionId) {
    const count = await mongoose.model('Collection').countDocuments();
    this.collectionId = `COL-${Date.now()}-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Collection', collectionSchema);
