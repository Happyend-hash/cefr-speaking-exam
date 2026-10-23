/**
 * The message box: what formatting survives, the expert bands, and the
 * wording of the automatic score message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanHtml } from '../services/Messages.js';
import { readBands } from '../services/ExpertReview.js';
import { SPEAKING_PART_MAX } from '../services/ScoreConversion.js';
import Message from '../models/Message.js';
import { scoreUpdateMessage } from '../services/Messages.js';

test('messages keep bold, colours, sizes, lists and links — and nothing dangerous', () => {
  const html = cleanHtml(`<p><b>Hi</b> <span style="color: #dc2626; font-size: x-large; position: fixed">red</span>
    <span style="background-color: rgb(254, 240, 138)">mark</span></p><ul><li>one</li></ul>
    <a href="https://example.com" onclick="steal()">link</a><a href="javascript:alert(1)">bad</a>
    <img src=x onerror=alert(1)><script>alert(1)</script><iframe src="https://x"></iframe><h3 style="text-align: center">Title</h3>`);
  assert.match(html, /<b>Hi<\/b>/);
  assert.match(html, /color:#dc2626/);
  assert.match(html, /font-size:x-large/);
  assert.doesNotMatch(html, /position/);
  assert.match(html, /background-color:rgb\(254, 240, 138\)/);
  assert.match(html, /<ul><li>one<\/li><\/ul>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">link<\/a>/);
  assert.doesNotMatch(html, /onclick|javascript:|<img|<script|<iframe|onerror/);
  assert.match(html, /<h3 style="text-align:center">Title<\/h3>/);
});

test('expert bands: halves allowed, out-of-range refused, blanks left out', () => {
  assert.deepEqual(readBands({ part11: 4, part12: '3.5', part2: '', part3: 6 }, SPEAKING_PART_MAX), { part11: 4, part12: 3.5, part3: 6 });
  assert.throws(() => readBands({ part11: 6 }, SPEAKING_PART_MAX), /0 to 5/);
  assert.throws(() => readBands({ part3: 4.3 }, SPEAKING_PART_MAX), /halves/);
  assert.throws(() => readBands({}, SPEAKING_PART_MAX), /Give the bands/);
});

test('the automatic score message says the attempt was reviewed by a real expert and upgraded', async () => {
  const made = [];
  const orig = Message.create;
  Message.create = async doc => { made.push(doc); return { toObject: () => ({ _id: 'm1', createdAt: new Date(), ...doc }) }; };
  try {
    const v = await scoreUpdateMessage({
      user: 'u1', module: 'speaking', attemptId: 'r1', attemptTitle: 'Mock 3', attemptDate: new Date('2026-10-20T10:00:00Z'),
      parts: [{ key: 'part11', name: 'Part 1.1', max: 5, before: 3, after: 4 }],
      before: { mark: 14, score: 48, level: 'B1' }, after: { mark: 17, score: 55, level: 'B2' }
    });
    assert.equal(v.kind, 'score');
    assert.equal(v.title, 'Your speaking score has been upgraded: 55/75 (B2)');
    assert.match(made[0].html, /has been reviewed by a real expert examiner, and your scores have been upgraded as follows:/);
    assert.match(made[0].html, /20 October 2026/);
    assert.equal(made[0].score.after.score, 55);

    await scoreUpdateMessage({ user: 'u1', module: 'writing', attemptId: 'w1', attemptTitle: 'Mock', parts: [],
      before: { mark: 10, score: 53, level: 'B1' }, after: { mark: 9, score: 50, level: 'B1' } });
    assert.match(made[1].html, /your scores have been changed as follows/);
    assert.equal(made[1].title, 'Your writing score has been changed: 50/75 (B1)');
  } finally { Message.create = orig; }
});
