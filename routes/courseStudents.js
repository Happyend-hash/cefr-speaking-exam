import express from 'express';
import mongoose from 'mongoose';
import CourseStudent, { LEVELS, SKILLS, ATTENDANCE } from '../models/CourseStudent.js';
import {
  newParentCode, readPhoto, dashboard, mergeDays, vocabSummary, unitsPerLevel, saveUnitsPerLevel, booksPerLevel, bookChoices, schoolYearOf, paidAhead, leaderboard, monthOf, dayOf, familyOf, attendanceSummary, paymentStatus, paymentHistory, joinedMonth
} from '../services/ParentPortal.js';
import { ensurePeriods, changeTerms, leave, restore, monthRegister, monthsOf, moveStudent, plannedMove, cancelPlannedMove, syncLevel } from '../services/CourseMonths.js';
import { mistakesForUsers } from '../services/VocabMistakes.js';
import { authorize } from '../middleware/auth.js';
import { APIError } from '../middleware/errorHandler.js';
import { sendPaymentReport } from '../services/PaymentReport.js';
import { recordUnitResult, recordGeneralTest } from '../services/CourseVocab.js';
import User from '../models/User.js';

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
const row = (s, units = {}, books = {}, accounts = new Set(), mistakes = new Map()) => {
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
    // which of them came from the homework rather than a roll call
    autoMarks: (s.attendance || []).filter(a => a.auto && a.date >= dayOf(Date.now() - 70 * 864e5)).map(a => a.date),
    monthlyFee: typeof s.monthlyFee === 'number' ? s.monthlyFee : null,
    payment: paymentStatus(s),
    paymentHistory: paymentHistory(s),
    paidAhead: paidAhead(s),
    joinedMonth: joinedMonth(s),
    // the student's time in the course: group and fee from month to month
    periods: (s.periods || []).map(p => ({ from: p.from, to: p.to || null, level: p.level, fee: p.fee ?? null })),
    removedAt: s.removedAt || null,
    leftReason: s.leftReason || '',
    // a move to another group planned for next month: { level, from } or null
    plannedMove: plannedMove(s),
    // vocabulary results of the groups (levels) the student was in before — kept, shown apart
    vocabHistory: [...new Set([...(s.vocab || []).map(r => r.level), ...(s.vocabTests || []).map(t => t.level)])]
      .filter(l => l && l !== s.level)
      .map(l => { const v = vocabSummary(s, units[l], l, books[l]); return { level: l, done: v.overall.done, units: v.overall.units, average: v.overall.average, tracks: v.tracks.map(t => ({ book: t.book?.title || '', done: t.list.filter(u => u.percent !== null).length, units: t.units, average: t.average ?? null })) }; }),
    // every payment ever saved, including ones marked as a mistake — the panel draws the school year from these
    ledger: (s.payments || []).map(p => ({
      id: String(p._id), month: p.month, amount: p.amount, paidAt: p.paidAt, note: p.note || '',
      savedAt: p.createdAt || null, voidedAt: p.voidedAt || null, voidReason: p.voidReason || ''
    })),
    vocab: vocabSummary(s, units[s.level], s.level, books[s.level]),
    accountEmail: s.accountEmail || '',
    accountFound: Boolean(s.accountEmail && accounts.has(s.accountEmail)),
    // "Xatolarim" of the linked account: words still to learn per book, and the hardest ones
    mistakes: (s.accountEmail && mistakes.get(s.accountEmail)) || null,
    lastParentVisit: s.lastParentVisit || null
  };
};

const cleanName = v => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const cleanLevel = v => (LEVELS.includes(v) ? v : null);

/**
 * Students saved before membership periods existed get theirs the first time
 * they are read (from when they joined to when they were removed).
 */
async function withPeriods(list) {
  for (const s of list) {
    const added = ensurePeriods(s);
    // a move planned "from next month" whose month has come
    const moved = syncLevel(s);
    if (added || moved) await CourseStudent.updateOne({ _id: s._id }, { $set: { periods: s.periods, level: s.level, monthlyFee: s.monthlyFee ?? null } });
  }
  return list;
}

