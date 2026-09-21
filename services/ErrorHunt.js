import crypto from 'crypto';
import { ERROR_ITEMS, corrected } from '../content/errorHunter.js';

/**
 * Error Hunter rounds, scored on the server.
 *
 * A round is 10 sentences. For each, the student taps the word they think is
 * wrong; only if they found it do they see the three possible fixes (sending
 * the fixes up front would give the answer away). Points per sentence:
 *
 *   found the wrong word  10
 *   picked the right fix  10
 *   speed bonus         0–5   (both right; full bonus inside 4 seconds)
 *
 * A sentence has ITEM_SECONDS; answers after that (plus a little grace for a
 * slow connection) score nothing. Rounds live in memory: a restart simply
 * ends any round in progress.
 */

export const ROUND_SIZE = 10;
export const ITEM_SECONDS = 20;
const GRACE_MS = 3000;
const ROUND_TTL_MS = 30 * 60 * 1000;
export const DELETE_LABEL = "(so'zni olib tashlash)";

const shuffle = list => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export class ErrorHunt {
  constructor({ items = ERROR_ITEMS, now = () => Date.now() } = {}) {
    this.items = items;
    this.now = now;
    this.rounds = new Map(); // roundId -> round
    this.byUser = new Map(); // userId -> roundId
  }

  start(userId) {
    this.sweep();
    const old = this.byUser.get(String(userId));
    if (old) this.rounds.delete(old);
    const id = crypto.randomUUID();
    const picked = shuffle(this.items).slice(0, ROUND_SIZE);
    const round = {
      id, user: String(userId), items: picked, pos: 0, itemStart: this.now(),
      found: false, options: null, points: 0, correct: 0, log: [], startedAt: this.now()
    };
    this.rounds.set(id, round);
    this.byUser.set(String(userId), id);
    return {
      roundId: id,
      total: picked.length,
      seconds: ITEM_SECONDS,
      items: picked.map((it, index) => ({ index, words: it.words }))
    };
  }

  get(userId, roundId, index) {
    const round = this.rounds.get(String(roundId));
    if (!round || round.user !== String(userId)) return { error: 'Bu raund topilmadi — qaytadan boshlang.' };
    if (round.pos >= round.items.length) return { error: 'Raund tugagan.' };
    if (Number(index) !== round.pos) return { error: 'Bu savolga javob berib bo\'lingan.' };
    return { round, item: round.items[round.pos] };
  }

  expired(round) {
    return this.now() - round.itemStart > ITEM_SECONDS * 1000 + GRACE_MS;
  }

  reveal(round, item, gained, extra = {}) {
    round.points += gained;
    round.log.push({ id: item.id, gained });
    round.pos += 1;
    round.itemStart = this.now();
    round.found = false;
    round.options = null;
    const done = round.pos >= round.items.length;
    return {
      at: item.at,
      fix: item.fix || DELETE_LABEL,
      sentence: corrected(item),
      why: item.why,
      gained,
      points: round.points,
      done,
      ...(done ? { summary: this.summary(round) } : {}),
      ...extra
    };
  }

  /** The student tapped a word. */
  tap(userId, roundId, index, wordIndex) {
    const { round, item, error } = this.get(userId, roundId, index);
    if (error) return { error };
    if (round.found) return { found: true, options: round.options.map(o => o.label) };
    if (this.expired(round)) return { found: false, timeout: true, ...this.reveal(round, item, 0) };
    // A miss is an answer, not an error: the reveal shows where the mistake was.
    if (Number(wordIndex) !== item.at) return { found: false, ...this.reveal(round, item, 0) };

    round.found = true;
    round.options = shuffle([item.fix, ...item.wrong]).map(value => ({ value, label: value || DELETE_LABEL }));
    return { found: true, options: round.options.map(o => o.label) };
  }

  /** The student picked a fix (after finding the word). */
  fix(userId, roundId, index, choice) {
    const { round, item, error } = this.get(userId, roundId, index);
    if (error) return { error };
    if (!round.found) return { error: "Avval xato so'zni toping." };
    const option = round.options[Number(choice)];
    if (!option) return { error: 'Variantni tanlang.' };
    if (this.expired(round)) return { right: false, timeout: true, ...this.reveal(round, item, 0) };

    const right = option.value === item.fix;
    const seconds = (this.now() - round.itemStart) / 1000;
    const bonus = right ? Math.max(0, 5 - Math.floor(seconds / 4)) : 0;
    const gained = 10 + (right ? 10 + bonus : 0);
    if (right) round.correct += 1;
    return { right, ...this.reveal(round, item, gained) };
  }

  /** Time ran out on this sentence. */
  timeout(userId, roundId, index) {
    const { round, item, error } = this.get(userId, roundId, index);
    if (error) return { error };
    return { timeout: true, ...this.reveal(round, item, 0) };
  }

  summary(round) {
    return { points: round.points, correct: round.correct, total: round.items.length };
  }

  /** The finished round, removed so it cannot be scored twice. */
  take(userId, roundId) {
    const round = this.rounds.get(String(roundId));
    if (!round || round.user !== String(userId) || round.pos < round.items.length || round.taken) return null;
    round.taken = true;
    this.rounds.delete(round.id);
    this.byUser.delete(round.user);
    return this.summary(round);
  }

  sweep() {
    const now = this.now();
    for (const [id, r] of this.rounds) {
      if (now - r.startedAt > ROUND_TTL_MS) { this.rounds.delete(id); this.byUser.delete(r.user); }
    }
  }
}

export default ErrorHunt;
