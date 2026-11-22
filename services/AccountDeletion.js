import crypto from 'crypto';
import mongoose from 'mongoose';
import User from '../models/User.js';
import ExamResult from '../models/ExamResult.js';
import WritingAttempt from '../models/WritingAttempt.js';
import ScoreRecord from '../models/ScoreRecord.js';
import VocabMistake from '../models/VocabMistake.js';
import GamePoint from '../models/GamePoint.js';
import DailyActivity from '../models/DailyActivity.js';
import PushSubscription from '../models/PushSubscription.js';
import ResultShare from '../models/ResultShare.js';
import Message from '../models/Message.js';
import SupportMessage from '../models/SupportMessage.js';
import SupportImage from '../models/SupportImage.js';
import WallCertificate from '../models/WallCertificate.js';
import ChatMessage from '../models/ChatMessage.js';
import ChatRoom from '../models/ChatRoom.js';
import Material from '../models/Material.js';
import VoiceSession from '../models/VoiceSession.js';
import Payment from '../models/Payment.js';
import PaymentTransaction from '../models/PaymentTransaction.js';
import { Friendship, SocialBlock, Conversation, DirectMessage, SocialPost, SocialReport, SocialComment } from '../models/Social.js';
import AudioStorageService from './AudioStorageService.js';
import { mediaStorage } from './MediaStorage.js';
import { avatarStorage } from './Premium.js';

/**
 * "Hisobni o'chirish" (2026-11-22, for Google Play): a student deletes their
 * own account and what they made on the site.
 *
 * Deleted: the account, every speaking and writing attempt with its
 * recordings, scores, games, friends, chats, posts, photos, messages and
 * support conversation.
 *
 * Kept: payment records. They are the business's accounting, so the payment
 * rows stay, with the name and email copied onto them ("deletedAccount"),
 * because the account they pointed to is gone. Payments are never deleted.
 *
 * A one-way hash of the email is kept too, so deleting and signing up again
 * does not hand out another free mock. The address itself is not stored.
 */

const DeletedAccount = mongoose.models.DeletedAccount || mongoose.model('DeletedAccount', new mongoose.Schema({
  emailHash: { type: String, required: true, unique: true },
  at: { type: Date, default: Date.now }
}));

export const emailHash = email => crypto.createHash('sha256').update(`eh-deleted:${String(email || '').trim().toLowerCase()}`).digest('hex');

/** Was an account with this email deleted before? (New accounts from it get no free mock.) */
export async function wasDeleted(email) {
  if (!email) return false;
  return Boolean(await DeletedAccount.exists({ emailHash: emailHash(email) }));
}

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const quiet = promise => Promise.resolve(promise).catch(() => false);

