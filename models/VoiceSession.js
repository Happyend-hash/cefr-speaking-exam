import mongoose from 'mongoose';

/**
 * One speaking-room session: a partner practice, or a club room from the
 * moment its first person arrived until the last one left.
 *
 * Kept so the teacher can see who talked with whom and, when a student
 * reports a problem, listen to what was said. Recordings are each
 * participant's own microphone, in pieces of up to ten minutes, and are
 * deleted automatically after VOICE_RETENTION_DAYS (see services/VoiceRooms).
 */
const voiceSessionSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['pair', 'club'], required: true },
    room: String,        // 'club-b2', or the partner room's id
    roomName: String,
    topic: { type: mongoose.Schema.Types.Mixed },
    startedAt: { type: Date, default: Date.now, index: true },
    endedAt: Date,

    participants: [
      {
        _id: false,
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        name: String,
        joinedAt: Date
      }
    ],

    recordings: [
      {
        _id: false,
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        audioKey: String,
        bytes: Number,
        seconds: Number,
        at: Date
      }
    ],

    reports: [
      {
        _id: false,
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byName: String,
        against: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        againstName: String,
        reason: String,
        at: Date
      }
    ],

    ratings: [
      {
        _id: false,
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        peer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        stars: Number,
        at: Date
      }
    ],

    reported: { type: Boolean, default: false, index: true }
  },
  { timestamps: true }
);

export default mongoose.model('VoiceSession', voiceSessionSchema);
