/**
 * The agency's own arithmetic, reproduced.
 *
 * Source: "Chet tilini bilish darajasini baholash ko'p darajali test formati
 * uchun baholash mezonlari" — Bilimni baholash agentligi, Ilmiy-metodik
 * kengash, 16 March 2023 — and, for speaking specifically, the school's own
 * "Rating scale for Multilevel speaking exams" material (see
 * content/speakingRubric.js).
 *
 * Speaking is NOT Rasch-scored. Rasch applies to listening and reading only.
 * Speaking and writing are marked by human experts against the published
 * criteria, and the mean of the experts' raw marks is converted to the reported
 * 0-75 figure by a fixed table. That makes the conversion exactly reproducible
 * — no modelling, no estimation, no equating. Speaking and writing each have
 * their OWN table and their own raw maximum — they are not the same scale.
 */

// ===========================================================================
// SPEAKING
// ===========================================================================

/**
 * Speaking is marked on FOUR holistic bands, one per part — not five weighted
 * criteria averaged together, which is what this file used to assume before
 * the school supplied its actual method. See content/speakingRubric.js for
 * the full argument and the descriptors themselves.
 *
 *   Part 1.1 (Q1-3)  0-5
 *   Part 1.2 (Q4-6)  0-5
 *   Part 2   (Q7)    0-5
 *   Part 3   (Q8)    0-6
 *
 * Raw total: 0-21, a PLAIN SUM of the four part bands — no weighting, no
 * averaging, exactly the same shape as writing below. The half-point rows
 * exist for the same reason writing's do: the official mark is the mean of
 * two experts, and this app's AI marker plus a teacher's review can produce
 * one too.
 */
const SPEAKING_CONVERSION = [
  [21, 75], [20.5, 73], [20, 71], [19.5, 69], [19, 67], [18.5, 65], [18, 64],
  [17.5, 63], [17, 61], [16.5, 59], [16, 57], [15.5, 56], [15, 54], [14.5, 52],
  [14, 51], [13.5, 50], [13, 49], [12.5, 47], [12, 46], [11.5, 45], [11, 43],
  [10.5, 42], [10, 40], [9.5, 39], [9, 38], [8.5, 37], [8, 35], [7.5, 33],
  [7, 32], [6.5, 30], [6, 29], [5.5, 27], [5, 26], [4.5, 24], [4, 23],
  [3.5, 21], [3, 19], [2.5, 17], [2, 15], [1.5, 13], [1, 11], [0.5, 10], [0, 0]
];

/** Each speaking part's ceiling, in the order the exam is taken. */
export const SPEAKING_PART_MAX = { part11: 5, part12: 5, part2: 5, part3: 6 };

/** A flawless speaking mock: 5 + 5 + 5 + 6, matching the conversion table's ceiling. */
export const SPEAKING_RAW_MAX =
  Object.values(SPEAKING_PART_MAX).reduce((a, b) => a + b, 0);

/**
 * The four part bands -> the expert mark.
 *
 * A missing part is NOT scaled up the way the old five-criteria system scaled
 * up a missing criterion, and the difference is deliberate — the same
 * reasoning as writing's version of this function: an unjudged criterion used
 * to mean "we couldn't hear it", but a missing PART means the candidate did
 * not do it (relevant to practice mode, which drills one part at a time). A
 * full mock always has all four, since the exam does not allow skipping.
 */
export function speakingExpertMark(bands = {}) {
  let total = 0;
  let marked = 0;

  for (const [part, max] of Object.entries(SPEAKING_PART_MAX)) {
    const band = Number(bands[part]);
    if (!Number.isFinite(band)) continue;
    total += Math.max(0, Math.min(max, band));
    marked += 1;
  }

  if (marked === 0) return null;
  const mark = Math.round(total * 2) / 2;
  return { mark, marked, complete: marked === Object.keys(SPEAKING_PART_MAX).length };
}

/** Expert mark -> reported 0-75 score, by the published speaking table. */
export function speakingMarkToScore(mark) {
  const value = Number(mark);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const row = SPEAKING_CONVERSION.find(([floor]) => value >= floor);
  return row ? row[1] : 0;
}

