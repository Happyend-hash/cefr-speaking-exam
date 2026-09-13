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
      throw new Error(payload.message || `Request failed (${response.status})`);
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
        user: profile?.user || state.user,
        loading: false
      });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
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
        screen: 'exam',
        exam,
        questions,
        serverTranscription: Boolean(started.serverTranscription),
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

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const EVAL_POLL_MS = 4000;
  const EVAL_GIVE_UP_MS = 6 * 60 * 1000;

  /**
   * Submit an attempt and wait for the mark.
   *
   * The outcome is read by polling the attempt, NOT by awaiting the submit
   * request. Marking runs inside that request and can take a minute or more,
   * and on a phone a request that long is routinely suspended when the screen
   * locks or the browser backgrounds the tab — after which it may never settle,
   * neither resolving nor rejecting. Awaiting it was leaving the page on
   * "Assessing your answers" forever while the server had in fact finished and
   * saved the result.
   *
   * Polling also means a student can lock their phone, come back, and still get
   * their score.
   */
  async function submitExam() {
    const resultId = state.resultId;
    setState({ screen: 'evaluating', loading: true, error: '', evalStartedAt: Date.now() });
    resetRecorder();

    let submitError = null;
    api(`/exam/results/${resultId}/submit`, { method: 'POST' }).catch(err => { submitError = err; });

    const deadline = Date.now() + EVAL_GIVE_UP_MS;

    while (Date.now() < deadline) {
      await sleep(EVAL_POLL_MS);

      // The student navigated away or started something else — stop polling.
      if (state.screen !== 'evaluating' || state.resultId !== resultId) return;

      try {
        const result = await api(`/exam/results/${resultId}`);

        if (result.status === 'completed') {
          setState({ result, screen: 'result', loading: false, error: '' });
          return;
        }

        // Back to 'submitted' means marking ran and nothing could be marked.
        // Two very different reasons, and the student needs the right one.
        if (result.status === 'submitted') {
          const tasks = result.taskResults || [];
          const allUnread = tasks.length > 0 && tasks.every(t => t.status === 'not_transcribed');
          setState({
            screen: 'exam',
            loading: false,
            error: allUnread
              ? 'None of your answers could be turned into text, so nothing could be marked. ' +
                'Your recordings are saved. This is usually the browser — open the site ' +
                'directly in Chrome rather than inside a messaging app, then try again.'
              : submitError?.message ||
                'Marking did not finish. Your answers are saved — you can submit again.'
          });
          return;
        }
      } catch {
        // A failed poll is expected on a flaky connection; keep waiting.
      }

      // A real rejection from the API (not a dropped connection) is worth
      // showing immediately rather than waiting out the whole deadline.
      if (submitError && !/fetch|network|load failed|aborted/i.test(submitError.message)) {
        setState({ screen: 'exam', loading: false, error: submitError.message });
        return;
      }

      render(); // refresh the elapsed-time line
    }

    setState({
      screen: 'exam',
      loading: false,
      error: 'Marking is taking longer than usual. Your answers are saved — ' +
             'open this attempt from your history in a few minutes to see the result.'
    });
  }

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
      exam: examScreen,
      evaluating: evaluatingScreen,
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

  function recentCard() {
    const recent = completedAttempts().slice(0, 5);
    if (!recent.length) return '';

    return `<div class="card">
      <div class="section-head"><h2>Recent attempts</h2>
        <p>Tap any attempt to read its feedback.</p></div>
      ${recent.map(item => `
        <button class="attempt" data-result="${esc(item.id)}">
          <span class="attempt-name">${esc(item.examTitle)}</span>
          <span class="attempt-score">${item.overallScore}/${state.stats?.maxScore || MAX_SCORE}</span>
          <span class="chip chip-speaking">${esc(item.overallLevel || '—')}</span>
          <span class="attempt-date">${esc(fmtDate(item.completedAt))}</span>
        </button>`).join('')}
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

    const welcome = `<div class="welcome">
      <div>
        <h1>Welcome back${name ? `, ${esc(name)}` : ''} 👋</h1>
        <p>Ready to test your English speaking skills?</p>
      </div>
      <button class="btn btn-lg" data-folder="speaking">${icon('mic')} Start a speaking mock</button>
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

    const analytics = hasResults
      ? `${cefrCard(best)}
         <div class="split">${skillsCard()}${recentCard()}</div>`
      : firstMockEmptyState();

    return `
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
      return `<p class="muted" style="margin-top:12px">
        This browser has no speech recognition, so your audio will be transcribed on the server.
      </p>`;
    }
    return `<div class="alert alert-warn" style="margin-top:12px">
      <strong>This browser cannot turn speech into text</strong>
      <p style="margin-top:6px">Your recording will be saved, but there will be nothing for the
      examiner to read, so the answer cannot be marked. This is normal in the browser built into
      messaging apps. Open the site directly in Chrome before you start.</p>
    </div>`;
  }

  function evaluatingScreen() {
    const seconds = Math.round((Date.now() - (state.evalStartedAt || Date.now())) / 1000);
    return `<div class="center-note">
      <span class="spinner"></span>
      <h2 style="margin:16px 0 8px">Assessing your answers</h2>
      <p class="muted">Each answer is scored against the CEFR descriptors. A full mock takes a minute or two.</p>
      ${seconds > 5 ? `<p class="muted" style="margin-top:10px">Waiting… ${fmtTime(seconds)}</p>` : ''}
      ${seconds > 45
        // Reassurance that matters on a phone: the marking is happening on the
        // server, so leaving the page does not lose it.
        ? `<p class="muted" style="margin-top:10px;max-width:26rem">
             You can lock your phone or leave this page — the marking carries on,
             and the result will be in your history.
           </p>`
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
                  <span class="criterion-name">${esc(criterionLabel(name))}</span>
                  <span class="criterion-score">${value?.score ?? 0} / ${MAX_SCORE}</span>
                </div>
                <div class="bar-track"><div class="bar-fill" style="width:${pctOfMax(value?.score)}%"></div></div>
                ${value?.feedback ? `<p>${esc(value.feedback)}</p>` : ''}
              </div>`).join('')}
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
