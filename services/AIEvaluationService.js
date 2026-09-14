import axios from 'axios';

// The bands live in one place so the score always means the same thing.
import { CEFR_BANDS, levelForScore, MAX_SCORE } from '../models/ExamResult.js';

/**
 * AI Evaluation Service - Integrates with Claude Opus for CEFR assessment
 * This service evaluates spoken English and provides CEFR level assessment
 */
class AIEvaluationService {
  constructor() {
    this.apiKey = process.env.CLAUDE_API_KEY;
    this.model = process.env.CLAUDE_MODEL || 'claude-opus-5-20250805';
    this.apiUrl = 'https://api.anthropic.com/v1/messages';
    // Headroom matters here: if the model thinks before answering, that
    // reasoning is billed against the same budget, and a budget spent before
    // the JSON is written comes back as a truncated reply with nothing to parse.
    this.maxTokens = parseInt(process.env.CLAUDE_MAX_TOKENS) || 4000;
  }

  /**
   * Evaluate a speaking task response
   * @param {Object} taskData - Task data with transcription and metadata
   * @returns {Object} Evaluation results with scores and feedback
   */
  async evaluateTask(taskData) {
    try {
      const {
        transcription,
        taskType,
        question,
        cefrLevel,
        referenceImages,
        followUpQuestions,
        part,
        instructions,
        topic,
        pros,
        cons,
        anchors
      } = taskData;

      if (!transcription || transcription.trim().length === 0) {
        return {
          score: 0,
          criteria: {
            grammar: { score: 0, feedback: 'No response provided' },
            vocabulary: { score: 0, feedback: 'No response provided' },
            coherence: { score: 0, feedback: 'No response provided' }
          },
          overallFeedback: 'No response was submitted for evaluation.',
          strengths: [],
          areasForImprovement: [],
          suggestedLevel: 'A1'
        };
      }

      // Writing is assessed against different criteria from speaking — there is
      // nothing to say about pronunciation or fluency in a written answer.
      const isWriting = String(taskType || '').startsWith('writing_');

      const prompt = isWriting
        ? this.buildWritingPrompt(transcription, taskType, question, taskData.minWords)
        : this.buildEvaluationPrompt(
            transcription,
            taskType,
            question,
            cefrLevel,
            referenceImages,
            followUpQuestions,
            { part, instructions, topic, pros, cons, anchors }
          );

      const response = await this.callClaudeAPI(prompt);
      const evaluation = this.parseEvaluation(response);

      return evaluation;
    } catch (error) {
      console.error('Error in evaluateTask:', error);
      throw new Error(`AI Evaluation failed: ${error.message}`);
    }
  }

