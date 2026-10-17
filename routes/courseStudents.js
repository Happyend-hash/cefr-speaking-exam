import express from 'express';
import mongoose from 'mongoose';
import CourseStudent, { LEVELS, SKILLS } from '../models/CourseStudent.js';
import { newParentCode, readPhoto, dashboard } from '../services/ParentPortal.js';
import { authorize } from '../middleware/auth.js';
import { APIError } from '../middleware/errorHandler.js';

/**
 * The teacher's side of the parents' page: the course list, each child's
 * photo, level and parent code, and the six scores of every class test.
 * Mounted at /api/admin/course-students (admins only).
 */
const router = express.Router();
router.use(authorize('admin'));

const isId = id => mongoose.Types.ObjectId.isValid(id);
async function load(id) {
  if (!isId(id)) throw new APIError('Invalid id', 400);
  const s = await CourseStudent.findById(id);
  if (!s) throw new APIError('Student not found', 404);
  return s;
}

/** What the admin list shows for one child (no photo bytes). */
const row = s => {
  const d = dashboard(s);
  return {
    id: String(s._id),
    name: s.name,
    level: s.level,
    parentCode: s.parentCode,
    active: s.active,
    hasPhoto: d.hasPhoto,
    photoVersion: d.photoVersion,
    latest: d.latest,
    overall: d.overall,
    results: d.results,
    lastParentVisit: s.lastParentVisit || null,
    createdAt: s.createdAt
  };
};

const cleanName = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const cleanLevel = v => (LEVELS.includes(v) ? v : null);

router.get('/', async (req, res, next) => {
  try {
    const list = await CourseStudent.find().select('-photo.data').sort({ name: 1 });
    // photo.data is left out of the list; hasPhoto comes from updatedAt instead
    res.json({ success: true, data: { levels: LEVELS, skills: SKILLS, students: list.map(s => ({ ...row(s), hasPhoto: Boolean(s.photo?.updatedAt) })) } });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const name = cleanName(req.body?.name);
    if (!name) throw new APIError('Enter the child’s name', 400);
    const s = await CourseStudent.create({
      name,
      level: cleanLevel(req.body?.level) || 'A1',
      parentCode: await newParentCode(),
      createdBy: req.user.id
    });
    res.status(201).json({ success: true, data: row(s) });
  } catch (error) { next(error); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    if (req.body?.name !== undefined) {
      const name = cleanName(req.body.name);
      if (!name) throw new APIError('Name cannot be empty', 400);
      s.name = name;
    }
    if (req.body?.level !== undefined) {
      const level = cleanLevel(req.body.level);
      if (!level) throw new APIError('Unknown level', 400);
      s.level = level;
    }
    if (req.body?.active !== undefined) s.active = Boolean(req.body.active);
    await s.save();
    res.json({ success: true, data: row(s) });
  } catch (error) { next(error); }
});

/** A new code; phones that remembered the old one are signed out. */
router.post('/:id/code', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    s.parentCode = await newParentCode();
    s.codeVersion = (s.codeVersion || 1) + 1;
    await s.save();
    res.json({ success: true, data: row(s) });
  } catch (error) { next(error); }
});

router.post('/:id/photo', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    let photo;
    try { photo = readPhoto(req.body?.photo); } catch (e) { throw new APIError(e.message, 400); }
    s.photo = { ...photo, updatedAt: new Date() };
    await s.save();
    res.json({ success: true, data: row(s) });
  } catch (error) { next(error); }
});

router.get('/:id/photo', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    if (!s.photo?.data?.length) return res.status(404).end();
    res.set('Content-Type', s.photo.contentType || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(s.photo.data);
  } catch (error) { next(error); }
});

/** One class test: a date, an optional title, the level, and up to six scores (percent). */
router.post('/:id/results', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const b = req.body || {};
    const date = b.date ? new Date(b.date) : new Date();
    if (Number.isNaN(date.getTime())) throw new APIError('Invalid date', 400);
    const skills = {};
    let any = false;
    for (const k of SKILLS) {
      const raw = b.skills?.[k];
      if (raw === undefined || raw === null || raw === '') { skills[k] = null; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new APIError(`${k}: enter a percent from 0 to 100`, 400);
      skills[k] = Math.round(n);
      any = true;
    }
    if (!any) throw new APIError('Enter at least one score', 400);
    s.results.push({
      date,
      title: String(b.title || '').trim().slice(0, 80),
      level: cleanLevel(b.level) || s.level,
      skills
    });
    await s.save();
    res.status(201).json({ success: true, data: row(s) });
  } catch (error) { next(error); }
});

router.delete('/:id/results/:rid', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const r = s.results.id(req.params.rid);
    if (!r) throw new APIError('Test not found', 404);
    r.deleteOne();
    await s.save();
    res.json({ success: true, data: row(s) });
  } catch (error) { next(error); }
});

/** Removing a child removes their photo, scores and code with them. */
router.delete('/:id', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    await s.deleteOne();
    res.json({ success: true, data: { id: req.params.id } });
  } catch (error) { next(error); }
});

export default router;
