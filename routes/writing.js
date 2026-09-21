import express from 'express';
import mongoose from 'mongoose';
import WritingAttempt from '../models/WritingAttempt.js';
import User, { UNITS_PER_MOCK, PART_COST } from '../models/User.js';
import { APIError } from '../middleware/errorHandler.js';
import {
  WRITING_TESTS,
  WRITING_TIME_LIMIT_SECONDS,
  writingTest,
  publicWritingTest
} from '../content/writingTests.js';
import { WRITING_PART_KEYS } from '../content/writingCriteria.js';
import { countWords } from '../services/WritingScoring.js';
import { markWritingAttempt, presentWritingAttempt } from '../services/WritingMarking.js';

/**
 * The writing module.
 *
 * Two ways in:
 *
 *   MOCK  — a test from content/writingTests.js under exam conditions: one
 *           60-minute clock for all three parts, typed, paste blocked in the
 *           browser, autosaved as the student writes. Charged one whole mock
 *           when it starts; every part left blank is handed back (⅓ each) when
 *           it is submitted.
 *
 *   CHECK — the student pastes writing they have already done, part by part,
 *           optionally with the task. Charged ⅓ of a mock per part submitted.
 *
 * Only all three parts together count as a full mock and get a score out of
 * 75. Anything less is marked part by part and capped at B1.
 */

const router = express.Router();

const isValidId = id => mongoose.Types.ObjectId.isValid(id);
const isStaff = user => user?.role === 'admin' || user?.role === 'teacher';

// A save that arrives a moment after the clock hits zero is the student's last
// sentence in flight, not cheating. Two minutes covers a slow phone network.
const SAVE_GRACE_MS = 2 * 60 * 1000;

// A marking that has been "in progress" this long was lost — the server
// restarted mid-call. It is started again the next time anyone looks.
const STALE_MARKING_MS = 5 * 60 * 1000;

const MAX_TEXT = 20000;

/** Marking runs in the background; this stops one attempt being marked twice at once. */
const marking = new Set();

function startMarking(id) {
  const key = String(id);
  if (marking.has(key)) return;
  marking.add(key);
  markWritingAttempt(key)
    .catch(error => console.error(`Writing marking ${key} crashed:`, error.message))
    .finally(() => marking.delete(key));
}

/** Read the texts a client sent, keeping only known parts, trimmed to size. */
function incomingParts(body) {
  const parts = {};
  const source = body?.parts && typeof body.parts === 'object' ? body.parts : {};
  for (const key of WRITING_PART_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value : value.text;
    const question = typeof value === 'object' ? value.question : undefined;
    parts[key] = {
      text: String(text ?? '').slice(0, MAX_TEXT),
      ...(question !== undefined ? { question: String(question ?? '').slice(0, 4000) } : {})
    };
  }
  return parts;
}

async function loadAttempt(req, id) {
  if (!isValidId(id)) throw new APIError('Invalid attempt id', 400);
  const attempt = await WritingAttempt.findById(id);
  if (!attempt) throw new APIError('Writing attempt not found', 404);
  if (String(attempt.student) !== String(req.user.id) && !isStaff(req.user)) {
    throw new APIError('Not authorized to access this attempt', 403);
  }
  return attempt;
}

async function refund(studentId, units) {
  if (!units) return;
  const student = await User.findById(studentId);
  if (!student) return;
  student.refundCredits(units);
  await student.save();
}

/**
 * Hand a mock in: decide which parts count, settle the charge, start marking.
 *
 * Claimed with a conditional update so that the student's own submit, their
 * browser's auto-submit at zero and a late page load can all arrive together
 * and only one of them does anything.
 */
