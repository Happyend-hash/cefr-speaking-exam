import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';

import Exam from '../models/Exam.js';
import ExamResult from '../models/ExamResult.js';
import AIEvaluationService from '../services/AIEvaluationService.js';
import TranscriptionService from '../services/TranscriptionService.js';
import AudioStorageService, {
  ALLOWED_AUDIO_TYPES,
  MAX_AUDIO_BYTES
} from '../services/AudioStorageService.js';
import ImageStorageService from '../services/ImageStorageService.js';
import { APIError } from '../middleware/errorHandler.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES },
  fileFilter: (req, file, cb) => {
    const type = (file.mimetype || '').split(';')[0].trim();
    if (ALLOWED_AUDIO_TYPES.includes(type)) return cb(null, true);
    cb(new APIError(`Unsupported audio format: ${type}`, 400));
  }
});

const isValidId = id => mongoose.Types.ObjectId.isValid(id);

/**
 * Flatten a stored exam into the ordered question list the runner plays.
 *
 * Works on a lean (plain-object) exam as well as a document, because most reads
 * here use .lean() and would not have the schema method available.
 */
function flattenExam(exam, onlyPart = null) {
  const flat = [];
  let number = 0;

  for (const [sectionIndex, section] of (exam.sections || []).entries()) {
    const questions = section.questions || [];
    questions.forEach((question, questionIndex) => {
      number += 1;
      if (onlyPart && section.part !== onlyPart) return;
      flat.push({
        taskNumber: number,
        sectionIndex,
        part: section.part,
        sectionTitle: section.title,
        instructions: section.instructions,
        images: section.images || [],
        topic: section.topic,
        pros: section.pros || [],
        cons: section.cons || [],
        text: question.text,
        prepTime: question.prepTime ?? 5,
        answerTime: question.answerTime ?? 30,
        isSectionStart: questionIndex === 0,
        questionInSection: questionIndex + 1,
        questionsInSection: questions.length
      });
    });
  }

  return flat;
}

/** Load a result and confirm the caller owns it (admins may view any). */
async function loadOwnedResult(req, resultId) {
  if (!isValidId(resultId)) throw new APIError('Invalid result id', 400);

  const result = await ExamResult.findById(resultId);
  if (!result) throw new APIError('Result not found', 404);

  const isOwner = String(result.student) === String(req.user.id);
  if (!isOwner && req.user.role !== 'admin') {
    throw new APIError('Not authorized to access this result', 403);
  }
  return result;
}

/**
 * @route   GET /api/exam/results
 * @desc    The signed-in student's exam history
 * @access  Private
 * @note    Declared before /:id so "results" is not captured as an exam id.
 */
