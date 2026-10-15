import express from 'express';
import User from '../models/User.js';
import {
  isConfigured, setupMessage, createSessionToken, questionsFor, listMocks,
  DAILY_SESSIONS, WS_URL, today,
  CHARACTERS,
  DEFAULT_CHARACTER,
  RUDE_WORDS
} from '../services/SpeakingAssistant.js';
import { isStaff } from '../services/Premium.js';
import { APIError } from '../middleware/errorHandler.js';

/**
 * AI Ustoz — the live voice speaking coach (services/SpeakingAssistant.js).
 *
 *   GET  /status      available? confirmed 18+? sessions left today
 *   POST /confirm-age the 18+ tick and the Google-review notice
 *   POST /session     a single-use token + the setup for one live session
 *   GET  /questions   the tool the model calls for real mock questions
 *   GET  /mocks       the tool that lists the mocks
 */
const router = express.Router();

function usageToday(user) {
  const day = today();
  return user.assistantUsage?.day === day ? user.assistantUsage.sessions || 0 : 0;
}

router.get('/status', async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('assistantAdultAt assistantUsage role premiumUntil');
    if (!user) throw new APIError('User not found', 404);
    const used = usageToday(user);
    res.json({
      success: true,
      data: {
        available: isConfigured(),
        adult: Boolean(user.assistantAdultAt),
        used,
        limit: isStaff(user) ? null : DAILY_SESSIONS,
        left: isStaff(user) ? null : Math.max(0, DAILY_SESSIONS - used)
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/confirm-age', async (req, res, next) => {
  try {
    if (req.body?.adult !== true) throw new APIError("Iltimos, 18 yoshdan kattaligingizni tasdiqlang.", 400);
    await User.updateOne({ _id: req.user.id }, { $set: { assistantAdultAt: new Date() } });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/session', async (req, res, next) => {
  try {
    if (!isConfigured()) throw new APIError("AI Ustoz hali ishga tushirilmagan.", 503, 'not_configured');
    const user = await User.findById(req.user.id).select('firstName assistantAdultAt assistantUsage role access premiumUntil');
    if (!user) throw new APIError('User not found', 404);
    if (user.access?.blocked && !isStaff(user)) throw new APIError('Your teacher has paused your access.', 403, 'blocked');
    if (!user.assistantAdultAt) throw new APIError("Avval 18 yoshdan kattaligingizni tasdiqlang.", 403, 'age');

    const used = usageToday(user);
    if (!isStaff(user) && used >= DAILY_SESSIONS) {
      throw new APIError(`Bugungi ${DAILY_SESSIONS} ta suhbat tugadi — ertaga yana gaplashamiz!`, 429, 'daily_limit');
    }

    let token;
    try {
      token = await createSessionToken();
    } catch (error) {
      console.error('AI Ustoz:', error.message);
      throw new APIError("AI Ustoz hozir band — birozdan keyin urinib ko'ring.", 503, 'gemini');
    }

    await User.updateOne({ _id: user._id }, { $set: { assistantUsage: { day: today(), sessions: used + 1 } } });
    res.json({
      success: true,
      data: {
        url: `${WS_URL}?access_token=${encodeURIComponent(token)}`,
        setup: setupMessage({
          character: CHARACTERS[req.body?.character] ? req.body.character : DEFAULT_CHARACTER,
          studentName: user.firstName
        }),
        left: isStaff(user) ? null : Math.max(0, DAILY_SESSIONS - used - 1),
        rudeWords: RUDE_WORDS
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/questions', async (req, res, next) => {
  try {
    res.json({ success: true, data: await questionsFor({ mock: req.query.mock, part: req.query.part }) });
  } catch (error) {
    next(error);
  }
});

router.get('/mocks', async (req, res, next) => {
  try {
    res.json({ success: true, data: await listMocks() });
  } catch (error) {
    next(error);
  }
});

export default router;
