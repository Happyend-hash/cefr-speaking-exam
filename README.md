# CEFR Speaking Exam Platform - Professional Edition

## 🎯 Overview

A complete, production-ready CEFR (Common European Framework of Reference) Speaking Exam platform that uses **Claude Opus** AI for sophisticated speech evaluation and assessment. This platform is designed for monetization with student payments and subscription management.

**Version:** 1.0.0  
**Status:** Production Ready  
**License:** MIT

---

## 🌟 Key Features

### For Students
- ✅ **Multi-level exams** (A1-C2) with realistic speaking tasks
- ✅ **Real-time recording interface** with audio visualization  
- ✅ **AI-powered evaluation** using Claude Opus
- ✅ **Detailed feedback** on grammar, vocabulary, fluency, pronunciation, and coherence
- ✅ **CEFR level assessment** with scores
- ✅ **Digital certificates** for passing exams
- ✅ **Exam history** and progress tracking
- ✅ **Mobile-responsive** design

### For Instructors/Admins
- ✅ **Create custom exam templates** with multiple task types
- ✅ **Manage student accounts** and subscriptions
- ✅ **Manual review** of AI evaluations for quality assurance
- ✅ **Analytics dashboard** with detailed statistics
- ✅ **Payment management** integrated with Stripe
- ✅ **Certificate issuance** system
- ✅ **Bulk student registration**

### Technical Features
- ✅ **API-based architecture** - Fully REST API with JWT authentication
- ✅ **MongoDB database** - Scalable document storage
- ✅ **Stripe integration** - Payment processing and subscriptions
- ✅ **Claude Opus AI** - Sophisticated linguistic analysis
- ✅ **Email notifications** - Verification, results, payment confirmations
- ✅ **Security features** - Rate limiting, CORS, helmet, password hashing
- ✅ **Rate limiting** - Protection against abuse
- ✅ **Audit logging** - Track all important actions

---

## 📋 System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Frontend (React/Vue)                   │
│                 (Separate repository)                    │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│        Express.js Backend API (This Project)             │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Routes (Auth, Exam, Payment, User, Evaluation)  │   │
│  └────────────┬─────────────────────────────────────┘   │
│               ▼                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │    Services (Auth, Payment, Evaluation, etc)    │   │
│  └────────────┬─────────────────────────────────────┘   │
│               ▼                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │     Models (User, Exam, ExamResult, Payment)    │   │
│  └─────────────────────────────────────────────────┘   │
└──────────────────────┬───────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
    MongoDB       Claude API    Stripe API    AWS S3
   (Database)     (AI Eval)  (Payments)   (Audio Storage)
```

---

## 🚀 Quick Start Guide

### Prerequisites

- **Node.js** 20+ (included on your system)
- **MongoDB** (local or MongoDB Atlas cloud database)
- **npm** or **yarn**
- **Stripe account** (free tier available at stripe.com)
- **Claude API key** (from console.anthropic.com)

### Installation Steps

#### 1. **Clone or Extract Project**

```bash
cd Documents
mkdir cefr-speaking-exam
cd cefr-speaking-exam
# Copy all files here
```

#### 2. **Install Dependencies**

```bash
npm install
```

This will install all required packages from package.json:
- express, mongoose, dotenv, jsonwebtoken, bcryptjs
- stripe, nodemailer, axios, multer
- And more...

#### 3. **Configure Environment**

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials:

```env
# Server
NODE_ENV=development
PORT=5000

# Database - Use MongoDB Atlas (cloud) or local MongoDB
MONGODB_URI=mongodb://localhost:27017/cefr-exam
# Or use MongoDB Atlas:
# MONGODB_ATLAS_URI=mongodb+srv://username:password@cluster.mongodb.net/cefr-exam

# Claude AI API
CLAUDE_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxx  # Get from console.anthropic.com
CLAUDE_MODEL=claude-opus-5-20250805

# Stripe
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxx      # Get from dashboard.stripe.com
STRIPE_PUBLIC_KEY=pk_test_xxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxx

# Email (Gmail example)
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password  # Use app-specific password

# JWT Security
JWT_SECRET=your_super_secret_key_here_change_in_production
REFRESH_TOKEN_SECRET=your_refresh_secret_here

# Pricing
PRICE_PER_EXAM_USD=15
```

#### 4. **Set Up Database**

**Option A: MongoDB Locally (Simple for development)**

```bash
# Install MongoDB Community (if not installed)
# Windows: Download from https://www.mongodb.com/try/download/community

