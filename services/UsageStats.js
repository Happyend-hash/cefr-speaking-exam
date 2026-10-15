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

export const _test = { seen, lastSeen, reset() { seen.clear(); lastSeen.clear(); estimateCache = { at: 0, key: '', days: {} }; } };

export default { noteUser, noteGuest, onlineNow, usageReport, dayOf, hourOf };
