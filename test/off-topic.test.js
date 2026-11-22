/** "You spoke about another subject": only when the examiners agree, and only short notes for known parts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { agreedOffTopic } from '../routes/exam.js';
import { cleanOffTopic } from '../services/AIEvaluationService.js';

test('the marker’s notes are kept only for real parts, trimmed', () => {
  assert.deepEqual(cleanOffTopic({ part3: '  You spoke about cash. ', part9: 'x', part2: '' }), { part3: 'You spoke about cash.' });
  assert.deepEqual(cleanOffTopic(null), {});
  assert.deepEqual(cleanOffTopic(['part3']), {});
  assert.equal(cleanOffTopic({ part3: 'a'.repeat(500) }).part3.length, 240);
});

test('two examiners must both say it; with three, two are enough', () => {
  const a = { offTopic: { part3: 'You spoke about cash payments.' } };
  const none = { offTopic: {} };
  assert.deepEqual(agreedOffTopic([a, a]), { part3: 'You spoke about cash payments.' });
  assert.deepEqual(agreedOffTopic([a, none]), {}, 'one doubt is not enough');
  assert.deepEqual(agreedOffTopic([a, none, a]), { part3: 'You spoke about cash payments.' });
  assert.deepEqual(agreedOffTopic([a]), { part3: 'You spoke about cash payments.' }, 'a single reading (SPEAKING_MARKERS=1)');
  assert.deepEqual(agreedOffTopic([]), {});
});
