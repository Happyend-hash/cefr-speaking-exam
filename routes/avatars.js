import express from 'express';
import User from '../models/User.js';
import { isPremium, avatarStorage } from '../services/Premium.js';

/**
 * GET /api/avatars/:token — a student's picture.
 *
 * Public (no sign-in), because it is shown in <img> tags all over the speaking
 * club, which cannot send a token. The address is a random 32-character
 * token that changes with every upload, so it cannot be guessed, and a picture
 * that was replaced or removed stops being served at once.
 *
 * Served only while the owner is Premium, only as one of the four image types
 * checked on upload, and with headers that stop a browser treating it as
 * anything but an image.
 */
const router = express.Router();

router.get('/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{32}$/.test(token)) return res.status(404).end();
    const user = await User.findOne({ 'picture.token': token }).select('picture premiumUntil').lean();
    if (!user?.picture?.key || !isPremium(user)) return res.status(404).end();

    res.set({
      'Content-Type': user.picture.contentType || 'image/gif',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      // The token changes on every upload, so each address is one picture forever.
      'Cache-Control': 'public, max-age=86400'
    });
    avatarStorage.open(user.picture.key)
      .on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); })
      .pipe(res);
  } catch (error) {
    next(error);
  }
});

export default router;
