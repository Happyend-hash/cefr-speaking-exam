import mongoose from 'mongoose';

/**
 * The level for anyone below the B1 floor. The agency's system has no A2 or A1
 * — under 38 is simply "below B1". Declared here rather than beside the band
 * table lower down because the schemas below reference it at module load, and a
 * `const` used before its declaration throws.
 */
export const BELOW_B1 = 'B1dan quyi';

const examResultSchema = new mongoose.Schema(
  {
    // References
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    exam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Exam',
      required: true
    },

    // Exam Metadata
    // Optional: a Multilevel test is not tied to a level, it determines one.
    examLevel: {
      type: String,
      enum: ['A1', 'A2', BELOW_B1, 'B1', 'B2', 'C1', 'C2', null]
    },

    module: {
      type: String,
      enum: ['speaking', 'writing'],
      default: 'speaking'
    },

    // 'mock' is the full test under exam conditions — no skipping.
    // 'practice' is one part at a time, at the student's own pace.
    mode: {
      type: String,
      enum: ['mock', 'practice'],
      default: 'mock'
    },

    // Set only for practice attempts: which part was practised.
    part: String,

    // Status
    status: {
      type: String,
      enum: ['in_progress', 'submitted', 'evaluating', 'completed', 'cancelled'],
      default: 'in_progress'
    },

    // Task Results
    taskResults: [
      {
        taskNumber: Number,

        // Written as { type: String } rather than a bare `String` deliberately.
        // `type` is a reserved key: when its value is a bare type, Mongoose reads
        // the WHOLE surrounding object as a type declaration, so `taskResults`
        // silently became an array of plain strings and every save failed with
        // "Cast to string failed ... at path taskResults". Wrapping it makes the
        // value a nested object, which Mongoose treats as an ordinary field.
        // Exam.tasks[].type already uses this form, which is why exams saved fine.
        type: { type: String }, // personal_question, image_description, etc

        audioUrl: String, // legacy; recordings are addressed by audioKey via GridFS
        audioKey: String, // For file management
        transcription: String, // AI-generated transcription
        duration: Number, // Recording duration in seconds

        // AI Evaluation
        aiEvaluation: {
          score: Number, // 0-100

          // CEFR Assessment Criteria
          // A free-form map of { criterionName: { score, feedback } }.
          //
          // Fixed keys only worked for speaking. Writing is assessed on task
          // achievement, coherence, lexical resource and grammatical range —
          // pronunciation and fluency are meaningless on a written answer, and
          // a fixed schema forced empty scores for them. The client renders
          // whatever keys are present, so both modules work unchanged.
          criteria: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
          },

          overallFeedback: String,
          strengths: [String],
          areasForImprovement: [String],
          suggestedLevel: String,

          // Raw AI Response
          aiModel: String,
          evaluatedAt: Date
        },

        // Manual Evaluation (optional, for quality assurance)
        manualEvaluation: {
          evaluator: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
          },
          score: Number,
          feedback: String,
          evaluatedAt: Date
        },

        // Final Score
        finalScore: Number, // Average of AI and manual if both exist, otherwise AI
        status: {
          type: String,
          // 'not_transcribed' means the student spoke and the recording is
          // saved, but no words were captured — so there is nothing to mark.
          // It must never be scored 0: a 0 reads as "you said nothing useful",
          // which is a false judgement about a student who answered fine.
          enum: ['pending', 'evaluating', 'evaluated', 'reviewed', 'not_transcribed'],
          default: 'pending'
        }
      }
    ],

    /**
     * Measured pronunciation, from Azure AI Speech.
     *
     * Attempt-level rather than per-answer because it is sampled: pronunciation
     * is a stable trait within one sitting, so a minute of the student's longest
     * answers is assessed and the result describes the whole attempt. Storing it
     * per answer would imply a precision the sampling does not have.
     *
     * `assessed: false` is a real and expected state — no key configured, the
     * service refused, or nothing in the attempt could be assessed. The client
     * must then say so, and never substitute a guess.
     */
    pronunciation: {
      assessed: { type: Boolean, default: false },
      // All 0-100, exactly as Azure returns them. Converted to this app's own
      // scale at display time, so the raw measurement is never lost.
      accuracy: Number,   // how closely the phonemes match a native production
      fluency: Number,    // pace, pausing, rhythm
      prosody: Number,    // stress and intonation; en-US only, and costs extra
      overall: Number,    // Azure's weighted combination of the above
      clipsAssessed: Number,
      secondsAssessed: Number,
      problemWords: [{ word: String, accuracy: Number, errorType: String }],
      error: String,
      assessedAt: Date
    },

    /**
     * The examiner's verdict on the whole performance.
     *
     * Stored rather than derived because it is a judgement, not arithmetic: the
     * parts are a ladder (Part 1 tops out at B1, Part 2 shows B2, Part 3 shows
     * C1) and the level is the highest rung actually demonstrated. Averaging the
     * answers produced a band too low for anyone who could argue at C1.
     */
    overallFeedback: String,
    overallReasoning: String,      // which part gave the evidence for each band
    overallStrengths: [String],
    overallImprovements: [String],

    /**
     * The official criterion bands, 0-6 each, and the arithmetic that turned
     * them into a score.
     *
     * THE BANDS ARE STORED, NOT JUST THE SCORE, and that is the point of this
     * block. The raw speaking total's denominator is inferred rather than
     * documented (see services/ScoreConversion.js). The day it is confirmed,
     * every attempt ever marked can be reconverted from these bands in a loop
     * that costs nothing. Had only the score been kept, correcting it would
     * mean re-marking every attempt through the API — real money, and only for
     * attempts whose audio still exists.
     *
     * `denominator` records what the conversion assumed at the time, so an
     * attempt marked under one assumption is never silently reinterpreted under
     * another.
     */
    criterionBands: {
      vocabulary: Number,
      grammar: Number,
      fluencyCoherence: Number,
      communicative: Number,
      pronunciation: Number
    },
    rawTotal: Number,
    denominator: Number,

    /**
     * The teacher's own bands for this performance, where they disagreed.
     *
     * This is the calibration loop closing. Until now a disagreement was a
     * message to somebody; here it becomes data the marker reads on every
     * future attempt. The teacher's marks NEVER overwrite the reported score —
     * the student's result stands as marked — because a correction is evidence
     * about the marker, not a re-grade of the candidate.
     *
     * `source` matters more than it looks. A band set against a real
     * certificate is worth far more than an expert guess, and the day a mock
     * and a certificate disagree you need to know which anchors came from the
     * agency and which from a teacher's ear.
     */
    teacherBands: {
      vocabulary: Number,
      grammar: Number,
      fluencyCoherence: Number,
      communicative: Number,
      pronunciation: Number,
      note: String,
      source: {
        type: String,
        enum: ['teacher-estimate', 'real-exam'],
        default: 'teacher-estimate'
      },
      correctedBy: String,
      correctedAt: Date
    },

    // Overall Results
    overallScore: Number, // the whole-performance judgement; see above

    // The outcome of the test, not an input to it — so it is only set once
    // evaluation has run. Requiring it made starting an attempt impossible.
    overallLevel: {
      type: String,
      enum: ['A1', 'A2', BELOW_B1, 'B1', 'B2', 'C1', 'C2', null]
    },

    isPassed: {
      type: Boolean,
      default: null // null until evaluation complete
    },

    // Timing
    startedAt: Date,
    submittedAt: Date,
    evaluatedAt: Date,
    completedAt: Date,

    // Metadata
    ipAddress: String,
    userAgent: String,
    deviceType: String,

    // Certificates
    certificate: {
      issued: {
        type: Boolean,
        default: false
      },
      certificateId: String,
      issuedAt: Date,
      pdfUrl: String
    },

    // Notes
    studentNotes: String, // Student feedback
    adminNotes: String,

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now
    },

    updatedAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

