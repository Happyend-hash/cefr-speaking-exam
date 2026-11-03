/**
 * Live delivery for Do'stlar: new private messages, "read" ticks, friend and
 * chat requests. One server-sent-event stream per open browser tab; nothing
 * is lost if nobody is connected — everything is in the database and the
 * screens load it when opened.
 */
export class SocialHub {
  constructor() {
    this.streams = new Map();   // userId -> Set(res)
  }

  connect(userId, res) {
    const id = String(userId);
    if (!this.streams.has(id)) this.streams.set(id, new Set());
    this.streams.get(id).add(res);
  }

  disconnect(userId, res) {
    const id = String(userId);
    const set = this.streams.get(id);
    if (!set) return;
    set.delete(res);
    if (!set.size) this.streams.delete(id);
  }

  isOnline(userId) {
    return this.streams.has(String(userId));
  }

  send(userId, event, data = {}) {
    const set = this.streams.get(String(userId));
    if (!set) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) { try { res.write(frame); } catch { /* removed on close */ } }
  }
}

export const socialHub = new SocialHub();
export default socialHub;
