import express from 'express';
import multer from 'multer';
import User from '../models/User.js';
import {
  isPremium, premiumDaysLeft, avatarUrl, sniffImage, newAvatarToken,
  avatarStorage, MAX_AVATAR_BYTES, PREMIUM_DAYS,
  announceBadge
} from '../services/Premium.js';
import { voiceHub } from '../services/VoiceRooms.js';
import { chatHub } from '../services/ChatRooms.js';
import { invalidate as invalidateLeaderboard, fallbackName } from '../services/Leaderboard.js';
import ExamResult, { CEFR_BANDS, MAX_SCORE, BELOW_B1 } from '../models/ExamResult.js';
import AuthService from '../services/AuthService.js';
import { APIError } from '../middleware/errorHandler.js';

const router = express.Router();

const pictureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 }
});

/**
 * @route   GET /api/user/profile
 * @desc    Signed-in user's profile plus a summary of their exam history
 * @access  Private
 */

/**
 * Average each marking criterion across a set of completed attempts.
 *
 * Returns scores on the same 0-75 scale as everything else; the dashboard
 * rescales for display. Criteria keys differ between speaking and writing, so
 * whatever keys are present are averaged and the caller renders what it gets.
 */
function averageSkills(results) {
  const totals = {};
  const counts = {};

  for (const result of results) {
    for (const task of result.taskResults || []) {
      const criteria = task.aiEvaluation?.criteria;
      if (!criteria || task.status !== 'evaluated') continue;
      for (const [name, value] of Object.entries(criteria)) {
        // Tested for absence before converting: Number(null) is 0, and the
        // measured fluency facts carry no score by design — read as a zero,
        // they would have shown every student a fluency skill of 0.
        if (value?.score === null || value?.score === undefined || value?.score === '') continue;
        const score = Number(value.score);
        if (!Number.isFinite(score)) continue;
        totals[name] = (totals[name] || 0) + score;
        counts[name] = (counts[name] || 0) + 1;
      }
    }
  }

  const skills = {};
  for (const name of Object.keys(totals)) {
    skills[name] = Math.round((totals[name] / counts[name]) * 10) / 10;
  }
  return Object.keys(skills).length ? skills : null;
}

