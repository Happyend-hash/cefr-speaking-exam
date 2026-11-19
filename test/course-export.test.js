/** The course students' Excel file: everyone, a sheet per group, and each month's payment. */
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { studentRow, buildWorkbook, exportFileName } from '../services/CourseExport.js';

const NOW = Date.parse('2026-11-19T09:00:00Z');
const student = (over = {}) => ({
  _id: 'a1', name: 'Malika Yusupova', level: 'B1', parentCode: '482913', monthlyFee: 400000,
  periods: [{ from: '2026-09', to: null, level: 'B1', fee: 400000 }],
  payments: [
    { _id: 'p1', month: '2026-09', amount: 400000, paidAt: new Date('2026-09-05') },
    { _id: 'p2', month: '2026-10', amount: 200000, paidAt: new Date('2026-10-04') },
    { _id: 'p3', month: '2026-11', amount: 999, paidAt: new Date('2026-11-02'), voidedAt: new Date('2026-11-03'), voidReason: 'typo' }
  ],
  createdAt: new Date('2026-09-02'),
  ...over
});

test('each month: paid, part paid or not paid, and nothing before the student joined', () => {
  const r = studentRow(student(), { now: NOW });
  const m = Object.fromEntries(r.months.map(x => [x.month, x]));
  assert.deepEqual([m['2026-09'].status, m['2026-09'].paid], ['paid', 400000]);
  assert.deepEqual([m['2026-10'].status, m['2026-10'].paid], ['partial', 200000]);
  assert.deepEqual([m['2026-11'].status, m['2026-11'].paid], ['overdue', 0], 'the voided payment does not count');
  assert.equal(m['2026-12'].status, 'future');
  const late = studentRow(student({ periods: [{ from: '2026-10', to: null, level: 'B1', fee: 400000 }], payments: [] }), { now: NOW });
  assert.equal(late.months[0].status, 'before', 'joined in October');
});

test('one sheet with everyone, one per group; September to November only; no parent codes', async () => {
  const rows = [
    studentRow(student(), { now: NOW }),
    studentRow(student({ _id: 'a2', name: 'Bekzod Tursunov', level: 'A2', periods: [{ from: '2026-09', to: null, level: 'A2', fee: 350000 }], payments: [] }), { now: NOW })
  ];
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(await buildWorkbook(rows, { now: NOW }).xlsx.writeBuffer());
  assert.deepEqual(back.worksheets.map(w => w.name), ['All students', 'A2', 'B1']);
  const all = back.getWorksheet('All students');
  assert.deepEqual(all.getRow(3).values.slice(1), ['No', 'Name', 'Group', 'September', 'October', 'November']);
  assert.deepEqual(all.getRow(4).values.slice(1), [1, 'Bekzod Tursunov', 'A2', 'Not paid', 'Not paid', 'Not paid']);
  assert.deepEqual(all.getRow(5).values.slice(1), [2, 'Malika Yusupova', 'B1', 400000, 200000, 'Not paid']);
  assert.deepEqual(back.getWorksheet('B1').getRow(3).values.slice(1), ['No', 'Name', 'September', 'October', 'November']);
  assert.ok(!JSON.stringify(back.worksheets.map(w => w.getSheetValues())).includes('482913'));
  assert.equal(exportFileName(NOW), 'English-Hub-students-2026-11-19.xlsx');
});

test('a month paid ahead appears, and only the student who paid it has an amount there', async () => {
  const ahead = student({ payments: [{ _id: 'p9', month: '2026-12', amount: 400000, paidAt: new Date('2026-11-10') }] });
  const other = student({ _id: 'a3', name: 'Zara', payments: [] });
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(await buildWorkbook([studentRow(ahead, { now: NOW }), studentRow(other, { now: NOW })], { now: NOW }).xlsx.writeBuffer());
  const ws = back.getWorksheet('B1');
  assert.equal(ws.getRow(3).values.slice(-1)[0], 'December');
  assert.equal(ws.getRow(4).values.slice(-1)[0], 400000);
  assert.equal(ws.getRow(5).getCell(6).value, null, 'December not due yet for the others');
});
