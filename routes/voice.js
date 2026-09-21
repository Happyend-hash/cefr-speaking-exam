import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import User from '../models/User.js';
import ExamResult from '../models/ExamResult.js';
import VoiceSession from '../models/VoiceSession.js';
import AudioStorageService, { MAX_AUDIO_BYTES } from '../services/AudioStorageService.js';
import { voiceHub, iceServers, relayConfigured, RETENTION_DAYS } from '../services/VoiceRooms.js';
import { fallbackName } from '../services/Leaderboard.js';
import { APIError } from '../middleware/errorHandler.js';

/**
 * Speaking rooms over HTTP.
 *
 * The browser keeps one long-lived response open (GET /stream) and receives
 * everything through it — matches, who joined, connection messages. It talks
 * back with short POSTs. No extra package is needed for this, and it passes
 * through Railway's proxy like any other request.
 *
 * The stream is opened with fetch() rather than EventSource, because
 * EventSource cannot send the Authorization header and a token must never go
 * in a URL.
 */

const router = express.Router();

const isValidId = id => mongoose.Types.ObjectId.isValid(id);
const isStaff = user => user?.role === 'admin' || user?.role === 'teacher';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES }
});

/** Who this student is in the rooms: nickname, and level for pairing. */
async function roomIdentity(userId) {
  const user = await User.findById(userId).select('firstName lastName nickname role access voiceConsentAt');
  if (!user) throw new APIError('User not found', 404);

  const latest = await ExamResult.findOne({
    student: userId,
    status: 'completed',
    overallLevel: { $exists: true }
  })
    .sort({ completedAt: -1 })
    .select('overallLevel')
    .lean();

  return {
    user,
    identity: {
      id: String(user._id),
      name: user.nickname || fallbackName(user),
      level: latest?.overallLevel && /^(B1|B2|C1)$/.test(latest.overallLevel) ? latest.overallLevel : null,
      staff: isStaff(user)
    }
  };
}

function refuseIfBlocked(user) {
  if (user.access?.blocked && !isStaff(user)) {
    throw new APIError('Your teacher has paused your access.', 403, 'blocked');
  }
}

// ------------------------------------------------------------- consent

