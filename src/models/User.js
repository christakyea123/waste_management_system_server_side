const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    // Email is optional (per owner's request). Phone is the primary identifier.
    // sparse:true so many customers without an email don't collide on the unique
    // index — only actual email values are required to be unique.
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      default: undefined,
      match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email'],
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      unique: true,
      trim: true,
      match: [/^(\+233|0)[0-9]{9}$/, 'Please provide a valid Ghanaian phone number'],
    },
    // Auto-generated login handle for customers (e.g. "kwame.mensah47").
    // Customers log in with username + phone (phone acts as the password).
    // sparse:true so admin/driver accounts that don't have one don't collide.
    username: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      default: undefined,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    role: {
      type: String,
      enum: ['superadmin', 'admin', 'driver', 'customer'],
      default: 'customer',
    },
    profileImage: {
      type: String,
      default: null,
    },
    profileImagePublicId: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    passwordResetToken: String,
    passwordResetExpires: Date,
    phoneVerificationCode: String,
    phoneVerificationExpires: Date,
    refreshToken: String,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// email and phone already indexed via unique:true above
userSchema.index({ role: 1 });
userSchema.index({ isActive: 1 });

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare passwords
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Build a login username from a full name, e.g. "Kwame Mensah" -> "kwame.mensah47".
// Strips accents/punctuation, lowercases, joins with a dot, appends a 2-digit
// suffix. Retries with a fresh suffix until it finds one not already taken.
userSchema.statics.generateUniqueUsername = async function (fullName) {
  const base = String(fullName || 'user')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // drop accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')   // keep letters/digits/space
    .trim()
    .split(/\s+/)
    .slice(0, 2)                    // first + last name only
    .join('.') || 'user';

  // Up to 25 attempts with random 2-digit suffixes, then fall back to a longer
  // random tail so we always return something unique.
  for (let i = 0; i < 25; i++) {
    const suffix = Math.floor(10 + Math.random() * 90); // 10..99
    const candidate = `${base}${suffix}`;
    const exists = await this.exists({ username: candidate });
    if (!exists) return candidate;
  }
  return `${base}${Date.now().toString().slice(-5)}`;
};

// Generate phone verification code
userSchema.methods.generateVerificationCode = function () {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  this.phoneVerificationCode = code;
  this.phoneVerificationExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
  return code;
};

module.exports = mongoose.model('User', userSchema);
