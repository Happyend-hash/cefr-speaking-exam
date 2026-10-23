import express from 'express';
import { authorize } from '../middleware/auth.js';
import { sendMessages, sentBatches, withdrawBatch, MAX_GIFT } from '../services/Messages.js';

/**
 * The teacher's side of the message box — /api/admin/messages (admin only).
 */
const router = express.Router();
router.use(authorize('admin'));

router.get('/', async (req, res, next) => {
  try { res.json({ success: true, data: { sent: await sentBatches(), maxGift: MAX_GIFT } }); } catch (error) { next(error); }
});

/** { to: 'all' | 'course' | [userId], title, html, gift?: { speaking, writing } } */
router.post('/', async (req, res, next) => {
  try {
    const { to, title, html, gift } = req.body || {};
    const out = await sendMessages({ to, title, html, gift, sentBy: req.user.email || String(req.user.id) });
    res.status(201).json({ success: true, message: `Sent to ${out.sent} student${out.sent === 1 ? '' : 's'}.`, data: { ...out, sent: out.sent, list: await sentBatches() } });
  } catch (error) { next(error); }
});

router.delete('/:batch', async (req, res, next) => {
  try {
    const out = await withdrawBatch(req.params.batch);
    res.json({ success: true, data: { ...out, list: await sentBatches() } });
  } catch (error) { next(error); }
});

export default router;
