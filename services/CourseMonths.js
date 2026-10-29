import {
  monthOf, periodAt, feeFor, joinedMonth, paymentStatus, attendanceSummary, monthAverage
} from './ParentPortal.js';

/**
 * The course by month (Jamshid, 2026-10-27).
 *
 * Students come and go every month, and a student removed from a group used to
 * vanish from view with all their months. Now each student has membership
 * periods — from a month, to a month, in one group at one fee — and the
 * monthly register reads any month back as it was: who was in each group,
 * what they owed and paid, and how often they came. Removed students move to
 * the archive with everything kept, and can be brought back.
 *
 * Rules:
 *  - Joining starts a period from that month.
 *  - Moving group or changing the fee in month M starts a new period from M;
 *    the old one ends the month before. (A change in the month the period
 *    began just edits it.) A fee set for the first time applies to the whole
 *    current period, since there was no earlier fee to keep.
 *  - Leaving in month M ends the last period at M: they count in M, not after.
 *  - Coming back in month M opens a new period from M (or reopens the last one
 *    if they left this month or last month).
 */

export const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const cleanFee = v => (typeof v === 'number' && v > 0 ? v : null);

/** The month a student first appears: when they were added, or an earlier lesson. */
function firstMonth(student) {
  const months = [monthOf(student.createdAt || Date.now())];
  for (const a of student.attendance || []) if (a?.date) months.push(a.date.slice(0, 7));
  return months.sort()[0];
}

/**
 * Students saved before periods existed get one period from when they joined
 * to when they were removed (or still open). Returns true when it changed.
 */
export function ensurePeriods(student) {
  if ((student.periods || []).length) return false;
  student.periods = [{
    from: firstMonth(student),
    to: student.removedAt ? monthOf(student.removedAt) : null,
    level: student.level,
    fee: cleanFee(student.monthlyFee)
  }];
  return true;
}

/** The period still going on (null for a removed student). */
export const openPeriod = student => [...(student.periods || [])].reverse().find(p => !p.to) || null;

/**
 * A new group and/or fee from `month` on. Also keeps `level` and `monthlyFee`
 * on the student in step, since the rest of the site reads those.
 */
export function changeTerms(student, { level, fee } = {}, month = monthOf()) {
  ensurePeriods(student);
  const next = {
    level: level !== undefined ? level : student.level,
    fee: fee !== undefined ? cleanFee(fee) : cleanFee(student.monthlyFee)
  };
  if (level !== undefined) student.level = level;
  if (fee !== undefined) student.monthlyFee = fee;

  const cur = openPeriod(student);
  if (!cur) return student;                       // removed: their past stays as it was
  const sameLevel = cur.level === next.level;
  const sameFee = (cur.fee ?? null) === (next.fee ?? null);
  if (sameLevel && sameFee) return student;
  if (cur.from >= month) {                        // began this month: just correct it
    cur.level = next.level; cur.fee = next.fee;
    return student;
  }
  if (sameLevel && (cur.fee ?? null) === null) {  // a first fee covers the whole period
    cur.fee = next.fee;
    return student;
  }
  cur.to = addMonths(month, -1);
  student.periods.push({ from: month, to: null, level: next.level, fee: next.fee });
  return student;
}

/** Leaving: the last period ends this month; the student moves to the archive. */
export function leave(student, { reason = '', month = monthOf(), now = new Date() } = {}) {
  ensurePeriods(student);
  const cur = openPeriod(student);
  if (cur) cur.to = cur.from > month ? cur.from : month;
  student.removedAt = now;
  student.active = false;
  student.leftReason = String(reason || '').trim().slice(0, 120);
  return student;
}

/** Coming back: a new period from this month (or the last one reopened if they only just left). */
export function restore(student, { month = monthOf() } = {}) {
  ensurePeriods(student);
  student.removedAt = null;
  student.active = true;
  student.leftReason = '';
  const last = (student.periods || [])[student.periods.length - 1];
  if (last && last.to && last.to >= addMonths(month, -1)) {
    last.to = null;
  } else if (!openPeriod(student)) {
    student.periods.push({ from: month, to: null, level: student.level, fee: cleanFee(student.monthlyFee) });
  }
  return student;
}

/**
 * Upgrade / downgrade (Jamshid, 2026-10-29): move a student to another group
 * (level) from this month or from next month.
 *
 *  - From this month: the same as changing the group — a new period starts now.
 *  - From next month: this month stays in the current group; the new period
 *    starts on the 1st and `level` switches by itself then (see syncLevel).
 *  - A move planned for next month replaces any earlier plan; moving back to
 *    the current group cancels it.
 * Everything else — payments, attendance, homework and vocabulary results —
 * stays on the student's card.
 */
export function plannedMove(student, now = Date.now()) {
  const thisMonth = monthOf(now);
  const future = (student.periods || []).find(p => p.from > thisMonth);
  return future ? { level: future.level, from: future.from } : null;
}

export function cancelPlannedMove(student, now = Date.now()) {
  const thisMonth = monthOf(now);
  const periods = student.periods || [];
  const keep = periods.filter(p => p.from <= thisMonth);
  if (keep.length === periods.length) return false;
  student.periods = keep;
  const last = student.periods[student.periods.length - 1];
  if (last && !student.removedAt) last.to = null;
  return true;
}

