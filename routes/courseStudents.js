import express from 'express';
import mongoose from 'mongoose';
import CourseStudent, { LEVELS, SKILLS } from '../models/CourseStudent.js';
import { newParentCode, readPhoto, dashboard, leaderboard, monthOf, familyOf } from '../services/ParentPortal.js';
import { authorize } from '../middleware/auth.js';
import { APIError } from '../middleware/errorHandler.js';

/**
 * The teacher's side of the parents' page: the course list by level, each
 * child's photo, level, family and parent code, the homework results of every
 * lesson, and the monthly ranking. Mounted at /api/admin/course-students.
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
    family: familyOf(s),
    parentCode: s.parentCode,
    active: s.active,
    hasPhoto: Boolean(s.photo?.updatedAt),
    photoVersion: d.photoVersion,
    latest: d.latest,
    month: d.month,
    results: d.results,
    lastParentVisit: s.lastParentVisit || null
  };
};

const cleanName = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const cleanLevel = v => (LEVELS.includes(v) ? v : null);

async function overview() {
  const list = await CourseStudent.find().select('-photo.data').sort({ name: 1 });
  const month = monthOf();
  return {
    levels: LEVELS,
    skills: SKILLS,
    month,
    students: list.map(row),
    leaderboards: LEVELS.map(level => leaderboard(list, level, month)).filter(b => b.rows.length)
  };
}

router.get('/', async (req, res, next) => {
  try { res.json({ success: true, data: await overview() }); } catch (error) { next(error); }
});

/**
 * Add a child: name, level, optionally a photo, and optionally "same family
 * as" another child — then they share that child's parent code.
 */
router.post('/', async (req, res, next) => {
  try {
    const name = cleanName(req.body?.name);
    if (!name) throw new APIError('Enter the child’s name', 400);
    const _id = new mongoose.Types.ObjectId();
    const doc = { _id, name, level: cleanLevel(req.body?.level) || 'A1', createdBy: req.user.id };

    if (req.body?.sameFamilyAs) {
      const sibling = await load(req.body.sameFamilyAs);
      if (!sibling.familyId) { sibling.familyId = sibling._id; await sibling.save(); }
      Object.assign(doc, { familyId: sibling.familyId, parentCode: sibling.parentCode, codeVersion: sibling.codeVersion || 1 });
    } else {
      Object.assign(doc, { familyId: _id, parentCode: await newParentCode() });
    }
    if (req.body?.photo) {
      try { doc.photo = { ...readPhoto(req.body.photo), updatedAt: new Date() }; } catch (e) { throw new APIError(e.message, 400); }
    }
    await CourseStudent.create(doc);
    res.status(201).json({ success: true, data: await overview() });
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
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/** Move a child into another child's family (sharing their code), or give them a family of their own. */
router.post('/:id/family', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    if (req.body?.sameFamilyAs) {
      const sibling = await load(req.body.sameFamilyAs);
      if (String(sibling._id) === String(s._id)) throw new APIError('Choose another child', 400);
      if (!sibling.familyId) { sibling.familyId = sibling._id; await sibling.save(); }
      Object.assign(s, { familyId: sibling.familyId, parentCode: sibling.parentCode, codeVersion: sibling.codeVersion || 1 });
    } else {
      Object.assign(s, { familyId: s._id, parentCode: await newParentCode(), codeVersion: (s.codeVersion || 1) + 1 });
    }
    await s.save();
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/** A new code for the whole family; phones that remembered the old one are signed out. */
router.post('/:id/code', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const family = familyOf(s);
    const members = await CourseStudent.find({ $or: [{ familyId: family }, { _id: family }] }).select('codeVersion familyId');
    const version = Math.max(...members.map(m => m.codeVersion || 1)) + 1;
    const code = await newParentCode();
    await CourseStudent.updateMany(
      { _id: { $in: members.map(m => m._id) } },
      { $set: { parentCode: code, codeVersion: version, familyId: family } }
    );
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

router.post('/:id/photo', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    let photo;
    try { photo = readPhoto(req.body?.photo); } catch (e) { throw new APIError(e.message, 400); }
    s.photo = { ...photo, updatedAt: new Date() };
    await s.save();
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

router.delete('/:id/photo', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    s.photo = undefined;
    await s.save();
    res.json({ success: true, data: await overview() });
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

/** One homework: a date (today by default), an optional title, and a percent for each type given. */
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
    if (!any) throw new APIError('Choose at least one homework type and enter its percent', 400);
    s.results.push({ date, title: String(b.title || '').trim().slice(0, 80), level: cleanLevel(b.level) || s.level, skills });
    await s.save();
    res.status(201).json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

router.delete('/:id/results/:rid', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const r = s.results.id(req.params.rid);
    if (!r) throw new APIError('Homework not found', 404);
    r.deleteOne();
    await s.save();
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/** Removing a child removes their photo and results with them. Brothers and sisters keep the family code. */
router.delete('/:id', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    await s.deleteOne();
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

export default router;
