import mongoose from 'mongoose';

/**
 * "Sayt yangiliklari" on the students' Home screen (Jamshid, 2026-11-03):
 * news about the site — changes, updates, events that took place, students'
 * results. The newest is shown open; older ones fold under it.
 *
 * NewsSetting holds who sees the section at all: 'test' = only the admin's
 * test profile (to try it first), 'all' = every student.
 */
export const NEWS_KINDS = ['news', 'update', 'event', 'results'];

const siteNewsSchema = new mongoose.Schema({
  kind: { type: String, enum: NEWS_KINDS, default: 'news' },
  title: { type: String, required: true, trim: true, maxlength: 140 },
  text: { type: String, trim: true, maxlength: 4000, default: '' },
  photo: { key: String, type: { type: String } },
  published: { type: Boolean, default: true },
  pinned: { type: Boolean, default: false },
  createdBy: String
}, { timestamps: true });
siteNewsSchema.index({ published: 1, createdAt: -1 });

const newsSettingSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'news' },
  audience: { type: String, enum: ['test', 'all'], default: 'test' }
}, { timestamps: true });

export const SiteNews = mongoose.model('SiteNews', siteNewsSchema);
export const NewsSetting = mongoose.model('NewsSetting', newsSettingSchema);
export default SiteNews;
