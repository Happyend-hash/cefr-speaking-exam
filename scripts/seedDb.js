/**
 * Seed the database with the six CEFR speaking exams.
 *
 * Idempotent: running it repeatedly updates the existing exams in place rather
 * than creating duplicates. Safe to run against production.
 *
 *   npm run seed
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Exam from '../models/Exam.js';
import User from '../models/User.js';

dotenv.config();

const SYSTEM_EMAIL = process.env.SEED_ADMIN_EMAIL || 'system@cefr-exam.local';

const EXAMS = [
  {
    level: 'A1',
    description:
      'Basic everyday exchanges. You introduce yourself and talk about familiar things in simple phrases.',
    tasks: [
      {
        type: 'personal_question',
        question:
          'Introduce yourself. Say your name, where you are from, and how old you are.',
        timeLimit: 60,
        scoringCriteria: ['Basic personal information', 'Simple present tense', 'Clear pronunciation of familiar words']
      },
      {
        type: 'personal_question',
        question: 'Describe your family. Who do you live with? What do they do?',
        timeLimit: 90,
        scoringCriteria: ['Family vocabulary', 'Simple connectors (and, but)', 'Present simple']
      },
      {
        type: 'personal_question',
        question: 'What do you do every day? Describe your daily routine from morning to evening.',
        timeLimit: 90,
        scoringCriteria: ['Time expressions', 'Sequencing (then, after that)', 'Common verbs']
      }
    ]
  },
  {
    level: 'A2',
    description:
      'Simple, direct exchanges on routine matters. You describe experiences and give short reasons.',
    tasks: [
      {
        type: 'personal_question',
        question: 'Describe your hometown. What do you like about it, and what would you change?',
        timeLimit: 90,
        scoringCriteria: ['Descriptive adjectives', 'Expressing preference', 'Simple reasons (because)']
      },
      {
        type: 'storytelling',
        question: 'Tell me about your last holiday or a trip you took. Where did you go and what did you do?',
        timeLimit: 120,
        scoringCriteria: ['Past simple', 'Chronological narrative', 'Travel vocabulary']
      },
      {
        type: 'discussion',
        question: 'What are your plans for the next year? Talk about something you want to learn or achieve.',
        timeLimit: 90,
        scoringCriteria: ['Future forms (going to, will)', 'Expressing intention', 'Basic justification']
      }
    ]
  },
  {
    level: 'B1',
    description:
      'Connected speech on familiar topics. You explain opinions, narrate events, and handle most travel situations.',
    tasks: [
      {
        type: 'discussion',
        question:
          'Some people prefer working from home, others prefer an office. Which do you prefer, and why?',
        timeLimit: 120,
        scoringCriteria: ['Opinion language', 'Comparison', 'Supporting arguments with examples']
      },
      {
        type: 'storytelling',
        question:
          'Describe a time when you had to solve a difficult problem. What happened, and how did you handle it?',
        timeLimit: 150,
        scoringCriteria: ['Past narrative tenses', 'Cause and effect', 'Reflection on outcome']
      },
      {
        type: 'interview',
        question: 'Talk about a skill you would like to develop and why it matters to you.',
        followUpQuestions: [
          'What is stopping you from learning it right now?',
          'How would your life change if you mastered it?'
        ],
        timeLimit: 150,
        scoringCriteria: ['Sustained turn', 'Hypothetical language', 'Responding to follow-ups']
      }
    ]
  },
  {
    level: 'B2',
    description:
      'Clear, detailed speech on a wide range of subjects. You argue a viewpoint and weigh advantages against disadvantages.',
    tasks: [
      {
        type: 'discussion',
        question:
          'Should social media platforms be responsible for the content their users post? Argue your position.',
        timeLimit: 150,
        scoringCriteria: ['Structured argument', 'Concession and rebuttal', 'Precise vocabulary']
      },
      {
        type: 'discussion',
        question:
          'What are the advantages and disadvantages of remote education compared with classroom teaching?',
        timeLimit: 150,
        scoringCriteria: ['Balanced analysis', 'Discourse markers', 'Range of structures']
      },
      {
        type: 'interview',
        question:
          'Describe a significant change in your country over the last decade and its effects on daily life.',
        followUpQuestions: [
          'Who benefited most from this change, and who lost out?',
          'Do you expect the trend to continue?'
        ],
        timeLimit: 180,
        scoringCriteria: ['Abstract discussion', 'Speculation', 'Coherent extended turn']
      }
    ]
  },
  {
    level: 'C1',
    description:
      'Fluent, spontaneous speech for social, academic and professional purposes, with flexible and effective language use.',
    tasks: [
      {
        type: 'discussion',
        question:
          'To what extent should governments regulate artificial intelligence? Develop a reasoned position.',
        timeLimit: 180,
        scoringCriteria: ['Nuanced argumentation', 'Hedging and qualification', 'Idiomatic control']
      },
      {
        type: 'discussion',
        question:
          'Some argue economic growth is incompatible with environmental protection. How far do you agree?',
        timeLimit: 180,
        scoringCriteria: ['Evaluating competing claims', 'Abstract reasoning', 'Cohesive devices']
      },
      {
        type: 'interview',
        question:
          'Discuss a piece of work — a book, film, or project — that changed how you think about something.',
        followUpQuestions: [
          'What specifically made it persuasive?',
          'Has your view of it shifted since?',
          'Would you recommend it to someone who disagrees with its premise?'
        ],
        timeLimit: 210,
        scoringCriteria: ['Critical analysis', 'Spontaneous elaboration', 'Register control']
      }
    ]
  },
  {
    level: 'C2',
    description:
      'Effortless, precise expression with fine shades of meaning, even in complex or unfamiliar situations.',
    tasks: [
      {
        type: 'discussion',
        question:
          'Is objectivity achievable in journalism, or is every account inevitably shaped by perspective?',
        timeLimit: 210,
        scoringCriteria: ['Conceptual precision', 'Sophisticated structures', 'Effortless fluency']
      },
      {
        type: 'discussion',
        question:
          'Argue for a position you personally disagree with, as convincingly as you can.',
        timeLimit: 210,
        scoringCriteria: ['Rhetorical control', 'Anticipating counterarguments', 'Stylistic range']
      },
      {
        type: 'interview',
        question:
          'Assess the claim that technological progress has outpaced our ethical frameworks.',
        followUpQuestions: [
          'Which domain illustrates that gap most sharply?',
          'What would closing it actually require?',
          'Is the premise itself sound?'
        ],
        timeLimit: 240,
        scoringCriteria: ['Abstract synthesis', 'Precision under pressure', 'Subtlety of meaning']
      }
    ]
  }
];

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('✗ MONGODB_URI is not set. Add it to your .env file.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('✓ Connected to MongoDB');

  // Exams need a creator. Reuse any existing admin before inventing one.
  let author = await User.findOne({ role: 'admin' });
  if (!author) {
    author = await User.findOne({ email: SYSTEM_EMAIL });
  }
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
    console.log(`✓ Created system author ${SYSTEM_EMAIL} (random password — sign in via a real admin account)`);
  }

  let created = 0;
  let updated = 0;

  for (const spec of EXAMS) {
    const title = `CEFR Speaking ${spec.level}`;
    const tasks = spec.tasks.map((task, index) => ({ taskNumber: index + 1, ...task }));

    const existing = await Exam.findOne({ level: spec.level });
    const target = existing || new Exam({ createdBy: author._id });

    target.title = title;
    target.level = spec.level;
    target.description = spec.description;
    target.tasks = tasks;
    target.isActive = true;
    target.isPublished = true;
    target.publishedAt = target.publishedAt || new Date();
    target.updatedBy = author._id;
    target.tags = ['speaking', spec.level.toLowerCase()];
    target.category = 'speaking';
    target.calculateDuration();

    await target.save();
    existing ? updated++ : created++;
    console.log(`  ${existing ? 'updated' : 'created'}  ${title}  (${tasks.length} tasks, ${target.duration}s)`);
  }

  console.log(`\n✓ Seed complete — ${created} created, ${updated} updated`);
  await mongoose.disconnect();
}

seed().catch(async error => {
  console.error('✗ Seed failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
