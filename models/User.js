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

    // Shown on the leaderboard instead of the real name. Unique regardless of
    // case, so nobody can appear as someone else; the lower-cased copy is what
    // the uniqueness is enforced on.
    nickname: {
      type: String,
      trim: true,
      maxlength: 20
    },
    nicknameLower: {
      type: String,
      index: { unique: true, sparse: true }
    },

    // When the student agreed that speaking-room calls are recorded. Voice is
    // not available until they have — being told is the point of recording
    // being acceptable at all.
    voiceConsentAt: Date,

    // Premium runs until this moment (services/Premium.js). Set from each
    // payment and by the teacher; null or past means a free account.
    premiumUntil: { type: Date, default: null },

    // The student's own picture or GIF, shown while they are Premium. The
    // token is the unguessable part of its public address and changes with
    // every upload, so browsers can cache each picture for good.
    picture: {
      key: String,          // file in the "avatars" GridFS bucket
      token: { type: String, index: { sparse: true } },
      contentType: String,
      bytes: Number,
      at: Date
    },
    // The teacher removed a picture and stopped this student uploading more.
    pictureBlocked: { type: Boolean, default: false },

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
      // WRITING has its own balance. examsRemaining / partCredits above are the
      // SPEAKING balance (their names predate writing and are kept so no
      // existing data moves). A package is 4 speaking + 3 writing, and the two
      // are not interchangeable: a writing mock costs a fraction of a speaking
      // one to run, so letting a student spend writing credit on speaking
      // would quietly turn a cheap package into an expensive one.
      //
      // One free writing mock, like speaking: the sample that shows a new
      // student what the test is.
      writingRemaining: {
        type: Number,
        default: 1
      },
      writingPartCredits: {
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
      totalWritingGranted: {
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
 * The credit balances, counted in twelfths of a mock.
 *
 * Two separate balances — speaking and writing — each priced by part:
 *
 *   speaking — 4 parts (1.1, 1.2, 2, 3), each ¼ of a speaking mock = 3 twelfths
 *   writing  — 3 parts (1.1, 1.2, 2),    each ⅓ of a writing mock  = 4 twelfths
 *   a full mock of either                                           = 12 twelfths
 *
 * Twelfths because 12 is the smallest unit both ¼ and ⅓ divide into exactly,
 * so nothing ever rounds. Every method takes the module and defaults to
 * speaking, which is how all the code written before writing existed calls it.
 */
export const UNITS_PER_MOCK = 12;
export const PART_COST = Object.freeze({ speaking: 3, writing: 4 });
export const MODULES = Object.freeze(['speaking', 'writing']);

/** Where each module's balance lives: [whole mocks, leftover twelfths]. */
export const BALANCE_FIELDS = Object.freeze({
  speaking: ['examsRemaining', 'partCredits'],
  writing: ['writingRemaining', 'writingPartCredits']
});

const fieldsFor = module => BALANCE_FIELDS[module] || BALANCE_FIELDS.speaking;

/** The package a paying student gets. Overridable without a code change. */
export const PACKAGE = Object.freeze({
  speaking: Number(process.env.PACKAGE_SPEAKING) || 4,
  writing: Number(process.env.PACKAGE_WRITING) || 3
});

userSchema.methods.creditUnits = function (module = 'speaking') {
  const [wholeField, partField] = fieldsFor(module);
  const whole = Math.max(0, Math.floor(Number(this.subscription?.[wholeField]) || 0));
  const part = Math.max(0, Math.floor(Number(this.subscription?.[partField]) || 0));
  return whole * UNITS_PER_MOCK + part;
};

/** Can this student pay for `units` twelfths of a mock of this module? */
userSchema.methods.canAfford = function (units, module = 'speaking') {
  return this.creditUnits(module) >= units;
};

/**
 * Spend `units` twelfths of a mock, breaking a whole mock only when needed.
 *
 * Leftover change is spent first, so a student who practised one part last
 * week uses that up before a fresh mock is opened. The balance is then re-split
 * into whole mocks and change — so twelve twelfths can never sit in the change
 * field; they are always a whole mock again.
 */
userSchema.methods.spendCredits = function (units, module = 'speaking') {
  const cost = Math.max(0, Math.floor(Number(units) || 0));
  const total = this.creditUnits(module);
  if (total < cost) return false;
  this.setCreditUnits(total - cost, module);
  return true;
};

/** Hand credit back — an attempt that was charged and never used. */
userSchema.methods.refundCredits = function (units, module = 'speaking') {
  const amount = Math.max(0, Math.floor(Number(units) || 0));
  this.setCreditUnits(this.creditUnits(module) + amount, module);
};

userSchema.methods.setCreditUnits = function (total, module = 'speaking') {
  const [wholeField, partField] = fieldsFor(module);
  const safe = Math.max(0, Math.floor(total));
  this.subscription[wholeField] = Math.floor(safe / UNITS_PER_MOCK);
  this.subscription[partField] = safe % UNITS_PER_MOCK;
};

/**
 * The balance as people say it: "4", "4¾", "⅔", "3 5/12".
 *
 * Shown to students and to the teacher, so both read the same figure.
 */
const FRACTION = {
  0: '', 1: '1/12', 2: '⅙', 3: '¼', 4: '⅓', 5: '5/12',
  6: '½', 7: '7/12', 8: '⅔', 9: '¾', 10: '⅚', 11: '11/12'
};

export function formatCredits(whole = 0, partTwelfths = 0) {
  const w = Math.max(0, Math.floor(Number(whole) || 0));
  const part = Math.max(0, Math.floor(Number(partTwelfths) || 0)) % UNITS_PER_MOCK;
  const fraction = FRACTION[part];
  if (!fraction) return String(w);
  if (!w) return fraction;
  return fraction.includes('/') ? `${w} ${fraction}` : `${w}${fraction}`;
}

/**
 * A module's whole-mock count from a user document, lean or not.
 *
 * A lean read skips schema defaults, so an account created before writing
 * existed has no writingRemaining at all — yet the moment that student starts
 * a writing mock, the full document fills in the default of 1 and lets them.
 * Reading the default here too keeps the teacher's list honest about it.
 */
export function wholeMocks(user, module = 'speaking') {
  const [wholeField] = fieldsFor(module);
  const value = user?.subscription?.[wholeField];
  return value === undefined || value === null ? 1 : value;
}

/** A module's balance label straight from a (lean) user document. */
export function balanceLabel(user, module = 'speaking') {
  const [, partField] = fieldsFor(module);
  return formatCredits(wholeMocks(user, module), user?.subscription?.[partField]);
}

userSchema.methods.creditLabel = function (module = 'speaking') {
  return balanceLabel(this, module);
};

/** Is there a whole speaking mock's worth left? */
userSchema.methods.hasExamsRemaining = function (module = 'speaking') {
  return this.canAfford(UNITS_PER_MOCK, module);
};

/** Use one whole mock. */
userSchema.methods.useExamCredit = function (module = 'speaking') {
  return this.spendCredits(UNITS_PER_MOCK, module);
};

/**
 * May this student start a new attempt?
 *
 * Returns a code rather than a sentence, because the student app says it in
 * Uzbek and the admin panel says it in English — the same decision, two
 * audiences. `allowed` is the only thing a caller should branch on.
 */
userSchema.methods.examAccess = function (cost = UNITS_PER_MOCK, module = 'speaking') {
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

  // The cost is in twelfths of THIS module's mock: 12 for a full mock, 3 for
  // one speaking part, 4 for one writing part.
  const [wholeField] = BALANCE_FIELDS[module] || BALANCE_FIELDS.speaking;
  const label = this.creditLabel(module);

  if (!this.canAfford(cost, module)) {
    return {
      allowed: false,
      code: 'no_credits',
      module,
      remaining: this.subscription[wholeField],
      credits: label,
      message: this.creditUnits(module) > 0
        ? `You have ${label} of a ${module} mock left — not enough for this. Ask your teacher to add more.`
        : `You have no ${module} mocks left. Ask your teacher to add more.`
    };
  }

  return {
    allowed: true,
    code: 'ok',
    module,
    remaining: this.subscription[wholeField],
    credits: label,
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
