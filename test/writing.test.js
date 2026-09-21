/**
 * The writing module's rules, checked without a database or the network.
 *
 * Every number here comes from the agency's material or from a rule the
 * teacher set — each test names which.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { writingBandsToScore, writingMarkToScore } from '../services/ScoreConversion.js';
import {
  countWords,
  lengthVerdict,
  locateCorrections,
  correctionSegments,
  scoreWriting
} from '../services/WritingScoring.js';
import AIEvaluationService from '../services/AIEvaluationService.js';
import { writingTest } from '../content/writingTests.js';

test("agency worked example: 4 + 2 + 2 = 8 -> 47 -> B1", () => {
  const out = scoreWriting({ part11: 4, part12: 2, part2: 2 });
  assert.equal(out.complete, true);
  assert.equal(out.expertMark, 8);
  assert.equal(out.score, 47);
  assert.equal(out.level, 'B1');
});

test('full marks 5 + 5 + 6 = 16 -> 75 -> C1', () => {
  const out = scoreWriting({ part11: 5, part12: 5, part2: 6 });
  assert.equal(out.score, 75);
  assert.equal(out.level, 'C1');
});

test('conversion table: every published row', () => {
  const table = {
    16: 75, 15.5: 72, 15: 69, 14.5: 67, 14: 65, 13.5: 64, 13: 63, 12.5: 62,
    12: 61, 11.5: 59, 11: 57, 10.5: 55, 10: 53, 9.5: 51, 9: 50, 8.5: 48,
    8: 47, 7.5: 45, 7: 43, 6.5: 41, 6: 40, 5.5: 38, 5: 37, 4.5: 35,
    4: 33, 3.5: 31, 3: 28, 2.5: 25, 2: 21, 1.5: 17, 1: 14, 0.5: 10, 0: 0
  };
  for (const [mark, score] of Object.entries(table)) {
    assert.equal(writingMarkToScore(Number(mark)), score, `mark ${mark}`);
  }
});

test('the level boundaries fall where the table puts them', () => {
  assert.equal(scoreWriting({ part11: 5, part12: 5, part2: 4 }).level, 'C1'); // 14 -> 65
  assert.equal(scoreWriting({ part11: 4, part12: 5, part2: 4 }).level, 'B2'); // 13 -> 63
  assert.equal(scoreWriting({ part11: 3, part12: 3, part2: 3 }).level, 'B1'); // 9 -> 50
  assert.equal(scoreWriting({ part11: 2, part12: 2, part2: 1 }).level, 'B1dan quyi'); // 5 -> 37
});

test('partial submission: no score out of 75, capped at B1', () => {
  const top = scoreWriting({ part11: 5 }); // label "B2 or above"
  assert.equal(top.complete, false);
  assert.equal(top.score, null);
  assert.equal(top.level, 'B1');

  const twoStrong = scoreWriting({ part12: 5, part2: 6 });
  assert.equal(twoStrong.level, 'B1');

  const weak = scoreWriting({ part11: 2 }); // A2
  assert.equal(weak.level, 'B1dan quyi');
});

test('a partial is never scaled up as if it were a whole mock', () => {
  assert.equal(writingBandsToScore({ part11: 5 }).complete, false);
});

test("teacher's under-length rule: Part 2 under 50%, Part 1.2 under 25%", () => {
  assert.equal(lengthVerdict('part2', 89, 180).zero, true);
  assert.equal(lengthVerdict('part2', 90, 180).zero, false);
  assert.equal(lengthVerdict('part12', 29, 120).zero, true);
  assert.equal(lengthVerdict('part12', 30, 120).zero, false);
  // Part 1.1 has no rule.
  assert.equal(lengthVerdict('part11', 3, 50).zero, false);
});

test('word count matches the counter students see', () => {
  assert.equal(countWords('  Dear  Sam,\nI am   fine. '), 5);
  assert.equal(countWords(''), 0);
});

test('corrections: exact quotes placed in order, repeats corrected in place', () => {
  const text = 'I goes to school. He goes too. I goes home.';
  const placed = locateCorrections(text, [
    { wrong: 'I goes', right: 'I go', why: 'agreement' },
    { wrong: 'I goes', right: 'I go', why: 'agreement' },
    { wrong: 'not in text', right: 'x' }
  ]);
  assert.equal(placed.length, 2);
  assert.equal(placed[0].start, 0);
  assert.equal(placed[1].start, text.lastIndexOf('I goes'));

  const segments = correctionSegments(text, placed);
  const rebuilt = segments.map(s => (s.wrong !== undefined ? s.wrong : s.text)).join('');
  assert.equal(rebuilt, text, 'segments must rebuild the original text exactly');
});

test('corrections never overlap and never alter the text', () => {
  const text = 'She have went there.';
  const placed = locateCorrections(text, [
    { wrong: 'have went', right: 'has gone' },
    { wrong: 'went', right: 'gone' }
  ]);
  assert.equal(placed.length, 1);
});

test('marker reply: bands clamped to each scale, missing band is an error', () => {
  const reply = JSON.stringify({
    parts: {
      part11: { band: 7, reasoning: 'r', feedback: 'f', corrections: [] },
      part2: { band: 6, corrections: [{ wrong: 'a', right: 'b' }] }
    },
    overallFeedback: 'ok',
    strengths: ['s'],
    areasForImprovement: ['a']
  });
  const out = AIEvaluationService.parseWritingEvaluation(reply, ['part11', 'part2']);
  assert.equal(out.parts.part11.band, 5, 'Part 1.1 tops out at 5');
  assert.equal(out.parts.part2.band, 6);

  assert.throws(
    () => AIEvaluationService.parseWritingEvaluation(reply, ['part11', 'part12', 'part2']),
    /no band for part12/
  );
  assert.throws(
    () => AIEvaluationService.parseWritingEvaluation(
      JSON.stringify({ parts: { part11: { band: null } } }), ['part11']),
    /no band for part11/,
    'null must never become a zero'
  );
});

test('the seeded test carries the teacher’s word targets', () => {
  const t = writingTest('writing-01');
  assert.equal(t.parts.part11.minWords, 50);
  assert.equal(t.parts.part12.minWords, 120);
  assert.equal(t.parts.part2.minWords, 180);
});
