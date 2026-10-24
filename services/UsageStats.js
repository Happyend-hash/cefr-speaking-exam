import DailyActivity from '../models/DailyActivity.js';
import User from '../models/User.js';
import ExamResult from '../models/ExamResult.js';
import WritingAttempt from '../models/WritingAttempt.js';
import ChatMessage from '../models/ChatMessage.js';

/**
 * How many people use the website each day — for the admin panel.
 *
 * Every signed-in request goes through `authenticate`, which calls noteUser().
 * Guests (the site open, nobody signed in) send one small ping per day from
 * the browser, which calls noteGuest().
 *
 * Writes are cheap on purpose: a person is written at most once per hour of
 * the day (the in-memory `seen` set), however many requests they make.
 * "Online now" is kept only in memory: it is a live figure, not history.
 *
 * Days and hours are Tashkent time (UTC+5, no daylight saving).
 */

const TZ_MS = 5 * 60 * 60 * 1000;
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;
export const HISTORY_DAYS = 30;

export const dayOf = (ms = Date.now()) => new Date(ms + TZ_MS).toISOString().slice(0, 10);
export const hourOf = (ms = Date.now()) => new Date(ms + TZ_MS).getUTCHours();
/** The UTC moment a Tashkent day starts. */
export const dayStart = day => new Date(Date.parse(`${day}T00:00:00Z`) - TZ_MS);
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const seen = new Set();          // "day|hour|key" already written
const lastSeen = new Map();      // userId -> ms, for "online now"

function forgetOld(now) {
  // At most a few thousand entries a day; drop everything not from this hour.
  const prefix = `${dayOf(now)}|${hourOf(now)}|`;
  if (seen.size > 5000) for (const k of seen) if (!k.startsWith(prefix)) seen.delete(k);
  if (lastSeen.size > 2000) {
    for (const [id, at] of lastSeen) if (now - at > ONLINE_WINDOW_MS) lastSeen.delete(id);
  }
}

async function note(key, kind, user, now) {
  const day = dayOf(now);
  const hour = hourOf(now);
  const mark = `${day}|${hour}|${key}`;
  if (seen.has(mark)) return false;
  seen.add(mark);
  forgetOld(now);
  try {
    await DailyActivity.updateOne(
      { day, key },
      {
        $setOnInsert: { kind, ...(user ? { user } : {}), first: new Date(now) },
        $addToSet: { hours: hour },
        $set: { last: new Date(now) }
      },
      { upsert: true }
    );
  } catch (error) {
    seen.delete(mark);
    // Two requests racing to insert the same row: the other one won. Fine.
    if (error.code !== 11000) console.error('Usage stats:', error.message);
  }
  return true;
}

/** A signed-in request. Never throws, never slows the request down. */
export function noteUser(userId, now = Date.now()) {
  if (!userId) return;
  const id = String(userId);
  lastSeen.set(id, now);
  note(`u:${id}`, 'user', id, now).catch(() => {});
}

/** A browser that opened the site without signing in. */
export function noteGuest(visitorId, now = Date.now()) {
  if (typeof visitorId !== 'string' || !/^[a-zA-Z0-9-]{8,40}$/.test(visitorId)) return false;
  const id = visitorId;
  note(`g:${id}`, 'guest', null, now).catch(() => {});
  return true;
}

export function onlineNow(now = Date.now()) {
  let n = 0;
  for (const at of lastSeen.values()) if (now - at <= ONLINE_WINDOW_MS) n += 1;
  return n;
}

// ------------------------------------------------------------------ report

let estimateCache = { at: 0, key: '', days: {} };

/**
 * Before tracking started there are no visit records, so for those days the
 * chart shows an estimate: the students who did something that left a record
 * (a speaking mock, a writing check, a chat message). It undercounts people
 * who only looked around. Past days never change, so this is cached.
 */
