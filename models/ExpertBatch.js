import mongoose from 'mongoose';

/**
 * One expert calibration batch (2026-11-21): the 15 mocks sent to a certified
 * examiner, by code. The key (which attempt each code is, and the AI's bands at
 * the time) is kept here so her marks can be compared with the AI's later.
 */
const itemSchema = new mongoose.Schema({
  code: { type: String, required: true },
  result: { type: mongoose.Schema.Types.ObjectId, ref: 'ExamResult', required: true },
  stratum: String,
  student: String,
  exam: String,
  completedAt: Date,
  aiScore: Number,
  aiLevel: String,
  aiBands: { part11: Number, part12: Number, part2: Number, part3: Number },
  aiMarkers: [{ _id: false, part11: Number, part12: Number, part2: Number, part3: Number }]
}, { _id: false });

const expertBatchSchema = new mongoose.Schema({
  seed: String,
  items: [itemSchema],
  swappedOut: [mongoose.Schema.Types.ObjectId],
  available: Number,          // how many mocks could have been chosen
  createdBy: String,
  closedAt: { type: Date, default: null }
}, { timestamps: true });

export default mongoose.model('ExpertBatch', expertBatchSchema);
