import mongoose from 'mongoose';

/**
 * A message in a student's message box (Jamshid, 2026-10-23).
 *
 * One document per recipient, so each student has their own read state and
 * their own gift to open. A message sent to many students shares a `batch` id,
 * which is how the admin panel lists, counts and withdraws it as one send.
 *
 *   note   the teacher's own message: updates about the website, anything
 *   gift   a note with mocks inside; the student opens it and presses Activate
 *   score  written by the site when an expert review changes an attempt's score
 */
const messageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    batch: { type: mongoose.Schema.Types.ObjectId, index: true },
    kind: { type: String, enum: ['note', 'gift', 'score'], default: 'note' },
    title: { type: String, maxlength: 140, default: '' },
    // Rich text, cleaned on the server (services/Messages.js) — never stored as typed.
    html: { type: String, maxlength: 40000, default: '' },

    gift: {
      speaking: { type: Number, min: 0, max: 20, default: 0 },
      writing: { type: Number, min: 0, max: 20, default: 0 },
      openedAt: Date,    // the box was unwrapped
      claimedAt: Date    // Activate pressed: the mocks are on the account
    },

    // kind 'score': what changed, so the student sees old and new side by side.
    score: {
      module: { type: String, enum: ['speaking', 'writing'] },
      attemptId: String,
      attemptTitle: String,
      attemptDate: Date,
      parts: [{ _id: false, key: String, name: String, max: Number, before: Number, after: Number }],
      before: { mark: Number, score: Number, level: String },
      after: { mark: Number, score: Number, level: String }
    },

    sentBy: String,
    readAt: Date,
    hiddenAt: Date     // the student deleted it from their box
  },
  { timestamps: true }
);

messageSchema.index({ user: 1, hiddenAt: 1, createdAt: -1 });

export default mongoose.model('Message', messageSchema);
