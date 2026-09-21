import { ChatHub } from './ChatHub.js';
import ChatMessage from '../models/ChatMessage.js';

/**
 * The one live text-room hub for this server, and clearing old messages away.
 */

/** Messages older than this are deleted automatically. */
export const CHAT_RETENTION_DAYS = Number(process.env.CHAT_RETENTION_DAYS) || 30;

export const chatHub = new ChatHub();

export async function purgeOldMessages() {
  const cutoff = new Date(Date.now() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    const result = await ChatMessage.deleteMany({ createdAt: { $lt: cutoff } });
    const deletedCount = result?.deletedCount || 0;
    if (deletedCount) console.log(`Chat: removed ${deletedCount} message(s) older than ${CHAT_RETENTION_DAYS} days`);
    return deletedCount || 0;
  } catch (error) {
    console.error('Chat: cleanup failed:', error.message);
    return 0;
  }
}

setTimeout(purgeOldMessages, 90 * 1000).unref?.();
setInterval(purgeOldMessages, 12 * 60 * 60 * 1000).unref?.();

/** A stored message as screens show it. */
export function publicMessage(m) {
  return {
    id: String(m._id),
    room: m.room,
    user: String(m.user),
    name: m.name,
    level: m.level || null,
    text: m.deletedAt ? '' : m.text,
    deleted: Boolean(m.deletedAt),
    at: m.createdAt
  };
}

export default chatHub;
