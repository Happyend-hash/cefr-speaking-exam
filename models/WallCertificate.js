import mongoose from 'mongoose';

/**
 * A real exam result a student uploaded to show what they achieved
 * (Jamshid, 2026-11-03). The teacher approves it before it appears on the
 * public wall; a rejected one is shown to its owner with the reason.
 */
const score = { type: Number, min: 0, max: 75, default: null };

const wallCertificateSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },   // how it is shown on the wall
  level: { type: String, enum: ['B1', 'B2', 'C1'], required: true },
  overall: score,
  speaking: score,
  writing: score,
  listening: score,
  reading: score,
  examMonth: { type: String, match: /^\d{4}-\d{2}$/ },                 // when the exam was taken
  story: { type: String, trim: true, maxlength: 600, default: '' },     // how the website helped
  photo: { key: { type: String, required: true }, type: { type: String } },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  reason: { type: String, default: '' },                                // why it was not approved
  reviewedAt: Date,
  reviewedBy: String
}, { timestamps: true });

wallCertificateSchema.index({ status: 1, reviewedAt: -1 });

export default mongoose.model('WallCertificate', wallCertificateSchema);
