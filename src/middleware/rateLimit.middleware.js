const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV === 'development';

const createLimiter = (windowMs, max, message, options = {}) =>
  rateLimit({
    windowMs,
    max,
    message: { success: false, message },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    skip: isDev ? () => true : undefined,
    ...options,
  });

const generalLimiter = createLimiter(
  parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  parseInt(process.env.RATE_LIMIT_MAX) || 100,
  'Too many requests. Please try again later.'
);

const authLimiter = createLimiter(
  15 * 60 * 1000,
  5,
  'Too many login attempts. Please try again in 15 minutes.'
);

const registrationLimiter = createLimiter(
  60 * 60 * 1000,
  3,
  'Too many registration attempts. Please try again in 1 hour.'
);

const smsLimiter = createLimiter(
  60 * 60 * 1000,
  10,
  'SMS limit reached. Please try again in 1 hour.'
);

const paymentLimiter = createLimiter(
  60 * 60 * 1000,
  20,
  'Too many payment requests. Please try again later.'
);

module.exports = { generalLimiter, authLimiter, registrationLimiter, smsLimiter, paymentLimiter };
