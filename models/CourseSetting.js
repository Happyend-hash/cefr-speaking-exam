import mongoose from 'mongoose';

/**
 * Settings of the teacher's course, kept in one document (key "course").
 * unitsPerLevel: how many vocabulary units each level has (20 when not set).
 */
const courseSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'course' },
  unitsPerLevel: { type: Map, of: Number, default: {} }
}, { timestamps: true });

export default mongoose.model('CourseSetting', courseSettingSchema);
