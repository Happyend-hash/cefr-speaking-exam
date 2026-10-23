import mongoose from 'mongoose';
import sanitizeHtml from 'sanitize-html';
import Message from '../models/Message.js';
import User from '../models/User.js';
import CourseStudent from '../models/CourseStudent.js';

/**
 * The message box (Jamshid, 2026-10-23): the teacher writes to one student,
 * a few, his own course students, or everyone — website updates, news,
 * anything — with bold, colours and sizes; a message can carry a gift of
 * mocks that the student unwraps and activates; and an expert review that
 * changes a score writes to the student by itself.
 */

export const MAX_GIFT = 10;            // per module, per gift
export const MAX_RECIPIENTS = 5000;

const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i];

const CLEAN = {
  allowedTags: ['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'span', 'font', 'h2', 'h3',
    'ul', 'ol', 'li', 'a', 'mark', 'blockquote', 'hr', 'small', 'big'],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    font: ['color', 'size'],
    '*': ['style']
  },
  allowedStyles: {
    '*': {
      color: COLOR,
      'background-color': COLOR,
      'font-size': [/^(x-small|small|medium|large|x-large|xx-large|1[0-9]px|2[0-9]px|3[0-6]px|\d(\.\d+)?em)$/],
      'font-weight': [/^(bold|normal|[1-9]00)$/],
      'font-style': [/^(italic|normal)$/],
      'text-decoration': [/^(underline|line-through|none)$/],
      'text-decoration-line': [/^(underline|line-through|none)$/],
      'text-align': [/^(left|center|right)$/]
    }
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: (tag, attribs) => ({ tagName: 'a', attribs: { href: attribs.href, target: '_blank', rel: 'noopener noreferrer' } })
  },
  exclusiveFilter: frame => frame.tag === 'a' && !frame.attribs.href
};

/** Rich text as the editor produced it → only the formatting the box allows. */
export function cleanHtml(html) {
  return sanitizeHtml(String(html || ''), CLEAN).trim();
}

const textOf = html => sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();

function giftOf(raw) {
  if (!raw) return null;
  const n = v => (v === undefined || v === null || v === '' ? 0 : Number(v));
  const speaking = n(raw.speaking);
  const writing = n(raw.writing);
  for (const v of [speaking, writing]) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_GIFT) throw Object.assign(new Error(`A gift holds 0 to ${MAX_GIFT} mocks of each kind`), { statusCode: 400 });
  }
  if (!speaking && !writing) return null;
  return { speaking, writing };
}

/** Who a send goes to: 'all' | 'course' | [userId, …]. Students only. */
export async function recipients(to) {
  if (to === 'all') {
    return (await User.find({ role: 'student' }).select('_id').lean()).map(u => u._id);
  }
  if (to === 'course') {
    const emails = (await CourseStudent.find({ removedAt: null, accountEmail: { $nin: [null, ''] } }).select('accountEmail').lean())
      .map(s => s.accountEmail);
    if (!emails.length) return [];
    return (await User.find({ email: { $in: emails } }).select('_id').lean()).map(u => u._id);
  }
  const ids = [...new Set((Array.isArray(to) ? to : []).map(String))].filter(id => mongoose.isValidObjectId(id));
  if (!ids.length) return [];
  return (await User.find({ _id: { $in: ids } }).select('_id').lean()).map(u => u._id);
}

/** The teacher's send. Returns { batch, sent }. */
export async function sendMessages({ to, title, html, gift, sentBy }) {
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const body = cleanHtml(html);
  const box = giftOf(gift);
  if (!cleanTitle) throw Object.assign(new Error('Give the message a title'), { statusCode: 400 });
  if (!textOf(body) && !box) throw Object.assign(new Error('Write the message (or add a gift)'), { statusCode: 400 });
  if (body.length > 40000) throw Object.assign(new Error('The message is too long'), { statusCode: 400 });

  const users = await recipients(to);
  if (!users.length) throw Object.assign(new Error('No students to send to'), { statusCode: 400 });
  if (users.length > MAX_RECIPIENTS) throw Object.assign(new Error('Too many recipients at once'), { statusCode: 400 });

  const batch = new mongoose.Types.ObjectId();
  const docs = users.map(user => ({
    user, batch, kind: box ? 'gift' : 'note', title: cleanTitle, html: body, sentBy,
    ...(box ? { gift: { ...box } } : {})
  }));
  for (let i = 0; i < docs.length; i += 500) await Message.insertMany(docs.slice(i, i + 500), { ordered: false });
  return { batch: String(batch), sent: docs.length };
}

