import mongoose from 'mongoose';

/**
 * A shared mock result (Jamshid, 2026-11-10): the code behind the score
 * sheet's QR and the englishhub.uz/r/CODE link.
 *
 * One per result. The code stays the same while the student shares it, so
 * every score sheet already sent keeps checking out; "Stop sharing" ends it
 * (revokedAt) and sharing again makes a new code. With `details` the link
 * also opens the recordings and feedback — only until `detailsUntil`
 * (30 days), after which it shows the score alone.
 */
const resultShareSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, enum: ['speaking', 'writing'], required: true },
  result: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  details: { type: Boolean, default: false },
  detailsUntil: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  views: { type: Number, default: 0 },
  lastViewAt: Date
}, { timestamps: true });

export default mongoose.model('ResultShare', resultShareSchema);
