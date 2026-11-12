import mongoose from 'mongoose';

/**
 * One purchase of a mock package through Click.
 *
 * Click's flow is two webhooks (Prepare, then Complete) tied together by
 * click_trans_id, arriving asynchronously after the student is redirected to
 * Click's own payment page — there is no synchronous "did it work" response
 * to our checkout call. This document is the record that ties a checkout
 * click to the webhooks that eventually confirm (or fail) it, and is what
 * makes the Complete handler idempotent against Click retrying a webhook.
 *
 * merchantTransId is ours: generated at checkout time, sent to Click as
 * transaction_param, and echoed back on both webhooks — it's how we find
 * this document again without trusting anything else in the callback body
 * before the signature is verified.
 */
const paymentTransactionSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    packageKey: { type: String, required: true },
    // What the package buys (2026-11-12). Older rows have no kind: speaking.
    kind: { type: String, enum: ['speaking', 'writing', 'premium'], default: 'speaking' },
    mocks: { type: Number, required: true },
    days: { type: Number, default: 0 }, // Premium days, for kind 'premium'
    amount: { type: Number, required: true }, // so'm

    status: {
      type: String,
      enum: ['pending', 'prepared', 'completed', 'cancelled', 'failed'],
      default: 'pending'
    },

    // Ours — sent to Click as transaction_param, echoed back on webhooks.
    merchantTransId: { type: String, required: true, unique: true },

    // Click's own ids, filled in as the webhooks arrive.
    // No default (2026-11-12): a stored null counted as a value in the old
    // unique+sparse index, so the second unpaid checkout failed with E11000.
    // The index below only covers real ids.
    clickTransId: { type: String },
    merchantPrepareId: { type: Number, default: null },

    // Click's error code from the Complete webhook, when it failed
    // (negative = failed charge; kept for support/debugging, not shown to students).
    clickError: { type: Number, default: null },
    clickErrorNote: { type: String, default: '' }
  },
  { timestamps: true }
);

paymentTransactionSchema.index({ student: 1, createdAt: -1 });
paymentTransactionSchema.index(
  { clickTransId: 1 },
  { unique: true, partialFilterExpression: { clickTransId: { $type: 'string' } } }
);

export default mongoose.model('PaymentTransaction', paymentTransactionSchema);
