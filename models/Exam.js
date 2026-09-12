import mongoose from 'mongoose';

const examSchema = new mongoose.Schema(
  {
    // Basic Info
    // Free text: the enum here used to allow only "CEFR Speaking <level>", which
    // made the Multilevel format impossible to express.
    title: {
      type: String,
      required: true,
      trim: true
    },

    // Which exam module this test belongs to.
    module: {
      type: String,
      enum: ['speaking', 'writing'],
      required: true,
      default: 'speaking'
    },

    // Multilevel is a single test that DETERMINES the candidate's level, so a
    // test is not tied to one. Kept optional for level-targeted practice sets.
    level: {
      type: String,
      enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', null]
    },

    // Display label for the part, e.g. "1.1", "2", "Task 1".
    partLabel: String,

    description: String,

    // Exam Content
    tasks: [
      {
        taskNumber: {
          type: Number,
          required: true
        },
        type: {
          type: String,
          enum: [
            // Speaking
            'personal_question',    // Part 1.1 — short factual answers
            'extended_answer',      // Part 1.2 — longer turn on a familiar topic
            'picture_comparison',   // Part 2  — compare and contrast two images
            'image_description',    // Part 2  — describe a single image
            'opinion',              // Part 3  — argue a position, with follow-ups
            'discussion',
            'storytelling',
            'interview',
            // Writing
            'writing_task1',        // Describe visual information
            'writing_task2'         // Opinion essay
          ],
          required: true
        },

        // Part label as candidates know it: "1.1", "1.2", "2", "3", "Task 1".
        part: String,

        question: {
          type: String,
          required: true
        },

        // Shown before the question — what the candidate must do.
        instructions: String,

        images: [String], // URLs to images for description/comparison tasks

        followUpQuestions: [String],

        timeLimit: {
          type: Number,
          default: 120 // seconds; for writing tasks this is the whole allowance
        },

        // Writing only — the expected length, shown to the candidate and
        // passed to the evaluator so under-length answers are penalised.
        minWords: Number,

        scoringCriteria: [String], // What to evaluate
        sampleAnswer: String // For admin reference
      }
    ],

    // Metadata
    duration: {
      type: Number,
      default: 0
    }, // Total duration in seconds

    totalTasks: {
      type: Number,
      default: 0
    },

    maxScore: {
      type: Number,
      default: 100
    },

    // Status
    isActive: {
      type: Boolean,
      default: true
    },

    isPublished: {
      type: Boolean,
      default: false
    },

    publishedAt: Date,

    // Creator
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },

    // Version control
    version: {
      type: Number,
      default: 1
    },

    // Statistics
    statistics: {
      timesUsed: {
        type: Number,
        default: 0
      },
      averageScore: {
        type: Number,
        default: 0
      },
      averageTime: {
        type: Number,
        default: 0
      }
    },

    // Tags and categorization
    tags: [String],
    category: String,

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
 * Calculate total duration from tasks
 */
examSchema.methods.calculateDuration = function () {
  this.duration = this.tasks.reduce((total, task) => total + (task.timeLimit || 120), 0);
  this.totalTasks = this.tasks.length;
  return this.duration;
};

/**
 * Add a task
 */
examSchema.methods.addTask = function (taskData) {
  this.tasks.push(taskData);
  this.calculateDuration();
};

/**
 * Update a task
 */
examSchema.methods.updateTask = function (taskNumber, taskData) {
  const taskIndex = this.tasks.findIndex(t => t.taskNumber === taskNumber);
  if (taskIndex !== -1) {
    this.tasks[taskIndex] = { ...this.tasks[taskIndex], ...taskData };
    this.calculateDuration();
    return true;
  }
  return false;
};

/**
 * Remove a task
 */
examSchema.methods.removeTask = function (taskNumber) {
  const taskIndex = this.tasks.findIndex(t => t.taskNumber === taskNumber);
  if (taskIndex !== -1) {
    this.tasks.splice(taskIndex, 1);
    this.calculateDuration();
    return true;
  }
  return false;
};

// ===========================
// INDEXES
// ===========================

examSchema.index({ level: 1 });
examSchema.index({ isPublished: 1 });
examSchema.index({ createdBy: 1 });
examSchema.index({ createdAt: -1 });
examSchema.index({ tags: 1 });

export default mongoose.model('Exam', examSchema);
