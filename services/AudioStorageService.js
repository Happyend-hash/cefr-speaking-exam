import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import { Readable } from 'stream';

// Taken from Mongoose rather than importing the `mongodb` package directly:
// the driver is only present as one of Mongoose's own dependencies, so importing
// it by name would rely on a package we never declared and could break on a
// Mongoose upgrade. These always match the driver Mongoose is actually using.
const { GridFSBucket } = mongoose.mongo;
const { ObjectId } = mongoose.Types;

/**
 * Audio Storage Service — where exam and speaking-room recordings live.
 *
 * TWO PLACES, ONE KEY.
 *
 * Recordings used to live only in MongoDB GridFS, because Railway's container
 * disk is wiped on every deploy. That filled the free 512 MB Atlas cluster
 * (recordings were ~95% of it, growing ~30 MB a day). So when a Railway
 * VOLUME is attached — a disk that survives deploys, a few cents a GB-month —
 * recordings go there instead, and MongoDB keeps only the small data.
 *
 *   - Disk is used when AUDIO_DIR is set, or when Railway has mounted a
 *     volume (it sets RAILWAY_VOLUME_MOUNT_PATH; recordings go in /audio
 *     under it). Without either, everything stays in GridFS exactly as before.
 *   - Keys are the same 24-hex ObjectId strings either way, so every stored
 *     audioKey keeps working and nothing that holds a key has to change.
 *   - Reads look on disk first, then GridFS, so recordings not yet moved
 *     still play.
 *   - migrateFromGridFS() moves the old recordings over in the background,
 *     verifying each copy byte-for-byte before deleting the GridFS original.
 */

const BUCKET_NAME = 'examAudio';

export const ALLOWED_AUDIO_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav'
];

/** Maximum accepted recording size, in bytes. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB

/** The disk folder for recordings, or null to keep using GridFS. */
export function audioDir() {
  if (process.env.AUDIO_DIR) return process.env.AUDIO_DIR;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'audio');
  }
  return null;
}

class AudioStorageService {
  constructor() {
    this.migration = { state: 'idle', moved: 0, failed: 0, remaining: null, lastError: '' };
  }

  get storage() {
    return audioDir() ? 'disk' : 'gridfs';
  }

