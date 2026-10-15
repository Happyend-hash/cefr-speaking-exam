import { test } from 'node:test';
import assert from 'node:assert/strict';
import AIEvaluationService from '../services/AIEvaluationService.js';

/**
 * A writing reply with a broken JSON character is asked for once more instead
 * of failing the student's attempt (2026-10-12: "Expected ',' or '}' after
 * property value").
 */
test('an unreadable writing reply is asked for again, once', async () => {
  const good = JSON.stringify({
    parts: { part2: { band: 4, reasoning: 'r', feedback: 'f', corrections: [] } },
    overallFeedback: 'o', strengths: [], areasForImprovement: []
  });
  const replies = ['{"parts": {"part2": {"band": 4, "reasoning": "the "best" one"}}}', good];
  let calls = 0;
  const original = AIEvaluationService.callClaudeAPI;
  AIEvaluationService.callClaudeAPI = async () => replies[calls++];
  try {
    const out = await AIEvaluationService.evaluateWriting({
      parts: [{ key: 'part2', text: 'text', words: 190, task: 'Write a blog post.', wordGuide: '180-200 words' }]
    });
    assert.equal(calls, 2);
    assert.equal(out.parts.part2.band, 4);

    calls = 0;
    replies[1] = replies[0];
    await assert.rejects(AIEvaluationService.evaluateWriting({
      parts: [{ key: 'part2', text: 'text', words: 190, task: 'Write.', wordGuide: '' }]
    }), /Failed to parse writing evaluation/);
    assert.equal(calls, 2, 'gives up after the second broken reply');
  } finally {
    AIEvaluationService.callClaudeAPI = original;
  }
});
