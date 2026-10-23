import { SPEAKING_PART_MAX, WRITING_PART_MAX, SPEAKING_RAW_MAX } from './ScoreConversion.js';
import { scoreSpeaking } from './SpeakingScoring.js';
import { scoreWriting } from './WritingScoring.js';
import { SPEAKING_PARTS } from '../content/speakingRubric.js';
import { WRITING_PARTS, writingLabel } from '../content/writingCriteria.js';
import { recordScore } from './Leaderboard.js';
import { scoreUpdateMessage } from './Messages.js';

/**
 * An expert's review that changes the reported score (Jamshid, 2026-10-23).
 *
 * The teacher (a real examiner) types the part bands; they replace the
 * marker's, the score and level are worked out by the same official tables,
 * what the student had before is kept on the attempt, and the student gets a
 * message with every part, the mark, the converted score and the level, old
 * and new. A re-mark refuses to run over an expert's score.
 */

const PASS_SCORE = () => Number(process.env.PASS_SCORE) || 38;

/** The bands typed in: whole or half bands within each part's range. Unset parts are left out. */
export function readBands(raw, max) {
  const bands = {};
  for (const [key, top] of Object.entries(max)) {
    const v = raw?.[key];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > top || Math.round(n * 2) !== n * 2) {
      throw Object.assign(new Error(`${key}: give a band from 0 to ${top} (halves allowed)`), { statusCode: 400 });
    }
    bands[key] = n;
  }
  if (!Object.keys(bands).length) throw Object.assign(new Error('Give the bands for the parts'), { statusCode: 400 });
  return bands;
}

const plain = obj => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]));

/** A speaking attempt (ExamResult document). Returns { before, after, message }. */
export async function reviewSpeaking(result, rawBands, { by, note = '', notify = true } = {}) {
  if (result.status !== 'completed') throw Object.assign(new Error('Only a marked attempt can be reviewed'), { statusCode: 409 });
  const oldBands = plain(result.toObject().partBands);
  // A full mock needs all four parts; practice needs the parts it already has.
  const required = result.mode === 'practice' && Object.keys(oldBands).length ? Object.keys(oldBands) : Object.keys(SPEAKING_PART_MAX);
  const typed = readBands(rawBands, SPEAKING_PART_MAX);
  const missing = required.filter(k => typed[k] === undefined);
  if (missing.length) throw Object.assign(new Error(`Give a band for ${missing.join(', ')}`), { statusCode: 400 });
  const bands = Object.fromEntries(required.map(k => [k, typed[k]]));
  const outcome = scoreSpeaking(bands);

  const before = { mark: result.rawTotal ?? null, score: result.overallScore ?? null, level: result.overallLevel || null };
  if (!result.expertReview?.at) {
    // The marker's own result, kept once: a second review still remembers what the AI gave.
    result.expertReview = { before: { bands: oldBands, ...before } };
  }
  result.expertReview.at = new Date();
  result.expertReview.by = by;
  result.expertReview.note = String(note || '').slice(0, 600);

  result.partBands = bands;
  result.rawTotal = outcome.expertMark;
  result.denominator = SPEAKING_RAW_MAX;
  if (outcome.complete) result.overallScore = outcome.score;
  result.overallLevel = outcome.level;
  if (Number.isFinite(result.overallScore)) result.isPassed = result.overallScore >= PASS_SCORE();
  // The same bands teach the marker, as a correction always has.
  result.teacherBands = { ...bands, note: `Expert review${note ? `: ${String(note).slice(0, 500)}` : ''}`, source: 'teacher-estimate', correctedBy: by, correctedAt: new Date() };
  result.markModified('partBands');
  await result.save();
  await recordScore(result);

  const after = { mark: result.rawTotal, score: outcome.complete ? result.overallScore : null, level: result.overallLevel };
  let message = null;
  if (notify) {
    message = await scoreUpdateMessage({
      user: result.student?._id || result.student, module: 'speaking', sentBy: by,
      attemptId: result._id, attemptTitle: result.exam?.title || result.examTitle || 'Speaking mock',
      attemptDate: result.completedAt || result.createdAt,
      parts: SPEAKING_PARTS.filter(p => bands[p.key] !== undefined).map(p => ({ key: p.key, name: p.name, max: p.max, before: oldBands[p.key] ?? null, after: bands[p.key] })),
      before, after
    });
  }
  return { before, after, message };
}

/** A writing attempt (WritingAttempt document). */
export async function reviewWriting(attempt, rawBands, { by, note = '', notify = true } = {}) {
  if (attempt.status !== 'completed') throw Object.assign(new Error('Only a marked attempt can be reviewed'), { statusCode: 409 });
  const submitted = (attempt.submittedParts?.length ? attempt.submittedParts : Object.keys(WRITING_PART_MAX))
    .filter(k => WRITING_PART_MAX[k] !== undefined);
  const oldParts = attempt.toObject().parts || {};
  const oldBands = Object.fromEntries(submitted.map(k => [k, oldParts[k]?.band]).filter(([, v]) => Number.isFinite(v)));
  const typed = readBands(rawBands, WRITING_PART_MAX);
  const missing = submitted.filter(k => typed[k] === undefined);
  if (missing.length) throw Object.assign(new Error(`Give a band for ${missing.join(', ')}`), { statusCode: 400 });
  const bands = Object.fromEntries(submitted.map(k => [k, typed[k]]));
  const outcome = scoreWriting(bands);

  const before = { mark: attempt.expertMark ?? null, score: attempt.score ?? null, level: attempt.level || null };
  if (!attempt.expertReview?.at) attempt.expertReview = { before: { bands: oldBands, ...before, complete: Boolean(attempt.complete) } };
  attempt.expertReview.at = new Date();
  attempt.expertReview.by = by;
  attempt.expertReview.note = String(note || '').slice(0, 600);

  for (const [key, band] of Object.entries(bands)) {
    const slot = attempt.parts[key];
    slot.band = band;
    slot.label = writingLabel(key, Math.floor(band));
  }
  attempt.complete = outcome.complete;
  attempt.expertMark = outcome.expertMark;
  attempt.score = outcome.score;
  attempt.level = outcome.level;
  attempt.markModified('parts');
  await attempt.save();

  const after = { mark: attempt.expertMark, score: attempt.score ?? null, level: attempt.level };
  let message = null;
  if (notify) {
    message = await scoreUpdateMessage({
      user: attempt.student?._id || attempt.student, module: 'writing', sentBy: by,
      attemptId: attempt._id, attemptTitle: attempt.testTitle || (attempt.mode === 'check' ? 'Writing check' : 'Writing mock'),
      attemptDate: attempt.markedAt || attempt.submittedAt || attempt.createdAt,
      parts: WRITING_PARTS.filter(p => bands[p.key] !== undefined).map(p => ({ key: p.key, name: p.name, max: p.max, before: oldBands[p.key] ?? null, after: bands[p.key] })),
      before, after
    });
  }
  return { before, after, message };
}

export default { reviewSpeaking, reviewWriting, readBands };
