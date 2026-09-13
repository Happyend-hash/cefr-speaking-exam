import mongoose from 'mongoose';
import { Readable } from 'stream';

// Taken from Mongoose rather than importing `mongodb` directly — the driver is
// only present as one of Mongoose's dependencies.
const { GridFSBucket } = mongoose.mongo;
const { ObjectId } = mongoose.Types;

/**
 * Exam image storage.
 *
 * Kept in GridFS alongside the recordings, for the same reason: Railway's
 * filesystem is ephemeral, so an uploaded picture written to disk disappears at
 * the next deploy and Part 1.2 would silently lose its images.
 *
 * A separate bucket from the audio so the two can be managed independently.
 */

const BUCKET_NAME = 'examImages';

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Maximum accepted image size, in bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

class ImageStorageService {
  getBucket() {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Database not connected — cannot access image storage');
    }
    return new GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
  }

  /**
   * Store an uploaded image.
   * @returns {Promise<{key: string, url: string, bytes: number}>}
   */
  async store(buffer, { filename, contentType, uploadedBy }) {
    if (!buffer || buffer.length === 0) throw new Error('Empty image upload');
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds the ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB limit`);
    }

    const bucket = this.getBucket();

    return new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(filename || 'exam-image', {
        contentType: contentType || 'image/jpeg',
        metadata: { uploadedBy: String(uploadedBy), uploadedAt: new Date() }
      });

      Readable.from(buffer)
        .pipe(uploadStream)
        .on('error', reject)
        .on('finish', () => {
          const key = uploadStream.id.toString();
          resolve({ key, url: `/api/exam/images/${key}`, bytes: buffer.length });
        });
    });
  }

  async getMetadata(key) {
    if (!ObjectId.isValid(key)) return null;
    const files = await this.getBucket().find({ _id: new ObjectId(key) }).toArray();
    return files[0] || null;
  }

  openDownloadStream(key) {
    if (!ObjectId.isValid(key)) throw new Error('Invalid image key');
    return this.getBucket().openDownloadStream(new ObjectId(key));
  }

  /** List stored images, newest first — the picker in the admin page. */
  async list(limit = 100) {
    const files = await this.getBucket()
      .find({})
      .sort({ uploadDate: -1 })
      .limit(limit)
      .toArray();

    return files.map(f => ({
      key: f._id.toString(),
      url: `/api/exam/images/${f._id}`,
      filename: f.filename,
      bytes: f.length,
      uploadedAt: f.uploadDate
    }));
  }

  /** Best-effort delete; never throws. */
  async delete(key) {
    try {
      if (!ObjectId.isValid(key)) return false;
      await this.getBucket().delete(new ObjectId(key));
      return true;
    } catch (error) {
      console.warn('Image delete failed:', error.message);
      return false;
    }
  }
}

export default new ImageStorageService();
