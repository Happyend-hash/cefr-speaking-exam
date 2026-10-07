/**
 * Live text rooms: who is in which room, and delivering new messages.
 *
 * Same shape as the speaking-room hub, and for the same reasons: a long-lived
 * stream per browser, short POSTs back, no extra package, state in memory for
 * the one server process. Messages themselves are stored by the route layer;
 * this only decides who receives them.
 *
 * Two kinds of room:
 *   - the four fixed rooms (General, B1, B2, C1), open to everyone, no limit;
 *   - COMMUNITY rooms that a Premium student opens, with a name, a topic and
 *     ROOM_SEATS seats. A seat is held while the student has the room open.
 *     The host (or a teacher) can remove someone, who then cannot come back
 *     into that room, and can close the room. A room nobody has been in for
 *     EMPTY_CLOSE_MS closes by itself (sweep()).
 *
 * A student reads one room at a time.
 */

export const TEXT_ROOMS = [
  { id: 'text-general', name: 'General', level: null },
  { id: 'text-b1', name: 'B1 chat', level: 'B1' },
  { id: 'text-b2', name: 'B2 chat', level: 'B2' },
  { id: 'text-c1', name: 'C1 chat', level: 'C1' }
];

export const isTextRoom = id => TEXT_ROOMS.some(r => r.id === id);
export const isCommunityId = id => /^room-[a-f0-9]{24}$/.test(String(id || ''));

/** Seats in a community room. */
export const ROOM_SEATS = Number(process.env.CHAT_ROOM_SEATS) || 10;
/** Community rooms open at once, across the site. */
export const MAX_COMMUNITY_ROOMS = Number(process.env.CHAT_MAX_ROOMS) || 30;
/** A community room nobody has been in for this long closes by itself. */
export const EMPTY_CLOSE_MS = (Number(process.env.CHAT_ROOM_EMPTY_MINUTES) || 15) * 60 * 1000;

const person = u => ({
  id: String(u.id),
  name: u.name,
  level: u.level || null,
  premium: Boolean(u.premium),
  avatar: u.avatar || null
});

export class ChatHub {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** userId -> { user, streams:Set, room } */
    this.clients = new Map();
    /** roomId -> { id, name, topic, level, host:{id,name,premium,avatar}, max, createdAt, emptySince, kicked:Set } */
    this.community = new Map();
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
    this.send(id, 'hello', { you: id, ...this.summary(), room: client.room });
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

  // ------------------------------------------------------------ rooms

  isRoom(id) {
    return isTextRoom(id) || this.community.has(id);
  }

  /** A community room, from the database or just created. */
  addRoom({ id, name, topic = '', level = null, host, createdAt = new Date(), kicked = [] }) {
    const room = {
      id: String(id), name, topic, level, host: person(host),
      max: ROOM_SEATS, createdAt, emptySince: this.now(), kicked: new Set(kicked.map(String))
    };
    this.community.set(room.id, room);
    this.broadcastSummary();
    return room;
  }

  /** The community room this student is hosting, if any. */
  roomHostedBy(userId) {
    return [...this.community.values()].find(r => r.host.id === String(userId)) || null;
  }

  membersOf(roomId) {
    return [...this.clients.values()].filter(c => c.room === roomId);
  }

  /** Is this student reading this room right now? */
  isIn(userId, roomId) {
    return this.clients.get(String(userId))?.room === roomId;
  }

  join(userId, roomId) {
    const client = this.clients.get(String(userId));
    if (!client) return { ok: false, reason: 'not connected' };
    if (!this.isRoom(roomId)) return { ok: false, reason: 'no such room' };
    const room = this.community.get(roomId);
    if (room && client.room !== roomId) {
      if (room.kicked.has(client.user.id) && !client.user.staff) return { ok: false, reason: 'kicked' };
      // A teacher looking in does not take a student's seat.
      const taken = this.membersOf(roomId).filter(c => !c.user.staff).length;
      if (taken >= room.max && !client.user.staff) return { ok: false, reason: 'full' };
    }
    client.room = roomId;
    this.broadcastSummary();
    return { ok: true };
  }

  /** Back to the room list: the seat is free again. */
  leave(userId) {
    const client = this.clients.get(String(userId));
    if (!client || !client.room) return;
    client.room = null;
    this.broadcastSummary();
  }

  /** The host or a teacher removed someone: out now, and not back into this room. */
  removeFromRoom(roomId, userId) {
    const room = this.community.get(roomId);
    if (!room) return false;
    room.kicked.add(String(userId));
    if (this.isIn(userId, roomId)) {
      this.clients.get(String(userId)).room = null;
      this.send(userId, 'room-kicked', { room: roomId, name: room.name });
    }
    this.broadcastSummary();
    return true;
  }

  /** Close a community room: everyone in it goes back to the list. */
  closeRoom(roomId, reason = 'closed') {
    const room = this.community.get(roomId);
    if (!room) return false;
    for (const client of this.membersOf(roomId)) {
      client.room = null;
      this.send(client.user.id, 'room-closed', { room: roomId, name: room.name, reason });
    }
    this.community.delete(roomId);
    this.broadcastSummary();
    return true;
  }

  /** Community rooms empty for EMPTY_CLOSE_MS. Returns the ids it closed. */
  sweep() {
    const closed = [];
    const now = this.now();
    for (const room of [...this.community.values()]) {
      if (room.emptySince != null && now - room.emptySince >= EMPTY_CLOSE_MS) {
        this.closeRoom(room.id, 'empty');
        closed.push(room.id);
      }
    }
    return closed;
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

  /** A crown or picture changed: used for this student's next messages. */
  updateUser(userId, patch) {
    const client = this.clients.get(String(userId));
    if (client) client.user = { ...client.user, ...patch };
  }

  kick(userId, reason = 'removed by the teacher') {
    this.send(userId, 'kicked', { reason });
    const client = this.clients.get(String(userId));
    if (client) client.room = null;
    this.broadcastSummary();
  }

  communityView(room) {
    const people = this.membersOf(room.id).filter(c => !c.user.staff).map(c => person(c.user));
    return {
      id: room.id,
      name: room.name,
      topic: room.topic,
      level: room.level,
      host: room.host,
      max: room.max,
      count: people.length,
      people
    };
  }

  summary() {
    const community = [...this.community.values()]
      .map(r => this.communityView(r))
      // Busy rooms first, then the newest.
      .sort((a, b) => b.count - a.count || String(b.id).localeCompare(String(a.id)));
    return {
      rooms: TEXT_ROOMS.map(r => ({ ...r, online: this.membersOf(r.id).length })),
      community
    };
  }

  /** Who is in which room changed: tell everyone, and start or stop each empty room's clock. */
  broadcastSummary() {
    const now = this.now();
    for (const room of this.community.values()) {
      const empty = this.membersOf(room.id).length === 0;
      if (empty && room.emptySince == null) room.emptySince = now;
      if (!empty) room.emptySince = null;
    }
    const summary = this.summary();
    for (const id of this.clients.keys()) this.send(id, 'rooms', summary);
  }
}

export default ChatHub;
