import express from 'express';
import mongoose from 'mongoose';
import CourseStudent, { LEVELS, SKILLS, ATTENDANCE } from '../models/CourseStudent.js';
import {
  newParentCode, readPhoto, dashboard, mergeDays, leaderboard, monthOf, dayOf, familyOf, attendanceSummary, paymentStatus, paymentHistory
} from '../services/ParentPortal.js';
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
    attendance: attendanceSummary(s),
    // the marks of the last 70 days, so a roll call for an earlier date opens filled in
    marks: Object.fromEntries((s.attendance || []).filter(a => a.date >= dayOf(Date.now() - 70 * 864e5)).map(a => [a.date, a.status])),
    monthlyFee: typeof s.monthlyFee === 'number' ? s.monthlyFee : null,
    payment: paymentStatus(s),
    paymentHistory: paymentHistory(s),
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
    if (req.body?.monthlyFee !== undefined) {
      const fee = req.body.monthlyFee === null || req.body.monthlyFee === '' ? null : Math.round(Number(req.body.monthlyFee));
      if (fee !== null && (!Number.isFinite(fee) || fee < 0 || fee > 100_000_000)) throw new APIError('Enter the monthly fee in so\u2019m', 400);
      s.monthlyFee = fee;
    }
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

/**
 * The homework of one day: a date (today by default), an optional note, and a
 * percent for each type given. A day has ONE result: saving the same day again
 * updates it (types left empty keep their earlier value; with replace: true the
 * form's values are taken as they are, so a type can also be taken off).
 */
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

    const day = dayOf(date);
    const sameDay = s.results.filter(r => dayOf(r.date) === day);
    const title = String(b.title ?? '').trim().slice(0, 80);
    const level = cleanLevel(b.level) || s.level;
    if (!sameDay.length) {
      s.results.push({ date, title, level, skills });
    } else {
      // join what was already saved that day (older saves may be split in several), then apply this save
      const [before] = mergeDays(sameDay);
      const keep = s.results.id(before.id) || sameDay[0];
      const merged = b.replace ? skills : Object.fromEntries(SKILLS.map(k => [k, skills[k] ?? before.skills[k]]));
      keep.set({ skills: merged, level, title: b.replace || title ? title : before.title });
      for (const r of sameDay) if (String(r._id) !== String(keep._id)) r.deleteOne();
    }
    await s.save();
    res.status(sameDay.length ? 200 : 201).json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/** Delete one day's homework (all of it, if it was saved in several goes). */
router.delete('/:id/results/:rid', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const r = s.results.id(req.params.rid);
    if (!r) throw new APIError('Homework not found', 404);
    const day = dayOf(r.date);
    s.results.filter(x => dayOf(x.date) === day).forEach(x => x.deleteOne());
    await s.save();
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/**
 * Attendance for one level on one day (the roll call): { date, level,
 * marks: { studentId: 'present' | 'late' | 'absent' } }. Saving the same day
 * again replaces it.
 */
router.post('/attendance', async (req, res, next) => {
  try {
    const date = String(req.body?.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new APIError('Choose the lesson date', 400);
    if (date > dayOf(Date.now() + 864e5)) throw new APIError('That date is in the future', 400);
    const marks = req.body?.marks || {};
    const ids = Object.keys(marks).filter(isId);
    if (!ids.length) throw new APIError('No students to mark', 400);
    for (const id of ids) if (!ATTENDANCE.includes(marks[id])) throw new APIError('Unknown attendance mark', 400);
    const students = await CourseStudent.find({ _id: { $in: ids } });
    for (const s of students) {
      s.attendance = (s.attendance || []).filter(a => a.date !== date);
      s.attendance.push({ date, status: marks[String(s._id)] });
      await s.save();
    }
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/** "No lesson that day after all": remove one day's marks for a level. */
router.delete('/attendance', async (req, res, next) => {
  try {
    const date = String(req.query?.date || '');
    const level = cleanLevel(req.query?.level);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !level) throw new APIError('Choose the date and level', 400);
    await CourseStudent.updateMany({ level }, { $pull: { attendance: { date } } });
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/** A payment towards a month (part payments add up). */
router.post('/:id/payments', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const month = String(req.body?.month || monthOf());
    if (!/^\d{4}-\d{2}$/.test(month)) throw new APIError('Choose the month', 400);
    const amount = Math.round(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) throw new APIError('Enter the amount paid in so\u2019m', 400);
    const paidAt = req.body?.paidAt ? new Date(req.body.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw new APIError('Invalid payment date', 400);
    s.payments.push({ month, amount, paidAt, note: String(req.body?.note || '').trim().slice(0, 80) });
    await s.save();
    res.status(201).json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

router.delete('/:id/payments/:pid', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const p = s.payments.id(req.params.pid);
    if (!p) throw new APIError('Payment not found', 404);
    p.deleteOne();
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
