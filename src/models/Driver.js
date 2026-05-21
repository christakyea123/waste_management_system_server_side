const mongoose = require('mongoose');

const driverSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    driverId: {
      type: String,
      unique: true,
    },
    licenseNumber: {
      type: String,
      trim: true,
    },
    truckNumber: {
      type: String,
      trim: true,
    },
    assignedRoute: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Route',
      default: null,
    },
    zone: {
      type: String,
      trim: true,
    },
    assignedCustomers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Customer',
      },
    ],
    currentLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [0, 0],
      },
      lastUpdated: {
        type: Date,
        default: Date.now,
      },
    },
    status: {
      type: String,
      enum: ['available', 'on_route', 'off_duty', 'suspended'],
      default: 'available',
    },
    totalCollections: {
      type: Number,
      default: 0,
    },
    missedCollections: {
      type: Number,
      default: 0,
    },
    performanceRating: {
      type: Number,
      min: 0,
      max: 5,
      default: 5,
    },
    hireDate: {
      type: Date,
      default: Date.now,
    },
    notes: String,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// user and driverId already indexed via unique:true above
driverSchema.index({ status: 1 });
driverSchema.index({ currentLocation: '2dsphere' });

// Atomic counter (shared with Customer) — race-condition safe
const CounterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const Counter = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);

driverSchema.pre('save', async function (next) {
  if (!this.driverId) {
    const counter = await Counter.findOneAndUpdate(
      { _id: 'driverId' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    this.driverId = `DRV-${String(counter.seq).padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Driver', driverSchema);
