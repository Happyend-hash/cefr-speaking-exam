import ExcelJS from 'exceljs';
import { LEVELS } from '../models/CourseStudent.js';
import {
  monthOf, dayOf, monthAverage, attendanceSummary, paymentStatus, paymentYear, vocabSummary, joinedMonth, schoolYearOf
} from './ParentPortal.js';
import { speakingSummary } from './CourseSpeaking.js';

/**
 * The course students as an Excel workbook (Jamshid, 2026-11-19): downloaded
 * from the teacher panel whenever he wants the list.
 *
 *   Summary          the month at a glance, one row per group, links to each sheet
 *   All students     every student in one sortable, filterable table
 *   A1 … C1          one sheet per group, with totals
 *   Payments YYYY-YY the school year month by month, coloured by state
 *   Speaking mocks   every mock and part practice from the linked accounts
 *
 * Built from the same calculations as the panel (ParentPortal), so the file
 * and the screen never disagree. Parent codes are left out on purpose: the
 * file gets forwarded, and a code opens a child's page.
 */

const BRAND = 'FF2A2391';
const BRAND_DARK = 'FF161257';
const GOLD = 'FFF5C451';
const INK = 'FF141A3A';
const MUTED = 'FF6B7194';
const LINE = 'FFE3E5F2';
const TINT = 'FFF4F5FD';

