import axios from 'axios';

// The bands live in one place so the score always means the same thing.
import { CEFR_BANDS, levelForScore, MAX_SCORE } from '../models/ExamResult.js';
import { CRITERIA_PROMPT_BLOCK, CRITERION_KEYS, BAND_LABELS } from '../content/speakingCriteria.js';
import { bandsToRaw, rawToScore, BAND_MAX } from './ScoreConversion.js';

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

    /**
     * A cheaper model for the per-answer feedback, if one is configured.
     *
     * The per-answer notes are supporting detail; the candidate's level comes
     * from the whole-performance pass, which always uses the main model. So the
     * two can be split — but only once there are calibration samples to prove
     * the cheaper one still marks to the same standard, which is what the
     * calibration check is for. Unset, both use the same model and nothing
     * changes.
     */
    this.answerModel = process.env.CLAUDE_ANSWER_MODEL || null;

    /** Tokens spent since boot, so the cost is measured rather than estimated. */
    this.spend = { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  }

  /**
   * What has been spent since this container started.
   *
   * Reported in tokens rather than money on purpose: prices change, differ per
   * model, and a dollar figure that quietly goes stale is worse than an honest
   * count. Multiply by the current rate when you want the bill.
   */
  get costSummary() {
    const { calls, input, output, cacheWrite, cacheRead } = this.spend;
    return {
      calls,
      input,
      output,
      cacheWrite,
      cacheRead,
      // The share of repeated prompt text read from cache instead of paid for
      // in full. Near zero means caching is not working.
      cacheHitRate: cacheRead + cacheWrite
        ? Math.round((cacheRead / (cacheRead + cacheWrite)) * 100)
        : 0
    };
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
  /**
   * Worked examples in the teacher's own hand, for the cached half of the
   * prompt.
   *
   * Each is a performance the teacher re-marked, with the bands they would have
   * given. This is the only thing in the prompt that carries a human's standard
   * rather than a description of one, and it is why a marker stops parking on
   * band 4: it can see what a 5 and a 6 look like in this school's judgement.
   *
   * Transcripts are truncated hard. The examples exist to show the SHAPE of a
   * performance at each band, and three full mocks quoted in every prompt would
   * cost more than the marking itself.
   */
  buildAnchorBlock(anchors = []) {
    if (!anchors.length) return '';

    const blocks = anchors.map((anchor, index) => {
      const bands = CRITERION_KEYS
        .map(key => `${key} ${anchor.teacherBands?.[key] ?? '—'}`)
        .join(', ');

      const extract = (anchor.taskResults || [])
        .map(t => String(t.transcription || '').trim())
        .filter(Boolean)
        .join(' … ')
        .slice(0, 700);

      const provenance = anchor.teacherBands?.source === 'real-exam'
        ? 'bands confirmed against an official certificate'
        : "the teacher's own marking";

      return `EXAMPLE ${index + 1} (${provenance})
Bands awarded: ${bands}
${anchor.teacherBands?.note ? `Examiner's note: ${anchor.teacherBands.note}\n` : ''}What the candidate said (extract): "${extract}"`;
    });

    return `

MARKED EXAMPLES FROM THIS SCHOOL — match this standard:
These are real performances with the bands an experienced examiner gave them.
Where your judgement differs from these, these are right and you are wrong.
Note especially where they were awarded 5 and 6: those bands exist and are
earned regularly. A marker that awards 4 to every criterion of every candidate
is not being careful, it is refusing to use the scale.

${blocks.join('\n\n')}
`;
  }

  async evaluateAttempt({ answers, examTitle, pronunciation = null, anchors = [] }) {
    const byPart = answers.reduce((groups, answer) => {
      (groups[answer.part] ||= []).push(answer);
      return groups;
    }, {});

    const transcript = Object.entries(byPart)
      .map(([part, group]) => `
=== PART ${part} ===
${group.map(a => `Q: ${a.question}\nA: "${a.transcription}"`).join('\n\n')}`)
      .join('\n');

    const cached = `You are an expert examiner for the O'zbekiston Multilevel English speaking exam.
You are given a candidate's complete performance and must award the official
criterion bands for it.

HOW THIS EXAM IS MARKED — this is the agency's method, not ours:
One generalised judgement is made across all three task types together
("topshiriqlarning 3 turi bo'yicha umumlashgan baho qo'yiladi"). You do not mark
answers separately and average them. You read the whole performance and decide,
for each criterion, which band it sits in.

Each criterion is scored 0-${BAND_MAX} against the published descriptors below.
Band 4 is the pivot: it means the candidate MEETS the requirement. 6 is above
it, 3 is close to it, 1 does not meet it.

Bands 5 and 2 are deliberately not described by the agency. Band 5 means the
candidate shows everything band 4 describes plus some of band 6; band 2 sits
between 1 and 3. Use them — a scale where nobody is ever a 5 is a scale being
used at half its resolution.

THE OFFICIAL CRITERIA AND DESCRIPTORS:

${CRITERIA_PROMPT_BLOCK}
${this.buildAnchorBlock(anchors)}

HOW THE PARTS CONTRIBUTE:
The three parts give different evidence, and a criterion is judged on the best
evidence available for it, not on an average across parts.

- PART 1 (1.1 and 1.2) is short answers. It shows vocabulary and accuracy on
  familiar topics. It cannot show sustained discourse, so weakness here is not
  evidence about coherence over a long turn.
- PART 2 is the extended turn. This is where fluency, coherence and the ability
  to sustain discourse are actually visible.
- PART 3 is argument. This is where the higher bands of communicative
  effectiveness and range get demonstrated.

A candidate who argues well in Part 3 but is terse in Part 1 has DEMONSTRATED
the higher band — weakness earlier does not cancel evidence produced later. Mark
the highest level the candidate actually shows, then adjust within the criterion
for how consistently they show it.

YOU ARE READING AUTOMATIC TRANSCRIPTION OF SPEECH:
No punctuation, inferred sentence boundaries, and repetitions or restarts that
are normal in speech and often artefacts of transcription rather than errors.
Judge the English a listener would have heard.

PRONUNCIATION (talaffuz) IS MEASURED, NOT GUESSED:
A transcript cannot hear an accent. Where measured figures are supplied in the
performance below, the talaffuz band must follow them and the descriptors
together. Where no measurement is supplied, return null for that band rather
than inventing one — a criterion nobody could judge is not a criterion the
candidate failed, and the scoring handles a missing band correctly.

Reply with JSON only:
{
  "bands": {
${CRITERION_KEYS.map(key => `    "${key}": 0-${BAND_MAX}`).join(',\n')}
  },
  "reasoning": "Which part gave the evidence for each band, in one or two sentences",
  "overallFeedback": "What the candidate does well and what holds them back, addressed to them",
  "strengths": ["...", "...", "..."],
  "areasForImprovement": ["...", "...", "..."]
}

${this.languageInstruction}
Award the bands the official examiner would: neither severe nor generous. Do not
hedge toward band 3 or 4 for safety — a candidate whose performance matches the
band 6 descriptor gets a 6, and marking them down to be cautious is a marking
error, not caution.`;

    const measured = pronunciation?.assessed
      ? `\n\nMEASURED PRONUNCIATION (Azure AI Speech, 0-100, from the candidate's actual audio):
accuracy ${Math.round(pronunciation.accuracy ?? 0)}, fluency ${Math.round(pronunciation.fluency ?? 0)}${
          Number.isFinite(pronunciation.prosody) ? `, prosody ${Math.round(pronunciation.prosody)}` : ''
        }, overall ${Math.round(pronunciation.overall ?? 0)}${
          pronunciation.problemWords?.length
            ? `\nWords mispronounced: ${pronunciation.problemWords.slice(0, 8).map(w => w.word).join(', ')}`
            : ''
        }
Use these for the talaffuz band, read against its descriptors.${
          pronunciation.accuracySuspect
            ? `

WARNING — THE ACCURACY FIGURE ABOVE IS UNRELIABLE FOR THIS ATTEMPT.
It sits far below fluency and prosody, which does not happen to a real speaker:
someone whose sounds are genuinely unclear is also hesitant and flat. Judge the
talaffuz band on fluency and prosody, and on the words listed as mispronounced
if any. Do not mark the candidate down for the accuracy number.`
            : ''
        }`
      : `\n\nNo pronunciation measurement is available for this attempt. Return null for
the talaffuz band.`;

    const user = `${examTitle ? `Exam: ${examTitle}\n\n` : ''}THE CANDIDATE'S FULL PERFORMANCE:
${transcript}${measured}`;

    const response = await this.callClaudeAPI({ cached, user });
    const verdict = this.parseEvaluation(response);

    const bands = {};
    for (const key of CRITERION_KEYS) {
      const awarded = verdict.bands?.[key];

      /*
       * A band the marker could not award stays ABSENT rather than becoming a
       * zero. Zero is a real judgement on this scale — worse than band 1 — and
       * must never stand in for "unknown".
       *
       * The emptiness is tested before the conversion to a number, because
       * Number(null) is 0 and Number('') is 0. Left to Number() alone, the
       * marker returning null for an unmeasurable pronunciation — exactly what
       * the prompt instructs it to do — silently became a zero and cost the
       * candidate eight points on the reported score.
       */
      if (awarded === null || awarded === undefined || awarded === '') continue;

      const band = Number(awarded);
      if (!Number.isFinite(band)) continue;
      bands[key] = Math.max(0, Math.min(BAND_MAX, Math.round(band)));
    }

    if (Object.keys(bands).length === 0) {
      throw new Error('Overall marking returned no usable criterion bands');
    }

    const raw = bandsToRaw(bands);
    const score = rawToScore(raw);

    return {
      bands,
      raw,
      score,
      // The agency's table is the authority on both numbers, so neither is
      // taken from the model: the bands convert to a score, and the score
      // determines the level. The marker's own arithmetic is never trusted,
      // which is why it is no longer asked for any.
      level: levelForScore(score),
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
  "suggestedLevel": "B1|B2|C1, or 'below B1'"
}

SCORING SCALE — out of 75, the O'zbekiston Multilevel scale:
- 65-75  C1    - 51-64  B2    - 38-50  B1    - 0-37  below B1
There is no A2 or A1 in this exam: anything under 38 is simply below B1.

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

    /*
     * Split so the unchanging half can be cached.
     *
     * Everything fixed for this part — the examiner's role, what the part
     * tests, the marked samples, how to arrive at a score — goes in `cached`.
     * Only the question and the student's words go in `user`. Marking one mock
     * makes eight calls that share the whole of `cached`; sent in full each
     * time, that prefix is paid for eight times over.
     *
     * The prefix has to be byte-identical to be reused, so nothing about a
     * particular candidate may leak into it.
     */
    const cached = `You are an expert examiner for the O'zbekiston Multilevel English speaking exam, assessing against the CEFR framework.

WHAT THIS PART TESTS:
${PART_BRIEF[part] || 'A speaking task in the Multilevel format.'}
${anchorBlock}
YOU ARE READING AUTOMATIC TRANSCRIPTION OF SPEECH, NOT WRITING:
There is no punctuation because the transcriber does not add it, and sentence
boundaries have to be inferred. Repetitions, restarts and self-corrections are
normal features of fluent speech and are frequently transcription artefacts
rather than the candidate's errors. Judge the English a listener would have
heard, not the typography. Do not count a missing comma, a run-on line or a
repeated word as a grammatical error.

WHAT YOU CAN AND CANNOT JUDGE:
You did not hear this student. Pronunciation and fluency are measured separately
from the audio by a speech assessor and are not yours to score — do not mention
pronunciation, accent, intonation, pace or hesitation anywhere. Judge what the
words show: grammar, vocabulary, coherence, and whether the task was done.

HOW TO ARRIVE AT THE SCORE:
Decide the band first, then the number inside it. Ask "is this A2, B1, B2 or C1
for this part?" and only then place it within that band. Choosing a band is a
judgement you can make reliably; choosing between 58 and 64 in the abstract is
not, and starting from the number is how marking drifts to the middle.

- 65-75  C1     - 51-64  B2     - 31-50  B1     - 16-30  A2     - 0-15  A1

Score this answer against what THIS PART can show. Part 1 tops out at B1 by
design, so an answer that does everything Part 1 asks is a strong answer and
should be scored as one, even though the task gives no room to demonstrate C1.
Do not mark an answer down for failing to show a level its own task never asked
for. The candidate's overall level is decided separately, across all parts
together — it is not your job here, and you must not hedge toward the middle in
anticipation of it.

REPLY WITH THIS JSON AND NOTHING ELSE:

{
  "score": (0-75),
  "criteria": {
    "grammar":    { "score": (0-75), "feedback": "one sentence, at most 20 words" },
    "vocabulary": { "score": (0-75), "feedback": "one sentence, at most 20 words" },
    "coherence":  { "score": (0-75), "feedback": "one sentence, at most 20 words" }
  },
  "suggestedLevel": "A1|A2|B1|B2|C1"
}

Keep each comment to one short sentence, quoting the candidate's own words where
it helps. This is per-answer detail only: the summary of the whole performance,
the candidate's strengths and what they should work on are written separately,
once, across every answer — so do not write them here. "suggestedLevel" must
agree with the band the score falls in. Never award more than 75.

${this.languageInstruction}
Mark as the official examiner would: neither severe nor generous.`;

    const user = `QUESTION: ${question}${
      instructions ? `\nInstructions the student was given: ${instructions}` : ''
    }${topic ? `\nTopic on screen: ${topic}` : ''}${
      pros?.length ? `\nArguments FOR shown to the student: ${pros.join('; ')}` : ''
    }${cons?.length ? `\nArguments AGAINST shown to the student: ${cons.join('; ')}` : ''}${
      followUpQuestions?.length ? `\nFollow-up questions: ${followUpQuestions.join(', ')}` : ''
    }${referenceImages?.length ? `\nThe student was shown ${referenceImages.length} picture(s). You cannot see them.` : ''}

THE STUDENT'S ANSWER (transcribed):
"${transcription}"`;

    return { cached, user, model: this.answerModel };
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

  /**
   * One call to the model.
   *
   * `prompt` may be a plain string, or `{ cached, user, model }` — where
   * `cached` is the part that does not change between calls.
   *
   * Why that split exists: marking a mock makes eight calls that share the same
   * examiner instructions, the same part brief and the same calibration samples,
   * and only differ in one question and one answer. Sent whole each time, the
   * identical prefix is paid for eight times over. Marked as cacheable it is
   * paid for once and read cheaply thereafter, which on an eight-answer attempt
   * is most of the input cost.
   *
   * The prefix must genuinely be identical to hit — hence it holds only what is
   * fixed for a part, and the question and the student's words go in the user
   * message where they belong.
   */
  async callClaudeAPIOnce(prompt) {
    const isSplit = prompt && typeof prompt === 'object';
    const userText = isSplit ? prompt.user : prompt;

    const payload = {
      // Per-call model override, so the cheap model can be tried on per-answer
      // feedback while the level itself stays on the better one.
      model: (isSplit && prompt.model) || this.model,
      max_tokens: this.maxTokens,
      messages: [
        {
          role: 'user',
          content: userText
        }
      ]
    };

    if (isSplit && prompt.cached) {
      payload.system = [
        {
          type: 'text',
          text: prompt.cached,
          // Below the model's minimum cacheable length this is simply ignored,
          // so there is nothing to guard against — it either helps or does not.
          cache_control: { type: 'ephemeral' }
        }
      ];
    }

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

      /*
       * What this call actually cost, in tokens.
       *
       * Logged because the bill was previously a matter of arithmetic and
       * guesswork — and because caching is invisible unless you look: a prefix
       * that stops matching goes on working and silently costs full price
       * again. `read` climbing while `wrote` stays flat is the cache doing its
       * job; `wrote` on every call means it is missing and worth investigating.
       */
      const usage = response.data?.usage;
      if (usage) {
        this.spend.calls += 1;
        this.spend.input += usage.input_tokens || 0;
        this.spend.output += usage.output_tokens || 0;
        this.spend.cacheWrite += usage.cache_creation_input_tokens || 0;
        this.spend.cacheRead += usage.cache_read_input_tokens || 0;
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

      /*
       * Two reply shapes go through this parser, and validating one against the
       * other is worse than not validating at all: the caller catches the error
       * and falls back to averaging, so a shape mismatch would not crash — it
       * would quietly undo the whole-performance marking and nobody would see
       * why the scores were low again.
       *
       *   whole-performance: { bands: {...}, ... }  — the criterion bands
       *   per-answer:        { score, criteria, overallFeedback }
       *
       * The shape is recognised by what it carries, not by a flag, because the
       * model decides what it sends and a flag it forgot would be worse than a
       * field it did.
       *
       * Note `!evaluation.score` would reject a legitimate score of 0 — which is
       * exactly what a silent or off-topic answer earns — so every check below
       * tests for the field being present, not truthy.
       */
      if (evaluation.bands !== undefined && evaluation.bands !== null) {
        if (typeof evaluation.bands !== 'object') {
          throw new Error(`bands came back as ${JSON.stringify(evaluation.bands)}, not an object`);
        }
        const usable = Object.values(evaluation.bands).some(
          band => typeof band === 'number' && !Number.isNaN(band)
        );
        if (!usable) throw new Error('the reply carried no numeric criterion band');
        return evaluation;
      }

      /*
       * `overallFeedback` is NOT required here, and removing it is the fix for
       * a bug that silently broke every per-answer mark.
       *
       * The per-answer reply used to carry its own summary, strengths and
       * improvements. Trimming that out halved the output tokens and removed
       * duplication with the whole-performance pass — but this validator went
       * on demanding a field the prompt had stopped asking for, so every answer
       * threw, every attempt reported "0 marked", and students watched
       * "Tekshirilmoqda…" that would never finish.
       *
       * What a per-answer reply must carry is a score and the criteria behind
       * it. Anything else is commentary, and commentary the model chose not to
       * write is not a reason to throw away a mark it did.
       */
      const missing = ['score', 'criteria'].filter(
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
