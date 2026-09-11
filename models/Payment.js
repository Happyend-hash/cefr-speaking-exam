import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema(
  {
    // References
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    // Payment Details
    type: {
      type: String,
      enum: ['exam', 'subscription', 'refund'],
      required: true
    },

    amount: {
      type: Number,
      required: true,
      min: 0
    },

    currency: {
      type: String,
      default: 'USD'
    },

    description: String,

    // Stripe Integration
    stripePaymentIntentId: String,
    stripeChargeId: String,
    stripeReceiptUrl: String,

    // Exam Reference (if applicable)
    examResult: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExamResult'
    },

    // Subscription Reference (if applicable)
    subscription: {
      plan: {
        type: String,
        enum: ['free', 'premium', 'enterprise'],
        required: function () {
          return this.type === 'subscription';
        }
      },
      billingCycle: {
        type: String,
        enum: ['monthly', 'quarterly', 'yearly'],
        default: 'monthly'
      },
      startDate: Date,
      endDate: Date,
      autoRenew: {
        type: Boolean,
        default: true
      },
      examsIncluded: Number
    },

    // Payment Status
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'cancelled', 'refunded'],
      default: 'pending'
    },

    // Failed Payment Details
    failureReason: String,
    failureCode: String,
    retryCount: {
      type: Number,
      default: 0
    },

    // Refund Details
    refund: {
      requested: Boolean,
      requestedAt: Date,
      reason: String,
      approvedAt: Date,
      refundedAmount: Number,
      refundStatus: {
        type: String,
        enum: ['pending', 'completed', 'failed'],
        default: 'pending'
      }
    },

    // Discount/Promotion
    discount: {
      code: String,
      percentage: Number,
      amount: Number,
      description: String
    },

    // Taxes (if applicable)
    taxes: {
      amount: Number,
      percentage: Number,
      region: String
    },

    // Invoice Details
    invoiceNumber: String,
    invoiceUrl: String,

    // Metadata
    paymentMethod: {
      type: String,
      enum: ['credit_card', 'debit_card', 'google_pay', 'apple_pay'],
      default: 'credit_card'
    },

    lastFourDigits: String, // From card
    cardBrand: String,

    // IP and Device Info
    ipAddress: String,
    userAgent: String,

    // Timestamps
    processedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    refundedAt: Date,

    createdAt: {
      type: Date,
      default: Date.now
    },

    updatedAt: {
      type: Date,
      default: Date.now
    },

    // Audit
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },

    notes: String
  },
  { timestamps: true }
);

// ===========================
// METHODS
// ===========================

/**
 * Mark payment as completed
 */
paymentSchema.methods.markCompleted = function () {
  this.status = 'completed';
  this.completedAt = new Date();
};

/**
 * Mark payment as failed
 */
paymentSchema.methods.markFailed = function (reason, code) {
  this.status = 'failed';
  this.failureReason = reason;
  this.failureCode = code;
  this.retryCount += 1;
};

/**
 * Request refund
 */
paymentSchema.methods.requestRefund = function (reason) {
  this.refund.requested = true;
  this.refund.requestedAt = new Date();
  this.refund.reason = reason;
  this.status = 'refunded';
};

/**
 * Apply discount
 */
paymentSchema.methods.applyDiscount = function (discountData) {
  if (discountData.percentage) {
    this.discount.amount = Math.round(this.amount * (discountData.percentage / 100));
  } else {
    this.discount.amount = discountData.amount;
  }

  this.discount.code = discountData.code;
  this.discount.percentage = discountData.percentage;
  this.discount.description = discountData.description;

  // Recalculate final amount
  return this.amount - this.discount.amount;
};

/**
 * Get receipt details
 */
paymentSchema.methods.getReceiptDetails = function () {
  return {
    invoiceNumber: this.invoiceNumber,
    amount: this.amount,
    discount: this.discount.amount,
    taxes: this.taxes?.amount || 0,
    finalAmount: this.amount - (this.discount.amount || 0) + (this.taxes?.amount || 0),
    paymentMethod: this.paymentMethod,
    status: this.status,
    completedAt: this.completedAt,
    invoiceUrl: this.invoiceUrl,
    receiptUrl: this.stripeReceiptUrl
  };
};

// ===========================
// INDEXES
// ===========================

paymentSchema.index({ user: 1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ type: 1 });
paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ stripePaymentIntentId: 1 });
paymentSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model('Payment', paymentSchema);
