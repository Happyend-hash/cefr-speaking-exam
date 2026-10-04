import { test } from 'node:test';
import assert from 'node:assert/strict';
import User, { VERIFY_EMAIL_FROM } from '../models/User.js';
import { requireVerifiedEmail, forgetCleared } from '../middleware/verifiedEmail.js';

/**
 * The server-side lock: new accounts reach nothing but the code screen and
 * their own profile until they confirm their email. User.findById is replaced
 * so no database is needed.
 */

function stubFind(doc) {
  let calls = 0;
  User.findById = () => {
    calls += 1;
    return { select: async () => (doc ? new User(doc) : null) };
  };
  return () => calls;
}

function run(req) {
  return new Promise(resolve => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ blocked: true, status: this.statusCode, body }); }
    };
    requireVerifiedEmail(req, res, error => resolve({ blocked: false, error }));
  });
}

const newStudent = { role: 'student', emailVerificationRequired: true, isEmailVerified: false };

test('a new, unconfirmed student is refused with email_unverified', async () => {
  forgetCleared();
  stubFind(newStudent);
  const out = await run({ user: { id: 'u1', role: 'student' }, method: 'GET', originalUrl: '/api/exam' });
  assert.equal(out.blocked, true);
  assert.equal(out.status, 403);
  assert.equal(out.body.code, 'email_unverified');
});

test('the same student may still read their own profile (how the page finds the code screen)', async () => {
  forgetCleared();
  stubFind(newStudent);
  const out = await run({ user: { id: 'u1', role: 'student' }, method: 'GET', originalUrl: '/api/user/profile' });
  assert.equal(out.blocked, false);
});

test('an account from before the cut-off is let through and remembered (no second lookup)', async () => {
  forgetCleared();
  const calls = stubFind({ ...newStudent, createdAt: new Date(VERIFY_EMAIL_FROM.getTime() - 86_400_000) });
  const req = { user: { id: 'old1', role: 'student' }, method: 'GET', originalUrl: '/api/games/rank' };
  assert.equal((await run(req)).blocked, false);
  assert.equal((await run(req)).blocked, false);
  assert.equal(calls(), 1);
});

test('a confirmed new account is let through', async () => {
  forgetCleared();
  stubFind({ ...newStudent, isEmailVerified: true });
  const out = await run({ user: { id: 'u2', role: 'student' }, method: 'POST', originalUrl: '/api/exam/x/start' });
  assert.equal(out.blocked, false);
});

test('staff are never checked', async () => {
  forgetCleared();
  const calls = stubFind(newStudent);
  const out = await run({ user: { id: 'a1', role: 'admin' }, method: 'GET', originalUrl: '/api/exam' });
  assert.equal(out.blocked, false);
  assert.equal(calls(), 0);
});
