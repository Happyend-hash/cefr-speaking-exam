import mongoose from 'mongoose';

/**
 * A child in the teacher's course, as their parents see them.
 *
 * Separate from website accounts on purpose: a child does not need to use the
 * website for their parents to follow their progress. The teacher adds the
 * child, uploads a photo, sets the CEFR level, and after each class test
 * enters six scores (percent). Parents sign in with the child's 6-digit code.
 *
 * The photo is kept here, small (resized in the browser before upload), and
 * is served only to the teacher and to that child's parents.
 */

export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
export const SKILLS = ['vocabulary', 'grammar', 'listening', 'reading', 'speaking', 'writing'];

const percent = { type: Number, min: 0, max: 100, default: null };

const resultSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  title: { type: String, trim: true, maxlength: 80, default: '' },
  level: { type: String, enum: LEVELS, required: true },
  skills: {
    vocabulary: percent,
    grammar: percent,
    listening: percent,
    reading: percent,
    speaking: percent,
    writing: percent
  }
}, { _id: true, timestamps: true });

const courseStudentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  level: { type: String, enum: LEVELS, default: 'A1' },
  /** The code the teacher gives the parents. Six digits, unique. */
  parentCode: { type: String, required: true, unique: true, match: /^\d{6}$/ },
  /** Raised when the code is changed, so phones that remembered the old one are signed out. */
  codeVersion: { type: Number, default: 1 },
  active: { type: Boolean, default: true },
  photo: {
    data: Buffer,
    contentType: String,
    updatedAt: Date
  },
  results: [resultSchema],
  lastParentVisit: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

export default mongoose.model('CourseStudent', courseStudentSchema);
