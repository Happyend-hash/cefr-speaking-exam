import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import User from '../models/User.js';
import ExamResult from '../models/ExamResult.js';
import ChatMessage from '../models/ChatMessage.js';
import ChatRoom from '../models/ChatRoom.js';
import {
  chatHub, publicMessage, CHAT_RETENTION_DAYS, VOICE_MAX_SECONDS, VOICE_MAX_BYTES,
  loadOpenRooms, cleanRoomText, cannotOpen, openRoom, closeRoom, removeFromRoom
} from '../services/ChatRooms.js';
import { TEXT_ROOMS, isTextRoom, isCommunityId, ROOM_SEATS } from '../services/ChatHub.js';
import AudioStorageService from '../services/AudioStorageService.js';
import { voiceHub } from '../services/VoiceRooms.js';
import { taboo } from '../services/GameRooms.js';
import { cleanMessage, allowMessage, MAX_LENGTH } from '../services/ChatFilter.js';
import { fallbackName } from '../services/Leaderboard.js';
import { badgeOf, BADGE_FIELDS } from '../services/Premium.js';
import { APIError } from '../middleware/errorHandler.js';

/**
 * Text chat: the General / B1 / B2 / C1 rooms, community rooms that Premium
 * students open (10 seats), and messages typed inside a speaking call.
 *
 * Every typed message goes through ChatFilter before it is stored or shown to
 * anyone, and every message — typed or a voice message — is stored so the
 * teacher can read or play it and act on a report.
 */

const router = express.Router();

const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VOICE_MAX_BYTES, files: 1 }
});

// Community rooms open before a restart come back on the first request.
router.use((req, res, next) => { loadOpenRooms().then(() => next(), () => next()); });
const isValidId = id => mongoose.Types.ObjectId.isValid(id);
const isStaff = user => user?.role === 'admin' || user?.role === 'teacher';

async function chatIdentity(userId) {
  const user = await User.findById(userId).select(`firstName lastName nickname access ${BADGE_FIELDS}`);
  if (!user) throw new APIError('User not found', 404);
  if (user.access?.blocked && !isStaff(user)) {
    throw new APIError('Your teacher has paused your access.', 403, 'blocked');
  }
  const latest = await ExamResult.findOne({ student: userId, status: 'completed', overallLevel: { $exists: true } })
    .sort({ completedAt: -1 }).select('overallLevel').lean();
  return {
    user,
    identity: {
      id: String(user._id),
      name: user.nickname || fallbackName(user),
      level: /^(B1|B2|C1)$/.test(latest?.overallLevel || '') ? latest.overallLevel : null,
      staff: isStaff(user),
      ...badgeOf(user)
    }
  };
}

const roomName = room => chatHub.community.get(room)?.name;

/**
 * May this student post in this room? The fixed rooms are open to everyone;
 * a community room only to the people sitting in it.
 */
function assertCanPost(identity, room) {
  if (isTextRoom(room)) return;
  if (!chatHub.community.has(room)) throw new APIError('Bu xona yopilgan.', 404, 'closed');
  if (!chatHub.isIn(identity.id, room)) throw new APIError('Avval xonaga kiring.', 409, 'not_in_room');
}

/** Filter, rate-limit and store one message. Throws with a student-facing reason. */
async function storeMessage(identity, room, raw) {
  if (!allowMessage(identity.id)) {
    throw new APIError('Juda tez yozyapsiz — bir oz kuting.', 429, 'slow_down');
  }
  const cleaned = cleanMessage(raw);
  if (!cleaned.ok) {
    throw new APIError(cleaned.message || 'Message is empty.', 400, cleaned.reason);
  }
  const message = await ChatMessage.create({
    room,
    roomName: roomName(room),
    user: identity.id,
    name: identity.name,
    level: identity.level,
    premium: identity.premium,
    avatar: identity.avatar,
    text: cleaned.text,
    filtered: cleaned.changed,
    original: cleaned.changed ? String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH) : undefined
  });
  return publicMessage(message);
}

