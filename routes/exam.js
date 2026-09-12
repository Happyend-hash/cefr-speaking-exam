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
      .select('title module level description totalTasks duration maxScore tags')
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
        totalTasks: exam.totalTasks,
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

    const existing = await ExamResult.findOne({
      student: req.user.id,
      exam: exam._id,
      status: 'in_progress'
    });

    if (existing) {
      return res.json({
        success: true,
        message: 'Resuming your attempt in progress',
        data: { resultId: existing._id, resumed: true }
      });
    }

    const result = await ExamResult.create({
      student: req.user.id,
      exam: exam._id,
      examLevel: exam.level || undefined,
      module: exam.module || 'speaking',
      // overallLevel is the outcome of the test, so it stays unset until evaluated.
      status: 'in_progress',
      startedAt: new Date(),
      taskResults: [],
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.status(201).json({
      success: true,
      message: 'Exam started',
      data: { resultId: result._id, resumed: false }
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
      const task = exam?.tasks.find(t => t.taskNumber === taskNumber);
      if (!task) throw new APIError(`Task ${taskNumber} does not exist on this exam`, 404);

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
        existing.type = task.type;
        if (audioKey) existing.audioKey = audioKey;
        existing.transcription = text;
        existing.duration = Number(req.body.duration) || existing.duration || 0;
        existing.status = 'pending';
      } else {
        result.taskResults.push({
          taskNumber,
          type: task.type,
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
          totalTasks: exam.tasks.length,
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
    if (result.status === 'evaluating') {
      throw new APIError('This attempt is currently being evaluated', 409);
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

    for (const taskResult of result.taskResults) {
      const task = exam.tasks.find(t => t.taskNumber === taskResult.taskNumber);
      if (!task) continue;

      try {
        const evaluation = await AIEvaluationService.evaluateTask({
          transcription: taskResult.transcription,
          taskType: taskResult.type,
          question: task.question,
          cefrLevel: exam.level,
          referenceImages: task.images,
          followUpQuestions: task.followUpQuestions,
          minWords: task.minWords
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
    result.isPassed = result.overallScore >= (Number(process.env.PASS_SCORE) || 50);
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
