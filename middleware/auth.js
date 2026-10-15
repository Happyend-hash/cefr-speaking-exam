import jwt from 'jsonwebtoken';
import { noteUser } from '../services/UsageStats.js';

/**
 * Authentication middleware to verify JWT tokens
 */
export const authenticate = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No authentication token provided'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    // Daily usage statistics. Admins are left out so checking the panel
    // does not count as a student using the site.
    if (decoded.role !== 'admin') noteUser(decoded.id);
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired',
        expiredAt: error.expiredAt
      });
    }

    res.status(401).json({
      success: false,
      message: 'Invalid token',
      error: error.message
    });
  }
};

/**
 * Authorization middleware to check user role
 */
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to access this resource'
      });
    }

    next();
  };
};

/**
 * Optional authentication - doesn't fail if no token
 */
export const optionalAuth = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
    }
  } catch (error) {
    // Silently fail - token is optional
  }

  next();
};