// ------------------------------------------------------------ text rooms

router.get('/rooms', (req, res) => {
  res.json({ success: true, data: { ...chatHub.summary(), seats: ROOM_SEATS, retentionDays: CHAT_RETENTION_DAYS } });
});

router.get('/stream', async (req, res, next) => {
  try {
    const { identity } = await chatIdentity(req.user.id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    chatHub.connect(identity, res);
    // Whether this student may open a room: the screen shows the button or the Premium offer.
    chatHub.send(identity.id, 'me', { premium: identity.premium, staff: identity.staff, canOpen: identity.premium || identity.staff });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      chatHub.disconnect(identity.id, res);
    });
  } catch (error) {
    next(error);
  }
});

const JOIN_REFUSED = {
  full: ["Xona to'la — 10 ta joy band.", 409],
  kicked: ['Xona egasi sizni bu xonadan chiqargan.', 403],
  'no such room': ['Bu xona yopilgan.', 404],
  'not connected': ['Ulanmoqda… bir soniyadan keyin qayta urinib ko\'ring.', 409]
};

/** Open a room: take a seat (community rooms), start receiving it, and get its last 60 messages. */
router.post('/join', async (req, res, next) => {
  try {
    const room = String(req.body?.room || '');
    if (!chatHub.isRoom(room)) throw new APIError('Bu xona yopilgan.', 404, 'closed');
    const outcome = chatHub.join(req.user.id, room);
    if (!outcome.ok) {
      const [message, status] = JOIN_REFUSED[outcome.reason] || [outcome.reason, 409];
      throw new APIError(message, status, outcome.reason);
    }
    const messages = await ChatMessage.find({ room }).sort({ createdAt: -1 }).limit(60).lean();
    const community = chatHub.community.get(room);
    res.json({
      success: true,
      data: {
        room,
        info: community ? chatHub.communityView(community) : TEXT_ROOMS.find(r => r.id === room),
        messages: messages.reverse().map(publicMessage)
      }
    });
  } catch (error) {
    next(error);
  }
});

/** Back to the list: the seat is free again. */
router.post('/leave', (req, res) => {
  chatHub.leave(req.user.id);
  res.json({ success: true });
});

