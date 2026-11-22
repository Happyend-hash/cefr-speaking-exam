/** The transcription check's word difference (0–100). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { difference } from '../services/TranscribeCompare.js';

test('same words, other case and punctuation, are no difference', () => {
  assert.equal(difference('I think, yes.', 'i think yes'), 0);
  assert.equal(difference('', ''), 0);
});

test('a changed word counts against the longer text', () => {
  const d = difference('I bring up my food', 'I bring up BYU feed');
  assert.ok(d > 0 && d <= 60, String(d));
});

test('nothing in common is 100', () => {
  assert.equal(difference('alpha beta', 'gamma delta'), 100);
  assert.equal(difference('words here', ''), 100);
});
