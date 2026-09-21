import GamePoint from '../models/GamePoint.js';
import User from '../models/User.js';
import { fallbackName } from './Leaderboard.js';
import { badgeOf, BADGE_FIELDS } from './Premium.js';

/**
 * Game points and the games ranking.
 *
 * Every game scores on the server and hands the result here. How many of
 * those points count toward the ranking each day is capped per game, so the
 * ranking rewards playing well rather than playing all night — the game
 * itself can always be played for practice.
 */

export const DAILY_CAP = Object.freeze({
  'error-hunter': Number(process.env.GAME_CAP_ERROR_HUNTER) || 1000,
  duel: Number(process.env.GAME_CAP_DUEL) || 800,
  taboo: Number(process.env.GAME_CAP_TABOO) || 500
});

const DAY = 24 * 60 * 60 * 1000;
const TASHKENT = 5 * 60 * 60 * 1000; // UTC+5, no daylight saving

/** Midnight in Tashkent, today. */
export function startOfDay(now = Date.now()) {
  return new Date(Math.floor((now + TASHKENT) / DAY) * DAY - TASHKENT);
}

/** Monday 00:00 in Tashkent, this week. */
export function startOfWeek(now = Date.now()) {
  const day = startOfDay(now).getTime();
  const weekday = new Date(day + TASHKENT).getUTCDay(); // 0 = Sunday
  const sinceMonday = (weekday + 6) % 7;
  return new Date(day - sinceMonday * DAY);
}

/**
 * Record points, within today's cap for that game. Returns what counted.
 * Staff never score: teachers testing a game do not appear in the ranking.
 */
export async function award(userId, game, points, meta = {}, now = Date.now()) {
  const wanted = Math.max(0, Math.round(Number(points) || 0));
  if (!wanted || !DAILY_CAP[game]) return 0;
  const user = await User.findById(userId).select('role').lean();
  if (!user || user.role === 'admin' || user.role === 'teacher') return 0;

  const today = await GamePoint.find({ user: userId, game, at: { $gte: startOfDay(now) } }).select('points').lean();
  const used = today.reduce((sum, p) => sum + (p.points || 0), 0);
  const counted = Math.min(wanted, Math.max(0, DAILY_CAP[game] - used));
  if (counted > 0) {
    await GamePoint.create({ user: userId, game, points: counted, at: new Date(now), meta });
    cache.clear();
  }
  return counted;
}

// ------------------------------------------------------------ ranking

const cache = new Map(); // period -> { at, rows }
const CACHE_MS = 30 * 1000;

async function ranking(period, now) {
  const hit = cache.get(period);
  if (hit && now - hit.at < CACHE_MS) return hit.rows;

  const match = period === 'week' ? { at: { $gte: startOfWeek(now) } } : {};
  const groups = await GamePoint.aggregate([
    { $match: match },
    { $group: { _id: '$user', points: { $sum: '$points' }, games: { $sum: 1 }, last: { $max: '$at' } } }
  ]);
  const users = await User.find({ _id: { $in: groups.map(g => g._id) } })
    .select(`firstName lastName nickname deletedAt access ${BADGE_FIELDS}`).lean();
  const byId = new Map(users.map(u => [String(u._id), u]));

  const rows = groups
    .map(g => ({ g, u: byId.get(String(g._id)) }))
    .filter(({ u }) => u && u.role === 'student' && !u.deletedAt && !u.access?.blocked)
    .map(({ g, u }) => ({
      id: String(g._id),
      name: u.nickname || fallbackName(u),
      points: g.points,
      games: g.games,
      last: g.last,
      ...badgeOf(u)
    }))
    // Ties go to whoever got there first.
    .sort((a, b) => b.points - a.points || new Date(a.last) - new Date(b.last));

  cache.set(period, { at: now, rows });
  return rows;
}

export async function gameLeaderboard(viewerId, period = 'week', now = Date.now()) {
  const which = period === 'all' ? 'all' : 'week';
  const rows = await ranking(which, now);
  const mine = rows.findIndex(r => r.id === String(viewerId));
  return {
    period: which,
    since: which === 'week' ? startOfWeek(now) : null,
    top: rows.slice(0, 10).map((r, i) => ({
      rank: i + 1, name: r.name, points: r.points, games: r.games,
      premium: r.premium, avatar: r.avatar, you: r.id === String(viewerId)
    })),
    you: mine >= 0 ? { rank: mine + 1, points: rows[mine].points } : { rank: null, points: 0 },
    caps: DAILY_CAP
  };
}

/** Points already counted today, per game — shown so students know where they stand. */
export async function todayPoints(userId, now = Date.now()) {
  const rows = await GamePoint.find({ user: userId, at: { $gte: startOfDay(now) } }).select('game points').lean();
  const out = { 'error-hunter': 0, duel: 0, taboo: 0 };
  for (const r of rows) out[r.game] = (out[r.game] || 0) + r.points;
  return out;
}

export const forgetCache = () => cache.clear();
export default { award, gameLeaderboard, todayPoints, DAILY_CAP, startOfDay, startOfWeek };
