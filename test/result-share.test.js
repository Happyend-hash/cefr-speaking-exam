/** Sharing a result: codes, what can be shared, the score sheet's data, and when the details stop. */
import test from 'node:test';
import assert from 'node:assert/strict';
const S = await import('../services/ResultShare.js');

test('codes are 8 letters/digits that cannot be misread, and checked strictly', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = S.newCode();
    assert.equal(c.length, 8);
    assert.ok(S.isCode(c), c);
    assert.ok(!/[01OIL]/.test(c), 'no 0/O, 1/I/L');
    seen.add(c);
  }
  assert.ok(seen.size > 1990, 'random');
  assert.equal(S.isCode('K7M2QX0A'), false, '0 is not used');
  assert.equal(S.isCode('k7m2qxab'), false, 'upper case only');
  assert.equal(S.isCode('K7M2'), false);
  assert.equal(S.isCode({ $ne: null }), false);
});

test('only a finished full mock with a score can be shared', () => {
  const sp = { mode: 'mock', status: 'completed', overallScore: 57, overallLevel: 'B2' };
  assert.equal(S.shareable('speaking', sp), true);
  assert.equal(S.shareable('speaking', { ...sp, mode: 'practice' }), false, 'part practice');
  assert.equal(S.shareable('speaking', { ...sp, status: 'evaluating' }), false, 'still being marked');
  assert.equal(S.shareable('speaking', { ...sp, overallScore: null }), false);
  const wr = { mode: 'mock', status: 'completed', complete: true, score: 63 };
  assert.equal(S.shareable('writing', wr), true);
  assert.equal(S.shareable('writing', { ...wr, complete: false }), false, 'not all three parts');
  assert.equal(S.shareable('writing', { ...wr, mode: 'check' }), false, '"check my writing" is not a mock');
  assert.equal(S.shareable('other', sp), false);
});

test('the sheet shows each speaking part with its maximum and level; half bands get both levels', () => {
  const parts = S.speakingParts({ part11: 5, part12: 4, part2: 3, part3: 4.5 });
  assert.deepEqual(parts.map(p => [p.name, p.band, p.max]), [['Part 1.1', 5, 5], ['Part 1.2', 4, 5], ['Part 2', 3, 5], ['Part 3', 4.5, 6]]);
  assert.equal(parts[0].label, 'Above A2');
  assert.equal(parts[0].desc, 'Shaxsiy savollar');
  assert.equal(parts[2].label, 'Lower B2');
  assert.equal(parts[3].label, 'Higher B2 – C1');
  assert.deepEqual(S.speakingParts({ part2: 3 }).map(p => p.name), ['Part 2'], 'missing parts are left out');
});

test('a speaking result becomes the sheet: name, mock, Tashkent date, score, level, parts, QR', () => {
  const doc = {
    mode: 'mock', status: 'completed', overallScore: 57, overallLevel: 'B2',
    exam: { title: 'Speaking Mock 3' }, completedAt: new Date('2026-11-09T20:30:00Z'), // 01:30 on the 10th in Tashkent
    partBands: { part11: 5, part12: 4, part2: 3, part3: 4 }
  };
  const sheet = S.sheetOf('speaking', doc, { firstName: 'Malika', lastName: 'Karimova' }, 'K7M2QXAB');
  assert.equal(sheet.name, 'Malika Karimova');
  assert.equal(sheet.title, 'Speaking Mock 3');
  assert.equal(sheet.date, '10-noyabr, 2026');
  assert.equal(sheet.score, 57);
  assert.equal(sheet.level, 'B2');
  assert.equal(sheet.parts.length, 4);
  assert.equal(sheet.url, 'englishhub.uz/r/K7M2QXAB');
  assert.ok(sheet.qr.length >= 21 && sheet.qr.every(r => r.length === sheet.qr.length && /^[01]+$/.test(r)), 'a square QR');
});

test('the link shows details only while they are shared, for 30 days', () => {
  const now = Date.parse('2026-11-10T10:00:00Z');
  const base = { code: 'K7M2QXAB', views: 3 };
  assert.equal(S.shareStatus(null), null);
  assert.equal(S.shareStatus({ ...base, revokedAt: new Date() }), null, 'stopped');
  assert.equal(S.shareStatus({ ...base, details: false }, now).details, false);
  const on = S.shareStatus({ ...base, details: true, detailsUntil: new Date(now + S.DETAILS_DAYS * 864e5) }, now);
  assert.equal(on.details, true);
  assert.equal(on.url, 'englishhub.uz/r/K7M2QXAB');
  assert.equal(S.shareStatus({ ...base, details: true, detailsUntil: new Date(now - 1) }, now).details, false, 'expired');
});
