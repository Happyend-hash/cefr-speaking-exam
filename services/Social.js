import mongoose from 'mongoose';
import User from '../models/User.js';
import ExamResult from '../models/ExamResult.js';
import {
  Friendship, SocialBlock, Conversation, DirectMessage, SocialPost, SocialReport, SocialComment, pairOf
} from '../models/Social.js';
import { cleanMessage } from './ChatFilter.js';
import { badgeOf, BADGE_FIELDS, isPremium } from './Premium.js';
import { fallbackName } from './Leaderboard.js';
import { mediaStorage, readPhoto } from './MediaStorage.js';
import AudioStorageService from './AudioStorageService.js';
import { socialHub } from './SocialHub.js';
import { notifySoon } from './Push.js';

/**
 * Do'stlar — friends, private chats with photos and voice messages, photo
 * posts and 24-hour stories (Jamshid, 2026-11-03).
 *
 * Privacy rules, all enforced here on the server:
 *   - People (everyone): name, picture, level and whether you are friends.
 *     Nothing else until a friend request is accepted.
 *   - Friends: bio, posts, stories, likes, comments (only friends may comment).
 *   - Messages: friends chat freely. Anyone else may send ONE text as a
 *     request; it waits in "So'rovlar" until accepted, deleted or blocked.
 *     Photos and voice only once the chat is accepted.
 *   - Block (either way): no messages, no requests, not shown to each other,
 *     friendship ended.
 *   - Text goes through the same filter as the chat rooms (swearing masked,
 *     links and phone numbers removed, English please).
 */

const fail = (message, statusCode = 400, code) => Object.assign(new Error(message), { statusCode, code });
const isId = id => mongoose.Types.ObjectId.isValid(String(id || '')) && /^[a-f0-9]{24}$/i.test(String(id));
const oid = id => new mongoose.Types.ObjectId(String(id));

export const STORY_HOURS = 24;
export const LIMITS = { friendRequestsPerDay: 30, postsPerDay: 3, storiesPerDay: 3, messagesPerMinute: 30, commentsPerHour: 40 };
// Premium (2026-11-03): posts and stories without a daily cap (50 is only a guard), 3-minute voice messages.
export const PREMIUM_LIMITS = { postsPerDay: 50, storiesPerDay: 50 };
export const PREMIUM_VOICE_SECONDS = 180;
export const COMMENT_PREVIEW = 2;     // comments shown under a post before "Barcha izohlar"
export const VOICE_MAX_SECONDS = 60;
const USER_FIELDS = `firstName lastName nickname role access social isEmailVerified emailVerificationRequired ${BADGE_FIELDS}`;

// ------------------------------------------------------------- pace

const recent = new Map();
/** At most 1 message a second and 30 a minute per student (in memory, one process). */
export function allowSend(userId, now = Date.now()) {
  const id = String(userId);
  const times = (recent.get(id) || []).filter(t => now - t < 60000);
  if (times.length && now - times[times.length - 1] < 700) return false;
  if (times.length >= LIMITS.messagesPerMinute) return false;
  times.push(now);
  recent.set(id, times);
  return true;
}

// ------------------------------------------------------------- people

const nameOf = u => u?.nickname || fallbackName(u);

/** The latest CEFR level each of these students reached in a marked mock. */
async function examLevels(ids) {
  if (!ids.length) return new Map();
  const rows = await ExamResult.aggregate([
    { $match: { student: { $in: ids.map(oid) }, status: 'completed', overallLevel: { $in: ['B1', 'B2', 'C1'] } } },
    { $sort: { completedAt: -1 } },
    { $group: { _id: '$student', level: { $first: '$overallLevel' } } }
  ]);
  return new Map(rows.map(r => [String(r._id), r.level]));
}

/** What anyone may see of a person. */
export function card(u, { level = null, relation = 'none' } = {}) {
  return {
    id: String(u._id),
    name: nameOf(u),
    level: u.social?.level || level || null,
    online: socialHub.isOnline(u._id),
    lastSeenAt: u.social?.lastSeenAt || null,
    relation,
    ...badgeOf(u)
  };
}

async function me(userId) {
  const u = await User.findById(userId).select(USER_FIELDS).lean();
  if (!u) throw fail('Foydalanuvchi topilmadi', 404);
  if (u.access?.blocked) throw fail('Hisobingiz vaqtincha to‘xtatilgan.', 403, 'blocked');
  return u;
}

/** Can this account take part? Students who confirmed their email, not blocked by the teacher. */
const usable = u => u && u.role === 'student' && !u.access?.blocked && !(u.emailVerificationRequired && !u.isEmailVerified);

async function other(userId, id) {
  if (!isId(id) || String(id) === String(userId)) throw fail('Foydalanuvchi topilmadi', 404);
  const u = await User.findById(id).select(USER_FIELDS).lean();
  if (!usable(u)) throw fail('Foydalanuvchi topilmadi', 404);
  return u;
}

/** Everyone I blocked and everyone who blocked me. */
async function blockedSet(userId) {
  const rows = await SocialBlock.find({ $or: [{ by: userId }, { user: userId }] }).select('by user').lean();
  const out = new Set();
  for (const r of rows) out.add(String(r.by) === String(userId) ? String(r.user) : String(r.by));
  return out;
}

async function isBlocked(a, b) {
  return Boolean(await SocialBlock.exists({ $or: [{ by: a, user: b }, { by: b, user: a }] }));
}

async function friendship(a, b) {
  return Friendship.findOne({ pair: pairOf(a, b) });
}

