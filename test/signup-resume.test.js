import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import User from '../models/User.js';
import AuthService from '../services/AuthService.js';
import { APIError } from '../middleware/errorHandler.js';

/**
 * Signing up again with an email whose earlier sign-up never entered its
 * emailed code. That used to be a flat 409 "already exists", leaving the
 * student no way back to the code screen (seen in the production logs).
 */

const realFindOne = User.findOne;
const realSendVerificationEmail = AuthService.sendVerificationEmail;
const savedEnv = {};
let sentTo;

beforeEach(() => {
  for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'JWT_SECRET']) savedEnv[key] = process.env[key];
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_USER = 'bot@example.com';
  process.env.SMTP_PASS = 'secret';
  process.env.JWT_SECRET = 'test-secret';
  sentTo = [];
  AuthService.sendVerificationEmail = async user => { sentTo.push(user.emailVerificationToken); return { sent: true }; };
});

afterEach(() => {
  User.findOne = realFindOne;
  AuthService.sendVerificationEmail = realSendVerificationEmail;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// A real User document with its password check and save stubbed, so
// examAccess()/getPublicProfile() behave exactly as on a genuine account.
function account({ password = 'right-password', ...overrides } = {}) {
  const user = new User({
    email: 'student@gmail.com',
    firstName: 'Ali',
    lastName: 'Valiyev',
    role: 'student',
    status: 'pending_email_verification',
    emailVerificationRequired: true,
    isEmailVerified: false,
    emailVerificationToken: '123456',
    emailVerificationExpires: new Date(Date.now() + 10 * 60_000),
    emailVerificationLastSentAt: new Date(Date.now() - 5 * 60_000),
    ...overrides
  });
  user.comparePassword = async attempt => attempt === password;
  user.saves = 0;
  user.save = async function () { this.saves++; return this; };
  return user;
}

// findOne(...).select('+password') is how AuthService reads accounts.
function stubFindOne(user) {
  User.findOne = () => {
    const result = Promise.resolve(user);
    result.select = () => Promise.resolve(user);
    return result;
  };
}

const signupData = password => ({ email: 'student@gmail.com', firstName: 'Ali', lastName: 'Valiyev', password });

test('signup: an unfinished sign-up with the same password signs in to the code screen', async () => {
  const user = account();
  stubFindOne(user);

  const result = await AuthService.signup(signupData('right-password'));
  assert.ok(result.accessToken);
  assert.equal(result.requiresVerification, true);
  assert.deepEqual(sentTo, ['123456']); // the code already in their inbox, sent again
});

test('signup: an unfinished sign-up with a different password is sent to sign in by code', async () => {
  const user = account();
  stubFindOne(user);

  await assert.rejects(
    () => AuthService.signup(signupData('new-password')),
    err => err instanceof APIError && err.statusCode === 409 && err.code === 'verify_by_code'
  );
  assert.equal(sentTo.length, 1);
});

test('signup: an expired code is replaced with a fresh one', async () => {
  const user = account({ emailVerificationExpires: new Date(Date.now() - 1000) });
  stubFindOne(user);

  await assert.rejects(() => AuthService.signup(signupData('new-password')), err => err.code === 'verify_by_code');
  assert.match(user.emailVerificationToken, /^\d{6}$/);
  assert.ok(user.emailVerificationExpires > new Date());
  assert.deepEqual(sentTo, [user.emailVerificationToken]);
});

test('signup: retrying inside the resend cooldown does not send another email', async () => {
  const user = account({ emailVerificationLastSentAt: new Date() });
  stubFindOne(user);

  await assert.rejects(() => AuthService.signup(signupData('new-password')), err => err.code === 'verify_by_code');
  assert.equal(sentTo.length, 0);
});

test('signup: a verified account is still refused as already existing', async () => {
  stubFindOne(account({ isEmailVerified: true, status: 'active' }));

  await assert.rejects(
    () => AuthService.signup(signupData('right-password')),
    err => err.statusCode === 409 && err.code === 'account_exists'
  );
  assert.equal(sentTo.length, 0);
});

test('signup: an account from before verification shipped is still refused', async () => {
  stubFindOne(account({ emailVerificationRequired: false }));

  await assert.rejects(() => AuthService.signup(signupData('new-password')), err => err.code === 'account_exists');
});

test('signup: without mail configured there is no code to point at, so it says sign in', async () => {
  delete process.env.SMTP_HOST;
  stubFindOne(account());

  await assert.rejects(() => AuthService.signup(signupData('new-password')), err => err.code === 'account_exists');
  assert.equal(sentTo.length, 0);
});

test('loginWithCode: the right code signs in, verifies, and sets the new password', async () => {
  const user = account();
  stubFindOne(user);

  const result = await AuthService.loginWithCode('student@gmail.com', '123456', 'new-password');
  assert.ok(result.accessToken);
  assert.equal(result.requiresVerification, false);
  assert.equal(user.isEmailVerified, true);
  assert.equal(user.status, 'active');
  assert.equal(user.emailVerificationToken, undefined);
  assert.equal(user.password, 'new-password'); // hashed by the model's own pre-save hook on a real save
});

test('loginWithCode: a wrong code is refused and counted; the fifth burns the code', async () => {
  const user = account();
  stubFindOne(user);

  for (let i = 1; i <= 4; i++) {
    await assert.rejects(() => AuthService.loginWithCode('student@gmail.com', '000000'), /not correct/);
    assert.equal(user.emailVerificationAttempts, i);
  }
  await assert.rejects(() => AuthService.loginWithCode('student@gmail.com', '000000'), /Too many/);
  assert.equal(user.emailVerificationToken, undefined);
  // Even the right code no longer works until a new one is requested.
  await assert.rejects(() => AuthService.loginWithCode('student@gmail.com', '123456'), /expired/);
  assert.equal(user.isEmailVerified, false);
});

test('loginWithCode: an expired code is refused', async () => {
  stubFindOne(account({ emailVerificationExpires: new Date(Date.now() - 1000) }));
  await assert.rejects(() => AuthService.loginWithCode('student@gmail.com', '123456'), /expired/);
});

test('loginWithCode: a verified account cannot be signed into by code', async () => {
  const user = account({ isEmailVerified: true, status: 'active' });
  stubFindOne(user);
  await assert.rejects(
    () => AuthService.loginWithCode('student@gmail.com', '123456'),
    err => err.statusCode === 400 && /not correct/.test(err.message)
  );
});

test('loginWithCode: an unknown email gets the same answer as a wrong code', async () => {
  stubFindOne(null);
  await assert.rejects(() => AuthService.loginWithCode('nobody@gmail.com', '123456'), /not correct/);
});

test('loginWithCode: a too-short new password is refused before the code is checked', async () => {
  const user = account();
  stubFindOne(user);
  await assert.rejects(() => AuthService.loginWithCode('student@gmail.com', '123456', 'short'), /at least 8/);
  assert.equal(user.isEmailVerified, false);
  assert.equal(user.saves, 0);
});
