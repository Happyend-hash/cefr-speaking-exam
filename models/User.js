import mongoose from 'mongoose';
import bcryptjs from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    // Basic Info
    email: {
      type: String,
      required: [true, 'Please provide an email'],
      unique: true,
      lowercase: true,
      match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please provide a valid email']
    },

    firstName: {
      type: String,
      required: [true, 'Please provide first name']
    },

    lastName: {
      type: String,
      required: [true, 'Please provide last name']
    },

    password: {
      type: String,
      required: [true, 'Please provide a password'],
      minlength: 6,
      select: false
    },

    // Profile
    avatar: {
      type: String,
      default: null
    },

    bio: {
      type: String,
      default: ''
    },

    nativeLanguage: {
      type: String,
      default: 'Uzbek'
    },

    // Account Status
    role: {
      type: String,
      enum: ['student', 'teacher', 'admin'],
      default: 'student'
    },

    status: {
      type: String,
      enum: ['active', 'inactive', 'suspended', 'pending_email_verification'],
      default: 'pending_email_verification'
    },

    isEmailVerified: {
      type: Boolean,
      default: false
    },

    emailVerificationToken: String,
    emailVerificationExpires: Date,

    // Subscription & Payment
    subscription: {
      plan: {
        type: String,
        enum: ['free', 'premium', 'enterprise'],
        default: 'free'
      },
      status: {
        type: String,
        enum: ['active', 'cancelled', 'expired'],
        default: 'active'
      },
      startDate: Date,
      endDate: Date,
      examsRemaining: {
        type: Number,
        default: 2 // Free plan includes 2 exams
      },
      stripeCustomerId: String,
      stripeSubscriptionId: String
    },

    // Statistics
    stats: {
      totalExamsTaken: {
        type: Number,
        default: 0
      },
      averageScore: {
        type: Number,
        default: 0
      },
      bestScore: {
        type: Number,
        default: 0
      },
      lastExamDate: Date
    },

    // Account Security
    twoFactorEnabled: {
      type: Boolean,
      default: false
    },

    twoFactorSecret: String,

    passwordResetToken: String,
    passwordResetExpires: Date,

    loginHistory: [
      {
        timestamp: Date,
        ipAddress: String,
        userAgent: String,
        success: Boolean
      }
    ],

    lastLogin: Date,

    // Preferences
    preferences: {
      language: {
        type: String,
        default: 'en'
      },
      notificationsEnabled: {
        type: Boolean,
        default: true
      },
      emailUpdates: {
        type: Boolean,
        default: true
      },
      darkMode: {
        type: Boolean,
        default: false
      }
    },

    // Admin Notes
    adminNotes: String,

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now
    },

    updatedAt: {
      type: Date,
      default: Date.now
    },

    deletedAt: Date
  },
  { timestamps: true }
);

// ===========================
// MIDDLEWARE
// ===========================

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcryptjs.genSalt(10);
    this.password = await bcryptjs.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Update updatedAt timestamp
userSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

// ===========================
// METHODS
// ===========================

/**
 * Compare password with hash
 */
userSchema.methods.comparePassword = async function (passwordAttempt) {
  return await bcryptjs.compare(passwordAttempt, this.password);
};

/**
 * Get public profile
 */
userSchema.methods.getPublicProfile = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.twoFactorSecret;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  delete obj.emailVerificationToken;
  delete obj.emailVerificationExpires;
  delete obj.loginHistory;
  return obj;
};

/**
 * Check if user has exams remaining
 */
userSchema.methods.hasExamsRemaining = function () {
  return this.subscription.examsRemaining > 0;
};

/**
 * Use an exam credit
 */
userSchema.methods.useExamCredit = function () {
  if (this.subscription.examsRemaining > 0) {
    this.subscription.examsRemaining--;
    return true;
  }
  return false;
};

// ===========================
// INDEXES
// ===========================

userSchema.index({ email: 1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ 'subscription.stripeCustomerId': 1 });

export default mongoose.model('User', userSchema);
