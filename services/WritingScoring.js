/**
 * Writing: everything between the marker's bands and the student's result.
 *
 * Pure functions, no database and no network, so every rule the teacher set
 * can be checked by a test rather than by taking a mock:
 *
 *   - word counting, and the official under-length caps
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
 * Does this part fall under the official under-length caps?
 *
 * Returns the threshold as well as the verdict, so the result screen can say
 * exactly why a part was capped ("you wrote 70 words; under 90 allows band 2 at most") rather
 * than leaving a student to guess.
 */
export function lengthVerdict(key, words, minWords) {
  const steps = WRITING_LENGTH_RULE[key];
  const min = Number(minWords) || DEFAULT_MIN_WORDS[key] || 0;
  if (!steps || !min) return { capped: false, cap: null, threshold: null, minWords: min };

  for (const { share, cap } of steps) {
    const threshold = Math.ceil(min * share);
    if (words < threshold) return { capped: true, cap, threshold, minWords: min };
  }
  return { capped: false, cap: null, threshold: null, minWords: min };
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
  const located = [];
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

    located.push({ start, end: start + wrong.length, right, why: String(item?.why ?? '').slice(0, 300) });
    cursor = start + wrong.length;
  }

  return narrowCorrections(source, located);
}

/** The words of a stretch of text, with where each one sits in it. */
function wordsOf(text, offset = 0) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push({ word: m[0], start: offset + m.index, end: offset + m.index + m[0].length });
  return out;
}

/**
 * Cut each correction down to the words that are actually wrong.
 *
 * The marker is told to quote only the wrong word, but it sometimes quotes a
 * whole clause and rewrites it ("I am agree with this idea" -> "I agree with
 * this idea"), and the student then sees the entire clause crossed out for
 * one bad word. So the quoted span and its correction are compared word by
 * word (longest common subsequence) and only the words that differ are
 * crossed out: here, just "am", removed. A missing word ("in morning" ->
 * "in the morning") is shown on the word after the gap ("morning" -> "the
 * morning"), since there is nothing to cross out. One correction can become
 * several small ones; each keeps the marker's reason.
 *
 * Also applied when an already-marked result is shown, so older results get
 * the same precise marking.
 */
export function narrowCorrections(text, placed = []) {
  const source = String(text || '');
  const out = [];

  for (const c of Array.isArray(placed) ? placed : []) {
    const start = Number(c?.start);
    const end = Number(c?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > source.length || end <= start) continue;
    const right = String(c?.right ?? '');
    const why = String(c?.why ?? '');

    const a = wordsOf(source.slice(start, end), start);
    const b = right.split(/\s+/).filter(Boolean);

    // Longest common subsequence of the two word lists.
    const n = a.length;
    const m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i].word === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }

    // Walk it, collecting each run of differences as one hunk.
    const hunks = [];
    let hunk = null;
    const flush = nextMatch => {
      if (hunk) { hunk.next = nextMatch; hunks.push(hunk); hunk = null; }
    };
    let i = 0;
    let j = 0;
    let prev = null;
    while (i < n || j < m) {
      if (i < n && j < m && a[i].word === b[j]) {
        flush(a[i]);
        prev = a[i];
        i++; j++;
      } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
        hunk = hunk || { del: [], ins: [], prev };
        hunk.ins.push(b[j]);
        j++;
      } else {
        hunk = hunk || { del: [], ins: [], prev };
        hunk.del.push(a[i]);
        i++;
      }
    }
    flush(null);

    for (const h of hunks) {
      if (h.del.length) {
        out.push({
          start: h.del[0].start,
          end: h.del[h.del.length - 1].end,
          wrong: source.slice(h.del[0].start, h.del[h.del.length - 1].end),
          right: h.ins.join(' '),
          why
        });
      } else if (h.next) {
        out.push({ start: h.next.start, end: h.next.end, wrong: h.next.word, right: `${h.ins.join(' ')} ${h.next.word}`, why });
      } else if (h.prev) {
        out.push({ start: h.prev.start, end: h.prev.end, wrong: h.prev.word, right: `${h.prev.word} ${h.ins.join(' ')}`, why });
      }
    }
  }

  // Overlaps cannot both be drawn; the earlier one wins.
  const kept = [];
  for (const c of out.sort((x, y) => x.start - y.start)) {
    if (c.wrong === c.right) continue;
    if (kept.some(k => c.start < k.end && c.end > k.start)) continue;
    kept.push(c);
  }
  return kept;
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
  narrowCorrections,
  correctionSegments,
  scoreWriting,
  PARTIAL_LEVEL_CAP
};
