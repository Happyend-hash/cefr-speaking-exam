# 🚀 CEFR Speaking Exam - Production Deployment Guide

## Overview

This guide covers deploying your CEFR Speaking Exam platform to production so you can start charging customers.

---

## Phase 1: Pre-Deployment Setup (Local)

### 1. Finalize Environment Variables

```bash
# Edit .env for production
NODE_ENV=production
PORT=5000  # Or your production port
FRONTEND_URL=https://yourdomain.com  # Your frontend URL

# Database - Use MongoDB Atlas (highly recommended)
MONGODB_ATLAS_URI=mongodb+srv://user:pass@cluster.mongodb.net/cefr-exam

# Claude API
CLAUDE_API_KEY=sk-ant-xxxxxxxxxxxxx  # Your API key
CLAUDE_MODEL=claude-opus-5-20250805

# Stripe - Use LIVE keys in production!
STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxxx  # LIVE keys, not test!
STRIPE_PUBLIC_KEY=pk_live_xxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx

# Email
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-business@gmail.com
SMTP_PASS=your-app-password

# JWT Security - Use strong random strings!
JWT_SECRET=$(openssl rand -base64 32)
REFRESH_TOKEN_SECRET=$(openssl rand -base64 32)

# Admin
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=SuperSecurePassword123!
```

### 2. Security Checklist

- [ ] All API keys are production keys (not test keys)
- [ ] JWT_SECRET is a strong random string (32+ characters)
- [ ] Database uses authentication
- [ ] HTTPS is enforced
- [ ] CORS is set to your domain only
- [ ] Email verification is enabled
- [ ] All sensitive data is in .env (not committed to git)

### 3. Database Setup (MongoDB Atlas - Recommended)

1. Go to https://mongodb.com/cloud/atlas
2. Create account and cluster
3. Set up IP whitelist for your server
4. Create database user
5. Get connection string
6. Update `MONGODB_ATLAS_URI` in production .env

---

## Phase 2: Deployment Options

### Option A: Heroku (Easiest for Beginners)

**Advantages:** Easy setup, automatic scaling, built-in monitoring  
**Cost:** Free tier or ~$7/month  
**Time:** 15 minutes

```bash
# 1. Install Heroku CLI
# macOS: brew install heroku
# Windows: Download from https://devcenter.heroku.com/articles/heroku-cli

# 2. Login
heroku login

# 3. Create app
heroku create your-cefr-exam-app

# 4. Add MongoDB Atlas addon (optional)
heroku addons:create mongolab

# 5. Set environment variables
heroku config:set NODE_ENV=production
heroku config:set CLAUDE_API_KEY=sk-ant-xxxxx
heroku config:set STRIPE_SECRET_KEY=sk_live_xxxxx
# ... set all variables from your .env

# 6. Deploy
git push heroku main

# 7. Check logs
heroku logs --tail

# 8. Your app is now at: https://your-cefr-exam-app.herokuapp.com
```

### Option B: AWS EC2 (More Control, Scalable)

**Advantages:** Full control, scalable, enterprise-grade  
**Cost:** ~$10-50/month  
**Time:** 1-2 hours

```bash
# 1. Create EC2 instance
# - Launch Ubuntu 22.04 LTS t2.micro (free tier eligible)
# - Configure security group (open ports 80, 443, 5000)
# - Create and save key pair

# 2. SSH into instance
ssh -i your-key.pem ubuntu@your-ec2-public-ip

# 3. Update system
sudo apt update && sudo apt upgrade -y

# 4. Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 5. Install MongoDB (optional, use Atlas instead)
# Or use MongoDB Atlas cloud database

# 6. Clone repository
git clone https://github.com/your-repo/cefr-exam.git
cd cefr-exam

# 7. Install dependencies
npm install --production

# 8. Create .env file with production values
nano .env

# 9. Install PM2 (process manager)
sudo npm install -g pm2

# 10. Start application
pm2 start server.js --name "cefr-exam"
pm2 save
pm2 startup

# 11. Install Nginx (reverse proxy)
sudo apt install -y nginx

# 12. Configure Nginx to point to your app (port 5000)
# Edit: sudo nano /etc/nginx/sites-available/default

# 13. Install SSL certificate (Let's Encrypt)
sudo apt install -y certbot python3-certbot-nginx
sudo certbot certonly --nginx -d yourdomain.com

# 14. Restart Nginx
sudo systemctl restart nginx

# Your app is now live at: https://yourdomain.com
```

### Option C: DigitalOcean App Platform (Balanced)

**Advantages:** Easy, GitHub integration, affordable  
**Cost:** ~$12/month  
**Time:** 30 minutes

```bash
# 1. Go to https://digitalocean.com/app-platform
# 2. Connect GitHub account
# 3. Select your repository
# 4. Set build command: npm install
# 5. Set start command: npm start
# 6. Add environment variables from .env
# 7. Deploy
# 8. Your app is live!
```

### Option D: Docker (Maximum Flexibility)

**Advantages:** Can run anywhere, consistent environment  
**Cost:** Depends on hosting (AWS ECS, Google Cloud Run, etc)  
**Time:** 1 hour

