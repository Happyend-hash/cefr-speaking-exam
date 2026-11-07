import express from 'express';
import multer from 'multer';
import { authorize } from '../middleware/auth.js';
import { APIError } from '../middleware/errorHandler.js';
import Materials, { MAX_MEDIA_BYTES } from '../services/Materials.js';

/**
 * "Materiallar" (2026-11-07).
 *   /api/materials/f/:token/:name   the file itself, by a signed link (no sign-in token needed)
 *   /api/materials                  the student's list (signed in)
 *   /api/admin/materials            the teacher's tools
 */
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e.statusCode && !(e instanceof APIError) ? new APIError(e.message, e.statusCode) : e); }
};
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export const fileRouter = express.Router();
fileRouter.get('/:token/:name?', handle(async (req, res) => Materials.sendMaterialFile(res, req.params.token, { download: req.query.dl === '1' })));

const router = express.Router();
router.get('/', handle(async (req, res) => ok(res, await Materials.studentMaterials(req.user.id))));
router.post('/:id/open', handle(async (req, res) => { await Materials.noteOpen(req.user.id, req.params.id); ok(res, { opened: true }); }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MEDIA_BYTES, files: 1 } });

export const adminRouter = express.Router();
adminRouter.use(authorize('admin'));
adminRouter.get('/', handle(async (req, res) => ok(res, await Materials.adminMaterials())));
adminRouter.post('/', (req, res, next) => upload.single('file')(req, res, async error => {
  try {
    if (error?.code === 'LIMIT_FILE_SIZE') throw new APIError('Too big: at most 30 MB', 413);
    if (error) throw new APIError(error.message, 400);
    const item = await Materials.createMaterial(req.body || {}, req.file || null, req.user.email || String(req.user.id));
    ok(res, { item, ...(await Materials.adminMaterials()) }, 201);
  } catch (e) { next(e.statusCode && !(e instanceof APIError) ? new APIError(e.message, e.statusCode) : e); }
}));
adminRouter.patch('/:id', handle(async (req, res) => { await Materials.updateMaterial(req.params.id, req.body || {}); ok(res, await Materials.adminMaterials()); }));
adminRouter.post('/:id/move', handle(async (req, res) => { await Materials.moveMaterial(req.params.id, req.body?.dir === 'up' ? 'up' : 'down'); ok(res, await Materials.adminMaterials()); }));
adminRouter.delete('/:id', handle(async (req, res) => { await Materials.deleteMaterial(req.params.id); ok(res, await Materials.adminMaterials()); }));

export default router;
