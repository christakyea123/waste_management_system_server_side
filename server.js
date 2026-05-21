require('dotenv').config();
const http = require('http');
const app = require('./src/app');
const connectDB = require('./src/config/database');
const logger = require('./src/utils/logger');
const { initScheduler } = require('./src/utils/scheduler');

// Create logs directory
const fs = require('fs');
const path = require('path');
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const PORT = process.env.PORT || 5000;

const ensureSuperAdmin = async () => {
  const User = require('./src/models/User');
  const exists = await User.findOne({ role: 'superadmin' });
  if (exists) return;

  const email = process.env.ADMIN_EMAIL || 'admin@wastemanagement.com';
  const phone = process.env.ADMIN_PHONE || '0200000000';
  const password = process.env.ADMIN_PASSWORD || 'Admin@123456';
  const fullName = 'Super Admin';

  await User.create({ fullName, email, phone, password, role: 'superadmin', isVerified: true, isActive: true });
  logger.info('====================================');
  logger.info('Superadmin account created:');
  logger.info(`  Email   : ${email}`);
  logger.info(`  Password: ${password}`);
  logger.info(`  Phone   : ${phone}`);
  logger.info('Change this password after first login!');
  logger.info('====================================');
};

const startServer = async () => {
  try {
    await connectDB();
    await ensureSuperAdmin();

    const server = http.createServer(app);

    server.listen(PORT, () => {
      logger.info(`====================================`);
      logger.info(`Waste Management System Server`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`Server running on port ${PORT}`);
      logger.info(`API Base URL: http://localhost:${PORT}/api/v1`);
      logger.info(`====================================`);
    });

    // Initialize cron scheduler
    if (process.env.NODE_ENV !== 'test') {
      initScheduler();
    }

    // Graceful shutdown
    const gracefulShutdown = async (signal) => {
      logger.info(`${signal} received. Shutting down gracefully...`);
      server.close(async () => {
        const mongoose = require('mongoose');
        await mongoose.connection.close();
        logger.info('MongoDB connection closed');
        process.exit(0);
      });
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (reason, promise) => {
      logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    });

    process.on('uncaughtException', (error) => {
      logger.error(`Uncaught Exception: ${error.message}`);
      process.exit(1);
    });

  } catch (error) {
    logger.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};

startServer();