async function overview() {
  const list = await withPeriods(await CourseStudent.find({ removedAt: null }).select('-photo.data').sort({ name: 1 }));
  const month = monthOf();
  const units = await unitsPerLevel();
  const books = await booksPerLevel();
  const emails = list.map(s => s.accountEmail).filter(Boolean);
  const users = emails.length ? await User.find({ email: { $in: emails } }).select('email').lean() : [];
  const accounts = new Set(users.map(u => u.email));
  const byUser = await mistakesForUsers(users.map(u => String(u._id)));
  const mistakes = new Map(users.filter(u => byUser.has(String(u._id))).map(u => [u.email, byUser.get(String(u._id))]));
  return {
    levels: LEVELS,
    skills: SKILLS,
    month,
    unitsPerLevel: units,
    schoolYear: schoolYearOf(),
    // several books per level now: { B1: [{ key, title, units }], A1: [] }
    books: Object.fromEntries(Object.entries(books).map(([l, list]) => [l, list.map(b => ({ key: b.key, title: b.title, units: b.units.length }))])),
    bookChoices: bookChoices(),
    students: list.map(s => row(s, units, books, accounts, mistakes)),
    archived: await CourseStudent.countDocuments({ removedAt: { $ne: null } }),
    leaderboards: LEVELS.map(level => leaderboard(list, level, month)).filter(b => b.rows.length)
  };
}

router.get('/', async (req, res, next) => {
  try { res.json({ success: true, data: await overview() }); } catch (error) { next(error); }
});

/**
 * The monthly register (Jamshid, 2026-10-27): every group as it was in one
 * month — including students who have since left — with each one's fee,
 * payment and attendance, and totals per group and overall.
 */
