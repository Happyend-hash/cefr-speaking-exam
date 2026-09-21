/**
 * Live speaking rooms: who is online, who is waiting for a partner, who is in
 * which room — and passing connection messages between them.
 *
 * The audio itself never touches this server. Browsers connect to each other
 * directly (WebRTC); this hub only introduces them and relays the handful of
 * messages they need to find each other. That is why speaking rooms cost
 * nothing to run on the server side.
 *
 * Two ways to talk:
 *   - PARTNER: "Find a partner" pairs two students, preferring the same level,
 *     and gives them an exam topic and a timer.
 *   - CLUBS: open group rooms, up to CLUB_MAX people, with a shared topic card
 *     anyone can change.
 *
 * Kept free of Express and the database on purpose: the rules here (pairing,
 * capacity, who may message whom) are tested on their own, and the route layer
 * wires them to HTTP and storage through the `hooks`.
 *
 * State is in memory. That is right for one server process, which is how this
 * app runs on Railway; a restart simply drops live calls and everyone
 * reconnects.
 */

import { randomUUID } from 'crypto';

export const CLUB_MAX = Number(process.env.VOICE_CLUB_MAX) || 5;
/** After this long waiting, a student is paired with anyone, not only their level. */
export const ANY_LEVEL_AFTER_MS = 20 * 1000;
/** A dropped connection keeps its place this long, so a network blip is not a hang-up. */
export const RECONNECT_GRACE_MS = 10 * 1000;

export const CLUBS = [
  { id: 'club-open', name: 'Open Room', level: null },
  { id: 'club-b1', name: 'B1 Club', level: 'B1' },
  { id: 'club-b2', name: 'B2 Club', level: 'B2' },
  { id: 'club-c1', name: 'C1 Club', level: 'C1' }
];

export class VoiceHub {
  /**
   * @param {object} hooks
   *   pickTopic(kind)                  -> topic object for a new room
   *   onSessionStart(room)             -> Promise<sessionId>
   *   onJoin(room, member)             -> void
   *   onSessionEnd(room)               -> void
   *   now()                            -> ms (tests control time)
   */
  constructor(hooks = {}) {
    this.hooks = {
      pickTopic: () => null,
      onSessionStart: async () => null,
      onJoin: () => {},
      onSessionEnd: () => {},
      now: () => Date.now(),
      ...hooks
    };
    /** userId -> { user, streams:Set, roomId, queuedAt, dropTimer } */
    this.clients = new Map();
    /** roomId -> { id, kind, name, level, members:Set<userId>, max, topic, sessionId, startedAt } */
    this.rooms = new Map();
    for (const club of CLUBS) {
      this.rooms.set(club.id, {
        id: club.id, kind: 'club', name: club.name, level: club.level,
        members: new Set(), max: CLUB_MAX, topic: null, sessionId: null, startedAt: null
      });
    }
    /** userIds waiting for a partner, oldest first */
    this.queue = [];
  }

  // ------------------------------------------------------------ transport

