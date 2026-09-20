import { spawn } from 'child_process';
import { CallLimiter } from './MarkingQueue.js';

/**
 * Pronunciation assessment — Azure AI Speech.
 *
 * Why this service exists at all
 * ------------------------------
 * The marking model reads a transcript. It never hears the student. So every
 * pronunciation score it produced before this existed was invented: asked for a
 * number it had no evidence for, it wrote a plausible one, and students studied
 * against it. The prompt even admitted the trick — "estimated from transcription
 * accuracy" — but transcription accuracy is a terrible proxy, because the
 * transcriber is built to be robust to accents. A strong accent transcribes
 * cleanly; a clear speaker in a noisy room transcribes badly. The signal
 * measured the microphone, not the mouth.
 *
 * Azure listens to the audio itself and returns scores derived from the acoustics:
 * accuracy (how close each phoneme is to a native production), fluency (pace,
 * pauses, rhythm) and optionally prosody (stress and intonation). Those are
 * measurements. When this service is not configured, the app now says
 * "not assessed" rather than filling the gap with a guess.
 *
 * Unscripted — reversing an earlier decision, on evidence
 * -------------------------------------------------------
 * This service originally assessed against the student's own transcript.
 * The reasoning was Microsoft's: the unscripted path uses a weaker recognizer,
 * so transcribe first and assess against that transcript whenever the score
 * matters. It matters here — this is a graded exam — and the transcript was
 * already sitting there, free.
 *
 * That reasoning missed one thing, and it was the thing that counted: our
 * transcript is MACHINE-MADE. Assessing against it does not compare the student
 * to what they meant to say; it compares them to what the recogniser thought it
 * heard. Every transcription error becomes a mispronounced word.
 *
 * Measured on one speaker, one microphone, two attempts minutes apart:
 *
 *   short Part 1.1 answers  -> accuracy 88
 *   full mock, Parts 1-3    -> accuracy 39
 *
 * Fluency was 83 in both; prosody 78 and 73. Only accuracy moved, because only
 * accuracy depends on the reference. The longer and more complex the speech,
 * the worse the transcript, and the more the student was punished for it — so
 * the candidates most deserving of high bands were the ones most penalised.
 *
 * A weaker recognizer scoring what was actually said beats a stronger one
 * scoring the wrong text. So unscripted is the default now, and the old
 * behaviour remains one variable away (AZURE_SPEECH_UNSCRIPTED=false) for the
 * case it was always right for: a candidate reading a script somebody chose.
 *
 * Completeness is ignored either way — there is no script to be complete
 * against. Accuracy, fluency and prosody are the real outputs.
 *
 * Why only a sample of the attempt is assessed
 * -------------------------------------------
 * Pronunciation is a stable trait — a student does not acquire a different
 * accent between question 1 and question 8. Assessing all 7¼ minutes of a mock
 * would cost five times as much as assessing a representative minute of it and
 * tell us the same thing. So the longest answers are sampled up to a budget.
 *
 * The 30-second wall
 * ------------------
 * Azure's REST endpoint refuses pronunciation assessment on anything longer
 * than 30 seconds of audio. Longer clips need their SDK, which is not
 * installable here. Since we are sampling anyway, each clip is simply cut to
 * just under the limit — that is enough speech for a reliable score, and it
 * keeps this service to plain HTTP with no new dependency.
 */

/** Cut below Azure's 30s ceiling: a 30s answer can encode as 30.2s. */
const CLIP_SECONDS = 28;

/** How much audio to assess per attempt. Two clips is plenty for a trait. */
const DEFAULT_BUDGET_SECONDS = 60;

/** Azure returns 0-100; this app marks out of 75. */
const AZURE_MAX = 100;

/**
 * How far accuracy must fall below BOTH fluency and prosody before it is
 * treated as a fault in the measurement rather than in the speaker.
 *
 * 25 comes from the case that exposed this: one attempt measured accuracy 39
 * against fluency 83 and prosody 73 — gaps of 44 and 34 — while the same
 * speaker measured 88 minutes earlier. A genuine pronunciation problem does
 * not leave fluency and intonation untouched.
 */
const SUSPECT_GAP = 25;

/**
 * A ceiling on how many recordings are being assessed at once, server-wide.
 *
 * This is not an optimisation, it is the difference between working and not.
 * Azure's free tier permits exactly ONE assessment at a time and cannot be
 * raised; a second arriving while the first is in flight is refused with a 429,
 * not queued. Marking already runs a student's answers in parallel and a class
 * finishes together, so without this ceiling the first student is assessed and
 * everyone else is told "not assessed" — which looks exactly like a broken
 * feature and is really just an unqueued queue.
 *
 * Default 1, because that is what the free tier allows and a wrong default here
 * fails silently. Standard tier permits 100: raise AZURE_SPEECH_CONCURRENCY to
 * something like 20 there and a class stops waiting on each other.
 */
