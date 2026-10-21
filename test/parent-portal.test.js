import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWeakCode, newParentCode, signInBlocked, noteWrongCode, noteRightCode, dashboard, readPhoto,
  leaderboard, monthAverage, monthOf, familyOf, MAX_TRIES, GLOBAL_MAX_FAILS, _guard,
  attendanceSummary, paymentStatus, paymentHistory, dayOf, mergeDays, vocabSummary
} from '../services/ParentPortal.js';

/** The parents' page: 6-digit codes, guessing kept out, and the numbers shown. */

test('codes are six digits, never 111111 or 123456, and never one already taken', async () => {
  assert.equal(isWeakCode('111111'), true);
  assert.equal(isWeakCode('123456'), true);
  assert.equal(isWeakCode('654321'), true);
  assert.equal(isWeakCode('482913'), false);
  const taken = new Set();
  for (let i = 0; i < 200; i += 1) {
    const code = await newParentCode({ exists: async c => taken.has(c) });
    assert.match(code, /^\d{6}$/);
    assert.equal(isWeakCode(code), false);
    assert.equal(taken.has(code), false);
    taken.add(code);
  }
});

test('one address gets a few wrong codes, then waits; a right code clears it', () => {
  _guard.reset();
  const t = 1_000_000;
  for (let i = 0; i < MAX_TRIES; i += 1) {
    assert.equal(signInBlocked('1.1.1.1', t + i).blocked, false);
    noteWrongCode('1.1.1.1', t + i);
  }
  assert.equal(signInBlocked('1.1.1.1', t + 100).blocked, true);
  assert.equal(signInBlocked('2.2.2.2', t + 100).blocked, false, 'other parents are not affected');
  assert.equal(signInBlocked('1.1.1.1', t + 16 * 60 * 1000).blocked, false, 'free again after 15 minutes');
  noteRightCode('1.1.1.1');
});

test('wrong codes from everywhere at once pause sign-in for everyone', () => {
  _guard.reset();
  const t = 5_000_000;
  for (let i = 0; i < GLOBAL_MAX_FAILS; i += 1) noteWrongCode(`10.0.${Math.floor(i / 200)}.${i % 200}`, t + i);
  const b = signInBlocked('9.9.9.9', t + 1000);
  assert.equal(b.blocked, true);
  assert.equal(b.everyone, true);
  _guard.reset();
});

test('the dashboard: latest score, the one before, and averages level by level', () => {
  const s = {
    name: 'Aziza', level: 'B1', photo: { data: Buffer.from([1]), updatedAt: new Date('2026-10-01') },
    results: [
      { _id: 'r2', date: new Date('2026-09-20'), level: 'A2', skills: { vocabulary: 70, grammar: 60, listening: null, reading: 80, speaking: 50, writing: 40 } },
      { _id: 'r1', date: new Date('2026-09-01'), level: 'A2', skills: { vocabulary: 60, grammar: 50, listening: 55, reading: 70, speaking: 45, writing: null } },
      { _id: 'r3', date: new Date('2026-10-10'), level: 'B1', skills: { vocabulary: 75, grammar: 65, listening: 60, reading: 72, speaking: 58, writing: 52 } }
    ]
  };
  const d = dashboard(s);
  assert.deepEqual(d.results.map(r => r.id), ['r1', 'r2', 'r3'], 'oldest first');
  assert.equal(d.latest.vocabulary, 75);
  assert.equal(d.previous.vocabulary, 70);
  assert.equal(d.latest.listening, 60);
  assert.equal(d.previous.listening, 55, 'a missing score is skipped, not counted as zero');
  assert.equal(d.overall, Math.round((75 + 65 + 60 + 72 + 58 + 52) / 6));
  assert.deepEqual(d.levelsStudied.map(l => [l.level, l.tests]), [['A2', 2], ['B1', 1]]);
  assert.equal(d.levelsStudied[0].skills.vocabulary, 65);
  assert.equal(d.levelsStudied[0].skills.writing, 40, 'average of the scores that exist');
  assert.equal(d.hasPhoto, true);
});

test('a child with no tests yet shows empty, not zeros', () => {
  const d = dashboard({ name: 'Bek', level: 'A1', results: [] });
  assert.equal(d.overall, null);
  assert.equal(d.latest.grammar, null);
  assert.deepEqual(d.levelsStudied, []);
  assert.equal(d.hasPhoto, false);
});

test('photos: only real JPEG, PNG or WebP, and not too big', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  assert.equal(readPhoto(`data:image/jpeg;base64,${jpeg.toString('base64')}`).contentType, 'image/jpeg');
  assert.throws(() => readPhoto('data:image/svg+xml;base64,PHN2Zz4='), /JPEG, PNG or WebP/);
  assert.throws(() => readPhoto(`data:image/jpeg;base64,${Buffer.from('hello').toString('base64')}`), /not an image/);
  const big = Buffer.alloc(700 * 1024); big[0] = 0xff; big[1] = 0xd8;
  assert.throws(() => readPhoto(`data:image/jpeg;base64,${big.toString('base64')}`), /too large/);
});

