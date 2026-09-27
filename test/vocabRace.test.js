/**
 * Word Sprint (vocabulary race): room lifecycle, all-words-at-once question
 * building, scoring, and the podium ranking — including bugs this suite was
 * written to catch (see the notes on individual assertions).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VocabRaceHub, QUESTION_MS } from '../services/VocabRaceHub.js';

function stream() {
  const events = [];
  return {
    events,
    write(frame) {
      events.push({ event: frame.match(/^event: (.+)$/m)[1], data: JSON.parse(frame.match(/^data: (.+)$/m)[1]) });
    },
    last(name) { return [...events].reverse().find(e => e.event === name)?.data; },
    all(name) { return events.filter(e => e.event === name).map(e => e.data); }
  };
}

/** Timers the test runs by hand. */
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

// A pack with part-of-speech and synonym data, like Destination B1.
const PACK = {
  key: 'test-pack', title: 'Test Pack', units: [
    { id: '1', title: 'Unit One', words: [
      { word: 'alpha', pos: 'n', synonym: 'first', uz: 'birinchi' },
      { word: 'beta', pos: 'n', synonym: 'second', uz: 'ikkinchi' },
      { word: 'gamma', pos: 'n', synonym: 'third', uz: 'uchinchi' },
      { word: 'delta', pos: 'n', synonym: 'fourth', uz: "to'rtinchi" }
    ]},
    { id: '2', title: 'Unit Two', words: [
      { word: 'epsilon', pos: 'n', synonym: 'fifth', uz: 'beshinchi' }
    ]}
  ]
};

// A pack with only word + Uzbek translation, like the English Hub books —
// no pos, no synonym.
const BARE_PACK = {
  key: 'bare-pack', title: 'Bare Pack', units: [
    { id: '1', title: 'Unit 1', words: [
      { word: 'one', uz: 'bir' },
      { word: 'two', uz: 'ikki' },
      { word: 'three', uz: 'uch' },
      { word: 'four', uz: "to'rt" }
    ]}
  ]
};

const PACKS = [PACK, BARE_PACK];

test('Word Sprint: a room asks every word in the chosen units, never a sample', () => {
  const hub = new VocabRaceHub({ packs: PACKS, random: () => 0 });
  const host = stream();
  hub.connect({ id: 'teacher' }, host);

  assert.equal(hub.create('teacher', 'nope', ['1']).ok, false, 'an unknown pack is rejected');
  assert.equal(hub.create('teacher', 'test-pack', []).ok, false, 'needs at least one unit');
  assert.equal(hub.create('teacher', 'test-pack', ['999']).ok, false, 'an unknown unit is rejected');

  const made = hub.create('teacher', 'test-pack', ['1', '2']);
  assert.equal(made.ok, true);
  assert.equal(made.words, 5, 'unit 1 (4 words) + unit 2 (1 word) = 5, all of them');
});

test('Word Sprint: distractors prefer the same unit, and pad when a unit is too small to fill four options', () => {
  const hub = new VocabRaceHub({ packs: PACKS, random: () => 0 });
  const room = { pool: hub.pool(PACK, ['1', '2']) };
  const qs = hub.buildQuestions(room);
  assert.equal(qs.length, 5);
  for (const q of qs) {
    assert.equal(q.options.length, 4);
    assert.equal(new Set(q.options).size, 4, 'four distinct-looking options every time');
    assert.ok(q.answer >= 0 && q.answer < 4);
  }
  // Unit 1 has enough words on its own, so 'alpha' should never borrow unit 2's answer.
  const alphaQ = qs.find(q => q.word === 'alpha');
  assert.ok(!alphaQ.options.includes('beshinchi'), 'same-unit distractors are preferred when there are enough of them');

  // 'epsilon' is alone in unit 2, so its three distractors must come from unit 1.
  const epsilonQ = qs.find(q => q.word === 'epsilon');
  const unit1Uz = new Set(['birinchi', 'ikkinchi', 'uchinchi', "to'rtinchi"]);
  const epsilonDistractors = epsilonQ.options.filter((_, i) => i !== epsilonQ.answer);
  assert.ok(epsilonDistractors.every(d => unit1Uz.has(d)), 'a unit too small to fill its own distractors borrows from other units');

  // A pool with just one word anywhere has nothing to draw distractors from —
  // building a question must still produce four options without crashing.
  const tinyRoom = { pool: [{ unitId: '9', word: 'solo', pos: 'n', synonym: 'alone', uz: 'yolg‘iz' }] };
  const [tinyQ] = hub.buildQuestions(tinyRoom);
  assert.equal(tinyQ.options.length, 4);
  assert.equal(tinyQ.options[tinyQ.answer], 'yolg‘iz', 'the correct option is still found among the padded ones');
});

