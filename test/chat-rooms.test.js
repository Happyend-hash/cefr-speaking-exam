/**
 * Community chat rooms: ten seats, the host's powers, closing when empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatHub, ROOM_SEATS, EMPTY_CLOSE_MS, isCommunityId } from '../services/ChatHub.js';

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

const ROOM = 'room-0123456789abcdef01234567';

function hubWithRoom() {
  let t = 1000;
  const h = new ChatHub({ now: () => t });
  const clock = { advance: ms => { t += ms; } };
  h.addRoom({ id: ROOM, name: 'Travel stories', topic: 'Your best trip', level: 'B2', host: { id: 'host', name: 'Host', premium: true } });
  return { h, clock };
}

test('room ids are recognised', () => {
  assert.equal(isCommunityId(ROOM), true);
  assert.equal(isCommunityId('text-general'), false);
  assert.equal(isCommunityId('room-../../etc'), false);
});

test('a community room has ten seats; the eleventh student is refused', () => {
  const { h } = hubWithRoom();
  assert.equal(ROOM_SEATS, 10);
  for (let i = 0; i < 10; i++) {
    h.connect({ id: `s${i}`, name: `S${i}` }, stream());
    assert.equal(h.join(`s${i}`, ROOM).ok, true, `seat ${i + 1}`);
  }
  h.connect({ id: 'late', name: 'Late' }, stream());
  assert.deepEqual(h.join('late', ROOM), { ok: false, reason: 'full' });
  // Someone leaves: the seat is free again.
  h.leave('s3');
  assert.equal(h.join('late', ROOM).ok, true);
  // A teacher looking in never takes a seat, even in a full room.
  h.connect({ id: 'teacher', name: 'T', staff: true }, stream());
  assert.equal(h.join('teacher', ROOM).ok, true);
  assert.equal(h.communityView(h.community.get(ROOM)).count, 10);
});

test('the fixed rooms have no seat limit', () => {
  const h = new ChatHub();
  for (let i = 0; i < 25; i++) {
    h.connect({ id: `s${i}`, name: `S${i}` }, stream());
    assert.equal(h.join(`s${i}`, 'text-general').ok, true);
  }
  assert.equal(h.summary().rooms.find(r => r.id === 'text-general').online, 25);
});

test('everyone sees the room list with who is sitting where', () => {
  const { h } = hubWithRoom();
  const a = stream(); const b = stream();
  h.connect({ id: 'a', name: 'Aziz', level: 'B2' }, a);
  h.connect({ id: 'b', name: 'Bek' }, b);
  assert.equal(a.last('hello').community[0].name, 'Travel stories');
  h.join('a', ROOM);
  const seen = b.last('rooms').community[0];
  assert.equal(seen.count, 1);
  assert.equal(seen.max, 10);
  assert.equal(seen.people[0].name, 'Aziz');
  assert.equal(seen.host.name, 'Host');
});

test('messages in a community room reach only the people in it', () => {
  const { h } = hubWithRoom();
  const a = stream(); const b = stream();
  h.connect({ id: 'a', name: 'A' }, a); h.connect({ id: 'b', name: 'B' }, b);
  h.join('a', ROOM); h.join('b', 'text-general');
  h.deliver(ROOM, { id: 'm1', kind: 'voice' });
  assert.equal(a.count('message'), 1);
  assert.equal(b.count('message'), 0);
  assert.equal(h.isIn('a', ROOM), true);
  assert.equal(h.isIn('b', ROOM), false);
});

test('the host removes someone: out now, and cannot come back', () => {
  const { h } = hubWithRoom();
  const x = stream();
  h.connect({ id: 'x', name: 'X' }, x);
  h.join('x', ROOM);
  h.removeFromRoom(ROOM, 'x');
  assert.equal(x.last('room-kicked').room, ROOM);
  assert.equal(h.isIn('x', ROOM), false);
  assert.deepEqual(h.join('x', ROOM), { ok: false, reason: 'kicked' });
  assert.equal(h.join('x', 'text-general').ok, true, 'other rooms are still open to them');
});

test('closing a room sends everyone back to the list', () => {
  const { h } = hubWithRoom();
  const a = stream(); const b = stream();
  h.connect({ id: 'a', name: 'A' }, a); h.connect({ id: 'b', name: 'B' }, b);
  h.join('a', ROOM);
  h.closeRoom(ROOM, 'host');
  assert.equal(a.last('room-closed').room, ROOM);
  assert.equal(b.count('room-closed'), 0);
  assert.equal(h.isRoom(ROOM), false);
  assert.equal(b.last('rooms').community.length, 0);
  assert.equal(h.join('a', ROOM).ok, false);
});

test('a room nobody is in closes by itself after a while; a busy one stays', () => {
  const { h, clock } = hubWithRoom();
  h.addRoom({ id: 'room-aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Busy', host: { id: 'h2', name: 'H2' } });
  const a = stream();
  h.connect({ id: 'a', name: 'A' }, a);
  h.join('a', 'room-aaaaaaaaaaaaaaaaaaaaaaaa');
  clock.advance(EMPTY_CLOSE_MS - 1000);
  assert.deepEqual(h.sweep(), []);
  clock.advance(2000);
  assert.deepEqual(h.sweep(), [ROOM]);
  assert.equal(h.isRoom('room-aaaaaaaaaaaaaaaaaaaaaaaa'), true);
  // The last person leaves: its clock starts now.
  h.disconnect('a', [...h.clients.get('a').streams][0]);
  clock.advance(EMPTY_CLOSE_MS + 1);
  assert.deepEqual(h.sweep(), ['room-aaaaaaaaaaaaaaaaaaaaaaaa']);
});

test('one open room per host is easy to find', () => {
  const { h } = hubWithRoom();
  assert.equal(h.roomHostedBy('host').id, ROOM);
  assert.equal(h.roomHostedBy('someone'), null);
});

// ------------------------------------------------- room names and voice messages

const { cleanRoomText, publicMessage, cannotOpen } = await import('../services/ChatRooms.js');

test('a room name is checked like a message', () => {
  assert.equal(cleanRoomText('  Travel   stories ', { field: 'Name', min: 3, max: 40, required: true }).text, 'Travel stories');
  assert.equal(cleanRoomText('', { field: 'Name', min: 3, max: 40, required: true }).ok, false);
  assert.equal(cleanRoomText('ab', { field: 'Name', min: 3, max: 40, required: true }).ok, false);
  assert.equal(cleanRoomText('join t.me/mygroup', { field: 'Name', min: 3, max: 40, required: true }).ok, false, 'no links');
  assert.equal(cleanRoomText('shit talk', { field: 'Name', min: 3, max: 40, required: true }).ok, false, 'no swearing');
  assert.equal(cleanRoomText('Привет всем друзья', { field: 'Name', min: 3, max: 40, required: true }).ok, false, 'English');
  assert.deepEqual(cleanRoomText('', { field: 'Topic', min: 3, max: 120, required: false }), { ok: true, text: '' });
});

test('only Premium students and teachers may open a room', () => {
  assert.equal(cannotOpen({ id: 'free', premium: false, staff: false }).code, 'premium');
  assert.equal(cannotOpen({ id: 'gold', premium: true, staff: false }), null);
  assert.equal(cannotOpen({ id: 'teacher', premium: false, staff: true }), null);
});

test('a voice message is shown with its length and a link to play it', () => {
  const m = publicMessage({ _id: 'abc', room: ROOM, user: 'u', name: 'U', kind: 'voice', text: '', seconds: 12.4, audioKey: 'k', createdAt: new Date(0) });
  assert.equal(m.kind, 'voice');
  assert.equal(m.seconds, 12);
  assert.equal(m.audio, '/api/chat/voice/abc');
  assert.equal(m.audioKey, undefined, 'the storage key never leaves the server');
  const gone = publicMessage({ _id: 'abc', room: ROOM, user: 'u', kind: 'voice', audioKey: 'k', deletedAt: new Date(), createdAt: new Date(0) });
  assert.equal(gone.audio, undefined, 'a deleted voice message cannot be played by students');
  assert.equal(publicMessage({ _id: 'x', room: 'text-general', user: 'u', text: 'hi', createdAt: new Date(0) }).kind, 'text');
});