// ===========================
// METHODS
// ===========================

/**
 * Calculate overall score from all tasks
 */
examResultSchema.methods.calculateOverallScore = function () {
  const scores = this.taskResults
    .filter(task => task.finalScore !== null && task.finalScore !== undefined)
    .map(task => task.finalScore);

  if (scores.length === 0) return 0;

  this.overallScore = Math.round(scores.reduce((a, b) => a + b) / scores.length);
  return this.overallScore;
};

/**
 * The CEFR bands, on the 75-point O'zbekiston Multilevel scale.
 *
 * These are the agency's own boundaries, not ours:
 *   65-75  C1
 *   51-64  B2
 *   38-50  B1
 *   0-37   B1dan quyi — "below B1"
 *
 * Source: "Chet tilini bilish darajasini baholash ko'p darajali test formati
 * uchun baholash mezonlari", Bilimni baholash agentligi, 16 March 2023.
 *
 * THERE IS NO A2 OR A1 IN THIS SYSTEM. Everything under 38 is simply below B1.
 * The earlier table here invented an A2 at 16 and an A1 at 0, and put B1 at 31
 * — seven points below the real floor. That error ran in the worst direction:
 * a candidate scoring 33 was told "B1" when the agency would not certify them
 * at B1 at all, which is exactly the student who then pays to sit the real exam
 * before they are ready.
 *
 * 'A1' and 'A2' remain permitted values in the schemas so that attempts marked
 * under the old table still load. Nothing produces them any more.
 *
 * Exported because the number must mean the same thing everywhere it is shown.
 * Anything that reports a level reads it from here rather than repeating the
 * thresholds, so the table can never drift out of step with itself.
 */
