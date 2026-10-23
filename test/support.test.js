/** English Hub Support: pictures are checked by their bytes, messages are tagged and rate-limited. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readImage, userSend, view, PER_HOUR } from '../services/Support.js';
import SupportMessage from '../models/SupportMessage.js';

const PNG = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

test('a screenshot must really be a picture', () => {
  assert.equal(readImage(PNG).contentType, 'image/png');
  assert.throws(() => readImage('data:image/png;base64,' + Buffer.from('<script>').toString('base64')), /rasm emas/);
  assert.throws(() => readImage('data:text/html;base64,PGI+'), /JPEG, PNG/);
});

test('a student message: tagged, trimmed, empty refused, and at most PER_HOUR an hour', async () => {
  const made = [];
  let recent = 0;
  const orig = { count: SupportMessage.countDocuments, create: SupportMessage.create };
  SupportMessage.countDocuments = async () => recent;
  SupportMessage.create = async doc => { made.push(doc); return { toObject: () => ({ _id: 'x', createdAt: new Date(), ...doc }) }; };
  try {
    const v = await userSend('64b000000000000000000001', { kind: 'problem', text: '  The timer stops on Part 2  ' });
    assert.equal(v.kind, 'problem');
    assert.equal(made[0].text, 'The timer stops on Part 2');
    await userSend('64b000000000000000000001', { kind: 'hack', text: 'hi' });
    assert.equal(made[1].kind, 'question', 'an unknown kind becomes a question');
    await assert.rejects(userSend('64b000000000000000000001', { text: '   ' }), /Xabar yozing/);
    recent = PER_HOUR;
    await assert.rejects(userSend('64b000000000000000000001', { text: 'again' }), e => e.statusCode === 429);
  } finally { Object.assign(SupportMessage, { countDocuments: orig.count, create: orig.create }); }
});

test('the student never sees which admin answered', () => {
  const m = { _id: 'a', from: 'team', text: 'Hi', sentBy: 'teacher@x.com', createdAt: new Date(), readByUser: null };
  assert.equal(view(m).sentBy, undefined);
  assert.equal(view(m, { admin: true }).sentBy, 'teacher@x.com');
});
