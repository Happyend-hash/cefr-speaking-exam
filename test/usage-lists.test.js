/** The people behind the "Website use" numbers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { usageList, noteUser, _test } from '../services/UsageStats.js';
import DailyActivity from '../models/DailyActivity.js';
import User from '../models/User.js';

const chain = v => ({ sort: () => ({ lean: async () => v }), lean: async () => v, select: () => ({ lean: async () => v }) });

test('students of a day come with names, emails and their active times; visitors stay anonymous', async () => {
  const orig = { find: DailyActivity.find, ufind: User.find };
  DailyActivity.find = q => chain(q.kind === 'user'
    ? [{ user: 'aaaaaaaaaaaaaaaaaaaaaaaa', first: new Date('2026-10-24T04:12:00Z'), last: new Date('2026-10-24T10:47:00Z'), hours: [9, 10, 15] }]
    : [{ key: 'g:abc', first: new Date('2026-10-24T05:02:00Z'), last: new Date('2026-10-24T05:05:00Z') }]);
  User.find = () => chain([{ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', firstName: 'Gulbahor', lastName: 'G', email: 'g@gmail.com', role: 'student' }]);
  try {
    const s = await usageList('students', { day: '2026-10-24', now: Date.parse('2026-10-24T18:00:00Z') });
    assert.equal(s.rows[0].name, 'Gulbahor G');
    assert.equal(s.rows[0].email, 'g@gmail.com');
    assert.equal(s.rows[0].detail, '09:12–15:47 · active in 3 hours', 'Tashkent times');
    const g = await usageList('guests', { day: '2026-10-24' });
    assert.equal(g.rows[0].name, 'Visitor 1');
    assert.equal(g.rows[0].email, '');
    await assert.rejects(usageList('nope'), e => e.statusCode === 400);
  } finally { DailyActivity.find = orig.find; User.find = orig.ufind; }
});

test('online now lists only accounts active in the last five minutes', async () => {
  _test.reset();
  const now = Date.parse('2026-10-24T18:00:00Z');
  const orig = { u: User.find, upd: DailyActivity.updateOne };
  DailyActivity.updateOne = async () => ({});
  noteUser('aaaaaaaaaaaaaaaaaaaaaaaa', now - 60_000);
  noteUser('bbbbbbbbbbbbbbbbbbbbbbbb', now - 10 * 60_000);
  User.find = q => chain([{ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', firstName: 'Ali', email: 'ali@x.com', role: 'student' }].filter(u => q._id.$in.includes(u._id)));
  try {
    const o = await usageList('online', { now });
    assert.deepEqual(o.rows.map(r => r.name), ['Ali']);
  } finally { User.find = orig.u; DailyActivity.updateOne = orig.upd; _test.reset(); }
});
