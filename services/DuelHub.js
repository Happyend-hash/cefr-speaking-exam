import crypto from 'crypto';
import { DUEL_QUESTIONS } from '../content/wordDuel.js';

/**
 * Word Duel: two students, the same ten questions at the same moment.
 *
 * Correct = 10 points + up to 10 for speed; the winner gets 30 more. If no
 * other student is looking for a duel within BOT_AFTER_MS, the practice bot
 * steps in — clearly named as a bot, answering at a human-ish pace and
 * getting about two in three right. Everything is decided here, on the
 * server; the browsers only show questions and send answers.
 *
 * Same shape as the speaking-room hub: one event stream per browser, short
 * POSTs back, all live state in memory.
 */

export const QUESTIONS_PER_DUEL = 10;
export const QUESTION_MS = 10000;
export const REVEAL_MS = 2500;
export const START_MS = 3000;
export const BOT_AFTER_MS = 15000;
export const WIN_BONUS = 30;
const DROP_GRACE_MS = 10000;
export const BOT = { id: 'bot', name: 'Mashq boti 🤖', level: null, bot: true };

const shuffle = (list, random) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export class DuelHub {
  constructor({
    questions = DUEL_QUESTIONS,
    now = () => Date.now(),
    setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer = t => clearTimeout(t),
    random = Math.random,
    onFinish = () => {}
  } = {}) {
    Object.assign(this, { questions, now, setTimer, clearTimer, random, onFinish });
    this.clients = new Map(); // id -> { user, streams, matchId, dropTimer }
    this.queue = [];
    this.botTimers = new Map();
    this.matches = new Map();
  }

  // ---------------------------------------------------------- transport

  send(id, event, data = {}) {
    const c = this.clients.get(String(id));
    if (!c) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of c.streams) { try { s.write(frame); } catch { /* removed on close */ } }
  }

  connect(user, stream) {
    const id = String(user.id);
    const c = this.clients.get(id) || { user: { ...user, id }, streams: new Set(), matchId: null, dropTimer: null };
    c.user = { ...c.user, ...user, id };
    c.streams.add(stream);
    if (c.dropTimer) { this.clearTimer(c.dropTimer); c.dropTimer = null; }
    this.clients.set(id, c);
    const match = c.matchId ? this.matches.get(c.matchId) : null;
    this.send(id, 'hello', { you: id, queued: this.queue.includes(id), match: match ? this.view(match, id) : null });
  }

  disconnect(id, stream) {
    const c = this.clients.get(String(id));
    if (!c) return;
    c.streams.delete(stream);
    if (c.streams.size) return;
    c.dropTimer = this.setTimer(() => { this.leave(id); this.clients.delete(String(id)); }, DROP_GRACE_MS);
  }

  // --------------------------------------------------------- matchmaking

  find(id) {
    id = String(id);
    const c = this.clients.get(id);
    if (!c) return { ok: false, reason: 'not connected' };
    if (c.matchId) return { ok: true, matched: true };
    if (this.queue.includes(id)) return { ok: true, waiting: true };
    const other = this.queue.find(x => x !== id);
    if (other) {
      this.cancel(other);
      this.start(other, id);
      return { ok: true, matched: true };
    }
    this.queue.push(id);
    this.botTimers.set(id, this.setTimer(() => {
      if (!this.queue.includes(id)) return;
      this.cancel(id);
      this.start(id, null);
    }, BOT_AFTER_MS));
    return { ok: true, waiting: true, botAfter: BOT_AFTER_MS / 1000 };
  }

  cancel(id) {
    id = String(id);
    this.queue = this.queue.filter(x => x !== id);
    const t = this.botTimers.get(id);
    if (t) { this.clearTimer(t); this.botTimers.delete(id); }
  }

  // --------------------------------------------------------------- duel

  start(a, b) {
    const qs = shuffle(this.questions, this.random).slice(0, QUESTIONS_PER_DUEL).map(q => {
      const options = shuffle(q.options, this.random);
      return { id: q.id, text: q.text, options, answer: options.indexOf(q.options[0]) };
    });
    const players = [String(a), b ? String(b) : BOT.id];
    const match = {
      id: crypto.randomUUID(), players, bot: !b, qs, i: -1, answers: {},
      scores: Object.fromEntries(players.map(p => [p, 0])), timer: null, done: false
    };
    this.matches.set(match.id, match);
    for (const p of players) {
      const c = this.clients.get(p);
      if (c) c.matchId = match.id;
    }
    for (const p of players) this.send(p, 'matched', this.view(match, p));
    match.timer = this.setTimer(() => this.ask(match, 0), START_MS);
    return match;
  }

  person(id) {
    if (id === BOT.id) return BOT;
    const u = this.clients.get(id)?.user || {};
    return { id, name: u.name || "O'quvchi", level: u.level || null, premium: Boolean(u.premium), avatar: u.avatar || null };
  }

  view(match, forId) {
    const opponent = match.players.find(p => p !== forId);
    return {
      matchId: match.id,
      you: forId,
      opponent: this.person(opponent),
      total: match.qs.length,
      bot: match.bot,
      scores: match.scores,
      i: match.i
    };
  }

  ask(match, i) {
    if (match.done) return;
    match.i = i;
    match.answers = {};
    match.askedAt = this.now();
    const q = match.qs[i];
    for (const p of match.players) {
      this.send(p, 'question', { i, total: match.qs.length, text: q.text, options: q.options, seconds: QUESTION_MS / 1000 });
    }
    match.timer = this.setTimer(() => this.reveal(match), QUESTION_MS + 500);
    if (match.bot) {
      const delay = 2500 + Math.floor(this.random() * 6000);
      const right = this.random() < 0.65;
      const choice = right ? q.answer : (q.answer + 1 + Math.floor(this.random() * 3)) % q.options.length;
      match.botTimer = this.setTimer(() => this.answer(BOT.id, i, choice, match.id), delay);
    }
  }

  answer(id, i, choice, matchId = null) {
    id = String(id);
    const match = id === BOT.id ? this.matches.get(matchId) : this.matches.get(this.clients.get(id)?.matchId);
    if (!match || match.done) return { ok: false, reason: 'no duel' };
    if (Number(i) !== match.i) return { ok: false, reason: 'late' };
    if (match.answers[id]) return { ok: true };
    const ms = this.now() - match.askedAt;
    if (ms > QUESTION_MS + 500) return { ok: false, reason: 'time is up' };
    const pick = Number(choice);
    if (!Number.isInteger(pick) || pick < 0 || pick >= match.qs[match.i].options.length) return { ok: false, reason: 'bad choice' };
    match.answers[id] = { choice: pick, ms };
    // The opponent sees that you answered (not what), which is half the fun.
    for (const p of match.players) if (p !== id) this.send(p, 'opponent-answered', { i: match.i });
    if (match.players.every(p => match.answers[p])) {
      this.clearTimer(match.timer);
      this.reveal(match);
    }
    return { ok: true };
  }

  reveal(match) {
    if (match.done || match.revealed === match.i) return;
    match.revealed = match.i;
    if (match.botTimer) { this.clearTimer(match.botTimer); match.botTimer = null; }
    const q = match.qs[match.i];
    const gained = {};
    const picks = {};
    for (const p of match.players) {
      const a = match.answers[p];
      picks[p] = a ? a.choice : null;
      gained[p] = a && a.choice === q.answer ? 10 + Math.round(10 * Math.max(0, 1 - a.ms / QUESTION_MS)) : 0;
      match.scores[p] += gained[p];
    }
    for (const p of match.players) this.send(p, 'reveal', { i: match.i, answer: q.answer, picks, gained, scores: match.scores });
    const next = match.i + 1;
    match.timer = this.setTimer(() => (next < match.qs.length ? this.ask(match, next) : this.finish(match)), REVEAL_MS);
  }

  finish(match, { forfeit = null } = {}) {
    if (match.done) return;
    match.done = true;
    this.clearTimer(match.timer);
    if (match.botTimer) this.clearTimer(match.botTimer);
    const [a, b] = match.players;
    let winner = null;
    if (forfeit) winner = match.players.find(p => p !== forfeit);
    else if (match.scores[a] !== match.scores[b]) winner = match.scores[a] > match.scores[b] ? a : b;
    const final = { ...match.scores };
    if (winner) final[winner] += WIN_BONUS;

    for (const p of match.players) {
      this.send(p, 'finished', { scores: final, winner, bonus: winner ? WIN_BONUS : 0, reason: forfeit ? 'forfeit' : 'done' });
      const c = this.clients.get(p);
      if (c && c.matchId === match.id) c.matchId = null;
    }
    this.matches.delete(match.id);
    this.onFinish({
      matchId: match.id,
      bot: match.bot,
      results: match.players
        .filter(p => p !== BOT.id)
        .map(p => ({ id: p, points: p === forfeit ? 0 : final[p], won: p === winner, opponent: match.players.find(x => x !== p) }))
    });
  }

  /** Leaving mid-duel hands the win to the other side. */
  leave(id) {
    id = String(id);
    this.cancel(id);
    const c = this.clients.get(id);
    const match = c?.matchId ? this.matches.get(c.matchId) : null;
    if (match) this.finish(match, { forfeit: id });
  }

  kick(id) {
    this.send(id, 'kicked', { reason: 'removed by the teacher' });
    this.leave(id);
  }
}

export default DuelHub;