```bash
# 1. Build Docker image
docker build -t cefr-exam:latest .

# 2. Run locally to test
docker run -p 5000:5000 \
  -e MONGODB_URI=mongodb://mongo:27017/cefr-exam \
  -e CLAUDE_API_KEY=sk-ant-xxxxx \
  cefr-exam:latest

# 3. Push to Docker Hub or AWS ECR
docker tag cefr-exam:latest yourusername/cefr-exam:latest
docker push yourusername/cefr-exam:latest

# 4. Deploy on cloud service
# - AWS ECS
# - Google Cloud Run
# - Azure Container Instances
# - Heroku Container Registry
```

---

## Phase 3: Post-Deployment

### 1. Set Up Domain

```bash
# Buy domain from:
# - GoDaddy
# - Namecheap
# - CloudFlare

# Point domain to your app:
# - If using Heroku: Create CNAME record
# - If using AWS: Point to your EC2 Elastic IP
# - If using DigitalOcean: Point to assigned IP
```

### 2. Set Up SSL Certificate

```bash
# Most platforms provide free SSL:
# - Heroku: Automatic
# - AWS EC2 + Nginx: Use Let's Encrypt (see above)
# - DigitalOcean: Automatic
# - Docker: Configure based on hosting

# Verify SSL:
curl -I https://yourdomain.com/api/health
# Should show: HTTP/2 200
```

### 3. Configure Stripe Webhooks

1. Go to Stripe Dashboard
2. Navigate to Webhooks
3. Add endpoint: `https://yourdomain.com/api/payment/webhook`
4. Select events: `payment_intent.succeeded`, `customer.subscription.created`
5. Add webhook signing secret to `.env`

### 4. Set Up Email Service

Option A: Gmail (Free)
```bash
# 1. Enable 2FA on Gmail
# 2. Create app password
# 3. Use app password in SMTP_PASS
```

Option B: SendGrid (Better for production)
```bash
# 1. Create SendGrid account
# 2. Get API key
# 3. Update SMTP settings
```

### 5. Database Backups

```bash
# MongoDB Atlas automatic backups (every 6 hours)
# Or schedule manual backups:
mongodump --uri "mongodb+srv://user:pass@cluster.mongodb.net/db" \
  --out ./backups/$(date +%Y%m%d_%H%M%S)
```

### 6. Monitoring & Logging

Set up monitoring to track:
- Uptime
- Error rates
- Response times
- Database performance
- Payment transactions

Services:
- **Uptime:** Pingdom, StatusPage.io
- **Logging:** LogRocket, Datadog, New Relic
- **Errors:** Sentry, Rollbar
- **APM:** New Relic, Datadog

---

## Phase 4: Launch Your Service

### Marketing

1. **Website:** Create landing page explaining the service
2. **Pricing:** Show your pricing tiers clearly
3. **SEO:** Optimize for "CEFR exam" keywords
4. **Social Media:** Share on LinkedIn, Twitter, Facebook
5. **Email:** Build email list for launches

### Payment Setup

```bash
# 1. Set pricing in PaymentService.js
# Example: $15 per exam, $29.99/month subscription

# 2. Test payments with Stripe test keys first
# Use test card: 4242 4242 4242 4242

# 3. Switch to live keys after testing

# 4. Monitor for failed payments
# Set up alerts in Stripe dashboard
```

### Student Onboarding

1. Registration flow
2. Email verification
3. Payment setup (free plan or premium)
4. First exam walkthrough
5. Certificate upon passing

---

## Phase 5: Ongoing Operations

### Weekly

- [ ] Check server status
- [ ] Review error logs
- [ ] Monitor payment transactions
- [ ] Check student feedback

### Monthly

- [ ] Database backup verification
- [ ] Security updates
- [ ] Performance optimization
- [ ] User analytics review

### Quarterly

- [ ] Security audit
- [ ] Feature releases
- [ ] Pricing review
- [ ] Customer support metrics

---

## Troubleshooting Production Issues

### Issue: Server Down

```bash
# Check server status
curl https://yourdomain.com/api/health

# Check logs
heroku logs --tail  # If Heroku
# Or SSH into EC2 and check pm2 logs
pm2 logs

# Restart
pm2 restart server.js
```

### Issue: Database Connection Error

```bash
# Check connection string in .env
# Verify database is running
# Check IP whitelist in MongoDB Atlas
# Test connection manually
node -e "require('mongoose').connect(process.env.MONGODB_ATLAS_URI)"
```

### Issue: Stripe Payment Not Working

```bash
# Verify API keys are correct (use sk_live_ in production)
# Check webhook secret
# Review Stripe logs for errors
# Test with Stripe test cards: 4242 4242 4242 4242
```

---

## Cost Estimation

| Service | Dev | Production |
|---------|-----|------------|
| Server | Free/Local | $10-50/month |
| Database | Free (Atlas) | Free-50/month |
| Claude API | Pay-as-you-go | Pay-as-you-go |
| Stripe | Free | 2.9% + $0.30/transaction |
| Email | Free (10/day limit) | $10-20/month |
| CDN/SSL | - | Free-50/month |
| **Total** | ~$0 | ~$50-150/month |

---

## Scaling for Growth

As you grow, consider:

1. **Database Sharding** - Split data across servers
2. **Caching** - Redis for faster responses
3. **Load Balancing** - Multiple server instances
4. **CDN** - CloudFlare for static assets
5. **Auto-scaling** - AWS Auto Scaling Groups

---

## Success! 🎉

Your CEFR Speaking Exam platform is now live and ready to accept paying customers!

**Next Steps:**
1. Market your service
2. Collect student feedback
3. Iterate on exam content
4. Monitor revenue
5. Plan feature expansion

---

**Questions? Check README.md or contact support!**