const azureLimiter = new CallLimiter(Number(process.env.AZURE_SPEECH_CONCURRENCY) || 1);

/** Attempts per clip before giving up on it. */
const MAX_ATTEMPTS = Number(process.env.AZURE_SPEECH_MAX_RETRIES) || 3;

class PronunciationService {
  get key() {
    return process.env.AZURE_SPEECH_KEY || '';
  }

  get region() {
    return (process.env.AZURE_SPEECH_REGION || '').trim().toLowerCase();
  }

  /**
   * Prosody costs extra on top of the base rate, so it is opt-in. It is also
   * en-US only — on any other locale Azure simply omits the score.
   */
  get prosodyEnabled() {
    return String(process.env.AZURE_SPEECH_PROSODY || '').toLowerCase() === 'true';
  }

  /**
   * Score the speech Azure hears, not the speech our recogniser wrote down.
   *
   * Defaults ON: scripted assessment is only correct when the candidate is
   * reading a text somebody chose, and nobody here is. See assessClipOnce for
   * the measurements that made this the default.
   */
  get unscripted() {
    return String(process.env.AZURE_SPEECH_UNSCRIPTED || 'true').toLowerCase() !== 'false';
  }

  get locale() {
    return process.env.AZURE_SPEECH_LOCALE || 'en-US';
  }

  get budgetSeconds() {
    return Number(process.env.PRONUNCIATION_BUDGET_SECONDS) || DEFAULT_BUDGET_SECONDS;
  }

  isConfigured() {
    return Boolean(this.key && this.region);
  }

  /**
   * Azure's own subdomain form. The regional host
   * (`<region>.stt.speech.microsoft.com`) also exists, but Microsoft's current
   * documentation only guarantees this one.
   */
  endpoint() {
    // An explicit host covers private endpoints, sovereign clouds, and pointing
    // this at a stand-in while testing without a real subscription.
    const host = process.env.AZURE_SPEECH_ENDPOINT
      || `https://${this.region}.stt.speech.microsoft.com`;

    return (
      `${host.replace(/\/+$/, '')}` +
      `/speech/recognition/conversation/cognitiveservices/v1` +
      // format=detailed is not optional: every assessment score lives inside
      // NBest, and the default `simple` format does not return it.
      `?language=${encodeURIComponent(this.locale)}&format=detailed`
    );
  }