  /**
   * Decide the candidate's level from the whole performance.
   *
   * This replaces averaging the eight answers, which was wrong in a way that
   * quietly cost real candidates a band. The parts are a ladder, not equal
   * slices: Part 1 can only ever demonstrate up to B1, Part 2 is where B2 is
   * shown, Part 3 is where C1 is. Averaging them asks a 30-second Part 1.1
   * answer to prove C1, marks it down when it cannot, and then drags a genuinely
   * C1 candidate to the middle of B2. A teacher who scores 67 in the real exam
   * was being handed 52 by arithmetic alone.
   *
   * So the overall mark is a judgement across every answer at once, the way an
   * examiner forms one. Per-answer scores stay — they are useful feedback — but
   * they no longer decide the outcome.
   */
  async evaluateAttempt({ answers, examTitle }) {
    const byPart = answers.reduce((groups, answer) => {
      (groups[answer.part] ||= []).push(answer);
      return groups;
    }, {});

    const transcript = Object.entries(byPart)
      .map(([part, group]) => `
=== PART ${part} ===
${group.map(a => `Q: ${a.question}\nA: "${a.transcription}"`).join('\n\n')}`)
      .join('\n');

    const prompt = `You are an expert examiner for the O'zbekiston Multilevel English speaking exam.
You have the candidate's complete performance${examTitle ? ` on ${examTitle}` : ''} and must decide their level.

HOW THIS EXAM ESTABLISHES A LEVEL — read this carefully, it is not an average:
The parts are a ladder. Each one is where a particular level gets demonstrated.

- PART 1 (1.1 and 1.2) establishes whether the candidate is A1, A2 or B1.
  This part cannot show more than B1. Doing it well proves B1, not C1.
- PART 2 is where B2 is demonstrated. A candidate who sustains an extended,
  connected two-minute turn covering all three questions is showing B2.
- PART 3 is where C1 is demonstrated. A candidate who argues a clear position,
  develops reasons and engages with the opposing side is showing C1.

The level is THE HIGHEST RUNG THE CANDIDATE ACTUALLY DEMONSTRATES. Weakness
lower down does not cap them at that lower rung — it moves them down WITHIN the
band they reached, not out of it:

- Strong Part 3, weak Part 1 → solid or upper B2. Not B1.
- Strong Part 2, weak Part 1, moderate Part 3 → B2, toward the lower end.
- Strong throughout, including Part 3 → C1.
- Handles Part 1 well but cannot sustain Part 2 → B1.

Overall impression across the whole performance is weighed alongside this.

YOU ARE READING AUTOMATIC TRANSCRIPTION OF SPEECH:
No punctuation, inferred sentence boundaries, and repetitions or restarts that
are normal in speech and often artefacts of transcription rather than errors.
Judge the English a listener would have heard. Pronunciation and fluency are
measured separately from the audio and are not yours to judge — do not mention
accent, pace or hesitation anywhere.

THE CANDIDATE'S FULL PERFORMANCE:
${transcript}

SCALE — out of 75:
- 65-75  C1     - 51-64  B2     - 31-50  B1     - 16-30  A2     - 0-15  A1

Decide the band first from the ladder above, then place the candidate within it.
Do not hedge toward the middle: a candidate who demonstrates C1 in Part 3 belongs
in the 65-75 band, and placing them at 58 to be safe is a marking error, not
caution.

Reply with JSON only:
{
  "score": (0-75),
  "level": "A1|A2|B1|B2|C1",
  "reasoning": "Which rung each part demonstrated, and how that produced this band",
  "overallFeedback": "What the candidate does well and what holds them back, addressed to them",
  "strengths": ["...", "...", "..."],
  "areasForImprovement": ["...", "...", "..."]
}

${this.languageInstruction}
Mark as the official examiner would: neither severe nor generous.`;

    const response = await this.callClaudeAPI(prompt);
    const verdict = this.parseEvaluation(response);

    const score = Number(verdict.score);
    if (!Number.isFinite(score)) throw new Error('Overall marking returned no usable score');

    return {
      score: Math.max(0, Math.min(MAX_SCORE, Math.round(score))),
      // The band table is the authority on which level a score is, so the level
      // is derived rather than trusted — the two can never disagree.
      level: levelForScore(Math.max(0, Math.min(MAX_SCORE, Math.round(score)))),
      reasoning: verdict.reasoning || '',
      overallFeedback: verdict.overallFeedback || '',
      strengths: verdict.strengths || [],
      areasForImprovement: verdict.areasForImprovement || []
    };
  }