test('months are Tashkent months', () => {
  assert.equal(monthOf('2026-10-31T18:59:00Z'), '2026-10');
  assert.equal(monthOf('2026-10-31T19:00:00Z'), '2026-11', 'midnight in Tashkent');
});

const hw = (id, date, skills) => ({ _id: id, date: new Date(date), level: 'B1', skills });
const kid = (id, name, level, results, extra = {}) => ({ _id: id, name, level, active: true, results, ...extra });

test("a month's average counts every homework percent of that month only", () => {
  const s = kid('a', 'Aziza', 'B1', [
    hw('1', '2026-09-28T10:00:00Z', { vocabulary: 10 }),
    hw('2', '2026-10-02T10:00:00Z', { vocabulary: 80, grammar: 70 }),
    hw('3', '2026-10-09T10:00:00Z', { listening: 90 })
  ]);
  assert.deepEqual(monthAverage(s, '2026-10'), { percent: 80, homeworks: 2 });
  assert.deepEqual(monthAverage(s, '2026-08'), { percent: null, homeworks: 0 });
});

test('the ranking: one level, this month, highest first, equal averages share a place', () => {
  const M = '2026-10';
  const students = [
    kid('a', 'Aziza', 'B1', [hw('1', '2026-10-02T10:00:00Z', { vocabulary: 90 })]),
    kid('b', 'Bekzod', 'B1', [hw('2', '2026-10-03T10:00:00Z', { grammar: 75, reading: 85 })]),
    kid('c', 'Dilnoza', 'B1', [hw('3', '2026-10-04T10:00:00Z', { speaking: 80 })]),
    kid('d', 'Javlon', 'B1', [hw('4', '2026-09-30T10:00:00Z', { writing: 99 })]),
    kid('e', 'Malika', 'A2', [hw('5', '2026-10-05T10:00:00Z', { vocabulary: 100 })]),
    kid('f', 'Sardor', 'B1', [hw('6', '2026-10-06T10:00:00Z', { vocabulary: 95 })], { active: false })
  ];
  const b = leaderboard(students, 'B1', M);
  assert.deepEqual(b.rows.map(r => [r.name, r.rank, r.percent]), [
    ['Aziza', 1, 90], ['Bekzod', 2, 80], ['Dilnoza', 2, 80], ['Javlon', null, null]
  ]);
  assert.ok(!b.rows.some(r => r.name === 'Malika'), 'other levels are not in it');
  assert.ok(!b.rows.some(r => r.name === 'Sardor'), 'paused children are not in it');
});

test('a family is its familyId, or the child itself when added alone', () => {
  assert.equal(familyOf({ _id: 'x1', familyId: 'f9' }), 'f9');
  assert.equal(familyOf({ _id: 'x1' }), 'x1');
});

test('attendance: one month, counts, and the days missed or late', () => {
  const s = { attendance: [
    { date: '2026-09-30', status: 'absent' },
    { date: '2026-10-02', status: 'present' },
    { date: '2026-10-09', status: 'absent' },
    { date: '2026-10-07', status: 'late' },
    { date: '2026-10-14', status: 'present' }
  ] };
  const a = attendanceSummary(s, '2026-10');
  assert.equal(a.lessons, 4);
  assert.equal(a.attended, 3, 'late still counts as came');
  assert.equal(a.absent, 1);
  assert.equal(a.percent, 75);
  assert.deepEqual(a.missed, ['2026-10-09']);
  assert.deepEqual(a.lateDays, ['2026-10-07']);
  assert.deepEqual(a.days.map(d => d.date), ['2026-10-02', '2026-10-07', '2026-10-09', '2026-10-14'], 'in date order');
  assert.equal(attendanceSummary({ attendance: [] }, '2026-10').percent, null, 'no lessons: no percent, not 0%');
});

const at = iso => Date.parse(iso);
test('payment: paid, part paid, a gentle reminder until the 10th, then overdue', () => {
  const fee = { monthlyFee: 500000 };
  const oct5 = at('2026-10-05T06:00:00Z'), oct11 = at('2026-10-11T06:00:00Z');
  assert.equal(paymentStatus({ ...fee, payments: [] }, '2026-10', oct5).status, 'due');
  assert.equal(paymentStatus({ ...fee, payments: [] }, '2026-10', oct11).status, 'overdue');
  const part = paymentStatus({ ...fee, payments: [{ month: '2026-10', amount: 300000, paidAt: new Date(oct5) }] }, '2026-10', oct11);
  assert.equal(part.status, 'partial');
  assert.equal(part.overdue, true, 'part paid after the 10th is flagged');
  assert.equal(part.left, 200000);
  const full = paymentStatus({ ...fee, payments: [
    { month: '2026-10', amount: 300000, paidAt: new Date(oct5) }, { month: '2026-10', amount: 200000, paidAt: new Date(oct11) }
  ] }, '2026-10', oct11);
  assert.equal(full.status, 'paid');
  assert.equal(full.paid, 500000);
  assert.equal(paymentStatus({ payments: [{ month: '2026-10', amount: 1000, paidAt: new Date(oct5) }] }, '2026-10', oct11).status, 'paid', 'no fee set: any payment counts');
  assert.equal(paymentStatus({ ...fee, payments: [{ month: '2026-09', amount: 500000 }] }, '2026-10', oct5).status, 'due', 'last month does not pay this month');
});

