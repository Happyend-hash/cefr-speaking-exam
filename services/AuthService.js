import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import User from '../models/User.js';
import { v4 as uuidv4 } from 'uuid';
import { APIError } from '../middleware/errorHandler.js';
import { sendMail } from './EmailService.js';

const VERIFICATION_CODE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between resend requests

/**
 * Authentication Service - Handles user registration, login, and token management
 */
class AuthService {
  /**
   * Register new user
   */
  async register(userData) {
    try {
      const { email, firstName, lastName, password } = userData;

      // Check if user already exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        throw new APIError('An account with this email already exists', 409);
      }

      // Create new user. emailVerificationRequired is set true here and only
      // here — see the field's own comment in models/User.js for why that is
      // what keeps this from locking out anyone who already had an account.
      const user = new User({
        email,
        firstName,
        lastName,
        password,
        emailVerificationToken: this.generateVerificationCode(),
        emailVerificationExpires: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
        emailVerificationLastSentAt: new Date(),
        emailVerificationRequired: true
      });

      await user.save();

      // Best-effort: a mail hiccup must not stop an account being created —
      // the student can always ask for a fresh code from the verify screen,
      // and if SMTP isn't configured at all, examAccess() doesn't enforce
      // verification in the first place.
      await this.sendVerificationEmail(user);

      return {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        status: user.status
      };
    } catch (error) {
      console.error('Error registering user:', error);
      throw error;
    }
  }

  /**
   * Generate a 6-digit numeric verification code. crypto.randomInt is used
   * rather than Math.random so the code can't be predicted from the account's
   * creation time.
   */
  generateVerificationCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  }

  /**
   * Email the account's current verification code. Never throws — a failed
   * send is reported back (`sent: false`) so the caller can decide what to
   * tell the student, but it never breaks signup or resend.
   */
  async sendVerificationEmail(user) {
    try {
      return await sendMail({
        to: user.email,
        subject: 'Confirm your email',
        text: `Your verification code is ${user.emailVerificationToken}. It expires in 30 minutes. If you didn't request this, you can ignore this email.`,
        html: `
          <p>Your verification code is:</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:6px">${user.emailVerificationToken}</p>
          <p style="color:#666">It expires in 30 minutes. If you didn't request this, you can ignore this email.</p>
        `
      });
    } catch (error) {
      console.error('Error sending verification email:', error);
      return { sent: false, reason: error.message };
    }
  }

  /**
   * Check a code the student typed in against their account's current one.
   */
  async verifyEmailCode(userId, code) {
    const user = await User.findById(userId);
    if (!user) throw new APIError('User not found', 404);

    if (user.isEmailVerified) {
      return user.getPublicProfile();
    }

    if (!user.emailVerificationToken || !user.emailVerificationExpires || user.emailVerificationExpires < new Date()) {
      throw new APIError('This code has expired — request a new one.', 400);
    }

    if (String(code ?? '').trim() !== user.emailVerificationToken) {
      throw new APIError('That code is not correct.', 400);
    }

    user.isEmailVerified = true;
    user.status = 'active';
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    return user.getPublicProfile();
  }

  /**
   * Send a fresh code, rate-limited per account so mashing "resend" can't
   * spam the mail server.
   */
  async resendVerificationEmail(userId) {
    const user = await User.findById(userId);
    if (!user) throw new APIError('User not found', 404);

    if (user.isEmailVerified) {
      return { message: 'Your email is already verified.', sent: false };
    }

    if (user.emailVerificationLastSentAt) {
      const elapsed = Date.now() - user.emailVerificationLastSentAt.getTime();
      if (elapsed < RESEND_COOLDOWN_MS) {
        const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
        throw new APIError(`Please wait ${waitSeconds}s before requesting another code.`, 429);
      }
    }

    user.emailVerificationToken = this.generateVerificationCode();
    user.emailVerificationExpires = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);
    user.emailVerificationLastSentAt = new Date();
    await user.save();

    const result = await this.sendVerificationEmail(user);
    return {
      message: result.sent
        ? 'A new code has been sent to your email.'
        : 'Email is not set up on this server yet — ask your teacher to verify you.',
      sent: Boolean(result.sent)
    };
  }

  /**
   * Login user and generate tokens
   */
  async login(email, password) {
    try {
      // Find user by email
      const user = await User.findOne({ email }).select('+password');
      if (!user) {
        throw new APIError('Invalid email or password', 401);
      }

      // Check if account is active
      if (user.status === 'suspended') {
        throw new APIError('This account has been suspended', 403);
      }

      // Compare password
      const isPasswordValid = await user.comparePassword(password);
      if (!isPasswordValid) {
        throw new APIError('Invalid email or password', 401);
      }

      // Generate tokens
      const accessToken = this.generateAccessToken(user);
      const refreshToken = this.generateRefreshToken(user);

      // Update last login
      user.lastLogin = new Date();
      user.loginHistory.push({
        timestamp: new Date(),
        success: true
      });
      await user.save();

      return {
        user: user.getPublicProfile(),
        accessToken,
        refreshToken,
        expiresIn: '7d'
      };
    } catch (error) {
      console.error('Error logging in user:', error);
      throw error;
    }
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken) {
    try {
      const decoded = jwt.verify(refreshToken, this.getRefreshTokenSecret());
      const user = await User.findById(decoded.id);

      if (!user) {
        throw new APIError('User not found', 404);
      }

      const newAccessToken = this.generateAccessToken(user);

      return {
        accessToken: newAccessToken,
        expiresIn: '7d'
      };
    } catch (error) {
      console.error('Error refreshing token:', error);
      throw new APIError('Your session has expired — please sign in again', 401);
    }
  }

  /**
   * Verify email
   */
  async verifyEmail(token) {
    try {
      const user = await User.findOne({
        emailVerificationToken: token,
        emailVerificationExpires: { $gt: Date.now() }
      });

      if (!user) {
        throw new APIError('This verification link is invalid or has expired', 400);
      }

      user.isEmailVerified = true;
      user.status = 'active';
      user.emailVerificationToken = undefined;
      user.emailVerificationExpires = undefined;

      await user.save();

      return {
        message: 'Email verified successfully',
        user: user.getPublicProfile()
      };
    } catch (error) {
      console.error('Error verifying email:', error);
      throw error;
    }
  }

  /**
   * Request password reset
   */
  async requestPasswordReset(email) {
    try {
      const user = await User.findOne({ email });

      if (!user) {
        // Don't reveal if email exists or not (security best practice)
        return { message: 'If account exists, password reset link has been sent' };
      }

      // Generate reset token
      user.passwordResetToken = uuidv4();
      user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await user.save();

      return {
        message: 'Password reset link sent to email',
        resetToken: user.passwordResetToken // In production, only send via email
      };
    } catch (error) {
      console.error('Error requesting password reset:', error);
      throw error;
    }
  }

  /**
   * Reset password
   */
  async resetPassword(resetToken, newPassword) {
    try {
      const user = await User.findOne({
        passwordResetToken: resetToken,
        passwordResetExpires: { $gt: Date.now() }
      });

      if (!user) {
        throw new APIError('This reset link is invalid or has expired', 400);
      }

      user.password = newPassword;
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;

      await user.save();

      return { message: 'Password reset successfully' };
    } catch (error) {
      console.error('Error resetting password:', error);
      throw error;
    }
  }

  /**
   * Change password
   */
  async changePassword(userId, oldPassword, newPassword) {
    try {
      const user = await User.findById(userId).select('+password');
      if (!user) {
        throw new APIError('User not found', 404);
      }

      const isPasswordValid = await user.comparePassword(oldPassword);
      if (!isPasswordValid) {
        throw new APIError('Your current password is incorrect', 401);
      }

      user.password = newPassword;
      await user.save();

      return { message: 'Password changed successfully' };
    } catch (error) {
      console.error('Error changing password:', error);
      throw error;
    }
  }

  /**
   * Logout user (invalidate tokens)
   */
  async logout(userId) {
    try {
      // In a production app, you might maintain a token blacklist
      return { message: 'Logged out successfully' };
    } catch (error) {
      console.error('Error logging out:', error);
      throw error;
    }
  }

  /**
   * Generate JWT access token
   */
  generateAccessToken(user) {
    return jwt.sign(
      {
        id: user._id.toString(),
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );
  }

  /**
   * Secret used to sign refresh tokens.
   *
   * REFRESH_TOKEN_SECRET is not configured in every environment, and jwt.sign
   * throws outright on an undefined secret — which made every login fail with a
   * 500 rather than anything diagnosable. Falling back to a value derived from
   * JWT_SECRET keeps login working; setting a distinct secret is still better,
   * because it means a leaked access-token secret cannot mint refresh tokens.
   */
  getRefreshTokenSecret() {
    const dedicated = process.env.REFRESH_TOKEN_SECRET;
    if (dedicated) return dedicated;

    if (!process.env.JWT_SECRET) {
      throw new Error('Neither REFRESH_TOKEN_SECRET nor JWT_SECRET is set — cannot issue tokens');
    }

    if (!this._warnedAboutRefreshSecret) {
      console.warn(
        '⚠ REFRESH_TOKEN_SECRET is not set; deriving it from JWT_SECRET. Set a separate secret in production.'
      );
      this._warnedAboutRefreshSecret = true;
    }
    return `${process.env.JWT_SECRET}:refresh`;
  }

  /**
   * Generate refresh token
   */
  generateRefreshToken(user) {
    return jwt.sign(
      {
        id: user._id.toString()
      },
      this.getRefreshTokenSecret(),
      { expiresIn: process.env.REFRESH_TOKEN_EXPIRE || '30d' }
    );
  }
}

export default new AuthService();
