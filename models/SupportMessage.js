import mongoose from 'mongoose';

/**
 * One message in a student's conversation with English Hub Support
 * (Jamshid, 2026-10-24). A conversation is simply every message with the
 * same `user`: the student writes (`from: 'user'`), the team answers
 * (`from: 'team'`). Students tag what they write — a question, a problem,
 * an idea, or something they liked — so the teacher can read the site's
 * drawbacks and praise at a glance.
 */
const supportMessageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    from: { type: String, enum: ['user', 'team'], required: true },
    kind: { type: String, enum: ['question', 'problem', 'idea', 'praise', null], default: null },
    text: { type: String, maxlength: 4000, default: '' },
    image: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportImage' },
    sentBy: String,          // the admin who answered (never shown to the student)
    readByUser: Date,        // a team reply the student has seen
    readByTeam: Date         // a student message the team has seen
  },
  { timestamps: true }
);

supportMessageSchema.index({ user: 1, createdAt: 1 });
supportMessageSchema.index({ from: 1, readByTeam: 1 });

export default mongoose.model('SupportMessage', supportMessageSchema);
