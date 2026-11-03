/**
 * Do'stlar and the results wall (2026-11-03): the rules that need no
 * database — who a pair is, the send pace, what a message, post or person
 * shows, and which photos are accepted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pairOf } from '../models/Social.js';
import { allowSend, messageView, postView, card } from '../services/Social.js';
import { readPhoto, MAX_PHOTO_BYTES } from '../services/MediaStorage.js';
import { certificateView, reviewView } from '../services/Wall.js';

const A = '64b000000000000000000001';
const B = '64b000000000000000000002';

test('a pair is the same whichever of the two starts', () => {
  assert.equal(pairOf(A, B), pairOf(B, A));
  assert.notEqual(pairOf(A, B), pairOf(A, A));
});

test('sending pace: not twice within 0.7 s, at most 30 a minute', () => {
  const t0 = 1_000_000;
  assert.equal(allowSend('pace-1', t0), true);
  assert.equal(allowSend('pace-1', t0 + 200), false, 'too fast');
  let ok = 1;
  for (let i = 1; i < 40; i += 1) if (allowSend('pace-1', t0 + i * 1000)) ok += 1;
  assert.equal(ok, 30, 'thirty in a minute, then wait');
  assert.equal(allowSend('pace-1', t0 + 120_000), true, 'a minute later it opens again');
});

test('a message: mine or theirs, media only through the guarded routes, removed ones empty', () => {
  const m = { _id: 'm1', from: A, to: B, kind: 'photo', text: 'hi', photo: { key: 'k' }, createdAt: new Date(), readAt: null };
  const forA = messageView(m, A);
  const forB = messageView(m, B);
  assert.equal(forA.mine, true);
  assert.equal(forB.mine, false);
  assert.equal(forA.photo, '/api/social/photo/m/m1');
  const removed = messageView({ ...m, removed: true }, B);
  assert.equal(removed.photo, null);
  assert.equal(removed.text, '');
  const voice = messageView({ ...m, kind: 'voice', audioKey: 'a', seconds: 7 }, B);
  assert.equal(voice.audio, '/api/social/voice/m1');
  assert.equal(voice.seconds, 7);
});

test('a post: likes counted, liked by me, photo through the guarded route', () => {
  const p = { _id: 'p1', user: A, kind: 'post', text: 'Weekend!', photo: { key: 'x' }, likes: [B], createdAt: new Date() };
  assert.deepEqual([postView(p, B).likes, postView(p, B).liked, postView(p, A).liked, postView(p, A).mine], [1, true, false, true]);
  assert.equal(postView(p, A).photo, '/api/social/photo/p/p1');
});

test('a person card never carries a bio or email — only name, level, picture and relation', () => {
  const c = card({ _id: A, firstName: 'Aziz', lastName: 'Kenjayev', email: 'x@y.z', social: { bio: 'secret', level: 'B2' }, role: 'student' }, { relation: 'none' });
  assert.equal(c.name, 'Aziz K.');
  assert.equal(c.level, 'B2');
  assert.equal(c.relation, 'none');
  assert.equal('bio' in c, false);
  assert.equal('email' in c, false);
});

test('photos: only real images, checked by their bytes, and not too big', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  assert.equal(readPhoto(`data:image/png;base64,${png.toString('base64')}`).contentType, 'image/png');
  const fake = Buffer.from('<svg onload=alert(1)>hello there</svg>');
  assert.throws(() => readPhoto(`data:image/png;base64,${fake.toString('base64')}`), /rasm emas/);
  assert.throws(() => readPhoto('data:image/svg+xml;base64,AAAA'), /JPEG, PNG/);
  const big = Buffer.alloc(MAX_PHOTO_BYTES + 10, 0); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  assert.throws(() => readPhoto(`data:image/jpeg;base64,${big.toString('base64')}`), /katta/);
});

test('the wall: the public sees an approved certificate by its public photo; the owner and teacher see the status', () => {
  const c = { _id: 'c1', user: A, name: 'Aziz', level: 'B2', speaking: 62, writing: 55, status: 'approved', photo: { key: 'k' }, createdAt: new Date(), reviewedAt: new Date() };
  const pub = certificateView(c);
  assert.equal(pub.photo, '/api/wall/photo/certificate/c1');
  assert.equal('status' in pub, false);
  assert.equal('user' in pub, false);
  const pending = certificateView({ ...c, status: 'pending' }, { mine: true });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.photo, '/api/wall/me/certificates/c1/photo');
  assert.equal(certificateView(c, { admin: true }).photo, '/api/admin/wall/certificates/c1/photo');
  const r = reviewView({ _id: 'r1', name: 'Malika', text: 'Great', stars: 5, published: true, photo: { key: 'p' } });
  assert.equal(r.photo, '/api/wall/photo/review/r1');
  assert.equal('published' in r, false);
});

test('comments: the writer and the post owner may delete; a story has no comments', async () => {
  const { commentView } = await import('../services/Social.js');
  const C = '64b000000000000000000003';
  const c = { _id: 'c9', user: B, text: 'Nice photo!', createdAt: new Date() };
  const person = { id: B, name: 'Malika R.' };
  assert.equal(commentView(c, B, person, A).canDelete, true, 'the writer');
  assert.equal(commentView(c, A, person, A).canDelete, true, 'the owner of the post');
  assert.equal(commentView(c, C, person, A).canDelete, false, 'another friend');
  assert.equal(commentView({ ...c, removed: true }, C, person, A).text, '');
  const post = postView({ _id: 'p2', user: A, kind: 'post', likes: [], createdAt: new Date(), commentCount: 4, latestComments: [1, 2] }, B);
  assert.deepEqual([post.comments, post.latestComments.length], [4, 2]);
  assert.equal(postView({ _id: 's', user: A, kind: 'story', likes: [], createdAt: new Date() }, B).comments, null);
});

test('site news: photo through the guarded route, the hidden flag only for the admin', async () => {
  const { newsView } = await import('../services/News.js');
  const at = new Date('2026-11-03T10:00:00Z');
  const n = { _id: 'n1', kind: 'update', title: 'Do‘stlar ochildi', text: 'Line 1\nLine 2', photo: { key: 'k' }, published: false, createdAt: at, updatedAt: at };
  const pub = newsView(n);
  assert.equal(pub.photo, '/api/news/n1/photo');
  assert.equal(pub.text, 'Line 1\nLine 2');
  assert.equal('published' in pub, false);
  assert.equal(newsView(n, { admin: true }).published, false);
  assert.equal(pub.edited, null);
});
