import { spawn } from 'child_process';

/**
 * Fluency, measured from the recording itself.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three things hid hesitation from the marker, and each one alone was enough
 * to make fluency marks generous:
 *
 *   1. The transcript is clean text. A four-second silence and a stretch of
 *      "ummm" both vanish when speech becomes words, and the marker judged
 *      "nutq ravonligi" from that text.
 *   2. Azure assessed about one minute of a seven-minute mock — the two
 *      longest answers, each cut to 28 seconds. Hesitation anywhere else was
 *      never measured.
 *   3. Azure's recogniser strips filled pauses before scoring, so a speaker
 *      who says "umm" between every phrase can still get a high fluency score.
 *
 * So fluency is now measured locally, on EVERY answer, in full:
 *
 *   - silent pauses — from the audio's loudness over time, frame by frame
 *   - speech rate  — words per minute of the time the student was talking
 *   - fillers      — "um", "uh", "erm", "eee", "mmm" in the transcript
 *   - repeats      — "I I think", "the the", a sign of restarts
 *
 * It costs nothing (ffmpeg and arithmetic, no paid service) and takes well
 * under a second per answer.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It cannot hear the difference between a long "ummm" and a word — both are
 * sound. Filled pauses are caught only when the transcript writes them down,
 * which is why the transcription is asked to keep them (TranscriptionService).
 * Background voices in a noisy room count as speech, so a pause filled by
 * someone else's talking is missed: the measurement errs lenient, never harsh.
 */

// ---------------------------------------------------------------- tuning

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 320 samples

/** Gaps shorter than this are the spaces inside and between words, not pauses. */
const MIN_PAUSE_S = 0.25;
/** A pause a listener notices. */
const LONG_PAUSE_S = 1.0;
/** A pause that strains the listener. */
const VERY_LONG_PAUSE_S = 2.0;
/** A voiced blip shorter than this is a click or a breath, not speech. */
const MIN_VOICED_S = 0.1;

/**
 * Fillers as the transcriber writes them, including the drawn-out "eee" and
 * "mmm" Uzbek speakers use. Kept to sounds that are never English words, so
 * "like", "so", "well" and "you know" are deliberately NOT counted — they are
 * often used correctly, and marking them would punish natural speech.
 */
const FILLER = /^(u+m+|u+h+m*|e+r+m*|e+r+|h+m+|m{2,}|a+h+|a{2,}|e+h+|e{2,}|e+m+|u{2,})$/i;

// ----------------------------------------------------------------- audio

