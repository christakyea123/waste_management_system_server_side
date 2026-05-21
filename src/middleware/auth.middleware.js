const { verifyToken } = require('../utils/generateToken');
const User = require('../models/User');
const ApiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');

const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return ApiResponse.error(res, 'Access denied. No token provided.', 401);
    }

    const decoded = verifyToken(token);
    const user = await User.findById(decoded.id).select('-password -refreshToken');

    if (!user) {
      return ApiResponse.error(res, 'User not found. Token invalid.', 401);
    }

    if (!user.isActive) {
      return ApiResponse.error(res, 'Your account has been suspended.', 403);
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return ApiResponse.error(res, 'Invalid token.', 401);
    }
    if (error.name === 'TokenExpiredError') {
      return ApiResponse.error(res, 'Token expired. Please login again.', 401);
    }
    logger.error(`Auth middleware error: ${error.message}`);
    return ApiResponse.error(res, 'Authentication failed.', 401);
  }
};

module.exports = { protect };
