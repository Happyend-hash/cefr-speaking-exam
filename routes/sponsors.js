import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { Readable } from 'stream';
import Sponsor, { PLACES } from '../models/Sponsor.js';
import { sniffImage } from '../services/Premium.js';
import { APIError } from '../middleware/errorHandler.js';

/**
 * Sponsor banners.
 *
 *   Public (no sign-in, so an <img> and a plain link work):
 *     GET /api/sponsors/slot/:place   one banner for that screen, or null; counts a view
 *     GET /api/sponsors/:id/image     the picture
 *     GET /api/sponsors/:id/go        counts a click, then sends the visitor on
 *
 *   Teacher (/api/admin/sponsors):
 *     GET / · POST / (multipart: image, name, link, places, endsAt)
 *     PUT /:id (name, link, places, active, endsAt) · POST /:id/image · DELETE /:id
 *
 * Banners never appear inside a test, a call or a result — the screens simply
 * have no slot there (public/app.js adSlot).
 */

const { GridFSBucket } = mongoose.mongo;
const { ObjectId } = mongoose.Types;
const MAX_BANNER_BYTES = 1024 * 1024; // 1 MB

const bucket = () => {
  if (mongoose.connection.readyState !== 1) throw new Error('Database not connected');
  return new GridFSBucket(mongoose.connection.db, { bucketName: 'sponsors' });
};
export const bannerStorage = {
  store(buffer, contentType) {
    return new Promise((resolve, reject) => {
      const up = bucket().openUploadStream('banner', { contentType });
      Readable.from(buffer).pipe(up).on('error', reject).on('finish', () => resolve(up.id.toString()));
    });
  },
  open: key => bucket().openDownloadStream(new ObjectId(key)),
  async delete(key) {
    try { if (key && ObjectId.isValid(key)) await bucket().delete(new ObjectId(key)); return true; } catch { return false; }
  }
};

const isValidId = id => mongoose.Types.ObjectId.isValid(id);

/** Only ordinary web addresses: never javascript:, data: or anything else. */
export function cleanLink(raw) {
  const text = String(raw || '').trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const cleanPlaces = raw => {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const places = list.map(p => String(p).trim()).filter(p => PLACES.includes(p));
  return [...new Set(places)];
};

const publicBanner = s => ({
  id: String(s._id),
  name: s.name,
  image: `/api/sponsors/${s._id}/image?v=${s.image?.key || ''}`,
  go: `/api/sponsors/${s._id}/go`
});

// ------------------------------------------------------------- public

export const publicRouter = express.Router();

publicRouter.get('/slot/:place', async (req, res, next) => {
  try {
    const place = String(req.params.place);
    if (!PLACES.includes(place)) return res.json({ success: true, data: null });
    const now = new Date();
    const live = await Sponsor.find({
      active: true,
      places: place,
      'image.key': { $exists: true }
    }).select('name image endsAt').lean();
    const open = live.filter(s => !s.endsAt || new Date(s.endsAt) > now);
    if (!open.length) return res.json({ success: true, data: null });
    // Equal turns: every live banner is as likely as the next.
    const pick = open[Math.floor(Math.random() * open.length)];
    Sponsor.updateOne({ _id: pick._id }, { $inc: { views: 1 } }).catch(() => {});
    res.json({ success: true, data: publicBanner(pick) });
  } catch (error) {
    next(error);
  }
});

publicRouter.get('/:id/image', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).end();
    const s = await Sponsor.findById(req.params.id).select('image').lean();
    if (!s?.image?.key) return res.status(404).end();
    res.set({
      'Content-Type': s.image.contentType || 'image/png',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'public, max-age=86400'
    });
    bannerStorage.open(s.image.key)
      .on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); })
      .pipe(res);
  } catch (error) {
    next(error);
  }
});

publicRouter.get('/:id/go', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).end();
    const s = await Sponsor.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } }, { new: true }).select('link').lean();
    const link = cleanLink(s?.link);
    if (!link) return res.status(404).end();
    res.redirect(302, link);
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------- teacher

