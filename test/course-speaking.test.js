/** Speaking mocks on the course card: recorded like vocabulary, kept when deleted, retakes show the new score. */
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
const { snapshotOf, mergeSpeaking, speakingSummary } = await import('../services/CourseSpeaking.js');

const id = () => new mongoose.Types.ObjectId();
const user = id();
const mock3 = { _id: id(), title: 'Speaking Mock 3' };
const mock5 = { _id: id(), title: 'Speaking Mock 5' };
const attempt = (exam, score, level, at, extra = {}) => ({
  _id: id(), student: user, exam, mode: 'mock', status: 'completed', overallScore: score, overallLevel: level,
  partBands: { part11: 4, part12: 3.5, part2: 4, part3: 4 }, submittedAt: new Date(at), ...extra
});

test('an attempt is kept with its mock, score, level and part bands', () => {
  const s = snapshotOf(attempt(mock3, 52, 'B2', '2026-11-05T10:00:00Z'));
  assert.equal(s.title, 'Speaking Mock 3');
  assert.equal(String(s.exam), String(mock3._id));
  assert.equal(s.score, 52);
  assert.equal(s.level, 'B2');
  assert.deepEqual(s.bands, { part11: 4, part12: 3.5, part2: 4, part3: 4 });
  assert.equal(s.status, 'completed');
  const marking = snapshotOf(attempt(mock3, undefined, undefined, '2026-11-06T10:00:00Z', { status: 'evaluating' }));
  assert.equal(marking.status, 'marking');
  assert.equal(marking.score, null);
});

test('new attempts are added, re-marks update, and a deleted one stays on the card', () => {
  const a = snapshotOf(attempt(mock3, 47, 'B1', '2026-11-01T10:00:00Z'));
  const b = snapshotOf(attempt(mock5, 50, 'B1', '2026-11-03T10:00:00Z'));
  let { list, changed } = mergeSpeaking([], [a, b], user);
  assert.equal(changed, true);
  assert.equal(list.length, 2);
  assert.equal(String(list[0].result), String(b.result), 'newest first');

  ({ list, changed } = mergeSpeaking(list, [a, b], user));
  assert.equal(changed, false, 'nothing new: nothing to save');

  const remarked = { ...b, score: 53, level: 'B2', expert: true };
  ({ list, changed } = mergeSpeaking(list, [a, remarked], user));
  assert.equal(changed, true);
  assert.equal(list.find(e => String(e.result) === String(b.result)).score, 53);

  // the student deleted attempt a on the website: it is no longer among their attempts
  ({ list, changed } = mergeSpeaking(list, [remarked], user));
  assert.equal(list.length, 2, 'the teacher keeps it');
});

test("another account's attempts go when the student is linked to a different Gmail", () => {
  const other = id();
  const old = { ...snapshotOf(attempt(mock3, 40, 'B1', '2026-10-01T10:00:00Z')), user: other };
  const mine = snapshotOf(attempt(mock5, 55, 'B2', '2026-11-02T10:00:00Z'));
  const { list } = mergeSpeaking([old], [mine], user);
  assert.deepEqual(list.map(e => String(e.result)), [String(mine.result)]);
});

test('a retaken mock shows its newest score and the one it replaced; counts and progress add up', () => {
  const entries = [
    snapshotOf(attempt(mock3, 41, 'B1', '2026-10-20T10:00:00Z')),
    snapshotOf(attempt(mock5, 47, 'B1', '2026-11-02T10:00:00Z')),
    snapshotOf(attempt(mock3, 52, 'B2', '2026-11-08T10:00:00Z')),
    { ...snapshotOf(attempt(mock5, undefined, undefined, '2026-11-09T10:00:00Z', { status: 'evaluating' })) },
    snapshotOf(attempt(mock3, 30, 'B1dan quyi', '2026-11-04T10:00:00Z', { mode: 'practice', part: 'part2', partBands: { part2: 3 } }))
  ];
  const sum = speakingSummary(entries, '2026-11');
  assert.equal(sum.submitted, 4, 'practice parts are not mocks');
  assert.equal(sum.thisMonth, 3);
  assert.equal(sum.mocksTaken, 2);
  assert.equal(sum.marking, 1);
  assert.deepEqual(sum.best, { score: 52, level: 'B2', title: 'Speaking Mock 3' });
  assert.deepEqual(sum.progress.map(p => p.score), [41, 47, 52], 'oldest first');

  const m3 = sum.mocks.find(m => m.title === 'Speaking Mock 3');
  assert.deepEqual(m3.current, { score: 52, level: 'B2' });
  assert.deepEqual(m3.previous, { score: 41, level: 'B1' });
  assert.equal(m3.attempts.length, 2);

  const m5 = sum.mocks.find(m => m.title === 'Speaking Mock 5');
  assert.equal(m5.latest.status, 'marking', 'the retake is being marked');
  assert.deepEqual(m5.current, { score: 47, level: 'B1' }, 'until then the last score stands');
  assert.equal(m5.previous, null);
  assert.equal(sum.mocks[0].title, 'Speaking Mock 5', 'most recently taken first');

  assert.equal(sum.practice.count, 1);
  assert.equal(sum.practice.recent[0].part, 'part2');
  assert.equal(sum.practice.recent[0].bands.part2, 3);
});

test('a student with nothing handed in has an empty summary', () => {
  const sum = speakingSummary([], '2026-11');
  assert.equal(sum.submitted, 0);
  assert.equal(sum.best, null);
  assert.deepEqual(sum.mocks, []);
});