  /**
   * Transcode a browser recording into what Azure accepts.
   *
   * The recorder produces WebM/Opus; Azure's REST endpoint takes 16 kHz mono
   * 16-bit PCM WAV and nothing else. ffmpeg also does the trimming, so only the
   * assessed seconds are ever decoded.
   */
  toWav(buffer, seconds = CLIP_SECONDS) {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-t', String(seconds),
        '-ar', '16000',      // 16 kHz
        '-ac', '1',          // mono
        '-c:a', 'pcm_s16le', // 16-bit
        '-f', 'wav',
        'pipe:1'
      ]);

      const chunks = [];
      const errors = [];
      ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
      ffmpeg.stderr.on('data', chunk => errors.push(chunk));

      ffmpeg.on('error', error =>
        reject(new Error(
          error.code === 'ENOENT'
            ? 'ffmpeg is not installed — pronunciation assessment needs it to convert recordings.'
            : `ffmpeg failed to start: ${error.message}`
        )));

      ffmpeg.on('close', code => {
        if (code !== 0) {
          return reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errors).toString().trim()}`));
        }
        const wav = Buffer.concat(chunks);
        if (!wav.length) return reject(new Error('ffmpeg produced no audio'));
        resolve(wav);
      });

      ffmpeg.stdin.on('error', () => { /* closed early; the close handler reports */ });
      ffmpeg.stdin.end(buffer);
    });
  }

  /**
   * Assess one clip.
   *
   * @param {Buffer} audio    the stored recording, in whatever the browser made
   * @param {string} referenceText  what the student was transcribed as saying
   */
  /**
   * Assess one clip, queued behind any others and retried if Azure is busy.
   *
   * The queue does the real work; the retry is for the case the docs warn about,
   * where Azure returns 429 while scaling up to meet demand even though the
   * caller is inside its quota. Waiting a moment is the only cure for that —
   * asking for more quota does not help.
   */
  assessClip(audio, referenceText) {
    return azureLimiter.run(() => this.assessClipWithRetry(audio, referenceText));
  }

  async assessClipWithRetry(audio, referenceText, attempt = 1) {
    try {
      return await this.assessClipOnce(audio, referenceText);
    } catch (error) {
      if (!error.retryable || attempt >= MAX_ATTEMPTS) throw error;

      // Jitter so several waiting clips do not all return at the same instant
      // and collide again.
      const waitMs = Math.min(20000, 1500 * 2 ** (attempt - 1)) + Math.random() * 500;
      console.warn(
        `Azure busy (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${Math.round(waitMs)}ms`
      );
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return this.assessClipWithRetry(audio, referenceText, attempt + 1);
    }
  }

  async assessClipOnce(audio, referenceText) {
    if (!this.isConfigured()) throw new Error('Azure Speech is not configured');

    const wav = await this.toWav(audio);

    // PascalCase keys and string booleans: the REST header takes a different
    // shape from the SDK's config object, and copying SDK field names here
    // silently yields accuracy-only results.
    /*
     * UNSCRIPTED BY DEFAULT — and this is a correction of a real fault.
     *
     * Azure scores pronunciation against a ReferenceText. We used to pass the
     * student's own transcript, reasoning that their own words could not be the
     * wrong script. But that transcript is MACHINE-MADE, and every word the
     * recogniser got wrong became a word the student had "mispronounced".
     *
     * The effect was measured, not theorised. The same speaker, same
     * microphone, two attempts minutes apart:
     *
     *   short Part 1.1 answers  -> accuracy 88   (transcript near-perfect)
     *   full mock, Parts 1-3    -> accuracy 39   (transcript full of errors)
     *
     * Fluency held at 83 in both and prosody at 78 and 73, because neither
     * depends on the reference. Only accuracy collapsed. The system was
     * punishing students for speaking at length and complexity — precisely the
     * candidates who deserved the higher bands.
     *
     * An empty ReferenceText puts Azure in unscripted mode, where it recognises
     * the speech itself and scores what it heard. That is what this feature is
     * designed for on spontaneous speech, and it removes the transcript from
     * the measurement entirely.
     *
     * Set AZURE_SPEECH_UNSCRIPTED=false to go back to scripted assessment,
     * which is only correct if a student is reading a known text aloud.
     */
    const config = {
      ReferenceText: this.unscripted ? '' : String(referenceText || '').slice(0, 4000),
      GradingSystem: 'HundredMark',
      Granularity: 'Phoneme',
      // Without Comprehensive, Azure returns accuracy and nothing else.
      Dimension: 'Comprehensive',
      // Miscue finds words skipped or inserted against a script the student was
      // meant to read. There is no such script here, scripted or not.
      EnableMiscue: 'False',
      EnableProsodyAssessment: this.prosodyEnabled ? 'True' : 'False'
    };

    const response = await fetch(this.endpoint(), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.key,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        'Pronunciation-Assessment': Buffer.from(JSON.stringify(config), 'utf8').toString('base64'),
        Accept: 'application/json'
      },
      body: wav
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const failure = new Error(this.explainFailure(response.status, detail));
      // A refused key stays refused however long we wait; a busy service does
      // not. Only the second kind is worth trying again.
      failure.retryable = response.status === 429 || response.status >= 500;
      throw failure;
    }

    return this.parse(await response.json());
  }

  /** Turn Azure's status codes into something a teacher can act on. */
  explainFailure(status, detail) {
    if (status === 401) return 'Azure rejected the speech key — check AZURE_SPEECH_KEY.';
    if (status === 403) return 'Azure received no speech key — AZURE_SPEECH_KEY is missing.';
    if (status === 429) {
      // Requests are already queued to one at a time by default, so reaching
      // here means either the monthly allowance is spent or Azure is still
      // scaling — and the two need different responses from a teacher.
      return 'Azure refused the request as too many. Either the free tier\'s ' +
             '5 audio hours for this month are used up, or AZURE_SPEECH_CONCURRENCY ' +
             'is set higher than your tier allows (the free tier permits 1).';
    }
    if (status === 400) return `Azure rejected the audio or the locale: ${detail.slice(0, 200)}`;
    return `Azure pronunciation assessment failed (${status}): ${detail.slice(0, 200)}`;
  }

  /**
   * Read the scores out of the response.
   *
   * Microsoft documents two different layouts for the same data — one with the
   * scores flat on the NBest entry, one with them nested under a
   * `PronunciationAssessment` object — so both are accepted rather than betting
   * on which one this endpoint returns today.
   */
  parse(payload) {
    const best = payload?.NBest?.[0];
    if (!best) {
      const status = payload?.RecognitionStatus;
      throw new Error(
        status === 'NoMatch' || status === 0
          ? 'Azure heard no speech in the recording.'
          : `Azure returned no assessment (status: ${status ?? 'unknown'}).`
      );
    }

    const scores = best.PronunciationAssessment || best;
    const score = value => (typeof value === 'number' ? value : null);

    const words = (best.Words || []).map(entry => {
      const wordScores = entry.PronunciationAssessment || entry;
      return {
        word: entry.Word,
        accuracy: score(wordScores.AccuracyScore),
        errorType: wordScores.ErrorType || 'None'
      };
    });

    return {
      accuracy: score(scores.AccuracyScore),
      fluency: score(scores.FluencyScore),
      prosody: score(scores.ProsodyScore),
      overall: score(scores.PronScore),
      words
    };
  }

  /**
   * Assess an attempt by sampling its answers.
   *
   * Answers are ranked by how much the student actually said, because a longer
   * answer gives the assessor more to work with — a three-word reply scores
   * erratically. Only answers that carry both audio and a transcript can be
   * used at all.
   *
   * Never throws: a pronunciation score is an enrichment, and losing it must
   * not cost the student their marks. Failures come back in `error`.
   */
  async assessAttempt(answers) {
    if (!this.isConfigured()) return null;

    const usable = answers
      .filter(a => a.audio?.length && String(a.transcription || '').trim())
      .sort((a, b) => b.transcription.length - a.transcription.length);

    if (!usable.length) return null;

    const clips = usable.slice(0, Math.max(1, Math.ceil(this.budgetSeconds / CLIP_SECONDS)));

    const results = [];
    const failures = [];
    const startedAt = Date.now();

    // One clip at a time within an attempt, deliberately. Each call queues
    // behind everyone else's, so submitting all three at once would put one
    // student three places ahead of a classmate who is still waiting for their
    // first — the same unfairness the queue exists to prevent.
    for (const clip of clips) {
      try {
        const assessment = await this.assessClip(clip.audio, clip.transcription);
        if (assessment.accuracy !== null) {
          results.push({ ...assessment, taskNumber: clip.taskNumber });
        }
      } catch (error) {
        failures.push(error.message);
      }
    }

    // Logged because capacity here is a real constraint and guessing at it is
    // how the free tier's one-at-a-time limit went unnoticed in the first place.
    console.log(
      `Pronunciation: ${results.length}/${clips.length} clip(s) in ` +
      `${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
      `(queue ${azureLimiter.stats.running} running, ${azureLimiter.stats.waiting} waiting)`
    );

    if (!results.length) {
      return { assessed: false, error: failures[0] || 'No answer could be assessed.' };
    }

    const mean = pick => {
      const values = results.map(pick).filter(v => typeof v === 'number');
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };

    // The words a teacher would actually point at: the worst-scored ones, with
    // duplicates collapsed so a student is not handed "the" five times.
    const seen = new Set();
    const problemWords = results
      .flatMap(r => r.words)
      .filter(w => typeof w.accuracy === 'number' && (w.accuracy < 60 || w.errorType === 'Mispronunciation'))
      .sort((a, b) => a.accuracy - b.accuracy)
      .filter(w => {
        const key = w.word.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);

    const accuracy = mean(r => r.accuracy);
    const fluency = mean(r => r.fluency);
    const prosody = mean(r => r.prosody);

    /*
     * A second line of defence for the measurement that already failed once.
     *
     * Accuracy is the figure that collapses when something is wrong with the
     * reference, and it collapses ALONE — a speaker whose sounds are genuinely
     * unclear is also hesitant and flat, so a real problem drags fluency and
     * prosody down with it. Accuracy far below both of them is therefore a
     * symptom of the measurement, not of the speaker.
     *
     * Flagged rather than discarded: the marker is told the figure is
     * unreliable and judges on the rest, which is honest about what we know.
     * Silently dropping it would leave nobody able to see that Azure is
     * misbehaving, and this fault went unnoticed for weeks exactly because
     * nothing said so out loud.
     */
    const others = [fluency, prosody].filter(v => typeof v === 'number');
    const accuracySuspect =
      typeof accuracy === 'number' &&
      others.length > 0 &&
      others.every(value => value - accuracy >= SUSPECT_GAP);

    if (accuracySuspect) {
      console.warn(
        `Pronunciation: accuracy ${Math.round(accuracy)} sits ${SUSPECT_GAP}+ below ` +
        `fluency/prosody (${others.map(Math.round).join('/')}) — treating it as unreliable`
      );
    }

    return {
      assessed: true,
      clipsAssessed: results.length,
      secondsAssessed: results.length * CLIP_SECONDS,
      accuracy,
      fluency,
      prosody,
      overall: mean(r => r.overall) ?? accuracy,
      accuracySuspect,
      problemWords,
      error: failures.length ? failures[0] : undefined
    };
  }

  /** Azure's 0-100 onto this app's 0-75, or null if there is nothing to convert. */
  toExamScale(value, maxScore) {
    if (typeof value !== 'number') return null;
    return Math.round((value / AZURE_MAX) * maxScore);
  }
}

export default new PronunciationService();
