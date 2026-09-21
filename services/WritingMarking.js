/**
 * Marking a writing attempt, and presenting it.
 *
 * The order of operations is the whole design:
 *
 *   1. the marker awards each submitted part a band on its own scale
 *   2. corrections are located in the student's text (exact quotes only)
 *   3. the school's under-length rule forces a part to 0 where it applies
 *   4. the bands are summed and converted by the official writing table
 *   5. a partial submission is capped at B1 and gets no score out of 75
 *
 * Steps 3-5 are arithmetic and never involve the model.
 */

import WritingAttempt from '../models/WritingAttempt.js';
import User from '../models/User.js';
import AIEvaluationService from './AIEvaluationService.js';
import AICallLimiter from './MarkingQueue.js';
import { sendMail, emailConfigured } from './EmailService.js';
import {
  WRITING_PARTS,
  writingLabel,
  writingDescriptor,
  writingNextBand
} from '../content/writingCriteria.js';
import { writingTest, DEFAULT_MIN_WORDS } from '../content/writingTests.js';
import {
  countWords,
  lengthVerdict,
  locateCorrections,
  correctionSegments,
  scoreWriting
} from './WritingScoring.js';

/** The task, stimulus and word target for one part of an attempt. */
function partBrief(attempt, key) {
  if (attempt.mode === 'mock') {
    const test = writingTest(attempt.testId);
    const part = test?.parts?.[key] || {};
    return {
      task: part.task || '',
      // Parts 1.1 and 1.2 answer the same message; Part 2 answers none.
      stimulus: key === 'part2' ? '' : [test?.stimulus?.intro, test?.stimulus?.text].filter(Boolean).join('\n\n'),
      wordGuide: part.wordGuide || '',
      minWords: part.minWords || DEFAULT_MIN_WORDS[key]
    };
  }
  return {
    task: attempt.parts?.[key]?.question || '',
    stimulus: '',
    wordGuide: `at least ${DEFAULT_MIN_WORDS[key]} words`,
    minWords: DEFAULT_MIN_WORDS[key]
  };
}

/**
 * Mark one attempt. Safe to call again on a failed attempt — it starts over
 * from the student's texts, which are never modified.
 */
export async function markWritingAttempt(attemptId) {
  const attempt = await WritingAttempt.findById(attemptId);
  if (!attempt) return null;

  const keys = WRITING_PARTS.map(p => p.key).filter(k => attempt.submittedParts.includes(k));

  try {
    const parts = keys.map(key => {
      const text = attempt.parts[key].text || '';
      const words = countWords(text);
      const brief = partBrief(attempt, key);
      const verdict = lengthVerdict(key, words, brief.minWords);
      return {
        key,
        text,
        words,
        ...brief,
        underLength: { applied: verdict.zero, threshold: verdict.threshold }
      };
    });

    const verdict = await AICallLimiter.run(() =>
      AIEvaluationService.evaluateWriting({ parts, mode: attempt.mode })
    );

    const bands = {};
    for (const part of parts) {
      const marked = verdict.parts[part.key];
      const slot = attempt.parts[part.key];

      slot.words = part.words;
      slot.reasoning = marked.reasoning;
      slot.feedback = marked.feedback;
      slot.corrections = locateCorrections(part.text, marked.corrections);

      // The school's rule overrides the marker, but the marker's band is kept
      // so a teacher can see what the writing itself was worth.
      slot.underLength = {
        applied: part.underLength.applied,
        threshold: part.underLength.threshold,
        markerBand: marked.band
      };
      slot.band = part.underLength.applied ? 0 : marked.band;
      slot.label = writingLabel(part.key, slot.band);
      bands[part.key] = slot.band;
    }

    const outcome = scoreWriting(bands);

    attempt.complete = outcome.complete;
    attempt.expertMark = outcome.expertMark;
    attempt.score = outcome.score;
    attempt.level = outcome.level;
    attempt.overallFeedback = verdict.overallFeedback;
    attempt.strengths = verdict.strengths;
    attempt.areasForImprovement = verdict.areasForImprovement;
    attempt.status = 'completed';
    attempt.markedAt = new Date();
    attempt.failureReason = undefined;
    attempt.markModified('parts');
    await attempt.save();
  } catch (error) {
    console.error(`Writing attempt ${attemptId} could not be marked:`, error.message);
    attempt.status = 'failed';
    attempt.failureReason = error.message.slice(0, 500);
    await attempt.save();
    return attempt;
  }

  // Email is a courtesy on top of a finished result — it never un-finishes it.
  try {
    await emailResult(attempt);
  } catch (error) {
    console.error(`Writing attempt ${attemptId}: email failed:`, error.message);
    await WritingAttempt.updateOne(
      { _id: attempt._id },
      { $set: { emailError: error.message.slice(0, 300) } }
    );
  }

  return attempt;
}

