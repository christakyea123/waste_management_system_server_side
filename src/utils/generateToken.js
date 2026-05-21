const jwt = require('jsonwebtoken');

const generateToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '7d',
  });
};

const verifyToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

const sendTokenResponse = (user, statusCode, res) => {
  const payload = {
    id: user._id,
    role: user.role,
    email: user.email,
  };

  const token = generateToken(payload);

  const cookieOptions = {
    expires: new Date(Date.now() + parseInt(process.env.JWT_COOKIE_EXPIRE || 7) * 24 * 60 * 60 * 1000),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  };

  const userData = {
    _id: user._id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
    role: user.role,
    profileImage: user.profileImage,
    isActive: user.isActive,
  };

  // Token is sent ONLY via httpOnly cookie — never in the response body.
  // JS cannot read httpOnly cookies, so XSS cannot steal the token.
  res.status(statusCode)
    .cookie('token', token, cookieOptions)
    .json({ success: true, user: userData });
};

module.exports = { generateToken, verifyToken, sendTokenResponse };
