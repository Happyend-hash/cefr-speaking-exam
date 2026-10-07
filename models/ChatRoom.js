import mongoose from 'mongoose';

/**
 * A community chat room a Premium student opened: a name, a topic, a level,
 * ROOM_SEATS seats (services/ChatHub). Who is sitting in it is live state in
 * the hub; this keeps the room itself across a restart, and who was removed
 * from it.
 *
 * closedAt is set when the host or a teacher closes it, or when it has been
 * empty for a while. Closed rooms are deleted with their messages after
 * CHAT_RETENTION_DAYS.
 */
const chatRoomSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 40 },
    topic: { type: String, default: '', maxlength: 120 },
    level: { type: String, enum: ['B1', 'B2', 'C1', null], default: null },
    host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    hostName: String,
    hostPremium: Boolean,
    hostAvatar: String,
    kicked: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    closedAt: { type: Date, default: null, index: true },
    closedBy: String
  },
  { timestamps: true }
);

export default mongoose.model('ChatRoom', chatRoomSchema);
