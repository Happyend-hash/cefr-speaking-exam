import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { verifyGoogleIdToken, _resetGoogleKeys } from '../services/GoogleAuth.js';

/** Sign in with Google: only a token signed by Google, for our app, with a verified email, gets through. */
const CLIENT = '123-abc.apps.googleusercontent.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const fakeFetch = async () => ({ ok: true, headers: { get: () => 'public, max-age=3600' }, json: async () => ({ keys: [jwk] }) });
const sign = (claims, key = privateKey, kid = 'k1') => jwt.sign({
  iss: 'https://accounts.google.com', aud: CLIENT, sub: '1099', email: 'Ali@Gmail.com', email_verified: true,
  given_name: 'Ali', family_name: 'Valiyev', name: 'Ali Valiyev', ...claims
}, key, { algorithm: 'RS256', keyid: kid, ...(claims.exp ? {} : { expiresIn: 600 }) });

test('a real Google token is accepted and read', async () => {
  _resetGoogleKeys();
  const g = await verifyGoogleIdToken(sign({}), { clientId: CLIENT, fetchImpl: fakeFetch });
  assert.deepEqual([g.sub, g.email, g.givenName, g.familyName], ['1099', 'ali@gmail.com', 'Ali', 'Valiyev']);
});

test('forged, foreign, expired or unverified tokens are refused', async () => {
  _resetGoogleKeys();
  const opts = { clientId: CLIENT, fetchImpl: fakeFetch };
  await assert.rejects(verifyGoogleIdToken(sign({}, other.privateKey), opts));                 // not signed by Google
  await assert.rejects(verifyGoogleIdToken(sign({ aud: 'someone-else.apps.googleusercontent.com' }), opts));
  await assert.rejects(verifyGoogleIdToken(sign({ iss: 'https://evil.example' }), opts));
  await assert.rejects(verifyGoogleIdToken(sign({ exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 }), opts));
  await assert.rejects(verifyGoogleIdToken(sign({ email_verified: false }), opts), /not verified/);
  await assert.rejects(verifyGoogleIdToken(sign({}, privateKey, 'unknown')), /set up|Unknown/);
  await assert.rejects(verifyGoogleIdToken('not-a-token', opts));
  await assert.rejects(verifyGoogleIdToken(jwt.sign({ sub: '1' }, 'secret', { algorithm: 'HS256' }), opts), /Not a Google/);
});
