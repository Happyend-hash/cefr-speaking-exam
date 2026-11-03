import mongoose from 'mongoose';

/**
 * Phone notifications (2026-11-03): one row per phone / browser that said
 * "yes" to notifications. The endpoint is the push service's address for
 * that device; the keys encrypt what we send to it.
 *
 * PushKey holds the site's own VAPID key pair. It is made once, on the first
 * start that needs it, and kept here so it survives redeploys — no Railway
 * variable to set. VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in the environment
 * win if they are ever set.
 */
const subscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true, unique: true },
  keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
  agent: { type: String, default: '' },          // "Android app", "Chrome", … for the teacher's count only
  lastOkAt: Date,
  fails: { type: Number, default: 0 },
  lastError: { type: String, default: '' },      // what the push service said last time it refused
  lastErrorAt: Date
}, { timestamps: true });

const pushKeySchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'vapid' },
  publicKey: { type: String, required: true },
  privateKey: { type: String, required: true, select: false }
}, { timestamps: true });

export const PushSubscription = mongoose.model('PushSubscription', subscriptionSchema);
export const PushKey = mongoose.model('PushKey', pushKeySchema);
export default PushSubscription;
