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
    mocks: { type: Number, required: true },
    amount: { type: Number, required: true }, // so'm

    status: {
      type: String,
      enum: ['pending', 'prepared', 'completed', 'cancelled', 'failed'],
      default: 'pending'
    },

    // Ours — sent to Click as transaction_param, echoed back on webhooks.
    merchantTransId: { type: String, required: true, unique: true },

    // Click's own ids, filled in as the webhooks arrive.
    clickTransId: { type: String, default: null, unique: true, sparse: true },
    merchantPrepareId: { type: Number, default: null },

    // Click's error code from the Complete webhook, when it failed
    // (negative = failed charge; kept for support/debugging, not shown to students).
    clickError: { type: Number, default: null },
    clickErrorNote: { type: String, default: '' }
  },
  { timestamps: true }
);

paymentTransactionSchema.index({ student: 1, createdAt: -1 });

export default mongoose.model('PaymentTransaction', paymentTransactionSchema);
