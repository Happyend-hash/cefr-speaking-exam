import { spawn } from 'child_process';
import ImageStorageService from './ImageStorageService.js';

/**
 * The Part 1.2 pictures, ready to show the marker (Jamshid, 2026-11-22).
 *
 * The marker used to be told "the student was shown pictures; you cannot see
 * them", so a description that matched the pictures well and one that missed
 * half of them read the same. Claude can look at images, so the pictures the
 * student saw now go in with the transcript.
 *
 * Each picture is shrunk to at most 1024 px on its longest side as JPEG (fewer
 * tokens, same evidence) and kept in memory: exam pictures never change.
 */

const MAX_SIDE = 1024;
const cache = new Map();          // key → { mediaType, data } (base64)
const CACHE_MAX = 60;

export const imageKey = img => String(img?.url || img || '').match(/([a-f0-9]{24})/)?.[1] || null;

function shrink(buffer) {
  return new Promise(resolve => {
    let done = false;
    const out = [];
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-vf', `scale='min(${MAX_SIDE},iw)':'min(${MAX_SIDE},ih)':force_original_aspect_ratio=decrease`,
      '-frames:v', '1', '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1']);
    const finish = v => { if (!done) { done = true; resolve(v); } };
    ff.stdout.on('data', c => out.push(c));
    ff.on('error', () => finish(null));
    ff.on('close', code => finish(code === 0 && out.length ? Buffer.concat(out) : null));
    ff.stdin.on('error', () => {});
    ff.stdin.end(buffer);
    setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } finish(null); }, 20000);
  });
}

const OK_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** One stored picture as { mediaType, data }, or null if it cannot be read. */
export async function pictureForMarker(key) {
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  try {
    const meta = await ImageStorageService.getMetadata(key);
    if (!meta) return null;
    const chunks = [];
    for await (const c of ImageStorageService.openDownloadStream(key)) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const small = await shrink(raw);
    let picture = null;
    if (small) picture = { mediaType: 'image/jpeg', data: small.toString('base64') };
    else if (OK_TYPES.includes(meta.contentType) && raw.length < 3.5 * 1024 * 1024) picture = { mediaType: meta.contentType, data: raw.toString('base64') };
    if (picture) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, picture);
    }
    return picture;
  } catch (error) {
    console.warn(`Part 1.2 picture ${key} could not be read for the marker: ${error.message}`);
    return null;
  }
}

/** The pictures of an exam's Part 1.2 (from its flattened questions), at most `max`. */
export async function partTwelvePictures(questions = [], max = 2) {
  const section = questions.find(q => String(q.part) === '1.2' && (q.images || []).length);
  if (!section) return [];
  const keys = [...new Set((section.images || []).map(imageKey).filter(Boolean))].slice(0, max);
  return (await Promise.all(keys.map(pictureForMarker))).filter(Boolean);
}

export default { pictureForMarker, partTwelvePictures, imageKey };
