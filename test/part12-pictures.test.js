/** The Part 1.2 pictures go to the marker, shrunk; a refused picture never costs the mark. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { Readable } from 'stream';
import axios from 'axios';
import ImageStorageService from '../services/ImageStorageService.js';
import { partTwelvePictures } from '../services/ExamPictures.js';
import svc from '../services/AIEvaluationService.js';

const png = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=2000x1200', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1']);
const KEY = 'aaaaaaaaaaaaaaaaaaaaaaaa';

test('the Part 1.2 picture is read, shrunk to JPEG and handed over once', async () => {
  const saved = { meta: ImageStorageService.getMetadata, open: ImageStorageService.openDownloadStream };
  let opened = 0;
  ImageStorageService.getMetadata = async () => ({ contentType: 'image/png' });
  ImageStorageService.openDownloadStream = () => { opened += 1; return Readable.from([png]); };
  try {
    const flat = [{ part: '1.1', images: [] }, { part: '1.2', images: [`/api/exam/images/${KEY}`] }, { part: '1.2', images: [`/api/exam/images/${KEY}`] }];
    const pics = await partTwelvePictures(flat);
    assert.equal(pics.length, 1);
    assert.equal(pics[0].mediaType, 'image/jpeg');
    assert.ok(Buffer.from(pics[0].data, 'base64').length < png.length, 'smaller than the original');
    await partTwelvePictures(flat);
    assert.equal(opened, 1, 'kept in memory after the first read');
    assert.deepEqual(await partTwelvePictures([{ part: '2', images: [] }]), []);
  } finally {
    ImageStorageService.getMetadata = saved.meta; ImageStorageService.openDownloadStream = saved.open;
  }
});

test('the picture goes to Claude before the text, and a refused picture is dropped, not the mark', async () => {
  const saved = axios.post;
  const sent = [];
  axios.post = async (url, payload) => {
    sent.push(payload);
    if (Array.isArray(payload.messages[0].content)) {
      const e = new Error('bad image'); e.response = { status: 400, data: { error: { message: 'Could not process image' } } }; throw e;
    }
    return { data: { content: [{ type: 'text', text: '{"ok":1}' }], stop_reason: 'end_turn', usage: {} } };
  };
  try {
    const out = await svc.callClaudeAPI({ cached: 'rubric', user: 'answer', images: [{ mediaType: 'image/jpeg', data: 'AAAA' }] });
    assert.equal(out, '{"ok":1}');
    const first = sent[0].messages[0].content;
    assert.equal(first[0].type, 'image');
    assert.equal(first[0].source.media_type, 'image/jpeg');
    assert.equal(first[1].type, 'text');
    assert.equal(typeof sent[1].messages[0].content, 'string', 'asked again without the picture');
  } finally { axios.post = saved; }
});
