/**
 * The marker's inputs and instructions after the 2026-10-24 review of an
 * attempt marked 64 that an expert put at 69: answers cut off by the timer
 * are said to be cut off, Part 3's statement and sides are shown, and the top
 * band of each part is defined as the official sheet defines it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { speakingInputs } from '../routes/exam.js';
import AIEvaluationService from '../services/AIEvaluationService.js';

const q = new Map([
  [1, { part: '1.1', text: 'Do you buy clothes online?', answerTime: 30 }],
  [8, { part: '3', text: 'Discuss.', answerTime: 120, topic: 'Countries should invest more in renewable energy.', pros: ['cleaner air'], cons: ['high cost'] }]
]);
const result = { taskResults: [
  { taskNumber: 1, transcription: 'Well, of course I usually buy clothes online as it', duration: 30 },
  { taskNumber: 8, transcription: 'From my perspective authorities should allocate more money', duration: 70 }
] };

test('the marker is told which answers ran to the time limit, and sees Part 3’s two sides', () => {
  const [a1, a8] = speakingInputs(result, q);
  assert.equal(a1.usedFullTime, true);
  assert.equal(a8.usedFullTime, false, 'stopped at 70 of 120 seconds');
  assert.deepEqual(a8.debate, { topic: 'Countries should invest more in renewable energy.', forSide: ['cleaner air'], againstSide: ['high cost'] });
  assert.equal(a1.debate, undefined);
});

test('the prompt carries the official top-band meaning and the cut-off rule', async () => {
  let sent = null;
  const orig = AIEvaluationService.callClaudeAPI;
  AIEvaluationService.callClaudeAPI = async prompt => {
    sent = prompt;
    return JSON.stringify({ bands: { part11: 5, part12: 5, part2: 5, part3: 4 }, reasoning: 'x' });
  };
  try {
    const out = await AIEvaluationService.evaluateAttempt({ answers: speakingInputs(result, q), examTitle: 'Mock 1' });
    assert.equal(out.score, 67, '5+5+5+4 = 19 -> 67');
    assert.match(sent.cached, /likely to be above the A2\s+level/);
    assert.match(sent.cached, /ANSWERS CUT OFF BY THE TIMER/);
    assert.match(sent.user, /spoke until the 30s time limit ran out/);
    assert.doesNotMatch(sent.user, /spoke until the 120s/);
    assert.match(sent.user, /Points given AGAINST it: high cost/);
    assert.match(sent.user, /is the candidate's own development, NOT reliance/);
    assert.match(sent.user, /argues only one side has not built a balanced argument/);
  } finally { AIEvaluationService.callClaudeAPI = orig; }
});
