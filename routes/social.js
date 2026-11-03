import express from 'express';
import multer from 'multer';
import { authorize } from '../middleware/auth.js';
import { APIError } from '../middleware/errorHandler.js';
import AudioStorageService from '../services/AudioStorageService.js';
import { mediaStorage } from '../services/MediaStorage.js';
import { socialHub } from '../services/SocialHub.js';
import Social from '../services/Social.js';

/**
 * Do'stlar — /api/social (signed in). Friends, private chats, posts, stories.
 * The rules live in services/Social.js; this file only speaks HTTP.
 * The teacher's side is /api/admin/social (adminRouter below).
 */
const router = express.Router();
const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e.statusCode ? new APIError(e.message, e.statusCode, e.code) : e); } };
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const voiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

/** Live events: new messages, read ticks, friend and chat requests. */
router.get('/stream', handle(async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  const id = String(req.user.id);
  socialHub.connect(id, res);
  Social.touch(id);
  res.write(`event: hello\ndata: {}\n\n`);
  const beat = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(beat); socialHub.disconnect(id, res); Social.touch(id); });
}));

router.get('/unread', handle(async (req, res) => ok(res, await Social.unread(req.user.id))));

// ---- people, profiles, friends
router.get('/people', handle(async (req, res) => ok(res, { people: await Social.people(req.user.id, { q: req.query.q }) })));
router.get('/friends', handle(async (req, res) => ok(res, {
  friends: await Social.friends(req.user.id), requests: await Social.friendRequests(req.user.id)
})));
router.get('/blocked', handle(async (req, res) => ok(res, { blocked: await Social.blockedList(req.user.id) })));
router.get('/me', handle(async (req, res) => ok(res, { profile: await Social.profile(req.user.id, req.user.id) })));
router.patch('/me', handle(async (req, res) => ok(res, { profile: await Social.updateMyProfile(req.user.id, req.body || {}) })));
router.get('/people/:id', handle(async (req, res) => ok(res, { profile: await Social.profile(req.user.id, req.params.id) })));
router.post('/people/:id/friend', handle(async (req, res) => ok(res, { relation: await Social.requestFriend(req.user.id, req.params.id) })));
router.post('/people/:id/accept', handle(async (req, res) => ok(res, { relation: await Social.acceptFriend(req.user.id, req.params.id) })));
router.delete('/people/:id/friend', handle(async (req, res) => ok(res, { relation: await Social.removeFriend(req.user.id, req.params.id) })));
router.post('/people/:id/block', handle(async (req, res) => { await Social.block(req.user.id, req.params.id); ok(res, { blocked: true }); }));
router.delete('/people/:id/block', handle(async (req, res) => { await Social.unblock(req.user.id, req.params.id); ok(res, { blocked: false }); }));

// ---- chats
router.get('/chats', handle(async (req, res) => ok(res, await Social.chats(req.user.id))));
router.get('/chats/:id', handle(async (req, res) => ok(res, await Social.thread(req.user.id, req.params.id, { before: req.query.before }))));
router.post('/chats/:id', handle(async (req, res) => ok(res, await Social.send(req.user.id, req.params.id, {
  text: req.body?.text, photo: req.body?.photo
}), 201)));
router.post('/chats/:id/voice', (req, res, next) => voiceUpload.single('audio')(req, res, async error => {
  try {
    if (error?.code === 'LIMIT_FILE_SIZE') throw new APIError('Ovozli xabar juda uzun — 1 daqiqagacha.', 413, 'too_long');
    if (error) throw error;
    const file = req.file;
    if (!file?.buffer?.length) throw new APIError("Ovoz yozilmadi — qayta urinib ko'ring.", 400, 'empty');
    const type = String(file.mimetype || '').split(';')[0];
    if (!/^audio\/(webm|ogg|mp4|mpeg|aac|x-m4a)$/.test(type)) throw new APIError('Bu ovoz formati qabul qilinmaydi.', 400, 'format');
    const out = await Social.send(req.user.id, req.params.id, {
      voice: { buffer: file.buffer, contentType: type, seconds: req.body?.seconds }
    });
    ok(res, out, 201);
  } catch (e) { next(e.statusCode && !(e instanceof APIError) ? new APIError(e.message, e.statusCode, e.code) : e); }
}));
router.post('/chats/:id/accept', handle(async (req, res) => { await Social.acceptChat(req.user.id, req.params.id); ok(res, { accepted: true }); }));
router.post('/chats/:id/decline', handle(async (req, res) => { await Social.declineChat(req.user.id, req.params.id); ok(res, { declined: true }); }));
router.delete('/chats/:id', handle(async (req, res) => { await Social.clearChat(req.user.id, req.params.id); ok(res, { cleared: true }); }));

