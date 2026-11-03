import webpush from 'web-push';
import mongoose from 'mongoose';
import { PushSubscription, PushKey } from '../models/PushSubscription.js';

/**
 * Phone notifications with the red number (Jamshid, 2026-11-03).
 *
 * When a student gets something new — a Do'stlar message, a chat or friend
 * request, a reply from Yordam markazi, a message from the teacher — every
 * phone they turned notifications on for gets a notification. In the
 * Android app (it delegates notifications to the site) and in browsers the
 * notification shows under "English Hub", and the phone's launcher puts the
 * red number on the app icon. The payload also carries the total unread, so
 * the service worker can set the badge itself where the phone supports that
 * (iPhone home-screen app, desktop installs).
 *
 * Nothing here ever throws into the caller: a message is saved whether or
 * not a phone could be told.
 */

/** Tests swap the unread counter for a stub (it reads four collections). */
export const forTests = { badge: null };

const SUBJECT = process.env.VAPID_SUBJECT || 'https://englishhub.uz';
const MAX_FAILS = 10;

let ready = null;

/** The site's VAPID keys: from the environment, else from the database (made once). */
export function keys() {
  if (!ready) {
    ready = (async () => {
      let publicKey = process.env.VAPID_PUBLIC_KEY;
      let privateKey = process.env.VAPID_PRIVATE_KEY;
      if (!publicKey || !privateKey) {
        let row = await PushKey.findOne({ key: 'vapid' }).select('+privateKey').lean();
        if (!row) {
          const made = webpush.generateVAPIDKeys();
          try {
            await PushKey.create({ key: 'vapid', ...made });
          } catch (error) {
            if (error?.code !== 11000) throw error;   // another server made them first
          }
          row = await PushKey.findOne({ key: 'vapid' }).select('+privateKey').lean();
        }
        ({ publicKey, privateKey } = row);
      }
      webpush.setVapidDetails(SUBJECT, publicKey, privateKey);
      return { publicKey };
    })().catch(error => { ready = null; throw error; });
  }
  return ready;
}

export async function publicKey() {
  return (await keys()).publicKey;
}

const clean = v => String(v || '').slice(0, 2000);

export async function subscribe(userId, sub = {}, agent = '') {
  const endpoint = clean(sub.endpoint);
  const p256dh = clean(sub.keys?.p256dh);
  const auth = clean(sub.keys?.auth);
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) {
    throw Object.assign(new Error('Bildirishnoma manzili noto‘g‘ri'), { statusCode: 400 });
  }
  // One phone belongs to whoever signed in on it last.
  await PushSubscription.updateOne(
    { endpoint },
    { $set: { user: userId, keys: { p256dh, auth }, agent: String(agent || '').slice(0, 60), fails: 0 } },
    { upsert: true }
  );
  return true;
}

export async function unsubscribe(userId, endpoint) {
  await PushSubscription.deleteOne({ user: userId, endpoint: clean(endpoint) });
  return true;
}

/** Everything unread for this student: the number on the app icon. */
export async function badgeCount(userId) {
  const [{ unreadCount }, { userUnread }, { unread }] = await Promise.all([
    import('./Messages.js'), import('./Support.js'), import('./Social.js')
  ]);
  const [inbox, support, social] = await Promise.all([
    unreadCount(userId).catch(() => 0),
    userUnread(userId).catch(() => 0),
    unread(userId).then(s => s.total).catch(() => 0)
  ]);
  return (inbox || 0) + (support || 0) + (social || 0);
}

async function deliver(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
      { TTL: 24 * 3600, urgency: 'high' }
    );
    await PushSubscription.updateOne({ _id: sub._id }, { $set: { lastOkAt: new Date(), fails: 0 } });
  } catch (error) {
    const gone = error?.statusCode === 404 || error?.statusCode === 410;
    if (gone || (sub.fails || 0) + 1 >= MAX_FAILS) {
      await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
    } else {
      await PushSubscription.updateOne({ _id: sub._id }, { $inc: { fails: 1 } }).catch(() => {});
      console.warn(`push failed (${error?.statusCode || error?.message})`);
    }
  }
}

/**
 * Tell one student's phones. `note` = { title, body, url, kind, from }.
 * `kind` + `from` let the app clear the right notifications once read.
 */
export async function notify(userId, note = {}) {
  try {
    if (!mongoose.isValidObjectId(String(userId))) return;
    const subs = await PushSubscription.find({ user: userId }).lean();
    if (!subs.length) return;
    await keys();
    const payload = JSON.stringify({
      title: String(note.title || 'English Hub').slice(0, 80),
      body: String(note.body || '').slice(0, 160),
      url: String(note.url || '/'),
      kind: note.kind || 'other',
      from: note.from ? String(note.from) : '',
      badge: await (forTests.badge || badgeCount)(userId),
      at: Date.now()
    });
    await Promise.all(subs.map(s => deliver(s, payload)));
  } catch (error) {
    console.warn(`push notify skipped: ${error?.message}`);
  }
}

/** Same, without making the caller wait. */
export function notifySoon(userId, note) {
  setImmediate(() => { notify(userId, note); });
}

/** The teacher's message to many students: only those with phones signed up. */
export function notifyMany(userIds, note) {
  setImmediate(async () => {
    try {
      const ids = await PushSubscription.distinct('user', { user: { $in: userIds } });
      for (let i = 0; i < ids.length; i += 20) {
        await Promise.all(ids.slice(i, i + 20).map(id => notify(id, note)));
      }
    } catch (error) {
      console.warn(`push notifyMany skipped: ${error?.message}`);
    }
  });
}

export async function stats() {
  const [devices, students] = await Promise.all([
    PushSubscription.countDocuments({}),
    PushSubscription.distinct('user').then(l => l.length)
  ]);
  return { devices, students };
}

export default { keys, publicKey, subscribe, unsubscribe, badgeCount, notify, notifySoon, notifyMany, stats };
