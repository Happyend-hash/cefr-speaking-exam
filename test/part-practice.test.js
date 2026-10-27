/**
 * Part practice (Jamshid, 2026-10-27): an attempt opened and left without a
 * single answer never blocks the next part the student chooses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmptyAttempt } from '../services/AttemptCleanup.js';

test('an opened, never-answered, uncharged attempt is empty and can go', () => {
  assert.equal(isEmptyAttempt({ status: 'in_progress', creditCharged: false, taskResults: [] }), true);
  assert.equal(isEmptyAttempt({ status: 'in_progress', creditCharged: false }), true);
});

test('an attempt with answers, a charged one, or a finished one is kept', () => {
  assert.equal(isEmptyAttempt({ status: 'in_progress', creditCharged: false, taskResults: [{ taskNumber: 7 }] }), false);
  assert.equal(isEmptyAttempt({ status: 'in_progress', creditCharged: true, taskResults: [] }), false);
  assert.equal(isEmptyAttempt({ status: 'evaluating', creditCharged: false, taskResults: [] }), false);
  assert.equal(isEmptyAttempt({ status: 'completed', creditCharged: false, taskResults: [] }), false);
  assert.equal(isEmptyAttempt(null), false);
});
