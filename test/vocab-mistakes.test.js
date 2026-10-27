/**
 * Xatolarim (2026-10-28): wrong answers are kept per book until learnt —
 * by the O'rgandim button or two right answers in a row in revision tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAnswer, LEARN_STREAK } from '../services/VocabMistakes.js';
import { VocabRaceHub, NEXT_MS } from '../services/VocabRaceHub.js';

const now = new Date('2026-10-28T10:00:00Z');
const wrong = { word: 'make a decision', uz: 'qaror qabul qilmoq', unitId: '7', packTitle: 'Collocations', correct: false, review: false };

test('a wrong answer adds the word; another wrong answer counts it again', () => {
  const first = applyAnswer(null, wrong, now);
  assert.equal(first.misses, 1);
  assert.equal(first.learntAt, null);
  const again = applyAnswer(first, wrong, now);
  assert.equal(again.misses, 2);
});

test('two right answers in a row in revision tests make it learnt; a miss in between starts again', () => {
  let e = applyAnswer(null, wrong, now);
  e = applyAnswer(e, { ...wrong, correct: true, review: true }, now);
  assert.equal(e.reviewStreak, 1);
  assert.equal(e.learntAt, null);
  e = applyAnswer(e, { ...wrong, correct: false, review: true }, now);
  assert.equal(e.reviewStreak, 0, 'a miss starts the count again');
  for (let i = 0; i < LEARN_STREAK; i += 1) e = applyAnswer(e, { ...wrong, correct: true, review: true }, now);
  assert.ok(e.learntAt);
  assert.equal(e.learntBy, 'test');
});

test('a right answer in an ordinary test changes nothing; a learnt word missed again comes back', () => {
  const e = applyAnswer(null, wrong, now);
  assert.equal(applyAnswer(e, { ...wrong, correct: true, review: false }, now), null);
  assert.equal(applyAnswer(null, { ...wrong, correct: true, review: true }, now), null, 'never missed: nothing to store');
  const learnt = { ...e, learntAt: now, learntBy: 'button' };
  const back = applyAnswer(learnt, wrong, now);
  assert.equal(back.learntAt, null);
  assert.equal(back.misses, 2);
});

const PACK = {
  key: 'book', title: 'Book', units: [
    { id: '6', title: 'Unit 6', words: ['a', 'b', 'c', 'd', 'e'].map(w => ({ word: w, uz: `${w}-uz` })) },
    { id: '7', title: 'Unit 7', words: ['f', 'g', 'h', 'i'].map(w => ({ word: w, uz: `${w}-uz` })) }
  ]
};
function clock() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const x = { at: t + ms, fn, done: false }; timers.push(x); return x; },
    clearTimer: x => { if (x) x.done = true; },
    advance(ms) {
      const until = t + ms;
      for (;;) {
        const next = timers.filter(x => !x.done && x.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = next.at; next.done = true; next.fn();
      }
      t = until;
    }
  };
}

test('every answer is reported; a revision test asks only the given words, with options from their units', () => {
  const c = clock();
  const answers = [];
  const hub = new VocabRaceHub({ packs: [PACK], now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0.3, onAnswer: a => answers.push(a) });
  hub.connect({ id: 'stu' }, { write() {} });

  hub.solo('stu', 'book', ['6'], 'track');
  let player = [...hub.rooms.values()].find(r => !r.over).players.get('stu');
  let n = 0;
  while (!player.finished) { const q = player.qs[player.cursor]; hub.answer('stu', player.cursor, n++ % 2 ? q.answer : (q.answer + 1) % 4); c.advance(NEXT_MS + 1); }
  assert.equal(answers.length, 5);
  assert.equal(answers.filter(a => !a.correct).length, 3);
  assert.ok(answers.every(a => a.packKey === 'book' && a.unitId === '6' && a.review === false));

  answers.length = 0;
  const out = hub.solo('stu', 'book', [], 'track', { review: [{ unitId: '6', word: 'b' }, { unitId: '7', word: 'g' }] });
  assert.equal(out.ok, true);
  assert.equal(out.words, 2);
  player = [...hub.rooms.values()].find(r => !r.over).players.get('stu');
  assert.deepEqual(player.qs.map(q => q.word).sort(), ['b', 'g']);
  for (const q of player.qs) assert.equal(new Set(q.options).size, 4, 'four real options even with two words');
  while (!player.finished) { hub.answer('stu', player.cursor, player.qs[player.cursor].answer); c.advance(NEXT_MS + 1); }
  assert.equal(answers.length, 2);
  assert.ok(answers.every(a => a.review === true && a.correct === true));

  assert.equal(hub.solo('stu', 'book', [], 'track', { review: [] }).ok, false, 'nothing left to revise');
});
