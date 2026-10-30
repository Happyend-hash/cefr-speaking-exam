/**
 * Xatolarim raises homework results (2026-10-30): a word missed in an online
 * homework test and later learnt in the revision test counts as right, so the
 * unit's result climbs — 78% towards 100%.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordUnitResult, recordGeneralTest, raiseForLearntWord } from '../services/CourseVocab.js';
import { VocabRaceHub, NEXT_MS } from '../services/VocabRaceHub.js';

const BOOK = 'collocations-in-use-intermediate';

test('a unit result rises one word at a time as the missed words are learnt, up to 100%', () => {
  const st = { level: 'B1', vocab: [], vocabTests: [] };
  const missed = ['a', 'b', 'c', 'd', 'e'];
  recordUnitResult(st, { unit: 3, percent: 78, date: '2026-10-30', via: 'online', book: BOOK, words: { total: 23, missed } });
  const r = st.vocab[0];
  assert.equal(r.total, 23);
  assert.deepEqual(r.missed, missed);

  assert.equal(raiseForLearntWord(st, { book: BOOK, word: 'a' }), 1);
  assert.equal(r.percent, 83);                    // 19/23
  assert.equal(raiseForLearntWord(st, { book: BOOK, word: 'a' }), 0, 'the same word only once');
  for (const w of ['b', 'c', 'd']) raiseForLearntWord(st, { book: BOOK, word: w });
  assert.equal(r.percent, 96);
  raiseForLearntWord(st, { book: BOOK, word: 'e' });
  assert.equal(r.percent, 100);
});

test('only results the word was missed in, in the same book; teacher-typed results never change', () => {
  const st = { level: 'B1', vocab: [], vocabTests: [] };
  recordUnitResult(st, { unit: 1, percent: 50, date: '2026-10-29', via: 'online', book: BOOK, words: { total: 4, missed: ['x', 'y'] } });
  recordUnitResult(st, { unit: 2, percent: 75, date: '2026-10-29', via: 'online', book: 'destination-b1', words: { total: 4, missed: ['x'] } });
  recordUnitResult(st, { unit: 4, percent: 60, date: '2026-10-29', via: 'teacher', book: BOOK });
  assert.equal(raiseForLearntWord(st, { book: BOOK, word: 'x' }), 1);
  assert.deepEqual(st.vocab.map(r => r.percent), [75, 75, 60]);
});

test('a general test: each unit it covered and the overall result rise', () => {
  const st = { level: 'B1', vocab: [], vocabTests: [] };
  recordGeneralTest(st, { date: '2026-10-30', perUnit: { 1: 50, 2: 100 }, percent: 75, via: 'online', book: BOOK,
    wordsByUnit: { 1: { total: 2, missed: ['p'] }, 2: { total: 2, missed: [] } } });
  assert.equal(st.vocabTests[0].total, 4);
  raiseForLearntWord(st, { book: BOOK, word: 'p' });
  assert.deepEqual(st.vocab.map(r => [r.unit, r.percent]), [[1, 100], [2, 100]]);
  assert.equal(st.vocabTests[0].percent, 100);
});

test('the test engine hands over which words were missed in each unit of a homework test', async () => {
  let now = 1_000_000;
  const timers = [];
  const clock = {
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, done: false }; timers.push(t); return t; },
    clearTimer: t => { if (t) t.done = true; },
    advance(ms) {
      const until = now + ms;
      for (;;) { const n = timers.filter(t => !t.done && t.at <= until).sort((a, b) => a.at - b.at)[0]; if (!n) break; now = n.at; n.done = true; n.fn(); }
      now = until;
    }
  };
  const PACK = { key: BOOK, title: 'C', units: [{ id: '6', title: 'U6', words: ['a', 'b', 'c', 'd'].map(w => ({ word: w, uz: `${w}-uz` })) }] };
  const saved = [];
  const hub = new VocabRaceHub({ packs: [PACK], ...clock, random: () => 0.2, onHomework: async ({ homework }) => saved.push(homework) });
  hub.connect({ id: 'stu' }, { write() {} });
  hub.solo('stu', BOOK, ['6'], 'track', { homework: { kind: 'unit', unit: 1 } });
  const player = [...hub.rooms.values()][0].players.get('stu');
  const wrong = new Set(['b', 'd']);
  while (!player.finished) { const q = player.qs[player.cursor]; hub.answer('stu', player.cursor, wrong.has(q.word) ? (q.answer + 1) % 4 : q.answer); clock.advance(NEXT_MS + 1); }
  await new Promise(r => setImmediate(r));
  assert.equal(saved[0].percent, 50);
  assert.equal(saved[0].wordsByUnit['6'].total, 4);
  assert.deepEqual(saved[0].wordsByUnit['6'].missed.sort(), ['b', 'd']);
});
