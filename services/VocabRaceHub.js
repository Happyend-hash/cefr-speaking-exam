import crypto from 'crypto';
import { VOCAB_PACKS } from '../content/vocabPacks.js';

/**
 * Word Sprint: a teacher picks a vocabulary pack (Destination B1, or one of
 * the English Hub books) and one or more of its units, students join with
 * the room code, and once the teacher starts it everyone races through every
 * word in those units — at their own pace, on their own device. Correct = 10
 * points + up to 10 for speed, same formula as Word Duel. There is no
 * lockstep and no waiting for anyone else: a fast, accurate student simply
 * finishes sooner. The race ends, and points are awarded, once every joined
 * student has finished or the teacher ends it early.
 *
 * Not every pack has a synonym or part of speech for each word (only
 * Destination B1 does), so a question type is only offered for a word when
 * the data for it actually exists — see buildQuestions().
 *
 * Same shape as the other game hubs: one SSE stream per browser, short POSTs
 * back, all live state in memory on this one server process.
 */

export const QUESTION_MS = 10000;
export const NEXT_MS = 900; // brief pause after an answer before the next word
const DROP_GRACE_MS = 10000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_LEN = 4;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000; // rooms nobody ever starts are swept up

const shuffle = (list, random) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const QUESTION_TYPES = [
  { key: 'en_uz', field: 'uz', promptField: 'word', kicker: "To'g'ri o'zbekcha ma'nosini tanlang" },
  { key: 'uz_en', field: 'word', promptField: 'uz', kicker: "Inglizcha so'zni tanlang" },
  { key: 'syn', field: 'synonym', promptField: 'word', kicker: 'Eng yaqin sinonimni tanlang' }
];

export class VocabRaceHub {
  constructor({
    packs = VOCAB_PACKS,
    now = () => Date.now(),
    setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    clearTimer = t => clearTimeout(t),
    random = Math.random,
    onFinish = () => {}
  } = {}) {
    Object.assign(this, { packs, now, setTimer, clearTimer, random, onFinish });
    this.clients = new Map(); // id -> { user, streams, roomCode, dropTimer }
    this.rooms = new Map();   // code -> room
  }

  pack(key) {
    return this.packs.find(p => p.key === key);
  }

  // ---------------------------------------------------------- transport

