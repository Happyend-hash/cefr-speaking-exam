import ExamResult from '../models/ExamResult.js';
import CourseStudent from '../models/CourseStudent.js';
import User from '../models/User.js';
import { monthOf } from './ParentPortal.js';

/**
 * Speaking mocks in the teacher's course panel (Jamshid, 2026-11-10).
 *
 * A course student linked to a website account (accountEmail) has every
 * speaking attempt that account hands in recorded on their card, the way
 * vocabulary results are: each mock with its latest score, the score before
 * it, and every attempt. The record lives on the CourseStudent, so it stays
 * when the student deletes an attempt on the website, and it is refreshed from
 * the attempts themselves whenever the panel loads, so a re-mark or an expert
 * review shows up too.
 */

/** Attempts that count: handed in. Open or cancelled ones never show. */
const HANDED_IN = ['submitted', 'evaluating', 'completed'];
/** The most kept per student, newest first. */
const KEEP = 300;
const BAND_KEYS = ['part11', 'part12', 'part2', 'part3'];

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One attempt as the course card keeps it. */
export function snapshotOf(r) {
  const bands = {};
  for (const k of BAND_KEYS) if (num(r.partBands?.[k]) !== null) bands[k] = r.partBands[k];
  return {
    result: r._id,
    user: r.student?._id || r.student || null,
    exam: r.exam?._id || r.exam || null,
    title: r.exam?.title || r.title || '',
    mode: r.mode === 'practice' ? 'practice' : 'mock',
    part: r.part || '',
    status: r.status === 'completed' ? 'completed' : 'marking',
    score: num(r.overallScore),
    level: r.overallLevel || '',
    bands,
    expert: Boolean(r.expertReview?.at),
    at: r.submittedAt || r.completedAt || r.createdAt || new Date(),
    deletedAt: null
  };
}

const same = (a, b) => JSON.stringify([a.title, a.status, a.score, a.level, a.bands || {}, a.expert, a.mode, a.part, String(a.exam || ''), String(a.user || '')])
  === JSON.stringify([b.title, b.status, b.score, b.level, b.bands || {}, b.expert, b.mode, b.part, String(b.exam || ''), String(b.user || '')]);

const plain = e => (typeof e?.toObject === 'function' ? e.toObject() : { ...e });

/**
 * The card's record brought up to date with the account's attempts as they
 * are now. Attempts that are gone from the website stay (they were deleted
 * there) — unless they belonged to another account, from before the teacher
 * linked this student to a different Gmail.
 * Returns { list, changed }.
 */
export function mergeSpeaking(current = [], snaps = [], userId = null) {
  const now = new Map(snaps.map(s => [String(s.result), s]));
  const seen = new Set();
  let changed = false;
  const list = [];
  for (const raw of current) {
    const e = plain(raw);
    const id = String(e.result);
    seen.add(id);
    const fresh = now.get(id);
    if (fresh) {
      if (!same(e, fresh) || e.deletedAt) changed = true;
      list.push({ ...fresh, at: e.at || fresh.at });
    } else if (userId && e.user && String(e.user) !== String(userId)) {
      changed = true; // another account's attempt: dropped
    } else {
      list.push(e); // deleted on the website (or not yet seen again): kept as it was
    }
  }
  for (const s of snaps) {
    if (!seen.has(String(s.result))) { list.push(s); changed = true; }
  }
  list.sort((a, b) => new Date(b.at) - new Date(a.at));
  if (list.length > KEEP) { list.length = KEEP; changed = true; }
  return { list, changed };
}

/**
 * What the panel shows: every full mock with its latest attempt and the score
 * before it, counts (all time and this month), the best score, the scores in
 * the order they came, and part practice in short.
 */
