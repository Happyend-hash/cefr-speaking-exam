import express from 'express';
import { authorize } from '../middleware/auth.js';
import { mediaStorage } from '../services/MediaStorage.js';
import { audience, setAudience, canSeeNews, listNews, saveNews, deleteNews, newsPhoto } from '../services/News.js';

/**
 * Sayt yangiliklari — /api/news (signed in) and /api/admin/news (admin).
 */
const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

const router = express.Router();
router.get('/', handle(async (req, res) => {
  if (!(await canSeeNews(req.user))) return res.json({ success: true, data: { visible: false, news: [] } });
  res.json({ success: true, data: { visible: true, news: await listNews() } });
}));
router.get('/:id/photo', handle(async (req, res) => {
  if (!(await canSeeNews(req.user))) return res.status(404).end();
  const photo = await newsPhoto(req.params.id, { admin: req.user?.role === 'admin' });
  if (!photo) return res.status(404).end();
  mediaStorage.serve(res, photo.key, photo.type);
}));

export const adminRouter = express.Router();
adminRouter.use(authorize('admin'));
adminRouter.get('/', handle(async (req, res) => {
  res.json({ success: true, data: { audience: await audience(), news: await listNews({ admin: true, limit: 200 }) } });
}));
adminRouter.put('/audience', handle(async (req, res) => {
  res.json({ success: true, data: { audience: await setAudience(String(req.body?.audience || '')) } });
}));
adminRouter.post('/', handle(async (req, res) => {
  res.status(201).json({ success: true, data: { item: await saveNews(null, req.body || {}, req.user.email) } });
}));
adminRouter.patch('/:id', handle(async (req, res) => {
  res.json({ success: true, data: { item: await saveNews(req.params.id, req.body || {}, req.user.email) } });
}));
adminRouter.delete('/:id', handle(async (req, res) => {
  await deleteNews(req.params.id);
  res.json({ success: true, data: { deleted: true } });
}));

export default router;
