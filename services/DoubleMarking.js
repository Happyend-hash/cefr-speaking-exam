/**
 * Two examiners, as the real exam does it.
 *
 * The agency's reported speaking mark is the MEAN OF TWO EXPERTS' marks — that
 * is why its conversion table has half-point rows. One AI reading of a mock
 * swings by a band from one attempt to the next on very similar performances
 * (a student scored 51 on a mock whose answers were, if anything, better than
 * those on a mock that scored 54). Two independent readings, averaged, halve
 * that swing; a third is called in only where the two disagree badly.
 *
 *   Two readings agree            -> that band.
 *   They differ by one band       -> the mean (e.g. 2 and 3 -> 2.5), exactly
 *                                    as two human examiners' marks combine.
 *   They differ by two or more    -> a third reading; the part gets the mean
 *                                    of the two closest of the three.
 *
 * Pure functions: no network, no database. The route does the calling.
 */

import { SPEAKING_PART_MAX } from './ScoreConversion.js';

/** How far apart two readings may be on one part before a third is needed. */
export const THIRD_MARKER_GAP = 2;

const PARTS = Object.keys(SPEAKING_PART_MAX);
const finite = v => typeof v === 'number' && Number.isFinite(v);

/** The widest disagreement between readings, on any one part. */
export function largestGap(verdicts) {
  let gap = 0;
  for (const key of PARTS) {
    const values = verdicts.map(v => v?.bands?.[key]).filter(finite);
    if (values.length >= 2) gap = Math.max(gap, Math.max(...values) - Math.min(...values));
  }
  return gap;
}

export const needsThirdMarker = verdicts => verdicts.length === 2 && largestGap(verdicts) >= THIRD_MARKER_GAP;

/** One part's band from several readings. */
export function combinePart(values) {
  const marks = values.filter(finite).sort((a, b) => a - b);
  if (!marks.length) return undefined;
  if (marks.length === 1) return marks[0];
  const half = x => Math.round(x * 2) / 2;
  if (marks.length === 2) return half((marks[0] + marks[1]) / 2);
  // Three or more: the two readings that agree most decide; the outlier does
  // not. When no pair is closer than another (1, 2, 3), the middle one stands.
  const gaps = marks.slice(1).map((m, i) => m - marks[i]);
  const smallest = Math.min(...gaps);
  const at = gaps.indexOf(smallest);
  if (gaps.lastIndexOf(smallest) !== at) return half(marks[Math.floor(marks.length / 2)]);
  return half((marks[at] + marks[at + 1]) / 2);
}

/**
 * Combine the readings into one set of part bands.
 * @returns {{ bands, closest }} closest is the reading nearest the result,
 *   whose written comments are shown to the student.
 */
export function combineVerdicts(verdicts) {
  const usable = verdicts.filter(v => v && v.bands);
  if (!usable.length) return null;

  const bands = {};
  for (const key of PARTS) {
    const band = combinePart(usable.map(v => v.bands[key]));
    if (band !== undefined) bands[key] = band;
  }

  const distance = v => PARTS.reduce((sum, key) =>
    sum + (finite(v.bands[key]) && finite(bands[key]) ? Math.abs(v.bands[key] - bands[key]) : 0), 0);
  const closest = usable.reduce((best, v) => (distance(v) < distance(best) ? v : best));

  return { bands, closest };
}

export default { combineVerdicts, combinePart, needsThirdMarker, largestGap, THIRD_MARKER_GAP };
