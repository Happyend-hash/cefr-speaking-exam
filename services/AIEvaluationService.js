import axios from 'axios';

// The bands live in one place so the score always means the same thing.
import { CEFR_BANDS, levelForScore, MAX_SCORE, BELOW_B1 } from '../models/ExamResult.js';
import { SPEAKING_PROMPT_BLOCK, SPEAKING_PART_KEYS } from '../content/speakingRubric.js';
import { SPEAKING_PART_MAX } from './ScoreConversion.js';
import { scoreSpeaking } from './SpeakingScoring.js';
import { WRITING_PARTS, WRITING_PROMPT_BLOCK } from '../content/writingCriteria.js';
import { WRITING_EXAMINER_METHOD, WRITING_OFFICIAL_SAMPLES } from '../content/writingExaminerGuide.js';
import { describeForMarker } from './FluencyService.js';

// Smallest output budget for the whole-performance verdict, whatever
// CLAUDE_MAX_TOKENS says (see evaluateAttempt).
const OVERALL_MIN_TOKENS = 16000;
// Ceiling a cut-off reply's budget is doubled up to before giving up (see
// callClaudeAPI). Kept within what current models accept on a
// non-streaming request.
const MAX_TOKENS_CEILING = 32000;

// The agency's 0-75 bands, written out for the per-answer prompt from the one
// table in models/ExamResult.js, so the prompt can never drift from the
// boundaries the score is read against.
const bandMin = level => CEFR_BANDS.find(b => b.level === level).min;
const B1_FLOOR = bandMin('B1');
const B2_FLOOR = bandMin('B2');
const OFFICIAL_SCALE = CEFR_BANDS
  .map((band, i) => {
    const top = i === 0 ? MAX_SCORE : CEFR_BANDS[i - 1].min - 1;
    return `- ${band.min}-${top}  ${band.level === BELOW_B1 ? 'below B1' : band.level}`;
  })
  .join('     ');

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
          suggestedLevel: BELOW_B1
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
      return this.onOfficialScale(this.parseEvaluation(response));
    } catch (error) {
      console.error('Error in evaluateTask:', error);
      throw new Error(`AI Evaluation failed: ${error.message}`);
    }
  }

  /**
   * Hold a per-answer reply to the agency's 0-75 scale.
   *
   * These scores are what the backup mark averages when the whole-performance
   * pass fails, so they must mean what the agency's table means. A score past
   * 75 would push an average past the scale's own ceiling, and the model's
   * "suggestedLevel" is not trusted for the same reason the overall level is
   * not: the level comes from the score by the published table, never from the
   * model's own idea of where the boundaries are.
   */
  onOfficialScale(evaluation) {
    const clamp = value => Math.max(0, Math.min(MAX_SCORE, Math.round(value)));
    const score = clamp(evaluation.score);

    const criteria = {};
    for (const [name, criterion] of Object.entries(evaluation.criteria || {})) {
      criteria[name] = criterion && typeof criterion.score === 'number' && !Number.isNaN(criterion.score)
        ? { ...criterion, score: clamp(criterion.score) }
        : criterion;
    }

    return { ...evaluation, score, criteria, suggestedLevel: levelForScore(score) };
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
      const bands = SPEAKING_PART_KEYS
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

  async evaluateAttempt({ answers, examTitle, pronunciation = null, fluency = null, anchors = [] }) {
    const byPart = answers.reduce((groups, answer) => {
      (groups[answer.part] ||= []).push(answer);
      return groups;
    }, {});

    const transcript = Object.entries(byPart)
      .map(([part, group]) => `
=== PART ${part} ===
${group.map(a => `Q: ${a.question}\nA: "${a.transcription}"${
      a.fluency ? `\n[recording: ${describeForMarker(a.fluency)}]` : ''
    }`).join('\n\n')}`)
      .join('\n');

    const cached = `You are an expert examiner for the O'zbekiston Multilevel English speaking exam.
You award each of the four parts ONE holistic band on that part's own official
scale.

HOW THIS EXAM IS MARKED — this is the school's own method:
Each part is judged separately, against its OWN scale and its OWN ceiling. Part
1.1 tops out at "Above A2", Part 3 at "Above C1" — the parts are not equal
slices of one bigger scale, they are four different rulers. Do not compare one
part against another and do not let a strong Part 3 pull up a weak Part 1.1 or
the reverse; each is scored purely on what it shows.

HOW TO AWARD A BAND:
- The band is HOLISTIC. Each descriptor names several things together — what
  the candidate can do, grammar, vocabulary, fluency and hesitation, how ideas
  connect, and pronunciation — and you weigh them into the ONE band whose
  description fits the performance best overall. Do not score them separately
  and average.
- PART 1.2 SPECIFICALLY: weigh fluency and the ability to form sentences
  naturally above grammar and vocabulary precision. A candidate who speaks
  naturally and constructs sentences, even with frequent grammar or
  vocabulary errors, should not be pulled down to a lower band for those
  errors alone — count grammar or vocabulary against the band only when it
  is severe enough to actually get in the way of understanding what the
  candidate means, not merely imperfect. This is the school's own priority
  for this part; the other three parts are unaffected.
- CALIBRATION FLOORS (Jamshid's instruction, 2026-09-29), for Part 1.2, Part 2
  and Part 3 — the parts whose own scale reaches B1 and above (Part 1.1's
  ceiling never reaches B1, so this bullet does not apply to it): if the
  candidate is understandable overall and their mistakes are minor — the kind
  that do not get in the way of following what they mean — that alone reaches
  at least this part's first B1-level band (Part 1.2's "Lower B1", Part 2 or
  Part 3's "B1"). Do not hold a performance like that down at an A2-level band
  just for imprecise grammar or vocabulary. Beyond that: a candidate who
  builds sentences using a decent range of structures and speaks fluently —
  without significant pausing or hesitation, meaning their recording is not
  in the lower "frequent pausing" range given below — reaches at least this part's
  first B2-level band (Part 2 or Part 3's "Lower B2"). Do not require
  near-flawless grammar to keep such a candidate out of B2 once the
  structures and the fluency are genuinely there.
- Use the whole scale. A performance that matches the top descriptor gets the
  top band; hedging toward the middle for safety is a marking error.
- A performance that is memorised, largely off-topic, or mostly in another
  language is band 0 or 1, as the scales say.

THE OFFICIAL RATING SCALES — award bands against these words exactly:

${SPEAKING_PROMPT_BLOCK}
${this.buildAnchorBlock(anchors)}

YOU ARE READING AUTOMATIC TRANSCRIPTION OF SPEECH:
No punctuation, inferred sentence boundaries, and repetitions or restarts that
are normal in speech and often artefacts of transcription rather than errors.
Judge the English a listener would have heard.

Hesitation sounds are written down on purpose: "um", "uh", "erm", "eee",
"mmm". They are evidence about fluency, never grammar or vocabulary errors.

FLUENCY IS JUDGED FROM THE RECORDING, NOT THE TEXT:
A transcript is clean — a four-second silence leaves no trace in it. So every
answer below carries a [recording: …] line measured from its full audio:

- words/min: pace across the time the candidate was speaking, pauses included
- pauses ≥1s: silences a listener notices (normal between ideas in exam
  speech); only long, repeated ones strain the listener; the longest is named
- silent %: share of the speaking time spent silent between words
- fillers: "um", "eee", "mmm" and similar, counted
- repeats: immediate restarts such as "I I think"
- started after: silence before the first word

Read them against each part's own fluency/hesitation sentence — "frequent
pauses, repetition or reformulation", "occasional hesitation", "speech is
fluent and sustained". These candidates are non-native speakers answering
exam questions on the spot, and real examiners expect thinking time: a
one-second pause at the end of a clause is normal speech, not hesitation.
As a guide (Jamshid's calibration, 2026-10-04 — the earlier, stricter figures
were marking candidates below their real exam results), taken over the answers
that carry most of the speaking (Part 2 and Part 3 matter most):

- Frequent pausing that strains the listener (the lower bands): under ~55
  words/min, OR 10+ pauses ≥1s per minute, OR pauses of 4s+ again and again,
  OR 15+ fillers per minute.
- Some hesitation (middle bands): roughly 55-85 words/min, 6-9 pauses ≥1s per
  minute, fillers fairly frequent.
- Pausing that does not strain the listener (upper bands): above ~85
  words/min, up to ~5 pauses ≥1s per minute, no repeated pauses over ~3s,
  fillers occasional.

These are guides, not a formula: a thoughtful pause before a complex idea is
not the same as stalling mid-sentence, and a candidate who answers briefly but
without hesitation is fluent. Fluency is ONE of the things each band weighs —
alongside range, accuracy, coherence and pronunciation — never the deciding
factor on its own. Use the measurements to settle the fluency sentence of the
descriptor, and only let them lower a band when they show pausing clearly in
the lower range above; even then, fluency alone moves a part down by at most
one band from what the language itself shows. Middle-range figures do not
lower a band at all.

PRONUNCIATION IS MEASURED, NOT GUESSED:
A transcript cannot hear an accent. Where measured figures are supplied below,
each part's pronunciation sentence must follow them, not your impression of the
spelling. The same measurement applies across every part — it was sampled from
the whole attempt, not answer by answer.

A PART WITH NO EVIDENCE AT ALL gets null, not a band. This only happens in
practice mode, where one part is drilled at a time — a full mock always has
transcript evidence for all four. Do not return null just because pronunciation
or fluency could not be measured; the part still has a transcript, still gets
one band, and the measurements simply do not move that band as far as they
otherwise would.

Reply with JSON only:
{
  "bands": {
${Object.entries(SPEAKING_PART_MAX).map(([key, max]) => `    "${key}": 0-${max}`).join(',\n')}
  },
  "reasoning": "Which sentence of which part's descriptor decided each band, in one or two sentences",
  "overallFeedback": "What the candidate does well and what holds them back, addressed to them",
  "strengths": ["...", "...", "..."],
  "areasForImprovement": ["...", "...", "..."]
}

${this.languageInstruction}
Award the bands the official examiner would: neither severe nor generous. Do not
hedge toward the middle for safety — a performance that matches the top
descriptor gets the top band, and marking it down to be cautious is a marking
error, not caution.`;

    const measured = pronunciation?.assessed
      ? `\n\nMEASURED PRONUNCIATION (Azure AI Speech, 0-100, from the candidate's actual audio):
accuracy ${Math.round(pronunciation.accuracy ?? 0)}, Azure fluency ${Math.round(pronunciation.fluency ?? 0)} (lenient: sampled from about one minute and blind to fillers — for fluency, the [recording] measurements above outrank it)${
          Number.isFinite(pronunciation.prosody) ? `, prosody ${Math.round(pronunciation.prosody)}` : ''
        }, overall ${Math.round(pronunciation.overall ?? 0)}${
          pronunciation.problemWords?.length
            ? `\nWords mispronounced: ${pronunciation.problemWords.slice(0, 8).map(w => w.word).join(', ')}`
            : ''
        }
Use these for every part's pronunciation sentence, read against its descriptor.
As a guide: accuracy 80+ supports the top pronunciation sentences ("intelligible",
"no strain on the listener"); 60-79 supports the middle ones ("occasional
strain", "mispronunciations noticeable but do not impede understanding"); below
60 supports the lower ones ("mispronunciations put a strain on the listener",
"strong native-language influence"). ACCURACY MEASURES PHONEMES, NOT
CONFIDENCE — a fast, fluent, confident speaker can still mispronounce heavily,
and that combination (high fluency, low accuracy) is real evidence of a
genuine pronunciation weakness, not a reason to look past the accuracy number.
Do not let a smooth-reading transcript or a high fluency figure talk you into
a higher pronunciation sentence than the accuracy score and the mispronounced
words support.${
          pronunciation.accuracySuspect
            ? `

WARNING — THE ACCURACY FIGURE ABOVE IS UNRELIABLE FOR THIS ATTEMPT.
It sits far below fluency and prosody in a way that only happens when the
measurement itself failed (a scripted assessment scored against a flawed
transcript) — not from ordinary variation in a speaker. Judge pronunciation on
fluency and prosody, and on the words listed as mispronounced if any. Do not
mark the candidate down for the accuracy number.`
            : ''
        }`
      : `\n\nNo pronunciation measurement is available for this attempt. Judge
pronunciation from the transcript alone, as an examiner without audio would —
do not return null for it; only a part with no evidence at all gets null.`;

    const measuredFluency = fluency?.measured
      ? `\n\nFLUENCY ACROSS THE WHOLE ATTEMPT (measured from ${fluency.answers} recordings, ${Math.round(fluency.speakingSec)}s of speaking):
${fluency.wordsPerMin} words/min; ${fluency.longPausesPerMin} pauses ≥1s per minute (${fluency.longPauses} in all, ${fluency.veryLongPauses} of them ≥2s, longest ${fluency.longestPauseSec}s); silent ${fluency.pauseRatio}% of speaking time; ${fluency.fillersPerMin} fillers per minute (${fluency.fillers} in all); ${fluency.repeats} repeats${fluency.slowStarts ? `; ${fluency.slowStarts} answer(s) started only after 3s+ of silence` : ''}.`
      : '';

    const user = `${examTitle ? `Exam: ${examTitle}\n\n` : ''}THE CANDIDATE'S FULL PERFORMANCE:
${transcript}${measured}${measuredFluency}`;

    // The longest reply of all — every part's band and reasoning, plus the
    // model's own thinking, which is billed against the same budget. On the
    // shared CLAUDE_MAX_TOKENS (2000 in production) the thinking alone used it
    // up and the attempt fell back to averaging. Unused budget costs nothing.
    const response = await this.callClaudeAPI({
      cached,
      user,
      maxTokens: Math.max(this.maxTokens, OVERALL_MIN_TOKENS)
    });
    const verdict = this.parseEvaluation(response);

    const bands = {};
    for (const [key, max] of Object.entries(SPEAKING_PART_MAX)) {
      const awarded = verdict.bands?.[key];

      /*
       * A band the marker could not award stays ABSENT rather than becoming a
       * zero. Zero is a real judgement on this scale — worse than band 1 — and
       * must never stand in for "unknown". This only happens for a part with
       * no evidence at all (practice mode); a full mock always has all four.
       *
       * The emptiness is tested before the conversion to a number, because
       * Number(null) is 0 and Number('') is 0.
       */
      if (awarded === null || awarded === undefined || awarded === '') continue;

      const band = Number(awarded);
      if (!Number.isFinite(band)) continue;
      bands[key] = Math.max(0, Math.min(max, Math.round(band)));
    }

    const outcome = scoreSpeaking(bands);
    if (!outcome) {
      throw new Error('Overall marking returned no usable part bands');
    }

    return {
      bands,
      // The school's table is the authority on both numbers, so neither is
      // taken from the model: the bands convert to a mark and a score, and the
      // score determines the level. The marker's own arithmetic is never
      // trusted, which is why it is no longer asked for any.
      raw: outcome.expertMark,
      complete: outcome.complete,
      score: outcome.score,
      level: outcome.level,
      reasoning: verdict.reasoning || '',
      overallFeedback: verdict.overallFeedback || '',
      strengths: verdict.strengths || [],
      areasForImprovement: verdict.areasForImprovement || []
    };
  }

  /**
   * Mark a writing attempt: one band per part, on the board's own scales.
   *
   * One call for all submitted parts. The parts are judged separately — each
   * has its own scale and its own descriptors — but reading them together lets
   * the marker write one summary, and one call on three short texts costs a
   * fraction of three.
   *
   * The marker returns bands and corrections. It does NOT return a score or a
   * level: the sum, the conversion and the level all come from the agency's
   * tables in WritingScoring.js, for the same reason as speaking — the model's
   * arithmetic is never trusted with a published table.
   *
   * @param {Array} parts  [{ key, text, words, task, stimulus, wordGuide,
   *                          minWords, underLength }]
   * @param {string} mode  'mock' | 'check'
   */
  async evaluateWriting({ parts, mode = 'mock' }) {
    const cached = `You are an expert examiner for the O'zbekiston Multilevel English WRITING exam.
You award each part ONE holistic band on that part's official scale, and you
mark the student's mistakes in-line so they can learn from them.

THE OFFICIAL RATING SCALES — award bands against these words exactly:

${WRITING_PROMPT_BLOCK}

HOW TO AWARD A BAND:
- Each part is judged on its OWN scale, against its OWN task. Parts 1.1 and
  1.2 are 0-5; Part 2 is 0-6. Never compare one part with another.
- The band is HOLISTIC. Each descriptor names task fulfilment, register or
  genre, grammar, vocabulary, cohesion, and spelling/punctuation. Weigh them
  together into the one band whose description fits the text best overall.
  Do not score them separately and average.
- Register matters: Part 1.1 is informal (to a friend), Part 1.2 is formal (to
  a manager or official), Part 2 is a blog post, article or forum post whose
  tone should suit publication.
- Use the whole scale. A text that matches the top descriptor gets the top
  band; hedging toward the middle for safety is a marking error.

${WRITING_EXAMINER_METHOD}

${WRITING_OFFICIAL_SAMPLES}

LENGTH:
Each part tells you its word count and required length. Where a part is
marked "UNDER LENGTH", the official scale caps its band (Parts 1.2 and 2:
under 50% of the required length, band 2 at most; under 25%, band 1 at most).
Still award the band the writing itself deserves and still correct it — the
cap is applied afterwards, not by you. Over length is not penalised by itself.

IN-LINE CORRECTIONS:
For each part, list the clear mistakes: grammar, word choice, spelling, and
punctuation that changes meaning or reads as an error.
- "wrong" MUST be copied EXACTLY from the student's text — same letters, same
  case, same punctuation — and be the SMALLEST span that contains the mistake
  (usually one to four words). It is located by exact search; anything not
  copied exactly is thrown away.
- "right" is the corrected English for exactly that span.
- "why" is a short reason, a few words.
- List corrections in the order they appear in the text.
- Correct ERRORS only. Do not rewrite correct sentences into your preferred
  style, and accept both British and American spelling.
- At most 12 corrections per part; if there are more, keep the most important.
- Corrections are teaching feedback. They must NOT decide the band — the band
  comes from the descriptors, holistically, as above.

${mode === 'check'
  ? `THIS IS A CHECK OF WORK THE STUDENT WROTE IN ADVANCE.
If a part comes with its task, judge whether the text answers that task. If no
task is given, judge the language, organisation and register for the kind of
text it is, do not lower the band for task fulfilment you cannot check, and
say in "reasoning" that task fulfilment could not be judged.`
  : 'THIS IS A TIMED MOCK: 60 minutes for all parts, typed, paste disabled.'}

Reply with JSON only, in exactly this shape, including only the parts supplied:
{
  "parts": {
    "part11": {
      "band": 0-5,
      "reasoning": "The evidence for this band, and what keeps it out of the band above (step 5) — two or three sentences",
      "feedback": "What to do to reach the next band — one or two sentences, to the student",
      "corrections": [ { "wrong": "exact words from the text", "right": "corrected words", "why": "short reason" } ]
    },
    "part12": { "band": 0-5, "reasoning": "...", "feedback": "...", "corrections": [] },
    "part2":  { "band": 0-6, "reasoning": "...", "feedback": "...", "corrections": [] }
  },
  "overallFeedback": "Two or three sentences on the writing as a whole, to the student",
  "strengths": ["...", "..."],
  "areasForImprovement": ["...", "..."]
}
${this.languageInstruction}
In this reply that means "reasoning", "feedback", "why", "overallFeedback",
"strengths" and "areasForImprovement" are in that language, while "wrong" and
"right" are ALWAYS English — they are the student's English and its correction.`;

    const byKey = Object.fromEntries(WRITING_PARTS.map(p => [p.key, p]));
    const fence = '"""';

    const user = parts.map(part => {
      const meta = byKey[part.key];
      const lines = [`=== ${meta.name} — ${meta.description} [${part.key}], scale 0-${meta.max} ===`];
      if (part.stimulus) lines.push(`The message the candidate is replying to:\n${fence}\n${part.stimulus}\n${fence}`);
      lines.push(part.task ? `TASK: ${part.task}` : 'TASK: not given by the student.');
      if (part.wordGuide) lines.push(`Recommended length: ${part.wordGuide}`);
      lines.push(`Word count: ${part.words}`);
      if (part.underLength?.applied) {
        lines.push(`UNDER LENGTH: under ${part.underLength.threshold} words, so the official scale allows band ${part.underLength.cap} at most.`);
      }
      lines.push(`THE CANDIDATE'S TEXT:\n${fence}\n${part.text}\n${fence}`);
      return lines.join('\n');
    }).join('\n\n');

    const response = await this.callClaudeAPI({
      cached,
      user,
      maxTokens: Math.max(this.maxTokens, 6000)
    });
    return this.parseWritingEvaluation(response, parts.map(p => p.key));
  }

  /**
   * Read the writing marker's reply.
   *
   * A band outside a part's scale is clamped rather than rejected — 6 on a
   * 0-5 part is the marker saying "the top", and the top is what it means.
   * A part with no numeric band is an error: a part that was handed in and
   * not marked must fail loudly, never quietly become a zero.
   */
  parseWritingEvaluation(responseText, expectedKeys = []) {
    if (typeof responseText !== 'string' || !responseText.trim()) {
      throw new Error('Failed to parse writing evaluation: the model returned no text');
    }
    const match = responseText.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(
        `Failed to parse writing evaluation: no JSON in the reply (starts: "${responseText.slice(0, 120)}…")`
      );
    }

    let data;
    try {
      data = JSON.parse(match[0]);
    } catch (error) {
      throw new Error(`Failed to parse writing evaluation: ${error.message}`);
    }

    const maxFor = Object.fromEntries(WRITING_PARTS.map(p => [p.key, p.max]));
    const parts = {};

    for (const key of expectedKeys) {
      const raw = data?.parts?.[key];
      const awarded = raw?.band;
      if (awarded === null || awarded === undefined || awarded === '' || !Number.isFinite(Number(awarded))) {
        throw new Error(`Failed to parse writing evaluation: no band for ${key}`);
      }
      parts[key] = {
        band: Math.max(0, Math.min(maxFor[key], Math.round(Number(awarded)))),
        reasoning: String(raw.reasoning || ''),
        feedback: String(raw.feedback || ''),
        corrections: Array.isArray(raw.corrections) ? raw.corrections.slice(0, 12) : []
      };
    }

    const list = value => (Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 5) : []);

    return {
      parts,
      overallFeedback: String(data?.overallFeedback || ''),
      strengths: list(data?.strengths),
      areasForImprovement: list(data?.areasForImprovement)
    };
  }

  /**
   * LEGACY — the old flat writing module (Exam documents with module
   * 'writing'), which scored each criterion 0-75 and is not the official
   * method. Superseded by evaluateWriting above; kept only so attempts made
   * through the old path can still be re-marked.
   *
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
             'internal coherence and detail, not on whether it matches an image you cannot see. ' +
             'The school\'s priority for this part is fluency and the ability to form sentences ' +
             'naturally, not grammatical precision: when scoring the grammar and vocabulary ' +
             'criteria below, frequent errors are expected and should not pull the score down on ' +
             'their own — only mark grammar or vocabulary down when the errors are severe enough ' +
             'to actually obscure the candidate\'s meaning, not merely when they are imperfect.',
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
repeated word as a grammatical error. Hesitation sounds ("um", "uh", "erm",
"eee", "mmm") are written down on purpose for the fluency measurement; they
are never grammar or vocabulary errors.

WHAT YOU CAN AND CANNOT JUDGE:
You did not hear this student. Pronunciation and fluency are measured separately
from the audio by a speech assessor and are not yours to score — do not mention
pronunciation, accent, intonation, pace or hesitation anywhere. Judge what the
words show: grammar, vocabulary, coherence, and whether the task was done.

HOW TO ARRIVE AT THE SCORE:
Decide the band first, then the number inside it. Ask "is this below B1, B1,
B2 or C1 for this part?" and only then place it within that band. Choosing a
band is a judgement you can make reliably; choosing between 58 and 64 in the
abstract is not, and starting from the number is how marking drifts to the
middle.

${OFFICIAL_SCALE}
There is no A2 or A1 in this exam: anything under ${B1_FLOOR} is simply below B1.

Score this answer against what THIS PART can show. Part 1 tops out at B1 by
design, so an answer that does everything Part 1 asks is a strong answer and
should be scored as one, even though the task gives no room to demonstrate C1.
Do not mark an answer down for failing to show a level its own task never asked
for.

CALIBRATION FLOOR (Jamshid's instruction, 2026-09-29): if the answer is
understandable overall and its mistakes are minor — the kind that do not get
in the way of following what the candidate means — that alone should keep it
at least in the B1 band (${B1_FLOOR}-${B2_FLOOR - 1}), not pulled down below B1 for
imprecise grammar or vocabulary on its own. This is a grammar/vocabulary/coherence judgement
only — you are not scoring fluency or hesitation here (see above), so it does
not move an answer into B2 on its own; a confident, structurally solid answer
that also sounds fluent is scored on its merits and can reach B2 or above the
normal way, through the criteria you do judge.

The candidate's overall level is decided separately, across all parts
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
  "suggestedLevel": "below B1|B1|B2|C1"
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
      // Cut off by the output budget: the same request would be cut off the
      // same way, so ask again with twice the room, up to the ceiling. Not
      // counted against the retry attempts — it is a different request.
      if (error.truncated) {
        const isSplit = prompt && typeof prompt === 'object';
        const budget = (isSplit && prompt.maxTokens) || this.maxTokens;
        if (budget >= MAX_TOKENS_CEILING) throw error;
        const larger = Math.min(MAX_TOKENS_CEILING, budget * 2);
        console.warn(`Claude reply cut off at max_tokens ${budget}; retrying with ${larger}`);
        return this.callClaudeAPI({ ...(isSplit ? prompt : { user: prompt }), maxTokens: larger }, attempt);
      }

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
      // A call may need more room than the default — writing marking returns
      // three parts' corrections in one reply, and a reply cut off mid-JSON
      // is a reply with nothing in it.
      max_tokens: (isSplit && prompt.maxTokens) || this.maxTokens,
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

      const stop = response.data?.stop_reason;
      const usage = response.data?.usage;

      /*
       * What this call actually cost, in tokens.
       *
       * Logged because the bill was previously a matter of arithmetic and
       * guesswork — and because caching is invisible unless you look: a prefix
       * that stops matching goes on working and silently costs full price
       * again. `read` climbing while `wrote` stays flat is the cache doing its
       * job; `wrote` on every call means it is missing and worth investigating.
       *
       * Counted before the checks below: a cut-off reply is still billed.
       */
      if (usage) {
        this.spend.calls += 1;
        this.spend.input += usage.input_tokens || 0;
        this.spend.output += usage.output_tokens || 0;
        this.spend.cacheWrite += usage.cache_creation_input_tokens || 0;
        this.spend.cacheRead += usage.cache_read_input_tokens || 0;
      }

      // Cut off by the output budget — with no text at all (thinking used it
      // up), or with JSON that stops mid-way and would fail to parse. Either
      // way it is flagged so callClaudeAPI asks again with more room.
      if (stop === 'max_tokens') {
        const kinds = blocks.map(b => b?.type || 'unknown').join(', ') || 'none';
        const truncated = new Error(
          `the reply was cut off at max_tokens ${payload.max_tokens} (blocks: ${kinds})`
        );
        truncated.truncated = true;
        throw truncated;
      }

      if (!text) {
        const kinds = blocks.map(b => b?.type || 'unknown').join(', ') || 'none';
        throw new Error(`the API returned no text to read (blocks: ${kinds}; stop_reason: ${stop || 'unknown'})`);
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
- "suggestedLevel", which is a level code ("below B1", B1, B2 or C1).

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
