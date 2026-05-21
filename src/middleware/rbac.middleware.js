const ApiResponse = require('../utils/apiResponse');

// Role hierarchy: higher index = more permissions
// superadmin automatically inherits all admin (and lower) permissions
const ROLE_LEVELS = { customer: 0, driver: 1, admin: 2, superadmin: 3 };

// Allow access if the user's role level is >= the minimum required role level
const authorize = (...roles) => {
  const minLevel = Math.min(...roles.map(r => ROLE_LEVELS[r] ?? Infinity));
  return (req, res, next) => {
    if (!req.user) {
      return ApiResponse.error(res, 'Not authenticated', 401);
    }
    const userLevel = ROLE_LEVELS[req.user.role] ?? -1;
    if (userLevel < minLevel) {
      return ApiResponse.error(
        res,
        `Role '${req.user.role}' is not authorized to access this resource.`,
        403
      );
    }
    next();
  };
};

// Shorthand role guards
const isAdmin       = authorize('admin');       // admin + superadmin
const isSuperAdmin  = authorize('superadmin');  // superadmin only
const isDriver      = authorize('driver');      // driver + admin + superadmin
const isCustomer    = authorize('customer');    // any authenticated role
const isAdminOrDriver = authorize('driver');    // same as isDriver
const isAnyRole     = authorize('customer');    // any authenticated role

module.exports = { authorize, isAdmin, isSuperAdmin, isDriver, isCustomer, isAdminOrDriver, isAnyRole };
