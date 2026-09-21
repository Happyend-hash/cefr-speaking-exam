import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Startup configuration check.
 *
 * Every one of these checks exists because the corresponding misconfiguration
 * actually shipped to production and failed silently: placeholder API keys that
 * only surfaced at the first evaluation, and a guessable JWT secret. Warn loudly
 * at boot rather than failing mysteriously later. Warnings never block startup —
 * a partly configured deployment should still serve what it can.
 */
function checkEnvironment() {
  const warnings = [];
  const placeholder = value =>
    !value ||
    /placeholder|your-|changeme|example|xxx/i.test(value);

  if (placeholder(process.env.CLAUDE_API_KEY)) {
    warnings.push('⚠ CLAUDE_API_KEY looks like a placeholder — AI evaluation will fail.');
  }
  if (placeholder(process.env.JWT_SECRET) || (process.env.JWT_SECRET || '').length < 32) {
    warnings.push('⚠ JWT_SECRET is missing, guessable, or under 32 characters — tokens are forgeable.');
  }
  if (!process.env.REFRESH_TOKEN_SECRET) {
    warnings.push('⚠ REFRESH_TOKEN_SECRET is not set — refresh tokens fall back to JWT_SECRET.');
  }
  if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.length < 40) {
    warnings.push('⚠ STRIPE_SECRET_KEY is too short to be a real Stripe key — payments will fail.');
  }
  if (!process.env.OPENAI_API_KEY) {
    warnings.push('ℹ OPENAI_API_KEY not set — transcription relies on the browser (Chrome/Edge only).');
  }
  return warnings;
}

// Route imports
import authRoutes from './routes/auth.js';
import examRoutes from './routes/exam.js';
import paymentRoutes from './routes/payment.js';
import userRoutes from './routes/user.js';
import evaluationRoutes from './routes/evaluation.js';
import adminRoutes from './routes/admin.js';
import writingRoutes from './routes/writing.js';
import leaderboardRoutes from './routes/leaderboard.js';
import voiceRoutes from './routes/voice.js';
import chatRoutes from './routes/chat.js';
import avatarRoutes from './routes/avatars.js';

// Middleware imports
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { authenticate } from './middleware/auth.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cefr-exam';

// ===========================
// MIDDLEWARE SETUP
// ===========================

/**
 * Security headers.
 *
 * helmet's default policy is `img-src 'self' data:`, which blocks blob: URLs.
 * The client needs them: exam pictures and recordings sit behind the API's
 * authentication, so they are fetched with the token and handed to the element
 * as a blob — a plain <img src> cannot send an Authorization header. The
 * recorder also plays a student's answer back from a blob before upload.
 * Without blob: the picture downloads fine and the browser then refuses to
 * display it, which looks exactly like a broken image and explains nothing.
 *
 * Everything else stays at helmet's defaults — this widens two directives, it
 * does not relax the policy generally.
 */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:']
      }
    }
  })
);
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

/**
 * Rate limiting.
 *
 * Railway terminates TLS in front of this process, so without trusting that hop
 * `req.ip` is the proxy's address, not the student's — every student in the
 * country counts as one person. The old limit of 100 per 15 minutes was
 * therefore shared by everyone, and since one mock costs about 30 requests
 * (sign in, start, save each answer, fetch the picture, submit, poll while it
 * is marked), the fourth student of any lesson was locked out mid-exam.
 *
 * `1` rather than `true`: one proxy hop is trusted, so the client address is the
 * last entry in X-Forwarded-For and cannot be spoofed by a header the client
 * sets itself. express-rate-limit also refuses to run behind a blanket `true`,
 * for exactly that reason.
 */
app.set('trust proxy', 1);

/**
 * Count per signed-in student, not per address.
 *
 * A class shares one school or mobile network, so per-IP limiting punishes
 * exactly the situation this app is built for: thirty students on the same
 * wifi. The token is verified rather than merely decoded — an unverified read
 * would let anyone mint keys and slip the limit entirely.
 */
function limitKey(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded?.id) return `user:${decoded.id}`;
    } catch {
      // Not a valid token — fall through and limit by address.
    }
  }
  return `ip:${req.ip}`;
}

// Generous enough for a full mock several times over, low enough to stop a
// runaway loop. A mock costs ~30 requests; this is 600 per student per 15 min.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 600,
  keyGenerator: limitKey,
  standardHeaders: true,
  legacyHeaders: false,
  // /api/auth has its own stricter limiter below. Without this skip both would
  // run on a sign-in: it would spend two budgets and report the looser one's
  // headers, so the strict limit would be invisible to anyone checking.
  // /voice/signal has its own budget below: setting up one group call is a
  // burst of small connection messages, and counting them here would lock a
  // student out of the rest of the site after a few calls.
  // /avatars are pictures in <img> tags: they carry no token, so they would
  // be counted per address, and a whole class behind one school connection
  // would share one budget. They have their own below.
  skip: req => req.path.startsWith('/auth') || req.path.startsWith('/voice/signal') || req.path.startsWith('/avatars'),
  message: { success: false, message: 'Too many requests — please wait a moment and try again.' }
});

// Sign-in and sign-up stay strict and per-address: this is the endpoint worth
// brute-forcing, and there is no user to count against until it succeeds.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many sign-in attempts — please wait a few minutes.' }
});

app.use('/api/auth', authLimiter);
app.use('/api/', apiLimiter);