export async function deleteAccount(userId, { confirmEmail } = {}) {
  if (!mongoose.isValidObjectId(userId)) throw fail('Hisob topilmadi', 404);
  const id = new mongoose.Types.ObjectId(String(userId));
  const user = await User.findById(id).select('email firstName lastName role picture').lean();
  if (!user) throw fail('Hisob topilmadi', 404);
  if (user.role !== 'student') throw fail('O‘qituvchi va admin hisoblari bu yerdan o‘chirilmaydi', 400);
  if (String(confirmEmail || '').trim().toLowerCase() !== user.email) throw fail('Email manzil mos kelmadi — hisobingiz emailini aynan yozing', 400);

  // 1. Payments stay; they get the name and email, as the account goes away.
  const snapshot = { email: user.email, name: `${user.firstName || ''} ${user.lastName || ''}`.trim(), at: new Date() };
  await PaymentTransaction.collection.updateMany({ student: id }, { $set: { deletedAccount: snapshot } });
  await Payment.collection.updateMany({ user: id }, { $set: { deletedAccount: snapshot } });
  // Checkouts not started at Click yet can no longer be paid (Prepare answers "cancelled").
  await PaymentTransaction.updateMany({ student: id, status: 'pending' }, { $set: { status: 'cancelled' } });

  // 2. Recordings and photos (files first, while the rows still say where they are).
  const audio = [];
  for (const r of await ExamResult.find({ student: id }).select('taskResults.audioKey').lean()) {
    for (const t of r.taskResults || []) if (t.audioKey) audio.push(t.audioKey);
  }
  for (const m of await ChatMessage.find({ user: id, audioKey: { $exists: true, $ne: null } }).select('audioKey').lean()) audio.push(m.audioKey);
  const voice = await VoiceSession.find({ 'recordings.user': id }).select('recordings').lean();
  for (const s of voice) for (const rec of s.recordings || []) if (String(rec.user) === String(id) && rec.audioKey) audio.push(rec.audioKey);

  const convs = await Conversation.find({ users: id }).select('_id').lean();
  const convIds = convs.map(c => c._id);
  const photos = [];
  for (const m of await DirectMessage.find({ conv: { $in: convIds } }).select('photo audioKey').lean()) {
    if (m.photo?.key) photos.push(m.photo);
    if (m.audioKey) audio.push(m.audioKey);
  }
  const posts = await SocialPost.find({ user: id }).select('_id photo').lean();
  for (const p of posts) if (p.photo?.key) photos.push(p.photo);
  for (const c of await WallCertificate.find({ user: id }).select('photo').lean()) if (c.photo?.key) photos.push(c.photo);

  for (const key of audio) await quiet(AudioStorageService.delete(key));
  for (const p of photos) await quiet(mediaStorage.delete(p.key, p.type));
  if (user.picture?.key) await quiet(avatarStorage.delete(user.picture.key));

  // 3. Everything that was theirs.
  const postIds = posts.map(p => p._id);
  await Promise.all([
    ExamResult.deleteMany({ student: id }),
    WritingAttempt.deleteMany({ student: id }),
    ScoreRecord.deleteMany({ student: id }),
    VocabMistake.deleteMany({ user: id }),
    GamePoint.deleteMany({ user: id }),
    DailyActivity.deleteMany({ user: id }),
    PushSubscription.deleteMany({ user: id }),
    ResultShare.deleteMany({ owner: id }),
    Message.deleteMany({ user: id }),
    SupportMessage.deleteMany({ user: id }),
    SupportImage.deleteMany({ user: id }),
    WallCertificate.deleteMany({ user: id }),
    ChatMessage.deleteMany({ user: id }),
    ChatRoom.deleteMany({ host: id }),
    ChatRoom.updateMany({ kicked: id }, { $pull: { kicked: id } }),
    Material.updateMany({ viewers: id }, { $pull: { viewers: id } }),
    VoiceSession.updateMany({ 'recordings.user': id }, { $pull: { recordings: { user: id } } }),
    VoiceSession.updateMany({ 'participants.user': id }, { $set: { 'participants.$[p].name': 'O‘chirilgan hisob' } }, { arrayFilters: [{ 'p.user': id }] }),
    Friendship.deleteMany({ users: id }),
    SocialBlock.deleteMany({ $or: [{ by: id }, { user: id }] }),
    DirectMessage.deleteMany({ conv: { $in: convIds } }),
    Conversation.deleteMany({ _id: { $in: convIds } }),
    SocialComment.deleteMany({ $or: [{ user: id }, { post: { $in: postIds } }] }),
    SocialPost.deleteMany({ user: id }),
    SocialPost.updateMany({ likes: id }, { $pull: { likes: id } }),
    SocialReport.deleteMany({ $or: [{ by: id }, { targetUser: id }] }),
    User.updateMany({ 'testAccount.user': id }, { $unset: { testAccount: 1 } })
  ]);

  await DeletedAccount.updateOne({ emailHash: emailHash(user.email) }, { $setOnInsert: { at: new Date() } }, { upsert: true });
  await User.deleteOne({ _id: id });
  console.log(`Account deleted by its owner: ${id} (${audio.length} recordings, ${photos.length} photos)`);
  return { deleted: true };
}

export default { deleteAccount, wasDeleted, emailHash };
