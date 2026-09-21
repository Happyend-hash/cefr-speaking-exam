import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { VoiceHub } from './VoiceHub.js';
import VoiceSession from '../models/VoiceSession.js';
import AudioStorageService from './AudioStorageService.js';

/**
 * The one live speaking-room hub for this server, wired to storage.
 *
 * VoiceHub holds the rules; this file supplies the things that need the
 * database or the filesystem: topic cards, session records, recordings, and
 * clearing old recordings away.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** How long call recordings are kept before they are deleted automatically. */
export const RETENTION_DAYS = Number(process.env.VOICE_RETENTION_DAYS) || 7;

// ------------------------------------------------------------------ topics

/**
 * Topic cards come from the real mock tests: the Part 2 question sets and the
 * Part 3 debate statements with their arguments for and against. Students
 * practise exactly what the exam asks.
 */
function loadTopics() {
  try {
    const mocks = JSON.parse(fs.readFileSync(path.join(__dirname, '../content/mocks.json'), 'utf8'));
    const topics = [];
    for (const mock of mocks) {
      for (const section of mock.sections || []) {
        if (section.part === '2' && section.questions?.[0]?.text) {
          topics.push({
            part: '2',
            title: 'Part 2 — tell your partner',
            text: section.questions[0].text
          });
        }
        if (section.part === '3' && section.topic) {
          topics.push({
            part: '3',
            title: 'Part 3 — debate',
            text: section.topic,
            pros: section.pros || [],
            cons: section.cons || []
          });
        }
      }
    }
    return topics;
  } catch (error) {
    console.warn('Speaking rooms: could not load topics from mocks.json —', error.message);
    return [];
  }
}

const TOPICS = loadTopics();
const FALLBACK_TOPIC = {
  part: '3',
  title: 'Part 3 — debate',
  text: 'Social media does more harm than good. Do you agree?',
  pros: ['Spreads false information', 'Wastes time', 'Affects mental health'],
  cons: ['Connects people', 'Helps small businesses', 'Fast access to news']
};

let lastTopic = -1;
export function pickTopic() {
  if (!TOPICS.length) return FALLBACK_TOPIC;
  let i = Math.floor(Math.random() * TOPICS.length);
  if (TOPICS.length > 1 && i === lastTopic) i = (i + 1) % TOPICS.length;
  lastTopic = i;
  return TOPICS[i];
}

// ------------------------------------------------------------ connection

/**
 * How browsers find each other. STUN (free, public) is enough on most wifi.
 * On mobile data many connections need a relay (TURN), which is a paid
 * service — configured in Railway, never in code:
 *
 *   TURN_URLS        e.g. turn:relay.example.com:3478,turns:relay.example.com:5349
 *   TURN_USERNAME
 *   TURN_CREDENTIAL
 *
 * Without them, calls still work wherever a direct connection is possible.
 */
export function iceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const urls = String(process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (urls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  return servers;
}

export const relayConfigured = () => iceServers().length > 1;

// ------------------------------------------------------------------- hub

export const voiceHub = new VoiceHub({
  pickTopic,

  async onSessionStart(room) {
    try {
      const session = await VoiceSession.create({
        kind: room.kind,
        room: room.id,
        roomName: room.name,
        topic: room.topic,
        startedAt: new Date()
      });
      return session._id;
    } catch (error) {
      console.error('Speaking rooms: could not record a session:', error.message);
      return null;
    }
  },

  onJoin(room, user) {
    // The session id may still be arriving (it is created asynchronously), so
    // wait a moment for it rather than lose the participant.
    const record = async (attempt = 0) => {
      if (!room.sessionId) {
        if (attempt < 20) setTimeout(() => record(attempt + 1), 100).unref?.();
        return;
      }
      await VoiceSession.updateOne(
        { _id: room.sessionId, 'participants.user': { $ne: user.id } },
        { $push: { participants: { user: user.id, name: user.name, joinedAt: new Date() } } }
      ).catch(error => console.error('Speaking rooms: participant not recorded:', error.message));
    };
    record();
  },

  onSessionEnd(room) {
    if (!room.sessionId) return;
    VoiceSession.updateOne({ _id: room.sessionId }, { $set: { endedAt: new Date() } })
      .catch(error => console.error('Speaking rooms: session end not recorded:', error.message));
  }
});

// Pair anyone who has waited long enough for a same-level partner.
setInterval(() => voiceHub.sweepQueue(), 5000).unref?.();

// ------------------------------------------------------------- retention

/**
 * Delete recordings older than RETENTION_DAYS, and the sessions with them.
 *
 * Sessions with a report are kept as long as the rest — a teacher who has not
 * looked within the week has a week's warning in the panel — so the rule is
 * simple and the storage stays bounded: without this, a free database fills.
 */
export async function purgeOldSessions() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    const old = await VoiceSession.find({ startedAt: { $lt: cutoff } }).select('recordings').lean();
    let files = 0;
    for (const session of old) {
      for (const rec of session.recordings || []) {
        if (await AudioStorageService.delete(rec.audioKey)) files += 1;
      }
    }
    if (old.length) {
      await VoiceSession.deleteMany({ _id: { $in: old.map(s => s._id) } });
      console.log(`Speaking rooms: removed ${old.length} session(s) and ${files} recording(s) older than ${RETENTION_DAYS} days`);
    }
    return { sessions: old.length, files };
  } catch (error) {
    console.error('Speaking rooms: cleanup failed:', error.message);
    return { sessions: 0, files: 0 };
  }
}

setTimeout(purgeOldSessions, 60 * 1000).unref?.();
setInterval(purgeOldSessions, 6 * 60 * 60 * 1000).unref?.();

export default voiceHub;