test('payment history: earlier months, from the month the child joined', () => {
  const s = { monthlyFee: 500000, createdAt: new Date('2026-08-20'), payments: [
    { month: '2026-08', amount: 500000 }, { month: '2026-09', amount: 200000 }
  ] };
  const h = paymentHistory(s, 6, at('2026-10-17T06:00:00Z'));
  assert.deepEqual(h.map(x => [x.month, x.status]), [['2026-09', 'partial'], ['2026-08', 'paid']]);
});

test('one day of homework is one result, however many times it was saved', () => {
  const sk = o => ({ vocabulary: null, grammar: null, listening: null, reading: null, speaking: null, writing: null, ...o });
  const results = [
    { _id: 'a', date: new Date('2026-10-17T00:00:00Z'), level: 'A2', title: '', skills: sk({ writing: 100 }), createdAt: new Date('2026-10-17T06:00:00Z') },
    { _id: 'b', date: new Date('2026-10-17T00:00:00Z'), level: 'A2', title: 'Unit 3', skills: sk({ vocabulary: 80 }), createdAt: new Date('2026-10-17T07:00:00Z') },
    { _id: 'c', date: new Date('2026-10-17T00:00:00Z'), level: 'A2', title: '', skills: sk({ speaking: 90, writing: 95 }), createdAt: new Date('2026-10-17T08:00:00Z') },
    { _id: 'd', date: new Date('2026-10-16T00:00:00Z'), level: 'A2', title: '', skills: sk({ grammar: 70 }) }
  ];
  const days = mergeDays(results);
  assert.equal(days.length, 2);
  assert.equal(days[0].day, '2026-10-16');
  assert.deepEqual(days[1].skills, sk({ vocabulary: 80, speaking: 90, writing: 95 }));
  assert.equal(days[1].title, 'Unit 3');
  assert.equal(days[1].id, 'a');
  const d = dashboard({ _id: 'x', name: 'Ali', level: 'A2', results });
  assert.equal(d.results.length, 2);
  const m = monthAverage({ results }, '2026-10');
  assert.equal(m.homeworks, 2);
  assert.equal(m.percent, Math.round(((70 + 80 + 90 + 95) / 4) * 10) / 10);
});

test('vocabulary units: the newest result counts, a general test replaces the units but keeps their history', () => {
  const at = (h) => new Date(`2026-10-01T0${h}:00:00Z`);
  const student = {
    level: 'A2',
    vocab: [
      { _id: 'a', level: 'A2', unit: 1, percent: 50, date: '2026-10-03', source: 'unit', createdAt: at(1) },
      { _id: 'b', level: 'A2', unit: 1, percent: 70, date: '2026-10-05', source: 'unit', createdAt: at(2) },
      { _id: 'c', level: 'A2', unit: 2, percent: 40, date: '2026-10-06', source: 'unit', createdAt: at(3) },
      { _id: 'd', level: 'A2', unit: 1, percent: 90, date: '2026-10-28', source: 'general', test: 't1', createdAt: at(4) },
      { _id: 'e', level: 'A2', unit: 2, percent: 80, date: '2026-10-28', source: 'general', test: 't1', createdAt: at(5) },
      { _id: 'f', level: 'B1', unit: 1, percent: 10, date: '2026-10-28', source: 'unit', createdAt: at(6) }   // another level
    ],
    vocabTests: [{ _id: 't1', level: 'A2', date: '2026-10-28', percent: 85, perUnit: true }]
  };
  const v = vocabSummary(student, 3);
  assert.equal(v.list.length, 3);
  assert.deepEqual(v.list.map(u => u.percent), [90, 80, null]);
  assert.equal(v.list[0].before, 70);                 // the unit test it replaced
  assert.equal(v.list[0].history.length, 3);
  assert.equal(v.done, 2);
  assert.equal(v.average, 85);                        // the general test now sets the average
  assert.equal(v.unitAverage, 55);                    // units alone: (70 + 40) / 2
  assert.equal(v.latestTest.percent, 85);
  assert.deepEqual(v.weak, []);

  const before = vocabSummary({ level: 'A2', vocab: student.vocab.filter(r => r.source === 'unit') }, 3);
  assert.deepEqual(before.weak, [{ unit: 2, percent: 40 }]);
  assert.equal(before.average, 55);
  assert.equal(before.latestTest, null);
});
