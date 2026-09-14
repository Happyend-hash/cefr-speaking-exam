/*
 * CEFR Speaking Exam — client.
 *
 * Deliberately buildless: plain ES2020 in one file, no bundler, no transpiler,
 * no CSS compiler. An earlier version of this app shipped a committed build
 * output whose stylesheet was never compiled and whose API URL still pointed at
 * localhost, and nothing caught either. With no build step there is no build
 * output to go stale — what you read here is exactly what runs.
 *
 * All API calls use relative paths: the Express server serves this file and the
 * API from the same origin, so there is no host to configure and no CORS.
 */

(() => {
  'use strict';

  const API = '/api';
  const root = document.getElementById('root');

  // ---------------------------------------------------------------- state

  const state = {
    screen: 'landing',
    user: null,
    token: null,
    exams: [],
    history: [],
    stats: null,
    exam: null,        // exam being taken
    questions: null,   // flattened, ordered question list (speaking)
    serverTranscription: false, // set from the server when an attempt starts
    mode: 'mock',      // 'mock' (no skipping) or 'practice' (one part, retryable)
    part: null,        // practice only: which part
    resultId: null,
    taskIndex: 0,
    qIndex: 0,
    answered: {},      // taskNumber -> { transcription, hasAudio }
    result: null,      // completed result detail
    // What this student is allowed to do, straight from the server. Never
    // decided here: a counter the page could edit would be a counter students
    // could edit. The server checks again at the start of every attempt.
    access: null,      // { remaining, blocked, contact, message }
    folder: null,      // which module's mocks are being browsed
    mockSearch: '',    // mocks screen: search box
    mockStatus: 'all', // mocks screen: status filter
    mockSort: 'recommended',
    loading: false,
    error: '',
    notice: ''
  };

  // Recorder state lives outside `state` because it holds live objects that
  // must survive re-renders.
  const rec = {
    mediaRecorder: null,
    chunks: [],
    stream: null,
    recognition: null,
    transcript: '',
    interim: '',
    startedAt: 0,
    tickHandle: null,
    blob: null,
    blobUrl: null,
    elapsed: 0,
    isRecording: false,
    uploading: false
  };

  // ------------------------------------------------------------- storage

  // Storage can throw (private mode, blocked cookies), and a thrown error here
  // would take down the whole app, so every access is guarded.
  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* session-only */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* nothing to do */ }
    }
  };

  // ----------------------------------------------------------- utilities

  // Marks are out of 75 (the Multilevel scale), but a progress bar is drawn as a
  // percentage — so a bar must be scaled, never fed the raw mark. Left unscaled,
  // a top C1 of 75/75 would render as a three-quarters-full bar.
  const MAX_SCORE = 75;
  const pctOfMax = score =>
    Math.max(0, Math.min(100, Math.round(((Number(score) || 0) / MAX_SCORE) * 100)));

  /**
   * Uzbek labels for the marking criteria and the headings around them.
   *
   * The AI writes its feedback in Uzbek (FEEDBACK_LANGUAGE on the server), so
   * leaving these headings in English would read as half-translated. The KEYS
   * stay English — they are data the server sends and code matches on; only
   * what the student reads is translated. An unknown key falls back to itself,
   * so adding a criterion server-side never shows a blank heading.
   */
  const CRITERION_LABELS = {
    grammar: 'Grammatika',
    vocabulary: "Lug'at boyligi",
    fluency: 'Ravonlik',
    pronunciation: 'Talaffuz',
    coherence: 'Bog\'lanish va izchillik',
    taskAchievement: 'Topshiriqni bajarish'
  };

  const UI_TEXT = {
    strengths: 'Kuchli tomonlar',
    improvements: 'Ustida ishlash kerak'
  };

  /**
   * The briefing, in Uzbek.
   *
   * Everything a student reads before the first question is gathered here
   * rather than left inline, because this is the one screen where a
   * misunderstanding costs marks — a teacher must be able to find a sentence
   * and reword it without reading the code around it. Latin script, matching
   * the AI feedback (FEEDBACK_LANGUAGE on the server).
   *
   * Two things stay in English on purpose: the part labels (1.1, 1.2, 2, 3),
   * which are what the real exam calls them, and the sample sentence for the
   * microphone check, which the student is meant to say in English.
   */
  const BRIEF_UZ = {
    back: 'Mocklarga qaytish',
    fullMock: "To'liq mock",
    practice: 'Mashq',
    summary: (questions, minutes) =>
      `${questions} ta savol · taxminan ${minutes} daqiqa o'ylash va gapirish vaqti.`,

    whatHeading: 'Nima qilasiz',
    partBlurb: {
      '1.1': "O'zingiz haqingizda qisqa savollar. Darhol javob bering.",
      '1.2': 'Ikki rasmni solishtiring va farqlarini ayting.',
      '2': 'Bitta vaziyat, uchta savol. Uchalasiga ham bitta javobda javob bering.',
      '3': "Mavzu bo'yicha tarafdor va qarshi fikrlar. O'z fikringizni bildiring."
    },
    minutes: n => `~${n} daq`,

    howHeading: "Qanday o'tadi",
    steps: [
      "Har bir savolda avval <strong>o'ylash vaqti</strong> beriladi. Undan foydalaning — bu paytda hech narsa yozib olinmaydi.",
      "So'ng ovoz yozish <strong>o'zi boshlanadi</strong> va vaqt tugagach o'zi to'xtaydi.",
      "Javobingiz o'zi saqlanadi va keyingi savol chiqadi."
    ],
    stepMock: "Mock boshlangandan keyin oxirigacha to'xtamaydi. To'xtatib turolmaysiz, savolni o'tkazib yubora olmaysiz va javobni qayta yoza olmaysiz.",
    stepPractice: "Mashqda savolni o'tkazib yuborishingiz yoki javobni qayta yozishingiz mumkin.",
    stepStay: "Oxirigacha shu sahifada qoling. Sahifadan chiqsangiz, yozilayotgan javob yo'qoladi.",
    quiet: "Avval tinch joy toping — atrofdagi ovozlar ham yozuvga tushadi va javobingizning bir qismi sifatida baholanadi.",

    micHeading: 'Mikrofonni tekshirish',
    micNote: "Bu yerda hech narsa baholanmaydi — bu yozuv o'chirib tashlanadi.",
    micIdle: seconds =>
      `${seconds} soniya yozib, eshitib ko'ring. Baho mikrofonga bog'liq bo'lishidan oldin uning ishlayotganiga ishonch hosil qiling.`,
    micTest: 'Mikrofonni tekshirish',
    micAsking: 'Brauzeringiz ruxsat so\'ramoqda — <strong>Allow</strong> (Ruxsat berish) ni tanlang.',
    micSay: 'Biror narsa ayting — <em>"My name is …, and I am taking a speaking test."</em>',
    micPassed: 'Mikrofoningiz ishlayapti.',
    micPlayback: "Eshitib ko'ring: ovoz sizniki eshitilyaptimi yoki faqat xona shovqinimi?",
    micRetest: 'Qayta tekshirish',
    micQuiet: 'Mikrofon yoniq, lekin sizni deyarli eshitmadi.',
    micQuietHow: peak =>
      `Eng baland ovoz — ${peak}%. Yaqinroq keling, mikrofonni yoqing yoki quloqchinni yeching, so'ng qayta tekshiring. Avval yozuvni eshiting:`,
    micFailed: 'Mikrofondan foydalanib bo\'lmadi.',
    micTryAgain: 'Qayta urinish',

    errNoApi: "Bu brauzer sahifaga mikrofondan foydalanishga ruxsat bermaydi. Saytni Chrome'da oching va qayta urinib ko'ring.",
    errDenied: 'Mikrofon bloklangan. Brauzeringizda shu sayt uchun mikrofonga ruxsat bering va qaytadan tekshiring.',
    errOpen: name => `Mikrofonni ochib bo'lmadi (${name}). Uni boshqa dastur band qilmaganiga ishonch hosil qiling.`,
    errRecorder: name => `Bu brauzer ovoz yoza olmaydi (${name}).`,
    errEmpty: "Umuman hech narsa yozilmadi. Boshqa brauzerdan foydalanib ko'ring.",

    startMock: 'Mock imtihonni boshlash',
    startPractice: 'Mashqni boshlash',
    startNote: 'Bosishingiz bilan birinchi savol boshlanadi.',
    startBlocked: "Boshlash uchun mikrofon tekshiruvidan o'ting.",
    startAnyway: 'Tekshirmasdan boshlash',

    serverWillTranscribe: 'Bu brauzerda nutqni tanish yo\'q, shuning uchun ovozingiz serverda matnga o\'giriladi.',
    noTranscriptionTitle: 'Bu brauzer nutqni matnga o\'gira olmaydi',
    noTranscriptionBody: "Yozuvingiz saqlanadi, lekin imtihon oluvchi o'qiydigan matn bo'lmaydi, shuning uchun javob baholanmaydi. Bu Telegram kabi ilovalar ichidagi brauzerlarda odatiy hol. Boshlashdan oldin saytni Chrome'da oching."
  };

  const criterionLabel = key => CRITERION_LABELS[key] || key;

  const esc = value =>
    String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const fmtTime = seconds => {
    const s = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const fmtDate = value =>
    value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

  async function api(path, { method = 'GET', body, form } = {}) {
    const headers = {};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (body) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: form ? form : body ? JSON.stringify(body) : undefined
    });

    let payload = {};
    try { payload = await response.json(); } catch { /* non-JSON error page */ }

    if (response.status === 401 && state.token) {
      signOut();
      throw new Error('Your session expired — please sign in again.');
    }
    if (!response.ok) {
      const error = new Error(payload.message || `Request failed (${response.status})`);
      // The reason, where the server named one. "You have no mocks left" and
      // "your teacher stopped you" arrive the same way and need different
      // screens, and matching on the wording would break the day it changed.
      error.code = payload.code || '';
      error.status = response.status;
      throw error;
    }
    return payload.data !== undefined ? payload.data : payload;
  }

  function setState(patch) {
    Object.assign(state, patch);
    render();
  }

  function go(screen, patch = {}) {
    setState({ screen, error: '', notice: '', ...patch });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  // ---------------------------------------------------------------- auth

  function signIn(data) {
    state.token = data.accessToken;
    state.user = data.user;
    store.set('token', data.accessToken);
    store.set('user', JSON.stringify(data.user));
    loadDashboard();
  }

  function signOut() {
    stopMicCheck();
    store.remove('token');
    store.remove('user');
    Object.assign(state, {
      token: null, user: null, exams: [], history: [], stats: null,
      exam: null, resultId: null, result: null, screen: 'landing'
    });
    render();
  }

  // ------------------------------------------------------------- loaders

  async function loadDashboard() {
    // Leaving the briefing by the nav rather than its own button would
    // otherwise leave the microphone open and the recording light on.
    stopMicCheck();
    setState({ screen: 'dashboard', loading: true, error: '' });
    try {
      const [exams, history, profile] = await Promise.all([
        api('/exam'),
        api('/exam/results'),
        api('/user/profile').catch(() => null)
      ]);
      setState({
        exams,
        history,
        stats: profile?.stats || null,
        access: profile?.access || state.access,
        user: profile?.user || state.user,
        loading: false
      });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  /**
   * Put the teacher's notice away.
   *
   * Cleared on screen first and on the server after: the student has read it,
   * and a note that stays up because the network hiccupped reads as broken. If
   * the request does fail the notice simply comes back on the next load, which
   * is the harmless direction to fail in.
   */
  async function dismissNotice() {
    setState({ access: { ...(state.access || {}), message: '' } });
    try {
      await api('/user/access/seen', { method: 'POST' });
    } catch { /* it will reappear on the next load */ }
  }

  async function startExam(examId, mode = 'mock', part = null) {
    setState({ loading: true, error: '' });
    try {
      const [exam, started] = await Promise.all([
        api(`/exam/${examId}`),
        api(`/exam/${examId}/start`, { method: 'POST', body: { mode, part } })
      ]);
      resetRecorder();
      clearPhaseTimer();

      // Sections-based speaking tests arrive already flattened and ordered.
      // The writing module still uses the legacy flat task list.
      const questions = started.questions?.length ? started.questions : null;

      setState({
        // Speaking goes through the briefing first: what is coming, and proof
        // the microphone works. Writing needs neither, so it starts directly.
        screen: questions ? 'briefing' : 'exam',
        exam,
        questions,
        micCheck: { phase: 'idle' },
        serverTranscription: Boolean(started.serverTranscription),
        // The balance the server has just charged, so the dashboard behind this
        // attempt is already right when the student comes back to it.
        access: typeof started.remaining === 'number'
          ? { ...(state.access || {}), remaining: started.remaining }
          : state.access,
        mode: started.mode || mode,
        part: started.part || part,
        resultId: started.resultId,
        taskIndex: 0,
        qIndex: 0,
        answered: {},
        loading: false,
        notice: started.resumed ? 'Resuming the attempt you already had in progress.' : ''
      });

      run.phase = 'ready';
      render();
    } catch (error) {
      // Being out of mocks is not a fault, so it does not get a red error bar.
      // It gets the page that explains what to do next.
      if (error.code === 'no_credits' || error.code === 'blocked') {
        return setState({
          loading: false,
          error: '',
          access: { ...(state.access || {}), remaining: 0, blocked: error.code === 'blocked' },
          screen: 'topup'
        });
      }
      setState({ loading: false, error: error.message });
    }
  }

  // =======================================================================
  // Timed exam engine (speaking, sections-based)
  //
  // Each question runs think → speak → save, with the countdown driven here
  // rather than by the student. In a mock the whole test plays through without
  // interaction, exactly as the real exam does; in practice mode the student
  // starts each question and may retry it.
  // =======================================================================

  const run = { phase: 'idle', remaining: 0, handle: null };

  function clearPhaseTimer() {
    if (run.handle) clearInterval(run.handle);
    run.handle = null;
  }

  const currentQuestion = () => state.questions?.[state.qIndex] || null;

  /** Count down `run.remaining`, updating the DOM directly so the page is not re-rendered every second. */
  function countdown(onZero) {
    clearPhaseTimer();
    paintTimer();
    run.handle = setInterval(() => {
      run.remaining -= 1;
      paintTimer();
      if (run.remaining <= 0) {
        clearPhaseTimer();
        onZero();
      }
    }, 1000);
  }

  function paintTimer() {
    const el = document.getElementById('phase-timer');
    if (el) el.textContent = fmtTime(Math.max(0, run.remaining));
    const bar = document.getElementById('phase-bar');
    if (bar && run.total) bar.style.width = `${Math.max(0, (run.remaining / run.total) * 100)}%`;
  }

  function beginPrep() {
    const q = currentQuestion();
    if (!q) return;
    resetRecorder();
    run.phase = 'prep';
    run.remaining = q.prepTime;
    run.total = q.prepTime;
    render();
    countdown(beginAnswer);
  }

  async function beginAnswer() {
    const q = currentQuestion();
    if (!q) return;
    run.phase = 'answer';
    run.remaining = q.answerTime;
    run.total = q.answerTime;
    render();

    await beginRecording();
    if (!rec.isRecording) {
      // Microphone blocked — stop here rather than silently recording nothing.
      run.phase = 'blocked';
      return render();
    }
    countdown(finishAnswer);
  }

  function finishAnswer() {
    clearPhaseTimer();
    if (!rec.isRecording) return;
    endRecording();
    run.phase = 'saving';
    render();
    // MediaRecorder delivers the blob asynchronously in onstop.
    setTimeout(uploadCurrentAnswer, 600);
  }

  async function uploadCurrentAnswer() {
    const q = currentQuestion();
    if (!q) return;

    try {
      const form = new FormData();
      if (rec.blob) {
        const ext = rec.blob.type.includes('mp4') ? 'mp4' : rec.blob.type.includes('ogg') ? 'ogg' : 'webm';
        form.append('audio', rec.blob, `q${q.taskNumber}.${ext}`);
      }
      form.append('transcription', (rec.transcript + ' ' + rec.interim).trim());
      form.append('duration', String(Math.round(rec.elapsed)));

      const data = await api(`/exam/results/${state.resultId}/tasks/${q.taskNumber}`, {
        method: 'POST',
        form
      });
      state.answered[q.taskNumber] = { transcription: data.transcription, hasAudio: data.hasAudio };

      // Checking whether the browser HAS speech recognition is not enough: the
      // in-app browsers inside messaging apps often expose the API and then
      // quietly capture nothing. A student was let through a whole test that
      // way. So judge it on the actual result — the moment a saved answer comes
      // back with no words, say so, while there is still a test left to save.
      if (!String(data.transcription || '').trim()) {
        state.emptyTranscripts = (state.emptyTranscripts || 0) + 1;
        if (!state.serverTranscription) {
          state.error =
            `Question ${q.taskNumber} recorded no words. Nothing you say is being turned into ` +
            `text, so these answers cannot be marked. Stop now and open ` +
            `${location.host} directly in Chrome — not inside a messaging app.`;
        }
      }
    } catch (error) {
      // A failed save used to scroll past unnoticed, so a student could record
      // a whole test and only find out at submit that nothing had been kept.
      // Count the failures and keep saying so for the rest of the attempt.
      state.saveFailures = (state.saveFailures || 0) + 1;
      state.error = `Question ${q.taskNumber} could not be saved — ${error.message}`;
    }

    resetRecorder();
    advanceQuestion();
  }

  function advanceQuestion() {
    // Two answers in a row that captured no words, with no server transcription
    // to fall back on, means this browser will not produce text for any of them.
    // A mock runs to the end without pausing, so without this the student would
    // record the remaining questions into nothing and find out at the end. Stop
    // and say why while the sitting can still be redone properly.
    if ((state.emptyTranscripts || 0) >= 2 && !state.serverTranscription) {
      clearPhaseTimer();
      run.phase = 'finished';
      state.error =
        'Stopped: none of your answers are being turned into text, so this test cannot be ' +
        `marked. Your recordings are saved. Open ${location.host} directly in Chrome ` +
        '— not inside Telegram or another app — and take the test again.';
      render();
      return;
    }

    const isLast = state.qIndex >= state.questions.length - 1;

    if (isLast) {
      run.phase = 'finished';
      // Submitting with nothing saved returns a confusing "answer at least one
      // task" from the server. Say what actually went wrong instead.
      if (Object.keys(state.answered).length === 0) {
        state.error =
          'None of your answers reached the server, so there is nothing to mark. ' +
          'Your recordings were not saved. Please report this rather than retaking the test.';
        render();
        return;
      }
      render();
      if (state.mode === 'mock') submitExam();
      return;
    }

    state.qIndex += 1;
    if (state.mode === 'mock') {
      beginPrep();           // a mock never pauses between questions
    } else {
      run.phase = 'ready';
      render();
    }
  }

  /**
   * Delete one attempt from the student's history.
   *
   * Removes the row optimistically so the list does not jump, but re-reads the
   * history from the server afterwards — the truth about what was deleted is
   * the server's, not this list's.
   */
  async function deleteResult(resultId) {
    setState({ confirmDelete: null, error: '', notice: 'Deleting…' });
    try {
      await api(`/exam/results/${resultId}`, { method: 'DELETE' });
      state.history = state.history.filter(item => item.id !== resultId);
      setState({ notice: 'Attempt deleted.' });
      loadDashboard();
    } catch (error) {
      setState({ notice: '', error: `Could not delete that attempt — ${error.message}` });
    }
  }

  /**
   * Delete every selected attempt in one request.
   *
   * A partial result is normal — an attempt being marked right now is kept —
   * so report exactly what survived instead of claiming a clean sweep.
   */
  async function deleteSelected() {
    const ids = state.history.filter(h => (state.selected || {})[h.id]).map(h => h.id);
    if (!ids.length) return;

    setState({ confirmBulk: false, error: '', notice: `Deleting ${ids.length}…` });
    try {
      const data = await api('/exam/results/bulk-delete', { method: 'POST', body: { ids } });
      const kept = data.kept || [];

      state.selected = {};
      setState({
        notice: kept.length
          ? `Deleted ${data.deleted.length}. Kept ${kept.length}: ${kept[0].reason}`
          : `Deleted ${data.deleted.length} attempt${data.deleted.length === 1 ? '' : 's'}.`
      });
      loadDashboard();
    } catch (error) {
      setState({ notice: '', error: `Could not delete those attempts — ${error.message}` });
    }
  }

  async function openResult(resultId) {
    setState({ screen: 'result', loading: true, error: '', result: null });
    try {
      const result = await api(`/exam/results/${resultId}`);
      setState({ result, loading: false });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  // ------------------------------------------------------------ recorder

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function resetRecorder() {
    stopTicking();
    if (rec.blobUrl) URL.revokeObjectURL(rec.blobUrl);
    if (rec.stream) rec.stream.getTracks().forEach(t => t.stop());
    try { rec.recognition?.stop(); } catch { /* already stopped */ }
    Object.assign(rec, {
      mediaRecorder: null, chunks: [], stream: null, recognition: null,
      transcript: '', interim: '', startedAt: 0, tickHandle: null,
      blob: null, blobUrl: null, elapsed: 0, isRecording: false, uploading: false
    });
  }

  function startTicking() {
    stopTicking();
    rec.tickHandle = setInterval(() => {
      rec.elapsed = (Date.now() - rec.startedAt) / 1000;
      const timer = document.getElementById('timer');
      if (timer) {
        timer.textContent = fmtTime(rec.elapsed);
        const limit = currentTask()?.timeLimit || 0;
        timer.classList.toggle('over', limit > 0 && rec.elapsed > limit);
      }
    }, 250);
  }

  function stopTicking() {
    if (rec.tickHandle) clearInterval(rec.tickHandle);
    rec.tickHandle = null;
  }

  async function beginRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return setState({ error: 'This browser cannot record audio. Try Chrome, Edge or Safari.' });
    }

    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const message = error.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it in your browser settings and try again.'
        : `Could not access the microphone: ${error.message}`;
      return setState({ error: message });
    }

    if (rec.blobUrl) URL.revokeObjectURL(rec.blobUrl);
    rec.chunks = [];
    rec.blob = null;
    rec.blobUrl = null;
    rec.transcript = '';
    rec.interim = '';

    // Pick a container the browser actually supports rather than assuming webm.
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    const mimeType = preferred.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';

    try {
      rec.mediaRecorder = new MediaRecorder(rec.stream, mimeType ? { mimeType } : undefined);
    } catch (error) {
      return setState({ error: `Could not start recording: ${error.message}` });
    }

    rec.mediaRecorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) rec.chunks.push(event.data);
    };
    rec.mediaRecorder.onstop = () => {
      rec.blob = new Blob(rec.chunks, { type: rec.mediaRecorder.mimeType || 'audio/webm' });
      rec.blobUrl = URL.createObjectURL(rec.blob);
      rec.stream?.getTracks().forEach(t => t.stop());
      rec.stream = null;
      render();
    };

    // Browser speech recognition gives a free transcript. Chrome and Edge
    // support it; elsewhere the server transcribes instead (needs OPENAI_API_KEY).
    if (SpeechRecognition) {
      try {
        rec.recognition = new SpeechRecognition();
        rec.recognition.continuous = true;
        rec.recognition.interimResults = true;
        rec.recognition.lang = 'en-US';
        rec.recognition.onresult = event => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const chunk = event.results[i][0].transcript;
            if (event.results[i].isFinal) rec.transcript += chunk + ' ';
            else interim += chunk;
          }
          rec.interim = interim;
          const box = document.getElementById('transcript');
          if (box) box.textContent = (rec.transcript + rec.interim).trim() || 'Listening…';
        };
        rec.recognition.onerror = () => { /* transcript is best-effort */ };
        rec.recognition.start();
      } catch { rec.recognition = null; }
    }

    rec.mediaRecorder.start();
    rec.isRecording = true;
    rec.startedAt = Date.now();
    rec.elapsed = 0;
    startTicking();
    setState({ error: '' });
  }

  function endRecording() {
    if (!rec.isRecording) return;
    stopTicking();
    rec.isRecording = false;
    rec.elapsed = (Date.now() - rec.startedAt) / 1000;
    try { rec.mediaRecorder?.stop(); } catch { /* already stopped */ }
    try { rec.recognition?.stop(); } catch { /* already stopped */ }
    render();
  }

  async function submitTask() {
    const task = currentTask();
    if (!task || !rec.blob) return;

    rec.uploading = true;
    render();

    try {
      const form = new FormData();
      const ext = (rec.blob.type.includes('mp4') && 'mp4') || (rec.blob.type.includes('ogg') && 'ogg') || 'webm';
      form.append('audio', rec.blob, `task-${task.taskNumber}.${ext}`);
      form.append('transcription', (rec.transcript + ' ' + rec.interim).trim());
      form.append('duration', String(Math.round(rec.elapsed)));

      const data = await api(`/exam/results/${state.resultId}/tasks/${task.taskNumber}`, {
        method: 'POST',
        form
      });

      state.answered[task.taskNumber] = {
        transcription: data.transcription,
        hasAudio: data.hasAudio
      };

      resetRecorder();

      const isLast = state.taskIndex >= state.exam.tasks.length - 1;
      setState({
        taskIndex: isLast ? state.taskIndex : state.taskIndex + 1,
        notice: data.warning || '',
        error: ''
      });
    } catch (error) {
      rec.uploading = false;
      setState({ error: error.message });
    }
  }

  /**
   * How often the dashboard re-checks an attempt that is still being marked.
   *
   * Slower than the old submit-screen poll on purpose. That one ran while a
   * student stared at a spinner and every second showed; this one runs in the
   * background behind a page they are already using, and a whole class doing it
   * at four-second intervals is load bought for nothing.
   */
  const PENDING_POLL_MS = 12000;

  /** The one live timer for the above, so it can never be started twice. */
  let pendingWatch = null;

  /**
   * Hand the attempt in and let the student go.
   *
   * Marking already happens on the server after a 202, so holding the student
   * on a spinner until it finished was a leftover from when it did not. It cost
   * something real: thirty students finishing a lesson together meant thirty
   * people watching a loading screen and thirty connections polling, and anyone
   * who locked their phone had no way to tell whether their work had survived.
   *
   * Now the submit is confirmed and they are sent back to the dashboard, where
   * the attempt is already listed as being marked and turns into a score by
   * itself. A student who wants to wait still sees the result in about the same
   * time; a student who does not is no longer made to.
   */
  async function submitExam() {
    const resultId = state.resultId;
    resetRecorder();
    setState({ screen: 'submitted', loading: true, error: '', submittedId: resultId });

    try {
      await api(`/exam/results/${resultId}/submit`, { method: 'POST' });
      setState({ loading: false });
    } catch (error) {
      // A failed hand-in is the one case worth stopping for: nothing is being
      // marked, so sending them to wait for a result would be a lie.
      const dropped = /fetch|network|load failed|aborted/i.test(error.message);
      setState({
        screen: 'exam',
        loading: false,
        error: dropped
          ? 'Your answers are saved, but the connection dropped before they could be handed in. Try Submit again.'
          : error.message
      });
    }
  }

  /**
   * Keep the dashboard honest while something is being marked.
   *
   * Without this the attempt would sit at "Tekshirilmoqda…" until the student
   * reloaded, and a student who waits would conclude it was stuck. One timer at
   * a time, stopped as soon as nothing is pending or the student leaves — a
   * poll that outlives its screen is how a phone's battery disappears.
   */
  function watchPending() {
    clearPendingWatch();
    if (!pendingAttempts().length) return;

    pendingWatch = setTimeout(async () => {
      pendingWatch = null;
      if (state.screen !== 'dashboard') return;

      try {
        const history = await api('/exam/results');
        // Only re-render if something actually changed, so the page does not
        // flicker under a student who is reading it.
        const changed = JSON.stringify(history.map(h => h.status)) !==
                        JSON.stringify(state.history.map(h => h.status));
        state.history = history;
        if (changed) render();
        else watchPending();
      } catch {
        watchPending(); // a dropped poll is not worth reporting; try again
      }
    }, PENDING_POLL_MS);
  }

  function clearPendingWatch() {
    if (pendingWatch) clearTimeout(pendingWatch);
    pendingWatch = null;
  }

  /** Attempts handed in but not yet marked. */
  const pendingAttempts = () =>
    (state.history || []).filter(h => h.status === 'evaluating' || h.status === 'submitted');

  const currentTask = () => state.exam?.tasks?.[state.taskIndex] || null;

  const countWords = text => (text || '').trim().split(/\s+/).filter(Boolean).length;

  /** Submit a written answer. Same endpoint as speaking, with text and no audio. */
  async function submitWriting() {
    const task = currentTask();
    const text = (document.getElementById('essay')?.value || '').trim();
    if (!task || !text) return setState({ error: 'Write your answer before saving it.' });

    rec.uploading = true;
    render();

    try {
      const form = new FormData();
      form.append('transcription', text);
      form.append('duration', '0');

      const data = await api(`/exam/results/${state.resultId}/tasks/${task.taskNumber}`, {
        method: 'POST',
        form
      });

      state.answered[task.taskNumber] = { transcription: data.transcription, hasAudio: false };
      rec.uploading = false;

      const isLast = state.taskIndex >= state.exam.tasks.length - 1;
      setState({ taskIndex: isLast ? state.taskIndex : state.taskIndex + 1, error: '', notice: '' });
    } catch (error) {
      rec.uploading = false;
      setState({ error: error.message });
    }
  }

  /** The answer area for a writing task. */
  function writingBlock(task, done, isLast, allAnswered) {
    if (done) {
      return `<div class="alert alert-ok">Answer saved for ${esc(task.part || 'this task')}.</div>
        <div class="transcript" style="margin-top:12px">${esc(done.transcription)}</div>
        <p class="muted" style="margin-top:8px">${countWords(done.transcription)} words</p>
        <div class="row" style="margin-top:16px;justify-content:space-between">
          <button class="btn btn-ghost btn-sm" data-action="redo">Rewrite</button>
          ${isLast
            ? (allAnswered ? '<button class="btn" data-action="finish">Submit for assessment</button>' : '')
            : '<button class="btn" data-action="next">Next task</button>'}
        </div>`;
    }

    return `
      <textarea id="essay" class="essay" placeholder="Write your answer here…"
                oninput="document.getElementById('wc').textContent = this.value.trim().split(/\\s+/).filter(Boolean).length"></textarea>
      <div class="row" style="justify-content:space-between;margin-top:10px">
        <span class="muted"><span id="wc">0</span> words${task.minWords ? ` · at least ${task.minWords} required` : ''}</span>
        <button class="btn" data-action="save-writing" ${rec.uploading ? 'disabled' : ''}>
          ${rec.uploading ? 'Saving…' : 'Save answer'}
        </button>
      </div>`;
  }

  // ------------------------------------------------------------ rendering

  function render() {
    root.innerHTML = screenMarkup();
    wire();
  }

  /**
   * May the student navigate away right now?
   *
   * Only a question that is actually running is protected — thinking time,
   * speaking time, and the save that follows. Once the attempt has finished,
   * errored, or is waiting to start, there is nothing left to protect and
   * leaving must be possible. Blocking on the whole exam screen instead used to
   * strand a student with no way back whenever an attempt ended badly.
   */
  function canLeave() {
    if (state.screen !== 'exam') return true;
    return !['prep', 'answer', 'saving'].includes(run.phase);
  }

  function brandMarkup() {
    // A real button, so it is reachable by keyboard and announced as a control.
    return canLeave() && state.user
      ? `<button class="brand brand-btn" data-go="dashboard" title="Back to dashboard">CEFR Speaking</button>`
      : `<div class="brand">CEFR Speaking</div>`;
  }

  function navMarkup() {
    if (!state.user) {
      return `<nav class="nav">
        ${brandMarkup()}
        <div class="nav-right">
          <button class="btn btn-ghost btn-sm" data-go="login">Sign in</button>
        </div>
      </nav>`;
    }
    // Mid-exam every link comes off: leaving a running question loses the
    // answer, so canLeave() gates the whole set rather than some of it.
    // Teachers and students see different places, and "Questions" has to stay
    // invisible to a student — a link they cannot use reads as a fault.
    const link = (screen, label) =>
      `<button class="nav-link ${state.screen === screen ? 'is-current' : ''}" data-go="${screen}">${label}</button>`;

    const links = !canLeave()
      ? ''
      : state.user.role === 'admin'
      ? `${link('dashboard', 'Dashboard')}
         <a class="nav-link" href="/admin.html">Questions</a>`
      : `${link('dashboard', 'Dashboard')}${link('results', 'My results')}`;

    const initials = String(state.user.firstName || state.user.email || '?')
      .trim().charAt(0).toUpperCase();

    return `<nav class="nav">
      ${brandMarkup()}
      <div class="nav-links">${links}</div>
      <div class="nav-right">
        <span class="avatar" aria-hidden="true">${esc(initials)}</span>
        <span class="nav-user">${esc(state.user.firstName || state.user.email)}</span>
        <button class="btn btn-ghost btn-sm" data-action="signout">Sign out</button>
      </div>
    </nav>`;
  }

  function alerts() {
    let html = '';
    if (state.error) html += `<div class="alert alert-error">${esc(state.error)}</div>`;
    if (state.notice) html += `<div class="alert alert-warn">${esc(state.notice)}</div>`;
    return html;
  }

  function screenMarkup() {
    const body = {
      landing: landingScreen,
      signup: () => authScreen('signup'),
      login: () => authScreen('login'),
      dashboard: dashboardScreen,
      mocks: mocksScreen,
      results: resultsScreen,
      briefing: briefingScreen,
      topup: topupScreen,
      exam: examScreen,
      submitted: submittedScreen,
      result: resultScreen
    }[state.screen] || landingScreen;

    return `${navMarkup()}<main class="stack">${alerts()}${body()}</main>`;
  }

  function landingScreen() {
    return `
      <section class="hero">
        <h1>Find your real English speaking level</h1>
        <p>Record answers to CEFR-calibrated tasks and get graded on grammar, vocabulary, fluency, pronunciation and coherence — with written feedback on each.</p>
        <div class="row">
          <button class="btn" data-go="signup">Get started</button>
          <button class="btn btn-ghost" data-go="login">I have an account</button>
        </div>
      </section>
      <div class="grid grid-3">
        <div class="card"><div class="section-title">1 — Record</div><p class="muted" style="margin-top:8px">Speak your answer to each task straight in the browser. Nothing to install.</p></div>
        <div class="card"><div class="section-title">2 — Assessed</div><p class="muted" style="margin-top:8px">Each response is scored against the CEFR descriptors for that level.</p></div>
        <div class="card"><div class="section-title">3 — Feedback</div><p class="muted" style="margin-top:8px">See your level, your strengths, and exactly what to work on next.</p></div>
      </div>`;
  }

  function authScreen(mode) {
    const isSignup = mode === 'signup';
    return `
      <div class="card form-card">
        <h2 style="margin-bottom:18px">${isSignup ? 'Create your account' : 'Welcome back'}</h2>
        <form id="auth-form">
          ${isSignup ? `
          <div class="field">
            <label for="name">Full name</label>
            <input id="name" name="name" autocomplete="name" required />
          </div>` : ''}
          <div class="field">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="email" required />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" minlength="8"
                   autocomplete="${isSignup ? 'new-password' : 'current-password'}" required />
            ${isSignup ? '<span class="muted">At least 8 characters.</span>' : ''}
          </div>
          <button class="btn btn-block" type="submit" ${state.loading ? 'disabled' : ''}>
            ${state.loading ? 'Working…' : isSignup ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <p class="muted" style="text-align:center;margin-top:16px">
          ${isSignup ? 'Already registered?' : 'No account yet?'}
          <a href="#" data-go="${isSignup ? 'login' : 'signup'}">${isSignup ? 'Sign in' : 'Create one'}</a>
        </p>
      </div>`;
  }

  // ---------------------------------------------------------------- icons

  /**
   * One icon family (Lucide), inlined as SVG paths.
   *
   * Inlined rather than loaded: an icon font or sprite is another request that
   * can fail, and these are small. `currentColor` means an icon takes the colour
   * of whatever contains it, so tiles and buttons need no icon-specific colours.
   */
  const ICONS = {
    mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    right: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    left: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
  };

  const icon = name =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  const PART_ICON = { '1.1': 'mic', '1.2': 'image', '2': 'message', '3': 'users' };

  // ------------------------------------------------------- derived figures

  /** Completed attempts, newest first. */
  const completedAttempts = () =>
    (state.history || []).filter(h => h.status === 'completed' && typeof h.overallScore === 'number');

  /**
   * Where a score sits between CEFR boundaries, and how far to the next one.
   * The bands come from the server so this can never disagree with the marking.
   */
  function cefrPosition(score) {
    const stats = state.stats || {};
    const bands = (stats.bands || []).slice().sort((a, b) => a.min - b.min);
    const max = stats.maxScore || MAX_SCORE;
    if (!bands.length || typeof score !== 'number') return null;

    const current = [...bands].reverse().find(b => score >= b.min) || bands[0];
    const next = bands.find(b => b.min > score) || null;

    return {
      bands, max, current, next,
      pointsToNext: next ? next.min - score : 0,
      percent: Math.max(0, Math.min(100, (score / max) * 100))
    };
  }

  /** What a student has done on each exam, for the mocks listing. */
  function attemptsByExam() {
    const map = {};
    for (const h of state.history || []) {
      if (!h.examId) continue;
      const entry = map[h.examId] || (map[h.examId] = { best: null, bestLevel: null, bestId: null, inProgress: false, count: 0 });
      if (h.status === 'in_progress') entry.inProgress = true;
      if (h.status === 'completed' && typeof h.overallScore === 'number') {
        entry.count += 1;
        if (entry.best === null || h.overallScore > entry.best) {
          entry.best = h.overallScore;
          entry.bestLevel = h.overallLevel;
          entry.bestId = h.id;
        }
      }
    }
    return map;
  }

  // ------------------------------------------------------------- dashboard

  function statCard(iconName, label, figure, note, noteClass = '') {
    return `<div class="card stat-card">
      <div class="icon-tile">${icon(iconName)}</div>
      <div>
        <div class="stat-label">${esc(label)}</div>
        <div class="stat-figure">${figure}</div>
        ${note ? `<div class="stat-note ${noteClass}">${esc(note)}</div>` : ''}
      </div>
    </div>`;
  }

  function cefrCard(score) {
    const pos = cefrPosition(score);
    if (!pos) return '';

    return `<div class="card">
      <div class="section-head"><h2>Your CEFR progress</h2>
        <p>Where this score sits on the Multilevel scale.</p></div>
      <div class="cefr">
        <div class="cefr-track">
          <div class="cefr-fill" style="width:${pos.percent}%"></div>
          ${pos.bands.filter(b => b.min > 0).map(b =>
            `<div class="cefr-tick" style="left:${(b.min / pos.max) * 100}%"></div>`).join('')}
          <div class="cefr-marker" style="left:${pos.percent}%"></div>
          <div class="cefr-marker-label" style="left:${pos.percent}%">${score}</div>
        </div>
        <div class="cefr-scale">
          ${pos.bands.map(b =>
            `<span class="cefr-band" style="left:${Math.max(2, Math.min(98, (b.min / pos.max) * 100))}%">${esc(b.level)}</span>`).join('')}
        </div>
        <div class="cefr-summary">
          <span class="cefr-level">${esc(pos.current.level)}</span>
          <span class="cefr-score">${score} / ${pos.max}</span>
        </div>
        <p class="cefr-next">${pos.next
          ? `<strong>${pos.pointsToNext} point${pos.pointsToNext === 1 ? '' : 's'}</strong> to reach ${esc(pos.next.level)}.`
          : `You are in the highest band on this scale.`}</p>
      </div>
    </div>`;
  }

  function skillsCard() {
    const skills = state.stats?.skills;
    if (!skills || !Object.keys(skills).length) return '';

    const max = state.stats?.maxScore || MAX_SCORE;
    // Out of ten reads better on a bar than out of seventy-five, and the spec
    // asks for it — but the underlying mark is the same 0-75 as everywhere else.
    const toTen = v => Math.round((v / max) * 10 * 10) / 10;

    const ORDER = ['fluency', 'vocabulary', 'grammar', 'pronunciation', 'coherence', 'taskAchievement'];
    const entries = Object.entries(skills)
      .sort((a, b) => (ORDER.indexOf(a[0]) + 99) % 99 - (ORDER.indexOf(b[0]) + 99) % 99);

    const sorted = [...entries].sort((a, b) => b[1] - a[1]);
    const strongest = sorted[0];
    const weakest = sorted[sorted.length - 1];

    return `<div class="card">
      <div class="section-head"><h2>Speaking skills</h2>
        <p>Averaged across your recent attempts.</p></div>
      ${entries.map(([name, value]) => `
        <div class="skill">
          <div class="skill-head">
            <span class="skill-name">${esc(criterionLabel(name))}</span>
            <span class="skill-score">${toTen(value).toFixed(1)} / 10</span>
          </div>
          <div class="skill-track"><div class="skill-fill" style="width:${Math.max(0, Math.min(100, (value / max) * 100))}%"></div></div>
        </div>`).join('')}
      ${strongest && weakest && strongest[0] !== weakest[0]
        ? `<div class="skill-insights">
             <span>Strongest: <b>${esc(criterionLabel(strongest[0]))}</b></span>
             <span>Needs work: <b>${esc(criterionLabel(weakest[0]))}</b></span>
           </div>`
        : ''}
    </div>`;
  }

  /**
   * The five most recent attempts — including ones still being marked.
   *
   * A student is sent here the moment they hand in, so an attempt that is still
   * being marked has to be visible. Showing only finished ones meant they
   * arrived to find nothing, which reads as "my test disappeared" — a good deal
   * worse than the spinner this replaced.
   */
  function recentCard() {
    const max = state.stats?.maxScore || MAX_SCORE;
    const recent = (state.history || [])
      .filter(h => h.status === 'completed' || h.status === 'evaluating' || h.status === 'submitted')
      .slice(0, 5);
    if (!recent.length) return '';

    const row = item => {
      const pending = item.status !== 'completed';

      // Nothing to open yet, so a pending row is not a button: it would look
      // like something to press and do nothing when pressed.
      if (pending) {
        return `<div class="attempt attempt-pending">
          <span class="attempt-name">${esc(item.examTitle)}</span>
          <span class="chip chip-progress"><span class="pulse"></span> Tekshirilmoqda…</span>
          <span class="attempt-date">${esc(fmtDate(item.startedAt))}</span>
        </div>`;
      }

      return `<button class="attempt" data-result="${esc(item.id)}">
        <span class="attempt-name">${esc(item.examTitle)}</span>
        <span class="attempt-score">${item.overallScore}/${max}</span>
        <span class="chip chip-speaking">${esc(item.overallLevel || '—')}</span>
        <span class="attempt-date">${esc(fmtDate(item.completedAt))}</span>
      </button>`;
    };

    return `<div class="card">
      <div class="section-head"><h2>Recent attempts</h2>
        <p>Tap any attempt to read its feedback.</p></div>
      ${recent.map(row).join('')}
      <button class="link-more" data-go="results">View all results ${icon('chevron')}</button>
    </div>`;
  }

  function firstMockEmptyState() {
    return `<div class="card empty-state">
      <div class="icon-tile">${icon('mic')}</div>
      <h3>Take your first speaking mock</h3>
      <p>Complete one full test to find your estimated CEFR level and get detailed
         feedback on fluency, vocabulary, grammar and pronunciation.</p>
      <button class="btn btn-lg" data-folder="speaking">Start my first mock ${icon('right')}</button>
    </div>`;
  }

  /**
   * Everything the student reads about access, in Uzbek.
   *
   * Money and permission are exactly where a misunderstanding costs the most, so
   * these are the last strings that should be left in English. The teacher's
   * contact details are not here — they come from the server, because they can
   * change without the app changing.
   */
  const ACCESS_UZ = {
    remaining: n => `Qolgan mock: ${n}`,
    remainingNone: 'Mock qolmadi',
    free: "Birinchi mock — bepul",

    outTitle: 'Mock imtihonlaringiz tugadi',
    outBody:
      "Har bir mock yozuvni matnga o'girish va tekshirish uchun haqiqiy pul talab qiladi, " +
      "shuning uchun birinchi bepul mockdan keyin ustoz ruxsat beradi.",

    blockedTitle: 'Ruxsat vaqtincha to\'xtatilgan',
    blockedBody:
      "Ustozingiz hisobingizni vaqtincha to'xtatib qo'ygan. Natijalaringiz saqlanib qoladi — " +
      "ular yo'qolmaydi. Davom etish uchun ustoz bilan bog'laning.",

    how: 'Qanday davom ettirish mumkin',
    step1: "Quyidagi manzil orqali ustoz bilan bog'laning.",
    step2: "To'lovni ustoz aytgan tarzda amalga oshiring — to'lov sayt orqali emas.",
    step3:
      "Ustoz ruxsat berishi bilan shu yerda xabar ko'rinadi va mock imtihon ochiladi. " +
      "Ro'yxatdan o'tgan pochtangizni ayting:",
    noContact:
      "Ustozingizning aloqa ma'lumoti hali kiritilmagan. Iltimos, unga o'zingiz murojaat qiling.",
    later: 'Keyinroq',
    toDashboard: 'Bosh sahifaga qaytish',
    dismiss: 'Tushunarli'
  };

  /**
   * The teacher's notice — normally "your payment landed, here are your mocks".
   *
   * A payment made outside the app has to be confirmed inside it, or the student
   * has paid and has no way to know it worked until they try to start a test.
   * Dismissing it clears it on the server, so it appears once and not on every
   * device forever.
   */
  function accessNotice() {
    const message = state.access?.message;
    if (!message) return '';

    return `<div class="alert alert-ok" style="display:flex;justify-content:space-between;gap:12px;align-items:center">
      <span>${esc(message)}</span>
      <button class="btn btn-ghost btn-sm" data-action="notice-seen">${ACCESS_UZ.dismiss}</button>
    </div>`;
  }

  /**
   * The page a student lands on when they have nothing left to spend.
   *
   * It is not an error page: running out is the normal end of the free sample,
   * and a student who paid last week and is waiting needs to see what happens
   * next rather than a red bar. "Keyinroq" leaves without paying, on purpose —
   * their results are still theirs to read.
   */
  function topupScreen() {
    const access = state.access || {};
    const blocked = Boolean(access.blocked);
    const contact = access.contact || '';

    const contactBlock = contact
      ? `<a class="btn btn-lg" href="${esc(
          contact.startsWith('http') ? contact : `https://t.me/${contact.replace(/^@/, '')}`
        )}" target="_blank" rel="noopener noreferrer">${esc(contact)}</a>`
      : `<p class="muted">${ACCESS_UZ.noContact}</p>`;

    return `
      <div class="card form-card" style="max-width:560px">
        <h2 style="margin-bottom:8px">${blocked ? ACCESS_UZ.blockedTitle : ACCESS_UZ.outTitle}</h2>
        <p class="muted">${blocked ? ACCESS_UZ.blockedBody : ACCESS_UZ.outBody}</p>

        <h3 style="font-size:15px;margin-top:22px">${ACCESS_UZ.how}</h3>
        <ol style="margin:10px 0 0 18px;line-height:1.7">
          <li>${ACCESS_UZ.step1}</li>
          <li>${ACCESS_UZ.step2}</li>
          <li>${ACCESS_UZ.step3} <strong>${esc(state.user?.email || '')}</strong></li>
        </ol>

        <div style="margin-top:20px">${contactBlock}</div>

        <button class="btn btn-ghost btn-block" style="margin-top:14px" data-go="dashboard">
          ${ACCESS_UZ.later}
        </button>
      </div>`;
  }

  function dashboardScreen() {
    if (state.loading && !state.exams.length) {
      return `<div class="center-note"><span class="spinner"></span><p style="margin-top:12px">Loading…</p></div>`;
    }

    const stats = state.stats || {};
    const done = completedAttempts();
    const hasResults = done.length > 0;
    const max = stats.maxScore || MAX_SCORE;
    const best = typeof stats.bestScore === 'number' ? stats.bestScore : null;
    const pos = best !== null ? cefrPosition(best) : null;

    const speaking = (state.exams || []).filter(e => (e.module || 'speaking') === 'speaking');
    const writing = (state.exams || []).filter(e => e.module === 'writing');

    const name = state.user?.firstName || '';

    // The balance sits next to the button that spends it. A student who finds
    // out they have none only after clicking Start has already been surprised.
    const remaining = state.access?.remaining;
    const counter = typeof remaining === 'number'
      ? `<p class="muted" style="margin-top:8px;text-align:center">${
          state.access?.blocked
            ? esc(ACCESS_UZ.blockedTitle)
            : remaining > 0
            ? esc(ACCESS_UZ.remaining(remaining))
            : `${esc(ACCESS_UZ.remainingNone)} · <button class="link-more" data-go="topup">${esc(ACCESS_UZ.how)}</button>`
        }</p>`
      : '';

    const welcome = `<div class="welcome">
      <div>
        <h1>Welcome back${name ? `, ${esc(name)}` : ''} 👋</h1>
        <p>Ready to test your English speaking skills?</p>
      </div>
      <div>
        <button class="btn btn-lg" data-folder="speaking">${icon('mic')} Start a speaking mock</button>
        ${counter}
      </div>
    </div>`;

    const statsRow = `<div class="stat-grid">
      ${statCard('mic', 'Mocks completed', done.length,
        stats.completedThisMonth ? `↑ ${stats.completedThisMonth} this month` : (hasResults ? '' : 'Take your first mock'),
        stats.completedThisMonth ? 'up' : '')}
      ${statCard('trophy', 'Best score',
        best !== null ? `${best}<span class="of"> / ${max}</span>` : '—',
        best !== null && typeof stats.previousBest === 'number'
          ? `+${best - stats.previousBest} from previous best`
          : (hasResults ? '' : 'No score yet'),
        best !== null && typeof stats.previousBest === 'number' && best > stats.previousBest ? 'up' : '')}
      ${statCard('target', 'Current level',
        stats.currentLevel ? esc(stats.currentLevel) : '—',
        pos ? (pos.next ? `${pos.pointsToNext} points to ${pos.next.level}` : 'Highest band reached') : 'Complete a mock to find out')}
    </div>`;

    const speakingCard = `<div class="card feature-card card-hover">
      <div class="feature-icon">${icon('mic')}</div>
      <div class="grow">
        <div class="row" style="gap:10px"><h3>Speaking mock</h3><span class="chip chip-speaking">Speaking</span></div>
        <p class="mock-sub">Practise Parts 1.1, 1.2, 2 and 3.</p>
        <div class="meta-row">
          <span>${icon('clock')} ~12 min</span>
          <span>${icon('mic')} Recorded</span>
          <span>${icon('check')} Evaluated</span>
        </div>
      </div>
      <div>
        <button class="btn btn-lg" data-folder="speaking">Start mock ${icon('right')}</button>
        <p class="muted" style="margin-top:8px;text-align:center">${speaking.length} mock${speaking.length === 1 ? '' : 's'} available</p>
      </div>
    </div>`;

    const writingCard = writing.length ? `<div class="card secondary-card card-hover">
      <div class="secondary-icon">${icon('pen')}</div>
      <div class="grow">
        <div class="row" style="gap:10px"><h3>Writing mock</h3><span class="chip chip-writing">Writing</span></div>
        <p class="mock-sub">Task 1 and Task 2 — written and evaluated.</p>
        <div class="meta-row">
          <span>${icon('pen')} Written</span>
          <span>${icon('check')} Evaluated</span>
        </div>
      </div>
      <div>
        <button class="btn btn-ghost" data-folder="writing">Start writing ${icon('right')}</button>
        <p class="muted" style="margin-top:8px;text-align:center">${writing.length} mock${writing.length === 1 ? '' : 's'} available</p>
      </div>
    </div>` : '';

    // A student who has just handed in their first mock has no completed
    // attempt yet, but they were sent here to watch for it — so the recent list
    // has to show even while the analytics below it have nothing to draw.
    const analytics = hasResults
      ? `${cefrCard(best)}
         <div class="split">${skillsCard()}${recentCard()}</div>`
      : pendingAttempts().length
      ? recentCard()
      : firstMockEmptyState();

    return `
      ${accessNotice()}
      ${welcome}
      ${statsRow}
      <div class="section-head" style="margin-top:8px"><h2>Ready for your next test?</h2>
        <p>Practise the real CEFR format and see how you perform.</p></div>
      <div class="stack" style="margin-bottom:36px">
        ${speakingCard}
        ${writingCard}
      </div>
      <div class="stack">${analytics}</div>`;
  }

  // --------------------------------------------------------- mocks listing

  const MOCK_SORTS = {
    recommended: 'Recommended',
    newest: 'Newest',
    oldest: 'Oldest',
    unattempted: 'Not attempted',
    best: 'Highest score'
  };

  function mockStatus(exam, attempts) {
    const a = attempts[exam.id];
    if (a?.best !== null && a?.best !== undefined) return 'completed';
    if (a?.inProgress) return 'in_progress';
    return 'not_started';
  }

  function mocksScreen() {
    const folder = state.folder || 'speaking';
    const isWriting = folder === 'writing';
    const attempts = attemptsByExam();
    const max = state.stats?.maxScore || MAX_SCORE;

    let list = (state.exams || []).filter(e => (e.module || 'speaking') === folder);

    const query = (state.mockSearch || '').trim().toLowerCase();
    if (query) {
      list = list.filter(e =>
        e.title.toLowerCase().includes(query) ||
        (e.description || '').toLowerCase().includes(query) ||
        (e.module || 'speaking').includes(query));
    }

    const statusFilter = state.mockStatus || 'all';
    if (statusFilter !== 'all') list = list.filter(e => mockStatus(e, attempts) === statusFilter);

    const byNumber = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
    const sort = state.mockSort || 'recommended';
    list = [...list].sort((a, b) => {
      if (sort === 'newest') return byNumber(b, a);
      if (sort === 'oldest') return byNumber(a, b);
      if (sort === 'best') return (attempts[b.id]?.best ?? -1) - (attempts[a.id]?.best ?? -1);
      if (sort === 'unattempted') {
        const rank = e => (mockStatus(e, attempts) === 'not_started' ? 0 : 1);
        return rank(a) - rank(b) || byNumber(a, b);
      }
      // Recommended: anything untouched first, then in progress, then done.
      const rank = e => ({ not_started: 0, in_progress: 1, completed: 2 }[mockStatus(e, attempts)]);
      return rank(a) - rank(b) || byNumber(a, b);
    });

    const featured = sort === 'recommended' && !query && statusFilter === 'all' ? list[0] : null;
    const rest = featured ? list.slice(1) : list;

    const toolbar = `<div class="toolbar">
      <div class="search">${icon('search')}
        <input type="search" id="mock-search" placeholder="Search mocks…" value="${esc(state.mockSearch || '')}" />
      </div>
      <select id="mock-status" aria-label="Filter by status">
        ${Object.entries({
          all: 'All statuses', not_started: 'Not started',
          in_progress: 'In progress', completed: 'Completed'
        }).map(([k, v]) =>
          `<option value="${k}" ${statusFilter === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <select id="mock-sort" aria-label="Sort">
        ${Object.entries(MOCK_SORTS).map(([k, v]) =>
          `<option value="${k}" ${sort === k ? 'selected' : ''}>Sort: ${v}</option>`).join('')}
      </select>
    </div>`;

    const statusChip = status => ({
      completed: `<span class="chip chip-done">${icon('check')} Completed</span>`,
      in_progress: `<span class="chip chip-progress">In progress</span>`,
      not_started: `<span class="chip chip-new">Not started</span>`
    }[status]);

    const partChips = exam => (exam.parts || []).length
      ? `<div class="practise-row">
           <span class="label">Practise:</span>
           ${exam.parts.map(p =>
             `<button class="chip-btn" data-start="${esc(exam.id)}" data-mode="practice" data-part="${esc(p)}">${esc(p)}</button>`).join('')}
         </div>`
      : '';

    const mockCard = (exam, isFeatured = false) => {
      const status = mockStatus(exam, attempts);
      const a = attempts[exam.id];
      const minutes = Math.round((exam.duration || 0) / 60);

      return `<div class="card mock-card card-hover ${isFeatured ? 'featured' : ''}">
        ${isFeatured ? `<div class="chip chip-speaking" style="align-self:flex-start;margin-bottom:12px">${icon('star')} Recommended</div>` : ''}
        <div class="mock-top">
          <h3>${esc(exam.title)}</h3>
          ${statusChip(status)}
        </div>
        <p class="mock-sub">${isWriting ? 'Full writing test' : 'Full speaking test'}</p>
        ${(exam.parts || []).length ? `<p class="mock-parts">Parts ${exam.parts.map(esc).join(' · ')}</p>` : ''}
        <p class="mock-meta">${exam.totalTasks || exam.totalQuestions || 0} questions${minutes ? ` · ~${minutes} min` : ''}</p>
        ${status === 'completed' ? `<div class="mock-best">
          <div class="stat-label">Best score</div>
          <div class="value">${a.best} / ${max} · ${esc(a.bestLevel || '')}</div>
        </div>` : ''}
        <div class="spacer"></div>
        <div class="row" style="margin-top:14px">
          <button class="btn ${isFeatured ? 'btn-lg' : ''}" data-start="${esc(exam.id)}" data-mode="mock">
            ${status === 'completed' ? 'Retake mock' : 'Start full mock'} ${icon('right')}
          </button>
          ${status === 'completed' ? `<button class="btn btn-ghost" data-result="${esc(a.bestId)}">View result</button>` : ''}
        </div>
        ${partChips(exam)}
      </div>`;
    };

    const empty = `<div class="card empty-state">
      <div class="icon-tile">${icon('search')}</div>
      <h3>No mock tests found</h3>
      <p>Try another search, or clear the filters.</p>
      <button class="btn btn-ghost" data-clear-filters="1">Clear filters</button>
    </div>`;

    const total = (state.exams || []).filter(e => (e.module || 'speaking') === folder).length;

    return `
      <div style="margin-bottom:18px">
        <button class="crumb" data-go="dashboard">${icon('left')} All mock exams</button>
        <h1 style="font-size:26px;margin:10px 0 4px">Mock exams</h1>
        <p class="muted">Choose a full test or practise a specific part.
          &nbsp;·&nbsp; ${isWriting ? 'Writing' : 'Speaking'} · ${total} mock test${total === 1 ? '' : 's'}</p>
      </div>
      ${toolbar}
      ${list.length
        ? `<div class="mock-grid">
             ${featured ? `<div class="featured-wrap">${mockCard(featured, true)}</div>` : ''}
             ${rest.map(e => mockCard(e)).join('')}
           </div>`
        : empty}`;
  }

  // ------------------------------------------------------- results archive

  function resultsScreen() {
    const selected = state.selected || {};
    const selectedIds = (state.history || []).filter(h => selected[h.id]).map(h => h.id);
    const allSelected = state.history.length > 0 && selectedIds.length === state.history.length;
    const max = state.stats?.maxScore || MAX_SCORE;

    const selectionBar = selectedIds.length
      ? `<div class="select-bar">
           <strong>${selectedIds.length} selected</strong>
           <button class="btn btn-ghost btn-sm" data-select-all="${allSelected ? 'none' : 'all'}">
             ${allSelected ? 'Clear selection' : `Select all ${state.history.length}`}
           </button>
           <span class="spacer"></span>
           ${state.confirmBulk
             ? `<span class="confirm-delete">
                  <span class="muted">Delete ${selectedIds.length} attempt${selectedIds.length === 1 ? '' : 's'} and their recordings?</span>
                  <button class="btn btn-danger btn-sm" data-bulk-confirm="1">Yes, delete ${selectedIds.length}</button>
                  <button class="btn btn-ghost btn-sm" data-bulk-cancel="1">Keep</button>
                </span>`
             : `<button class="btn btn-danger btn-sm" data-bulk-delete="1">Delete selected</button>`}
         </div>`
      : '';

    if (!state.history.length) {
      return `
        <button class="crumb" data-go="dashboard">${icon('left')} Dashboard</button>
        <h1 style="font-size:26px;margin:10px 0 18px">My results</h1>
        <div class="card empty-state">
          <div class="icon-tile">${icon('chart')}</div>
          <h3>No results yet</h3>
          <p>Your completed mocks and their feedback will appear here.</p>
          <button class="btn" data-folder="speaking">Start a mock ${icon('right')}</button>
        </div>`;
    }

    return `
      <button class="crumb" data-go="dashboard">${icon('left')} Dashboard</button>
      <h1 style="font-size:26px;margin:10px 0 4px">My results</h1>
      <p class="muted" style="margin-bottom:18px">Every attempt, with its recordings and feedback.</p>
      ${selectionBar}
      <div class="stack">${state.history.map(item => `
        <div class="card row ${selected[item.id] ? 'row-selected' : ''}" style="justify-content:space-between">
          <div class="row">
            <input type="checkbox" class="pick" id="pick-${esc(item.id)}"
                   data-pick="${esc(item.id)}" ${selected[item.id] ? 'checked' : ''}
                   aria-label="Select this attempt" />
            <label for="pick-${esc(item.id)}">
              <strong>${esc(item.examTitle)}</strong>
              <div class="muted">${esc(item.status === 'completed' ? fmtDate(item.completedAt) : item.status.replace('_', ' '))}</div>
            </label>
          </div>
          <div class="row">
            ${item.status === 'completed'
              ? `<span class="attempt-score">${item.overallScore}/${max}</span>
                 <span class="chip chip-speaking">${esc(item.overallLevel || '—')}</span>
                 <button class="btn btn-ghost btn-sm" data-result="${esc(item.id)}">View</button>`
              : `<span class="chip chip-progress">${esc(item.status.replace('_', ' '))}</span>`}
            ${state.confirmDelete === item.id
              ? `<span class="confirm-delete">
                   <span class="muted">Delete this attempt and its recordings?</span>
                   <button class="btn btn-danger btn-sm" data-delete-confirm="${esc(item.id)}">Yes, delete</button>
                   <button class="btn btn-ghost btn-sm" data-delete-cancel="1">Keep</button>
                 </span>`
              : `<button class="btn btn-ghost btn-sm btn-quiet" data-delete="${esc(item.id)}" title="Delete this attempt">Delete</button>`}
          </div>
        </div>`).join('')}</div>`;
  }

  // -------------------------------------------------- briefing and mic check

  /**
   * Live objects for the microphone check, kept out of `state` for the same
   * reason the recorder is: they must survive a re-render.
   */
  const mic = {
    stream: null,
    recorder: null,
    chunks: [],
    context: null,
    analyser: null,
    frame: null,
    blobUrl: null,
    peak: 0,
    stopAt: 0
  };

  const MIC_CHECK_SECONDS = 4;
  // Below this the microphone is delivering something, but nothing you could
  // call speech — a muted input, or a phone held too far away. Room tone alone
  // sits around 1-2%, so 5% is roughly "someone spoke".
  const MIC_QUIET_PEAK = 0.05;

  /** Let go of the microphone and stop drawing. Safe to call at any point. */
  function stopMicCheck({ keepPlayback = false } = {}) {
    if (mic.frame) cancelAnimationFrame(mic.frame);
    mic.frame = null;
    try { mic.recorder?.state === 'recording' && mic.recorder.stop(); } catch { /* already stopped */ }
    mic.stream?.getTracks().forEach(track => track.stop());
    mic.stream = null;
    try { mic.context?.close(); } catch { /* already closed */ }
    mic.context = null;
    mic.analyser = null;
    if (!keepPlayback && mic.blobUrl) {
      URL.revokeObjectURL(mic.blobUrl);
      mic.blobUrl = null;
    }
  }

  /**
   * Record a few seconds, play them back, and say whether they carried sound.
   *
   * This exists because of a real failure: students recorded whole mocks on
   * phones and were handed zeros, because nothing had ever proved the
   * microphone worked. Four seconds before the first question is the cheapest
   * possible moment to find out — and hearing themselves back is the only
   * check a student can actually trust.
   */
  async function runMicCheck() {
    stopMicCheck();
    mic.peak = 0;

    if (!navigator.mediaDevices?.getUserMedia) {
      return setState({
        micCheck: { phase: 'failed', message: BRIEF_UZ.errNoApi }
      });
    }

    setState({ micCheck: { phase: 'asking' } });

    try {
      mic.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const denied = /NotAllowed|Permission|Security/i.test(error.name || '');
      return setState({
        micCheck: {
          phase: 'failed',
          message: denied
            ? BRIEF_UZ.errDenied
            : BRIEF_UZ.errOpen(error.name || 'unknown error')
        }
      });
    }

    // Meter first: a student watching a bar move knows the microphone is live
    // before any of the machinery behind it has finished.
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      mic.context = new AudioContextClass();
      mic.analyser = mic.context.createAnalyser();
      mic.analyser.fftSize = 1024;
      mic.context.createMediaStreamSource(mic.stream).connect(mic.analyser);
    } catch {
      // No meter on this browser. The playback is still the real test, so the
      // check goes ahead without it rather than failing.
      mic.analyser = null;
    }

    mic.chunks = [];
    try {
      mic.recorder = new MediaRecorder(mic.stream);
    } catch (error) {
      stopMicCheck();
      return setState({
        micCheck: { phase: 'failed', message: BRIEF_UZ.errRecorder(error.name || 'unknown error') }
      });
    }

    mic.recorder.ondataavailable = event => {
      if (event.data.size) mic.chunks.push(event.data);
    };

    mic.recorder.onstop = () => {
      const blob = new Blob(mic.chunks, { type: mic.recorder.mimeType || 'audio/webm' });
      const heard = mic.peak >= MIC_QUIET_PEAK;
      if (mic.blobUrl) URL.revokeObjectURL(mic.blobUrl);
      mic.blobUrl = blob.size ? URL.createObjectURL(blob) : null;

      stopMicCheck({ keepPlayback: true });

      setState({
        micCheck: {
          phase: heard && mic.blobUrl ? 'passed' : 'quiet',
          peak: Math.round(mic.peak * 100),
          playback: mic.blobUrl,
          message: mic.blobUrl ? '' : BRIEF_UZ.errEmpty
        }
      });
    };

    mic.stopAt = Date.now() + MIC_CHECK_SECONDS * 1000;
    mic.recorder.start();
    setState({ micCheck: { phase: 'listening', peak: 0 } });
    meterTick();
  }

  /**
   * Drive the level meter and the countdown straight through the DOM.
   *
   * Sixty re-renders a second would rebuild the page under the student's
   * fingers, so this writes to the two elements it owns and nothing else.
   */
  function meterTick() {
    const bar = document.getElementById('mic-level');
    const countdown = document.getElementById('mic-countdown');
    if (!bar) return;

    let level = 0;
    if (mic.analyser) {
      const samples = new Uint8Array(mic.analyser.fftSize);
      mic.analyser.getByteTimeDomainData(samples);
      let furthest = 0;
      for (const sample of samples) furthest = Math.max(furthest, Math.abs(sample - 128));
      level = furthest / 128;
      mic.peak = Math.max(mic.peak, level);
    }

    // A little headroom so normal speech fills most of the bar rather than
    // pinning it — the point is to show movement, not to be a meter.
    bar.style.width = `${Math.min(100, level * 180)}%`;
    bar.classList.toggle('is-live', level >= MIC_QUIET_PEAK);

    const left = Math.max(0, Math.ceil((mic.stopAt - Date.now()) / 1000));
    if (countdown) countdown.textContent = String(left);

    if (Date.now() >= mic.stopAt) {
      try { mic.recorder?.state === 'recording' && mic.recorder.stop(); } catch { /* already stopped */ }
      return;
    }
    mic.frame = requestAnimationFrame(meterTick);
  }

  function micCheckCard() {
    const check = state.micCheck || { phase: 'idle' };
    const canTranscribe = state.serverTranscription || Boolean(SpeechRecognition);

    const body = {
      idle: `<p class="muted">${BRIEF_UZ.micIdle(MIC_CHECK_SECONDS)}</p>
             <button class="btn" data-action="mic-check">${icon('mic')} ${BRIEF_UZ.micTest}</button>`,

      asking: `<p class="muted">${BRIEF_UZ.micAsking}</p>
               <span class="spinner"></span>`,

      listening: `<div class="mic-live">
                    <div class="mic-meter"><div class="mic-level" id="mic-level"></div></div>
                    <span class="mic-countdown"><span id="mic-countdown">${MIC_CHECK_SECONDS}</span>s</span>
                  </div>
                  <p class="muted">${BRIEF_UZ.micSay}</p>`,

      passed: `<div class="mic-verdict ok">${icon('check')} <strong>${BRIEF_UZ.micPassed}</strong></div>
               <p class="muted">${BRIEF_UZ.micPlayback}</p>
               <audio controls src="${esc(check.playback || '')}"></audio>
               <button class="btn btn-ghost btn-sm" data-action="mic-check">${BRIEF_UZ.micRetest}</button>`,

      quiet: `<div class="mic-verdict warn"><strong>${BRIEF_UZ.micQuiet}</strong></div>
              <p class="muted">${BRIEF_UZ.micQuietHow(check.peak ?? 0)}</p>
              ${check.playback ? `<audio controls src="${esc(check.playback)}"></audio>` : ''}
              <button class="btn" data-action="mic-check">${BRIEF_UZ.micRetest}</button>`,

      failed: `<div class="mic-verdict bad"><strong>${BRIEF_UZ.micFailed}</strong></div>
               <p class="muted">${esc(check.message || '')}</p>
               <button class="btn" data-action="mic-check">${BRIEF_UZ.micTryAgain}</button>`
    }[check.phase] || '';

    return `<div class="card mic-card">
      <div class="section-head"><h2>${icon('mic')} ${BRIEF_UZ.micHeading}</h2>
        <p>${BRIEF_UZ.micNote}</p></div>
      ${body}
      ${canTranscribe ? '' : transcriptionWarning()}
    </div>`;
  }

  /**
   * What the student sees between choosing a mock and starting it.
   *
   * A mock runs to the end once begun, so everything that could go wrong has to
   * be settled before that: what is coming, how long each part gives them, and
   * whether the microphone actually works.
   */
  function briefingScreen() {
    const exam = state.exam;
    if (!exam || !state.questions) return `<div class="center-note"><span class="spinner"></span></div>`;

    const isMock = state.mode === 'mock';
    const check = state.micCheck || { phase: 'idle' };
    const ready = check.phase === 'passed';

    // Group the questions by part so the student sees the shape of the test
    // rather than a list of eight items.
    const parts = [];
    for (const q of state.questions) {
      const last = parts[parts.length - 1];
      if (last && last.part === q.part) {
        last.count += 1;
        last.seconds += (q.prepTime || 0) + (q.answerTime || 0);
      } else {
        parts.push({
          part: q.part,
          count: 1,
          seconds: (q.prepTime || 0) + (q.answerTime || 0)
        });
      }
    }
    const totalSeconds = parts.reduce((sum, p) => sum + p.seconds, 0);

    return `
      <button class="crumb" data-action="leave-briefing">${icon('left')} ${BRIEF_UZ.back}</button>

      <div class="card" style="margin-top:12px">
        <div class="row" style="justify-content:space-between;gap:10px">
          <h1 style="font-size:24px">${esc(exam.title)}</h1>
          <span class="chip ${isMock ? 'chip-speaking' : 'chip-new'}">${
            isMock ? BRIEF_UZ.fullMock : `${BRIEF_UZ.practice} · Part ${esc(state.part || '')}`
          }</span>
        </div>
        <p class="muted" style="margin-top:6px">${
          BRIEF_UZ.summary(state.questions.length, Math.ceil(totalSeconds / 60))
        }</p>
      </div>

      <div class="card">
        <div class="section-head"><h2>${BRIEF_UZ.whatHeading}</h2></div>
        <div class="brief-parts">
          ${parts.map(p => `
            <div class="brief-part">
              <div class="icon-tile">${icon(PART_ICON[p.part] || 'mic')}</div>
              <div class="grow">
                <strong>Part ${esc(p.part)}</strong>
                <p class="muted">${esc(BRIEF_UZ.partBlurb[p.part] || `${p.count} ta savol.`)}</p>
              </div>
              <span class="brief-time">${icon('clock')} ${BRIEF_UZ.minutes(Math.ceil(p.seconds / 60))}</span>
            </div>`).join('')}
        </div>
      </div>

      <div class="card">
        <div class="section-head"><h2>${BRIEF_UZ.howHeading}</h2></div>
        <ol class="brief-steps">
          ${BRIEF_UZ.steps.map(step => `<li>${step}</li>`).join('')}
          <li>${isMock ? BRIEF_UZ.stepMock : BRIEF_UZ.stepPractice}</li>
          <li>${BRIEF_UZ.stepStay}</li>
        </ol>
        <p class="muted" style="margin-top:12px">${BRIEF_UZ.quiet}</p>
      </div>

      ${micCheckCard()}

      <div class="brief-start">
        <button class="btn btn-lg" data-action="start-questions" ${ready ? '' : 'disabled'}>
          ${isMock ? BRIEF_UZ.startMock : BRIEF_UZ.startPractice} ${icon('right')}
        </button>
        ${ready
          ? `<p class="muted">${isMock ? BRIEF_UZ.startNote : ''}</p>`
          : `<p class="muted">${BRIEF_UZ.startBlocked}
               <button class="link-inline" data-action="start-questions-anyway">${BRIEF_UZ.startAnyway}</button></p>`}
      </div>`;
  }

  function examScreen() {
    const exam = state.exam;
    if (!exam) return `<div class="center-note">Loading…</div>`;

    // The writing module still uses the legacy flat task list.
    if (!state.questions) return legacyExamScreen();

    const q = currentQuestion();
    if (!q) return `<div class="center-note">Loading…</div>`;

    const total = state.questions.length;
    const answeredCount = Object.keys(state.answered).length;
    const isMock = state.mode === 'mock';

    const stimulus = `
      ${q.images?.length ? `<div class="stimulus-images">
        ${q.images.map((url, i) => `<figure><img data-authsrc="${esc(url)}" alt="${q.images.length > 1 ? `Picture ${i + 1}` : 'Pictures for this question'}" loading="eager" />${
          // Only number them when they arrive as separate files. A single file
          // that already holds both pictures must not be labelled "Picture 1".
          q.images.length > 1 ? `<figcaption>Picture ${i + 1}</figcaption>` : ''
        }</figure>`).join('')}
      </div>` : ''}
      ${q.topic ? `<div class="stimulus-topic">${esc(q.topic)}</div>` : ''}
      ${(q.pros?.length || q.cons?.length) ? `<div class="proscons">
        <div class="pros"><h4>Advantages</h4><ul>${q.pros.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div class="cons"><h4>Disadvantages</h4><ul>${q.cons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
      </div>` : ''}`;

    const phaseBlock = (() => {
      switch (run.phase) {
        case 'prep':
          return `<div class="phase phase-prep">
            <div class="phase-label">Think about your answer</div>
            <div class="phase-timer" id="phase-timer">${fmtTime(run.remaining)}</div>
            <div class="phase-track"><div class="phase-fill" id="phase-bar" style="width:100%"></div></div>
            <p class="muted">Recording starts automatically.</p>
          </div>`;

        case 'answer':
          return `<div class="phase phase-answer">
            <div class="phase-label"><span class="rec-live"></span> Speak now</div>
            <div class="phase-timer" id="phase-timer">${fmtTime(run.remaining)}</div>
            <div class="phase-track"><div class="phase-fill recording" id="phase-bar" style="width:100%"></div></div>
            <div id="transcript" class="transcript" style="margin-top:14px">${esc((rec.transcript + rec.interim).trim() || 'Listening…')}</div>
          </div>`;

        case 'saving':
          return `<div class="phase"><span class="spinner"></span><p class="muted" style="margin-top:10px">Saving your answer…</p></div>`;

        case 'blocked':
          return `<div class="alert alert-error">The microphone is blocked. Allow access in your browser, then reload and start again.</div>`;

        case 'finished':
          return `<div class="phase">
            <div class="phase-label">All questions answered</div>
            ${isMock
              ? '<p class="muted">Submitting for assessment…</p><span class="spinner"></span>'
              : '<button class="btn" data-action="finish">Submit for assessment</button>'}
          </div>`;

        default: // 'ready'
          return `<div class="phase">
            ${state.qIndex === 0 && !SpeechRecognition && !state.serverTranscription
              // Warn at the START, not after eight answers. A mock runs straight
              // through once begun, so a student in a browser that cannot make
              // words would otherwise record the whole test before finding out.
              ? `<div class="alert alert-error" style="text-align:left;margin-bottom:14px">
                   <strong>Stop — this browser cannot turn speech into text</strong>
                   <p style="margin-top:6px">Your recordings would be saved but could not be marked.
                   This happens in the browser built into messaging apps like Telegram.
                   Open <code>${esc(location.host)}</code> directly in Chrome, then start the test.</p>
                 </div>`
              : ''}
            <p class="muted">${q.prepTime}s to think, then ${q.answerTime}s to answer.</p>
            <button class="btn" data-action="begin">
              ${state.qIndex === 0 ? (isMock ? 'Begin mock exam' : 'Start') : 'Next question'}
            </button>
            ${isMock && state.qIndex === 0
              ? '<p class="muted" style="margin-top:10px">Once it starts it runs to the end — you cannot pause or skip.</p>'
              : ''}
          </div>`;
      }
    })();

    return `
      <div class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:12px">
          <div>
            <span class="badge">Part ${esc(q.part)}</span>
            ${isMock ? '<span class="badge badge-mock">Mock exam</span>' : '<span class="badge">Practice</span>'}
          </div>
          <span class="muted">Question ${state.qIndex + 1} of ${total} · ${answeredCount} answered</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${(answeredCount / total) * 100}%"></div></div>

        ${q.isSectionStart && q.instructions ? `<p class="muted" style="margin-top:14px">${esc(q.instructions)}</p>` : ''}
        ${stimulus}

        <div class="question">${esc(q.text)}</div>

        ${phaseBlock}
      </div>

      ${!isMock && run.phase === 'ready' && state.qIndex < total - 1
        ? '<div class="row" style="justify-content:flex-end"><button class="btn btn-ghost btn-sm" data-action="skip-question">Skip this question</button></div>'
        : ''}`;
  }

  function legacyExamScreen() {
    const exam = state.exam;
    const task = currentTask();
    if (!exam || !task) return `<div class="center-note">Loading exam…</div>`;

    const total = exam.tasks.length;
    const answeredCount = Object.keys(state.answered).length;
    const done = state.answered[task.taskNumber];
    const isLast = state.taskIndex >= total - 1;
    const allAnswered = answeredCount >= total;
    const isWriting = exam.module === 'writing';

    const recorderBlock = done
      ? `<div class="alert alert-ok">Answer saved for task ${task.taskNumber}.</div>
         <div class="transcript" style="margin-top:12px">${esc(done.transcription || '(no transcript captured)')}</div>
         <div class="row" style="margin-top:16px;justify-content:space-between">
           <button class="btn btn-ghost btn-sm" data-action="redo">Record again</button>
           ${isLast
             ? (allAnswered ? `<button class="btn" data-action="finish">Submit exam for assessment</button>` : `<button class="btn btn-ghost" data-action="prev">Back</button>`)
             : `<button class="btn" data-action="next">Next task</button>`}
         </div>`
      : `<div class="recorder">
           <button id="rec-btn" class="rec-button ${rec.isRecording ? 'recording' : ''}" ${rec.uploading ? 'disabled' : ''}
                   aria-label="${rec.isRecording ? 'Stop recording' : 'Start recording'}">
             <span class="${rec.isRecording ? 'rec-square' : 'rec-dot'}"></span>
           </button>
           <div id="timer" class="timer">${fmtTime(rec.elapsed)}</div>
           <div class="muted">${rec.isRecording
             ? 'Recording — press again to stop'
             : rec.blob ? 'Review your answer, then save it' : `Suggested time: ${fmtTime(task.timeLimit || 120)}`}</div>
         </div>
         ${rec.blobUrl ? `<audio controls src="${rec.blobUrl}"></audio>` : ''}
         ${(rec.isRecording || rec.transcript || rec.interim)
            ? `<div style="margin-top:14px"><div class="section-title">Live transcript</div>
               <div id="transcript" class="transcript" style="margin-top:6px">${esc((rec.transcript + rec.interim).trim() || 'Listening…')}</div></div>`
            : SpeechRecognition ? '' : transcriptionWarning()}
         ${rec.blob && !rec.isRecording
            ? `<div class="row" style="margin-top:16px">
                 <button class="btn" data-action="save" ${rec.uploading ? 'disabled' : ''}>
                   ${rec.uploading ? 'Saving…' : 'Save answer'}
                 </button>
                 <button class="btn btn-ghost" data-action="discard" ${rec.uploading ? 'disabled' : ''}>Discard</button>
               </div>`
            : ''}`;

    return `
      <div class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:12px">
          <div>
            <span class="badge">${esc(task.part ? `Part ${task.part}` : (isWriting ? 'Writing' : 'Speaking'))}</span>
            <span class="muted" style="margin-left:8px">${task.taskNumber} of ${total}</span>
          </div>
          <span class="muted">${answeredCount}/${total} answered</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${(answeredCount / total) * 100}%"></div></div>

        ${task.instructions ? `<p class="muted" style="margin-top:10px">${esc(task.instructions)}</p>` : ''}
        <div class="question${isWriting ? ' question-pre' : ''}">${esc(task.question)}</div>
        ${task.followUpQuestions?.length
          ? `<div class="section-title">The examiner may also ask</div>
             <ul class="followups">${task.followUpQuestions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>`
          : ''}

        ${isWriting ? writingBlock(task, done, isLast, allAnswered) : recorderBlock}
      </div>

      <div class="row" style="justify-content:space-between">
        <button class="btn btn-ghost btn-sm" data-action="prev" ${state.taskIndex === 0 ? 'disabled' : ''}>Previous</button>
        ${allAnswered && !done ? `<button class="btn btn-sm" data-action="finish">Submit exam</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-action="next" ${isLast ? 'disabled' : ''}>Skip</button>
      </div>`;
  }

  /**
   * Warn about transcription BEFORE the student records.
   *
   * The old copy promised "your audio will be transcribed on the server"
   * unconditionally. When no server transcription is configured that promise is
   * false, and a student trusted it, recorded a whole test, and was handed
   * zeros. Say only what is actually true of this deployment.
   */
  function transcriptionWarning() {
    if (state.serverTranscription) {
      return `<p class="muted" style="margin-top:12px">${BRIEF_UZ.serverWillTranscribe}</p>`;
    }
    return `<div class="alert alert-warn" style="margin-top:12px">
      <strong>${BRIEF_UZ.noTranscriptionTitle}</strong>
      <p style="margin-top:6px">${BRIEF_UZ.noTranscriptionBody}</p>
    </div>`;
  }

  /**
   * What a student sees the moment they hand in.
   *
   * Deliberately a full screen rather than a browser dialog: this is the last
   * thing they read after twelve minutes of being timed, and it has one job —
   * tell them the work is safely in and where the result will appear. A native
   * alert() would be dismissed by reflex before any of that registered.
   *
   * "Recent attempts" stays in English because that is what the section is
   * called on the dashboard. Translating it here would send them looking for a
   * heading that does not exist.
   */
  function submittedScreen() {
    return `<div class="card submitted-card">
      <div class="submitted-mark">${icon('check')}</div>
      <h2>Imtihoningiz tekshirishga yuborildi</h2>
      <p>Natijangiz tayyor bo'lgach, boshqaruv panelidagi
         <strong>"Recent attempts"</strong> bo'limida ko'rinadi.</p>
      <p class="muted">Kutib turishingiz shart emas — telefoningizni yopsangiz ham
         tekshirish davom etadi.</p>
      <button class="btn btn-lg" data-action="done-submitting" ${state.loading ? 'disabled' : ''}>
        ${state.loading ? 'Yuborilmoqda…' : 'OK'}
      </button>
    </div>`;
  }


  function resultScreen() {
    if (state.loading || !state.result) {
      return `<div class="center-note"><span class="spinner"></span><p style="margin-top:12px">Loading results…</p></div>`;
    }

    const r = state.result;
    const tasks = r.taskResults.filter(t => t.evaluation);
    const unread = r.taskResults.filter(t => t.status === 'not_transcribed');

    // An answer nobody could read is not a bad answer. Say so plainly, next to
    // the recording, rather than letting it vanish from the list or drag the
    // mark down as if the student had said nothing.
    const unreadNotice = unread.length
      ? `<div class="alert alert-warn" style="margin-bottom:16px">
           <strong>${unread.length} answer${unread.length === 1 ? '' : 's'} could not be turned into text</strong>
           <p style="margin-top:6px">Question${unread.length === 1 ? '' : 's'}
             ${unread.map(t => t.taskNumber).join(', ')} — the recording${unread.length === 1 ? ' is' : 's are'}
             saved and you can play ${unread.length === 1 ? 'it' : 'them'} below, but no words were captured,
             so ${unread.length === 1 ? 'it was' : 'they were'} left unmarked rather than scored zero.
             ${r.overallScore != null ? 'Your score below covers only the answers that could be read.' : ''}</p>
           <p style="margin-top:6px">This is usually the browser: speech recognition does not work inside
             the browser built into messaging apps. Open the site directly in Chrome and try again.</p>
         </div>`
      : '';

    return `
      ${unreadNotice}
      <div class="card score-hero">
        <div class="muted">${esc(r.exam?.title || 'Exam')}</div>
        <div class="score-value">${r.overallScore ?? '—'}</div>
        <div class="score-level">${esc(r.overallLevel || '')}</div>
        <div style="margin-top:12px">
          <span class="badge ${r.isPassed ? 'badge-pass' : 'badge-fail'}">${r.isPassed ? 'Passed' : 'Not yet passed'}</span>
        </div>
      </div>

      ${r.overallFeedback ? `<div class="card">
        <div class="section-head"><h2>Umumiy baho</h2>
          <p>Butun imtihon bo'yicha — bu yerdan darajangiz aniqlanadi.</p></div>
        <p>${esc(r.overallFeedback)}</p>
        ${r.overallReasoning
          // Why this level, part by part. A student told "B2" learns nothing;
          // a student told which part carried them and which held them back
          // knows what to practise next.
          ? `<p class="muted" style="margin-top:12px">${esc(r.overallReasoning)}</p>`
          : ''}
        ${r.overallStrengths?.length
          ? `<div style="margin-top:14px"><div class="section-title">${esc(UI_TEXT.strengths)}</div>
               <ul class="pill-list">${r.overallStrengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>`
          : ''}
        ${r.overallImprovements?.length
          ? `<div style="margin-top:12px"><div class="section-title">${esc(UI_TEXT.improvements)}</div>
               <ul class="pill-list">${r.overallImprovements.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>`
          : ''}
      </div>` : ''}

      ${unread.map(t => `
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <strong>Question ${t.taskNumber}</strong>
            <span class="badge">Not marked</span>
          </div>
          ${t.audioUrl ? `<audio controls data-authsrc="${esc(t.audioUrl)}"></audio>` : ''}
          <p class="muted" style="margin-top:8px">Your recording was saved, but no words were captured from it.</p>
        </div>`).join('')}

      ${tasks.map(task => {
        const e = task.evaluation;
        const criteria = e.criteria || {};
        return `
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <h3>Task ${task.taskNumber}</h3>
            <span class="badge">${task.finalScore ?? 0}/${MAX_SCORE}</span>
          </div>
          ${task.audioUrl ? `<audio controls data-authsrc="${esc(task.audioUrl)}"></audio>` : ''}
          ${task.transcription ? `<div style="margin-top:12px"><div class="section-title">What you said</div><div class="transcript" style="margin-top:6px">${esc(task.transcription)}</div></div>` : ''}
          ${e.overallFeedback ? `<p style="margin-top:14px">${esc(e.overallFeedback)}</p>` : ''}

          <div class="criteria">
            ${Object.entries(criteria).map(([name, value]) => `
              <div class="criterion">
                <div class="criterion-head">
                  <span class="criterion-name">${esc(criterionLabel(name))}${
                    // Two of these are measured from the recording and the rest
                    // are an examiner's judgement of the words. A student
                    // deserves to know which is which — the measured ones can be
                    // trusted to the point, the judged ones are an opinion.
                    value?.measured ? '<span class="measured-tag">o\'lchandi</span>' : ''
                  }</span>
                  <span class="criterion-score">${value?.score ?? 0} / ${MAX_SCORE}</span>
                </div>
                <div class="bar-track"><div class="bar-fill${value?.measured ? ' measured' : ''}" style="width:${pctOfMax(value?.score)}%"></div></div>
                ${value?.feedback ? `<p>${esc(value.feedback)}</p>` : ''}
              </div>`).join('')}
            ${state.result?.pronunciation && !state.result.pronunciation.assessed
              // Silence would read as "pronunciation was fine". Saying nothing
              // was measured is the only honest thing to show here.
              ? `<div class="criterion criterion-absent">
                   <div class="criterion-head">
                     <span class="criterion-name">${esc(criterionLabel('pronunciation'))}</span>
                     <span class="criterion-score">—</span>
                   </div>
                   <p>Bu javobda talaffuz o'lchanmadi. Uni o'qituvchingiz baholashi kerak.</p>
                 </div>`
              : ''}
          </div>

          ${e.strengths?.length ? `<div style="margin-top:14px"><div class="section-title">${esc(UI_TEXT.strengths)}</div><ul class="pill-list">${e.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
          ${e.areasForImprovement?.length ? `<div style="margin-top:12px"><div class="section-title">${esc(UI_TEXT.improvements)}</div><ul class="pill-list">${e.areasForImprovement.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
        </div>`;
      }).join('')}

      <div class="row"><button class="btn" data-go="dashboard">Back to dashboard</button></div>`;
  }

  // ------------------------------------------------------------- wiring

  /**
   * Load media that sits behind the API's authentication.
   *
   * Every /api/exam route requires an Authorization header, and a plain
   * <img src> or <audio src> cannot send one — the browser just gets a 401 and
   * shows a broken image or a dead player. So the markup carries the address in
   * data-authsrc, and here we fetch it with the token and hand the element a
   * blob URL instead. Recordings stay private and no token ever appears in a URL.
   */
  const mediaCache = new Map();

  async function resolveAuthedMedia() {
    const pending = root.querySelectorAll('[data-authsrc]');
    for (const el of pending) {
      const url = el.dataset.authsrc;
      if (!url) continue;

      const cached = mediaCache.get(url);
      if (cached) { el.src = cached; el.removeAttribute('data-authsrc'); continue; }

      try {
        const response = await fetch(url, {
          headers: state.token ? { Authorization: `Bearer ${state.token}` } : {}
        });
        if (!response.ok) throw new Error(`${response.status}`);
        const objectUrl = URL.createObjectURL(await response.blob());
        mediaCache.set(url, objectUrl);
        el.src = objectUrl;
        el.removeAttribute('data-authsrc');
      } catch (error) {
        // Say so rather than leaving a silent broken-image icon: a student who
        // cannot see the Part 1.2 pictures cannot answer the question.
        el.removeAttribute('data-authsrc');
        el.alt = 'This picture could not be loaded';
        el.classList.add('media-failed');
        console.error('Could not load', url, error.message);
        if (el.tagName === 'IMG' && !state.error) {
          state.error = 'The pictures for this question could not be loaded. Tell your teacher before answering.';
          const box = document.querySelector('.alert-error');
          if (!box) render();
        }
      }
    }
  }

  function wire() {
    resolveAuthedMedia();

    // The watcher belongs to the dashboard and nothing else. Deciding here,
    // once per render, means it can never be left running behind a screen that
    // stopped caring — including after a sign-out.
    if (state.screen === 'dashboard' && state.user) watchPending();
    else clearPendingWatch();

    root.querySelectorAll('[data-go]').forEach(el => {
      el.addEventListener('click', event => {
        event.preventDefault();
        const target = el.dataset.go;
        if (target === 'dashboard') loadDashboard();
        else go(target);
      });
    });

    root.querySelectorAll('[data-start]').forEach(el =>
      el.addEventListener('click', () =>
        startExam(el.dataset.start, el.dataset.mode || 'mock', el.dataset.part || null)));

    root.querySelectorAll('[data-result]').forEach(el =>
      el.addEventListener('click', () => openResult(el.dataset.result)));

    // Opening a folder is a screen change now, not a filter on the dashboard.
    // The search and filters reset with it, so a student who comes back to the
    // speaking mocks is never met by an empty list left over from last time.
    root.querySelectorAll('[data-folder]').forEach(el =>
      el.addEventListener('click', () => {
        go('mocks', {
          folder: el.dataset.folder,
          mockSearch: '', mockStatus: 'all', mockSort: 'recommended'
        });
      }));

    root.querySelectorAll('[data-clear-filters]').forEach(el =>
      el.addEventListener('click', () =>
        setState({ mockSearch: '', mockStatus: 'all', mockSort: 'recommended' })));

    /*
     * Typing re-renders the whole screen, which throws away the input the
     * student is typing into — so the caret is put back where it was straight
     * afterwards. Without this the box loses focus after every single letter.
     */
    const search = document.getElementById('mock-search');
    search?.addEventListener('input', () => {
      const caret = search.selectionStart;
      setState({ mockSearch: search.value });
      const fresh = document.getElementById('mock-search');
      if (!fresh) return;
      fresh.focus();
      try { fresh.setSelectionRange(caret, caret); } catch { /* unsupported */ }
    });

    document.getElementById('mock-status')?.addEventListener('change', event =>
      setState({ mockStatus: event.target.value }));

    document.getElementById('mock-sort')?.addEventListener('change', event =>
      setState({ mockSort: event.target.value }));

    root.querySelectorAll('[data-delete]').forEach(el =>
      el.addEventListener('click', () => setState({ confirmDelete: el.dataset.delete, error: '' })));

    root.querySelectorAll('[data-delete-cancel]').forEach(el =>
      el.addEventListener('click', () => setState({ confirmDelete: null })));

    root.querySelectorAll('[data-delete-confirm]').forEach(el =>
      el.addEventListener('click', () => deleteResult(el.dataset.deleteConfirm)));

    root.querySelectorAll('[data-pick]').forEach(el =>
      el.addEventListener('change', () => {
        const picked = { ...(state.selected || {}) };
        if (el.checked) picked[el.dataset.pick] = true;
        else delete picked[el.dataset.pick];
        setState({ selected: picked, confirmBulk: false });
      }));

    root.querySelectorAll('[data-select-all]').forEach(el =>
      el.addEventListener('click', () => {
        const picked = {};
        if (el.dataset.selectAll === 'all') state.history.forEach(h => { picked[h.id] = true; });
        setState({ selected: picked, confirmBulk: false });
      }));

    root.querySelectorAll('[data-bulk-delete]').forEach(el =>
      el.addEventListener('click', () => setState({ confirmBulk: true, error: '' })));

    root.querySelectorAll('[data-bulk-cancel]').forEach(el =>
      el.addEventListener('click', () => setState({ confirmBulk: false })));

    root.querySelectorAll('[data-bulk-confirm]').forEach(el =>
      el.addEventListener('click', () => deleteSelected()));

    root.querySelectorAll('[data-action]').forEach(el =>
      el.addEventListener('click', () => handleAction(el.dataset.action)));

    document.getElementById('rec-btn')?.addEventListener('click', () =>
      rec.isRecording ? endRecording() : beginRecording());

    document.getElementById('auth-form')?.addEventListener('submit', handleAuthSubmit);
  }

  function handleAction(action) {
    switch (action) {
      case 'signout': return signOut();
      case 'done-submitting': return loadDashboard();
      case 'notice-seen': return dismissNotice();
      case 'mic-check': return runMicCheck();
      case 'start-questions':
      case 'start-questions-anyway':
        // The check holds the microphone open; the recorder needs it free.
        stopMicCheck();
        go('exam');
        // The briefing IS the start screen for a mock, so going straight into
        // the first question's thinking time saves a second button that asks
        // nothing. Practice keeps its own start, since a student there chooses
        // which question to attempt.
        if (state.mode === 'mock') beginPrep();
        return;
      case 'leave-briefing':
        stopMicCheck();
        return go('mocks');
      case 'save': return submitTask();
      case 'save-writing': return submitWriting();
      case 'begin': return beginPrep();
      case 'skip-question': return advanceQuestion();
      case 'discard': resetRecorder(); return render();
      case 'redo':
        delete state.answered[currentTask().taskNumber];
        resetRecorder();
        return render();
      case 'next':
        if (state.taskIndex < state.exam.tasks.length - 1) {
          resetRecorder();
          return setState({ taskIndex: state.taskIndex + 1, error: '', notice: '' });
        }
        return;
      case 'prev':
        if (state.taskIndex > 0) {
          resetRecorder();
          return setState({ taskIndex: state.taskIndex - 1, error: '', notice: '' });
        }
        return;
      case 'finish': return submitExam();
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const isSignup = state.screen === 'signup';
    const payload = {
      email: form.email.value.trim(),
      password: form.password.value
    };
    if (isSignup) payload.name = form.name.value.trim();

    setState({ loading: true, error: '' });
    try {
      const data = await api(`/auth/${isSignup ? 'signup' : 'login'}`, { method: 'POST', body: payload });
      state.loading = false;
      signIn(data);
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  // ---------------------------------------------------------------- boot

  window.addEventListener('beforeunload', event => {
    if (state.screen === 'exam' && (rec.isRecording || rec.blob)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  (function boot() {
    const token = store.get('token');
    const user = store.get('user');
    if (token && user) {
      try {
        state.token = token;
        state.user = JSON.parse(user);
        loadDashboard();
        return;
      } catch { signOut(); }
    }
    render();
  })();
})();
