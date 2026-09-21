import { TABOO_CARDS } from '../content/tabooCards.js';

/**
 * Taboo in a group speaking room.
 *
 * Each person in the room describes words for TURN_SECONDS, out loud, without
 * saying the word or its four forbidden words. The others guess by typing in
 * the room's chat. A right guess gives 10 to the guesser and 10 to the
 * describer, and the next card appears. The describer may skip three cards a
 * turn; anyone listening may press "Taboo!" if a forbidden word was said,
 * which costs the describer 5 and moves on. After everyone has described,
 * the scores go to the games ranking.
 *
 * The card is sent only to the describer. Events travel on the room's own
 * voice stream, so no new connection is needed.
 */

export const TURN_SECONDS = 60;
export const GUESS_POINTS = 10;
export const DESCRIBE_POINTS = 10;
export const BUZZ_PENALTY = 5;
export const MAX_SKIPS = 3;

const norm = s => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9'\s-]/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim()} `;

/** Does this text contain the word (or its plural)? */
export function mentions(text, word) {
  const t = norm(text);
  const w = norm(word).trim();
  if (!w) return false;
  const forms = [w, `${w}s`, `${w}es`];
  if (w.endsWith('y')) forms.push(`${w.slice(0, -1)}ies`);
  if (w.endsWith('f')) forms.push(`${w.slice(0, -1)}ves`);
  return forms.some(f => t.includes(` ${f} `));
}

export class TabooGame {
  constructor({
    hub,
    cards = TABOO_CARDS,
    now = () => Date.now(),
    setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer = t => clearTimeout(t),
    random = Math.random,
    onFinish = () => {}
  }) {
    Object.assign(this, { hub, cards, now, setTimer, clearTimer, random, onFinish });
    this.games = new Map(); // roomId -> game
  }

  gameOf(userId) {
    const room = this.hub.roomOf(userId);
    return room ? this.games.get(room.id) || null : null;
  }

  members(game) {
    return [...(this.hub.rooms.get(game.roomId)?.members || [])];
  }

  broadcast(game, event, data) {
    for (const id of this.members(game)) this.hub.send(id, event, data);
  }

  state(game) {
    return {
      active: true,
      describer: { id: game.describer, name: this.hub.nameOf(game.describer) },
      deadline: game.deadline,
      // Milliseconds left: phones' clocks differ from the server's, so the
      // countdown is started from this rather than from the deadline.
      left: Math.max(0, game.deadline - this.now()),
      seconds: TURN_SECONDS,
      turn: game.turn + 1,
      turns: game.order.length,
      scores: Object.entries(game.scores)
        .map(([id, points]) => ({ id, name: this.hub.nameOf(id) || game.names[id] || "O'quvchi", points }))
        .sort((a, b) => b.points - a.points)
    };
  }

  start(userId) {
    const room = this.hub.roomOf(userId);
    if (!room || room.kind !== 'club') return { ok: false, reason: "Taboo guruh xonalarida o'ynaladi." };
    if (this.games.has(room.id)) return { ok: false, reason: "Bu xonada o'yin allaqachon boshlangan." };
    const order = [...room.members];
    if (order.length < 2) return { ok: false, reason: "Taboo uchun xonada kamida 2 kishi bo'lishi kerak." };
    const game = {
      roomId: room.id, order, turn: -1, used: new Set(), timer: null,
      scores: Object.fromEntries(order.map(id => [id, 0])),
      names: Object.fromEntries(order.map(id => [id, this.hub.nameOf(id)]))
    };
    this.games.set(room.id, game);
    this.broadcast(game, 'taboo-start', { by: this.hub.nameOf(userId) });
    this.nextTurn(game);
    return { ok: true };
  }

  nextTurn(game) {
    this.clearTimer(game.timer);
    const present = new Set(this.members(game));
    if (present.size < 2) return this.finish(game);
    do { game.turn += 1; } while (game.turn < game.order.length && !present.has(game.order[game.turn]));
    if (game.turn >= game.order.length) return this.finish(game);
    game.describer = game.order[game.turn];
    game.skips = 0;
    game.deadline = this.now() + TURN_SECONDS * 1000;
    this.newCard(game);
    this.broadcast(game, 'taboo', this.state(game));
    game.timer = this.setTimer(() => this.nextTurn(game), TURN_SECONDS * 1000);
  }

  newCard(game) {
    let left = this.cards.filter(c => !game.used.has(c.id));
    if (!left.length) { game.used.clear(); left = this.cards; }
    game.card = left[Math.floor(this.random() * left.length)];
    game.used.add(game.card.id);
    game.buzzed = false;
    this.hub.send(game.describer, 'taboo-card', { word: game.card.word, taboo: game.card.taboo, skipsLeft: MAX_SKIPS - game.skips });
  }

  /** A chat message from someone in the room. Returns what happened, if anything. */
  guess(userId, text) {
    const game = this.gameOf(userId);
    const id = String(userId);
    if (!game || id === game.describer || !game.card) return null;
    if (!mentions(text, game.card.word)) return null;
    game.scores[id] = (game.scores[id] || 0) + GUESS_POINTS;
    game.scores[game.describer] = (game.scores[game.describer] || 0) + DESCRIBE_POINTS;
    this.broadcast(game, 'taboo-correct', { by: this.hub.nameOf(id), word: game.card.word, gained: GUESS_POINTS });
    this.newCard(game);
    this.broadcast(game, 'taboo', this.state(game));
    return { correct: true };
  }

  /** Is the describer about to type the answer or a forbidden word? */
  describerLeaks(userId, text) {
    const game = this.gameOf(userId);
    if (!game || String(userId) !== game.describer || !game.card) return false;
    return [game.card.word, ...game.card.taboo].some(w => mentions(text, w));
  }

  skip(userId) {
    const game = this.gameOf(userId);
    if (!game || String(userId) !== game.describer) return { ok: false, reason: 'Faqat tasvirlovchi o\'tkazib yubora oladi.' };
    if (game.skips >= MAX_SKIPS) return { ok: false, reason: "O'tkazib yuborish tugadi." };
    game.skips += 1;
    this.broadcast(game, 'taboo-skip', { word: game.card.word });
    this.newCard(game);
    return { ok: true };
  }

  buzz(userId) {
    const game = this.gameOf(userId);
    if (!game || String(userId) === game.describer) return { ok: false, reason: 'Hozir buni bosa olmaysiz.' };
    if (game.buzzed) return { ok: true };
    game.buzzed = true;
    game.scores[game.describer] = Math.max(0, (game.scores[game.describer] || 0) - BUZZ_PENALTY);
    this.broadcast(game, 'taboo-buzz', { by: this.hub.nameOf(userId), word: game.card.word });
    this.newCard(game);
    this.broadcast(game, 'taboo', this.state(game));
    return { ok: true };
  }

  stop(userId) {
    const game = this.gameOf(userId);
    if (!game) return { ok: false, reason: "O'yin yo'q." };
    this.finish(game);
    return { ok: true };
  }

  finish(game) {
    if (!this.games.has(game.roomId)) return;
    this.clearTimer(game.timer);
    this.games.delete(game.roomId);
    const scores = this.state({ ...game, describer: game.describer || game.order[0] }).scores;
    this.broadcast(game, 'taboo-end', { scores });
    this.onFinish({ roomId: game.roomId, scores });
  }
}

export default TabooGame;
