import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateCorrections, narrowCorrections, correctionSegments } from '../services/WritingScoring.js';

/**
 * A correction crosses out only the words that are wrong, even when the
 * marker quoted and rewrote a whole clause.
 */

const pick = list => list.map(c => [c.wrong, c.right]);

test('one wrong word in a quoted sentence: only that word is crossed out', () => {
  const text = 'Yesterday I goed to the club with my friends.';
  const placed = locateCorrections(text, [
    { wrong: 'Yesterday I goed to the club with my friends.', right: 'Yesterday I went to the club with my friends.', why: 'past tense' }
  ]);
  assert.deepEqual(pick(placed), [['goed', 'went']]);
  assert.equal(text.slice(placed[0].start, placed[0].end), 'goed');
  assert.equal(placed[0].why, 'past tense');
});

test('an extra word is crossed out alone, with nothing to replace it', () => {
  const text = 'I am agree with this idea.';
  assert.deepEqual(pick(locateCorrections(text, [{ wrong: 'I am agree with this idea.', right: 'I agree with this idea.' }])), [['am', '']]);
});

test('a missing word is shown on the word after the gap', () => {
  const text = 'We train in morning every day.';
  assert.deepEqual(pick(locateCorrections(text, [{ wrong: 'in morning every', right: 'in the morning every' }])), [['morning', 'the morning']]);
});

test('two mistakes in one quoted clause: only the changed words are crossed out', () => {
  const text = 'She have many informations about it.';
  const placed = locateCorrections(text, [{ wrong: 'She have many informations about it.', right: 'She has a lot of information about it.' }]);
  assert.ok(placed.length >= 1);
  for (const c of placed) {
    assert.ok(!/She|about/.test(c.wrong), `crossed out too much: ${c.wrong}`);
  }
});

test('an already-precise correction is left exactly as it was', () => {
  const text = 'I did a mistake.';
  assert.deepEqual(pick(locateCorrections(text, [{ wrong: 'did', right: 'made', why: 'collocation' }])), [['did', 'made']]);
});

test('stored corrections from older results are narrowed when shown', () => {
  const text = 'Yesterday I goed to the club.';
  const stored = [{ start: 0, end: text.length, wrong: text, right: 'Yesterday I went to the club.', why: 'tense' }];
  const fixes = narrowCorrections(text, stored);
  const segments = correctionSegments(text, fixes);
  assert.deepEqual(segments, [
    { text: 'Yesterday I ' },
    { wrong: 'goed', right: 'went', why: 'tense' },
    { text: ' to the club.' }
  ]);
});
