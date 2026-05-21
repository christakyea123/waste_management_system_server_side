const mongoose = require('mongoose');

// Single-document store for app-wide settings (singleton pattern).
// We keep this in MongoDB rather than env vars so admins can change
// service pricing without redeploying.
const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'app' },
    pricing: {
      basic:    { type: Number, default: 50,  min: [0, 'Price cannot be negative'] },
      standard: { type: Number, default: 80,  min: [0, 'Price cannot be negative'] },
      premium:  { type: Number, default: 120, min: [0, 'Price cannot be negative'] },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, _id: false }
);

// Helper: always return the single settings doc, creating it on first access.
settingsSchema.statics.getSingleton = async function () {
  let doc = await this.findById('app');
  if (!doc) doc = await this.create({ _id: 'app' });
  return doc;
};

// Helper: read pricing with env-var fallback (so existing deploys keep working
// until an admin saves new values from the dashboard).
settingsSchema.statics.getPricing = async function () {
  const doc = await this.findById('app').lean();
  const envFallback = (k, d) => parseFloat(process.env[k]) || d;
  return {
    basic:    doc?.pricing?.basic    ?? envFallback('MONTHLY_FEE_BASIC',    50),
    standard: doc?.pricing?.standard ?? envFallback('MONTHLY_FEE_STANDARD', 80),
    premium:  doc?.pricing?.premium  ?? envFallback('MONTHLY_FEE_PREMIUM',  120),
  };
};

module.exports = mongoose.model('Settings', settingsSchema);
