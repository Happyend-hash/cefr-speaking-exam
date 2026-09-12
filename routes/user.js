import express from 'express';
import User from '../models/User.js';
import ExamResult from '../models/ExamResult.js';
import AuthService from '../services/AuthService.js';
import { APIError } from '../middleware/errorHandler.js';

const router = express.Router();

/**
 * @route   GET /api/user/profile
 * @desc    Signed-in user's profile plus a summary of their exam history
 * @access  Private
 */
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
          lastCompletedAt: results[0]?.completedAt || null
        }
      }
    });
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
    const allowed = ['firstName', 'lastName', 'nativeLanguage', 'bio', 'avatar'];
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

const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

function highestCEFR(levels) {
  const ranked = levels.filter(Boolean).map(l => CEFR_ORDER.indexOf(l)).filter(i => i >= 0);
  if (ranked.length === 0) return null;
  return CEFR_ORDER[Math.max(...ranked)];
}

export default router;
