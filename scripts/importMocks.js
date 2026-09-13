/**
 * Import the mock speaking tests from content/mocks.json.
 *
 *   npm run import-mocks
 *
 * Reads the question bank and its pictures out of content/, uploads each image
 * to GridFS, and creates one published test per mock. Idempotent: a mock that
 * already exists is updated in place and its old images are replaced, so running
 * it twice does not duplicate anything or leak storage.
 *
 * Adding more mocks later means adding to content/mocks.json and its images,
 * then running this again — or using the Manage Questions page for one-offs.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Exam from '../models/Exam.js';
import User from '../models/User.js';
import ImageStorageService from '../services/ImageStorageService.js';

dotenv.config();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(root, 'content');
const IMAGES = path.join(CONTENT, 'mocks');

const SYSTEM_EMAIL = process.env.SEED_ADMIN_EMAIL || 'system@cefr-exam.com';

/** Upload one picture and return its served URL, reusing nothing — callers clean up. */
async function uploadImage(filename, uploadedBy) {
  const filePath = path.join(IMAGES, filename);
  if (!fs.existsSync(filePath)) {
    console.warn(`    ! missing image ${filename} — skipped`);
    return null;
  }
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const stored = await ImageStorageService.store(buffer, { filename, contentType, uploadedBy });
  return stored.url;
}

/** Pull the GridFS key out of a stored image URL, for cleanup on re-import. */
const keyFromUrl = url => (url || '').split('/').pop();

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('✗ MONGODB_URI is not set.');
    process.exit(1);
  }

  const manifestPath = path.join(CONTENT, 'mocks.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`✗ ${manifestPath} not found.`);
    process.exit(1);
  }

  const mocks = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`✓ Connected — importing ${mocks.length} mock(s)\n`);

  let author = (await User.findOne({ role: 'admin' })) || (await User.findOne({ email: SYSTEM_EMAIL }));
  if (!author) {
    author = await User.create({
      email: SYSTEM_EMAIL,
      firstName: 'System',
      lastName: 'Importer',
      password: `import-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      role: 'admin',
      status: 'active',
      isEmailVerified: true
    });
    console.log(`✓ Created system author ${SYSTEM_EMAIL}`);
  }

  let created = 0;
  let updated = 0;
  let uploaded = 0;

  for (const mock of mocks) {
    const existing = await Exam.findOne({ title: mock.title });
    const exam = existing || new Exam({ createdBy: author._id });

    // Re-importing replaces the pictures, so delete the previous ones first —
    // otherwise every run would orphan another copy in GridFS.
    if (existing) {
      for (const section of existing.sections || []) {
        for (const url of section.images || []) {
          await ImageStorageService.delete(keyFromUrl(url));
        }
      }
    }

    const sections = [];
    for (const spec of mock.sections) {
      const images = [];
      for (const file of spec.imageFiles || []) {
        const url = await uploadImage(file, author._id);
        if (url) { images.push(url); uploaded++; }
      }
      sections.push({
        part: spec.part,
        instructions: spec.instructions,
        topic: spec.topic,
        pros: spec.pros || [],
        cons: spec.cons || [],
        images,
        questions: spec.questions
      });
    }

    exam.title = mock.title;
    exam.module = 'speaking';
    exam.description = mock.description ||
      'Full Multilevel speaking test: Parts 1.1, 1.2, 2 and 3.';
    exam.sections = sections;
    exam.tasks = [];
    exam.isActive = true;
    exam.isPublished = true;
    exam.publishedAt = exam.publishedAt || new Date();
    exam.updatedBy = author._id;
    exam.tags = ['multilevel', 'speaking', 'mock'];
    exam.category = 'speaking';
    exam.calculateDuration();

    await exam.save();
    existing ? updated++ : created++;

    const q = exam.totalTasks;
    const imgs = sections.reduce((n, s) => n + s.images.length, 0);
    console.log(`  ${existing ? 'updated' : 'created'}  ${mock.title.padEnd(20)} ${q} questions, ${imgs} image(s), ~${Math.round(exam.duration / 60)} min`);
  }

  console.log(`\n✓ Import complete — ${created} created, ${updated} updated, ${uploaded} images uploaded`);
  console.log('  Edit any of them at /admin.html');
  await mongoose.disconnect();
}

run().catch(async error => {
  console.error('✗ Import failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
