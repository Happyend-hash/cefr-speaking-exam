/**
 * Collocations in Use Intermediate (2026-10-28): the book is complete and a
 * unit test and the general test can be played with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VOCAB_PACKS } from '../content/vocabPacks.js';
import { VocabRaceHub, NEXT_MS } from '../services/VocabRaceHub.js';
import { bookView } from '../services/ParentPortal.js';

const KEY = 'collocations-in-use-intermediate';
const pack = VOCAB_PACKS.find(p => p.key === KEY);

test('the book: units 6–60, 942 collocations, each with an Uzbek meaning', () => {
  assert.ok(pack);
  assert.equal(pack.title, 'Collocations in Use Intermediate');
  assert.deepEqual(pack.units.map(u => Number(u.id)), Array.from({ length: 55 }, (_, i) => i + 6));
  assert.equal(pack.units.reduce((a, u) => a + u.words.length, 0), 942);
  for (const u of pack.units) {
    assert.ok(u.words.length >= 4, `unit ${u.id} has enough for four options`);
    assert.equal(new Set(u.words.map(w => w.word.toLowerCase())).size, u.words.length, `no repeats in unit ${u.id}`);
    for (const w of u.words) assert.ok(w.word && w.uz, `unit ${u.id}: ${w.word}`);
  }
  assert.ok(!pack.units.some(u => u.words.some(w => /[og]'/i.test(w.uz))), 'Uzbek o‘ and g‘ use the proper letter');
  assert.equal(bookView(KEY).units.length, 55);
  assert.equal(bookView(KEY).units[0].title, 'Unit 6: Intensifying adverbs');
});

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

test('a unit test and the general test play through with the book', async () => {
  const c = clock();
  const saved = [];
  const hub = new VocabRaceHub({ packs: VOCAB_PACKS, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0.4,
    onHomework: async ({ homework }) => { saved.push(homework); } });
  hub.connect({ id: 'stu' }, { write() {} });
  for (const [ids, opts] of [[['7'], { homework: { kind: 'unit', unit: 2 } }], [pack.units.map(u => u.id), { homework: { kind: 'general' }, perUnit: 2 }]]) {
    const out = hub.solo('stu', KEY, ids, 'track', opts);
    assert.equal(out.ok, true);
    const room = [...hub.rooms.values()].find(r => !r.over && r.players.has('stu'));
    const player = room.players.get('stu');
    for (const q of player.qs) assert.equal(new Set(q.options).size, q.options.length, 'options are all different');
    while (!player.finished) { hub.answer('stu', player.cursor, player.qs[player.cursor].answer); c.advance(NEXT_MS + 1); }
    await new Promise(r => setImmediate(r));
  }
  assert.equal(saved.length, 2);
  assert.equal(saved[0].percent, 100);
  assert.equal(Object.keys(saved[1].perUnit).length, 55, 'the general test covers every unit');
});
