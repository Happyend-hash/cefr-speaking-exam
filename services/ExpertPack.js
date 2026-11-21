import crypto from 'crypto';
import { spawn } from 'child_process';
import archiver from 'archiver';
import ExamResult from '../models/ExamResult.js';
import Exam from '../models/Exam.js';
import ExpertBatch from '../models/ExpertBatch.js';
import AudioStorageService from './AudioStorageService.js';
import ImageStorageService from './ImageStorageService.js';
import { SPEAKING_PARTS } from '../content/speakingRubric.js';

/**
 * The expert calibration pack (Jamshid, 2026-11-21).
 *
 * A certified examiner agreed to mark 15 mocks blind. The site picks them —
 * spread across the levels, weighted to the B1/B2 and B2/C1 boundaries — and
 * hands the teacher a ZIP to put on Google Drive: per candidate a folder with
 * the eight answers as MP3, the Part 1.2 pictures, and the questions, plus a
 * manifest the Google Apps Script reads to build the Google Form.
 *
 * The examiner sees codes (M01 … M15) only: no names, no AI score, no
 * transcript. The key (code → attempt, student, AI bands) stays on the site
 * and in a separate file for the teacher, so her marks can be compared later.
 */

export const STRATA = [
  { key: 'below', label: 'below B1 (under 38)', min: 0, max: 37, take: 2 },
  { key: 'b1', label: 'B1 (38–50)', min: 38, max: 50, take: 4, prefer: s => s >= 46 },
  { key: 'b2low', label: 'low B2 (51–57)', min: 51, max: 57, take: 4, prefer: s => s === 54 },
  { key: 'b2high', label: 'high B2 (58–64)', min: 58, max: 64, take: 3, prefer: s => s >= 61 },
  { key: 'c1', label: 'C1 (65+)', min: 65, max: 75, take: 2 }
];
export const PACK_SIZE = STRATA.reduce((a, s) => a + s.take, 0); // 15
/** Marked by two examiners since this day: the current marking. */
export const SINCE = new Date('2026-10-12T00:00:00Z');

const PART_KEYS = ['part11', 'part12', 'part2', 'part3'];
const PART_LABEL = { '1.1': 'Part 1.1', '1.2': 'Part 1.2', 2: 'Part 2', 3: 'Part 3', '2': 'Part 2', '3': 'Part 3' };

/** How far the two AI readings were apart on their worst part. */
export function disagreement(markerBands = []) {
  if (markerBands.length < 2) return 0;
  const [a, b] = markerBands;
  return Math.max(...PART_KEYS.map(k => (Number.isFinite(a?.[k]) && Number.isFinite(b?.[k]) ? Math.abs(a[k] - b[k]) : 0)));
}

/** Can this attempt go to the examiner? A full, cleanly marked mock with every recording. */
export function usable(r) {
  const tasks = r.taskResults || [];
  return r.mode !== 'practice'
    && r.status === 'completed'
    && r.markingMethod === 'whole-performance'
    && Number.isFinite(r.overallScore)
    && (r.markerBands || []).length >= 2
    && !r.teacherBands?.correctedAt
    && !r.expertReview?.at
    && new Date(r.completedAt || r.evaluatedAt || 0) >= SINCE
    && tasks.length >= 8
    && tasks.every(t => t.audioKey && String(t.transcription || '').trim().length > 0);
}

