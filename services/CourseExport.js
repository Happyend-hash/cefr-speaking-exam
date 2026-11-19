import ExcelJS from 'exceljs';
import { LEVELS } from '../models/CourseStudent.js';
import { monthOf, dayOf, paymentYear, schoolYearOf } from './ParentPortal.js';

/**
 * The course students as an Excel file (Jamshid, 2026-11-19; made simple
 * 2026-11-22 at his request): one sheet with everyone, and one sheet per
 * group. Each sheet has only the number, the name and the monthly payments
 * from September to this month — the amount paid, or "Not paid".
 *
 * Built from the same payment calculation as the panel (ParentPortal), so the
 * file and the screen never disagree. Parent codes are not in it.
 */

const BRAND = 'FF2A2391';
const INK = 'FF141A3A';
const LINE = 'FFE3E5F2';

const LOOK = {
  paid: { fill: 'FFDCFCE7', font: 'FF166534' },        // paid in full
  advance: { fill: 'FFDCFCE7', font: 'FF166534' },
  partial: { fill: 'FFFEF3C7', font: 'FF92400E' },     // part paid
  due: { fill: 'FFFEE2E2', font: 'FF991B1B' },         // nothing yet
  overdue: { fill: 'FFFEE2E2', font: 'FF991B1B' },
  upcoming: { fill: 'FFFEE2E2', font: 'FF991B1B' },
  before: { fill: 'FFF1F2F6', font: 'FFB4B8CC' },       // not in the course yet
  future: { fill: 'FFFFFFFF', font: 'FFB4B8CC' }        // a month still to come, nothing paid ahead
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = ym => MONTHS[Number(ym.slice(5, 7)) - 1];

const thin = { style: 'thin', color: { argb: LINE } };
const border = { top: thin, left: thin, bottom: thin, right: thin };
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

/** One student: name, group and each month of the school year's payment. */
export function studentRow(s, { now = Date.now() } = {}) {
  return {
    name: s.name,
    group: s.level,
    months: paymentYear(s, schoolYearOf(now), now).map(m => ({
      month: m.month,
      paid: m.paid || 0,
      fee: m.fee,
      status: m.beforeJoined ? 'before'
        : m.paid > 0 && m.fee !== null && m.paid < m.fee ? 'partial'
          : m.paid > 0 ? 'paid'
            : m.month > monthOf(now) ? 'future' : 'overdue'
    }))
  };
}

/** September up to this month, and on to any later month someone has already paid. */
function monthsToShow(rows, now) {
  const current = monthOf(now);
  const all = rows[0]?.months.map(m => m.month) || [];
  const last = rows.flatMap(r => r.months).filter(m => m.paid > 0).reduce((a, m) => (m.month > a ? m.month : a), current);
  return all.filter(m => m <= last);
}

function sheet(wb, title, rows, months, withGroup, now) {
  const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', xSplit: withGroup ? 3 : 2, ySplit: 3, showGridLines: false }] });
  const cols = [{ h: 'No', w: 5 }, { h: 'Name', w: 28 }, ...(withGroup ? [{ h: 'Group', w: 8 }] : []), ...months.map(m => ({ h: monthName(m), w: 14 }))];
  ws.columns = cols.map(c => ({ width: c.w }));

  ws.mergeCells(1, 1, 1, cols.length);
  const t = ws.getCell(1, 1);
  t.value = `${title === 'All students' ? 'All students' : `Group ${title}`} — payments (so'm) · ${dayOf(now).split('-').reverse().join('.')}`;
  t.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  t.fill = fill(BRAND);
  t.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 28;

  const head = ws.getRow(3);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.h;
    cell.font = { bold: true, color: { argb: INK } };
    cell.fill = fill('FFECEDFF');
    cell.alignment = { horizontal: i === 1 ? 'left' : 'center', vertical: 'middle' };
    cell.border = border;
  });
  head.height = 22;

  rows.forEach((r, i) => {
    const row = ws.getRow(4 + i);
    row.getCell(1).value = i + 1;
    row.getCell(2).value = r.name;
    row.getCell(2).font = { bold: true, color: { argb: INK } };
    if (withGroup) row.getCell(3).value = r.group;
    const first = withGroup ? 4 : 3;
    months.forEach((ym, mi) => {
      const m = r.months.find(x => x.month === ym);
      const cell = row.getCell(first + mi);
      const look = LOOK[m.status];
      if (m.status === 'before') cell.value = '—';
      else if (m.status === 'future') cell.value = null;
      else if (m.paid > 0) cell.value = m.paid;
      else cell.value = 'Not paid';
      cell.numFmt = '#,##0';
      cell.fill = fill(look.fill);
      cell.font = { bold: m.status !== 'before', color: { argb: look.font } };
      if (m.status === 'partial') cell.note = `Part paid: fee ${m.fee.toLocaleString('en-US')} so'm`;
    });
    for (let c = 1; c <= cols.length; c += 1) {
      const cell = row.getCell(c);
      cell.border = border;
      if (c !== 2) cell.alignment = { horizontal: 'center', vertical: 'middle' };
      else cell.alignment = { vertical: 'middle' };
    }
    row.height = 20;
  });
  if (!rows.length) ws.getCell(4, 2).value = 'No students';
  ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  return ws;
}

export function buildWorkbook(rows, { now = Date.now() } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'English Hub Family';
  wb.created = new Date(now);
  const months = monthsToShow(rows, now);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const sorted = [...rows].sort((a, b) => LEVELS.indexOf(a.group) - LEVELS.indexOf(b.group) || byName(a, b));
  sheet(wb, 'All students', sorted, months, true, now);
  for (const g of LEVELS.filter(l => rows.some(r => r.group === l))) {
    sheet(wb, g, rows.filter(r => r.group === g).sort(byName), months, false, now);
  }
  return wb;
}

export const exportFileName = (now = Date.now()) => `English-Hub-students-${dayOf(now)}.xlsx`;

export default { studentRow, buildWorkbook, exportFileName };