/** What the student's box shows for one message. */
export function view(m) {
  return {
    id: String(m._id),
    kind: m.kind,
    title: m.title,
    html: m.html,
    gift: m.kind === 'gift' ? {
      speaking: m.gift?.speaking || 0,
      writing: m.gift?.writing || 0,
      opened: Boolean(m.gift?.openedAt),
      claimed: Boolean(m.gift?.claimedAt),
      claimedAt: m.gift?.claimedAt || null
    } : null,
    score: m.kind === 'score' ? m.score : null,
    read: Boolean(m.readAt),
    at: m.createdAt
  };
}

const visible = user => ({ user, hiddenAt: null });
const waiting = user => ({ ...visible(user), $or: [{ readAt: null }, { kind: 'gift', 'gift.claimedAt': null }] });

export async function unreadCount(user) {
  return Message.countDocuments(waiting(user));
}

export async function inbox(user, { limit = 100 } = {}) {
  const [list, unread] = await Promise.all([
    Message.find(visible(user)).sort({ createdAt: -1 }).limit(limit).lean(),
    unreadCount(user)
  ]);
  return { messages: list.map(view), unread };
}

export async function markRead(user, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const m = await Message.findOneAndUpdate({ _id: id, ...visible(user) }, { $set: { readAt: new Date() } }, { new: true }).lean();
  return m ? view(m) : null;
}

/** The box is unwrapped (the button that opens it was pressed). Nothing granted yet. */
export async function openGift(user, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const now = new Date();
  await Message.updateOne({ _id: id, ...visible(user), kind: 'gift', 'gift.openedAt': null }, { $set: { 'gift.openedAt': now } });
  const m = await Message.findOneAndUpdate({ _id: id, ...visible(user), readAt: null }, { $set: { readAt: now } }, { new: true }).lean()
    || await Message.findOne({ _id: id, ...visible(user) }).lean();
  return m ? view(m) : null;
}

/**
 * Activate: the mocks go onto the account, once. The message is marked
 * claimed first (only one request can win that), then the balance moves; if
 * that fails the claim is undone so the student can press again.
 */
export async function claimGift(user, id) {
  if (!mongoose.isValidObjectId(id)) throw Object.assign(new Error('Sovg‘a topilmadi'), { statusCode: 404 });
  const now = new Date();
  const m = await Message.findOneAndUpdate(
    { _id: id, ...visible(user), kind: 'gift', 'gift.claimedAt': null },
    { $set: { 'gift.claimedAt': now, 'gift.openedAt': now, readAt: now } },
    { new: true }
  ).lean();
  if (!m) {
    const existing = await Message.findOne({ _id: id, ...visible(user) }).lean();
    if (existing?.gift?.claimedAt) throw Object.assign(new Error('Bu sovg‘a allaqachon faollashtirilgan'), { statusCode: 409 });
    throw Object.assign(new Error('Sovg‘a topilmadi'), { statusCode: 404 });
  }
  const inc = {};
  if (m.gift.speaking) inc['subscription.examsRemaining'] = m.gift.speaking;
  if (m.gift.writing) inc['subscription.writingRemaining'] = m.gift.writing;
  try {
    const updated = await User.findOneAndUpdate({ _id: user }, { $inc: inc }, { new: true }).select('subscription').lean();
    if (!updated) throw new Error('account not found');
    return {
      message: view(m),
      balance: { speaking: updated.subscription?.examsRemaining ?? 0, writing: updated.subscription?.writingRemaining ?? 0 }
    };
  } catch (error) {
    await Message.updateOne({ _id: m._id }, { $set: { 'gift.claimedAt': null } });
    throw error;
  }
}

