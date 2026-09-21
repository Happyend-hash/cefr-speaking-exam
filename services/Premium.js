import crypto from 'crypto';
import mongoose from 'mongoose';
import { Readable } from 'stream';

// From Mongoose rather than `mongodb` directly — the driver is only present as
// one of Mongoose's dependencies (same as ImageStorageService).
const { GridFSBucket } = mongoose.mongo;
const { ObjectId } = mongoose.Types;

/**
 * Premium: what a paying student gets in the speaking club.
 *
 *   - a crown next to their name (voice rooms, chat, leaderboard)
 *   - their own picture or animated GIF as avatar — free students keep
 *     coloured initials
 *   - a gold name and a glowing ring round their avatar
 *   - a sixth seat in a full club, and first pick when a partner comes free
 *
 * Premium runs for PREMIUM_DAYS (30) from each payment — the teacher's
 * "Add package" or a grant of paid mocks — and stacks: paying again while
 * still Premium adds 30 days to the end. The teacher can also switch it on or
 * off by hand. When it runs out the picture is kept but not shown, and comes
 * back the moment they pay again.
 */

export const PREMIUM_DAYS = Number(process.env.PREMIUM_DAYS) || 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const isStaff = user => user?.role === 'admin' || user?.role === 'teacher';

export function isPremium(user, now = Date.now()) {
  const until = user?.premiumUntil ? new Date(user.premiumUntil).getTime() : 0;
  return until > now;
}

/** Add days to the end of Premium (or start it today). Returns the new end date. */
export function extendPremium(user, days = PREMIUM_DAYS, now = Date.now()) {
  const current = user.premiumUntil ? new Date(user.premiumUntil).getTime() : 0;
  user.premiumUntil = new Date(Math.max(now, current) + days * DAY_MS);
  return user.premiumUntil;
}

export function endPremium(user) {
  user.premiumUntil = null;
}

/** Whole days left, rounded up; 0 when not Premium. */
export function premiumDaysLeft(user, now = Date.now()) {
  if (!isPremium(user, now)) return 0;
  return Math.ceil((new Date(user.premiumUntil).getTime() - now) / DAY_MS);
}

/** The picture's address, if it should be shown: Premium and not removed. */
export function avatarUrl(user, now = Date.now()) {
  return isPremium(user, now) && user?.picture?.token ? `/api/avatars/${user.picture.token}` : null;
}

/** What other students see next to a name. */
export function badgeOf(user, now = Date.now()) {
  return { premium: isPremium(user, now), avatar: avatarUrl(user, now) };
}

/** The fields to select from User for badgeOf. */
export const BADGE_FIELDS = 'premiumUntil picture role';

// ------------------------------------------------------------ pictures

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * What kind of image this really is, from its first bytes — never from the
 * file name or what the browser claims. Only these four are accepted; SVG in
 * particular is not, because an SVG can carry script.
 */
export function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const ascii = (start, end) => buffer.subarray(start, end).toString('latin1');
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (buffer[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export const newAvatarToken = () => crypto.randomBytes(16).toString('hex');

/** Pictures live in their own bucket, apart from exam images and audio. */
class AvatarStorage {
  bucket() {
    if (mongoose.connection.readyState !== 1) throw new Error('Database not connected');
    return new GridFSBucket(mongoose.connection.db, { bucketName: 'avatars' });
  }

  store(buffer, { contentType, userId }) {
    return new Promise((resolve, reject) => {
      const upload = this.bucket().openUploadStream(`avatar-${userId}`, {
        contentType,
        metadata: { userId: String(userId), at: new Date() }
      });
      Readable.from(buffer)
        .pipe(upload)
        .on('error', reject)
        .on('finish', () => resolve(upload.id.toString()));
    });
  }

  open(key) {
    return this.bucket().openDownloadStream(new ObjectId(key));
  }

  async delete(key) {
    try {
      if (!key || !ObjectId.isValid(key)) return false;
      await this.bucket().delete(new ObjectId(key));
      return true;
    } catch (error) {
      console.warn('Avatar delete failed:', error.message);
      return false;
    }
  }
}

export const avatarStorage = new AvatarStorage();

/**
 * Tell the live rooms that a student's badge changed. The hubs are passed in
 * rather than imported so this file stays free of the rooms.
 */
export function announceBadge(user, hubs) {
  const badge = badgeOf(user);
  for (const hub of hubs) hub?.updateUser?.(String(user._id), badge);
}

export default {
  PREMIUM_DAYS, isPremium, extendPremium, endPremium, premiumDaysLeft,
  avatarUrl, badgeOf, sniffImage, avatarStorage, MAX_AVATAR_BYTES
};
