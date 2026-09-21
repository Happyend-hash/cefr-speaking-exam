/**
 * What a chat message may contain.
 *
 * Runs on the server, on every message, before anyone else sees it. Free —
 * no AI — and deliberately simple: it catches the common cases and the
 * teacher's Report and Block buttons catch the rest.
 *
 *   - swear words in English, Russian and Uzbek are masked (***)
 *   - links and phone numbers are removed: with school-age students and open
 *     sign-up, swapping contacts to move a conversation somewhere the teacher
 *     cannot see is the thing to prevent
 *   - messages mostly in Cyrillic are refused with a nudge to write in
 *     English — these are English practice rooms
 *   - length and pace are limited, so nobody can flood a room
 */

export const MAX_LENGTH = 500;

/**
 * Roots, matched at the START of a word so that ordinary words containing the
 * letters ("class", "assume", "Scunthorpe") are left alone.
 */
const ROOTS = [
  // English
  'fuck', 'fck', 'fuk', 'shit', 'bitch', 'cunt', 'asshole', 'dick', 'bastard', 'whore',
  'slut', 'nigg', 'fagg', 'motherf', 'retard', 'wank', 'twat', 'pussy', 'porn',
  // Russian (Cyrillic and Latin spellings)
  'бля', 'хуй', 'хуе', 'хуё', 'пизд', 'еба', 'ебл', 'ёба', 'сука', 'суки', 'мудак', 'пидор', 'пидар', 'шлюх', 'гандон',
  'blya', 'blyat', 'xuy', 'huy', 'pizd', 'yeba', 'suka', 'mudak', 'pidor', 'pidar', 'gandon',
  // Uzbek
  'jalab', 'qanjiq', 'sikay', 'sikdi', 'sikib', 'onangni', 'dalbayo', 'dalbaeb', 'itvachcha', 'haromi', 'xaromi'
];

const wordStart = new RegExp(`(^|[^\\p{L}])(${ROOTS.map(r => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[\\p{L}]*`, 'giu');

const LINK = /\b((https?:\/\/|www\.)\S+|t\.me\/\S+|\S+\.(com|uz|ru|net|org|me|io|app|site|link)(\/\S*)?)/gi;
const HANDLE = /(^|\s)@[a-z0-9_]{4,}/gi;
// 7+ digits, allowing spaces, dashes, brackets and a leading + in between.
const PHONE = /\+?\d[\d\s\-()]{6,}\d/g;

/** Masks, removals and a verdict. */
export function cleanMessage(raw) {
  let text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > MAX_LENGTH) text = text.slice(0, MAX_LENGTH);

  const letters = text.match(/\p{L}/gu) || [];
  const cyrillic = text.match(/\p{Script=Cyrillic}/gu) || [];
  if (letters.length >= 6 && cyrillic.length / letters.length > 0.5) {
    return { ok: false, reason: 'english', message: 'Please write in English 🙂 — bu xonalar ingliz tili amaliyoti uchun.' };
  }

  let changed = false;
  const swap = (pattern, replacer) => {
    const next = text.replace(pattern, replacer);
    if (next !== text) { changed = true; text = next; }
  };
  swap(LINK, '[link removed]');
  swap(HANDLE, (m, lead) => `${lead}[contact removed]`);
  swap(PHONE, '[number removed]');
  swap(wordStart, (m, lead, root) => `${lead}${'*'.repeat(Math.max(3, m.length - lead.length))}`);

  return { ok: true, text, changed };
}

/**
 * At most 1 message a second and 20 a minute per student. In memory, per
 * server process — the same as the rooms themselves.
 */
const recent = new Map();
export function allowMessage(userId, now = Date.now()) {
  const id = String(userId);
  const times = (recent.get(id) || []).filter(t => now - t < 60000);
  if (times.length && now - times[times.length - 1] < 1000) return false;
  if (times.length >= 20) return false;
  times.push(now);
  recent.set(id, times);
  return true;
}

export default { cleanMessage, allowMessage, MAX_LENGTH };
