import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAccuracySuspect } from '../services/PronunciationService.js';

/**
 * The bug this guards against: a fluent, confident speaker with genuinely
 * poor phoneme accuracy was having that low accuracy waved away as a
 * "measurement fault" just because Azure's own (lenient) fluency score sat
 * comfortably above it — in unscripted mode, where there is no reference
 * transcript for accuracy to fail against, so the gap is real evidence, not
 * an artifact. See PronunciationService.js's SUSPECT_GAP comment.
 */

test('unscripted mode never flags accuracy as suspect, however large the gap', () => {
  // The exact profile that was silently excusing real low pronunciation:
  // fluent and confident (high Azure fluency, decent prosody), genuinely bad
  // phonemes (low accuracy).
  assert.equal(
    isAccuracySuspect({ accuracy: 40, fluency: 90, prosody: 75, unscripted: true }),
    false
  );
  // Even the original calibration case, replayed in unscripted mode.
  assert.equal(
    isAccuracySuspect({ accuracy: 39, fluency: 83, prosody: 73, unscripted: true }),
    false
  );
});

test('scripted mode still flags a large gap as suspect (the case it was built for)', () => {
  assert.equal(
    isAccuracySuspect({ accuracy: 39, fluency: 83, prosody: 73, unscripted: false }),
    true
  );
});

test('scripted mode does not flag a small, ordinary gap', () => {
  assert.equal(
    isAccuracySuspect({ accuracy: 65, fluency: 75, prosody: 70, unscripted: false }),
    false
  );
});

test('scripted mode needs both fluency and prosody clear of the gap, not just one', () => {
  // prosody is only 20 points above accuracy — under SUSPECT_GAP (25).
  assert.equal(
    isAccuracySuspect({ accuracy: 50, fluency: 90, prosody: 70, unscripted: false }),
    false
  );
});

test('handles a missing prosody score (prosody assessment is opt-in)', () => {
  assert.equal(
    isAccuracySuspect({ accuracy: 39, fluency: 83, prosody: null, unscripted: false }),
    true
  );
  assert.equal(
    isAccuracySuspect({ accuracy: 39, fluency: 83, prosody: null, unscripted: true }),
    false
  );
});

test('a non-numeric accuracy is never suspect (nothing to be suspicious about)', () => {
  assert.equal(
    isAccuracySuspect({ accuracy: null, fluency: 83, prosody: 73, unscripted: false }),
    false
  );
});