  send(id, event, data = {}) {
    const c = this.clients.get(String(id));
    if (!c) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of c.streams) { try { s.write(frame); } catch { /* removed on close */ } }
  }

  broadcast(room, event, data = {}) {
    this.send(room.hostId, event, data);
    for (const id of room.players.keys()) this.send(id, event, data);
  }

  connect(user, stream) {
    const id = String(user.id);
    const c = this.clients.get(id) || { user: { ...user, id }, streams: new Set(), roomCode: null, dropTimer: null };
    c.user = { ...c.user, ...user, id };
    c.streams.add(stream);
    if (c.dropTimer) { this.clearTimer(c.dropTimer); c.dropTimer = null; }
    this.clients.set(id, c);
    const room = c.roomCode ? this.rooms.get(c.roomCode) : null;
    this.send(id, 'hello', { you: id, room: room ? this.view(room, id) : null });
  }

  disconnect(id, stream) {
    const c = this.clients.get(String(id));
    if (!c) return;
    c.streams.delete(stream);
    if (c.streams.size) return;
    c.dropTimer = this.setTimer(() => this.clients.delete(String(id)), DROP_GRACE_MS);
  }

  // -------------------------------------------------------------- rooms

  person(id) {
    const u = this.clients.get(String(id))?.user || {};
    return { id: String(id), name: u.name || "O'quvchi", premium: Boolean(u.premium), avatar: u.avatar || null };
  }

  pool(pack, unitIds) {
    const wanted = new Set(unitIds.map(String));
    const out = [];
    for (const u of pack.units) {
      if (!wanted.has(String(u.id))) continue;
      for (const w of u.words) out.push({ unitId: String(u.id), word: w.word, pos: w.pos, synonym: w.synonym, uz: w.uz });
    }
    return out;
  }

  makeCode() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      let code = '';
      for (let i = 0; i < CODE_LEN; i += 1) code += CODE_CHARS[Math.floor(this.random() * CODE_CHARS.length)];
      if (!this.rooms.has(code)) return code;
    }
    return crypto.randomUUID().slice(0, 8).toUpperCase();
  }

  /** hostId must already be checked as staff by the route. */
  create(hostId, packKey, unitIds) {
    hostId = String(hostId);
    const pack = this.pack(packKey);
    if (!pack) return { ok: false, reason: 'Bu lug’at to’plami topilmadi' };
    const ids = [...new Set((unitIds || []).map(String))].filter(id => pack.units.some(u => String(u.id) === id));
    if (!ids.length) return { ok: false, reason: 'Kamida bitta bo’lim tanlang' };
    const pool = this.pool(pack, ids);
    if (!pool.length) return { ok: false, reason: 'Bu bo’limlarda so’z topilmadi' };

    this.sweep();
    const code = this.makeCode();
    const room = {
      code, hostId, packKey: pack.key, packTitle: pack.title, unitIds: ids, pool,
      players: new Map(), // id -> { user, qs, cursor, score, correct, streak, best, missed, finished, finishedAt, timer, askedAt }
      started: false, over: false, createdAt: this.now()
    };
    this.rooms.set(code, room);
    const c = this.clients.get(hostId);
    if (c) c.roomCode = code;
    return { ok: true, code, words: pool.length };
  }

  sweep() {
    const cutoff = this.now() - ROOM_TTL_MS;
    for (const [code, room] of this.rooms) {
      if (!room.started && room.createdAt < cutoff) this.rooms.delete(code);
    }
  }

  /**
   * The shared, unpersonalized room state — safe to send to everyone in the
   * room with a single broadcast (unlike view(), it never says who the host
   * is, so it can't leak that flag to whoever isn't).
   */
  roomSummary(room) {
    const roster = [...room.players.values()].map(p => ({
      ...this.person(p.user.id), correct: p.correct, total: p.qs?.length || 0, finished: p.finished, score: p.score
    }));
    const base = {
      code: room.code, packKey: room.packKey, packTitle: room.packTitle, unitIds: room.unitIds, words: room.pool.length,
      started: room.started, over: room.over, roster
    };
    return room.over ? { ...base, podium: this.podium(room) } : base;
  }

  /** A snapshot personalized for one client — used for the one-off 'hello' on (re)connect. */
  view(room, forId) {
    const isHost = String(forId) === room.hostId;
    const summary = this.roomSummary(room);
    if (room.over || isHost || !room.started) return { ...summary, isHost };
    const me = room.players.get(String(forId));
    if (!me) return { ...summary, isHost };
    if (me.finished) return { ...summary, isHost, you: { finished: true, score: me.score, correct: me.correct, total: me.qs.length } };
    return { ...summary, isHost, you: this.questionView(me) };
  }

  join(userId, code) {
    userId = String(userId);
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) return { ok: false, reason: 'Xona topilmadi — kodni tekshiring' };
    if (room.over) return { ok: false, reason: 'Bu poyga tugagan' };
    if (userId === room.hostId) return { ok: false, reason: 'Siz bu xonaning o’qituvchisisiz' };
    let player = room.players.get(userId);
    if (!player) {
      if (room.started) return { ok: false, reason: 'Poyga allaqachon boshlangan — keyingisini kuting' };
      const c = this.clients.get(userId);
      player = {
        user: { id: userId, name: c?.user?.name, premium: c?.user?.premium, avatar: c?.user?.avatar },
        qs: null, cursor: 0, score: 0, correct: 0, streak: 0, best: 0, missed: [],
        finished: false, finishedAt: null, timer: null, askedAt: 0
      };
      room.players.set(userId, player);
    }
    const c = this.clients.get(userId);
    if (c) c.roomCode = room.code;
    this.broadcast(room, 'roster', this.roomSummary(room));
    return { ok: true, code: room.code };
  }

  buildQuestions(room) {
    const picked = shuffle(room.pool, this.random);
    return picked.map(entry => {
      // Not every pack has a synonym or part of speech (only Destination B1
      // does) — only offer a question type this word actually has data for.
      const available = QUESTION_TYPES.filter(t => entry[t.field] && entry[t.promptField]);
      const type = available[Math.floor(this.random() * available.length)] || QUESTION_TYPES[0];
      const correctText = entry[type.field];
      const promptText = entry[type.promptField];
      const seen = new Set([correctText]);
      const sameUnit = shuffle(room.pool.filter(e => e.unitId === entry.unitId && e.word !== entry.word), this.random);
      const others = shuffle(room.pool.filter(e => e.unitId !== entry.unitId && e.word !== entry.word), this.random);
      const distractors = [];
      for (const src of [sameUnit, others]) {
        for (const cand of src) {
          if (distractors.length >= 3) break;
          const val = cand[type.field];
          if (!val || seen.has(val)) continue;
          seen.add(val);
          distractors.push(val);
        }
        if (distractors.length >= 3) break;
      }
      while (distractors.length < 3) distractors.push(`${correctText} `);
      const options = shuffle([correctText, ...distractors], this.random);
      return {
        kicker: type.kicker, prompt: promptText, pos: type.promptField === 'word' ? entry.pos : null,
        options, answer: options.indexOf(correctText), word: entry.word, uz: entry.uz
      };
    });
  }

  start(hostId) {
    hostId = String(hostId);
    const c = this.clients.get(hostId);
    const room = c?.roomCode ? this.rooms.get(c.roomCode) : null;
    if (!room || room.hostId !== hostId) return { ok: false, reason: 'Xona topilmadi' };
    if (room.started) return { ok: false, reason: 'Poyga allaqachon boshlangan' };
    if (!room.players.size) return { ok: false, reason: 'Hali hech kim qo’shilmadi' };
    room.started = true;
    room.startedAt = this.now();
    for (const player of room.players.values()) {
      player.qs = this.buildQuestions(room);
      this.send(player.user.id, 'start', { total: player.qs.length });
      this.ask(room, player, 0);
    }
    this.broadcast(room, 'started', this.roomSummary(room));
    return { ok: true };
  }

  questionView(player) {
    const q = player.qs[player.cursor];
    return { i: player.cursor, total: player.qs.length, kicker: q.kicker, prompt: q.prompt, pos: q.pos, options: q.options, seconds: QUESTION_MS / 1000 };
  }

  ask(room, player, i) {
    if (room.over || player.finished) return;
    player.cursor = i;
    player.askedAt = this.now();
    this.send(player.user.id, 'question', this.questionView(player));
    player.timer = this.setTimer(() => this.timeout(room.code, player.user.id, i), QUESTION_MS + 500);
  }

  timeout(code, userId, i) {
    const room = this.rooms.get(code);
    const player = room?.players.get(String(userId));
    if (!room || !player || player.cursor !== i || player.finished) return;
    this.settle(room, player, null, QUESTION_MS);
  }

  answer(userId, i, choice) {
    userId = String(userId);
    const c = this.clients.get(userId);
    const room = c?.roomCode ? this.rooms.get(c.roomCode) : null;
    const player = room?.players.get(userId);
    if (!room || !player || player.finished) return { ok: false, reason: 'poyga topilmadi' };
    if (Number(i) !== player.cursor) return { ok: false, reason: 'kech qoldingiz' };
    const ms = this.now() - player.askedAt;
    if (ms > QUESTION_MS + 500) return { ok: false, reason: 'vaqt tugadi' };
    if (player.timer) { this.clearTimer(player.timer); player.timer = null; }
    const pick = Number(choice);
    const q = player.qs[i];
    if (!Number.isInteger(pick) || pick < 0 || pick >= q.options.length) return { ok: false, reason: 'noto’g’ri tanlov' };
    this.settle(room, player, pick, ms);
    return { ok: true };
  }

  settle(room, player, pick, ms) {
    const q = player.qs[player.cursor];
    const correct = pick !== null && pick === q.answer;
    let gained = 0;
    if (correct) {
      gained = 10 + Math.round(10 * Math.max(0, 1 - ms / QUESTION_MS));
      player.correct += 1;
      player.streak += 1;
      player.best = Math.max(player.best, player.streak);
      player.score += gained;
    } else {
      player.streak = 0;
      player.missed.push({ word: q.word, uz: q.uz });
    }
    this.send(player.user.id, 'reveal', { i: player.cursor, answer: q.answer, picked: pick, gained, score: player.score, streak: player.streak });
    // Broadcast (not just to the host) so every player's own screen can show
    // a live race track too, not only the teacher's.
    this.broadcast(room, 'progress', { id: player.user.id, correct: player.correct, total: player.qs.length, score: player.score, finished: false });

    const next = player.cursor + 1;
    this.setTimer(() => {
      if (room.over) return;
      if (next >= player.qs.length) this.finishPlayer(room, player);
      else this.ask(room, player, next);
    }, NEXT_MS);
  }

  finishPlayer(room, player) {
    player.finished = true;
    player.finishedAt = this.now();
    this.send(player.user.id, 'finished-you', { score: player.score, correct: player.correct, total: player.qs.length, missed: player.missed });
    this.broadcast(room, 'progress', { id: player.user.id, correct: player.correct, total: player.qs.length, score: player.score, finished: true });
    if ([...room.players.values()].every(p => p.finished)) this.finish(room);
  }

  podium(room) {
    const ranked = [...room.players.values()]
      .map(p => ({ player: p, points: p.score, finishedAt: p.finishedAt }))
      .sort((a, b) => b.points - a.points || (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity));
    return ranked.map((r, i) => ({
      id: r.player.user.id, ...this.person(r.player.user.id),
      points: r.points, correct: r.player.correct, total: r.player.qs?.length || 0, rank: i + 1
    }));
  }

  /** Ends the room now, whether or not everyone has finished. */
  finish(room) {
    if (room.over) return;
    room.over = true;
    for (const player of room.players.values()) if (player.timer) this.clearTimer(player.timer);
    const podium = this.podium(room);
    this.broadcast(room, 'over', this.roomSummary(room));
    for (const id of room.players.keys()) {
      const c = this.clients.get(id);
      if (c) c.roomCode = null;
    }
    this.onFinish({ code: room.code, results: podium.map(r => ({ id: r.id, points: r.points, rank: r.rank })) });
    this.setTimer(() => this.rooms.delete(room.code), ROOM_TTL_MS);
  }

  /** The teacher ending the race early. */
  end(hostId) {
    hostId = String(hostId);
    const c = this.clients.get(hostId);
    const room = c?.roomCode ? this.rooms.get(c.roomCode) : null;
    if (!room || room.hostId !== hostId) return { ok: false, reason: 'Xona topilmadi' };
    this.finish(room);
    return { ok: true };
  }

  /** A student leaving before the race is over: their spot just stops progressing. */
  leave(userId) {
    userId = String(userId);
    const c = this.clients.get(userId);
    if (!c || !c.roomCode) return;
    const room = this.rooms.get(c.roomCode);
    c.roomCode = null;
    if (!room || room.hostId === userId) return;
    const player = room.players.get(userId);
    if (player?.timer) this.clearTimer(player.timer);
  }
}

export default VocabRaceHub;
