import mongoose from 'mongoose';

/**
 * One chat message — in a text room ('text-general', 'text-b2', …) or typed
 * inside a speaking call ('voice:<roomId>').
 *
 * Kept so the teacher can read what was said and act on a report, and deleted
 * automatically after CHAT_RETENTION_DAYS (services/ChatRooms). A deleted
 * message stays as a stub for the rest of that period, so a teacher looking
 * into a report can still see what was removed and by whom.
 */
const chatMessageSchema = new mongoose.Schema(
  {
    room: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: String,
    level: String,
    text: { type: String, required: true, maxlength: 600 },
    // The filter changed something (masked a word, removed a link) — worth a
    // glance from the teacher even without a report.
    filtered: { type: Boolean, default: false },
    // What was typed before the filter, when it changed something. Only the
    // teacher ever sees this — students see `text`.
    original: { type: String, maxlength: 600 },
    deletedAt: Date,
    deletedBy: String,
    reports: [
      {
        _id: false,
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byName: String,
        reason: String,
        at: Date
      }
    ],
    reported: { type: Boolean, default: false, index: true }
  },
  { timestamps: true }
);

chatMessageSchema.index({ room: 1, createdAt: -1 });

export default mongoose.model('ChatMessage', chatMessageSchema);
