/**
 * The course by month (Jamshid, 2026-10-27): membership periods, the monthly
 * register and the archive. Plain objects stand in for students.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePeriods, changeTerms, leave, restore, monthRow, monthRegister, monthsOf, registerMonths } from '../services/CourseMonths.js';
import { feeFor, paymentStatus } from '../services/ParentPortal.js';

const NOW = Date.UTC(2026, 9, 27, 9);   // 27 Oct 2026
const at = ym => Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, 15, 9);
let n = 0;
const student = (o = {}) => ({
  _id: `s${++n}`, name: o.name || `Student ${n}`, level: 'A1', active: true, monthlyFee: null,
  payments: [], attendance: [], results: [], createdAt: new Date(at('2026-09')), removedAt: null, leftReason: '', ...o
});
const pay = (month, amount) => ({ _id: `p${++n}`, month, amount, paidAt: new Date(at(month)), note: '' });
const day = (date, status = 'present') => ({ date, status });

test('a student saved before periods gets one from when they joined to when they were removed', () => {
  const s = student({ monthlyFee: 400000, attendance: [day('2026-08-28')], removedAt: new Date(at('2026-10')) });
  assert.equal(ensurePeriods(s), true);
  assert.deepEqual(s.periods, [{ from: '2026-08', to: '2026-10', level: 'A1', fee: 400000 }]);
  assert.equal(ensurePeriods(s), false, 'only once');
});

test('moving group starts a new period this month; earlier months stay in the old group', () => {
  const s = student({ monthlyFee: 400000 });
  ensurePeriods(s);
  changeTerms(s, { level: 'A2' }, '2026-11');
  assert.deepEqual(s.periods.map(p => [p.from, p.to, p.level]), [['2026-09', '2026-10', 'A1'], ['2026-11', null, 'A2']]);
  assert.equal(s.level, 'A2');
  assert.equal(monthRow(s, '2026-10', NOW).level, 'A1');
  assert.equal(monthRow(s, '2026-11', NOW).movedFrom, 'A1');
  assert.equal(monthRow(s, '2026-10', NOW).movedTo, 'A2');
});

test('a change in the month the period began just corrects it', () => {
  const s = student({ createdAt: new Date(at('2026-10')) });
  ensurePeriods(s);
  changeTerms(s, { level: 'B1' }, '2026-10');
  assert.equal(s.periods.length, 1);
  assert.equal(s.periods[0].level, 'B1');
});

test('a new fee counts from this month; earlier months keep the fee they had', () => {
  const s = student({ monthlyFee: 400000, payments: [pay('2026-09', 400000)] });
  ensurePeriods(s);
  changeTerms(s, { fee: 500000 }, '2026-10');
  assert.equal(feeFor(s, '2026-09'), 400000);
  assert.equal(feeFor(s, '2026-10'), 500000);
  assert.equal(paymentStatus(s, '2026-09', NOW).status, 'paid', 'September stays paid in full');
  assert.equal(s.monthlyFee, 500000);
});

test('a fee set for the first time covers the whole period (there was no fee to keep)', () => {
  const s = student();
  ensurePeriods(s);
  changeTerms(s, { fee: 450000 }, '2026-10');
  assert.equal(s.periods.length, 1);
  assert.equal(feeFor(s, '2026-09'), 450000);
});

test('leaving: they count in the month they left, not after, and keep their reason', () => {
  const s = student({ monthlyFee: 400000, attendance: [day('2026-10-02'), day('2026-10-05', 'absent')] });
  ensurePeriods(s);
  leave(s, { reason: 'moved to Tashkent', month: '2026-10', now: new Date(NOW) });
  assert.equal(s.periods[0].to, '2026-10');
  assert.ok(s.removedAt);
  const oct = monthRow(s, '2026-10', NOW);
  assert.equal(oct.leftNow, true);
  assert.equal(oct.leftReason, 'moved to Tashkent');
  assert.equal(oct.lessons, 2);
  assert.equal(oct.absent, 1);
  assert.equal(monthRow(s, '2026-11', NOW), null);
});

test('coming back: same card, a new period after a gap (or the last one reopened)', () => {
  const s = student({ monthlyFee: 400000 });
  ensurePeriods(s);
  leave(s, { month: '2026-09', now: new Date(at('2026-09')) });
  restore(s, { month: '2026-12' });
  assert.equal(s.removedAt, null);
  assert.deepEqual(s.periods.map(p => [p.from, p.to]), [['2026-09', '2026-09'], ['2026-12', null]]);
  assert.equal(monthRow(s, '2026-12', Date.UTC(2026, 11, 20)).returned, true);

  const t = student();
  ensurePeriods(t);
  leave(t, { month: '2026-10', now: new Date(NOW) });
  restore(t, { month: '2026-10' });
  assert.equal(t.periods.length, 1, 'left and came back the same month: one unbroken period');
  assert.equal(t.periods[0].to, null);
});

test('the register: each group as it was, students who left included, totals added up', () => {
  const a = student({ name: 'Aziza', monthlyFee: 400000, payments: [pay('2026-10', 400000)], attendance: [day('2026-10-01'), day('2026-10-03', 'late')] });
  const b = student({ name: 'Bobur', monthlyFee: 400000, payments: [pay('2026-10', 100000)], attendance: [day('2026-10-01', 'absent'), day('2026-10-03')] });
  const c = student({ name: 'Dilnoza', level: 'A2', monthlyFee: 500000 });
  const gone = student({ name: 'Eldor', monthlyFee: 400000, payments: [pay('2026-09', 400000)] });
  [a, b, c, gone].forEach(ensurePeriods);
  leave(gone, { reason: 'finished', month: '2026-09', now: new Date(at('2026-09')) });

  const oct = monthRegister([a, b, c, gone], '2026-10', { levels: ['A1', 'A2'], now: NOW });
  assert.deepEqual(oct.groups.map(g => [g.level, g.rows.map(r => r.name)]), [['A1', ['Aziza', 'Bobur']], ['A2', ['Dilnoza']]]);
  assert.equal(oct.totals.students, 3);
  assert.equal(oct.totals.paid, 500000);
  assert.equal(oct.totals.fees, 1300000);
  assert.equal(oct.totals.owed, 300000 + 500000);
  assert.equal(oct.groups[0].totals.attendance, 75);

  const sep = monthRegister([a, b, c, gone], '2026-09', { levels: ['A1', 'A2'], now: NOW });
  const eldor = sep.groups[0].rows.find(r => r.name === 'Eldor');
  assert.ok(eldor, 'September still shows the student who has since left');
  assert.equal(eldor.leftNow, true);
  assert.equal(eldor.status, 'paid');
});

test('a student who moved mid-year is counted once a month, in the right group', () => {
  const s = student({ name: 'Farrux', monthlyFee: 400000, payments: [pay('2026-10', 400000), pay('2026-11', 450000)] });
  ensurePeriods(s);
  changeTerms(s, { level: 'A2', fee: 450000 }, '2026-11');
  const nov = monthRegister([s], '2026-11', { now: Date.UTC(2026, 10, 20) });
  assert.equal(nov.groups.length, 1);
  assert.equal(nov.groups[0].level, 'A2');
  assert.equal(nov.totals.paid, 450000);
  const oct = monthRegister([s], '2026-10', { now: Date.UTC(2026, 10, 20) });
  assert.equal(oct.groups[0].level, 'A1');
  assert.equal(oct.groups[0].rows[0].fee, 400000);
});

test('the archive lists every month of a student who left, newest first; the picker covers every month', () => {
  const s = student({ monthlyFee: 400000, createdAt: new Date(at('2026-08')), payments: [pay('2026-08', 400000)] });
  ensurePeriods(s);
  leave(s, { month: '2026-10', now: new Date(NOW) });
  assert.deepEqual(monthsOf(s, NOW).map(m => m.month), ['2026-10', '2026-09', '2026-08']);
  assert.deepEqual(monthsOf(s, NOW).map(m => m.status), ['overdue', 'overdue', 'paid']);
  assert.deepEqual(registerMonths([s], NOW), ['2026-10', '2026-09', '2026-08']);
});
