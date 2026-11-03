import mongoose from 'mongoose';

/**
 * Friends, private chats, photo posts and stories (Jamshid, 2026-11-03:
 * "HelloTalk in my website").
 *
 *  - Friendship: one document per pair of students. A request is 'pending'
 *    until the other accepts; then both are 'friends'. Only friends see each
 *    other's profile details, posts and stories.
 *  - SocialBlock: one person blocking another. Either direction stops
 *    messages, friend requests and seeing each other in People.
 *  - Conversation + DirectMessage: a private chat between two students.
 *    Friends chat freely; anyone else can send ONE text as a request, which
 *    waits in "So'rovlar" until it is accepted (or deleted / blocked).
 *  - SocialPost: a photo post (kept) or a story (gone after 24 hours).
 *  - SocialReport: a user, post or message reported to the teacher.
 *
 * `pair` is the two user ids sorted and joined, so each pair has exactly one
 * friendship and one conversation however it was started.
 */
const { ObjectId } = mongoose.Schema.Types;

export const pairOf = (a, b) => [String(a), String(b)].sort().join('_');

const photo = { key: String, type: { type: String } };

const friendshipSchema = new mongoose.Schema({
  pair: { type: String, required: true, unique: true },
  users: [{ type: ObjectId, ref: 'User' }],
  requester: { type: ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'friends'], default: 'pending' },
  since: Date
}, { timestamps: true });
friendshipSchema.index({ users: 1, status: 1 });

const blockSchema = new mongoose.Schema({
  by: { type: ObjectId, ref: 'User', required: true },
  user: { type: ObjectId, ref: 'User', required: true }
}, { timestamps: true });
blockSchema.index({ by: 1, user: 1 }, { unique: true });
blockSchema.index({ user: 1 });

const conversationSchema = new mongoose.Schema({
  pair: { type: String, required: true, unique: true },
  users: [{ type: ObjectId, ref: 'User' }],
  status: { type: String, enum: ['request', 'open'], default: 'open' },
  requester: { type: ObjectId, ref: 'User' },
  lastAt: { type: Date, default: Date.now },
  last: { from: ObjectId, kind: String, text: String },
  // unread messages per person: { "<userId>": n }
  unread: { type: Map, of: Number, default: {} },
  // a person who "deleted" the chat no longer sees messages from before then
  clearedAt: { type: Map, of: Date, default: {} }
}, { timestamps: true });
conversationSchema.index({ users: 1, lastAt: -1 });

const directMessageSchema = new mongoose.Schema({
  conv: { type: ObjectId, ref: 'Conversation', required: true },
  from: { type: ObjectId, ref: 'User', required: true },
  to: { type: ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['text', 'photo', 'voice'], default: 'text' },
  text: { type: String, default: '', maxlength: 1000 },
  original: { type: String, select: false },      // what was typed before the filter (teacher only)
  photo,
  audioKey: String,
  seconds: Number,
  readAt: Date,
  removed: { type: Boolean, default: false }      // removed by the teacher
}, { timestamps: true });
directMessageSchema.index({ conv: 1, createdAt: -1 });

const postSchema = new mongoose.Schema({
  user: { type: ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['post', 'story'], default: 'post' },
  text: { type: String, default: '', maxlength: 1000 },
  photo,
  likes: [{ type: ObjectId, ref: 'User' }],
  expiresAt: Date,                                // stories only
  removed: { type: Boolean, default: false }
}, { timestamps: true });
postSchema.index({ user: 1, kind: 1, createdAt: -1 });
postSchema.index({ kind: 1, expiresAt: 1 });

const reportSchema = new mongoose.Schema({
  by: { type: ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['user', 'post', 'message'], required: true },
  target: { type: ObjectId, required: true },     // the user, post or message
  targetUser: { type: ObjectId, ref: 'User' },    // whose it is
  reason: { type: String, default: '', maxlength: 300 },
  status: { type: String, enum: ['open', 'done'], default: 'open' },
  handledBy: String,
  handledAt: Date
}, { timestamps: true });
reportSchema.index({ status: 1, createdAt: -1 });

export const Friendship = mongoose.model('Friendship', friendshipSchema);
export const SocialBlock = mongoose.model('SocialBlock', blockSchema);
export const Conversation = mongoose.model('Conversation', conversationSchema);
export const DirectMessage = mongoose.model('DirectMessage', directMessageSchema);
export const SocialPost = mongoose.model('SocialPost', postSchema);
export const SocialReport = mongoose.model('SocialReport', reportSchema);

export default { Friendship, SocialBlock, Conversation, DirectMessage, SocialPost, SocialReport, pairOf };