const STATUS = {
  paid: { label: 'Paid', fill: 'FFDCFCE7', font: 'FF166534' },
  advance: { label: 'Paid ahead', fill: 'FFDBEAFE', font: 'FF1E40AF' },
  partial: { label: 'Part paid', fill: 'FFFEF3C7', font: 'FF92400E' },
  due: { label: 'Due by the 10th', fill: 'FFFFF7ED', font: 'FF9A3412' },
  overdue: { label: 'Not paid', fill: 'FFFEE2E2', font: 'FF991B1B' },
  upcoming: { label: 'Upcoming', fill: 'FFFFFFFF', font: MUTED },
  nofee: { label: 'No fee set', fill: 'FFF1F2F6', font: MUTED }
};

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return `${MONTHS_EN[m - 1]} ${y}`; };
const pct = v => (typeof v === 'number' ? v / 100 : null);
const date = d => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`) : null);

/** One student, worked out once: what every sheet needs. */
export function studentRow(s, { units = {}, books = {}, now = Date.now() } = {}) {
  const month = monthOf(now);
  const pay = paymentStatus(s, month, now);
  const att = attendanceSummary(s, month);
  const hw = monthAverage(s, month);
  const vocab = vocabSummary(s, units[s.level], s.level, books[s.level]);
  const sp = speakingSummary(s.speaking || [], month);
  const year = paymentYear(s, schoolYearOf(now), now);
  const status = pay.fee === null && !pay.paid ? 'nofee' : pay.status;
  return {
    id: String(s._id),
    name: s.name,
    group: s.level,
    joined: joinedMonth(s),
    fee: pay.fee,
    paid: pay.paid,
    left: pay.left,
    status,
    lastPaid: pay.lastPaidAt ? new Date(pay.lastPaidAt) : null,
    lessons: att.lessons,
    attended: att.attended,
    absent: att.absent,
    attendance: att.percent,
    homework: hw.percent,
    homeworks: hw.homeworks,
    vocabDone: vocab.overall.done,
    vocabUnits: vocab.overall.units,
    vocabAvg: vocab.overall.average,
    mocks: sp.submitted,
    mocksMonth: sp.thisMonth,
    latestScore: sp.latestScore?.score ?? null,
    latestLevel: sp.latestScore?.level || '',
    bestScore: sp.best?.score ?? null,
    account: s.accountEmail || '',
    note: s.teacherNote || '',
    active: s.active !== false,
    year: year.map(m => ({
      month: m.month, fee: m.fee, paid: m.paid, left: m.left, before: m.beforeJoined,
      status: m.beforeJoined ? 'before' : m.fee === null && !m.paid ? 'nofee' : m.status
    })),
    // owed so far: every month up to this one that is not fully paid
    owedToDate: year.filter(m => !m.beforeJoined && m.month <= month && m.left).reduce((a, m) => a + m.left, 0),
    paidYear: year.reduce((a, m) => a + (m.paid || 0), 0),
    attempts: (s.speaking || []).map(e => ({
      title: e.title || (e.mode === 'practice' ? 'Part practice' : 'Speaking mock'),
      mode: e.mode === 'practice' ? 'practice' : 'mock',
      part: e.part || '',
      status: e.status === 'completed' ? 'completed' : 'marking',
      score: typeof e.score === 'number' ? e.score : null,
      level: e.level || '',
      bands: e.bands || {},
      expert: Boolean(e.expert),
      at: e.at || null,
      deleted: Boolean(e.deletedAt)
    }))
  };
}

// --------------------------------------------------------------- styling

const thin = { style: 'thin', color: { argb: LINE } };
const border = { top: thin, left: thin, bottom: thin, right: thin };
const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

function titleBlock(ws, title, sub, width) {
  ws.mergeCells(1, 1, 1, width);
  ws.mergeCells(2, 1, 2, width);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  t.fill = fill(BRAND);
  t.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 34;
  const s = ws.getCell(2, 1);
  s.value = sub;
  s.font = { name: 'Calibri', size: 10.5, color: { argb: 'FFDCDAFF' } };
  s.fill = fill(BRAND_DARK);
  s.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(2).height = 20;
  for (let c = 1; c <= width; c += 1) ws.getCell(3, c).fill = fill(GOLD);
  ws.getRow(3).height = 4;
}

const COLUMNS = [
  { key: 'no', name: 'No', width: 5, total: 'none' },
  { key: 'name', name: 'Name', width: 24, total: 'count', totalLabel: true },
  { key: 'group', name: 'Group', width: 8 },
  { key: 'joined', name: 'Joined', width: 10 },
  { key: 'fee', name: 'Monthly fee', width: 15, fmt: '#,##0', total: 'sum' },
  { key: 'paid', name: 'Paid this month', width: 16, fmt: '#,##0', total: 'sum' },
  { key: 'left', name: 'Left to pay', width: 15, fmt: '#,##0', total: 'sum' },
  { key: 'status', name: 'Payment', width: 15 },
  { key: 'lastPaid', name: 'Last paid', width: 12, fmt: 'dd.mm.yyyy' },
  { key: 'owedToDate', name: 'Owed this year', width: 16, fmt: '#,##0', total: 'sum' },
  { key: 'lessons', name: 'Lessons', width: 9, fmt: '0' },
  { key: 'attended', name: 'Came', width: 8, fmt: '0' },
  { key: 'attendance', name: 'Attendance', width: 12, fmt: '0%', total: 'average', bar: 'FF22C55E' },
  { key: 'homework', name: 'Homework avg', width: 13, fmt: '0%', total: 'average', bar: 'FF6366F1' },
  { key: 'homeworks', name: 'Homeworks', width: 11, fmt: '0', total: 'sum' },
  { key: 'vocab', name: 'Vocab units', width: 11 },
  { key: 'vocabAvg', name: 'Vocab avg', width: 11, fmt: '0%', total: 'average', bar: 'FFF59E0B' },
  { key: 'mocks', name: 'Speaking mocks', width: 10, fmt: '0', total: 'sum' },
  { key: 'mocksMonth', name: 'Mocks this month', width: 10, fmt: '0', total: 'sum' },
  { key: 'latestScore', name: 'Latest score (of 75)', width: 10, fmt: '0', total: 'average' },
  { key: 'latestLevel', name: 'Level', width: 10 },
  { key: 'bestScore', name: 'Best score (of 75)', width: 9, fmt: '0', total: 'max' },
  { key: 'account', name: 'Website account', width: 26 },
  { key: 'note', name: 'Teacher note', width: 34 }
];

const cellValue = (r, key, i) => {
  switch (key) {
    case 'no': return i + 1;
    case 'joined': return monthLabel(r.joined);
    case 'status': return STATUS[r.status]?.label || r.status;
    case 'attendance': return pct(r.attendance);
    case 'homework': return pct(r.homework);
    case 'vocabAvg': return pct(r.vocabAvg);
    case 'vocab': return r.vocabUnits ? `${r.vocabDone}/${r.vocabUnits}` : '';
    case 'latestLevel': return r.latestLevel || '';
    default: return r[key] ?? null;
  }
};

/** A sortable, filterable Excel table of students, with totals and colours. */
function studentTable(ws, rows, { name, startRow, columns }) {
  const cols = columns;
  ws.columns = cols.map(c => ({ key: c.key, width: c.width }));
  const totals = rows.length > 0;
  ws.addTable({
    name,
    ref: `A${startRow}`,
    headerRow: true,
    totalsRow: totals,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: cols.map(c => ({
      name: c.name,
      filterButton: c.key !== 'no',
      ...(totals && c.totalLabel ? { totalsRowLabel: 'Total', totalsRowFunction: 'none' } : {}),
      ...(totals && c.total && c.total !== 'none' && !c.totalLabel ? { totalsRowFunction: c.total } : {})
    })),
    rows: (rows.length ? rows : [null]).map((r, i) => cols.map(c => (r ? cellValue(r, c.key, i) : (c.key === 'name' ? 'No students yet' : null))))
  });

  // header
  const head = ws.getRow(startRow);
  head.height = 36;
  head.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10.5 };
    cell.fill = fill(BRAND);
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });

  // body
  rows.forEach((r, i) => {
    const row = ws.getRow(startRow + 1 + i);
    row.height = 20;
    cols.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      if (c.fmt) cell.numFmt = c.fmt;
      cell.alignment = { vertical: 'middle', horizontal: ['name', 'account', 'note'].includes(c.key) ? 'left' : 'center', wrapText: c.key === 'note' };
      cell.border = border;
      if (c.key === 'name') cell.font = { bold: true, color: { argb: INK } };
      if (c.key === 'status') {
        const st = STATUS[r.status];
        if (st) { cell.fill = fill(st.fill); cell.font = { bold: true, color: { argb: st.font } }; }
      }
      if (c.key === 'left' && r.left > 0) cell.font = { bold: true, color: { argb: 'FF991B1B' } };
      if (c.key === 'owedToDate' && r.owedToDate > 0) cell.font = { bold: true, color: { argb: 'FF991B1B' } };
      if (c.key === 'group') cell.font = { bold: true, color: { argb: BRAND } };
    });
    if (!r.active) row.getCell(cols.findIndex(c => c.key === 'name') + 1).note = 'Paused (not active)';
  });

  // totals row
  if (totals) {
    const tr = ws.getRow(startRow + rows.length + 1);
    tr.height = 22;
    cols.forEach((c, ci) => {
      const cell = tr.getCell(ci + 1);
      if (c.fmt) cell.numFmt = c.fmt;
      cell.font = { bold: true, color: { argb: INK } };
      cell.fill = fill('FFFFF4D6');
      cell.alignment = { vertical: 'middle', horizontal: c.key === 'name' ? 'left' : 'center' };
    });
  }

  // data bars on the percentages
  if (rows.length) {
    cols.forEach((c, ci) => {
      if (!c.bar) return;
      const col = ws.getColumn(ci + 1).letter;
      ws.addConditionalFormatting({
        ref: `${col}${startRow + 1}:${col}${startRow + rows.length}`,
        rules: [{ type: 'dataBar', priority: 1, minLength: 0, maxLength: 100, gradient: true, color: { argb: c.bar }, cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }] }]
      });
    });
  }
  ws.views = [{ state: 'frozen', xSplit: 2, ySplit: startRow, showGridLines: false }];
  return startRow + rows.length + (totals ? 1 : 0);
}

const tableName = s => `T_${s.replace(/[^A-Za-z0-9]/g, '_')}`;

// --------------------------------------------------------------- workbook

export function buildWorkbook(rows, { now = Date.now(), teacher = 'English Hub Family' } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = teacher;
  wb.created = new Date(now);
  const month = monthOf(now);
  const today = dayOf(now);
  const year = schoolYearOf(now);
  const yearName = `Payments ${year}-${String(year + 1).slice(2)}`;
  const sub = `${rows.length} students · ${monthLabel(month)} · money in so'm · downloaded ${today.split('-').reverse().join('.')} (Tashkent)`;
  const groups = LEVELS.filter(l => rows.some(r => r.group === l));
  const sortRows = list => [...list].sort((a, b) => LEVELS.indexOf(a.group) - LEVELS.indexOf(b.group) || a.name.localeCompare(b.name));

  // ---- Summary
  const sum = wb.addWorksheet('Summary', { properties: { tabColor: { argb: GOLD } } });
  sum.columns = [{ width: 3 }, { width: 20 }, { width: 11 }, { width: 17 }, { width: 17 }, { width: 17 }, { width: 13 }, { width: 12 }, { width: 13 }, { width: 13 }, { width: 12 }, { width: 13 }, { width: 14 }];
  titleBlock(sum, 'English Hub Family — Course students', sub, 13);

  const avgOf = list => { const v = list.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const kpis = [
    ['Students', rows.length, '0'],
    ['Groups', groups.length, '0'],
    [`Fees for ${monthLabel(month)}`, rows.reduce((a, r) => a + (r.fee || 0), 0), "#,##0\" so'm\""],
    ['Paid this month', rows.reduce((a, r) => a + (r.paid || 0), 0), "#,##0\" so'm\""],
    ['Left to pay', rows.reduce((a, r) => a + (r.left || 0), 0), "#,##0\" so'm\""],
    ['Not paid (after the 10th)', rows.filter(r => r.status === 'overdue').length, '0'],
    ['Attendance', avgOf(rows.map(r => pct(r.attendance))), '0%'],
    ['Homework average', avgOf(rows.map(r => pct(r.homework))), '0%']
  ];
  // tiles: 4 per row, each 3 columns wide (B–D, E–G, H–J, K–M)
  kpis.forEach(([label, value, fmt], i) => {
    const r0 = 5 + Math.floor(i / 4) * 3;
    const c0 = 2 + (i % 4) * 3;
    sum.mergeCells(r0, c0, r0, c0 + 2);
    sum.mergeCells(r0 + 1, c0, r0 + 1, c0 + 2);
    const l = sum.getCell(r0, c0);
    l.value = label;
    l.font = { size: 10, bold: true, color: { argb: MUTED } };
    l.alignment = { vertical: 'bottom', horizontal: 'left', indent: 1 };
    const v = sum.getCell(r0 + 1, c0);
    v.value = value ?? '—';
    v.numFmt = fmt;
    v.font = { size: 20, bold: true, color: { argb: label === 'Left to pay' || label.startsWith('Not paid') ? 'FF991B1B' : BRAND } };
    v.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    for (let c = c0; c <= c0 + 2; c += 1) {
      sum.getCell(r0, c).fill = fill(TINT);
      sum.getCell(r0 + 1, c).fill = fill(TINT);
      sum.getCell(r0, c).border = { top: { style: 'medium', color: { argb: GOLD } } };
    }
    sum.getRow(r0).height = 22;
    sum.getRow(r0 + 1).height = 34;
  });

  // groups table
  const gStart = 12;
  sum.getCell(gStart - 1, 2).value = 'Groups';
  sum.getCell(gStart - 1, 2).font = { size: 13, bold: true, color: { argb: INK } };
  const gHead = ['Group', 'Students', "Fees (so'm)", "Paid (so'm)", "Left (so'm)", 'Paid in full', 'Not paid', 'Attendance', 'Homework', 'Vocab avg', 'Mocks this month', 'Open sheet'];
  gHead.forEach((h, i) => {
    const c = sum.getCell(gStart, i + 2);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = fill(BRAND);
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = border;
  });
  sum.getRow(gStart).height = 30;
  groups.forEach((g, i) => {
    const list = rows.filter(r => r.group === g);
    const vals = [
      g, list.length,
      list.reduce((a, r) => a + (r.fee || 0), 0),
      list.reduce((a, r) => a + (r.paid || 0), 0),
      list.reduce((a, r) => a + (r.left || 0), 0),
      list.filter(r => r.status === 'paid' || r.status === 'advance').length,
      list.filter(r => r.status === 'overdue').length,
      avgOf(list.map(r => pct(r.attendance))),
      avgOf(list.map(r => pct(r.homework))),
      avgOf(list.map(r => pct(r.vocabAvg))),
      list.reduce((a, r) => a + r.mocksMonth, 0),
      { text: `${g} →`, hyperlink: `#'${g}'!A1` }
    ];
    const fmts = [null, '0', '#,##0', '#,##0', '#,##0', '0', '0', '0%', '0%', '0%', '0', null];
    vals.forEach((v, ci) => {
      const c = sum.getCell(gStart + 1 + i, ci + 2);
      c.value = v ?? '—';
      if (fmts[ci]) c.numFmt = fmts[ci];
      c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.border = border;
      if (i % 2) c.fill = fill(TINT);
      if (ci === 0) c.font = { bold: true, size: 12, color: { argb: BRAND } };
      if (ci === 4 && v > 0) c.font = { bold: true, color: { argb: 'FF991B1B' } };
      if (ci === 6 && v > 0) c.font = { bold: true, color: { argb: 'FF991B1B' } };
      if (ci === 11) c.font = { bold: true, underline: true, color: { argb: 'FF4F46E5' } };
    });
    sum.getRow(gStart + 1 + i).height = 22;
  });

  // where everything is
  const guide = gStart + groups.length + 3;
  const links = [
    ['All students', 'Everyone in one table: sort and filter by any column (the ▼ buttons).'],
    ...groups.map(g => [g, `Group ${g} only, with totals at the bottom.`]),
    [yearName, 'September to August, month by month: green paid, amber part paid, red not paid.'],
    ['Speaking mocks', 'Every mock and part practice handed in from the students’ website accounts.']
  ];
  sum.getCell(guide, 2).value = 'In this file';
  sum.getCell(guide, 2).font = { size: 13, bold: true, color: { argb: INK } };
  links.forEach(([sheet, text], i) => {
    const a = sum.getCell(guide + 1 + i, 2);
    a.value = { text: sheet, hyperlink: `#'${sheet}'!A1` };
    a.font = { bold: true, underline: true, color: { argb: 'FF4F46E5' } };
    sum.mergeCells(guide + 1 + i, 3, guide + 1 + i, 13);
    const t = sum.getCell(guide + 1 + i, 3);
    t.value = text;
    t.font = { color: { argb: MUTED } };
  });
  const legend = guide + links.length + 2;
  sum.getCell(legend, 2).value = 'Payment colours';
  sum.getCell(legend, 2).font = { bold: true, color: { argb: INK } };
  ['paid', 'advance', 'partial', 'due', 'overdue', 'nofee'].forEach((k, i) => {
    const c = sum.getCell(legend, 3 + i * 2);
    sum.mergeCells(legend, 3 + i * 2, legend, 4 + i * 2);
    c.value = STATUS[k].label;
    c.fill = fill(STATUS[k].fill);
    c.font = { bold: true, color: { argb: STATUS[k].font } };
    c.alignment = { horizontal: 'center' };
    c.border = border;
  });
  sum.getCell(legend + 2, 2).value = "Parent codes are not in this file, so it is safe to forward. They are in the teacher panel (👁 Show codes).";
  sum.getCell(legend + 2, 2).font = { italic: true, size: 9.5, color: { argb: MUTED } };
  sum.views = [{ showGridLines: false }];

  // ---- All students
  const all = wb.addWorksheet('All students', { properties: { tabColor: { argb: BRAND } } });
  titleBlock(all, 'All students', sub, COLUMNS.length);
  studentTable(all, sortRows(rows), { name: 'AllStudents', startRow: 5, columns: COLUMNS });

  // ---- one sheet per group
  const groupCols = COLUMNS.filter(c => c.key !== 'group');
  for (const g of groups) {
    const ws = wb.addWorksheet(g, { properties: { tabColor: { argb: 'FF6366F1' } } });
    const list = sortRows(rows.filter(r => r.group === g));
    titleBlock(ws, `Group ${g}`, `${list.length} students · ${monthLabel(month)}`, groupCols.length);
    const back = ws.getCell(4, 1);
    back.value = { text: '← Summary', hyperlink: "#'Summary'!A1" };
    back.font = { size: 9.5, underline: true, color: { argb: 'FF4F46E5' } };
    studentTable(ws, list, { name: tableName(`Group_${g}`), startRow: 5, columns: groupCols });
  }

  // ---- payments, the school year
  const pay = wb.addWorksheet(yearName, { properties: { tabColor: { argb: 'FF22C55E' } } });
  const months = (rows[0]?.year || paymentYearMonths(year)).map(m => m.month);
  const payCols = [{ h: 'Name', w: 24 }, { h: 'Group', w: 8 }, ...months.map(m => ({ h: monthLabel(m), w: 11 })), { h: "Paid this year (so'm)", w: 16 }, { h: "Owed to date (so'm)", w: 16 }];
  titleBlock(pay, `Payments ${year}–${year + 1}`, 'Amount paid each month. Green paid · blue paid ahead · amber part paid / due · red not paid · grey before joining', payCols.length);
  pay.columns = payCols.map(c => ({ width: c.w }));
  const ph = pay.getRow(5);
  payCols.forEach((c, i) => {
    const cell = ph.getCell(i + 1);
    cell.value = c.h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = fill(months.includes(months[i - 2]) && months[i - 2] === month ? 'FF4F46E5' : BRAND);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = border;
  });
  ph.height = 30;
  let pr = 6;
  for (const g of groups) {
    const gh = pay.getRow(pr);
    pay.mergeCells(pr, 1, pr, payCols.length);
    gh.getCell(1).value = `Group ${g}`;
    gh.getCell(1).font = { bold: true, color: { argb: BRAND } };
    gh.getCell(1).fill = fill('FFECEDFF');
    gh.height = 20;
    pr += 1;
    for (const r of sortRows(rows.filter(x => x.group === g))) {
      const row = pay.getRow(pr);
      row.getCell(1).value = r.name;
      row.getCell(1).font = { bold: true, color: { argb: INK } };
      row.getCell(2).value = r.group;
      row.getCell(2).alignment = { horizontal: 'center' };
      r.year.forEach((m, i) => {
        const cell = row.getCell(3 + i);
        const st = m.status === 'before' ? { fill: 'FFF1F2F6', font: 'FFB4B8CC' } : STATUS[m.status] || STATUS.upcoming;
        cell.value = m.status === 'before' ? '—' : m.paid ? m.paid : m.status === 'upcoming' || m.status === 'nofee' ? null : 0;
        cell.numFmt = '#,##0';
        cell.fill = fill(st.fill);
        cell.font = { color: { argb: st.font }, bold: m.status === 'overdue' };
        cell.alignment = { horizontal: 'center' };
        cell.border = border;
        if (m.left && m.status !== 'before' && m.month <= month) cell.note = `Fee ${m.fee.toLocaleString('en-US')} · left ${m.left.toLocaleString('en-US')} so'm`;
      });
      const tot = row.getCell(3 + months.length);
      tot.value = r.paidYear;
      tot.numFmt = '#,##0';
      tot.font = { bold: true };
      const owed = row.getCell(4 + months.length);
      owed.value = r.owedToDate;
      owed.numFmt = '#,##0';
      owed.font = { bold: true, color: { argb: r.owedToDate ? 'FF991B1B' : 'FF166534' } };
      [1, 2, 3 + months.length, 4 + months.length].forEach(c => { row.getCell(c).border = border; });
      row.height = 19;
      pr += 1;
    }
  }
  pay.views = [{ state: 'frozen', xSplit: 2, ySplit: 5, showGridLines: false }];

  // ---- speaking mocks
  const spk = wb.addWorksheet('Speaking mocks', { properties: { tabColor: { argb: 'FFF59E0B' } } });
  const sCols = [
    { name: 'Name', width: 24 }, { name: 'Group', width: 8 }, { name: 'Mock', width: 22 }, { name: 'Type', width: 14 },
    { name: 'Date', width: 12 }, { name: 'Score /75', width: 10 }, { name: 'Level', width: 10 },
    { name: 'Part 1.1 /5', width: 10 }, { name: 'Part 1.2 /5', width: 10 }, { name: 'Part 2 /5', width: 10 }, { name: 'Part 3 /6', width: 10 },
    { name: 'Checked by expert', width: 11 }, { name: 'Deleted on site', width: 11 }
  ];
  const attempts = sortRows(rows).flatMap(r => (r.attempts || []).map(a => ({ r, a })))
    .sort((x, y) => new Date(y.a.at || 0) - new Date(x.a.at || 0));
  titleBlock(spk, 'Speaking mocks', `${attempts.length} attempts from the students’ website accounts`, sCols.length);
  spk.columns = sCols.map(c => ({ width: c.width }));
  spk.addTable({
    name: 'SpeakingMocks',
    ref: 'A5',
    headerRow: true,
    style: { theme: 'TableStyleMedium7', showRowStripes: true },
    columns: sCols.map(c => ({ name: c.name, filterButton: true })),
    rows: (attempts.length ? attempts : [{ r: { name: 'No speaking mocks yet', group: '' }, a: {} }]).map(({ r, a }) => [
      r.name, r.group, a.title || '',
      a.mode === 'practice' ? `Practice${a.part ? ` · Part ${a.part}` : ''}` : a.mode ? 'Full mock' : '',
      a.at ? new Date(a.at) : null,
      a.status === 'marking' ? null : a.score ?? null,
      a.status === 'marking' ? 'Being marked' : a.level || '',
      a.bands?.part11 ?? null, a.bands?.part12 ?? null, a.bands?.part2 ?? null, a.bands?.part3 ?? null,
      a.expert ? 'Yes' : '', a.deleted ? 'Yes' : ''
    ])
  });
  const sh = spk.getRow(5);
  sh.height = 30;
  sh.eachCell(c => { c.fill = fill('FFB45309'); c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; });
  attempts.forEach((_, i) => {
    const row = spk.getRow(6 + i);
    row.getCell(1).font = { bold: true };
    row.getCell(5).numFmt = 'dd.mm.yyyy';
    for (let c = 2; c <= sCols.length; c += 1) row.getCell(c).alignment = { horizontal: c === 3 || c === 4 ? 'left' : 'center' };
  });
  if (attempts.length) {
    spk.addConditionalFormatting({
      ref: `F6:F${5 + attempts.length}`,
      rules: [{ type: 'colorScale', priority: 1, cfvo: [{ type: 'num', value: 30 }, { type: 'num', value: 51 }, { type: 'num', value: 70 }], color: [{ argb: 'FFFCA5A5' }, { argb: 'FFFDE68A' }, { argb: 'FF86EFAC' }] }]
    });
  }
  spk.views = [{ state: 'frozen', xSplit: 1, ySplit: 5, showGridLines: false }];

  // print: landscape, fit to width
  wb.eachSheet(ws => { ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }; });
  wb.views = [{ activeTab: 0 }];
  return wb;
}

function paymentYearMonths(year) {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(year, 8 + i, 1));
    return { month: d.toISOString().slice(0, 7) };
  });
}

export const exportFileName = (now = Date.now()) => `English-Hub-students-${dayOf(now)}.xlsx`;

export default { studentRow, buildWorkbook, exportFileName };