/** A seeded shuffle, so a batch can be explained and repeated. */
function shuffled(list, seed) {
  const out = [...list];
  let h = crypto.createHash('sha256').update(String(seed)).digest();
  for (let i = out.length - 1; i > 0; i -= 1) {
    if (i % 8 === 0) h = crypto.createHash('sha256').update(h).digest();
    const j = h.readUInt32BE((i % 8) * 4) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pick the pack: per level band, boundary scores first, then the mocks the two
 * AI readings disagreed on most, then the rest in a seeded random order. One
 * mock per student and, where possible, one per test. A band with too few
 * mocks is topped up from the others so the pack still has 15. The next
 * candidates of each band are kept as backups (for "Swap").
 */
export function selectPack(attempts, { seed = 'x', exclude = [] } = {}) {
  const pool = attempts.filter(usable).filter(r => !exclude.includes(String(r._id)));
  const usedStudents = new Set();
  const usedExams = new Set();
  const picked = [];
  const backups = [];
  const order = (stratum, list) => shuffled(list, `${seed}:${stratum.key}`)
    .sort((a, b) => (stratum.prefer ? Number(stratum.prefer(b.overallScore)) - Number(stratum.prefer(a.overallScore)) : 0)
      || disagreement(b.markerBands) - disagreement(a.markerBands));
  const take = (r, stratum) => {
    picked.push({ r, stratum: stratum.key });
    usedStudents.add(String(r.student));
    usedExams.add(String(r.exam?._id || r.exam));
  };
  const free = r => !usedStudents.has(String(r.student)) && !picked.some(p => p.r === r);
  const examFree = r => !usedExams.has(String(r.exam?._id || r.exam));

  for (const stratum of STRATA) {
    const list = order(stratum, pool.filter(r => r.overallScore >= stratum.min && r.overallScore <= stratum.max));
    let n = 0;
    for (const r of list) { if (n < stratum.take && free(r) && examFree(r)) { take(r, stratum); n += 1; } }
    for (const r of list) { if (n < stratum.take && free(r)) { take(r, stratum); n += 1; } }
    for (const r of list) if (free(r) && !backups.some(b => b.r === r)) backups.push({ r, stratum: stratum.key });
  }
  // Top up from the backups when a band was short — from the B2 and B1 bands
  // first, where the marking matters most, and below B1 last (2026-11-21:
  // with no C1 mocks the first pack took 5 below B1).
  const TOPUP = ['b2high', 'b2low', 'b1', 'c1', 'below'];
  backups.sort((a, b) => TOPUP.indexOf(a.stratum) - TOPUP.indexOf(b.stratum));
  while (picked.length < PACK_SIZE && backups.length) {
    const i = backups.findIndex(b => free(b.r));
    if (i < 0) break;
    const [b] = backups.splice(i, 1);
    take(b.r, STRATA.find(s => s.key === b.stratum));
  }
  return { picked, backups: backups.filter(b => free(b.r)) };
}

const code = i => `M${String(i + 1).padStart(2, '0')}`;

/** Make a new batch (replacing the open one) from the attempts in the database. */
export async function createBatch({ by } = {}) {
  const attempts = await ExamResult.find({ module: { $ne: 'writing' }, status: 'completed', completedAt: { $gte: SINCE } })
    .select('student exam mode status markingMethod overallScore overallLevel partBands markerBands teacherBands expertReview completedAt evaluatedAt taskResults.audioKey taskResults.transcription taskResults.taskNumber')
    .populate('exam', 'title')
    .populate('student', 'firstName lastName email')
    .lean();
  const seed = crypto.randomBytes(8).toString('hex');
  const { picked } = selectPack(attempts.map(a => ({ ...a, student: a.student?._id || a.student, who: a.student })), { seed });
  // Codes in a shuffled order, so M01 … M15 do not give the levels away.
  const items = shuffled(picked, `${seed}:codes`).map((p, i) => ({
    code: code(i),
    result: p.r._id,
    stratum: p.stratum,
    student: [p.r.who?.firstName, p.r.who?.lastName].filter(Boolean).join(' ') || p.r.who?.email || '',
    exam: p.r.exam?.title || '',
    completedAt: p.r.completedAt,
    aiScore: p.r.overallScore,
    aiLevel: p.r.overallLevel,
    aiBands: p.r.partBands,
    aiMarkers: p.r.markerBands
  }));
  await ExpertBatch.updateMany({ closedAt: null }, { $set: { closedAt: new Date() } });
  return ExpertBatch.create({ seed, items, createdBy: by, available: attempts.filter(usable).length });
}

/** Replace one mock with the next one from the same level band. */
export async function swapItem(batch, itemCode) {
  const item = batch.items.find(i => i.code === itemCode);
  if (!item) throw Object.assign(new Error('Unknown code'), { statusCode: 404 });
  const attempts = await ExamResult.find({ module: { $ne: 'writing' }, status: 'completed', completedAt: { $gte: SINCE } })
    .select('student exam mode status markingMethod overallScore overallLevel partBands markerBands teacherBands expertReview completedAt evaluatedAt taskResults.audioKey taskResults.transcription')
    .populate('exam', 'title').populate('student', 'firstName lastName email').lean();
  const inBatch = new Set(batch.items.map(i => String(i.result)));
  const swapped = new Set((batch.swappedOut || []).map(String));
  const studentsIn = new Set(attempts.filter(a => inBatch.has(String(a._id)) && String(a._id) !== String(item.result)).map(a => String(a.student?._id || a.student)));
  const stratum = STRATA.find(s => s.key === item.stratum);
  const next = shuffled(attempts.filter(usable), `${batch.seed}:swap:${item.code}:${swapped.size}`)
    .find(a => !inBatch.has(String(a._id)) && !swapped.has(String(a._id))
      && !studentsIn.has(String(a.student?._id || a.student))
      && a.overallScore >= stratum.min && a.overallScore <= stratum.max);
  if (!next) throw Object.assign(new Error(`No other mock is left in ${stratum.label}`), { statusCode: 409 });
  batch.swappedOut = [...(batch.swappedOut || []), item.result];
  Object.assign(item, {
    result: next._id,
    student: [next.student?.firstName, next.student?.lastName].filter(Boolean).join(' ') || next.student?.email || '',
    exam: next.exam?.title || '', completedAt: next.completedAt, aiScore: next.overallScore, aiLevel: next.overallLevel,
    aiBands: next.partBands, aiMarkers: next.markerBands
  });
  batch.markModified('items');
  await batch.save();
  return batch;
}

/** The key, for the teacher only: code → student, test, AI bands and score. */
export function keyCsv(batch) {
  const head = ['Code', 'Level band', 'Student', 'Mock', 'Date', 'AI Part 1.1', 'AI Part 1.2', 'AI Part 2', 'AI Part 3', 'AI score', 'AI level', 'Attempt id'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = batch.items.map(i => [
    i.code, STRATA.find(s => s.key === i.stratum)?.label || i.stratum, i.student, i.exam,
    i.completedAt ? new Date(i.completedAt).toISOString().slice(0, 10) : '',
    i.aiBands?.part11, i.aiBands?.part12, i.aiBands?.part2, i.aiBands?.part3, i.aiScore, i.aiLevel, String(i.result)
  ]);
  return '﻿' + [head, ...rows].map(r => r.map(q).join(',')).join('\r\n');
}

/** Any recording → MP3, so it plays in Google Drive's preview on every device. */
function toMp3(buffer) {
  return new Promise(resolve => {
    let done = false;
    const chunks = [];
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-b:a', '64k', '-f', 'mp3', 'pipe:1']);
    const finish = out => { if (!done) { done = true; resolve(out); } };
    ff.stdout.on('data', c => chunks.push(c));
    ff.on('error', () => finish(null));
    ff.on('close', codeNum => finish(codeNum === 0 && chunks.length ? Buffer.concat(chunks) : null));
    ff.stdin.on('error', () => {});
    ff.stdin.end(buffer);
    setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } finish(null); }, 60000);
  });
}

