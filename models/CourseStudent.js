import mongoose from 'mongoose';

/**
 * A child in the teacher's course, as their parents see them.
 *
 * Separate from website accounts on purpose: a child does not need to use the
 * website for their parents to follow their progress.
 *
 * Families: brothers and sisters share one family (familyId) and one 6-digit
 * parent code, so their parents type one code and see all their children.
 * A child added on their own is a family of one (familyId = their own id).
 *
 * After each lesson the teacher enters the homework results: the types that
 * were given (vocabulary, grammar, listening, reading, speaking, writing) and
 * a percent for each. Those feed the child's page and the monthly ranking.
 *
 * The photo is kept here, small (resized in the browser before upload), and
 * is served only to the teacher and to that child's parents.
 */

export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
export const SKILLS = ['vocabulary', 'grammar', 'listening', 'reading', 'speaking', 'writing'];
/** Attendance marks (Jamshid's choice): came, came late, missed. */
export const ATTENDANCE = ['present', 'late', 'absent'];

const percent = { type: Number, min: 0, max: 100, default: null };

/** One homework (or class test): a date, the level, and a percent per type given. */
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

/** One lesson day: "2026-10-09" (Tashkent date) and how the child was marked. */
const attendanceSchema = new mongoose.Schema({
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  status: { type: String, enum: ATTENDANCE, required: true }
}, { _id: false });

/** A payment towards one month ("2026-10"). Several can add up (part payments). */
const paymentSchema = new mongoose.Schema({
  month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  amount: { type: Number, required: true, min: 1 },
  paidAt: { type: Date, default: Date.now },
  note: { type: String, trim: true, maxlength: 80, default: '' }
}, { _id: true, timestamps: true });

/**
 * Vocabulary units (Jamshid, 2026-10-21): each level has a number of units
 * (20 by default, set in the admin panel) and a general test at the end.
 * Every unit result is kept; the newest one for a unit is its current result.
 * A general test adds a result to every unit it covers, so it replaces the
 * current results, while the earlier unit results stay in the history.
 */
const vocabResultSchema = new mongoose.Schema({
  level: { type: String, enum: LEVELS, required: true },
  unit: { type: Number, required: true, min: 1, max: 60 },
  percent: { type: Number, required: true, min: 0, max: 100 },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  source: { type: String, enum: ['unit', 'general'], default: 'unit' },
  test: { type: mongoose.Schema.Types.ObjectId }     // the general test it came from
}, { _id: true, timestamps: true });

const vocabTestSchema = new mongoose.Schema({
  level: { type: String, enum: LEVELS, required: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  percent: { type: Number, required: true, min: 0, max: 100 },
  perUnit: { type: Boolean, default: false }          // a result per unit, or one overall result for all
}, { _id: true, timestamps: true });

const courseStudentSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  level: { type: String, enum: LEVELS, default: 'A1' },
  /** Brothers and sisters share it. Empty on children added before families existed: their own id is used. */
  familyId: { type: mongoose.Schema.Types.ObjectId, index: true },
  /** The code the teacher gives the parents. Six digits; the same for the whole family. */
  parentCode: { type: String, required: true, match: /^\d{6}$/, index: true },
  /** Raised when the family's code is changed, so phones that remembered the old one are signed out. */
  codeVersion: { type: Number, default: 1 },
  active: { type: Boolean, default: true },
  photo: {
    data: Buffer,
    contentType: String,
    updatedAt: Date
  },
  results: [resultSchema],
  attendance: [attendanceSchema],
  /** What this child pays a month, in so'm (siblings may have a discount). Empty = not set. */
  monthlyFee: { type: Number, min: 0, default: null },
  payments: [paymentSchema],
  vocab: [vocabResultSchema],
  vocabTests: [vocabTestSchema],
  lastParentVisit: Date,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

courseStudentSchema.virtual('family').get(function family() {
  return String(this.familyId || this._id);
});

export default mongoose.model('CourseStudent', courseStudentSchema);