/** Decode any browser recording to 16 kHz mono 16-bit PCM samples. */
export function decodeToPcm(buffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-f', 's16le',
      'pipe:1'
    ]);
    const chunks = [];
    const errors = [];
    ffmpeg.stdout.on('data', c => chunks.push(c));
    ffmpeg.stderr.on('data', c => errors.push(c));
    ffmpeg.on('error', error => reject(new Error(
      error.code === 'ENOENT' ? 'ffmpeg is not installed' : `ffmpeg failed: ${error.message}`
    )));
    ffmpeg.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errors).toString().trim()}`));
      const raw = Buffer.concat(chunks);
      resolve(new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2)));
    });
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stdin.end(buffer);
  });
}

const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : 0;

/**
 * Where the student was speaking, from loudness alone.
 *
 * The threshold adapts to each recording rather than being a fixed decibel
 * level: a phone in a quiet bedroom and a laptop in a classroom have very
 * different floors, and a fixed line would call one all-silence and the other
 * all-speech. The quiet end of the recording (10th percentile) is taken as the
 * room, the loud end (95th) as the voice, and speech is anything a quarter of
 * the way from one to the other.
 *
 * @returns {{ segments: Array<[number, number]>, duration: number, reliable: boolean }}
 *          voiced segments in seconds
 */
export function findSpeech(samples) {
  const frames = Math.floor(samples.length / FRAME);
  const duration = samples.length / SAMPLE_RATE;
  if (frames < 5) return { segments: [], duration, reliable: false };

  const db = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / FRAME);
    db[f] = 20 * Math.log10(Math.max(rms, 1) / 32768);
  }

  const sorted = Array.from(db).sort((a, b) => a - b);
  const floor = percentile(sorted, 0.1);
  const peak = percentile(sorted, 0.95);
  const range = peak - floor;

  // Under 10 dB between the room and the loudest speech means there is no
  // clear voice in the recording — measuring pauses in it would be noise.
  if (range < 10) return { segments: [], duration, reliable: false };

  const threshold = floor + Math.max(6, range * 0.25);

  const raw = [];
  let start = null;
  for (let f = 0; f < frames; f++) {
    const voiced = db[f] >= threshold;
    if (voiced && start === null) start = f;
    if (!voiced && start !== null) { raw.push([start, f]); start = null; }
  }
  if (start !== null) raw.push([start, frames]);

  const toS = f => (f * FRAME_MS) / 1000;

  // Join voiced runs separated by less than a real pause (stop consonants and
  // word boundaries are silent for a moment), then drop clicks.
  const merged = [];
  for (const [a, b] of raw) {
    const last = merged[merged.length - 1];
    if (last && toS(a) - toS(last[1]) < MIN_PAUSE_S) last[1] = b;
    else merged.push([a, b]);
  }

  const segments = merged
    .map(([a, b]) => [toS(a), toS(b)])
    .filter(([a, b]) => b - a >= MIN_VOICED_S);

  return { segments, duration, reliable: segments.length > 0 };
}

// ------------------------------------------------------------ transcript

const tokens = text => String(text || '').toLowerCase().match(/[a-z']+/g) || [];

/** Fillers in a transcript: count, per kind. */
export function countFillers(text) {
  const found = {};
  let count = 0;
  for (const word of tokens(text)) {
    if (!FILLER.test(word)) continue;
    const key = word.replace(/(.)\1+/g, '$1$1').slice(0, 4); // "ummmm" and "umm" are one kind
    found[key] = (found[key] || 0) + 1;
    count += 1;
  }
  return { count, kinds: found };
}

/** Immediate repeats — "I I think", "the the" — a sign of restarts. */
export function countRepeats(text) {
  const words = tokens(text).filter(w => !FILLER.test(w));
  let repeats = 0;
  for (let i = 1; i < words.length; i++) if (words[i] === words[i - 1]) repeats += 1;
  return repeats;
}

/** Words that carry meaning — everything except fillers. */
export function countWords(text) {
  return tokens(text).filter(w => !FILLER.test(w)).length;
}

// ---------------------------------------------------------------- measure

const round1 = n => Math.round(n * 10) / 10;

/**
 * The fluency facts for one answer, from its speech segments and transcript.
 *
 * Pure — no audio decoding — so every rule here is testable on its own.
 */
export function describe({ segments, duration, reliable }, transcription) {
  const fillers = countFillers(transcription);
  const repeats = countRepeats(transcription);
  const words = countWords(transcription);

  if (!reliable || !segments.length) {
    return { measured: false, reason: 'no clear speech in the recording', fillers: fillers.count, fillerKinds: fillers.kinds, repeats, words };
  }

  const first = segments[0][0];
  const last = segments[segments.length - 1][1];
  const span = Math.max(0.1, last - first);
  const voiced = segments.reduce((sum, [a, b]) => sum + (b - a), 0);

  // Only pauses BETWEEN stretches of speech. Silence before the first word is
  // reported separately (hesitating to start); silence after the last word is
  // the student having finished, and is not a pause at all.
  const pauses = [];
  for (let i = 1; i < segments.length; i++) {
    const gap = segments[i][0] - segments[i - 1][1];
    if (gap >= MIN_PAUSE_S) pauses.push(gap);
  }

  const long = pauses.filter(p => p >= LONG_PAUSE_S);
  const veryLong = pauses.filter(p => p >= VERY_LONG_PAUSE_S);
  const minutes = span / 60;

  return {
    measured: true,
    recordingSec: round1(duration),
    startDelaySec: round1(first),
    speakingSec: round1(span),
    voicedSec: round1(voiced),
    pauses: pauses.length,
    longPauses: long.length,
    veryLongPauses: veryLong.length,
    longestPauseSec: round1(pauses.length ? Math.max(...pauses) : 0),
    // Share of the speaking time spent silent between words.
    pauseRatio: Math.round(((span - voiced) / span) * 100),
    longPausesPerMin: round1(long.length / minutes),
    words,
    wordsPerMin: Math.round(words / minutes),
    fillers: fillers.count,
    fillerKinds: fillers.kinds,
    fillersPerMin: round1(fillers.count / minutes),
    repeats
  };
}

/** Measure one answer from its stored recording. Never throws. */
export async function measureAnswer(audio, transcription) {
  try {
    const samples = await decodeToPcm(audio);
    return describe(findSpeech(samples), transcription);
  } catch (error) {
    return { measured: false, reason: error.message.slice(0, 200) };
  }
}

/**
 * The whole attempt, weighted by how long each answer was — a 2-minute
 * Part 3 says more about fluency than a 10-second Part 1.1 reply.
 */
export function summarise(answers) {
  const measured = answers.filter(a => a?.measured);
  if (!measured.length) return { measured: false };

  const total = key => measured.reduce((sum, a) => sum + (a[key] || 0), 0);
  const speaking = total('speakingSec');
  const minutes = Math.max(speaking / 60, 0.01);

  return {
    measured: true,
    answers: measured.length,
    speakingSec: round1(speaking),
    wordsPerMin: Math.round(total('words') / minutes),
    longPauses: total('longPauses'),
    veryLongPauses: total('veryLongPauses'),
    longPausesPerMin: round1(total('longPauses') / minutes),
    longestPauseSec: Math.max(...measured.map(a => a.longestPauseSec || 0)),
    pauseRatio: Math.round((1 - total('voicedSec') / Math.max(speaking, 0.1)) * 100),
    fillers: total('fillers'),
    fillersPerMin: round1(total('fillers') / minutes),
    repeats: total('repeats'),
    slowStarts: measured.filter(a => a.startDelaySec >= 3).length
  };
}

/** One line per answer, for the marker. */
export function describeForMarker(f) {
  if (!f?.measured) return 'fluency not measured for this answer';
  return (
    `spoke ${f.speakingSec}s (started after ${f.startDelaySec}s); ` +
    `${f.wordsPerMin} words/min; ` +
    `pauses ≥1s: ${f.longPauses}${f.veryLongPauses ? ` (≥2s: ${f.veryLongPauses})` : ''}, longest ${f.longestPauseSec}s; ` +
    `silent ${f.pauseRatio}% of speaking time; ` +
    `fillers: ${f.fillers}${f.fillers ? ` (${Object.entries(f.fillerKinds).map(([k, n]) => `${k}×${n}`).join(', ')})` : ''}; ` +
    `repeats: ${f.repeats}`
  );
}

export default { decodeToPcm, findSpeech, describe, measureAnswer, summarise, describeForMarker, countFillers, countRepeats, countWords };
