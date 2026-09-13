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
    mode: 'mock',      // 'mock' (no skipping) or 'practice' (one part, retryable)
    part: null,        // practice only: which part
    resultId: null,
    taskIndex: 0,
    qIndex: 0,
    answered: {},      // taskNumber -> { transcription, hasAudio }
    result: null,      // completed result detail
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

  async function submitExam() {
    setState({ screen: 'evaluating', loading: true, error: '' });
    try {
      const summary = await api(`/exam/results/${state.resultId}/submit`, { method: 'POST' });
      resetRecorder();
      await openResult(summary.resultId || state.resultId);
    } catch (error) {
      setState({ screen: 'exam', loading: false, error: error.message });
    }
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
    return `<nav class="nav">
      ${brandMarkup()}
      <div class="nav-right">
        <span class="nav-user">${esc(state.user.firstName || state.user.email)}</span>
        ${state.user.role === 'admin' && canLeave()
          ? '<a class="btn btn-ghost btn-sm" href="/admin.html">Manage questions</a>'
          : ''}
        ${canLeave() ? '<button class="btn btn-ghost btn-sm" data-go="dashboard">Dashboard</button>' : ''}
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

  function dashboardScreen() {
    if (state.loading) return `<div class="center-note"><span class="spinner"></span><p style="margin-top:12px">Loading…</p></div>`;

    const s = state.stats || {};
    const stats = `
      <div class="grid grid-3">
        <div class="card stat"><div class="stat-label">Exams completed</div><div class="stat-value">${s.examsCompleted ?? 0}</div></div>
        <div class="card stat"><div class="stat-label">Average score</div><div class="stat-value">${s.averageScore ?? '—'}</div></div>
        <div class="card stat"><div class="stat-label">Current level</div><div class="stat-value">${esc(s.currentLevel || '—')}</div></div>
      </div>`;

    const exams = state.exams.length
      ? `<div class="grid grid-2">${state.exams.map(exam => `
          <div class="card exam-card">
            <div class="row" style="justify-content:space-between">
              <h3>${esc(exam.title)}</h3>
              <span class="badge">${esc(exam.module === 'writing' ? 'Writing' : 'Speaking')}</span>
            </div>
            <p class="muted">${esc(exam.description || '')}</p>
            <div class="exam-meta">
              <span>${exam.totalTasks} ${exam.module === 'writing' ? 'tasks' : 'questions'}</span>
              <span>~${Math.round((exam.duration || 0) / 60)} min</span>
            </div>
            <div class="row">
              <button class="btn btn-sm" data-start="${esc(exam.id)}" data-mode="mock">Full mock exam</button>
              ${(exam.parts || []).map(p =>
                `<button class="btn btn-ghost btn-sm" data-start="${esc(exam.id)}" data-mode="practice" data-part="${esc(p)}">Practise Part ${esc(p)}</button>`
              ).join('')}
            </div>
          </div>`).join('')}</div>`
      : `<div class="card"><p class="muted">No exams are published yet. An administrator can add them by running <code>npm run seed</code>.</p></div>`;

    const selected = state.selected || {};
    const selectedIds = state.history.filter(h => selected[h.id]).map(h => h.id);
    const allSelected = state.history.length > 0 && selectedIds.length === state.history.length;

    // The selection bar only appears once something is selected, so the normal
    // view of "my results" stays uncluttered for a student who just wants to read them.
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

    const history = state.history.length
      ? `${selectionBar}<div class="stack">${state.history.map(item => `
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
                ? `<span class="badge ${item.isPassed ? 'badge-pass' : 'badge-fail'}">${item.overallScore} · ${esc(item.overallLevel)}</span>
                   <button class="btn btn-ghost btn-sm" data-result="${esc(item.id)}">View</button>`
                : `<span class="badge">${esc(item.status.replace('_', ' '))}</span>`}
              ${state.confirmDelete === item.id
                // Deleting also destroys the recordings, so it takes a second,
                // deliberate click rather than a dialog that can be dismissed by reflex.
                ? `<span class="confirm-delete">
                     <span class="muted">Delete this attempt and its recordings?</span>
                     <button class="btn btn-danger btn-sm" data-delete-confirm="${esc(item.id)}">Yes, delete</button>
                     <button class="btn btn-ghost btn-sm" data-delete-cancel="1">Keep</button>
                   </span>`
                : `<button class="btn btn-ghost btn-sm btn-quiet" data-delete="${esc(item.id)}" title="Delete this attempt">Delete</button>`}
            </div>
          </div>`).join('')}</div>`
      : '';

    return `
      ${stats}
      <div><h2 style="margin:22px 0 4px">Available exams</h2><p class="muted" style="margin-bottom:14px">Pick the level you want to be assessed at.</p></div>
      ${exams}
      ${history ? `<div><h2 style="margin:26px 0 14px">Your history</h2></div>${history}` : ''}`;
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
            : SpeechRecognition ? '' : `<p class="muted" style="margin-top:12px">This browser has no speech recognition, so your audio will be transcribed on the server.</p>`}
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

  function evaluatingScreen() {
    return `<div class="center-note">
      <span class="spinner"></span>
      <h2 style="margin:16px 0 8px">Assessing your answers</h2>
      <p class="muted">Each task is being scored against the CEFR descriptors. This usually takes under a minute.</p>
    </div>`;
  }

  function resultScreen() {
    if (state.loading || !state.result) {
      return `<div class="center-note"><span class="spinner"></span><p style="margin-top:12px">Loading results…</p></div>`;
    }

    const r = state.result;
    const tasks = r.taskResults.filter(t => t.evaluation);

    return `
      <div class="card score-hero">
        <div class="muted">${esc(r.exam?.title || 'Exam')}</div>
        <div class="score-value">${r.overallScore ?? '—'}</div>
        <div class="score-level">${esc(r.overallLevel || '')}</div>
        <div style="margin-top:12px">
          <span class="badge ${r.isPassed ? 'badge-pass' : 'badge-fail'}">${r.isPassed ? 'Passed' : 'Not yet passed'}</span>
        </div>
      </div>

      ${tasks.map(task => {
        const e = task.evaluation;
        const criteria = e.criteria || {};
        return `
        <div class="card">
          <div class="row" style="justify-content:space-between">
            <h3>Task ${task.taskNumber}</h3>
            <span class="badge">${task.finalScore ?? 0}/100</span>
          </div>
          ${task.audioUrl ? `<audio controls data-authsrc="${esc(task.audioUrl)}"></audio>` : ''}
          ${task.transcription ? `<div style="margin-top:12px"><div class="section-title">What you said</div><div class="transcript" style="margin-top:6px">${esc(task.transcription)}</div></div>` : ''}
          ${e.overallFeedback ? `<p style="margin-top:14px">${esc(e.overallFeedback)}</p>` : ''}

          <div class="criteria">
            ${Object.entries(criteria).map(([name, value]) => `
              <div class="criterion">
                <div class="criterion-head">
                  <span class="criterion-name">${esc(name)}</span>
                  <span class="criterion-score">${value?.score ?? 0} / ${MAX_SCORE}</span>
                </div>
                <div class="bar-track"><div class="bar-fill" style="width:${pctOfMax(value?.score)}%"></div></div>
                ${value?.feedback ? `<p>${esc(value.feedback)}</p>` : ''}
              </div>`).join('')}
          </div>

          ${e.strengths?.length ? `<div style="margin-top:14px"><div class="section-title">Strengths</div><ul class="pill-list">${e.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
          ${e.areasForImprovement?.length ? `<div style="margin-top:12px"><div class="section-title">Work on next</div><ul class="pill-list">${e.areasForImprovement.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>` : ''}
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
