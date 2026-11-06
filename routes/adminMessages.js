import express from 'express';
import { authorize } from '../middleware/auth.js';
import User from '../models/User.js';
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
    const { title, html, gift } = req.body || {};
    let { to } = req.body || {};
    // A course student's linked account, by its email (the 🎁 in O'quvchilar, 2026-11-06).
    if (req.body?.toEmail !== undefined) {
      const email = String(req.body.toEmail || '').trim().toLowerCase();
      const user = email ? await User.findOne({ email }).select('_id role').lean() : null;
      if (!user || user.role !== 'student') {
        return res.status(400).json({ success: false, message: `No student account with ${email || 'that email'} on the website yet.` });
      }
      to = [String(user._id)];
    }
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