# MongoDB will run on localhost:27017 by default
# Connection string: mongodb://localhost:27017/cefr-exam
```

**Option B: MongoDB Atlas (Cloud - Recommended for production)**

1. Go to https://www.mongodb.com/cloud/atlas
2. Create free account
3. Create a cluster
4. Get connection string
5. Update `MONGODB_URI` in `.env`

#### 5. **Start Development Server**

```bash
npm run dev
```

Or for production:

```bash
npm start
```

Server will start on `http://localhost:5000`

Check health: `curl http://localhost:5000/api/health`

---

## 💰 Monetization Setup

### Stripe Integration

The platform includes complete Stripe integration for:

- **Per-exam payments** ($15 USD per exam)
- **Subscriptions** (Premium: $29.99/month, Enterprise: $99.99/month)
- **Refund management**
- **Invoice generation**
- **Discount codes**

**Setup Stripe:**

1. Create free account at https://stripe.com
2. Get API keys from Dashboard
3. Add to `.env`:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_PUBLIC_KEY`
   - `STRIPE_WEBHOOK_SECRET`

4. Set webhook endpoint in Stripe dashboard pointing to:
   `https://yourdomain.com/api/payment/webhook`

### Pricing Structure

```
FREE PLAN (Default)
├─ 2 free exams per month
├─ Basic results
└─ No certificate

PREMIUM ($29.99/month)
├─ 10 exams per month
├─ Unlimited exams after
├─ Certificates
└─ Priority support

ENTERPRISE ($99.99/month)
├─ 50 exams per month
├─ Custom branding
├─ API access
└─ Dedicated support
```

---

## 🔑 API Documentation

### Authentication Endpoints

```bash
# Register
POST /api/auth/register
{
  "email": "student@example.com",
  "firstName": "John",
  "lastName": "Doe",
  "password": "SecurePassword123!"
}

# Login
POST /api/auth/login
{
  "email": "student@example.com",
  "password": "SecurePassword123!"
}

Response:
{
  "accessToken": "jwt_token_here",
  "refreshToken": "refresh_token_here",
  "user": { ... }
}
```

### Exam Endpoints

```bash
# Get available exams
GET /api/exam
Authorization: Bearer {accessToken}

# Start exam
POST /api/exam/:id/start
Authorization: Bearer {accessToken}

# Submit task response
POST /api/exam/:id/submit
Authorization: Bearer {accessToken}
{
  "taskNumber": 1,
  "audioUrl": "s3://bucket/audio.wav",
  "transcription": "Student's spoken text..."
}

# Get results
GET /api/exam/:id/results
Authorization: Bearer {accessToken}
```

### Payment Endpoints

```bash
# Create exam payment
POST /api/payment/create-exam-payment
Authorization: Bearer {accessToken}

# Create subscription
POST /api/payment/create-subscription
Authorization: Bearer {accessToken}
{
  "plan": "premium",
  "billingCycle": "monthly"
}

# Stripe webhook (no auth needed)
POST /api/payment/webhook
```

---

## 🤖 Claude Opus Integration

This platform uses **Claude Opus** (recommended best model for this use case) for sophisticated CEFR evaluation.

### Why Claude Opus?

✅ **Best linguistic analysis** of all Claude models  
✅ **Understands CEFR framework deeply** (A1-C2 levels)  
✅ **Complex reasoning** for detailed feedback  
✅ **Multilingual support** (Uzbek, English, others)  
✅ **Cost-effective** for your scale  

### How It Works

1. Student completes exam and audio is recorded
2. Audio is transcribed to text (via speech-to-text service)
3. Transcription sent to Claude Opus with task context
4. Claude evaluates on 5 criteria:
   - **Grammar & Accuracy**
   - **Vocabulary Range & Appropriateness**
   - **Fluency & Coherence**
   - **Pronunciation** (estimated from transcription)
   - **Task Achievement & Communication**
5. Claude returns structured evaluation with:
   - Numeric score (0-100)
   - CEFR level (A1-C2)
   - Detailed feedback
   - Specific strengths and improvements

See `services/AIEvaluationService.js` for implementation details.

---

## 📦 Project Structure

```
cefr-speaking-exam/
├── models/                 # Database schemas
│   ├── User.js            # Student, teacher, admin accounts
│   ├── Exam.js            # Exam templates
│   ├── ExamResult.js      # Student exam attempts & scores
│   └── Payment.js         # Payment transactions
├── services/              # Business logic
│   ├── AuthService.js     # User registration, login, tokens
│   ├── AIEvaluationService.js  # Claude Opus integration
│   └── PaymentService.js  # Stripe integration
├── routes/                # API endpoints
│   ├── auth.js            # Auth routes
│   ├── exam.js            # Exam routes
│   ├── payment.js         # Payment routes
│   ├── user.js            # User profile routes
│   ├── evaluation.js      # Evaluation routes
│   └── admin.js           # Admin routes
├── middleware/            # Express middleware
│   ├── auth.js            # JWT authentication
│   └── errorHandler.js    # Error handling
├── public/               # Frontend assets (if serving from backend)
├── scripts/              # Setup & migration scripts
├── server.js             # Main server file
├── package.json          # Dependencies
├── .env.example          # Environment template
└── README.md             # This file
```

