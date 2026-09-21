/**
 * Text chat: what the filter lets through, and who receives what.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMessage, allowMessage, MAX_LENGTH } from '../services/ChatFilter.js';
import { ChatHub } from '../services/ChatHub.js';
import { VoiceHub } from '../services/VoiceHub.js';

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

// ---------------------------------------------------------------- filter

test('ordinary English passes untouched', () => {
  const r = cleanMessage('  Hi everyone!   Shall we discuss the classic assumption about Scunthorpe? ');
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.text, 'Hi everyone! Shall we discuss the classic assumption about Scunthorpe?');
});

test('swearing is masked in English, Russian and Uzbek', () => {
  for (const bad of ['what the fuck', 'this is shit', 'you are a сука, really', 'sen jalab']) {
    const r = cleanMessage(bad);
    assert.equal(r.ok, true, bad);
    assert.equal(r.changed, true, bad);
    assert.match(r.text, /\*{3,}/, bad);
  }
});

test('links, handles and phone numbers are removed', () => {
  assert.match(cleanMessage('join t.me/mygroup now').text, /\[link removed\]/);
  assert.match(cleanMessage('see https://example.com/x').text, /\[link removed\]/);
  assert.match(cleanMessage('go to mysite.uz please').text, /\[link removed\]/);
  assert.match(cleanMessage('write me @someone_here').text, /\[contact removed\]/);
  assert.match(cleanMessage('call +998 90 123 45 67').text, /\[number removed\]/);
  assert.equal(cleanMessage('I am 17 and scored 61 in 2025').changed, false, 'short numbers are fine');
});

test('messages mostly in Cyrillic are refused with a nudge', () => {
  const r = cleanMessage('Привет всем, как дела?');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'english');
  assert.equal(cleanMessage('Hello! Как? ok').ok, true, 'a word or two is allowed');
});

test('empty is refused and long is cut', () => {
  assert.equal(cleanMessage('   ').reason, 'empty');
  assert.equal(cleanMessage('a'.repeat(900)).text.length, MAX_LENGTH);
});

test('at most one message a second and twenty a minute', () => {
  const t = 5_000_000;
  assert.equal(allowMessage('rate-a', t), true);
  assert.equal(allowMessage('rate-a', t + 300), false);
  let sent = 1;
  for (let i = 1; i < 40; i += 1) if (allowMessage('rate-a', t + i * 1500)) sent += 1;
  assert.equal(sent, 20);
  assert.equal(allowMessage('rate-a', t + 61_000 + 40 * 1500), true, 'the minute rolls on');
});

// ------------------------------------------------------------------- hub

test('a message reaches only the people reading that room', () => {
  const h = new ChatHub();
  const s = { a: stream(), b: stream(), c: stream() };
  for (const id of ['a', 'b', 'c']) h.connect({ id, name: id }, s[id]);
  assert.equal(s.a.last('hello').you, 'a');

  h.join('a', 'text-b2'); h.join('b', 'text-b2'); h.join('c', 'text-general');
  h.deliver('text-b2', { id: 'm1', text: 'hi' });
  assert.equal(s.a.last('message').id, 'm1');
  assert.equal(s.b.last('message').id, 'm1');
  assert.equal(s.c.count('message'), 0);

  const rooms = s.c.last('rooms').rooms;
  assert.equal(rooms.find(r => r.id === 'text-b2').online, 2);
  assert.equal(rooms.find(r => r.id === 'text-general').online, 1);

  h.retract('text-b2', 'm1');
  assert.equal(s.b.last('deleted').id, 'm1');
  assert.equal(s.c.count('deleted'), 0);
});

test('unknown rooms and unconnected students are refused', () => {
  const h = new ChatHub();
  assert.equal(h.join('nobody', 'text-general').ok, false);
  h.connect({ id: 'a', name: 'a' }, stream());
  assert.equal(h.join('a', 'voice:x').ok, false);
});

test('a kicked student stops receiving the room; leaving updates the counts', () => {
  const h = new ChatHub();
  const a = stream(); const b = stream();
  h.connect({ id: 'a', name: 'a' }, a); h.connect({ id: 'b', name: 'b' }, b);
  h.join('a', 'text-general'); h.join('b', 'text-general');
  h.kick('a');
  assert.ok(a.last('kicked'));
  h.deliver('text-general', { id: 'm2' });
  assert.equal(a.count('message'), 0);
  h.disconnect('b', b);
  assert.equal(h.summary().find(r => r.id === 'text-general').online, 0);
});

test('chat inside a call reaches the people in that call only', () => {
  const v = new VoiceHub({ pickTopic: () => ({ text: 't' }), onSessionStart: async () => 's1', onSessionEnd: () => {} });
  const s = { a: stream(), b: stream(), c: stream() };
  for (const id of ['a', 'b', 'c']) v.connect({ id, name: id, level: 'B2' }, s[id]);
  v.findPartner('a'); v.findPartner('b');
  assert.equal(v.roomChat('a', { id: 'x', text: 'how do you spell "necessary"?' }).ok, true);
  assert.equal(s.b.last('chat').id, 'x');
  assert.equal(s.a.last('chat').id, 'x');
  assert.equal(s.c.count('chat'), 0);
  assert.equal(v.roomChat('c', { id: 'y' }).ok, false, 'not in a call');
});
