import mongoose from 'mongoose';
import { Readable } from 'stream';

// Taken from Mongoose rather than importing the `mongodb` package directly:
// the driver is only present as one of Mongoose's own dependencies, so importing
// it by name would rely on a package we never declared and could break on a
// Mongoose upgrade. These always match the driver Mongoose is actually using.
const { GridFSBucket } = mongoose.mongo;
const { ObjectId } = mongoose.Types;

/**
 * Audio Storage Service — stores exam recordings in MongoDB GridFS.
 *
 * GridFS is used deliberately: Railway containers have ephemeral filesystems,
 * so anything written to disk is lost on redeploy. The MongoDB Atlas cluster is
 * already provisioned and persistent, so recordings live there instead. No
 * additional service, bucket or credential is required.
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

class AudioStorageService {
  getBucket() {
    if (mongoose.connection.readyState !== 1) {
      throw new Error('Database not connected — cannot access audio storage');
    }
    return new GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });
  }

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

    const bucket = this.getBucket();

    return new Promise((resolve, reject) => {
      const uploadStream = bucket.openUploadStream(filename, {
        contentType: contentType || 'audio/webm',
        metadata: {
          studentId: String(studentId),
          resultId: String(resultId),
          taskNumber,
          uploadedAt: new Date()
        }
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
   * Look up a recording's metadata without downloading it.
   * Returns null when the key is malformed or the file is gone.
   */
  async getMetadata(audioKey) {
    if (!ObjectId.isValid(audioKey)) return null;
    const files = await this.getBucket().find({ _id: new ObjectId(audioKey) }).toArray();
    return files[0] || null;
  }

  /** Open a readable stream for a stored recording. */
  openDownloadStream(audioKey) {
    if (!ObjectId.isValid(audioKey)) {
      throw new Error('Invalid audio key');
    }
    return this.getBucket().openDownloadStream(new ObjectId(audioKey));
  }

  /** Read a recording fully into memory (used for server-side transcription). */
  async readBuffer(audioKey) {
    const chunks = [];
    const stream = this.openDownloadStream(audioKey);
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  /** Delete a recording. Never throws — deletion is always best-effort cleanup. */
  async delete(audioKey) {
    try {
      if (!ObjectId.isValid(audioKey)) return false;
      await this.getBucket().delete(new ObjectId(audioKey));
      return true;
    } catch (error) {
      console.warn('Audio delete failed:', error.message);
      return false;
    }
  }
}

export default new AudioStorageService();
