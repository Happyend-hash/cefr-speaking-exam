import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';

import Exam from '../models/Exam.js';
import ExamResult, { MAX_SCORE } from '../models/ExamResult.js';
import CalibrationSample from '../models/CalibrationSample.js';
import AIEvaluationService from '../services/AIEvaluationService.js';
import TranscriptionService from '../services/TranscriptionService.js';
import AudioStorageService, {
  ALLOWED_AUDIO_TYPES,
  MAX_AUDIO_BYTES
} from '../services/AudioStorageService.js';
import ImageStorageService from '../services/ImageStorageService.js';
import User from '../models/User.js';
import PronunciationService from '../services/PronunciationService.js';
import { removeResult } from '../services/AttemptCleanup.js';
import { RAW_MAX, BAND_MAX } from '../services/ScoreConversion.js';
import {
  CRITERIA,
  BAND_LABELS,
  descriptorFor,
  nextBandFor
} from '../content/speakingCriteria.js';
import AICallLimiter from '../services/MarkingQueue.js';
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

/**
 * The detail behind a result's score: each official criterion, the band
 * awarded, what that band means, and what the next one up requires.
 *
 * Returns an empty array for attempts marked before criterion bands existed, so
 * the client shows the score alone rather than an empty panel promising detail
 * it does not have.
 */
