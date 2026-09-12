import express from 'express';
import AuthService from '../services/AuthService.js';
import { APIError } from '../middleware/errorHandler.js';

const router = express.Router();

/**
 * @route   POST /api/auth/register
 * @desc    Register a new user
 * @access  Public
 */
router.post('/register', async (req, res, next) => {
  try {
    const { email, firstName, lastName, password } = req.body;

    if (!email || !firstName || !lastName || !password) {
      throw new APIError('Missing required fields', 400);
    }

    const user = await AuthService.register({
      email,
      firstName,
      lastName,
      password
    });

    res.status(201).json({
      success: true,
      message: 'User registered successfully. Please verify your email.',
      data: user
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/auth/signup
 * @desc    Register and sign in immediately, returning a usable token.
 * @access  Public
 *
 * Exists because /register deliberately returns no token (it expects email
 * verification first), which leaves a new user stranded at the sign-up screen.
 * Accepts either a single `name` or separate `firstName`/`lastName`.
 */
router.post('/signup', async (req, res, next) => {
  try {
    const { email, password, name } = req.body;
    let { firstName, lastName } = req.body;

    if (!firstName && name) {
      const parts = String(name).trim().split(/\s+/);
      firstName = parts.shift() || '';
      lastName = parts.join(' ') || firstName;
    }

    if (!email || !password || !firstName) {
      throw new APIError('Name, email and password are all required', 400);
    }
    if (String(password).length < 8) {
      throw new APIError('Password must be at least 8 characters', 400);
    }

    await AuthService.register({
      email,
      firstName,
      lastName: lastName || firstName,
      password
    });

    const result = await AuthService.login(email, password);

    res.status(201).json({
      success: true,
      message: 'Account created',
      data: result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/auth/login
 * @desc    Login user
 * @access  Public
 */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new APIError('Email and password required', 400);
    }

    const result = await AuthService.login(email, password);

    res.json({
      success: true,
      message: 'Login successful',
      data: result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw new APIError('Refresh token required', 400);
    }

    const result = await AuthService.refreshAccessToken(refreshToken);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/auth/verify-email/:token
 * @desc    Verify email address
 * @access  Public
 */
router.post('/verify-email/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const result = await AuthService.verifyEmail(token);

    res.json({
      success: true,
      message: result.message,
      data: result.user
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Request password reset
 * @access  Public
 */
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email) {
      throw new APIError('Email required', 400);
    }

    const result = await AuthService.requestPasswordReset(email);

    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/auth/reset-password
 * @desc    Reset password with token
 * @access  Public
 */
router.post('/reset-password', async (req, res, next) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken || !newPassword) {
      throw new APIError('Reset token and new password required', 400);
    }

    const result = await AuthService.resetPassword(resetToken, newPassword);

    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    next(error);
  }
});

export default router;
