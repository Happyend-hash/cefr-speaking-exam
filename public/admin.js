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
    remark: null,
    students: null,          // { students, total, shown, contact } once loaded
    review: null,            // { results, uncorrected } once loaded
    reviewOpen: false,
    reviewOnly: 'uncorrected',
    studentsOpen: false,
    studentSearch: '',
    studentOnly: '',         // '', 'blocked' or 'out'
    calibration: null,       // { coverage, samples } once loaded
    calibrationOpen: false,
    addingSample: false,
    calibrationCheck: null,  // results of the last consistency check
    editingTask: null,   // taskNumber being edited (writing)
    addingTo: null,      // test id the add-form is open for (writing)
    addingSectionTo: null,
    editingSection: null,     // "testId:sectionIndex"
    addingQuestionTo: null,   // "testId:sectionIndex"
    editingQuestion: null,    // "testId:sectionIndex:qIndex"
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

  async function api(path, { method = 'GET', body, form } = {}) {
    const headers = {};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    // A FormData body sets its own Content-Type, including the multipart
    // boundary. Setting it here would overwrite that and the upload would
    // arrive unparseable.
    if (body) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: form ? form : body ? JSON.stringify(body) : undefined
    });
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

        ${reviewCard()}
        ${studentsCard()}
        ${voiceCard()}
        ${chatCard()}
        ${picturesCard()}
        ${sponsorsCard()}

        <div class="row" style="justify-content:space-between;margin-top:8px">
          <h2>Tests</h2>
          <button class="btn btn-sm" data-action="new-test">+ New test</button>
        </div>

        ${state.screen === 'new-test' ? newTestForm() : ''}

        ${state.loading ? '<div class="center-note"><span class="spinner"></span></div>' : ''}
        ${state.tests.length === 0 && !state.loading
          ? '<div class="card"><p class="muted">No tests yet. Create one, then add questions to it.</p></div>'
          : state.tests.map(testCard).join('')}

        ${calibrationCard()}
        ${remarkCard()}
        ${rescueCard()}
        ${purgeCard()}
      </main>`;
  }

  /**
   * The review queue.
   *
   * The marker is only as good as the standard behind it, and the standard only
   * reaches it if somebody listens to real students and disagrees on the
   * record. This is the door to that: every completed attempt, newest first,
   * opening into the same result screen a student sees — recordings,
   * transcripts, the marker's bands — with the correction panel underneath.
   *
   * It defaults to the unreviewed ones, because a queue that shows everything
   * shows no work to do.
   */
  function reviewCard() {
    if (!state.reviewOpen) {
      return `<div class="card" style="margin-top:28px">
        <h2 style="font-size:18px">Review attempts</h2>
        <p class="muted" style="margin-top:6px">
          Listen to what a student actually said, then record the bands you would have
          given. Your marking becomes the standard the examiner is held to on every
          attempt after it.
        </p>
        <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="review-open">
          Open review queue
        </button>
      </div>`;
    }

    const data = state.review;
    const filters = [
      ['uncorrected', 'Not yet reviewed'],
      ['corrected', 'Reviewed'],
      ['', 'All']
    ].map(([value, label]) => `
      <button class="btn btn-sm ${state.reviewOnly === value ? '' : 'btn-ghost'}"
              data-review-filter="${value}">${label}</button>`).join('');

    const rows = (data?.results || []).map(r => `
      <div class="row" style="justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);flex-wrap:wrap">
        <div style="min-width:220px">
          <strong>${esc(r.studentName || r.student)}</strong>
          ${r.corrected ? '<span class="tag tag-live">reviewed</span>' : ''}
          <div class="muted" style="font-size:13px">
            ${esc(r.exam)}${r.part ? ` · Part ${esc(r.part)}` : ''} · ${r.answers} answer${r.answers === 1 ? '' : 's'}
          </div>
        </div>
        <div class="muted" style="font-size:13px">
          ${r.at ? new Date(r.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''}
        </div>
        <div class="row" style="gap:10px;align-items:center">
          <span><strong>${r.score ?? '—'}</strong><span class="muted"> / 75</span></span>
          <span class="tag">${esc(r.level || '')}</span>
          <a class="btn btn-sm" href="/?result=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">
            Review
          </a>
        </div>
      </div>`).join('');

    return `<div class="card" style="margin-top:28px">
      <div class="row" style="justify-content:space-between">
        <h2 style="font-size:18px">Review attempts</h2>
        <button class="btn btn-ghost btn-sm" data-action="review-close">Close</button>
      </div>
      <p class="muted" style="margin-top:6px">
        ${data ? `${data.uncorrected} attempt${data.uncorrected === 1 ? '' : 's'} not yet reviewed.` : ''}
        Opening one shows the recordings and the marker's bands, with your own marking underneath.
      </p>
      <div class="row" style="gap:10px;margin-top:14px;flex-wrap:wrap">
        ${filters}
        <button class="btn btn-ghost btn-sm" data-action="review-reload" ${state.loading ? 'disabled' : ''}>
          ${state.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <div style="margin-top:12px">
        ${rows || '<p class="muted">Nothing here.</p>'}
      </div>
    </div>`;
  }

  /**
   * Students and their access.
   *
   * Every attempt spends the teacher's own money, so this table answers two
   * questions and nothing else: who is spending it, and does this person still
   * have permission to. Payment happens outside the app — the teacher decides
   * someone has paid and adds mocks here, which is the only part software can
   * honestly know.
   *
   * Blocking and the mock balance are shown as separate things because they are
   * separate: blocking is about the person and survives any balance; the balance
   * runs down on its own. A blocked student keeps the mocks they paid for.
   */
  function studentsCard() {
    if (!state.studentsOpen) {
      return `<div class="card" style="margin-top:28px">
        <h2 style="font-size:18px">Students</h2>
        <p class="muted" style="margin-top:6px">
          Who can take mocks, how many they have left, and who is stopped.
          Every attempt costs you money, so this is where you decide who spends it.
        </p>
        <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="students-open">
          Open students
        </button>
      </div>`;
    }

    const data = state.students;
    const rows = (data?.students || []).map(studentRow).join('');

    const filters = [
      ['', 'Everyone'],
      ['out', 'Out of mocks'],
      ['blocked', 'Blocked']
    ].map(([value, label]) => `
      <button class="btn btn-sm ${state.studentOnly === value ? '' : 'btn-ghost'}"
              data-student-filter="${value}">${label}</button>`).join('');

    return `<div class="card" style="margin-top:28px">
      <div class="row" style="justify-content:space-between">
        <h2 style="font-size:18px">Students</h2>
        <button class="btn btn-ghost btn-sm" data-action="students-close">Close</button>
      </div>

      <p class="muted" style="margin-top:6px">
        A new account gets one free speaking mock and one free writing mock. After that,
        when someone pays, press <strong>Add package</strong> (${packageLabel()}) — or add
        speaking or writing mocks by hand for special cases.
        Every package, and every mock you add, also gives <strong>30 days of Premium</strong> 👑
        (added to any days left); <strong>+30 days</strong> gives Premium on its own.
        ${data?.contact
          ? `Students are told to contact <strong>${esc(data.contact)}</strong>.`
          : `<strong>Students are not shown anywhere to pay yet.</strong> Set
             <code>TELEGRAM_CONTACT</code> in Railway to your Telegram username (for
             example <code>@username</code>) and they will see it on the top-up page.`}
      </p>

      <div class="row" style="gap:10px;margin-top:14px;flex-wrap:wrap">
        <input id="student-search" type="search" placeholder="Search name or email"
               value="${esc(state.studentSearch)}" style="flex:1;min-width:200px" />
        ${filters}
        <button class="btn btn-ghost btn-sm" data-action="students-reload" ${state.loading ? 'disabled' : ''}>
          ${state.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      ${state.studentSearch || state.studentOnly
        // Once a search finds the one student you were looking for, there was no
        // way back to the full list except clearing the box by hand and hoping
        // Enter still worked on an empty field. One button, always in the same
        // place, does what "back" means here.
        ? `<button class="btn btn-ghost btn-sm" style="margin-top:10px" data-action="students-clear">
             ← All students
           </button>`
        : ''}

      <div style="margin-top:16px">
        ${rows || '<p class="muted">No students match.</p>'}
      </div>

      ${data ? `<p class="muted" style="margin-top:12px;font-size:13px">
        Showing ${data.shown} of ${data.total}.
      </p>` : ''}

      <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--line)">
        <strong style="font-size:14px">Stop everyone at once</strong>
        <p class="muted" style="margin-top:4px;font-size:13px">
          For the day the link spreads further than you meant. It blocks every student
          account — not you, and not other teachers — and nobody loses the mocks they have.
          You then let people back in one at a time.
          <br><br>
          Worth knowing once: accounts that existed before access control was added still
          carry the old free allowance of 2 mocks, because nothing was ever counting.
          Blocking everyone is what stops those being spent; from then on a new account
          gets one free mock and the rest comes from you.
        </p>
        <div class="row" style="gap:10px;margin-top:10px">
          <button class="btn btn-sm" data-action="block-all" ${state.loading ? 'disabled' : ''}>Block every student</button>
          <button class="btn btn-ghost btn-sm" data-action="unblock-all" ${state.loading ? 'disabled' : ''}>Unblock everyone</button>
        </div>
      </div>
    </div>`;
  }

  // The standard package, as the server grants it (PACKAGE_SPEAKING /
  // PACKAGE_WRITING in Railway). Shown on the button so the teacher knows
  // what one click adds.
  const packageLabel = () => {
    const p = state.students?.package || { speaking: 4, writing: 3 };
    return `${p.speaking} speaking + ${p.writing} writing`;
  };

  const balance = (name, label, some) =>
    `<span style="font-weight:600;${some ? '' : 'color:var(--red)'}">${esc(name)} ${esc(label)}</span>`;

  function studentRow(s) {
    const tags =
      (s.blocked ? '<span class="tag tag-draft">blocked</span>' : '') +
      (s.role !== 'student' ? `<span class="tag">${esc(s.role)}</span>` : '') +
      (s.pendingMessage ? '<span class="tag tag-live">notice waiting</span>' : '') +
      (s.premiumUntil
        ? `<span class="tag" style="background:#fff6da;color:#a86400">👑 Premium to ${esc(new Date(s.premiumUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</span>`
        : '');

    const last = s.lastAttemptAt
      ? new Date(s.lastAttemptAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      : '—';

    return `<div style="padding:12px 0;border-bottom:1px solid var(--line)">
      <div class="row" style="justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="min-width:220px">
          <strong>${esc(s.name || s.email)}</strong> ${tags}
          <div class="muted" style="font-size:13px">${esc(s.email)}</div>
        </div>
        <div class="muted" style="font-size:13px">
          ${s.attempts} attempt${s.attempts === 1 ? '' : 's'} · last ${last}
        </div>
        <div class="row" style="gap:6px;align-items:center;flex-wrap:wrap">
          ${balance('Speaking', s.credits ?? String(s.remaining), s.remaining > 0 || s.partCredits > 0)}
          ${balance('Writing', s.writingCredits ?? String(s.writingRemaining ?? 0), s.writingRemaining > 0 || s.writingPartCredits > 0)}
          <button class="btn btn-sm" data-access="package" data-id="${esc(s.id)}"
                  title="Adds ${packageLabel()} on top of what is left">Add package (${packageLabel()})</button>
          <button class="btn btn-ghost btn-sm" data-access="${s.blocked ? 'unblock' : 'block'}"
                  data-id="${esc(s.id)}">${s.blocked ? 'Unblock' : 'Block'}</button>
        </div>
      </div>
      <div class="row" style="gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px;justify-content:flex-end">
        <span class="muted" style="font-size:13px">Or by hand:</span>
        <input id="amt-${esc(s.id)}" type="number" min="0" max="100" value="1"
               style="width:64px" aria-label="Number of mocks" />
        <select id="mod-${esc(s.id)}" aria-label="Which mocks">
          <option value="speaking">speaking</option>
          <option value="writing">writing</option>
        </select>
        <button class="btn btn-ghost btn-sm" data-access="grant" data-id="${esc(s.id)}">Add</button>
        <button class="btn btn-ghost btn-sm" data-access="reduce" data-id="${esc(s.id)}"
                title="Takes away up to this many — never goes below 0">Remove</button>
        <button class="btn btn-ghost btn-sm" data-access="set" data-id="${esc(s.id)}">Set to</button>
        <span class="muted" style="font-size:13px;margin-left:8px">Premium:</span>
        <button class="btn btn-ghost btn-sm" data-access="premium" data-id="${esc(s.id)}" title="30 more days of Premium, without adding mocks">+30 days</button>
        ${s.premiumUntil ? `<button class="btn btn-ghost btn-sm" data-access="premium-off" data-id="${esc(s.id)}">End</button>` : ''}
      </div>
    </div>`;
  }

  /**
   * The calibration library.
   *
   * Marked sample answers the examiner is shown while judging the same part, so
   * it compares against this teacher's standard rather than inventing a scale.
   * Without them the marker drifts toward the middle and a candidate who scores
   * 67 in the real exam is handed 52.
   *
   * The card leads with coverage rather than a list, because spread is what
   * teaches a scale: three samples at B1, B2 and C1 are worth more than ten all
   * sitting at C1, and a teacher can only collect what they can see is missing.
   */
  function calibrationCard() {
    const cal = state.calibration;

    if (!state.calibrationOpen) {
      return `<div class="card" style="margin-top:28px">
        <h2 style="font-size:18px">Calibration samples</h2>
        <p class="muted" style="margin-top:6px">
          Marked example answers that teach the examiner your standard. Without them
          it guesses the scale and marks low.
        </p>
        <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="calibration-open">
          Open calibration
        </button>
      </div>`;
    }

    const coverage = (cal?.coverage || []).map(c => `
      <div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)">
        <strong>Part ${esc(c.part)}</strong>
        <span class="muted">${c.total} sample${c.total === 1 ? '' : 's'}${
          c.levels.length ? ` · ${c.levels.join(', ')}` : ''
        }</span>
        ${c.missing.length
          ? `<span class="tag tag-draft">needs ${c.missing.join(', ')}</span>`
          : '<span class="tag tag-live">covered</span>'}
      </div>`).join('');

    const check = state.calibrationCheck;
    const checkBlock = check ? `
      <div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:var(--ground);border:1px solid var(--line)">
        <strong>${check.averageGap === null
          ? 'Nothing could be checked.'
          : `The examiner is ${check.averageGap > 0 ? 'above' : 'below'} your marks by ${Math.abs(check.averageGap)} on average.`}</strong>
        <p class="muted" style="margin-top:4px">
          Each sample was marked against the others, never itself.
        </p>
        <div style="margin-top:10px">
          ${(check.checked || []).map(c => `
            <div class="row" style="justify-content:space-between;font-size:13px;padding:4px 0">
              <span>Part ${esc(c.part)} · ${esc(c.level || '')}</span>
              ${c.error
                ? `<span class="muted">${esc(c.error)}</span>`
                : `<span>you ${c.teacherScore} · examiner ${c.examinerScore}
                     <strong style="color:${Math.abs(c.gap) <= 4 ? 'var(--green)' : 'var(--red)'}">
                       ${c.gap > 0 ? '+' : ''}${c.gap}</strong></span>`}
            </div>`).join('')}
        </div>
      </div>` : '';

    return `<div class="card" style="margin-top:28px">
      <div class="row" style="justify-content:space-between">
        <h2 style="font-size:18px">Calibration samples</h2>
        <button class="btn btn-ghost btn-sm" data-action="calibration-close">Close</button>
      </div>
      <p class="muted" style="margin-top:6px">
        Example answers with the mark you would give them. The examiner sees the samples
        for the part it is judging and matches your standard instead of guessing.
        Spread matters more than number — one at B1, B2 and C1 beats ten at C1.
      </p>

      <h3 style="font-size:15px;margin-top:18px">Coverage</h3>
      ${coverage || '<p class="muted">No samples yet.</p>'}

      <div class="row" style="gap:10px;margin-top:16px">
        <button class="btn btn-sm" data-action="sample-add">+ Add a sample</button>
        <button class="btn btn-ghost btn-sm" data-action="calibration-check" ${state.loading ? 'disabled' : ''}>
          ${state.loading ? 'Checking…' : 'Check calibration'}
        </button>
      </div>
      ${checkBlock}
      ${state.addingSample ? sampleForm() : ''}
      ${(cal?.samples || []).length ? `<h3 style="font-size:15px;margin-top:22px">Samples</h3>
        ${cal.samples.map(sampleRow).join('')}` : ''}
    </div>`;
  }

  function sampleForm() {
    return `<form id="sample-form" class="card" style="margin-top:16px;background:var(--ground)">
      <h3 style="font-size:15px;margin-bottom:12px">New sample</h3>

      <div class="row" style="gap:12px;flex-wrap:wrap;align-items:flex-end">
        <label style="display:flex;flex-direction:column;gap:4px">
          <span class="muted" style="font-size:13px">Part</span>
          <select name="part" required>
            <option value="1.1">1.1</option><option value="1.2">1.2</option>
            <option value="2">2</option><option value="3" selected>3</option>
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px">
          <span class="muted" style="font-size:13px">Level</span>
          <select name="level" required>
            <option>A2</option><option>B1</option><option selected>B2</option><option>C1</option>
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px">
          <span class="muted" style="font-size:13px">Score / 75</span>
          <input name="score" type="number" min="0" max="75" required style="width:90px" />
        </label>
        <label style="display:flex;flex-direction:column;gap:4px">
          <span class="muted" style="font-size:13px">Score is</span>
          <select name="scoreSource">
            <option value="teacher-estimate">my estimate</option>
            <option value="real-exam">a real exam result</option>
          </select>
        </label>
      </div>

      <label style="display:block;margin-top:12px">
        <span class="muted" style="font-size:13px">Question the answer responds to (optional)</span>
        <input name="question" placeholder="e.g. Some people believe technology isolates us…" />
      </label>

      <label style="display:block;margin-top:12px">
        <span class="muted" style="font-size:13px">Recording (optional — it will be transcribed for you)</span>
        <input name="audio" type="file" accept="audio/*" />
      </label>

      <label style="display:block;margin-top:12px">
        <span class="muted" style="font-size:13px">Or paste the transcript</span>
        <textarea name="transcription" rows="5" placeholder="Leave empty if you uploaded a recording."></textarea>
      </label>

      <label style="display:block;margin-top:12px">
        <span class="muted" style="font-size:13px">Why it earns this mark (optional, but it is what the examiner reads)</span>
        <input name="notes" placeholder="e.g. clear position, developed reasons, a few slips under pressure" />
      </label>

      <div class="row" style="gap:10px;margin-top:14px">
        <button class="btn btn-sm" type="submit" ${state.loading ? 'disabled' : ''}>
          ${state.loading ? 'Saving…' : 'Save sample'}
        </button>
        <button class="btn btn-ghost btn-sm" type="button" data-action="sample-cancel">Cancel</button>
      </div>
    </form>`;
  }

  function sampleRow(s) {
    return `<div class="card" style="margin-top:10px;${s.isActive ? '' : 'opacity:.55'}">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <strong>Part ${esc(s.part)} · ${esc(s.level)} · ${s.score}/75</strong>
          <span class="muted" style="font-size:13px">
            ${s.scoreSource === 'real-exam' ? ' — confirmed by the real exam' : ' — your estimate'}
            ${s.hasAudio ? ' · has recording' : ''}
          </span>
        </div>
        <div class="row" style="gap:8px">
          <button class="btn btn-ghost btn-sm" data-sample-toggle="${esc(s.id)}" data-active="${s.isActive}">
            ${s.isActive ? 'Deactivate' : 'Activate'}
          </button>
          <button class="btn btn-ghost btn-sm btn-quiet" data-sample-delete="${esc(s.id)}">Delete</button>
        </div>
      </div>
      ${s.question ? `<p class="muted" style="font-size:13px;margin-top:6px">Q: ${esc(s.question)}</p>` : ''}
      <p style="font-size:14px;margin-top:6px">${esc(s.transcription.slice(0, 400))}${s.transcription.length > 400 ? '…' : ''}</p>
      ${s.notes ? `<p class="muted" style="font-size:13px;margin-top:6px">Why: ${esc(s.notes)}</p>` : ''}
      ${s.audioUrl ? `<audio controls src="${esc(s.audioUrl)}" style="margin-top:8px;width:100%;max-width:420px"></audio>` : ''}
    </div>`;
  }

  /**
   * Marking existing attempts again with the current scoring.
   *
   * Not the same as the rescue below, and the difference matters: a rescue is
   * for recordings that were never transcribed, this is for attempts whose
   * transcripts were always fine but whose score came from marking that has
   * since changed. Nothing is re-transcribed and no audio is touched.
   *
   * Scoped to one account on purpose. A full attempt costs nine AI calls, so
   * re-marking a whole class to check one change spends a lot of quota to
   * answer a question a single attempt can answer — and the count is shown
   * before anything runs, because it is the teacher's bill.
   */
  function remarkCard() {
    const r = state.remark || {};

    return `<div class="card" style="margin-top:28px">
      <h2 style="font-size:18px">Mark attempts again</h2>
      <p class="muted" style="margin-top:6px">
        Runs completed attempts through the current marking. Use this after the scoring
        changes, to see the new result on work that has already been recorded. Pauses are
        measured from the saved recordings either way.
      </p>

      <div class="row" style="gap:12px;margin-top:14px;flex-wrap:wrap;align-items:flex-end">
        <label style="display:flex;flex-direction:column;gap:4px;flex:1 1 260px">
          <span class="muted" style="font-size:13px">Whose attempts (leave empty for your own)</span>
          <input id="remark-email" type="email" placeholder="student@example.com"
                 value="${esc(r.email || '')}" />
        </label>
        <button class="btn btn-ghost btn-sm" data-action="remark-check" ${r.checking ? 'disabled' : ''}>
          ${r.checking ? 'Checking…' : 'Check'}
        </button>
      </div>

      ${r.counted !== undefined ? (r.counted === 0
        ? '<p class="muted" style="margin-top:14px">No completed attempts found for that account.</p>'
        : `<div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:var(--indigo-50);border:1px solid var(--indigo-500)">
             <strong>${r.counted} attempt${r.counted === 1 ? '' : 's'}</strong> for ${esc(r.who)}
             — about ${r.aiCalls} AI calls.
             <p class="muted" style="margin-top:6px">
               Scores will change. The old ones are replaced, not kept.
             </p>
             <label style="display:flex;gap:8px;align-items:flex-start;margin-top:10px;font-size:14px">
               <input type="checkbox" id="remark-retranscribe" ${r.retranscribe === false ? '' : 'checked'} />
               <span>Also read the recordings again, so "umm", "eee" and "mmm" are counted.
                 <span class="muted">Needed for attempts recorded before fillers were kept.
                 Adds about 2 US cents of transcription per full mock.</span></span>
             </label>
             <button class="btn btn-sm" style="margin-top:10px"
                     data-action="remark-run" ${r.running ? 'disabled' : ''}>
               ${r.running ? 'Started…' : `Mark ${r.counted} attempt${r.counted === 1 ? '' : 's'} again`}
             </button>
           </div>`) : ''}
    </div>`;
  }

  async function checkRemark() {
    const email = document.getElementById('remark-email')?.value.trim() || '';
    setState({ remark: { email, checking: true }, error: '' });
    try {
      const query = email ? `?email=${encodeURIComponent(email)}` : '';
      const data = await api('/admin/results/remark' + query);
      setState({
        remark: { email, counted: data.attempts, aiCalls: data.aiCalls, who: data.email }
      });
    } catch (error) {
      setState({ remark: { email }, error: error.message });
    }
  }

  async function runRemark() {
    const r = state.remark || {};
    const retranscribe = document.getElementById('remark-retranscribe')?.checked !== false;
    setState({ remark: { ...r, retranscribe, running: true }, error: '' });
    try {
      const data = await api('/admin/results/remark', {
        method: 'POST',
        body: { email: r.email || undefined, retranscribe }
      });
      state.notice = `${data.started} attempt(s) are being marked again. Open the result in a few minutes to see the new score.`;
      setState({ remark: {} });
    } catch (error) {
      setState({ remark: { ...r, running: false }, error: error.message });
    }
  }

  /**
   * Recovering attempts nobody ever read.
   *
   * Students were handed zeros because their recordings arrived with no words:
   * most mobile browsers have no speech recognition, and at the time that was
   * the only transcriber. The audio was always fine. Server-side transcription
   * fixed the cause, and the recordings are still stored — so these attempts can
   * be turned into real scores rather than thrown away.
   *
   * Deliberately placed above the clear-attempts panel: given a zero, recovering
   * it is almost always the better answer, and the destructive option should not
   * be the first one a teacher meets.
   */
  function rescueCard() {
    const r = state.rescue || {};

    return `<div class="card" style="margin-top:28px">
      <h2 style="font-size:18px">Re-read unmarked recordings</h2>
      <p class="muted" style="margin-top:6px">
        Some attempts scored zero because the recording was never turned into text —
        older phones could not do it. That is fixed, and the recordings are still here,
        so those attempts can be read and marked properly instead of deleted.
      </p>

      <div class="row" style="gap:12px;margin-top:14px">
        <button class="btn btn-ghost btn-sm" data-action="rescue-check" ${r.checking ? 'disabled' : ''}>
          ${r.checking ? 'Checking…' : 'Check what can be recovered'}
        </button>
      </div>

      ${r.counted !== undefined ? (r.counted === 0
        ? '<p class="muted" style="margin-top:14px">Nothing to recover — every attempt with a recording has been read.</p>'
        : `<div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:var(--green-bg);border:1px solid var(--green)">
             <strong>${r.counted} attempt${r.counted === 1 ? '' : 's'}</strong>
             from ${r.students} student${r.students === 1 ? '' : 's'},
             holding ${r.answers} unread recording${r.answers === 1 ? '' : 's'}.
             <p class="muted" style="margin-top:6px">
               Nothing is deleted. Each attempt is read again and re-marked, and the
               score updates itself when it finishes.
             </p>
             <button class="btn btn-sm" style="margin-top:10px"
                     data-action="rescue-run" ${r.running ? 'disabled' : ''}>
               ${r.running ? 'Started…' : `Re-read these ${r.counted} attempts`}
             </button>
           </div>`) : ''}
    </div>`;
  }

  /**
   * Clearing old attempts.
   *
   * Attempts marked before the scale changed, and the zeros left when phones
   * captured no words, feed every student's best score and skills chart. This
   * removes them — and their recordings, permanently.
   *
   * Nothing is deleted until the teacher has been shown the exact count. The
   * button carries that number, and the server refuses the delete if the number
   * has moved since — a student finishing a mock between the check and the click
   * must not be swept up in it.
   */
  function purgeCard() {
    const p = state.purge || {};

    return `<div class="card" style="margin-top:28px;border-color:#fecaca">
      <h2 style="font-size:18px">Clear old attempts</h2>
      <p class="muted" style="margin-top:6px">
        Attempts marked before the 75-point scale, and ones that scored zero because
        no words were captured, still count towards students' averages and levels.
        Removing them also deletes their recordings, permanently.
      </p>

      <div class="row" style="gap:14px;margin-top:14px;flex-wrap:wrap;align-items:flex-end">
        <label style="display:flex;flex-direction:column;gap:4px">
          <span class="muted" style="font-size:13px">Completed before</span>
          <input type="date" id="purge-before" value="${esc(p.before || '')}" />
        </label>
        <label class="row" style="gap:6px">
          <input type="checkbox" id="purge-zeros" ${p.onlyZeros ? 'checked' : ''} />
          <span class="muted" style="font-size:13px">Only attempts that scored 0</span>
        </label>
        <button class="btn btn-ghost btn-sm" data-action="purge-check" ${p.checking ? 'disabled' : ''}>
          ${p.checking ? 'Checking…' : 'Check what matches'}
        </button>
      </div>

      ${p.counted !== undefined ? (p.counted === 0
        ? '<p class="muted" style="margin-top:14px">Nothing matches — there is nothing to clear.</p>'
        : `<div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:#fef2f2;border:1px solid #dc2626">
             <strong>${p.counted} attempt${p.counted === 1 ? '' : 's'}</strong>
             from ${p.students} student${p.students === 1 ? '' : 's'},
             including ${p.recordings} recording${p.recordings === 1 ? '' : 's'}.
             <p class="muted" style="margin-top:6px">This cannot be undone.</p>
             <button class="btn btn-danger btn-sm" style="margin-top:10px"
                     data-action="purge-run" ${p.running ? 'disabled' : ''}>
               ${p.running ? 'Deleting…' : `Delete these ${p.counted} attempts`}
             </button>
           </div>`) : ''}
    </div>`;
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
    const isWriting = test.module === 'writing';
    const count = isWriting ? test.totalTasks : (test.totalQuestions || 0);

    return `
      <div class="card">
        <div class="test-row">
          <div>
            <div class="q-meta">
              <span class="tag ${isWriting ? 'tag-writing' : ''}">${esc(test.module)}</span>
              <span class="tag ${test.isPublished ? 'tag-live' : 'tag-draft'}">${test.isPublished ? 'published' : 'draft'}</span>
            </div>
            <h3>${esc(test.title)}</h3>
            <p class="muted">${count} question${count === 1 ? '' : 's'}${test.description ? ' · ' + esc(test.description) : ''}</p>
          </div>
          <div class="q-actions">
            <button class="btn btn-ghost btn-sm" data-toggle="${esc(test.id)}">${open ? 'Hide' : 'Questions'}</button>
            <button class="btn btn-ghost btn-sm" data-publish="${esc(test.id)}" data-value="${test.isPublished ? 'false' : 'true'}">
              ${test.isPublished ? 'Unpublish' : 'Publish'}
            </button>
            <button class="btn btn-ghost btn-sm" data-delete-test="${esc(test.id)}">Delete</button>
          </div>
        </div>

        ${open ? (isWriting ? legacyTaskList(test) : sectionList(test)) : ''}
      </div>`;
  }

  /** Writing tests still use the flat task list. */
  function legacyTaskList(test) {
    return `<div style="margin-top:18px">
      ${test.tasks.length === 0 ? '<p class="muted">No tasks yet.</p>' : test.tasks.map(t => questionItem(test, t)).join('')}
      ${state.addingTo === test.id
        ? questionForm(test, null)
        : `<button class="btn btn-sm" data-add="${esc(test.id)}" style="margin-top:8px">+ Add task</button>`}
    </div>`;
  }

  // ---------------------------------------------------- speaking sections

  const PARTS = [
    ['1.1', 'Part 1.1 — three short personal questions (5s think / 30s answer)'],
    ['1.2', 'Part 1.2 — two pictures, then three questions (10s/45s then 5s/30s)'],
    ['2', 'Part 2 — topic with two follow-ups (60s think / 120s answer)'],
    ['3', 'Part 3 — topic with advantages and disadvantages (60s / 120s)']
  ];

  function sectionList(test) {
    return `<div style="margin-top:18px">
      ${(test.sections || []).map(section => sectionCard(test, section)).join('')}
      ${state.addingSectionTo === test.id
        ? sectionForm(test, null)
        : `<button class="btn btn-sm" data-add-section="${esc(test.id)}" style="margin-top:8px">+ Add a part</button>`}
    </div>`;
  }

  function sectionCard(test, section) {
    const editing = state.editingSection === `${test.id}:${section.index}`;
    if (editing) return sectionForm(test, section);

    return `
      <div class="q-item" style="background:var(--ground)">
        <div class="q-head">
          <div style="flex:1">
            <div class="q-meta">
              <span class="tag">Part ${esc(section.part)}</span>
              <span class="muted">${section.questions.length} question${section.questions.length === 1 ? '' : 's'}</span>
            </div>
            ${section.instructions ? `<p class="muted">${esc(section.instructions)}</p>` : ''}
            ${section.topic ? `<div class="q-text" style="margin-top:6px"><strong>Topic:</strong> ${esc(section.topic)}</div>` : ''}
            ${section.images.length ? `<div class="thumbs">${section.images.map(u => `<img src="${esc(u)}" alt="" />`).join('')}</div>` : ''}
            ${(section.pros.length || section.cons.length) ? `
              <div class="muted" style="margin-top:8px">
                ${section.pros.length ? `<div>+ ${section.pros.map(esc).join(' · ')}</div>` : ''}
                ${section.cons.length ? `<div>− ${section.cons.map(esc).join(' · ')}</div>` : ''}
              </div>` : ''}
          </div>
          <div class="q-actions">
            <button class="btn btn-ghost btn-sm" data-edit-section="${esc(test.id)}" data-index="${section.index}">Edit part</button>
            <button class="btn btn-ghost btn-sm" data-delete-section="${esc(test.id)}" data-index="${section.index}">Delete</button>
          </div>
        </div>

        <div style="margin-top:12px">
          ${section.questions.map((q, i) => `
            <div class="q-item" style="margin-bottom:8px">
              <div class="q-head">
                <div style="flex:1">
                  <div class="q-meta">
                    <span class="q-num">${i + 1}</span>
                    <span class="muted">${q.prepTime}s think · ${q.answerTime}s answer</span>
                  </div>
                  <div class="q-text">${esc(q.text)}</div>
                </div>
                <div class="q-actions">
                  <button class="btn btn-ghost btn-sm" data-edit-q="${esc(test.id)}" data-index="${section.index}" data-q="${i}">Edit</button>
                  <button class="btn btn-ghost btn-sm" data-delete-q="${esc(test.id)}" data-index="${section.index}" data-q="${i}">Delete</button>
                </div>
              </div>
              ${state.editingQuestion === `${test.id}:${section.index}:${i}` ? sectionQuestionForm(test, section, i, q) : ''}
            </div>`).join('')}

          ${state.addingQuestionTo === `${test.id}:${section.index}`
            ? sectionQuestionForm(test, section, null, null)
            : `<button class="btn btn-ghost btn-sm" data-add-q="${esc(test.id)}" data-index="${section.index}">+ Add question to Part ${esc(section.part)}</button>`}
        </div>
      </div>`;
  }

  function sectionForm(test, section) {
    const isEdit = Boolean(section);
    const sec = section || {};
    return `
      <div class="q-item" style="border-color:var(--indigo-500)">
        <h4 style="margin-bottom:12px">${isEdit ? `Edit Part ${esc(sec.part)}` : 'Add a part'}</h4>
        <form class="q-form" data-section-form="${isEdit ? 'edit' : 'add'}" data-test="${esc(test.id)}" data-index="${isEdit ? sec.index : ''}">
          <div>
            <label>Part</label>
            <select name="part" ${isEdit ? 'disabled' : ''}>
              ${PARTS.map(([v, label]) => `<option value="${v}" ${sec.part === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
            </select>
          </div>

          <div>
            <label>Instructions shown to the student (optional)</label>
            <input name="instructions" value="${esc(sec.instructions || '')}" placeholder="e.g. Look at the two pictures and answer the questions." />
          </div>

          <div>
            <label>Topic (Parts 2 and 3)</label>
            <textarea name="topic" placeholder="The topic the questions are about">${esc(sec.topic || '')}</textarea>
          </div>

          <div class="two">
            <div>
              <label>Advantages — one per line (Part 3)</label>
              <textarea name="pros">${esc((sec.pros || []).join('\n'))}</textarea>
            </div>
            <div>
              <label>Disadvantages — one per line (Part 3)</label>
              <textarea name="cons">${esc((sec.cons || []).join('\n'))}</textarea>
            </div>
          </div>

          <div>
            <label>Pictures (Part 1.2 — upload two)</label>
            <div class="thumbs" id="sec-thumbs">${(sec.images || []).map(u => `<img src="${esc(u)}" alt="" />`).join('')}</div>
            <input type="hidden" name="images" value="${esc((sec.images || []).join(','))}" />
            <input type="file" accept="image/*" multiple data-upload-images />
            <p class="hint">JPEG, PNG, WebP or GIF, up to 5MB each. Uploading replaces the list above.</p>
          </div>

          <div class="row">
            <button class="btn btn-sm" type="submit">${isEdit ? 'Save part' : 'Add part'}</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="cancel-form">Cancel</button>
          </div>
        </form>
      </div>`;
  }

  function sectionQuestionForm(test, section, qIndex, q) {
    const isEdit = q !== null && q !== undefined;
    const defaults = { '1.1': [5, 30], '1.2': [5, 30], '2': [60, 120], '3': [60, 120] }[section.part] || [5, 30];
    return `
      <div class="q-item" style="border-color:var(--indigo-500);margin-top:8px">
        <form class="q-form" data-q-form="${isEdit ? 'edit' : 'add'}" data-test="${esc(test.id)}" data-index="${section.index}" data-q="${isEdit ? qIndex : ''}">
          <div>
            <label>Question</label>
            <textarea name="text" required placeholder="What the student is asked">${esc(q?.text || '')}</textarea>
          </div>
          <div class="two">
            <div>
              <label>Think time (seconds)</label>
              <input name="prepTime" type="number" min="0" value="${q?.prepTime ?? defaults[0]}" />
            </div>
            <div>
              <label>Answer time (seconds)</label>
              <input name="answerTime" type="number" min="5" value="${q?.answerTime ?? defaults[1]}" />
            </div>
          </div>
          <div class="row">
            <button class="btn btn-sm" type="submit">${isEdit ? 'Save' : 'Add question'}</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="cancel-form">Cancel</button>
          </div>
        </form>
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
    wireVoiceAdmin();
    wireChatAdmin();
    wirePicturesAdmin();
    wireSponsorsAdmin();
    document.getElementById('login-form')?.addEventListener('submit', handleLogin);
    document.getElementById('new-test-form')?.addEventListener('submit', handleNewTest);
    document.getElementById('sample-form')?.addEventListener('submit', handleNewSample);

    root.querySelectorAll('[data-sample-toggle]').forEach(el =>
      el.addEventListener('click', () =>
        toggleSample(el.dataset.sampleToggle, el.dataset.active === 'true')));

    root.querySelectorAll('[data-sample-delete]').forEach(el =>
      el.addEventListener('click', () => deleteSample(el.dataset.sampleDelete)));

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

    // ---- sections ----
    root.querySelectorAll('[data-add-section]').forEach(el =>
      el.addEventListener('click', () => setState({
        addingSectionTo: el.dataset.addSection, editingSection: null, addingQuestionTo: null, editingQuestion: null
      })));

    root.querySelectorAll('[data-edit-section]').forEach(el =>
      el.addEventListener('click', () => setState({
        editingSection: `${el.dataset.editSection}:${el.dataset.index}`, addingSectionTo: null
      })));

    root.querySelectorAll('[data-delete-section]').forEach(el =>
      el.addEventListener('click', () => deleteSection(el.dataset.deleteSection, el.dataset.index)));

    root.querySelectorAll('[data-add-q]').forEach(el =>
      el.addEventListener('click', () => setState({
        addingQuestionTo: `${el.dataset.addQ}:${el.dataset.index}`, editingQuestion: null
      })));

    root.querySelectorAll('[data-edit-q]').forEach(el =>
      el.addEventListener('click', () => setState({
        editingQuestion: `${el.dataset.editQ}:${el.dataset.index}:${el.dataset.q}`, addingQuestionTo: null
      })));

    root.querySelectorAll('[data-delete-q]').forEach(el =>
      el.addEventListener('click', () => deleteSectionQuestion(el.dataset.deleteQ, el.dataset.index, el.dataset.q)));

    root.querySelectorAll('form[data-section-form]').forEach(form =>
      form.addEventListener('submit', event => handleSectionSubmit(event, form)));

    root.querySelectorAll('form[data-q-form]').forEach(form =>
      form.addEventListener('submit', event => handleSectionQuestionSubmit(event, form)));

    root.querySelectorAll('[data-upload-images]').forEach(el =>
      el.addEventListener('change', event => uploadImages(event.target)));

    // ---- students ----
    root.querySelectorAll('[data-access]').forEach(el =>
      el.addEventListener('click', () => changeAccess(el.dataset.id, el.dataset.access)));

    root.querySelectorAll('[data-review-filter]').forEach(el =>
      el.addEventListener('click', () => loadReview({ only: el.dataset.reviewFilter })));

    root.querySelectorAll('[data-student-filter]').forEach(el =>
      el.addEventListener('click', () => loadStudents({ only: el.dataset.studentFilter })));

    const search = document.getElementById('student-search');
    if (search) {
      // Searching re-renders the whole card, so the box would lose focus and the
      // caret on every keystroke if it queried as you type. It searches on Enter.
      search.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          loadStudents({ search: search.value });
        }
      });
    }
  }

  function handleAction(action) {
    if (action === 'signout') return signOut();
    if (action === 'new-test') return setState({ screen: 'new-test' });
    if (action === 'cancel-new-test') return setState({ screen: 'tests' });
    if (action === 'cancel-form') return setState({
      editingTask: null, addingTo: null,
      addingSectionTo: null, editingSection: null, addingQuestionTo: null, editingQuestion: null
    });
    if (action === 'purge-check') return checkPurge();
    if (action === 'purge-run') return runPurge();
    if (action === 'remark-check') return checkRemark();
    if (action === 'remark-run') return runRemark();
    if (action === 'rescue-check') return checkRescue();
    if (action === 'rescue-run') return runRescue();
    if (action === 'calibration-open') return openCalibration();
    if (action === 'calibration-close') return setState({ calibrationOpen: false, addingSample: false });
    if (action === 'calibration-check') return runCalibrationCheck();
    if (action === 'sample-add') return setState({ addingSample: true, error: '' });
    if (action === 'sample-cancel') return setState({ addingSample: false });
    if (action === 'review-open') return loadReview({ open: true });
    if (action === 'review-close') return setState({ reviewOpen: false });
    if (action === 'review-reload') return loadReview({});
    if (action === 'students-open') return loadStudents({ open: true });
    if (action === 'students-close') return setState({ studentsOpen: false });
    if (action === 'students-reload') return loadStudents({});
    if (action === 'students-clear') return loadStudents({ search: '', only: '' });
    if (action === 'voice-open') return loadVoice({ open: true });
    if (action === 'voice-close') return setState({ voiceOpen: false });
    if (action === 'voice-reload') return loadVoice({});
    if (action === 'chat-open') return loadChat({ open: true });
    if (action === 'chat-close') return setState({ chatOpen: false });
    if (action === 'chat-reload') return loadChat({});
    if (action === 'pictures-open') return loadPictures({ open: true });
    if (action === 'pictures-close') return setState({ picturesOpen: false });
    if (action === 'pictures-reload') return loadPictures({});
    if (action === 'sponsors-open') return loadSponsors({ open: true });
    if (action === 'sponsors-close') return setState({ sponsorsOpen: false });
    if (action === 'block-all') return changeAccessForAll('block');
    if (action === 'unblock-all') return changeAccessForAll('unblock');
  }

  // ------------------------------------------------------ speaking rooms

  /**
   * Speaking rooms, from the teacher's side: who is talking right now, the
   * sessions of the last week (reported ones first when filtered), the
   * recordings behind them, and the two actions a teacher needs — remove a
   * student from a call now, and delete a session.
   *
   * Recordings are fetched with the token and played from a blob: they sit
   * behind authentication and a plain <audio src> cannot send it.
   */
  function voiceCard() {
    if (!state.voiceOpen) {
      return `<div class="card" style="margin-top:28px">
        <h2 style="font-size:18px">Speaking rooms</h2>
        <p class="muted" style="margin-top:6px">
          Who is talking right now, reports from students, and call recordings
          (kept ${esc(state.voice?.retentionDays || 7)} days, then deleted automatically).
        </p>
        <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="voice-open">Open speaking rooms</button>
      </div>`;
    }

    const live = state.voice || {};
    const sessions = state.voiceSessions || [];
    const reportedCount = sessions.filter(s => s.reported).length;

    const liveRooms = (live.rooms || []).map(r => `
      <div style="padding:10px 0;border-bottom:1px solid var(--line)">
        <strong>${esc(r.name)}</strong> <span class="muted" style="font-size:13px">${esc(r.topic?.text || '')}</span>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:6px">
          ${r.members.map(m => `<span class="tag">${esc(m.name)}
            <button class="btn btn-ghost btn-sm" style="padding:0 6px;margin-left:4px" data-voice-kick="${esc(m.id)}" title="Remove from the call now">✕</button></span>`).join('')}
        </div>
      </div>`).join('');

    const sessionRows = sessions.map(s => `
      <div style="padding:12px 0;border-bottom:1px solid var(--line)">
        <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div>
            <strong>${esc(s.kind === 'pair' ? 'Partner' : s.roomName)}</strong>
            ${s.reported ? '<span class="tag tag-draft">reported</span>' : ''}
            <span class="muted" style="font-size:13px"> · ${new Date(s.startedAt).toLocaleString()}</span>
            <div class="muted" style="font-size:13px">${esc(s.participants.map(p => p.name).join(', ') || '—')}</div>
          </div>
          <div class="row" style="gap:6px">
            <button class="btn btn-ghost btn-sm" data-voice-toggle="${esc(s.id)}">${state.voiceShown === s.id ? 'Hide' : 'Details'}</button>
            <button class="btn btn-ghost btn-sm" data-voice-delete="${esc(s.id)}">Delete</button>
          </div>
        </div>
        ${state.voiceShown === s.id ? `<div style="margin-top:10px">
          ${s.topic ? `<p class="muted" style="font-size:13px">Topic: ${esc(s.topic)}</p>` : ''}
          ${s.reports.map(r => `<div class="alert alert-error" style="margin-top:8px">
              <strong>${esc(r.byName || 'A student')}</strong> reported <strong>${esc(r.againstName || 'someone')}</strong>:
              ${esc(r.reason)} <span class="muted">(${new Date(r.at).toLocaleString()})</span></div>`).join('')}
          ${s.recordings.length
            ? s.recordings.map(rec => `<div style="margin-top:8px">
                <div class="muted" style="font-size:13px">${esc(rec.name || 'Student')} — ${new Date(rec.at).toLocaleTimeString()}</div>
                <audio controls preload="none" data-voice-audio="${esc(rec.audioKey)}" style="width:100%"></audio>
              </div>`).join('')
            : '<p class="muted" style="margin-top:8px">No recordings for this session.</p>'}
        </div>` : ''}
      </div>`).join('');

    return `<div class="card" style="margin-top:28px">
      <div class="row" style="justify-content:space-between">
        <h2 style="font-size:18px">Speaking rooms</h2>
        <div class="row" style="gap:8px">
          <button class="btn btn-ghost btn-sm" data-action="voice-reload">Refresh</button>
          <button class="btn btn-ghost btn-sm" data-action="voice-close">Close</button>
        </div>
      </div>

      <p class="muted" style="margin-top:6px">
        ${live.online || 0} online · ${(live.waiting || []).length} waiting for a partner.
        ${live.relay ? '' : `<br><strong>No relay configured.</strong> Calls on mobile data may fail to connect.
          Add <code>TURN_URLS</code>, <code>TURN_USERNAME</code> and <code>TURN_CREDENTIAL</code> in Railway when you have a relay service.`}
      </p>

      <h3 style="font-size:15px;margin-top:16px">Talking now</h3>
      ${liveRooms || '<p class="muted" style="margin-top:6px">Nobody is in a room right now.</p>'}

      <div class="row" style="justify-content:space-between;margin-top:18px;gap:10px;flex-wrap:wrap">
        <h3 style="font-size:15px">Sessions (last ${esc(live.retentionDays || 7)} days)</h3>
        <div class="row" style="gap:6px">
          <button class="btn btn-sm ${state.voiceReported ? 'btn-ghost' : ''}" data-voice-filter="">All</button>
          <button class="btn btn-sm ${state.voiceReported ? '' : 'btn-ghost'}" data-voice-filter="1">Reported${reportedCount ? ` (${reportedCount})` : ''}</button>
        </div>
      </div>
      ${sessionRows || '<p class="muted" style="margin-top:6px">No sessions yet.</p>'}
    </div>`;
  }

  async function loadVoice({ open, reported } = {}) {
    const nextReported = reported === undefined ? state.voiceReported : reported;
    setState({ voiceOpen: open || state.voiceOpen, voiceReported: nextReported, loading: true, error: '' });
    try {
      const [live, sessions] = await Promise.all([
        api('/voice/admin/live'),
        api(`/voice/admin/sessions${nextReported ? '?reported=1' : ''}`)
      ]);
      setState({ voice: live, voiceSessions: sessions, loading: false });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  // ------------------------------------------------------------ sponsors

  /**
   * Sponsor banners sold to local businesses. Each shows on the screens
   * ticked, one banner per screen at a time (turns taken at random when
   * several are live), after the main content — never in a test, a call or
   * a result. Views and clicks are what to show the sponsor.
   */
  const PLACE_NAMES = { home: 'Home', tests: 'Tests', club: 'Club', rank: 'Ranking' };

  function sponsorsCard() {
    if (!state.sponsorsOpen) {
      return `<div class="card" style="margin-top:28px">
        <h2 style="font-size:18px">Sponsor banners</h2>
        <p class="muted" style="margin-top:6px">
          Banners you sell to local businesses: shown on Home, Tests, Club and Ranking, with view and click counts.
        </p>
        <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="sponsors-open">Open sponsor banners</button>
      </div>`;
    }
    const list = state.sponsors?.sponsors || [];
    const places = state.sponsors?.places || Object.keys(PLACE_NAMES);
    const rows = list.map(sp => {
      const ctr = sp.views ? ((sp.clicks / sp.views) * 100).toFixed(1) : '0.0';
      const ended = sp.endsAt && new Date(sp.endsAt) < new Date();
      return `<div style="padding:14px 0;border-bottom:1px solid var(--line);display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">
        ${sp.image ? `<img src="${esc(sp.image)}" alt="" style="width:240px;max-width:100%;aspect-ratio:16/5;object-fit:cover;border-radius:10px;border:1px solid var(--line)">` : ''}
        <div style="flex:1;min-width:220px;display:flex;flex-direction:column;gap:6px">
          <div><strong>${esc(sp.name)}</strong>
            ${sp.active && !ended ? '<span class="tag tag-live">live</span>' : `<span class="tag">${ended ? 'ended' : 'paused'}</span>`}</div>
          <a href="${esc(sp.link)}" target="_blank" rel="noopener noreferrer" style="font-size:13px;overflow-wrap:anywhere">${esc(sp.link)}</a>
          <div style="font-size:14px"><strong>${sp.views}</strong> views · <strong>${sp.clicks}</strong> clicks · ${ctr}% clicked
            ${sp.endsAt ? ` · <span class="muted">until ${esc(new Date(sp.endsAt).toLocaleDateString())}</span>` : ''}</div>
          <div class="row" style="gap:10px;flex-wrap:wrap;font-size:14px">
            ${places.map(pl => `<label style="display:inline-flex;gap:4px;align-items:center">
              <input type="checkbox" data-sp-place="${esc(sp.id)}" value="${esc(pl)}" ${sp.places.includes(pl) ? 'checked' : ''}> ${esc(PLACE_NAMES[pl] || pl)}</label>`).join('')}
          </div>
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" data-sp-toggle="${esc(sp.id)}" data-active="${sp.active ? '1' : ''}">${sp.active ? 'Pause' : 'Show again'}</button>
            <label class="btn btn-ghost btn-sm" style="cursor:pointer">Replace picture
              <input type="file" accept="image/gif,image/png,image/jpeg,image/webp" data-sp-image="${esc(sp.id)}" style="display:none"></label>
            <button class="btn btn-ghost btn-sm" data-sp-delete="${esc(sp.id)}" data-name="${esc(sp.name)}">Delete</button>
          </div>
        </div>
      </div>`;
    }).join('');

    return `<div class="card" style="margin-top:28px">
      <div class="row" style="justify-content:space-between">
        <h2 style="font-size:18px">Sponsor banners</h2>
        <button class="btn btn-ghost btn-sm" data-action="sponsors-close">Close</button>
      </div>
      <p class="muted" style="margin-top:6px">
        Picture <strong>1280 × 400 px</strong> (or 640 × 200), GIF, PNG, JPG or WEBP, up to 1 MB. Everyone sees banners, Premium students too.
        Several live banners on one screen take turns.
      </p>
      <form id="sponsor-form" style="display:grid;gap:10px;margin-top:14px;padding:14px;border:1px dashed var(--line);border-radius:12px">
        <strong>Add a banner</strong>
        <input name="name" placeholder="Sponsor name (e.g. the learning centre)" maxlength="80" required>
        <input name="link" placeholder="https://their-site.uz or t.me/their_channel" maxlength="500" required>
        <input name="image" type="file" accept="image/gif,image/png,image/jpeg,image/webp" required>
        <div class="row" style="gap:12px;flex-wrap:wrap;font-size:14px">
          ${places.map(pl => `<label style="display:inline-flex;gap:4px;align-items:center"><input type="checkbox" name="places" value="${esc(pl)}" checked> ${esc(PLACE_NAMES[pl] || pl)}</label>`).join('')}
        </div>
        <label style="font-size:14px">Show until (optional) <input type="date" name="endsAt"></label>
        <button class="btn btn-sm" type="submit" style="justify-self:start">Add banner</button>
      </form>
      ${rows || '<p class="muted" style="margin-top:12px">No banners yet.</p>'}
    </div>`;
  }

  async function loadSponsors({ open } = {}) {
    setState({ sponsorsOpen: open || state.sponsorsOpen, loading: true, error: '' });
    try {
      setState({ sponsors: await api('/admin/sponsors'), loading: false });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  function wireSponsorsAdmin() {
    const form = document.getElementById('sponsor-form');
    form?.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        await api('/admin/sponsors', { method: 'POST', form: new FormData(form) });
        state.notice = 'Banner added — it shows straight away.';
        loadSponsors({});
      } catch (error) { setState({ error: error.message }); }
    });
    const update = async (id, body) => {
      try { await api(`/admin/sponsors/${id}`, { method: 'PUT', body }); loadSponsors({}); }
      catch (error) { setState({ error: error.message }); }
    };
    root.querySelectorAll('[data-sp-toggle]').forEach(el =>
      el.addEventListener('click', () => update(el.dataset.spToggle, { active: !el.dataset.active })));
    root.querySelectorAll('[data-sp-place]').forEach(el =>
      el.addEventListener('change', () => {
        const id = el.dataset.spPlace;
        const places = [...root.querySelectorAll(`[data-sp-place="${id}"]`)].filter(c => c.checked).map(c => c.value);
        update(id, { places });
      }));
    root.querySelectorAll('[data-sp-image]').forEach(el =>
      el.addEventListener('change', async () => {
        const file = el.files?.[0];
        if (!file) return;
        const data = new FormData();
        data.append('image', file);
        try { await api(`/admin/sponsors/${el.dataset.spImage}/image`, { method: 'POST', form: data }); loadSponsors({}); }
        catch (error) { setState({ error: error.message }); }
      }));
    root.querySelectorAll('[data-sp-delete]').forEach(el =>
      el.addEventListener('click', async () => {
        if (!window.confirm(`Delete the banner "${el.dataset.name}"? Its view and click counts go with it.`)) return;
        try { await api(`/admin/sponsors/${el.dataset.spDelete}`, { method: 'DELETE' }); loadSponsors({}); }
        catch (error) { setState({ error: error.message }); }
      }));
  }

  // ------------------------------------------------------------ pictures

  /**
   * Every Premium picture, newest first. Pictures go live as soon as they are
   * uploaded, so this is where the teacher looks them over: Remove deletes
   * one; Remove + stop uploads also stops that student putting up another.
   */
  function picturesCard() {
    if (!state.picturesOpen) {
      return `<div class="card" style="margin-top:28px">
        <h2 style="font-size:18px">Student pictures</h2>
        <p class="muted" style="margin-top:6px">
          Premium students can put up a picture or animated GIF. They appear at once;
          look them over here and remove anything unsuitable.
        </p>
        <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="pictures-open">Open pictures</button>
      </div>`;
    }
    const data = state.pictures || { pictures: [], blocked: [] };
    const tiles = data.pictures.map(p => `
      <div style="display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;padding:10px;border:1px solid var(--line);border-radius:12px">
        <img src="${esc(p.url)}" alt="" loading="lazy" style="width:88px;height:88px;border-radius:50%;object-fit:cover;background:var(--ground)">
        <strong style="font-size:14px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</strong>
        <span class="muted" style="font-size:12px;max-width:100%;overflow-wrap:anywhere">${esc(p.email)}</span>
        <span class="muted" style="font-size:12px">${p.at ? new Date(p.at).toLocaleDateString() : ''}${p.live ? '' : ' · hidden (Premium ended)'}</span>
        <div class="row" style="gap:4px;flex-wrap:wrap;justify-content:center">
          <button class="btn btn-ghost btn-sm" data-pic-remove="${esc(p.id)}">Remove</button>
          <button class="btn btn-ghost btn-sm" data-pic-block="${esc(p.id)}" title="Remove and stop this student uploading another">Remove + stop</button>
        </div>
      </div>`).join('');
    const blocked = data.blocked.length
      ? `<h3 style="font-size:15px;margin-top:18px">Stopped from uploading</h3>
         ${data.blocked.map(b => `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">
            <span>${esc(b.name)} <span class="muted" style="font-size:13px">${esc(b.email)}</span></span>
            <button class="btn btn-ghost btn-sm" data-pic-allow="${esc(b.id)}">Allow again</button></div>`).join('')}`
      : '';
    return `<div class="card" style="margin-top:28px">
      <div class="row" style="justify-content:space-between">
        <h2 style="font-size:18px">Student pictures</h2>
        <div class="row" style="gap:8px">
          <button class="btn btn-ghost btn-sm" data-action="pictures-reload">Refresh</button>
          <button class="btn btn-ghost btn-sm" data-action="pictures-close">Close</button>
        </div>
      </div>
      ${tiles
        ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-top:12px">${tiles}</div>`
        : '<p class="muted" style="margin-top:10px">No pictures yet.</p>'}
      ${blocked}
    </div>`;
  }

  async function loadPictures({ open } = {}) {
    setState({ picturesOpen: open || state.picturesOpen, loading: true, error: '' });
    try {
      setState({ pictures: await api('/admin/avatars'), loading: false });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  function wirePicturesAdmin() {
    const act = (selector, path, body, confirmText) =>
      root.querySelectorAll(selector).forEach(el =>
        el.addEventListener('click', async () => {
          const id = el.getAttribute(selector.slice(1, -1));
          if (confirmText && !window.confirm(confirmText)) return;
          try {
            await api(`/admin/avatars/${id}/${path}`, { method: 'POST', body });
            loadPictures({});
          } catch (error) { setState({ error: error.message }); }
        }));
    act('[data-pic-remove]', 'remove', { block: false });
    act('[data-pic-block]', 'remove', { block: true }, 'Remove this picture and stop this student uploading another?');
    act('[data-pic-allow]', 'allow', {});
  }

  // ---------------------------------------------------------------- chat

  /**
   * Text chat, from the teacher's side: the newest messages from every room
   * and from inside calls, with what the filter removed shown in full, who
   * wrote each one, and the reports. Delete takes a message off every screen
   * at once; Block stops the student using the site at all.
   */
  const CHAT_ROOM_NAMES = { 'text-general': 'General', 'text-b1': 'B1 chat', 'text-b2': 'B2 chat', 'text-c1': 'C1 chat' };
  const chatRoomName = room => CHAT_ROOM_NAMES[room] || (String(room).startsWith('voice:') ? 'In a call' : room);

  function chatCard() {
    if (!state.chatOpen) {
      return `<div class="card" style="margin-top:28px">
        <h2 style="font-size:18px">Text chat</h2>
        <p class="muted" style="margin-top:6px">
          Messages from the General, B1, B2 and C1 chat rooms and from inside speaking calls,
          with student reports (kept ${esc(state.chat?.retentionDays || 30)} days, then deleted automatically).
        </p>
        <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="chat-open">Open text chat</button>
      </div>`;
    }

    const data = state.chat || {};
    const messages = data.messages || [];
    const filterBtn = (value, label) =>
      `<button class="btn btn-sm ${state.chatFilter === value ? '' : 'btn-ghost'}" data-chat-filter="${esc(value)}">${label}</button>`;

    const rows = messages.map(m => `
      <div style="padding:10px 0;border-bottom:1px solid var(--line)${m.deleted ? ';opacity:.6' : ''}">
        <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
          <div style="min-width:0;flex:1">
            <strong>${esc(m.name)}</strong>
            <span class="muted" style="font-size:13px"> ${esc(m.email)} · ${esc(chatRoomName(m.room))} · ${new Date(m.at).toLocaleString()}</span>
            ${m.reported ? '<span class="tag tag-draft">reported</span>' : ''}
            ${m.filtered ? '<span class="tag" title="The filter changed this message before anyone saw it">filtered</span>' : ''}
            ${m.deleted ? `<span class="tag">deleted${m.deletedBy ? ` by ${esc(m.deletedBy)}` : ''}</span>` : ''}
            <div style="margin-top:4px;overflow-wrap:anywhere">${esc(m.text)}</div>
            ${m.original ? `<div class="muted" style="margin-top:2px;font-size:13px;overflow-wrap:anywhere">Before the filter: ${esc(m.original)}</div>` : ''}
            ${m.reports.map(r => `<div class="alert alert-error" style="margin-top:6px;padding:6px 10px">
              <strong>${esc(r.byName || 'A student')}</strong> reported this${r.reason ? `: ${esc(r.reason)}` : ''}
              <span class="muted">(${new Date(r.at).toLocaleString()})</span></div>`).join('')}
          </div>
          <div class="row" style="gap:6px">
            ${m.deleted ? '' : `<button class="btn btn-ghost btn-sm" data-chat-delete="${esc(m.id)}">Delete</button>`}
            <button class="btn btn-ghost btn-sm" data-chat-block="${esc(m.user)}" data-chat-name="${esc(m.name)}">Block</button>
          </div>
        </div>
      </div>`).join('');

    const reportedCount = messages.filter(m => m.reported).length;
    return `<div class="card" style="margin-top:28px">
      <div class="row" style="justify-content:space-between">
        <h2 style="font-size:18px">Text chat</h2>
        <div class="row" style="gap:8px">
          <button class="btn btn-ghost btn-sm" data-action="chat-reload">Refresh</button>
          <button class="btn btn-ghost btn-sm" data-action="chat-close">Close</button>
        </div>
      </div>
      <p class="muted" style="margin-top:6px">
        Links, phone numbers and swear words are removed before students see a message.
        Where the filter changed something, you also see what was typed. Newest first, up to 150.
      </p>
      <div class="row" style="gap:6px;margin-top:12px;flex-wrap:wrap">
        ${filterBtn('', 'All')}
        ${filterBtn('reported', `Reported${state.chatFilter === 'reported' && reportedCount ? ` (${reportedCount})` : ''}`)}
        ${Object.entries(CHAT_ROOM_NAMES).map(([id, name]) => filterBtn(id, name)).join('')}
      </div>
      ${rows || '<p class="muted" style="margin-top:10px">No messages.</p>'}
    </div>`;
  }

  async function loadChat({ open, filter } = {}) {
    const next = filter === undefined ? state.chatFilter || '' : filter;
    setState({ chatOpen: open || state.chatOpen, chatFilter: next, loading: true, error: '' });
    try {
      const query = next === 'reported' ? '?reported=1' : next ? `?room=${encodeURIComponent(next)}` : '';
      const chat = await api(`/chat/admin/messages${query}`);
      setState({ chat, loading: false });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  function wireChatAdmin() {
    root.querySelectorAll('[data-chat-filter]').forEach(el =>
      el.addEventListener('click', () => loadChat({ filter: el.dataset.chatFilter })));
    root.querySelectorAll('[data-chat-delete]').forEach(el =>
      el.addEventListener('click', async () => {
        try {
          await api(`/chat/admin/messages/${el.dataset.chatDelete}`, { method: 'DELETE' });
          loadChat({});
        } catch (error) { setState({ error: error.message }); }
      }));
    root.querySelectorAll('[data-chat-block]').forEach(el =>
      el.addEventListener('click', async () => {
        if (!window.confirm(`Block ${el.dataset.chatName}? They will be removed from chat and calls and cannot use the site until you unblock them in Students.`)) return;
        try {
          await api(`/admin/students/${el.dataset.chatBlock}/access`, { method: 'POST', body: { action: 'block' } });
          state.notice = `${el.dataset.chatName} blocked. Unblock them in Students.`;
          loadChat({});
        } catch (error) { setState({ error: error.message }); }
      }));
  }

  function wireVoiceAdmin() {
    root.querySelectorAll('[data-voice-filter]').forEach(el =>
      el.addEventListener('click', () => loadVoice({ reported: el.dataset.voiceFilter === '1' })));
    root.querySelectorAll('[data-voice-toggle]').forEach(el =>
      el.addEventListener('click', () =>
        setState({ voiceShown: state.voiceShown === el.dataset.voiceToggle ? null : el.dataset.voiceToggle })));
    root.querySelectorAll('[data-voice-kick]').forEach(el =>
      el.addEventListener('click', async () => {
        try {
          await api('/voice/admin/kick', { method: 'POST', body: { userId: el.dataset.voiceKick } });
          state.notice = 'Removed from the call. To stop them joining again, block them in Students.';
          loadVoice({});
        } catch (error) { setState({ error: error.message }); }
      }));
    root.querySelectorAll('[data-voice-delete]').forEach(el =>
      el.addEventListener('click', async () => {
        try {
          await api(`/voice/admin/sessions/${el.dataset.voiceDelete}`, { method: 'DELETE' });
          loadVoice({});
        } catch (error) { setState({ error: error.message }); }
      }));
    root.querySelectorAll('[data-voice-audio]').forEach(async el => {
      try {
        const res = await fetch(`${API}/voice/admin/recordings/${el.dataset.voiceAudio}`, {
          headers: { Authorization: `Bearer ${state.token}` }
        });
        if (!res.ok) throw new Error(String(res.status));
        el.src = URL.createObjectURL(await res.blob());
      } catch {
        el.replaceWith(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Recording unavailable.' }));
      }
    });
  }

  // --------------------------------------------------------------- review

  async function loadReview({ open, only } = {}) {
    const nextOnly = only === undefined ? state.reviewOnly : only;
    setState({ reviewOpen: open || state.reviewOpen, reviewOnly: nextOnly, loading: true, error: '' });
    try {
      const query = new URLSearchParams();
      if (nextOnly) query.set('only', nextOnly);
      const data = await api(`/admin/results?${query}`);
      setState({ review: data, loading: false });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  // ------------------------------------------------------------- students

  async function loadStudents({ open, search, only } = {}) {
    const nextSearch = search === undefined ? state.studentSearch : search;
    const nextOnly = only === undefined ? state.studentOnly : only;

    setState({
      studentsOpen: open || state.studentsOpen,
      studentSearch: nextSearch,
      studentOnly: nextOnly,
      loading: true,
      error: ''
    });

    try {
      const query = new URLSearchParams();
      if (nextSearch) query.set('search', nextSearch);
      if (nextOnly) query.set('only', nextOnly);
      // The "?" is always written, even with nothing after it. An empty query
      // string is harmless, and it keeps the path readable as a path — both to
      // a person and to scripts/check-api.js, which otherwise reads an appended
      // variable as part of the route and reports a route that exists as missing.
      const data = await api(`/admin/students?${query}`);
      setState({ students: data, loading: false });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  async function changeAccess(id, action) {
    const input = document.getElementById(`amt-${id}`);
    // For Premium the amount is days, not mocks.
    const amount = action === 'premium' ? 30 : Number(input?.value ?? 0);
    const module = document.getElementById(`mod-${id}`)?.value || 'speaking';

    if ((action === 'grant' || action === 'set' || action === 'reduce') && !Number.isInteger(amount)) {
      return setState({ error: 'Give a whole number of mocks.' });
    }

    setState({ loading: true, error: '', notice: '' });
    try {
      const data = await api(`/admin/students/${id}/access`, {
        method: 'POST',
        body: { action, amount, module }
      });

      // Reloads rather than patching the row in place: the attempt counts and
      // the "notice waiting" tag come from the server, and a half-updated table
      // is worse than a second of loading.
      await loadStudents({});
      setState({
        notice: action === 'premium' || action === 'premium-off'
          ? data.premiumUntil
            ? `${data.email}: Premium until ${new Date(data.premiumUntil).toLocaleDateString()}.`
            : `${data.email}: Premium ended.`
          : action === 'grant' || action === 'package'
          ? `${data.email} now has speaking ${data.credits ?? data.remaining}, writing ${data.writingCredits ?? '—'}. They will see the confirmation on their dashboard.`
          : action === 'reduce' || action === 'set'
          ? `${data.email}: speaking ${data.credits ?? data.remaining}, writing ${data.writingCredits ?? '—'}.`
          : `${data.email}: ${data.blocked ? 'blocked' : 'allowed'} — speaking ${data.credits ?? data.remaining}, writing ${data.writingCredits ?? '—'} left.`
      });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  async function changeAccessForAll(action) {
    setState({ loading: true, error: '', notice: '' });
    try {
      // The count comes from the server rather than from this page, and the
      // server refuses the change if the number has moved since. A tab left open
      // overnight cannot act on a class it was never shown.
      const fresh = await api('/admin/students');
      const data = await api('/admin/students/access-all', {
        method: 'POST',
        body: { action, confirm: fresh.studentCount }
      });

      await loadStudents({});
      setState({ notice: `${data.changed} student(s) ${action === 'block' ? 'blocked' : 'unblocked'}.` });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  async function openCalibration() {
    setState({ calibrationOpen: true, loading: true, error: '' });
    try {
      const data = await api('/admin/calibration');
      setState({ calibration: data, loading: false });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  async function loadCalibration() {
    try {
      state.calibration = await api('/admin/calibration');
    } catch { /* the card shows what it has */ }
  }

  async function handleNewSample(event) {
    event.preventDefault();
    const form = event.target;

    // Sent as multipart because a sample may carry a recording. The transcript
    // is optional when audio is present — the server transcribes it, so the
    // sample is a transcript produced exactly the way marked answers are.
    const data = new FormData();
    for (const field of ['part', 'level', 'score', 'scoreSource', 'question', 'transcription', 'notes']) {
      data.append(field, form[field]?.value || '');
    }
    const file = form.audio?.files?.[0];
    if (file) data.append('audio', file);

    if (!file && !form.transcription.value.trim()) {
      return setState({ error: 'Upload a recording or paste the transcript.' });
    }

    setState({ loading: true, error: '' });
    try {
      await api('/admin/calibration', { method: 'POST', form: data });
      await loadCalibration();
      state.notice = 'Sample added. It will be used the next time an answer for that part is marked.';
      setState({ loading: false, addingSample: false });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  async function toggleSample(id, isActive) {
    try {
      await api(`/admin/calibration/${id}`, { method: 'PATCH', body: { isActive: !isActive } });
      await loadCalibration();
      render();
    } catch (error) {
      setState({ error: error.message });
    }
  }

  async function deleteSample(id) {
    if (!window.confirm('Delete this sample? The examiner will stop using it.')) return;
    try {
      await api(`/admin/calibration/${id}`, { method: 'DELETE' });
      await loadCalibration();
      render();
    } catch (error) {
      setState({ error: error.message });
    }
  }

  async function runCalibrationCheck() {
    setState({ loading: true, error: '', calibrationCheck: null });
    try {
      const data = await api('/admin/calibration/check', { method: 'POST' });
      setState({ calibrationCheck: data, loading: false });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  async function checkRescue() {
    setState({ rescue: { checking: true }, error: '' });
    try {
      const data = await api('/admin/results/rescue');
      setState({
        rescue: { counted: data.attempts, students: data.students, answers: data.answers }
      });
    } catch (error) {
      setState({ rescue: {}, error: error.message });
    }
  }

  async function runRescue() {
    const r = state.rescue || {};
    setState({ rescue: { ...r, running: true }, error: '' });
    try {
      const data = await api('/admin/results/rescue', { method: 'POST' });
      // The work carries on server-side after this returns, so the notice says
      // what is happening rather than claiming it is done.
      state.notice = `${data.started} attempt(s) are being re-read. Scores appear as each one finishes — check back in a few minutes.`;
      setState({ rescue: {} });
    } catch (error) {
      setState({ rescue: { ...r, running: false }, error: error.message });
    }
  }

  /** Read the form without re-rendering, so a half-typed date is not lost. */
  function purgeQuery() {
    return {
      before: document.getElementById('purge-before')?.value || '',
      onlyZeros: Boolean(document.getElementById('purge-zeros')?.checked)
    };
  }

  async function checkPurge() {
    const query = purgeQuery();
    if (!query.before && !query.onlyZeros) {
      return setState({ error: 'Choose a date, or tick "only attempts that scored 0" — otherwise this would match every attempt ever taken.' });
    }

    setState({ purge: { ...query, checking: true }, error: '' });
    try {
      const params = new URLSearchParams();
      if (query.before) params.set('before', query.before);
      if (query.onlyZeros) params.set('onlyZeros', 'true');

      const data = await api(`/admin/results/purge?${params}`);
      setState({
        purge: {
          ...query,
          counted: data.attempts,
          recordings: data.recordings,
          students: data.students
        }
      });
    } catch (error) {
      setState({ purge: { ...query }, error: error.message });
    }
  }

  async function runPurge() {
    const p = state.purge || {};
    if (!p.counted) return;

    setState({ purge: { ...p, running: true }, error: '' });
    try {
      const data = await api('/admin/results/purge', {
        method: 'POST',
        // The count is sent back so the server can refuse if the set has
        // changed — a student finishing a mock in the meantime must not be
        // caught by a click aimed at yesterday's data.
        body: { before: p.before || undefined, onlyZeros: p.onlyZeros, confirm: p.counted }
      });
      state.notice = `Cleared ${data.deleted} attempt(s) and ${data.recordings} recording(s).`;
      setState({ purge: {} });
      await loadTests();
    } catch (error) {
      setState({ purge: { ...p, running: false }, error: error.message });
    }
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

  const lines = value => value.split('\n').map(x => x.trim()).filter(Boolean);

  /**
   * Upload picked images and attach them to the open section form.
   *
   * Uploaded straight away rather than on submit, so the teacher sees the
   * pictures appear and can tell an upload failed before saving the part.
   */
  async function uploadImages(input) {
    const form = input.closest('form');
    const files = [...input.files];
    if (!files.length) return;

    const thumbs = document.getElementById('sec-thumbs');
    if (thumbs) thumbs.innerHTML = '<span class="spinner"></span>';

    try {
      const urls = [];
      for (const file of files) {
        const body = new FormData();
        body.append('image', file);
        const res = await fetch(`${API}/admin/images`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.token}` },
          body
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.message || `Upload failed (${res.status})`);
        urls.push(payload.data.url);
      }

      form.images.value = urls.join(',');
      if (thumbs) thumbs.innerHTML = urls.map(u => `<img src="${esc(u)}" alt="" />`).join('');
    } catch (error) {
      if (thumbs) thumbs.innerHTML = '';
      setState({ error: error.message });
    }
  }

  async function handleSectionSubmit(event, form) {
    event.preventDefault();
    const testId = form.dataset.test;
    const isEdit = form.dataset.sectionForm === 'edit';

    const body = {
      instructions: form.instructions.value.trim(),
      topic: form.topic.value.trim(),
      pros: lines(form.pros.value),
      cons: lines(form.cons.value),
      images: form.images.value.split(',').map(x => x.trim()).filter(Boolean)
    };
    if (!isEdit) body.part = form.part.value;

    try {
      if (isEdit) {
        await api(`/admin/tests/${testId}/sections/${form.dataset.index}`, { method: 'PATCH', body });
      } else {
        await api(`/admin/tests/${testId}/sections`, { method: 'POST', body });
      }
      state.addingSectionTo = null;
      state.editingSection = null;
      state.notice = isEdit ? 'Part updated.' : 'Part added. Now add its questions.';
      await loadTests();
    } catch (error) {
      setState({ error: error.message });
    }
  }

  async function handleSectionQuestionSubmit(event, form) {
    event.preventDefault();
    const testId = form.dataset.test;
    const index = form.dataset.index;
    const isEdit = form.dataset.qForm === 'edit';

    const body = {
      text: form.text.value.trim(),
      prepTime: Number(form.prepTime.value),
      answerTime: Number(form.answerTime.value)
    };

    try {
      if (isEdit) {
        await api(`/admin/tests/${testId}/sections/${index}/questions/${form.dataset.q}`, { method: 'PATCH', body });
      } else {
        await api(`/admin/tests/${testId}/sections/${index}/questions`, { method: 'POST', body });
      }
      state.addingQuestionTo = null;
      state.editingQuestion = null;
      state.notice = isEdit ? 'Question updated.' : 'Question added.';
      await loadTests();
    } catch (error) {
      setState({ error: error.message });
    }
  }

  async function deleteSection(testId, index) {
    if (!window.confirm('Delete this part and all of its questions? This cannot be undone.')) return;
    try {
      await api(`/admin/tests/${testId}/sections/${index}`, { method: 'DELETE' });
      state.notice = 'Part removed.';
      await loadTests();
    } catch (error) {
      setState({ error: error.message });
    }
  }

  async function deleteSectionQuestion(testId, index, qIndex) {
    if (!window.confirm('Delete this question? This cannot be undone.')) return;
    try {
      await api(`/admin/tests/${testId}/sections/${index}/questions/${qIndex}`, { method: 'DELETE' });
      state.notice = 'Question removed.';
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