router.get('/months/:ym', async (req, res, next) => {
  try {
    const month = String(req.params.ym || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new APIError('Choose a month', 400);
    const all = await withPeriods(await CourseStudent.find({}).select('name level active monthlyFee payments attendance results periods removedAt leftReason createdAt'));
    res.json({ success: true, data: monthRegister(all, month, { levels: LEVELS }) });
  } catch (error) { next(error); }
});

/** Students who have left: everything kept, month by month, and a way back. */
router.get('/archive', async (req, res, next) => {
  try {
    const list = await withPeriods(await CourseStudent.find({ removedAt: { $ne: null } }).select('-photo.data').sort({ removedAt: -1 }));
    res.json({
      success: true,
      data: {
        schoolYear: schoolYearOf(),
        students: list.map(s => {
          const months = monthsOf(s);
          return {
            ...row(s),
            months,
            totalPaid: months.reduce((a, m) => a + (m.paid || 0), 0),
            owed: months.reduce((a, m) => a + (m.left || 0), 0),
            lastLevel: (s.periods || []).slice(-1)[0]?.level || s.level
          };
        })
      }
    });
  } catch (error) { next(error); }
});

/**
 * Upgrade / downgrade (2026-10-29): move a student to another group (level)
 * from this month or next month. Payments, attendance, homework and
 * vocabulary results all stay on the card; the register keeps earlier months
 * in the old group. `{ cancel: true }` drops a move planned for next month.
 */
router.post('/:id/move', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    if (req.body?.cancel) {
      if (!cancelPlannedMove(s)) throw new APIError('No move is planned for this student', 400);
    } else {
      const level = cleanLevel(req.body?.level);
      if (!level) throw new APIError('Choose the group to move to', 400);
      const month = String(req.body?.month || monthOf());
      if (level === s.level && !plannedMove(s)) throw new APIError(`${s.name} is already in ${level}`, 400);
      try { moveStudent(s, { level, month }); } catch (e) { throw new APIError(e.message, e.statusCode || 400); }
    }
    s.markModified('periods');
    await s.save();
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/** Bring an archived student back: a new period from this month, same card, same parent code. */
router.post('/:id/restore', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    if (!s.removedAt) throw new APIError('This student is already in the course', 400);
    restore(s);
    await s.save();
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
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
    const level = cleanLevel(req.body?.level) || 'A1';
    const doc = { _id, name, level, createdBy: req.user.id, periods: [{ from: monthOf(), to: null, level, fee: null }] };

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
      // a new group from this month; earlier months stay in the old one
      changeTerms(s, { level });
    }
    if (req.body?.active !== undefined) s.active = Boolean(req.body.active);
    if (req.body?.accountEmail !== undefined) {
      const email = String(req.body.accountEmail || '').trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new APIError('Enter the student\u2019s account email, e.g. name@gmail.com', 400);
      if (email) {
        const other = await CourseStudent.findOne({ accountEmail: email, removedAt: null, _id: { $ne: s._id } }).select('name');
        if (other) throw new APIError(`${email} is already linked to ${other.name}`, 409);
      }
      s.accountEmail = email;
    }
    if (req.body?.monthlyFee !== undefined) {
      const fee = req.body.monthlyFee === null || req.body.monthlyFee === '' ? null : Math.round(Number(req.body.monthlyFee));
      if (fee !== null && (!Number.isFinite(fee) || fee < 0 || fee > 100_000_000)) throw new APIError('Enter the monthly fee in so\u2019m', 400);
      // the new fee counts from this month; earlier months keep theirs
      changeTerms(s, { fee });
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
 * Attendance from the homework (Jamshid, 2026-10-24): on a day a group's
 * homework is entered, a child with a result came, and a child without one
 * did not. Written as automatic marks, so the roll call shows them filled in
 * and can still change any of them; a mark from the roll call is never
 * overwritten, except that homework turns "missed" into "came" (late stays
 * late). With no homework left that day (all deleted), the automatic marks go.
 */
export async function attendanceFromHomework(date, level, alsoId = null) {
  const group = await CourseStudent.find({ level, removedAt: null, $or: [{ active: true }, ...(alsoId ? [{ _id: alsoId }] : [])] });
  const hasResult = st => (st.results || []).some(r => dayOf(r.date) === date);
  const lesson = group.some(hasResult);
  for (const st of group) {
    const marks = st.attendance || [];
    const mark = marks.find(a => a.date === date);
    let next;   // undefined = leave as it is, null = remove, else the new mark
    if (!lesson) next = mark?.auto ? null : undefined;
    else if (hasResult(st)) next = !mark || mark.status === 'absent' ? { date, status: 'present', auto: true } : undefined;
    else if (!mark) next = dayOf(st.createdAt || Date.now()) <= date ? { date, status: 'absent', auto: true } : undefined;
    else if (mark.auto && mark.status !== 'absent') next = { date, status: 'absent', auto: true };
    if (next === undefined) continue;
    st.attendance = marks.filter(a => a.date !== date);
    if (next) st.attendance.push(next);
    await st.save();
  }
}

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
    await attendanceFromHomework(day, s.level, s._id);
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
    await attendanceFromHomework(day, s.level, s._id);
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

/** How many vocabulary units each level has: { A1: 20, A2: 24, … }. */
router.put('/settings/units', async (req, res, next) => {
  try {
    try { await saveUnitsPerLevel(req.body || {}); } catch (e) { throw new APIError(e.message, 400); }
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

const cleanDay = v => {
  const d = String(v || dayOf());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new APIError('Choose the date', 400);
  if (d > dayOf(Date.now() + 864e5)) throw new APIError('That date is in the future', 400);
  return d;
};
const cleanPercent = (v, what = 'Result') => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0 || n > 100) throw new APIError(`${what}: enter a percent from 0 to 100`, 400);
  return Math.round(n);
};

/**
 * Which book of the student's level a vocabulary result is for: { book, firstBook, units }.
 * `book` from the request (a pack key); a level without books has numbered units.
 */
async function bookFor(s, key) {
  const list = (await booksPerLevel())[s.level] || [];
  if (!list.length) return { book: null, firstBook: null, units: (await unitsPerLevel())[s.level] };
  const b = key ? list.find(x => x.key === key) : list[0];
  if (!b) throw new APIError('That book is not one of this level’s books', 400);
  return { book: b.key, firstBook: list[0].key, units: b.units.length };
}

/** One unit's vocabulary test: { book, unit, percent, date }. The same unit of the same book on the same day again replaces it. */
router.post('/:id/vocab', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const { book, firstBook, units } = await bookFor(s, req.body?.book);
    const unit = Number(req.body?.unit);
    if (!Number.isInteger(unit) || unit < 1 || unit > units) throw new APIError(`Choose a unit from 1 to ${units}`, 400);
    const percent = cleanPercent(req.body?.percent);
    const date = cleanDay(req.body?.date);
    recordUnitResult(s, { unit, percent, date, via: 'teacher', book, firstBook });
    await s.save();
    res.status(201).json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/**
 * The general test at the end of the units: { date, units: { 1: 80, 2: 65, … } }
 * and/or { percent }. With a result per unit, each of those units gets it as
 * its new current result; with only an overall percent, every unit gets that.
 * Earlier unit results are kept as history. A second general test on the same
 * day replaces the first.
 */
router.post('/:id/vocab/general', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const { book, firstBook, units } = await bookFor(s, req.body?.book);
    const date = cleanDay(req.body?.date);
    const perUnit = {};
    for (const [k, v] of Object.entries(req.body?.units || {})) {
      if (v === '' || v === null || v === undefined) continue;
      const unit = Number(k);
      if (!Number.isInteger(unit) || unit < 1 || unit > units) throw new APIError(`Unit ${k} is not in this level (1–${units})`, 400);
      perUnit[unit] = cleanPercent(v, `Unit ${unit}`);
    }
    const given = Object.values(perUnit);
    const hasOverall = !(req.body?.percent === '' || req.body?.percent === null || req.body?.percent === undefined);
    if (!given.length && !hasOverall) throw new APIError('Enter the general test result: one overall percent, or a percent for each unit', 400);
    const percent = hasOverall ? cleanPercent(req.body.percent, 'Overall result')
      : Math.round(given.reduce((a, b) => a + b, 0) / given.length);

    recordGeneralTest(s, { date, perUnit: given.length ? perUnit : {}, percent, units, via: 'teacher', book, firstBook });
    await s.save();
    res.status(201).json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/** Delete one unit result. */
router.delete('/:id/vocab/:vid', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const r = s.vocab.id(req.params.vid);
    if (!r) throw new APIError('Result not found', 404);
    r.deleteOne();
    await s.save();
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/** Delete a general test, and the unit results it gave. */
router.delete('/:id/vocab-tests/:tid', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const t = s.vocabTests.id(req.params.tid);
    if (!t) throw new APIError('General test not found', 404);
    s.vocab = s.vocab.filter(r => String(r.test || '') !== String(t._id));
    t.deleteOne();
    await s.save();
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/**
 * A payment towards a month (part payments add up). Any month from a year back
 * to two years ahead — students may pay for months still to come.
 */
router.post('/:id/payments', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const month = String(req.body?.month || monthOf());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new APIError('Choose the month', 400);
    const shift = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
    if (month < shift(monthOf(), -24) || month > shift(monthOf(), 24)) throw new APIError('Choose a month within two years', 400);
    const amount = Math.round(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) throw new APIError('Enter the amount paid in so\u2019m', 400);
    const paidAt = req.body?.paidAt ? new Date(req.body.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw new APIError('Invalid payment date', 400);
    if (paidAt.getTime() > Date.now() + 864e5) throw new APIError('The payment date can\u2019t be in the future', 400);
    s.payments.push({ month, amount, paidAt, note: String(req.body?.note || '').trim().slice(0, 80) });
    await s.save();
    res.status(201).json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

/**
 * A payment typed by mistake: kept for ever, shown crossed out with the
 * reason, and no longer counted. (Payments are never deleted.)
 */
router.post('/:id/payments/:pid/void', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    const p = s.payments.id(req.params.pid);
    if (!p) throw new APIError('Payment not found', 404);
    if (p.voidedAt) throw new APIError('Already marked as a mistake', 400);
    const reason = String(req.body?.reason || '').trim().slice(0, 120);
    if (!reason) throw new APIError('Write why this payment is a mistake', 400);
    p.voidedAt = new Date();
    p.voidReason = reason;
    await s.save();
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

router.delete('/:id/payments/:pid', (req, res) => {
  res.status(405).json({ success: false, message: 'Payments are never deleted. Mark it as a mistake instead.' });
});

/** Email the payment report now (the same one that goes out each evening). */
router.post('/payments/report', async (req, res, next) => {
  try {
    const r = await sendPaymentReport({ force: true });
    if (!r.sent) throw new APIError(`The report was not sent: ${r.reason}`, 502);
    res.json({ success: true, data: { to: r.to, counts: r.counts } });
  } catch (error) { next(error); }
});

/**
 * "Remove student": they leave the groups, the parents' page and the ranking
 * and move to the archive — with every month of payments and attendance kept.
 * Their last period ends this month, so they still count in it.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const s = await load(req.params.id);
    if (s.removedAt) throw new APIError('This student is already in the archive', 400);
    leave(s, { reason: req.body?.reason ?? req.query?.reason ?? '' });
    await s.save();
    res.json({ success: true, data: await overview() });
  } catch (error) { next(error); }
});

export default router;
