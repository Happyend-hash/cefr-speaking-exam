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
  tasks: [
    // ---- Part 1.1 — short factual answers about yourself ----
    {
      part: '1.1',
      type: 'personal_question',
      instructions: 'Answer briefly. You have 30 seconds for each question.',
      question: 'Where are you from, and how long have you lived there?',
      timeLimit: 30,
      scoringCriteria: ['Clear factual answer', 'Basic accuracy', 'Audible delivery']
    },
    {
      part: '1.1',
      type: 'personal_question',
      instructions: 'Answer briefly. You have 30 seconds.',
      question: 'What do you do — do you work or study? Tell me a little about it.',
      timeLimit: 30,
      scoringCriteria: ['Relevant detail', 'Present simple accuracy', 'Everyday vocabulary']
    },
    {
      part: '1.1',
      type: 'personal_question',
      instructions: 'Answer briefly. You have 30 seconds.',
      question: 'How do you usually travel around your city, and why?',
      timeLimit: 30,
      scoringCriteria: ['Reason given', 'Connectors (because, so)', 'Fluency at short length']
    },

    // ---- Part 1.2 — longer turn on a familiar topic ----
    {
      part: '1.2',
      type: 'extended_answer',
      instructions:
        'You have 1 minute to prepare and 2 minutes to speak. Cover all the points below.',
      question:
        'Describe a place in your country that you would recommend to a visitor. Say where it is, what people can do there, why you would recommend it, and when the best time to go is.',
      timeLimit: 120,
      scoringCriteria: [
        'Covers every prompt point',
        'Sustains a two-minute turn',
        'Descriptive vocabulary',
        'Organisation and linking'
      ]
    },
    {
      part: '1.2',
      type: 'extended_answer',
      instructions: 'You have 1 minute to prepare and 2 minutes to speak.',
      question:
        'Describe a skill you have learned outside school or university. Say what it is, how you learned it, how difficult it was, and how you use it now.',
      timeLimit: 120,
      scoringCriteria: [
        'Past narrative control',
        'Sequencing across the answer',
        'Range of structures',
        'Sustained fluency'
      ]
    },

    // ---- Part 2 — compare and contrast two pictures ----
    {
      part: '2',
      type: 'picture_comparison',
      instructions:
        'Compare the two situations. Say how they are similar, how they differ, and which you would prefer. You have 2 minutes.',
      question:
        'Compare these two ways of studying: studying alone at home, and studying in a group at a library or learning centre. What are the advantages of each, and which would suit you better?',
      timeLimit: 120,
      images: [],
      scoringCriteria: [
        'Comparison and contrast language',
        'Balanced treatment of both options',
        'Justified preference',
        'Precision of vocabulary'
      ]
    },
    {
      part: '2',
      type: 'picture_comparison',
      instructions: 'Compare the two situations and give your view. You have 2 minutes.',
      question:
        'Compare shopping in a local bazaar with shopping in a large supermarket. Describe what each experience is like, and explain which you think most families in your country prefer, and why.',
      timeLimit: 120,
      images: [],
      scoringCriteria: [
        'Descriptive detail',
        'Comparative structures',
        'Speculation about others',
        'Coherent organisation'
      ]
    },

    // ---- Part 3 — opinion, with examiner follow-ups ----
    {
      part: '3',
      type: 'opinion',
      instructions:
        'Give your opinion and support it with reasons and examples. Be ready for follow-up questions. You have 2 minutes.',
      question:
        'Some people think young people should be required to spend a year working or volunteering before starting university. Do you agree?',
      followUpQuestions: [
        'What might someone gain from that year that university cannot teach?',
        'Who would find such a requirement most difficult?',
        'Should it be compulsory, or a personal choice?'
      ],
      timeLimit: 120,
      scoringCriteria: [
        'Clear position with support',
        'Responds to follow-ups',
        'Abstract and hypothetical language',
        'Fluency under pressure'
      ]
    },
    {
      part: '3',
      type: 'opinion',
      instructions: 'Give your opinion with reasons and examples. You have 2 minutes.',
      question:
        'In many countries people are moving from villages to large cities. Is this change good or bad for a society overall?',
      followUpQuestions: [
        'What is lost when a village empties?',
        'What could persuade young people to stay?',
        'Will this trend continue in your country?'
      ],
      timeLimit: 120,
      scoringCriteria: [
        'Weighing competing effects',
        'Cause and consequence language',
        'Extended reasoning',
        'Range and accuracy'
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
    const tasks = spec.tasks.map((task, index) => ({ taskNumber: index + 1, ...task }));

    const existing = await Exam.findOne({ title: spec.title });
    const target = existing || new Exam({ createdBy: author._id });

    target.title = spec.title;
    target.module = spec.module;
    target.description = spec.description;
    target.tasks = tasks;
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
    console.log(`  ${existing ? 'updated' : 'created'}  ${spec.title}  (${tasks.length} questions, ~${minutes} min)`);
    for (const task of tasks) {
      console.log(`      Part ${task.part}  ${task.question.split('\n')[0].slice(0, 58)}…`);
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
