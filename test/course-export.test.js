/** The course students' Excel file: the right numbers, every sheet, no parent codes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { studentRow, buildWorkbook, exportFileName } from '../services/CourseExport.js';

const NOW = Date.parse('2026-11-19T09:00:00Z');
const student = (over = {}) => ({
  _id: 'a1', name: 'Malika Yusupova', level: 'B1', active: true, parentCode: '482913', monthlyFee: 400000,
  periods: [{ from: '2026-09', to: null, level: 'B1', fee: 400000 }],
  payments: [
    { _id: 'p1', month: '2026-09', amount: 400000, paidAt: new Date('2026-09-05') },
    { _id: 'p2', month: '2026-10', amount: 200000, paidAt: new Date('2026-10-04') },
    { _id: 'p3', month: '2026-11', amount: 999, paidAt: new Date('2026-11-02'), voidedAt: new Date('2026-11-03'), voidReason: 'typo' }
  ],
  attendance: [{ date: '2026-11-03', status: 'present' }, { date: '2026-11-05', status: 'late' }, { date: '2026-11-07', status: 'absent' }, { date: '2026-11-10', status: 'present' }],
  results: [{ _id: 'r1', date: new Date('2026-11-05T10:00:00Z'), level: 'B1', skills: { vocabulary: 80, grammar: 60, listening: null, reading: null, speaking: null, writing: null } }],
  vocab: [{ _id: 'v1', level: 'B1', unit: 1, percent: 90, date: '2026-11-01', source: 'unit', createdAt: new Date() }],
  vocabTests: [],
  speaking: [
    { result: 's1', title: 'Speaking Mock 2', mode: 'mock', status: 'completed', score: 46, level: 'B1', bands: { part11: 4, part12: 3, part2: 3, part3: 3 }, at: new Date('2026-11-02T12:00:00Z') },
    { result: 's2', title: 'Speaking Mock 3', mode: 'mock', status: 'completed', score: 57, level: 'B2', at: new Date('2026-11-12T12:00:00Z') }
  ],
  accountEmail: 'malika@gmail.com', teacherNote: 'Strong in Part 3', createdAt: new Date('2026-09-02'),
  ...over
});

test('a student row matches the panel: this month unpaid after the 10th, owed this year, attendance, mocks', () => {
  const r = studentRow(student(), { now: NOW });
  assert.equal(r.status, 'overdue', 'nothing for November (the voided payment does not count)');
  assert.equal(r.paid, 0);
  assert.equal(r.left, 400000);
  assert.equal(r.owedToDate, 600000, '200,000 left from October + 400,000 for November');
  assert.equal(r.paidYear, 600000);
  assert.deepEqual([r.lessons, r.attended, r.attendance], [4, 3, 75]);
  assert.equal(r.homework, 70);
  assert.deepEqual([r.mocks, r.latestScore, r.bestScore], [2, 57, 57]);
  assert.equal(r.year.length, 12);
  assert.equal(r.year[0].status, 'paid');
  assert.equal(r.year[1].status, 'partial', 'October part paid');
});

test('the workbook has every sheet, real tables with totals, and never the parent code', async () => {
  const rows = [studentRow(student(), { now: NOW }), studentRow(student({ _id: 'a2', name: 'Bekzod Tursunov', level: 'A2', periods: [{ from: '2026-09', to: null, level: 'A2', fee: 350000 }], payments: [], speaking: [] }), { now: NOW })];
  const wb = buildWorkbook(rows, { now: NOW });
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf);
  assert.deepEqual(back.worksheets.map(w => w.name), ['Summary', 'All students', 'A2', 'B1', 'Payments 2026-27', 'Speaking mocks']);
  const all = back.getWorksheet('All students');
  assert.ok(all.getTable('AllStudents'), 'a sortable, filterable table');
  const text = JSON.stringify(back.worksheets.map(w => w.getSheetValues()));
  assert.ok(!text.includes('482913'), 'parent codes stay out of the file');
  assert.ok(text.includes('Malika Yusupova') && text.includes('Bekzod Tursunov'));
  assert.equal(exportFileName(NOW), 'English-Hub-students-2026-11-19.xlsx');
});

test('an empty course still makes a valid file', async () => {
  const buf = await buildWorkbook([], { now: NOW }).xlsx.writeBuffer();
  assert.ok(buf.byteLength > 1000);
});