// ------------------------------------------------------------ presentation

/**
 * The attempt as the student's screen needs it.
 *
 * Descriptors come from the official scale at read time rather than being
 * stored, so a student always reads the board's current wording next to the
 * band — the same rule the speaking result follows.
 */
export function presentWritingAttempt(attempt) {
  const a = attempt.toObject ? attempt.toObject() : attempt;
  const test = a.mode === 'mock' ? writingTest(a.testId) : null;

  const parts = WRITING_PARTS.map(meta => {
    const slot = a.parts?.[meta.key] || {};
    const marked = Number.isFinite(slot.band);
    const brief = partBrief(a, meta.key);

    return {
      key: meta.key,
      name: meta.name,
      description: meta.description,
      max: meta.max,
      submitted: (a.submittedParts || []).includes(meta.key),
      text: slot.text || '',
      question: slot.question || '',
      task: brief.task,
      wordGuide: brief.wordGuide,
      minWords: brief.minWords,
      words: slot.words || countWords(slot.text),
      band: marked ? slot.band : null,
      label: marked ? slot.label || writingLabel(meta.key, slot.band) : '',
      descriptor: marked ? writingDescriptor(meta.key, slot.band) : [],
      next: marked ? writingNextBand(meta.key, slot.band) : null,
      reasoning: slot.reasoning || '',
      feedback: slot.feedback || '',
      corrections: slot.corrections || [],
      segments: marked ? correctionSegments(slot.text, slot.corrections || []) : [],
      underLength: slot.underLength?.applied
        ? { threshold: slot.underLength.threshold, markerBand: slot.underLength.markerBand }
        : null
    };
  });

  return {
    id: String(a._id),
    mode: a.mode,
    testId: a.testId || null,
    title: a.mode === 'mock' ? a.testTitle || test?.title || 'Writing mock' : 'Writing check',
    status: a.status,
    startedAt: a.startedAt,
    deadline: a.deadline || null,
    submittedAt: a.submittedAt || null,
    markedAt: a.markedAt || null,
    complete: a.complete ?? null,
    expertMark: a.expertMark ?? null,
    score: a.score ?? null,
    level: a.level || null,
    overallFeedback: a.overallFeedback || '',
    strengths: a.strengths || [],
    areasForImprovement: a.areasForImprovement || [],
    failureReason: a.status === 'failed' ? a.failureReason || '' : '',
    creditCost: a.creditCost || 0,
    emailed: Boolean(a.emailedAt),
    parts
  };
}

// ------------------------------------------------------------------- email

const escapeHtml = value =>
  String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The marked script, mistakes struck through with the correction beside. */
function markedScriptHtml(segments) {
  return segments.map(seg =>
    seg.wrong !== undefined
      ? `<del style="color:#b42318;text-decoration:line-through">${escapeHtml(seg.wrong)}</del>` +
        ` <ins style="color:#067647;text-decoration:none;font-weight:600">${escapeHtml(seg.right)}</ins>`
      : escapeHtml(seg.text)
  ).join('').replace(/\n/g, '<br>');
}

