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
    // Fixed service area ("branch") within Dunkwa-on-Offin municipality.
    // These are the areas the company supplies — see SERVICE_AREAS below.
    area: {
      type: String,
      required: [true, 'Service area is required'],
      enum: {
        values: [
          'Mfoum', 'Estate', 'Oxford', 'Abesewa', 'Kadadwene/Zongo',
          'Buzagaline', 'Main market/low cost', 'Atecham', 'Dunkwa soro', 'Atecham police',
        ],
        message: '{VALUE} is not a supported service area',
      },
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
      // biweekly  = twice a month  (Basic plan)
      // weekly    = once a week    (Standard plan)
      // twice_weekly = twice a week (Premium plan)
      frequency: {
        type: String,
        enum: ['biweekly', 'weekly', 'twice_weekly'],
        default: 'biweekly',
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

// Map each bin type to its default collection cadence. Kept here (not in
// Settings) because cadence is a product decision baked into each plan tier,
// not something we'd want admins flipping per-customer from the pricing page.
const BIN_FREQUENCY = {
  basic:    'biweekly',     // twice a month
  standard: 'weekly',       // once a week
  premium:  'twice_weekly', // twice a week
};

// Set monthly fee + collection frequency based on bin type. Pricing lives in
// the Settings collection (editable by admins) with env-var fallback; frequency
// follows the tier so a Basic customer always defaults to twice-a-month pickup.
customerSchema.pre('save', async function (next) {
  const binChanged = this.isModified('binType');
  if (!binChanged && this.monthlyFee) return next();
  try {
    const Settings = mongoose.model('Settings');
    const pricing = await Settings.getPricing();
    this.monthlyFee = pricing[this.binType] ?? pricing.basic;

    // Only overwrite the frequency on bin change (or on first save) — don't
    // stomp an admin's manual override on subsequent saves.
    if (binChanged || !this.collectionSchedule?.frequency) {
      this.collectionSchedule = this.collectionSchedule || {};
      this.collectionSchedule.frequency = BIN_FREQUENCY[this.binType] || 'biweekly';
    }

    next();
  } catch (err) {
    next(err);
  }
});

// The fixed service areas ("branches") the company supplies in Dunkwa-on-Offin.
// Single source of truth — the schema enum above mirrors this list. Exported so
// validators / other modules can reuse it without re-typing the strings.
const SERVICE_AREAS = [
  'Mfoum', 'Estate', 'Oxford', 'Abesewa', 'Kadadwene/Zongo',
  'Buzagaline', 'Main market/low cost', 'Atecham', 'Dunkwa soro', 'Atecham police',
];

const Customer = mongoose.model('Customer', customerSchema);
Customer.SERVICE_AREAS = SERVICE_AREAS;

module.exports = Customer;
