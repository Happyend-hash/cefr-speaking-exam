import crypto from 'crypto';
import jwt from 'jsonwebtoken';

/**
 * "Sign in with Google" (Google Identity Services).
 *
 * The browser shows Google's own button; when the student picks an account,
 * Google hands the page a signed ID token (a JWT). The page sends it here and
 * we check it ourselves — signature against Google's published keys, issuer,
 * audience (our client id), expiry and a verified email — before trusting a
 * single field in it. No Google secret is needed for this, only the public
 * client id (GOOGLE_CLIENT_ID).
 */

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

export const googleClientId = () => String(process.env.GOOGLE_CLIENT_ID || '').trim();
export const googleConfigured = () => /\.apps\.googleusercontent\.com$/.test(googleClientId());

let keys = null;          // kid -> KeyObject
let keysUntil = 0;

async function googleKeys(fetchImpl = fetch, force = false) {
  if (!force && keys && Date.now() < keysUntil) return keys;
  const res = await fetchImpl(CERTS_URL);
  if (!res.ok) throw new Error(`Google keys: HTTP ${res.status}`);
  const body = await res.json();
  const next = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kty === 'RSA' && jwk.kid) next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
  }
  if (!next.size) throw new Error('Google keys: none published');
  // Google sends Cache-Control: max-age; keep them at most that long (1 hour by default).
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers?.get?.('cache-control') || '')?.[1]) || 3600;
  keys = next;
  keysUntil = Date.now() + Math.min(maxAge, 6 * 3600) * 1000;
  return keys;
}

/** For tests: forget the cached keys. */
export const _resetGoogleKeys = () => { keys = null; keysUntil = 0; };

/**
 * Check a Google ID token. Returns { sub, email, givenName, familyName, name, picture }
 * or throws an Error with a short reason.
 */
export async function verifyGoogleIdToken(idToken, { clientId = googleClientId(), fetchImpl = fetch } = {}) {
  if (!clientId) throw new Error('Google sign-in is not set up');
  const token = String(idToken || '');
  const header = jwt.decode(token, { complete: true })?.header;
  if (!header?.kid || header.alg !== 'RS256') throw new Error('Not a Google sign-in token');

  let set = await googleKeys(fetchImpl);
  if (!set.has(header.kid)) set = await googleKeys(fetchImpl, true);   // Google rotated its keys
  const key = set.get(header.kid);
  if (!key) throw new Error('Unknown Google key');

  const claims = jwt.verify(token, key, { algorithms: ['RS256'], audience: clientId, issuer: ISSUERS, clockTolerance: 60 });
  if (!claims.sub || !claims.email) throw new Error('Google did not share an email address');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('This Google account’s email is not verified');

  return {
    sub: String(claims.sub),
    email: String(claims.email).trim().toLowerCase(),
    givenName: String(claims.given_name || '').trim(),
    familyName: String(claims.family_name || '').trim(),
    name: String(claims.name || '').trim(),
    picture: String(claims.picture || '')
  };
}

export default { verifyGoogleIdToken, googleConfigured, googleClientId };
