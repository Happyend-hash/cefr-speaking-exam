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
  skip: req => req.path.startsWith('/auth'),
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

// Protected routes (require authentication)
app.use('/api/exam', authenticate, examRoutes);
app.use('/api/user', authenticate, userRoutes);
app.use('/api/evaluation', authenticate, evaluationRoutes);

// Admin routes
app.use('/api/admin', authenticate, adminRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
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

const databaseName = (() => {
  try {
    const withoutQuery = MONGODB_URI.split('?')[0];
    return withoutQuery.split('/').filter(Boolean).pop() || '(default)';
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
