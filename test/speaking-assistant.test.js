import { test } from 'node:test';
import assert from 'node:assert/strict';
import Exam from '../models/Exam.js';
import { questionsFor, listMocks, setupMessage, createSessionToken, today, DAILY_SESSIONS } from '../services/SpeakingAssistant.js';

/** AI Ustoz finds the real mock questions the student asks for. */
const exams = [
  { _id: 'a', title: 'Speaking Mock 5', sections: [
    { part: '1.1', questions: [{ text: 'Where do you live?' }, { text: 'Do you like your job?' }] },
    { part: '1.2', images: ['/api/exam/images/x1', '/api/exam/images/x2'], questions: [{ text: 'What can you see?' }] },
    { part: '3', topic: 'Libraries are outdated.', pros: ['Online is faster'], cons: ['Quiet place'], questions: [{ text: 'Discuss.' }] }
  ] },
  { _id: 'b', title: 'Speaking Mock 12', sections: [{ part: '2', topic: 'A project', questions: [{ text: 'Describe a project.' }] }] }
];
Exam.find = () => ({ select: () => ({ lean: async () => exams }) });

test('the exact questions of a mock part', async () => {
  const q = await questionsFor({ mock: 5, part: '1.1' });
  assert.equal(q.mock, 'Speaking Mock 5');
  assert.deepEqual(q.questions, ['Where do you live?', 'Do you like your job?']);
  const pics = await questionsFor({ mock: '5', part: 'Part 1.2' });
  assert.deepEqual(pics.images, ['/api/exam/images/x1', '/api/exam/images/x2'], 'pictures go to the screen');
  const p3 = await questionsFor({ mock: 'mock 5', part: '3' });
  assert.equal(p3.topic, 'Libraries are outdated.');
  assert.deepEqual(p3.for, ['Online is faster']);
});

test('a random mock when none is named, and honest errors', async () => {
  assert.equal((await questionsFor({ part: '2' })).mock, 'Speaking Mock 12');
  assert.match((await questionsFor({ mock: 99, part: '2' })).error, /no Speaking Mock 99/);
  assert.match((await questionsFor({ mock: 12, part: '1.1' })).error, /has no Part 1.1/);
  assert.match((await questionsFor({ mock: 5, part: '7' })).error, /Part must be/);
});

test('the list of mocks, in order', async () => {
  const list = await listMocks();
  assert.deepEqual(list.mocks.map(m => m.number), [5, 12]);
  assert.deepEqual(list.mocks[0].parts, ['1.1', '1.2', '3']);
});

test('the session setup asks for Uzbek feedback and declares the question tools', () => {
  const s = setupMessage().setup;
  assert.match(s.model, /^models\//);
  assert.deepEqual(s.generationConfig.responseModalities, ['AUDIO']);
  assert.match(s.systemInstruction.parts[0].text, /Feedback in UZBEK/);
  assert.match(s.systemInstruction.parts[0].text, /NEVER invent questions/);
  assert.deepEqual(s.tools[0].functionDeclarations.map(f => f.name), ['get_mock_questions', 'list_mocks']);
  assert.ok(s.inputAudioTranscription && s.outputAudioTranscription);
});

test('the browser gets a single-use token, never the key', async () => {
  process.env.GEMINI_API_KEY = 'secret-key';
  let sent;
  const token = await createSessionToken({
    now: Date.parse('2026-10-15T10:00:00Z'),
    fetchImpl: async (url, opts) => { sent = { url, opts }; return { ok: true, status: 200, json: async () => ({ name: 'auth_tokens/abc' }) }; }
  });
  assert.equal(token, 'auth_tokens/abc');
  assert.match(sent.url, /v1beta\/auth_tokens$/);
  assert.equal(sent.opts.headers['x-goog-api-key'], 'secret-key');
  const body = JSON.parse(sent.opts.body);
  assert.equal(body.uses, 1);
  assert.equal(body.expireTime, '2026-10-15T10:30:00.000Z');
  await assert.rejects(createSessionToken({ fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'User location is not supported' } }) }) }), /location is not supported/);
  delete process.env.GEMINI_API_KEY;
});

test('the daily limit counts in Tashkent days', () => {
  assert.equal(today(Date.parse('2026-10-15T20:00:00Z')), '2026-10-16');
  assert.ok(DAILY_SESSIONS >= 1);
});

test('Lesley: her own voice and manner, the student by name, and honest that she is an AI', () => {
  const s = setupMessage({ character: 'lesley', studentName: 'Nilufar<script>' }).setup;
  const prompt = s.systemInstruction.parts[0].text;
  assert.equal(s.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Sulafat');
  assert.match(prompt, /Your name is Lesley/);
  assert.match(prompt, /first name is Nilufarscript\./, 'the name is cleaned of anything but letters');
  assert.match(prompt, /you are an AI teacher/i);
  assert.match(prompt, /Never claim to be human/);
  assert.match(prompt, /UZBEK/, 'the coaching rules are still there');
});

test('an unknown character falls back to Lesley; Arthur has his own voice', () => {
  const unknown = setupMessage({ character: 'nobody' }).setup;
  assert.match(unknown.systemInstruction.parts[0].text, /Your name is Lesley/);
  assert.match(unknown.systemInstruction.parts[0].text, /Ask the student's first name/);
  const arthur = setupMessage({ character: 'arthur' }).setup;
  assert.equal(arthur.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
  assert.match(arthur.systemInstruction.parts[0].text, /Your name is Arthur/);
});

test('rudeness: the shared swear list plus insults, and a short polite reminder in the prompt', async () => {
  const { RUDE_WORDS } = await import('../services/SpeakingAssistant.js');
  assert.ok(RUDE_WORDS.includes('fuck') && RUDE_WORDS.includes('jalab'), 'the text chat list is reused');
  assert.ok(RUDE_WORDS.includes('stupid') && RUDE_WORDS.includes('ahmoq') && RUDE_WORDS.includes('дурак'));
  assert.ok(!RUDE_WORDS.some(w => w.length < 3), 'no tiny roots that would catch ordinary words');
  const prompt = setupMessage({ character: 'lesley' }).setup.systemInstruction.parts[0].text;
  assert.match(prompt, /Let's keep it polite, please/);
  assert.match(prompt, /Iltimos, odobli gaplashaylik/);
  assert.match(prompt, /do not repeat their words/);
});
