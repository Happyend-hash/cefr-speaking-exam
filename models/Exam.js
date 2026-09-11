import mongoose from 'mongoose';

const examSchema = new mongoose.Schema(
  {
    // Basic Info
    title: {
      type: String,
      required: true,
      enum: ['CEFR Speaking A1', 'CEFR Speaking A2', 'CEFR Speaking B1', 'CEFR Speaking B2', 'CEFR Speaking C1', 'CEFR Speaking C2']
    },

    level: {
      type: String,
      required: true,
      enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
    },

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
          enum: ['personal_question', 'image_description', 'discussion', 'storytelling', 'interview'],
          required: true
        },
        question: {
          type: String,
          required: true
        },
        images: [String], // URLs to images for description tasks
        followUpQuestions: [String], // For interviews
        timeLimit: {
          type: Number,
          default: 120 // seconds
        },
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
