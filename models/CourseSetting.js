import mongoose from 'mongoose';

/**
 * Settings of the teacher's course, kept in one document (key "course").
 * unitsPerLevel: how many vocabulary units each level has (20 when not set).
 */
const courseSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'course' },
  unitsPerLevel: { type: Map, of: Number, default: {} },
  /** The vocabulary book each level studies (a Vocabulary test pack key, e.g. "destination-b1"). Its units are the level's units. */
  booksPerLevel: { type: Map, of: String, default: {} },
  /** The daily payment email: when it was last sent. */
  paymentReportAt: { type: Date, default: null },
  /** The Tashkent day ("2026-10-23") the automatic evening email last went. */
  paymentReportAutoDay: { type: String, default: '' }
}, { timestamps: true });

export default mongoose.model('CourseSetting', courseSettingSchema);
