/*
 * Question manager — admin only.
 *
 * A separate page from the student app on purpose: it keeps teaching tools out
 * of the exam client entirely, so a change here can never break a live sitting.
 * Buildless, same as the rest of the client.
 *
 * Access: sign up on the site normally, then run `npm run make-admin -- <email>`
 * once. There is deliberately no way to grant yourself admin from the browser.
 */

(() => {
  'use strict';

  const API = '/api';
  const root = document.getElementById('root');

  const SPEAKING_TYPES = [
    ['personal_question', 'Part 1.1 — short personal question'],
    ['extended_answer', 'Part 1.2 — longer answer on a topic'],
    ['picture_comparison', 'Part 2 — compare two pictures'],
    ['image_description', 'Part 2 — describe one picture'],
    ['opinion', 'Part 3 — opinion with follow-ups'],
    ['discussion', 'Discussion'],
    ['storytelling', 'Storytelling'],
    ['interview', 'Interview']
  ];

  const WRITING_TYPES = [
    ['writing_task1', 'Task 1 — describe visual information'],
    ['writing_task2', 'Task 2 — opinion essay']
  ];

  const state = {
    screen: 'login',
    token: null,
    user: null,
    tests: [],
    overview: null,
    openTestId: null,
    editingTask: null,   // taskNumber being edited
    addingTo: null,      // test id the add-form is open for
    loading: false,
    error: '',
    notice: ''
  };

  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
    remove: k => { try { localStorage.removeItem(k); } catch {} }
  };

  const esc = v => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let payload = {};
    try { payload = await res.json(); } catch {}

    if (res.status === 401) { signOut(); throw new Error('Session expired — sign in again.'); }
    if (res.status === 403) throw new Error('This account is not an admin. Run: npm run make-admin -- <your email>');
    if (!res.ok) throw new Error(payload.message || `Request failed (${res.status})`);
    return payload.data !== undefined ? payload.data : payload;
  }

  const setState = patch => { Object.assign(state, patch); render(); };

  function signOut() {
    store.remove('adminToken');
    Object.assign(state, { token: null, user: null, tests: [], screen: 'login' });
    render();
  }

  async function loadTests() {
    setState({ loading: true, error: '' });
    try {
      const [tests, overview] = await Promise.all([
        api('/admin/tests'),
        api('/admin/overview').catch(() => null)
      ]);
      setState({ tests, overview, loading: false, screen: 'tests' });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  // ----------------------------------------------------------------- screens

  function render() {
    root.innerHTML = state.screen === 'login' ? loginScreen() : mainScreen();
    wire();
  }

  const alerts = () =>
    (state.error ? `<div class="alert alert-error">${esc(state.error)}</div>` : '') +
    (state.notice ? `<div class="alert alert-ok">${esc(state.notice)}</div>` : '');

  function loginScreen() {
    return `
      <div class="admin-bar"><div class="brand">Question Manager</div></div>
      <main class="stack">
        ${alerts()}
        <div class="card form-card">
          <h2 style="margin-bottom:6px">Admin sign in</h2>
          <p class="muted" style="margin-bottom:18px">Use your normal account. It must have been made an admin.</p>
          <form id="login-form">
            <div class="field">
              <label for="email">Email</label>
              <input id="email" name="email" type="email" autocomplete="email" required />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" autocomplete="current-password" required />
            </div>
            <button class="btn btn-block" type="submit" ${state.loading ? 'disabled' : ''}>
              ${state.loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <p class="muted" style="margin-top:16px;text-align:center"><a href="/">Back to the exam site</a></p>
        </div>
      </main>`;
  }

  function mainScreen() {
    const o = state.overview;
    return `
      <div class="admin-bar">
        <div class="brand">Question Manager</div>
        <div class="row">
          <span class="muted">${esc(state.user?.email || '')}</span>
          <a class="btn btn-ghost btn-sm" href="/">Exam site</a>
          <button class="btn btn-ghost btn-sm" data-action="signout">Sign out</button>
        </div>
      </div>
      <main class="stack">
        ${alerts()}
        ${o ? `<div class="grid grid-3">
          <div class="card stat"><div class="stat-label">Students</div><div class="stat-value">${o.students}</div></div>
          <div class="card stat"><div class="stat-label">Published tests</div><div class="stat-value">${o.published}</div></div>
          <div class="card stat"><div class="stat-label">Attempts</div><div class="stat-value">${o.attempts}</div></div>
        </div>` : ''}

        <div class="row" style="justify-content:space-between;margin-top:8px">
          <h2>Tests</h2>
          <button class="btn btn-sm" data-action="new-test">+ New test</button>
        </div>

        ${state.screen === 'new-test' ? newTestForm() : ''}

        ${state.loading ? '<div class="center-note"><span class="spinner"></span></div>' : ''}
        ${state.tests.length === 0 && !state.loading
          ? '<div class="card"><p class="muted">No tests yet. Create one, then add questions to it.</p></div>'
          : state.tests.map(testCard).join('')}
      </main>`;
  }

  function newTestForm() {
    return `
      <div class="card">
        <h3 style="margin-bottom:14px">New test</h3>
        <form id="new-test-form" class="q-form">
          <div class="two">
            <div>
              <label for="nt-title">Title</label>
              <input id="nt-title" name="title" placeholder="Multilevel Speaking — Test 2" required />
            </div>
            <div>
              <label for="nt-module">Module</label>
              <select id="nt-module" name="module">
                <option value="speaking">Speaking</option>
                <option value="writing">Writing</option>
              </select>
            </div>
          </div>
          <div>
            <label for="nt-desc">Description (optional)</label>
            <input id="nt-desc" name="description" placeholder="Shown to students on the dashboard" />
          </div>
          <div class="row">
            <button class="btn btn-sm" type="submit">Create</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="cancel-new-test">Cancel</button>
          </div>
        </form>
      </div>`;
  }

  function testCard(test) {
    const open = state.openTestId === test.id;
    return `
      <div class="card">
        <div class="test-row">
          <div>
            <div class="q-meta">
              <span class="tag ${test.module === 'writing' ? 'tag-writing' : ''}">${esc(test.module)}</span>
              <span class="tag ${test.isPublished ? 'tag-live' : 'tag-draft'}">${test.isPublished ? 'published' : 'draft'}</span>
            </div>
            <h3>${esc(test.title)}</h3>
            <p class="muted">${test.totalTasks} question${test.totalTasks === 1 ? '' : 's'}${test.description ? ' · ' + esc(test.description) : ''}</p>
          </div>
          <div class="q-actions">
            <button class="btn btn-ghost btn-sm" data-toggle="${esc(test.id)}">${open ? 'Hide' : 'Questions'}</button>
            <button class="btn btn-ghost btn-sm" data-publish="${esc(test.id)}" data-value="${test.isPublished ? 'false' : 'true'}">
              ${test.isPublished ? 'Unpublish' : 'Publish'}
            </button>
            <button class="btn btn-ghost btn-sm" data-delete-test="${esc(test.id)}">Delete</button>
          </div>
        </div>

        ${open ? `
          <div style="margin-top:18px">
            ${test.tasks.length === 0
              ? '<p class="muted">No questions yet.</p>'
              : test.tasks.map(task => questionItem(test, task)).join('')}

            ${state.addingTo === test.id
              ? questionForm(test, null)
              : `<button class="btn btn-sm" data-add="${esc(test.id)}" style="margin-top:8px">+ Add question</button>`}
          </div>` : ''}
      </div>`;
  }

  function questionItem(test, task) {
    if (state.openTestId === test.id && state.editingTask === task.taskNumber) {
      return questionForm(test, task);
    }
    return `
      <div class="q-item">
        <div class="q-head">
          <div style="flex:1">
            <div class="q-meta">
              <span class="q-num">${task.taskNumber}</span>
              ${task.part ? `<span class="tag">Part ${esc(task.part)}</span>` : ''}
              <span class="muted">${esc(typeLabel(task.type))}</span>
              ${task.timeLimit ? `<span class="muted">· ${Math.round(task.timeLimit / 60)} min</span>` : ''}
              ${task.minWords ? `<span class="muted">· ${task.minWords}+ words</span>` : ''}
            </div>
            <div class="q-text">${esc(task.question)}</div>
            ${task.followUpQuestions?.length
              ? `<ul class="pill-list">${task.followUpQuestions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>`
              : ''}
          </div>
          <div class="q-actions">
            <button class="btn btn-ghost btn-sm" data-edit="${esc(test.id)}" data-task="${task.taskNumber}">Edit</button>
            <button class="btn btn-ghost btn-sm" data-delete-task="${esc(test.id)}" data-task="${task.taskNumber}">Delete</button>
          </div>
        </div>
      </div>`;
  }

  function questionForm(test, task) {
    const isEdit = Boolean(task);
    const types = test.module === 'writing' ? WRITING_TYPES : SPEAKING_TYPES;
    const t = task || {};
    return `
      <div class="q-item" style="border-color:var(--indigo-500)">
        <h4 style="margin-bottom:12px">${isEdit ? `Edit question ${task.taskNumber}` : 'New question'}</h4>
        <form class="q-form" data-form="${isEdit ? 'edit' : 'add'}" data-test="${esc(test.id)}" data-task="${t.taskNumber || ''}">
          <div class="two">
            <div>
              <label>Type</label>
              <select name="type">
                ${types.map(([value, label]) =>
                  `<option value="${value}" ${t.type === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label>Part label</label>
              <input name="part" value="${esc(t.part || '')}" placeholder="1.1, 2, 3, Task 1" />
            </div>
          </div>

          <div>
            <label>Question</label>
            <textarea name="question" required placeholder="What the student is asked">${esc(t.question || '')}</textarea>
          </div>

          <div>
            <label>Instructions (optional)</label>
            <input name="instructions" value="${esc(t.instructions || '')}" placeholder="Shown above the question" />
          </div>

          <div class="two">
            <div>
              <label>Time limit (seconds)</label>
              <input name="timeLimit" type="number" min="10" value="${t.timeLimit || (test.module === 'writing' ? 1200 : 120)}" />
            </div>
            <div>
              <label>${test.module === 'writing' ? 'Minimum words' : 'Image URLs (comma separated)'}</label>
              ${test.module === 'writing'
                ? `<input name="minWords" type="number" min="0" value="${t.minWords || ''}" placeholder="150" />`
                : `<input name="images" value="${esc((t.images || []).join(', '))}" placeholder="https://… , https://…" />`}
            </div>
          </div>

          <div>
            <label>Follow-up questions (one per line, optional)</label>
            <textarea name="followUpQuestions" placeholder="Used for Part 3 style tasks">${esc((t.followUpQuestions || []).join('\n'))}</textarea>
          </div>

          <div class="row">
            <button class="btn btn-sm" type="submit">${isEdit ? 'Save changes' : 'Add question'}</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="cancel-form">Cancel</button>
          </div>
        </form>
      </div>`;
  }

  const typeLabel = value =>
    [...SPEAKING_TYPES, ...WRITING_TYPES].find(([v]) => v === value)?.[1] || value;

  // ------------------------------------------------------------------ wiring

  function wire() {
    document.getElementById('login-form')?.addEventListener('submit', handleLogin);
    document.getElementById('new-test-form')?.addEventListener('submit', handleNewTest);

    root.querySelectorAll('[data-action]').forEach(el =>
      el.addEventListener('click', () => handleAction(el.dataset.action)));

    root.querySelectorAll('[data-toggle]').forEach(el =>
      el.addEventListener('click', () => setState({
        openTestId: state.openTestId === el.dataset.toggle ? null : el.dataset.toggle,
        editingTask: null, addingTo: null, error: '', notice: ''
      })));

    root.querySelectorAll('[data-add]').forEach(el =>
      el.addEventListener('click', () => setState({ addingTo: el.dataset.add, editingTask: null })));

    root.querySelectorAll('[data-edit]').forEach(el =>
      el.addEventListener('click', () => setState({
        editingTask: Number(el.dataset.task), addingTo: null
      })));

    root.querySelectorAll('[data-publish]').forEach(el =>
      el.addEventListener('click', () => togglePublish(el.dataset.publish, el.dataset.value === 'true')));

    root.querySelectorAll('[data-delete-task]').forEach(el =>
      el.addEventListener('click', () => deleteTask(el.dataset.deleteTask, Number(el.dataset.task))));

    root.querySelectorAll('[data-delete-test]').forEach(el =>
      el.addEventListener('click', () => deleteTest(el.dataset.deleteTest)));

    root.querySelectorAll('form[data-form]').forEach(form =>
      form.addEventListener('submit', event => handleQuestionSubmit(event, form)));
  }

  function handleAction(action) {
    if (action === 'signout') return signOut();
    if (action === 'new-test') return setState({ screen: 'new-test' });
    if (action === 'cancel-new-test') return setState({ screen: 'tests' });
    if (action === 'cancel-form') return setState({ editingTask: null, addingTo: null });
  }

  async function handleLogin(event) {
    event.preventDefault();
    const form = event.target;
    setState({ loading: true, error: '' });
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: { email: form.email.value.trim(), password: form.password.value }
      });
      if (data.user?.role !== 'admin') {
        throw new Error('That account is not an admin. Run: npm run make-admin -- ' + form.email.value.trim());
      }
      state.token = data.accessToken;
      state.user = data.user;
      store.set('adminToken', data.accessToken);
      state.loading = false;
      await loadTests();
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  async function handleNewTest(event) {
    event.preventDefault();
    const form = event.target;
    try {
      await api('/admin/tests', {
        method: 'POST',
        body: {
          title: form.title.value.trim(),
          module: form.module.value,
          description: form.description.value.trim()
        }
      });
      state.screen = 'tests';
      state.notice = 'Test created. Add questions, then publish it.';
      await loadTests();
    } catch (error) {
      setState({ error: error.message });
    }
  }

  async function handleQuestionSubmit(event, form) {
    event.preventDefault();
    const testId = form.dataset.test;
    const isEdit = form.dataset.form === 'edit';

    const body = {
      type: form.type.value,
      part: form.part.value.trim(),
      question: form.question.value.trim(),
      instructions: form.instructions.value.trim(),
      timeLimit: Number(form.timeLimit.value) || undefined,
      followUpQuestions: form.followUpQuestions.value.split('\n').map(s => s.trim()).filter(Boolean)
    };
    if (form.minWords) body.minWords = Number(form.minWords.value) || undefined;
    if (form.images) {
      body.images = form.images.value.split(',').map(s => s.trim()).filter(Boolean);
    }

    try {
      if (isEdit) {
        await api(`/admin/tests/${testId}/tasks/${form.dataset.task}`, { method: 'PATCH', body });
      } else {
        await api(`/admin/tests/${testId}/tasks`, { method: 'POST', body });
      }
      state.editingTask = null;
      state.addingTo = null;
      state.notice = isEdit ? 'Question updated.' : 'Question added.';
      await loadTests();
    } catch (error) {
      setState({ error: error.message });
    }
  }

  async function togglePublish(testId, isPublished) {
    try {
      await api(`/admin/tests/${testId}`, { method: 'PATCH', body: { isPublished } });
      state.notice = isPublished ? 'Published — students can see it now.' : 'Unpublished.';
      await loadTests();
    } catch (error) {
      setState({ error: error.message });
    }
  }

  async function deleteTask(testId, taskNumber) {
    if (!window.confirm(`Delete question ${taskNumber}? This cannot be undone.`)) return;
    try {
      await api(`/admin/tests/${testId}/tasks/${taskNumber}`, { method: 'DELETE' });
      state.notice = 'Question removed.';
      await loadTests();
    } catch (error) {
      setState({ error: error.message });
    }
  }

  async function deleteTest(testId) {
    const test = state.tests.find(t => t.id === testId);
    if (!window.confirm(`Delete "${test?.title}" and all its questions? This cannot be undone.`)) return;
    try {
      await api(`/admin/tests/${testId}`, { method: 'DELETE' });
      state.notice = 'Test deleted.';
      await loadTests();
    } catch (error) {
      // Refused because students have attempted it — offer unpublishing instead.
      setState({ error: error.message });
    }
  }

  // -------------------------------------------------------------------- boot

  (function boot() {
    const token = store.get('adminToken');
    if (token) {
      state.token = token;
      loadTests().catch(() => signOut());
      return;
    }
    render();
  })();
})();
