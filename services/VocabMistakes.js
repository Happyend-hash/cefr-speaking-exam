import mongoose from 'mongoose';
import VocabMistake from '../models/VocabMistake.js';

/**
 * "Xatolarim" — every word a student got wrong in a vocabulary test, kept per
 * book until they learn it (Jamshid, 2026-10-28).
 *
 *  - A wrong answer anywhere (practice, homework, a teacher's room, a
 *    revision test) adds the word, or counts it again and puts it back on the
 *    list if it had been learnt.
 *  - A right answer in a revision test moves it one step on; two in a row and
 *    it is learnt. A right answer in an ordinary test changes nothing.
 *  - The student can also press O'rgandim on any word (and undo it).
 */

export const LEARN_STREAK = 2;      // right answers in a row in revision tests to count as learnt
export const REVIEW_SIZE = 20;      // words in one revision test (most missed first)

/**
 * The rule on its own, for one stored word (or null if it was never missed).
 * Returns the word as it should be stored now, or null when nothing changes.
 */
export function applyAnswer(entry, { correct, review, packTitle = '', unitId = '', word, uz = '' }, now = new Date()) {
  if (!correct) {
    const base = entry ? { ...entry } : { word, misses: 0, firstMissedAt: now, reviewStreak: 0, learntAt: null, learntBy: '' };
    return {
      ...base,
      packTitle: packTitle || base.packTitle || '',
      unitId: unitId || base.unitId || '',
      uz: uz || base.uz || '',
      misses: (base.misses || 0) + 1,
      lastMissedAt: now,
      reviewStreak: 0,
      learntAt: null,
      learntBy: ''
    };
  }
  if (!review || !entry || entry.learntAt) return null;
  const streak = (entry.reviewStreak || 0) + 1;
  const learnt = streak >= LEARN_STREAK;
  return { ...entry, reviewStreak: streak, lastReviewedAt: now, learntAt: learnt ? now : null, learntBy: learnt ? 'test' : '' };
}

const FIELDS = ['packTitle', 'unitId', 'uz', 'misses', 'firstMissedAt', 'lastMissedAt', 'reviewStreak', 'lastReviewedAt', 'learntAt', 'learntBy'];

/** One answer from the test engine, saved. Never throws (a failed save must not break the test). */
export async function recordAnswer(answer, now = new Date()) {
  try {
    if (!mongoose.isValidObjectId(answer.userId) || !answer.packKey || !answer.word) return;
    const key = { user: answer.userId, packKey: answer.packKey, word: answer.word };
    if (answer.correct && !answer.review) return;          // the common case: nothing to look up
    const doc = await VocabMistake.findOne(key);
    const next = applyAnswer(doc ? doc.toObject() : null, answer, now);
    if (!next) return;
    const set = Object.fromEntries(FIELDS.map(f => [f, next[f] ?? null]));
    await VocabMistake.updateOne(key, { $set: set }, { upsert: true });
  } catch (error) {
    console.error('Vocabulary mistake not saved:', error.message);
  }
}

const view = d => ({
  id: String(d._id), word: d.word, uz: d.uz, unitId: d.unitId, misses: d.misses,
  streak: d.reviewStreak || 0, lastMissedAt: d.lastMissedAt, learntAt: d.learntAt || null, learntBy: d.learntBy || ''
});

/** Per book: words still to learn and words learnt. */
export async function mistakeSummary(userId) {
  const rows = await VocabMistake.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(String(userId)) } },
    { $group: {
      _id: '$packKey',
      title: { $last: '$packTitle' },
      open: { $sum: { $cond: [{ $eq: ['$learntAt', null] }, 1, 0] } },
      learnt: { $sum: { $cond: [{ $eq: ['$learntAt', null] }, 0, 1] } },
      last: { $max: '$lastMissedAt' }
    } },
    { $sort: { open: -1, last: -1 } }
  ]);
  const books = rows.map(r => ({ packKey: r._id, title: r.title || r._id, open: r.open, learnt: r.learnt }));
  return { open: books.reduce((a, b) => a + b.open, 0), learnt: books.reduce((a, b) => a + b.learnt, 0), books, learnStreak: LEARN_STREAK, reviewSize: REVIEW_SIZE };
}

/** One book: the words still to learn (most missed first) and the ones learnt. */
export async function mistakeList(userId, packKey) {
  const all = await VocabMistake.find({ user: userId, packKey }).lean();
  const open = all.filter(d => !d.learntAt)
    .sort((a, b) => b.misses - a.misses || new Date(b.lastMissedAt) - new Date(a.lastMissedAt));
  const learnt = all.filter(d => d.learntAt).sort((a, b) => new Date(b.learntAt) - new Date(a.learntAt)).slice(0, 200);
  return { packKey, title: all[0]?.packTitle || packKey, open: open.map(view), learnt: learnt.map(view), learnStreak: LEARN_STREAK };
}

/** The O'rgandim button, and its undo. */
export async function setLearnt(userId, id, learnt, now = new Date()) {
  if (!mongoose.isValidObjectId(id)) throw Object.assign(new Error('So‘z topilmadi'), { statusCode: 404 });
  const doc = await VocabMistake.findOne({ _id: id, user: userId });
  if (!doc) throw Object.assign(new Error('So‘z topilmadi'), { statusCode: 404 });
  doc.learntAt = learnt ? now : null;
  doc.learntBy = learnt ? 'button' : '';
  if (!learnt) doc.reviewStreak = 0;
  await doc.save();
  return doc.packKey;
}

/** The words of one revision test: still to learn, most missed first. */
export async function reviewWords(userId, packKey, limit = REVIEW_SIZE) {
  const open = await VocabMistake.find({ user: userId, packKey, learntAt: null })
    .sort({ misses: -1, lastMissedAt: -1 }).limit(limit).select('unitId word').lean();
  return open.map(d => ({ unitId: d.unitId, word: d.word }));
}

/** For the teacher's panel: each account's words to learn, per book, and the hardest ones. */
export async function mistakesForUsers(userIds) {
  const ids = userIds.filter(id => mongoose.isValidObjectId(id)).map(id => new mongoose.Types.ObjectId(String(id)));
  if (!ids.length) return new Map();
  const docs = await VocabMistake.find({ user: { $in: ids } }).select('user packKey packTitle word uz misses learntAt').lean();
  const out = new Map();
  for (const d of docs) {
    const key = String(d.user);
    const m = out.get(key) || { open: 0, learnt: 0, books: {}, hardest: [] };
    const b = (m.books[d.packKey] ||= { packKey: d.packKey, title: d.packTitle || d.packKey, open: 0, learnt: 0 });
    if (d.learntAt) { m.learnt += 1; b.learnt += 1; } else { m.open += 1; b.open += 1; m.hardest.push(d); }
    out.set(key, m);
  }
  for (const m of out.values()) {
    m.books = Object.values(m.books).sort((a, b) => b.open - a.open);
    m.hardest = m.hardest.sort((a, b) => b.misses - a.misses).slice(0, 8).map(d => ({ word: d.word, uz: d.uz, misses: d.misses, book: d.packTitle }));
  }
  return out;
}

export default { applyAnswer, recordAnswer, mistakeSummary, mistakeList, setLearnt, reviewWords, mistakesForUsers, LEARN_STREAK, REVIEW_SIZE };