test('Word Sprint: a pack with no synonym or part of speech (like the English Hub books) still builds valid questions', () => {
  const hub = new VocabRaceHub({ packs: PACKS, random: () => 0 });
  const room = { pool: hub.pool(BARE_PACK, ['1']) };
  const qs = hub.buildQuestions(room);
  assert.equal(qs.length, 4);
  for (const q of qs) {
    assert.equal(q.options.length, 4);
    assert.notEqual(q.kicker, 'Eng yaqin sinonimni tanlang', 'the synonym question type is never offered when there is no synonym data');
    assert.ok(!q.pos, 'no part of speech to show either');
  }
});

test('Word Sprint: room lifecycle end to end — join, start, race, podium', () => {
  const c = clock();
  const finished = [];
  const hub = new VocabRaceHub({
    packs: PACKS, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    random: () => 0, onFinish: r => finished.push(r)
  });
  const host = stream(); const a = stream(); const b = stream();
  hub.connect({ id: 'teacher', name: 'Ustoz' }, host);
  hub.connect({ id: 'a', name: 'Aziza' }, a);
  hub.connect({ id: 'b', name: 'Bek' }, b);

  const made = hub.create('teacher', 'test-pack', ['1', '2']);
  const code = made.code;

  assert.equal(hub.join('teacher', code).ok, false, 'the host cannot join their own room');
  assert.equal(hub.join('a', 'ZZZZ').ok, false, 'an unknown code is refused');

  assert.equal(hub.join('a', code).ok, true);
  const rosterForStudent = a.last('roster');
  assert.equal('isHost' in rosterForStudent, false, 'a student must never be told isHost in a shared broadcast');
  assert.equal(rosterForStudent.roster.length, 1);
  assert.equal(rosterForStudent.packTitle, 'Test Pack');

  assert.equal(hub.join('b', code).ok, true);
  assert.equal(host.last('roster').roster.length, 2);

  assert.equal(hub.start('a').ok, false, 'only the host can start the race');
  assert.equal(hub.start('teacher').ok, true);
  assert.equal('isHost' in host.last('started'), false, 'the started broadcast is also unpersonalized');
  assert.equal(a.last('start').total, 5, 'every word in both units is asked at once');
  assert.equal(b.last('start').total, 5);

  assert.equal(hub.join('c', code).ok, false, 'joining fresh after the race started is refused');

  // Aziza races fast and perfect; Bek is slower and gets every one wrong.
  // Since each player has their own 10s-per-word clock, they are answered in
  // the same round of shared-clock advances so neither's timer times out
  // while the test is still busy with the other player.
  for (let i = 0; i < 5; i += 1) {
    const qa = a.last('question'); const qb = b.last('question');
    assert.equal(qa.i, i); assert.equal(qb.i, i);
    const pa = hub.rooms.get(code).players.get('a');
    const pb = hub.rooms.get(code).players.get('b');
    const rightAnswer = pa.qs[i].answer;
    const wrongAnswer = (pb.qs[i].answer + 1) % 4;

    c.advance(1000);
    assert.equal(hub.answer('a', i, rightAnswer).ok, true);
    assert.ok(a.last('reveal').gained > 0, 'a correct, fast answer always scores something');

    c.advance(2000);
    assert.equal(hub.answer('b', i, wrongAnswer).ok, true);
    assert.equal(b.last('reveal').gained, 0, 'a wrong answer never scores');

    c.advance(900); // NEXT_MS for whichever player is still waiting on it
  }
  assert.equal(a.last('finished-you').correct, 5, 'Aziza got every one of the 5 words right');
  assert.ok(a.last('finished-you').score > 0);

  const over = host.last('over');
  assert.equal(over.over, true);
  assert.equal('isHost' in over, false, 'the over broadcast is shared, unpersonalized state');
  assert.deepEqual(over.podium.map(r => r.id), ['a', 'b'], 'the perfect, faster score ranks first');
  assert.ok(over.podium[0].points > 0);
  assert.equal(over.podium[1].points, 0);

  assert.equal(finished.length, 1);
  assert.deepEqual(finished[0].results.map(r => r.id), ['a', 'b']);
  assert.equal(finished[0].results[1].points, 0, 'no points awarded for a zero score');
});

