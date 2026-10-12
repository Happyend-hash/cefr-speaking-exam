import ExamResult from '../models/ExamResult.js';
import WritingAttempt from '../models/WritingAttempt.js';
import { markWritingAttempt } from './WritingMarking.js';
import { markAttempt, STALE_EVALUATION_MS } from '../routes/exam.js';

/**
 * Attempts that were handed in but never got a mark — and getting them one.
 *
 * When the AI service is unavailable (the Anthropic balance ran out on
 * 2026-10-12, for example) a speaking mock goes back to 'submitted' and a
 * writing check to 'failed'. Nothing used to try again: the student waited for
 * a result that never came until someone noticed. Now:
 *
 *   - the teacher panel lists them and can mark them now (listUnmarked /
 *     retryOne / retryAll);
 *   - every RETRY_EVERY_MS they are retried automatically, a few times, while
 *     they are recent — so the moment the service is back, they get marked.
 *
 * A retry costs nothing extra for the student: they were charged when they
 * handed the attempt in.
 */

/** Only recent attempts are retried automatically; older ones wait for a teacher. */
export const AUTO_RETRY_DAYS = 3;
/** How often the automatic retry runs, and the most times one attempt is tried per boot. */
export const RETRY_EVERY_MS = 20 * 60 * 1000;
export const MAX_AUTO_RETRIES = 6;

const inFlight = new Set();
const tries = new Map();

const staleEvaluating = () => ({
  status: 'evaluating',
  submittedAt: { $lt: new Date(Date.now() - STALE_EVALUATION_MS) }
});

/** Everything handed in and not marked, newest first. */
export async function listUnmarked() {
  const [speaking, writing] = await Promise.all([
    ExamResult.find({
      $or: [{ status: 'submitted' }, staleEvaluating()],
      'taskResults.0': { $exists: true }
    })
      .sort({ submittedAt: -1, createdAt: -1 })
      .limit(100)
      .populate('student', 'email firstName lastName')
      .populate('exam', 'title')
      .select('student exam status mode part submittedAt createdAt taskResults.transcription')
      .lean(),
    WritingAttempt.find({ $or: [{ status: 'failed' }, staleEvaluating()] })
      .sort({ submittedAt: -1, createdAt: -1 })
      .limit(100)
      .populate('student', 'email firstName lastName')
      .select('student status mode testTitle submittedAt createdAt failureReason')
      .lean()
  ]);

  const who = s => ({
    email: s?.email || '—',
    name: [s?.firstName, s?.lastName].filter(Boolean).join(' ')
  });

  return [
    ...speaking.map(r => ({
      kind: 'speaking',
      id: String(r._id),
      ...who(r.student),
      title: r.exam?.title || 'Speaking',
      detail: r.mode === 'practice' && r.part ? `Part ${r.part} practice` : 'Full mock',
      // Answers with no words cannot be marked by retrying; say so.
      transcribed: (r.taskResults || []).filter(t => String(t.transcription || '').trim()).length,
      answers: (r.taskResults || []).length,
      status: r.status,
      at: r.submittedAt || r.createdAt,
      reason: ''
    })),
    ...writing.map(a => ({
      kind: 'writing',
      id: String(a._id),
      ...who(a.student),
      title: a.mode === 'mock' ? a.testTitle || 'Writing mock' : 'Writing check',
      detail: a.mode === 'mock' ? 'Writing mock' : 'Writing check',
      status: a.status,
      at: a.submittedAt || a.createdAt,
      reason: a.failureReason || ''
    }))
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
}

/** Mark one attempt again, in the background. Returns false if it is already being marked. */
export async function retryOne(kind, id) {
  const key = `${kind}:${id}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);

  try {
    if (kind === 'speaking') {
      const moved = await ExamResult.updateOne(
        { _id: id, $or: [{ status: 'submitted' }, staleEvaluating()] },
        { $set: { status: 'evaluating', submittedAt: new Date() } }
      );
      if (!moved.modifiedCount) { inFlight.delete(key); return false; }
      markAttempt(id)
        .catch(async error => {
          console.error(`Retry: speaking ${id} failed:`, error.message);
          await ExamResult.updateOne({ _id: id, status: 'evaluating' }, { $set: { status: 'submitted' } }).catch(() => {});
        })
        .finally(() => inFlight.delete(key));
      return true;
    }

    if (kind === 'writing') {
      const moved = await WritingAttempt.updateOne(
        { _id: id, $or: [{ status: 'failed' }, staleEvaluating()] },
        { $set: { status: 'evaluating', submittedAt: new Date() }, $unset: { failureReason: 1 } }
      );
      if (!moved.modifiedCount) { inFlight.delete(key); return false; }
      markWritingAttempt(id)
        .catch(error => console.error(`Retry: writing ${id} failed:`, error.message))
        .finally(() => inFlight.delete(key));
      return true;
    }
  } catch (error) {
    inFlight.delete(key);
    throw error;
  }
  inFlight.delete(key);
  return false;
}

/** Retry everything unmarked. `recentOnly` limits it to the last AUTO_RETRY_DAYS. */
export async function retryAll({ recentOnly = false, automatic = false } = {}) {
  const cutoff = Date.now() - AUTO_RETRY_DAYS * 24 * 60 * 60 * 1000;
  const list = (await listUnmarked()).filter(item => !recentOnly || new Date(item.at).getTime() >= cutoff);
  let started = 0;
  for (const item of list) {
    // A mock with no words in it cannot be marked by trying again.
    if (item.kind === 'speaking' && !item.transcribed) continue;
    const key = `${item.kind}:${item.id}`;
    if (automatic) {
      const n = tries.get(key) || 0;
      if (n >= MAX_AUTO_RETRIES) continue;
      tries.set(key, n + 1);
    }
    if (await retryOne(item.kind, item.id)) started += 1;
  }
  if (started) console.log(`Marking retry: started ${started} unmarked attempt(s)${automatic ? ' (automatic)' : ''}`);
  return { found: list.length, started };
}

export default { listUnmarked, retryOne, retryAll };