  /**
   * Build the evaluation prompt for a written answer.
   *
   * Mirrors the speaking prompt's JSON contract exactly, so the same parser and
   * the same result shape work for both modules — only the criteria differ.
   */
  buildWritingPrompt(answer, taskType, question, minWords) {
    const wordCount = answer.trim().split(/\s+/).filter(Boolean).length;
    const isTask1 = taskType === 'writing_task1';

    const lengthNote = minWords
      ? `\nLENGTH: the task required at least ${minWords} words; the candidate wrote ${wordCount}. ` +
        (wordCount < minWords
          ? 'An under-length answer cannot reach the higher bands — penalise task achievement accordingly.'
          : 'The length requirement is met.')
      : `\nLENGTH: the candidate wrote ${wordCount} words.`;

    return `You are an experienced examiner for the Uzbekistan Multilevel English examination. Assess the written answer below against the CEFR scale.

TASK TYPE: ${isTask1 ? 'Task 1 — describing visual information' : 'Task 2 — opinion essay'}

QUESTION:
${question}
${lengthNote}

CANDIDATE'S ANSWER:
"""
${answer}
"""

Assess it on these four criteria, each scored 0-75:
- taskAchievement: ${isTask1
      ? 'Does it report the key features accurately, make relevant comparisons, and avoid opinion and invented data?'
      : 'Does it address every part of the prompt, take a clear position, and develop ideas with relevant support?'}
- coherence: paragraphing, logical progression, and cohesive devices used accurately rather than mechanically.
- vocabulary: range, precision and appropriacy, including collocation and any awkward or misused items.
- grammar: range of structures and accuracy, noting whether errors impede understanding.

Respond with ONLY valid JSON in exactly this structure, and nothing else:

{
  "score": (0-75, the overall mark for this answer on the Multilevel scale),
  "criteria": {
    "taskAchievement": { "score": (0-75), "feedback": "Specific comment, quoting the answer where useful" },
    "coherence": { "score": (0-75), "feedback": "Specific comment" },
    "vocabulary": { "score": (0-75), "feedback": "Specific comment" },
    "grammar": { "score": (0-75), "feedback": "Name the actual error patterns you found" }
  },
  "overallFeedback": "A short paragraph summarising the level of this answer and why",
  "strengths": ["Strength 1", "Strength 2", "Strength 3"],
  "areasForImprovement": ["Specific, actionable point 1", "Point 2", "Point 3"],
  "suggestedLevel": "CEFR level (A1/A2/B1/B2/C1/C2)"
}

SCORING SCALE — out of 75, the O'zbekiston Multilevel scale:
- 65-75  C1    - 51-64  B2    - 31-50  B1    - 16-30  A2    - 0-15  A1

Never award more than 75, and make "suggestedLevel" agree with the band the score falls in.

${this.languageInstruction}
Be rigorous and specific. Quote the candidate's own words when pointing out an error, and make every improvement point something they could act on in their next attempt. Do not be generically encouraging.`;
  }