export function writingEmail(view, student) {
  const appUrl = (process.env.APP_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
  const name = student?.firstName ? `, ${escapeHtml(student.firstName)}` : '';

  const headline = view.complete
    ? `${view.score} / 75 · ${escapeHtml(view.level)}`
    : `${escapeHtml(view.level)} (to'liq bo'lmagan topshiriq — eng ko'pi B1)`;

  const parts = view.parts.filter(p => p.submitted && p.band !== null).map(p => `
    <h3 style="margin:28px 0 4px;font-size:17px">${escapeHtml(p.name)} — ${p.band} / ${p.max}
      <span style="font-weight:400;color:#555">· ${escapeHtml(p.label)}</span></h3>
    ${p.task ? `<p style="margin:0 0 10px;color:#555;font-size:13px">${escapeHtml(p.task)}</p>` : ''}
    ${p.underLength
      ? `<p style="margin:0 0 10px;color:#b42318;font-size:13px">So'zlar soni ${p.words} ta — ${p.underLength.threshold} tadan kam bo'lgani uchun bu qism 0 ball oldi.</p>`
      : ''}
    <div style="padding:14px 16px;border:1px solid #ddd;border-radius:8px;line-height:1.7;font-size:15px">
      ${markedScriptHtml(p.segments)}
    </div>
    ${p.corrections.length
      ? `<ol style="margin:10px 0 0;padding-left:20px;font-size:13px;color:#333">
           ${p.corrections.map(c =>
             `<li><del style="color:#b42318">${escapeHtml(c.wrong)}</del> → <strong style="color:#067647">${escapeHtml(c.right)}</strong>${c.why ? ` — ${escapeHtml(c.why)}` : ''}</li>`
           ).join('')}
         </ol>`
      : ''}
    ${p.feedback ? `<p style="margin:10px 0 0">${escapeHtml(p.feedback)}</p>` : ''}`).join('');

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#111">
    <p>Assalomu alaykum${name}!</p>
    <p>Yozma ishingiz tekshirildi: <strong>${escapeHtml(view.title)}</strong></p>
    <p style="font-size:22px;margin:12px 0"><strong>${headline}</strong></p>
    ${view.overallFeedback ? `<p>${escapeHtml(view.overallFeedback)}</p>` : ''}
    ${parts}
    <p style="margin-top:28px;font-size:13px;color:#555">
      <del style="color:#b42318">Qizil</del> — xato, <strong style="color:#067647">yashil</strong> — to'g'ri varianti.
      ${appUrl ? `<br>Natijani saytda ko'rish: <a href="${appUrl}/?writing=${view.id}">${appUrl}</a>` : ''}
    </p>
  </div>`;

  const text = [
    `Yozma ishingiz tekshirildi: ${view.title}`,
    view.complete ? `${view.score} / 75 · ${view.level}` : view.level,
    '',
    ...view.parts.filter(p => p.submitted && p.band !== null).flatMap(p => [
      `${p.name}: ${p.band} / ${p.max} (${p.label})`,
      ...p.corrections.map(c => `  ${c.wrong} -> ${c.right}${c.why ? ` (${c.why})` : ''}`),
      ''
    ])
  ].join('\n');

  const subject = view.complete
    ? `Yozma ish natijasi: ${view.score}/75 · ${view.level}`
    : `Yozma ish natijasi: ${view.level}`;

  return { subject, html, text };
}

async function emailResult(attempt) {
  if (!emailConfigured()) return;
  const student = await User.findById(attempt.student).select('email firstName');
  if (!student?.email) return;

  const view = presentWritingAttempt(attempt);
  const { subject, html, text } = writingEmail(view, student);
  const outcome = await sendMail({ to: student.email, subject, html, text });

  if (outcome.sent) {
    await WritingAttempt.updateOne(
      { _id: attempt._id },
      { $set: { emailedAt: new Date() }, $unset: { emailError: 1 } }
    );
  }
}

export default { markWritingAttempt, presentWritingAttempt, writingEmail };