router.get('/profile', async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) throw new APIError('User not found', 404);

    const results = await ExamResult.find({
      student: req.user.id,
      status: 'completed'
    })
      .sort({ completedAt: -1 })
      .lean();

    const scores = results.map(r => r.overallScore).filter(s => typeof s === 'number');
    const averageScore = scores.length
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : null;

    res.json({
      success: true,
      data: {
        user: user.getPublicProfile ? user.getPublicProfile() : user,
        stats: {
          examsCompleted: results.length,
          averageScore,
          currentLevel: results[0]?.overallLevel || null,
          highestLevel: highestCEFR(results.map(r => r.overallLevel)),
          lastCompletedAt: results[0]?.completedAt || null,
          bestScore: scores.length ? Math.max(...scores) : null,
          // The score before the current best, so the dashboard can say whether
          // the student is improving rather than only where they stand.
          previousBest: (() => {
            const sorted = [...scores].sort((a, b) => b - a);
            return sorted.length > 1 ? sorted[1] : null;
          })(),
          completedThisMonth: results.filter(r => {
            if (!r.completedAt) return false;
            const d = new Date(r.completedAt);
            const now = new Date();
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
          }).length,
          // Per-criterion averages across the most recent completed attempts.
          // The results LIST does not carry criteria — they live inside each
          // attempt's taskResults — so the dashboard could not show a skill
          // breakdown without this. Averaged over the last few attempts rather
          // than only the latest, so one bad answer does not define a skill.
          skills: averageSkills(results.slice(0, 5)),
          // The dashboard draws the CEFR progress bar from these rather than
          // keeping its own copy of the thresholds. One source of truth for the
          // bands was the whole point of putting them in models/ExamResult.js.
          maxScore: MAX_SCORE,
          bands: CEFR_BANDS
        },
        // What the student is allowed to do, and how to ask for more. The
        // dashboard already fetches this profile, so the mock counter, the
        // top-up page and the payment confirmation all arrive without a second
        // request — and the counter cannot disagree with the server, because it
        // is not kept anywhere else.
        access: {
          // null for teachers and admins, who are never charged. The dashboard
          // shows a counter only when there is a number, so staff simply do not
          // see one rather than seeing a number that means nothing.
          remaining: user.examAccess().code === 'staff'
            ? null
            : user.subscription?.examsRemaining ?? 0,
          // The balance as it is said — "4⅓". A single part costs a share of
          // a mock (¼ speaking, ⅓ writing), so the whole count alone under-reports.
          credits: user.examAccess().code === 'staff' ? null : user.creditLabel(),
          units: user.examAccess().code === 'staff' ? null : user.creditUnits(),
          // Writing has its own balance — a package is 4 speaking + 3 writing,
          // and the two are not interchangeable.
          writing: user.examAccess().code === 'staff'
            ? null
            : {
                remaining: user.subscription?.writingRemaining ?? 0,
                credits: user.creditLabel('writing'),
                units: user.creditUnits('writing')
              },
          blocked: Boolean(user.access?.blocked),
          // Where to reach the teacher about paying. Configured once, in the
          // environment, so the contact can change without a deploy of the app
          // code and without the address being baked into the page.
          contact: process.env.TELEGRAM_CONTACT || '',
          // A one-off note from the teacher — normally the confirmation that a
          // payment landed. Cleared by the student dismissing it.
          message: user.access?.message || ''
        },
        // Premium and the picture, for the speaking club's profile strip.
        premium: premiumState(user)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/user/access/seen
 * @desc    Dismiss the teacher's one-off notice
 * @access  Private
 */
router.post('/access/seen', async (req, res, next) => {
  try {
    await User.updateOne(
      { _id: req.user.id },
      { $set: { 'access.message': '', 'access.messageAt': null } }
    );
    res.json({ success: true, message: 'Notice dismissed' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/user/nickname
 * @desc    Choose the name shown on the leaderboard
 * @access  Private
 *
 * 3-20 characters: letters in any alphabet, digits, spaces, dot, dash and
 * underscore. Unique regardless of case. An empty value clears it, and the
 * student shows as first name and last initial again.
 */
router.put('/nickname', async (req, res, next) => {
  try {
    const raw = String(req.body?.nickname ?? '').replace(/\s+/g, ' ').trim();
    const user = await User.findById(req.user.id);
    if (!user) throw new APIError('User not found', 404);

    if (!raw) {
      user.nickname = undefined;
      user.nicknameLower = undefined;
    } else {
      if (raw.length < 3 || raw.length > 20) {
        throw new APIError("Taxallus 3 tadan 20 tagacha belgidan iborat bo'lsin.", 400, 'nickname_length');
      }
      if (!/^[\p{L}\p{N} ._-]+$/u.test(raw)) {
        throw new APIError("Faqat harf, raqam, bo'sh joy, nuqta, chiziqcha va _ ishlatish mumkin.", 400, 'nickname_chars');
      }
      const lower = raw.toLowerCase();
      const taken = await User.exists({ nicknameLower: lower, _id: { $ne: user._id } });
      if (taken) throw new APIError('Bu taxallus band. Boshqasini tanlang.', 409, 'nickname_taken');
      user.nickname = raw;
      user.nicknameLower = lower;
    }

    await user.save();
    invalidateLeaderboard();
    res.json({ success: true, data: { nickname: user.nickname || null } });
  } catch (error) {
    // Two students choosing the same name at the same moment: the unique index
    // catches what the check above could not.
    if (error?.code === 11000) {
      return next(new APIError('Bu taxallus band. Boshqasini tanlang.', 409, 'nickname_taken'));
    }
    next(error);
  }
});

// ------------------------------------------------------------- premium

function premiumState(user) {
  return {
    name: user.nickname || fallbackName(user),
    active: isPremium(user),
    until: user.premiumUntil || null,
    daysLeft: premiumDaysLeft(user),
    days: PREMIUM_DAYS,
    // The picture even while Premium has lapsed, so the student sees that it
    // is kept and comes back when they renew.
    avatar: avatarUrl(user),
    hasPicture: Boolean(user.picture?.token),
    pictureBlocked: Boolean(user.pictureBlocked),
    maxBytes: MAX_AVATAR_BYTES
  };
}

router.get('/premium', async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) throw new APIError('User not found', 404);
    res.json({ success: true, data: premiumState(user) });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/user/avatar
 * @desc    Upload a picture or animated GIF (Premium only, 2 MB)
 */
router.post('/avatar', (req, res, next) => {
  pictureUpload.single('picture')(req, res, async error => {
    try {
      if (error?.code === 'LIMIT_FILE_SIZE') {
        throw new APIError('Rasm 2 MB dan katta bo\'lmasligi kerak.', 413, 'too_big');
      }
      if (error) throw error;

      const user = await User.findById(req.user.id);
      if (!user) throw new APIError('User not found', 404);
      if (!isPremium(user)) {
        throw new APIError("Rasm qo'yish faqat Premium o'quvchilar uchun.", 403, 'premium_only');
      }
      if (user.pictureBlocked) {
        throw new APIError("Ustoz sizga rasm qo'yishni to'xtatgan.", 403, 'picture_blocked');
      }
      const buffer = req.file?.buffer;
      const contentType = sniffImage(buffer);
      if (!contentType) {
        throw new APIError('Faqat GIF, PNG, JPG yoki WEBP rasm yuklang.', 415, 'bad_type');
      }

      const key = await avatarStorage.store(buffer, { contentType, userId: user._id });
      const old = user.picture?.key;
      user.picture = { key, token: newAvatarToken(), contentType, bytes: buffer.length, at: new Date() };
      await user.save();
      if (old) await avatarStorage.delete(old);
      invalidateLeaderboard();
      announceBadge(user, [voiceHub, chatHub]);

      res.status(201).json({ success: true, data: premiumState(user) });
    } catch (err) {
      next(err);
    }
  });
});

router.delete('/avatar', async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) throw new APIError('User not found', 404);
    const old = user.picture?.key;
    user.picture = undefined;
    await user.save();
    if (old) await avatarStorage.delete(old);
    invalidateLeaderboard();
    announceBadge(user, [voiceHub, chatHub]);
    res.json({ success: true, data: premiumState(user) });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/user/profile
 * @desc    Update the editable parts of a profile
 * @access  Private
 */
router.put('/profile', async (req, res, next) => {
  try {
    // Not 'avatar': pictures go through POST /avatar, which checks the file
    // and that the student is Premium. A free-text avatar field would let
    // anyone point their avatar at any address.
    const allowed = ['firstName', 'lastName', 'nativeLanguage', 'bio'];
    const updates = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (Object.keys(updates).length === 0) {
      throw new APIError('No updatable fields provided', 400);
    }

    const user = await User.findByIdAndUpdate(req.user.id, updates, {
      new: true,
      runValidators: true
    });
    if (!user) throw new APIError('User not found', 404);

    res.json({
      success: true,
      message: 'Profile updated',
      data: user.getPublicProfile ? user.getPublicProfile() : user
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/user/history
 * @desc    Every attempt this user has made
 * @access  Private
 */
router.get('/history', async (req, res, next) => {
  try {
    const results = await ExamResult.find({ student: req.user.id })
      .sort({ createdAt: -1 })
      .populate('exam', 'title level')
      .lean();

    res.json({
      success: true,
      data: results.map(r => ({
        id: r._id,
        examTitle: r.exam?.title || 'Exam',
        examLevel: r.examLevel,
        status: r.status,
        overallScore: r.overallScore ?? null,
        overallLevel: r.overallLevel,
        isPassed: r.isPassed,
        startedAt: r.startedAt,
        completedAt: r.completedAt
      }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/user/change-password
 * @access  Private
 */
router.post('/change-password', async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      throw new APIError('Both the current and new password are required', 400);
    }
    if (String(newPassword).length < 8) {
      throw new APIError('New password must be at least 8 characters', 400);
    }

    const result = await AuthService.changePassword(req.user.id, oldPassword, newPassword);
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// 'A1' and 'A2' are kept only so attempts marked under the old, invented band
// table still rank. Nothing produces them now; 'B1dan quyi' is what sits below
// B1 in this exam.
const CEFR_ORDER = ['A1', 'A2', BELOW_B1, 'B1', 'B2', 'C1', 'C2'];

function highestCEFR(levels) {
  const ranked = levels.filter(Boolean).map(l => CEFR_ORDER.indexOf(l)).filter(i => i >= 0);
  if (ranked.length === 0) return null;
  return CEFR_ORDER[Math.max(...ranked)];
}

export default router;