export async function areFriends(a, b) {
  return Boolean(await Friendship.exists({ pair: pairOf(a, b), status: 'friends' }));
}

/** My relation to each of these ids: friends | sent | incoming | none. */
async function relations(userId, ids) {
  const rows = await Friendship.find({ pair: { $in: ids.map(id => pairOf(userId, id)) } }).lean();
  const out = new Map();
  for (const f of rows) {
    const otherId = f.users.map(String).find(x => x !== String(userId));
    out.set(otherId, f.status === 'friends' ? 'friends' : (String(f.requester) === String(userId) ? 'sent' : 'incoming'));
  }
  return out;
}

async function cards(userId, users) {
  const ids = users.map(u => String(u._id));
  const [levels, rel] = await Promise.all([examLevels(ids), relations(userId, ids)]);
  return users.map(u => card(u, { level: levels.get(String(u._id)), relation: rel.get(String(u._id)) || 'none' }));
}

/** People: every student except me and anyone blocked either way, most recently active first. */
export async function people(userId, { q = '', limit = 60 } = {}) {
  await me(userId);
  const hidden = await blockedSet(userId);
  const filter = {
    role: 'student',
    'access.blocked': { $ne: true },
    _id: { $nin: [oid(userId), ...[...hidden].map(oid)] },
    $or: [{ emailVerificationRequired: { $ne: true } }, { isEmailVerified: true }]
  };
  const search = String(q || '').trim().slice(0, 40);
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$and = [{ $or: [{ nickname: rx }, { firstName: rx }, { lastName: rx }] }];
  }
  const users = await User.find(filter).select(USER_FIELDS)
    .sort({ 'social.lastSeenAt': -1, createdAt: -1 }).limit(Math.min(limit, 100)).lean();
  const list = await cards(userId, users);
  // Premium first (2026-11-03), then online, then the order above
  return list.sort((a, b) => Number(Boolean(b.premium)) - Number(Boolean(a.premium)) || Number(b.online) - Number(a.online));
}

/** Friend requests waiting for me, and the ones I sent. */
export async function friendRequests(userId) {
  const rows = await Friendship.find({ users: userId, status: 'pending' }).sort({ createdAt: -1 }).limit(100).lean();
  const hidden = await blockedSet(userId);
  const ids = rows.map(f => f.users.map(String).find(x => x !== String(userId))).filter(id => !hidden.has(id));
  const users = await User.find({ _id: { $in: ids } }).select(USER_FIELDS).lean();
  const list = (await cards(userId, users.filter(usable)));
  return { incoming: list.filter(p => p.relation === 'incoming'), sent: list.filter(p => p.relation === 'sent') };
}