async function estimatedDays(fromDay, toDay) {
  const cacheKey = `${fromDay}|${toDay}`;
  if (estimateCache.key === cacheKey && Date.now() - estimateCache.at < 60 * 60 * 1000) return estimateCache.days;
  const from = dayStart(fromDay);
  const to = dayStart(addDays(toDay, 1));
  const group = field => [
    { $match: { createdAt: { $gte: from, $lt: to } } },
    { $project: { who: `$${field}`, day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+05:00' } } } },
    { $group: { _id: { day: '$day', who: '$who' } } }
  ];
  const [a, b, c] = await Promise.all([
    ExamResult.aggregate(group('student')),
    WritingAttempt.aggregate(group('student')),
    ChatMessage.aggregate(group('user'))
  ]);
  const sets = {};
  for (const row of [...a, ...b, ...c]) {
    if (!row._id.who) continue;
    (sets[row._id.day] ||= new Set()).add(String(row._id.who));
  }
  const days = Object.fromEntries(Object.entries(sets).map(([d, s]) => [d, s.size]));
  estimateCache = { at: Date.now(), key: cacheKey, days };
  return days;
}

export async function usageReport(now = Date.now()) {
  const today = dayOf(now);
  const yesterday = addDays(today, -1);
  const firstDay = addDays(today, -(HISTORY_DAYS - 1));
  const todayStart = dayStart(today);

  const [perDay, hourly, firstTracked, newSignups, speaking, writing, ai, yesterdaySoFar] = await Promise.all([
    DailyActivity.aggregate([
      { $match: { day: { $gte: firstDay } } },
      { $group: { _id: { day: '$day', kind: '$kind' }, n: { $sum: 1 } } }
    ]),
    DailyActivity.aggregate([
      { $match: { day: today, kind: 'user' } },
      { $unwind: '$hours' },
      { $group: { _id: '$hours', n: { $sum: 1 } } }
    ]),
    DailyActivity.findOne().sort({ day: 1 }).select('day').lean(),
    User.countDocuments({ createdAt: { $gte: todayStart } }),
    ExamResult.countDocuments({ createdAt: { $gte: todayStart } }),
    WritingAttempt.countDocuments({ createdAt: { $gte: todayStart } }),
    User.aggregate([
      { $match: { 'assistantUsage.day': today } },
      { $group: { _id: null, sessions: { $sum: '$assistantUsage.sessions' }, people: { $sum: 1 } } }
    ]),
    // A fair comparison during the day: yesterday up to this same time.
    DailyActivity.countDocuments({ day: yesterday, kind: 'user', first: { $lte: new Date(now - 864e5) } })
  ]);

  const count = (day, kind) => perDay.find(r => r._id.day === day && r._id.kind === kind)?.n || 0;
  const trackedFrom = firstTracked?.day || today;
  const estimates = trackedFrom > firstDay ? await estimatedDays(firstDay, addDays(trackedFrom, -1)) : {};

  const days = [];
  for (let i = 0; i < HISTORY_DAYS; i += 1) {
    const day = addDays(firstDay, i);
    const tracked = day >= trackedFrom;
    days.push({
      day,
      users: tracked ? count(day, 'user') : estimates[day] || 0,
      guests: tracked ? count(day, 'guest') : null,
      estimated: !tracked
    });
  }

  const hours = Array.from({ length: 24 }, (_, h) => hourly.find(r => r._id === h)?.n || 0);
  // The seven full days before today (today is still running).
  const week = days.slice(-8, -1).filter(d => !d.estimated);

  return {
    today,
    updatedAt: new Date(now).toISOString(),
    currentHour: hourOf(now),
    onlineNow: onlineNow(now),
    activeToday: count(today, 'user'),
    activeYesterday: yesterday >= trackedFrom ? count(yesterday, 'user') : (estimates[yesterday] ?? null),
    yesterdayEstimated: yesterday < trackedFrom,
    yesterdaySoFar: yesterday >= trackedFrom ? yesterdaySoFar : null,
    guestsToday: count(today, 'guest'),
    newSignups,
    speakingToday: speaking,
    writingToday: writing,
    aiSessionsToday: ai[0]?.sessions || 0,
    aiPeopleToday: ai[0]?.people || 0,
    weekAverage: week.length ? Math.round(week.reduce((s, d) => s + d.users, 0) / week.length) : null,
    trackedFrom,
    hours,
    days
  };
}

// ------------------------------------------------------------------ lists

const fullName = u => [u?.firstName, u?.lastName].filter(Boolean).join(' ');
const person = u => ({ id: String(u._id), name: fullName(u) || u.email || '—', email: u.email || '', role: u.role || 'student' });
const hhmm = d => (d ? new Date(new Date(d).getTime() + TZ_MS).toISOString().slice(11, 16) : '');

/**
 * Who is behind a number on the "Website use" card (Jamshid, 2026-10-24):
 * kind = online | students | guests | signups | speaking | writing | ai,
 * for today or (students) any tracked day. Returns { title, rows, note }.
 * Visitors who did not sign in have no account, so they are listed only as
 * anonymous visits with their times.
 */
export async function usageList(kind, { day = dayOf(), now = Date.now() } = {}) {
  const start = dayStart(day);
  const end = dayStart(addDays(day, 1));
  const users = async ids => {
    const list = await User.find({ _id: { $in: ids } }).select('firstName lastName email role createdAt').lean();
    return new Map(list.map(u => [String(u._id), u]));
  };

  if (kind === 'online') {
    const live = [...lastSeen].filter(([, at]) => now - at <= ONLINE_WINDOW_MS).sort((a, b) => b[1] - a[1]);
    const byId = await users(live.map(([id]) => id));
    return {
      title: 'Online now',
      rows: live.filter(([id]) => byId.has(id)).map(([id, at]) => ({ ...person(byId.get(id)), detail: `last active ${hhmm(at)}`, at: new Date(at) }))
    };
  }

  if (kind === 'students') {
    const acts = await DailyActivity.find({ day, kind: 'user' }).sort({ last: -1 }).lean();
    const byId = await users(acts.map(a => a.user).filter(Boolean));
    return {
      title: day === dayOf(now) ? 'Students today' : `Students on ${day}`,
      rows: acts.filter(a => byId.has(String(a.user))).map(a => ({
        ...person(byId.get(String(a.user))),
        detail: `${hhmm(a.first)}–${hhmm(a.last)} · active in ${a.hours?.length || 1} hour${(a.hours?.length || 1) === 1 ? '' : 's'}`,
        at: a.last
      }))
    };
  }

  if (kind === 'guests') {
    const acts = await DailyActivity.find({ day, kind: 'guest' }).sort({ first: 1 }).lean();
    return {
      title: 'Visitors not signed in',
      note: 'They have no account, so there is no name to show — each line is one browser that opened the site.',
      rows: acts.map((a, i) => ({ id: a.key, name: `Visitor ${i + 1}`, email: '', detail: `${hhmm(a.first)}–${hhmm(a.last)}`, at: a.first }))
    };
  }

  if (kind === 'signups') {
    const list = await User.find({ createdAt: { $gte: start, $lt: end } }).sort({ createdAt: -1 })
      .select('firstName lastName email role createdAt isEmailVerified googleId').lean();
    return {
      title: 'New sign-ups',
      rows: list.map(u => ({ ...person(u), detail: `${hhmm(u.createdAt)} · ${u.googleId ? 'Google' : 'email'}${u.isEmailVerified ? '' : ' · email not confirmed'}`, at: u.createdAt }))
    };
  }

  if (kind === 'speaking') {
    const list = await ExamResult.find({ createdAt: { $gte: start, $lt: end } }).sort({ createdAt: -1 })
      .populate('student', 'firstName lastName email role').populate('exam', 'title')
      .select('student exam mode part status overallScore overallLevel createdAt').lean();
    return {
      title: 'Speaking mocks started',
      rows: list.filter(r => r.student).map(r => ({
        ...person(r.student),
        detail: `${hhmm(r.createdAt)} · ${r.exam?.title || 'Speaking'}${r.mode === 'practice' ? ` · practice Part ${r.part || ''}` : ''} · ${
          r.status === 'completed' ? `${r.overallScore ?? '—'}/75 ${r.overallLevel || ''}` : r.status === 'in_progress' ? 'not finished' : r.status}`,
        link: r.status === 'completed' ? `/?result=${r._id}` : null,
        at: r.createdAt
      }))
    };
  }

  if (kind === 'writing') {
    const list = await WritingAttempt.find({ createdAt: { $gte: start, $lt: end } }).sort({ createdAt: -1 })
      .populate('student', 'firstName lastName email role')
      .select('student mode testTitle status score level complete createdAt').lean();
    return {
      title: 'Writing checks and mocks',
      rows: list.filter(r => r.student).map(r => ({
        ...person(r.student),
        detail: `${hhmm(r.createdAt)} · ${r.mode === 'check' ? 'Writing check' : r.testTitle || 'Writing mock'} · ${
          r.status === 'completed' ? (r.score != null ? `${r.score}/75 ${r.level || ''}` : r.level || 'marked') : r.status === 'in_progress' ? 'not finished' : r.status}`,
        link: r.status === 'completed' ? `/?writing=${r._id}` : null,
        at: r.createdAt
      }))
    };
  }

  if (kind === 'ai') {
    const list = await User.find({ 'assistantUsage.day': day }).select('firstName lastName email role assistantUsage').lean();
    return {
      title: 'AI Ustoz',
      rows: list.sort((a, b) => (b.assistantUsage?.sessions || 0) - (a.assistantUsage?.sessions || 0))
        .map(u => ({ ...person(u), detail: `${u.assistantUsage?.sessions || 0} session${u.assistantUsage?.sessions === 1 ? '' : 's'}` }))
    };
  }

  throw Object.assign(new Error('Unknown list'), { statusCode: 400 });
}

export const _test = { seen, lastSeen, reset() { seen.clear(); lastSeen.clear(); estimateCache = { at: 0, key: '', days: {} }; } };

export default { noteUser, noteGuest, onlineNow, usageReport, usageList, dayOf, hourOf };