export const adminRouter = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BANNER_BYTES, files: 1 } });

// Checked on every route, not once with router.use, so no route can miss it.
const staffOnly = (req, res, next) =>
  req.user?.role === 'admin' || req.user?.role === 'teacher' ? next() : next(new APIError('Teachers only', 403));

const adminView = s => ({
  id: String(s._id),
  name: s.name,
  link: s.link,
  places: s.places || [],
  active: Boolean(s.active),
  endsAt: s.endsAt || null,
  image: s.image?.key ? `/api/sponsors/${s._id}/image?v=${s.image.key}` : null,
  views: s.views || 0,
  clicks: s.clicks || 0,
  createdAt: s.createdAt
});

/** Run multer, turning its size error into a message the teacher can act on. */
const withImage = handler => (req, res, next) =>
  upload.single('image')(req, res, error => {
    if (error?.code === 'LIMIT_FILE_SIZE') return next(new APIError('The banner must be 1 MB or smaller.', 413));
    if (error) return next(error);
    Promise.resolve(handler(req, res, next)).catch(next);
  });

async function storeImage(file) {
  const contentType = sniffImage(file?.buffer);
  if (!contentType) throw new APIError('Upload a GIF, PNG, JPG or WEBP picture.', 415);
  const key = await bannerStorage.store(file.buffer, contentType);
  return { key, contentType, bytes: file.buffer.length };
}

adminRouter.get('/', staffOnly, async (req, res, next) => {
  try {
    const list = await Sponsor.find({}).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: { sponsors: list.map(adminView), places: PLACES } });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/', staffOnly, withImage(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const link = cleanLink(req.body?.link);
  if (!name) throw new APIError("Give the sponsor's name.", 400);
  if (!link) throw new APIError('Give a web address starting with https://', 400);
  if (!req.file) throw new APIError('Choose a banner picture.', 400);
  const places = cleanPlaces(req.body?.places);
  const endsAt = req.body?.endsAt ? new Date(req.body.endsAt) : null;
  const image = await storeImage(req.file);
  const s = await Sponsor.create({
    name, link, image,
    places: places.length ? places : PLACES,
    endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null
  });
  res.status(201).json({ success: true, data: adminView(s) });
}));

adminRouter.put('/:id', staffOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid banner', 400);
    const s = await Sponsor.findById(req.params.id);
    if (!s) throw new APIError('Banner not found', 404);
    const b = req.body || {};
    if (b.name !== undefined) s.name = String(b.name).trim().slice(0, 80) || s.name;
    if (b.link !== undefined) {
      const link = cleanLink(b.link);
      if (!link) throw new APIError('Give a web address starting with https://', 400);
      s.link = link;
    }
    if (b.places !== undefined) s.places = cleanPlaces(b.places);
    if (b.active !== undefined) s.active = Boolean(b.active);
    if (b.endsAt !== undefined) {
      const d = b.endsAt ? new Date(b.endsAt) : null;
      s.endsAt = d && !Number.isNaN(d.getTime()) ? d : null;
    }
    await s.save();
    res.json({ success: true, data: adminView(s) });
  } catch (error) {
    next(error);
  }
});

adminRouter.post('/:id/image', staffOnly, withImage(async (req, res) => {
  if (!isValidId(req.params.id)) throw new APIError('Invalid banner', 400);
  const s = await Sponsor.findById(req.params.id);
  if (!s) throw new APIError('Banner not found', 404);
  if (!req.file) throw new APIError('Choose a banner picture.', 400);
  const old = s.image?.key;
  s.image = await storeImage(req.file);
  await s.save();
  if (old) await bannerStorage.delete(old);
  res.json({ success: true, data: adminView(s) });
}));

adminRouter.delete('/:id', staffOnly, async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) throw new APIError('Invalid banner', 400);
    const s = await Sponsor.findById(req.params.id);
    if (!s) throw new APIError('Banner not found', 404);
    if (s.image?.key) await bannerStorage.delete(s.image.key);
    await Sponsor.deleteOne({ _id: s._id });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default publicRouter;
