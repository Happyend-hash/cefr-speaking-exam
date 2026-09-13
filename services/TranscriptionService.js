import axios from 'axios';

/**
 * Transcription Service — turns a recording into text for the evaluator.
 *
 * Claude's Messages API does not accept audio, so speech-to-text has to happen
 * elsewhere. Two paths are supported, and the service picks the best available:
 *
 *   1. Server-side Whisper (OpenAI). Used when OPENAI_API_KEY is set. Accurate,
 *      browser-independent, and costs per minute of audio.
 *   2. The browser's own SpeechRecognition transcript, sent with the upload.
 *      Free and needs no extra account, but only Chrome and Edge implement it
 *      well, and accuracy is lower.
 *
 * With no key configured the service falls back to the browser transcript, so
 * the platform works out of the box and improves when a key is added.
 */

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

class TranscriptionService {
  get whisperKey() {
    const key = process.env.OPENAI_API_KEY;
    // Guard against the placeholder-key problem that silently broke this project before.
    if (!key || key.length < 20 || key.toLowerCase().includes('placeholder')) return null;
    return key;
  }

  isServerTranscriptionAvailable() {
    return this.whisperKey !== null;
  }

  /**
   * Produce the best transcript available for one task response.
   *
   * @param {Buffer|null} audioBuffer  Recording bytes, when available.
   * @param {Object} options
   * @param {string} [options.clientTranscript] Transcript captured in the browser.
   * @param {string} [options.filename]
   * @param {string} [options.contentType]
   * @returns {Promise<{text: string, provider: string, warning?: string}>}
   */
  async transcribe(audioBuffer, { clientTranscript = '', filename = 'response.webm', contentType = 'audio/webm' } = {}) {
    const fallback = (clientTranscript || '').trim();

    if (audioBuffer && this.whisperKey) {
      try {
        const text = await this.transcribeWithWhisper(audioBuffer, filename, contentType);
        if (text && text.trim()) {
          return { text: text.trim(), provider: 'whisper' };
        }
      } catch (error) {
        console.error('Whisper transcription failed, falling back to browser transcript:', error.message);
        if (fallback) {
          return {
            text: fallback,
            provider: 'browser',
            warning: 'Server transcription failed; used the browser transcript instead.'
          };
        }
        throw new Error(`Transcription failed and no browser transcript was provided: ${error.message}`);
      }
    }

    if (fallback) {
      return {
        text: fallback,
        provider: 'browser',
        warning: this.isServerTranscriptionAvailable()
          ? undefined
          : 'Transcribed in the browser. Set OPENAI_API_KEY for more accurate server-side transcription.'
      };
    }

    return {
      text: '',
      provider: 'none',
      warning:
        'No transcript could be produced. Your browser may not support speech recognition — set OPENAI_API_KEY to transcribe on the server instead.'
    };
  }

  async transcribeWithWhisper(audioBuffer, filename, contentType) {
    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: contentType }), filename);
    // gpt-4o-mini-transcribe is half the price of legacy whisper-1 ($0.003 vs
    // $0.006 a minute) and newer, which matters for accented speech. Override
    // with WHISPER_MODEL if it ever mishears these students.
    form.append('model', process.env.WHISPER_MODEL || 'gpt-4o-mini-transcribe');
    form.append('language', process.env.EXAM_LANGUAGE || 'en');

    try {
      const response = await axios.post(WHISPER_URL, form, {
        headers: { Authorization: `Bearer ${this.whisperKey}` },
        timeout: 120000,
        maxBodyLength: Infinity
      });

      return response.data?.text || '';
    } catch (error) {
      // Say which of the handful of likely causes it is. Without this, a wrong
      // key, an empty balance and a bad model name all read the same in the
      // logs, and the student just sees an unmarked answer.
      const status = error.response?.status;
      const detail = error.response?.data?.error?.message || error.message;
      const hint =
        status === 401 ? ' — OPENAI_API_KEY is wrong or was revoked'
        : status === 429 ? ' — rate limited, or the API credit balance is empty'
        : status === 400 ? ` — request rejected; check WHISPER_MODEL (currently "${process.env.WHISPER_MODEL || 'gpt-4o-mini-transcribe'}")`
        : status === 404 ? ' — that transcription model does not exist for this account'
        : '';

      const wrapped = new Error(`OpenAI transcription ${status || 'request'} failed: ${detail}${hint}`);
      wrapped.status = status;
      throw wrapped;
    }
  }
}

export default new TranscriptionService();