async function finalizeMock(attempt, incoming = {}) {
  const now = Date.now();
  const inTime = !attempt.deadline || now <= attempt.deadline.getTime() + SAVE_GRACE_MS;

  const texts = {};
  for (const key of WRITING_PART_KEYS) {
    const sent = inTime ? incoming[key]?.text : undefined;
    texts[key] = sent !== undefined ? sent : attempt.parts?.[key]?.text || '';
  }

  const submitted = WRITING_PART_KEYS.filter(key => texts[key].trim());
  // Staff run free (creditCost 0) and stay free; everyone else pays ⅓ a part.
  const charged = attempt.creditCost || 0;
  const cost = charged ? submitted.length * PART_COST.writing : 0;

  const set = {
    status: submitted.length ? 'evaluating' : 'cancelled',
    submittedAt: new Date(),
    submittedParts: submitted,
    creditCost: cost
  };
  for (const key of WRITING_PART_KEYS) {
    set[`parts.${key}.text`] = texts[key];
    set[`parts.${key}.words`] = countWords(texts[key]);
  }

  const claimed = await WritingAttempt.findOneAndUpdate(
    { _id: attempt._id, status: 'in_progress' },
    { $set: set },
    { new: true }
  );
  if (!claimed) return WritingAttempt.findById(attempt._id);

  await refund(claimed.student, charged - cost);
  if (submitted.length) startMarking(claimed._id);
  return claimed;
}

/**
 * Bring an attempt up to date before anyone reads it.
 *
 *  - a mock whose time ran out while the tab was closed is handed in now, with
 *    whatever was autosaved — exactly what happens in the exam room
 *  - a marking lost to a restart is started again
 */
async function settle(attempt) {
  if (
    attempt.mode === 'mock' &&
    attempt.status === 'in_progress' &&
    attempt.deadline &&
    Date.now() > attempt.deadline.getTime() + SAVE_GRACE_MS
  ) {
    return finalizeMock(attempt);
  }

  if (
    attempt.status === 'evaluating' &&
    attempt.submittedAt &&
    Date.now() - attempt.submittedAt.getTime() > STALE_MARKING_MS &&
    !marking.has(String(attempt._id))
  ) {
    await WritingAttempt.updateOne({ _id: attempt._id }, { $set: { submittedAt: new Date() } });
    startMarking(attempt._id);
  }

  return attempt;
}

// ------------------------------------------------------------------ tests

/**
 * @route GET /api/writing/tests
 * @desc  The writing tests, with this student's progress on each.
 */