  /**
   * Build evaluation prompt for Claude Opus
   */
  buildEvaluationPrompt(
    transcription,
    taskType,
    question,
    cefrLevel,
    referenceImages,
    followUpQuestions,
    context = {}
  ) {
    const { part, instructions, topic, pros, cons, anchors = [] } = context;

    /**
     * Marked samples for this same part, lowest first.
     *
     * This is the single change that most affects accuracy. Without it the model
     * invents the scale on every call and drifts toward the middle; with two or
     * three known points it compares instead of guessing. Only samples for the
     * same part are ever shown — a Part 1.1 example would actively mislead
     * someone marking Part 3.
     */
    const anchorBlock = anchors.length
      ? `\nMARKED SAMPLES FOR THIS PART — the teacher's own standard.
Match these. An answer as good as the ${anchors[anchors.length - 1].score}/75 sample deserves about that mark; do not award less out of caution.
${anchors.map(a => `
--- ${a.level}, scored ${a.score}/75${a.scoreSource === 'real-exam' ? ' (confirmed by the real exam)' : ''}
${a.question ? `Question: ${a.question}\n` : ''}"${a.transcription}"
${a.notes ? `Why: ${a.notes}` : ''}`).join('\n')}
--- end of samples\n`
      : '';

    // What each part is actually testing. Without this the model grades a
    // 30-second Part 1.1 answer by the same yardstick as a 2-minute Part 3
    // argument, and marks the short one down for being short.
    //
    // The ceilings matter more than they look. The parts are a ladder: Part 1
    // can only ever show A1-B1, Part 2 is where B2 is demonstrated, Part 3 is
    // where C1 is. So an excellent Part 1.1 answer is an excellent B1-ceiling
    // performance, and scoring it against the full 0-75 range asks it to prove
    // something the task does not give it room to prove.
    const PART_BRIEF = {
      '1.1': 'Part 1.1 — three short personal questions, 30 seconds each. Expect a direct, ' +
             'relevant answer with a little detail. Brevity is correct here and must not be penalised.',
      '1.2': 'Part 1.2 — the student sees two pictures and describes them, then answers two ' +
             'short follow-ups. Reward accurate description, comparison and the language of ' +
             'speculation. The transcript is all you have, so judge the description on its own ' +
             'internal coherence and detail, not on whether it matches an image you cannot see.',
      '2': 'Part 2 — one long turn of up to 2 minutes answering three linked questions together. ' +
           'Expect all three to be covered, with extended, connected discourse.',
      '3': 'Part 3 — a 2-minute argued opinion on a statement, with arguments for and against ' +
           'supplied. Expect a clear position, reasons, and engagement with the other side. ' +
           'A student who only reads the supplied points aloud without developing them has not ' +
           'done the task.'
    };

    return `You are an expert examiner for the O'zbekiston Multilevel English speaking exam, assessing against the CEFR framework.

TASK INFORMATION:
- Task Type: ${taskType}${part ? `\n- Exam Part: ${part}` : ''}${
      PART_BRIEF[part] ? `\n- What this part tests: ${PART_BRIEF[part]}` : ''
    }
- Target Level: ${cefrLevel || 'not fixed — this is a Multilevel sitting, so determine the level from the performance'}${
      instructions ? `\n- Instructions the student was given: ${instructions}` : ''
    }${topic ? `\n- Topic / statement on screen: ${topic}` : ''}
- Question/Prompt: ${question}
${pros?.length ? `- Arguments FOR shown to the student: ${pros.join('; ')}` : ''}
${cons?.length ? `- Arguments AGAINST shown to the student: ${cons.join('; ')}` : ''}
${followUpQuestions?.length ? `- Follow-up Questions: ${followUpQuestions.join(', ')}` : ''}
${referenceImages?.length ? `- Reference Context: the student was shown ${referenceImages.length} picture(s). You cannot see them.` : ''}

STUDENT'S RESPONSE (Transcribed):
"${transcription}"
${anchorBlock}
YOU ARE READING AUTOMATIC TRANSCRIPTION OF SPEECH, NOT WRITING:
There is no punctuation because the transcriber does not add it, and sentence
boundaries have to be inferred. Repetitions, restarts and self-corrections are
normal features of fluent speech and are frequently transcription artefacts
rather than the candidate's errors. Judge the English a listener would have
heard, not the typography. Do not count a missing comma, a run-on line or a
repeated word as a grammatical error.

WHAT YOU CAN AND CANNOT JUDGE:
You are reading a transcript. You did not hear this student. Pronunciation and
fluency are therefore not yours to score — they are measured separately from the
audio itself by a speech assessor, and your guess would overwrite a measurement.
Do not mention pronunciation, accent, intonation, pace or hesitation anywhere in
your feedback, including in strengths and areas for improvement: you have no
evidence for any of it. Judge what the words show — grammar, vocabulary,
coherence and whether the task was done — and let the overall score reflect only
those.

Please evaluate this response and provide a detailed assessment in the following JSON format:

{
  "score": (numeric score from 0 to 75 — the Multilevel scale),
  "criteria": {
    "grammar": {
      "score": (0-75),
      "feedback": "Specific feedback on grammatical accuracy, sentence structure, and complexity"
    },
    "vocabulary": {
      "score": (0-75),
      "feedback": "Feedback on vocabulary range, appropriateness, and use of idiomatic expressions"
    },
    "coherence": {
      "score": (0-75),
      "feedback": "Feedback on logical organization, coherence, and task completion"
    }
  },
  "overallFeedback": "A comprehensive summary of the response quality and assessment",
  "strengths": ["Strength 1", "Strength 2", "Strength 3"],
  "areasForImprovement": ["Area 1", "Area 2", "Area 3"],
  "suggestedLevel": "CEFR level (A1/A2/B1/B2/C1/C2)"
}

HOW TO ARRIVE AT THE SCORE:
Decide the band first, then the number inside it. Ask "is this A2, B1, B2 or C1
for this part?" and only then place it within that band. Choosing a band is a
judgement you can make reliably; choosing between 58 and 64 in the abstract is
not, and starting from the number is how marking drifts to the middle.

- 65-75  C1     - 51-64  B2     - 31-50  B1     - 16-30  A2     - 0-15  A1

Set "suggestedLevel" to the band the score falls in — the two must agree. Never
award more than 75.

Score this answer against what THIS PART can show. Part 1 tops out at B1 by
design, so an answer that does everything Part 1 asks is a strong answer and
should be scored as one, even though the task gives no room to demonstrate C1.
Do not mark an answer down for failing to show a level its own task never asked
for. The candidate's overall level is decided separately, across all parts
together — it is not your job here and you must not hedge toward the middle in
anticipation of it.

${this.languageInstruction}
Mark as the official examiner would: neither severe nor generous. Judge accuracy,
range, coherence, and how well the answer does what this part of the exam asks.
Do not mark a short answer down for being short when the part calls for a short
answer.`;
  }

