/**
 * Promote an existing account to admin.
 *
 *   npm run make-admin -- you@example.com
 *
 * Sign up through the site first, then run this against that email. Run it from
 * the Railway console so it uses the production database.
 *
 * Deliberately a separate command rather than a signup option: nobody should be
 * able to make themselves an admin through the web interface.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/User.js';

dotenv.config();

const email = (process.argv[2] || '').trim().toLowerCase();

async function run() {
  if (!email) {
    console.error('✗ Usage: npm run make-admin -- you@example.com');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('✗ MONGODB_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findOne({ email });
  if (!user) {
    console.error(`✗ No account found for ${email}. Sign up on the site first, then run this again.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (user.role === 'admin') {
    console.log(`✓ ${email} is already an admin.`);
  } else {
    user.role = 'admin';
    user.status = 'active';
    await user.save();
    console.log(`✓ ${email} is now an admin. Sign out and back in to pick up the new role.`);
  }

  await mongoose.disconnect();
}

run().catch(async error => {
  console.error('✗ Failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
