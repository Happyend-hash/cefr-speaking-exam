import mongoose from 'mongoose';
import SupportMessage from '../models/SupportMessage.js';
import SupportImage from '../models/SupportImage.js';
import User from '../models/User.js';

/**
 * English Hub Support (Jamshid, 2026-10-24): every student has one
 * conversation with the team, inside their message box. They can ask, report
 * a problem, suggest an idea or say what they liked, with a screenshot; the
 * team answers from the admin panel as "English Hub Support".
 */

export const KINDS = ['question', 'problem', 'idea', 'praise'];
export const MAX_TEXT = 2000;
export const MAX_IMAGE_BYTES = 900 * 1024;
export const PER_HOUR = 20;   // a student's messages per hour

const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/** A screenshot as the browser sends it (a data URL) → { data, contentType }, checked by its bytes. */
export function readImage(dataUrl) {
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw fail('Rasm JPEG, PNG yoki WebP bo‘lishi kerak', 400);
  const data = Buffer.from(m[3], 'base64');
  if (data.length > MAX_IMAGE_BYTES) throw fail('Rasm juda katta', 400);
  const isJpeg = data[0] === 0xff && data[1] === 0xd8;
  const isPng = data.slice(0, 4).toString('hex') === '89504e47';
  const isWebp = data.slice(0, 4).toString() === 'RIFF' && data.slice(8, 12).toString() === 'WEBP';
  if (!(isJpeg || isPng || isWebp)) throw fail('Bu fayl rasm emas', 400);
  return { data, contentType: m[1] };
}

const imageUrl = (id, admin) => (id ? `/api/${admin ? 'admin/support' : 'support'}/images/${id}` : null);

export function view(m, { admin = false } = {}) {
  return {
    id: String(m._id),
    from: m.from,
    kind: m.kind || null,
    text: m.text || '',
    image: imageUrl(m.image, admin),
    at: m.createdAt,
    seen: m.from === 'user' ? Boolean(m.readByTeam) : Boolean(m.readByUser),
    ...(admin && m.sentBy ? { sentBy: m.sentBy } : {})
  };
}

export async function userUnread(user) {
  return SupportMessage.countDocuments({ user, from: 'team', readByUser: null });
}

/** The student's conversation. Opening it marks the team's replies as seen. */
export async function thread(user, { markRead = true } = {}) {
  const list = await SupportMessage.find({ user }).sort({ createdAt: 1 }).limit(500).lean();
  if (markRead && list.some(m => m.from === 'team' && !m.readByUser)) {
    await SupportMessage.updateMany({ user, from: 'team', readByUser: null }, { $set: { readByUser: new Date() } });
  }
  return { messages: list.map(m => view(m)), unread: markRead ? 0 : await userUnread(user) };
}

async function saveImage(user, dataUrl) {
  if (!dataUrl) return null;
  const { data, contentType } = readImage(dataUrl);
  const img = await SupportImage.create({ user, data, contentType });
  return img._id;
}

/** The student writes. */
export async function userSend(user, { kind, text, image }) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
  if (!body && !image) throw fail('Xabar yozing', 400);
  const k = KINDS.includes(kind) ? kind : 'question';
  const recent = await SupportMessage.countDocuments({ user, from: 'user', createdAt: { $gt: new Date(Date.now() - 3600 * 1000) } });
  if (recent >= PER_HOUR) throw fail('Juda ko‘p xabar yuborildi — birozdan keyin yozing', 429);
  const imageId = await saveImage(user, image);
  const m = await SupportMessage.create({ user, from: 'user', kind: k, text: body, image: imageId });
  return view(m.toObject());
}

