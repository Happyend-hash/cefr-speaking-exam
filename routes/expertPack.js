import express from 'express';
import ExpertBatch from '../models/ExpertBatch.js';
import { authorize } from '../middleware/auth.js';
import { APIError } from '../middleware/errorHandler.js';
import { STRATA, createBatch, swapItem, keyCsv, writePack } from '../services/ExpertPack.js';

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

const view = b => (b ? {
  id: String(b._id),
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
  try { res.json({ success: true, data: view(await open()) }); } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const batch = await createBatch({ by: req.user.email || String(req.user.id) });
    if (!batch.items.length) throw new APIError('No marked full mocks since 12 October could be used.', 409);
    res.json({ success: true, data: view(batch) });
  } catch (e) { next(e); }
});

router.post('/swap/:code', async (req, res, next) => {
  try {
    const batch = await open();
    if (!batch) throw new APIError('Pick the 15 mocks first', 404);
    res.json({ success: true, data: view(await swapItem(batch, String(req.params.code))) });
  } catch (e) { next(e.statusCode ? new APIError(e.message, e.statusCode) : e); }
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
