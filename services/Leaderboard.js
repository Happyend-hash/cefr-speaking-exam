import ScoreRecord from '../models/ScoreRecord.js';
import ExamResult, { levelForScore } from '../models/ExamResult.js';
import User from '../models/User.js';
import { badgeOf, BADGE_FIELDS } from './Premium.js';

/**
 * The site-wide speaking leaderboard: the ten best AVERAGE full-mock scores.
 *
 * Rules, as the teacher set them:
 *   - only full speaking mocks count — not part practice, not writing
 *   - at least MIN_MOCKS of them before a student appears, so one lucky mock
 *     cannot top the board
 *   - a score survives the student deleting the attempt (see ScoreRecord)
 *   - students only; teachers and admins are never ranked
 *   - shown by nickname, or first name and last initial until one is chosen
 *
 * Costs nothing to run: no AI, just a database read of scores already saved,
 * recomputed at most once a minute however many students open the dashboard.
 */

export const MIN_MOCKS = Number(process.env.LEADERBOARD_MIN_MOCKS) || 3;
const TOP = 10;
const CACHE_MS = 60 * 1000;

let cache = { at: 0, ranking: null };

/** Is this attempt a full speaking mock that the leaderboard counts? */
export function countsForLeaderboard(result) {
  return (
    result &&
    result.status === 'completed' &&
    typeof result.overallScore === 'number' &&
    (result.mode || 'mock') === 'mock' &&
    !result.part &&
    (result.module || 'speaking') === 'speaking'
  );
}

/**
 * Save (or update) the score of a marked attempt. Called whenever marking
 * completes, so a re-mark replaces the old score for the same attempt.
 * Never throws — the ranking must never cost anyone their mark.
 */
export async function recordScore(result) {
  try {
    if (!countsForLeaderboard(result)) return;
    await ScoreRecord.updateOne(
      { result: result._id },
      {
        $set: {
          student: result.student,
          score: result.overallScore,
          level: result.overallLevel,
          completedAt: result.completedAt || new Date()
        }
      },
      { upsert: true }
    );
    cache.at = 0; // the next view recomputes
  } catch (error) {
    console.error('Leaderboard: could not record score:', error.message);
  }
}

/** A teacher removed the attempt: it should not have counted at all. */
export async function forgetScore(resultId) {
  try {
    await ScoreRecord.deleteOne({ result: resultId });
    cache.at = 0;
  } catch (error) {
    console.error('Leaderboard: could not remove score:', error.message);
  }
}

/**
 * Bring in full mocks marked before the leaderboard existed.
 *
 * Cheap and idempotent: only attempts with no record yet are inserted, so it
 * can run on every recompute. Attempts deleted before today are gone and
 * cannot be recovered — from here on, deleting no longer removes a score.
 */
async function backfill() {
  const recorded = new Set((await ScoreRecord.distinct('result')).map(String));
  const results = await ExamResult.find({
    status: 'completed',
    overallScore: { $type: 'number' }
  })
    .select('student overallScore overallLevel completedAt mode part module status')
    .lean();

  const missing = results.filter(r => countsForLeaderboard(r) && !recorded.has(String(r._id)));
  if (!missing.length) return 0;

  await ScoreRecord.bulkWrite(
    missing.map(r => ({
      updateOne: {
        filter: { result: r._id },
        update: {
          $setOnInsert: {
            student: r.student,
            result: r._id,
            score: r.overallScore,
            level: r.overallLevel,
            completedAt: r.completedAt || new Date()
          }
        },
        upsert: true
      }
    })),
    { ordered: false }
  );
  return missing.length;
}

/** "Aziza K." — used until a student chooses a nickname. */
export function fallbackName(user) {
  const first = String(user?.firstName || '').trim();
  const last = String(user?.lastName || '').trim();
  if (!first) return "O'quvchi";
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

/**
 * Everyone who qualifies, best average first.
 *
 * Ties go to whoever has sat more mocks (a steadier average), then to whoever
 * reached it first.
 */
async function computeRanking() {
  await backfill();

  const groups = await ScoreRecord.aggregate([
    {
      $group: {
        _id: '$student',
        average: { $avg: '$score' },
        mocks: { $sum: 1 },
        best: { $max: '$score' },
        first: { $min: '$completedAt' }
      }
    }
  ]);

  const users = await User.find({ _id: { $in: groups.map(g => g._id) } })
    .select(`firstName lastName nickname deletedAt ${BADGE_FIELDS}`)
    .lean();
  const byId = new Map(users.map(u => [String(u._id), u]));

  return groups
    .map(g => ({ ...g, user: byId.get(String(g._id)) }))
    .filter(g => g.user && g.user.role === 'student' && !g.user.deletedAt)
    .map(g => ({
      id: String(g._id),
      name: g.user.nickname || fallbackName(g.user),
      hasNickname: Boolean(g.user.nickname),
      ...badgeOf(g.user),
      average: Math.round(g.average * 10) / 10,
      mocks: g.mocks,
      best: g.best,
      first: g.first
    }))
    .sort((a, b) =>
      b.average - a.average ||
      b.mocks - a.mocks ||
      new Date(a.first || 0) - new Date(b.first || 0)
    );
}

async function ranking() {
  if (!cache.ranking || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), ranking: await computeRanking() };
  }
  return cache.ranking;
}

/** Forget the cached ranking — after a nickname changes, for instance. */
export function invalidate() {
  cache.at = 0;
}

/**
 * The top ten, plus where the viewer stands.
 */
export async function leaderboardFor(viewerId) {
  const all = await ranking();
  const qualified = all.filter(r => r.mocks >= MIN_MOCKS);

  const top = qualified.slice(0, TOP).map((r, i) => ({
    rank: i + 1,
    name: r.name,
    average: r.average,
    level: levelForScore(Math.round(r.average)),
    mocks: r.mocks,
    best: r.best,
    premium: r.premium,
    avatar: r.avatar,
    you: r.id === String(viewerId)
  }));

  const mine = all.find(r => r.id === String(viewerId));
  const myRank = qualified.findIndex(r => r.id === String(viewerId));

  return {
    minMocks: MIN_MOCKS,
    ranked: qualified.length,
    top,
    you: mine
      ? {
          rank: myRank >= 0 ? myRank + 1 : null,
          average: mine.average,
          mocks: mine.mocks,
          needed: Math.max(0, MIN_MOCKS - mine.mocks)
        }
      : { rank: null, average: null, mocks: 0, needed: MIN_MOCKS }
  };
}

export default { recordScore, forgetScore, leaderboardFor, countsForLeaderboard, invalidate, MIN_MOCKS };
