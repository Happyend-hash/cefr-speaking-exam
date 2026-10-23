import CourseStudent from '../models/CourseStudent.js';
import User from '../models/User.js';
import { booksPerLevel, vocabSummary, dayOf } from './ParentPortal.js';
import { recordUnitResult, recordGeneralTest } from './CourseVocab.js';

/**
 * "Uyga vazifani topshirish" (Jamshid, 2026-10-23): a website account the
 * teacher has linked to a course student (by its Gmail, in the admin panel)
 * takes the vocabulary test of a unit of its level's book — or the general
 * test of all units — and the result goes straight into that course
 * student's vocabulary units, as if the teacher had typed it in. Accounts
 * that are not linked never see the option.
 */

/** Words per unit in the online general test (all units at once would be too long for big books). */
export const GENERAL_WORDS_PER_UNIT = 10;

/** The course student linked to a website account, or null. */
export async function linkedCourseStudent(userId) {
  const user = await User.findById(userId).select('email').lean();
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return null;
  return CourseStudent.findOne({ accountEmail: email, removedAt: null, active: true });
}

/**
 * What the student's "Uyga vazifa" screen shows: every book of their level
 * (several since 2026-10-24), each with its units and current results and
 * its own general test.
 */
export async function homeworkView(student) {
  const list = (await booksPerLevel())[student.level] || [];
  const base = { name: student.name, level: student.level };
  if (!list.length) return { ...base, books: [], book: null, units: [], general: null, average: null };
  const summary = vocabSummary(student, 0, student.level, list);
  const books = list.map((book, i) => {
    const t = summary.tracks[i];
    return {
      key: book.key,
      title: book.title,
      units: book.units.map(u => {
        const cur = t.list[u.n - 1] || {};
        return { n: u.n, title: u.title, words: u.words, percent: cur.percent ?? null, date: cur.date || null, source: cur.source || null };
      }),
      general: t.latestTest,
      generalWords: book.units.reduce((a, u) => a + Math.min(u.words, GENERAL_WORDS_PER_UNIT), 0),
      average: t.average
    };
  });
  // `book`, `units`, `general`, `generalWords` repeat the first book for screens made before several books.
  return { ...base, books, book: { key: books[0].key, title: books[0].title }, units: books[0].units, general: books[0].general, generalWords: books[0].generalWords, average: summary.overall.average };
}

/**
 * The test a student is about to take: the pack, the unit ids and the
 * homework tag the quiz engine carries to the end. `unit`: a unit number or
 * 'general'; `bookKey`: which of the level's books (the first when not given).
 */
export async function homeworkPlan(student, unit, bookKey = null) {
  const list = (await booksPerLevel())[student.level] || [];
  if (!list.length) throw new Error('Ustozingiz hali bu daraja uchun kitob tanlamagan');
  const book = bookKey ? list.find(b => b.key === bookKey) : list[0];
  if (!book) throw new Error('Bu kitob sizning darajangizda yo‘q');
  const base = { courseStudentId: String(student._id), level: student.level, bookKey: book.key, firstBook: list[0].key, bookTitle: book.title };
  if (unit === 'general') {
    return {
      packKey: book.key, unitIds: book.units.map(u => u.id), perUnit: GENERAL_WORDS_PER_UNIT,
      homework: { ...base, kind: 'general', label: `${book.title} — umumiy test`, unitNumbers: Object.fromEntries(book.units.map(u => [u.id, u.n])) }
    };
  }
  const u = book.units.find(x => x.n === Number(unit));
  if (!u) throw new Error('Bu unit topilmadi');
  return {
    packKey: book.key, unitIds: [u.id], perUnit: 0,
    homework: { ...base, kind: 'unit', unit: u.n, label: `${book.title} — ${u.title}`, unitNumbers: { [u.id]: u.n } }
  };
}

/** Save a finished homework test on the course student (called by the quiz engine). */
export async function saveHomeworkResult(homework) {
  const student = await CourseStudent.findById(homework.courseStudentId);
  if (!student || student.removedAt) throw new Error('O‘quvchi topilmadi');
  // The level may have changed while the test was running: results belong to the level it was taken for.
  if (student.level !== homework.level) throw new Error('Darajangiz o‘zgargan — testni qaytadan boshlang');
  const date = dayOf();
  const where = { book: homework.bookKey || null, firstBook: homework.firstBook || homework.bookKey || null };
  if (homework.kind === 'unit') {
    recordUnitResult(student, { unit: homework.unit, percent: homework.percent, date, via: 'online', ...where });
  } else {
    const perUnit = {};
    for (const [unitId, p] of Object.entries(homework.perUnit || {})) {
      const n = homework.unitNumbers?.[unitId];
      if (n) perUnit[n] = p;
    }
    recordGeneralTest(student, { date, perUnit, percent: homework.percent, via: 'online', ...where });
  }
  await student.save();
  return true;
}

export default { linkedCourseStudent, homeworkView, homeworkPlan, saveHomeworkResult };
