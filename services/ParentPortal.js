import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import CourseStudent, { LEVELS, SKILLS } from '../models/CourseStudent.js';

/**
 * The parents' page: sign in with the family's 6-digit code, see the
 * children, their homework results, and the monthly ranking of their level.
 *
 * A 6-digit code is short, so guessing is what has to be stopped:
 *   - each address gets MAX_TRIES wrong codes per TRY_WINDOW_MS;
 *   - if wrong codes pour in from everywhere at once (someone trying codes in
 *     bulk), parent sign-in pauses for everyone for GLOBAL_PAUSE_MS.
 *
 * "Remember on this phone" keeps the parent signed in for 180 days. Changing
 * a family's code in the admin panel signs out every phone that used the old one.
 *
 * The ranking (Jamshid's choice, 2026-10-17): per level, this month only
 * (Tashkent time), by the average of every homework percent entered this
 * month. Parents see the whole ranking of their child's level.
 */

export const MAX_TRIES = 8;
export const TRY_WINDOW_MS = 15 * 60 * 1000;
export const GLOBAL_MAX_FAILS = 60;
export const GLOBAL_WINDOW_MS = 10 * 60 * 1000;
export const GLOBAL_PAUSE_MS = 15 * 60 * 1000;
export const REMEMBER_DAYS = 180;

const TZ_MS = 5 * 60 * 60 * 1000;
/** "2026-10" for a moment, in Tashkent time. */
export const monthOf = (when = Date.now()) => new Date(new Date(when).getTime() + TZ_MS).toISOString().slice(0, 7);

/** "2026-10-17" for a moment, in Tashkent time. */
export const dayOf = (when = Date.now()) => new Date(new Date(when).getTime() + TZ_MS).toISOString().slice(0, 10);

/** Payment is expected by this day of the month; after it, parents see the red message. */
export const PAYMENT_DUE_DAY = 10;

/** The family a child belongs to (their own id when added alone). */
export const familyOf = s => String(s.familyId || s._id);

// ------------------------------------------------------------------ codes

/** Codes nobody should get: all one digit, or a run like 123456. */
export function isWeakCode(code) {
  if (/^(\d)\1{5}$/.test(code)) return true;
  const runs = ['0123456789', '9876543210'];
  return runs.some(r => r.includes(code));
}

export async function newParentCode({ exists = async code => Boolean(await CourseStudent.exists({ parentCode: code })) } = {}) {
  for (let i = 0; i < 50; i += 1) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (isWeakCode(code)) continue;
    if (!(await exists(code))) return code;
  }
  throw new Error('Could not find a free parent code');
}

// ----------------------------------------------------------- guessing guard

const tries = new Map();          // ip -> [timestamps of wrong codes]
let globalFails = [];
let pausedUntil = 0;

export function signInBlocked(ip, now = Date.now()) {
  if (now < pausedUntil) return { blocked: true, retryAfterMs: pausedUntil - now, everyone: true };
  const mine = (tries.get(ip) || []).filter(t => now - t < TRY_WINDOW_MS);
  if (mine.length >= MAX_TRIES) return { blocked: true, retryAfterMs: TRY_WINDOW_MS - (now - mine[0]) };
  return { blocked: false };
}

export function noteWrongCode(ip, now = Date.now()) {
  const mine = (tries.get(ip) || []).filter(t => now - t < TRY_WINDOW_MS);
  mine.push(now);
  tries.set(ip, mine);
  globalFails = globalFails.filter(t => now - t < GLOBAL_WINDOW_MS);
  globalFails.push(now);
  if (globalFails.length >= GLOBAL_MAX_FAILS) {
    pausedUntil = now + GLOBAL_PAUSE_MS;
    globalFails = [];
    console.warn(`Parent sign-in paused for ${GLOBAL_PAUSE_MS / 60000} min: too many wrong codes at once`);
  }
  if (tries.size > 5000) for (const [k, v] of tries) if (!v.some(t => now - t < TRY_WINDOW_MS)) tries.delete(k);
}

export function noteRightCode(ip) { tries.delete(ip); }

export const _guard = { reset() { tries.clear(); globalFails = []; pausedUntil = 0; } };

// ------------------------------------------------------------------ tokens

export function parentToken(student, { remember = true } = {}) {
  return jwt.sign(
    { kind: 'parent', fam: familyOf(student), v: student.codeVersion || 1 },
    process.env.JWT_SECRET,
    { expiresIn: remember ? `${REMEMBER_DAYS}d` : '12h' }
  );
}

/** The active children of a family. */
export function familyChildren(family) {
  return CourseStudent.find({ active: true, $or: [{ familyId: family }, { _id: family, familyId: null }] }).sort({ name: 1 });
}

