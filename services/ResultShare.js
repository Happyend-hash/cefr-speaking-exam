import crypto from 'crypto';
import QRCode from 'qrcode';
import ResultShare from '../models/ResultShare.js';
import ExamResult from '../models/ExamResult.js';
import WritingAttempt from '../models/WritingAttempt.js';
import User from '../models/User.js';
import { SPEAKING_PARTS, speakingLabel } from '../content/speakingRubric.js';
import { presentWritingAttempt } from './WritingMarking.js';

/**
 * Sharing a mock result (Jamshid, 2026-11-10).
 *
 * The student taps "Natijani ulashish" on a finished full mock and gets the
 * score sheet — an image in the site's style, drawn on their own phone from
 * the data below — plus a link, englishhub.uz/r/CODE, that the sheet's QR
 * opens. The link proves the score is real. If the student chose
 * "with audio and feedback", it also opens their recordings, what they said
 * and the feedback, for 30 days.
 */

export const DETAILS_DAYS = 30;
const DAY = 864e5;
// No 0/O, 1/I/L: read aloud or typed from a picture without mistakes.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;
export const SITE = 'englishhub.uz';

export const newCode = () => Array.from({ length: CODE_LENGTH }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
export const isCode = c => typeof c === 'string' && c.length === CODE_LENGTH && [...c].every(ch => ALPHABET.includes(ch));
export const shareUrl = code => `${SITE}/r/${code}`;

const fail = (message, status = 400, code) => Object.assign(new Error(message), { statusCode: status, code });

// The part names on the sheet, in Uzbek, as the app shows them.
const SPEAKING_UZ = { part11: 'Shaxsiy savollar', part12: 'Rasmlarni solishtirish', part2: 'Bir mavzuda gapirish', part3: 'Munozara: tarafdor va qarshi' };
const WRITING_UZ = { part11: 'Norasmiy xat (do‘stga)', part12: 'Rasmiy xat', part2: 'Blog / maqola' };
const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
const TZ_MS = 5 * 3600e3; // Tashkent

/** "9-noyabr, 2026", in Tashkent time. */
export function uzDate(when) {
  if (!when) return '';
  const d = new Date(new Date(when).getTime() + TZ_MS);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}, ${d.getUTCFullYear()}`;
}

const fullName = u => [u?.firstName, u?.lastName].map(s => String(s || '').trim()).filter(Boolean).join(' ') || 'English Hub o‘quvchisi';

/** A finished full mock with a score: the only results the sheet is made for. */
export function shareable(kind, doc) {
  if (!doc) return false;
  if (kind === 'speaking') return doc.mode !== 'practice' && doc.status === 'completed' && Number.isFinite(doc.overallScore) && Boolean(doc.overallLevel);
  if (kind === 'writing') return doc.mode === 'mock' && doc.status === 'completed' && doc.complete === true && Number.isFinite(doc.score);
  return false;
}

/** Each part of a speaking result as the sheet shows it. Half bands get both labels. */
export function speakingParts(bands = {}) {
  return SPEAKING_PARTS.map(p => {
    const band = Number(bands?.[p.key]);
    if (!Number.isFinite(band)) return null;
    const low = Math.floor(band);
    return {
      key: p.key, name: p.name, desc: SPEAKING_UZ[p.key] || p.description, band, max: p.max,
      label: band === low ? speakingLabel(p.key, band) : `${speakingLabel(p.key, low)} – ${speakingLabel(p.key, low + 1)}`
    };
  }).filter(Boolean);
}

/** The QR as rows of 0/1, drawn by the browser onto the sheet. */
export function qrRows(text) {
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = q.modules.size;
  const rows = [];
  for (let y = 0; y < n; y++) {
    let row = '';
    for (let x = 0; x < n; x++) row += q.modules.get(y, x) ? '1' : '0';
    rows.push(row);
  }
  return rows;
}

/** Everything the score sheet needs. */
export function sheetOf(kind, doc, user, code) {
  const base = { module: kind, name: fullName(user), code, url: shareUrl(code), qr: qrRows(`https://${shareUrl(code)}`) };
  if (kind === 'speaking') {
    return {
      ...base,
      title: doc.exam?.title || 'Speaking mock',
      date: uzDate(doc.completedAt || doc.submittedAt || doc.createdAt),
      score: doc.overallScore,
      level: doc.overallLevel,
      expert: Boolean(doc.expertReview?.at),
      parts: speakingParts(doc.partBands)
    };
  }
  const view = presentWritingAttempt(doc);
  return {
    ...base,
    title: view.title,
    date: uzDate(doc.submittedAt || doc.markedAt || doc.createdAt),
    score: view.score,
    level: view.level,
    expert: Boolean(view.expertReviewed),
    parts: view.parts.filter(p => p.submitted && p.band !== null)
      .map(p => ({ key: p.key, name: p.name, desc: WRITING_UZ[p.key] || p.description, band: p.band, max: p.max, label: p.label }))
  };
}

