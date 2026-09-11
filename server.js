import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

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

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ===========================
// DATABASE CONNECTION
// ===========================

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
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
app.use(express.static('public'));

// ===========================
// ERROR HANDLING
// ===========================

app.use(notFound);
app.use(errorHandler);

// ===========================
// SERVER START
// ===========================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   CEFR Speaking Exam Platform             ║
║   Server running on port ${PORT}              ║
║   Environment: ${process.env.NODE_ENV || 'development'}       ║
║   Database: ${MONGODB_URI.split('/')[-1]}                  ║
╚════════════════════════════════════════════╝
  `);
});

export default app;
