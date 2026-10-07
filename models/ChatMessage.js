import mongoose from 'mongoose';

/**
 * One chat message — in a text room ('text-general', 'text-b2', …), in a
 * community room a Premium student opened ('room-<id>'), or typed inside a
 * speaking call ('voice:<roomId>'). Text, or a short voice message.
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
    // As they were when the message was sent (services/Premium.js).
    premium: { type: Boolean, default: false },
    avatar: String,
    // 'voice' messages carry a recording instead of text (text stays '').
    kind: { type: String, enum: ['text', 'voice'], default: 'text' },
    text: { type: String, default: '', maxlength: 600 },
    audioKey: String,          // services/AudioStorageService key, voice only
    seconds: Number,           // length of a voice message
    // The community room's name at the time, so the teacher can tell rooms
    // apart after the room itself has closed.
    roomName: String,
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
