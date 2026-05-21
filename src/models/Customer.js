const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    customerId: {
      type: String,
      unique: true,
    },
    residentialAddress: {
      type: String,
      required: [true, 'Residential address is required'],
      trim: true,
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: [true, 'GPS coordinates are required'],
      },
      formattedAddress: String,
    },
    binType: {
      type: String,
      enum: ['basic', 'standard', 'premium'],
      default: 'basic',
    },
    binSize: {
      type: String,
      enum: ['small', 'medium', 'large'],
      default: 'medium',
    },
    emergencyContact: {
      name: String,
      phone: String,
      relationship: String,
    },
    assignedDriver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      default: null,
    },
    collectionRoute: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Route',
      default: null,
    },
    collectionZone: {
      type: String,
      default: null,
    },
    collectionSchedule: {
      day: {
        type: String,
        enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
        default: 'monday',
      },
      frequency: {
        type: String,
        enum: ['weekly', 'biweekly'],
        default: 'weekly',
      },
    },
    monthlyFee: {
      type: Number,
      default: 50,
    },
    accountStatus: {
      type: String,
      enum: ['active', 'suspended', 'pending', 'cancelled'],
      default: 'pending',
    },
    totalCollections: {
      type: Number,
      default: 0,
    },
    missedCollections: {
      type: Number,
      default: 0,
    },
    notes: {
      type: String,
      maxlength: 500,
    },
    registrationDate: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Geospatial index
// user and customerId already indexed via unique:true above
customerSchema.index({ location: '2dsphere' });
customerSchema.index({ assignedDriver: 1 });
customerSchema.index({ collectionRoute: 1 });
customerSchema.index({ accountStatus: 1 });

// Counter document for atomic ID generation
const CounterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const Counter = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);

// Auto-generate customer ID atomically (race-condition safe)
customerSchema.pre('save', async function (next) {
  if (!this.customerId) {
    const counter = await Counter.findOneAndUpdate(
      { _id: 'customerId' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    this.customerId = `WM-${String(counter.seq).padStart(5, '0')}`;
  }
  next();
});

// Set monthly fee based on bin type. Pricing lives in the Settings collection
// (editable by admins from the dashboard) with env-var fallback for fresh installs.
customerSchema.pre('save', async function (next) {
  if (!this.isModified('binType') && this.monthlyFee) return next();
  try {
    const Settings = mongoose.model('Settings');
    const pricing = await Settings.getPricing();
    this.monthlyFee = pricing[this.binType] ?? pricing.basic;
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Customer', customerSchema);