const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'video/webm': 'webm' };
const IMG_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const imageKey = img => String(img?.url || img || '').match(/([a-f0-9]{24})/)?.[1] || null;

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

/** The examiner's instructions, in the ZIP and in the form. */
export const EXAMINER_NOTE = [
  'English Hub Family — speaking calibration',
  '',
  'Thank you for marking these mocks. Please mark them exactly as in the real Multilevel exam:',
  '- Listen to the recordings. There are no transcripts and no other scores on purpose.',
  '- Give one band per part on the official scale: Part 1.1 (0-5), Part 1.2 (0-5), Part 2 (0-5), Part 3 (0-6).',
  '- Part 1.2: the two pictures the candidate saw are in the candidate\'s folder.',
  '- Each candidate is a different student. Candidates are shown by code only (M01, M02 ...).',
  '- A short reason per part ("why not one band higher") helps us a lot, but is optional.',
  ''
].join('\r\n');

/**
 * What the pack holds, worked out once and used both for the ZIP and for the
 * Google script's private link: per candidate the answers (with their
 * recording keys), the Part 1.2 pictures and the Part 3 statement.
 */
export async function packEntries(batch) {
  const exams = new Map();
  const out = [];
  for (const item of batch.items) {
    const r = await ExamResult.findById(item.result).select('exam taskResults.taskNumber taskResults.audioKey').lean();
    if (!r) continue;
    const examId = String(r.exam);
    if (!exams.has(examId)) exams.set(examId, await Exam.findById(examId).lean());
    const flat = flattenSections(exams.get(examId));
    const cand = { code: item.code, answers: [], pictures: [], partThree: null };
    const picturesDone = new Set();
    for (const q of flat) {
      const t = (r.taskResults || []).find(x => x.taskNumber === q.taskNumber);
      const partName = PART_LABEL[q.part] || `Part ${q.part}`;
      if (q.part === '1.2' && !picturesDone.has(q.sectionIndex)) {
        picturesDone.add(q.sectionIndex);
        for (const img of q.images || []) {
          const key = imageKey(img);
          if (key) cand.pictures.push({ key, name: `${item.code}-P12-picture-${cand.pictures.length + 1}` });
        }
      }
      if (q.part === '3') cand.partThree = { statement: q.topic || '', forSide: q.pros || [], againstSide: q.cons || [] };
      cand.answers.push({
        part: q.part, partName, number: q.questionInSection, question: q.text || '',
        audioKey: t?.audioKey || null,
        name: `${item.code}-${partName.replace('Part ', 'P').replace('.', '')}-Q${q.questionInSection}`
      });
    }
    out.push(cand);
  }
  return out;
}