test('Word Sprint: scoring is 10 base plus up to 10 for speed, same formula as Word Duel', () => {
  const c = clock();
  const hub = new VocabRaceHub({ packs: PACKS, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0 });
  const host = stream(); const a = stream();
  hub.connect({ id: 'teacher' }, host);
  hub.connect({ id: 'a', name: 'Aziza' }, a);
  hub.create('teacher', 'test-pack', ['1']); // 4 words, one racer — keeps timing unambiguous
  const code = [...hub.rooms.keys()][0];
  hub.join('a', code);
  hub.start('teacher');

  const player = () => hub.rooms.get(code).players.get('a');

  c.advance(1000); // answered instantly relative to the 10s window
  hub.answer('a', 0, player().qs[0].answer);
  assert.equal(a.last('reveal').gained, 19, '10 + round(10 * (1 - 1000/10000)) = 19');
  c.advance(900);

  c.advance(5000); // answered halfway through the window
  hub.answer('a', 1, player().qs[1].answer);
  assert.equal(a.last('reveal').gained, 15, '10 + round(10 * (1 - 5000/10000)) = 15');
  c.advance(900);

  c.advance(QUESTION_MS); // answered right at the wire
  hub.answer('a', 2, player().qs[2].answer);
  assert.equal(a.last('reveal').gained, 10, 'no speed bonus left, but still the base 10 for being right');
});

test('Word Sprint: an unanswered question times out as wrong, and the teacher can end a race early', () => {
  const c = clock();
  const hub = new VocabRaceHub({ packs: PACKS, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0 });
  const host = stream(); const a = stream();
  hub.connect({ id: 'teacher' }, host);
  hub.connect({ id: 'a', name: 'Aziza' }, a);
  hub.create('teacher', 'test-pack', ['1']);
  const code = [...hub.rooms.keys()][0];
  hub.join('a', code);
  hub.start('teacher');

  c.advance(QUESTION_MS + 600);
  assert.equal(a.last('reveal').gained, 0, 'silence is scored as a miss, not stuck forever');

  assert.equal(hub.end('teacher').ok, true);
  assert.equal(host.last('over').over, true);
  assert.equal(hub.end('teacher').ok, true, 'ending an already-over room is a harmless no-op');
});

test('Word Sprint: the podium ranks by score, ties broken by who finished first (not by join order)', () => {
  const hub = new VocabRaceHub({ packs: PACKS, now: () => 0 });
  const room = { hostId: 'teacher', players: new Map() };
  // Inserted in an order that would fool a tie-break bug which silently drops finishedAt.
  room.players.set('a', { user: { id: 'a' }, score: 50, correct: 3, qs: [1, 2, 3], finishedAt: 2000 });
  room.players.set('b', { user: { id: 'b' }, score: 50, correct: 3, qs: [1, 2, 3], finishedAt: 1000 });
  room.players.set('c', { user: { id: 'c' }, score: 80, correct: 4, qs: [1, 2, 3, 4], finishedAt: 5000 });

  const ranked = hub.podium(room);
  assert.deepEqual(ranked.map(r => r.id), ['c', 'b', 'a'], 'highest score first; equal score goes to whoever finished earlier');
  assert.deepEqual(ranked.map(r => r.rank), [1, 2, 3]);
});
