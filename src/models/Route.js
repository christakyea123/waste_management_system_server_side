const mongoose = require('mongoose');

const routeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    zone: {
      type: String,
      required: true,
      trim: true,
    },
    description: String,
    assignedDriver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      default: null,
    },
    customers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Customer',
      },
    ],
    collectionDays: [
      {
        type: String,
        enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      },
    ],
    estimatedDuration: {
      type: Number, // minutes
      default: 180,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    waypoints: [
      {
        latitude: Number,
        longitude: Number,
        order: Number,
      },
    ],
  },
  { timestamps: true }
);

routeSchema.index({ assignedDriver: 1 });
routeSchema.index({ zone: 1 });

module.exports = mongoose.model('Route', routeSchema);