app.use('/api/avatars', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AVATAR_RATE_LIMIT_MAX) || 5000,
  standardHeaders: true,
  legacyHeaders: false
}));

// Connection messages for speaking rooms: generous, but still a ceiling on a
// runaway loop. A five-person room is a few hundred messages to set up.
app.use('/api/voice/signal', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.VOICE_SIGNAL_LIMIT) || 5000,
  keyGenerator: limitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many connection messages — rejoin the room in a moment.' }
}));

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ===========================
// DATABASE CONNECTION
// ===========================

// useNewUrlParser / useUnifiedTopology were removed in Mongoose 6+ and are no
// longer accepted options.
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✓ MongoDB connected successfully'))
  .catch((err) => {
    console.error('✗ MongoDB connection error:', err.message);
    process.exit(1);
  });

// ===========================
// ROUTES
// ===========================

// Public routes
app.use('/api/auth', authRoutes);
app.use('/api/payment', paymentRoutes);
// Students' pictures: public by unguessable address (see routes/avatars.js).
app.use('/api/avatars', avatarRoutes);

// Protected routes (require authentication)
app.use('/api/exam', authenticate, examRoutes);
app.use('/api/user', authenticate, userRoutes);
app.use('/api/evaluation', authenticate, evaluationRoutes);
app.use('/api/writing', authenticate, writingRoutes);
app.use('/api/leaderboard', authenticate, leaderboardRoutes);
app.use('/api/voice', authenticate, voiceRoutes);
app.use('/api/chat', authenticate, chatRoutes);

// Admin routes
app.use('/api/admin', authenticate, adminRoutes);

// Health check
/**
 * Is the app actually able to serve a student?
 *
 * This used to answer OK unconditionally, which made it worse than useless:
 * the one night the site went down — the database rejecting our credentials
 * after a password rotation — this endpoint would have cheerfully returned
 * status OK to any monitor watching it, while every student saw a failure. A
 * health check that cannot fail does not report health, it reports that a
 * process is running, and nobody needs a monitor to tell them that.
 *
 * So it reports the database, which is the dependency that everything a
 * student does relies on: signing in, starting an attempt, saving an answer,
 * reading a result. A 503 when it is unreachable is what makes an uptime
 * monitor able to tell anyone anything.
 *
 * mongoose.connection.readyState: 0 disconnected, 1 connected, 2 connecting,
 * 3 disconnecting. Only 1 is servable — 2 is honest about a server still
 * coming up, and answering OK during it would hide a boot that never finishes.
 */
app.get('/api/health', (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const readyState = mongoose.connection?.readyState ?? 0;
  const healthy = readyState === 1;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'OK' : 'UNHEALTHY',
    database: states[readyState] || 'unknown',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Static files for frontend
app.use(express.static(path.join(__dirname, 'public')));

// Any non-API GET falls through to the client, so deep links and reloads work.
// Declared after express.static so real files always win.
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
    if (err) next();
  });
});

// ===========================
// ERROR HANDLING
// ===========================

// Multer signals oversized or rejected uploads with its own error type; without
// this they surface as an opaque 500.
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Recording is too large — keep answers under 10MB.'
        : `Upload rejected: ${err.message}`;
    return res.status(400).json({ success: false, message });
  }
  next(err);
});

app.use(notFound);
app.use(errorHandler);

// ===========================
// SERVER START
// ===========================

/**
 * The database, named without naming the password.
 *
 * This line used to print the connection credentials to the deploy log on every
 * boot. It meant to print the database name — it took the last "/"-separated
 * segment — but an Atlas URI has no path segment before its query string
 * (mongodb+srv://user:pass@host/?retryWrites=true), so the last segment WAS
 * "user:pass@host", and the password went into the logs of every deployment,
 * readable by anyone who could open the Railway dashboard.
 *
 * Credentials are now stripped before anything is printed, and the fallback is
 * a constant rather than any part of the URI: a parser that fails must not
 * respond by printing the raw string it failed to parse.
 */
const databaseName = (() => {
  try {
    const withoutScheme = MONGODB_URI.replace(/^[a-z+]+:\/\//i, '');
    // Everything before the LAST "@" is credentials. The last one, not the
    // first: a password may contain "@" — correctly it would be
    // percent-encoded, but a password that should have been encoded and was not
    // is exactly the case where a leak must not happen. A host cannot contain
    // "@", so splitting at the last one is always right.
    const hostAndPath = withoutScheme.includes('@')
      ? withoutScheme.slice(withoutScheme.lastIndexOf('@') + 1)
      : withoutScheme;

    const [host, ...rest] = hostAndPath.split('?')[0].split('/');
    const database = rest.filter(Boolean).pop();
    return database ? `${database} @ ${host}` : host || '(default)';
  } catch {
    return '(unknown)';
  }
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════╗
║   CEFR Speaking Exam Platform              ║
╚════════════════════════════════════════════╝
  Port:        ${PORT}
  Environment: ${process.env.NODE_ENV || 'development'}
  Database:    ${databaseName}
`);

  for (const warning of checkEnvironment()) console.warn(warning);

  console.log(
    `  Reminder: Railway routes your public domain to a specific target port.\n` +
    `  If the site returns 502 while this process is healthy, that target port\n` +
    `  does not match ${PORT}. Settings → Networking → domain → Target port.\n`
  );
});

export default app;
