import express from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import ExamResult from '../models/ExamResult.js';
import ChatMessage from '../models/ChatMessage.js';
import { chatHub, publicMessage, CHAT_RETENTION_DAYS } from '../services/ChatRooms.js';
import { TEXT_ROOMS, isTextRoom } from '../services/ChatHub.js';
import { voiceHub } from '../services/VoiceRooms.js';
import { cleanMessage, allowMessage, MAX_LENGTH } from '../services/ChatFilter.js';
import { fallbackName } from '../services/Leaderboard.js';
import { APIError } from '../middleware/errorHandler.js';

/**
 * Text chat: the General / B1 / B2 / C1 rooms, and messages typed inside a
 * speaking call.
 *
 * Every message goes through ChatFilter before it is stored or shown to
 * anyone, and is stored so the teacher can read it and act on a report.
 */

const router = express.Router();
const isValidId = id => mongoose.Types.ObjectId.isValid(id);
const isStaff = user => user?.role === 'admin' || user?.role === 'teacher';

async function chatIdentity(userId) {
  const user = await User.findById(userId).select('firstName lastName nickname role access');
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
      staff: isStaff(user)
    }
  };
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
    user: identity.id,
    name: identity.name,
    level: identity.level,
    text: cleaned.text,
    filtered: cleaned.changed,
    original: cleaned.changed ? String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH) : undefined
  });
  return publicMessage(message);
}

// ------------------------------------------------------------ text rooms

router.get('/rooms', (req, res) => {
  res.json({ success: true, data: { rooms: chatHub.summary(), retentionDays: CHAT_RETENTION_DAYS } });
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
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      chatHub.disconnect(identity.id, res);
    });
  } catch (error) {
    next(error);
  }
});

/** Open a room: start receiving it, and get its last 60 messages. */
router.post('/join', async (req, res, next) => {
  try {
    const room = String(req.body?.room || '');
    if (!isTextRoom(room)) throw new APIError('No such room', 404);
    const outcome = chatHub.join(req.user.id, room);
    if (!outcome.ok) throw new APIError(outcome.reason, 409);
    const messages = await ChatMessage.find({ room }).sort({ createdAt: -1 }).limit(60).lean();
    res.json({ success: true, data: { room, messages: messages.reverse().map(publicMessage) } });
  } catch (error) {
    next(error);
  }
});

router.post('/send', async (req, res, next) => {
  try {
    const room = String(req.body?.room || '');
    if (!isTextRoom(room)) throw new APIError('No such room', 404);
    const { identity } = await chatIdentity(req.user.id);
    const message = await storeMessage(identity, room, req.body?.text);
    chatHub.deliver(room, message);
    res.status(201).json({ success: true, data: message });
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
    const message = await storeMessage(identity, `voice:${room.id}`, req.body?.text);
    voiceHub.roomChat(identity.id, message);
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
        retentionDays: CHAT_RETENTION_DAYS,
        messages: messages.map(m => ({
          ...publicMessage(m),
          // The teacher sees what was removed, and who wrote it.
          text: m.text,
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
    if (isTextRoom(message.room)) chatHub.retract(message.room, message._id);
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
