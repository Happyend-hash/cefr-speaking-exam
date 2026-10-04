import User from '../models/User.js';

/**
 * Keep new accounts out of the site until they confirm their email.
 *
 * The page already shows the code screen, but a page is only a suggestion:
 * the API is what holds the mocks, the games and the speaking rooms, so the
 * rule is enforced here, after `authenticate`, on every route group a student
 * uses. Who must confirm is decided in one place — User.needsEmailVerification()
 * — and existing accounts are never affected.
 *
 * Still allowed while unconfirmed: everything under /api/auth (the code
 * screen, resend, sign out) and reading one's own profile, which is how the
 * page learns whether to show the code screen at all.
 *
 * Accounts that are through stay through — verification is never undone, and
 * the rule only ever exempts more — so they are remembered in memory and cost
 * no database lookup after their first request.
 */
const cleared = new Set();

const ALLOWED_WHILE_UNVERIFIED = [
  { method: 'GET', path: /^\/api\/user\/profile\/?$/ }
];

export function forgetCleared() {
  cleared.clear();
}

export const requireVerifiedEmail = async (req, res, next) => {
  try {
    const id = req.user?.id;
    if (!id || cleared.has(String(id))) return next();
    if (req.user.role === 'admin' || req.user.role === 'teacher') return next();

    const path = req.originalUrl.split('?')[0];
    if (ALLOWED_WHILE_UNVERIFIED.some(rule => rule.method === req.method && rule.path.test(path))) {
      return next();
    }

    const user = await User.findById(id)
      .select('role isEmailVerified emailVerificationRequired createdAt');
    // A token for a deleted account: let the route answer as it always has.
    if (!user || !user.needsEmailVerification()) {
      cleared.add(String(id));
      return next();
    }

    return res.status(403).json({
      success: false,
      code: 'email_unverified',
      message: 'Confirm your email first — enter the 6-digit code we sent you.'
    });
  } catch (error) {
    next(error);
  }
};
