/**
 * Leaderboard rules that do not need a database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { countsForLeaderboard, fallbackName } from '../services/Leaderboard.js';

const full = { status: 'completed', overallScore: 60, mode: 'mock', module: 'speaking' };

test('only full, marked speaking mocks count', () => {
  assert.equal(countsForLeaderboard(full), true);
  assert.equal(countsForLeaderboard({ ...full, mode: 'practice', part: '3' }), false);
  assert.equal(countsForLeaderboard({ ...full, module: 'writing' }), false);
  assert.equal(countsForLeaderboard({ ...full, status: 'submitted' }), false);
  assert.equal(countsForLeaderboard({ ...full, overallScore: undefined }), false);
  // Attempts from before `mode`/`module` existed were full speaking mocks.
  assert.equal(countsForLeaderboard({ status: 'completed', overallScore: 55 }), true);
});

test('without a nickname: first name and last initial', () => {
  assert.equal(fallbackName({ firstName: 'Aziza', lastName: 'karimova' }), 'Aziza K.');
  assert.equal(fallbackName({ firstName: 'Ali', lastName: '' }), 'Ali');
  assert.equal(fallbackName({}), "O'quvchi");
});
