import mongoose from 'mongoose';

/**
 * One row per person per day they used the site (Tashkent days).
 *
 * key is "u:<userId>" for a signed-in student or "g:<random id>" for a guest
 * browser that opened the site without signing in. hours lists the Tashkent
 * hours (0-23) they were active in, for the "busiest hours" chart.
 *
 * Kept for about 13 months, then removed automatically.
 */
const dailyActivitySchema = new mongoose.Schema({
  day: { type: String, required: true },          // YYYY-MM-DD, Tashkent
  key: { type: String, required: true },
  kind: { type: String, enum: ['user', 'guest'], required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  hours: [Number],
  first: { type: Date, default: Date.now },
  last: { type: Date, default: Date.now }
});

dailyActivitySchema.index({ day: 1, key: 1 }, { unique: true });
dailyActivitySchema.index({ first: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

export default mongoose.model('DailyActivity', dailyActivitySchema);
