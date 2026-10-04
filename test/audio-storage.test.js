import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import mongoose from 'mongoose';
import AudioStorage, { audioDir } from '../services/AudioStorageService.js';

/**
 * Recordings on a Railway volume, and the move of old ones out of GridFS.
 * GridFS is replaced by an in-memory stand-in; the disk is a temp folder.
 */

const { ObjectId } = mongoose.Types;

function useTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-'));
  process.env.AUDIO_DIR = dir;
  return dir;
}

function fakeBucket(files) {
  const bucket = {
    deleted: [],
    find(query) {
      const rows = [...files.values()]
        .filter(f => !query?._id || String(f._id) === String(query._id))
        .map(({ data, ...doc }) => doc);
      return { toArray: async () => rows };
    },
    openDownloadStream(id) {
      const file = files.get(String(id));
      if (!file) throw new Error('FileNotFound');
      return Readable.from([file.data]);
    },
    async delete(id) {
      if (!files.delete(String(id))) throw new Error('FileNotFound: no file');
      bucket.deleted.push(String(id));
    }
  };
  AudioStorage.getBucket = () => bucket;
  return bucket;
}

test('without AUDIO_DIR or a Railway volume, storage stays in GridFS', () => {
  delete process.env.AUDIO_DIR;
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  assert.equal(audioDir(), null);
  assert.equal(AudioStorage.storage, 'gridfs');
  process.env.RAILWAY_VOLUME_MOUNT_PATH = '/data';
  assert.equal(audioDir(), path.join('/data', 'audio'));
  delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
});

test('a recording stored on disk can be read, streamed, described and deleted by its key', async () => {
  useTempDir();
  fakeBucket(new Map());
  const audio = Buffer.from('fake webm bytes');
  const { audioKey, bytes } = await AudioStorage.store(audio, {
    filename: 'a.webm', contentType: 'audio/webm', studentId: 's1', resultId: 'r1', taskNumber: 2
  });

  assert.ok(ObjectId.isValid(audioKey));
  assert.equal(bytes, audio.length);
  assert.deepEqual(await AudioStorage.readBuffer(audioKey), audio);

  const chunks = [];
  for await (const c of AudioStorage.openDownloadStream(audioKey)) chunks.push(c);
  assert.deepEqual(Buffer.concat(chunks), audio);

  const meta = await AudioStorage.getMetadata(audioKey);
  assert.equal(meta.length, audio.length);
  assert.equal(meta.contentType, 'audio/webm');
  assert.equal(meta.metadata.studentId, 's1'); // ownership check on playback reads this

  assert.equal(await AudioStorage.delete(audioKey), true);
  assert.equal(await AudioStorage.getMetadata(audioKey), null);
});

test('old GridFS recordings move to disk, verified, then leave GridFS; keys keep working', async () => {
  useTempDir();
  const id = new ObjectId().toString();
  const data = Buffer.from('old recording from september');
  const files = new Map([[id, {
    _id: id, length: data.length, filename: 'old.webm', contentType: 'audio/webm',
    uploadDate: new Date('2026-09-14'), metadata: { studentId: 's9' }, data
  }]]);
  const bucket = fakeBucket(files);

  // Before the move: still readable (falls back to GridFS).
  assert.deepEqual(await AudioStorage.readBuffer(id), data);

  const status = await AudioStorage.migrateFromGridFS({ pauseMs: 0 });
  assert.equal(status.moved, 1);
  assert.equal(status.failed, 0);
  assert.deepEqual(bucket.deleted, [id]);

  // After: same key, served from disk, same owner.
  assert.deepEqual(await AudioStorage.readBuffer(id), data);
  assert.equal((await AudioStorage.getMetadata(id)).metadata.studentId, 's9');
});

test('a recording that cannot be read in full is NOT deleted from GridFS', async () => {
  useTempDir();
  const id = new ObjectId().toString();
  const files = new Map([[id, {
    _id: id, length: 999, filename: 'x.webm', contentType: 'audio/webm',
    metadata: {}, data: Buffer.from('short')
  }]]);
  const bucket = fakeBucket(files);

  const status = await AudioStorage.migrateFromGridFS({ pauseMs: 0 });
  assert.equal(status.moved, 0);
  assert.equal(status.failed, 1);
  assert.deepEqual(bucket.deleted, []);
  assert.ok(files.has(id));
});
