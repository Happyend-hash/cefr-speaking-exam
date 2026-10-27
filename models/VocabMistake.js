import mongoose from 'mongoose';

/**
 * A word a student got wrong in a vocabulary test (Jamshid, 2026-10-28).
 *
 * One document per student, book and word. Every wrong answer — in practice,
 * homework or a teacher's room — counts it again and puts it back on the
 * list. It leaves the list ("learnt") when the student presses O'rgandim, or
 * after answering it right twice in a row in the revision test.
 */
const vocabMistakeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    packKey: { type: String, required: true },
    packTitle: { type: String, default: '' },
    unitId: { type: String, default: '' },
    word: { type: String, required: true },
    uz: { type: String, default: '' },
    misses: { type: Number, default: 0 },          // how many times it was answered wrong, ever
    firstMissedAt: Date,
    lastMissedAt: Date,
    reviewStreak: { type: Number, default: 0 },    // right answers in a row in revision tests since the last miss
    lastReviewedAt: Date,
    learntAt: { type: Date, default: null },       // null = still to learn
    learntBy: { type: String, enum: ['', 'button', 'test'], default: '' }
  },
  { timestamps: true }
);

vocabMistakeSchema.index({ user: 1, packKey: 1, word: 1 }, { unique: true });
vocabMistakeSchema.index({ user: 1, learntAt: 1 });

export default mongoose.model('VocabMistake', vocabMistakeSchema);
