/**
 * Speaking rooms: pairing, capacity, and who may message whom.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceHub, CLUB_MAX, ANY_LEVEL_AFTER_MS } from '../services/VoiceHub.js';

/** A fake event stream that remembers what was sent to it. */
function stream() {
  const events = [];
  return {
    events,
    write(frame) {
      const [, event] = frame.match(/^event: (.+)$/m);
      const [, data] = frame.match(/^data: (.+)$/m);
      events.push({ event, data: JSON.parse(data) });
    },
    last(name) { return [...events].reverse().find(e => e.event === name)?.data; },
    count(name) { return events.filter(e => e.event === name).length; }
  };
}

function hub() {
  let clock = 1_000_000;
  const sessions = [];
  const h = new VoiceHub({
    now: () => clock,
    pickTopic: kind => ({ kind, text: 'Discuss renewable energy' }),
    onSessionStart: async room => { sessions.push({ room: room.id, ended: false }); return `s${sessions.length}`; },
    onSessionEnd: room => { const s = sessions.find(x => x.room === room.id && !x.ended); if (s) s.ended = true; }
  });
  h.advance = ms => { clock += ms; };
  h.sessions = sessions;
  return h;
}

const user = (id, level = 'B2') => ({ id, name: `User ${id}`, level });
const tick = () => new Promise(r => setImmediate(r));

test('two students at the same level are paired; the one who waited calls', async () => {
  const h = hub();
  const a = stream(); const b = stream();
  h.connect(user('a'), a); h.connect(user('b'), b);

  assert.deepEqual(h.findPartner('a'), { ok: true, waiting: true });
  const r = h.findPartner('b');
  assert.equal(r.matched, true);
  assert.equal(a.last('matched').initiator, 'a');
  assert.equal(b.last('matched').members.length, 2);
  assert.ok(a.last('matched').topic, 'a topic card is dealt');
  await tick();
  assert.equal(a.last('session').sessionId, 's1', 'a session is recorded');
});

test('different levels wait, then pair once someone has waited long enough', () => {
  const h = hub();
  const a = stream(); const b = stream();
  h.connect(user('a', 'B1'), a); h.connect(user('b', 'C1'), b);
  h.findPartner('a');
  h.findPartner('b');
  assert.equal(a.count('matched'), 0, 'not paired across levels straight away');
  h.advance(ANY_LEVEL_AFTER_MS);
  h.sweepQueue();
  assert.equal(a.count('matched'), 1);
  assert.equal(b.count('matched'), 1);
});

test('messages only reach someone in the same room', () => {
  const h = hub();
  const s = { a: stream(), b: stream(), c: stream() };
  for (const id of ['a', 'b', 'c']) h.connect(user(id), s[id]);
  h.findPartner('a'); h.findPartner('b');

  assert.equal(h.relay('a', 'b', { type: 'offer' }).ok, true);
  assert.equal(s.b.last('signal').from, 'a');
  assert.equal(h.relay('a', 'c', { type: 'offer' }).ok, false, 'c is not in the room');
  assert.equal(h.relay('c', 'a', { type: 'offer' }).ok, false, 'c cannot reach a');
  assert.equal(s.c.count('signal'), 0);
});

test('a partner leaving ends the session for both', async () => {
  const h = hub();
  const a = stream(); const b = stream();
  h.connect(user('a'), a); h.connect(user('b'), b);
  h.findPartner('a'); h.findPartner('b');
  await tick();
  h.leave('a');
  assert.equal(b.last('ended').reason, 'partner-left');
  assert.equal(h.roomOf('b'), null);
  assert.equal(h.sessions[0].ended, true);
});

test('clubs hold at most CLUB_MAX; the newcomer calls everyone already there', () => {
  const h = hub();
  const streams = {};
  for (let i = 1; i <= CLUB_MAX + 1; i++) {
    streams[i] = stream();
    h.connect(user(String(i)), streams[i]);
  }
  for (let i = 1; i <= CLUB_MAX; i++) assert.equal(h.join(String(i), 'club-open').ok, true);
  assert.deepEqual(h.join(String(CLUB_MAX + 1), 'club-open'), { ok: false, reason: 'room is full' });

  assert.deepEqual(streams[3].last('joined').callPeers, ['1', '2']);
  assert.equal(streams[1].count('peer-joined'), CLUB_MAX - 1);
});

test('everyone in a club gets the new topic; an empty club resets', async () => {
  const h = hub();
  const a = stream(); const b = stream();
  h.connect(user('a'), a); h.connect(user('b'), b);
  h.join('a', 'club-b2'); h.join('b', 'club-b2');
  h.nextTopic('b');
  assert.equal(a.last('topic').by, 'User b');
  await tick();
  h.leave('a'); h.leave('b');
  const club = h.rooms.get('club-b2');
  assert.equal(club.members.size, 0);
  assert.equal(club.topic, null);
  assert.equal(h.sessions[0].ended, true);
});

test('a dropped connection keeps its place briefly; reconnecting restores the room', () => {
  const h = hub();
  const a1 = stream(); const b = stream();
  h.connect(user('a'), a1); h.connect(user('b'), b);
  h.join('a', 'club-open'); h.join('b', 'club-open');
  h.disconnect('a', a1);
  assert.equal(h.roomOf('a')?.id, 'club-open', 'still in the room during the grace period');
  const a2 = stream();
  h.connect(user('a'), a2);
  assert.equal(a2.last('hello').room.roomId, 'club-open');
  assert.equal(b.count('peer-left'), 0);
});

test('a kicked student is out of the room and told why', () => {
  const h = hub();
  const a = stream(); const b = stream();
  h.connect(user('a'), a); h.connect(user('b'), b);
  h.join('a', 'club-open'); h.join('b', 'club-open');
  h.kick('a');
  assert.equal(a.last('kicked').reason, 'removed by the teacher');
  assert.equal(b.last('peer-left').peer, 'a');
  assert.equal(h.clients.has('a'), false);
});
