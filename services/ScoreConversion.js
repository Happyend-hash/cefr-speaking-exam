/**
 * The agency's own arithmetic, reproduced.
 *
 * Source: "Chet tilini bilish darajasini baholash ko'p darajali test formati
 * uchun baholash mezonlari" — Bilimni baholash agentligi, Ilmiy-metodik
 * kengash, 16 March 2023.
 *
 * Speaking is NOT Rasch-scored. Rasch applies to listening and reading only.
 * Speaking and writing are marked by human experts against the published
 * criteria, and the mean of the experts' raw marks is converted to the reported
 * 0-75 figure by the fixed table below. That makes the conversion exactly
 * reproducible — no modelling, no estimation, no equating.
 */

/**
 * Raw mean -> reported score, exactly as published.
 *
 * Implemented as a literal table and never as a formula, because the bands are
 * not uniform: 1.0 wide at the top and around 27-30, 0.5 wide elsewhere, and
 * anything above zero starts at 10 rather than at 1. A formula fitted to this
 * would agree in the middle and disagree exactly where a student notices.
 *
 * Ordered high to low; the first row whose floor the raw mark reaches wins.
 */
const CONVERSION = [
  [35.1, 75], [34.1, 74], [33.1, 73], [32.6, 72], [32.1, 71], [31.6, 70],
  [31.1, 69], [30.6, 68], [30.1, 67], [29.1, 66], [28.1, 65], [27.1, 64],
  [26.6, 63], [26.1, 62], [25.6, 61], [25.1, 60], [24.6, 59], [24.1, 58],
  [23.6, 57], [23.1, 56], [22.6, 55], [22.1, 54], [21.6, 53], [21.1, 52],
  [20.6, 51], [20.1, 50], [19.6, 49], [19.1, 48], [18.6, 47], [18.1, 46],
  [17.6, 45], [17.1, 44], [16.6, 43], [16.1, 42], [15.6, 41], [15.1, 40],
  [14.6, 39], [14.1, 38], [13.6, 37], [13.1, 36], [12.6, 35], [12.1, 34],
  [11.6, 33], [11.1, 32], [10.6, 31], [10.1, 30], [9.6, 29], [9.1, 28],
  [8.6, 27], [8.1, 26], [7.6, 25], [7.1, 24], [6.6, 23], [6.1, 22],
  [5.6, 21], [5.1, 20], [4.6, 19], [4.1, 18], [3.6, 17], [3.1, 16],
  [2.6, 15], [2.1, 14], [1.6, 13], [1.1, 12], [0.6, 11], [0.1, 10]
];

/**
 * How the five marked criteria become the raw total the table expects.
 *
 * THE ONE UNCONFIRMED NUMBER IN THIS FILE. The table's maximum raw mark is 36,
 * which writing reaches as 12 + 24. The published speaking criteria have five
 * columns scored 0-6, which reaches only 30 — and a real certificate reports a
 * speaking score of 67, which the table says requires a raw mean of 30.1-30.5.
 * So the speaking raw total demonstrably exceeds 30, and the sheets we hold do
 * not say how.
 *
 * Two candidate explanations, and conveniently both are just weight vectors
 * over the same five bands, so switching between them is one edit here and
 * costs nothing else:
 *
 *   A (in force) — the rater screen splits "nutq ravonligi VA matn yaxlitligi"
 *       into two sliders, as its title suggests. Six sliders x 6 = 36. Modelled
 *       here by weighting that one criterion double, which is identical to two
 *       sliders whenever both halves get the same band — and it keeps the
 *       student-facing descriptors exactly as published, with nothing split by
 *       us.
 *
 *   B — five criteria scaled by 1.2 (30 x 1.2 = 36). Set every weight to 1.2
 *       to adopt it.
 *
 * Both reach 36 and both use the table above unchanged. They differ only for
 * candidates whose fluency and coherence sit apart from the rest of their
 * profile, and then by a point or two.
 */
export const CRITERION_WEIGHTS = {
  vocabulary: 1,
  grammar: 1,
  fluencyCoherence: 2,
  communicative: 1,
  pronunciation: 1
};

export const BAND_MAX = 6;

/** The raw total a flawless performance would reach: 36, matching the table. */
export const RAW_MAX =
  BAND_MAX * Object.values(CRITERION_WEIGHTS).reduce((a, b) => a + b, 0);

/**
 * Weighted raw total from the criterion bands.
 *
 * A missing criterion is not treated as zero — a criterion nobody could judge
 * is not a criterion the candidate failed. It is dropped from both sides of the
 * sum and the total is scaled to what it would have been, so one unmeasurable
 * criterion costs a candidate nothing.
 */
export function bandsToRaw(bands = {}) {
  let total = 0;
  let weightUsed = 0;
  let weightAll = 0;

  for (const [criterion, weight] of Object.entries(CRITERION_WEIGHTS)) {
    weightAll += weight;
    const band = Number(bands[criterion]);
    if (!Number.isFinite(band)) continue;
    total += Math.max(0, Math.min(BAND_MAX, band)) * weight;
    weightUsed += weight;
  }

  if (weightUsed === 0) return null;
  const scaled = total * (weightAll / weightUsed);
  return Math.round(scaled * 10) / 10;
}

/** Raw total -> reported 0-75 score, by the published table. */
export function rawToScore(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const row = CONVERSION.find(([floor]) => value >= floor);
  return row ? row[1] : 0;
}

/** Criterion bands straight through to the reported score. */
export function bandsToScore(bands) {
  const raw = bandsToRaw(bands);
  return raw === null ? null : rawToScore(raw);
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
  CRITERION_WEIGHTS,
  BAND_MAX,
  RAW_MAX,
  bandsToRaw,
  rawToScore,
  bandsToScore,
  WRITING_PART_MAX,
  WRITING_RAW_MAX,
  writingExpertMark,
  writingMarkToScore,
  writingBandsToScore
};
