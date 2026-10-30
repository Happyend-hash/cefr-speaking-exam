import mongoose from 'mongoose';

/**
 * Saving vocabulary unit results on a course student — one place for both
 * the teacher typing a result in the admin panel and the student taking the
 * test on the website ("Uyga vazifani topshirish").
 *
 * The rules (Jamshid, 2026-10-21): every result is kept; the same unit on the
 * same day again replaces that day's result; a general test gives every unit
 * it covers a new current result, the earlier ones stay as history; a second
 * general test on the same day replaces the first.
 */

/**
 * Several books per level (2026-10-24): `book` is the pack key of the book
 * the unit belongs to (null for a level without a book); `firstBook` is the
 * level's first book, which results saved before books were recorded belong to.
 */
const sameBook = (r, book, firstBook) => (r.book || firstBook || null) === (book || null);

/** One unit's result. `via`: 'teacher' | 'online'. */
export function recordUnitResult(student, { unit, percent, date, via = 'teacher', book = null, firstBook = null, words = null }) {
  const level = student.level;
  student.vocab = (student.vocab || []).filter(r => !(r.level === level && r.unit === unit && r.date === date && r.source === 'unit' && sameBook(r, book, firstBook)));
  student.vocab.push({ level, ...(book ? { book } : {}), unit, percent, date, source: 'unit', via, ...wordsOf(words) });
  return student;
}

/** The words an online test asked: { total, missed } kept on the result (see raiseForLearntWord). */
const wordsOf = w => (w && Number.isInteger(w.total) && w.total > 0
  ? { total: w.total, missed: [...new Set(w.missed || [])], recovered: [] }
  : {});

/**
 * A general test. `perUnit`: { unitNumber: percent } for the units it
 * covered; `percent`: the overall result (worked out from perUnit if not given).
 * With no perUnit, every unit 1..units gets the overall percent.
 */
export function recordGeneralTest(student, { date, perUnit = {}, percent = null, units = 0, via = 'teacher', book = null, firstBook = null, wordsByUnit = {} }) {
  const level = student.level;
  const given = Object.entries(perUnit).filter(([, v]) => Number.isFinite(v));
  const overall = percent !== null && percent !== undefined
    ? percent
    : Math.round(given.reduce((a, [, v]) => a + v, 0) / Math.max(1, given.length));

  const old = (student.vocabTests || []).filter(t => t.level === level && t.date === date && sameBook(t, book, firstBook)).map(t => String(t._id));
  student.vocabTests = (student.vocabTests || []).filter(t => !old.includes(String(t._id)));
  student.vocab = (student.vocab || []).filter(r => !(r.test && old.includes(String(r.test))));

  const testId = new mongoose.Types.ObjectId();
  const b = book ? { book } : {};
  const all = Object.values(wordsByUnit || {});
  const testWords = all.length ? { total: all.reduce((a, w) => a + (w.total || 0), 0), missed: all.flatMap(w => w.missed || []) } : null;
  student.vocabTests.push({ _id: testId, level, ...b, date, percent: overall, perUnit: given.length > 0, via, ...wordsOf(testWords) });
  if (given.length) {
    for (const [k, p] of given) student.vocab.push({ level, ...b, unit: Number(k), percent: p, date, source: 'general', test: testId, via, ...wordsOf(wordsByUnit?.[k]) });
  } else {
    for (let unit = 1; unit <= units; unit += 1) student.vocab.push({ level, ...b, unit, percent: overall, date, source: 'general', test: testId, via });
  }
  return { student, percent: overall, testId };
}

/**
 * "Xatolarim" (Jamshid, 2026-10-30): a word the student got wrong in an online
 * test and has now learnt (right twice in a row in the revision test) counts
 * as right in every result it was missed in — so a 78% unit result climbs as
 * the missed words are learnt, up to 100%. Returns how many results rose.
 */
export function raiseForLearntWord(student, { book, word }) {
  let raised = 0;
  const raise = r => {
    if (!Number.isInteger(r.total) || r.total <= 0 || !Array.isArray(r.missed) || !r.missed.includes(word)) return;
    if ((r.book || null) !== (book || null)) return;
    const recovered = [...(r.recovered || [])];
    if (recovered.includes(word)) return;
    recovered.push(word);
    r.recovered = recovered;
    const right = r.total - r.missed.length + recovered.length;
    const next = Math.min(100, Math.round((right / r.total) * 100));
    if (next > r.percent) r.percent = next;
    raised += 1;
  };
  (student.vocab || []).forEach(raise);
  (student.vocabTests || []).forEach(raise);
  return raised;
}

export default { recordUnitResult, recordGeneralTest, raiseForLearntWord };