// ---- posts and stories
router.get('/feed', handle(async (req, res) => ok(res, await Social.feed(req.user.id, { before: req.query.before }))));
router.get('/stories', handle(async (req, res) => ok(res, { stories: await Social.stories(req.user.id) })));
router.post('/posts', handle(async (req, res) => ok(res, { post: await Social.createPost(req.user.id, req.body || {}) }, 201)));
router.delete('/posts/:id', handle(async (req, res) => { await Social.deletePost(req.user.id, req.params.id); ok(res, { deleted: true }); }));
router.post('/posts/:id/like', handle(async (req, res) => ok(res, await Social.toggleLike(req.user.id, req.params.id))));
router.post('/report', handle(async (req, res) => { await Social.report(req.user.id, req.body || {}); ok(res, { reported: true }); }));

// ---- media, only for the people allowed to see it
async function sendPhoto(res, kind, id, userId, admin = false) {
  const item = kind === 'm' ? await Social.messageMedia(userId, id, { admin }) : kind === 'p' ? await Social.postMedia(userId, id, { admin }) : null;
  if (!item?.photo?.key) return res.status(404).end();
  mediaStorage.serve(res, item.photo.key, item.photo.type);
}
async function sendVoice(res, id, userId, admin = false) {
  const m = await Social.messageMedia(userId, id, { admin });
  if (!m?.audioKey) return res.status(404).end();
  const meta = await AudioStorageService.getMetadata(m.audioKey);
  if (!meta) return res.status(404).end();
  res.setHeader('Content-Type', meta.contentType || 'audio/webm');
  if (meta.length) res.setHeader('Content-Length', String(meta.length));
  res.setHeader('Cache-Control', 'private, max-age=86400');
  AudioStorageService.openDownloadStream(m.audioKey).on('error', () => res.status(404).end()).pipe(res);
}
router.get('/photo/:kind(m|p)/:id', handle(async (req, res) => sendPhoto(res, req.params.kind, req.params.id, req.user.id)));
router.get('/voice/:id', handle(async (req, res) => sendVoice(res, req.params.id, req.user.id)));

// ---- the teacher
export const adminRouter = express.Router();
adminRouter.use(authorize('admin'));
adminRouter.get('/', handle(async (req, res) => ok(res, await Social.adminOverview())));
adminRouter.post('/reports/:id/:action(done|remove)', handle(async (req, res) => {
  await Social.adminHandleReport(req.params.id, { action: req.params.action, by: req.user.email });
  ok(res, await Social.adminOverview());
}));
adminRouter.delete('/posts/:id', handle(async (req, res) => {
  await Social.deletePost(req.user.id, req.params.id, { admin: true });
  ok(res, await Social.adminOverview());
}));
adminRouter.get('/photo/:kind(m|p)/:id', handle(async (req, res) => sendPhoto(res, req.params.kind, req.params.id, req.user.id, true)));
adminRouter.get('/voice/:id', handle(async (req, res) => sendVoice(res, req.params.id, req.user.id, true)));

export default router;
