/**
 * Seed the starter question bank.
 *
 * Structured to the O'zbekiston Multilevel format: one Speaking test with Parts
 * 1.1, 1.2, 2 and 3, and one Writing test with Task 1 and Task 2. Unlike a
 * per-level CEFR test, a Multilevel sitting is not tied to a level — it
 * determines one.
 *
 * Every question here is original, written to the format. They are a starting
 * point, not a fixed syllabus: add, edit and delete them in the Manage Questions
 * page (/admin.html) rather than by editing this file.
 *
 *   npm run seed
 *
 * Idempotent — re-running updates the seeded tests in place and leaves anything
 * you created yourself untouched. It will overwrite edits to the seeded tests,
 * so rename a test if you want it protected from a future re-seed.
 *
 * IMPORTANT: verify timings and question counts against the official Multilevel
 * specification before using this with students. The structure here follows the
 * published format, but exact allowances should come from the official source.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Exam from '../models/Exam.js';
import User from '../models/User.js';

dotenv.config();

const SYSTEM_EMAIL = process.env.SEED_ADMIN_EMAIL || 'system@cefr-exam.com';

const SPEAKING_TEST = {
  title: 'Multilevel Speaking — Test 1',
  module: 'speaking',
  description:
    'Full speaking test in the Multilevel format: Parts 1.1, 1.2, 2 and 3. Your level is determined from your performance.',
  sections: [
    {
      part: '1.1',
      instructions: 'Answer each question briefly. You have 5 seconds to think and 30 seconds to answer.',
      questions: [
        { text: 'Where are you from, and how long have you lived there?', prepTime: 5, answerTime: 30 },
        { text: 'Do you work or study? Tell me a little about it.', prepTime: 5, answerTime: 30 },
        { text: 'How do you usually travel around your city, and why?', prepTime: 5, answerTime: 30 }
      ]
    },
    {
      part: '1.2',
      instructions: 'Look at the two pictures and answer the questions about them.',
      // Upload the real picture pair in Manage Questions — the wording below works
      // meanwhile, but Part 1.2 is designed around two images that differ.
      images: [],
      questions: [
        {
          text: 'Describe the two pictures. What can you see in each one, and how are they different?',
          prepTime: 10,
          answerTime: 45
        },
        { text: 'Which of these two situations is more common in your country? Why?', prepTime: 5, answerTime: 30 },
        { text: 'Which one would you prefer for yourself, and why?', prepTime: 5, answerTime: 30 }
      ]
    },
    {
      part: '2',
      instructions: 'You have 1 minute to think and 2 minutes to answer each question.',
      topic: 'Learning a new skill outside school or university.',
      questions: [
        {
          text: 'Describe a skill you have learned outside school or university. Say what it is, how you learned it, how difficult it was, and how you use it now.',
          prepTime: 60,
          answerTime: 120
        },
        { text: 'Why do you think some people find it hard to keep learning after they finish their studies?', prepTime: 60, answerTime: 120 },
        { text: 'How could schools better prepare students to go on learning by themselves?', prepTime: 60, answerTime: 120 }
      ]
    },
    {
      part: '3',
      instructions: 'You have 1 minute to think and 2 minutes to answer. Use the points below if they help.',
      topic: 'Some people believe young people should spend a year working or volunteering before starting university. Do you agree?',
      pros: [
        'Students gain real work experience and practical skills',
        'A year away helps them choose their subject more wisely',
        'Earning money first reduces the financial pressure of study'
      ],
      cons: [
        'It delays graduation and entering a career',
        'Some students lose academic habits and never return',
        'Families who need income cannot afford an unpaid year'
      ],
      questions: [
        {
          text: 'Do you agree that young people should work or volunteer for a year before starting university? Give reasons for your opinion.',
          prepTime: 60,
          answerTime: 120
        }
      ]
    }
  ]
};

const WRITING_TEST = {
  title: 'Multilevel Writing — Test 1',
  module: 'writing',
  description:
    'Full writing test in the Multilevel format: Task 1 describes visual information, Task 2 is an opinion essay.',
  tasks: [
    {
      part: 'Task 1',
      type: 'writing_task1',
      instructions:
        'Describe the information below. Report the main features and make comparisons where relevant. Write at least 150 words. You have about 20 minutes.',
      question:
        'The table shows how students at one university in Tashkent travel to campus, in 2015 and 2025.\n\n' +
        'Method            2015     2025\n' +
        'Bus / metro        46%      38%\n' +
        'Private car        18%      27%\n' +
        'Walking            24%      16%\n' +
        'Bicycle / scooter   4%      14%\n' +
        'Taxi / ride-share   8%       5%\n\n' +
        'Summarise the main changes and compare the figures. Do not give your opinion.',
      timeLimit: 1200,
      minWords: 150,
      scoringCriteria: [
        'Task achievement — reports key features accurately',
        'Makes relevant comparisons',
        'Organisation and paragraphing',
        'Range and accuracy of language',
        'No unsupported opinion'
      ]
    },
    {
      part: 'Task 2',
      type: 'writing_task2',
      instructions:
        'Write an essay giving your opinion. Support it with reasons and examples from your knowledge or experience. Write at least 250 words. You have about 40 minutes.',
      question:
        'Some people believe that school students should be taught practical life skills — managing money, cooking, basic repairs — instead of some traditional academic subjects. Others argue academic subjects matter more for a student\'s future.\n\nDiscuss both views and give your own opinion.',
      timeLimit: 2400,
      minWords: 250,
      scoringCriteria: [
        'Addresses both views and states a clear position',
        'Develops ideas with reasons and examples',
        'Coherence, cohesion and paragraphing',
        'Lexical range and precision',
        'Grammatical range and accuracy'
      ]
    }
  ]
};

const TESTS = [SPEAKING_TEST, WRITING_TEST];

async function seed() {
  if (!process.env.MONGODB_URI) {
    console.error('✗ MONGODB_URI is not set. Add it to your .env file.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✓ Connected to MongoDB');

  // Tests need an author. Reuse an existing admin before inventing one.
  let author = (await User.findOne({ role: 'admin' })) || (await User.findOne({ email: SYSTEM_EMAIL }));
  if (!author) {
    author = await User.create({
      email: SYSTEM_EMAIL,
      firstName: 'System',
      lastName: 'Seeder',
      password: `seed-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      role: 'admin',
      status: 'active',
      isEmailVerified: true
    });
    console.log(`✓ Created system author ${SYSTEM_EMAIL}`);
  }

  // Retire the old per-level CEFR tests, which do not match the Multilevel
  // format. Unpublished rather than deleted so existing attempts keep working.
  const retired = await Exam.updateMany(
    { title: /^CEFR Speaking [A-C][12]$/, isPublished: true },
    { $set: { isPublished: false, isActive: false } }
  );
  if (retired.modifiedCount) {
    console.log(`✓ Retired ${retired.modifiedCount} old per-level test(s) — hidden from students, attempts preserved`);
  }

  let created = 0;
  let updated = 0;

  for (const spec of TESTS) {
    const existing = await Exam.findOne({ title: spec.title });
    const target = existing || new Exam({ createdBy: author._id });

    target.title = spec.title;
    target.module = spec.module;
    target.description = spec.description;

    if (spec.sections) {
      target.sections = spec.sections;
      target.tasks = [];
    } else {
      target.tasks = spec.tasks.map((task, index) => ({ taskNumber: index + 1, ...task }));
      target.sections = [];
    }
    target.isActive = true;
    target.isPublished = true;
    target.publishedAt = target.publishedAt || new Date();
    target.updatedBy = author._id;
    target.tags = ['multilevel', spec.module];
    target.category = spec.module;
    target.calculateDuration();

    await target.save();
    existing ? updated++ : created++;

    const minutes = Math.round(target.duration / 60);
    const count = target.totalTasks;
    console.log(`  ${existing ? 'updated' : 'created'}  ${spec.title}  (${count} questions, ~${minutes} min)`);

    for (const section of spec.sections || []) {
      console.log(`      Part ${section.part} — ${section.questions.length} question(s)`);
      for (const q of section.questions) {
        console.log(`          ${q.prepTime}s/${q.answerTime}s  ${q.text.slice(0, 52)}…`);
      }
    }
    for (const task of target.tasks) {
      console.log(`      ${task.part}  ${task.question.split('\n')[0].slice(0, 52)}…`);
    }
  }

  console.log(`\n✓ Seed complete — ${created} created, ${updated} updated`);
  console.log('  Edit these at /admin.html (sign in with an admin account).');
  await mongoose.disconnect();
}

seed().catch(async error => {
  console.error('✗ Seed failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
