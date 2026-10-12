import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineVerdicts, combinePart, needsThirdMarker } from '../services/DoubleMarking.js';
import { scoreSpeaking } from '../services/SpeakingScoring.js';
import { firstJsonObject } from '../services/AIEvaluationService.js';
import { markTwice } from '../routes/exam.js';

/**
 * Two examiners, as the real exam does it — and the JSON reading bug that
 * sent three mocks to the averaging fallback.
 */

const v = (part11, part12, part2, part3, text = '') => ({ bands: { part11, part12, part2, part3 }, reasoning: text });

test('two readings that agree give that band; one band apart gives the half', () => {
  assert.equal(combinePart([3, 3]), 3);
  assert.equal(combinePart([2, 3]), 2.5);
  assert.equal(combinePart([4]), 4);
  assert.equal(combinePart([]), undefined);
});

test('with three readings the outlier does not count', () => {
  assert.equal(combinePart([2, 3, 5]), 2.5);
  assert.equal(combinePart([2, 4, 4]), 4);
  assert.equal(combinePart([1, 3, 4]), 3.5);
});

test('a third marker is called only when two readings are two bands apart', () => {
  assert.equal(needsThirdMarker([v(5, 4, 3, 3), v(5, 4, 2, 3)]), false);
  assert.equal(needsThirdMarker([v(5, 4, 3, 3), v(5, 4, 1, 3)]), true);
  assert.equal(needsThirdMarker([v(5, 4, 3, 3)]), false);
});

test("Nilufar's two mocks: averaged readings narrow the swing between attempts", () => {
  // Mock 4 was read 5/4/2/3 and Mock 16 5/4/3/3 by one marker. With a second
  // reading each part lands between, and the two mocks end up closer together.
  const a = combineVerdicts([v(5, 4, 2, 3), v(5, 4, 3, 3)]);
  assert.deepEqual(a.bands, { part11: 5, part12: 4, part2: 2.5, part3: 3 });
  const s = scoreSpeaking(a.bands);
  assert.equal(s.expertMark, 14.5);
  assert.equal(s.score, 52, 'the half-point row of the official table');
});

test("the comments shown come from the reading closest to the final bands", () => {
  const out = combineVerdicts([v(5, 4, 3, 3, 'first'), v(5, 4, 1, 3, 'second'), v(5, 4, 3, 3, 'third')]);
  assert.equal(out.bands.part2, 3);
  assert.equal(out.closest.reasoning, 'first');
});

test('a practice part marked 2.5 reads as the lower band\'s level, not as nothing', () => {
  const s = scoreSpeaking({ part2: 2.5 });
  assert.equal(s.complete, false);
  assert.notEqual(s.level, undefined);
  assert.equal(s.level, scoreSpeaking({ part2: 2 }).level);
});

test('markTwice marks twice, calls a third reading on a wide gap, and survives one failure', async () => {
  const replies = [v(5, 4, 3, 3), v(5, 4, 1, 3), v(5, 4, 2, 3)];
  let calls = 0;
  const out = await markTwice(async () => replies[calls++]);
  assert.equal(calls, 3, 'two readings, then a third for the 2-band gap on Part 2');
  assert.equal(out.bands.part2, 2, '3, 1 and 2: no pair is closer than another, so the middle reading stands');
  assert.equal(out.markers.length, 3);
  assert.equal(typeof out.score, 'number');

  let n = 0;
  const one = await markTwice(async () => { n += 1; if (n === 1) throw new Error('parse'); return v(5, 4, 3, 3); });
  assert.deepEqual(one.bands, { part11: 5, part12: 4, part2: 3, part3: 3 }, 'one good reading is still a mark');

  await assert.rejects(markTwice(async () => { throw new Error('down'); }), /down/);
});

test('SPEAKING_MARKERS=1 goes back to a single reading', async () => {
  process.env.SPEAKING_MARKERS = '1';
  try {
    let calls = 0;
    await markTwice(async () => { calls += 1; return v(5, 4, 3, 3); });
    assert.equal(calls, 1);
  } finally {
    delete process.env.SPEAKING_MARKERS;
  }
});

test('the JSON object is found even with prose and braces after it', () => {
  const reply = '```json\n{"bands":{"part2":3},"reasoning":"uses {braces} in a string"}\n```\nNote: I considered {part2: 2} but chose 3.';
  assert.deepEqual(JSON.parse(firstJsonObject(reply)).bands, { part2: 3 });
  assert.equal(firstJsonObject('Here: {not json} then {"score": 40, "criteria": {}}'), '{"score": 40, "criteria": {}}');
  assert.equal(firstJsonObject('no object here'), null);
});
