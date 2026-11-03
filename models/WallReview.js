import mongoose from 'mongoose';

/**
 * A student's opinion of English Hub, written onto the public "Natijalar va
 * fikrlar" wall by the teacher (Jamshid, 2026-11-03: reviews are added by
 * him, not by students). Shown to everyone, signed in or not, when published.
 */
const wallReviewSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  // a short line under the name, e.g. "B2 · Speaking 62" or "IELTS 7.0"
  label: { type: String, trim: true, maxlength: 60, default: '' },
  text: { type: String, required: true, trim: true, maxlength: 1200 },
  stars: { type: Number, min: 1, max: 5, default: 5 },
  photo: { key: String, type: { type: String } },
  published: { type: Boolean, default: true },
  pinned: { type: Boolean, default: false },
  createdBy: String
}, { timestamps: true });

wallReviewSchema.index({ published: 1, pinned: -1, createdAt: -1 });

export default mongoose.model('WallReview', wallReviewSchema);
