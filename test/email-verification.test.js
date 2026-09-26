import { test } from 'node:test';
import assert from 'node:assert/strict';
import User from '../models/User.js';
import AuthService from '../services/AuthService.js';
import { APIError } from '../middleware/errorHandler.js';

/**
 * Covers the gate added to examAccess() for "must verify before spending a
 * mock", and the AuthService methods that check/resend a code. See that
 * gate's own comment in models/User.js for why it only ever applies to
 * accounts created after this shipped, and only while SMTP is configured.
 */

// SMTP_* are read fresh by emailConfigured() on every call (no caching), so
// tests can just flip them around each case rather than mock the module.
function withMailConfigured(configured, fn) {
  const saved = { SMTP_HOST: process.env.SMTP_HOST, SMTP_USER: process.env.SMTP_USER, SMTP_PASS: process.env.SMTP_PASS };
  try {
    if (configured) {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_USER = 'bot@example.com';
      process.env.SMTP_PASS = 'secret';
    } else {
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A real User instance (not a plain object) so prototype methods examAccess()
// calls internally — creditLabel(), canAfford(), creditUnits() — are there
// too, exactly as they are on a genuine document.
function baseStudent(overrides = {}) {
  return new User({
    role: 'student',
    access: { blocked: false },
    isEmailVerified: false,
    emailVerificationRequired: false,
    subscription: { examsRemaining: 1, partCredits: 0, writingRemaining: 1, writingPartCredits: 0 },
    ...overrides
  });
}

test('examAccess: a verified-required account with no verification yet is refused while mail is configured', () => {
  withMailConfigured(true, () => {
    const gate = baseStudent({ emailVerificationRequired: true, isEmailVerified: false }).examAccess(12);
    assert.equal(gate.allowed, false);
    assert.equal(gate.code, 'unverified');
  });
});

test('examAccess: the same account is NOT blocked when mail is not configured (fail open)', () => {
  withMailConfigured(false, () => {
    const gate = baseStudent({ emailVerificationRequired: true, isEmailVerified: false }).examAccess(12);
    assert.notEqual(gate.code, 'unverified');
  });
});

test('examAccess: an account predating the feature (emailVerificationRequired false) is never gated on it', () => {
  withMailConfigured(true, () => {
    const gate = baseStudent({ emailVerificationRequired: false, isEmailVerified: false }).examAccess(12);
    assert.notEqual(gate.code, 'unverified');
    assert.equal(gate.allowed, true); // falls through to the (satisfied) credit check
  });
});

test('examAccess: a blocked account is refused as "blocked" even if also unverified', () => {
  withMailConfigured(true, () => {
    const gate = baseStudent({ emailVerificationRequired: true, isEmailVerified: false, access: { blocked: true } }).examAccess(12);
    assert.equal(gate.code, 'blocked');
  });
});

test('examAccess: staff bypass wins over an unverified email', () => {
  withMailConfigured(true, () => {
    const gate = baseStudent({ role: 'teacher', emailVerificationRequired: true, isEmailVerified: false }).examAccess(12);
    assert.equal(gate.code, 'staff');
    assert.equal(gate.allowed, true);
  });
});

test('examAccess: a verified account is never gated regardless of emailVerificationRequired', () => {
  withMailConfigured(true, () => {
    const gate = baseStudent({ emailVerificationRequired: true, isEmailVerified: true }).examAccess(12);
    assert.notEqual(gate.code, 'unverified');
  });
});

test('generateVerificationCode: always a zero-padded 6-digit string', () => {
  for (let i = 0; i < 50; i++) {
    const code = AuthService.generateVerificationCode();
    assert.match(code, /^\d{6}$/);
  }
});

test('verifyEmailCode: correct, unexpired code verifies the account', async () => {
  const saved = [];
  const fakeUser = {
    isEmailVerified: false,
    emailVerificationToken: '123456',
    emailVerificationExpires: new Date(Date.now() + 60_000),
    status: 'pending_email_verification',
    save: async function () { saved.push({ ...this }); },
    getPublicProfile: () => ({ ok: true })
  };
  User.findById = async () => fakeUser;

  const result = await AuthService.verifyEmailCode('any-id', '123456');
  assert.deepEqual(result, { ok: true });
  assert.equal(fakeUser.isEmailVerified, true);
  assert.equal(fakeUser.status, 'active');
  assert.equal(fakeUser.emailVerificationToken, undefined);
  assert.equal(saved.length, 1);
});

test('verifyEmailCode: wrong code is rejected without changing the account', async () => {
  const fakeUser = {
    isEmailVerified: false,
    emailVerificationToken: '123456',
    emailVerificationExpires: new Date(Date.now() + 60_000),
    save: async () => { throw new Error('must not save on a wrong code'); }
  };
  User.findById = async () => fakeUser;

  await assert.rejects(
    () => AuthService.verifyEmailCode('any-id', '000000'),
    err => err instanceof APIError && err.statusCode === 400
  );
  assert.equal(fakeUser.isEmailVerified, false);
});

test('verifyEmailCode: an expired code is rejected', async () => {
  const fakeUser = {
    isEmailVerified: false,
    emailVerificationToken: '123456',
    emailVerificationExpires: new Date(Date.now() - 1000),
    save: async () => { throw new Error('must not save on an expired code'); }
  };
  User.findById = async () => fakeUser;

  await assert.rejects(
    () => AuthService.verifyEmailCode('any-id', '123456'),
    err => err instanceof APIError && err.statusCode === 400
  );
});

test('verifyEmailCode: an already-verified account short-circuits without checking the code', async () => {
  const fakeUser = { isEmailVerified: true, getPublicProfile: () => ({ ok: true }) };
  User.findById = async () => fakeUser;

  const result = await AuthService.verifyEmailCode('any-id', 'anything');
  assert.deepEqual(result, { ok: true });
});

test('resendVerificationEmail: refuses a second request inside the cooldown window', async () => {
  const fakeUser = {
    isEmailVerified: false,
    emailVerificationLastSentAt: new Date(),
    save: async () => { throw new Error('must not save while cooling down'); }
  };
  User.findById = async () => fakeUser;

  await assert.rejects(
    () => AuthService.resendVerificationEmail('any-id'),
    err => err instanceof APIError && err.statusCode === 429
  );
});

test('resendVerificationEmail: issues a fresh code once the cooldown has passed', async () => {
  const fakeUser = {
    isEmailVerified: false,
    emailVerificationToken: 'old-token',
    emailVerificationLastSentAt: new Date(Date.now() - 120_000),
    save: async function () { /* accept */ }
  };
  User.findById = async () => fakeUser;

  const result = await withMailConfigured(false, () => AuthService.resendVerificationEmail('any-id'));
  assert.match(fakeUser.emailVerificationToken, /^\d{6}$/);
  assert.notEqual(fakeUser.emailVerificationToken, 'old-token');
  assert.equal(result.sent, false); // mail isn't configured in this test
  assert.match(result.message, /ask your teacher/i);
});

test('resendVerificationEmail: an already-verified account is told so and nothing is sent', async () => {
  const fakeUser = { isEmailVerified: true, save: async () => { throw new Error('must not save'); } };
  User.findById = async () => fakeUser;

  const result = await AuthService.resendVerificationEmail('any-id');
  assert.equal(result.sent, false);
  assert.match(result.message, /already verified/i);
});
