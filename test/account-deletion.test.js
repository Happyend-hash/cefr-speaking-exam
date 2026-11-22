/** "Hisobni o'chirish": what goes, what stays — run against stubbed models (no database). */
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import User from '../models/User.js';
import ExamResult from '../models/ExamResult.js';
import PaymentTransaction from '../models/PaymentTransaction.js';
import Payment from '../models/Payment.js';
import ChatMessage from '../models/ChatMessage.js';
import VoiceSession from '../models/VoiceSession.js';
import WallCertificate from '../models/WallCertificate.js';
import { Conversation, DirectMessage, SocialPost } from '../models/Social.js';
import AudioStorageService from '../services/AudioStorageService.js';
import { mediaStorage } from '../services/MediaStorage.js';
import { avatarStorage } from '../services/Premium.js';
import { deleteAccount, emailHash } from '../services/AccountDeletion.js';

const chain = value => ({ select() { return this; }, lean: async () => value, then: (ok, bad) => Promise.resolve(value).then(ok, bad) });
const id = new mongoose.Types.ObjectId();

function stubAll(user) {
  const calls = [];
  const models = Object.values(mongoose.models);
  const saved = [];
  for (const M of models) {
    for (const fn of ['find', 'findById', 'deleteMany', 'deleteOne', 'updateMany', 'updateOne', 'exists']) {
      saved.push([M, fn, M[fn]]);
      M[fn] = (...args) => {
        calls.push([M.modelName, fn, args[0], args[1]]);
        if (fn === 'findById') return chain(M === User ? user : null);
        if (fn === 'find') {
          if (M === ExamResult) return chain([{ taskResults: [{ audioKey: 'a1' }, { audioKey: 'a2' }] }]);
          if (M === ChatMessage) return chain([{ audioKey: 'c1' }]);
          if (M === VoiceSession) return chain([{ recordings: [{ user: id, audioKey: 'v1' }, { user: new mongoose.Types.ObjectId(), audioKey: 'other' }] }]);
          if (M === Conversation) return chain([{ _id: 'conv1' }]);
          if (M === DirectMessage) return chain([{ photo: { key: 'p1', type: 'image/jpeg' } }, { audioKey: 'd1' }]);
          if (M === SocialPost) return chain([{ _id: 'post1', photo: { key: 'p2', type: 'image/png' } }]);
          if (M === WallCertificate) return chain([{ photo: { key: 'p3' } }]);
          return chain([]);
        }
        return Promise.resolve({});
      };
    }
    saved.push([M.collection, 'updateMany', M.collection.updateMany]);
    M.collection.updateMany = async (...args) => { calls.push([M.modelName, 'collection.updateMany', args[0], args[1]]); return {}; };
  }
  const gone = { audio: [], media: [], avatar: [] };
  saved.push([AudioStorageService, 'delete', AudioStorageService.delete], [mediaStorage, 'delete', mediaStorage.delete], [avatarStorage, 'delete', avatarStorage.delete]);
  AudioStorageService.delete = async k => gone.audio.push(k);
  mediaStorage.delete = async k => gone.media.push(k);
  avatarStorage.delete = async k => gone.avatar.push(k);
  return { calls, gone, restore: () => saved.reverse().forEach(([o, k, v]) => { o[k] = v; }) };
}

test('a student deletes their account: files and rows go, payments stay with a snapshot', async () => {
  const s = stubAll({ _id: id, email: 'ali@example.com', firstName: 'Ali', lastName: 'Valiyev', role: 'student', picture: { key: 'av1' } });
  try {
    await deleteAccount(String(id), { confirmEmail: ' Ali@Example.com ' });
    assert.deepEqual(s.gone.audio.sort(), ['a1', 'a2', 'c1', 'd1', 'v1']);
    assert.deepEqual(s.gone.media.sort(), ['p1', 'p2', 'p3']);
    assert.deepEqual(s.gone.avatar, ['av1']);
    const did = (model, fn) => s.calls.filter(c => c[0] === model && c[1] === fn);
    assert.equal(did('User', 'deleteOne').length, 1);
    assert.equal(did('ExamResult', 'deleteMany').length, 1);
    assert.equal(did('WritingAttempt', 'deleteMany').length, 1);
    // payments are never deleted
    assert.equal(did('PaymentTransaction', 'deleteMany').length + did('Payment', 'deleteMany').length, 0);
    const snap = did('PaymentTransaction', 'collection.updateMany')[0][3].$set.deletedAccount;
    assert.equal(snap.email, 'ali@example.com');
    assert.equal(snap.name, 'Ali Valiyev');
    assert.ok(did('Payment', 'collection.updateMany').length);
    assert.equal(did('PaymentTransaction', 'updateMany')[0][2].status, 'pending');
    // only the hash of the email is kept
    const tomb = did('DeletedAccount', 'updateOne')[0][2];
    assert.equal(tomb.emailHash, emailHash('ali@example.com'));
    assert.ok(!JSON.stringify(tomb).includes('ali@'));
  } finally { s.restore(); }
});

test('the email must match, and teachers cannot delete themselves here', async () => {
  let s = stubAll({ _id: id, email: 'ali@example.com', role: 'student' });
  try {
    await assert.rejects(deleteAccount(String(id), { confirmEmail: 'someone@else.com' }), /mos kelmadi/);
    assert.equal(s.calls.filter(c => c[1] === 'deleteMany' || c[1] === 'deleteOne').length, 0);
  } finally { s.restore(); }
  s = stubAll({ _id: id, email: 't@example.com', role: 'admin' });
  try {
    await assert.rejects(deleteAccount(String(id), { confirmEmail: 't@example.com' }), /o‘chirilmaydi/);
  } finally { s.restore(); }
});
