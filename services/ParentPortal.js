import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import CourseStudent, { LEVELS, SKILLS } from '../models/CourseStudent.js';

/**
 * The parents' page: sign in with a child's 6-digit code, see their progress.
 *
 * A 6-digit code is short, so guessing is what has to be stopped:
 *   - each address gets MAX_TRIES wrong codes per TRY_WINDOW_MS;
 *   - if wrong codes pour in from everywhere at once (someone trying codes in
 *     bulk), parent sign-in pauses for everyone for GLOBAL_PAUSE_MS.
 * With 200 children that keeps the chance of a stranger finding any code
 * below about one in a thousand per day.
 *
 * "Remember on this phone" keeps the parent signed in for 180 days. Changing
 * a child's code in the admin panel signs out every phone that used the old one.
 */

export const MAX_TRIES = 8;
export const TRY_WINDOW_MS = 15 * 60 * 1000;
export const GLOBAL_MAX_FAILS = 60;
export const GLOBAL_WINDOW_MS = 10 * 60 * 1000;
export const GLOBAL_PAUSE_MS = 15 * 60 * 1000;
export const REMEMBER_DAYS = 180;

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
    { kind: 'parent', sid: String(student._id), v: student.codeVersion || 1 },
    process.env.JWT_SECRET,
    { expiresIn: remember ? `${REMEMBER_DAYS}d` : '12h' }
  );
}

/** Express middleware: a signed-in parent, for a child whose code has not changed. */
export async function parentAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Kod bilan kiring.' });
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    if (claims.kind !== 'parent') throw new Error('not a parent token');
    const student = await CourseStudent.findById(claims.sid);
    if (!student || !student.active || (student.codeVersion || 1) !== claims.v) {
      return res.status(401).json({ success: false, message: 'Kod o‘zgargan yoki o‘chirilgan. Yangi kodni ustozdan so‘rang.' });
    }
    req.student = student;
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

/** Everything the parents' page shows, worked out once on the server. */
export function dashboard(student) {
  const results = [...(student.results || [])]
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map(r => ({
      id: String(r._id),
      date: r.date,
      title: r.title || '',
      level: r.level,
      skills: Object.fromEntries(SKILLS.map(k => [k, typeof r.skills?.[k] === 'number' ? r.skills[k] : null]))
    }));

  // The latest score of each skill, and the one before it (for the arrow).
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
    name: student.name,
    level: student.level,
    levels: LEVELS,
    hasPhoto: Boolean(student.photo?.data?.length),
    photoVersion: student.photo?.updatedAt ? new Date(student.photo.updatedAt).getTime() : 0,
    skills: SKILLS,
    latest,
    previous,
    overall: avg(Object.values(latest)),
    levelsStudied: levels,
    results,
    lastTest: results.length ? results[results.length - 1].date : null
  };
}

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

export default { newParentCode, isWeakCode, signInBlocked, noteWrongCode, noteRightCode, parentToken, parentAuth, dashboard, readPhoto };