/**
 * Express middleware: a signed-in parent whose family code has not changed.
 * Sets req.children (the family's active children).
 */
export async function parentAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Kod bilan kiring.' });
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    if (claims.kind !== 'parent') throw new Error('not a parent token');
    // Phones signed in before families existed carry one child's id.
    let family = claims.fam;
    if (!family && claims.sid) {
      const one = await CourseStudent.findById(claims.sid).select('familyId');
      family = one ? familyOf(one) : null;
    }
    const children = family ? await familyChildren(family) : [];
    if (!children.length || children.some(c => (c.codeVersion || 1) !== claims.v)) {
      return res.status(401).json({ success: false, message: 'Kod o‘zgargan yoki o‘chirilgan. Yangi kodni ustozdan so‘rang.' });
    }
    req.children = children;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Qaytadan kiring.' });
  }
}

// ---------------------------------------------------------------- the page

const avg = values => {
  const v = values.filter(x => typeof x === 'number');
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

const sortedResults = student => [...(student.results || [])]
  .sort((a, b) => new Date(a.date) - new Date(b.date))
  .map(r => ({
    id: String(r._id),
    date: r.date,
    title: r.title || '',
    level: r.level,
    skills: Object.fromEntries(SKILLS.map(k => [k, typeof r.skills?.[k] === 'number' ? r.skills[k] : null]))
  }));

/** A child's average of every homework percent in one month (null if none), and how many homeworks. */
export function monthAverage(student, month = monthOf()) {
  const inMonth = sortedResults(student).filter(r => monthOf(r.date) === month);
  const values = inMonth.flatMap(r => SKILLS.map(k => r.skills[k])).filter(v => v !== null);
  return {
    percent: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null,
    homeworks: inMonth.length
  };
}

/**
 * The ranking of one level for one month: highest average first. Equal
 * averages share a place (1, 1, 3). Children with no homework this month are
 * listed after, without a place.
 */
export function leaderboard(students, level, month = monthOf()) {
  const rows = students
    .filter(s => s.active !== false && s.level === level)
    .map(s => ({ id: String(s._id), name: s.name, level: s.level, ...monthAverage(s, month) }));
  const ranked = rows.filter(r => r.percent !== null).sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name));
  let place = 0;
  ranked.forEach((r, i) => {
    if (i === 0 || r.percent !== ranked[i - 1].percent) place = i + 1;
    r.rank = place;
  });
  const unranked = rows.filter(r => r.percent === null).sort((a, b) => a.name.localeCompare(b.name)).map(r => ({ ...r, rank: null }));
  return { level, month, rows: [...ranked, ...unranked] };
}

/** Everything one child's page shows, worked out once on the server. */
export function dashboard(student) {
  const results = sortedResults(student);

  // The latest score of each type, and the one before it (for the arrow).
  const latest = {};
  const previous = {};
  for (const k of SKILLS) {
    const scored = results.filter(r => r.skills[k] !== null);
    latest[k] = scored.length ? scored[scored.length - 1].skills[k] : null;
    previous[k] = scored.length > 1 ? scored[scored.length - 2].skills[k] : null;
  }

  // Averages at each level she or he has studied: "level to level".
  const levels = LEVELS.filter(l => results.some(r => r.level === l)).map(level => {
    const at = results.filter(r => r.level === level);
    const skills = Object.fromEntries(SKILLS.map(k => [k, avg(at.map(r => r.skills[k]))]));
    return { level, tests: at.length, skills, overall: avg(Object.values(skills)) };
  });

  return {
    id: String(student._id),
    name: student.name,
    level: student.level,
    levels: LEVELS,
    hasPhoto: Boolean(student.photo?.data?.length || student.photo?.updatedAt),
    photoVersion: student.photo?.updatedAt ? new Date(student.photo.updatedAt).getTime() : 0,
    skills: SKILLS,
    latest,
    previous,
    overall: avg(Object.values(latest)),
    month: monthAverage(student),
    attendance: attendanceSummary(student),
    attendanceHistory: attendanceHistory(student),
    payment: paymentStatus(student),
    paymentHistory: paymentHistory(student),
    levelsStudied: levels,
    results,
    lastTest: results.length ? results[results.length - 1].date : null
  };
}

// --------------------------------------------------------- attendance

