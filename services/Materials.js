import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import mongoose from 'mongoose';
import Material from '../models/Material.js';
import User from '../models/User.js';
import { MATERIAL_FOLDERS, MATERIAL_LEVELS } from '../content/materials.js';
import { sniffImage, isPremium } from './Premium.js';
import { notifyMany } from './Push.js';

/**
 * "Materiallar" (Jamshid, 2026-11-07): study materials for students, filed
 * by skill (Speaking, Writing, Reading, Listening …) and sub-folder.
 *
 *  - Files are checked by their bytes (PDF, Word/PowerPoint/Excel, pictures,
 *    audio, MP4 video) and kept on the Railway volume (GridFS when there is
 *    no volume, i.e. a local run).
 *  - Students open a file through a signed link that works for a few hours,
 *    so the phone's own PDF viewer, audio player and downloads work without
 *    the sign-in token. Only signed-in students get links; Premium-only items
 *    get links only for Premium students.
 */

const { GridFSBucket } = mongoose.mongo;
const { ObjectId } = mongoose.Types;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const isId = id => mongoose.Types.ObjectId.isValid(String(id || ''));

export const MAX_DOC_BYTES = 20 * 1024 * 1024;     // PDF, Word, slides, sheets, pictures
export const MAX_MEDIA_BYTES = 30 * 1024 * 1024;   // audio, video
const LINK_TTL_MS = 6 * 3600 * 1000;
const NEW_FOR_MS = 7 * 24 * 3600 * 1000;

const FOLDER_KEYS = MATERIAL_FOLDERS.map(f => f.key);
const OFFICE = {
  docx: ['word', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  pptx: ['slides', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  xlsx: ['sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  doc: ['word', 'application/msword'],
  ppt: ['slides', 'application/vnd.ms-powerpoint'],
  xls: ['sheet', 'application/vnd.ms-excel']
};

/** What a file really is, by its first bytes (and, for Office files, its extension). */
export function sniffMaterial(buffer, name = '') {
  if (!buffer || buffer.length < 12) return null;
  const ext = String(name).toLowerCase().split('.').pop();
  const ascii = (a, b) => buffer.subarray(a, b).toString('latin1');
  if (ascii(0, 5) === '%PDF-') return { kind: 'pdf', type: 'application/pdf', ext: 'pdf' };
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04 && ['docx', 'pptx', 'xlsx'].includes(ext)) {
    return { kind: OFFICE[ext][0], type: OFFICE[ext][1], ext };
  }
  if (buffer.readUInt32BE(0) === 0xd0cf11e0 && ['doc', 'ppt', 'xls'].includes(ext)) return { kind: OFFICE[ext][0], type: OFFICE[ext][1], ext };
  const image = sniffImage(buffer);
  if (image) return { kind: 'image', type: image, ext: image.split('/')[1].replace('jpeg', 'jpg') };
  if (ascii(0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return { kind: 'audio', type: 'audio/mpeg', ext: 'mp3' };
  if (ascii(0, 4) === 'OggS') return { kind: 'audio', type: 'audio/ogg', ext: 'ogg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { kind: 'audio', type: 'audio/wav', ext: 'wav' };
  if (ascii(4, 8) === 'ftyp') {
    return ext === 'mp4' || ext === 'mov'
      ? { kind: 'video', type: 'video/mp4', ext: 'mp4' }
      : { kind: 'audio', type: 'audio/mp4', ext: 'm4a' };
  }
  return null;
}

// ------------------------------------------------------------- storage

export function materialsDir() {
  if (process.env.MATERIALS_DIR) return process.env.MATERIALS_DIR;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'materials');
  return null;
}
const bucket = () => new GridFSBucket(mongoose.connection.db, { bucketName: 'materials' });
const diskPath = (key, ext) => (materialsDir() && isId(key) ? path.join(materialsDir(), `${key}.${ext}`) : null);
const extOf = m => String(m.file?.name || '').toLowerCase().split('.').pop() || 'bin';

async function storeFile(buffer, ext) {
  const key = new ObjectId().toString();
  const file = diskPath(key, ext);
  if (file) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, file);
    return key;
  }
  await new Promise((resolve, reject) => {
    const up = bucket().openUploadStream(`material.${ext}`, { id: new ObjectId(key) });
    Readable.from(buffer).pipe(up).on('error', reject).on('finish', resolve);
  });
  return key;
}

async function deleteFile(m) {
  const key = m.file?.key;
  if (!isId(key)) return;
  try {
    const file = diskPath(key, extOf(m));
    if (file && fs.existsSync(file)) await fsp.unlink(file);
    else await bucket().delete(new ObjectId(key));
  } catch { /* already gone */ }
}

// ------------------------------------------------------------- signed links

const secret = () => `${process.env.JWT_SECRET || 'dev'}:materials`;
const b64 = s => Buffer.from(s).toString('base64url');

export function signLink(id, now = Date.now()) {
  const body = `${id}.${(now + LINK_TTL_MS).toString(36)}`;
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 32);
  return `${b64(body)}.${mac}`;
}

export function readLink(token, now = Date.now()) {
  const [enc, mac] = String(token || '').split('.');
  if (!enc || !mac) return null;
  let body;
  try { body = Buffer.from(enc, 'base64url').toString(); } catch { return null; }
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url').slice(0, 32);
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  const [id, exp] = body.split('.');
  if (!isId(id) || parseInt(exp, 36) < now) return null;
  return id;
}

const safeName = name => String(name || 'file').replace(/[^\p{L}\p{N}._ -]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';

/** Send a material's file. `download` → saved as a file instead of opened. */
export async function sendMaterialFile(res, token, { download = false } = {}) {
  const id = readLink(token);
  if (!id) return res.status(410).type('text/plain').send('Bu havola eskirgan — Materiallar sahifasini yangilang.');
  const m = await Material.findById(id).lean();
  if (!m || m.hidden || !m.file?.key) return res.status(404).type('text/plain').send('Topilmadi');
  const name = safeName(m.file.name);
  res.removeHeader('Content-Security-Policy');        // the phone's PDF viewer must be free to open it
  res.set({
    'Content-Type': m.file.type || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `${download || ['word', 'slides', 'sheet'].includes(m.kind) ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`
  });
  if (!['pdf', 'image', 'audio', 'video'].includes(m.kind)) res.set('Content-Security-Policy', "default-src 'none'");
  const file = diskPath(m.file.key, extOf(m));
  if (file && fs.existsSync(file)) return res.sendFile(file, { headers: { 'Content-Type': m.file.type } });
  try {
    bucket().openDownloadStream(new ObjectId(m.file.key))
      .on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); })
      .pipe(res);
  } catch { res.status(404).end(); }
  return undefined;
}