export const MAX_SCORE = 75;

export const CEFR_BANDS = [
  { min: 65, level: 'C1' },
  { min: 51, level: 'B2' },
  { min: 38, level: 'B1' },
  { min: 0, level: BELOW_B1 }
];

export function levelForScore(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return BELOW_B1;
  return (CEFR_BANDS.find(band => value >= band.min) || { level: BELOW_B1 }).level;
}

examResultSchema.methods.determineCEFRLevel = function () {
  return levelForScore(this.overallScore);
};

/**
 * Mark exam as submitted
 */
examResultSchema.methods.submit = function () {
  this.status = 'submitted';
  this.submittedAt = new Date();
};

/**
 * Get evaluation summary
 */
examResultSchema.methods.getEvaluationSummary = function () {
  return {
    examLevel: this.examLevel,
    overallScore: this.overallScore,
    overallLevel: this.overallLevel,
    isPassed: this.isPassed,
    taskResults: this.taskResults.map(task => ({
      taskNumber: task.taskNumber,
      score: task.finalScore,
      feedback: task.aiEvaluation?.overallFeedback,
      strengths: task.aiEvaluation?.strengths,
      improvements: task.aiEvaluation?.areasForImprovement
    })),
    evaluatedAt: this.evaluatedAt
  };
};

/**
 * Generate certificate
 */
examResultSchema.methods.generateCertificate = function () {
  if (!this.isPassed) return false;

  this.certificate.issued = true;
  this.certificate.certificateId = `CERT-${this._id}-${Date.now()}`;
  this.certificate.issuedAt = new Date();
  return true;
};

/**
 * The teacher-corrected attempts the marker should be shown.
 *
 * Chosen for SPREAD, not recency. Three corrected attempts all sitting around
 * band 4 teach a marker nothing it does not already do; one near the bottom,
 * one in the middle and one near the top teach it the whole scale. So the
 * corrections are sorted by the teacher's own total and sampled across the
 * range, with real-exam-backed corrections preferred over estimates wherever
 * both exist.
 *
 * Kept small on purpose: these go in the cached half of every marking prompt,
 * and a prompt that carries ten worked examples costs more than it teaches.
 */
examResultSchema.statics.markingAnchors = async function (limit = 3) {
  const corrected = await this.find({ 'teacherBands.correctedAt': { $exists: true } })
    .select('teacherBands taskResults.transcription taskResults.taskNumber')
    .sort({ 'teacherBands.correctedAt': -1 })
    .limit(40)
    .lean();

  if (corrected.length <= limit) return corrected;

  const total = doc =>
    ['vocabulary', 'grammar', 'fluencyCoherence', 'communicative', 'pronunciation']
      .reduce((sum, key) => sum + (Number(doc.teacherBands?.[key]) || 0), 0);

  const ranked = corrected
    .map(doc => ({ doc, total: total(doc), real: doc.teacherBands?.source === 'real-exam' }))
    .sort((a, b) => (b.real - a.real) || (a.total - b.total));

  // Even slices across the ranked list: lowest, middle, highest.
  const picked = [];
  for (let i = 0; i < limit; i += 1) {
    picked.push(ranked[Math.round((i * (ranked.length - 1)) / (limit - 1))].doc);
  }
  return [...new Set(picked)];
};

// ===========================
// INDEXES
// ===========================

examResultSchema.index({ 'teacherBands.correctedAt': -1 });
examResultSchema.index({ student: 1 });
examResultSchema.index({ exam: 1 });
examResultSchema.index({ student: 1, createdAt: -1 });
examResultSchema.index({ status: 1 });
examResultSchema.index({ 'taskResults.aiEvaluation.evaluatedAt': 1 });

export default mongoose.model('ExamResult', examResultSchema);
