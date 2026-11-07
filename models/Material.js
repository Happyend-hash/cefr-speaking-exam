import mongoose from 'mongoose';
import { MATERIAL_FOLDERS, MATERIAL_LEVELS } from '../content/materials.js';

/**
 * A study material in "Materiallar" (2026-11-07): a file the teacher uploaded
 * (PDF, Word, PowerPoint, Excel, picture, audio, video) or a link.
 * The file itself is on the Railway volume (services/MaterialStorage.js).
 */
const materialSchema = new mongoose.Schema({
  folder: { type: String, enum: MATERIAL_FOLDERS.map(f => f.key), required: true },
  section: { type: String, default: '', maxlength: 60 },
  title: { type: String, required: true, maxlength: 140 },
  description: { type: String, default: '', maxlength: 400 },
  level: { type: String, enum: MATERIAL_LEVELS, default: 'all' },
  kind: { type: String, enum: ['pdf', 'word', 'slides', 'sheet', 'image', 'audio', 'video', 'link'], required: true },
  file: { key: String, name: String, type: { type: String }, size: Number },
  url: { type: String, default: '' },            // kind 'link'
  premium: { type: Boolean, default: false },    // only Premium students may open it
  hidden: { type: Boolean, default: false },
  order: { type: Number, default: 0 },           // within its sub-folder; smaller first
  views: { type: Number, default: 0 },
  viewers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', select: false }],
  createdBy: String
}, { timestamps: true });

materialSchema.index({ folder: 1, section: 1, order: 1, createdAt: -1 });

export default mongoose.model('Material', materialSchema);
