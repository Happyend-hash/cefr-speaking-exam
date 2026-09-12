import express from 'express';
import mongoose from 'mongoose';
import Exam from '../models/Exam.js';
import ExamResult from '../models/ExamResult.js';
import User from '../models/User.js';
import { authorize } from '../middleware/auth.js';
import { APIError } from '../middleware/errorHandler.js';

const router = express.Router();

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

export default router;