/** The team answers (admin panel). */
export async function teamSend(user, { text, image, sentBy }) {
  if (!mongoose.isValidObjectId(user)) throw fail('Unknown student', 404);
  const exists = await User.exists({ _id: user });
  if (!exists) throw fail('Unknown student', 404);
  const body = String(text || '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
  if (!body && !image) throw fail('Write a reply', 400);
  const imageId = await saveImage(user, image);
  // Answering means the team has read everything before it.
  await SupportMessage.updateMany({ user, from: 'user', readByTeam: null }, { $set: { readByTeam: new Date() } });
  const m = await SupportMessage.create({ user, from: 'team', text: body, image: imageId, sentBy });
  return view(m.toObject(), { admin: true });
}

/** A picture, only to its owner or the team. */
export async function image(id, { user, admin = false }) {
  if (!mongoose.isValidObjectId(id)) return null;
  const img = await SupportImage.findById(id).lean();
  if (!img) return null;
  if (!admin && String(img.user) !== String(user)) return null;
  return img;
}

// ---------------------------------------------------------------- admin

export async function teamUnread() {
  return SupportMessage.countDocuments({ from: 'user', readByTeam: null });
}

/**
 * Every conversation, newest activity first, with what the student last
 * wrote and how many messages wait for the team. `only: 'waiting'` keeps
 * the ones whose last message is the student's.
 */
export async function conversations({ only = '', limit = 100 } = {}) {
  const rows = await SupportMessage.aggregate([
    { $sort: { createdAt: -1 } },
    { $group: {
      _id: '$user',
      lastAt: { $first: '$createdAt' }, lastFrom: { $first: '$from' }, lastText: { $first: '$text' },
      lastKind: { $first: '$kind' }, lastImage: { $first: '$image' },
      unread: { $sum: { $cond: [{ $and: [{ $eq: ['$from', 'user'] }, { $not: [{ $ifNull: ['$readByTeam', false] }] }] }, 1, 0] } },
      total: { $sum: 1 },
      kinds: { $push: { $cond: [{ $eq: ['$from', 'user'] }, '$kind', null] } }
    } },
    ...(only === 'waiting' ? [{ $match: { lastFrom: 'user' } }] : []),
    { $sort: { lastAt: -1 } },
    { $limit: limit }
  ]);
  const users = await User.find({ _id: { $in: rows.map(r => r._id) } }).select('firstName lastName email').lean();
  const byId = new Map(users.map(u => [String(u._id), u]));
  const totals = await SupportMessage.aggregate([{ $match: { from: 'user' } }, { $group: { _id: '$kind', n: { $sum: 1 } } }]);
  return {
    conversations: rows.map(r => {
      const u = byId.get(String(r._id));
      return {
        user: String(r._id),
        name: u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : '',
        email: u?.email || '(deleted account)',
        lastAt: r.lastAt, lastFrom: r.lastFrom, lastKind: r.lastKind,
        lastText: (r.lastText || (r.lastImage ? '📷' : '')).slice(0, 140),
        unread: r.unread, total: r.total,
        kinds: KINDS.filter(k => r.kinds.includes(k))
      };
    }),
    totals: Object.fromEntries(KINDS.map(k => [k, totals.find(t => t._id === k)?.n || 0])),
    unread: await teamUnread()
  };
}

/** One conversation for the team. Opening it marks the student's messages as read. */
export async function teamThread(user) {
  if (!mongoose.isValidObjectId(user)) throw fail('Unknown student', 404);
  const [list, u] = await Promise.all([
    SupportMessage.find({ user }).sort({ createdAt: 1 }).limit(500).lean(),
    User.findById(user).select('firstName lastName email createdAt').lean()
  ]);
  if (list.some(m => m.from === 'user' && !m.readByTeam)) {
    await SupportMessage.updateMany({ user, from: 'user', readByTeam: null }, { $set: { readByTeam: new Date() } });
  }
  return {
    user: { id: String(user), name: u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : '', email: u?.email || '(deleted account)', since: u?.createdAt || null },
    messages: list.map(m => view(m, { admin: true })),
    unread: await teamUnread()
  };
}

export default { KINDS, readImage, view, userUnread, thread, userSend, teamSend, image, teamUnread, conversations, teamThread };