  /**
   * Call Claude API
   */
  /**
   * Call the API, retrying the failures that are worth retrying.
   *
   * A 429 or a 5xx is the API saying "not now", not "this answer is bad" — but
   * without a retry it surfaced as a failed task, which is a wrong mark for a
   * student whose only mistake was submitting at the same moment as thirty
   * classmates. Wait and try again, backing off so a burst does not become a
   * stampede, with jitter so the retries do not all return together.
   *
   * A 400 or 401 is a configuration mistake that will fail identically forever,
   * so those are not retried.
   */
  async callClaudeAPI(prompt, attempt = 1) {
    const MAX_ATTEMPTS = Number(process.env.CLAUDE_MAX_RETRIES) || 4;

    try {
      return await this.callClaudeAPIOnce(prompt);
    } catch (error) {
      const status = error.status || error.response?.status;
      const retryable =
        status === 429 || status === 529 || (status >= 500 && status < 600) ||
        // No status at all means the connection itself failed.
        (!status && /timeout|ETIMEDOUT|ECONNRESET|socket hang up|network/i.test(error.message || ''));

      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;

      const backoffMs = Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
      console.warn(
        `Claude API attempt ${attempt}/${MAX_ATTEMPTS} failed (${status || 'connection'}); ` +
          `retrying in ${Math.round(backoffMs)}ms`
      );
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      return this.callClaudeAPI(prompt, attempt + 1);
    }
  }

  async callClaudeAPIOnce(prompt) {
    const payload = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    };

    // Temperature is sent only when explicitly configured. Some models accept a
    // narrower range than others, and an unsupported value is rejected with a
    // 400 for the whole request — not worth risking for a grading task, where
    // the default (deterministic-leaning) sampling is what you want anyway.
    if (process.env.CLAUDE_TEMPERATURE !== undefined) {
      payload.temperature = Number(process.env.CLAUDE_TEMPERATURE);
    }

    try {
      const response = await axios.post(this.apiUrl, payload, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      });

