import mongoose from 'mongoose';

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
      enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', null]
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
    overallReasoning: String,      // which rung each part demonstrated
    overallStrengths: [String],
    overallImprovements: [String],

    // Overall Results
    overallScore: Number, // the whole-performance judgement; see above

    // The outcome of the test, not an input to it — so it is only set once
    // evaluation has run. Requiring it made starting an attempt impossible.
    overallLevel: {
      type: String,
      enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', null]
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
 * These three bands are the ones that matter and were set deliberately:
 *   65-75  C1
 *   51-64  B2
 *   31-50  B1
 * A2 and A1 sit below them so a student who barely spoke is not handed a B1 —
 * the bands are a floor as well as a ceiling.
 *
 * Exported because the number must mean the same thing everywhere it is shown.
 * Anything that reports a level reads it from here rather than repeating the
 * thresholds, so the table can never drift out of step with itself.
 */
export const MAX_SCORE = 75;

export const CEFR_BANDS = [
  { min: 65, level: 'C1' },
  { min: 51, level: 'B2' },
  { min: 31, level: 'B1' },
  { min: 16, level: 'A2' },
  { min: 0, level: 'A1' }
];

export function levelForScore(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'A1';
  return (CEFR_BANDS.find(band => value >= band.min) || { level: 'A1' }).level;
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

// ===========================
// INDEXES
// ===========================

examResultSchema.index({ student: 1 });
examResultSchema.index({ exam: 1 });
examResultSchema.index({ student: 1, createdAt: -1 });
examResultSchema.index({ status: 1 });
examResultSchema.index({ 'taskResults.aiEvaluation.evaluatedAt': 1 });

export default mongoose.model('ExamResult', examResultSchema);
