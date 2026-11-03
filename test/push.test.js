/** Phone notifications: who gets them, what they carry, and dead phones are dropped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { PushSubscription, PushKey } from '../models/PushSubscription.js';
import Push, { forTests } from '../services/Push.js';

const USER = '64b000000000000000000001';
const made = webpush.generateVAPIDKeys();

function stub() {
  const orig = {
    findOne: PushKey.findOne, find: PushSubscription.find, updateOne: PushSubscription.updateOne,
    deleteOne: PushSubscription.deleteOne, send: webpush.sendNotification
  };
  const log = { sent: [], deleted: [], updated: [] };
  PushKey.findOne = () => ({ select: () => ({ lean: async () => ({ key: 'vapid', ...made }) }) });
  PushSubscription.updateOne = async (q, u) => { log.updated.push([q, u]); return {}; };
  PushSubscription.deleteOne = async q => { log.deleted.push(q); return {}; };
  forTests.badge = async () => 4;
  const restore = () => {
    Object.assign(PushKey, { findOne: orig.findOne });
    Object.assign(PushSubscription, { find: orig.find, updateOne: orig.updateOne, deleteOne: orig.deleteOne });
    webpush.sendNotification = orig.send;
    forTests.badge = null;
  };
  return { log, restore };
}

test('a phone address must be a real push address', async () => {
  await assert.rejects(Push.subscribe(USER, { endpoint: 'http://evil', keys: { p256dh: 'a', auth: 'b' } }), e => e.statusCode === 400);
  await assert.rejects(Push.subscribe(USER, { endpoint: 'https://fcm.googleapis.com/x', keys: {} }), e => e.statusCode === 400);
  const { log, restore } = stub();
  try {
    await Push.subscribe(USER, { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } }, 'Android app');
    assert.equal(log.updated[0][0].endpoint, 'https://fcm.googleapis.com/x');
    assert.equal(String(log.updated[0][1].$set.user), USER, 'the phone belongs to whoever signed in last');
  } finally { restore(); }
});

test('a notification carries the text, where to go, and the unread number', async () => {
  const { log, restore } = stub();
  PushSubscription.find = () => ({ lean: async () => [
    { _id: 's1', endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } },
    { _id: 's2', endpoint: 'https://push.example/2', keys: { p256dh: 'p', auth: 'a' } }
  ] });
  webpush.sendNotification = async (sub, payload) => { log.sent.push([sub.endpoint, JSON.parse(payload)]); return {}; };
  try {
    await Push.notify(USER, { title: 'Aziz', body: 'Hello!', url: `/?open=dm&id=${USER}`, kind: 'dm', from: USER });
    assert.equal(log.sent.length, 2, 'every phone of the student');
    const [, p] = log.sent[0];
    assert.equal(p.title, 'Aziz');
    assert.equal(p.body, 'Hello!');
    assert.equal(p.badge, 4);
    assert.equal(p.kind, 'dm');
    assert.match(p.url, /open=dm/);
  } finally { restore(); }
});

test('a phone that left is forgotten; a passing error is only counted', async () => {
  const { log, restore } = stub();
  PushSubscription.find = () => ({ lean: async () => [
    { _id: 'gone', endpoint: 'https://push.example/gone', keys: { p256dh: 'p', auth: 'a' } },
    { _id: 'busy', endpoint: 'https://push.example/busy', keys: { p256dh: 'p', auth: 'a' }, fails: 0 }
  ] });
  webpush.sendNotification = async sub => {
    throw Object.assign(new Error('x'), { statusCode: sub.endpoint.endsWith('gone') ? 410 : 503 });
  };
  try {
    await Push.notify(USER, { title: 't', body: 'b' });
    assert.deepEqual(log.deleted.map(q => q._id), ['gone']);
    assert.ok(log.updated.some(([q, u]) => q._id === 'busy' && u.$inc?.fails === 1));
  } finally { restore(); }
});

test('nothing to send and bad ids never throw', async () => {
  const { restore } = stub();
  PushSubscription.find = () => ({ lean: async () => [] });
  try {
    await Push.notify(USER, { title: 't' });
    await Push.notify('not-an-id', { title: 't' });
  } finally { restore(); }
});
