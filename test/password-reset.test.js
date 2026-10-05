import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import User from '../models/User.js';
import AuthService from '../services/AuthService.js';

/**
 * "Forgot password": a 6-digit code by email, then code + new password.
 * User.findOne is replaced so no database is needed; the code generator is
 * pinned so the test knows the code that would have been emailed.
 */

const CODE = '482913';
AuthService.generateVerificationCode = () => CODE;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-password-reset-tests';

function student(overrides = {}) {
  const doc = new User({
    email: 'maqsuda@example.com',
    firstName: 'Maqsuda',
    role: 'student',
    status: 'active',
    isEmailVerified: true,
    loginHistory: [],
    ...overrides
  });
  if (!doc._id) doc._id = new mongoose.Types.ObjectId();
  doc.saves = 0;
  doc.save = async function () { this.saves += 1; return this; };
  return doc;
}

function useAccount(doc) {
  const seen = [];
  User.findOne = query => {
    seen.push(query);
    const result = doc && query.email === doc.email ? doc : null;
    return { select: async () => result, then: (ok, fail) => Promise.resolve(result).then(ok, fail) };
  };
  return seen;
}

test('asking for a code stores only a hash of it, never returns it, and looks the email up in lower case', async () => {
  const doc = student();
  const seen = useAccount(doc);
  const out = await AuthService.requestPasswordReset('  Maqsuda@Example.com ');

  assert.equal(seen[0].email, 'maqsuda@example.com');
  assert.ok(!JSON.stringify(out).includes(CODE), 'the code must not be in the response');
  assert.equal(out.resetToken, undefined);
  assert.notEqual(doc.passwordResetToken, CODE);
  assert.equal(doc.passwordResetToken, AuthService.hashResetCode(CODE));
  assert.ok(doc.passwordResetExpires > new Date());
});

test('an unknown address gets the same answer and nothing is saved', async () => {
  useAccount(null);
  const known = await AuthService.requestPasswordReset('maqsuda@example.com');
  const unknown = await AuthService.requestPasswordReset('nobody@example.com');
  assert.equal(unknown.message, known.message);
});

test('the right code sets the new password, clears the code and signs the student in', async () => {
  const doc = student();
  useAccount(doc);
  await AuthService.requestPasswordReset('maqsuda@example.com');

  const session = await AuthService.resetPassword('maqsuda@example.com', CODE, 'newpass123');
  assert.equal(doc.password, 'newpass123');
  assert.equal(doc.passwordResetToken, undefined);
  assert.ok(session.accessToken);
  assert.equal(session.user.email, 'maqsuda@example.com');

  await assert.rejects(() => AuthService.resetPassword('maqsuda@example.com', CODE, 'another123'),
    /not correct/, 'a used code cannot be used again');
});

test('a wrong code is refused, and five wrong codes burn it', async () => {
  const doc = student();
  useAccount(doc);
  await AuthService.requestPasswordReset('maqsuda@example.com');

  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(() => AuthService.resetPassword('maqsuda@example.com', '000000', 'newpass123'), /not correct/);
  }
  await assert.rejects(() => AuthService.resetPassword('maqsuda@example.com', '000000', 'newpass123'), /Too many/);
  await assert.rejects(() => AuthService.resetPassword('maqsuda@example.com', CODE, 'newpass123'), /not correct/);
  assert.notEqual(doc.password, 'newpass123');
});

test('an expired code and a short password are refused', async () => {
  const doc = student();
  useAccount(doc);
  await AuthService.requestPasswordReset('maqsuda@example.com');

  await assert.rejects(() => AuthService.resetPassword('maqsuda@example.com', CODE, 'short'), /at least 8/);
  doc.passwordResetExpires = new Date(Date.now() - 1000);
  await assert.rejects(() => AuthService.resetPassword('maqsuda@example.com', CODE, 'newpass123'), /expired/);
});

test('resetting also confirms an unconfirmed email (the code proves the address)', async () => {
  const doc = student({ isEmailVerified: false, emailVerificationRequired: true, emailVerificationToken: '111111' });
  useAccount(doc);
  await AuthService.requestPasswordReset('maqsuda@example.com');
  await AuthService.resetPassword('maqsuda@example.com', CODE, 'newpass123');
  assert.equal(doc.isEmailVerified, true);
  assert.equal(doc.emailVerificationToken, undefined);
});
