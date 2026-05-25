require('express-async-errors');
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const xssClean = require('xss-clean');
const hpp = require('hpp');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const { generalLimiter } = require('./middleware/rateLimit.middleware');
const { errorHandler, notFound } = require('./middleware/error.middleware');
const logger = require('./utils/logger');

// Route imports
const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const customerRoutes = require('./routes/customer.routes');
const driverRoutes = require('./routes/driver.routes');
const paymentRoutes = require('./routes/payment.routes');
const collectionRoutes = require('./routes/collection.routes');

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.paystack.co', 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com', 'https://*.openstreetmap.org', 'https://*.tile.openstreetmap.org'],
      connectSrc: ["'self'", 'https://api.paystack.co'],
      workerSrc: ["'self'", 'blob:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Body parsing (skip raw for webhook)
app.use((req, res, next) => {
  if (req.originalUrl === '/api/v1/payments/webhook') return next();
  express.json({ limit: '10mb' })(req, res, next);
});
app.use((req, res, next) => {
  if (req.originalUrl === '/api/v1/payments/webhook') return next();
  express.urlencoded({ extended: true, limit: '10mb' })(req, res, next);
});

app.use(cookieParser());
app.use(compression());

// Security middleware
app.use(mongoSanitize());
app.use(xssClean());
app.use(hpp());

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  }));
}

// Rate limiting
app.use('/api/', generalLimiter);

// Serve static frontend files only if the frontend folder is present alongside the backend
// (local dev). In production the frontend is hosted separately on cPanel.
const frontendPublicPath = path.join(__dirname, '../../frontend/public');
const frontendRootPath = path.join(__dirname, '../../frontend');
const serveFrontend = fs.existsSync(frontendPublicPath);
const staticOpts = {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
    }
  },
};
if (serveFrontend) {
  app.use(express.static(frontendPublicPath, staticOpts));
  app.use(express.static(frontendRootPath, staticOpts));
}

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/customer', customerRoutes);
app.use('/api/v1/driver', driverRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/collections', collectionRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Waste Management API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
  });
});

// SPA fallback — only when frontend files are bundled with the backend (local dev).
if (serveFrontend) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(
      path.join(frontendPublicPath, 'index.html'),
      (err) => { if (err) next(err); }
    );
  });
}

// 404 + error handling (catches unknown API routes and file-send errors)
app.use(notFound);
app.use(errorHandler);

module.exports = app;