---

## 🧪 Testing

### Manual Testing with cURL

```bash
# Test health
curl http://localhost:5000/api/health

# Register
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","firstName":"Test","lastName":"User","password":"Test123!"}'

# Login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123!"}'
```

### Run Tests

```bash
npm test
```

---

## 🔐 Security Considerations

✅ **Passwords hashed** with bcryptjs (10 salt rounds)  
✅ **JWT tokens** with expiration  
✅ **Rate limiting** on all endpoints (100 requests/15 min)  
✅ **CORS enabled** for specified domains  
✅ **Helmet.js** for HTTP headers security  
✅ **Input validation** with Joi  
✅ **HTTPS required** in production  
✅ **Environment variables** for sensitive data  

### Production Security Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Change `JWT_SECRET` to strong random string
- [ ] Enable HTTPS/SSL certificates
- [ ] Configure MongoDB with authentication
- [ ] Set up rate limiting (consider Redis)
- [ ] Enable email verification
- [ ] Set up 2FA (optional)
- [ ] Configure CORS for your domain only
- [ ] Regular security audits
- [ ] Database backups automated

---

## 🚀 Deployment

### Deployment Options

#### Option 1: Heroku (Easiest)

```bash
# Install Heroku CLI
# Login
heroku login

# Create app
heroku create your-cefr-exam-app

# Add MongoDB Atlas
heroku addons:create mongolab:sandbox

# Set environment variables
heroku config:set CLAUDE_API_KEY=sk-ant-xxxxx
heroku config:set STRIPE_SECRET_KEY=sk_test_xxxxx

# Deploy
git push heroku main
```

#### Option 2: AWS EC2

```bash
# 1. Launch EC2 instance (Ubuntu)
# 2. SSH into instance
# 3. Install Node.js and MongoDB
# 4. Clone repository
# 5. Install dependencies: npm install
# 6. Set environment variables
# 7. Start with PM2: pm2 start server.js
```

#### Option 3: DigitalOcean App Platform

```bash
# 1. Connect GitHub repository
# 2. Create new app
# 3. Set build command: npm install
# 4. Set start command: npm start
# 5. Add environment variables
# 6. Deploy
```

#### Option 4: Docker

```bash
# Build
docker build -t cefr-exam .

# Run
docker run -p 5000:5000 -e MONGODB_URI=mongodb://mongo:27017/cefr-exam cefr-exam
```

See `Dockerfile` in project root.

---

## 📊 Analytics & Monitoring

The platform includes analytics:

- **Student Statistics**: Total exams, average score, best score
- **Exam Statistics**: Times used, average score, average time
- **Payment Tracking**: Revenue, subscriptions, refunds
- **System Health**: Error rates, API response times

Access via Admin Dashboard: `/admin/dashboard`

---

## 🆘 Troubleshooting

### Common Issues

**Problem:** MongoDB connection failed
```
Solution: Check MONGODB_URI in .env
- Local: mongodb://localhost:27017/cefr-exam
- Atlas: mongodb+srv://user:pass@cluster.mongodb.net/db
```

**Problem:** Stripe not working
```
Solution: Verify keys in .env are correct
- Use sk_test_xxx for development
- Use sk_live_xxx for production
```

**Problem:** Claude API errors
```
Solution: Check API key and rate limits
- Get key from console.anthropic.com
- Verify account has credits
- Check rate limiting (5 req/min for free tier)
```

---

## 📞 Support & Updates

- **Documentation:** Check README.md and code comments
- **Issues:** Create issue tickets
- **Email:** support@cefrexam.com
- **Status Page:** https://status.cefrexam.com

---

## 📄 License

MIT License - Feel free to use commercially

---

## 🎓 Next Steps

1. ✅ Install dependencies: `npm install`
2. ✅ Configure `.env` file
3. ✅ Start database (MongoDB)
4. ✅ Start server: `npm run dev`
5. ✅ Build frontend (React/Vue)
6. ✅ Connect frontend to backend API
7. ✅ Test authentication flow
8. ✅ Configure Stripe for payments
9. ✅ Set up email notifications
10. ✅ Deploy to production

---

**Built with ❤️ using Express.js, MongoDB, and Claude AI**