      // Never assume content[0] is the answer. A response can lead with a
      // non-text block — a thinking block, for instance — and then
      // content[0].text is undefined, which surfaced as a useless "cannot read
      // properties of undefined (reading 'match')" in the parser below.
      // Join every text block instead, and if there are none, say what came back.
      const blocks = Array.isArray(response.data?.content) ? response.data.content : [];
      const text = blocks
        .filter(b => b?.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n')
        .trim();

      if (!text) {
        const kinds = blocks.map(b => b?.type || 'unknown').join(', ') || 'none';
        const stop = response.data?.stop_reason;
        throw new Error(
          `the API returned no text to read (blocks: ${kinds}; stop_reason: ${stop || 'unknown'})` +
            (stop === 'max_tokens' ? ' — the answer was cut off; raise CLAUDE_MAX_TOKENS' : '')
        );
      }

      return text;
    } catch (error) {
      // A thrown Error here is ours, not axios's — pass it through unchanged
      // rather than relabelling it as an HTTP failure.
      if (!error.response && !error.request) throw error;
      // Axios reduces an API rejection to "Request failed with status code 400",
      // which hides the one thing that matters: which field was wrong. Surface
      // the API's own explanation, and name the likely cause per status code.
      const status = error.response?.status;
      const detail =
        error.response?.data?.error?.message ||
        (error.response?.data ? JSON.stringify(error.response.data).slice(0, 400) : error.message);

      const hint =
        status === 401 ? ' — CLAUDE_API_KEY is invalid'
        : status === 404 ? ` — model "${this.model}" does not exist; set CLAUDE_MODEL to one your key can use`
        : status === 400 ? ' — the request was rejected; check CLAUDE_MODEL, CLAUDE_MAX_TOKENS and CLAUDE_TEMPERATURE'
        : status === 429 ? ' — rate limited or out of credit'
        : '';

      // Carry the status on the error: the retry logic needs to tell a 429
      // ("try again shortly") from a 401 ("this will never work").
      const wrapped = new Error(`Claude API ${status || 'request'} failed: ${detail}${hint}`);
      wrapped.status = status;
      throw wrapped;
    }
  }


  /**
   * Tell the model which language to write feedback in.
   *
   * The students are Uzbek teenagers preparing for a national exam. Feedback
   * they cannot read is feedback they cannot act on, and a B1 candidate cannot
   * reliably read a paragraph of C1-level English about their own mistakes.
   *
   * The English they actually said stays in English, though: correcting
   * "both has" to "both have" only teaches anything if both forms are shown as
   * the student would write them.
   */
  get languageInstruction() {
    const lang = (process.env.FEEDBACK_LANGUAGE || 'uz').toLowerCase();
    if (lang === 'en') return '';

    const named = {
      uz: "Uzbek, using the Latin alphabet (o'zbek lotin), not Cyrillic",
      'uz-cyrl': 'Uzbek, using the Cyrillic alphabet',
      ru: 'Russian'
    }[lang] || lang;

    return `
LANGUAGE OF THE FEEDBACK — IMPORTANT:
Write "overallFeedback", every "feedback" field, "strengths" and
"areasForImprovement" in ${named}. The student is a school-age learner, so keep
the language plain and encouraging, and explain grammar terms rather than
assuming them.

Two things stay in English:
- Any words you quote from the student's answer. Quote them exactly as spoken,
  then explain in ${named} what was wrong and give the corrected English.
- "suggestedLevel", which is a CEFR code (A1-C2).

Numbers stay numbers. Do not translate the JSON field names.
`;
  }

  /**
   * Parse Claude's JSON response
   */
  parseEvaluation(responseText) {
    try {
      if (typeof responseText !== 'string' || !responseText.trim()) {
        throw new Error('the model returned no text to parse');
      }

      // Extract JSON from the response. Models often wrap it in prose or a
      // ```json fence, so take the outermost braces rather than the whole string.
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`no JSON object in the reply (starts: "${responseText.slice(0, 120)}…")`);
      }

      const evaluation = JSON.parse(jsonMatch[0]);

      // Validate structure. Note `!evaluation.score` would reject a legitimate
      // score of 0 — which is exactly what a silent or off-topic answer earns —
      // so test for the field being present, not truthy.
      const missing = ['score', 'criteria', 'overallFeedback'].filter(
        key => evaluation[key] === undefined || evaluation[key] === null
      );
      if (missing.length) {
        throw new Error(`the reply is missing ${missing.join(', ')}`);
      }
      if (typeof evaluation.score !== 'number' || Number.isNaN(evaluation.score)) {
        throw new Error(`score came back as ${JSON.stringify(evaluation.score)}, not a number`);
      }

      return evaluation;
    } catch (error) {
      console.error('Error parsing evaluation:', error);
      throw new Error(`Failed to parse AI evaluation: ${error.message}`);
    }
  }

  /**
   * Batch evaluate multiple tasks
   */
  async batchEvaluateTasks(tasks) {
    const results = [];

    for (const task of tasks) {
      try {
        const evaluation = await this.evaluateTask(task);
        results.push({
          taskNumber: task.taskNumber,
          success: true,
          evaluation
        });
      } catch (error) {
        results.push({
          taskNumber: task.taskNumber,
          success: false,
          error: error.message
        });
      }

      // Add delay between API calls to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }

  /**
   * Get CEFR level from score.
   *
   * Delegates to the single band table in models/ExamResult.js — this used to
   * be a second copy of the thresholds, which is exactly how a scale change
   * ends up applied in one place and not the other.
   */
  static scoreToCEFRLevel(score) {
    return levelForScore(score);
  }

  /** Does this score reach the band the student was aiming for? */
  static checkPassed(score, targetLevel) {
    const band = CEFR_BANDS.find(b => b.level === targetLevel);
    return Number(score) >= (band ? band.min : 0);
  }
}

export default new AIEvaluationService();
