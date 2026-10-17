import express from 'express';
import CourseStudent from '../models/CourseStudent.js';
import {
  signInBlocked, noteWrongCode, noteRightCode, parentToken, parentAuth, dashboard
} from '../services/ParentPortal.js';

/**
 * The parents' page (public/parent.html). No accounts: a parent signs in
 * with the 6-digit code the teacher gave them and sees that child only.
 */
const router = express.Router();

const ipOf = req => req.ip || req.socket?.remoteAddress || 'unknown';
const minutes = ms => Math.max(1, Math.ceil(ms / 60000));

router.post('/login', async (req, res, next) => {
  try {
    const ip = ipOf(req);
    const blocked = signInBlocked(ip);
    if (blocked.blocked) {
      return res.status(429).json({
        success: false,
        message: `Juda ko‘p noto‘g‘ri urinish. ${minutes(blocked.retryAfterMs)} daqiqadan keyin qayta urinib ko‘ring.`
      });
    }
    const code = String(req.body?.code || '').replace(/\D/g, '');
    const student = code.length === 6 ? await CourseStudent.findOne({ parentCode: code, active: true }) : null;
    if (!student) {
      noteWrongCode(ip);
      return res.status(401).json({ success: false, message: 'Kod noto‘g‘ri. Ustoz bergan 6 xonali kodni tekshiring.' });
    }
    noteRightCode(ip);
    await CourseStudent.updateOne({ _id: student._id }, { $set: { lastParentVisit: new Date() } });
    res.json({ success: true, data: { token: parentToken(student, { remember: req.body?.remember !== false }) } });
  } catch (error) {
    next(error);
  }
});

router.get('/me', parentAuth, (req, res) => {
  res.json({ success: true, data: dashboard(req.student) });
});

router.get('/photo', parentAuth, (req, res) => {
  const photo = req.student.photo;
  if (!photo?.data?.length) return res.status(404).end();
  res.set('Content-Type', photo.contentType || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(photo.data);
});

export default router;