/** One answer as MP3 (or its original file if it cannot be converted): { buffer, ext, type }. */
export async function answerAudio(audioKey) {
  const raw = await AudioStorageService.readBuffer(audioKey);
  const mp3 = await toMp3(raw);
  if (mp3) return { buffer: mp3, ext: 'mp3', type: 'audio/mpeg' };
  const meta = await AudioStorageService.getMetadata(audioKey).catch(() => null);
  const type = meta?.contentType || 'audio/webm';
  return { buffer: raw, ext: EXT[type] || 'webm', type };
}

/** One Part 1.2 picture: { buffer, ext, type }. */
export async function picture(key) {
  const meta = await ImageStorageService.getMetadata(key);
  if (!meta) throw Object.assign(new Error('Picture not found'), { statusCode: 404 });
  const buffer = await streamToBuffer(ImageStorageService.openDownloadStream(key));
  const type = meta.contentType || 'image/jpeg';
  return { buffer, ext: IMG_EXT[type] || 'jpg', type };
}

const manifestHead = batch => ({
  title: 'English Hub Family — speaking calibration',
  created: batch.createdAt,
  note: EXAMINER_NOTE,
  parts: SPEAKING_PARTS.map(p => ({ key: p.key, name: p.name, max: p.max }))
});

/**
 * The manifest for the Google script's private link: the same pack, with an
 * address for every recording and picture instead of a file in a ZIP.
 */
export async function linkManifest(batch, base) {
  const entries = await packEntries(batch);
  return {
    ...manifestHead(batch),
    candidates: entries.map(c => ({
      code: c.code,
      partThree: c.partThree,
      pictures: c.pictures.map((p, i) => ({ name: p.name, url: `${base}/picture/${c.code}/${i + 1}` })),
      answers: c.answers.map((a, i) => ({
        part: a.part, partName: a.partName, number: a.number, question: a.question, name: a.name,
        url: a.audioKey ? `${base}/audio/${c.code}/${i + 1}` : null
      }))
    }))
  };
}

/**
 * Write the ZIP to `out`: README, manifest.json and one folder per candidate
 * (answers as MP3, Part 1.2 pictures, questions.txt).
 */
export async function writePack(batch, out) {
  const zip = archiver('zip', { zlib: { level: 1 } });
  zip.pipe(out);
  const manifest = { ...manifestHead(batch), candidates: [] };
  for (const c of await packEntries(batch)) {
    const cand = { code: c.code, answers: [], pictures: [], partThree: c.partThree };
    const lines = [c.code, ''];
    for (const p of c.pictures) {
      try {
        const img = await picture(p.key);
        const name = `${p.name}.${img.ext}`;
        zip.append(img.buffer, { name: `${c.code}/${name}` });
        cand.pictures.push(name);
      } catch { /* listed as missing */ }
    }
    for (const a of c.answers) {
      let file = null;
      if (a.audioKey) {
        try {
          const audio = await answerAudio(a.audioKey);
          file = `${a.name}.${audio.ext}`;
          zip.append(audio.buffer, { name: `${c.code}/${file}` });
        } catch { file = null; }
      }
      cand.answers.push({ part: a.part, partName: a.partName, number: a.number, question: a.question, file });
      lines.push(`${a.partName} · Q${a.number}${file ? `  (${file})` : '  (recording missing)'}`, `  ${String(a.question).replace(/\n/g, '\n  ')}`, '');
    }
    if (c.partThree) {
      lines.push('Part 3 statement:', `  ${c.partThree.statement}`, '  FOR: ' + c.partThree.forSide.join('; '), '  AGAINST: ' + c.partThree.againstSide.join('; '), '');
    }
    zip.append(lines.join('\r\n'), { name: `${c.code}/${c.code}-questions.txt` });
    manifest.candidates.push(cand);
  }
  zip.append(EXAMINER_NOTE, { name: 'README-for-examiner.txt' });
  zip.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  await zip.finalize();
}

/** The exam's questions in the order the student answered them (same as routes/exam.js flattenExam). */
function flattenSections(exam) {
  const flat = [];
  let number = 0;
  for (const [sectionIndex, section] of (exam?.sections || []).entries()) {
    (section.questions || []).forEach((question, questionIndex) => {
      number += 1;
      flat.push({
        taskNumber: number, sectionIndex, part: String(section.part), images: section.images || [],
        topic: section.topic, pros: section.pros || [], cons: section.cons || [],
        text: question.text, questionInSection: questionIndex + 1
      });
    });
  }
  return flat;
}

export default { STRATA, PACK_SIZE, selectPack, usable, disagreement, createBatch, swapItem, keyCsv, writePack, packEntries, linkManifest, answerAudio, picture };
