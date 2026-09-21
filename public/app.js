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
    criteriaOpen: false, // result screen: is the criteria panel expanded
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

  /** The measured fluency of a whole attempt, in one Uzbek sentence. */
  const FLUENCY_UZ = {
    summary: f =>
      `Yozuvingizdan o'lchandi: daqiqasiga ${f.wordsPerMin} so'z · ` +
      `${f.longPauses} ta uzoq pauza (1 soniyadan ko'p${f.veryLongPauses ? `, ${f.veryLongPauses} tasi 2 soniyadan ko'p` : ''}), eng uzuni ${f.longestPauseSec} s · ` +
      `${f.fillers} ta to'ldiruvchi tovush (umm, eee) · ${f.repeats} ta takrorlash.`
  };

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
    stopVoice();
    stopChat();
    stopWritingTimers();
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
        api('/user/profile').catch(() => null),
        loadLeaderboard()
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
  /**
   * Send the teacher's bands as calibration.
   *
   * Reads the inputs straight from the DOM rather than mirroring them in state:
   * every keystroke would otherwise re-render the panel and throw away the
   * caret, and these five numbers are read exactly once, when Save is pressed.
   */
  async function saveBands() {
    const body = {};
    root.querySelectorAll('[data-band]').forEach(input => {
      const value = input.value.trim();
      if (value !== '') body[input.dataset.band] = Number(value);
    });

    body.note = document.getElementById('band-note')?.value?.trim() || '';
    if (document.getElementById('band-real')?.checked) body.source = 'real-exam';

    setState({ loading: true, error: '', notice: '' });
    try {
      const saved = await api(`/admin/results/${state.result.id}/bands`, { method: 'POST', body });
      // Re-read the result so the panel shows what the server stored rather
      // than what this page hoped it sent.
      const result = await api(`/exam/results/${state.result.id}`);
      setState({
        result,
        loading: false,
        // The teacher's own bands, converted through the official table. Shown
        // because bands are easier to judge than a score, but a score is what
        // the real exam reports — and a teacher whose bands quietly add up to
        // 72 for someone they think of as a 67 should find that out here.
        notice:
          `Saved${Number.isFinite(saved.teacherScore) ? ` — your bands come to ${saved.teacherScore}/75` : ''}` +
          `${Number.isFinite(saved.markedScore) ? ` against the marker's ${saved.markedScore}` : ''}. ` +
          `${saved.anchors} corrected attempt${saved.anchors === 1 ? '' : 's'} now teach the marker.`
      });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

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
          ? { ...(state.access || {}), remaining: started.remaining, credits: started.credits, units: started.units }
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
    // The details panel closes with the result it belonged to: opening another
    // attempt should show that attempt's headline, not inherit the last one's
    // expanded state.
    setState({ screen: 'result', loading: true, error: '', result: null, criteriaOpen: false });
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

  // ============================================================== WRITING
  //
  // Two ways in, one result screen:
  //
  //   writing-exam   the timed mock — one 60-minute clock for all three parts,
  //                  paste blocked, autosaved while the student types
  //   writing-check  the student pastes writing they already have
  //   writing-result bands on the board's scales, the script with mistakes
  //                  crossed out and the correction beside, and the details
  //
  // The exam screen is drawn ONCE. Typing, the clock, the word counters and
  // the save status all update the page directly: a full re-render on each
  // keystroke would throw away the caret, and in a timed exam that is not an
  // annoyance, it is lost time.

  const WR_UZ = {
    heading: 'Yozma imtihon (Writing)',
    sub: "Rasmiy baholash shkalasi bo'yicha tekshiriladi: Part 1.1 — 0-5, Part 1.2 — 0-5, Part 2 — 0-6.",
    mockTitle: 'Imtihon sharoitida yozish',
    mockBody: "60 daqiqa, uchala qism uchun. Nusxa ko'chirib qo'yish (paste) o'chirilgan. Faqat uchala qism topshirilsa — to'liq mock va 75 ballik natija.",
    mockCost: 'Narxi: 1 mock. Bo\'sh qoldirilgan har bir qism uchun ⅓ qaytariladi.',
    start: 'Boshlash',
    resume: 'Davom ettirish',
    best: (s, l) => `Eng yaxshi natija: ${s}/75 · ${l}`,
    checkTitle: 'Tayyor ishimni tekshirish',
    checkBody: "Oldin yozgan xat yoki inshoingizni joylang. Har bir qism alohida baholanadi, xatolar ustiga chizilib, to'g'risi yonida ko'rsatiladi.",
    checkCost: 'Narxi: har bir qism — ⅓ mock.',
    checkOpen: 'Tekshirishga yuborish',
    history: 'Oldingi yozma ishlarim',
    none: "Hali yozma ish yo'q.",
    evaluating: 'Tekshirilmoqda…',
    failed: 'Tekshirib bo\'lmadi',
    partial: "To'liq emas",
    back: 'Yozma imtihonga qaytish',
    balance: n => `Qolgan writing mock: ${n}`,

    timeLeft: 'Qolgan vaqt',
    words: n => `${n} so'z`,
    target: t => `tavsiya: ${t}`,
    saved: t => `Saqlandi ${t}`,
    saving: 'Saqlanmoqda…',
    saveFailed: "Saqlab bo'lmadi — internetni tekshiring. Matningiz shu sahifada turibdi.",
    pasteBlocked: "Imtihon sharoitida nusxa ko'chirib qo'yish mumkin emas. O'zingiz yozing.",
    handIn: 'Topshirish',
    handInConfirm: 'Ha, topshiraman',
    handInCancel: 'Yozishda davom etish',
    handInSure: 'Topshirgandan keyin o\'zgartira olmaysiz.',
    emptyParts: list => `Bo'sh qismlar: ${list}. Ular baholanmaydi va har biri uchun ⅓ mock qaytariladi. To'liq natija (75 ballik) faqat uchala qism bilan beriladi.`,
    timeUp: 'Vaqt tugadi — ishingiz topshirildi.',
    message: 'Siz javob beradigan xabar',
    task: 'Topshiriq',
    under: (words, threshold) => `So'zlar soni ${words} ta — ${threshold} tadan kam bo'lgani uchun bu qism 0 ball oldi.`,
    underMarker: b => `(Yozuvning o'zi ${b} ballga loyiq edi.)`,

    checkIntro: 'Faqat tekshirmoqchi bo\'lgan qismlarni to\'ldiring. Topshiriq matnini ham qo\'shsangiz, mavzudan chetga chiqmaganingiz tekshiriladi.',
    question: 'Topshiriq matni (ixtiyoriy)',
    yourText: 'Sizning matningiz',
    cost: n => n ? `Narxi: ${['', '⅓', '⅔', '1'][n]} mock` : 'Kamida bitta qismni to\'ldiring',
    send: 'Tekshirishga yuborish',

    resultPartialNote: "Faqat uchala qism topshirilganda to'liq mock hisoblanadi va 75 ballik natija beriladi. Bir yoki ikki qism bilan eng yuqori daraja — B1.",
    expert: m => `Ekspert bahosi: ${m} / 16`,
    marked: 'Tekshirilgan matn',
    legend: "<del>qizil</del> — xato, <ins>yashil</ins> — to'g'ri varianti",
    noErrors: 'Aniq xato topilmadi.',
    why: 'Nima uchun bu ball',
    toNext: 'Keyingi ballga chiqish uchun',
    details: 'Batafsil',
    hide: 'Yopish',
    descriptor: 'Shkaladagi tavsif',
    nextBand: b => `${b} ball uchun rasmiy talab`,
    top: 'Bu qismning eng yuqori bali.',
    emailed: 'Tekshirilgan ish emailingizga ham yuborildi.',
    retry: 'Qayta tekshirish',
    waiting: "Ishingiz tekshirilmoqda. Odatda bir daqiqadan kamroq vaqt oladi — sahifani yopsangiz ham natija saqlanadi.",
    notSubmitted: 'Topshirilmagan'
  };

  const WR_PARTS = [
    { key: 'part11', name: 'Part 1.1', what: "Norasmiy xat (do'stga)" },
    { key: 'part12', name: 'Part 1.2', what: 'Rasmiy xat' },
    { key: 'part2', name: 'Part 2', what: 'Blog / maqola' }
  ];

  // Live objects for the writing screens, kept out of `state` for the same
  // reason as the recorder: they must survive re-renders.
  const wr = {
    attempt: null,
    test: null,
    texts: { part11: '', part12: '', part2: '' },
    questions: { part11: '', part12: '', part2: '' },
    active: 'part11',
    offset: 0,          // server clock minus browser clock
    tick: null,
    saveTimer: null,
    dirty: false,
    saving: false,
    pastes: 0,
    confirming: false,
    submitting: false,
    poll: null
  };

  const wrWords = text => String(text || '').trim().split(/\s+/).filter(Boolean).length;

  function stopWritingTimers() {
    clearInterval(wr.tick); wr.tick = null;
    clearTimeout(wr.saveTimer); wr.saveTimer = null;
    clearTimeout(wr.poll); wr.poll = null;
  }

  async function loadWritingHome() {
    stopWritingTimers();
    go('writing', { loading: true });
    try {
      const [tests, attempts, profile] = await Promise.all([
        api('/writing/tests'),
        api('/writing/attempts'),
        api('/user/profile').catch(() => null)
      ]);
      setState({
        writingTests: tests,
        writingHistory: attempts,
        access: profile?.access || state.access,
        loading: false
      });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  /** Out of credit or blocked: the same page speaking uses. */
  function handleAccessError(error) {
    if (error.code === 'no_credits' || error.code === 'blocked') {
      setState({
        loading: false,
        error: '',
        access: { ...(state.access || {}), remaining: 0, blocked: error.code === 'blocked' },
        screen: 'topup'
      });
      return true;
    }
    return false;
  }

  function adoptAttempt(data) {
    wr.attempt = data.attempt;
    wr.test = data.test || null;
    wr.offset = Number(data.serverNow) ? Number(data.serverNow) - Date.now() : 0;
    for (const p of data.attempt.parts) {
      wr.texts[p.key] = p.text || '';
      wr.questions[p.key] = p.question || '';
    }
    wr.active = 'part11';
    wr.dirty = false;
    wr.pastes = 0;
    wr.confirming = false;
    wr.submitting = false;
  }

  async function startWritingMock(testId) {
    setState({ loading: true, error: '' });
    try {
      const data = await api('/writing/mock', { method: 'POST', body: { testId } });
      adoptAttempt(data);
      if (data.credits !== undefined && data.credits !== null) {
        state.access = { ...(state.access || {}), writing: { ...(state.access?.writing || {}), credits: data.credits, units: data.units } };
      }
      state.loading = false;
      go('writing-exam');
    } catch (error) {
      if (!handleAccessError(error)) setState({ loading: false, error: error.message });
    }
  }

  // ------------------------------------------------------------ exam: clock

  const wrRemaining = () =>
    wr.attempt?.deadline
      ? Math.floor((new Date(wr.attempt.deadline).getTime() - (Date.now() + wr.offset)) / 1000)
      : 0;

  function startWritingClock() {
    clearInterval(wr.tick);
    const paint = () => {
      const left = wrRemaining();
      const el = document.getElementById('wr-clock');
      if (el) {
        el.textContent = fmtTime(Math.max(0, left));
        el.classList.toggle('is-low', left <= 5 * 60);
      }
      if (left <= 0 && !wr.submitting) {
        clearInterval(wr.tick);
        submitWritingMock({ auto: true });
      }
    };
    paint();
    wr.tick = setInterval(paint, 1000);
  }

  // ------------------------------------------------------------- exam: save

  function paintSaveStatus(text, bad = false) {
    const el = document.getElementById('wr-save');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-bad', bad);
  }

  function scheduleWritingSave() {
    wr.dirty = true;
    clearTimeout(wr.saveTimer);
    wr.saveTimer = setTimeout(saveWritingNow, 2500);
  }

  async function saveWritingNow() {
    clearTimeout(wr.saveTimer);
    if (!wr.attempt || wr.saving || !wr.dirty || wr.submitting) return;
    wr.saving = true;
    wr.dirty = false;
    paintSaveStatus(WR_UZ.saving);
    try {
      await api(`/writing/attempts/${wr.attempt.id}`, {
        method: 'PUT',
        body: { parts: { ...wr.texts }, pasteBlocked: wr.pastes }
      });
      paintSaveStatus(WR_UZ.saved(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    } catch (error) {
      wr.dirty = true;
      if (error.code === 'time_up' || error.code === 'closed') {
        stopWritingTimers();
        return openWritingResult(wr.attempt.id, WR_UZ.timeUp);
      }
      paintSaveStatus(WR_UZ.saveFailed, true);
    } finally {
      wr.saving = false;
      // Anything typed while this save was in flight still needs saving.
      if (wr.dirty && !wr.submitting) wr.saveTimer = setTimeout(saveWritingNow, 2500);
    }
  }

  async function submitWritingMock({ auto = false } = {}) {
    if (!wr.attempt || wr.submitting) return;
    wr.submitting = true;
    stopWritingTimers();
    try {
      const data = await api(`/writing/attempts/${wr.attempt.id}/submit`, {
        method: 'POST',
        body: { parts: { ...wr.texts } }
      });
      openWritingResult(data.attempt.id, auto ? WR_UZ.timeUp : '');
    } catch (error) {
      wr.submitting = false;
      // Put the clock back, or a failed hand-in would freeze the exam.
      startWritingClock();
      setState({ error: error.message });
    }
  }

  // ----------------------------------------------------------- exam: screen

  function wrPartMeta(key) {
    return WR_PARTS.find(p => p.key === key);
  }

  function writingExamScreen() {
    const a = wr.attempt;
    const t = wr.test;
    if (!a || !t) return `<div class="center-note"><span class="spinner"></span></div>`;

    const tabs = WR_PARTS.map(p => `
      <button class="wr-tab ${wr.active === p.key ? 'is-active' : ''}" data-wr-tab="${p.key}" type="button">
        <span>${esc(p.name)}</span>
        <span class="wr-tab-count" id="wr-tabcount-${p.key}">${esc(WR_UZ.words(wrWords(wr.texts[p.key])))}</span>
      </button>`).join('');

    const stimulus = `<div class="wr-stimulus">
        <p class="muted" style="font-size:14px">${esc(t.stimulus?.intro || '')}</p>
        <div class="wr-message">${esc(t.stimulus?.text || '').replace(/\n/g, '<br>')}</div>
      </div>`;

    const panels = WR_PARTS.map(p => {
      const part = t.parts[p.key];
      const words = wrWords(wr.texts[p.key]);
      return `<section class="wr-panel ${wr.active === p.key ? 'is-active' : ''}" data-wr-panel="${p.key}">
        ${p.key !== 'part2' ? stimulus : ''}
        <div class="wr-task">
          <div class="section-title">${esc(p.name)} · ${esc(WR_UZ.task)}</div>
          <p style="margin-top:6px">${esc(part.task)}</p>
          <p class="muted" style="margin-top:4px;font-size:14px">${esc(part.wordGuide)}</p>
        </div>
        <textarea class="essay wr-text" id="wr-${p.key}" data-wr-text="${p.key}"
                  spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="sentences"
                  aria-label="${esc(p.name)}">${esc(wr.texts[p.key])}</textarea>
        <div class="wr-counter">
          <span id="wr-count-${p.key}" class="${words >= (part.minWords || 0) ? 'is-met' : ''}">${esc(WR_UZ.words(words))}</span>
          <span class="muted">· ${esc(WR_UZ.target(part.wordGuide.replace(/^Write\s*/i, '')))}</span>
        </div>
      </section>`;
    }).join('');

    const empty = WR_PARTS.filter(p => !wr.texts[p.key].trim()).map(p => p.name);

    return `
      <div class="wr-bar">
        <div>
          <div class="muted" style="font-size:13px">${esc(t.title)}</div>
          <div class="wr-clock-wrap">${icon('clock')}
            <span class="wr-clock" id="wr-clock">${fmtTime(Math.max(0, wrRemaining()))}</span>
            <span class="muted" style="font-size:13px">${esc(WR_UZ.timeLeft)}</span>
          </div>
        </div>
        <div class="wr-bar-right">
          <span class="wr-save muted" id="wr-save" aria-live="polite"></span>
          <button class="btn" data-wr="handin" type="button">${esc(WR_UZ.handIn)}</button>
        </div>
      </div>
      <div class="alert alert-warn" id="wr-paste" style="display:none">${esc(WR_UZ.pasteBlocked)}</div>
      <div class="card wr-confirm" id="wr-confirm" style="display:${wr.confirming ? 'block' : 'none'}">
        <strong>${esc(WR_UZ.handInSure)}</strong>
        <p class="muted" id="wr-empty-note" style="margin-top:6px">${empty.length ? esc(WR_UZ.emptyParts(empty.join(', '))) : ''}</p>
        <div class="row" style="margin-top:12px;gap:10px;flex-wrap:wrap">
          <button class="btn" data-wr="handin-yes" type="button">${esc(WR_UZ.handInConfirm)}</button>
          <button class="btn btn-ghost" data-wr="handin-no" type="button">${esc(WR_UZ.handInCancel)}</button>
        </div>
      </div>
      <div class="wr-tabs" role="tablist">${tabs}</div>
      <div class="card wr-sheet">${panels}</div>`;
  }

  function wireWritingExam() {
    if (state.screen !== 'writing-exam') return;
    if (!wr.tick) startWritingClock();

    const blockPaste = event => {
      event.preventDefault();
      wr.pastes += 1;
      wr.dirty = true;
      const note = document.getElementById('wr-paste');
      if (note) {
        note.style.display = 'block';
        clearTimeout(note._hide);
        note._hide = setTimeout(() => { note.style.display = 'none'; }, 4000);
      }
    };

    root.querySelectorAll('[data-wr-text]').forEach(area => {
      const key = area.dataset.wrText;
      const target = wr.test?.parts?.[key]?.minWords || 0;

      area.addEventListener('paste', blockPaste);
      area.addEventListener('drop', blockPaste);
      area.addEventListener('beforeinput', event => {
        if (event.inputType === 'insertFromPaste' || event.inputType === 'insertFromDrop') blockPaste(event);
      });

      area.addEventListener('input', () => {
        wr.texts[key] = area.value;
        const n = wrWords(area.value);
        const count = document.getElementById(`wr-count-${key}`);
        if (count) {
          count.textContent = WR_UZ.words(n);
          count.classList.toggle('is-met', n >= target);
        }
        const tab = document.getElementById(`wr-tabcount-${key}`);
        if (tab) tab.textContent = WR_UZ.words(n);
        scheduleWritingSave();
      });
    });

    root.querySelectorAll('[data-wr-tab]').forEach(button =>
      button.addEventListener('click', () => {
        wr.active = button.dataset.wrTab;
        root.querySelectorAll('[data-wr-tab]').forEach(b =>
          b.classList.toggle('is-active', b.dataset.wrTab === wr.active));
        root.querySelectorAll('[data-wr-panel]').forEach(p =>
          p.classList.toggle('is-active', p.dataset.wrPanel === wr.active));
        document.getElementById(`wr-${wr.active}`)?.focus();
      }));

    root.querySelectorAll('[data-wr]').forEach(button =>
      button.addEventListener('click', () => {
        const box = document.getElementById('wr-confirm');
        if (button.dataset.wr === 'handin') {
          wr.confirming = true;
          const empty = WR_PARTS.filter(p => !wr.texts[p.key].trim()).map(p => p.name);
          const note = document.getElementById('wr-empty-note');
          if (note) note.textContent = empty.length ? WR_UZ.emptyParts(empty.join(', ')) : '';
          if (box) { box.style.display = 'block'; box.scrollIntoView({ block: 'nearest' }); }
        } else if (button.dataset.wr === 'handin-no') {
          wr.confirming = false;
          if (box) box.style.display = 'none';
        } else if (button.dataset.wr === 'handin-yes') {
          button.disabled = true;
          submitWritingMock();
        }
      }));
  }

  // ------------------------------------------------------------------ check

  function writingCheckScreen() {
    const filled = WR_PARTS.filter(p => wr.texts[p.key].trim()).length;

    const blocks = WR_PARTS.map(p => `
      <div class="card">
        <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
          <h3>${esc(p.name)} <span class="muted" style="font-weight:500;font-size:15px">· ${esc(p.what)}</span></h3>
          <span class="muted" id="wc-count-${p.key}">${esc(WR_UZ.words(wrWords(wr.texts[p.key])))}</span>
        </div>
        <label class="field" style="margin-top:12px">
          <span class="muted" style="font-size:13px">${esc(WR_UZ.question)}</span>
          <textarea class="essay wr-question" data-wc-question="${p.key}" rows="2">${esc(wr.questions[p.key])}</textarea>
        </label>
        <label class="field" style="margin-top:10px">
          <span class="muted" style="font-size:13px">${esc(WR_UZ.yourText)}</span>
          <textarea class="essay" data-wc-text="${p.key}">${esc(wr.texts[p.key])}</textarea>
        </label>
      </div>`).join('');

    return `
      <div>
        <button class="crumb" data-go="writing">${icon('left')} ${esc(WR_UZ.back)}</button>
        <h1 style="font-size:26px;margin:10px 0 4px">${esc(WR_UZ.checkTitle)}</h1>
        <p class="muted">${esc(WR_UZ.checkIntro)}</p>
      </div>
      ${blocks}
      <div class="row" style="justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span class="muted" id="wc-cost">${esc(WR_UZ.cost(filled))}</span>
        <button class="btn btn-lg" data-wc-send="1" ${filled && !state.loading ? '' : 'disabled'}>
          ${state.loading ? '…' : esc(WR_UZ.send)}
        </button>
      </div>`;
  }

  function wireWritingCheck() {
    if (state.screen !== 'writing-check') return;

    const refresh = () => {
      const filled = WR_PARTS.filter(p => wr.texts[p.key].trim()).length;
      const cost = document.getElementById('wc-cost');
      if (cost) cost.textContent = WR_UZ.cost(filled);
      const send = root.querySelector('[data-wc-send]');
      if (send) send.disabled = !filled;
    };

    root.querySelectorAll('[data-wc-text]').forEach(area =>
      area.addEventListener('input', () => {
        const key = area.dataset.wcText;
        wr.texts[key] = area.value;
        const count = document.getElementById(`wc-count-${key}`);
        if (count) count.textContent = WR_UZ.words(wrWords(area.value));
        refresh();
      }));

    root.querySelectorAll('[data-wc-question]').forEach(area =>
      area.addEventListener('input', () => { wr.questions[area.dataset.wcQuestion] = area.value; }));

    root.querySelector('[data-wc-send]')?.addEventListener('click', sendWritingCheck);
  }

  function openWritingCheck() {
    stopWritingTimers();
    wr.texts = { part11: '', part12: '', part2: '' };
    wr.questions = { part11: '', part12: '', part2: '' };
    go('writing-check');
  }

  async function sendWritingCheck() {
    const parts = {};
    for (const p of WR_PARTS) {
      if (wr.texts[p.key].trim()) parts[p.key] = { text: wr.texts[p.key], question: wr.questions[p.key] };
    }
    if (!Object.keys(parts).length) return;

    setState({ loading: true, error: '' });
    try {
      const data = await api('/writing/check', { method: 'POST', body: { parts } });
      if (data.credits !== undefined && data.credits !== null) {
        state.access = { ...(state.access || {}), writing: { ...(state.access?.writing || {}), credits: data.credits, units: data.units } };
      }
      state.loading = false;
      openWritingResult(data.attempt.id);
    } catch (error) {
      if (!handleAccessError(error)) setState({ loading: false, error: error.message });
    }
  }

  // ----------------------------------------------------------------- result

  async function openWritingResult(id, notice = '') {
    stopWritingTimers();
    go('writing-result', { loading: true, writingResult: null, writingDetails: {}, notice });
    await refreshWritingResult(id);
  }

  async function refreshWritingResult(id) {
    try {
      const data = await api(`/writing/attempts/${id}`);
      // Still being written (a deep link to a running mock): go back to it.
      if (data.attempt.status === 'in_progress' && data.attempt.mode === 'mock') {
        adoptAttempt(data);
        state.loading = false;
        return go('writing-exam');
      }
      setState({ writingResult: data.attempt, loading: false });
      if (data.attempt.status === 'evaluating' && state.screen === 'writing-result') {
        clearTimeout(wr.poll);
        wr.poll = setTimeout(() => {
          if (state.screen === 'writing-result' && state.writingResult?.id === id) refreshWritingResult(id);
        }, 4000);
      }
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  function markedScript(segments) {
    return segments.map(seg =>
      seg.wrong !== undefined
        ? `<span class="wr-fix"${seg.why ? ` title="${esc(seg.why)}"` : ''}><del>${esc(seg.wrong)}</del> <ins>${esc(seg.right)}</ins></span>`
        : esc(seg.text)
    ).join('').replace(/\n/g, '<br>');
  }

  function writingPartCard(p) {
    if (!p.submitted) {
      return `<div class="card wr-part is-skipped">
        <div class="row" style="justify-content:space-between"><h3>${esc(p.name)}</h3>
          <span class="badge">${esc(WR_UZ.notSubmitted)}</span></div>
      </div>`;
    }
    if (p.band === null) return '';

    const open = Boolean(state.writingDetails?.[p.key]);

    return `<div class="card wr-part">
      <div class="row" style="justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
        <div>
          <h3>${esc(p.name)}</h3>
          <div class="muted" style="font-size:13px">${esc(p.description)} · ${esc(WR_UZ.words(p.words))}</div>
        </div>
        <div class="wr-band"><strong>${p.band}</strong><span class="muted"> / ${p.max}</span>
          <div class="muted" style="font-size:13px;text-align:right">${esc(p.label)}</div></div>
      </div>

      ${p.underLength
        ? `<div class="alert alert-error" style="margin-top:12px">${esc(WR_UZ.under(p.words, p.underLength.threshold))}
             ${Number.isFinite(p.underLength.markerBand) ? ` ${esc(WR_UZ.underMarker(p.underLength.markerBand))}` : ''}</div>`
        : ''}

      ${p.task ? `<p class="muted" style="margin-top:12px;font-size:14px"><strong>${esc(WR_UZ.task)}:</strong> ${esc(p.task)}</p>` : ''}

      <div style="margin-top:14px">
        <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div class="section-title">${esc(WR_UZ.marked)}</div>
          <span class="muted wr-legend">${WR_UZ.legend}</span>
        </div>
        <div class="wr-script">${markedScript(p.segments)}</div>
        ${p.corrections.length
          ? `<ol class="wr-fixes">${p.corrections.map(c =>
              `<li><del>${esc(c.wrong)}</del> → <ins>${esc(c.right)}</ins>${c.why ? `<span class="muted"> — ${esc(c.why)}</span>` : ''}</li>`).join('')}</ol>`
          : `<p class="muted" style="margin-top:8px">${esc(WR_UZ.noErrors)}</p>`}
      </div>

      ${p.reasoning ? `<div style="margin-top:14px"><div class="section-title">${esc(WR_UZ.why)}</div><p style="margin-top:4px">${esc(p.reasoning)}</p></div>` : ''}
      ${p.feedback ? `<div style="margin-top:12px"><div class="section-title">${esc(WR_UZ.toNext)}</div><p style="margin-top:4px">${esc(p.feedback)}</p></div>` : ''}

      <button class="btn btn-ghost btn-sm" style="margin-top:14px" data-wr-details="${p.key}">
        ${esc(open ? WR_UZ.hide : WR_UZ.details)}
      </button>
      ${open ? `<div class="wr-details">
          <div class="section-title">${esc(WR_UZ.descriptor)} — ${p.band} (${esc(p.label)})</div>
          <ul class="pill-list">${p.descriptor.map(d => `<li>${esc(d)}</li>`).join('')}</ul>
          ${p.next
            ? `<div class="section-title" style="margin-top:12px">${esc(WR_UZ.nextBand(p.next.band))} (${esc(p.next.label)})</div>
               <ul class="pill-list">${p.next.descriptor.map(d => `<li>${esc(d)}</li>`).join('')}</ul>`
            : `<p class="muted" style="margin-top:10px">${esc(WR_UZ.top)}</p>`}
        </div>` : ''}
    </div>`;
  }

  function writingResultScreen() {
    const r = state.writingResult;
    if (state.loading || !r) {
      return `<div class="center-note"><span class="spinner"></span><p style="margin-top:12px">Loading…</p></div>`;
    }

    const crumb = `<button class="crumb" data-go="writing">${icon('left')} ${esc(WR_UZ.back)}</button>`;

    if (r.status === 'evaluating') {
      return `${crumb}
        <div class="card score-hero">
          <div class="muted">${esc(r.title)}</div>
          <span class="spinner" style="margin-top:16px"></span>
          <p style="margin-top:12px">${esc(WR_UZ.waiting)}</p>
        </div>`;
    }

    if (r.status === 'failed') {
      return `${crumb}
        <div class="card score-hero">
          <div class="muted">${esc(r.title)}</div>
          <h2 style="margin-top:10px">${esc(WR_UZ.failed)}</h2>
          <p class="muted" style="margin-top:8px">${esc(r.failureReason)}</p>
          <button class="btn" style="margin-top:16px" data-wr-remark="${esc(r.id)}">${esc(WR_UZ.retry)}</button>
        </div>`;
    }

    const hero = r.complete
      ? `<div class="score-value">${r.score}</div>
         <div class="score-level">${esc(r.level || '')}</div>
         <p class="muted" style="margin-top:6px">${esc(WR_UZ.expert(r.expertMark))}</p>`
      : `<div class="score-value" style="font-size:44px">${esc(r.level || '')}</div>
         <div class="badge" style="margin-top:8px">${esc(WR_UZ.partial)}</div>
         <p class="muted" style="margin-top:10px;max-width:520px;margin-inline:auto">${esc(WR_UZ.resultPartialNote)}</p>`;

    return `
      ${crumb}
      <div class="card score-hero">
        <div class="muted">${esc(r.title)}</div>
        ${hero}
        ${r.emailed ? `<p class="muted" style="margin-top:10px;font-size:13px">${esc(WR_UZ.emailed)}</p>` : ''}
      </div>

      ${r.overallFeedback ? `<div class="card">
        <p>${esc(r.overallFeedback)}</p>
        ${r.strengths?.length ? `<div style="margin-top:12px"><div class="section-title">${esc(UI_TEXT.strengths)}</div>
          <ul class="pill-list">${r.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
        ${r.areasForImprovement?.length ? `<div style="margin-top:12px"><div class="section-title">${esc(UI_TEXT.improvements)}</div>
          <ul class="pill-list">${r.areasForImprovement.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
      </div>` : ''}

      ${r.parts.map(p => writingPartCard(p)).join('')}

      <div class="row"><button class="btn" data-go="writing">${esc(WR_UZ.back)}</button></div>`;
  }

  function wireWritingResult() {
    if (state.screen !== 'writing-result') return;
    root.querySelectorAll('[data-wr-details]').forEach(button =>
      button.addEventListener('click', () => {
        const key = button.dataset.wrDetails;
        setState({ writingDetails: { ...(state.writingDetails || {}), [key]: !state.writingDetails?.[key] } });
      }));
    root.querySelectorAll('[data-wr-remark]').forEach(button =>
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api(`/writing/attempts/${button.dataset.wrRemark}/remark`, { method: 'POST' });
          refreshWritingResult(button.dataset.wrRemark);
        } catch (error) {
          setState({ error: error.message });
        }
      }));
  }

  // ------------------------------------------------------------------- home

  function writingHomeScreen() {
    if (state.loading && !state.writingTests) {
      return `<div class="center-note"><span class="spinner"></span><p style="margin-top:12px">Loading…</p></div>`;
    }

    const tests = (state.writingTests || []).map(t => `
      <div class="card mock-card card-hover">
        <div class="mock-top"><h3>${esc(t.title)}</h3>
          ${t.inProgress ? '<span class="chip chip-progress">In progress</span>' : t.best ? `<span class="chip chip-done">${icon('check')} ${t.best.score}/75</span>` : ''}
        </div>
        <p class="mock-sub">${esc(WR_UZ.mockBody)}</p>
        <p class="mock-meta">${icon('clock')} 60 min · Part 1.1 · 1.2 · 2</p>
        ${t.best ? `<p class="muted" style="margin-top:6px;font-size:14px">${esc(WR_UZ.best(t.best.score, t.best.level))}</p>` : ''}
        <p class="muted" style="margin-top:6px;font-size:13px">${esc(WR_UZ.mockCost)}</p>
        <div class="spacer"></div>
        <div class="row" style="margin-top:14px;gap:10px;flex-wrap:wrap">
          <button class="btn" data-wr-start="${esc(t.id)}" ${state.loading ? 'disabled' : ''}>
            ${esc(t.inProgress ? WR_UZ.resume : WR_UZ.start)} ${icon('right')}</button>
          ${t.best ? `<button class="btn btn-ghost" data-wr-open="${esc(t.best.id)}">View result</button>` : ''}
        </div>
      </div>`).join('');

    const check = `<div class="card secondary-card card-hover">
      <div class="secondary-icon">${icon('pen')}</div>
      <div class="grow">
        <h3>${esc(WR_UZ.checkTitle)}</h3>
        <p class="mock-sub">${esc(WR_UZ.checkBody)}</p>
        <p class="muted" style="font-size:13px;margin-top:4px">${esc(WR_UZ.checkCost)}</p>
      </div>
      <div><button class="btn btn-ghost" data-wr-check="1">${esc(WR_UZ.checkOpen)} ${icon('right')}</button></div>
    </div>`;

    const history = (state.writingHistory || []).length
      ? `<div class="card"><div class="section-head"><h2>${esc(WR_UZ.history)}</h2></div>
          <div class="wr-history">${state.writingHistory.map(h => `
            <button class="wr-history-row" data-wr-open="${esc(h.id)}">
              <span><strong>${esc(h.title)}</strong>
                <span class="muted" style="font-size:13px"> · ${esc((h.parts || []).join(', '))} · ${esc(fmtDate(h.date))}</span></span>
              <span>${
                h.status === 'evaluating' ? `<span class="muted">${esc(WR_UZ.evaluating)}</span>`
                : h.status === 'failed' ? `<span class="badge badge-fail">${esc(WR_UZ.failed)}</span>`
                : h.status === 'in_progress' ? '<span class="chip chip-progress">In progress</span>'
                : h.complete ? `<strong>${h.score}/75</strong> · ${esc(h.level || '')}`
                : `${esc(h.level || '')} <span class="muted">(${esc(WR_UZ.partial)})</span>`
              }</span>
            </button>`).join('')}</div></div>`
      : `<p class="muted">${esc(WR_UZ.none)}</p>`;

    // Writing has its own balance (a package is 4 speaking + 3 writing).
    const credits = state.access?.writing?.credits;

    return `
      <div>
        <button class="crumb" data-go="dashboard">${icon('left')} Dashboard</button>
        <h1 style="font-size:26px;margin:10px 0 4px">${esc(WR_UZ.heading)}</h1>
        <p class="muted">${esc(WR_UZ.sub)}</p>
        ${credits !== undefined && credits !== null
          ? `<p style="margin-top:6px;font-weight:600">${esc(WR_UZ.balance(credits))}${
              state.access?.writing?.units > 0 ? '' : ` · <button class="link-more" style="margin-top:0" data-go="topup">${esc(ACCESS_UZ.how)}</button>`}</p>`
          : ''}
      </div>
      <div class="section-head" style="margin-top:8px"><h2>${esc(WR_UZ.mockTitle)}</h2></div>
      <div class="mock-grid">${tests}</div>
      ${check}
      ${history}`;
  }

  function wireWritingHome() {
    if (state.screen !== 'writing') return;
    root.querySelectorAll('[data-wr-start]').forEach(b =>
      b.addEventListener('click', () => startWritingMock(b.dataset.wrStart)));
    root.querySelectorAll('[data-wr-open]').forEach(b =>
      b.addEventListener('click', () => openWritingResult(b.dataset.wrOpen)));
    root.querySelector('[data-wr-check]')?.addEventListener('click', openWritingCheck);
  }

  function wireWriting() {
    // Timers belong to their screens; leaving one stops them.
    if (state.screen !== 'writing-exam') { clearInterval(wr.tick); wr.tick = null; clearTimeout(wr.saveTimer); }
    if (state.screen !== 'writing-result') { clearTimeout(wr.poll); wr.poll = null; }
    wireWritingHome();
    wireWritingExam();
    wireWritingCheck();
    wireWritingResult();
  }

  // =========================================================== LEADERBOARD
  //
  // The ten best AVERAGE full speaking mock scores on the site. Computed on
  // the server (services/Leaderboard.js); this only draws it. Scores survive a
  // student deleting an attempt, and a student needs a few full mocks before
  // they appear — both decided server-side, so nothing here can be gamed.

  const LB_UZ = {
    title: 'Reyting',
    sub: "Eng yuqori o'rtacha speaking bali — faqat to'liq mocklar hisoblanadi",
    you: 'Siz',
    mocks: n => `${n} ta mock`,
    avg: "o'rtacha",
    best: 'eng yaxshi',
    empty: min => `Hali hech kim reytingga kirmagan. Kamida ${min} ta to'liq speaking mock topshirgan birinchi o'quvchi bo'ling!`,
    yourRank: (rank, avg, mocks) => `Sizning o'rningiz: #${rank} · o'rtacha ${avg} · ${mocks} ta mock`,
    needMore: n => `Reytingga kirish uchun yana ${n} ta to'liq speaking mock topshiring.`,
    staff: "O'qituvchilar reytingda ko'rsatilmaydi.",
    nickLabel: 'Reytingdagi ismingiz',
    nickNone: 'taxallus tanlanmagan',
    nickEdit: "O'zgartirish",
    nickSet: 'Taxallus tanlash',
    nickPlaceholder: '3–20 belgi',
    nickSave: 'Saqlash',
    nickCancel: 'Bekor qilish',
    nickHint: "Taxallus tanlamasangiz, ismingiz va familiyangizning bosh harfi ko'rinadi.",
    nickSaved: 'Taxallus saqlandi.'
  };

  const MEDAL = { 1: 'gold', 2: 'silver', 3: 'bronze' };

  const initialsOf = name =>
    String(name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';

  // ---------------------------------------------------------------- premium
  //
  // Premium students (services/Premium.js) show a crown, a gold name, a
  // glowing ring and their own picture wherever a name appears in the
  // speaking club, the chat and the leaderboard.

  const CROWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7z" fill="currentColor"/></svg>';
  // Only ever an address this server made — never whatever a field contains.
  const safePic = url => (/^\/api\/avatars\/[a-f0-9]{32}$/.test(String(url || '')) ? url : null);

  /** What goes inside an avatar circle: the picture, or initials. */
  const picInner = person => safePic(person?.avatar)
    ? `<img class="av-pic" src="${esc(person.avatar)}" alt="" loading="lazy" decoding="async">`
    : `<span>${esc(initialsOf(person?.name))}</span>`;
  const premiumClass = person => (person?.premium ? ' is-premium' : '');
  const crownMark = person =>
    person?.premium ? `<span class="crown" title="Premium" aria-label="Premium" role="img">${CROWN}</span>` : '';
  const nameMarkup = person =>
    `<span class="${person?.premium ? 'gold-name' : ''}">${esc(person?.name || '')}</span>${crownMark(person)}`;

  async function loadLeaderboard() {
    try {
      state.leaderboard = await api('/leaderboard');
    } catch {
      state.leaderboard = null; // the card simply does not show
    }
  }

  function podiumSpot(entry) {
    if (!entry) return '<div class="lb-spot is-empty"></div>';
    const medal = MEDAL[entry.rank];
    return `<div class="lb-spot lb-${medal} ${entry.you ? 'is-you' : ''}">
      <div class="lb-avatar${premiumClass(entry)}">${picInner(entry)}<b class="lb-medal">${entry.rank}</b></div>
      <div class="lb-name" title="${esc(entry.name)}">${nameMarkup(entry)}${entry.you ? ` <span class="lb-you">${LB_UZ.you}</span>` : ''}</div>
      <div class="lb-score">${entry.average.toFixed(1)}</div>
      <div class="lb-meta">${esc(entry.level)} · ${esc(LB_UZ.mocks(entry.mocks))}</div>
      <div class="lb-step"><span>${entry.rank}</span></div>
    </div>`;
  }

  function nicknameRow() {
    const nick = state.user?.nickname || '';
    if (state.user?.role !== 'student') return '';
    if (state.nickEditing) {
      return `<div class="lb-nick is-editing">
        <label for="nick-input" class="lb-nick-label">${LB_UZ.nickLabel}</label>
        <div class="lb-nick-form">
          <input id="nick-input" maxlength="20" autocomplete="off" placeholder="${LB_UZ.nickPlaceholder}" value="${esc(nick)}" />
          <button class="btn btn-sm" data-lb="nick-save" ${state.nickSaving ? 'disabled' : ''}>${state.nickSaving ? '…' : LB_UZ.nickSave}</button>
          <button class="btn btn-ghost btn-sm" data-lb="nick-cancel">${LB_UZ.nickCancel}</button>
        </div>
        <p class="muted" style="font-size:12px;margin-top:6px">${LB_UZ.nickHint}</p>
      </div>`;
    }
    return `<div class="lb-nick">
      <span class="lb-nick-label">${LB_UZ.nickLabel}:</span>
      <strong>${nick ? esc(nick) : `<span class="muted" style="font-weight:500">${LB_UZ.nickNone}</span>`}</strong>
      <button class="link-more" style="margin-top:0" data-lb="nick-edit">${nick ? LB_UZ.nickEdit : LB_UZ.nickSet}</button>
    </div>`;
  }

  function leaderboardCard() {
    const lb = state.leaderboard;
    if (!lb) return '';

    const top = lb.top || [];
    const byRank = r => top.find(e => e.rank === r);
    const rest = top.filter(e => e.rank > 3);

    const podium = top.length
      ? `<div class="lb-podium">${podiumSpot(byRank(2))}${podiumSpot(byRank(1))}${podiumSpot(byRank(3))}</div>`
      : `<div class="lb-empty">${icon('trophy')}<p>${esc(LB_UZ.empty(lb.minMocks))}</p></div>`;

    const list = rest.length
      ? `<ol class="lb-list" start="4">${rest.map(e => `
          <li class="${e.you ? 'is-you' : ''}">
            <span class="lb-rank">${e.rank}</span>
            <span class="lb-mini${premiumClass(e)}">${picInner(e)}</span>
            <span class="lb-row-name">${nameMarkup(e)}${e.you ? ` <span class="lb-you">${LB_UZ.you}</span>` : ''}</span>
            <span class="lb-row-meta">${esc(e.level)} · ${esc(LB_UZ.mocks(e.mocks))}</span>
            <span class="lb-row-score">${e.average.toFixed(1)}</span>
          </li>`).join('')}</ol>`
      : '';

    const me = lb.you || {};
    const standing = state.user?.role !== 'student'
      ? LB_UZ.staff
      : me.rank
      ? LB_UZ.yourRank(me.rank, me.average.toFixed(1), me.mocks)
      : LB_UZ.needMore(me.needed || lb.minMocks);

    return `<section class="card lb-card" aria-labelledby="lb-title">
      <div class="lb-head">
        <div class="lb-head-icon">${icon('trophy')}</div>
        <div>
          <h2 id="lb-title">${LB_UZ.title} <span class="lb-top10">TOP 10</span></h2>
          <p class="muted">${LB_UZ.sub}</p>
        </div>
      </div>
      ${podium}
      ${list}
      <div class="lb-foot">
        <p class="lb-standing">${esc(standing)}</p>
        ${nicknameRow()}
      </div>
    </section>`;
  }

  async function saveNickname() {
    const value = document.getElementById('nick-input')?.value ?? '';
    setState({ nickSaving: true, error: '' });
    try {
      const data = await api('/user/nickname', { method: 'PUT', body: { nickname: value } });
      state.user = { ...(state.user || {}), nickname: data.nickname || undefined };
      store.set('user', JSON.stringify(state.user));
      await loadLeaderboard();
      setState({ nickSaving: false, nickEditing: false, notice: LB_UZ.nickSaved });
    } catch (error) {
      setState({ nickSaving: false, error: error.message });
    }
  }

  function wireLeaderboard() {
    root.querySelectorAll('[data-lb]').forEach(el =>
      el.addEventListener('click', () => {
        const action = el.dataset.lb;
        if (action === 'nick-edit') {
          setState({ nickEditing: true });
          const input = document.getElementById('nick-input');
          input?.focus();
          input?.select();
        } else if (action === 'nick-cancel') {
          setState({ nickEditing: false });
        } else if (action === 'nick-save') {
          saveNickname();
        }
      }));
    document.getElementById('nick-input')?.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); saveNickname(); }
      if (event.key === 'Escape') setState({ nickEditing: false });
    });
  }

  // ======================================================= SPEAKING ROOMS
  //
  // Students talk to each other live: a partner found for them, or an open
  // club room of up to five. Audio goes browser to browser (WebRTC); the
  // server only introduces them, through one long-lived stream (GET
  // /api/voice/stream) and short POSTs back.
  //
  // Everything live — connections, audio elements, the microphone, the
  // recorder — lives in `vc`, outside `state`, and the audio elements sit
  // outside #root. The page redraws often; a redraw must never cut a call.

  const VC_UZ = {
    title: 'Speaking xonalari',
    sub: "Boshqa o'quvchilar bilan jonli ingliz tilida gaplashing. Mavzu kartasi imtihondagi haqiqiy savollardan.",
    consentTitle: 'Boshlashdan oldin',
    consentBody: days =>
      `Xavfsizlik uchun barcha suhbatlar yozib olinadi. Yozuvlarni faqat ustoz eshitishi mumkin va ular ${days} kundan keyin avtomatik o'chiriladi.`,
    consentRules: [
      'Faqat ingliz tilida gaplashing.',
      "Hurmat bilan gaplashing — haqorat qilgan o'quvchi bloklanadi.",
      "Shaxsiy ma'lumot (telefon, manzil) aytmang.",
      "Yomon xulq bo'lsa, «Shikoyat» tugmasini bosing."
    ],
    consentAgree: 'Roziman, davom etish',
    connecting: 'Ulanmoqda…',
    partnerTitle: 'Sherik topish',
    partnerBody: "Darajangizga mos o'quvchi bilan juftlashasiz. Mavzu kartasi va 5 daqiqalik taymer beriladi.",
    partnerFind: 'Sherik topish',
    partnerWaiting: "Sherik qidirilmoqda…",
    partnerWaitingNote: "Darajangizdagi sherik bo'lmasa, 20 soniyadan keyin boshqa darajadagi bilan juftlashasiz.",
    cancel: 'Bekor qilish',
    waiting: n => (n ? `${n} kishi kutmoqda` : "Hozir hech kim kutmayapti"),
    clubsTitle: 'Speaking club xonalari',
    clubsBody: "Guruh bo'lib gaplashing — 5 kishigacha. Istalgan xonaga kiring.",
    join: 'Kirish',
    full: "To'lgan",
    empty: "Bo'sh — birinchi bo'ling",
    mic: 'Mikrofonga ruxsat bering — brauzeringiz so\'raydi.',
    micDenied: "Mikrofonga ruxsat berilmadi. Brauzer sozlamalarida shu sayt uchun mikrofonni yoqing.",
    recording: 'Yozib olinmoqda',
    topic: 'Mavzu',
    newTopic: 'Yangi mavzu',
    for: 'Tarafdor',
    against: 'Qarshi',
    mute: "Ovozni o'chirish",
    unmute: 'Ovozni yoqish',
    leave: 'Chiqish',
    report: 'Shikoyat',
    reportWho: 'Kim haqida?',
    reportWhy: "Nima bo'ldi? (qisqacha)",
    reportSend: 'Yuborish',
    reportSent: "Shikoyat ustozga yuborildi. Rahmat.",
    you: 'Siz',
    connectingPeer: 'ulanmoqda…',
    failedPeer: "ulanib bo'lmadi",
    alone: "Hozircha xonada faqat siz. Boshqalar kirishini kuting yoki do'stingizni taklif qiling.",
    timeUp: "Vaqt tugadi — xohlasangiz davom eting.",
    partnerLeft: 'Sherigingiz suhbatni tugatdi.',
    rateTitle: name => `${name} bilan suhbat qanday bo'ldi?`,
    rateThanks: 'Rahmat!',
    again: 'Yana sherik topish',
    backToRooms: 'Xonalarga qaytish',
    kicked: 'Ustoz sizni suhbatdan chiqardi.',
    lost: "Aloqa uzildi — qayta ulanmoqda…",
    noRelay: "Mobil internetda ba'zan ulanish qiyin bo'lishi mumkin. Wi-Fi'da yaxshiroq ishlaydi."
  };

  const PAIR_SECONDS = 5 * 60;
  const SEGMENT_MS = 10 * 60 * 1000; // recording pieces of up to ten minutes

  const vc = {
    active: false,          // the stream should be open
    abort: null,            // AbortController for the stream
    connected: false,
    iceServers: [],
    retentionDays: 7,
    me: null,
    rooms: [],
    waiting: 0,
    queued: false,
    room: null,             // current roomView
    peers: new Map(),       // peerId -> { pc, audio, pendingIce, state, level }
    local: null,            // MediaStream
    muted: false,
    recorder: null,
    segmentTimer: null,
    segmentStart: 0,
    uploads: [],
    audioCtx: null,
    meters: new Map(),      // id -> AnalyserNode
    meterTimer: null,
    tick: null,
    pairStart: 0,
    after: null,            // { kind, sessionId, partner:{id,name}, rated }
    reportOpen: false,
    notice: '',
    status: null,           // /voice/status
    chat: [],               // messages typed in the current call
    chatRoom: null          // which call those messages belong to
  };

  const audioBox = () => {
    let box = document.getElementById('vc-audio');
    if (!box) {
      box = document.createElement('div');
      box.id = 'vc-audio';
      box.hidden = true;
      document.body.appendChild(box);
    }
    return box;
  };

  // ------------------------------------------------------------ stream

  /**
   * The speaking club has two tabs: voice rooms and text chat. Each opens its
   * own stream only while it is showing, so a student reading the chat is
   * not sitting in the voice lobby and the other way round.
   */
  async function openVoice(tab = ch.tab || 'voice') {
    ch.tab = tab;
    go('speak', { loading: true });
    try {
      const [status, premium] = await Promise.all([
        api('/voice/status'),
        api('/user/premium').catch(() => null)
      ]);
      vc.status = status;
      pr.state = premium;
      state.loading = false;
      if (vc.status.blocked) return setState({ error: ACCESS_UZ.blockedTitle });
      if (tab === 'chat') {
        stopVoice();
        startChat();
      } else {
        stopChat();
        if (vc.status.consented) startStream();
      }
      render();
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  async function agreeVoice() {
    try {
      await api('/voice/consent', { method: 'POST' });
      vc.status = { ...(vc.status || {}), consented: true };
      startStream();
      render();
    } catch (error) {
      setState({ error: error.message });
    }
  }

  function startStream() {
    if (vc.active) return;
    vc.active = true;
    readStream();
  }

  async function readStream() {
    while (vc.active) {
      vc.abort = new AbortController();
      try {
        const response = await fetch(`${API}/voice/stream`, {
          headers: { Authorization: `Bearer ${state.token}` },
          signal: vc.abort.signal
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          vc.active = false;
          vc.connected = false;
          setState({ error: payload.message || `Speaking rooms unavailable (${response.status})` });
          return;
        }
        vc.connected = true;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = frame.match(/^event: (.+)$/m)?.[1];
            const data = frame.match(/^data: (.+)$/m)?.[1];
            if (event && data) {
              try { onVoiceEvent(event, JSON.parse(data)); } catch (error) { console.error('voice event', event, error); }
            }
          }
        }
      } catch (error) {
        if (!vc.active) return;
      }
      vc.connected = false;
      if (!vc.active) return;
      vc.notice = VC_UZ.lost;
      if (state.screen === 'speak') render();
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  function stopVoice() {
    if (!vc.active && !vc.room && !vc.local) return;
    vc.active = false;
    if (vc.room || vc.queued) api(vc.queued ? '/voice/partner' : '/voice/leave', { method: vc.queued ? 'DELETE' : 'POST' }).catch(() => {});
    leaveCallLocally();
    vc.abort?.abort();
    vc.local?.getTracks().forEach(t => t.stop());
    vc.local = null;
    vc.queued = false;
    vc.connected = false;
  }

  const send = (to, payload) =>
    api('/voice/signal', { method: 'POST', body: { to, payload } }).catch(error => console.warn('signal', error.message));

  // ------------------------------------------------------------- events

  function onVoiceEvent(event, data) {
    switch (event) {
      case 'config':
        vc.iceServers = data.iceServers || [];
        vc.retentionDays = data.retentionDays || vc.retentionDays;
        return;
      case 'hello':
        vc.me = data.you;
        vc.rooms = data.rooms || [];
        vc.waiting = data.waiting || 0;
        vc.queued = Boolean(data.queued);
        vc.notice = '';
        if (data.room) {
          // Back after a dropped connection: reconnect to everyone still there.
          enterRoom(data.room, data.room.members.map(m => m.id).filter(id => id !== vc.me));
        }
        break;
      case 'rooms':
        vc.rooms = data.rooms || [];
        vc.waiting = data.waiting || 0;
        break;
      case 'matched':
        vc.queued = false;
        vc.after = null;
        // Remembered now: when the partner leaves, "peer-left" removes them
        // from the room before "ended" arrives, and the rating card still
        // needs to know who they were.
        vc.partner = (data.members || []).find(m => m.id !== vc.me) || null;
        enterRoom(data, data.initiator === vc.me ? data.members.map(m => m.id).filter(id => id !== vc.me) : []);
        vc.pairStart = Date.now();
        break;
      case 'joined':
        vc.after = null;
        vc.partner = null;
        enterRoom(data, data.callPeers || []);
        break;
      case 'session':
        if (vc.room) {
          vc.room.sessionId = data.sessionId;
          startRecording();
        }
        return;
      case 'peer-updated':
        // A crown or picture changed while in the call.
        if (vc.room) vc.room.members = vc.room.members.map(m => (m.id === data.peer.id ? { ...m, ...data.peer } : m));
        break;
      case 'peer-joined':
        if (vc.room && !vc.room.members.some(m => m.id === data.peer.id)) vc.room.members.push(data.peer);
        break;
      case 'peer-left':
        if (vc.room) vc.room.members = vc.room.members.filter(m => m.id !== data.peer);
        closePeer(data.peer);
        break;
      case 'topic':
        if (vc.room) vc.room.topic = data.topic;
        break;
      case 'signal':
        onSignal(data.from, data.payload);
        return;
      case 'chat':
        if (!vc.chat.some(m => m.id === data.id)) vc.chat.push(data);
        break;
      case 'chat-deleted':
        vc.chat = vc.chat.map(m => m.id === data.id ? { ...m, text: '', deleted: true } : m);
        break;
      case 'ended': {
        const partner = vc.partner || vc.room?.members.find(m => m.id !== vc.me);
        vc.after = { kind: 'pair', sessionId: data.sessionId || vc.room?.sessionId, partner, rated: false, reason: data.reason };
        leaveCallLocally();
        break;
      }
      case 'kicked':
        vc.active = false;
        leaveCallLocally();
        vc.abort?.abort();
        state.error = data.reason || VC_UZ.kicked;
        break;
    }
    if (state.screen === 'speak') render();
  }

  // ----------------------------------------------------------- the call

  async function ensureMic() {
    if (vc.local) return vc.local;
    vc.notice = VC_UZ.mic;
    if (state.screen === 'speak') render();
    try {
      vc.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      vc.notice = '';
      watchLevel(vc.me || 'me', vc.local);
      return vc.local;
    } catch (error) {
      vc.notice = '';
      throw new Error(VC_UZ.micDenied);
    }
  }

  async function enterRoom(room, callPeers) {
    vc.room = { ...room, members: [...(room.members || [])] };
    // A new call starts with an empty chat; coming back to the same call
    // after a dropped connection keeps what was already typed.
    const callId = room.roomId || room.id;
    if (vc.chatRoom !== callId) { vc.chat = []; vc.chatRoom = callId; }
    vc.reportOpen = false;
    try {
      await ensureMic();
    } catch (error) {
      api('/voice/leave', { method: 'POST' }).catch(() => {});
      vc.room = null;
      return setState({ error: error.message });
    }
    applyMute();
    startTicking();
    if (vc.room.sessionId) startRecording();
    for (const peerId of callPeers) callPeer(peerId, true);
    if (state.screen === 'speak') render();
  }

  function newPeer(peerId) {
    closePeer(peerId);
    const pc = new RTCPeerConnection({ iceServers: vc.iceServers });
    const peer = { pc, audio: null, pendingIce: [], state: 'connecting' };
    vc.peers.set(peerId, peer);

    vc.local?.getTracks().forEach(track => pc.addTrack(track, vc.local));
    pc.onicecandidate = e => { if (e.candidate) send(peerId, { type: 'ice', candidate: e.candidate }); };
    pc.ontrack = e => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (!peer.audio) {
        peer.audio = document.createElement('audio');
        peer.audio.autoplay = true;
        peer.audio.setAttribute('playsinline', '');
        audioBox().appendChild(peer.audio);
      }
      peer.audio.srcObject = stream;
      peer.audio.play().catch(() => {});
      watchLevel(peerId, stream);
    };
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState;
      paintPeerState(peerId);
    };
    return peer;
  }

  async function callPeer(peerId, initiator) {
    const peer = newPeer(peerId);
    if (!initiator) return peer;
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    send(peerId, { type: 'offer', sdp: peer.pc.localDescription });
    return peer;
  }

  async function onSignal(from, payload) {
    if (!vc.room || !payload) return;
    try {
      if (payload.type === 'offer') {
        // A new offer always starts a fresh connection with that person — this
        // is also how someone who dropped out and came back reconnects.
        if (!vc.local) await ensureMic();
        const peer = newPeer(from);
        await peer.pc.setRemoteDescription(payload.sdp);
        for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        send(from, { type: 'answer', sdp: peer.pc.localDescription });
      } else if (payload.type === 'answer') {
        const peer = vc.peers.get(from);
        if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
        await peer.pc.setRemoteDescription(payload.sdp);
        for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
      } else if (payload.type === 'ice') {
        const peer = vc.peers.get(from);
        if (!peer) return;
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(payload.candidate).catch(() => {});
        else peer.pendingIce.push(payload.candidate);
      }
    } catch (error) {
      console.warn('voice signal failed', error);
    }
  }

  function closePeer(peerId) {
    const peer = vc.peers.get(peerId);
    if (!peer) return;
    try { peer.pc.close(); } catch { /* already closed */ }
    if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
    vc.peers.delete(peerId);
    vc.meters.delete(peerId);
  }

  function leaveCallLocally() {
    stopRecording();
    for (const id of [...vc.peers.keys()]) closePeer(id);
    vc.room = null;
    vc.reportOpen = false;
    clearInterval(vc.tick); vc.tick = null;
  }

  async function leaveRoom() {
    const wasPair = vc.room?.kind === 'pair';
    const partner = vc.partner || vc.room?.members.find(m => m.id !== vc.me);
    const sessionId = vc.room?.sessionId;
    leaveCallLocally();
    await api('/voice/leave', { method: 'POST' }).catch(() => {});
    vc.after = wasPair && partner ? { kind: 'pair', sessionId, partner, rated: false } : null;
    render();
  }

  function applyMute() {
    vc.local?.getAudioTracks().forEach(t => { t.enabled = !vc.muted; });
  }

  // ------------------------------------------------------ recording

  function recorderType() {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return types.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
  }

  /** Record this student's own microphone, in pieces of up to ten minutes. */
  function startRecording() {
    if (!vc.local || !vc.room?.sessionId || vc.recorder || !window.MediaRecorder) return;
    const sessionId = vc.room.sessionId;
    const type = recorderType();
    const chunks = [];
    let recorder;
    try {
      recorder = new MediaRecorder(vc.local, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 24000 });
    } catch {
      return;
    }
    vc.recorder = recorder;
    vc.segmentStart = Date.now();
    recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const seconds = Math.round((Date.now() - vc.segmentStart) / 1000);
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
      if (blob.size > 2000) uploadSegment(sessionId, blob, seconds);
    };
    recorder.start(1000);
    clearTimeout(vc.segmentTimer);
    vc.segmentTimer = setTimeout(() => {
      // Start a fresh piece: each one is a complete, playable file on its own.
      stopRecording();
      startRecording();
    }, SEGMENT_MS);
  }

  function stopRecording() {
    clearTimeout(vc.segmentTimer);
    vc.segmentTimer = null;
    const recorder = vc.recorder;
    vc.recorder = null;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* already stopped */ }
    }
  }

  function uploadSegment(sessionId, blob, seconds) {
    const form = new FormData();
    form.append('audio', blob, `voice.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`);
    form.append('seconds', String(seconds));
    api(`/voice/sessions/${sessionId}/recording`, { method: 'POST', form })
      .catch(error => console.warn('voice recording upload failed', error.message));
  }

  // ------------------------------------------------ levels and timer

  function watchLevel(id, stream) {
    try {
      vc.audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      vc.audioCtx.resume?.();
      const source = vc.audioCtx.createMediaStreamSource(stream);
      const analyser = vc.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      vc.meters.set(id, analyser);
      if (!vc.meterTimer) vc.meterTimer = setInterval(paintLevels, 120);
    } catch { /* no meter, the call still works */ }
  }

  const levelBuf = new Uint8Array(512);
  function paintLevels() {
    if (state.screen !== 'speak') return;
    for (const [id, analyser] of vc.meters) {
      const el = document.getElementById(`vc-p-${id === 'me' ? vc.me : id}`);
      if (!el) continue;
      analyser.getByteTimeDomainData(levelBuf);
      let sum = 0;
      for (const v of levelBuf) sum += (v - 128) * (v - 128);
      const rms = Math.sqrt(sum / levelBuf.length) / 128;
      const talking = rms > 0.04 && !(id === vc.me && vc.muted);
      el.classList.toggle('is-talking', talking);
    }
  }

  function startTicking() {
    clearInterval(vc.tick);
    vc.tick = setInterval(() => {
      const el = document.getElementById('vc-timer');
      if (!el || !vc.room) return;
      if (vc.room.kind === 'pair') {
        const left = PAIR_SECONDS - Math.floor((Date.now() - vc.pairStart) / 1000);
        el.textContent = left > 0 ? fmtTime(left) : VC_UZ.timeUp;
        el.classList.toggle('is-low', left <= 30);
      } else {
        const since = Math.floor((Date.now() - (vc.room.startedAt || Date.now())) / 1000);
        el.textContent = fmtTime(Math.max(0, since));
      }
    }, 1000);
  }

  function paintPeerState(peerId) {
    const el = document.getElementById(`vc-s-${peerId}`);
    const peer = vc.peers.get(peerId);
    if (!el || !peer) return;
    el.textContent = peer.state === 'connected' ? '' : peer.state === 'failed' ? VC_UZ.failedPeer : VC_UZ.connectingPeer;
    el.closest('.vc-person')?.classList.toggle('is-failed', peer.state === 'failed');
  }

  // --------------------------------------------------------- screens

  function speakScreen() {
    if (state.loading || !vc.status) {
      return `<div class="center-note"><span class="spinner"></span></div>`;
    }
    // In a call the call is the whole screen; its own chat is inside it.
    if (vc.room) return roomScreen();
    const tab = ch.tab === 'chat' ? 'chat' : 'voice';
    const tabBtn = (id, label, iconName) =>
      `<button class="ch-tab ${tab === id ? 'is-current' : ''}" data-ch-tab="${id}" aria-pressed="${tab === id}">${icon(iconName)} ${label}</button>`;
    return `
      <div>
        <button class="crumb" data-go="dashboard">${icon('left')} Dashboard</button>
        <h1 style="font-size:26px;margin:10px 0 4px">${VC_UZ.title}</h1>
        <p class="muted">${tab === 'chat' ? CH_UZ.sub : VC_UZ.sub}</p>
      </div>
      ${premiumStrip()}
      <div class="ch-tabs" role="group">
        ${tabBtn('voice', CH_UZ.tabVoice, 'mic')}
        ${tabBtn('chat', CH_UZ.tabChat, 'message')}
      </div>
      ${tab === 'chat' ? chatScreen() : !vc.status.consented ? consentScreen() : lobbyScreen()}`;
  }

  function consentScreen() {
    return `<div class="card form-card vc-consent">
      <div class="vc-consent-icon">${icon('users')}</div>
      <h2>${VC_UZ.consentTitle}</h2>
      <p style="margin-top:10px">${esc(VC_UZ.consentBody(vc.status.retentionDays || 7))}</p>
      <ul class="vc-rules">${VC_UZ.consentRules.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      <button class="btn btn-lg btn-block" data-vc="agree">${VC_UZ.consentAgree}</button>
    </div>`;
  }

  function lobbyScreen() {
    const after = vc.after ? afterCard() : '';
    const partner = vc.queued
      ? `<div class="vc-wait"><span class="vc-pulse"></span>
           <div><strong>${VC_UZ.partnerWaiting}</strong>
             <p class="muted" style="font-size:13px;margin-top:2px">${VC_UZ.partnerWaitingNote}</p></div>
           <button class="btn btn-ghost btn-sm" data-vc="cancel">${VC_UZ.cancel}</button>
         </div>`
      : `<button class="btn btn-lg" data-vc="find" ${vc.connected ? '' : 'disabled'}>${icon('users')} ${VC_UZ.partnerFind}</button>`;

    const iAmPremium = Boolean(vc.status?.premium);
    const clubs = (vc.rooms || []).map(r => {
      const extra = r.premiumSeats || 0;
      // Full for everyone else; a Premium student still has the gold seat.
      const premiumSeat = r.count >= r.max && r.count < r.max + extra && iAmPremium;
      const full = r.count >= r.max && !premiumSeat;
      const seats = Array.from({ length: r.max }, (_, i) => `<span class="vc-seat ${i < r.count ? 'is-taken' : ''}"></span>`).join('')
        + (extra ? `<span class="vc-seat is-gold ${r.count > r.max ? 'is-taken' : ''}" title="${esc(PR_UZ.goldSeat)}"></span>` : '');
      const faces = (r.people || []).map(p =>
        `<span class="vc-face${premiumClass(p)}" title="${esc(p.name)}">${picInner(p)}</span>`).join('');
      return `<div class="card vc-club">
        <div class="row" style="justify-content:space-between;gap:10px">
          <h3>${esc(r.name)}</h3>
          ${r.level ? `<span class="chip chip-speaking">${esc(r.level)}</span>` : ''}
        </div>
        <div class="vc-seats" aria-label="${r.count} / ${r.max}">${seats}<span class="muted">${Math.min(r.count, r.max)}/${r.max}${r.count > r.max ? ' +👑' : ''}</span></div>
        ${r.count
          ? `<div class="vc-faces">${faces}</div><p class="muted vc-club-names">${esc(r.names.join(', '))}</p>`
          : `<p class="muted vc-club-names">${VC_UZ.empty}</p>`}
        <button class="btn ${full ? 'btn-ghost' : ''}${premiumSeat ? ' btn-gold' : ''}" data-vc-join="${esc(r.id)}" ${full || !vc.connected ? 'disabled' : ''}>
          ${full ? VC_UZ.full : premiumSeat ? `${CROWN} ${PR_UZ.goldSeat}` : VC_UZ.join}
        </button>
      </div>`;
    }).join('');

    return `
      ${vc.notice ? `<div class="alert alert-warn">${esc(vc.notice)}</div>` : ''}
      ${after}
      <div class="card vc-partner">
        <div class="vc-partner-text">
          <h2>${VC_UZ.partnerTitle}</h2>
          <p class="muted" style="margin-top:4px">${VC_UZ.partnerBody}</p>
          <p class="muted" style="margin-top:6px;font-size:13px">${esc(VC_UZ.waiting(vc.waiting))}</p>
        </div>
        <div class="vc-partner-action">${partner}</div>
      </div>
      <div class="section-head" style="margin-top:6px"><h2>${VC_UZ.clubsTitle}</h2><p>${VC_UZ.clubsBody}</p></div>
      <div class="vc-clubs">${clubs}</div>
      ${vc.status.relay ? '' : `<p class="muted" style="font-size:13px">${VC_UZ.noRelay}</p>`}`;
  }

  function topicCard(topic) {
    if (!topic) return '';
    const text = esc(topic.text).replace(/\n/g, '<br>');
    return `<div class="vc-topic">
      <div class="row" style="justify-content:space-between;gap:10px;align-items:center">
        <span class="vc-topic-label">${esc(topic.title || VC_UZ.topic)}</span>
        <button class="btn btn-ghost btn-sm" data-vc="topic">${VC_UZ.newTopic}</button>
      </div>
      <p class="vc-topic-text">${text}</p>
      ${topic.pros?.length || topic.cons?.length ? `<div class="vc-args">
        <div><div class="section-title">${VC_UZ.for}</div><ul>${(topic.pros || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>
        <div><div class="section-title">${VC_UZ.against}</div><ul>${(topic.cons || []).map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>
      </div>` : ''}
    </div>`;
  }

  function roomScreen() {
    const room = vc.room;
    const others = room.members.filter(m => m.id !== vc.me);
    const me = room.members.find(m => m.id === vc.me) || { id: vc.me, name: VC_UZ.you };
    const person = (m, isMe) => {
      const peer = vc.peers.get(m.id);
      const status = isMe ? '' : peer?.state === 'connected' ? '' : peer?.state === 'failed' ? VC_UZ.failedPeer : VC_UZ.connectingPeer;
      return `<div class="vc-person ${isMe ? 'is-me' : ''}" id="vc-p-${esc(m.id)}">
        <div class="vc-avatar${premiumClass(m)}">${picInner(m)}</div>
        <div class="vc-person-name">${nameMarkup(m)}${isMe ? ` <span class="lb-you">${VC_UZ.you}</span>` : ''}</div>
        <div class="vc-person-meta">${m.level ? esc(m.level) : ''}${isMe && vc.muted ? ' · 🔇' : ''}</div>
        ${isMe ? '' : `<div class="vc-person-state" id="vc-s-${esc(m.id)}">${esc(status)}</div>`}
      </div>`;
    };

    const reportForm = vc.reportOpen ? `<div class="card vc-report">
        <label class="field"><span class="muted" style="font-size:13px">${VC_UZ.reportWho}</span>
          <select id="vc-report-who">${others.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></label>
        <label class="field" style="margin-top:8px"><span class="muted" style="font-size:13px">${VC_UZ.reportWhy}</span>
          <textarea id="vc-report-why" class="essay" rows="2" style="min-height:0"></textarea></label>
        <div class="row" style="gap:8px;margin-top:8px">
          <button class="btn btn-sm" data-vc="report-send">${VC_UZ.reportSend}</button>
          <button class="btn btn-ghost btn-sm" data-vc="report-close">${VC_UZ.cancel}</button>
        </div>
      </div>` : '';

    return `
      <div class="vc-room-head">
        <div>
          <div class="muted" style="font-size:13px">${esc(room.name)}</div>
          <div class="vc-timer" id="vc-timer">${room.kind === 'pair' ? fmtTime(PAIR_SECONDS) : '00:00'}</div>
        </div>
        <span class="vc-rec"><span></span>${VC_UZ.recording}</span>
      </div>
      ${vc.notice ? `<div class="alert alert-warn">${esc(vc.notice)}</div>` : ''}
      ${topicCard(room.topic)}
      <div class="vc-people">
        ${person(me, true)}
        ${others.map(m => person(m, false)).join('')}
      </div>
      ${others.length ? '' : `<p class="muted" style="text-align:center">${VC_UZ.alone}</p>`}
      ${reportForm}
      <div class="vc-controls">
        <button class="vc-btn ${vc.muted ? 'is-on' : ''}" data-vc="mute">${icon('mic')}<span>${vc.muted ? VC_UZ.unmute : VC_UZ.mute}</span></button>
        ${others.length ? `<button class="vc-btn" data-vc="report-open">${icon('message')}<span>${VC_UZ.report}</span></button>` : ''}
        <button class="vc-btn vc-leave" data-vc="leave">${icon('right')}<span>${VC_UZ.leave}</span></button>
      </div>
      <div class="card ch-call">
        <div class="ch-call-head">${icon('message')} <strong>${CH_UZ.callTitle}</strong></div>
        <div class="ch-list ch-list-call" id="ch-call-list" data-keep-scroll>
          ${vc.chat.length ? vc.chat.map(m => messageMarkup(m, 'call')).join('') : `<p class="muted ch-empty">${CH_UZ.callEmpty}</p>`}
        </div>
        ${composerMarkup('ch-call-input', 'call')}
      </div>`;
  }

  function afterCard() {
    const a = vc.after;
    if (!a?.partner) return '';
    return `<div class="card vc-after">
      ${a.reason === 'partner-left' ? `<p class="muted" style="margin-bottom:6px">${VC_UZ.partnerLeft}</p>` : ''}
      <strong>${esc(VC_UZ.rateTitle(a.partner.name))}</strong>
      ${a.rated
        ? `<p style="margin-top:8px">${VC_UZ.rateThanks}</p>`
        : `<div class="vc-stars">${[1, 2, 3, 4, 5].map(n => `<button data-vc-star="${n}" aria-label="${n}">★</button>`).join('')}</div>`}
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn btn-sm" data-vc="find">${VC_UZ.again}</button>
        <button class="btn btn-ghost btn-sm" data-vc="after-report">${VC_UZ.report}</button>
      </div>
      ${a.reportOpen ? `<div style="margin-top:10px">
        <textarea id="vc-after-why" class="essay" rows="2" style="min-height:0" placeholder="${esc(VC_UZ.reportWhy)}"></textarea>
        <button class="btn btn-sm" style="margin-top:8px" data-vc="after-report-send">${VC_UZ.reportSend}</button>
      </div>` : ''}
    </div>`;
  }

  // --------------------------------------------------------- wiring

  async function vcAction(action, el) {
    try {
      if (action === 'agree') return agreeVoice();
      if (action === 'find') {
        vc.after = null;
        await ensureMic();
        vc.queued = true; render();
        const r = await api('/voice/partner', { method: 'POST' });
        if (r.matched) vc.queued = false;
        return render();
      }
      if (action === 'cancel') {
        vc.queued = false; render();
        return api('/voice/partner', { method: 'DELETE' });
      }
      if (action === 'leave') return leaveRoom();
      if (action === 'mute') { vc.muted = !vc.muted; applyMute(); return render(); }
      if (action === 'topic') return api('/voice/topic', { method: 'POST' });
      if (action === 'report-open') { vc.reportOpen = true; return render(); }
      if (action === 'report-close') { vc.reportOpen = false; return render(); }
      if (action === 'report-send') {
        const against = document.getElementById('vc-report-who')?.value;
        const reason = document.getElementById('vc-report-why')?.value || '';
        await api('/voice/report', { method: 'POST', body: { sessionId: vc.room?.sessionId, against, reason } });
        vc.reportOpen = false;
        return setState({ notice: VC_UZ.reportSent });
      }
      if (action === 'after-report') { vc.after.reportOpen = !vc.after.reportOpen; return render(); }
      if (action === 'after-report-send') {
        const reason = document.getElementById('vc-after-why')?.value || '';
        await api('/voice/report', { method: 'POST', body: { sessionId: vc.after.sessionId, against: vc.after.partner.id, reason } });
        vc.after.reportOpen = false;
        return setState({ notice: VC_UZ.reportSent });
      }
    } catch (error) {
      vc.queued = false;
      setState({ error: error.message });
    }
  }

  function wireSpeak() {
    if (state.screen !== 'speak') {
      // Leaving the speaking screen hangs up: a call nobody can see is a call
      // nobody can mute or leave.
      if (vc.active || vc.room || vc.local) stopVoice();
      if (ch.active) stopChat();
      return;
    }
    wireChat();
    wirePremium();
    root.querySelectorAll('[data-vc]').forEach(el =>
      el.addEventListener('click', () => vcAction(el.dataset.vc, el)));
    root.querySelectorAll('[data-vc-join]').forEach(el =>
      el.addEventListener('click', async () => {
        try {
          vc.after = null;
          await ensureMic();
          await api('/voice/join', { method: 'POST', body: { roomId: el.dataset.vcJoin } });
        } catch (error) {
          setState({ error: error.message });
        }
      }));
    root.querySelectorAll('[data-vc-star]').forEach(el =>
      el.addEventListener('click', async () => {
        const a = vc.after;
        if (!a?.sessionId) return;
        await api('/voice/rate', { method: 'POST', body: { sessionId: a.sessionId, peer: a.partner.id, stars: Number(el.dataset.vcStar) } }).catch(() => {});
        a.rated = true;
        render();
      }));
    if (vc.room) {
      for (const id of vc.peers.keys()) paintPeerState(id);
    }
  }



  // ------------------------------------------------------------ premium strip

  const PR_UZ = {
    title: 'Premium',
    active: days => `Premium faol · ${days} kun qoldi`,
    until: d => `${d} gacha`,
    upload: "Rasm yoki GIF qo'yish",
    change: "Rasmni o'zgartirish",
    remove: 'Olib tashlash',
    uploading: 'Yuklanmoqda…',
    hint: "GIF, PNG, JPG yoki WEBP · 2 MB gacha. Hurmatli rasm tanlang — ustoz noo'rin rasmni o'chiradi.",
    blocked: "Ustoz sizga rasm qo'yishni to'xtatgan.",
    kept: "Rasmingiz saqlangan — Premium yangilanganda yana ko'rinadi.",
    upsellTitle: "Premium bo'ling 👑",
    upsell: days => `Paket sotib olsangiz, ${days} kun Premium sovg'a:`,
    perks: [
      "Ismingiz yonida toj belgisi",
      "O'z rasmingiz yoki animatsiyali GIF avatar",
      "Oltin rangli ism va avatar atrofida nur",
      "To'la xonada siz uchun qo'shimcha joy",
      "Sherik qidirganda birinchi bo'lib topiladi"
    ],
    buy: 'Paket olish',
    goldSeat: 'Premium joy',
    tooBig: "Rasm 2 MB dan katta — kichikroq rasm tanlang."
  };

  const pr = { state: null, busy: false, error: '' };

  // Written out by hand: browsers have no Uzbek month names and show "M10".
  const UZ_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
  const shortDate = d => {
    const x = new Date(d);
    return Number.isNaN(x.getTime()) ? '' : `${x.getDate()}-${UZ_MONTHS[x.getMonth()]}`;
  };

  function premiumStrip() {
    const p = pr.state;
    if (!p || state.user?.role !== 'student') return '';
    const me = { name: p.name, premium: p.active, avatar: p.avatar };
    const avatar = `<div class="pr-avatar${premiumClass(me)}">${picInner(me)}</div>`;
    const error = pr.error ? `<p class="pr-error" role="alert">${esc(pr.error)}</p>` : '';

    if (!p.active) {
      return `<section class="card pr-strip is-free">
        ${avatar}
        <div class="pr-body">
          <h3>${PR_UZ.upsellTitle}</h3>
          <p class="muted">${esc(PR_UZ.upsell(p.days))}</p>
          <ul class="pr-perks">${PR_UZ.perks.map(t => `<li>${CROWN}<span>${esc(t)}</span></li>`).join('')}</ul>
          ${p.hasPicture ? `<p class="muted pr-note">${PR_UZ.kept}</p>` : ''}
        </div>
        <button class="btn btn-gold" data-pr="buy">${PR_UZ.buy}</button>
      </section>`;
    }

    const actions = p.pictureBlocked
      ? `<p class="muted pr-note">${PR_UZ.blocked}</p>`
      : `<div class="pr-actions">
          <label class="btn btn-sm btn-gold pr-upload ${pr.busy ? 'is-busy' : ''}">
            <input type="file" id="pr-file" accept="image/gif,image/png,image/jpeg,image/webp" ${pr.busy ? 'disabled' : ''}>
            ${pr.busy ? PR_UZ.uploading : p.avatar ? PR_UZ.change : PR_UZ.upload}
          </label>
          ${p.avatar ? `<button class="btn btn-ghost btn-sm" data-pr="remove" ${pr.busy ? 'disabled' : ''}>${PR_UZ.remove}</button>` : ''}
        </div>
        <p class="muted pr-note">${PR_UZ.hint}</p>`;

    return `<section class="card pr-strip is-premium">
      ${avatar}
      <div class="pr-body">
        <div class="pr-name">${nameMarkup(me)}</div>
        <p class="pr-status">${esc(PR_UZ.active(p.daysLeft))} <span class="muted">· ${esc(PR_UZ.until(shortDate(p.until)))}</span></p>
        ${actions}
        ${error}
      </div>
    </section>`;
  }

  async function uploadPicture(file) {
    if (!file) return;
    if (pr.state && file.size > pr.state.maxBytes) {
      pr.error = PR_UZ.tooBig;
      return render();
    }
    pr.busy = true; pr.error = ''; render();
    try {
      const form = new FormData();
      form.append('picture', file);
      pr.state = await api('/user/avatar', { method: 'POST', form });
      // The leaderboard shows the picture too.
      loadLeaderboard();
    } catch (error) {
      pr.error = error.message;
    }
    pr.busy = false;
    render();
  }

  async function removePicture() {
    pr.busy = true; pr.error = ''; render();
    try {
      pr.state = await api('/user/avatar', { method: 'DELETE' });
    } catch (error) {
      pr.error = error.message;
    }
    pr.busy = false;
    render();
  }

  function wirePremium() {
    document.getElementById('pr-file')?.addEventListener('change', event => uploadPicture(event.target.files?.[0]));
    root.querySelectorAll('[data-pr="remove"]').forEach(el => el.addEventListener('click', removePicture));
    root.querySelectorAll('[data-pr="buy"]').forEach(el => el.addEventListener('click', () => go('topup', { topupReason: 'premium' })));
  }

  // ============================================================ text chat
  //
  // Two places to type: the General / B1 / B2 / C1 rooms on the Chat tab,
  // and a small chat inside every speaking call. Everything is filtered on the
  // server (swearing masked, links and phone numbers removed, English only)
  // and every message is visible to the teacher.

  const CH_UZ = {
    tabVoice: 'Ovozli xonalar',
    tabChat: 'Chat',
    sub: "Boshqa o'quvchilar bilan ingliz tilida yozishing. Xabarlarni ustoz ham ko'radi.",
    roomsTitle: 'Xonalar',
    online: n => (n ? `${n} kishi shu yerda` : "Hozir hech kim yo'q"),
    placeholder: 'Write in English…',
    send: 'Yuborish',
    report: 'Shikoyat',
    reportWhy: "Nima bo'ldi? (ixtiyoriy)",
    reportSend: 'Ustozga yuborish',
    reportSent: 'Shikoyat ustozga yuborildi. Rahmat!',
    cancel: 'Bekor qilish',
    deleted: "Bu xabar ustoz tomonidan o'chirildi",
    empty: "Hali xabar yo'q — birinchi bo'lib salom bering! 👋",
    rules: "Faqat ingliz tilida. Havolalar, telefon raqamlari va so'kinishlar avtomatik olib tashlanadi.",
    connecting: 'Ulanmoqda…',
    lost: 'Aloqa uzildi — qayta ulanmoqda…',
    kicked: 'Ustoz sizni chatdan chiqardi.',
    you: 'siz',
    callTitle: 'Chat',
    callEmpty: "Bu yerga yozishingiz mumkin — masalan, so'zni yozib ko'rsatish uchun."
  };

  const ch = {
    tab: 'voice',
    active: false,
    abort: null,
    connected: false,
    me: null,
    rooms: [],
    room: 'text-general',
    messages: [],
    loadingRoom: false,
    error: '',
    reportFor: null,       // message id with the report form open
    sending: false
  };

  /** Read a server-sent event stream opened with fetch (keeps the token out of the URL). */
  async function readEvents(path, ctl, onEvent) {
    ctl.abort = new AbortController();
    const response = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: ctl.abort.signal
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(payload.message || `Unavailable (${response.status})`);
      error.fatal = response.status >= 400 && response.status < 500;
      throw error;
    }
    ctl.connected = true;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (event && data) {
          try { onEvent(event, JSON.parse(data)); } catch (error) { console.error('chat event', event, error); }
        }
      }
    }
  }

  function startChat() {
    if (ch.active) return;
    ch.active = true;
    ch.error = '';
    (async () => {
      while (ch.active) {
        try {
          await readEvents('/chat/stream', ch, onChatEvent);
        } catch (error) {
          if (!ch.active) return;
          if (error.fatal) {
            ch.active = false;
            ch.connected = false;
            return setState({ error: error.message });
          }
        }
        ch.connected = false;
        if (!ch.active) return;
        ch.error = CH_UZ.lost;
        if (state.screen === 'speak') render();
        await new Promise(r => setTimeout(r, 2000));
      }
    })();
  }

  function stopChat() {
    ch.active = false;
    ch.connected = false;
    ch.abort?.abort();
    ch.reportFor = null;
  }

  function onChatEvent(event, data) {
    switch (event) {
      case 'hello':
        ch.me = data.you;
        ch.rooms = data.rooms || [];
        ch.error = '';
        // The server forgets which room we were in when the stream drops,
        // so (re)open it — this also reloads anything missed meanwhile.
        openChatRoom(ch.room);
        break;
      case 'rooms':
        ch.rooms = data.rooms || [];
        // Only the online counts changed: update them in place, so a busy
        // lobby does not redraw the page under someone who is typing.
        if (patchRoomCounts()) return;
        break;
      case 'message':
        if (data.room !== ch.room || ch.messages.some(m => m.id === data.id)) return;
        ch.messages.push(data);
        if (ch.messages.length > 200) ch.messages.splice(0, ch.messages.length - 200);
        break;
      case 'deleted':
        ch.messages = ch.messages.map(m => (m.id === data.id ? { ...m, text: '', deleted: true } : m));
        break;
      case 'kicked':
        stopChat();
        state.error = data.reason || CH_UZ.kicked;
        break;
    }
    if (state.screen === 'speak' && ch.tab === 'chat' && !vc.room) render();
  }

  function patchRoomCounts() {
    if (state.screen !== 'speak' || ch.tab !== 'chat') return true;
    let all = true;
    for (const r of ch.rooms) {
      const el = document.getElementById(`ch-count-${r.id}`);
      if (el) el.textContent = r.online || 0;
      else all = false;
    }
    return all;
  }

  async function openChatRoom(room) {
    ch.room = room;
    ch.loadingRoom = true;
    ch.reportFor = null;
    if (state.screen === 'speak') render();
    try {
      const data = await api('/chat/join', { method: 'POST', body: { room } });
      if (ch.room !== room) return;
      ch.messages = data.messages || [];
      ch.error = '';
    } catch (error) {
      ch.error = error.message;
    }
    ch.loadingRoom = false;
    if (state.screen === 'speak') render();
    scrollChatToEnd();
  }

  function scrollChatToEnd() {
    root.querySelectorAll('.ch-list').forEach(list => { list.scrollTop = list.scrollHeight; });
  }

  const clock = at => {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  /** One message. `where` is 'room' or 'call' — both can be reported. */
  function messageMarkup(m, where) {
    const mine = m.user === (where === 'call' ? vc.me : ch.me);
    const body = m.deleted
      ? `<span class="ch-deleted">${CH_UZ.deleted}</span>`
      : esc(m.text);
    const reportForm = ch.reportFor === m.id
      ? `<div class="ch-report">
           <input type="text" id="ch-report-why" data-keep maxlength="300" placeholder="${esc(CH_UZ.reportWhy)}">
           <button class="btn btn-sm" data-ch-report-send="${esc(m.id)}">${CH_UZ.reportSend}</button>
           <button class="btn btn-ghost btn-sm" data-ch-report-close>${CH_UZ.cancel}</button>
         </div>`
      : '';
    return `<div class="ch-row ${mine ? 'is-mine' : ''}">
      ${mine ? '' : `<span class="ch-av${premiumClass(m)}">${picInner(m)}</span>`}
      <div class="ch-msg ${mine ? 'is-mine' : ''}${m.premium ? ' is-premium' : ''}" data-msg="${esc(m.id)}">
      <div class="ch-meta">
        <span class="ch-name">${nameMarkup(m)}${mine ? ` <span class="lb-you">${CH_UZ.you}</span>` : ''}</span>
        ${m.level ? `<span class="ch-level">${esc(m.level)}</span>` : ''}
        <span class="ch-time">${esc(clock(m.at))}</span>
        ${!mine && !m.deleted ? `<button class="ch-flag" data-ch-report="${esc(m.id)}" title="${CH_UZ.report}" aria-label="${CH_UZ.report}">⚑</button>` : ''}
      </div>
      <div class="ch-text">${body}</div>
      ${reportForm}
      </div>
    </div>`;
  }

  function composerMarkup(id, where) {
    return `<form class="ch-compose" data-ch-compose="${where}" autocomplete="off">
      <input type="text" id="${id}" data-keep maxlength="500" placeholder="${esc(CH_UZ.placeholder)}" aria-label="${esc(CH_UZ.placeholder)}">
      <button class="btn" type="submit">${CH_UZ.send}</button>
    </form>`;
  }

  function chatScreen() {
    const rooms = (ch.rooms.length ? ch.rooms : [
      { id: 'text-general', name: 'General', online: 0 },
      { id: 'text-b1', name: 'B1 chat', level: 'B1', online: 0 },
      { id: 'text-b2', name: 'B2 chat', level: 'B2', online: 0 },
      { id: 'text-c1', name: 'C1 chat', level: 'C1', online: 0 }
    ]).map(r => `<button class="ch-room ${r.id === ch.room ? 'is-current' : ''}" data-ch-room="${esc(r.id)}" aria-pressed="${r.id === ch.room}">
        <span class="ch-room-name">${esc(r.name)}</span>
        <span class="ch-room-count"><span class="ch-dot"></span><span id="ch-count-${esc(r.id)}">${r.online || 0}</span></span>
      </button>`).join('');

    const current = ch.rooms.find(r => r.id === ch.room);
    const list = ch.loadingRoom && !ch.messages.length
      ? `<div class="center-note"><span class="spinner"></span></div>`
      : ch.messages.length
      ? ch.messages.map(m => messageMarkup(m, 'room')).join('')
      : `<p class="muted ch-empty">${CH_UZ.empty}</p>`;

    return `
      <div class="ch-layout">
        <div class="ch-rooms" role="group" aria-label="${CH_UZ.roomsTitle}">${rooms}</div>
        <div class="card ch-panel">
          <div class="ch-panel-head">
            <strong>${esc(current?.name || 'General')}</strong>
            <span class="muted" style="font-size:13px">${ch.connected ? esc(CH_UZ.online(current?.online || 0)) : CH_UZ.connecting}</span>
          </div>
          ${ch.error ? `<div class="alert alert-warn" style="margin:0">${esc(ch.error)}</div>` : ''}
          <div class="ch-list" id="ch-room-list" data-keep-scroll>${list}</div>
          ${composerMarkup('ch-room-input', 'room')}
          <p class="muted ch-rules">${CH_UZ.rules}</p>
        </div>
      </div>`;
  }

  async function sendChat(where, input) {
    const text = input.value.trim();
    if (!text || ch.sending) return;
    ch.sending = true;
    input.value = '';
    try {
      if (where === 'call') {
        const m = await api('/chat/call', { method: 'POST', body: { text } });
        if (!vc.chat.some(x => x.id === m.id)) vc.chat.push(m);
        vc.notice = '';
      } else {
        const m = await api('/chat/send', { method: 'POST', body: { room: ch.room, text } });
        if (m.room === ch.room && !ch.messages.some(x => x.id === m.id)) ch.messages.push(m);
        ch.error = '';
      }
    } catch (error) {
      // Give the text back so nothing typed is lost, and say why.
      const field = document.getElementById(input.id);
      if (field && !field.value) field.value = text;
      if (where === 'call') vc.notice = error.message; else ch.error = error.message;
    }
    ch.sending = false;
    if (state.screen === 'speak') {
      render();
      scrollChatToEnd();
      document.getElementById(input.id)?.focus();
    }
  }

  function wireChat() {
    root.querySelectorAll('[data-ch-tab]').forEach(el =>
      el.addEventListener('click', () => {
        if (el.dataset.chTab !== ch.tab) openVoice(el.dataset.chTab);
      }));
    root.querySelectorAll('[data-ch-room]').forEach(el =>
      el.addEventListener('click', () => {
        if (el.dataset.chRoom !== ch.room || !ch.messages.length) openChatRoom(el.dataset.chRoom);
      }));
    root.querySelectorAll('[data-ch-compose]').forEach(form =>
      form.addEventListener('submit', event => {
        event.preventDefault();
        sendChat(form.dataset.chCompose, form.querySelector('input'));
      }));
    root.querySelectorAll('[data-ch-report]').forEach(el =>
      el.addEventListener('click', () => {
        ch.reportFor = ch.reportFor === el.dataset.chReport ? null : el.dataset.chReport;
        render();
        document.getElementById('ch-report-why')?.focus();
      }));
    root.querySelectorAll('[data-ch-report-close]').forEach(el =>
      el.addEventListener('click', () => { ch.reportFor = null; render(); }));
    root.querySelectorAll('[data-ch-report-send]').forEach(el =>
      el.addEventListener('click', async () => {
        const reason = document.getElementById('ch-report-why')?.value || '';
        try {
          await api('/chat/report', { method: 'POST', body: { messageId: el.dataset.chReportSend, reason } });
          ch.reportFor = null;
          setState({ notice: CH_UZ.reportSent });
        } catch (error) {
          setState({ error: error.message });
        }
      }));
  }

  // ------------------------------------------------------------ rendering

  /**
   * Everything is redrawn from state, which would wipe a half-typed chat
   * message and jump the message list back to the top every time someone
   * else writes. Fields marked data-keep keep their text, cursor and focus;
   * lists marked data-keep-scroll keep their place, or stay at the bottom if
   * they were already there.
   */
  function render() {
    const kept = [...root.querySelectorAll('[data-keep][id]')].map(el => ({
      id: el.id,
      value: el.value,
      focused: document.activeElement === el,
      start: el.selectionStart,
      end: el.selectionEnd
    }));
    const scrolls = [...root.querySelectorAll('[data-keep-scroll][id]')].map(el => ({
      id: el.id,
      top: el.scrollTop,
      atEnd: el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }));

    root.innerHTML = screenMarkup();

    for (const k of kept) {
      const el = document.getElementById(k.id);
      if (!el) continue;
      if (!el.value) el.value = k.value;
      if (k.focused) {
        el.focus({ preventScroll: true });
        try { el.setSelectionRange(k.start, k.end); } catch { /* not a text field */ }
      }
    }
    for (const s of scrolls) {
      const el = document.getElementById(s.id);
      if (el) el.scrollTop = s.atEnd ? el.scrollHeight : s.top;
    }
    // A list drawn for the first time starts at the newest message.
    root.querySelectorAll('[data-keep-scroll][id]').forEach(el => {
      if (!scrolls.some(s => s.id === el.id)) el.scrollTop = el.scrollHeight;
    });

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
      : `${link('dashboard', 'Dashboard')}${link('speak', 'Speaking club')}${link('writing', 'Writing')}${link('results', 'My results')}`;

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
      result: resultScreen,
      writing: writingHomeScreen,
      'writing-exam': writingExamScreen,
      'writing-check': writingCheckScreen,
      'writing-result': writingResultScreen,
      speak: speakScreen
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
  /**
   * The details panel's own labels. The criterion names, band labels and
   * descriptors are NOT here — those come from the server, in the agency's
   * wording, so there is exactly one copy of them in the system.
   */
  const CRITERIA_UZ = {
    open: "Batafsil — mezonlar bo'yicha ballaringiz",
    close: 'Yopish',
    heading: 'Baholash mezonlari',
    intro:
      "Rasmiy imtihon mezonlari. Har biri 0 dan 6 gacha baholanadi; 4 ball — " +
      "daraja talabiga mos degani.",
    next: band => `${band} ball uchun nima kerak`,
    measured: "O'lchangan",
    azure: { accuracy: 'aniqlik', fluency: 'ravonlik', prosody: 'ohang' },
    // Bands 5 and 2 have no descriptor of their own — the sheet defines them as
    // the space between their neighbours, so the page shows the band above and
    // says so rather than printing "between 4 and 6" as if it were advice.
    between: (band, shown) =>
      `${band} ball — hozirgi darajangizdan yuqori, ${shown} ball xususiyatlari ko'rina boshlashi kerak:`,
    top: "Bu mezon bo'yicha eng yuqori ball."
  };

  /**
   * The correction panel's labels — in English, unlike everything else on this
   * screen. Only the teacher sees this block, and every other admin surface on
   * the site is already English; switching language mid-panel for an audience
   * of one would be worse than consistent.
   */
  const CORRECT_UZ = {
    heading: 'Your marking',
    intro:
      'Set the bands you would have given. This does not change the score the student sees — ' +
      'it becomes a worked example the marker is shown on every future attempt.',
    note: 'Why (optional — the marker reads this)',
    real: 'Confirmed by a real certificate',
    save: 'Save as calibration',
    savedAt: when => `Recorded ${when}.`
  };

  const ACCESS_UZ = {
    remaining: n => `Qolgan speaking mock: ${n}`,
    remainingNone: 'Mock qolmadi',
    free: "Birinchi mock — bepul",

    outTitle: 'Bu bo\'lim uchun mock qolmadi',
    outBody:
      "Har bir mock yozuvni matnga o'girish va tekshirish uchun haqiqiy pul talab qiladi, " +
      "shuning uchun birinchi bepul mockdan keyin ustoz ruxsat beradi.",

    packageLine: "Bitta paket: 4 ta speaking va 3 ta writing mock.",
    premiumLine: "Har bir paket bilan 30 kun Premium: toj belgisi, GIF avatar, oltin ism va xonalarda ustunlik.",
    premiumTitle: "Premium olish",
    premiumBody: "Premium paket bilan birga beriladi. To'lovdan keyin ustoz paketni qo'shadi va Premium darhol yoqiladi.",

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
    // Arrived from "Premium bo'ling", not from running out of mocks.
    const forPremium = state.topupReason === 'premium' && !blocked;
    state.topupReason = '';

    const contactBlock = contact
      ? `<a class="btn btn-lg" href="${esc(
          contact.startsWith('http') ? contact : `https://t.me/${contact.replace(/^@/, '')}`
        )}" target="_blank" rel="noopener noreferrer">${esc(contact)}</a>`
      : `<p class="muted">${ACCESS_UZ.noContact}</p>`;

    return `
      <div class="card form-card" style="max-width:560px">
        <h2 style="margin-bottom:8px">${blocked ? ACCESS_UZ.blockedTitle : forPremium ? ACCESS_UZ.premiumTitle : ACCESS_UZ.outTitle}</h2>
        <p class="muted">${blocked ? ACCESS_UZ.blockedBody : forPremium ? ACCESS_UZ.premiumBody : ACCESS_UZ.outBody}</p>
        ${blocked ? '' : `<p style="margin-top:10px;font-weight:600">${ACCESS_UZ.packageLine}</p>
          <p class="pr-topup">${CROWN} ${ACCESS_UZ.premiumLine}</p>`}

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

    const name = state.user?.firstName || '';

    // The balance sits next to the button that spends it. A student who finds
    // out they have none only after clicking Start has already been surprised.
    const remaining = state.access?.remaining;
    const counter = typeof remaining === 'number'
      ? `<p class="muted" style="margin-top:8px;text-align:center">${
          state.access?.blocked
            ? esc(ACCESS_UZ.blockedTitle)
            : remaining > 0 || state.access?.units > 0
            ? esc(ACCESS_UZ.remaining(state.access?.credits ?? remaining))
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

    const speakCard = `<div class="card secondary-card card-hover vc-dash">
      <div class="secondary-icon">${icon('users')}</div>
      <div class="grow">
        <div class="row" style="gap:10px"><h3>Speaking club</h3><span class="chip chip-speaking">Live</span></div>
        <p class="mock-sub">Boshqa o'quvchilar bilan jonli gaplashing — sherik toping yoki guruh xonasiga kiring.</p>
      </div>
      <div><button class="btn btn-ghost" data-go="speak">Kirish ${icon('right')}</button></div>
    </div>`;

    // Writing lives on its own screen with its own tests (content/writingTests.js),
    // so the card is always shown — it no longer depends on Exam documents.
    const writingCard = `<div class="card secondary-card card-hover">
      <div class="secondary-icon">${icon('pen')}</div>
      <div class="grow">
        <div class="row" style="gap:10px"><h3>Writing mock</h3><span class="chip chip-writing">Writing</span></div>
        <p class="mock-sub">Part 1.1, 1.2 va 2 — 60 daqiqa, rasmiy shkala bo'yicha tekshiriladi. Tayyor ishingizni ham tekshirtirishingiz mumkin.</p>
        <div class="meta-row">
          <span>${icon('clock')} 60 min</span>
          <span>${icon('pen')} Written</span>
          <span>${icon('check')} Evaluated</span>
        </div>
      </div>
      <div>
        <button class="btn btn-ghost" data-go="writing">Start writing ${icon('right')}</button>
        ${state.access?.writing?.credits != null
          ? `<p class="muted" style="margin-top:8px;text-align:center">${esc(WR_UZ.balance(state.access.writing.credits))}</p>`
          : ''}
      </div>
    </div>`;

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
      ${leaderboardCard()}
      <div class="section-head" style="margin-top:8px"><h2>Ready for your next test?</h2>
        <p>Practise the real CEFR format and see how you perform.</p></div>
      <div class="stack" style="margin-bottom:36px">
        ${speakingCard}
        ${speakCard}
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
           <span class="label" title="Har bir qism — mockning ¼ qismi">Practise (¼ mock):</span>
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


  /**
   * The official criteria, behind a "Batafsil" toggle.
   *
   * Collapsed by default because the score and the level are what a candidate
   * came for — this is the same order the certificate puts them in. Open, it is
   * the only place a student can see the exam's actual marking criteria applied
   * to their own words.
   *
   * Every sentence here is the agency's, sent by the server from the same file
   * the marker read. Nothing is paraphrased on the way to the screen: a student
   * comparing this against the official sheet has to find the same wording.
   */
  function criteriaCard() {
    const criteria = state.result?.criteria || [];
    // Attempts marked before criterion bands existed have none. Showing an
    // empty panel would promise detail that is not there.
    if (!criteria.length) return '';

    if (!state.criteriaOpen) {
      return `<div class="card">
        <button class="btn btn-ghost btn-block" data-action="criteria-open">
          ${CRITERIA_UZ.open}
        </button>
      </div>`;
    }

    const rows = criteria.map(c => `
      <div style="padding:16px 0;border-bottom:1px solid var(--line)">
        <div class="row" style="justify-content:space-between;align-items:baseline;gap:12px">
          <strong>${esc(c.name)}</strong>
          <span><strong style="font-size:20px">${c.band}</strong><span class="muted"> / ${c.max}</span></span>
        </div>
        <div class="muted" style="font-size:13px;margin-top:2px">${esc(c.label)}</div>
        ${c.descriptor
          ? `<p style="margin-top:10px">${esc(c.descriptor)}</p>`
          : ''}
        ${c.key === 'fluencyCoherence' && state.result?.fluency
          // The recording behind the band: what a listener heard that the
          // transcript cannot show. Pauses and fillers are things a student
          // can hear in their own recording and work on.
          ? `<div class="muted" style="font-size:13px;margin-top:8px">
               ${esc(FLUENCY_UZ.summary(state.result.fluency))}
             </div>`
          : ''}
        ${c.key === 'pronunciation' && state.result?.pronunciation?.assessed
          // The measurement behind the band, shown where the band is. This is
          // the one criterion with an instrument rather than an opinion behind
          // it, and a teacher checking whether the marker respected the
          // measurement should not have to go hunting for it.
          ? `<div class="muted" style="font-size:13px;margin-top:8px">
               ${CRITERIA_UZ.measured}:
               ${['accuracy', 'fluency', 'prosody']
                 .filter(k => Number.isFinite(Number(state.result.pronunciation[k])))
                 .map(k => `${CRITERIA_UZ.azure[k]} ${Math.round(state.result.pronunciation[k])}`)
                 .join(' · ')} / 100
             </div>`
          : ''}
        ${c.next
          // The actionable half. A band number says where a student is; this
          // says what the next one asks of them, in the words the examiner
          // will be reading when they sit the real exam.
          ? `<div style="margin-top:12px;padding:12px 14px;border-radius:10px;background:var(--ground)">
               <div class="section-title">${esc(CRITERIA_UZ.next(c.next.band))}</div>
               ${c.next.between
                 ? `<p class="muted" style="margin-top:6px;font-size:13px">${esc(CRITERIA_UZ.between(c.next.band, c.next.describes))}</p>`
                 : ''}
               <p style="margin-top:6px">${esc(c.next.descriptor)}</p>
             </div>`
          : `<p class="muted" style="margin-top:12px">${esc(CRITERIA_UZ.top)}</p>`}
      </div>`).join('');

    return `<div class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="font-size:18px">${CRITERIA_UZ.heading}</h2>
        <button class="btn btn-ghost btn-sm" data-action="criteria-close">${CRITERIA_UZ.close}</button>
      </div>
      <p class="muted" style="margin-top:6px">${CRITERIA_UZ.intro}</p>
      <div style="margin-top:8px">${rows}</div>
      ${correctionForm(criteria)}
    </div>`;
  }

  /**
   * The teacher's correction, on the result itself.
   *
   * Only an admin sees it, and it sits here rather than in the admin panel on
   * purpose: the moment a teacher disagrees with a mark is the moment they are
   * looking at it. A correction that requires navigating somewhere else is a
   * correction that does not get made.
   *
   * It does not change the student's score. It teaches the marker, and the
   * next attempt marked anywhere on the site is marked against it.
   */
  function correctionForm(criteria) {
    if (state.user?.role !== 'admin') return '';

    const saved = state.result?.teacherBands;

    const fields = criteria.map(c => `
      <label style="display:flex;flex-direction:column;gap:4px">
        <span class="muted" style="font-size:12px">${esc(c.name)}</span>
        <input type="number" min="0" max="6" style="width:68px"
               data-band="${esc(c.key)}"
               value="${saved?.[c.key] ?? c.band}" />
      </label>`).join('');

    return `<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line)">
      <strong style="font-size:14px">${CORRECT_UZ.heading}</strong>
      <p class="muted" style="margin-top:4px;font-size:13px">${CORRECT_UZ.intro}</p>

      <div class="row" style="gap:12px;flex-wrap:wrap;margin-top:12px;align-items:flex-end">
        ${fields}
      </div>

      <div class="row" style="gap:12px;margin-top:12px;flex-wrap:wrap;align-items:flex-end">
        <label style="display:flex;flex-direction:column;gap:4px;flex:1;min-width:220px">
          <span class="muted" style="font-size:12px">${CORRECT_UZ.note}</span>
          <input type="text" id="band-note" value="${esc(saved?.note || '')}" />
        </label>
        <label style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="band-real" ${saved?.source === 'real-exam' ? 'checked' : ''} />
          <span style="font-size:13px">${CORRECT_UZ.real}</span>
        </label>
        <button class="btn btn-sm" data-action="bands-save" ${state.loading ? 'disabled' : ''}>
          ${state.loading ? '…' : CORRECT_UZ.save}
        </button>
      </div>

      ${saved?.correctedAt
        ? `<p class="muted" style="margin-top:10px;font-size:13px">${esc(CORRECT_UZ.savedAt(fmtDate(saved.correctedAt)))}</p>`
        : ''}
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

      ${criteriaCard()}

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
                  ${value?.score === null && value?.measured
                    // Measured facts with no score (fluency): the pauses and
                    // fillers are the finding, and a bar would invent a number.
                    ? ''
                    : `<span class="criterion-score">${value?.score ?? 0} / ${MAX_SCORE}</span>`}
                </div>
                ${value?.score === null && value?.measured
                  ? ''
                  : `<div class="bar-track"><div class="bar-fill${value?.measured ? ' measured' : ''}" style="width:${pctOfMax(value?.score)}%"></div></div>`}
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
        // Leaving a writing mock mid-way keeps what was typed: the clock keeps
        // running on the server and the student can come back to it.
        if (state.screen === 'writing-exam') saveWritingNow();
        if (target === 'dashboard') loadDashboard();
        else if (target === 'writing') loadWritingHome();
        else if (target === 'speak') openVoice();
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

    wireWriting();
    wireLeaderboard();
    wireSpeak();
  }

  function handleAction(action) {
    switch (action) {
      case 'signout': return signOut();
      case 'done-submitting': return loadDashboard();
      case 'notice-seen': return dismissNotice();
      case 'bands-save': return saveBands();
      case 'criteria-open': return setState({ criteriaOpen: true });
      case 'criteria-close': return setState({ criteriaOpen: false });
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
    // Last words not yet autosaved: try once, and ask the browser to hold on.
    if (state.screen === 'writing-exam' && wr.dirty && !wr.submitting) {
      saveWritingNow();
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

        /*
         * ?result=<id> opens one attempt directly.
         *
         * This is how the review queue reaches a student's work: the admin
         * panel links here rather than rebuilding the result screen, so a
         * teacher reviewing someone else's attempt sees exactly what the
         * student sees — the same recordings, the same bands, the same
         * descriptors — with the correction panel underneath. Two renderings of
         * a result would eventually disagree, and the one the teacher marks
         * against has to be the one the student reads.
         *
         * The server decides who may open it; this only asks.
         */
        const requested = new URLSearchParams(window.location.search).get('result');
        if (requested) {
          openResult(requested);
          return;
        }

        // ?writing=<id> — the link in the marked-writing email.
        const writingId = new URLSearchParams(window.location.search).get('writing');
        if (writingId) {
          openWritingResult(writingId);
          return;
        }

        loadDashboard();
        return;
      } catch { signOut(); }
    }
    render();
  })();
})();
