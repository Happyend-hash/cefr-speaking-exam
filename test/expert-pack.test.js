/** The expert calibration pack: 15 mocks across the levels, one per student, clean recordings only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPack, usable, disagreement, PACK_SIZE, STRATA } from '../services/ExpertPack.js';

const tasks = (ok = true) => Array.from({ length: 8 }, (_, i) => ({ taskNumber: i + 1, audioKey: ok ? `a${i}` : null, transcription: 'I think that...' }));
let n = 0;
const mock = (score, over = {}) => ({
  _id: `r${++n}`, student: `s${n}`, exam: `e${n % 20}`, mode: 'mock', status: 'completed', markingMethod: 'whole-performance',
  overallScore: score, markerBands: [{ part11: 4, part12: 3, part2: 3, part3: 3 }, { part11: 4, part12: 4, part2: 3, part3: 3 }],
  completedAt: new Date('2026-11-01'), taskResults: tasks(), ...over
});

test('only clean, current, full mocks can go to the examiner', () => {
  assert.equal(usable(mock(50)), true);
  assert.equal(usable(mock(50, { mode: 'practice' })), false);
  assert.equal(usable(mock(50, { markerBands: [{}] })), false, 'one reading: before double marking');
  assert.equal(usable(mock(50, { completedAt: new Date('2026-10-01') })), false);
  assert.equal(usable(mock(50, { taskResults: tasks(false) })), false, 'a recording missing');
  assert.equal(usable(mock(50, { teacherBands: { correctedAt: new Date() } })), false, 'already a calibration example');
  assert.equal(usable(mock(50, { markingMethod: 'average' })), false, 'backup mark');
  assert.equal(disagreement([{ part11: 4, part12: 2, part2: 3, part3: 3 }, { part11: 4, part12: 4, part2: 3, part3: 4 }]), 2);
});

test('15 picked across the levels, boundaries first, one per student', () => {
  const pool = [];
  for (const s of [20, 30, 35, 40, 42, 44, 46, 47, 48, 49, 50, 51, 52, 54, 54, 54, 55, 56, 57, 58, 60, 61, 62, 63, 64, 65, 67, 70]) pool.push(mock(s));
  pool.push(mock(54, { student: pool[0].student })); // a second mock by the first student
  const { picked } = selectPack(pool, { seed: 't' });
  assert.equal(picked.length, PACK_SIZE);
  const count = key => picked.filter(p => p.stratum === key).length;
  assert.deepEqual(STRATA.map(s => count(s.key)), STRATA.map(s => s.take));
  assert.equal(new Set(picked.map(p => p.r.student)).size, PACK_SIZE, 'one mock per student');
  assert.ok(picked.filter(p => p.stratum === 'b2low').some(p => p.r.overallScore === 54), 'the 54 cluster is in');
  assert.ok(picked.filter(p => p.stratum === 'b1').filter(p => p.r.overallScore >= 46).length >= 2, 'near the B1/B2 boundary');
});

test('a short level band is topped up from the others', () => {
  const pool = [40, 41, 42, 43, 44, 45, 46, 47, 48, 51, 52, 53, 54, 55, 56, 58, 59, 60].map(s => mock(s));
  const { picked } = selectPack(pool, { seed: 'u' });
  assert.equal(picked.length, PACK_SIZE, 'no below-B1 or C1 mocks, still 15');
});

test('with no C1 and few high B2 mocks, the gap is filled from B2 and B1, not below B1', () => {
  const pool = [20, 25, 30, 33, 35, 36, 37, 40, 42, 44, 46, 47, 48, 49, 50, 51, 52, 53, 54, 54, 55, 56, 57, 59, 62].map(s => mock(s));
  const { picked } = selectPack(pool, { seed: 'v' });
  assert.equal(picked.length, PACK_SIZE);
  assert.equal(picked.filter(p => p.stratum === 'below').length, 2, 'below B1 stays at 2');
});
