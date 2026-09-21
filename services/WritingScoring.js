/**
 * Writing: everything between the marker's bands and the student's result.
 *
 * Pure functions, no database and no network, so every rule the teacher set
 * can be checked by a test rather than by taking a mock:
 *
 *   - word counting, and the school's under-length rule
 *   - where each in-line correction sits in the student's text
 *   - the expert mark (plain sum), the official conversion, and the level
 *   - the partial-submission cap
 */

import { WRITING_PART_KEYS, writingBandLevel } from '../content/writingCriteria.js';
import { WRITING_LENGTH_RULE, DEFAULT_MIN_WORDS } from '../content/writingTests.js';
import { writingBandsToScore } from './ScoreConversion.js';
import { levelForScore, BELOW_B1 } from '../models/ExamResult.js';

/**
 * Words as a reader counts them: runs of non-space characters.
 *
 * The same rule runs in the browser for the live counter, so the number a
 * student watches while writing is the number the rule is applied to.
 */
export function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Does this part fall under the school's under-length rule?
 *
 * Returns the threshold as well as the verdict, so the result screen can say
 * exactly why a part scored 0 ("you wrote 70 words; under 90 scores 0") rather
 * than leaving a student to guess.
 */
export function lengthVerdict(key, words, minWords) {
  const share = WRITING_LENGTH_RULE[key];
  const min = Number(minWords) || DEFAULT_MIN_WORDS[key] || 0;
  if (!share || !min) return { zero: false, threshold: null, minWords: min };

  const threshold = Math.ceil(min * share);
  return { zero: words < threshold, threshold, minWords: min };
}

/**
 * Place each correction in the text.
 *
 * The marker names a mistake by quoting it; this finds the quote. Quotes are
 * matched in order, each searching from where the previous one ended, so a
 * mistake the student made twice is corrected in the right place both times.
 *
 * A quote that cannot be found is dropped rather than guessed at. A correction
 * shown over the wrong words is worse than one not shown: it teaches the
 * student that something correct was wrong.
 */
export function locateCorrections(text, corrections = []) {
  const source = String(text || '');
  const placed = [];
  let cursor = 0;

  for (const item of Array.isArray(corrections) ? corrections : []) {
    const wrong = String(item?.wrong ?? '');
    const right = String(item?.right ?? '');
    if (!wrong.trim() || wrong === right) continue;

    let start = source.indexOf(wrong, cursor);
    // The marker occasionally lists corrections out of order. One retry from
    // the top catches that without letting two corrections claim one span.
    if (start === -1) start = source.indexOf(wrong);
    if (start === -1) continue;

    const end = start + wrong.length;
    if (placed.some(p => start < p.end && end > p.start)) continue;

    placed.push({
      start,
      end,
      wrong,
      right,
      why: String(item?.why ?? '').slice(0, 300)
    });
    cursor = end;
  }

  return placed.sort((a, b) => a.start - b.start);
}

/**
 * The text cut into plain runs and corrections, ready to draw.
 *
 * One shape for the screen and the email, so the student sees the same marked
 * script in both places.
 */
export function correctionSegments(text, placed = []) {
  const source = String(text || '');
  const segments = [];
  let at = 0;

  for (const c of placed) {
    if (c.start < at) continue;
    if (c.start > at) segments.push({ text: source.slice(at, c.start) });
    segments.push({ wrong: source.slice(c.start, c.end), right: c.right, why: c.why });
    at = c.end;
  }
  if (at < source.length) segments.push({ text: source.slice(at) });
  return segments;
}

const LEVEL_ORDER = [BELOW_B1, 'B1', 'B2', 'C1'];
const rank = level => Math.max(0, LEVEL_ORDER.indexOf(level || BELOW_B1));

/**
 * The outcome of a writing attempt from its part bands.
 *
 * Complete (all three parts): expert mark = plain sum, converted by the
 * official writing table, level from the official bands.
 *
 * Partial: no score out of 75 — one or two parts cannot honestly be converted
 * on a table built for all three. The level is the weakest level any submitted
 * part shows, and never above B1: the teacher's rule is that only a full
 * submission counts as a mock, and a partial one can reach B1 at most.
 */
export const PARTIAL_LEVEL_CAP = 'B1';

export function scoreWriting(bands = {}) {
  const present = {};
  for (const key of WRITING_PART_KEYS) {
    const band = bands[key];
    if (band === null || band === undefined || band === '') continue;
    if (Number.isFinite(Number(band))) present[key] = Number(band);
  }

  const keys = Object.keys(present);
  if (!keys.length) return null;

  const converted = writingBandsToScore(present);

  if (converted.complete) {
    return {
      complete: true,
      expertMark: converted.mark,
      score: converted.score,
      level: levelForScore(converted.score)
    };
  }

  const weakest = keys
    .map(key => writingBandLevel(key, present[key]) || BELOW_B1)
    .reduce((low, level) => (rank(level) < rank(low) ? level : low));

  return {
    complete: false,
    expertMark: converted.mark,
    score: null,
    level: rank(weakest) > rank(PARTIAL_LEVEL_CAP) ? PARTIAL_LEVEL_CAP : weakest
  };
}

export default {
  countWords,
  lengthVerdict,
  locateCorrections,
  correctionSegments,
  scoreWriting,
  PARTIAL_LEVEL_CAP
};