export function moveStudent(student, { level, month }, now = Date.now()) {
  const thisMonth = monthOf(now);
  const nextMonth = addMonths(thisMonth, 1);
  if (month !== thisMonth && month !== nextMonth) throw Object.assign(new Error('Choose this month or next month'), { statusCode: 400 });
  if (student.removedAt) throw Object.assign(new Error('Bring the student back from the archive first'), { statusCode: 400 });
  ensurePeriods(student);
  cancelPlannedMove(student, now);
  if (month === thisMonth) return changeTerms(student, { level }, thisMonth);
  const cur = openPeriod(student);
  if (!cur || cur.level === level) return student;      // same group: nothing planned
  cur.to = thisMonth;
  student.periods.push({ from: nextMonth, to: null, level, fee: cur.fee ?? null });
  return student;                                         // student.level stays until the 1st
}

/** On (or after) the 1st: a planned move takes effect. Returns true when `level` changed. */
export function syncLevel(student, now = Date.now()) {
  if (student.removedAt) return false;
  const p = periodAt(student, monthOf(now));
  if (!p || p.level === student.level) return false;
  student.level = p.level;
  if (typeof p.fee === 'number') student.monthlyFee = p.fee;
  return true;
}

/**
 * One student in one month, as the register shows them. Null when they were
 * not in the course that month.
 */
export function monthRow(student, month, now = Date.now()) {
  const p = periodAt(student, month);
  if (!p) return null;
  const periods = student.periods || [];
  const i = periods.indexOf(p);
  const before = i > 0 ? periods[i - 1] : null;
  const after = i < periods.length - 1 ? periods[i + 1] : null;
  const pay = paymentStatus(student, month, now);
  const att = attendanceSummary(student, month);
  const hw = monthAverage(student, month);
  const back = before && before.to && addMonths(before.to, 1) < p.from;   // returned after a gap
  return {
    id: String(student._id),
    name: student.name,
    level: p.level,
    fee: feeFor(student, month),
    paid: pay.paid,
    left: pay.left,
    status: pay.status,
    payments: pay.payments.length,
    lessons: att.lessons,
    present: att.present,
    late: att.late,
    absent: att.absent,
    attendance: att.percent,
    homework: hw.percent,
    homeworks: hw.homeworks,
    // what happened this month
    joined: p.from === month && (!before || back),
    returned: p.from === month && Boolean(back),
    movedFrom: p.from === month && before && !back && before.level !== p.level ? before.level : null,
    feeChanged: p.from === month && before && !back && before.level === p.level,
    movedTo: p.to === month && after && addMonths(month, 1) === after.from && after.level !== p.level ? after.level : null,
    leftNow: p.to === month && !after && Boolean(student.removedAt),
    leftReason: p.to === month && !after ? student.leftReason || '' : '',
    removed: Boolean(student.removedAt),
    paused: !student.removedAt && student.active === false
  };
}

const sum = (rows, key) => rows.reduce((a, r) => a + (r[key] || 0), 0);

/** Totals for a list of register rows. */
function totals(rows, month, now) {
  const lessons = sum(rows, 'lessons');
  const came = sum(rows, 'present') + sum(rows, 'late');
  const future = month > monthOf(now);
  return {
    students: rows.length,
    joined: rows.filter(r => r.joined).length,
    left: rows.filter(r => r.leftNow).length,
    fees: rows.reduce((a, r) => a + (r.fee || 0), 0),
    paid: sum(rows, 'paid'),
    owed: future ? 0 : rows.reduce((a, r) => a + (r.left || 0), 0),
    unpaid: future ? 0 : rows.filter(r => r.status === 'overdue' || r.status === 'partial' || r.status === 'due').length,
    attendance: lessons ? Math.round((came / lessons) * 100) : null
  };
}

/**
 * The register for one month: every group as it was, with each student's fee,
 * payment and attendance, and totals per group and overall.
 */
export function monthRegister(students, month, { levels = [], now = Date.now() } = {}) {
  const rows = students.map(s => monthRow(s, month, now)).filter(Boolean);
  const order = l => (levels.indexOf(l) === -1 ? 99 : levels.indexOf(l));
  const groups = [...new Set(rows.map(r => r.level))]
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map(level => {
      const list = rows.filter(r => r.level === level).sort((a, b) => a.name.localeCompare(b.name));
      return { level, rows: list, totals: totals(list, month, now) };
    });
  return { month, groups, totals: totals(rows, month, now), months: registerMonths(students, now) };
}

/** The months the picker offers: from the first student's first month up to this month. */
export function registerMonths(students, now = Date.now()) {
  const thisMonth = monthOf(now);
  const first = students.map(s => (s.periods?.[0]?.from) || joinedMonth(s)).sort()[0] || thisMonth;
  const out = [];
  for (let m = first < thisMonth ? first : thisMonth; m <= thisMonth && out.length < 120; m = addMonths(m, 1)) out.push(m);
  return out.reverse();
}

/** An archived student's months, newest first: group, fee, payment and attendance of each. */
export function monthsOf(student, now = Date.now()) {
  const out = [];
  for (const p of student.periods || []) {
    const end = p.to || monthOf(now);
    for (let m = p.from; m <= end && out.length < 120; m = addMonths(m, 1)) {
      const r = monthRow(student, m, now);
      if (r) out.push({ month: m, ...r });
    }
  }
  return out.sort((a, b) => b.month.localeCompare(a.month));
}

export default { ensurePeriods, openPeriod, changeTerms, leave, restore, monthRow, monthRegister, registerMonths, monthsOf, addMonths, moveStudent, plannedMove, cancelPlannedMove, syncLevel };
