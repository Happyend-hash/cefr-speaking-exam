import { test } from 'node:test';
import assert from 'node:assert/strict';
import DailyActivity from '../models/DailyActivity.js';
import User from '../models/User.js';
import ExamResult from '../models/ExamResult.js';
import WritingAttempt from '../models/WritingAttempt.js';
import ChatMessage from '../models/ChatMessage.js';
import { dayOf, hourOf, dayStart, addDays, noteUser, noteGuest, onlineNow, usageReport, _test } from '../services/UsageStats.js';

/** Daily usage statistics for the admin panel. */

const at = iso => Date.parse(iso);

test('days and hours are Tashkent time', () => {
  assert.equal(dayOf(at('2026-10-15T18:59:00Z')), '2026-10-15');
  assert.equal(dayOf(at('2026-10-15T19:00:00Z')), '2026-10-16', 'midnight in Tashkent is 19:00 UTC');
  assert.equal(hourOf(at('2026-10-15T10:30:00Z')), 15);
  assert.equal(dayStart('2026-10-16').toISOString(), '2026-10-15T19:00:00.000Z');
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
});

test('a student is written once per hour however many requests they make', async () => {
  _test.reset();
  const writes = [];
  const orig = DailyActivity.updateOne;
  DailyActivity.updateOne = async (q, u) => { writes.push({ q, u }); return {}; };
  try {
    const t = at('2026-10-15T05:00:00Z');
    for (let i = 0; i < 50; i += 1) noteUser('u1', t + i * 1000);
    noteUser('u2', t);
    noteUser('u1', t + 60 * 60 * 1000); // next hour
    await new Promise(r => setImmediate(r));
    assert.equal(writes.length, 3);
    assert.deepEqual(writes[0].q, { day: '2026-10-15', key: 'u:u1' });
    assert.deepEqual(writes[0].u.$addToSet, { hours: 10 });
    assert.deepEqual(writes[2].u.$addToSet, { hours: 11 });
  } finally {
    DailyActivity.updateOne = orig;
  }
});

test('online now counts the last five minutes only', () => {
  _test.reset();
  const orig = DailyActivity.updateOne;
  DailyActivity.updateOne = async () => ({});
  try {
    const t = at('2026-10-15T05:00:00Z');
    noteUser('a', t);
    noteUser('b', t - 4 * 60 * 1000);
    noteUser('c', t - 6 * 60 * 1000);
    assert.equal(onlineNow(t), 2);
  } finally {
    DailyActivity.updateOne = orig;
  }
});

test('a guest id must look like the random id the browser makes', () => {
  _test.reset();
  const orig = DailyActivity.updateOne;
  DailyActivity.updateOne = async () => ({});
  try {
    assert.equal(noteGuest(''), false);
    assert.equal(noteGuest('abc'), false);
    assert.equal(noteGuest({ $gt: '' }), false, 'objects are not ids');
    assert.equal(noteGuest('3f2c9a1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f'), true);
  } finally {
    DailyActivity.updateOne = orig;
  }
});

test('the report: today, yesterday, by hour, 30 days with estimates before tracking began', async () => {
  _test.reset();
  const now = at('2026-10-17T09:00:00Z'); // 14:00 in Tashkent
  const saved = {};
  const stub = (model, name, fn) => { saved[`${model.modelName}.${name}`] = [model, name, model[name]]; model[name] = fn; };
  const lean = v => ({ sort: () => ({ select: () => ({ lean: async () => v }) }) });
  stub(DailyActivity, 'aggregate', async pipeline => {
    if (pipeline[1]?.$unwind) return [{ _id: 9, n: 3 }, { _id: 14, n: 5 }];
    return [
      { _id: { day: '2026-10-15', kind: 'user' }, n: 40 },
      { _id: { day: '2026-10-16', kind: 'user' }, n: 52 },
      { _id: { day: '2026-10-16', kind: 'guest' }, n: 9 },
      { _id: { day: '2026-10-17', kind: 'user' }, n: 21 },
      { _id: { day: '2026-10-17', kind: 'guest' }, n: 4 }
    ];
  });
  stub(DailyActivity, 'findOne', () => lean({ day: '2026-10-15' }));
  let soFarQuery;
  stub(DailyActivity, 'countDocuments', async q => { soFarQuery = q; return 30; });
  stub(User, 'countDocuments', async () => 3);
  stub(User, 'aggregate', async () => [{ sessions: 7, people: 4 }]);
  stub(ExamResult, 'countDocuments', async () => 12);
  stub(WritingAttempt, 'countDocuments', async () => 5);
  const est = day => [{ _id: { day, who: 'x' } }, { _id: { day, who: 'y' } }];
  stub(ExamResult, 'aggregate', async () => [...est('2026-10-14'), { _id: { day: '2026-10-14', who: 'z' } }]);
  stub(WritingAttempt, 'aggregate', async () => est('2026-10-14'));
  stub(ChatMessage, 'aggregate', async () => est('2026-10-10'));
  try {
    const r = await usageReport(now);
    assert.equal(r.today, '2026-10-17');
    assert.equal(r.currentHour, 14);
    assert.equal(r.activeToday, 21);
    assert.equal(r.activeYesterday, 52);
    assert.equal(r.yesterdaySoFar, 30);
    assert.equal(soFarQuery.day, '2026-10-16');
    assert.equal(soFarQuery.first.$lte.toISOString(), '2026-10-16T09:00:00.000Z', 'up to this time yesterday');
    assert.equal(r.guestsToday, 4);
    assert.equal(r.newSignups, 3);
    assert.equal(r.speakingToday, 12);
    assert.equal(r.aiSessionsToday, 7);
    assert.equal(r.hours.length, 24);
    assert.equal(r.hours[14], 5);
    assert.equal(r.days.length, 30);
    assert.equal(r.days.at(-1).day, '2026-10-17');
    const d14 = r.days.find(d => d.day === '2026-10-14');
    assert.deepEqual(d14, { day: '2026-10-14', users: 3, guests: null, estimated: true }, 'x, y and z: each student once');
    assert.equal(r.days.find(d => d.day === '2026-10-15').estimated, false);
    assert.equal(r.weekAverage, 46, 'full tracked days before today: (40 + 52) / 2');
  } finally {
    for (const [model, name, fn] of Object.values(saved)) model[name] = fn;
  }
});
