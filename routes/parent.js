import express from 'express';
import CourseStudent from '../models/CourseStudent.js';
import {
  signInBlocked, noteWrongCode, noteRightCode, parentToken, parentAuth, dashboard, childCard, leaderboard, monthOf, vocabSummary, unitsPerLevel
} from '../services/ParentPortal.js';

/**
 * The parents' page (public/parent.html). No accounts: a parent signs in
 * with the family's 6-digit code and sees their own children only — plus the
 * monthly ranking of each child's level (names, levels and percents).
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
    const student = code.length === 6 ? await CourseStudent.findOne({ parentCode: code, active: true, removedAt: null }).select('familyId codeVersion') : null;
    if (!student) {
      noteWrongCode(ip);
      return res.status(401).json({ success: false, message: 'Kod noto‘g‘ri. Ustoz bergan 6 xonali kodni tekshiring.' });
    }
    noteRightCode(ip);
    await CourseStudent.updateMany({ parentCode: code }, { $set: { lastParentVisit: new Date() } });
    res.json({ success: true, data: { token: parentToken(student, { remember: req.body?.remember !== false }) } });
  } catch (error) {
    next(error);
  }
});

/** The family's children: one card each. */
router.get('/children', parentAuth, (req, res) => {
  res.json({ success: true, data: { children: req.children.map(childCard) } });
});

const mine = (req, id) => req.children.find(c => String(c._id) === String(id));

/** One child's page, with this month's ranking of their level. */
router.get('/children/:id', parentAuth, async (req, res, next) => {
  try {
    const child = mine(req, req.params.id);
    if (!child) return res.status(404).json({ success: false, message: 'Topilmadi.' });
    const sameLevel = await CourseStudent.find({ active: true, removedAt: null, level: child.level }).select('name level active results');
    const board = leaderboard(sameLevel, child.level, monthOf());
    const family = new Set(req.children.map(c => String(c._id)));
    res.json({
      success: true,
      data: {
        ...dashboard(child),
        vocab: vocabSummary(child, (await unitsPerLevel())[child.level]),
        leaderboard: { ...board, rows: board.rows.map(({ id, ...r }) => ({ ...r, mine: family.has(id), self: id === String(child._id) })) }
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get('/children/:id/photo', parentAuth, async (req, res, next) => {
  try {
    if (!mine(req, req.params.id)) return res.status(404).end();
    const child = await CourseStudent.findById(req.params.id).select('photo');
    if (!child?.photo?.data?.length) return res.status(404).end();
    res.set('Content-Type', child.photo.contentType || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(child.photo.data);
  } catch (error) {
    next(error);
  }
});

export default router;
