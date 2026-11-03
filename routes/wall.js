import express from 'express';
import { authorize } from '../middleware/auth.js';
import { mediaStorage } from '../services/MediaStorage.js';
import { sendMessages } from '../services/Messages.js';
import {
  publicWall, publicPhoto, myCertificates, submitCertificate, deleteMyCertificate, myCertificatePhoto,
  adminWall, saveReview, deleteReview, reviewCertificate, deleteCertificate, adminCertificatePhoto
} from '../services/Wall.js';

/**
 * "Natijalar va fikrlar" — the public wall of reviews and real exam results.
 *   /api/wall            public: the wall and its photos (no sign-in)
 *   /api/wall/me         a student's own certificates (signed in)
 *   /api/admin/wall      the teacher: reviews, and approving certificates
 */
const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

export const publicRouter = express.Router();
publicRouter.get('/', handle(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ success: true, data: await publicWall() });
}));
publicRouter.get('/photo/:kind/:id', handle(async (req, res) => {
  const photo = await publicPhoto(String(req.params.kind), String(req.params.id));
  if (!photo) return res.status(404).end();
  mediaStorage.serve(res, photo.key, photo.type);
}));

export const studentRouter = express.Router();
studentRouter.get('/', handle(async (req, res) => {
  res.json({ success: true, data: { certificates: await myCertificates(req.user.id) } });
}));
studentRouter.post('/certificates', handle(async (req, res) => {
  res.status(201).json({ success: true, data: { certificate: await submitCertificate(req.user.id, req.body || {}) } });
}));
studentRouter.delete('/certificates/:id', handle(async (req, res) => {
  await deleteMyCertificate(req.user.id, req.params.id);
  res.json({ success: true, data: { certificates: await myCertificates(req.user.id) } });
}));
studentRouter.get('/certificates/:id/photo', handle(async (req, res) => {
  const photo = await myCertificatePhoto(req.user.id, req.params.id);
  if (!photo) return res.status(404).end();
  mediaStorage.serve(res, photo.key, photo.type);
}));

export const adminRouter = express.Router();
adminRouter.use(authorize('admin'));
adminRouter.get('/', handle(async (req, res) => res.json({ success: true, data: await adminWall() })));
adminRouter.post('/reviews', handle(async (req, res) => {
  res.status(201).json({ success: true, data: { review: await saveReview(null, req.body || {}, req.user.email) } });
}));
adminRouter.patch('/reviews/:id', handle(async (req, res) => {
  res.json({ success: true, data: { review: await saveReview(req.params.id, req.body || {}, req.user.email) } });
}));
adminRouter.delete('/reviews/:id', handle(async (req, res) => {
  await deleteReview(req.params.id);
  res.json({ success: true, data: await adminWall() });
}));
adminRouter.post('/certificates/:id/:action(approve|reject|hide)', handle(async (req, res) => {
  const c = await reviewCertificate(req.params.id, { action: req.params.action, reason: req.body?.reason, by: req.user.email });
  // The student hears the outcome in their message box.
  if (req.params.action !== 'hide' && req.body?.notify !== false) {
    const ok = req.params.action === 'approve';
    await sendMessages({
      to: [String(c.user)],
      title: ok ? '🏆 Natijangiz «Natijalar» sahifasiga qo‘shildi!' : 'Natijangiz qabul qilinmadi',
      html: ok
        ? '<p>Tabriklaymiz! 🎉 Siz yuklagan imtihon natijasi tekshirildi va endi hamma uchun <b>Natijalar va fikrlar</b> sahifasida ko‘rinadi. Boshqa o‘quvchilarga ilhom berganingiz uchun rahmat! 💙</p>'
        : `<p>Siz yuklagan imtihon natijasi sahifaga qo‘shilmadi.${c.reason ? ` Sababi: <b>${c.reason.replace(/[<>&"]/g, '')}</b>.` : ''}</p><p>Rasmni aniqroq qilib yoki ma’lumotlarni to‘g‘rilab qaytadan yuklashingiz mumkin.</p>`,
      sentBy: req.user.email || 'teacher'
    }).catch(error => console.error('Certificate message not sent:', error.message));
  }
  res.json({ success: true, data: await adminWall() });
}));
adminRouter.delete('/certificates/:id', handle(async (req, res) => {
  await deleteCertificate(req.params.id);
  res.json({ success: true, data: await adminWall() });
}));
adminRouter.get('/certificates/:id/photo', handle(async (req, res) => {
  const photo = await adminCertificatePhoto(req.params.id);
  if (!photo) return res.status(404).end();
  mediaStorage.serve(res, photo.key, photo.type);
}));

export default { publicRouter, studentRouter, adminRouter };
