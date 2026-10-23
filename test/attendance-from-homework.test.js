/** A child with homework that day came; the rest of the group did not; the roll call still decides. */
import test from 'node:test';
import assert from 'node:assert/strict';
import CourseStudent from '../models/CourseStudent.js';
import { attendanceFromHomework } from '../routes/courseStudents.js';

function kid(name, { results = [], attendance = [], createdAt = new Date('2026-09-01') } = {}) {
  const s = new CourseStudent({ name, level: 'B1', parentCode: String(100000 + Math.floor(Math.random() * 899999)), results, attendance });
  s.createdAt = createdAt;
  s.save = async function () { await this.validate(); return this; };
  return s;
}
const mark = (s, d) => s.attendance.find(a => a.date === d);
const hw = date => ({ date: new Date(`${date}T10:00:00+05:00`), level: 'B1', skills: { vocabulary: 80 } });

test('homework marks its child as came and the rest of the group as missed; a roll call is kept', async () => {
  const ali = kid('Ali', { results: [hw('2026-10-24')] });
  const vali = kid('Vali');
  const late = kid('Late', { results: [hw('2026-10-24')], attendance: [{ date: '2026-10-24', status: 'late' }] });
  const wasAbsent = kid('Absent', { results: [hw('2026-10-24')], attendance: [{ date: '2026-10-24', status: 'absent' }] });
  const newcomer = kid('New', { createdAt: new Date('2026-10-25') });
  const manual = kid('Manual', { attendance: [{ date: '2026-10-24', status: 'present' }] });
  const group = [ali, vali, late, wasAbsent, newcomer, manual];
  const orig = CourseStudent.find;
  CourseStudent.find = async () => group;
  try {
    await attendanceFromHomework('2026-10-24', 'B1');
    assert.deepEqual([mark(ali, '2026-10-24').status, mark(ali, '2026-10-24').auto], ['present', true]);
    assert.deepEqual([mark(vali, '2026-10-24').status, mark(vali, '2026-10-24').auto], ['absent', true]);
    assert.equal(mark(late, '2026-10-24').status, 'late', 'late stays late');
    assert.equal(mark(wasAbsent, '2026-10-24').status, 'present', 'homework turns missed into came');
    assert.equal(mark(newcomer, '2026-10-24'), undefined, 'not in the group yet that day');
    assert.equal(mark(manual, '2026-10-24').auto, undefined, 'a roll-call mark is left alone');

    // Vali's homework comes in later: now he came.
    vali.results.push(hw('2026-10-24'));
    await attendanceFromHomework('2026-10-24', 'B1');
    assert.equal(mark(vali, '2026-10-24').status, 'present');

    // All homework of that day deleted: no lesson after all — the automatic marks go, the roll call's stay.
    for (const s of group) s.results = [];
    await attendanceFromHomework('2026-10-24', 'B1');
    assert.equal(mark(ali, '2026-10-24'), undefined);
    assert.equal(mark(vali, '2026-10-24'), undefined);
    assert.equal(mark(manual, '2026-10-24').status, 'present');
    assert.equal(mark(late, '2026-10-24').status, 'late');
  } finally { CourseStudent.find = orig; }
});
