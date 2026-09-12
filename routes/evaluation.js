import express from 'express';
import mongoose from 'mongoose';
import ExamResult from '../models/ExamResult.js';
import { APIError } from '../middleware/errorHandler.js';

const router = express.Router();

async function loadOwnedResult(req, resultId) {
  if (!mongoose.Types.ObjectId.isValid(resultId)) throw new APIError('Invalid result id', 400);

  const result = await ExamResult.findById(resultId);
  if (!result) throw new APIError('Result not found', 404);

  const isOwner = String(result.student) === String(req.user.id);
  if (!isOwner && req.user.role !== 'admin') {
    throw new APIError('Not authorized to access this evaluation', 403);
  }
  return result;
}

/**
 * @route   GET /api/evaluation/:resultId
 * @desc    Evaluation summary for one attempt
 * @access  Private (owner or admin)
 */
router.get('/:resultId', async (req, res, next) => {
  try {
    const result = await loadOwnedResult(req, req.params.resultId);

    if (result.status !== 'completed') {
      return res.json({
        success: true,
        data: { status: result.status, message: 'This attempt has not been evaluated yet' }
      });
    }

    res.json({
      success: true,
      data: { status: result.status, ...result.getEvaluationSummary() }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/evaluation/:resultId/appeal
 * @desc    Flag an evaluation for human review
 * @access  Private (owner)
 */
router.post('/:resultId/appeal', async (req, res, next) => {
  try {
    const { reason } = req.body;
    if (!reason || String(reason).trim().length < 10) {
      throw new APIError('Please describe why you are appealing (at least 10 characters)', 400);
    }

    const result = await loadOwnedResult(req, req.params.resultId);
    if (result.status !== 'completed') {
      throw new APIError('Only completed evaluations can be appealed', 400);
    }

    result.studentNotes = String(reason).trim();
    result.adminNotes = `${result.adminNotes || ''}\n[appeal ${new Date().toISOString()}] awaiting review`.trim();
    await result.save();

    res.json({
      success: true,
      message: 'Your appeal has been recorded and will be reviewed by an examiner.',
      data: { resultId: result._id }
    });
  } catch (error) {
    next(error);
  }
});

export default router;
