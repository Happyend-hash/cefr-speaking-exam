import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentStatus, paymentYear, paidAhead, schoolYearOf } from '../services/ParentPortal.js';
import { buildReport, changesSince } from '../services/PaymentReport.js';

/** Payments: by month for the school year, paid ahead, and mistakes kept but never counted. */
const NOW = Date.parse('2026-10-23T09:00:00Z');   // 23 Oct, Tashkent
const pay = (id, month, amount, paidAt, extra = {}) => ({ _id: id, month, amount, paidAt: new Date(paidAt), createdAt: new Date(paidAt), note: '', ...extra });

const ali = {
  name: 'Ali', level: 'A2', monthlyFee: 500000, createdAt: new Date('2026-09-05'),
  payments: [
    pay('p1', '2026-09', 500000, '2026-09-08'),
    pay('p2', '2026-10', 300000, '2026-10-05'),
    pay('p3', '2026-10', 200000, '2026-10-20'),
    pay('p4', '2026-11', 500000, '2026-10-20'),                       // paid ahead
    pay('p5', '2026-12', 250000, '2026-10-20'),                       // part paid ahead
    pay('p6', '2027-01', 500000, '2026-10-21', { voidedAt: new Date('2026-10-22'), voidReason: 'wrong student' })
  ]
};

test('a month adds up its payments; a mistake is listed but not counted', () => {
  const oct = paymentStatus(ali, '2026-10', NOW);
  assert.equal(oct.paid, 500000); assert.equal(oct.status, 'paid');
  const jan = paymentStatus(ali, '2027-01', NOW);
  assert.equal(jan.paid, 0); assert.equal(jan.status, 'upcoming'); assert.equal(jan.voided.length, 1);
  assert.equal(jan.voided[0].voidReason, 'wrong student');
});

test('future months: paid ahead, part paid ahead, or still to come — never "not paid"', () => {
  assert.equal(paymentStatus(ali, '2026-11', NOW).status, 'advance');
  assert.equal(paymentStatus(ali, '2026-12', NOW).status, 'partial');
  assert.equal(paymentStatus(ali, '2026-12', NOW).overdue, false);
  assert.deepEqual(paidAhead(ali, NOW).map(a => [a.month, a.status]), [['2026-11', 'advance'], ['2026-12', 'partial']]);
});

test('the school year runs September to August', () => {
  assert.equal(schoolYearOf(NOW), 2026);
  assert.equal(schoolYearOf(Date.parse('2027-03-01T00:00:00Z')), 2026);
  const year = paymentYear(ali, 2026, NOW);
  assert.equal(year.length, 12);
  assert.equal(year[0].month, '2026-09'); assert.equal(year[11].month, '2027-08');
  assert.equal(year[0].status, 'paid'); assert.equal(year[2].status, 'advance');
});

test('an unpaid earlier month is overdue; this month is only due until the 10th', () => {
  const bek = { name: 'Bek', level: 'A2', monthlyFee: 400000, createdAt: new Date('2026-09-01'), payments: [] };
  assert.equal(paymentStatus(bek, '2026-09', NOW).status, 'overdue');
  assert.equal(paymentStatus(bek, '2026-10', NOW).status, 'overdue');
  assert.equal(paymentStatus(bek, '2026-10', Date.parse('2026-10-05T09:00:00Z')).status, 'due');
});

test('the daily email: by group, who paid and who not, amounts and dates; changes since the last one', () => {
  const bek = { name: 'Bek', level: 'A2', monthlyFee: 400000, createdAt: new Date('2026-09-01'), payments: [] };
  const zara = { name: 'Zara', level: 'B1', monthlyFee: 600000, createdAt: new Date('2026-09-01'), payments: [pay('z1', '2026-10', 600000, '2026-10-09')] };
  const changes = changesSince([ali, bek, zara], new Date('2026-10-20T23:00:00Z'));
  assert.deepEqual(changes.map(c => c.kind + ':' + c.p._id).sort(), ['added:p6', 'voided:p6']);
  assert.equal(changesSince([ali, bek, zara], new Date('2026-10-23')).length, 0);

  const r = buildReport([ali, bek, zara], { month: '2026-10', now: NOW, changes });
  assert.deepEqual(r.counts, { paid: 2, notPaid: 1, total: 1100000, changes: 2 });
  assert.match(r.subject, /Oktabr 2026: 2 to‘lagan, 1 to‘lamagan/);
  assert.ok(r.html.indexOf('A2') < r.html.indexOf('B1'));
  assert.match(r.text, /Ali: To‘langan — 500 000 so‘m \/ 500 000 so‘m \(05\.10\.2026, 20\.10\.2026\) · oldindan: Noyabr, Dekabr \(qisman\)/);
  assert.match(r.text, /Bek: To‘lanmagan/);
  assert.match(r.text, /xato deb belgilandi \(wrong student\)/);
});
