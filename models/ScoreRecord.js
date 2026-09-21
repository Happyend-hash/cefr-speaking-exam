import mongoose from 'mongoose';

/**
 * One full speaking mock's score, kept for the leaderboard.
 *
 * Separate from ExamResult on purpose. A student can delete an attempt — its
 * recordings and its result page go — but its score stays here, so deleting
 * the weak attempts cannot push anyone up the leaderboard. Without this, the
 * students most motivated by the ranking would be the first to discover that
 * deleting a 50 raises their average.
 *
 * Only a teacher's deletion (the admin purge) removes a record, because that is
 * the teacher deciding an attempt should not have counted at all.
 *
 * Only FULL speaking mocks are recorded: part practice and writing do not
 * count towards the ranking.
 */
const scoreRecordSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The attempt this came from. Unique, so a re-mark updates the score in
    // place rather than counting the same mock twice.
    result: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamResult', required: true, unique: true },
    score: { type: Number, required: true },
    level: String,
    completedAt: Date
  },
  { timestamps: true }
);

export default mongoose.model('ScoreRecord', scoreRecordSchema);
