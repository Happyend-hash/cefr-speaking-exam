import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { v4 as uuidv4 } from 'uuid';
import { APIError } from '../middleware/errorHandler.js';

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

      // Create new user
      const user = new User({
        email,
        firstName,
        lastName,
        password,
        emailVerificationToken: uuidv4(),
        emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
      });

      await user.save();

      return {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        status: user.status,
        emailVerificationToken: user.emailVerificationToken
      };
    } catch (error) {
      console.error('Error registering user:', error);
      throw error;
    }
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
