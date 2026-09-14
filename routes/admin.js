import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import Exam from '../models/Exam.js';
import ExamResult from '../models/ExamResult.js';
import User from '../models/User.js';
import ImageStorageService, {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES
} from '../services/ImageStorageService.js';
import { removeResult } from '../services/AttemptCleanup.js';
import { isRescuable, rescueAttempt } from './exam.js';
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

export default router;
