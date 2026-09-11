# 🚀 CEFR Speaking Exam - 15-Minute Quick Start

## Step 1: Get Your API Keys (5 minutes)

### Claude API Key
1. Go to https://console.anthropic.com
2. Sign up/login
3. Create API key
4. Copy it (you'll need it soon)

### Stripe Keys
1. Go to https://stripe.com
2. Create free account
3. Go to Dashboard → API Keys
4. Copy "Secret Key" (starts with `sk_test_`)

### Optional: MongoDB Atlas (Cloud Database)
1. Go to https://mongodb.com/cloud/atlas
2. Create free account
3. Create a cluster (M0 free tier)
4. Get connection string
5. Copy it

## Step 2: Set Up Project (5 minutes)

```bash
# Navigate to project
cd Documents/cefr-speaking-exam

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env file (open with notepad or VS Code)
# Add your keys:
# CLAUDE_API_KEY=sk-ant-xxxxxxxxxxxxx
# STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxxx
# MONGODB_URI=your_connection_string
```

## Step 3: Start Server (5 minutes)

```bash
# Start development server
npm run dev

# You should see:
# ╔════════════════════════════════════════════╗
# ║   CEFR Speaking Exam Platform             ║
# ║   Server running on port 5000              ║
# ║   Environment: development                 ║
# ╚════════════════════════════════════════════╝
```

## Step 4: Test It Works

Open another terminal:

```bash
# Test server health
curl http://localhost:5000/api/health

# Should respond with:
# {"status":"OK","timestamp":"2026-09-11T...","version":"1.0.0"}

# Test registration
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email":"test@example.com",
    "firstName":"John",
    "lastName":"Doe",
    "password":"Test123!"
  }'
```

## ✅ Done!

Your backend is now running! 

### Next: Build Frontend

You need to create a React/Vue frontend that connects to these API endpoints. The frontend should:

1. Handle authentication (login/register)
2. Display exam interface  
3. Record audio
4. Send to backend for evaluation
5. Display results

### Frontend Skeleton (React Example)

```javascript
// Login
const response = await fetch('http://localhost:5000/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    email: 'test@example.com',
    password: 'Test123!'
  })
});
const data = await response.json();
const token = data.data.accessToken; // Save this!

// Get exams (with token)
const examResponse = await fetch('http://localhost:5000/api/exam', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

// Use audio API to record...
// Then submit...
```

## 📚 Learn More

- Full documentation: See `README.md`
- API endpoints: See `routes/` folder  
- Database models: See `models/` folder
- Services: See `services/` folder

## 🐛 Troubleshooting

**Port already in use?**
```bash
# Change PORT in .env file or use different port
npm run dev -- --port 5001
```

**MongoDB connection error?**
```bash
# Make sure MongoDB is running
# Or update MONGODB_URI to use MongoDB Atlas (cloud)
```

**Stripe error?**
```bash
# Make sure STRIPE_SECRET_KEY starts with sk_test_ (not sk_live_)
# For production, use sk_live_xxxxx keys
```

---

**That's it! You have a production-ready CEFR exam backend! 🎉**
