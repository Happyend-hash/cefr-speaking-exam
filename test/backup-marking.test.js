/**
 * The backup mark — the average of the per-answer scores, used only when the
 * whole-performance pass fails — must be on the agency's scale, and must say
 * that it is a backup.
 *
 * The per-answer prompt used to carry an old invented scale (B1 from 31, plus
 * an A2 and an A1 this exam does not have). When the whole-performance pass
 * failed, those scores were averaged into the reported result with nothing to
 * show it, so a 31-37 average read as "B1" to the student while the agency
 * would put it below B1.
 *
 * The network is replaced by a stub of axios.post; nothing is sent. The
 * result documents are never saved, so no database is needed.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import AIEvaluationService from '../services/AIEvaluationService.js';
import ExamResult, { BELOW_B1, CEFR_BANDS, MAX_SCORE } from '../models/ExamResult.js';

const realPost = axios.post;
let requests;

function replyWith(evaluation) {
  requests = [];
  axios.post = async (url, payload) => {
    requests.push(payload);
    return {
      data: {
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: 'text', text: JSON.stringify(evaluation) }],
        stop_reason: 'end_turn'
      }
    };
  };
}

afterEach(() => {
  axios.post = realPost;
});

const answer = {
  transcription: 'I like football because it is fun',
  taskType: 'speaking',
  question: 'What do you do in your free time?',
  part: '1.1'
};

test('per-answer prompt carries the official bands, not the old invented scale', () => {
  const { cached } = AIEvaluationService.buildEvaluationPrompt(
    answer.transcription, answer.taskType, answer.question, null, [], [], { part: '1.1' }
  );

  for (const band of CEFR_BANDS) {
    assert.match(cached, new RegExp(`\\b${band.min}-`), `missing the boundary at ${band.min}`);
  }
  assert.doesNotMatch(cached, /31-50|16-30|0-15/, 'old boundaries still in the prompt');
  // A2/A1 do not exist in this exam: neither as a band on the scale nor as a
  // level the model may answer with.
  assert.doesNotMatch(cached, /\d+-\d+\s+A[12]\b/, 'A2/A1 still a band on the scale');
  assert.doesNotMatch(cached, /"suggestedLevel": "[^"]*A[12]/, 'A2/A1 still an allowed level');
});

test('per-answer level follows the official table, not the model', async () => {
  // 34 was "B1" on the old scale; the agency puts it below B1.
  replyWith({ score: 34, criteria: {}, suggestedLevel: 'B1' });
  const evaluation = await AIEvaluationService.evaluateTask(answer);
  assert.equal(evaluation.score, 34);
  assert.equal(evaluation.suggestedLevel, BELOW_B1);
});

test('per-answer score is kept within 0-75', async () => {
  replyWith({ score: 90, criteria: { grammar: { score: 120, feedback: 'ok' } }, suggestedLevel: 'C2' });
  const high = await AIEvaluationService.evaluateTask(answer);
  assert.equal(high.score, MAX_SCORE);
  assert.equal(high.criteria.grammar.score, MAX_SCORE);
  assert.equal(high.suggestedLevel, 'C1');

  replyWith({ score: -5, criteria: {} });
  const low = await AIEvaluationService.evaluateTask(answer);
  assert.equal(low.score, 0);
});

test('an empty answer is below B1, not the non-existent A1', async () => {
  const evaluation = await AIEvaluationService.evaluateTask({ ...answer, transcription: '  ' });
  assert.equal(evaluation.suggestedLevel, BELOW_B1);
});

function markedResult() {
  return new ExamResult({
    taskResults: [
      { taskNumber: 1, finalScore: 34 },
      { taskNumber: 2, finalScore: 36 }
    ]
  });
}

test('backup mark: averaged on the official bands and flagged as a backup', () => {
  const result = markedResult();
  result.applyAverageFallback('Claude API 529 failed: overloaded');

  assert.equal(result.overallScore, 35);
  assert.equal(result.overallLevel, BELOW_B1);
  assert.equal(result.markingMethod, 'average-fallback');
  assert.match(result.markingFallbackReason, /529/);
});

test('backup mark: a re-mark that falls back leaves no stale whole-performance verdict', () => {
  const result = markedResult();
  // What an earlier, successful whole-performance pass left behind.
  result.partBands = { part11: 5, part12: 5, part2: 5, part3: 6 };
  result.rawTotal = 21;
  result.denominator = 21;
  result.overallReasoning = 'Part 3 showed C1.';
  result.overallFeedback = 'Excellent.';
  result.overallStrengths = ['range'];
  result.overallImprovements = ['none'];

  result.applyAverageFallback('no usable part bands');

  assert.equal(result.partBands?.part3, undefined);
  assert.equal(result.rawTotal, undefined);
  assert.equal(result.denominator, undefined);
  assert.equal(result.overallReasoning, undefined);
  assert.equal(result.overallFeedback, undefined);
  assert.deepEqual([...(result.overallStrengths || [])], []);
  assert.deepEqual([...(result.overallImprovements || [])], []);
});
