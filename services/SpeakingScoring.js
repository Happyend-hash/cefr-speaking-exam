/**
 * Speaking: the part bands -> the reported result.
 *
 * Pure functions, no database and no network — the same shape as
 * WritingScoring.js, because the two rubrics are the same design now: several
 * holistic part bands, summed, converted by a fixed table, and capped when
 * the submission is not complete.
 *
 *   - the expert mark (plain sum), the official conversion, and the level
 *   - the partial-submission cap
 *
 * "Partial" only happens in practice mode, which drills exactly one part at a
 * time (see ExamResult.part) — a full mock always has transcript evidence for
 * all four parts, since the exam does not allow skipping or pausing.
 */

import { speakingBandsToScore, SPEAKING_PART_MAX } from './ScoreConversion.js';
import { speakingBandLevel } from '../content/speakingRubric.js';
import { levelForScore, BELOW_B1 } from '../models/ExamResult.js';

const LEVEL_ORDER = [BELOW_B1, 'B1', 'B2', 'C1'];
const rank = level => Math.max(0, LEVEL_ORDER.indexOf(level || BELOW_B1));

/**
 * A partial submission is never scaled up as if it were a whole mock, and
 * never converted to a score out of 75 on a table built for all four parts —
 * the same reasoning as writing's version of this cap. A single strong part
 * (Part 3 alone, say) could otherwise sum to a raw mark the table reads as a
 * B2 or C1 result from one part of the exam.
 */
export const PARTIAL_LEVEL_CAP = 'B1';

/**
 * The outcome of a speaking attempt from its part bands.
 *
 * Complete (all four parts): expert mark = plain sum, converted by the
 * official speaking table, level from the official bands.
 *
 * Partial: no score out of 75 — the level is the weakest level any submitted
 * part shows (read off that part's own CEFR-labelled scale), capped at B1.
 */
export function scoreSpeaking(bands = {}) {
  const present = {};
  for (const key of Object.keys(SPEAKING_PART_MAX)) {
    const band = bands[key];
    if (band === null || band === undefined || band === '') continue;
    if (Number.isFinite(Number(band))) present[key] = Number(band);
  }

  const keys = Object.keys(present);
  if (!keys.length) return null;

  const converted = speakingBandsToScore(present);

  if (converted.complete) {
    return {
      complete: true,
      expertMark: converted.mark,
      score: converted.score,
      level: levelForScore(converted.score)
    };
  }

  const weakest = keys
    .map(key => speakingBandLevel(key, present[key]) || BELOW_B1)
    .reduce((low, level) => (rank(level) < rank(low) ? level : low));

  return {
    complete: false,
    expertMark: converted.mark,
    score: null,
    level: rank(weakest) > rank(PARTIAL_LEVEL_CAP) ? PARTIAL_LEVEL_CAP : weakest
  };
}

export default { scoreSpeaking, PARTIAL_LEVEL_CAP };
