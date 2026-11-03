import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import mongoose from 'mongoose';
import { sniffImage } from './Premium.js';

/**
 * Photos students share (friends' chat, posts, stories, exam certificates)
 * and the photos on the reviews wall.
 *
 * Kept on the Railway volume when there is one — the same disk as the
 * recordings, a few cents a GB-month — and in a GridFS bucket otherwise (a
 * local run without a volume). MongoDB's free 512 MB would fill up quickly
 * with photos, so the volume is the normal home.
 *
 * The browser shrinks every photo before it is sent (at most 1280 px, JPEG),
 * so one is usually 100-300 KB. Who may SEE a photo is decided by the route
 * that serves it, never here.
 */

const { GridFSBucket } = mongoose.mongo;
const { ObjectId } = mongoose.Types;

export const MAX_PHOTO_BYTES = 1200 * 1024;

export function mediaDir() {
  if (process.env.MEDIA_DIR) return process.env.MEDIA_DIR;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'media');
  return null;
}

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

/** A photo as the browser sends it (a data URL) → { buffer, contentType }, checked by its bytes. */
export function readPhoto(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw fail('Rasm JPEG, PNG yoki WebP bo‘lishi kerak');
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > MAX_PHOTO_BYTES) throw fail('Rasm juda katta — kichikroq rasm tanlang');
  const contentType = sniffImage(buffer);
  if (!contentType) throw fail('Bu fayl rasm emas');
  return { buffer, contentType };
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

class MediaStorage {
  bucket() {
    if (mongoose.connection.readyState !== 1) throw new Error('Database not connected');
    return new GridFSBucket(mongoose.connection.db, { bucketName: 'media' });
  }

  diskPath(key, contentType) {
    const dir = mediaDir();
    if (!dir || !ObjectId.isValid(key)) return null;
    return path.join(dir, `${key}.${EXT[contentType] || 'img'}`);
  }

  /** Store a checked photo. Returns its key (a 24-hex id). */
  async store({ buffer, contentType }, { owner, purpose }) {
    const key = new ObjectId().toString();
    const file = this.diskPath(key, contentType);
    if (file) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tmp, buffer);
      await fsp.rename(tmp, file);
      return key;
    }
    await new Promise((resolve, reject) => {
      const up = this.bucket().openUploadStream(`${purpose}-${owner}`, {
        id: new ObjectId(key), contentType, metadata: { owner: String(owner), purpose, at: new Date() }
      });
      Readable.from(buffer).pipe(up).on('error', reject).on('finish', resolve);
    });
    return key;
  }

  /** Send a stored photo on an HTTP response (404 when it is gone). */
  serve(res, key, contentType) {
    res.set({
      'Content-Type': contentType || 'image/jpeg',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'private, max-age=86400'
    });
    const file = this.diskPath(key, contentType);
    const stream = file && fs.existsSync(file)
      ? fs.createReadStream(file)
      : (ObjectId.isValid(key) ? this.bucket().openDownloadStream(new ObjectId(key)) : null);
    if (!stream) return res.status(404).end();
    stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); }).pipe(res);
  }

  /** Best-effort delete. */
  async delete(key, contentType) {
    if (!ObjectId.isValid(key)) return false;
    try {
      const file = this.diskPath(key, contentType);
      if (file && fs.existsSync(file)) { await fsp.unlink(file); return true; }
      await this.bucket().delete(new ObjectId(key));
      return true;
    } catch {
      return false;
    }
  }
}

export const mediaStorage = new MediaStorage();
export default mediaStorage;