/** Part bands straight through to the reported speaking score. */
export function speakingBandsToScore(bands) {
  const expert = speakingExpertMark(bands);
  if (!expert) return null;
  return { ...expert, score: speakingMarkToScore(expert.mark) };
}

// ===========================================================================
// WRITING
// ===========================================================================

/**
 * Writing has its own table, and it is NOT the one above.
 *
 * The agency's own worked example settles it: a candidate marked 4 on Part 1.1,
 * 2 on Part 1.2 and 2 on Part 2 is reported as 47. Under the speaking table
 * that profile lands near 40. Two different scales, two different tables —
 * writing's maximum raw mark is 16, not 36.
 *
 * The expert mark is a PLAIN SUM of the three part bands:
 *
 *     Part 1.1 (0-5) + Part 1.2 (0-5) + Part 2 (0-6)  ->  0-16
 *
 * No weighting, no averaging across parts, no scaling. Part 2 carries more
 * weight only because it is marked out of 6 rather than 5. Any temptation to
 * "balance" the parts is a temptation to disagree with the published example.
 *
 * The half-point rows exist because the official mark is the MEAN OF TWO
 * EXPERTS, and the mean of two integers can end in .5. This app has one marker
 * (the AI) plus, when the teacher reviews, a second opinion — so half marks are
 * reachable here too and the table is used at its full resolution.
 */
const WRITING_CONVERSION = [
  [16, 75], [15.5, 72], [15, 69], [14.5, 67], [14, 65], [13.5, 64],
  [13, 63], [12.5, 62], [12, 61], [11.5, 59], [11, 57], [10.5, 55],
  [10, 53], [9.5, 51], [9, 50], [8.5, 48], [8, 47], [7.5, 45],
  [7, 43], [6.5, 41], [6, 40], [5.5, 38], [5, 37], [4.5, 35],
  [4, 33], [3.5, 31], [3, 28], [2.5, 25], [2, 21], [1.5, 17],
  [1, 14], [0.5, 10]
];

/** Each writing part's ceiling, in the order the exam is taken. */
export const WRITING_PART_MAX = { part11: 5, part12: 5, part2: 6 };

/** A flawless writing mock: 5 + 5 + 6. */
export const WRITING_RAW_MAX =
  Object.values(WRITING_PART_MAX).reduce((a, b) => a + b, 0);

/**
 * The three part bands -> the expert mark.
 *
 * A missing part is NOT scaled up the way a missing speaking criterion is, and
 * the difference is deliberate. An unjudgeable pronunciation is a measurement
 * failure — the candidate spoke, we simply could not hear well enough. An
 * absent Part 2 is not: the candidate did not write it. Scaling would report a
 * one-part submission as if it were a whole mock, which is exactly the hole the
 * partial-submission rule exists to close.
 *
 * So a partial submission sums what is there and returns `complete: false`. The
 * caller decides what to do with that — the app caps a partial mock's reported
 * level rather than converting it as a full one.
 */
export function writingExpertMark(bands = {}) {
  let total = 0;
  let marked = 0;

  for (const [part, max] of Object.entries(WRITING_PART_MAX)) {
    const band = Number(bands[part]);
    if (!Number.isFinite(band)) continue;
    total += Math.max(0, Math.min(max, band));
    marked += 1;
  }

  if (marked === 0) return null;
  // Halves survive; anything finer is not a mark the table knows.
  const mark = Math.round(total * 2) / 2;
  return { mark, marked, complete: marked === Object.keys(WRITING_PART_MAX).length };
}

/** Expert mark -> reported 0-75 score, by the published writing table. */
export function writingMarkToScore(mark) {
  const value = Number(mark);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const row = WRITING_CONVERSION.find(([floor]) => value >= floor);
  return row ? row[1] : 0;
}

/** Part bands straight through to the reported writing score. */
export function writingBandsToScore(bands) {
  const expert = writingExpertMark(bands);
  if (!expert) return null;
  return { ...expert, score: writingMarkToScore(expert.mark) };
}

export default {
  SPEAKING_PART_MAX,
  SPEAKING_RAW_MAX,
  speakingExpertMark,
  speakingMarkToScore,
  speakingBandsToScore,
  WRITING_PART_MAX,
  WRITING_RAW_MAX,
  writingExpertMark,
  writingMarkToScore,
  writingBandsToScore
};