router.get('/results', async (req, res, next) => {
  try {
    const results = await ExamResult.find({ student: req.user.id })
      .sort({ createdAt: -1 })
      .populate('exam', 'title level')
      .lean();

    res.json({
      success: true,
      data: results.map(r => ({
        id: r._id,
        examTitle: r.exam?.title || 'Exam',
        examLevel: r.examLevel,
        status: r.status,
        overallScore: r.overallScore ?? null,
        overallLevel: r.overallLevel,
        isPassed: r.isPassed,
        startedAt: r.startedAt,
        completedAt: r.completedAt
      }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/exam/results/:resultId
 * @desc    Remove one attempt from the student's history, with its recordings.
 * @access  Private (owner or admin)
 *
 * The recordings go too. Deleting the attempt on its own would leave the audio
 * orphaned in GridFS — invisible to the student, still taking up space, and
 * still their voice. If a recording fails to delete the attempt is kept, so the
 * history never shows "deleted" while the audio is still stored.
 */
async function removeResult(result) {
  if (result.status === 'evaluating') {
    return { ok: false, reason: 'it is being marked right now' };
  }

  const keys = result.taskResults.map(t => t.audioKey).filter(Boolean);
  const failed = [];
  for (const key of keys) {
    if (!(await AudioStorageService.delete(key))) failed.push(key);
  }

  // Keep the attempt if its audio survived, so the history can never claim
  // something is gone while the student's voice is still stored.
  if (failed.length) {
    return { ok: false, reason: `${failed.length} of ${keys.length} recordings could not be deleted` };
  }

  await result.deleteOne();
  return { ok: true, recordingsDeleted: keys.length };
}

router.delete('/results/:resultId', async (req, res, next) => {
  try {
    const result = await loadOwnedResult(req, req.params.resultId);
    const outcome = await removeResult(result);

    if (!outcome.ok) {
      throw new APIError(
        `This attempt was kept — ${outcome.reason}.`,
        outcome.reason.includes('marked') ? 409 : 500
      );
    }

    res.json({
      success: true,
      message: 'Attempt deleted',
      data: { id: String(result._id), recordingsDeleted: outcome.recordingsDeleted }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/exam/results/bulk-delete
 * @desc    Delete several attempts at once, with their recordings.
 * @access  Private (owner or admin)
 *
 * One request rather than one per row: the API is rate limited, and a student
 * clearing twenty old attempts should not spend twenty of their allowance.
 *
 * Each id is checked and deleted on its own, and the response reports exactly
 * what went and what stayed. A partial failure is a normal outcome here, not an
 * error — the client shows which attempts survived and why.
 */
router.post('/results/bulk-delete', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!ids || ids.length === 0) {
      throw new APIError('Select at least one attempt to delete', 400);
    }
    if (ids.length > 100) {
      throw new APIError('Delete at most 100 attempts at a time', 400);
    }

    const deleted = [];
    const kept = [];

    for (const id of ids) {
      try {
        const result = await loadOwnedResult(req, id);
        const outcome = await removeResult(result);
        if (outcome.ok) deleted.push(String(id));
        else kept.push({ id: String(id), reason: outcome.reason });
      } catch (error) {
        // One bad id must not abandon the rest of the selection.
        kept.push({ id: String(id), reason: error.message });
      }
    }

    res.json({
      success: true,
      message: kept.length
        ? `Deleted ${deleted.length}; kept ${kept.length}`
        : `Deleted ${deleted.length} attempt${deleted.length === 1 ? '' : 's'}`,
      data: { deleted, kept }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/exam/results/:resultId
 * @desc    Full detail for one attempt, including per-task feedback
 * @access  Private (owner or admin)
 */
router.get('/results/:resultId', async (req, res, next) => {
  try {
    const result = await loadOwnedResult(req, req.params.resultId);
    await result.populate('exam', 'title level description');

    res.json({
      success: true,
      data: {
        id: result._id,
        exam: result.exam,
        examLevel: result.examLevel,
        status: result.status,
        overallScore: result.overallScore ?? null,
        overallLevel: result.overallLevel,
        isPassed: result.isPassed,
        startedAt: result.startedAt,
        submittedAt: result.submittedAt,
        completedAt: result.completedAt,
        taskResults: result.taskResults.map(t => ({
          taskNumber: t.taskNumber,
          type: t.type,
          transcription: t.transcription,
          duration: t.duration,
          hasAudio: Boolean(t.audioKey),
          audioUrl: t.audioKey ? `/api/exam/audio/${t.audioKey}` : null,
          status: t.status,
          finalScore: t.finalScore ?? null,
          evaluation: t.aiEvaluation || null
        }))
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/exam/audio/:audioKey
 * @desc    Stream a stored recording back to its owner
 * @access  Private (owner or admin)
 */
router.get('/audio/:audioKey', async (req, res, next) => {
  try {
    const { audioKey } = req.params;
    const file = await AudioStorageService.getMetadata(audioKey);
    if (!file) throw new APIError('Recording not found', 404);

    const ownerId = file.metadata?.studentId;
    if (String(ownerId) !== String(req.user.id) && req.user.role !== 'admin') {
      throw new APIError('Not authorized to access this recording', 403);
    }

    res.set('Content-Type', file.contentType || 'audio/webm');
    res.set('Content-Length', String(file.length));
    res.set('Cache-Control', 'private, max-age=3600');

    const stream = AudioStorageService.openDownloadStream(audioKey);
    stream.on('error', err => next(new APIError(`Could not read recording: ${err.message}`, 500)));
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/exam/images/:key
 * @desc    Serve an exam image (Part 1.2 pictures)
 * @access  Private — any signed-in student
 */
router.get('/images/:key', async (req, res, next) => {
  try {
    const file = await ImageStorageService.getMetadata(req.params.key);
    if (!file) throw new APIError('Image not found', 404);

    res.set('Content-Type', file.contentType || 'image/jpeg');
    res.set('Content-Length', String(file.length));
    // Exam images never change once uploaded, so they cache hard.
    res.set('Cache-Control', 'private, max-age=86400');

    const stream = ImageStorageService.openDownloadStream(req.params.key);
    stream.on('error', err => next(new APIError(`Could not read image: ${err.message}`, 500)));
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/exam
 * @desc    List published exams
 * @access  Private
 */
router.get('/', async (req, res, next) => {
  try {
    const filter = { isActive: true, isPublished: true };
    if (req.query.level) filter.level = req.query.level;

    if (req.query.module) filter.module = req.query.module;

    const exams = await Exam.find(filter)
      .select('title module level description totalTasks duration maxScore tags sections')
      .sort({ module: 1, title: 1 })
      .lean();

    res.json({
      success: true,
      data: exams.map(e => ({
        id: e._id,
        title: e.title,
        module: e.module || 'speaking',
        level: e.level || null,
        description: e.description,
        totalTasks: e.totalTasks,
        parts: [...new Set((e.sections || []).map(s => s.part))],
        totalQuestions: (e.sections || []).reduce((n, s) => n + (s.questions?.length || 0), 0),
        duration: e.duration,
        maxScore: e.maxScore,
        tags: e.tags || []
      }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/exam/:id
 * @desc    Exam detail with its tasks. Sample answers are never exposed.
 * @access  Private
 */
router.get('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid exam id', 400);

    const exam = await Exam.findById(req.params.id).lean();
    if (!exam || !exam.isPublished || !exam.isActive) {
      throw new APIError('Exam not found', 404);
    }

    res.json({
      success: true,
      data: {
        id: exam._id,
        title: exam.title,
        module: exam.module || 'speaking',
        level: exam.level || null,
        description: exam.description,
        duration: exam.duration,
        // Which parts this test contains, so the client can offer part practice.
        parts: [...new Set((exam.sections || []).map(s => s.part))],
        totalTasks: exam.totalTasks,
        // Sections flattened into the ordered question list the runner plays.
        questions: flattenExam(exam),
        // Legacy flat tasks — still how the writing module is stored.
        tasks: exam.tasks.map(t => ({
          taskNumber: t.taskNumber,
          type: t.type,
          part: t.part,
          instructions: t.instructions,
          question: t.question,
          images: t.images || [],
          followUpQuestions: t.followUpQuestions || [],
          timeLimit: t.timeLimit,
          minWords: t.minWords
        }))
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/exam/:id/start
 * @desc    Begin an attempt. Reuses an existing in-progress attempt rather than
 *          creating duplicates when a student reloads mid-exam.
 * @access  Private
 */
router.post('/:id/start', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid exam id', 400);

    const exam = await Exam.findById(req.params.id);
    if (!exam || !exam.isPublished || !exam.isActive) {
      throw new APIError('Exam not found', 404);
    }

    // 'mock' runs the whole test under exam conditions — no skipping, timers
    // enforced. 'practice' lets the student work through one part at a time.
    const mode = req.body.mode === 'practice' ? 'practice' : 'mock';
    const part = mode === 'practice' && req.body.part ? String(req.body.part) : null;

    if (part && !(exam.sections || []).some(s => s.part === part)) {
      throw new APIError(`This test has no Part ${part}`, 400);
    }

    // Resume only an attempt of the SAME kind. Matching on the exam alone meant
    // a student who abandoned a mock was handed it back when they asked for part
    // practice, and could never start practising at all. In MongoDB `part: null`
    // also matches documents where the field is absent, which is how mocks store it.
    const existing = await ExamResult.findOne({
      student: req.user.id,
      exam: exam._id,
      status: 'in_progress',
      mode,
      part: part ?? null
    });

    if (existing) {
      return res.json({
        success: true,
        message: 'Resuming your attempt in progress',
        data: {
          resultId: existing._id,
          resumed: true,
          mode: existing.mode,
          part: existing.part || null,
          questions: flattenExam(exam.toObject(), existing.part || null)
        }
      });
    }

    const result = await ExamResult.create({
      student: req.user.id,
      exam: exam._id,
      examLevel: exam.level || undefined,
      module: exam.module || 'speaking',
      mode,
      part,
      // overallLevel is the outcome of the test, so it stays unset until evaluated.
      status: 'in_progress',
      startedAt: new Date(),
      taskResults: [],
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.status(201).json({
      success: true,
      message: mode === 'mock' ? 'Mock exam started' : `Practice started`,
      data: {
        resultId: result._id,
        resumed: false,
        mode,
        part,
        questions: flattenExam(exam.toObject(), part)
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/exam/results/:resultId/tasks/:taskNumber
 * @desc    Upload one task response (audio + transcript). Re-uploading replaces
 *          the previous answer for that task.
 * @access  Private (owner)
 */
router.post(
  '/results/:resultId/tasks/:taskNumber',
  upload.single('audio'),
  async (req, res, next) => {
    try {
      const result = await loadOwnedResult(req, req.params.resultId);

      if (result.status !== 'in_progress') {
        throw new APIError('This attempt has already been submitted', 409);
      }

      const taskNumber = Number(req.params.taskNumber);
      if (!Number.isInteger(taskNumber) || taskNumber < 1) {
        throw new APIError('Invalid task number', 400);
      }

      const exam = await Exam.findById(result.exam).lean();
      if (!exam) throw new APIError('The exam for this attempt no longer exists', 404);

      // A speaking test stores its questions in sections, so exam.tasks is
      // empty for it. Look in both: tasks for writing, the flattened sections
      // for speaking. Checking only tasks rejected every speaking answer with
      // a 404, so nothing was ever saved and submitting found no answers.
      const flat = flattenExam(exam);
      const question = flat.find(q => q.taskNumber === taskNumber);
      const task = exam.tasks.find(t => t.taskNumber === taskNumber);
      if (!task && !question) {
        throw new APIError(`Task ${taskNumber} does not exist on this exam`, 404);
      }

      // taskResults.type drives which rubric the evaluator uses; anything not
      // starting with "writing_" is marked as speaking.
      const answerType = task ? task.type : `speaking_part_${question.part}`;
      const totalTasks = exam.tasks.length || flat.length;

      // Store the recording first so the transcript always has audio backing it.
      let audioKey = null;
      if (req.file?.buffer?.length) {
        const stored = await AudioStorageService.store(req.file.buffer, {
          filename: `result-${result._id}-task-${taskNumber}.webm`,
          contentType: (req.file.mimetype || '').split(';')[0].trim(),
          studentId: req.user.id,
          resultId: result._id,
          taskNumber
        });
        audioKey = stored.audioKey;
      }

      const { text, provider, warning } = await TranscriptionService.transcribe(
        req.file?.buffer || null,
        {
          clientTranscript: req.body.transcription || '',
          filename: `task-${taskNumber}.webm`,
          contentType: (req.file?.mimetype || 'audio/webm').split(';')[0].trim()
        }
      );

      const existing = result.taskResults.find(t => t.taskNumber === taskNumber);

      if (existing) {
        // Replacing an answer: drop the superseded recording so storage doesn't grow unbounded.
        if (existing.audioKey && audioKey) {
          await AudioStorageService.delete(existing.audioKey);
        }
        existing.type = answerType;
        if (audioKey) existing.audioKey = audioKey;
        existing.transcription = text;
        existing.duration = Number(req.body.duration) || existing.duration || 0;
        existing.status = 'pending';
      } else {
        result.taskResults.push({
          taskNumber,
          type: answerType,
          audioKey,
          transcription: text,
          duration: Number(req.body.duration) || 0,
          status: 'pending'
        });
      }

      await result.save();

      res.json({
        success: true,
        message: 'Response saved',
        data: {
          taskNumber,
          transcription: text,
          transcriptionProvider: provider,
          hasAudio: Boolean(audioKey),
          answered: result.taskResults.length,
          totalTasks,
          warning
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/exam/results/:resultId/submit
 * @desc    Finish an attempt and run AI evaluation across every answered task.
 * @access  Private (owner)
 */
router.post('/results/:resultId/submit', async (req, res, next) => {
  try {
    const result = await loadOwnedResult(req, req.params.resultId);

    if (result.status === 'completed') {
      return res.json({
        success: true,
        message: 'This attempt was already evaluated',
        data: { ...result.getEvaluationSummary(), resultId: result._id }
      });
    }
    // An attempt only stays in 'evaluating' while a request is actively marking
    // it. If the process restarted mid-marking — a deploy, a crash — the flag is
    // never cleared and the attempt would be locked out of submission forever,
    // with its recordings stranded. Treat a long-stale flag as abandoned and let
    // the student try again.
    const STALE_EVALUATION_MS = 10 * 60 * 1000;
    if (result.status === 'evaluating') {
      const startedAt = result.submittedAt ? new Date(result.submittedAt).getTime() : 0;
      const stale = startedAt && Date.now() - startedAt > STALE_EVALUATION_MS;
      if (!stale) {
        throw new APIError('This attempt is currently being evaluated', 409);
      }
      console.warn(`Result ${result._id} was stuck in 'evaluating' — re-marking it.`);
    }
    if (result.taskResults.length === 0) {
      throw new APIError('Answer at least one task before submitting', 400);
    }

    const exam = await Exam.findById(result.exam).lean();
    if (!exam) throw new APIError('The exam for this attempt no longer exists', 404);

    result.submit();
    result.status = 'evaluating';
    await result.save();

    const failures = [];

    // Speaking tests are stored as sections, not tasks, so exam.tasks is empty
    // for them. Flatten first and look the answer up there, otherwise every
    // question in a Multilevel speaking mock is silently skipped at grading.
    const flat = flattenExam(exam);
    const questionByNumber = new Map(flat.map(q => [q.taskNumber, q]));

    for (const taskResult of result.taskResults) {
      const task = exam.tasks.find(t => t.taskNumber === taskResult.taskNumber);
      const question = questionByNumber.get(taskResult.taskNumber);
      if (!task && !question) continue;

      try {
        const evaluation = await AIEvaluationService.evaluateTask({
          transcription: taskResult.transcription,
          taskType: taskResult.type,
          question: task ? task.question : question.text,
          cefrLevel: exam.level,
          referenceImages: task ? task.images : question.images,
          followUpQuestions: task?.followUpQuestions,
          minWords: task?.minWords,
          // Context the examiner would have in front of them: which part this
          // is, and the stimulus the student was answering about.
          part: question?.part,
          instructions: question?.instructions,
          topic: question?.topic,
          pros: question?.pros,
          cons: question?.cons
        });

        taskResult.aiEvaluation = {
          ...evaluation,
          aiModel: process.env.CLAUDE_MODEL || 'claude-opus-5-20250805',
          evaluatedAt: new Date()
        };
        taskResult.finalScore = evaluation.score;
        taskResult.status = 'evaluated';
      } catch (error) {
        // One failed task must not discard the whole attempt — recordings and
        // transcripts are kept so it can be re-evaluated later.
        console.error(`Evaluation failed for task ${taskResult.taskNumber}:`, error.message);
        failures.push({ taskNumber: taskResult.taskNumber, error: error.message });
        taskResult.status = 'pending';
      }
    }

    const evaluatedCount = result.taskResults.filter(t => t.status === 'evaluated').length;

    if (evaluatedCount === 0) {
      result.status = 'submitted';
      await result.save();
      throw new APIError(
        `Evaluation failed for every task. ${failures[0]?.error || ''} Your answers are saved — fix the configuration and submit again.`.trim(),
        502
      );
    }

    result.calculateOverallScore();
    result.overallLevel = result.determineCEFRLevel();
    // Passing means reaching B1, the lowest certified band on the 75-point scale.
    result.isPassed = result.overallScore >= (Number(process.env.PASS_SCORE) || 31);
    result.status = 'completed';
    result.evaluatedAt = new Date();
    result.completedAt = new Date();

    if (result.isPassed) result.generateCertificate();
    await result.save();

    await Exam.findByIdAndUpdate(exam._id, { $inc: { 'statistics.timesUsed': 1 } });

    res.json({
      success: true,
      message: 'Evaluation complete',
      data: {
        ...result.getEvaluationSummary(),
        resultId: result._id,
        partialFailures: failures.length ? failures : undefined
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
