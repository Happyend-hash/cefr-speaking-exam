import mongoose from 'mongoose';
import WallReview from '../models/WallReview.js';
import WallCertificate from '../models/WallCertificate.js';
import User from '../models/User.js';
import { mediaStorage, readPhoto } from './MediaStorage.js';
import { fallbackName } from './Leaderboard.js';

/**
 * "Natijalar va fikrlar" — the public wall (Jamshid, 2026-11-03):
 *   - reviews of the website, written by the teacher;
 *   - real exam certificates uploaded by students, shown once the teacher
 *     approves them.
 * Everyone can see the wall, signed in or not.
 */

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const isId = id => mongoose.Types.ObjectId.isValid(String(id || ''));

export const MAX_PENDING = 3;       // a student's certificates waiting for the teacher at once
export const LEVELS = ['B1', 'B2', 'C1'];

const scoreOf = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 75) throw fail('Ball 0 dan 75 gacha bo‘lishi kerak');
  return Math.round(n * 10) / 10;
};

// ------------------------------------------------------------- shapes

export const reviewView = (r, { admin = false } = {}) => ({
  id: String(r._id),
  name: r.name,
  label: r.label || '',
  text: r.text,
  stars: r.stars || 5,
  photo: r.photo?.key ? `/api/wall/photo/review/${r._id}` : null,
  at: r.createdAt,
  ...(admin ? { published: r.published, pinned: r.pinned } : {})
});

export const certificateView = (c, { admin = false, mine = false } = {}) => ({
  id: String(c._id),
  name: c.name,
  level: c.level,
  overall: c.overall ?? null,
  speaking: c.speaking ?? null,
  writing: c.writing ?? null,
  listening: c.listening ?? null,
  reading: c.reading ?? null,
  examMonth: c.examMonth || null,
  story: c.story || '',
  photo: c.status === 'approved' && !admin && !mine
    ? `/api/wall/photo/certificate/${c._id}`
    : (admin ? `/api/admin/wall/certificates/${c._id}/photo` : `/api/wall/me/certificates/${c._id}/photo`),
  at: c.reviewedAt || c.createdAt,
  ...(admin || mine ? { status: c.status, reason: c.reason || '', submittedAt: c.createdAt } : {}),
  ...(admin ? { user: c.user?.email ? { id: String(c.user._id), email: c.user.email, name: fallbackName(c.user) } : null } : {})
});

// ------------------------------------------------------------- public

export async function publicWall() {
  const [reviews, results] = await Promise.all([
    WallReview.find({ published: true }).sort({ pinned: -1, createdAt: -1 }).limit(100).lean(),
    WallCertificate.find({ status: 'approved' }).sort({ reviewedAt: -1 }).limit(200).lean()
  ]);
  const count = l => results.filter(r => r.level === l).length;
  return {
    reviews: reviews.map(r => reviewView(r)),
    results: results.map(c => certificateView(c)),
    counts: { results: results.length, C1: count('C1'), B2: count('B2'), B1: count('B1'), reviews: reviews.length }
  };
}

/** A photo the public may see: a published review's or an approved certificate's. */
export async function publicPhoto(kind, id) {
  if (!isId(id)) return null;
  if (kind === 'review') {
    const r = await WallReview.findOne({ _id: id, published: true }).select('photo').lean();
    return r?.photo?.key ? r.photo : null;
  }
  if (kind === 'certificate') {
    const c = await WallCertificate.findOne({ _id: id, status: 'approved' }).select('photo').lean();
    return c?.photo?.key ? c.photo : null;
  }
  return null;
}

// ------------------------------------------------------------- students

export async function myCertificates(userId) {
  const list = await WallCertificate.find({ user: userId }).sort({ createdAt: -1 }).limit(20).lean();
  return list.map(c => certificateView(c, { mine: true }));
}

export async function submitCertificate(userId, body = {}) {
  const user = await User.findById(userId).select('firstName lastName nickname role access').lean();
  if (!user) throw fail('Foydalanuvchi topilmadi', 404);
  if (user.access?.blocked) throw fail('Hisobingiz vaqtincha to‘xtatilgan', 403);
  const pending = await WallCertificate.countDocuments({ user: userId, status: 'pending' });
  if (pending >= MAX_PENDING) throw fail('Avvalgi natijalaringiz hali tekshirilmoqda — biroz kuting', 429);

  const level = String(body.level || '').toUpperCase();
  if (!LEVELS.includes(level)) throw fail('Darajani tanlang (B1, B2 yoki C1)');
  const scores = Object.fromEntries(['overall', 'speaking', 'writing', 'listening', 'reading'].map(k => [k, scoreOf(body[k])]));
  if (scores.speaking === null && scores.writing === null) throw fail('Kamida Speaking yoki Writing balini yozing');
  const examMonth = /^\d{4}-\d{2}$/.test(String(body.examMonth || '')) ? String(body.examMonth) : null;
  const name = String(body.name || '').trim().slice(0, 60) || [user.firstName, user.lastName].filter(Boolean).join(' ') || fallbackName(user);
  const story = String(body.story || '').replace(/\s+\n/g, '\n').trim().slice(0, 600);
  if (!body.agree) throw fail('Natijangiz hammaga ko‘rinishiga rozilik bering');

  const photo = readPhoto(body.photo);
  const key = await mediaStorage.store(photo, { owner: userId, purpose: 'certificate' });
  const c = await WallCertificate.create({
    user: userId, name, level, ...scores, examMonth, story, photo: { key, type: photo.contentType }
  });
  return certificateView(c.toObject(), { mine: true });
}

