import express from 'express';
import Push from '../services/Push.js';

/**
 * Phone notifications — /api/push (signed in).
 *   GET  /key          the site's public key, for the browser to subscribe with
 *   POST /subscribe    { subscription, agent } — this phone wants notifications
 *   POST /unsubscribe  { endpoint } — it no longer does (or signed out)
 *   GET  /count        the number for the app icon
 */
const router = express.Router();
const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
const ok = (res, data) => res.json({ success: true, data });

router.get('/key', handle(async (req, res) => ok(res, { key: await Push.publicKey() })));
router.post('/subscribe', handle(async (req, res) => {
  await Push.subscribe(req.user.id, req.body?.subscription, req.body?.agent);
  ok(res, { subscribed: true });
}));
router.post('/unsubscribe', handle(async (req, res) => {
  await Push.unsubscribe(req.user.id, req.body?.endpoint);
  ok(res, { subscribed: false });
}));
router.get('/count', handle(async (req, res) => ok(res, { count: await Push.badgeCount(req.user.id) })));

export default router;
