/**
 * Premium: how long it lasts, what is shown, and the room perks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPremium, extendPremium, premiumDaysLeft, avatarUrl, sniffImage, PREMIUM_DAYS } from '../services/Premium.js';
import { VoiceHub, CLUB_MAX, ANY_LEVEL_AFTER_MS } from '../services/VoiceHub.js';

const DAY = 864e5;
const T = Date.UTC(2026, 8, 21);

test('a payment gives 30 days, and paying again adds to the end', () => {
  const u = {};
  assert.equal(isPremium(u, T), false);
  extendPremium(u, PREMIUM_DAYS, T);
  assert.equal(premiumDaysLeft(u, T), 30);
  extendPremium(u, PREMIUM_DAYS, T + 10 * DAY);         // pays again with 20 days left
  assert.equal(premiumDaysLeft(u, T + 10 * DAY), 50);
  assert.equal(isPremium(u, T + 61 * DAY), false, 'runs out');
  extendPremium(u, PREMIUM_DAYS, T + 100 * DAY);        // lapsed, then pays: starts today
  assert.equal(premiumDaysLeft(u, T + 100 * DAY), 30);
});

test('a picture is shown only while Premium', () => {
  const u = { picture: { token: 'a'.repeat(32) } };
  assert.equal(avatarUrl(u, T), null);
  extendPremium(u, 30, T);
  assert.equal(avatarUrl(u, T), `/api/avatars/${'a'.repeat(32)}`);
  assert.equal(avatarUrl(u, T + 31 * DAY), null, 'kept but hidden after Premium ends');
});

test('only real GIF, PNG, JPG and WEBP files are accepted', () => {
  const pad = b => Buffer.concat([b, Buffer.alloc(16)]);
  assert.equal(sniffImage(pad(Buffer.from('GIF89a'))), 'image/gif');
  assert.equal(sniffImage(pad(Buffer.from([0x89, 0x50, 0x4e, 0x47]))), 'image/png');
  assert.equal(sniffImage(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>'))), null, 'SVG refused');
  assert.equal(sniffImage(pad(Buffer.from('<html>'))), null);
  assert.equal(sniffImage(Buffer.from('GIF')), null, 'too short');
});

function stream() {
  const events = [];
  return {
    events,
    write(frame) {
      events.push({ event: frame.match(/^event: (.+)$/m)[1], data: JSON.parse(frame.match(/^data: (.+)$/m)[1]) });
    },
    last(name) { return [...events].reverse().find(e => e.event === name)?.data; }
  };
}
const hub = () => {
  let clock = 1_000_000;
  const h = new VoiceHub({ now: () => clock, pickTopic: () => ({ text: 't' }), onSessionStart: async () => 's' });
  h.advance = ms => { clock += ms; };
  return h;
};

test('a full club has one more seat, for Premium students only', () => {
  const h = hub();
  for (let i = 0; i < CLUB_MAX; i += 1) {
    h.connect({ id: `f${i}`, name: `F${i}` }, stream());
    assert.equal(h.join(`f${i}`, 'club-open').ok, true);
  }
  h.connect({ id: 'free', name: 'Free' }, stream());
  h.connect({ id: 'gold', name: 'Gold', premium: true, avatar: '/api/avatars/x' }, stream());
  h.connect({ id: 'gold2', name: 'Gold2', premium: true }, stream());
  assert.equal(h.join('free', 'club-open').ok, false, 'free student: full');
  assert.equal(h.join('gold', 'club-open').ok, true, 'Premium: takes the extra seat');
  assert.equal(h.join('gold2', 'club-open').ok, false, 'only one extra seat');
  const summary = h.clubSummary().find(r => r.id === 'club-open');
  assert.equal(summary.count, CLUB_MAX + 1);
  const g = summary.people.find(p => p.id === 'gold');
  assert.equal(g.premium, true); assert.equal(g.avatar, '/api/avatars/x');
});

test('a Premium student waiting is paired before others', () => {
  const h = hub();
  const t = {};
  // Two students waiting at levels nobody else has: a (free) came first.
  for (const [id, level, premium] of [['a', 'B1', false], ['b', 'C1', true]]) {
    t[id] = stream();
    h.connect({ id, name: id, level, premium }, t[id]);
    h.findPartner(id);
  }
  h.advance(ANY_LEVEL_AFTER_MS);
  t.c = stream();
  h.connect({ id: 'c', name: 'c', level: 'B2' }, t.c);
  h.findPartner('c');
  assert.equal(t.c.last('matched').members.some(m => m.id === 'b'), true, 'the Premium one (b) is chosen, though a waited longer');
  assert.equal(t.a.last('matched'), undefined, 'a keeps waiting');
});

test("a new picture reaches the people in the student's call", () => {
  const h = hub();
  const a = stream(); const b = stream();
  h.connect({ id: 'a', name: 'a', level: 'B2' }, a);
  h.connect({ id: 'b', name: 'b', level: 'B2' }, b);
  h.findPartner('a'); h.findPartner('b');
  h.updateUser('a', { premium: true, avatar: '/api/avatars/y' });
  assert.equal(b.last('peer-updated').peer.avatar, '/api/avatars/y');
  assert.equal(h.memberView('a').premium, true);
});
