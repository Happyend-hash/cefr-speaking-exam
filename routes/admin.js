import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import Exam from '../models/Exam.js';
import ExamResult from '../models/ExamResult.js';
import CalibrationSample from '../models/CalibrationSample.js';
import User, { formatCredits, balanceLabel, wholeMocks, BALANCE_FIELDS, PACKAGE } from '../models/User.js';
import ImageStorageService, {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES
} from '../services/ImageStorageService.js';
import AudioStorageService, {
  ALLOWED_AUDIO_TYPES,
  MAX_AUDIO_BYTES
} from '../services/AudioStorageService.js';
import TranscriptionService from '../services/TranscriptionService.js';
import AIEvaluationService from '../services/AIEvaluationService.js';
import { removeResult } from '../services/AttemptCleanup.js';
import { forgetScore } from '../services/Leaderboard.js';
import { voiceHub } from '../services/VoiceRooms.js';
import { chatHub } from '../services/ChatRooms.js';
import { bandsToScore } from '../services/ScoreConversion.js';
import { isRescuable, rescueAttempt, markAttempt, retranscribeAndMark } from './exam.js';
import { authorize } from '../middleware/auth.js';
import { APIError } from '../middleware/errorHandler.js';

const router = express.Router();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter: (req, file, cb) => {
    const type = (file.mimetype || '').split(';')[0].trim();
    if (ALLOWED_IMAGE_TYPES.includes(type)) return cb(null, true);
    cb(new APIError(`Unsupported image format: ${type}. Use JPEG, PNG, WebP or GIF.`, 400));
  }
});

// Every route below is admin-only. The parent router already authenticates.
router.use(authorize('admin'));

const isValidId = id => mongoose.Types.ObjectId.isValid(id);

/** Editable fields on a question. Anything else in the body is ignored. */
const TASK_FIELDS = [
  'type',
  'part',
  'question',
  'instructions',
  'images',
  'followUpQuestions',
  'timeLimit',
  'minWords',
  'scoringCriteria',
  'sampleAnswer'
];

function pickTaskFields(body) {
  const task = {};
  for (const field of TASK_FIELDS) {
    if (body[field] !== undefined) task[field] = body[field];
  }
  return task;
}

async function loadExam(id) {
  if (!isValidId(id)) throw new APIError('Invalid test id', 400);
  const exam = await Exam.findById(id);
  if (!exam) throw new APIError('Test not found', 404);
  return exam;
}

/**
 * Renumber tasks 1..n after an insert or delete so numbering never has gaps.
 * Task numbers are what candidates see and what results reference, so they must
 * stay contiguous and in display order.
 */
function resequence(exam) {
  exam.tasks.forEach((task, index) => {
    task.taskNumber = index + 1;
  });
  exam.calculateDuration();
}

/**
 * @route   GET /api/admin/tests
 * @desc    Every test, published or not, with its questions
 */
