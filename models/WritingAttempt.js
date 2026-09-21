import mongoose from 'mongoose';
import { BELOW_B1 } from './ExamResult.js';

/**
 * One writing attempt: a timed mock, or a check of work already written.
 *
 * Kept apart from ExamResult on purpose. A speaking attempt is eight recorded
 * answers with transcripts, audio and a pronunciation measurement; a writing
 * attempt is three texts with one band each. Forcing both into one schema
 * would leave every writing attempt carrying empty audio fields and every
 * speaking query filtering writing out — and a mistake in either would break
 * the other.
 */

const correctionSchema = new mongoose.Schema(
  {
    start: Number,
    end: Number,
    wrong: String,
    right: String,
    why: String
  },
  { _id: false }
);

const partSchema = new mongoose.Schema(
  {
    // What the student wrote. Saved as they type (mock) or on submit (check).
    text: { type: String, default: '', maxlength: 20000 },

    // Check mode only: the task the student was answering, if they gave it.
    // Without it the marker cannot judge task fulfilment and says so.
    question: { type: String, default: '', maxlength: 4000 },

    words: { type: Number, default: 0 },

    // The marker's band on this part's own scale (0-5 or 0-6). Absent until
    // marked, and absent for a part the student did not submit.
    band: Number,
    label: String,
    reasoning: String,
    feedback: String,
    corrections: { type: [correctionSchema], default: [] },

    // Set when the school's under-length rule forced the band to 0. The
    // marker's own band is kept alongside so a teacher can see what the
    // writing itself was worth.
    underLength: {
      applied: { type: Boolean, default: false },
      threshold: Number,
      markerBand: Number
    }
  },
  { _id: false }
);

const writingAttemptSchema = new mongoose.Schema(
  {
    student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // 'mock'  — the test under exam conditions: 60 minutes, paste blocked.
    // 'check' — the student's own texts, pasted in and marked.
    mode: { type: String, enum: ['mock', 'check'], required: true },

    // Mock only: which test from content/writingTests.js.
    testId: String,
    testTitle: String,

    status: {
      type: String,
      enum: ['in_progress', 'evaluating', 'completed', 'failed', 'cancelled'],
      default: 'in_progress',
      index: true
    },

    startedAt: { type: Date, default: Date.now },
    // Mock only: when time runs out. The server enforces it; the browser's
    // countdown is a display of this, never the authority.
    deadline: Date,
    submittedAt: Date,
    markedAt: Date,

    parts: {
      part11: { type: partSchema, default: () => ({}) },
      part12: { type: partSchema, default: () => ({}) },
      part2: { type: partSchema, default: () => ({}) }
    },

    // Which parts were handed in for marking.
    submittedParts: { type: [String], default: [] },

    // Charged, in twelfths of a mock (see models/User.js). A mock takes a
    // whole mock up front and hands back 4 for each part left blank.
    creditCost: { type: Number, default: 0 },

    // Outcome.
    complete: Boolean,
    expertMark: Number,
    score: Number, // 0-75, full submissions only
    level: {
      type: String,
      enum: [BELOW_B1, 'B1', 'B2', 'C1', null]
    },
    overallFeedback: String,
    strengths: [String],
    areasForImprovement: [String],
    failureReason: String,

    // Mock only: how many times the browser blocked a paste. Evidence for the
    // teacher, not a penalty — the rule is enforced by blocking, not by marks.
    pasteBlocked: { type: Number, default: 0 },

    emailedAt: Date,
    emailError: String
  },
  { timestamps: true }
);

writingAttemptSchema.index({ student: 1, createdAt: -1 });

export default mongoose.model('WritingAttempt', writingAttemptSchema);
