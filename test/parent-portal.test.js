import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWeakCode, newParentCode, signInBlocked, noteWrongCode, noteRightCode, dashboard, readPhoto,
  MAX_TRIES, GLOBAL_MAX_FAILS, _guard
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
