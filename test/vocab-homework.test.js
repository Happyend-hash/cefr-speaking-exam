/**
 * Vocabulary test → "Uyga vazifani topshirish": a linked student's online
 * test result goes straight into their course vocabulary units.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VocabRaceHub, NEXT_MS } from '../services/VocabRaceHub.js';
import { recordUnitResult, recordGeneralTest } from '../services/CourseVocab.js';

const PACK = {
  key: 'book', title: 'Book', units: [
    { id: 'u1', title: 'Family', words: ['a', 'b', 'c', 'd', 'e', 'f'].map(w => ({ word: w, uz: `${w}-uz` })) },
    { id: 'u2', title: 'School', words: ['g', 'h', 'i', 'j'].map(w => ({ word: w, uz: `${w}-uz` })) }
  ]
};

function clock() {
  let now = 1_000_000;
  const timers = [];
  return {
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, done: false }; timers.push(t); return t; },
    clearTimer: t => { if (t) t.done = true; },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = timers.filter(t => !t.done && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at; next.done = true; next.fn();
      }
      now = until;
    }
  };
}

function stream() {
  const events = [];
  return {
    events,
    write(frame) { events.push({ event: frame.match(/^event: (.+)$/m)[1], data: JSON.parse(frame.match(/^data: (.+)$/m)[1]) }); },
    last(name) { return [...events].reverse().find(e => e.event === name)?.data; }
  };
}

/** Answer every question; `right(q)` decides whether to pick the right option. */
function play(hub, c, userId, right) {
  const room = [...hub.rooms.values()].find(r => r.players.has(userId));
  const player = room.players.get(userId);
  while (!player.finished) {
    const q = player.qs[player.cursor];
    const pick = right(q) ? q.answer : (q.answer + 1) % q.options.length;
    assert.equal(hub.answer(userId, player.cursor, pick).ok, true);
    c.advance(NEXT_MS + 1);
  }
  return room;
}

test('homework unit test: the result is handed to onHomework and the student is told it was saved', async () => {
  const c = clock();
  const saved = [];
  const hub = new VocabRaceHub({ packs: [PACK], now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0.3,
    onHomework: async ({ homework }) => { saved.push(homework); } });
  const s = stream();
  hub.connect({ id: 'stu' }, s);
  const out = hub.solo('stu', 'book', ['u1'], 'track', { homework: { courseStudentId: 'cs1', kind: 'unit', unit: 1, label: 'Book — Family' } });
  assert.equal(out.ok, true);
  assert.equal(out.words, 6, 'a unit test asks every word of the unit');

  // 3 of 6 right → 50%
  let n = 0;
  play(hub, c, 'stu', () => (n++ % 2 === 0));
  await new Promise(r => setImmediate(r));

  const fin = s.last('finished-you');
  assert.equal(fin.homework.percent, 50);
  assert.equal(fin.homework.kind, 'unit');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].percent, 50);
  assert.equal(saved[0].courseStudentId, 'cs1');
  assert.deepEqual(saved[0].perUnit, { u1: 50 });
  assert.deepEqual(s.last('homework-saved'), { ok: true, percent: 50 });
});

test('homework general test: samples per unit and reports a percent per unit', async () => {
  const c = clock();
  const saved = [];
  const hub = new VocabRaceHub({ packs: [PACK], now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0.5,
    onHomework: async ({ homework }) => { saved.push(homework); } });
  hub.connect({ id: 'stu' }, stream());
  const out = hub.solo('stu', 'book', ['u1', 'u2'], 'track', { homework: { kind: 'general' }, perUnit: 3 });
  assert.equal(out.words, 6, '3 words from each of the 2 units');
  play(hub, c, 'stu', q => q.unitId === 'u1');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(saved[0].perUnit, { u1: 100, u2: 0 });
  assert.equal(saved[0].percent, 50);
});

test('a failed save is reported to the student, and quitting mid-test saves nothing', async () => {
  const c = clock();
  let calls = 0;
  const hub = new VocabRaceHub({ packs: [PACK], now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    onHomework: async () => { calls += 1; throw new Error('Darajangiz o‘zgargan'); } });
  const s = stream();
  hub.connect({ id: 'stu' }, s);
  hub.solo('stu', 'book', ['u2'], 'track', { homework: { kind: 'unit', unit: 2 } });
  play(hub, c, 'stu', () => true);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(s.last('homework-saved'), { ok: false, reason: 'Darajangiz o‘zgargan' });

  calls = 0;
  hub.solo('stu', 'book', ['u1'], 'track', { homework: { kind: 'unit', unit: 1 } });
  const player = [...hub.rooms.values()].find(r => !r.over).players.get('stu');
  hub.answer('stu', 0, player.qs[0].answer);
  hub.leave('stu');
  c.advance(60_000);
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 0, 'leaving before the end never saves a half-done test');
});

test('ordinary practice (no homework) never calls onHomework', async () => {
  const c = clock();
  let calls = 0;
  const hub = new VocabRaceHub({ packs: [PACK], now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onHomework: async () => { calls += 1; } });
  const s = stream();
  hub.connect({ id: 'stu' }, s);
  hub.solo('stu', 'book', ['u1'], 'track');
  play(hub, c, 'stu', () => true);
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 0);
  assert.equal(s.last('finished-you').homework, null);
});

test('CourseVocab: the same unit on the same day replaces; another day is kept as history', () => {
  const st = { level: 'A2', vocab: [], vocabTests: [] };
  recordUnitResult(st, { unit: 3, percent: 40, date: '2026-10-22', via: 'online' });
  recordUnitResult(st, { unit: 3, percent: 60, date: '2026-10-23', via: 'online' });
  recordUnitResult(st, { unit: 3, percent: 90, date: '2026-10-23', via: 'online' });
  assert.deepEqual(st.vocab.map(r => [r.date, r.percent, r.via]), [['2026-10-22', 40, 'online'], ['2026-10-23', 90, 'online']]);
});

test('CourseVocab: an online general test writes each unit it covered; a second one that day replaces it', () => {
  const st = { level: 'A2', vocab: [], vocabTests: [] };
  recordGeneralTest(st, { date: '2026-10-23', perUnit: { 1: 80, 2: 60 }, percent: 70, via: 'online' });
  recordGeneralTest(st, { date: '2026-10-23', perUnit: { 1: 90, 2: 70 }, percent: 80, via: 'online' });
  assert.equal(st.vocabTests.length, 1);
  assert.equal(st.vocabTests[0].percent, 80);
  assert.equal(st.vocabTests[0].via, 'online');
  assert.deepEqual(st.vocab.map(r => [r.unit, r.percent, r.source]), [[1, 90, 'general'], [2, 70, 'general']]);
});