router.get('/tests', async (req, res, next) => {
  try {
    const attempts = await WritingAttempt.find({ student: req.user.id, mode: 'mock' })
      .select('testId status score level complete createdAt deadline')
      .sort({ createdAt: -1 })
      .lean();

    const tests = WRITING_TESTS.map(test => {
      const mine = attempts.filter(a => a.testId === test.id);
      const done = mine.filter(a => a.status === 'completed');
      const best = done
        .filter(a => a.complete && Number.isFinite(a.score))
        .sort((a, b) => b.score - a.score)[0];
      const open = mine.find(
        a => a.status === 'in_progress' && (!a.deadline || new Date(a.deadline).getTime() + SAVE_GRACE_MS > Date.now())
      );
      return {
        id: test.id,
        title: test.title,
        timeLimit: WRITING_TIME_LIMIT_SECONDS,
        attempts: done.length,
        best: best ? { id: String(best._id), score: best.score, level: best.level } : null,
        inProgress: open ? String(open._id) : null
      };
    });

    res.json({ success: true, data: tests });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------------- mock

/**
 * @route POST /api/writing/mock
 * @desc  Start (or resume) a timed writing mock.
 * @body  { testId }
 */
router.post('/mock', async (req, res, next) => {
  try {
    const test = writingTest(String(req.body?.testId || ''));
    if (!test) throw new APIError('Writing test not found', 404);

    const first = await User.findById(req.user.id);
    if (!first) throw new APIError('User not found', 404);

    // A block stops even a resume: it is a decision about the person.
    const blocked = first.examAccess(UNITS_PER_MOCK);
    if (blocked.code === 'blocked') throw new APIError(blocked.message, 403, 'blocked');

    // Resume rather than charge again: a reload or a lost connection must not
    // cost a second mock, and the clock keeps running from the first start.
    const open = await WritingAttempt.findOne({
      student: first._id,
      mode: 'mock',
      testId: test.id,
      status: 'in_progress'
    }).sort({ createdAt: -1 });

    if (open) {
      const settled = await settle(open);
      if (settled.status === 'in_progress') {
        return res.json({
          success: true,
          data: { resumed: true, attempt: presentWritingAttempt(settled), test: publicWritingTest(test), serverNow: Date.now() }
        });
      }
    }

    // Read the balance only now: an expired attempt settled just above may
    // have handed credit back.
    const student = await User.findById(req.user.id);
    const gate = student.examAccess(UNITS_PER_MOCK);

    // A whole mock is taken up front, because the student is about to see all
    // three tasks. Parts left blank are handed back at submission.
    if (!gate.allowed) throw new APIError(gate.message, 402, gate.code);

    const now = new Date();
    const attempt = await WritingAttempt.create({
      student: student._id,
      mode: 'mock',
      testId: test.id,
      testTitle: test.title,
      startedAt: now,
      deadline: new Date(now.getTime() + WRITING_TIME_LIMIT_SECONDS * 1000),
      creditCost: gate.code === 'staff' ? 0 : UNITS_PER_MOCK
    });

    if (gate.code !== 'staff') {
      student.spendCredits(UNITS_PER_MOCK);
      await student.save();
    }

    res.status(201).json({
      success: true,
      data: {
        resumed: false,
        attempt: presentWritingAttempt(attempt),
        test: publicWritingTest(test),
        serverNow: Date.now(),
        credits: gate.code === 'staff' ? null : student.creditLabel(),
        units: gate.code === 'staff' ? null : student.creditUnits()
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route PUT /api/writing/attempts/:id
 * @desc  Autosave a mock in progress.
 * @body  { parts: { part11: "text", ... }, pasteBlocked }
 */
router.put('/attempts/:id', async (req, res, next) => {
  try {
    const attempt = await loadAttempt(req, req.params.id);
    if (String(attempt.student) !== String(req.user.id)) {
      throw new APIError('Only the candidate can write in this attempt', 403);
    }
    if (attempt.mode !== 'mock' || attempt.status !== 'in_progress') {
      throw new APIError('This attempt has already been handed in', 409, 'closed');
    }
    if (attempt.deadline && Date.now() > attempt.deadline.getTime() + SAVE_GRACE_MS) {
      const settled = await finalizeMock(attempt);
      return res.status(409).json({
        success: false,
        code: 'time_up',
        message: 'Time is up — your writing has been handed in.',
        data: { attempt: presentWritingAttempt(settled) }
      });
    }

    const set = {};
    for (const [key, value] of Object.entries(incomingParts(req.body))) {
      set[`parts.${key}.text`] = value.text;
      set[`parts.${key}.words`] = countWords(value.text);
    }
    const pastes = Number(req.body?.pasteBlocked);
    const update = { $set: set };
    if (Number.isFinite(pastes) && pastes > 0) update.$max = { pasteBlocked: Math.floor(pastes) };

    await WritingAttempt.updateOne({ _id: attempt._id, status: 'in_progress' }, update);
    res.json({ success: true, data: { savedAt: new Date().toISOString() } });
  } catch (error) {
    next(error);
  }
});

/**
 * @route POST /api/writing/attempts/:id/submit
 * @desc  Hand in a mock. Accepts the final texts, so nothing typed after the
 *        last autosave is lost.
 */
router.post('/attempts/:id/submit', async (req, res, next) => {
  try {
    const attempt = await loadAttempt(req, req.params.id);
    if (String(attempt.student) !== String(req.user.id)) {
      throw new APIError('Only the candidate can hand in this attempt', 403);
    }
    if (attempt.mode !== 'mock') throw new APIError('Not a mock attempt', 400);

    const settled =
      attempt.status === 'in_progress' ? await finalizeMock(attempt, incomingParts(req.body)) : attempt;

    res.json({ success: true, data: { attempt: presentWritingAttempt(settled) } });
  } catch (error) {
    next(error);
  }
});

// ------------------------------------------------------------------ check

/**
 * @route POST /api/writing/check
 * @desc  Mark writing the student already has. ⅓ of a mock per part.
 * @body  { parts: { part11: { text, question }, ... } }
 */
router.post('/check', async (req, res, next) => {
  try {
    const parts = incomingParts(req.body);
    const submitted = WRITING_PART_KEYS.filter(key => parts[key]?.text?.trim());
    if (!submitted.length) {
      throw new APIError('Paste at least one piece of writing to check.', 400, 'empty');
    }

    const student = await User.findById(req.user.id);
    if (!student) throw new APIError('User not found', 404);

    const cost = submitted.length * PART_COST.writing;
    const gate = student.examAccess(cost);
    if (gate.code === 'blocked') throw new APIError(gate.message, 403, 'blocked');
    if (!gate.allowed) throw new APIError(gate.message, 402, gate.code);

    const doc = {
      student: student._id,
      mode: 'check',
      status: 'evaluating',
      startedAt: new Date(),
      submittedAt: new Date(),
      submittedParts: submitted,
      creditCost: gate.code === 'staff' ? 0 : cost,
      parts: {}
    };
    for (const key of WRITING_PART_KEYS) {
      const text = submitted.includes(key) ? parts[key].text : '';
      doc.parts[key] = {
        text,
        question: submitted.includes(key) ? parts[key].question || '' : '',
        words: countWords(text)
      };
    }

    const attempt = await WritingAttempt.create(doc);

    if (gate.code !== 'staff') {
      student.spendCredits(cost);
      await student.save();
    }

    startMarking(attempt._id);

    res.status(201).json({
      success: true,
      data: {
        attempt: presentWritingAttempt(attempt),
        credits: gate.code === 'staff' ? null : student.creditLabel(),
        units: gate.code === 'staff' ? null : student.creditUnits()
      }
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------- results

/**
 * @route GET /api/writing/attempts
 * @desc  This student's writing attempts, newest first.
 */
router.get('/attempts', async (req, res, next) => {
  try {
    const attempts = await WritingAttempt.find({ student: req.user.id, status: { $ne: 'cancelled' } })
      .sort({ createdAt: -1 })
      .limit(50);

    const settled = [];
    for (const attempt of attempts) settled.push(await settle(attempt));

    res.json({
      success: true,
      data: settled
        .filter(a => a.status !== 'cancelled')
        .map(a => {
          const view = presentWritingAttempt(a);
          return {
            id: view.id,
            mode: view.mode,
            title: view.title,
            status: view.status,
            score: view.score,
            level: view.level,
            complete: view.complete,
            parts: view.parts.filter(p => p.submitted).map(p => p.name),
            date: a.submittedAt || a.startedAt
          };
        })
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route GET /api/writing/attempts/:id
 * @desc  One attempt — in progress, being marked, or marked.
 */
router.get('/attempts/:id', async (req, res, next) => {
  try {
    const attempt = await settle(await loadAttempt(req, req.params.id));
    res.json({
      success: true,
      data: {
        attempt: presentWritingAttempt(attempt),
        test: attempt.mode === 'mock' ? publicWritingTest(writingTest(attempt.testId)) : null,
        serverNow: Date.now()
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route POST /api/writing/attempts/:id/remark
 * @desc  Try a failed marking again. No charge — the student already paid.
 */
router.post('/attempts/:id/remark', async (req, res, next) => {
  try {
    const attempt = await loadAttempt(req, req.params.id);
    if (!['failed', 'completed'].includes(attempt.status)) {
      throw new APIError('This attempt is not ready to be marked again', 409);
    }
    // A student may retry a failure; re-marking a finished result is the
    // teacher's call, not a free second opinion.
    if (attempt.status === 'completed' && !isStaff(req.user)) {
      throw new APIError('Only a teacher can re-mark a finished result', 403);
    }

    await WritingAttempt.updateOne(
      { _id: attempt._id },
      { $set: { status: 'evaluating', submittedAt: new Date() }, $unset: { failureReason: 1 } }
    );
    startMarking(attempt._id);

    res.json({ success: true, message: 'Marking again' });
  } catch (error) {
    next(error);
  }
});

export default router;
