import ExamResult from '../models/ExamResult.js';
import Exam from '../models/Exam.js';
import AudioStorageService from './AudioStorageService.js';
import TranscriptionService from './TranscriptionService.js';

/**
 * The transcription check (Jamshid, 2026-11-22).
 *
 * The marker reads what the transcription service heard. Garbled phrases in
 * its reasons ("I bring up BYU feed") suggest the cheaper model mishears some
 * students, and a misheard answer reads as broken English. This tool takes the
 * Part 2 and Part 3 answers of a few recent mocks — the long answers that
 * decide B2 and C1 — transcribes them again with another model, and shows the
 * two texts side by side with the recording, so the teacher can hear which is
 * right. Nothing is saved and no score changes.
 */

export const CANDIDATES = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'];
const PARTS = ['2', '3'];

let last = null;   // the latest comparison, for the panel
let running = null; // { model, startedAt } while one runs
export const lastComparison = () => ({ running, last });

/** Start a comparison in the background (it takes a minute or two); the panel polls lastComparison. */
export function startCompare(opts = {}) {
  if (running) throw Object.assign(new Error('A check is already running'), { statusCode: 409 });
  if (!CANDIDATES.includes(opts.model || 'gpt-4o-transcribe')) throw Object.assign(new Error('Unknown model'), { statusCode: 400 });
  running = { model: opts.model || 'gpt-4o-transcribe', startedAt: new Date() };
  compare(opts)
    .catch(error => { last = { at: new Date(), model: running?.model, error: error.message, items: [] }; })
    .finally(() => { running = null; });
  return lastComparison();
}

/** Recent full mocks with recordings and transcripts for Part 2 and Part 3. */
async function recentAnswers(mocks) {
  const results = await ExamResult.find({ mode: { $ne: 'practice' }, status: 'completed', module: { $ne: 'writing' } })
    .sort({ completedAt: -1 }).limit(mocks * 3)
    .select('exam completedAt overallScore taskResults.taskNumber taskResults.audioKey taskResults.transcription')
    .populate('exam', 'title sections').lean();
  const out = [];
  for (const r of results) {
    if (out.length >= mocks * PARTS.length) break;
    let n = 0;
    const byNumber = new Map();
    for (const section of r.exam?.sections || []) for (const q of section.questions || []) { n += 1; byNumber.set(n, { part: String(section.part), text: q.text }); }
    const picked = (r.taskResults || []).filter(t => PARTS.includes(byNumber.get(t.taskNumber)?.part) && t.audioKey && String(t.transcription || '').trim());
    if (picked.length < PARTS.length) continue;
    for (const t of picked) out.push({ result: String(r._id), exam: r.exam?.title || '', at: r.completedAt, score: r.overallScore, part: byNumber.get(t.taskNumber).part, question: byNumber.get(t.taskNumber).text, audioKey: t.audioKey, current: t.transcription });
  }
  return out;
}

const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
/** How far apart two texts are: changed words as a share of the longer one (0–100). */
export function difference(a, b) {
  const x = words(a), y = words(b);
  const m = x.length, n = y.length;
  if (!m && !n) return 0;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) for (let j = n - 1; j >= 0; j -= 1) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  return Math.round((1 - dp[0][0] / Math.max(m, n)) * 100);
}

/** Run the comparison on `mocks` recent mocks with `model`. */
export async function compare({ mocks = 5, model = 'gpt-4o-transcribe' } = {}) {
  if (!CANDIDATES.includes(model)) throw Object.assign(new Error('Unknown model'), { statusCode: 400 });
  if (!TranscriptionService.whisperKey) throw Object.assign(new Error('OPENAI_API_KEY is not set'), { statusCode: 409 });
  const answers = await recentAnswers(Math.max(1, Math.min(8, Number(mocks) || 5)));
  const items = [];
  const queue = [...answers];
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      try {
        const buffer = await AudioStorageService.readBuffer(a.audioKey);
        const meta = await AudioStorageService.getMetadata(a.audioKey).catch(() => null);
        const type = meta?.contentType || meta?.metadata?.contentType || 'audio/webm';
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm';
        const text = await TranscriptionService.transcribeWithWhisper(buffer, `answer.${ext}`, type, { model });
        items.push({ ...a, candidate: text, difference: difference(a.current, text) });
      } catch (error) {
        items.push({ ...a, candidate: null, error: error.message });
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  items.sort((x, y) => new Date(y.at) - new Date(x.at) || x.part.localeCompare(y.part));
  last = { at: new Date(), model, current: TranscriptionService.currentModel, items };
  return last;
}

export default { compare, startCompare, lastComparison, difference, CANDIDATES };