// ------------------------------------------------------------- views

const folderInfo = () => MATERIAL_FOLDERS.map(f => ({ key: f.key, title: f.title, icon: f.icon, sections: f.sections }));

function orderedSections(folder, items) {
  const suggested = MATERIAL_FOLDERS.find(f => f.key === folder)?.sections || [];
  const used = [...new Set(items.map(i => i.section).filter(Boolean))];
  return [...suggested.filter(s => used.includes(s)), ...used.filter(s => !suggested.includes(s)).sort()];
}

const fileView = (m, { open }) => {
  const token = open ? signLink(String(m._id)) : null;
  const name = encodeURIComponent(safeName(m.file?.name || m.title));
  return {
    id: String(m._id), folder: m.folder, section: m.section || '', title: m.title, description: m.description || '',
    level: m.level, kind: m.kind, premium: Boolean(m.premium), locked: !open,
    size: m.file?.size || null, ext: m.kind === 'link' ? null : extOf(m),
    href: m.kind === 'link' ? (open ? m.url : null) : (token ? `/api/materials/f/${token}/${name}` : null),
    download: m.kind === 'link' || !token ? null : `/api/materials/f/${token}/${name}?dl=1`,
    isNew: Date.now() - new Date(m.createdAt).getTime() < NEW_FOR_MS,
    at: m.createdAt
  };
};

/** Everything a student may see, with fresh links. */
export async function studentMaterials(userId) {
  const user = await User.findById(userId).select('role premiumUntil').lean();
  if (!user) throw fail('Foydalanuvchi topilmadi', 404);
  const premium = isPremium(user) || user.role === 'admin' || user.role === 'teacher';
  const list = await Material.find({ hidden: false }).sort({ order: 1, createdAt: -1 }).lean();
  const items = list.map(m => fileView(m, { open: !m.premium || premium }));
  const folders = folderInfo().map(f => {
    const mine = items.filter(i => i.folder === f.key);
    return { ...f, count: mine.length, fresh: mine.filter(i => i.isNew).length, sections: orderedSections(f.key, mine) };
  });
  return { folders, items, premium };
}

export async function noteOpen(userId, id) {
  if (!isId(id)) return;
  await Material.updateOne({ _id: id }, { $inc: { views: 1 }, $addToSet: { viewers: userId } }).catch(() => {});
}

// ------------------------------------------------------------- teacher

const adminView = m => ({
  ...fileView(m, { open: true }),
  hidden: Boolean(m.hidden), order: m.order || 0, views: m.views || 0, students: m.viewersCount ?? (m.viewers || []).length,
  fileName: m.file?.name || '', url: m.url || ''
});

