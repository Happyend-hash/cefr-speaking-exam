import { test } from 'node:test';
import assert from 'node:assert/strict';
import AIEvaluationService from '../services/AIEvaluationService.js';

/**
 * The writing marker carries the board's examiner method and its graded
 * samples, and tells the marker about the official under-length cap.
 */

test('the writing prompt carries the official method, the graded samples and the cap', async () => {
  let seen = null;
  const original = AIEvaluationService.callClaudeAPI;
  AIEvaluationService.callClaudeAPI = async args => {
    seen = args;
    return JSON.stringify({ parts: { part2: { band: 4, reasoning: 'r', feedback: 'f', corrections: [] } } });
  };
  try {
    const out = await AIEvaluationService.evaluateWriting({
      parts: [{
        key: 'part2', text: 'short text', words: 60, task: 'Write a blog post.', wordGuide: 'Write 180–200 words.',
        underLength: { applied: true, threshold: 90, cap: 2 }
      }]
    });
    assert.equal(out.parts.part2.band, 4, 'the marker band comes back untouched; the cap is applied later');
  } finally {
    AIEvaluationService.callClaudeAPI = original;
  }

  assert.match(seen.cached, /SIX-STEP RATING PROCESS/);
  assert.match(seen.cached, /OFFICIAL BAND 3 \(Lower B2\)/);
  assert.match(seen.cached, /Over length: does NOT automatically lower the band/);
  assert.match(seen.cached, /Parts 1\.2 and 2 = band 0/);
  assert.doesNotMatch(seen.cached, /scores it 0 whatever its/);
  assert.match(seen.user, /UNDER LENGTH: under 90 words, so the official scale allows band 2 at most/);
});