router.get('/tests', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.module) filter.module = req.query.module;

    const exams = await Exam.find(filter).sort({ module: 1, title: 1 }).lean();

    res.json({
      success: true,
      data: exams.map(exam => ({
        id: exam._id,
        title: exam.title,
        module: exam.module,
        description: exam.description,
        isPublished: exam.isPublished,
        isActive: exam.isActive,
        duration: exam.duration,
        sections: (exam.sections || []).map((s, index) => ({
          index,
          part: s.part,
          title: s.title,
          instructions: s.instructions,
          images: s.images || [],
          topic: s.topic,
          pros: s.pros || [],
          cons: s.cons || [],
          questions: (s.questions || []).map((q, qIndex) => ({
            index: qIndex,
            text: q.text,
            prepTime: q.prepTime,
            answerTime: q.answerTime
          }))
        })),
        totalQuestions: (exam.sections || []).reduce((n, s) => n + (s.questions?.length || 0), 0),
        totalTasks: exam.tasks.length,
        tasks: exam.tasks.map(t => ({
          taskNumber: t.taskNumber,
          part: t.part,
          type: t.type,
          question: t.question,
          instructions: t.instructions,
          images: t.images || [],
          followUpQuestions: t.followUpQuestions || [],
          timeLimit: t.timeLimit,
          minWords: t.minWords
        }))
      }))
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/admin/tests
 * @desc    Create a test
 */
router.post('/tests', async (req, res, next) => {
  try {
    const { title, module = 'speaking', description, isPublished = false } = req.body;
    if (!title || !String(title).trim()) throw new APIError('A title is required', 400);

    const exam = await Exam.create({
      title: String(title).trim(),
      module,
      description,
      isPublished,
      publishedAt: isPublished ? new Date() : undefined,
      tasks: [],
      createdBy: req.user.id,
      updatedBy: req.user.id
    });

    res.status(201).json({
      success: true,
      message: 'Test created',
      data: { id: exam._id, title: exam.title, module: exam.module }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/admin/tests/:id
 * @desc    Rename a test, change its module, or publish/unpublish it
 */
router.patch('/tests/:id', async (req, res, next) => {
  try {
    const exam = await loadExam(req.params.id);
    const { title, module, description, isPublished, isActive } = req.body;

    if (title !== undefined) exam.title = String(title).trim();
    if (module !== undefined) exam.module = module;
    if (description !== undefined) exam.description = description;
    if (isActive !== undefined) exam.isActive = Boolean(isActive);
    if (isPublished !== undefined) {
      exam.isPublished = Boolean(isPublished);
      if (exam.isPublished && !exam.publishedAt) exam.publishedAt = new Date();
    }

    exam.updatedBy = req.user.id;
    await exam.save();

    res.json({ success: true, message: 'Test updated', data: { id: exam._id } });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/admin/tests/:id
 * @desc    Delete a test. Refused while attempts reference it, so results are
 *          never orphaned — unpublish instead to retire a test safely.
 */
router.delete('/tests/:id', async (req, res, next) => {
  try {
    const exam = await loadExam(req.params.id);

    const attempts = await ExamResult.countDocuments({ exam: exam._id });
    if (attempts > 0 && req.query.force !== 'true') {
      throw new APIError(
        `${attempts} student attempt(s) reference this test. Unpublish it instead, or repeat with ?force=true to delete anyway.`,
        409
      );
    }

    await exam.deleteOne();
    res.json({ success: true, message: 'Test deleted' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/admin/tests/:id/tasks
 * @desc    Add a question to a test
 */
router.post('/tests/:id/tasks', async (req, res, next) => {
  try {
    const exam = await loadExam(req.params.id);
    const task = pickTaskFields(req.body);

    if (!task.question || !String(task.question).trim()) {
      throw new APIError('The question text is required', 400);
    }
    if (!task.type) throw new APIError('A question type is required', 400);

    // Insert at a chosen position when given, otherwise append.
    const position = Number(req.body.position);
    const index = Number.isInteger(position) && position >= 1
      ? Math.min(position - 1, exam.tasks.length)
      : exam.tasks.length;

    exam.tasks.splice(index, 0, { ...task, taskNumber: index + 1 });
    resequence(exam);
    exam.updatedBy = req.user.id;
    await exam.save();

    res.status(201).json({
      success: true,
      message: 'Question added',
      data: { totalTasks: exam.tasks.length }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/admin/tests/:id/tasks/:taskNumber
 * @desc    Edit a question
 */
router.patch('/tests/:id/tasks/:taskNumber', async (req, res, next) => {
  try {
    const exam = await loadExam(req.params.id);
    const taskNumber = Number(req.params.taskNumber);
    const task = exam.tasks.find(t => t.taskNumber === taskNumber);
    if (!task) throw new APIError(`Question ${taskNumber} not found`, 404);

    const updates = pickTaskFields(req.body);
    if (updates.question !== undefined && !String(updates.question).trim()) {
      throw new APIError('The question text cannot be empty', 400);
    }
    Object.assign(task, updates);

    exam.calculateDuration();
    exam.updatedBy = req.user.id;
    await exam.save();

    res.json({ success: true, message: 'Question updated' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/admin/tests/:id/tasks/:taskNumber
 * @desc    Remove a question. Remaining questions are renumbered.
 */
router.delete('/tests/:id/tasks/:taskNumber', async (req, res, next) => {
  try {
    const exam = await loadExam(req.params.id);
    const taskNumber = Number(req.params.taskNumber);
    const index = exam.tasks.findIndex(t => t.taskNumber === taskNumber);
    if (index === -1) throw new APIError(`Question ${taskNumber} not found`, 404);

    exam.tasks.splice(index, 1);
    resequence(exam);
    exam.updatedBy = req.user.id;
    await exam.save();

    res.json({
      success: true,
      message: 'Question removed',
      data: { totalTasks: exam.tasks.length }
    });
  } catch (error) {
    next(error);
  }
});

// ===========================================================================
// SECTIONS — the Multilevel speaking structure
// ===========================================================================

const SECTION_FIELDS = ['part', 'title', 'instructions', 'images', 'topic', 'pros', 'cons'];

function pickSectionFields(body) {
  const section = {};
  for (const field of SECTION_FIELDS) {
    if (body[field] !== undefined) section[field] = body[field];
  }
  return section;
}

/** Default timings per part, so a new question starts with the real exam's values. */
const PART_DEFAULTS = {
  '1.1': { prepTime: 5, answerTime: 30 },
  '1.2': { prepTime: 5, answerTime: 30 },
  '2': { prepTime: 60, answerTime: 120 },
  '3': { prepTime: 60, answerTime: 120 }
};

/**
 * @route   POST /api/admin/tests/:id/sections
 * @desc    Add a section (a part with its shared stimulus)
 */
router.post('/tests/:id/sections', async (req, res, next) => {
  try {
    const exam = await loadExam(req.params.id);
    const section = pickSectionFields(req.body);

    if (!section.part) throw new APIError('A part label is required (1.1, 1.2, 2 or 3)', 400);

    exam.sections.push({ ...section, questions: [] });
    exam.calculateDuration();
    exam.updatedBy = req.user.id;
    await exam.save();

    res.status(201).json({
      success: true,
      message: `Part ${section.part} added`,
      data: { sectionIndex: exam.sections.length - 1 }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/admin/tests/:id/sections/:index
 * @desc    Edit a section's stimulus — images, topic, pros and cons
 */
router.patch('/tests/:id/sections/:index', async (req, res, next) => {
  try {
    const exam = await loadExam(req.params.id);
    const section = exam.sections[Number(req.params.index)];
    if (!section) throw new APIError('Section not found', 404);

    Object.assign(section, pickSectionFields(req.body));
    exam.calculateDuration();
    exam.updatedBy = req.user.id;
    await exam.save();

    res.json({ success: true, message: 'Part updated' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/admin/tests/:id/sections/:index
 * @desc    Remove a section and all of its questions
 */
router.delete('/tests/:id/sections/:index', async (req, res, next) => {
  try {
    const exam = await loadExam(req.params.id);
    const index = Number(req.params.index);
    if (!exam.sections[index]) throw new APIError('Section not found', 404);

    exam.sections.splice(index, 1);
    exam.calculateDuration();
    exam.updatedBy = req.user.id;
    await exam.save();

    res.json({ success: true, message: 'Part removed' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/admin/tests/:id/sections/:index/questions
 * @desc    Add a question to a section
 */
router.post('/tests/:id/sections/:index/questions', async (req, res, next) => {
  try {
    const exam = await loadExam(req.params.id);
    const section = exam.sections[Number(req.params.index)];
    if (!section) throw new APIError('Section not found', 404);

    const { text } = req.body;
    if (!text || !String(text).trim()) throw new APIError('Question text is required', 400);

    const defaults = PART_DEFAULTS[section.part] || { prepTime: 5, answerTime: 30 };

    section.questions.push({
      text: String(text).trim(),
      prepTime: Number(req.body.prepTime) || defaults.prepTime,
      answerTime: Number(req.body.answerTime) || defaults.answerTime
    });

    exam.calculateDuration();
    exam.updatedBy = req.user.id;
    await exam.save();

    res.status(201).json({ success: true, message: 'Question added' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/admin/tests/:id/sections/:index/questions/:qIndex
 */
router.patch('/tests/:id/sections/:index/questions/:qIndex', async (req, res, next) => {
  try {
    const exam = await loadExam(req.params.id);
    const section = exam.sections[Number(req.params.index)];
    if (!section) throw new APIError('Section not found', 404);

    const question = section.questions[Number(req.params.qIndex)];
    if (!question) throw new APIError('Question not found', 404);

    if (req.body.text !== undefined) {
      if (!String(req.body.text).trim()) throw new APIError('Question text cannot be empty', 400);
      question.text = String(req.body.text).trim();
    }
    if (req.body.prepTime !== undefined) question.prepTime = Number(req.body.prepTime);
    if (req.body.answerTime !== undefined) question.answerTime = Number(req.body.answerTime);

    exam.calculateDuration();
    exam.updatedBy = req.user.id;
    await exam.save();

    res.json({ success: true, message: 'Question updated' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/admin/tests/:id/sections/:index/questions/:qIndex
 */
router.delete('/tests/:id/sections/:index/questions/:qIndex', async (req, res, next) => {
  try {
    const exam = await loadExam(req.params.id);
    const section = exam.sections[Number(req.params.index)];
    if (!section) throw new APIError('Section not found', 404);

    const qIndex = Number(req.params.qIndex);
    if (!section.questions[qIndex]) throw new APIError('Question not found', 404);

    section.questions.splice(qIndex, 1);
    exam.calculateDuration();
    exam.updatedBy = req.user.id;
    await exam.save();

    res.json({ success: true, message: 'Question removed' });
  } catch (error) {
    next(error);
  }
});

// ===========================================================================
// IMAGES
// ===========================================================================

/**
 * @route   POST /api/admin/images
 * @desc    Upload an exam image. Returns the URL to put on a section.
 */
router.post('/images', imageUpload.single('image'), async (req, res, next) => {
  try {
    if (!req.file?.buffer?.length) throw new APIError('No image was uploaded', 400);

    const stored = await ImageStorageService.store(req.file.buffer, {
      filename: req.file.originalname,
      contentType: (req.file.mimetype || '').split(';')[0].trim(),
      uploadedBy: req.user.id
    });

    res.status(201).json({ success: true, message: 'Image uploaded', data: stored });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/admin/images
 * @desc    Previously uploaded images, newest first
 */
router.get('/images', async (req, res, next) => {
  try {
    res.json({ success: true, data: await ImageStorageService.list(100) });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/admin/images/:key
 */
router.delete('/images/:key', async (req, res, next) => {
  try {
    await ImageStorageService.delete(req.params.key);
    res.json({ success: true, message: 'Image deleted' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/admin/overview
 * @desc    Headline numbers for the admin screen
 */
router.get('/overview', async (req, res, next) => {
  try {
    const [students, tests, published, attempts, completed] = await Promise.all([
      User.countDocuments({ role: 'student' }),
      Exam.countDocuments(),
      Exam.countDocuments({ isPublished: true, isActive: true }),
      ExamResult.countDocuments(),
      ExamResult.countDocuments({ status: 'completed' })
    ]);

    res.json({
      success: true,
      data: { students, tests, published, attempts, completed }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The calibration library.
 *
 * Marked sample answers the examiner is shown alongside the answer it is
 * judging, so it compares against the teacher's standard instead of inventing a
 * scale. See models/CalibrationSample.js for why this is the highest-value fix.
 *
 * Samples arrive two ways: a recording uploaded from outside, transcribed here;
 * or a transcript typed in directly. Either way the teacher supplies the mark —
 * that judgement is the whole point, and nothing else in the system can provide
 * it.
 */

const sampleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES },
  fileFilter: (req, file, cb) => {
    const type = (file.mimetype || '').split(';')[0].trim();
    if (ALLOWED_AUDIO_TYPES.includes(type)) return cb(null, true);
    cb(new APIError(`Unsupported audio format: ${type}`, 400));
  }
});

/**
 * @route   GET /api/admin/calibration
 * @desc    Every sample, with a note on where the set is thin.
 */
router.get('/calibration', async (req, res, next) => {
  try {
    const samples = await CalibrationSample.find().sort({ part: 1, score: 1 }).lean();

    // Spread is what teaches the scale, so the gaps matter more than the count.
    // A part with four C1 samples and nothing below is worse calibrated than one
    // with a single sample at each of B1, B2 and C1.
    const PARTS = ['1.1', '1.2', '2', '3'];
    const coverage = PARTS.map(part => {
      const mine = samples.filter(s => s.part === part && s.isActive);
      return {
        part,
        total: mine.length,
        levels: [...new Set(mine.map(s => s.level))].sort(),
        missing: ['B1', 'B2', 'C1'].filter(l => !mine.some(s => s.level === l))
      };
    });

    res.json({
      success: true,
      data: {
        coverage,
        samples: samples.map(s => ({
          id: s._id,
          part: s.part,
          level: s.level,
          score: s.score,
          scoreSource: s.scoreSource,
          question: s.question,
          transcription: s.transcription,
          notes: s.notes,
          isActive: s.isActive,
          hasAudio: Boolean(s.audioKey),
          audioUrl: s.audioKey ? `/api/exam/audio/${s.audioKey}` : null,
          createdAt: s.createdAt
        }))
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/admin/calibration
 * @desc    Add a sample, from an uploaded recording or a typed transcript.
 */
router.post('/calibration', sampleUpload.single('audio'), async (req, res, next) => {
  try {
    const { part, level, score, question, notes, scoreSource } = req.body;

    if (!['1.1', '1.2', '2', '3'].includes(part)) {
      throw new APIError('Choose which part this answer belongs to.', 400);
    }
    const mark = Number(score);
    if (!Number.isFinite(mark) || mark < 0 || mark > 75) {
      throw new APIError('Give a score between 0 and 75.', 400);
    }
    if (!['A1', 'A2', 'B1', 'B2', 'C1'].includes(level)) {
      throw new APIError('Choose the level this answer represents.', 400);
    }

    let transcription = String(req.body.transcription || '').trim();
    let audioKey = null;

    if (req.file?.buffer?.length) {
      const stored = await AudioStorageService.store(req.file.buffer, {
        filename: `calibration-part-${part}-${level}.webm`,
        contentType: (req.file.mimetype || '').split(';')[0].trim(),
        studentId: req.user.id,
        resultId: null,
        taskNumber: 0
      });
      audioKey = stored.audioKey;

      // Transcribe here rather than asking the teacher to type it out: the
      // marker reads transcripts, so a sample has to be a transcript produced
      // the same way, or it is teaching the model against a different medium.
      if (!transcription) {
        const { text } = await TranscriptionService.transcribe(req.file.buffer, {
          filename: `calibration-part-${part}.webm`,
          contentType: (req.file.mimetype || 'audio/webm').split(';')[0].trim()
        });
        transcription = String(text || '').trim();
      }
    }

    if (!transcription) {
      throw new APIError(
        audioKey
          ? 'No words could be heard in that recording, so it cannot be used as a sample.'
          : 'Upload a recording or paste the transcript.',
        400
      );
    }

    const sample = await CalibrationSample.create({
      part,
      level,
      score: Math.round(mark),
      scoreSource: scoreSource === 'real-exam' ? 'real-exam' : 'teacher-estimate',
      question: question || '',
      notes: notes || '',
      transcription,
      audioKey,
      addedBy: req.user.id
    });

    res.status(201).json({
      success: true,
      message: `Sample added for Part ${part} at ${level}.`,
      data: { id: sample._id, transcription }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/admin/calibration/:id
 * @desc    Correct a sample's mark, or take it out of use.
 */
router.patch('/calibration/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid sample id', 400);
    const sample = await CalibrationSample.findById(req.params.id);
    if (!sample) throw new APIError('Sample not found', 404);

    const { score, level, notes, isActive, scoreSource } = req.body;
    if (score !== undefined) {
      const mark = Number(score);
      if (!Number.isFinite(mark) || mark < 0 || mark > 75) {
        throw new APIError('Give a score between 0 and 75.', 400);
      }
      sample.score = Math.round(mark);
    }
    if (level !== undefined) sample.level = level;
    if (notes !== undefined) sample.notes = notes;
    if (isActive !== undefined) sample.isActive = Boolean(isActive);
    if (scoreSource !== undefined) sample.scoreSource = scoreSource;

    await sample.save();
    res.json({ success: true, message: 'Sample updated', data: { id: sample._id } });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/admin/calibration/:id
 */
router.delete('/calibration/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid sample id', 400);
    const sample = await CalibrationSample.findById(req.params.id);
    if (!sample) throw new APIError('Sample not found', 404);

    if (sample.audioKey) await AudioStorageService.delete(sample.audioKey);
    await sample.deleteOne();

    res.json({ success: true, message: 'Sample removed' });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/admin/calibration/check
 * @desc    Mark the samples themselves and report the examiner's score beside
 *          the teacher's.
 *
 * A wrongly scored sample is inherited silently by every marking that follows,
 * so calibration needs a way to be wrong out loud. If the teacher says 67 and
 * the examiner still says 54, the anchors are not landing — and that should be
 * discovered from a button, not from a confused student.
 */
router.post('/calibration/check', async (req, res, next) => {
  try {
    const samples = await CalibrationSample.find({ isActive: true }).lean();
    if (!samples.length) {
      return res.json({
        success: true,
        message: 'No samples to check yet.',
        data: { checked: [], averageGap: null }
      });
    }

    const checked = [];
    for (const sample of samples) {
      try {
        // Marked against the OTHER samples, never itself — a sample that can see
        // its own answer key proves nothing.
        const anchors = (await CalibrationSample.anchorsForPart(sample.part))
          .filter(a => String(a._id) !== String(sample._id));

        const evaluation = await AIEvaluationService.evaluateTask({
          transcription: sample.transcription,
          taskType: 'speaking',
          question: sample.question || 'Sample answer',
          part: sample.part,
          anchors
        });

        checked.push({
          id: String(sample._id),
          part: sample.part,
          level: sample.level,
          teacherScore: sample.score,
          examinerScore: evaluation.score,
          gap: evaluation.score - sample.score
        });
      } catch (error) {
        checked.push({
          id: String(sample._id),
          part: sample.part,
          teacherScore: sample.score,
          error: error.message
        });
      }
    }

    const gaps = checked.filter(c => typeof c.gap === 'number').map(c => c.gap);
    const averageGap = gaps.length
      ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10
      : null;

    res.json({
      success: true,
      message: averageGap === null
        ? 'Nothing could be checked.'
        : `The examiner is ${averageGap > 0 ? 'above' : 'below'} your marks by ${Math.abs(averageGap)} on average.`,
      data: { checked, averageGap }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Re-marking attempts that were read perfectly well.
 *
 * Distinct from the rescue below, and easy to confuse with it. A rescue is for
 * recordings nobody ever transcribed; this is for attempts whose transcripts
 * were always fine but whose SCORE was produced by marking that has since
 * changed. Nothing is re-transcribed and no audio is touched — the same words
 * go through the current marking.
 *
 * Scoped to one person by design. Re-marking is not free: a full attempt is
 * eight answers plus the whole-performance pass, so re-marking everybody to
 * check one change would spend a great deal of somebody's quota to answer a
 * question one attempt can answer.
 */

/** The student whose attempts a re-mark would cover, from an email or the caller. */
/**
 * Which attempts "mark again" should touch.
 *
 * 'completed' is the obvious one: work already marked, to be marked again under
 * changed scoring.
 *
 * 'submitted' is the one that was missing, and its absence left a real gap. An
 * attempt whose marking failed drops back to 'submitted' — transcripts intact,
 * recordings intact, simply unmarked. Rescue does not cover it either, because
 * rescue exists for attempts whose TRANSCRIPTS are missing. So an attempt
 * broken by a marking fault fell between the two tools and showed the student
 * "Tekshirilmoqda..." with nothing able to reach it.
 *
 * 'evaluating' is deliberately excluded: an attempt in that state may be being
 * marked right now, and marking it twice at once would have two passes writing
 * over each other.
 */
const REMARKABLE = ['completed', 'submitted'];

async function resolveStudent(email, fallbackId) {
  if (!email) return fallbackId;
  const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select('_id');
  if (!user) throw new APIError(`No account found for ${email}.`, 404);
  return user._id;
}

/**
 * @route   GET /api/admin/results/remark
 * @desc    Count what a re-mark would cover. Changes nothing.
 */
router.get('/results/remark', async (req, res, next) => {
  try {
    const student = await resolveStudent(req.query.email, req.user.id);
    const attempts = await ExamResult.countDocuments({
      student,
      status: { $in: REMARKABLE }
    });

    res.json({
      success: true,
      data: {
        attempts,
        // Eight answers and one whole-performance pass per attempt: worth
        // showing, because it is the teacher's API quota being spent.
        aiCalls: attempts * 9,
        email: req.query.email || 'your own account'
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/admin/results/remark
 * @desc    Mark those attempts again with the current scoring.
 */
router.post('/results/remark', async (req, res, next) => {
  try {
    const student = await resolveStudent(req.body?.email, req.user.id);
    const attempts = await ExamResult.find({ student, status: { $in: REMARKABLE } })
      .select('_id')
      .lean();

    if (!attempts.length) {
      return res.json({
        success: true,
        message: 'No completed attempts to re-mark.',
        data: { started: 0 }
      });
    }

    const ids = attempts.map(a => String(a._id));

    // Read the recordings again first, so hesitations ("umm", "eee") that the
    // old transcripts dropped are counted. Costs transcription (about 2 US
    // cents per full mock) on top of marking.
    const retranscribe = req.body?.retranscribe === true;

    // One at a time, and after the response, for the same reason the rescue is:
    // marking a full attempt takes long enough that holding the request open
    // only invites closing the tab half way through.
    (async () => {
      for (const id of ids) {
        try {
          if (retranscribe) await retranscribeAndMark(id);
          else await markAttempt(id);
        } catch (error) {
          console.error(`Re-mark failed for ${id}:`, error.message);
        }
      }
      console.log(`Re-marked ${ids.length} attempt(s)${retranscribe ? ', transcripts refreshed' : ''}`);
    })();

    res.status(202).json({
      success: true,
      message: `Re-marking ${ids.length} attempt(s). Scores update as each finishes.`,
      data: { started: ids.length }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Rescuing attempts that were never read.
 *
 * A batch of attempts came back as zeros because the recordings arrived with no
 * words attached — most mobile browsers have no speech recognition, and at the
 * time that was the only transcriber. The audio was always fine. It was never
 * read, and the student was handed a false A1 for an answer nobody had seen.
 *
 * Server-side transcription fixed the cause, and the recordings are still in
 * storage, so those attempts are recoverable rather than rubbish. Deleting them
 * would destroy work that can be turned into a real score instead.
 */

/**
 * @route   GET /api/admin/results/rescue
 * @desc    Count attempts holding recordings that were never transcribed.
 */
router.get('/results/rescue', authorize('admin'), async (req, res, next) => {
  try {
    // Anything that finished badly, or never finished at all. Attempts still in
    // progress are excluded: a student may simply be part-way through one.
    const candidates = await ExamResult.find({
      status: { $in: ['completed', 'submitted'] }
    }).select('student taskResults overallScore status').lean();

    const rescuable = candidates.filter(isRescuable);

    res.json({
      success: true,
      data: {
        attempts: rescuable.length,
        students: new Set(rescuable.map(r => String(r.student))).size,
        answers: rescuable.reduce(
          (sum, r) => sum + (r.taskResults || []).filter(
            t => t.audioKey && !String(t.transcription || '').trim()
          ).length,
          0
        )
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/admin/results/rescue
 * @desc    Transcribe those recordings and mark the attempts properly.
 *
 * Returns as soon as the work is under way. Re-reading and re-marking a class's
 * worth of attempts takes minutes, and holding the teacher's browser open for
 * it would only invite them to close the tab half way and wonder what happened.
 * Each attempt updates itself as it finishes, exactly as a fresh one does.
 */
router.post('/results/rescue', authorize('admin'), async (req, res, next) => {
  try {
    const candidates = await ExamResult.find({
      status: { $in: ['completed', 'submitted'] }
    }).select('_id taskResults').lean();

    const ids = candidates.filter(isRescuable).map(r => String(r._id));
    if (!ids.length) {
      return res.json({
        success: true,
        message: 'Nothing to rescue — every attempt with a recording has been read.',
        data: { started: 0 }
      });
    }

    // One at a time, deliberately. Each rescue transcribes several recordings
    // and then marks them, and firing fifty at once would collide with the
    // students actually sitting exams right now.
    (async () => {
      let rescued = 0;
      for (const id of ids) {
        try {
          const outcome = await rescueAttempt(id);
          if (outcome.ok) rescued += 1;
          else console.warn(`Rescue skipped ${id}: ${outcome.reason}`);
        } catch (error) {
          console.error(`Rescue failed for ${id}:`, error.message);
        }
      }
      console.log(`Rescue finished: ${rescued}/${ids.length} attempt(s) recovered`);
    })();

    res.status(202).json({
      success: true,
      message: `Re-reading ${ids.length} attempt(s). Scores will appear as each one finishes.`,
      data: { started: ids.length }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Clearing attempts.
 *
 * Attempts marked before the scale changed, and the zeros left by the spell
 * when phones captured no words, now feed every student's best score, level
 * and skills chart. A stale zero visibly drags down a student who did nothing
 * wrong, and an old score out of 100 reads as a far higher level than it was.
 *
 * Two endpoints rather than one, deliberately. Deleting an attempt destroys the
 * student's recordings with it and cannot be undone, so the count is fetched
 * first and the button that does it says exactly what will go. A confirmation
 * dialog that says "are you sure?" without saying "sure about what" is not a
 * safeguard.
 */

/** Which attempts a clear would take, given the query. */
function purgeFilter({ before, onlyZeros }) {
  const filter = {};

  if (before) {
    const cutoff = new Date(before);
    if (Number.isNaN(cutoff.getTime())) throw new APIError('That is not a valid date.', 400);
    filter.completedAt = { $lt: cutoff };
  }

  // An attempt that scored nothing is almost always a recording that was never
  // transcribed, not a student who said nothing worth marking.
  if (onlyZeros) filter.overallScore = 0;

  // An empty filter matches every attempt ever taken. The screen will not send
  // one, but a screen is not a safeguard — the rule belongs on the side that
  // does the deleting.
  if (!Object.keys(filter).length) {
    throw new APIError(
      'Narrow this down: give a date, or restrict it to attempts that scored 0. ' +
      'An unrestricted clear would delete every attempt ever taken.',
      400
    );
  }

  return filter;
}

/**
 * @route   GET /api/admin/results/purge
 * @desc    Count what a clear would remove. Changes nothing.
 */
router.get('/results/purge', authorize('admin'), async (req, res, next) => {
  try {
    const filter = purgeFilter({
      before: req.query.before,
      onlyZeros: req.query.onlyZeros === 'true'
    });

    const results = await ExamResult.find(filter).select('student taskResults').lean();
    const recordings = results.reduce(
      (sum, r) => sum + (r.taskResults || []).filter(t => t.audioKey).length,
      0
    );

    res.json({
      success: true,
      data: {
        attempts: results.length,
        recordings,
        students: new Set(results.map(r => String(r.student))).size
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/admin/results/purge
 * @desc    Delete those attempts and their recordings. Irreversible.
 */
router.post('/results/purge', authorize('admin'), async (req, res, next) => {
  try {
    const { before, onlyZeros, confirm } = req.body || {};

    // The client has to say what it expects to delete. Without this, a stale
    // page could delete a far larger set than the teacher was shown.
    if (typeof confirm !== 'number') {
      throw new APIError('Confirm the number of attempts to delete.', 400);
    }

    const filter = purgeFilter({ before, onlyZeros });
    const results = await ExamResult.find(filter);

    if (results.length !== confirm) {
      throw new APIError(
        `The number of attempts changed since you checked — ${results.length} match now, not ${confirm}. ` +
        `Check again before deleting.`,
        409
      );
    }

    let deleted = 0;
    let recordings = 0;
    const refused = [];

    for (const result of results) {
      // Shares the same rule the students' own delete uses: an attempt is never
      // removed while its recordings survive, so history can never claim
      // something is gone while a student's voice is still stored.
      const outcome = await removeResult(result);
      if (outcome.ok) {
        // A teacher clearing an attempt means it should never have counted —
        // unlike a student deleting their own, which keeps the score.
        await forgetScore(result._id);
        deleted += 1;
        recordings += outcome.recordingsDeleted;
      } else {
        refused.push({ id: String(result._id), reason: outcome.reason });
      }
    }

    console.log(`Admin cleared ${deleted} attempt(s) and ${recordings} recording(s)`);

    res.json({
      success: true,
      message: `Deleted ${deleted} attempt(s) and ${recordings} recording(s).`,
      data: { deleted, recordings, refused }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Students and their access.
 *
 * The teacher pays for every attempt, so the decision about who may spend that
 * money has to be visible in one place and changeable in one click. Two knobs,
 * kept separate on purpose (see models/User.js):
 *
 *   blocked          — a decision about the person. Stops them outright, keeps
 *                      whatever mocks they had for when they come back.
 *   examsRemaining    — a balance. Runs down as attempts are created.
 *
 * Payment happens outside the app, in cash or by transfer. Nothing here tries to
 * take money; it records that the teacher decided someone has paid, which is the
 * only part the software can honestly know.
 */

const MAX_GRANT = 100;

/** One row of the students table, from a lean user document. */
function studentRow(user, activity) {
  const stats = activity.get(String(user._id)) || {};
  return {
    id: String(user._id),
    email: user.email,
    name: [user.firstName, user.lastName].filter(Boolean).join(' '),
    role: user.role,
    status: user.status,
    blocked: Boolean(user.access?.blocked),
    remaining: user.subscription?.examsRemaining ?? 0,
    // Change left over from single parts, in twelfths of a mock.
    partCredits: user.subscription?.partCredits ?? 0,
    credits: formatCredits(user.subscription?.examsRemaining, user.subscription?.partCredits),
    // Writing is a separate balance.
    writingRemaining: wholeMocks(user, 'writing'),
    writingPartCredits: user.subscription?.writingPartCredits ?? 0,
    writingCredits: balanceLabel(user, 'writing'),
    granted: user.access?.totalGranted || 0,
    note: user.access?.note || '',
    pendingMessage: user.access?.message || '',
    attempts: stats.attempts || 0,
    completed: stats.completed || 0,
    lastAttemptAt: stats.lastAttemptAt || null,
    joinedAt: user.createdAt
  };
}

/**
 * @route   GET /api/admin/students
 * @desc    Everyone who can sign in, with what they have used and what is left
 *
 * Attempt counts come from one aggregate over the listed students rather than a
 * query per row: a class of forty would otherwise be forty round trips to show
 * one table.
 */
router.get('/students', async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim();
    const limit = Math.min(Number(req.query.limit) || 100, 300);

    const filter = {};
    if (search) {
      // Escaped, so a student searching for "a.b" cannot become a pattern.
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(safe, 'i');
      filter.$or = [{ email: rx }, { firstName: rx }, { lastName: rx }];
    }
    if (req.query.only === 'blocked') filter['access.blocked'] = true;
    if (req.query.only === 'out') filter['subscription.examsRemaining'] = { $lte: 0 };

    const users = await User.find(filter)
      .select('email firstName lastName role status access subscription createdAt')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const ids = users.map(u => u._id);
    const grouped = await ExamResult.aggregate([
      { $match: { student: { $in: ids } } },
      {
        $group: {
          _id: '$student',
          attempts: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          lastAttemptAt: { $max: '$createdAt' }
        }
      }
    ]);

    const activity = new Map(grouped.map(g => [String(g._id), g]));

    res.json({
      success: true,
      data: {
        students: users.map(u => studentRow(u, activity)),
        total: await User.countDocuments(filter),
        shown: users.length,
        // How many accounts a block-everyone would touch. Counted here, on the
        // same rule the bulk route uses, so the confirmation the client sends
        // back means the same thing on both sides even when the table is
        // filtered or longer than one page.
        studentCount: await User.countDocuments({ role: 'student' }),
        // So the panel can tell the teacher whether students have anywhere to
        // send a payment to, instead of quietly showing them a dead end.
        contact: process.env.TELEGRAM_CONTACT || '',
        // What "Add package" grants, so the button says exactly that.
        package: PACKAGE
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/admin/students/:id/access
 * @desc    Grant mocks, set a balance, block or unblock one student
 *
 * Granting also writes the student a one-line notice, because a payment made
 * outside the app needs a confirmation inside it — otherwise the student has
 * paid and has no way to see that it landed until they try to start a test.
 */
router.post('/students/:id/access', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid student id', 400);

    const { action, amount, note, message } = req.body || {};
    const user = await User.findById(req.params.id);
    if (!user) throw new APIError('Student not found', 404);

    if (!user.access) user.access = {};
    let outcome = '';

    // Which balance. Speaking unless told otherwise, so anything that called
    // this before writing existed still does what it did.
    const module = req.body?.module === 'writing' ? 'writing' : 'speaking';
    const [wholeField, partField] = BALANCE_FIELDS[module];
    const both = () =>
      `speaking ${balanceLabel(user, 'speaking')}, writing ${balanceLabel(user, 'writing')}`;

    const confirmPayment = text => {
      user.access.lastGrantedAt = new Date();
      user.access.lastGrantedBy = req.user.email || String(req.user.id);
      // Uzbek, because this is read by the student on their own dashboard,
      // where every other instruction is already in Uzbek.
      user.access.message = String(message || '').trim() || text;
      user.access.messageAt = new Date();
    };

    if (action === 'package') {
      // The standard package: 4 speaking + 3 writing (PACKAGE_SPEAKING /
      // PACKAGE_WRITING to change it). Added on top of whatever is left.
      const before = both();
      user.subscription.examsRemaining = (user.subscription.examsRemaining || 0) + PACKAGE.speaking;
      user.subscription.writingRemaining = (user.subscription.writingRemaining || 0) + PACKAGE.writing;
      user.access.totalGranted = (user.access.totalGranted || 0) + PACKAGE.speaking;
      user.access.totalWritingGranted = (user.access.totalWritingGranted || 0) + PACKAGE.writing;
      confirmPayment(
        `To'lovingiz tasdiqlandi. Hisobingizga ${PACKAGE.speaking} ta speaking va ${PACKAGE.writing} ta writing mock qo'shildi.`
      );
      outcome = `${user.email}: package added — ${before} → ${both()}`;
    } else if (action === 'grant' || action === 'set') {
      const value = Number(amount);
      if (!Number.isInteger(value) || value < 0 || value > MAX_GRANT) {
        throw new APIError(`Give a whole number of mocks between 0 and ${MAX_GRANT}.`, 400);
      }

      const before = balanceLabel(user, module);
      user.subscription[wholeField] =
        action === 'grant' ? (user.subscription[wholeField] || 0) + value : value;
      // "Set to 5" means exactly 5: any leftover part-credit goes.
      // "Add 5" keeps it — the student already paid for that part.
      if (action === 'set') user.subscription[partField] = 0;

      if (action === 'grant' && value > 0) {
        if (module === 'writing') {
          user.access.totalWritingGranted = (user.access.totalWritingGranted || 0) + value;
        } else {
          user.access.totalGranted = (user.access.totalGranted || 0) + value;
        }
        confirmPayment(`To'lovingiz tasdiqlandi. Hisobingizga ${value} ta ${module} mock qo'shildi.`);
      }

      outcome = `${user.email}: ${module} ${before} → ${balanceLabel(user, module)} mock(s)`;
    } else if (action === 'block') {
      user.access.blocked = true;
      user.access.blockedAt = new Date();
      // Out of any speaking room at once, not only out of the next one.
      voiceHub.kick(String(user._id), 'Your teacher has paused your access.');
      chatHub.kick(String(user._id), 'Your teacher has paused your access.');
      outcome = `${user.email} blocked`;
    } else if (action === 'unblock') {
      user.access.blocked = false;
      user.access.blockedAt = null;
      outcome = `${user.email} unblocked`;
    } else {
      throw new APIError('Unknown action. Use package, grant, set, block or unblock.', 400);
    }

    if (note !== undefined) user.access.note = String(note).slice(0, 500);

    await user.save();
    console.log(`Admin access change — ${outcome}`);

    res.json({
      success: true,
      message: outcome,
      data: {
        id: String(user._id),
        email: user.email,
        blocked: Boolean(user.access.blocked),
        remaining: user.subscription.examsRemaining,
        credits: formatCredits(user.subscription.examsRemaining, user.subscription.partCredits),
        writingRemaining: user.subscription.writingRemaining ?? 0,
        writingCredits: balanceLabel(user, 'writing'),
        pendingMessage: user.access.message || ''
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/admin/students/access-all
 * @desc    Block every student at once, or set everyone's balance
 *
 * The blunt instrument, for the day the link escapes: one click stops the whole
 * class spending money, and access comes back one student at a time. Admins and
 * teachers are never included — locking yourself out of your own dashboard from
 * your own dashboard is not a recoverable mistake.
 *
 * Like the purge, it refuses to run unless the client says how many students it
 * expects to change, so a stale page cannot act on a larger set than the teacher
 * was shown.
 */
router.post('/students/access-all', async (req, res, next) => {
  try {
    const { action, amount, confirm } = req.body || {};

    if (typeof confirm !== 'number') {
      throw new APIError('Confirm the number of students this will change.', 400);
    }

    const filter = { role: 'student' };
    const matched = await User.countDocuments(filter);
    if (matched !== confirm) {
      throw new APIError(
        `The number of students changed since you checked — ${matched} now, not ${confirm}.`,
        409
      );
    }

    let update;
    if (action === 'block') {
      update = { $set: { 'access.blocked': true, 'access.blockedAt': new Date() } };
    } else if (action === 'unblock') {
      update = { $set: { 'access.blocked': false, 'access.blockedAt': null } };
    } else if (action === 'set') {
      const value = Number(amount);
      if (!Number.isInteger(value) || value < 0 || value > MAX_GRANT) {
        throw new APIError(`Give a whole number of mocks between 0 and ${MAX_GRANT}.`, 400);
      }
      const [wholeField, partField] = BALANCE_FIELDS[req.body?.module === 'writing' ? 'writing' : 'speaking'];
      update = { $set: { [`subscription.${wholeField}`]: value, [`subscription.${partField}`]: 0 } };
    } else {
      throw new APIError('Unknown action. Use block, unblock or set.', 400);
    }

    const outcome = await User.updateMany(filter, update);
    const changed = outcome.modifiedCount ?? 0;
    console.log(`Admin bulk access change — ${action} on ${changed} student(s)`);

    res.json({
      success: true,
      message: `${action} applied to ${changed} student(s).`,
      data: { changed, matched }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/admin/results
 * @desc    Recent attempts from every student, for review
 *
 * The teacher's queue. Marking is only as good as the standard behind it, and
 * the standard only reaches the marker if somebody listens to real students and
 * disagrees on the record. This is where that starts: every attempt, newest
 * first, with a note of which ones have already been reviewed.
 *
 * `only=uncorrected` is the working view — the attempts nobody has checked yet.
 */
router.get('/results', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 40, 200);

    const filter = { status: 'completed' };
    if (req.query.only === 'uncorrected') filter['teacherBands.correctedAt'] = { $exists: false };
    if (req.query.only === 'corrected') filter['teacherBands.correctedAt'] = { $exists: true };

    const results = await ExamResult.find(filter)
      .sort({ completedAt: -1, createdAt: -1 })
      .limit(limit)
      .populate('student', 'email firstName lastName')
      .populate('exam', 'title')
      .select('student exam overallScore overallLevel criterionBands teacherBands completedAt createdAt mode part taskResults.taskNumber')
      .lean();

    res.json({
      success: true,
      data: {
        results: results.map(r => ({
          id: String(r._id),
          student: r.student?.email || '—',
          studentName: [r.student?.firstName, r.student?.lastName].filter(Boolean).join(' '),
          exam: r.exam?.title || 'Exam',
          mode: r.mode,
          part: r.part || null,
          answers: (r.taskResults || []).length,
          score: r.overallScore ?? null,
          level: r.overallLevel || '',
          corrected: Boolean(r.teacherBands?.correctedAt),
          correctedAt: r.teacherBands?.correctedAt || null,
          at: r.completedAt || r.createdAt
        })),
        // So the card can say how much of the queue is still unreviewed without
        // a second request.
        uncorrected: await ExamResult.countDocuments({
          status: 'completed',
          'teacherBands.correctedAt': { $exists: false }
        })
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/admin/results/:id/bands
 * @desc    Record the bands the teacher would have awarded this performance
 *
 * The calibration loop, closed. A disagreement with the marker stops being a
 * complaint and becomes an example the marker reads on every future attempt.
 *
 * The student's reported score is NOT changed. A correction is evidence about
 * the marker, not a re-grade of the candidate — re-grading on a teacher's
 * second look would make the score depend on whether anyone happened to review
 * it, which is a worse injustice than the one it fixes. Re-mark the attempt if
 * the score itself should move.
 */
router.post('/results/:id/bands', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid result id', 400);

    const result = await ExamResult.findById(req.params.id);
    if (!result) throw new APIError('Attempt not found', 404);

    const keys = ['vocabulary', 'grammar', 'fluencyCoherence', 'communicative', 'pronunciation'];
    const bands = {};

    for (const key of keys) {
      const value = req.body?.[key];
      // An unset criterion is left unset rather than zeroed: a teacher who only
      // wants to correct pronunciation should not have to restate the other
      // four, and a blank must never be read as "band 0".
      if (value === undefined || value === null || value === '') continue;
      const band = Number(value);
      if (!Number.isInteger(band) || band < 0 || band > 6) {
        throw new APIError(`${key} must be a whole number from 0 to 6`, 400);
      }
      bands[key] = band;
    }

    if (Object.keys(bands).length === 0) {
      throw new APIError('Give at least one band to record', 400);
    }

    const source = req.body?.source === 'real-exam' ? 'real-exam' : 'teacher-estimate';

    result.teacherBands = {
      ...bands,
      note: String(req.body?.note || '').slice(0, 600),
      source,
      correctedBy: req.user.email || String(req.user.id),
      correctedAt: new Date()
    };

    await result.save();

    const anchors = await ExamResult.countDocuments({ 'teacherBands.correctedAt': { $exists: true } });
    console.log(`Calibration: bands recorded for ${result._id} (${source}); ${anchors} anchor(s) now`);

    // What the teacher's own bands come to on the official scale. Shown back to
    // them because bands are easier to judge than a score but a score is what
    // they will be compared against — and a teacher whose bands quietly add up
    // to 72 for a candidate they think of as a 67 should see that immediately.
    const teacherScore = bandsToScore(bands);

    res.json({
      success: true,
      message: `Recorded. ${anchors} corrected attempt${anchors === 1 ? '' : 's'} now teach the marker.`,
      data: {
        id: String(result._id),
        bands,
        source,
        anchors,
        teacherScore,
        markedScore: result.overallScore ?? null
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
