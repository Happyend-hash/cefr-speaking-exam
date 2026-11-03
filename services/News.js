import mongoose from 'mongoose';
import User from '../models/User.js';
import { SiteNews, NewsSetting, NEWS_KINDS } from '../models/SiteNews.js';
import { mediaStorage, readPhoto } from './MediaStorage.js';

/**
 * Sayt yangiliklari (2026-11-03). Written by the admin in the teacher panel;
 * shown on Home — the newest open, older ones folded. While the audience is
 * 'test' only the admin's linked test profile (and admins) see it.
 */
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const isId = id => mongoose.Types.ObjectId.isValid(String(id || ''));

export async function audience() {
  const s = await NewsSetting.findOne({ key: 'news' }).lean();
  return s?.audience || 'test';
}

export async function setAudience(value) {
  if (!['test', 'all'].includes(value)) throw fail('Choose who sees the news');
  await NewsSetting.updateOne({ key: 'news' }, { $set: { audience: value } }, { upsert: true });
  return value;
}

/** May this account see the news section right now? */
export async function canSeeNews(user) {
  if (user?.role === 'admin') return true;
  if ((await audience()) === 'all') return true;
  return Boolean(await User.exists({ role: 'admin', 'testAccount.user': user?.id }));
}

export const newsView = (n, { admin = false } = {}) => ({
  id: String(n._id),
  kind: n.kind,
  title: n.title,
  text: n.text || '',
  photo: n.photo?.key ? `/api/news/${n._id}/photo` : null,
  pinned: Boolean(n.pinned),
  at: n.createdAt,
  edited: n.updatedAt && n.createdAt && new Date(n.updatedAt) - new Date(n.createdAt) > 60e3 ? n.updatedAt : null,
  ...(admin ? { published: n.published } : {})
});

/** Newest first; a pinned item stays on top. */
export async function listNews({ admin = false, limit = 30 } = {}) {
  const rows = await SiteNews.find(admin ? {} : { published: true }).sort({ pinned: -1, createdAt: -1 }).limit(limit).lean();
  return rows.map(n => newsView(n, { admin }));
}

export async function saveNews(id, body = {}, by = '') {
  const title = String(body.title ?? '').trim();
  if (!title) throw fail('Write a title');
  const fields = {
    kind: NEWS_KINDS.includes(body.kind) ? body.kind : 'news',
    title: title.slice(0, 140),
    text: String(body.text || '').replace(/\r\n/g, '\n').trim().slice(0, 4000),
    published: body.published !== false,
    pinned: Boolean(body.pinned)
  };
  const item = id ? (isId(id) ? await SiteNews.findById(id) : null) : new SiteNews({ createdBy: by });
  if (!item) throw fail('News not found', 404);
  Object.assign(item, fields);
  if (body.photo) {
    const photo = readPhoto(body.photo);
    const key = await mediaStorage.store(photo, { owner: by || 'admin', purpose: 'news' });
    if (item.photo?.key) await mediaStorage.delete(item.photo.key, item.photo.type);
    item.photo = { key, type: photo.contentType };
  } else if (body.removePhoto && item.photo?.key) {
    await mediaStorage.delete(item.photo.key, item.photo.type);
    item.photo = undefined;
  }
  await item.save();
  return newsView(item.toObject(), { admin: true });
}

export async function deleteNews(id) {
  const item = isId(id) ? await SiteNews.findById(id) : null;
  if (!item) throw fail('News not found', 404);
  if (item.photo?.key) await mediaStorage.delete(item.photo.key, item.photo.type);
  await item.deleteOne();
  return true;
}

export async function newsPhoto(id, { admin = false } = {}) {
  if (!isId(id)) return null;
  const n = await SiteNews.findById(id).select('photo published').lean();
  if (!n?.photo?.key || (!n.published && !admin)) return null;
  return n.photo;
}

export default { audience, setAudience, canSeeNews, listNews, saveNews, deleteNews, newsPhoto, newsView };
