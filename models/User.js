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
      // One free mock on the house: the sample that shows a new student what the
      // test is. Everything after it is granted by the teacher, because every
      // attempt costs real money in transcription, marking and pronunciation.
      examsRemaining: {
        type: Number,
        default: 1
      },
      // Change left over from single parts, in TWELFTHS of a mock (0-11).
      //
      // A speaking part costs ¼ of a mock and a writing part ⅓. Storing those
      // as 0.25 / 0.333 in examsRemaining would drift — three thirds in
      // floating point is 0.9999999999999999 — and a student would one day be
      // refused a mock they had paid for. So whole mocks stay whole in
      // examsRemaining and the change is kept here as an integer. See
      // spendCredits() for how the two move together.
      partCredits: {
        type: Number,
        default: 0,
        min: 0,
        max: 11
      },
      stripeCustomerId: String,
      stripeSubscriptionId: String
    },

    // Exam access, controlled by the teacher.
    //
    // Two separate ideas, deliberately not merged. `blocked` is a decision about
    // the person — it survives any number of credits and is how a student is
    // stopped outright. `subscription.examsRemaining` is a balance. Merging them
    // into one number would mean granting a credit silently un-blocks someone,
    // and blocking someone throws away the mocks they paid for.
    access: {
      blocked: {
        type: Boolean,
        default: false
      },
      blockedAt: Date,
      // Why, in the teacher's words. Never shown to the student.
      note: String,
      // Shown to the student once, on their dashboard, then dismissed. This is
      // how a payment gets confirmed inside the app: the teacher grants the
      // mocks and the student sees that it landed.
      message: String,
      messageAt: Date,
      totalGranted: {
        type: Number,
        default: 0
      },
      lastGrantedAt: Date,
      lastGrantedBy: String
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
 * The credit balance, counted in twelfths of a mock.
 *
 * One pool pays for everything, and parts are priced as a share of a mock:
 *
 *   speaking — 4 parts (1.1, 1.2, 2, 3), each ¼ of a mock  =  3 twelfths
 *   writing  — 3 parts (1.1, 1.2, 2),    each ⅓ of a mock  =  4 twelfths
 *   a full mock of either                                   = 12 twelfths
 *
 * Twelfths because 12 is the smallest unit both ¼ and ⅓ divide into exactly.
 * All arithmetic is in whole twelfths, so nothing ever rounds: a student who
 * practises all four speaking parts one by one has spent exactly one mock.
 */
export const UNITS_PER_MOCK = 12;
export const PART_COST = Object.freeze({ speaking: 3, writing: 4 });

userSchema.methods.creditUnits = function () {
  const whole = Math.max(0, Math.floor(Number(this.subscription?.examsRemaining) || 0));
  const part = Math.max(0, Math.floor(Number(this.subscription?.partCredits) || 0));
  return whole * UNITS_PER_MOCK + part;
};

/** Can this student pay for `units` twelfths of a mock? */
userSchema.methods.canAfford = function (units) {
  return this.creditUnits() >= units;
};

/**
 * Spend `units` twelfths of a mock, breaking a whole mock only when needed.
 *
 * Leftover change is spent first, so a student who practised one part last
 * week uses that up before a fresh mock is opened. The balance is then re-split
 * into whole mocks and change — so twelve twelfths can never sit in
 * partCredits; they are always a whole mock again.
 */
userSchema.methods.spendCredits = function (units) {
  const cost = Math.max(0, Math.floor(Number(units) || 0));
  const total = this.creditUnits();
  if (total < cost) return false;
  this.setCreditUnits(total - cost);
  return true;
};

/** Hand credit back — an attempt that was charged and never used. */
userSchema.methods.refundCredits = function (units) {
  const amount = Math.max(0, Math.floor(Number(units) || 0));
  this.setCreditUnits(this.creditUnits() + amount);
};

userSchema.methods.setCreditUnits = function (total) {
  const safe = Math.max(0, Math.floor(total));
  this.subscription.examsRemaining = Math.floor(safe / UNITS_PER_MOCK);
  this.subscription.partCredits = safe % UNITS_PER_MOCK;
};

/**
 * The balance as people say it: "4", "4¾", "⅔", "3 5/12".
 *
 * Shown to students and to the teacher, so both read the same figure.
 * Awkward fractions (5/12, 7/12…) only appear after mixing speaking and
 * writing parts, and are printed plainly rather than rounded — rounding
 * would tell a student they have more, or less, than they do.
 */
const FRACTION = {
  0: '', 1: '1/12', 2: '⅙', 3: '¼', 4: '⅓', 5: '5/12',
  6: '½', 7: '7/12', 8: '⅔', 9: '¾', 10: '⅚', 11: '11/12'
};

export function formatCredits(examsRemaining = 0, partCredits = 0) {
  const whole = Math.max(0, Math.floor(Number(examsRemaining) || 0));
  const part = Math.max(0, Math.floor(Number(partCredits) || 0)) % UNITS_PER_MOCK;
  const fraction = FRACTION[part];
  if (!fraction) return String(whole);
  if (!whole) return fraction;
  return fraction.includes('/') ? `${whole} ${fraction}` : `${whole}${fraction}`;
}

userSchema.methods.creditLabel = function () {
  return formatCredits(this.subscription?.examsRemaining, this.subscription?.partCredits);
};

/** Is there a whole mock's worth left? */
userSchema.methods.hasExamsRemaining = function () {
  return this.canAfford(UNITS_PER_MOCK);
};

/** Use one whole mock (a full speaking or full writing mock). */
userSchema.methods.useExamCredit = function () {
  return this.spendCredits(UNITS_PER_MOCK);
};

/**
 * May this student start a new attempt?
 *
 * Returns a code rather than a sentence, because the student app says it in
 * Uzbek and the admin panel says it in English — the same decision, two
 * audiences. `allowed` is the only thing a caller should branch on.
 */
userSchema.methods.examAccess = function (cost = UNITS_PER_MOCK) {
  // Teachers and admins are never charged and never blocked. They are the
  // people who have to be able to open the test to check it — including the
  // teacher who has just blocked the whole class, who would otherwise have
  // locked themselves out of their own product.
  if (this.role === 'admin' || this.role === 'teacher') {
    return { allowed: true, code: 'staff', remaining: null, message: '' };
  }

  if (this.access?.blocked) {
    return {
      allowed: false,
      code: 'blocked',
      remaining: 0,
      message: 'Your teacher has paused your access to the mock exams.'
    };
  }

  // The cost is in twelfths: 12 for a full mock, 3 for one speaking part,
  // 4 for one writing part.
  if (!this.canAfford(cost)) {
    return {
      allowed: false,
      code: 'no_credits',
      remaining: this.subscription.examsRemaining,
      credits: this.creditLabel(),
      message: this.creditUnits() > 0
        ? `You have ${this.creditLabel()} of a mock left — not enough for this. Ask your teacher to add more.`
        : 'You have no mock exams left. Ask your teacher to add more.'
    };
  }

  return {
    allowed: true,
    code: 'ok',
    remaining: this.subscription.examsRemaining,
    credits: this.creditLabel(),
    message: ''
  };
};

// ===========================
// INDEXES
// ===========================

userSchema.index({ email: 1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ 'subscription.stripeCustomerId': 1 });

export default mongoose.model('User', userSchema);
