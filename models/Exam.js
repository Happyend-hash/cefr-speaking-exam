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

    /**
     * Exam content, grouped into sections.
     *
     * A section is one stimulus shared by several questions — the two pictures
     * in Part 1.2, the topic in Part 2, the topic with its pros and cons in
     * Part 3. The old flat `tasks` array could not express that: each question
     * carried its own copy of the images, so three questions about one picture
     * pair meant three copies with nothing tying them together.
     *
     * Questions are numbered globally across the whole test at serve time (see
     * `flattenQuestions`), so results still reference a single stable number.
     */
    sections: [
      {
        // Part label as candidates know it: "1.1", "1.2", "2", "3".
        part: { type: String, required: true },

        title: String,
        instructions: String,

        // Part 1.2: exactly two related images. Stored as /api/exam/images/<key>.
        images: [String],

        // Parts 2 and 3: the topic the questions hang off.
        topic: String,

        // Part 3 only: the arguments shown to the candidate before they speak.
        pros: [String],
        cons: [String],

        questions: [
          {
            text: { type: String, required: true },

            // Seconds to prepare before recording starts.
            prepTime: { type: Number, default: 5 },

            // Seconds of speaking allowed once recording starts.
            answerTime: { type: Number, default: 30 }
          }
        ]
      }
    ],

    // Legacy flat list, kept so existing writing tests and past attempts still
    // resolve. New speaking content uses `sections`.
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
  const flat = this.flattenQuestions();
  if (flat.length) {
    this.duration = flat.reduce((total, q) => total + (q.prepTime || 0) + (q.answerTime || 0), 0);
    this.totalTasks = flat.length;
    return this.duration;
  }

  // Legacy flat tests (the writing module).
  this.duration = this.tasks.reduce((total, task) => total + (task.timeLimit || 120), 0);
  this.totalTasks = this.tasks.length;
  return this.duration;
};

/**
 * Flatten sections into the ordered question list the exam runner consumes.
 *
 * Each entry carries its section's stimulus, so the client can render the two
 * pictures or the pros and cons above the question without a second lookup, and
 * knows where one section ends and the next begins.
 */
examSchema.methods.flattenQuestions = function () {
  const flat = [];
  let number = 0;

  for (const [sectionIndex, section] of (this.sections || []).entries()) {
    const questions = section.questions || [];
    questions.forEach((question, questionIndex) => {
      number += 1;
      flat.push({
        taskNumber: number,
        sectionIndex,
        part: section.part,
        sectionTitle: section.title,
        instructions: section.instructions,
        images: section.images || [],
        topic: section.topic,
        pros: section.pros || [],
        cons: section.cons || [],
        text: question.text,
        prepTime: question.prepTime ?? 5,
        answerTime: question.answerTime ?? 30,
        // The client shows the stimulus once, on the first question of a section.
        isSectionStart: questionIndex === 0,
        questionInSection: questionIndex + 1,
        questionsInSection: questions.length
      });
    });
  }

  return flat;
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
