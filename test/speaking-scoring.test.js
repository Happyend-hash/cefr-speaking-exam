/**
 * The speaking module's rules, checked without a database or the network.
 *
 * The rubric (content/speakingRubric.js) and the conversion table
 * (services/ScoreConversion.js) come from the school's own material, supplied
 * directly (Rating scale for Multilevel speaking exams + the raw-to-reported
 * conversion table). Every number here traces back to one of those two
 * documents.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  speakingBandsToScore,
  speakingExpertMark,
  speakingMarkToScore,
  SPEAKING_PART_MAX,
  SPEAKING_RAW_MAX
} from '../services/ScoreConversion.js';
import { scoreSpeaking, PARTIAL_LEVEL_CAP } from '../services/SpeakingScoring.js';
import {
  SPEAKING_PARTS,
  SPEAKING_PART_KEYS,
  speakingDescriptor,
  speakingLabel,
  speakingNextBand,
  speakingBandLevel
} from '../content/speakingRubric.js';

test('the four parts sum to the conversion table\'s ceiling: 5+5+5+6 = 21', () => {
  assert.equal(SPEAKING_RAW_MAX, 21);
  assert.deepEqual(SPEAKING_PART_MAX, { part11: 5, part12: 5, part2: 5, part3: 6 });
});

test('full marks on every part -> 21 -> 75 -> C1', () => {
  const out = scoreSpeaking({ part11: 5, part12: 5, part2: 5, part3: 6 });
  assert.equal(out.complete, true);
  assert.equal(out.expertMark, 21);
  assert.equal(out.score, 75);
  assert.equal(out.level, 'C1');
});

test('zero on every part -> 0 -> 0 -> below B1', () => {
  const out = scoreSpeaking({ part11: 0, part12: 0, part2: 0, part3: 0 });
  assert.equal(out.score, 0);
  assert.equal(out.level, 'B1dan quyi');
});

test('conversion table: every published row', () => {
  const table = {
    21: 75, 20.5: 73, 20: 71, 19.5: 69, 19: 67, 18.5: 65, 18: 64,
    17.5: 63, 17: 61, 16.5: 59, 16: 57, 15.5: 56, 15: 54, 14.5: 52,
    14: 51, 13.5: 50, 13: 49, 12.5: 47, 12: 46, 11.5: 45, 11: 43,
    10.5: 42, 10: 40, 9.5: 39, 9: 38, 8.5: 37, 8: 35, 7.5: 33,
    7: 32, 6.5: 30, 6: 29, 5.5: 27, 5: 26, 4.5: 24, 4: 23,
    3.5: 21, 3: 19, 2.5: 17, 2: 15, 1.5: 13, 1: 11, 0.5: 10, 0: 0
  };
  for (const [mark, score] of Object.entries(table)) {
    assert.equal(speakingMarkToScore(Number(mark)), score, `mark ${mark}`);
  }
});

test('the level boundaries fall where the table puts them', () => {
  // 38-50 B1, 51-64 B2, 65-75 C1, else below B1 — every mark below is a plain
  // sum of the four bands, converted by the published table.
  assert.equal(scoreSpeaking({ part11: 5, part12: 5, part2: 5, part3: 4 }).score, 67); // 19 -> 67
  assert.equal(scoreSpeaking({ part11: 5, part12: 5, part2: 5, part3: 4 }).level, 'C1');

  assert.equal(scoreSpeaking({ part11: 5, part12: 4, part2: 4, part3: 3 }).score, 57); // 16 -> 57
  assert.equal(scoreSpeaking({ part11: 5, part12: 4, part2: 4, part3: 3 }).level, 'B2');

  assert.equal(scoreSpeaking({ part11: 2, part12: 2, part2: 2, part3: 3 }).score, 38); // 9 -> 38
  assert.equal(scoreSpeaking({ part11: 2, part12: 2, part2: 2, part3: 3 }).level, 'B1');

  assert.equal(scoreSpeaking({ part11: 1, part12: 1, part2: 1, part3: 1 }).score, 23); // 4 -> 23
  assert.equal(scoreSpeaking({ part11: 1, part12: 1, part2: 1, part3: 1 }).level, 'B1dan quyi');
});

test('a plain sum, never weighted or averaged', () => {
  const mark = speakingExpertMark({ part11: 3, part12: 3, part2: 3, part3: 3 });
  assert.equal(mark.mark, 12);
  assert.equal(mark.complete, true);
});

test('partial submission (practice mode, one part): no score out of 75, capped', () => {
  // Part 1.1 alone never reaches this app's reported floor (its own ceiling
  // is "Above A2", entirely below B1) however high the band.
  const part11Full = scoreSpeaking({ part11: 5 });
  assert.equal(part11Full.complete, false);
  assert.equal(part11Full.score, null);
  assert.equal(part11Full.level, 'B1dan quyi');

  // Part 1.2 at its top band shows B1, capped there (never inferred as B2).
  const part12Full = scoreSpeaking({ part12: 5 });
  assert.equal(part12Full.level, 'B1');

  // Part 3 at its top band would show C1, but a partial submission is capped
  // at B1 regardless — the same rule writing uses.
  const part3Full = scoreSpeaking({ part3: 6 });
  assert.equal(part3Full.level, PARTIAL_LEVEL_CAP);
});

test('a partial is never scaled up as if it were a whole mock', () => {
  assert.equal(speakingBandsToScore({ part3: 6 }).complete, false);
  assert.equal(speakingBandsToScore({ part3: 6 }).mark, 6);
});

test('a missing part is dropped, not zeroed', () => {
  const out = scoreSpeaking({ part11: 4, part12: null, part2: undefined, part3: 5 });
  assert.equal(out.expertMark, 9);
  assert.equal(out.complete, false);
});

test('bands are clamped to each part\'s own ceiling', () => {
  const out = speakingExpertMark({ part11: 9, part12: -3, part2: 5, part3: 9 });
  // part11 clamped to 5, part12 clamped to 0, part2 = 5, part3 clamped to 6
  assert.equal(out.mark, 5 + 0 + 5 + 6);
});

test('every part has a descriptor for every band 0 through its max', () => {
  for (const part of SPEAKING_PARTS) {
    for (let band = 0; band <= part.max; band += 1) {
      const descriptor = speakingDescriptor(part.key, band);
      assert.ok(Array.isArray(descriptor) && descriptor.length > 0, `${part.key} band ${band}`);
      assert.ok(speakingLabel(part.key, band) !== '' || band === 0, `${part.key} band ${band} label`);
    }
  }
});

test('the next band up is always one step, never the old "between" bands', () => {
  const next = speakingNextBand('part3', 4);
  assert.equal(next.band, 5);
  assert.equal(next.label, 'C1');
  assert.ok(next.descriptor.length > 0);

  // At the ceiling there is nothing above.
  assert.equal(speakingNextBand('part3', 6), null);
  assert.equal(speakingNextBand('part11', 5), null);
});

test('part-level CEFR reading used only for partial caps', () => {
  assert.equal(speakingBandLevel('part11', 5), null); // "Above A2" never reaches B1
  assert.equal(speakingBandLevel('part12', 5), 'B1'); // "Above B1" read conservatively
  assert.equal(speakingBandLevel('part2', 4), 'B2');
  assert.equal(speakingBandLevel('part3', 6), 'C1'); // "Above C1" capped at C1
  assert.equal(speakingBandLevel('part3', 1), null);
});

test('all four part keys are distinct and in exam order', () => {
  assert.deepEqual(SPEAKING_PART_KEYS, ['part11', 'part12', 'part2', 'part3']);
});
