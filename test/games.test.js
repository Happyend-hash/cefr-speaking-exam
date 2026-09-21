/**
 * Games: Error Hunter scoring, Word Duel flow, Taboo turns, and the week.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorHunt, ROUND_SIZE, ITEM_SECONDS, DELETE_LABEL } from '../services/ErrorHunt.js';
import { ERROR_ITEMS, corrected } from '../content/errorHunter.js';
import { DuelHub, QUESTION_MS, WIN_BONUS, BOT_AFTER_MS } from '../services/DuelHub.js';
import { TabooGame, mentions, TURN_SECONDS } from '../services/TabooGame.js';
import { VoiceHub } from '../services/VoiceHub.js';
import { startOfWeek, startOfDay } from '../services/Games.js';

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

// --------------------------------------------------------- error hunter

test('every Error Hunter sentence reads correctly once fixed', () => {
  assert.ok(ERROR_ITEMS.length >= 100);
  for (const it of ERROR_ITEMS) {
    assert.ok(it.words[it.at], it.id);
    assert.ok(!corrected(it).includes('  '), it.id);
  }
  const item = ERROR_ITEMS.find(i => i.words.join(' ') === 'I am agree with your opinion.');
  assert.equal(corrected(item), 'I agree with your opinion.');
});

test('Error Hunter: find the word, pick the fix, score with speed bonus', () => {
  const c = clock();
  const eh = new ErrorHunt({ now: c.now });
  const round = eh.start('u1');
  assert.equal(round.items.length, ROUND_SIZE);
  assert.equal(round.items[0].fix, undefined, 'answers are never sent');

  const item0 = eh.rounds.get(round.roundId).items[0];
  c.advance(2000);
  const tap = eh.tap('u1', round.roundId, 0, item0.at);
  assert.equal(tap.found, true);
  assert.equal(tap.options.length, 3);
  const right = tap.options.indexOf(item0.fix || DELETE_LABEL);
  const out = eh.fix('u1', round.roundId, 0, right);
  assert.equal(out.right, true);
  assert.equal(out.gained, 25, '10 + 10 + full speed bonus');

  // Wrong word: nothing, and the answer is shown.
  const item1 = eh.rounds.get(round.roundId).items[1];
  const miss = eh.tap('u1', round.roundId, 1, (item1.at + 1) % item1.words.length);
  assert.equal(miss.found, false);
  assert.equal(miss.at, item1.at);
  assert.equal(miss.gained, 0);

  // Answering an old sentence again is refused.
  assert.ok(eh.tap('u1', round.roundId, 0, item0.at).error);
  // Another student cannot answer this round.
  assert.ok(eh.tap('u2', round.roundId, 2, 0).error);

  // Too slow: no points.
  const item2 = eh.rounds.get(round.roundId).items[2];
  c.advance((ITEM_SECONDS + 5) * 1000);
  const late = eh.tap('u1', round.roundId, 2, item2.at);
  assert.equal(late.timeout, true);
  assert.equal(late.gained, 0);

  for (let i = 3; i < ROUND_SIZE; i += 1) eh.timeout('u1', round.roundId, i);
  const summary = eh.take('u1', round.roundId);
  assert.deepEqual(summary, { points: 25, correct: 1, total: ROUND_SIZE });
  assert.equal(eh.take('u1', round.roundId), null, 'a round is scored once');
});

// ------------------------------------------------------------ word duel

test('Word Duel: same questions, speed counts, winner gets the bonus', () => {
  const c = clock();
  const finished = [];
  const hub = new DuelHub({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0.1, onFinish: r => finished.push(r) });
  const a = stream(); const b = stream();
  hub.connect({ id: 'a', name: 'Aziza' }, a);
  hub.connect({ id: 'b', name: 'Bek' }, b);
  assert.equal(hub.find('a').waiting, true);
  assert.equal(hub.find('b').matched, true);
  assert.equal(a.last('matched').opponent.name, 'Bek');

  c.advance(3000);
  for (let i = 0; i < 10; i += 1) {
    const qa = a.last('question'); const qb = b.last('question');
    assert.equal(qa.i, i); assert.equal(qa.text, qb.text);
    const match = [...hub.matches.values()][0];
    const answer = match.qs[i].answer;
    c.advance(1000);
    hub.answer('a', i, answer);                       // fast and right
    assert.equal(b.last('opponent-answered').i, i);
    c.advance(4000);
    hub.answer('b', i, (answer + 1) % 4);             // slower and wrong
    assert.equal(a.last('reveal').i, i);
    c.advance(2500);
  }
  const done = a.last('finished');
  assert.equal(done.winner, 'a');
  assert.equal(done.scores.a, 10 * 19 + WIN_BONUS);
  assert.equal(done.scores.b, 0);
  assert.equal(finished[0].bot, false);
  assert.deepEqual(finished[0].results.map(r => [r.id, r.points, r.won]), [['a', 220, true], ['b', 0, false]]);
});

test('Word Duel: the practice bot steps in, and leaving hands over the win', () => {
  const c = clock();
  const finished = [];
  const hub = new DuelHub({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onFinish: r => finished.push(r) });
  const a = stream();
  hub.connect({ id: 'a', name: 'Aziza' }, a);
  hub.find('a');
  c.advance(BOT_AFTER_MS);
  assert.equal(a.last('matched').bot, true);
  assert.match(a.last('matched').opponent.name, /bot/i);
  c.advance(3000 + QUESTION_MS + 600);
  assert.ok(a.last('reveal'), 'the question closes even if nobody answers');
  hub.leave('a');
  assert.equal(a.last('finished').reason, 'forfeit');
  assert.equal(finished[0].bot, true);
  assert.equal(finished[0].results[0].points, 0, 'the one who left scores nothing');
});

// ---------------------------------------------------------------- taboo

test('Taboo: guesses in chat, points to guesser and describer, turns rotate', () => {
  const c = clock();
  const voice = new VoiceHub({ pickTopic: () => ({ text: 't' }), onSessionStart: async () => 's' });
  const s = { a: stream(), b: stream(), c: stream() };
  for (const id of ['a', 'b', 'c']) { voice.connect({ id, name: id.toUpperCase() }, s[id]); voice.join(id, 'club-open'); }
  const ended = [];
  const game = new TabooGame({
    hub: voice, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0,
    cards: [{ id: 'x', word: 'library', taboo: ['book', 'read', 'borrow', 'quiet'] }, { id: 'y', word: 'bridge', taboo: ['river', 'cross', 'road', 'over'] }],
    onFinish: r => ended.push(r)
  });
  assert.equal(game.start('a').ok, true);
  assert.equal(s.a.last('taboo-card').word, 'library', 'the describer sees the card');
  assert.equal(s.b.last('taboo-card'), undefined, 'nobody else does');
  assert.equal(s.b.last('taboo').describer.id, 'a');

  assert.equal(game.describerLeaks('a', 'you can borrow books there'), true);
  assert.equal(game.describerLeaks('b', 'borrow'), false);
  assert.equal(game.guess('b', 'is it a school?'), null);
  assert.deepEqual(game.guess('b', 'Libraries!'), { correct: true });
  assert.equal(s.c.last('taboo-correct').by, 'B');
  const scores = Object.fromEntries(s.c.last('taboo').scores.map(x => [x.id, x.points]));
  assert.deepEqual([scores.a, scores.b, scores.c], [10, 10, 0]);

  game.buzz('c');
  assert.equal(Object.fromEntries(s.c.last('taboo').scores.map(x => [x.id, x.points])).a, 5, 'buzz costs the describer 5');

  c.advance(TURN_SECONDS * 1000);
  assert.equal(s.a.last('taboo').describer.id, 'b', 'next turn');
  c.advance(TURN_SECONDS * 1000 * 2);
  assert.ok(s.a.last('taboo-end'));
  assert.equal(ended.length, 1);
  assert.equal(game.games.size, 0);
});

test('Taboo needs a group room with two people', () => {
  const voice = new VoiceHub({ pickTopic: () => ({}), onSessionStart: async () => 's' });
  voice.connect({ id: 'a', name: 'A' }, stream());
  const game = new TabooGame({ hub: voice });
  assert.equal(game.start('a').ok, false);
  voice.join('a', 'club-b2');
  assert.match(game.start('a').reason, /2/);
});

test('matching a guess: plurals and phrases, not parts of words', () => {
  assert.equal(mentions('I think it is a library', 'library'), true);
  assert.equal(mentions('libraries', 'library'), true);
  assert.equal(mentions('cats', 'cat'), true);
  assert.equal(mentions('category', 'cat'), false);
  assert.equal(mentions('social media!', 'social media'), true);
  assert.equal(mentions('social', 'social media'), false);
});

test('the games week starts on Monday in Tashkent', () => {
  // Wednesday 24 Sep 2026, 03:00 in Tashkent (22:00 UTC on the 23rd)
  const t = Date.UTC(2026, 8, 23, 22, 0);
  assert.equal(startOfDay(t).toISOString(), '2026-09-23T19:00:00.000Z');
  assert.equal(startOfWeek(t).toISOString(), '2026-09-20T19:00:00.000Z');
});
