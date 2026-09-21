import express from 'express';
import { leaderboardFor } from '../services/Leaderboard.js';

/**
 * @route  GET /api/leaderboard
 * @desc   Top ten average full-speaking-mock scores, and where the viewer stands.
 * @access Signed-in users
 */
const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await leaderboardFor(req.user.id) });
  } catch (error) {
    next(error);
  }
});

export default router;
