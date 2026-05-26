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

// Helper: read pricing from the DB singleton. Schema defaults (50/80/120) are
// the source of truth — getSingleton() creates the doc with those defaults on
// first access, so this always returns a complete pricing object.
settingsSchema.statics.getPricing = async function () {
  const doc = await this.getSingleton();
  return {
    basic:    doc.pricing.basic,
    standard: doc.pricing.standard,
    premium:  doc.pricing.premium,
  };
};

module.exports = mongoose.model('Settings', settingsSchema);
