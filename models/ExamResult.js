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
    examLevel: {
      type: String,
      enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'],
      required: true
    },

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
          criteria: {
            grammar: {
              score: Number,
              feedback: String
            },
            vocabulary: {
              score: Number,
              feedback: String
            },
            fluency: {
              score: Number,
              feedback: String
            },
            pronunciation: {
              score: Number,
              feedback: String
            },
            coherence: {
              score: Number,
              feedback: String
            }
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
          enum: ['pending', 'evaluating', 'evaluated', 'reviewed'],
          default: 'pending'
        }
      }
    ],

    // Overall Results
    overallScore: Number, // Average of all tasks

    overallLevel: {
      type: String,
      enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'],
      required: true
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
 * Determine CEFR level based on score
 */
examResultSchema.methods.determineCEFRLevel = function () {
  const score = this.overallScore;

  if (score >= 85) return 'C2';
  if (score >= 75) return 'C1';
  if (score >= 65) return 'B2';
  if (score >= 50) return 'B1';
  if (score >= 35) return 'A2';
  if (score >= 0) return 'A1';

  return 'A1';
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
