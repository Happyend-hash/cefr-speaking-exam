import express from 'express';
import mongoose from 'mongoose';
import { APIError } from '../middleware/errorHandler.js';
import AudioStorageService from '../services/AudioStorageService.js';
import * as Shares from '../services/ResultShare.js';

/**
 * Sharing mock results (2026-11-10). See services/ResultShare.js.
 *   /api/share  (signed in)  — make, change or stop a share
 *   /api/r      (public)     — the verification page's data and recordings
 */
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e.statusCode && !(e instanceof APIError) ? new APIError(e.message, e.statusCode, e.code) : e); }
};
const kindOf = k => { if (k !== 'speaking' && k !== 'writing') throw new APIError('Unknown result kind', 400); return k; };
const idOf = id => { if (!mongoose.Types.ObjectId.isValid(id)) throw new APIError('Invalid result id', 400); return id; };

export const router = express.Router();
router.post('/', handle(async (req, res) => ok(res, await Shares.share(req.user.id, {
  kind: kindOf(req.body?.kind), id: idOf(req.body?.id), details: Boolean(req.body?.details)
}))));
router.get('/:kind/:id', handle(async (req, res) => ok(res, { share: await Shares.mine(req.user.id, kindOf(req.params.kind), idOf(req.params.id)) })));
router.delete('/:code', handle(async (req, res) => ok(res, await Shares.revoke(req.user.id, String(req.params.code)))));

export const publicRouter = express.Router();
publicRouter.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
publicRouter.get('/:code', handle(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  ok(res, await Shares.publicView(String(req.params.code).toUpperCase()));
}));
publicRouter.get('/:code/audio/:n', handle(async (req, res) => {
  const key = await Shares.sharedAudio(String(req.params.code).toUpperCase(), req.params.n);
  const file = await AudioStorageService.getMetadata(key);
  if (!file) throw new APIError('Audio topilmadi', 404);
  res.set('Content-Type', file.contentType || 'audio/webm');
  res.set('Content-Length', String(file.length));
  res.set('Cache-Control', 'private, max-age=600');
  const stream = AudioStorageService.openDownloadStream(key);
  stream.on('error', err => res.destroy(err));
  stream.pipe(res);
}));

export default router;
