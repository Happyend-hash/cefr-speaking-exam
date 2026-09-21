/**
 * Live text rooms: who is in which room, and delivering new messages.
 *
 * Same shape as the speaking-room hub, and for the same reasons: a long-lived
 * stream per browser, short POSTs back, no extra package, state in memory for
 * the one server process. Messages themselves are stored by the route layer;
 * this only decides who receives them.
 *
 * A student reads one text room at a time.
 */

export const TEXT_ROOMS = [
  { id: 'text-general', name: 'General', level: null },
  { id: 'text-b1', name: 'B1 chat', level: 'B1' },
  { id: 'text-b2', name: 'B2 chat', level: 'B2' },
  { id: 'text-c1', name: 'C1 chat', level: 'C1' }
];

export const isTextRoom = id => TEXT_ROOMS.some(r => r.id === id);

export class ChatHub {
  constructor() {
    /** userId -> { user, streams:Set, room } */
    this.clients = new Map();
  }

  send(userId, event, data) {
    const client = this.clients.get(String(userId));
    if (!client) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of client.streams) {
      try { stream.write(frame); } catch { /* removed on close */ }
    }
  }

  connect(user, stream) {
    const id = String(user.id);
    const client = this.clients.get(id) || { user: { ...user, id }, streams: new Set(), room: null };
    client.user = { ...client.user, ...user, id };
    client.streams.add(stream);
    this.clients.set(id, client);
    this.send(id, 'hello', { you: id, rooms: this.summary(), room: client.room });
  }

  disconnect(userId, stream) {
    const id = String(userId);
    const client = this.clients.get(id);
    if (!client) return;
    client.streams.delete(stream);
    if (!client.streams.size) {
      this.clients.delete(id);
      this.broadcastSummary();
    }
  }

  join(userId, roomId) {
    const client = this.clients.get(String(userId));
    if (!client) return { ok: false, reason: 'not connected' };
    if (!isTextRoom(roomId)) return { ok: false, reason: 'no such room' };
    client.room = roomId;
    this.broadcastSummary();
    return { ok: true };
  }

  /** Deliver a stored message to everyone reading that room. */
  deliver(roomId, message) {
    for (const [id, client] of this.clients) {
      if (client.room === roomId) this.send(id, 'message', message);
    }
  }

  /** A message was removed by the teacher: take it off every screen. */
  retract(roomId, messageId) {
    for (const [id, client] of this.clients) {
      if (client.room === roomId) this.send(id, 'deleted', { id: String(messageId) });
    }
  }

  kick(userId, reason = 'removed by the teacher') {
    this.send(userId, 'kicked', { reason });
    const client = this.clients.get(String(userId));
    if (client) client.room = null;
    this.broadcastSummary();
  }

  summary() {
    return TEXT_ROOMS.map(r => ({
      ...r,
      online: [...this.clients.values()].filter(c => c.room === r.id).length
    }));
  }

  broadcastSummary() {
    const rooms = this.summary();
    for (const id of this.clients.keys()) this.send(id, 'rooms', { rooms });
  }
}

export default ChatHub;