export async function friends(userId) {
  const rows = await Friendship.find({ users: userId, status: 'friends' }).sort({ since: -1 }).limit(500).lean();
  const ids = rows.map(f => f.users.map(String).find(x => x !== String(userId)));
  const users = await User.find({ _id: { $in: ids } }).select(USER_FIELDS).lean();
  return (await cards(userId, users.filter(usable))).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** A profile: everyone sees the card; friends (and I) see bio, posts and stories. */
export async function profile(userId, id) {
  const self = String(id) === String(userId);
  const u = self ? await me(userId) : await other(userId, id);
  if (!self && await isBlocked(userId, id)) throw fail('Foydalanuvchi topilmadi', 404);
  const [c] = await cards(userId, [u]);
  const open = self || c.relation === 'friends';
  const out = { ...c, self, open, canMessage: !self };
  if (!open) return out;
  const [friendCount, posts, stories] = await Promise.all([
    Friendship.countDocuments({ users: u._id, status: 'friends' }),
    SocialPost.find({ user: u._id, kind: 'post', removed: false }).sort({ createdAt: -1 }).limit(30).lean(),
    SocialPost.find({ user: u._id, kind: 'story', removed: false, expiresAt: { $gt: new Date() } }).sort({ createdAt: 1 }).lean()
  ]);
  return {
    ...out,
    bio: u.social?.bio || '',
    friendCount,
    posts: (await withComments(posts, userId)).map(p => postView(p, userId, c)),
    stories: stories.map(p => postView(p, userId, c))
  };
}

export async function updateMyProfile(userId, { bio, level } = {}) {
  const set = {};
  if (bio !== undefined) {
    const text = String(bio || '').replace(/\s+/g, ' ').trim();
    if (text) {
      const checked = cleanMessage(text.slice(0, 160));
      if (!checked.ok) throw fail(checked.reason === 'english' ? 'Please write in English 🙂' : 'Bu matnni saqlab bo‘lmaydi');
      set['social.bio'] = checked.text.slice(0, 160);
    } else set['social.bio'] = '';
  }
  if (level !== undefined) {
    if (!['', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(String(level))) throw fail('Darajani tanlang');
    set['social.level'] = String(level);
  }
  await User.updateOne({ _id: userId }, { $set: set });
  return profile(userId, userId);
}

export async function touch(userId) {
  await User.updateOne({ _id: userId }, { $set: { 'social.lastSeenAt': new Date() } }).catch(() => {});
}

// ------------------------------------------------------------- friends

export async function requestFriend(userId, id) {
  const asker = await me(userId);
  const u = await other(userId, id);
  if (await isBlocked(userId, id)) throw fail('Bu foydalanuvchiga so‘rov yuborib bo‘lmaydi', 403);
  const f = await friendship(userId, id);
  if (f?.status === 'friends') return 'friends';
  if (f && String(f.requester) !== String(userId)) return acceptFriend(userId, id);
  if (f) return 'sent';
  const since = new Date(Date.now() - 864e5);
  const today = await Friendship.countDocuments({ requester: userId, createdAt: { $gt: since } });
  if (today >= LIMITS.friendRequestsPerDay) throw fail('Bugun juda ko‘p so‘rov yubordingiz — ertaga davom eting', 429);
  try {
    await Friendship.create({ pair: pairOf(userId, id), users: [userId, u._id], requester: userId });
  } catch (error) {
    if (error?.code !== 11000) throw error;          // both pressed at once: the other one won
  }
  socialHub.send(id, 'friend', { kind: 'request', from: String(userId) });
  notifySoon(u._id, { title: 'Do‘stlik so‘rovi 🤝', body: `${nameOf(asker)} siz bilan do‘st bo‘lmoqchi`, url: '/?open=friends', kind: 'friend', from: String(userId) });
  return 'sent';
}

export async function acceptFriend(userId, id) {
  const f = await friendship(userId, id);
  if (!f || f.status !== 'pending' || String(f.requester) === String(userId)) throw fail('So‘rov topilmadi', 404);
  f.status = 'friends';
  f.since = new Date();
  await f.save();
  // A waiting chat request between them opens too.
  await Conversation.updateOne({ pair: pairOf(userId, id), status: 'request' }, { $set: { status: 'open' } });
  socialHub.send(id, 'friend', { kind: 'accepted', from: String(userId) });
  socialHub.send(userId, 'friend', { kind: 'accepted', from: String(id) });
  return 'friends';
}

/** Decline a request, cancel mine, or stop being friends. */
export async function removeFriend(userId, id) {
  if (!isId(id)) throw fail('Foydalanuvchi topilmadi', 404);
  await Friendship.deleteOne({ pair: pairOf(userId, id) });
  socialHub.send(id, 'friend', { kind: 'removed', from: String(userId) });
  return 'none';
}

// ------------------------------------------------------------- blocking

export async function block(userId, id) {
  if (!isId(id) || String(id) === String(userId)) throw fail('Foydalanuvchi topilmadi', 404);
  await SocialBlock.updateOne({ by: userId, user: id }, { $setOnInsert: { by: userId, user: id } }, { upsert: true });
  await Friendship.deleteOne({ pair: pairOf(userId, id) });
  // a waiting request from them is simply gone
  const conv = await Conversation.findOne({ pair: pairOf(userId, id), status: 'request', requester: id });
  if (conv) await deleteConversation(conv);
  return true;
}

export async function unblock(userId, id) {
  if (!isId(id)) throw fail('Foydalanuvchi topilmadi', 404);
  await SocialBlock.deleteOne({ by: userId, user: id });
  return true;
}

export async function blockedList(userId) {
  const rows = await SocialBlock.find({ by: userId }).sort({ createdAt: -1 }).lean();
  const users = await User.find({ _id: { $in: rows.map(r => r.user) } }).select(USER_FIELDS).lean();
  return users.map(u => card(u, { relation: 'blocked' }));
}

// ------------------------------------------------------------- chats

const lastText = m => (m.kind === 'photo' ? '📷 Rasm' : m.kind === 'voice' ? '🎤 Ovozli xabar' : m.text);

export function messageView(m, userId) {
  return {
    id: String(m._id),
    from: String(m.from),
    mine: String(m.from) === String(userId),
    kind: m.kind,
    text: m.removed ? '' : m.text,
    removed: Boolean(m.removed),
    photo: m.kind === 'photo' && !m.removed ? `/api/social/photo/m/${m._id}` : null,
    audio: m.kind === 'voice' && !m.removed ? `/api/social/voice/${m._id}` : null,
    seconds: m.seconds || null,
    read: Boolean(m.readAt),
    at: m.createdAt
  };
}

function chatView(conv, userId, person) {
  const otherId = conv.users.map(String).find(x => x !== String(userId));
  const incoming = conv.status === 'request' && String(conv.requester) === otherId;
  return {
    id: String(conv._id),
    with: person,
    withId: otherId,
    status: conv.status,                         // open | request
    incoming,                                    // a request waiting for MY answer
    waiting: conv.status === 'request' && !incoming,   // my request waiting for theirs
    last: conv.last?.kind ? { mine: String(conv.last.from) === String(userId), text: conv.last.text } : null,
    lastAt: conv.lastAt,
    unread: conv.unread?.get?.(String(userId)) ?? conv.unread?.[String(userId)] ?? 0
  };
}

/** My chats (newest first) and the requests waiting for my answer. */
export async function chats(userId) {
  await me(userId);
  const hidden = await blockedSet(userId);
  const convs = await Conversation.find({ users: userId }).sort({ lastAt: -1 }).limit(200).lean();
  const shown = convs.filter(c => {
    const otherId = c.users.map(String).find(x => x !== String(userId));
    if (hidden.has(otherId)) return false;
    const cleared = c.clearedAt?.[String(userId)];
    return !cleared || new Date(c.lastAt) > new Date(cleared);
  });
  const ids = shown.map(c => c.users.map(String).find(x => x !== String(userId)));
  const users = await User.find({ _id: { $in: ids } }).select(USER_FIELDS).lean();
  const byId = new Map((await cards(userId, users)).map(p => [p.id, p]));
  const list = shown
    .map(c => chatView(c, userId, byId.get(c.users.map(String).find(x => x !== String(userId)))))
    .filter(c => c.with);
  return { chats: list.filter(c => !c.incoming), requests: list.filter(c => c.incoming) };
}

/** One chat: the person, the state, and messages (50 at a time, older with `before`). Marks them read. */
export async function thread(userId, id, { before = null } = {}) {
  await me(userId);
  const u = await other(userId, id);
  const blocked = await isBlocked(userId, id);
  const [person] = await cards(userId, [u]);
  const conv = await Conversation.findOne({ pair: pairOf(userId, id) });
  if (!conv) return { with: person, chat: null, messages: [], blocked, more: false };

  const cleared = conv.clearedAt?.get(String(userId));
  const when = {};
  if (cleared) when.$gt = cleared;
  if (before && !Number.isNaN(new Date(before).getTime())) when.$lt = new Date(before);
  const rows = await DirectMessage.find({ conv: conv._id, ...(Object.keys(when).length ? { createdAt: when } : {}) })
    .sort({ createdAt: -1 }).limit(51).lean();
  const more = rows.length > 50;
  const messages = rows.slice(0, 50).reverse();

  if ((conv.unread?.get(String(userId)) || 0) > 0 || messages.some(m => String(m.to) === String(userId) && !m.readAt)) {
    const now = new Date();
    await DirectMessage.updateMany({ conv: conv._id, to: userId, readAt: null }, { $set: { readAt: now } });
    conv.unread.set(String(userId), 0);
    await conv.save();
    socialHub.send(id, 'read', { by: String(userId), at: now });
  }
  return {
    with: person,
    chat: chatView(conv.toObject(), userId, person),
    messages: messages.map(m => messageView(m, userId)),
    blocked,
    more
  };
}

/**
 * Send one message. `body`: { text } or { photo: dataUrl }, or a voice file
 * ({ voice: { buffer, contentType, seconds } }) from the route.
 */
export async function send(userId, id, body = {}) {
  const sender = await me(userId);
  const u = await other(userId, id);
  if (await isBlocked(userId, id)) throw fail('Bu foydalanuvchiga xabar yuborib bo‘lmaydi', 403, 'blocked');
  if (!allowSend(userId)) throw fail('Juda tez yuboryapsiz — bir oz kuting', 429, 'slow_down');

  const friendsNow = await areFriends(userId, id);
  let conv = await Conversation.findOne({ pair: pairOf(userId, id) });
  let isNewRequest = false;
  if (!conv) {
    try {
      conv = await Conversation.create({
        pair: pairOf(userId, id), users: [userId, u._id],
        status: friendsNow ? 'open' : 'request', requester: userId
      });
      isNewRequest = conv.status === 'request';
    } catch (error) {
      if (error?.code !== 11000) throw error;
      conv = await Conversation.findOne({ pair: pairOf(userId, id) });
    }
  } else if (conv.status === 'request') {
    if (friendsNow || String(conv.requester) === String(id)) conv.status = 'open';   // replying accepts
    else throw fail('Xabaringiz hali qabul qilinmadi — javobni kuting', 409, 'waiting');
  }

  const kind = body.voice ? 'voice' : body.photo ? 'photo' : 'text';
  if (conv.status === 'request' && kind !== 'text') {
    if (isNewRequest) await conv.deleteOne();
    throw fail('Birinchi xabar matn bo‘lsin — rasm va ovozli xabar suhbat qabul qilingandan keyin', 409, 'text_first');
  }

  const doc = { conv: conv._id, from: userId, to: u._id, kind };
  try {
    if (kind === 'text') {
      const checked = cleanMessage(body.text);
      if (!checked.ok) {
        throw fail(checked.reason === 'english' ? 'Please write in English 🙂 — bu yer ingliz tili amaliyoti uchun.' : 'Xabar bo‘sh', 400, checked.reason);
      }
      doc.text = checked.text;
      if (checked.changed) doc.original = String(body.text).slice(0, 1000);
    } else if (kind === 'photo') {
      const photo = readPhoto(body.photo);
      doc.photo = { key: await mediaStorage.store(photo, { owner: userId, purpose: 'dm' }), type: photo.contentType };
      if (body.text) {
        const checked = cleanMessage(body.text);
        if (checked.ok) doc.text = checked.text;
      }
    } else {
      const seconds = Math.round(Number(body.voice.seconds) || 0);
      if (seconds < 1) throw fail('Juda qisqa — tugmani bosib, gapiring', 400, 'too_short');
      const { audioKey } = await AudioStorageService.store(body.voice.buffer, {
        filename: `dm-voice.${/mp4|m4a|aac/.test(body.voice.contentType) ? 'm4a' : 'webm'}`,
        contentType: body.voice.contentType, studentId: userId, resultId: 'dm', taskNumber: 0
      });
      doc.audioKey = audioKey;
      doc.seconds = Math.min(seconds, isPremium(sender) ? PREMIUM_VOICE_SECONDS : VOICE_MAX_SECONDS);
    }
  } catch (error) {
    if (isNewRequest) await conv.deleteOne().catch(() => {});
    throw error;
  }

  const m = await DirectMessage.create(doc);
  conv.last = { from: userId, kind, text: lastText(m).slice(0, 120) };
  conv.lastAt = m.createdAt;
  conv.unread.set(String(u._id), (conv.unread.get(String(u._id)) || 0) + 1);
  await conv.save();

  const [toMe, toThem] = [messageView(m, userId), messageView(m, u._id)];
  const senderCard = card(sender);
  socialHub.send(u._id, 'message', { with: String(userId), person: senderCard, message: toThem, status: conv.status, incoming: conv.status === 'request' });
  socialHub.send(userId, 'message', { with: String(u._id), message: toMe, status: conv.status, incoming: false });
  // The phone: a notification and the red number on the app icon.
  notifySoon(u._id, {
    title: senderCard.name,
    body: conv.status === 'request' ? `💬 Suhbat so‘rovi: ${lastText(m)}` : lastText(m),
    url: `/?open=dm&id=${userId}`, kind: 'dm', from: String(userId)
  });
  return { message: toMe, status: conv.status };
}

export async function acceptChat(userId, id) {
  const conv = await Conversation.findOne({ pair: pairOf(userId, id), status: 'request', requester: id });
  if (!conv) throw fail('So‘rov topilmadi', 404);
  conv.status = 'open';
  await conv.save();
  socialHub.send(id, 'chat', { kind: 'accepted', from: String(userId) });
  return true;
}

async function deleteConversation(conv) {
  const msgs = await DirectMessage.find({ conv: conv._id }).select('kind photo audioKey').lean();
  for (const m of msgs) {
    if (m.photo?.key) await mediaStorage.delete(m.photo.key, m.photo.type);
    if (m.audioKey) await AudioStorageService.delete(m.audioKey);
  }
  await DirectMessage.deleteMany({ conv: conv._id });
  await conv.deleteOne();
}

/** "O'chirish" on a request waiting for me: it is gone for both. */
export async function declineChat(userId, id) {
  const conv = await Conversation.findOne({ pair: pairOf(userId, id), status: 'request', requester: id });
  if (!conv) throw fail('So‘rov topilmadi', 404);
  await deleteConversation(conv);
  return true;
}

/** "Suhbatni o'chirish": the chat disappears from MY list and history; the other person keeps theirs. */
export async function clearChat(userId, id) {
  const conv = await Conversation.findOne({ pair: pairOf(userId, id) });
  if (!conv) return true;
  conv.clearedAt.set(String(userId), new Date());
  conv.unread.set(String(userId), 0);
  await conv.save();
  return true;
}

/** A message's photo or voice, for the two people in the chat (or the teacher). */
export async function messageMedia(userId, messageId, { admin = false } = {}) {
  if (!isId(messageId)) return null;
  const m = await DirectMessage.findById(messageId).lean();
  if (!m || (m.removed && !admin)) return null;
  if (!admin && String(m.from) !== String(userId) && String(m.to) !== String(userId)) return null;
  return m;
}

// ------------------------------------------------------------- posts & stories

export function postView(p, userId, person = null) {
  return {
    id: String(p._id),
    kind: p.kind,
    user: person,
    mine: String(p.user) === String(userId),
    text: p.text || '',
    photo: p.photo?.key ? `/api/social/photo/p/${p._id}` : null,
    likes: (p.likes || []).length,
    liked: (p.likes || []).some(x => String(x) === String(userId)),
    at: p.createdAt,
    expiresAt: p.expiresAt || null,
    comments: p.kind === 'post' ? (p.commentCount ?? 0) : null,
    latestComments: p.latestComments || []
  };
}

export function commentView(c, userId, person, postOwner) {
  return {
    id: String(c._id),
    user: person,
    text: c.removed ? '' : c.text,
    removed: Boolean(c.removed),
    mine: String(c.user) === String(userId),
    // the writer, and the owner of the post, may delete it
    canDelete: String(c.user) === String(userId) || String(postOwner) === String(userId),
    at: c.createdAt
  };
}

/** Each post's comment count and its latest few comments, as the viewer may see them. */
async function withComments(posts, userId) {
  const ids = posts.filter(p => p.kind === 'post').map(p => p._id);
  if (!ids.length) return posts;
  const hidden = await blockedSet(userId);
  const all = await SocialComment.find({ post: { $in: ids }, removed: false, user: { $nin: [...hidden].map(oid) } })
    .sort({ createdAt: 1 }).select('post user text createdAt').lean();
  const byPost = new Map();
  for (const c of all) {
    const k = String(c.post);
    if (!byPost.has(k)) byPost.set(k, []);
    byPost.get(k).push(c);
  }
  const latest = [...byPost.values()].flatMap(list => list.slice(-COMMENT_PREVIEW));
  const users = await User.find({ _id: { $in: [...new Set(latest.map(c => String(c.user)))] } }).select(USER_FIELDS).lean();
  const people = new Map(users.map(u => [String(u._id), card(u)]));
  return posts.map(p => {
    const list = byPost.get(String(p._id)) || [];
    return {
      ...p,
      commentCount: list.length,
      latestComments: list.slice(-COMMENT_PREVIEW).map(c => commentView(c, userId, people.get(String(c.user)), p.user)).filter(c => c.user)
    };
  });
}

/** All comments of one post, oldest first (the post's owner and their friends only). */
export async function comments(userId, postId) {
  await me(userId);
  if (!isId(postId)) throw fail('Topilmadi', 404);
  const post = await SocialPost.findById(postId).lean();
  if (!post || post.kind !== 'post' || !(await canSee(userId, post))) throw fail('Topilmadi', 404);
  const hidden = await blockedSet(userId);
  const list = await SocialComment.find({ post: post._id, removed: false, user: { $nin: [...hidden].map(oid) } })
    .sort({ createdAt: 1 }).limit(300).lean();
  const users = await User.find({ _id: { $in: [...new Set(list.map(c => String(c.user)))] } }).select(USER_FIELDS).lean();
  const people = new Map(users.map(u => [String(u._id), card(u)]));
  return list.map(c => commentView(c, userId, people.get(String(c.user)), post.user)).filter(c => c.user);
}

/** Write a comment: only on a post the writer may see — their own, or a friend's. */
export async function addComment(userId, postId, text) {
  const writer = await me(userId);
  if (!isId(postId)) throw fail('Topilmadi', 404);
  const post = await SocialPost.findById(postId).lean();
  if (!post || post.kind !== 'post' || !(await canSee(userId, post))) throw fail('Faqat do‘stlar izoh yoza oladi', 403, 'friends_only');
  const recent = await SocialComment.countDocuments({ user: userId, createdAt: { $gt: new Date(Date.now() - 3600e3) } });
  if (recent >= LIMITS.commentsPerHour) throw fail('Juda ko‘p izoh — biroz dam oling 🙂', 429);
  const checked = cleanMessage(String(text || '').slice(0, 300));
  if (!checked.ok) throw fail(checked.reason === 'english' ? 'Please write in English 🙂' : 'Izoh yozing', 400, checked.reason);
  const c = await SocialComment.create({
    post: post._id, user: userId, text: checked.text.slice(0, 300),
    ...(checked.changed ? { original: String(text).slice(0, 600) } : {})
  });
  const view = commentView(c.toObject(), userId, card(writer), post.user);
  if (String(post.user) !== String(userId)) {
    socialHub.send(post.user, 'comment', { post: String(post._id), from: String(userId), name: view.user.name });
  }
  return view;
}

export async function deleteComment(userId, id, { admin = false } = {}) {
  if (!isId(id)) throw fail('Topilmadi', 404);
  const c = await SocialComment.findById(id);
  if (!c) throw fail('Topilmadi', 404);
  const post = await SocialPost.findById(c.post).select('user').lean();
  const allowed = admin || String(c.user) === String(userId) || String(post?.user) === String(userId);
  if (!allowed) throw fail('Topilmadi', 404);
  await c.deleteOne();
  return true;
}

export async function createPost(userId, { kind = 'post', text = '', photo = null } = {}) {
  const writer = await me(userId);
  const k = kind === 'story' ? 'story' : 'post';
  const since = new Date(Date.now() - 864e5);
  const today = await SocialPost.countDocuments({ user: userId, kind: k, createdAt: { $gt: since } });
  const premium = isPremium(writer);
  const cap = (premium ? PREMIUM_LIMITS : LIMITS)[k === 'story' ? 'storiesPerDay' : 'postsPerDay'];
  if (today >= cap) {
    throw fail(premium ? 'Bugungi chegara tugadi — ertaga davom eting'
      : `Bugun ${cap} ta ${k === 'story' ? 'hikoya' : 'post'} joyladingiz. Premium bilan cheklovsiz 👑`, 429, 'limit');
  }
  if (k === 'story' && !photo) throw fail('Hikoya uchun rasm tanlang');
  let caption = '';
  if (String(text || '').trim()) {
    const checked = cleanMessage(text);
    if (!checked.ok) throw fail(checked.reason === 'english' ? 'Please write in English 🙂' : 'Matnni tekshiring');
    caption = checked.text;
  }
  if (!caption && !photo) throw fail('Rasm tanlang yoki biror narsa yozing');
  const doc = { user: userId, kind: k, text: caption };
  if (photo) {
    const p = readPhoto(photo);
    doc.photo = { key: await mediaStorage.store(p, { owner: userId, purpose: k }), type: p.contentType };
  }
  if (k === 'story') doc.expiresAt = new Date(Date.now() + STORY_HOURS * 3600e3);
  const post = await SocialPost.create(doc);
  return postView(post.toObject(), userId, card(await me(userId)));
}

export async function deletePost(userId, id, { admin = false } = {}) {
  if (!isId(id)) throw fail('Topilmadi', 404);
  const post = await SocialPost.findById(id);
  if (!post || (!admin && String(post.user) !== String(userId))) throw fail('Topilmadi', 404);
  if (post.photo?.key) await mediaStorage.delete(post.photo.key, post.photo.type);
  await SocialComment.deleteMany({ post: post._id });
  await post.deleteOne();
  return true;
}

/** May this person see this post? Its owner, their friends (not blocked), or the teacher. */
async function canSee(userId, post, { admin = false } = {}) {
  if (!post || (post.removed && !admin)) return false;
  if (admin || String(post.user) === String(userId)) return true;
  if (post.kind === 'story' && post.expiresAt && post.expiresAt < new Date()) return false;
  return (await areFriends(userId, post.user)) && !(await isBlocked(userId, post.user));
}

export async function toggleLike(userId, id) {
  if (!isId(id)) throw fail('Topilmadi', 404);
  const post = await SocialPost.findById(id);
  if (!(await canSee(userId, post))) throw fail('Topilmadi', 404);
  const liked = post.likes.some(x => String(x) === String(userId));
  await SocialPost.updateOne({ _id: id }, liked ? { $pull: { likes: oid(userId) } } : { $addToSet: { likes: oid(userId) } });
  return { liked: !liked, likes: post.likes.length + (liked ? -1 : 1) };
}

export async function postMedia(userId, id, { admin = false } = {}) {
  if (!isId(id)) return null;
  const post = await SocialPost.findById(id).lean();
  return (await canSee(userId, post, { admin })) ? post : null;
}

async function friendIds(userId) {
  const rows = await Friendship.find({ users: userId, status: 'friends' }).select('users').lean();
  const hidden = await blockedSet(userId);
  return rows.map(f => f.users.map(String).find(x => x !== String(userId))).filter(id => !hidden.has(id));
}

/** Lenta: my friends' posts and mine, newest first, 20 at a time. */
export async function feed(userId, { before = null } = {}) {
  await me(userId);
  const ids = [String(userId), ...(await friendIds(userId))];
  const when = before && !Number.isNaN(new Date(before).getTime()) ? { createdAt: { $lt: new Date(before) } } : {};
  const rows = await SocialPost.find({ user: { $in: ids.map(oid) }, kind: 'post', removed: false, ...when })
    .sort({ createdAt: -1 }).limit(21).lean();
  const users = await User.find({ _id: { $in: [...new Set(rows.map(p => String(p.user)))] } }).select(USER_FIELDS).lean();
  const byId = new Map((await cards(userId, users)).map(p => [p.id, p]));
  const shown = await withComments(rows.slice(0, 20), userId);
  return { posts: shown.map(p => postView(p, userId, byId.get(String(p.user)))), more: rows.length > 20 };
}

/** Stories of the last 24 hours: mine first, then friends', each person's in the order they were added. */
export async function stories(userId) {
  await me(userId);
  const ids = [String(userId), ...(await friendIds(userId))];
  const rows = await SocialPost.find({ user: { $in: ids.map(oid) }, kind: 'story', removed: false, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: 1 }).lean();
  const users = await User.find({ _id: { $in: [...new Set(rows.map(p => String(p.user)))] } }).select(USER_FIELDS).lean();
  const byId = new Map((await cards(userId, users)).map(p => [p.id, p]));
  const groups = new Map();
  for (const p of rows) {
    const id = String(p.user);
    if (!groups.has(id)) groups.set(id, { user: byId.get(id), mine: id === String(userId), items: [] });
    groups.get(id).items.push(postView(p, userId, byId.get(id)));
  }
  return [...groups.values()]
    .filter(g => g.user)
    .sort((a, b) => Number(b.mine) - Number(a.mine) || new Date(b.items[b.items.length - 1].at) - new Date(a.items[a.items.length - 1].at));
}

/** Stories past their 24 hours: photo and document removed. */
export async function sweepStories(now = new Date()) {
  const old = await SocialPost.find({ kind: 'story', expiresAt: { $lt: now } }).select('photo').limit(500).lean();
  for (const p of old) if (p.photo?.key) await mediaStorage.delete(p.photo.key, p.photo.type);
  if (old.length) await SocialPost.deleteMany({ _id: { $in: old.map(p => p._id) } });
  return old.length;
}

let sweeper = null;
export function startStorySweep() {
  if (sweeper) return;
  const run = () => sweepStories().catch(error => console.error('Story sweep failed:', error.message));
  setTimeout(run, 60e3);
  sweeper = setInterval(run, 60 * 60e3);
  sweeper.unref?.();
}

// ------------------------------------------------------------- reports & counts

export async function report(userId, { kind, id, reason = '' } = {}) {
  if (!['user', 'post', 'message', 'comment'].includes(kind) || !isId(id)) throw fail('Nimani xabar qilyapsiz?');
  let targetUser = null;
  if (kind === 'user') targetUser = id;
  if (kind === 'post') {
    const p = await SocialPost.findById(id).select('user kind expiresAt removed').lean();
    if (!(await canSee(userId, p))) throw fail('Topilmadi', 404);
    targetUser = p.user;
  }
  if (kind === 'message') {
    const m = await messageMedia(userId, id);
    if (!m) throw fail('Topilmadi', 404);
    targetUser = m.from;
  }
  if (kind === 'comment') {
    const c = await SocialComment.findById(id).select('post user').lean();
    const p = c ? await SocialPost.findById(c.post).select('user kind expiresAt removed').lean() : null;
    if (!c || !(await canSee(userId, p))) throw fail('Topilmadi', 404);
    targetUser = c.user;
  }
  const open = await SocialReport.countDocuments({ by: userId, createdAt: { $gt: new Date(Date.now() - 864e5) } });
  if (open >= 20) throw fail('Bugun juda ko‘p shikoyat yubordingiz', 429);
  await SocialReport.create({ by: userId, kind, target: id, targetUser, reason: String(reason || '').trim().slice(0, 300) });
  return true;
}

export async function unread(userId) {
  const hidden = await blockedSet(userId);
  const convs = await Conversation.find({ users: userId }).select('users status requester unread').lean();
  let messages = 0;
  let requests = 0;
  for (const c of convs) {
    const otherId = c.users.map(String).find(x => x !== String(userId));
    if (hidden.has(otherId)) continue;
    const n = c.unread?.[String(userId)] || 0;
    if (c.status === 'request' && String(c.requester) === otherId) requests += 1;
    else messages += n;
  }
  const friendRequests = await Friendship.countDocuments({ users: userId, status: 'pending', requester: { $ne: oid(userId), $nin: [...hidden].map(oid) } });
  return { messages, requests, friendRequests, total: messages + requests + friendRequests };
}

// ------------------------------------------------------------- the teacher

export async function adminOverview() {
  const [reports, posts, counts] = await Promise.all([
    SocialReport.find().sort({ status: 1, createdAt: -1 }).limit(100).lean(),
    SocialPost.find({ removed: false }).sort({ createdAt: -1 }).limit(60).lean(),
    Promise.all([
      Friendship.countDocuments({ status: 'friends' }),
      Conversation.countDocuments({}),
      DirectMessage.countDocuments({ createdAt: { $gt: new Date(Date.now() - 864e5) } }),
      SocialPost.countDocuments({ kind: 'post', removed: false }),
      SocialPost.countDocuments({ kind: 'story', expiresAt: { $gt: new Date() } }),
      SocialComment.countDocuments({ createdAt: { $gt: new Date(Date.now() - 864e5) } })
    ])
  ]);
  const userIds = new Set();
  reports.forEach(r => { userIds.add(String(r.by)); if (r.targetUser) userIds.add(String(r.targetUser)); });
  const reportedComments = await SocialComment.find({ _id: { $in: reports.filter(r => r.kind === 'comment').map(r => r.target) } }).select('post').lean();
  const commentPosts = await SocialPost.find({ _id: { $in: reportedComments.map(c => c.post) } }).select('user').lean();
  commentPosts.forEach(p => userIds.add(String(p.user)));
  posts.forEach(p => userIds.add(String(p.user)));
  const users = await User.find({ _id: { $in: [...userIds] } }).select('email firstName lastName nickname access').lean();
  const who = id => {
    const u = users.find(x => String(x._id) === String(id));
    return u ? { id: String(u._id), name: nameOf(u), email: u.email, blocked: Boolean(u.access?.blocked) } : null;
  };

  const withContext = await Promise.all(reports.map(async r => {
    let context = null;
    if (r.kind === 'message') {
      const m = await DirectMessage.findById(r.target).select('+original').lean();
      if (m) {
        const around = await DirectMessage.find({ conv: m.conv, createdAt: { $gte: new Date(new Date(m.createdAt).getTime() - 30 * 60e3), $lte: new Date(new Date(m.createdAt).getTime() + 30 * 60e3) } })
          .select('+original').sort({ createdAt: 1 }).limit(12).lean();
        context = around.map(x => ({
          id: String(x._id), from: who(x.from)?.name || '?', reported: String(x._id) === String(m._id),
          kind: x.kind, text: x.text, original: x.original || '', removed: x.removed,
          photo: x.kind === 'photo' ? `/api/admin/social/photo/m/${x._id}` : null,
          audio: x.kind === 'voice' ? `/api/admin/social/voice/${x._id}` : null, at: x.createdAt
        }));
      }
    }
    if (r.kind === 'comment') {
      const cm = await SocialComment.findById(r.target).select('+original').lean();
      const p = cm ? await SocialPost.findById(cm.post).lean() : null;
      if (cm) {
        context = [
          ...(p ? [{ id: String(p._id), kind: 'post', from: who(p.user)?.name || '?', text: p.text, photo: p.photo?.key ? `/api/admin/social/photo/p/${p._id}` : null, at: p.createdAt }] : []),
          { id: String(cm._id), kind: 'comment', from: who(cm.user)?.name || '?', reported: true, text: cm.text, original: cm.original || '', removed: cm.removed, at: cm.createdAt }
        ];
      }
    }
    if (r.kind === 'post') {
      const p = await SocialPost.findById(r.target).lean();
      if (p) context = [{ id: String(p._id), kind: p.kind, text: p.text, removed: p.removed, photo: p.photo?.key ? `/api/admin/social/photo/p/${p._id}` : null, at: p.createdAt }];
    }
    return {
      id: String(r._id), kind: r.kind, target: String(r.target), reason: r.reason, status: r.status,
      by: who(r.by), about: who(r.targetUser), at: r.createdAt, context
    };
  }));

  return {
    counts: { friendships: counts[0], chats: counts[1], messagesToday: counts[2], posts: counts[3], stories: counts[4], commentsToday: counts[5] },
    open: reports.filter(r => r.status === 'open').length,
    reports: withContext,
    posts: posts.map(p => ({
      id: String(p._id), kind: p.kind, text: p.text, user: who(p.user), likes: (p.likes || []).length,
      photo: p.photo?.key ? `/api/admin/social/photo/p/${p._id}` : null, at: p.createdAt, expiresAt: p.expiresAt || null
    }))
  };
}

export async function adminHandleReport(id, { action, by }) {
  if (!isId(id)) throw fail('Report not found', 404);
  const r = await SocialReport.findById(id);
  if (!r) throw fail('Report not found', 404);
  if (action === 'remove') {
    if (r.kind === 'post') await SocialPost.updateOne({ _id: r.target }, { $set: { removed: true } });
    if (r.kind === 'message') await DirectMessage.updateOne({ _id: r.target }, { $set: { removed: true } });
    if (r.kind === 'comment') await SocialComment.updateOne({ _id: r.target }, { $set: { removed: true } });
  }
  r.status = 'done';
  r.handledBy = by;
  r.handledAt = new Date();
  await r.save();
  return true;
}

export async function openReports() {
  return SocialReport.countDocuments({ status: 'open' });
}

export default {
  people, friendRequests, friends, profile, updateMyProfile, touch,
  requestFriend, acceptFriend, removeFriend, block, unblock, blockedList,
  chats, thread, send, acceptChat, declineChat, clearChat, messageMedia,
  createPost, deletePost, toggleLike, postMedia, feed, stories, sweepStories, startStorySweep,
  comments, addComment, deleteComment, commentView,
  report, unread, adminOverview, adminHandleReport, openReports, areFriends, allowSend, card
};