/** One month of attendance: the counts, each lesson day, and the days missed or late. */
export function attendanceSummary(student, month = monthOf()) {
  const days = (student.attendance || [])
    .filter(a => a.date.startsWith(month))
    .map(a => ({ date: a.date, status: a.status }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const count = st => days.filter(d => d.status === st).length;
  const present = count('present'), late = count('late'), absent = count('absent');
  return {
    month,
    lessons: days.length,
    present,
    late,
    absent,
    attended: present + late,
    percent: days.length ? Math.round(((present + late) / days.length) * 100) : null,
    days,
    missed: days.filter(d => d.status === 'absent').map(d => d.date),
    lateDays: days.filter(d => d.status === 'late').map(d => d.date)
  };
}

/** The last few months of attendance, newest first (for "previous months"). */
export function attendanceHistory(student, months = 4, now = Date.now()) {
  const out = [];
  const [y, m] = monthOf(now).split('-').map(Number);
  for (let i = 1; i <= months; i += 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = d.toISOString().slice(0, 7);
    const sum = attendanceSummary(student, key);
    if (sum.lessons) out.push({ month: key, lessons: sum.lessons, attended: sum.attended, late: sum.late, absent: sum.absent, percent: sum.percent });
  }
  return out;
}

// ------------------------------------------------------------ payment

/**
 * One month's payment:
 *   paid     — paid in full (or any amount when no fee is set)
 *   partial  — part of the fee paid
 *   due      — nothing yet, but before the due day (a gentle reminder)
 *   overdue  — nothing (or only part) after the due day: the red message
 */
export function paymentStatus(student, month = monthOf(), now = Date.now()) {
  const list = (student.payments || []).filter(p => p.month === month);
  const paid = list.reduce((sum, p) => sum + (p.amount || 0), 0);
  const fee = typeof student.monthlyFee === 'number' && student.monthlyFee > 0 ? student.monthlyFee : null;
  const current = month === monthOf(now);
  const day = Number(dayOf(now).slice(8, 10));
  const pastDue = !current || day > PAYMENT_DUE_DAY;   // an earlier month is always past due
  let status;
  if (paid > 0 && (fee === null || paid >= fee)) status = 'paid';
  else if (paid > 0) status = 'partial';
  else status = 'due';
  const overdue = status !== 'paid' && pastDue;
  const last = list.reduce((a, p) => (!a || new Date(p.paidAt) > new Date(a.paidAt) ? p : a), null);
  return {
    month,
    fee,
    paid,
    left: fee !== null ? Math.max(0, fee - paid) : null,
    status: overdue && status === 'due' ? 'overdue' : status,
    overdue,
    dueDay: PAYMENT_DUE_DAY,
    lastPaidAt: last ? last.paidAt : null,
    payments: list.map(p => ({ id: String(p._id), amount: p.amount, paidAt: p.paidAt, note: p.note || '' }))
  };
}

/** The last few months of payments, newest first, from the month the child was added. */
export function paymentHistory(student, months = 6, now = Date.now()) {
  const out = [];
  const [y, m] = monthOf(now).split('-').map(Number);
  const since = student.createdAt ? monthOf(student.createdAt) : '0000-00';
  for (let i = 1; i <= months; i += 1) {
    const key = new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7);
    if (key < since) break;
    const p = paymentStatus(student, key, now);
    out.push({ month: key, status: p.status, paid: p.paid, fee: p.fee });
  }
  return out;
}

/** The short card of a child in the family list. */
export const childCard = s => ({
  id: String(s._id),
  name: s.name,
  level: s.level,
  payment: (({ status, month }) => ({ status, month }))(paymentStatus(s)),
  hasPhoto: Boolean(s.photo?.data?.length || s.photo?.updatedAt),
  photoVersion: s.photo?.updatedAt ? new Date(s.photo.updatedAt).getTime() : 0
});

// ------------------------------------------------------------------ photos

/** A photo arrives as a data: URL (already resized in the browser). */
export function readPhoto(dataUrl) {
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Photo must be a JPEG, PNG or WebP image');
  const data = Buffer.from(m[3], 'base64');
  if (data.length > 600 * 1024) throw new Error('Photo is too large (max 600 KB after resizing)');
  const isJpeg = data[0] === 0xff && data[1] === 0xd8;
  const isPng = data.slice(0, 4).toString('hex') === '89504e47';
  const isWebp = data.slice(0, 4).toString() === 'RIFF' && data.slice(8, 12).toString() === 'WEBP';
  if (!(isJpeg || isPng || isWebp)) throw new Error('That file is not an image');
  return { data, contentType: m[1] };
}

export default {
  newParentCode, isWeakCode, signInBlocked, noteWrongCode, noteRightCode, parentToken, parentAuth,
  familyChildren, familyOf, dashboard, childCard, leaderboard, monthAverage, monthOf, dayOf, readPhoto,
  attendanceSummary, attendanceHistory, paymentStatus, paymentHistory, PAYMENT_DUE_DAY
};