/** The recordings, what was said and the feedback (only with the student's "with audio" choice). */
export async function detailsOf(kind, doc, code) {
  if (kind === 'speaking') {
    const questions = doc.exam?.flattenQuestions ? doc.exam.flattenQuestions() : [];
    const byNumber = new Map(questions.map(q => [q.taskNumber, q]));
    return {
      feedback: doc.overallFeedback || '',
      reasoning: doc.overallReasoning || '',
      strengths: doc.overallStrengths || [],
      improvements: doc.overallImprovements || [],
      answers: [...(doc.taskResults || [])].sort((a, b) => a.taskNumber - b.taskNumber).map(t => {
        const q = byNumber.get(t.taskNumber);
        return {
          n: t.taskNumber,
          part: q?.part || '',
          question: q?.text || '',
          said: t.transcription || '',
          audio: t.audioKey ? `/api/r/${code}/audio/${t.taskNumber}` : null,
          feedback: t.aiEvaluation?.overallFeedback || ''
        };
      })
    };
  }
  const view = presentWritingAttempt(doc);
  return {
    feedback: view.overallFeedback || '',
    strengths: view.strengths || [],
    improvements: view.areasForImprovement || [],
    parts: view.parts.filter(p => p.submitted && p.band !== null).map(p => ({
      name: p.name, desc: WRITING_UZ[p.key] || p.description, band: p.band, max: p.max, label: p.label, words: p.words,
      task: p.task || '', segments: p.segments, corrections: p.corrections, reasoning: p.reasoning, feedback: p.feedback
    }))
  };
}

const detailsOn = (share, now = Date.now()) => Boolean(share.details && share.detailsUntil && new Date(share.detailsUntil).getTime() > now);

/** What the student's share panel shows about their link. */
export function shareStatus(share, now = Date.now()) {
  if (!share || share.revokedAt) return null;
  return {
    code: share.code,
    url: shareUrl(share.code),
    details: detailsOn(share, now),
    detailsUntil: detailsOn(share, now) ? share.detailsUntil : null,
    views: share.views || 0
  };
}

async function loadResult(kind, id) {
  if (kind === 'speaking') return ExamResult.findById(id).populate('exam', 'title sections');
  if (kind === 'writing') return WritingAttempt.findById(id);
  throw fail('Unknown result kind', 400);
}

async function loadMine(userId, kind, id) {
  const doc = await loadResult(kind, id).catch(() => null);
  if (!doc || String(doc.student) !== String(userId)) throw fail('Natija topilmadi', 404, 'not_found');
  if (!shareable(kind, doc)) throw fail('Faqat tekshirib bo‘lingan to‘liq mockni ulashish mumkin', 409, 'not_shareable');
  return doc;
}

/**
 * Share a result, or change how it is shared. Keeps the code of a link that is
 * already out there. Returns { share, sheet }.
 */
export async function share(userId, { kind, id, details = false, now = Date.now() } = {}) {
  const doc = await loadMine(userId, kind, id);
  const user = await User.findById(userId).select('firstName lastName');
  let s = await ResultShare.findOne({ owner: userId, kind, result: doc._id, revokedAt: null });
  if (!s) {
    for (let i = 0; i < 5 && !s; i++) {
      try {
        s = await ResultShare.create({ code: newCode(), owner: userId, kind, result: doc._id });
      } catch (error) {
        if (error?.code !== 11000) throw error; // a code taken already: try another
      }
    }
    if (!s) throw fail('Havola yaratib bo‘lmadi — qayta urinib ko‘ring', 500);
  }
  const wantDetails = Boolean(details);
  if (wantDetails && !detailsOn(s, now)) { s.details = true; s.detailsUntil = new Date(now + DETAILS_DAYS * DAY); }
  if (!wantDetails) { s.details = false; s.detailsUntil = null; }
  await s.save();
  return { share: shareStatus(s, now), sheet: sheetOf(kind, doc, user, s.code) };
}

/** The student's live link for one result, if any. */
export async function mine(userId, kind, id) {
  const s = await ResultShare.findOne({ owner: userId, kind, result: id, revokedAt: null });
  return shareStatus(s);
}

/** "Stop sharing": the link and every sheet's QR stop working. */
export async function revoke(userId, code) {
  const s = await ResultShare.findOne({ code, owner: userId, revokedAt: null });
  if (!s) throw fail('Havola topilmadi', 404, 'not_found');
  s.revokedAt = new Date();
  await s.save();
  return { revoked: true };
}

/** Load a live share and its result, or throw "not found" — the same for every reason, so codes cannot be probed. */
async function openShare(code) {
  const gone = () => fail('Bu havola ishlamaydi: natija o‘chirilgan yoki ulashish to‘xtatilgan.', 404, 'gone');
  if (!isCode(code)) throw gone();
  const s = await ResultShare.findOne({ code, revokedAt: null });
  if (!s) throw gone();
  const doc = await loadResult(s.kind, s.result).catch(() => null);
  if (!doc || !shareable(s.kind, doc)) throw gone();
  return { s, doc };
}

/** The public page: the verified score sheet, and the details while the student allows them. */
export async function publicView(code, now = Date.now()) {
  const { s, doc } = await openShare(code);
  const user = await User.findById(s.owner).select('firstName lastName');
  ResultShare.updateOne({ _id: s._id }, { $inc: { views: 1 }, $set: { lastViewAt: new Date(now) } }).catch(() => {});
  const on = detailsOn(s, now);
  return {
    verified: true,
    sheet: sheetOf(s.kind, doc, user, s.code),
    details: on ? await detailsOf(s.kind, doc, s.code) : null,
    detailsUntil: on ? s.detailsUntil : null,
    detailsExpired: Boolean(s.details && !on)
  };
}

/** One recording of a shared speaking result, while its details are shared. */
export async function sharedAudio(code, taskNumber, now = Date.now()) {
  const { s, doc } = await openShare(code);
  if (s.kind !== 'speaking' || !detailsOn(s, now)) throw fail('Audio ulashilmagan', 404, 'gone');
  const t = (doc.taskResults || []).find(x => x.taskNumber === Number(taskNumber));
  if (!t?.audioKey) throw fail('Audio topilmadi', 404, 'gone');
  return t.audioKey;
}

export default { share, mine, revoke, publicView, sharedAudio, sheetOf, shareable, newCode, isCode, uzDate, speakingParts, qrRows };
