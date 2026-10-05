import express from 'express';
import AuthService from '../services/AuthService.js';
import { APIError } from '../middleware/errorHandler.js';
import { authenticate } from '../middleware/auth.js';

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

    // Also finishes an earlier sign-up that never entered its code, rather
    // than refusing it as "already exists" — see AuthService.signup.
    const result = await AuthService.signup({
      email,
      firstName,
      lastName: lastName || firstName,
      password
    });

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
 * @route   POST /api/auth/login-with-code
 * @desc    Sign in with the 6-digit code emailed at sign-up, verifying the
 *          account. For a student who signs up again before finishing, with
 *          a different password (or none they remember): the code is how
 *          they prove the address is theirs. `newPassword` is optional.
 * @access  Public
 */
router.post('/login-with-code', async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code) throw new APIError('Enter the code from your email', 400);

    const result = await AuthService.loginWithCode(email, code, newPassword);

    res.json({
      success: true,
      message: 'Email verified',
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
 * @route   POST /api/auth/verify-email-code
 * @desc    Confirm the 6-digit code emailed at signup. Signed in already —
 *          this checks the code against the caller's own account, not a
 *          link token, since the frontend keeps the student signed in from
 *          the moment they sign up.
 * @access  Private
 */
router.post('/verify-email-code', authenticate, async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) throw new APIError('Enter the code from your email', 400);

    const user = await AuthService.verifyEmailCode(req.user.id, code);

    res.json({
      success: true,
      message: 'Email verified',
      data: user
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/auth/resend-verification
 * @desc    Send a fresh verification code. Rate-limited per account.
 * @access  Private
 */
router.post('/resend-verification', authenticate, async (req, res, next) => {
  try {
    const result = await AuthService.resendVerificationEmail(req.user.id);

    // The api() helper on the client unwraps to `data` when present, so the
    // message the student actually needs to see has to live there too, not
    // only at the top level.
    res.json({
      success: true,
      message: result.message,
      data: { emailSent: result.sent, message: result.message }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Email a 6-digit password reset code. Same answer whether or not
 *          the address has an account.
 * @access  Public (rate-limited per address with the rest of /api/auth)
 */
router.post('/forgot-password', async (req, res, next) => {
  try {
    const result = await AuthService.requestPasswordReset(req.body?.email);
    res.json({ success: true, message: result.message, data: { emailConfigured: result.emailConfigured } });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/auth/reset-password
 * @desc    The emailed code plus a new password; signs the student in.
 * @access  Public
 */
router.post('/reset-password', async (req, res, next) => {
  try {
    const { email, code, newPassword } = req.body || {};
    if (!email || !code || !newPassword) {
      throw new APIError('Enter your email, the code and a new password', 400);
    }
    const result = await AuthService.resetPassword(email, code, newPassword);
    res.json({ success: true, message: 'Password changed', data: result });
  } catch (error) {
    next(error);
  }
});

export default router;
