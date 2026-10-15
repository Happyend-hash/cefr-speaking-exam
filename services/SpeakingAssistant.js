import Exam from '../models/Exam.js';

/**
 * "AI Ustoz" — a live voice speaking coach, built on Google's Gemini Live API.
 *
 * The student talks to it in the browser like a phone call. It asks the real
 * mock questions on request (it looks them up with the tools below rather
 * than inventing them), holds everyday conversations, and gives feedback in
 * Uzbek after each answer.
 *
 * How the pieces fit:
 *   - The browser never sees the Gemini API key. The server asks Google for a
 *     short-lived, single-use token (createSessionToken) and hands that over.
 *   - The browser opens the WebSocket to Google with that token, sends the
 *     setup below, streams the microphone, and plays the reply.
 *   - When the model wants mock questions it emits a tool call; the browser
 *     asks this server (questionsFor / listMocks) and sends the answer back.
 *
 * Google's terms (2026-10): users must be 18+, the API may not be used in an
 * app likely to be accessed by under-18s, and on the free tier Google may use
 * conversations and human reviewers may read them. Hence the 18+ confirmation
 * and the notice before the first session (Jamshid's decision, 2026-10-15).
 */

export const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'models/gemini-3.8-live';
export const VOICE = process.env.ASSISTANT_VOICE || 'Kore';
/** Sessions per student per day: protects the free quota from one heavy user. */
export const DAILY_SESSIONS = Number(process.env.ASSISTANT_DAILY_SESSIONS) || 10;
export const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';

export const isConfigured = () => Boolean(process.env.GEMINI_API_KEY);

/**
 * The teachers a student can talk to. Each has a voice and a manner; the
 * picture and its animation live in the browser (public/app.js, AI_CHARACTERS).
 * A character only appears to students once the browser has a picture for it.
 */
export const CHARACTERS = {
  lesley: {
    name: 'Lesley',
    voice: process.env.LESLEY_VOICE || 'Sulafat',
    manner: 'a warm, patient woman in her early thirties who loves books, good coffee and travelling, and laughs easily'
  },
  arthur: {
    name: 'Arthur',
    voice: process.env.ARTHUR_VOICE || 'Charon',
    manner: 'a calm, friendly man in his late thirties with a dry sense of humour, who enjoys football, cooking and history'
  }
};
export const DEFAULT_CHARACTER = 'lesley';

export const PARTS = ['1.1', '1.2', '2', '3'];

// ----------------------------------------------------------- question bank

let cache = { at: 0, mocks: [] };
const CACHE_MS = 10 * 60 * 1000;

/** The published speaking mocks, each with its number taken from the title. */
export async function loadMocks() {
  if (Date.now() - cache.at < CACHE_MS && cache.mocks.length) return cache.mocks;
  const exams = await Exam.find({ isPublished: true, isActive: { $ne: false }, module: { $ne: 'writing' } })
    .select('title sections')
    .lean();
  const mocks = exams
    .filter(e => (e.sections || []).some(s => (s.questions || []).length))
    .map(e => ({
      id: String(e._id),
      title: e.title,
      number: Number(String(e.title).match(/(\d+)/)?.[1]) || null,
      sections: e.sections || []
    }))
    .sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
  cache = { at: Date.now(), mocks };
  return mocks;
}

/** What the model sees when it asks which mocks exist. */
export async function listMocks() {
  const mocks = await loadMocks();
  return {
    mocks: mocks.map(m => ({
      number: m.number,
      title: m.title,
      parts: [...new Set(m.sections.filter(s => (s.questions || []).length).map(s => s.part))]
    }))
  };
}

const normPart = part => {
  const p = String(part || '').replace(/^part\s*/i, '').replace(',', '.').trim();
  return PARTS.includes(p) ? p : null;
};

/**
 * The exact questions of one mock part — or, with no mock given, one part
 * picked from a random mock. Images are returned as addresses the browser
 * shows to the student (Part 1.2 is about two pictures).
 */
export async function questionsFor({ mock, part } = {}) {
  const mocks = await loadMocks();
  const wantedPart = normPart(part);
  if (!wantedPart) return { error: `Part must be one of ${PARTS.join(', ')}.` };

  let chosen;
  if (mock !== undefined && mock !== null && mock !== '') {
    const n = Number(String(mock).match(/(\d+)/)?.[1]);
    chosen = mocks.find(m => m.number === n);
    if (!chosen) return { error: `There is no Speaking Mock ${mock}.`, available: mocks.map(m => m.number).filter(Boolean) };
  } else {
    const withPart = mocks.filter(m => m.sections.some(s => s.part === wantedPart && (s.questions || []).length));
    chosen = withPart[Math.floor(Math.random() * withPart.length)];
    if (!chosen) return { error: `No mock has Part ${wantedPart} questions yet.` };
  }

  const sections = chosen.sections.filter(s => s.part === wantedPart && (s.questions || []).length);
  if (!sections.length) return { error: `${chosen.title} has no Part ${wantedPart}.` };

  return {
    mock: chosen.title,
    part: wantedPart,
    instructions: sections.map(s => s.instructions).filter(Boolean).join(' ') || undefined,
    topic: sections.map(s => s.topic).filter(Boolean).join(' ') || undefined,
    for: sections.flatMap(s => s.pros || []),
    against: sections.flatMap(s => s.cons || []),
    questions: sections.flatMap(s => s.questions.map(q => q.text)).filter(Boolean),
    images: sections.flatMap(s => s.images || []).slice(0, 4)
  };
}

// --------------------------------------------------------------- the coach