function buildCriteriaDetail(bands) {
  if (!bands) return [];

  return CRITERIA.map(criterion => {
    const band = Number(bands[criterion.key] ?? bands.get?.(criterion.key));
    if (!Number.isFinite(band)) return null;

    return {
      key: criterion.key,
      name: criterion.name,
      band,
      max: BAND_MAX,
      label: BAND_LABELS[band] || '',
      descriptor: descriptorFor(criterion.key, band),
      next: nextBandFor(criterion.key, band)
    };
  }).filter(Boolean);
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
      .populate('exam', 'title level module')
      .lean();

    res.json({
      success: true,
      data: results.map(r => ({
        id: r._id,
        // The mocks page needs this to show which mocks a student has already
        // done, and their best score on each. Title alone cannot match reliably.
        examId: String(r.exam?._id || r.exam || ''),
        examModule: r.exam?.module || 'speaking',
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
 * @desc    Delete one attempt and its recordings
 * @access  Private (owner or admin)
 */
router.delete('/results/:resultId', async (req, res, next) => {
  try {
    const result = await loadOwnedResult(req, req.params.resultId);

    // An attempt that was started and never spoken into cost nothing to run, so
    // it should not have cost a mock either. Deleting it hands the credit back.
    // Only the untouched ones: once there is a single answer, the transcription
    // has been paid for and the attempt was used.
    const refundable =
      result.status === 'in_progress' && (result.taskResults || []).length === 0;

    const outcome = await removeResult(result);

    if (!outcome.ok) {
      throw new APIError(
        `This attempt was kept — ${outcome.reason}.`,
        outcome.reason.includes('marked') ? 409 : 500
      );
    }

    if (refundable) {
      await User.updateOne(
        { _id: result.student },
        { $inc: { 'subscription.examsRemaining': 1, 'stats.totalExamsTaken': -1 } }
      );
    }

    res.json({
      success: true,
      message: 'Attempt deleted',
      data: {
        id: String(result._id),
        recordingsDeleted: outcome.recordingsDeleted,
        refunded: refundable
      }
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
        // The examiner's verdict on the whole performance, which is where the
        // level actually comes from — the per-answer marks are feedback.
        overallFeedback: result.overallFeedback || '',
        overallReasoning: result.overallReasoning || '',
        overallStrengths: result.overallStrengths || [],
        overallImprovements: result.overallImprovements || [],
        /*
         * The official criterion bands, assembled here rather than on the
         * client so the descriptors can never drift: the sentence a student
         * reads is the one the marker was shown, from the same file.
         *
         * `next` carries the band above and what it describes, which is the
         * actionable half — a band number alone tells a student where they are
         * and nothing about how to move.
         */
        criteria: buildCriteriaDetail(result.criterionBands),
        // Always sent, even unassessed: the client has to be able to say
        // "not assessed" rather than quietly leaving the criterion out, which
        // would read as though pronunciation had simply been forgotten.
        pronunciation: result.pronunciation?.assessed
          ? {
              assessed: true,
              accuracy: result.pronunciation.accuracy,
              fluency: result.pronunciation.fluency,
              prosody: result.pronunciation.prosody,
              overall: result.pronunciation.overall,
              secondsAssessed: result.pronunciation.secondsAssessed,
              problemWords: result.pronunciation.problemWords || []
            }
          : { assessed: false },
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
 *
 * This is the only door into the paid work. Everything an attempt costs —
 * transcription on every upload, marking and pronunciation on submit — follows
 * from getting through here, so the access check lives here rather than at
 * submit, where the money would already have been spent.
 *
 * A credit is spent when an attempt is CREATED, not when it is resumed. A
 * student who reloads, loses their connection or comes back to finish is not
 * charged twice for the same attempt.
 */
router.post('/:id/start', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid exam id', 400);

    const student = await User.findById(req.user.id);
    if (!student) throw new APIError('User not found', 404);

    // One decision, read once, used by both branches below.
    const gate = student.examAccess();

    // A block stops even a resume: it is a decision about the person, and
    // letting a blocked student carry on with an attempt they already opened
    // would keep the transcription bill running.
    if (gate.code === 'blocked') throw new APIError(gate.message, 403, 'blocked');

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
          remaining: gate.code === 'staff' ? null : student.subscription.examsRemaining,
          serverTranscription: TranscriptionService.isServerTranscriptionAvailable(),
          mode: existing.mode,
          part: existing.part || null,
          questions: flattenExam(exam.toObject(), existing.part || null)
        }
      });
    }

    // Past this point a new attempt is being created, so it has to be paid for.
    if (!gate.allowed) throw new APIError(gate.message, 402, gate.code);

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

    // Charged only after the attempt exists. Charging first would take a mock
    // off a student whose attempt then failed to save. Staff run free — the
    // teacher checking a test is not a customer.
    if (gate.code !== 'staff') student.useExamCredit();
    student.stats.totalExamsTaken = (student.stats.totalExamsTaken || 0) + 1;
    await student.save();

    res.status(201).json({
      success: true,
      message: mode === 'mock' ? 'Mock exam started' : `Practice started`,
      data: {
        // Whether the server can turn a recording into text on its own. Without
        // it the app depends entirely on the browser's speech recognition, which
        // messaging-app browsers do not have — so the student must be warned
        // BEFORE recording, not handed a zero afterwards.
        serverTranscription: TranscriptionService.isServerTranscriptionAvailable(),
        resultId: result._id,
        resumed: false,
        remaining: gate.code === 'staff' ? null : student.subscription.examsRemaining,
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

    // Started, not awaited: marking takes far longer than an HTTP request
    // should. The per-call limiter inside markAttempt is what paces the load,
    // so attempts themselves need not queue behind one another.
    markAttempt(result._id).catch(async error => {
      console.error(`Marking crashed for ${result._id}:`, error.message);
      await ExamResult.findByIdAndUpdate(result._id, { status: 'submitted' }).catch(() => {});
    });

    res.status(202).json({
      success: true,
      message: 'Your answers are being marked',
      data: {
        resultId: result._id,
        status: 'evaluating',
        queue: AICallLimiter.stats
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Mark one attempt, away from the request that asked for it.
 *
 * Marking is slow — one AI call per answer — so it does not belong inside an
 * HTTP request. Holding the connection open for a minute or more is what left a
 * student's phone stuck on "Assessing your answers" when the browser suspended
 * the request, and with fifty students it would mean fifty connections held
 * open while they queue. The client polls the attempt for its result instead,
 * so this can take as long as it needs.
 *
 * Everything is reported by updating the attempt itself: 'completed' with a
 * score, or back to 'submitted' if nothing could be marked.
 */
/**
 * Measure the attempt's pronunciation, if Azure is configured.
 *
 * Only a sample of the attempt is sent — see PronunciationService for why — so
 * this pulls the recordings back out of GridFS for the answers that service
 * chooses, not for all eight. Recordings are fetched lazily for that reason:
 * each is about three quarters of a megabyte, and loading the whole attempt into
 * memory to use one minute of it would be wasteful with fifty students at once.
 *
 * Never throws. A pronunciation score is an enrichment; if Azure is down or the
 * key has expired, the student still gets marked on everything else.
 */
async function assessPronunciation(result) {
  if (!PronunciationService.isConfigured()) return null;

  try {
    // Rank by how much was said before fetching anything, so only the clips
    // that will actually be assessed are ever downloaded.
    const candidates = result.taskResults
      .filter(t => t.audioKey && String(t.transcription || '').trim())
      .sort((a, b) => b.transcription.length - a.transcription.length)
      .slice(0, 3);

    if (!candidates.length) return null;

    const answers = [];
    for (const taskResult of candidates) {
      try {
        answers.push({
          taskNumber: taskResult.taskNumber,
          transcription: taskResult.transcription,
          audio: await AudioStorageService.readBuffer(taskResult.audioKey)
        });
      } catch (error) {
        console.warn(`Could not read audio for task ${taskResult.taskNumber}:`, error.message);
      }
    }

    return await PronunciationService.assessAttempt(answers);
  } catch (error) {
    console.error('Pronunciation assessment failed:', error.message);
    return { assessed: false, error: error.message };
  }
}

/**
 * Say what the pronunciation measurement found, in Uzbek, naming names.
 *
 * "Talaffuz: 61/75" tells a student nothing they can act on. The words the
 * assessor scored lowest are the actual lesson, so they are what gets said.
 */
function pronunciationFeedback(pronunciation) {
  const accuracy = Math.round(pronunciation.accuracy);
  const seconds = pronunciation.secondsAssessed || 0;

  const opening =
    `Talaffuz aniqligi ${accuracy}/100 — ovozingizning ${seconds} soniyasi bo'yicha o'lchandi.`;

  const words = (pronunciation.problemWords || []).slice(0, 5).map(w => w.word);
  if (!words.length) return `${opening} Aniq xato topilmadi.`;

  return `${opening} Ustida ishlash kerak bo'lgan so'zlar: ${words.join(', ')}.`;
}

/**
 * Which attempts can be rescued, and why they need rescuing.
 *
 * A batch of attempts was handed back as zeros, or as nothing at all, because
 * the recordings arrived with no words attached: most mobile browsers have no
 * speech recognition, and at the time that was the only transcriber. The audio
 * was always fine — it was never read.
 *
 * That is now fixed, and the recordings are still in storage, so those attempts
 * are not broken. They are unread. This finds them.
 */
export function isRescuable(result) {
  const answers = result.taskResults || [];
  const withAudio = answers.filter(t => t.audioKey);
  if (!withAudio.length) return false;

  // An answer holding a recording but no words is one nobody has read yet.
  return withAudio.some(t => !String(t.transcription || '').trim());
}

/**
 * Read the recordings that were never read, then mark the attempt properly.
 *
 * Transcribing first is the whole point: marking alone would skip these answers
 * again, because it (correctly) refuses to score an answer with no words. The
 * words have to be recovered from the audio before there is anything to mark.
 */
export async function rescueAttempt(resultId) {
  const result = await ExamResult.findById(resultId);
  if (!result) return { ok: false, reason: 'not found' };

  let recovered = 0;
  let failed = 0;

  for (const taskResult of result.taskResults) {
    if (!taskResult.audioKey) continue;
    if (String(taskResult.transcription || '').trim()) continue;

    try {
      const audio = await AudioStorageService.readBuffer(taskResult.audioKey);
      const { text } = await TranscriptionService.transcribe(audio, {
        filename: `task-${taskResult.taskNumber}.webm`,
        contentType: 'audio/webm'
      });

      if (String(text || '').trim()) {
        taskResult.transcription = text;
        // Back to 'pending' so marking picks it up: 'not_transcribed' is what
        // told it to leave this answer alone in the first place.
        taskResult.status = 'pending';
        recovered += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      console.warn(`Rescue: task ${taskResult.taskNumber} of ${resultId} — ${error.message}`);
      failed += 1;
    }
  }

  if (!recovered) {
    return { ok: false, reason: failed ? 'no words could be recovered' : 'nothing to recover' };
  }

  // Clear the old verdict so a rescue that then fails to mark leaves no stale
  // score behind claiming to be current. `set(..., undefined)` is Mongoose's
  // way of unsetting a path — a plain assignment of undefined is ignored.
  result.set('overallScore', undefined);
  result.set('overallLevel', undefined);
  result.set('isPassed', undefined);
  result.status = 'submitted';
  await result.save();

  await markAttempt(resultId);
  return { ok: true, recovered, failed };
}

export async function markAttempt(resultId) {
  const result = await ExamResult.findById(resultId);
  if (!result) return;

  const exam = await Exam.findById(result.exam).lean();
  if (!exam) {
    result.status = 'submitted';
    await result.save();
    return;
  }

  const failures = [];

  // Speaking tests are stored as sections, not tasks, so exam.tasks is empty
  // for them. Flatten first and look the answer up there, otherwise every
  // question in a Multilevel speaking mock is silently skipped at grading.
  const flat = flattenExam(exam);
  const questionByNumber = new Map(flat.map(q => [q.taskNumber, q]));

  const untranscribed = [];
  const jobs = [];

  for (const taskResult of result.taskResults) {
    const task = exam.tasks.find(t => t.taskNumber === taskResult.taskNumber);
    const question = questionByNumber.get(taskResult.taskNumber);
    if (!task && !question) continue;

    // A recording with no words captured is NOT a wrong answer. The student
    // spoke; the browser simply produced no transcript (common in the in-app
    // browsers inside messaging apps, which have no speech recognition).
    // Scoring it 0 hands back a false A1 for an answer nobody ever read, so
    // set it aside instead: unscored, excluded from the overall mark, and
    // reported honestly. Costs no AI call, so it is settled here and now.
    const hasWords = String(taskResult.transcription || '').trim().length > 0;
    if (!hasWords && taskResult.audioKey) {
      taskResult.status = 'not_transcribed';
      taskResult.finalScore = undefined;
      untranscribed.push(taskResult.taskNumber);
      continue;
    }

    jobs.push(async () => {
      try {
        // The teacher's marked samples for this same part, so the examiner
        // compares against a known standard instead of inventing the scale.
        const anchors = question?.part
          ? await CalibrationSample.anchorsForPart(question.part)
          : [];

        const evaluation = await AIEvaluationService.evaluateTask({
          anchors,
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
        // One failed answer must not discard the whole attempt — recordings and
        // transcripts are kept so it can be marked again later.
        console.error(`Evaluation failed for task ${taskResult.taskNumber}:`, error.message);
        failures.push({ taskNumber: taskResult.taskNumber, error: error.message });
        taskResult.status = 'pending';
      }
    });
  }

  // The answers of one attempt are independent — nothing in answer 5 depends on
  // answer 4 — so they are marked together rather than one after another. Run
  // sequentially, eight answers at ~19s each took ~150s; in parallel an attempt
  // takes about as long as its slowest single answer.
  //
  // Each call still passes through the shared limiter, which caps how many are
  // in flight across the WHOLE server. That cap is what keeps the parallelism
  // from turning into a burst of rate-limit errors when several attempts are
  // being marked at once.
  const startedAt = Date.now();

  /*
   * Pronunciation is measured alongside the marking, not after it.
   *
   * A different service listens to the audio, so it shares nothing with the AI
   * calls and there is no reason to make the student wait for one before the
   * other begins. It is also deliberately outside the AI limiter: that cap
   * exists to protect the Anthropic rate limit, and Azure has its own.
   */
  const [pronunciation] = await Promise.all([
    assessPronunciation(result),
    Promise.all(jobs.map(job => AICallLimiter.run(job)))
  ]);

  if (pronunciation) {
    result.pronunciation = { ...pronunciation, assessedAt: new Date() };

    /*
     * Put the measured scores where the student already looks.
     *
     * The result screen renders whatever criteria an answer carries, so adding
     * them here means pronunciation and fluency appear beside grammar and
     * vocabulary without the client needing to know where they came from. They
     * are the same measurement on every answer — it was sampled for the attempt
     * as a whole — and `measured: true` marks them as observed rather than
     * judged, so nothing downstream mistakes them for the model's opinion.
     *
     * The attempt's own score is NOT touched. It stays the average of what the
     * examiner model marked, so the band boundaries keep meaning exactly what
     * they meant before pronunciation was measurable.
     */
    if (pronunciation.assessed) {
      const asExamScore = value => PronunciationService.toExamScale(value, MAX_SCORE);
      const measured = {};

      if (typeof pronunciation.accuracy === 'number') {
        measured.pronunciation = {
          score: asExamScore(pronunciation.accuracy),
          measured: true,
          feedback: pronunciationFeedback(pronunciation)
        };
      }
      if (typeof pronunciation.fluency === 'number') {
        measured.fluency = {
          score: asExamScore(pronunciation.fluency),
          measured: true,
          feedback: `Nutq ravonligi ${Math.round(pronunciation.fluency)}/100 — ` +
                    `tezlik, to'xtalishlar va ritm bo'yicha o'lchandi.`
        };
      }

      for (const taskResult of result.taskResults) {
        if (taskResult.status !== 'evaluated' || !taskResult.aiEvaluation) continue;
        taskResult.aiEvaluation.criteria = {
          ...(taskResult.aiEvaluation.criteria || {}),
          ...measured
        };
        taskResult.markModified('aiEvaluation.criteria');
      }
    }
  }

  if (jobs.length) {
    // Tokens, not money: the rate changes and a stale dollar figure in a log is
    // worse than an honest count. This is how the cost per mock stops being my
    // arithmetic and starts being a measurement.
    const spend = AIEvaluationService.costSummary;
    console.log(
      `Marked ${jobs.length} answer(s) for ${result._id} in ` +
      `${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
      `since boot: ${spend.calls} calls, ${spend.input} in / ${spend.output} out, ` +
      `cache ${spend.cacheHitRate}% hit (${spend.cacheRead} read / ${spend.cacheWrite} written)`
    );
  }

  const evaluatedCount = result.taskResults.filter(t => t.status === 'evaluated').length;

  if (evaluatedCount === 0) {
    // Nothing could be marked. Drop back to 'submitted' so the attempt is not
    // stuck in 'evaluating', and leave the task statuses as the explanation —
    // the client reads them and tells the student whether this was a
    // transcription problem or a marking one.
    result.status = 'submitted';
    await result.save();
    console.warn(
      `Nothing marked for ${result._id}: ` +
      `${untranscribed.length} untranscribed, ${failures.length} failed`
    );
    return;
  }

  /*
   * The mark comes from the whole performance, as the agency's own method
   * requires: "topshiriqlarning 3 turi bo'yicha umumlashgan baho qo'yiladi" —
   * one generalised judgement across the three task types.
   *
   * So the marker awards the five official criterion bands, 0-6 each, and the
   * published conversion table turns those into the 0-75 figure. Averaging the
   * answers was never how this exam works: it asked a 30-second Part 1.1 reply
   * to prove C1, marked it down when it could not, and pulled genuine C1
   * candidates into the middle of B2.
   *
   * The measured pronunciation goes in with the transcripts, because talaffuz
   * is one of the five criteria and a transcript cannot hear an accent.
   *
   * The old average survives as the fallback. It is wrong in the way described
   * above, but it is wrong in a knowable direction, and a marked attempt with a
   * pessimistic score beats an attempt with no score at all.
   */
  const speakingAnswers = result.taskResults
    .filter(t => t.status === 'evaluated' && String(t.transcription || '').trim())
    .map(t => ({
      part: questionByNumber.get(t.taskNumber)?.part || '—',
      question: questionByNumber.get(t.taskNumber)?.text || '',
      transcription: t.transcription
    }));

  let overall = null;
  if (speakingAnswers.length && result.taskResults.some(t => t.audioKey)) {
    try {
      overall = await AICallLimiter.run(() =>
        AIEvaluationService.evaluateAttempt({
          answers: speakingAnswers,
          examTitle: exam.title,
          pronunciation: result.pronunciation
        })
      );
    } catch (error) {
      console.error(`Overall marking failed for ${result._id}, averaging instead:`, error.message);
    }
  }

  if (overall) {
    result.overallScore = overall.score;
    result.overallLevel = overall.level;
    result.overallFeedback = overall.overallFeedback;
    result.overallReasoning = overall.reasoning;
    result.overallStrengths = overall.strengths;
    result.overallImprovements = overall.areasForImprovement;
    // The bands and the arithmetic that produced the score, kept so the
    // conversion can be corrected later without re-marking anybody.
    result.criterionBands = overall.bands;
    result.rawTotal = overall.raw;
    result.denominator = RAW_MAX;
  } else {
    result.calculateOverallScore();
    result.overallLevel = result.determineCEFRLevel();
  }

  // Passing means reaching B1 — which the agency puts at 38, not the 31 this
  // once used. The old figure let a candidate the agency would not certify at
  // B1 pass a mock that told them they were ready.
  result.isPassed = result.overallScore >= (Number(process.env.PASS_SCORE) || 38);
  result.status = 'completed';
  result.evaluatedAt = new Date();
  result.completedAt = new Date();

  if (result.isPassed) result.generateCertificate();
  await result.save();

  await Exam.findByIdAndUpdate(result.exam, { $inc: { 'statistics.timesUsed': 1 } });
}


export default router;
