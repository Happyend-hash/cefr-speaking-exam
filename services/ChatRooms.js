import { ChatHub, isCommunityId, MAX_COMMUNITY_ROOMS } from './ChatHub.js';
import ChatMessage from '../models/ChatMessage.js';
import ChatRoom from '../models/ChatRoom.js';
import AudioStorageService from './AudioStorageService.js';
import { cleanMessage } from './ChatFilter.js';

/**
 * The one live text-room hub for this server, community rooms kept across
 * restarts, and clearing old messages (and their voice recordings) away.
 */

/** Messages older than this are deleted automatically. */
export const CHAT_RETENTION_DAYS = Number(process.env.CHAT_RETENTION_DAYS) || 30;

/** Longest voice message, in seconds, and its largest file. */
export const VOICE_MAX_SECONDS = 60;
export const VOICE_MAX_BYTES = 2 * 1024 * 1024;

export const chatHub = new ChatHub();

const roomId = doc => `room-${doc._id}`;
const docId = id => String(id).slice(5);

// ------------------------------------------------------------ community rooms

let loading = null;
/** Put the rooms that were open before a restart back in the hub (once). */
export function loadOpenRooms() {
  if (!loading) {
    loading = ChatRoom.find({ closedAt: null }).lean()
      .then(rooms => {
        for (const r of rooms) {
          chatHub.addRoom({
            id: roomId(r), name: r.name, topic: r.topic, level: r.level, createdAt: r.createdAt,
            host: { id: r.host, name: r.hostName, premium: r.hostPremium, avatar: r.hostAvatar },
            kicked: r.kicked || []
          });
        }
      })
      .catch(error => {
        console.error('Chat: could not load community rooms:', error.message);
        loading = null;
      });
  }
  return loading;
}

/**
 * Check what a student typed for a room's name or topic. Same filter as a
 * message: no swearing, links or phone numbers, written in English.
 */
export function cleanRoomText(raw, { field, min, max, required }) {
  const value = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!value) {
    if (required) return { ok: false, message: `${field} kerak.` };
    return { ok: true, text: '' };
  }
  if (value.length < min) return { ok: false, message: `${field} kamida ${min} ta harf bo'lsin.` };
  const cleaned = cleanMessage(value.slice(0, max));
  if (!cleaned.ok) return { ok: false, message: cleaned.message || `${field}ni tekshiring.` };
  if (cleaned.changed) return { ok: false, message: `${field}da havola, raqam yoki noo'rin so'z bo'lmasin.` };
  return { ok: true, text: cleaned.text };
}

/** Why a new room cannot be opened right now, or null. */
export function cannotOpen(identity) {
  if (!identity.premium && !identity.staff) return { status: 403, code: 'premium', message: "Xona ochish faqat Premium o'quvchilar uchun." };
  const mine = chatHub.roomHostedBy(identity.id);
  if (mine) return { status: 409, code: 'has_room', message: `Sizda ochiq xona bor: "${mine.name}". Yangisini ochishdan oldin uni yoping.`, room: mine.id };
  if (chatHub.community.size >= MAX_COMMUNITY_ROOMS) return { status: 429, code: 'too_many', message: "Hozir xonalar juda ko'p — birozdan keyin urinib ko'ring." };
  return null;
}

export async function openRoom(identity, { name, topic, level }) {
  const doc = await ChatRoom.create({
    name, topic, level: ['B1', 'B2', 'C1'].includes(level) ? level : null,
    host: identity.id, hostName: identity.name, hostPremium: identity.premium, hostAvatar: identity.avatar
  });
  return chatHub.addRoom({
    id: roomId(doc), name: doc.name, topic: doc.topic, level: doc.level, createdAt: doc.createdAt,
    host: { id: identity.id, name: identity.name, premium: identity.premium, avatar: identity.avatar }
  });
}

export async function closeRoom(id, by, reason = 'closed') {
  chatHub.closeRoom(id, reason);
  if (!isCommunityId(id)) return;
  await ChatRoom.updateOne({ _id: docId(id), closedAt: null }, { $set: { closedAt: new Date(), closedBy: by } })
    .catch(error => console.error('Chat: could not mark room closed:', error.message));
}

export async function removeFromRoom(id, userId) {
  chatHub.removeFromRoom(id, userId);
  if (!isCommunityId(id)) return;
  await ChatRoom.updateOne({ _id: docId(id) }, { $addToSet: { kicked: userId } })
    .catch(error => console.error('Chat: could not save removal:', error.message));
}

/** Close rooms that have been empty too long. */
export async function sweepRooms() {
  for (const id of chatHub.sweep()) {
    await ChatRoom.updateOne({ _id: docId(id), closedAt: null }, { $set: { closedAt: new Date(), closedBy: 'empty' } })
      .catch(() => {});
  }
}

// ------------------------------------------------------------------- cleanup

export async function purgeOldMessages() {
  const cutoff = new Date(Date.now() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    // Voice messages: the recording goes first, then the message.
    const voices = await ChatMessage.find({ createdAt: { $lt: cutoff }, audioKey: { $exists: true } }).select('audioKey').lean();
    for (const v of voices) await AudioStorageService.delete(v.audioKey);
    const result = await ChatMessage.deleteMany({ createdAt: { $lt: cutoff } });
    const deletedCount = result?.deletedCount || 0;
    if (deletedCount) console.log(`Chat: removed ${deletedCount} message(s) older than ${CHAT_RETENTION_DAYS} days`);
    await ChatRoom.deleteMany({ closedAt: { $lt: cutoff } });
    return deletedCount || 0;
  } catch (error) {
    console.error('Chat: cleanup failed:', error.message);
    return 0;
  }
}

setTimeout(purgeOldMessages, 90 * 1000).unref?.();
setInterval(purgeOldMessages, 12 * 60 * 60 * 1000).unref?.();
setInterval(sweepRooms, 60 * 1000).unref?.();

/** A stored message as screens show it. */
export function publicMessage(m) {
  const voice = m.kind === 'voice';
  return {
    id: String(m._id),
    room: m.room,
    user: String(m.user),
    name: m.name,
    level: m.level || null,
    premium: Boolean(m.premium),
    avatar: m.avatar || null,
    kind: voice ? 'voice' : 'text',
    text: m.deletedAt ? '' : (m.text || ''),
    seconds: voice ? Math.round(m.seconds || 0) : undefined,
    audio: voice && !m.deletedAt ? `/api/chat/voice/${m._id}` : undefined,
    deleted: Boolean(m.deletedAt),
    at: m.createdAt
  };
}

export default chatHub;