  getBucket() {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Database not connected — cannot access audio storage');
    }
    return new GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
  }

  // ------------------------------------------------------------------ disk

  diskPaths(audioKey) {
    const dir = audioDir();
    if (!dir || !ObjectId.isValid(audioKey)) return null;
    const key = String(audioKey);
    return { dir, data: path.join(dir, `${key}.audio`), meta: path.join(dir, `${key}.json`) };
  }

  /**
   * Write one recording to disk. The data is written to a temporary name and
   * renamed into place last, so a reader never sees half a file, and a crash
   * mid-write leaves nothing that looks like a recording.
   */
  async writeToDisk(audioKey, buffer, info) {
    const p = this.diskPaths(audioKey);
    await fsp.mkdir(p.dir, { recursive: true });
    const meta = {
      filename: info.filename,
      contentType: info.contentType || 'audio/webm',
      length: buffer.length,
      uploadDate: info.uploadDate || new Date(),
      metadata: info.metadata || {}
    };
    const tmp = `${p.data}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, buffer);
    await fsp.writeFile(p.meta, JSON.stringify(meta));
    await fsp.rename(tmp, p.data);
    return meta;
  }

  async readDiskMeta(audioKey) {
    const p = this.diskPaths(audioKey);
    if (!p) return null;
    try {
      const meta = JSON.parse(await fsp.readFile(p.meta, 'utf8'));
      // The data file is what makes a recording exist; metadata alone is a
      // write that never finished.
      await fsp.access(p.data);
      return meta;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------- public API

  /**
   * Store a recording.
   * @returns {Promise<{audioKey: string, bytes: number}>}
   */
  async store(buffer, { filename, contentType, studentId, resultId, taskNumber }) {
    if (!buffer || buffer.length === 0) {
      throw new Error('Empty audio upload');
    }
    if (buffer.length > MAX_AUDIO_BYTES) {
      throw new Error(`Audio exceeds the ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)}MB limit`);
    }

    const metadata = {
      studentId: String(studentId),
      resultId: String(resultId),
      taskNumber,
      uploadedAt: new Date()
    };

    if (audioDir()) {
      const audioKey = new ObjectId().toString();
      await this.writeToDisk(audioKey, buffer, { filename, contentType, metadata });
      return { audioKey, bytes: buffer.length };
    }

    const bucket = this.getBucket();
    return new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(filename, {
        contentType: contentType || 'audio/webm',
        metadata
      });

      Readable.from(buffer)
        .pipe(uploadStream)
        .on('error', reject)
        .on('finish', () =>
          resolve({ audioKey: uploadStream.id.toString(), bytes: buffer.length })
        );
    });
  }

  /**
   * Look up a recording's metadata without downloading it — the same shape
   * as a GridFS file document (length, contentType, metadata, filename).
   * Returns null when the key is malformed or the file is gone.
   */
  async getMetadata(audioKey) {
    if (!ObjectId.isValid(audioKey)) return null;
    const onDisk = await this.readDiskMeta(audioKey);
    if (onDisk) return { _id: String(audioKey), ...onDisk };
    const files = await this.getBucket().find({ _id: new ObjectId(audioKey) }).toArray();
    return files[0] || null;
  }

  /** Open a readable stream for a stored recording. */
  openDownloadStream(audioKey) {
    if (!ObjectId.isValid(audioKey)) {
      throw new Error('Invalid audio key');
    }
    const p = this.diskPaths(audioKey);
    if (p && fs.existsSync(p.data)) return fs.createReadStream(p.data);
    return this.getBucket().openDownloadStream(new ObjectId(audioKey));
  }

  /** Read a recording fully into memory (used for server-side transcription). */
  async readBuffer(audioKey) {
    const p = this.diskPaths(audioKey);
    if (p && fs.existsSync(p.data)) return fsp.readFile(p.data);
    const chunks = [];
    const stream = this.openDownloadStream(audioKey);
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  /** Delete a recording, wherever it is. Never throws — deletion is best-effort cleanup. */
  async delete(audioKey) {
    if (!ObjectId.isValid(audioKey)) return false;
    let deleted = false;

    const p = this.diskPaths(audioKey);
    if (p) {
      for (const file of [p.data, p.meta]) {
        try {
          await fsp.unlink(file);
          if (file === p.data) deleted = true;
        } catch (error) {
          if (error.code !== 'ENOENT') console.warn('Audio delete failed:', error.message);
        }
      }
    }

    // Always also try GridFS: a move interrupted between copying and deleting
    // can leave the recording in both places, and a deleted recording must
    // not survive in either.
    try {
      await this.getBucket().delete(new ObjectId(audioKey));
      deleted = true;
    } catch (error) {
      // "File not found" just means it was on disk only — the normal case now.
      if (!deleted && !/FileNotFound|not found/i.test(error.message)) {
        console.warn('Audio delete failed:', error.message);
      }
    }
    return deleted;
  }

  // -------------------------------------------------------------- migration

  /**
   * Move every recording still in GridFS onto the disk, one at a time.
   *
   * Each copy is read back from disk and compared byte-for-byte with the
   * original BEFORE the original is deleted; any mismatch or error leaves the
   * GridFS copy where it is and moves on. Safe to run again at any time — a
   * second run only finds what the first could not move. Sequential on
   * purpose: it runs beside live students and must not compete with them.
   */
  async migrateFromGridFS({ pauseMs = 50 } = {}) {
    if (!audioDir() || this.migration.state === 'running') return this.migration;
    const status = this.migration = { state: 'running', moved: 0, failed: 0, remaining: null, lastError: '' };

    try {
      const bucket = this.getBucket();
      const files = await bucket.find({}, { projection: { _id: 1 } }).toArray();
      status.remaining = files.length;

      for (const { _id } of files) {
        const audioKey = _id.toString();
        try {
          const [file] = await bucket.find({ _id }).toArray();
          if (!file) { status.remaining -= 1; continue; }

          const chunks = [];
          for await (const chunk of bucket.openDownloadStream(_id)) chunks.push(chunk);
          const original = Buffer.concat(chunks);
          if (original.length !== file.length) {
            throw new Error(`read ${original.length} of ${file.length} bytes`);
          }

          await this.writeToDisk(audioKey, original, {
            filename: file.filename,
            contentType: file.contentType,
            uploadDate: file.uploadDate,
            metadata: file.metadata
          });

          const copy = await fsp.readFile(this.diskPaths(audioKey).data);
          if (!copy.equals(original)) throw new Error('disk copy does not match the original');

          await bucket.delete(_id);
          status.moved += 1;
        } catch (error) {
          status.failed += 1;
          status.lastError = `${audioKey}: ${error.message}`;
          console.warn(`Recording ${audioKey} not moved to disk: ${error.message}`);
        }
        status.remaining -= 1;
        if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs));
      }
      status.state = 'done';
      console.log(`Recordings moved to disk: ${status.moved} moved, ${status.failed} left in MongoDB`);
    } catch (error) {
      status.state = 'error';
      status.lastError = error.message;
      console.error('Moving recordings to disk stopped:', error.message);
    }
    return status;
  }
}

export default new AudioStorageService();
