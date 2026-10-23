import express from 'express';
import { authorize } from '../middleware/auth.js';
import { conversations, teamThread, teamSend, teamUnread, image } from '../services/Support.js';

/** English Hub Support, the team's side — /api/admin/support (admin only). */
const router = express.Router();
router.use(authorize('admin'));

router.get('/', async (req, res, next) => {
  try { res.json({ success: true, data: await conversations({ only: req.query.only }) }); } catch (error) { next(error); }
});

router.get('/unread', async (req, res, next) => {
  try { res.json({ success: true, data: { unread: await teamUnread() } }); } catch (error) { next(error); }
});

router.get('/images/:id', async (req, res, next) => {
  try {
    const img = await image(req.params.id, { admin: true });
    if (!img) return res.status(404).end();
    res.set({ 'Content-Type': img.contentType, 'Cache-Control': 'private, max-age=86400' }).send(img.data);
  } catch (error) { next(error); }
});

router.get('/:user', async (req, res, next) => {
  try { res.json({ success: true, data: await teamThread(req.params.user) }); } catch (error) { next(error); }
});

router.post('/:user', async (req, res, next) => {
  try {
    const message = await teamSend(req.params.user, { ...(req.body || {}), sentBy: req.user.email || String(req.user.id) });
    res.status(201).json({ success: true, data: { message } });
  } catch (error) { next(error); }
});

export default router;