/** The student deletes a message from their box. A gift not yet activated stays. */
export async function hide(user, id) {
  if (!mongoose.isValidObjectId(id)) return false;
  const m = await Message.findOne({ _id: id, ...visible(user) }).lean();
  if (!m) return false;
  if (m.kind === 'gift' && !m.gift?.claimedAt) throw Object.assign(new Error('Avval sovg‘ani faollashtiring'), { statusCode: 409 });
  await Message.updateOne({ _id: m._id }, { $set: { hiddenAt: new Date() } });
  return true;
}

// ---------------------------------------------------------------- admin

/** The teacher's sent list: one row per send, with how many read it / activated the gift. */
export async function sentBatches({ limit = 30 } = {}) {
  const rows = await Message.aggregate([
    { $match: { batch: { $ne: null } } },
    { $sort: { createdAt: -1 } },
    { $group: {
      _id: '$batch',
      at: { $first: '$createdAt' }, title: { $first: '$title' }, kind: { $first: '$kind' },
      html: { $first: '$html' }, gift: { $first: '$gift' },
      recipients: { $sum: 1 },
      read: { $sum: { $cond: [{ $ifNull: ['$readAt', false] }, 1, 0] } },
      claimed: { $sum: { $cond: [{ $ifNull: ['$gift.claimedAt', false] }, 1, 0] } },
      users: { $push: '$user' }
    } },
    { $sort: { at: -1 } },
    { $limit: limit }
  ]);
  const few = [...new Set(rows.filter(r => r.recipients <= 3).flatMap(r => r.users.map(String)))];
  const people = few.length ? await User.find({ _id: { $in: few } }).select('firstName lastName email').lean() : [];
  const name = id => { const u = people.find(p => String(p._id) === String(id)); return u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email) : '—'; };
  return rows.map(r => ({
    batch: String(r._id), at: r.at, title: r.title, kind: r.kind,
    preview: textOf(r.html).slice(0, 140),
    gift: r.kind === 'gift' ? { speaking: r.gift?.speaking || 0, writing: r.gift?.writing || 0 } : null,
    recipients: r.recipients, read: r.read, claimed: r.claimed,
    to: r.recipients <= 3 ? r.users.map(name) : null
  }));
}

/** Withdraw a send. Gifts already activated keep their mocks; nothing else is undone. */
export async function withdrawBatch(batch) {
  if (!mongoose.isValidObjectId(batch)) return { removed: 0, keptClaimed: 0 };
  const keptClaimed = await Message.countDocuments({ batch, 'gift.claimedAt': { $ne: null } });
  const { deletedCount } = await Message.deleteMany({ batch });
  return { removed: deletedCount, keptClaimed };
}

// ---------------------------------------------------------------- score updates

const LEVEL_NAME = level => (level === 'B1dan quyi' ? 'Below B1' : level || '—');

/**
 * The message an expert review writes on its own. English, as Jamshid asked,
 * with the parts, the mark, the converted score and the level, old and new.
 */
export async function scoreUpdateMessage({ user, module, attemptId, attemptTitle, attemptDate, parts, before, after, sentBy }) {
  const went = (after.score ?? -1) > (before.score ?? -1) ? 'upgraded'
    : (after.score ?? -1) < (before.score ?? -1) ? 'changed' : 'updated';
  const skill = module === 'writing' ? 'writing' : 'speaking';
  const when = attemptDate ? new Date(attemptDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Tashkent' }) : '';
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<p>Your ${skill} attempt <strong>“${esc(attemptTitle || 'Mock exam')}”</strong>${when ? ` of ${esc(when)}` : ''} has been reviewed by a real expert examiner, and your scores have been ${went} as follows:</p>`;
  const title = after.score !== null && after.score !== undefined
    ? `Your ${skill} score has been ${went}: ${after.score}/75 (${LEVEL_NAME(after.level)})`
    : `Your ${skill} result has been ${went}: ${LEVEL_NAME(after.level)}`;
  const m = await Message.create({
    user, batch: new mongoose.Types.ObjectId(), kind: 'score', title: title.slice(0, 140), html, sentBy,
    score: { module: skill, attemptId: String(attemptId), attemptTitle, attemptDate, parts, before, after }
  });
  return view(m.toObject());
}

export default {
  cleanHtml, recipients, sendMessages, view, unreadCount, inbox, markRead, openGift, claimGift, hide,
  sentBatches, withdrawBatch, scoreUpdateMessage, MAX_GIFT
};