  send(userId, event, data = {}) {
    const client = this.clients.get(String(userId));
    if (!client) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of client.streams) {
      try { stream.write(frame); } catch { /* a dead stream is removed on close */ }
    }
  }

  broadcastLobby() {
    const rooms = this.clubSummary();
    for (const [userId, client] of this.clients) {
      if (!client.roomId) this.send(userId, 'rooms', { rooms, waiting: this.queue.length });
    }
  }

  // ------------------------------------------------------------ presence

  /**
   * A browser opened its event stream.
   * @param user {id, name, level}
   * @param stream anything with write(string)
   */
  connect(user, stream) {
    const id = String(user.id);
    let client = this.clients.get(id);
    if (!client) {
      client = { user: { ...user, id }, streams: new Set(), roomId: null, queuedAt: null, dropTimer: null };
      this.clients.set(id, client);
    }
    client.user = { ...client.user, ...user, id };
    client.streams.add(stream);
    if (client.dropTimer) { clearTimeout(client.dropTimer); client.dropTimer = null; }

    const room = client.roomId ? this.rooms.get(client.roomId) : null;
    this.send(id, 'hello', {
      you: id,
      rooms: this.clubSummary(),
      waiting: this.queue.length,
      queued: this.queue.includes(id),
      // Back in the room they briefly dropped out of: the browser reconnects
      // its audio to everyone still there.
      room: room ? this.roomView(room) : null
    });
  }

  /** A stream closed. The student keeps their place for a moment in case it was a blip. */
  disconnect(userId, stream) {
    const id = String(userId);
    const client = this.clients.get(id);
    if (!client) return;
    client.streams.delete(stream);
    if (client.streams.size) return;
    client.dropTimer = setTimeout(() => this.drop(id), RECONNECT_GRACE_MS);
    client.dropTimer.unref?.();
  }

  /** Gone for good: out of the queue and the room. */
  drop(userId) {
    const id = String(userId);
    this.cancelQueue(id);
    this.leave(id);
    this.clients.delete(id);
  }

  // ------------------------------------------------------------- partner

  /** Wait for a partner, or be paired with someone already waiting. */
  findPartner(userId) {
    const id = String(userId);
    const me = this.clients.get(id);
    if (!me) return { ok: false, reason: 'not connected' };
    if (this.queue.includes(id)) return { ok: true, waiting: true };
    this.leave(id);

    const now = this.hooks.now();
    // Same level first. Anyone who has already waited long enough — on either
    // side — takes whoever is there: a B2 student waiting alone for a minute is
    // worse served than one paired with a B1.
    const partnerId =
      this.queue.find(other => this.clients.get(other)?.user.level === me.user.level && me.user.level) ||
      this.queue.find(other => now - (this.clients.get(other)?.queuedAt || now) >= ANY_LEVEL_AFTER_MS);

    if (!partnerId) {
      me.queuedAt = now;
      this.queue.push(id);
      this.broadcastLobby();
      return { ok: true, waiting: true };
    }

    this.cancelQueue(partnerId);
    return this.pair(partnerId, id);
  }

  /** Re-check the queue: pairs anyone who has now waited long enough. Called on a timer. */
  sweepQueue() {
    const now = this.hooks.now();
    const ready = this.queue.filter(id => now - (this.clients.get(id)?.queuedAt || now) >= ANY_LEVEL_AFTER_MS);
    while (ready.length >= 2) {
      const a = ready.shift();
      const b = ready.shift();
      this.cancelQueue(a);
      this.cancelQueue(b);
      this.pair(a, b);
    }
    // One long-waiter plus anyone newer is also a pair.
    if (ready.length === 1) {
      const other = this.queue.find(id => id !== ready[0]);
      if (other) {
        this.cancelQueue(ready[0]);
        this.cancelQueue(other);
        this.pair(ready[0], other);
      }
    }
  }

  cancelQueue(userId) {
    const id = String(userId);
    const before = this.queue.length;
    this.queue = this.queue.filter(q => q !== id);
    const client = this.clients.get(id);
    if (client) client.queuedAt = null;
    if (this.queue.length !== before) this.broadcastLobby();
  }

  pair(firstId, secondId) {
    const room = {
      id: `pair-${randomUUID()}`,
      kind: 'pair',
      name: 'Partner practice',
      level: null,
      members: new Set(),
      max: 2,
      topic: this.hooks.pickTopic('pair'),
      sessionId: null,
      startedAt: this.hooks.now()
    };
    this.rooms.set(room.id, room);
    this.startSession(room);
    // The one who waited longer makes the call; the newcomer answers.
    this.addMember(room, firstId, { announce: false });
    this.addMember(room, secondId, { announce: false });
    for (const id of room.members) {
      this.send(id, 'matched', { ...this.roomView(room), initiator: String(firstId) });
    }
    return { ok: true, matched: true, roomId: room.id };
  }

  // --------------------------------------------------------------- clubs

  join(userId, roomId) {
    const id = String(userId);
    const room = this.rooms.get(roomId);
    if (!this.clients.has(id)) return { ok: false, reason: 'not connected' };
    if (!room || room.kind !== 'club') return { ok: false, reason: 'no such room' };
    if (room.members.has(id)) return { ok: true, roomId };
    if (room.members.size >= room.max) return { ok: false, reason: 'room is full' };

    this.cancelQueue(id);
    this.leave(id);

    if (!room.members.size) {
      room.topic = this.hooks.pickTopic('club');
      room.startedAt = this.hooks.now();
      this.startSession(room);
    }

    // The newcomer receives the list and calls everyone already there; those
    // already there are only told who arrived.
    const peers = [...room.members];
    this.addMember(room, id, { announce: true });
    this.send(id, 'joined', { ...this.roomView(room), callPeers: peers });
    this.broadcastLobby();
    return { ok: true, roomId };
  }

  /** Anyone in a club can deal a new topic card to the whole room. */
  nextTopic(userId) {
    const room = this.roomOf(userId);
    if (!room) return { ok: false, reason: 'not in a room' };
    room.topic = this.hooks.pickTopic(room.kind);
    for (const id of room.members) this.send(id, 'topic', { topic: room.topic, by: this.nameOf(userId) });
    return { ok: true };
  }

  // -------------------------------------------------------------- shared

  addMember(room, userId, { announce }) {
    const id = String(userId);
    const client = this.clients.get(id);
    if (!client) return;
    if (announce) {
      for (const other of room.members) this.send(other, 'peer-joined', { peer: this.memberView(id) });
    }
    room.members.add(id);
    client.roomId = room.id;
    this.hooks.onJoin(room, client.user);
  }

  leave(userId) {
    const id = String(userId);
    const client = this.clients.get(id);
    const room = client?.roomId ? this.rooms.get(client.roomId) : null;
    if (client) client.roomId = null;
    if (!room || !room.members.has(id)) return;

    room.members.delete(id);
    for (const other of room.members) this.send(other, 'peer-left', { peer: id });

    if (room.kind === 'pair') {
      // A partner session ends when either side leaves.
      for (const other of room.members) {
        const otherClient = this.clients.get(other);
        if (otherClient) otherClient.roomId = null;
        this.send(other, 'ended', { reason: 'partner-left', sessionId: room.sessionId });
      }
      room.members.clear();
      this.endSession(room);
      this.rooms.delete(room.id);
    } else if (!room.members.size) {
      this.endSession(room);
      room.topic = null;
      room.startedAt = null;
    }
    this.broadcastLobby();
  }

  /**
   * Pass a connection message to another member of the SAME room — never to
   * anyone else. This is what stops a student using the relay to reach someone
   * they were not paired with.
   */
  relay(fromId, toId, payload) {
    const from = String(fromId);
    const to = String(toId);
    const room = this.roomOf(from);
    if (!room || !room.members.has(to) || from === to) return { ok: false, reason: 'not in the same room' };
    this.send(to, 'signal', { from, payload });
    return { ok: true };
  }

  /**
   * A typed message inside a call, to everyone in the same room. The route
   * has already filtered and stored it; this only delivers.
   */
  roomChat(userId, message) {
    const room = this.roomOf(userId);
    if (!room) return { ok: false, reason: 'not in a room' };
    for (const id of room.members) this.send(id, 'chat', message);
    return { ok: true, roomId: room.id };
  }

  /** Teacher removes someone from voice immediately. */
  kick(userId, reason = 'removed by the teacher') {
    const id = String(userId);
    this.send(id, 'kicked', { reason });
    this.drop(id);
  }

  startSession(room) {
    room.sessionId = null;
    Promise.resolve(this.hooks.onSessionStart(room))
      .then(sessionId => {
        room.sessionId = sessionId ? String(sessionId) : null;
        for (const id of room.members) this.send(id, 'session', { sessionId: room.sessionId });
      })
      .catch(() => {});
  }

  endSession(room) {
    if (room.sessionId || room.startedAt) this.hooks.onSessionEnd(room);
    room.sessionId = null;
  }

  // -------------------------------------------------------------- views

  roomOf(userId) {
    const client = this.clients.get(String(userId));
    return client?.roomId ? this.rooms.get(client.roomId) || null : null;
  }

  nameOf(userId) {
    return this.clients.get(String(userId))?.user.name || '';
  }

  memberView(userId) {
    const u = this.clients.get(String(userId))?.user || {};
    return { id: String(userId), name: u.name || "O'quvchi", level: u.level || null };
  }

  roomView(room) {
    return {
      roomId: room.id,
      kind: room.kind,
      name: room.name,
      topic: room.topic,
      sessionId: room.sessionId,
      startedAt: room.startedAt,
      members: [...room.members].map(id => this.memberView(id))
    };
  }

  clubSummary() {
    return [...this.rooms.values()]
      .filter(r => r.kind === 'club')
      .map(r => ({
        id: r.id, name: r.name, level: r.level, max: r.max,
        count: r.members.size,
        names: [...r.members].map(id => this.nameOf(id))
      }));
  }

  /** Everything live, for the teacher's panel. */
  snapshot() {
    return {
      online: this.clients.size,
      waiting: this.queue.map(id => this.memberView(id)),
      rooms: [...this.rooms.values()]
        .filter(r => r.members.size)
        .map(r => ({ ...this.roomView(r), members: [...r.members].map(id => this.memberView(id)) }))
    };
  }
}

export default VoiceHub;
