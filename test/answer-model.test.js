/** Per-answer comments on the cheaper model, with the main model as the safety net. */
import test from 'node:test';
import assert from 'node:assert/strict';
const { answerModelFromEnv, DEFAULT_ANSWER_MODEL, default: svc } = await import('../services/AIEvaluationService.js');

test('the per-answer comments use Haiku unless told otherwise', () => {
  assert.equal(answerModelFromEnv(undefined), DEFAULT_ANSWER_MODEL);
  assert.equal(answerModelFromEnv(''), DEFAULT_ANSWER_MODEL);
  assert.equal(answerModelFromEnv('same'), null, '"same" puts them back on the main model');
  assert.equal(answerModelFromEnv('MAIN'), null);
  assert.equal(answerModelFromEnv('claude-x'), 'claude-x');
});

test('if the answer model is refused, the call is made again with the main model, and Haiku is not asked again', async () => {
  const saved = { once: svc.callClaudeAPIOnce, answer: svc.answerModel, model: svc.model };
  svc.model = 'main-model';
  svc.answerModel = 'cheap-model';
  const seen = [];
  svc.callClaudeAPIOnce = async prompt => {
    seen.push(prompt.model || svc.model);
    if (prompt.model === 'cheap-model') throw Object.assign(new Error('Claude API 404 failed'), { status: 404 });
    return '{"ok":true}';
  };
  try {
    const out = await svc.callClaudeAPI({ cached: 'rubric', user: 'answer', model: 'cheap-model' });
    assert.equal(out, '{"ok":true}');
    assert.deepEqual(seen, ['cheap-model', 'main-model']);
    assert.equal(svc.answerModel, null, 'stops asking the refused model');
  } finally {
    Object.assign(svc, { callClaudeAPIOnce: saved.once, answerModel: saved.answer, model: saved.model });
  }
});

test('a refusal of the MAIN model is not hidden', async () => {
  const saved = svc.callClaudeAPIOnce;
  svc.callClaudeAPIOnce = async () => { throw Object.assign(new Error('Claude API 400 failed'), { status: 400 }); };
  try {
    await assert.rejects(svc.callClaudeAPI({ cached: 'r', user: 'u' }), /400/);
  } finally { svc.callClaudeAPIOnce = saved; }
});