router.post('/send', async (req, res, next) => {
  try {
    const room = String(req.body?.room || '');
    if (!chatHub.isRoom(room)) throw new APIError('Bu xona yopilgan.', 404, 'closed');
    const { identity } = await chatIdentity(req.user.id);
    assertCanPost(identity, room);
    const message = await storeMessage(identity, room, req.body?.text);
    chatHub.deliver(room, message);
    res.status(201).json({ success: true, data: message });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------- voice messages

/**
 * A voice message: recorded in the browser (up to a minute), stored with the
 * exam recordings, delivered like a typed message. Nothing listens to it
 * automatically — students report, the teacher plays it.
 */
router.post('/voice', voiceUpload.single('audio'), async (req, res, next) => {
  try {
    const room = String(req.body?.room || '');
    if (!chatHub.isRoom(room)) throw new APIError('Bu xona yopilgan.', 404, 'closed');
    const { identity } = await chatIdentity(req.user.id);
    assertCanPost(identity, room);
    const file = req.file;
    if (!file?.buffer?.length) throw new APIError("Ovoz yozilmadi — qayta urinib ko'ring.", 400, 'empty');
    const type = String(file.mimetype || '').split(';')[0];
    if (!/^audio\/(webm|ogg|mp4|mpeg|aac|x-m4a)$/.test(type)) throw new APIError('Bu ovoz formati qabul qilinmaydi.', 400, 'format');
    const seconds = Math.round(Number(req.body?.seconds) || 0);
    if (seconds < 1) throw new APIError("Juda qisqa — tugmani bosib, gapiring.", 400, 'too_short');
    if (!allowMessage(identity.id)) throw new APIError('Juda tez yuboryapsiz — bir oz kuting.', 429, 'slow_down');

    const { audioKey } = await AudioStorageService.store(file.buffer, {
      filename: `chat-voice.${type.includes('mp4') || type.includes('m4a') || type.includes('aac') ? 'm4a' : 'webm'}`,
      contentType: type,
      studentId: identity.id,
      resultId: 'chat',
      taskNumber: 0
    });
    const message = publicMessage(await ChatMessage.create({
      room,
      roomName: roomName(room),
      user: identity.id,
      name: identity.name,
      level: identity.level,
      premium: identity.premium,
      avatar: identity.avatar,
      kind: 'voice',
      text: '',
      audioKey,
      seconds: Math.min(seconds, VOICE_MAX_SECONDS)
    }));
    chatHub.deliver(room, message);
    res.status(201).json({ success: true, data: message });
  } catch (error) {
    if (error?.code === 'LIMIT_FILE_SIZE') return next(new APIError('Ovozli xabar juda uzun — 1 daqiqagacha.', 413, 'too_long'));
    next(error);
  }
});

/** Play a voice message. Anyone signed in may (they are in open rooms); a deleted one only the teacher. */
router.get('/voice/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid message', 400);
    const message = await ChatMessage.findById(req.params.id).select('kind audioKey deletedAt').lean();
    if (!message || message.kind !== 'voice' || !message.audioKey) throw new APIError('Not found', 404);
    if (message.deletedAt && !isStaff(req.user)) throw new APIError('Not found', 404);
    const meta = await AudioStorageService.getMetadata(message.audioKey);
    if (!meta) throw new APIError('Recording unavailable', 404);
    res.setHeader('Content-Type', meta.contentType || 'audio/webm');
    if (meta.length) res.setHeader('Content-Length', String(meta.length));
    res.setHeader('Cache-Control', 'private, max-age=86400');
    AudioStorageService.openDownloadStream(message.audioKey)
      .on('error', error => next(new APIError(`Recording unavailable: ${error.message}`, 404)))
      .pipe(res);
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------- community rooms

/** Open a community room — Premium students (and teachers) only. */
router.post('/rooms', async (req, res, next) => {
  try {
    const { identity } = await chatIdentity(req.user.id);
    const refused = cannotOpen(identity);
    if (refused) throw new APIError(refused.message, refused.status, refused.code);
    const name = cleanRoomText(req.body?.name, { field: 'Xona nomi', min: 3, max: 40, required: true });
    if (!name.ok) throw new APIError(name.message, 400, 'name');
    const topic = cleanRoomText(req.body?.topic, { field: 'Mavzu', min: 3, max: 120, required: false });
    if (!topic.ok) throw new APIError(topic.message, 400, 'topic');
    const room = await openRoom(identity, { name: name.text, topic: topic.text, level: req.body?.level });
    res.status(201).json({ success: true, data: chatHub.communityView(room) });
  } catch (error) {
    next(error);
  }
});

/** May this user run this community room? Its host, or a teacher. */
function assertHost(req, roomId) {
  const room = chatHub.community.get(roomId);
  if (!room) throw new APIError('Bu xona yopilgan.', 404, 'closed');
  if (room.host.id !== String(req.user.id) && !isStaff(req.user)) throw new APIError('Faqat xona egasi.', 403);
  return room;
}

router.post('/rooms/:id/close', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    assertHost(req, id);
    await closeRoom(id, isStaff(req.user) ? (req.user.email || 'teacher') : 'host', isStaff(req.user) ? 'teacher' : 'host');
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/rooms/:id/remove', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const room = assertHost(req, id);
    const userId = String(req.body?.userId || '');
    if (!isValidId(userId)) throw new APIError('Invalid student', 400);
    if (userId === room.host.id) throw new APIError("Xona egasini chiqarib bo'lmaydi.", 400);
    await removeFromRoom(id, userId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------- chat in a call

/**
 * Typed inside a speaking call: delivered over the call's own stream to the
 * people in that call, and stored under 'voice:<roomId>'.
 */
router.post('/call', async (req, res, next) => {
  try {
    const { identity } = await chatIdentity(req.user.id);
    const room = voiceHub.roomOf(identity.id);
    if (!room) throw new APIError('You are not in a call.', 409);
    // Playing Taboo: the one describing may not type the answer or a forbidden word.
    if (taboo.describerLeaks(identity.id, req.body?.text)) {
      throw new APIError("Taboo! Bu so'zni yozish mumkin emas — tushuntirib bering.", 400, 'taboo');
    }
    const message = await storeMessage(identity, `voice:${room.id}`, req.body?.text);
    voiceHub.roomChat(identity.id, message);
    // …and everyone else's messages are guesses.
    taboo.guess(identity.id, message.text);
    res.status(201).json({ success: true, data: message });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------- report

router.post('/report', async (req, res, next) => {
  try {
    const id = String(req.body?.messageId || '');
    if (!isValidId(id)) throw new APIError('Invalid message', 400);
    const message = await ChatMessage.findById(id);
    if (!message) throw new APIError('Message not found', 404);
    if (String(message.user) === String(req.user.id)) throw new APIError('That is your own message.', 400);
    const me = await User.findById(req.user.id).select('firstName lastName nickname');
    await ChatMessage.updateOne(
      { _id: message._id },
      {
        $set: { reported: true },
        $push: {
          reports: {
            by: req.user.id,
            byName: me?.nickname || fallbackName(me),
            reason: String(req.body?.reason || '').trim().slice(0, 300),
            at: new Date()
          }
        }
      }
    );
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// --------------------------------------------------------------- teacher

const staffOnly = (req, res, next) =>
  isStaff(req.user) ? next() : next(new APIError('Teachers only', 403));

router.get('/admin/messages', staffOnly, async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.reported === '1') filter.reported = true;
    if (req.query.room) filter.room = String(req.query.room);
    const messages = await ChatMessage.find(filter).sort({ createdAt: -1 }).limit(150).lean();
    const emails = new Map(
      (await User.find({ _id: { $in: [...new Set(messages.map(m => String(m.user)))] } }).select('email').lean())
        .map(u => [String(u._id), u.email])
    );
    res.json({
      success: true,
      data: {
        rooms: TEXT_ROOMS,
        community: chatHub.summary().community,
        retentionDays: CHAT_RETENTION_DAYS,
        messages: messages.map(m => ({
          ...publicMessage(m),
          // The teacher sees what was removed, and who wrote it.
          text: m.text,
          roomName: m.roomName || '',
          // The teacher can still play a deleted voice message.
          audio: m.kind === 'voice' ? `/api/chat/voice/${m._id}` : undefined,
          original: m.original || '',
          email: emails.get(String(m.user)) || '',
          filtered: Boolean(m.filtered),
          deletedBy: m.deletedBy || null,
          reports: m.reports || [],
          reported: Boolean(m.reported)
        }))
      }
    });
  } catch (error) {
    next(error);
  }
});

/** Remove a message from every screen. Kept as a stub for the retention period. */
router.delete('/admin/messages/:id', staffOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid message', 400);
    const message = await ChatMessage.findById(req.params.id);
    if (!message) throw new APIError('Message not found', 404);
    await ChatMessage.updateOne(
      { _id: message._id },
      { $set: { deletedAt: new Date(), deletedBy: req.user.email || String(req.user.id) } }
    );
    if (isTextRoom(message.room) || isCommunityId(message.room)) chatHub.retract(message.room, message._id);
    else if (message.room.startsWith('voice:')) {
      const room = voiceHub.rooms.get(message.room.slice(6));
      for (const id of room?.members || []) voiceHub.send(id, 'chat-deleted', { id: String(message._id) });
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