export async function deleteMyCertificate(userId, id) {
  if (!isId(id)) throw fail('Topilmadi', 404);
  const c = await WallCertificate.findOne({ _id: id, user: userId });
  if (!c) throw fail('Topilmadi', 404);
  await mediaStorage.delete(c.photo?.key, c.photo?.type);
  await c.deleteOne();
  return true;
}

export async function myCertificatePhoto(userId, id) {
  if (!isId(id)) return null;
  const c = await WallCertificate.findOne({ _id: id, user: userId }).select('photo').lean();
  return c?.photo?.key ? c.photo : null;
}

// ------------------------------------------------------------- teacher

export async function adminWall() {
  const [reviews, certificates] = await Promise.all([
    WallReview.find().sort({ pinned: -1, createdAt: -1 }).limit(200).lean(),
    WallCertificate.find().sort({ createdAt: -1 }).limit(300).populate('user', 'email firstName lastName').lean()
  ]);
  const order = { pending: 0, approved: 1, rejected: 2 };
  return {
    reviews: reviews.map(r => reviewView(r, { admin: true })),
    certificates: certificates
      .sort((a, b) => order[a.status] - order[b.status] || new Date(b.createdAt) - new Date(a.createdAt))
      .map(c => certificateView(c, { admin: true })),
    pending: certificates.filter(c => c.status === 'pending').length
  };
}

export async function pendingCertificates() {
  return WallCertificate.countDocuments({ status: 'pending' });
}

export async function saveReview(id, body = {}, by = '') {
  const name = String(body.name ?? '').trim();
  const text = String(body.text ?? '').trim();
  if (!name) throw fail('Write the student’s name');
  if (!text) throw fail('Write what the student said');
  const fields = {
    name: name.slice(0, 60),
    label: String(body.label || '').trim().slice(0, 60),
    text: text.slice(0, 1200),
    stars: Math.min(5, Math.max(1, Math.round(Number(body.stars) || 5))),
    published: body.published !== false,
    pinned: Boolean(body.pinned)
  };
  let review = id ? await WallReview.findById(isId(id) ? id : null) : new WallReview({ createdBy: by });
  if (!review) throw fail('Review not found', 404);
  Object.assign(review, fields);
  if (body.photo) {
    const photo = readPhoto(body.photo);
    const key = await mediaStorage.store(photo, { owner: by || 'teacher', purpose: 'review' });
    if (review.photo?.key) await mediaStorage.delete(review.photo.key, review.photo.type);
    review.photo = { key, type: photo.contentType };
  } else if (body.removePhoto && review.photo?.key) {
    await mediaStorage.delete(review.photo.key, review.photo.type);
    review.photo = undefined;
  }
  await review.save();
  return reviewView(review.toObject(), { admin: true });
}

export async function deleteReview(id) {
  const r = isId(id) ? await WallReview.findById(id) : null;
  if (!r) throw fail('Review not found', 404);
  if (r.photo?.key) await mediaStorage.delete(r.photo.key, r.photo.type);
  await r.deleteOne();
  return true;
}

export async function reviewCertificate(id, { action, reason = '', by = '' }) {
  const c = isId(id) ? await WallCertificate.findById(id) : null;
  if (!c) throw fail('Certificate not found', 404);
  if (action === 'approve') { c.status = 'approved'; c.reason = ''; }
  else if (action === 'reject') { c.status = 'rejected'; c.reason = String(reason || '').trim().slice(0, 300); }
  else if (action === 'hide') { c.status = 'pending'; }
  else throw fail('Unknown action');
  c.reviewedAt = new Date();
  c.reviewedBy = by;
  await c.save();
  return c;
}

export async function deleteCertificate(id) {
  const c = isId(id) ? await WallCertificate.findById(id) : null;
  if (!c) throw fail('Certificate not found', 404);
  await mediaStorage.delete(c.photo?.key, c.photo?.type);
  await c.deleteOne();
  return true;
}

export async function adminCertificatePhoto(id) {
  if (!isId(id)) return null;
  const c = await WallCertificate.findById(id).select('photo').lean();
  return c?.photo?.key ? c.photo : null;
}

export default {
  publicWall, publicPhoto, myCertificates, submitCertificate, deleteMyCertificate, myCertificatePhoto,
  adminWall, pendingCertificates, saveReview, deleteReview, reviewCertificate, deleteCertificate, adminCertificatePhoto
};
