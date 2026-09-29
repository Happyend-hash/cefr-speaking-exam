import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMail, emailConfigured, parseSender } from '../services/EmailService.js';

/**
 * Brevo is how email leaves Railway's Hobby plan, which blocks outgoing SMTP.
 * These cover the request the app makes and how it reports Brevo's refusals;
 * fetch is replaced so nothing is actually sent.
 */

const ENV_KEYS = ['BREVO_API_KEY', 'MAIL_FROM', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, values);
    return await fn();
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('parseSender reads "Name <address>" and a bare address', () => {
  assert.deepEqual(parseSender('CEFR Mock <xappyend@gmail.com>'), { name: 'CEFR Mock', email: 'xappyend@gmail.com' });
  assert.deepEqual(parseSender('"CEFR Mock" <a@b.uz>'), { name: 'CEFR Mock', email: 'a@b.uz' });
  assert.deepEqual(parseSender('a@b.uz'), { email: 'a@b.uz' });
  assert.equal(parseSender(''), null);
});

test('Brevo counts as configured only with both a key and a sender', () => withEnv({}, () => {
  assert.equal(emailConfigured(), false);
  process.env.BREVO_API_KEY = 'xkeysib-test';
  assert.equal(emailConfigured(), false, 'a key without MAIL_FROM has no sender to send as');
  process.env.MAIL_FROM = 'CEFR Mock <a@b.uz>';
  assert.equal(emailConfigured(), true);
}));

test('sendMail posts the message to Brevo with the api-key header', () => withEnv({
  BREVO_API_KEY: 'xkeysib-test',
  MAIL_FROM: 'CEFR Mock <a@b.uz>',
  // Brevo must win even while SMTP is also set: on Railway Hobby SMTP only times out.
  SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'a@b.uz', SMTP_PASS: 'x'
}, async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ messageId: '<1@brevo>' }), { status: 201 });
  };

  const result = await sendMail({ to: 'student@example.com', subject: 'Confirm your email', html: '<p>123456</p>', text: '123456' });

  assert.deepEqual(result, { sent: true });
  assert.equal(request.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['api-key'], 'xkeysib-test');
  assert.deepEqual(JSON.parse(request.options.body), {
    sender: { name: 'CEFR Mock', email: 'a@b.uz' },
    to: [{ email: 'student@example.com' }],
    subject: 'Confirm your email',
    htmlContent: '<p>123456</p>',
    textContent: '123456'
  });
}));

test('a Brevo refusal throws with Brevo\'s own explanation', () => withEnv({
  BREVO_API_KEY: 'xkeysib-test', MAIL_FROM: 'a@b.uz'
}, async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 'unauthorized', message: 'Sender not valid' }), { status: 400 });

  await assert.rejects(
    sendMail({ to: 's@example.com', subject: 's', html: 'h', text: 't' }),
    /Brevo rejected the email \(400\).*Sender not valid/
  );
}));