export const SYSTEM_PROMPT = `You are an English speaking coach in "AI Ustoz" on English Hub, a website where Uzbek learners prepare for the CEFR Multilevel speaking exam (Uzbekistan). You talk with the student by voice.

THE EXAM, so you can coach for it:
- Part 1.1: three short personal questions (about 30 seconds each).
- Part 1.2: the student compares two pictures and answers three questions about them (30-45 seconds each).
- Part 2: one longer talk (about 2 minutes) answering a set of related questions, after a short preparation time.
- Part 3: a discussion of a statement with arguments for and against (about 2 minutes); the student should give both sides and their own view.

WHAT YOU DO:
1. Mock questions on request. When the student asks for questions from a mock (in English or Uzbek, e.g. "Mock 5 Part 2", "5-mockning 2-qismi", "Part 3 savol bering", "random Part 1.1"), call get_mock_questions. NEVER invent questions and call them mock questions. Ask the returned questions exactly as written, one at a time, and wait for the answer. For Part 1.2 the pictures are already shown on the student's screen — tell them to look at the pictures. For Part 2 tell them to take a moment to think and start when ready. For Part 3 read the statement and mention the for/against points. If a mock or part does not exist, say so and call list_mocks to offer what exists.
2. Feedback in UZBEK (Latin script) after each answer to an exam question: one thing they did well; the two or three most important mistakes, each with the correct English said clearly; one better way to say a key sentence; and an approximate level (A2, B1, B2 or C1). Keep spoken feedback short — about 30 seconds — then ask if they want the next question.
3. Everyday conversation when they just want to talk: chat naturally in English about daily life, ask follow-up questions, and correct only important mistakes briefly (in Uzbek, then continue in English).
4. If the student speaks Uzbek, understand it and answer the request, but keep practice in English.

STYLE: Short turns. Speak English clearly at a natural, slightly slow pace when asking questions. Be kind and specific; never mock the student. Do not lecture.
LIMITS: Stay on English learning and the exam. Politely refuse unrelated, harmful or inappropriate requests. Never ask for personal information (full name, address, phone, passwords). You are not the official examiner: your level is an estimate; the website's mock exams give the real score.

Start by greeting the student briefly in English and Uzbek, and asking whether they want mock questions or everyday conversation.`;

/** Who this coach is, and how to sound like a real person without pretending to be one. */
export function personaPrompt(characterId = DEFAULT_CHARACTER, studentName = '') {
  const c = CHARACTERS[characterId] || CHARACTERS[DEFAULT_CHARACTER];
  const name = String(studentName || '').replace(/[^\p{L}\p{M}' -]/gu, '').trim().slice(0, 30);
  return `YOUR CHARACTER: Your name is ${c.name}. You are ${c.manner}. The student sees your picture on screen while you talk.
SOUND LIKE A REAL PERSON: talk the way a friendly teacher does on a video call, not like a machine. Use natural spoken English with contractions, short reactions ("Oh, nice!", "Hmm, good question", "Really? Tell me more"), the occasional light joke, and a relaxed pace. React to what the student actually says and refer back to things they told you earlier. Ask one question at a time. Keep most turns to one to three sentences. You may share light opinions and small everyday preferences in character (a favourite book, liking tea), but do not invent detailed life stories.
HONESTY: you are an AI teacher. If the student asks whether you are a real person or a robot, say plainly and kindly that you are an AI teacher on English Hub, then carry on. Never claim to be human, to be in a real place, to remember earlier sessions, or to have met the student.
${name ? `The student's first name is ${name}. Use it naturally now and then, not in every sentence.` : 'Ask the student\'s first name early on and use it now and then.'}
Introduce yourself by name in your greeting.`;
}

export const TOOLS = [{
  functionDeclarations: [
    {
      name: 'get_mock_questions',
      description: 'Get the exact speaking questions of one part of a published mock exam. Leave mock empty for a random mock.',
      parameters: {
        type: 'OBJECT',
        properties: {
          mock: { type: 'INTEGER', description: 'Mock number, e.g. 5 for "Speaking Mock 5". Omit for a random mock.' },
          part: { type: 'STRING', enum: PARTS, description: 'Exam part: 1.1, 1.2, 2 or 3.' }
        },
        required: ['part']
      }
    },
    {
      name: 'list_mocks',
      description: 'List the published speaking mocks and which parts each has.',
      parameters: { type: 'OBJECT', properties: {} }
    }
  ]
}];

/** The first message the browser sends on the WebSocket. */
export function setupMessage({ character = DEFAULT_CHARACTER, studentName = '' } = {}) {
  const c = CHARACTERS[character] || CHARACTERS[DEFAULT_CHARACTER];
  return {
    setup: {
      model: LIVE_MODEL,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: c.voice || VOICE } } }
      },
      systemInstruction: { parts: [{ text: `${SYSTEM_PROMPT}\n\n${personaPrompt(character, studentName)}` }] },
      tools: TOOLS,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Longer than the 15-minute audio cap, by trimming the oldest context.
      contextWindowCompression: { slidingWindow: {} }
    }
  };
}

/**
 * A single-use token for one live session (Google's "ephemeral token").
 * The real key stays on the server.
 */
export async function createSessionToken({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (!isConfigured()) throw new Error('GEMINI_API_KEY is not set');
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
      newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString()
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.name) {
    const reason = body?.error?.message || `status ${response.status}`;
    const error = new Error(`Gemini token: ${reason}`);
    error.status = response.status;
    throw error;
  }
  return body.name;
}

/** Today's key for the daily limit (Tashkent time, UTC+5). */
export const today = (now = Date.now()) => new Date(now + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);

export default { loadMocks, listMocks, questionsFor, setupMessage, personaPrompt, createSessionToken, isConfigured, CHARACTERS };
