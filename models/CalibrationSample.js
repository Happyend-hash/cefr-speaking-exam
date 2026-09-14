import mongoose from 'mongoose';

/**
 * A marked sample answer, used to calibrate the examiner.
 *
 * Why these exist
 * ---------------
 * Given only a band table — "65-75 is C1" — the marking model has to invent the
 * scale on every call, and models asked to grade without examples cluster toward
 * the middle and are reluctant to award high marks, because 68 out of 75 feels
 * like claiming near-perfection. The result was a candidate who scores 67 in the
 * real exam being handed 52.
 *
 * This is how human examiners are trained: not with a rubric alone, but with
 * standardisation samples — recordings everyone agrees the mark for. A teacher
 * builds that set here, and the marker sees them alongside the answer it is
 * judging, so it compares rather than guesses.
 *
 * What makes a set useful
 * -----------------------
 * Spread, not volume. Three samples at 40, 55 and 67 teach the scale; ten all
 * sitting at 65 teach one point on it. And samples are per part, because a Part
 * 1.1 answer says nothing about what a good Part 3 answer looks like — different
 * length, different demands, different ceiling.
 *
 * The risk worth naming: a wrongly scored sample is inherited silently by every
 * marking that follows. That is why they stay visible and editable, why they can
 * be deactivated without being destroyed, and why there is a check that re-marks
 * them and shows the examiner's score beside the teacher's.
 */
const calibrationSampleSchema = new mongoose.Schema(
  {
    // Which part this answer belongs to. Samples are only ever shown to the
    // marker when it is judging the same part.
    part: {
      type: String,
      enum: ['1.1', '1.2', '2', '3'],
      required: true,
      index: true
    },

    /** What the sample was answering, when known. Gives the transcript context. */
    question: String,

    /** The words. Either typed in, or transcribed from an uploaded recording. */
    transcription: {
      type: String,
      required: true
    },

    /** The recording, when one was uploaded. Kept so it can be listened to again. */
    audioKey: String,

    /** The mark this answer deserves, on the 75-point scale. */
    score: {
      type: Number,
      required: true,
      min: 0,
      max: 75
    },

    level: {
      type: String,
      enum: ['A1', 'A2', 'B1', 'B2', 'C1'],
      required: true
    },

    /**
     * Where the score came from. A confirmed result from the real exam is worth
     * more than an informed estimate, and saying which is which lets a teacher
     * look back later and see where their judgement and the exam disagreed.
     */
    scoreSource: {
      type: String,
      enum: ['teacher-estimate', 'real-exam'],
      default: 'teacher-estimate'
    },

    /** Why this answer earns this mark. Shown to the marker as the reasoning. */
    notes: String,

    /** Deactivated samples stay for reference but stop influencing marking. */
    isActive: {
      type: Boolean,
      default: true,
      index: true
    },

    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  { timestamps: true }
);

/**
 * The samples to put in front of the marker for one part.
 *
 * Picked for spread rather than recency: one sample per distinct level, lowest
 * first, so the model sees the shape of the scale instead of several examples of
 * the same point on it. Where a level has several samples the highest-confidence
 * one wins — a confirmed exam result over a teacher's estimate.
 */
calibrationSampleSchema.statics.anchorsForPart = async function (part, limit = 4) {
  const samples = await this.find({ part, isActive: true })
    .sort({ scoreSource: 1, createdAt: -1 }) // 'real-exam' sorts before 'teacher-estimate'
    .lean();

  const byLevel = new Map();
  for (const sample of samples) {
    if (!byLevel.has(sample.level)) byLevel.set(sample.level, sample);
  }

  return [...byLevel.values()].sort((a, b) => a.score - b.score).slice(0, limit);
};

export default mongoose.model('CalibrationSample', calibrationSampleSchema);
