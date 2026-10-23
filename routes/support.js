import express from 'express';
import { thread, userSend, image, userUnread } from '../services/Support.js';

/** English Hub Support, the student's side — /api/support (signed in). */
const router = express.Router();

router.get('/', async (req, res, next) => {
  try { res.json({ success: true, data: await thread(req.user.id, { markRead: req.query.peek !== '1' }) }); } catch (error) { next(error); }
});

router.get('/unread', async (req, res, next) => {
  try { res.json({ success: true, data: { unread: await userUnread(req.user.id) } }); } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const message = await userSend(req.user.id, req.body || {});
    res.status(201).json({ success: true, data: { message } });
  } catch (error) { next(error); }
});

router.get('/images/:id', async (req, res, next) => {
  try {
    const img = await image(req.params.id, { user: req.user.id });
    if (!img) return res.status(404).end();
    res.set({ 'Content-Type': img.contentType, 'Cache-Control': 'private, max-age=86400' }).send(img.data);
  } catch (error) { next(error); }
});

export default router;
