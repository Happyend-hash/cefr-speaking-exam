/** Click sells speaking, writing and Premium; the webhooks credit the right one and check what Click sends. */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import { findPackage, PREMIUM_KEY, PREMIUM_OFFER } from '../content/packages.js';
import router, { fulfil } from '../routes/payment.js';
import PaymentTransaction from '../models/PaymentTransaction.js';
import User from '../models/User.js';

test('every package Click sells is found, with what it buys', () => {
  assert.deepEqual([findPackage('single').kind, findPackage('single').mocks], ['speaking', 1]);
  assert.deepEqual([findPackage('w10').kind, findPackage('w10').mocks, findPackage('w10').price], ['writing', 10, 16000]);
  const p = findPackage(PREMIUM_KEY);
  assert.deepEqual([p.kind, p.days, p.price, p.mocks], ['premium', PREMIUM_OFFER.days, PREMIUM_OFFER.price, 0]);
  assert.equal(findPackage('nope'), null);
});

test('a paid package goes to the right balance', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  const s = { subscription: { examsRemaining: 1, writingRemaining: 2 }, access: {} };
  fulfil(s, { kind: 'speaking', mocks: 5 }, now);
  assert.equal(s.subscription.examsRemaining, 6);
  fulfil(s, { kind: 'writing', mocks: 10 }, now);
  assert.equal(s.subscription.writingRemaining, 12);
  assert.equal(s.subscription.examsRemaining, 6, 'writing does not touch speaking');
  assert.match(s.access.message, /10 ta writing mock/);
  fulfil(s, { kind: 'premium', days: 30, mocks: 0 }, now);
  assert.equal(new Date(s.premiumUntil).getTime(), now + 30 * 864e5);
  assert.match(s.access.message, /Premium faollashtirildi/);
  assert.equal(s.subscription.examsRemaining, 6);
  const old = { subscription: { examsRemaining: 0 }, access: {} };
  fulfil(old, { mocks: 1 }, now);
  assert.equal(old.subscription.examsRemaining, 1, 'rows from before kinds are speaking');
});

// ---- the two webhooks, end to end, with the database stubbed out
const SECRET = 'test-secret';
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
async function withServer(fn) {
  process.env.CLICK_SECRET_KEY = SECRET;
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/p', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/p`;
  const post = (path, body) => fetch(base + path, { method: 'POST', body: new URLSearchParams(body) }).then(r => r.json());
  try { await fn(post); } finally { server.close(); }
}

test('Prepare then Complete credits a writing package once, and checks action, amount and the prepare id', async () => {
  const tx = { _id: 'T1', kind: 'writing', mocks: 5, days: 0, amount: 9000, status: 'pending', student: 'U1', merchantPrepareId: null, save: async () => {} };
  const student = { subscription: { writingRemaining: 0, examsRemaining: 0 }, access: {}, save: async () => {} };
  const saved = { tx: PaymentTransaction.findById, user: User.findById };
  PaymentTransaction.findById = async () => tx;
  User.findById = async () => student;
  try {
    await withServer(async post => {
      const base = { click_trans_id: '77', service_id: '1', merchant_trans_id: 'T1', sign_time: '2026-11-12 10:00:00' };
      const prep = (amount, action = '0') => ({ ...base, amount, action, sign_string: md5(`77${'1'}${SECRET}T1${amount}${action}${base.sign_time}`) });
      assert.equal((await post('/click/prepare', { ...prep('9000.00'), sign_string: 'bad' })).error, -1);
      assert.equal((await post('/click/prepare', prep('5000.00'))).error, -2, 'wrong amount');
      assert.equal((await post('/click/prepare', prep('9000.00', '1'))).error, -3, 'wrong action');
      const ok = await post('/click/prepare', prep('9000.00'));
      assert.equal(ok.error, 0);
      assert.equal(tx.status, 'prepared');
      assert.equal((await post('/click/prepare', prep('9000.00'))).merchant_prepare_id, ok.merchant_prepare_id, 'a repeated Prepare keeps its reservation');

      const comp = (prepareId, amount = '9000.00', error = '0') => ({ ...base, amount, action: '1', error, merchant_prepare_id: prepareId,
        sign_string: md5(`77${'1'}${SECRET}T1${prepareId}${amount}1${base.sign_time}`) });
      assert.equal((await post('/click/complete', comp('123'))).error, -6, 'a prepare id we never gave');
      assert.equal((await post('/click/complete', comp(String(ok.merchant_prepare_id), '1.00'))).error, -2, 'wrong amount on Complete');
      const done = await post('/click/complete', comp(String(ok.merchant_prepare_id)));
      assert.equal(done.error, 0);
      assert.equal(student.subscription.writingRemaining, 5);
      const again = await post('/click/complete', comp(String(ok.merchant_prepare_id)));
      assert.equal(again.error, -4, 'a retried Complete does not credit twice');
      assert.equal(student.subscription.writingRemaining, 5);
    });
  } finally {
    PaymentTransaction.findById = saved.tx; User.findById = saved.user;
  }
});
