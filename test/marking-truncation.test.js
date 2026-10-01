/**
 * A reply cut off by the output budget must be asked for again with more
 * room, not given up on. In production the whole-performance verdict came
 * back as nothing but a thinking block (stop_reason: max_tokens) on the
 * shared 2000-token budget, and the attempt fell back to averaging.
 *
 * The network is replaced by a stub of axios.post; nothing is sent.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import AIEvaluationService from '../services/AIEvaluationService.js';

const realPost = axios.post;
const realMaxTokens = AIEvaluationService.maxTokens;
let requests;

// Answer each request with the next scripted reply, recording what was asked.
function scriptReplies(...replies) {
  requests = [];
  axios.post = async (url, payload) => {
    requests.push(payload);
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    return { data: { usage: { input_tokens: 10, output_tokens: 10 }, ...reply } };
  };
}

const thinkingOnly = { content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'max_tokens' };
const cutOffJson = { content: [{ type: 'text', text: '{"bands": {"part11": 4, "par' }], stop_reason: 'max_tokens' };
const verdict = {
  content: [
    { type: 'thinking', thinking: '…' },
    { type: 'text', text: JSON.stringify({ bands: { part11: 4, part12: 4, part2: 4, part3: 4 }, reasoning: 'ok', overallFeedback: 'ok' }) }
  ],
  stop_reason: 'end_turn'
};

const answers = [
  { part: '1.1', question: 'Q1', transcription: 'I like football.' },
  { part: '1.2', question: 'Q2', transcription: 'In the picture there are people.' },
  { part: '2', question: 'Q3', transcription: 'I want to talk about my trip.' },
  { part: '3', question: 'Q4', transcription: 'On the one hand, on the other hand.' }
];

beforeEach(() => {
  AIEvaluationService.maxTokens = 2000; // the production value that failed
});

afterEach(() => {
  axios.post = realPost;
  AIEvaluationService.maxTokens = realMaxTokens;
});

test('evaluateAttempt: asks for at least 16000 output tokens even when CLAUDE_MAX_TOKENS is 2000', async () => {
  scriptReplies(verdict);
  const result = await AIEvaluationService.evaluateAttempt({ answers });
  assert.equal(requests.length, 1);
  assert.ok(requests[0].max_tokens >= 16000);
  assert.ok(typeof result.score === 'number');
});

test('evaluateAttempt: a thinking-only cut-off reply (the production failure) is retried with more room and marks', async () => {
  scriptReplies(thinkingOnly, verdict);
  const result = await AIEvaluationService.evaluateAttempt({ answers });
  assert.equal(requests.length, 2);
  assert.ok(requests[1].max_tokens > requests[0].max_tokens);
  assert.deepEqual(result.bands, { part11: 4, part12: 4, part2: 4, part3: 4 });
});

test('callClaudeAPI: JSON cut off mid-way is retried rather than handed to the parser', async () => {
  scriptReplies(cutOffJson, verdict);
  const text = await AIEvaluationService.callClaudeAPI('mark this');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_tokens, 2000);
  assert.equal(requests[1].max_tokens, 4000);
  assert.equal(requests[1].messages[0].content, 'mark this'); // a plain-string prompt survives the retry
  assert.match(text, /"bands"/);
});

test('callClaudeAPI: the budget doubles up to the 32000 ceiling, then gives up with a clear error', async () => {
  scriptReplies(thinkingOnly);
  await assert.rejects(
    () => AIEvaluationService.callClaudeAPI({ user: 'mark this', maxTokens: 8000 }),
    /cut off at max_tokens 32000/
  );
  assert.deepEqual(requests.map(r => r.max_tokens), [8000, 16000, 32000]);
});

test('callClaudeAPI: a complete reply is not retried', async () => {
  scriptReplies(verdict);
  await AIEvaluationService.callClaudeAPI('mark this');
  assert.equal(requests.length, 1);
});