router.get('/status', async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('voiceConsentAt access role');
    res.json({
      success: true,
      data: {
        consented: Boolean(user?.voiceConsentAt),
        blocked: Boolean(user?.access?.blocked) && !isStaff(user),
        retentionDays: RETENTION_DAYS,
        relay: relayConfigured()
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/consent', async (req, res, next) => {
  try {
    await User.updateOne({ _id: req.user.id }, { $set: { voiceConsentAt: new Date() } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------- stream

router.get('/stream', async (req, res, next) => {
  try {
    const { user, identity } = await roomIdentity(req.user.id);
    refuseIfBlocked(user);
    if (!user.voiceConsentAt) {
      throw new APIError('Agree to call recording before joining.', 428, 'consent');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Some proxies hold small responses back; this asks them not to.
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    res.write(`event: config\ndata: ${JSON.stringify({ iceServers: iceServers(), retentionDays: RETENTION_DAYS })}\n\n`);

    voiceHub.connect(identity, res);

    // Idle connections are closed by proxies; a comment every 15s keeps it open.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      voiceHub.disconnect(identity.id, res);
    });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------- actions

const act = handler => async (req, res, next) => {
  try {
    const outcome = await handler(req);
    if (outcome && outcome.ok === false) throw new APIError(outcome.reason, 409, 'voice');
    res.json({ success: true, data: outcome || {} });
  } catch (error) {
    next(error);
  }
};

router.post('/partner', act(req => voiceHub.findPartner(req.user.id)));
router.delete('/partner', act(req => { voiceHub.cancelQueue(req.user.id); return { ok: true }; }));
router.post('/join', act(req => voiceHub.join(req.user.id, String(req.body?.roomId || ''))));
router.post('/leave', act(req => { voiceHub.leave(req.user.id); return { ok: true }; }));
router.post('/topic', act(req => voiceHub.nextTopic(req.user.id)));

/**
 * A connection message for one other person in the same room. The hub refuses
 * anyone else, so this cannot be used to reach a student one was not paired
 * with. Size-limited: these are a few kilobytes at most.
 */
router.post('/signal', act(req => {
  const payload = req.body?.payload;
  if (!payload || JSON.stringify(payload).length > 20000) return { ok: false, reason: 'bad signal' };
  return voiceHub.relay(req.user.id, String(req.body?.to || ''), payload);
}));

// ---------------------------------------------------------- recordings

async function loadSessionFor(req, id) {
  if (!isValidId(id)) throw new APIError('Invalid session', 400);
  const session = await VoiceSession.findById(id);
  if (!session) throw new APIError('Session not found', 404);
  const inIt = session.participants.some(p => String(p.user) === String(req.user.id));
  if (!inIt && !isStaff(req.user)) throw new APIError('Not your session', 403);
  return session;
}

/**
 * A piece of the student's own microphone from a session. Each participant
 * uploads their own side, in pieces of up to ten minutes.
 */
router.post('/sessions/:id/recording', upload.single('audio'), async (req, res, next) => {
  try {
    const session = await loadSessionFor(req, req.params.id);
    if (!req.file?.buffer?.length) throw new APIError('No audio received', 400);

    const { audioKey, bytes } = await AudioStorageService.store(req.file.buffer, {
      filename: `voice-${session._id}-${req.user.id}-${Date.now()}.webm`,
      contentType: req.file.mimetype || 'audio/webm',
      studentId: req.user.id,
      resultId: `voice:${session._id}`,
      taskNumber: 0
    });

    await VoiceSession.updateOne(
      { _id: session._id },
      {
        $push: {
          recordings: {
            user: req.user.id,
            audioKey,
            bytes,
            seconds: Number(req.body?.seconds) || undefined,
            at: new Date()
          }
        }
      }
    );
    res.status(201).json({ success: true, data: { audioKey, bytes } });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------ report and rate

router.post('/report', async (req, res, next) => {
  try {
    const session = await loadSessionFor(req, String(req.body?.sessionId || ''));
    const against = session.participants.find(p => String(p.user) === String(req.body?.against));
    const me = session.participants.find(p => String(p.user) === String(req.user.id));
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    if (!reason) throw new APIError('Say briefly what happened.', 400);

    await VoiceSession.updateOne(
      { _id: session._id },
      {
        $set: { reported: true },
        $push: {
          reports: {
            by: req.user.id,
            byName: me?.name || '',
            against: against?.user,
            againstName: against?.name || '',
            reason,
            at: new Date()
          }
        }
      }
    );
    console.warn(`Speaking rooms: report on session ${session._id} by ${req.user.id}`);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/rate', async (req, res, next) => {
  try {
    const session = await loadSessionFor(req, String(req.body?.sessionId || ''));
    const stars = Math.max(1, Math.min(5, Math.round(Number(req.body?.stars) || 0)));
    const peer = session.participants.find(p => String(p.user) === String(req.body?.peer));
    if (!peer || String(peer.user) === String(req.user.id)) throw new APIError('Unknown partner', 400);

    await VoiceSession.updateOne(
      { _id: session._id },
      { $push: { ratings: { by: req.user.id, peer: peer.user, stars, at: new Date() } } }
    );
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------- teacher

const staffOnly = (req, res, next) =>
  isStaff(req.user) ? next() : next(new APIError('Teachers only', 403));

router.get('/admin/live', staffOnly, (req, res) => {
  res.json({ success: true, data: { ...voiceHub.snapshot(), relay: relayConfigured(), retentionDays: RETENTION_DAYS } });
});

router.get('/admin/sessions', staffOnly, async (req, res, next) => {
  try {
    const filter = req.query.reported === '1' ? { reported: true } : {};
    const sessions = await VoiceSession.find(filter).sort({ startedAt: -1 }).limit(60).lean();
    res.json({
      success: true,
      data: sessions.map(s => ({
        id: String(s._id),
        kind: s.kind,
        roomName: s.roomName,
        topic: s.topic?.text || '',
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        participants: (s.participants || []).map(p => ({ id: String(p.user), name: p.name })),
        recordings: (s.recordings || []).map(r => ({
          audioKey: r.audioKey,
          user: String(r.user),
          name: (s.participants || []).find(p => String(p.user) === String(r.user))?.name || '',
          bytes: r.bytes,
          at: r.at
        })),
        reports: s.reports || [],
        reported: Boolean(s.reported)
      }))
    });
  } catch (error) {
    next(error);
  }
});

/** Play a recording — teachers only, streamed, never exposed by URL alone. */
router.get('/admin/recordings/:audioKey', staffOnly, async (req, res, next) => {
  try {
    const session = await VoiceSession.exists({ 'recordings.audioKey': req.params.audioKey });
    if (!session) throw new APIError('Recording not found', 404);
    res.setHeader('Content-Type', 'audio/webm');
    AudioStorageService.openDownloadStream(req.params.audioKey)
      .on('error', error => next(new APIError(`Recording unavailable: ${error.message}`, 404)))
      .pipe(res);
  } catch (error) {
    next(error);
  }
});

router.delete('/admin/sessions/:id', staffOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid session', 400);
    const session = await VoiceSession.findById(req.params.id);
    if (!session) throw new APIError('Session not found', 404);
    for (const rec of session.recordings || []) await AudioStorageService.delete(rec.audioKey);
    await session.deleteOne();
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/admin/kick', staffOnly, (req, res) => {
  voiceHub.kick(String(req.body?.userId || ''));
  res.json({ success: true });
});

export default router;