export async function adminMaterials() {
  const list = await Material.find({}).select('+viewers').sort({ folder: 1, section: 1, order: 1, createdAt: -1 }).lean();
  return { folders: folderInfo(), levels: MATERIAL_LEVELS, items: list.map(adminView) };
}

function cleanFields(body = {}, { partial = false } = {}) {
  const out = {};
  const has = k => body[k] !== undefined;
  if (!partial || has('folder')) {
    if (!FOLDER_KEYS.includes(body.folder)) throw fail('Choose a folder');
    out.folder = body.folder;
  }
  if (!partial || has('title')) {
    const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!title) throw fail('Give it a title');
    out.title = title;
  }
  if (!partial || has('section')) out.section = String(body.section || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!partial || has('description')) out.description = String(body.description || '').trim().slice(0, 400);
  if (!partial || has('level')) out.level = MATERIAL_LEVELS.includes(body.level) ? body.level : 'all';
  const flag = v => v === true || v === 'true' || v === '1' || v === 'on';
  if (!partial || has('premium')) out.premium = flag(body.premium);
  if (!partial || has('hidden')) out.hidden = flag(body.hidden);
  return out;
}

function cleanUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw fail('Paste a full link, starting with https://'); }
  if (!['https:', 'http:'].includes(u.protocol)) throw fail('Only http(s) links');
  return u.toString().slice(0, 1000);
}

export async function createMaterial(body = {}, file = null, by = '') {
  const fields = cleanFields(body);
  let doc;
  if (file?.buffer?.length) {
    const what = sniffMaterial(file.buffer, file.originalname);
    if (!what) throw fail('This file type is not accepted: use PDF, Word, PowerPoint, Excel, a picture, MP3/M4A audio or MP4 video');
    const limit = ['audio', 'video'].includes(what.kind) ? MAX_MEDIA_BYTES : MAX_DOC_BYTES;
    if (file.buffer.length > limit) throw fail(`Too big: at most ${Math.round(limit / 1048576)} MB for this kind of file`, 413);
    const key = await storeFile(file.buffer, what.ext);
    const base = safeName(file.originalname).replace(/\.[^.]+$/, '') || safeName(fields.title);
    doc = { ...fields, kind: what.kind, file: { key, name: `${base}.${what.ext}`, type: what.type, size: file.buffer.length } };
  } else if (body.url) {
    doc = { ...fields, kind: 'link', url: cleanUrl(body.url) };
  } else {
    throw fail('Choose a file or paste a link');
  }
  const last = await Material.findOne({ folder: doc.folder, section: doc.section }).sort({ order: -1 }).select('order').lean();
  const m = await Material.create({ ...doc, order: (last?.order ?? -1) + 1, createdBy: by });
  const notify = body.notify === true || body.notify === 'true' || body.notify === '1';
  if (notify && !m.hidden) {
    const folder = MATERIAL_FOLDERS.find(f => f.key === m.folder);
    User.find({ role: 'student' }).select('_id').lean()
      .then(list => notifyMany(list.map(u => u._id), {
        title: '📚 Yangi material', body: `${folder?.title || ''}: ${m.title}`, url: '/?open=materials', kind: 'material'
      }))
      .catch(() => {});
  }
  return adminView(m.toObject());
}

export async function updateMaterial(id, body = {}) {
  const m = isId(id) ? await Material.findById(id) : null;
  if (!m) throw fail('Material not found', 404);
  Object.assign(m, cleanFields(body, { partial: true }));
  if (body.url !== undefined && m.kind === 'link') m.url = cleanUrl(body.url);
  await m.save();
  return adminView(m.toObject());
}

/** Up or down within its sub-folder. */
export async function moveMaterial(id, dir) {
  const m = isId(id) ? await Material.findById(id) : null;
  if (!m) throw fail('Material not found', 404);
  const siblings = await Material.find({ folder: m.folder, section: m.section }).sort({ order: 1, createdAt: -1 });
  const i = siblings.findIndex(s => String(s._id) === String(m._id));
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= siblings.length) return true;
  [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
  await Promise.all(siblings.map((s, k) => (s.order === k ? null : Material.updateOne({ _id: s._id }, { $set: { order: k } }))));
  return true;
}

export async function deleteMaterial(id) {
  const m = isId(id) ? await Material.findById(id) : null;
  if (!m) throw fail('Material not found', 404);
  await deleteFile(m);
  await m.deleteOne();
  return true;
}

export default {
  sniffMaterial, signLink, readLink, sendMaterialFile, studentMaterials, noteOpen,
  adminMaterials, createMaterial, updateMaterial, moveMaterial, deleteMaterial
};
