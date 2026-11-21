import express from 'express';
import ExpertBatch from '../models/ExpertBatch.js';
import { authorize } from '../middleware/auth.js';
import { APIError } from '../middleware/errorHandler.js';
import crypto from 'crypto';
import { STRATA, createBatch, swapItem, keyCsv, writePack, linkManifest, answerAudio, picture, packEntries } from '../services/ExpertPack.js';

/**
 * The expert calibration pack (2026-11-21), mounted at /api/admin/expert-pack.
 *   GET  /            the open batch (or null)
 *   POST /            pick a new batch of 15
 *   POST /swap/:code  replace one mock with another from its level band
 *   GET  /pack.zip    the examiner's ZIP (codes only, no names or AI scores)
 *   GET  /key.csv     the teacher's key: code → student, test, AI bands
 */
const router = express.Router();
router.use(authorize('admin'));

export const LINK_DAYS = 5;
const linkBase = (req, token) => `${req.protocol}://${req.get('host')}/api/expert-files/${token}`;

const view = (b, req) => (b ? {
  id: String(b._id),
  link: b.shareToken && b.shareUntil > new Date() && req ? linkBase(req, b.shareToken) : null,
  linkUntil: b.shareToken && b.shareUntil > new Date() ? b.shareUntil : null,
  createdAt: b.createdAt,
  available: b.available,
  items: b.items.map(i => ({
    code: i.code, stratum: STRATA.find(s => s.key === i.stratum)?.label || i.stratum,
    student: i.student, exam: i.exam, completedAt: i.completedAt,
    aiScore: i.aiScore, aiLevel: i.aiLevel, aiBands: i.aiBands
  }))
} : null);

const open = () => ExpertBatch.findOne({ closedAt: null }).sort({ createdAt: -1 });

router.get('/', async (req, res, next) => {
  try { res.json({ success: true, data: view(await open(), req) }); } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const batch = await createBatch({ by: req.user.email || String(req.user.id) });
    if (!batch.items.length) throw new APIError('No marked full mocks since 12 October could be used.', 409);
    res.json({ success: true, data: view(batch, req) });
  } catch (e) { next(e); }
});

router.post('/swap/:code', async (req, res, next) => {
  try {
    const batch = await open();
    if (!batch) throw new APIError('Pick the 15 mocks first', 404);
    res.json({ success: true, data: view(await swapItem(batch, String(req.params.code)), req) });
  } catch (e) { next(e.statusCode ? new APIError(e.message, e.statusCode) : e); }
});

/** The private link for the Google script: makes a new one, valid for LINK_DAYS days. */
router.post('/link', async (req, res, next) => {
  try {
    const batch = await open();
    if (!batch) throw new APIError('Pick the 15 mocks first', 404);
    batch.shareToken = crypto.randomBytes(24).toString('hex');
    batch.shareUntil = new Date(Date.now() + LINK_DAYS * 864e5);
    await batch.save();
    res.json({ success: true, data: view(batch, req) });
  } catch (e) { next(e); }
});

/** Stop the link at once (when the form is built, or if it leaked). */
router.delete('/link', async (req, res, next) => {
  try {
    const batch = await open();
    if (batch) { batch.shareToken = undefined; batch.shareUntil = undefined; await batch.save(); }
    res.json({ success: true, data: view(batch, req) });
  } catch (e) { next(e); }
});

const stamp = d => new Date(d).toISOString().slice(0, 10);

router.get('/pack.zip', async (req, res, next) => {
  try {
    const batch = await open();
    if (!batch) throw new APIError('Pick the 15 mocks first', 404);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="EnglishHub-calibration-${stamp(batch.createdAt)}.zip"`);
    res.set('Cache-Control', 'no-store');
    await writePack(batch, res);
  } catch (e) { if (res.headersSent) { console.error('Expert pack failed:', e); res.end(); } else next(e); }
});

router.get('/key.csv', async (req, res, next) => {
  try {
    const batch = await open();
    if (!batch) throw new APIError('Pick the 15 mocks first', 404);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="KEY-do-not-share-${stamp(batch.createdAt)}.csv"`);
    res.set('Cache-Control', 'no-store');
    res.send(keyCsv(batch));
  } catch (e) { next(e); }
});

export default router;

/**
 * The private link (no sign-in): the Google script reads the manifest, then
 * each recording and picture. Only codes and questions — no names, no AI
 * scores. Works only while the link is valid.
 */
export const filesRouter = express.Router();
const byToken = async token => {
  if (!/^[a-f0-9]{48}$/.test(String(token))) return null;
  const b = await ExpertBatch.findOne({ shareToken: token, closedAt: null });
  return b && b.shareUntil > new Date() ? b : null;
};
const entriesCache = new Map(); // token → entries, so 120 file requests do not re-read the batch each time
async function entriesFor(b) {
  const hit = entriesCache.get(b.shareToken);
  if (hit && hit.at > Date.now() - 10 * 60e3) return hit.entries;
  const entries = await packEntries(b);
  entriesCache.set(b.shareToken, { at: Date.now(), entries });
  return entries;
}

filesRouter.get('/:token/manifest.json', async (req, res, next) => {
  try {
    const b = await byToken(req.params.token);
    if (!b) return res.status(404).json({ success: false, message: 'This link has expired. Make a new one in the teacher panel.' });
    res.set('Cache-Control', 'no-store');
    res.json(await linkManifest(b, linkBase(req, b.shareToken)));
  } catch (e) { next(e); }
});

filesRouter.get('/:token/:kind(audio|picture)/:code/:n', async (req, res, next) => {
  try {
    const b = await byToken(req.params.token);
    if (!b) return res.status(404).end();
    const cand = (await entriesFor(b)).find(c => c.code === req.params.code);
    const i = Number(req.params.n) - 1;
    const entry = req.params.kind === 'audio' ? cand?.answers[i] : cand?.pictures[i];
    if (!entry || (req.params.kind === 'audio' && !entry.audioKey)) return res.status(404).end();
    const file = req.params.kind === 'audio' ? await answerAudio(entry.audioKey) : await picture(entry.key);
    res.set({ 'Content-Type': file.type, 'Content-Disposition': `attachment; filename="${entry.name}.${file.ext}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(file.buffer);
  } catch (e) { next(e); }
});
