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
        cons
      } = taskData;

      if (!transcription || transcription.trim().length === 0) {
        return {
          score: 0,
          criteria: {
            grammar: { score: 0, feedback: 'No response provided' },
            vocabulary: { score: 0, feedback: 'No response provided' },
            fluency: { score: 0, feedback: 'No response provided' },
            pronunciation: { score: 0, feedback: 'Unable to assess - no audio' },
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
            { part, instructions, topic, pros, cons }
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
    const { part, instructions, topic, pros, cons } = context;

    // What each part is actually testing. Without this the model grades a
    // 30-second Part 1.1 answer by the same yardstick as a 2-minute Part 3
    // argument, and marks the short one down for being short.
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
    "fluency": {
      "score": (0-75),
      "feedback": "Feedback on speech fluency, pace, hesitations, and natural delivery"
    },
    "pronunciation": {
      "score": (0-75),
      "feedback": "Assessment of pronunciation clarity (note: estimated from transcription accuracy)"
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

SCORING SCALE — score out of 75, exactly as the O'zbekiston Multilevel exam does:
- 65-75  C1
- 51-64  B2
- 31-50  B1
- 16-30  A2
- 0-15   A1

Never award more than 75. Set "suggestedLevel" to the band the score falls in,
using the table above — the two must agree.

${this.languageInstruction}
Be fair but rigorous. Judge accuracy, fluency, coherence, and how well the answer
does what this part of the exam asks. Do not mark a short answer down for being
short when the part calls for a short answer.`;
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
