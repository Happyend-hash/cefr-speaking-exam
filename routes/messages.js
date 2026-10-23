import express from 'express';
import { inbox, unreadCount, markRead, openGift, claimGift, hide } from '../services/Messages.js';

/**
 * The student's message box — /api/messages (signed in).
 * See services/Messages.js.
 */
const router = express.Router();

router.get('/', async (req, res, next) => {
  try { res.json({ success: true, data: await inbox(req.user.id) }); } catch (error) { next(error); }
});

router.get('/unread', async (req, res, next) => {
  try { res.json({ success: true, data: { unread: await unreadCount(req.user.id) } }); } catch (error) { next(error); }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    const message = await markRead(req.user.id, req.params.id);
    if (!message) return res.status(404).json({ success: false, message: 'Xabar topilmadi' });
    res.json({ success: true, data: { message, unread: await unreadCount(req.user.id) } });
  } catch (error) { next(error); }
});

router.post('/:id/open', async (req, res, next) => {
  try {
    const message = await openGift(req.user.id, req.params.id);
    if (!message) return res.status(404).json({ success: false, message: 'Sovg‘a topilmadi' });
    res.json({ success: true, data: { message } });
  } catch (error) { next(error); }
});

router.post('/:id/claim', async (req, res, next) => {
  try {
    const out = await claimGift(req.user.id, req.params.id);
    res.json({ success: true, data: { ...out, unread: await unreadCount(req.user.id) } });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const ok = await hide(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ success: false, message: 'Xabar topilmadi' });
    res.json({ success: true, data: { unread: await unreadCount(req.user.id) } });
  } catch (error) { next(error); }
});

export default router;
