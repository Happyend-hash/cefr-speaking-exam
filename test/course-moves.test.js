/**
 * Upgrade / downgrade between groups (2026-10-29): from this month or from
 * next month, history kept, planned moves switching on the 1st.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePeriods, moveStudent, plannedMove, cancelPlannedMove, syncLevel, monthRow } from '../services/CourseMonths.js';

const OCT = Date.UTC(2026, 9, 29, 9);
const NOV = Date.UTC(2026, 10, 2, 9);
const student = () => {
  const s = { _id: 's1', name: 'Aziza', level: 'A2', monthlyFee: 400000, active: true, removedAt: null, createdAt: new Date(Date.UTC(2026, 8, 5)),
    payments: [{ _id: 'p1', month: '2026-10', amount: 400000, paidAt: new Date(OCT) }], attendance: [{ date: '2026-10-03', status: 'present' }], results: [] };
  ensurePeriods(s);
  return s;
};

test('upgrade from this month: the new group now, earlier months in the old one, payments kept', () => {
  const s = student();
  moveStudent(s, { level: 'B1', month: '2026-10' }, OCT);
  assert.equal(s.level, 'B1');
  assert.deepEqual(s.periods.map(p => [p.from, p.to, p.level]), [['2026-09', '2026-09', 'A2'], ['2026-10', null, 'B1']]);
  assert.equal(monthRow(s, '2026-09', OCT).level, 'A2');
  const oct = monthRow(s, '2026-10', OCT);
  assert.equal(oct.level, 'B1');
  assert.equal(oct.movedFrom, 'A2');
  assert.equal(oct.status, 'paid', 'the payment stays');
  assert.equal(oct.lessons, 1, 'the attendance stays');
});

test('downgrade from next month: stays in the group until the 1st, then switches by itself', () => {
  const s = student();
  moveStudent(s, { level: 'A1', month: '2026-11' }, OCT);
  assert.equal(s.level, 'A2', 'still A2 this month');
  assert.deepEqual(plannedMove(s, OCT), { level: 'A1', from: '2026-11' });
  assert.equal(monthRow(s, '2026-10', OCT).level, 'A2');
  assert.equal(monthRow(s, '2026-10', OCT).movedTo, 'A1');
  assert.equal(syncLevel(s, OCT), false, 'not before the 1st');
  assert.equal(syncLevel(s, NOV), true);
  assert.equal(s.level, 'A1');
  assert.equal(plannedMove(s, NOV), null);
});

test('a new plan replaces the old one; moving back to the same group or cancelling drops it', () => {
  const s = student();
  moveStudent(s, { level: 'B1', month: '2026-11' }, OCT);
  moveStudent(s, { level: 'A1', month: '2026-11' }, OCT);
  assert.deepEqual(plannedMove(s, OCT), { level: 'A1', from: '2026-11' });
  assert.equal(s.periods.length, 2);
  moveStudent(s, { level: 'A2', month: '2026-11' }, OCT);
  assert.equal(plannedMove(s, OCT), null);
  assert.equal(s.periods.at(-1).to, null, 'the current period runs on again');
  moveStudent(s, { level: 'B1', month: '2026-11' }, OCT);
  assert.equal(cancelPlannedMove(s, OCT), true);
  assert.equal(plannedMove(s, OCT), null);
  assert.equal(s.level, 'A2');
});

test('only this month or next month; not for a student in the archive', () => {
  const s = student();
  assert.throws(() => moveStudent(s, { level: 'B1', month: '2026-12' }, OCT), /this month or next month/);
  s.removedAt = new Date(OCT);
  assert.throws(() => moveStudent(s, { level: 'B1', month: '2026-10' }, OCT), /archive/);
});