export function speakingSummary(entries = [], month = monthOf()) {
  const list = entries.map(plain).map(e => ({
    id: String(e.result),
    exam: e.exam ? String(e.exam) : '',
    title: e.title || 'Speaking mock',
    mode: e.mode === 'practice' ? 'practice' : 'mock',
    part: e.part || '',
    status: e.status === 'completed' ? 'completed' : 'marking',
    score: num(e.score),
    level: e.level || '',
    bands: e.bands ? Object.fromEntries(BAND_KEYS.filter(k => num(e.bands[k]) !== null).map(k => [k, e.bands[k]])) : {},
    expert: Boolean(e.expert),
    at: e.at ? new Date(e.at).toISOString() : null,
    deleted: Boolean(e.deletedAt)
  })).sort((a, b) => new Date(b.at) - new Date(a.at));

  const mocks = list.filter(e => e.mode === 'mock');
  const practice = list.filter(e => e.mode === 'practice');
  const inMonth = e => e.at && monthOf(e.at) === month;

  const byExam = new Map();
  for (const e of mocks) {
    const key = e.exam || e.title;
    if (!byExam.has(key)) byExam.set(key, { exam: e.exam, title: e.title, attempts: [] });
    byExam.get(key).attempts.push(e);
  }
  const perMock = [...byExam.values()].map(m => {
    const latest = m.attempts[0];
    const scored = m.attempts.filter(a => a.score !== null);
    // the score this one replaced: the newest scored attempt before the latest scored one
    const current = scored[0] || null;
    const previous = current ? scored.find(a => a !== current) || null : null;
    return {
      exam: m.exam,
      title: m.title,
      latest,
      current: current ? { score: current.score, level: current.level } : null,
      previous: previous ? { score: previous.score, level: previous.level } : null,
      attempts: m.attempts
    };
  });

  const scoredMocks = mocks.filter(e => e.score !== null);
  const best = scoredMocks.reduce((b, e) => (!b || e.score > b.score ? e : b), null);
  const latestScored = scoredMocks[0] || null;

  return {
    submitted: mocks.length,
    thisMonth: mocks.filter(inMonth).length,
    mocksTaken: perMock.length,
    marking: mocks.filter(e => e.status === 'marking').length,
    latest: mocks[0] || null,
    latestScore: latestScored ? { score: latestScored.score, level: latestScored.level, title: latestScored.title, at: latestScored.at } : null,
    best: best ? { score: best.score, level: best.level, title: best.title } : null,
    // oldest first, the last twelve: how the score has moved
    progress: [...scoredMocks].reverse().slice(-12).map(e => ({ score: e.score, level: e.level, title: e.title, at: e.at })),
    mocks: perMock,
    practice: {
      count: practice.length,
      thisMonth: practice.filter(inMonth).length,
      recent: practice.slice(0, 8)
    }
  };
}

/**
 * Bring every given course student's record up to date with their linked
 * account's attempts. `users` maps an email to the account's id. Saves only
 * the students whose record changed.
 */
export async function syncCourseSpeaking(students, users) {
  const linked = students.filter(s => s.accountEmail && users.has(s.accountEmail));
  if (!linked.length) return;
  const ids = [...new Set(linked.map(s => String(users.get(s.accountEmail))))];
  const results = await ExamResult.find({ student: { $in: ids }, status: { $in: HANDED_IN }, module: { $ne: 'writing' } })
    .select('student exam mode part status overallScore overallLevel partBands expertReview submittedAt completedAt createdAt')
    .populate('exam', 'title')
    .lean();
  const byUser = new Map();
  for (const r of results) {
    const k = String(r.student);
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push(snapshotOf(r));
  }
  for (const s of linked) {
    const userId = String(users.get(s.accountEmail));
    const { list, changed } = mergeSpeaking(s.speaking || [], byUser.get(userId) || [], userId);
    if (!changed) continue;
    s.speaking = list;
    await CourseStudent.updateOne({ _id: s._id }, { $set: { speaking: list } });
  }
}

/**
 * Before an attempt is deleted on the website: make sure the teacher's record
 * has it, marked as deleted by the student. Never throws — deleting must not
 * fail because of the course card.
 */
export async function keepBeforeDelete(result) {
  try {
    if (!result || !HANDED_IN.includes(result.status) || result.module === 'writing') return;
    const user = await User.findById(result.student).select('email').lean();
    if (!user?.email) return;
    const students = await CourseStudent.find({ accountEmail: user.email }).select('speaking');
    if (!students.length) return;
    const populated = result.exam?.title ? result : await ExamResult.populate(
      typeof result.toObject === 'function' ? result.toObject() : result, { path: 'exam', select: 'title' }
    );
    const snap = { ...snapshotOf(populated), deletedAt: new Date() };
    for (const s of students) {
      const list = (s.speaking || []).map(plain).filter(e => String(e.result) !== String(snap.result));
      const old = (s.speaking || []).map(plain).find(e => String(e.result) === String(snap.result));
      list.push({ ...snap, at: old?.at || snap.at });
      list.sort((a, b) => new Date(b.at) - new Date(a.at));
      await CourseStudent.updateOne({ _id: s._id }, { $set: { speaking: list.slice(0, KEEP) } });
    }
  } catch (error) {
    console.error('Course speaking record before delete:', error.message);
  }
}

export default { snapshotOf, mergeSpeaking, speakingSummary, syncCourseSpeaking, keepBeforeDelete };
