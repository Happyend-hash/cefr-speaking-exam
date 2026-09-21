import express from 'express';
import User from '../models/User.js';
import ExamResult from '../models/ExamResult.js';
import { errorHunt, duelHub, taboo } from '../services/GameRooms.js';
import { award, gameLeaderboard, todayPoints, DAILY_CAP } from '../services/Games.js';
import { fallbackName } from '../services/Leaderboard.js';
import { badgeOf, BADGE_FIELDS } from '../services/Premium.js';
import { APIError } from '../middleware/errorHandler.js';

/**
 * Games: Error Hunter, Word Duel and Taboo, and the games ranking.
 * Every score is worked out on the server.
 */

const router = express.Router();
const isStaff = u => u?.role === 'admin' || u?.role === 'teacher';

async function player(userId) {
  const user = await User.findById(userId).select(`firstName lastName nickname access ${BADGE_FIELDS}`);
  if (!user) throw new APIError('User not found', 404);
  if (user.access?.blocked && !isStaff(user)) throw new APIError('Your teacher has paused your access.', 403, 'blocked');
  const latest = await ExamResult.findOne({ student: userId, status: 'completed', overallLevel: { $exists: true } })
    .sort({ completedAt: -1 }).select('overallLevel').lean();
  return {
    id: String(user._id),
    name: user.nickname || fallbackName(user),
    level: /^(B1|B2|C1)$/.test(latest?.overallLevel || '') ? latest.overallLevel : null,
    ...badgeOf(user)
  };
}

const reply = (res, out) => {
  if (out?.error) throw new APIError(out.error, 409);
  if (out?.ok === false) throw new APIError(out.reason || 'Not possible now', 409);
  res.json({ success: true, data: out || {} });
};
const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

// ------------------------------------------------------------- overview

router.get('/leaderboard', handle(async (req, res) => {
  res.json({ success: true, data: await gameLeaderboard(req.user.id, req.query.period === 'all' ? 'all' : 'week') });
}));

router.get('/today', handle(async (req, res) => {
  res.json({ success: true, data: { today: await todayPoints(req.user.id), caps: DAILY_CAP } });
}));

// --------------------------------------------------------- error hunter

router.post('/eh/start', handle(async (req, res) => {
  await player(req.user.id);
  res.json({ success: true, data: errorHunt.start(req.user.id) });
}));

const afterAnswer = async (req, out) => {
  if (!out?.done) return out;
  const summary = errorHunt.take(req.user.id, req.body?.roundId);
  if (summary) {
    out.counted = await award(req.user.id, 'error-hunter', summary.points, { correct: summary.correct, total: summary.total });
  }
  return out;
};

router.post('/eh/tap', handle(async (req, res) => {
  const b = req.body || {};
  reply(res, await afterAnswer(req, errorHunt.tap(req.user.id, b.roundId, b.index, b.word)));
}));
router.post('/eh/fix', handle(async (req, res) => {
  const b = req.body || {};
  reply(res, await afterAnswer(req, errorHunt.fix(req.user.id, b.roundId, b.index, b.choice)));
}));
router.post('/eh/timeout', handle(async (req, res) => {
  const b = req.body || {};
  reply(res, await afterAnswer(req, errorHunt.timeout(req.user.id, b.roundId, b.index)));
}));

// ----------------------------------------------------------- word duel

router.get('/duel/stream', handle(async (req, res) => {
  const me = await player(req.user.id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  duelHub.connect(me, res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(heartbeat); duelHub.disconnect(me.id, res); });
}));

router.post('/duel/find', handle(async (req, res) => reply(res, duelHub.find(req.user.id))));
router.delete('/duel/find', handle(async (req, res) => { duelHub.cancel(req.user.id); reply(res, { ok: true }); }));
router.post('/duel/answer', handle(async (req, res) =>
  reply(res, duelHub.answer(req.user.id, req.body?.i, req.body?.choice))));
router.post('/duel/leave', handle(async (req, res) => { duelHub.leave(req.user.id); reply(res, { ok: true }); }));

// --------------------------------------------------------------- taboo

router.post('/taboo/start', handle(async (req, res) => reply(res, taboo.start(req.user.id))));
router.post('/taboo/skip', handle(async (req, res) => reply(res, taboo.skip(req.user.id))));
router.post('/taboo/buzz', handle(async (req, res) => reply(res, taboo.buzz(req.user.id))));
router.post('/taboo/stop', handle(async (req, res) => reply(res, taboo.stop(req.user.id))));

export default router;
