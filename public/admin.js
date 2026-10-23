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
    csOpen: false,           // course students & homework card
    cs: null,                // { levels, skills, month, students, leaderboards }
    csNew: { name: '', level: 'A1', family: '', photo: '' },   // the "add student" form
    csSel: null,             // the student whose panel is open
    csTypes: new Set(),      // homework types ticked for today
    csVals: {},              // their percents, as typed
    csTitle: '',
    csDate: '',
    csHistory: false,
    csRoll: null,            // the level whose attendance roll call is open
    csGroups: new Set(),     // the levels (groups) whose student list is open
    csShowCodes: false,      // parent codes are hidden (students may be looking at the screen)
    csReveal: null,          // one student's code shown for a moment
    csPayYear: null,         // the school year shown in the payment months (null = this one)
    csPayMonth: null,        // the month whose payment form is open ("2026-11")
    csPayNote: '',
    csUnit: null,            // vocabulary: the unit being entered (a number) or 'general'
    csUnitVal: '', csUnitDate: '',
    csGenVals: {}, csGenOverall: '', csGenDate: '',
    csUnitsOpen: false,      // the "units per level" setting
    csRollDate: '',
    csRollMarks: {},         // id -> 'present' | 'late' | 'absent', as tapped
    csPayAmount: undefined,
    csPayDate: '',
    csFee: undefined,
    msgOpen: false,          // the Messages card
    msg: null,               // { sent, maxGift } once loaded
    msgDraft: { to: 'all', picked: [], title: '', html: '', giftOn: false, gs: 1, gw: 0 },
    msgFind: '',
    msgFound: [],
    reviewModule: 'speaking', // the review queue: speaking or writing attempts
    spOpen: false,           // the Support chat card
    sp: null,                // { conversations, totals, unread }
    spOnly: 'waiting',
    spSel: null,             // the student whose conversation is open
    spThread: null,
    spDraft: {},             // replies being typed, per student
    spImage: '',
    spBusy: false,
    spUnread: 0,
    refreshing: false,       // the Refresh button is working
    refreshedAt: '',         // when it last finished, shown next to it
    usage: null,             // the "Website use" numbers, refreshed every 2 min
    usageError: '',
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

  /**
   * The Refresh button: reloads the whole page (so a new version of the site
   * is picked up too), then opens again the cards, groups and student that
   * were open and goes back to the same place on the page.
   */
  const OPEN_CARDS = ['spOpen', 'msgOpen', 'csOpen', 'reviewOpen', 'studentsOpen', 'voiceOpen', 'chatOpen', 'picturesOpen', 'sponsorsOpen', 'calibrationOpen'];
  function refreshAll() {
    if (state.refreshing) return;
    setState({ refreshing: true });
    try {
      sessionStorage.setItem('adminRestore', JSON.stringify({
        at: Date.now(),
        open: OPEN_CARDS.filter(k => state[k]),
        csGroups: [...state.csGroups],
        csSel: state.csSel,
        scrollY: window.scrollY
      }));
    } catch { /* private mode: reload without restoring */ }
    location.reload();
  }

  /** After a Refresh: the same cards open, the same place on the page. */
  async function restoreAfterRefresh() {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem('adminRestore') || 'null');
      sessionStorage.removeItem('adminRestore');
    } catch { saved = null; }
    if (!saved || Date.now() - saved.at > 60000) return;
    const open = new Set(saved.open || []);
    OPEN_CARDS.forEach(k => { if (open.has(k)) state[k] = true; });
    state.csGroups = new Set(saved.csGroups || []);
    state.csSel = saved.csSel || null;
    await Promise.all([
      open.has('csOpen') ? loadCourse({}) : null,
      open.has('msgOpen') ? loadMessages({}) : null,
      open.has('spOpen') ? loadSupportAdmin({}) : null,
      open.has('reviewOpen') ? loadReview({}) : null,
      open.has('studentsOpen') ? loadStudents({}) : null,
      open.has('voiceOpen') ? loadVoice({}) : null,
      open.has('chatOpen') ? loadChat({}) : null,
      open.has('picturesOpen') ? loadPictures({}) : null,
      open.has('sponsorsOpen') ? loadSponsors({}) : null,
      open.has('calibrationOpen') ? loadCalibration() : null
    ].map(p => p && p.catch(() => null)));
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setState({ refreshedAt: now });
    // photos and cards finish drawing a moment later; go back to the same place once they have
    const y = saved.scrollY || 0;
    [0, 150, 400].forEach(ms => setTimeout(() => { if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y); }, ms));
  }

  async function loadTests() {
    setState({ loading: true, error: '' });
    try {
      const [tests, overview, unmarked] = await Promise.all([
        api('/admin/tests'),
        api('/admin/overview').catch(() => null),
        api('/admin/unmarked').catch(() => null)
      ]);
      api('/admin/usage')
        .then(usage => { state.usage = usage; state.usageError = ''; })
        .catch(error => { state.usageError = `Could not load the numbers: ${error.message}`; })
        .finally(() => refreshUsageCard());
      setState({ tests, overview, unmarked: unmarked?.attempts || [], loading: false, screen: 'tests' });
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
          ${state.refreshedAt ? `<span class="muted admin-refreshed">Updated ${esc(state.refreshedAt)}</span>` : ''}
          <button class="btn btn-sm admin-refresh ${state.refreshing ? 'is-busy' : ''}" data-action="refresh" ${state.refreshing ? 'disabled' : ''} title="Load the latest changes">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>
            ${state.refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
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

        ${usageCard()}
        ${unmarkedCard()}
        ${courseCard()}
        ${supportCard()}
        ${messagesCard()}
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
  /** Write to (or send a gift to) the student of an attempt, straight from the review queue. */
  const giftButton = r => (r.studentId
    ? `<button class="btn btn-ghost btn-sm" data-msg-write="${esc(r.studentId)}" data-name="${esc(r.studentName)}" data-email="${esc(r.student)}" title="Write to ${esc(r.student)} or send a gift">🎁 Message</button>`
    : '');

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

    const writing = state.reviewModule === 'writing';
    const modules = [['speaking', 'Speaking'], ['writing', 'Writing']].map(([value, label]) => `
      <button class="btn btn-sm ${state.reviewModule === value ? '' : 'btn-ghost'}" data-review-module="${value}">${label}</button>`).join('');
    const writingRows = (data?.results || []).map(r => `
      <div class="row" style="justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);flex-wrap:wrap">
        <div style="min-width:220px">
          <strong>${esc(r.studentName || r.student)}</strong>
          ${r.reviewed ? '<span class="tag tag-live">expert reviewed</span>' : ''}
          ${r.studentName ? `<div class="review-email">${esc(r.student)}</div>` : ''}
          <div class="muted" style="font-size:13px">${esc(r.title)} · ${r.parts} part${r.parts === 1 ? '' : 's'}</div>
        </div>
        <div class="muted" style="font-size:13px">${r.at ? new Date(r.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''}</div>
        <div class="row" style="gap:10px;align-items:center">
          <span><strong>${r.score ?? '—'}</strong><span class="muted"> / 75</span></span>
          <span class="tag">${esc(r.level || '')}</span>
          ${giftButton(r)}
          <a class="btn btn-sm" href="/?writing=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">Review</a>
        </div>
      </div>`).join('');
    const rows = writing ? writingRows : (data?.results || []).map(r => `
      <div class="row" style="justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);flex-wrap:wrap">
        <div style="min-width:220px">
          <strong>${esc(r.studentName || r.student)}</strong>
          ${r.corrected ? '<span class="tag tag-live">reviewed</span>' : ''}
          ${r.backupMark ? `<span class="tag tag-warn" title="${esc(r.backupReason || '')}">backup mark — re-mark</span>` : ''}
          ${r.studentName ? `<div class="review-email">${esc(r.student)}</div>` : ''}
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
          ${giftButton(r)}
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
        ${writing
          ? `${data?.unreviewed ?? 0} writing attempt${data?.unreviewed === 1 ? '' : 's'} not yet reviewed by you. Opening one shows the texts and bands; under them you can set the expert score, and the student gets a message with the old and new scores.`
          : `${data ? `${data.uncorrected} attempt${data.uncorrected === 1 ? '' : 's'} not yet reviewed.` : ''}
        Opening one shows the recordings and the marker's bands, with your own marking underneath — and the expert score, which changes the student's result and sends them a message.`}
      </p>
      <div class="row" style="gap:10px;margin-top:14px;flex-wrap:wrap">
        ${modules}<span class="msg-sep"></span>
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
      (s.waitingForEmail ? '<span class="tag tag-draft">email not confirmed</span>' : '') +
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
          <button class="btn btn-ghost btn-sm" data-msg-write="${esc(s.id)}" data-name="${esc(s.name)}" data-email="${esc(s.email)}" title="Write to this student, or send a gift">✉ Message</button>
          ${s.waitingForEmail
            ? `<button class="btn btn-ghost btn-sm" data-access="confirm-email" data-id="${esc(s.id)}"
                       title="Let this student in without the emailed code">Confirm email</button>`
            : ''}
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

  /**
   * Attempts handed in but never marked — e.g. while the AI balance was empty.
   * Shown only when there are any, at the top, because each is a student
   * waiting for a result. The server also retries recent ones by itself.
   */
  function unmarkedCard() {
    const list = state.unmarked || [];
    if (!list.length) return '';
    const rows = list.map(a => `
      <div class="row" style="justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--line);flex-wrap:wrap">
        <div style="min-width:0;flex:1">
          <strong>${esc(a.name || a.email)}</strong>
          <span class="muted" style="font-size:13px"> ${esc(a.email)} · ${esc(a.kind === 'speaking' ? 'Speaking' : 'Writing')} · ${esc(a.title)} · ${esc(a.detail)} · ${new Date(a.at).toLocaleString()}</span>
          ${a.kind === 'speaking' && !a.transcribed ? '<div class="muted" style="font-size:13px">No words were captured in any answer — retrying cannot mark it; use "Rescue" below or ask the student to retake.</div>' : ''}
          ${a.reason ? `<div class="muted" style="font-size:13px;overflow-wrap:anywhere">Last error: ${esc(a.reason.slice(0, 160))}</div>` : ''}
        </div>
        <button class="btn btn-sm" data-unmarked-retry="${esc(a.kind)}:${esc(a.id)}" ${a.kind === 'speaking' && !a.transcribed ? 'disabled' : ''}>Mark now</button>
      </div>`).join('');
    return `<div class="card" style="border-color:#fde68a;background:#fffbeb">
      <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
        <h2 style="font-size:18px">Not marked yet (${list.length})</h2>
        <div class="row" style="gap:8px">
          <button class="btn btn-ghost btn-sm" data-action="unmarked-reload">Refresh</button>
          <button class="btn btn-sm" data-action="unmarked-all">Mark all now</button>
        </div>
      </div>
      <p class="muted" style="margin-top:6px">Handed in, but marking failed (for example while the AI balance was empty).
        The site retries recent ones by itself every 20 minutes; "Mark now" does it straight away. Students are not charged again.</p>
      ${rows}
    </div>`;
  }

  async function loadUnmarked() {
    try {
      const data = await api('/admin/unmarked');
      setState({ unmarked: data.attempts || [] });
    } catch (error) {
      setState({ error: error.message });
    }
  }

  async function retryUnmarked(body) {
    try {
      const data = await api('/admin/unmarked/retry', { method: 'POST', body });
      state.notice = body.all
        ? `Marking started for ${data.started} attempt(s). Results appear in a minute or two — press Refresh.`
        : (data.started ? 'Marking started. Press Refresh in a minute.' : 'That attempt is already being marked.');
      setTimeout(loadUnmarked, 1500);
      render();
    } catch (error) {
      setState({ error: error.message });
    }
  }

  function wire() {
    wireUsage();
    wireCourseAdmin();
    wireMessagesAdmin();
    wireSupportAdmin();
    wireVoiceAdmin();
    wireChatAdmin();
    root.querySelectorAll('[data-unmarked-retry]').forEach(el =>
      el.addEventListener('click', () => {
        const [kind, id] = el.dataset.unmarkedRetry.split(':');
        el.disabled = true;
        retryUnmarked({ kind, id });
      }));
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
    root.querySelectorAll('[data-review-module]').forEach(el =>
      el.addEventListener('click', () => { state.reviewModule = el.dataset.reviewModule; state.review = null; loadReview({}); }));

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
    if (action === 'sp-open') return loadSupportAdmin({ open: true });
    if (action === 'sp-close') return setState({ spOpen: false });
    if (action === 'msg-open') return loadMessages({ open: true });
    if (action === 'msg-close') return setState({ msgOpen: false });
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
    if (action === 'unmarked-reload') return loadUnmarked();
    if (action === 'unmarked-all') return retryUnmarked({ all: true });
    if (action === 'chat-open') return loadChat({ open: true });
    if (action === 'chat-close') return setState({ chatOpen: false });
    if (action === 'chat-reload') return loadChat({});
    if (action === 'pictures-open') return loadPictures({ open: true });
    if (action === 'pictures-close') return setState({ picturesOpen: false });
    if (action === 'pictures-reload') return loadPictures({});
    if (action === 'sponsors-open') return loadSponsors({ open: true });
    if (action === 'sponsors-close') return setState({ sponsorsOpen: false });
    if (action === 'refresh') return refreshAll();
    if (action === 'cs-open') return loadCourse({ open: true });
    if (action === 'cs-close') return setState({ csOpen: false, csSel: null });
    if (action === 'block-all') return changeAccessForAll('block');
    if (action === 'unblock-all') return changeAccessForAll('unblock');
  }

  // ----------------------------------------------- parents' page: course students

  /**
   * The children in the course, as their parents see them on /ota-ona.
   * One table per level; click a child to enter today's homework (tick the
   * types given, type the percent of each, Save), change their details, or
   * remove them. Brothers and sisters share one family code. The ranking is
   * per level, this month, by the average of all homework percents.
   */
  const CS_SKILLS = [
    ['vocabulary', 'Vocabulary', 'Lug‘at'], ['grammar', 'Grammar', 'Grammatika'], ['listening', 'Listening', 'Tinglab tushunish'],
    ['reading', 'Reading', 'O‘qib tushunish'], ['speaking', 'Speaking', 'Gapirish'], ['writing', 'Writing', 'Yozish']
  ];
  const CS_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const csPhotos = new Map();   // "id:version" -> blob URL

  const csInitials = name => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  /** The homework form filled with what is already saved for that day (one day = one result). */
  const csFormFor = (s, date) => {
    const had = s?.results.find(r => r.day === date);
    return {
      csDate: date,
      csTypes: new Set(had ? Object.keys(had.skills).filter(k => had.skills[k] !== null) : []),
      csVals: had ? Object.fromEntries(Object.entries(had.skills).filter(([, v]) => v !== null).map(([k, v]) => [k, String(v)])) : {},
      csTitle: had?.title || ''
    };
  };
  const csToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const csMonthName = ym => { const [y, m] = String(ym || '').split('-'); return `${CS_MONTHS[Number(m) - 1] || ''} ${y || ''}`; };
  const csPct = v => (v === null || v === undefined ? '—' : `${Number.isInteger(v) ? v : v.toFixed(1)}%`);
  const csBand = v => (v === null || v === undefined ? '' : v >= 75 ? 'is-good' : v >= 50 ? 'is-mid' : 'is-low');
  const csMoney = n => `${Math.round(n || 0).toLocaleString('en-US').replace(/,/g, ' ')} so‘m`;
  const CS_MARKS = [['present', 'Came'], ['late', 'Late'], ['absent', 'Missed']];
  const CS_PAY = {
    paid: ['is-paid', '✓ Paid'], partial: ['is-partial', 'Part paid'], due: ['is-due', 'Not yet'], overdue: ['is-overdue', '✗ Not paid'],
    advance: ['is-paid', '✓ Paid ahead'], upcoming: ['is-upcoming', '—']
  };
  const CS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const csAddMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
  /**
   * One month of a student's payments, worked out from the full record (the
   * same rules as the server): voided payments never count; due by the 10th.
   */
  const csMonthPay = (s, ym) => {
    const today = csToday();
    const thisMonth = today.slice(0, 7);
    const entries = (s.ledger || []).filter(p => p.month === ym);
    const live = entries.filter(p => !p.voidedAt);
    const paid = live.reduce((a, p) => a + p.amount, 0);
    const fee = s.monthlyFee > 0 ? s.monthlyFee : null;
    const future = ym > thisMonth;
    const pastDue = !future && (ym < thisMonth || Number(today.slice(8, 10)) > 10);
    let status = paid > 0 && (fee === null || paid >= fee) ? (future ? 'advance' : 'paid') : paid > 0 ? 'partial' : future ? 'upcoming' : pastDue ? 'overdue' : 'due';
    if (status === 'overdue' && ym < (s.joinedMonth || '')) status = 'before';
    return { month: ym, paid, fee, left: fee !== null ? Math.max(0, fee - paid) : null, status, entries };
  };
  const csPayBadge = p => { const [cls, text] = CS_PAY[p?.status] || CS_PAY.due; return `<span class="cs-pay ${cls}">${text}</span>`; };
  const csFace = (s, size = 40) => {
    const url = s?.hasPhoto ? csPhotos.get(`${s.id}:${s.photoVersion}`) : '';
    return `<span class="cs-face" style="width:${size}px;height:${size}px">${url ? `<img src="${esc(url)}" alt="">` : esc(csInitials(s?.name))}</span>`;
  };

  /**
   * A parent code, hidden as dots unless the teacher shows it: students often
   * see the teacher's screen. Tapping one shows just that code for 15 seconds.
   */
  function csCode(s, big = false) {
    const shown = state.csShowCodes || state.csReveal === s.id;
    const text = shown ? `${s.parentCode.slice(0, 3)} ${s.parentCode.slice(3)}` : '••• •••';
    return `<button type="button" class="cs-code-btn ${big ? 'is-big' : ''} ${shown ? 'is-shown' : ''}" data-cs-reveal="${esc(s.id)}"
      title="${shown ? 'Hide the code' : 'Show this code'}" aria-label="${shown ? 'Hide parent code' : 'Show parent code'}">
      <span class="cs-code-text">${esc(text)}</span><span class="cs-code-eye" aria-hidden="true">${shown ? '🙈' : '👁'}</span></button>`;
  }

  function courseCard() {
    if (!state.csOpen) {
      return `<div class="card" style="margin-top:28px">
        <h2 style="font-size:18px">Course students &amp; homework</h2>
        <p class="muted" style="margin-top:6px">
          Your course students by level, their daily homework results and the monthly ranking.
          Parents type their family's 6-digit code at <strong>${esc(location.host)}/ota-ona</strong> to see their children.
        </p>
        <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="cs-open">Open course students</button>
      </div>`;
    }
    const data = state.cs || { students: [], levels: ['A1', 'A2', 'B1', 'B2', 'C1'], leaderboards: [], month: '' };
    const levels = data.levels;
    const byId = new Map(data.students.map(s => [s.id, s]));
    const familySize = fam => data.students.filter(s => s.family === fam).length;
    const levelOptions = sel => levels.map(l => `<option ${l === sel ? 'selected' : ''}>${l}</option>`).join('');
    // For a student already in a family, their brother or sister is shown as chosen.
    const familyOptions = (exceptId, selected = '') => {
      const me = exceptId ? byId.get(exceptId) : null;
      const sibling = me ? data.students.find(s => s.id !== me.id && s.family === me.family) : null;
      const chosen = selected || sibling?.id || '';
      const first = !me ? 'New family (new code)' : sibling ? 'Leave the family (own new code)' : 'Own family (own code)';
      return `<option value="">${first}</option>` + data.students
        .filter(s => s.id !== exceptId)
        .map(s => `<option value="${esc(s.id)}" ${chosen === s.id ? 'selected' : ''}>Same family as ${esc(s.name)}${state.csShowCodes ? ` (code ${esc(s.parentCode)})` : ''}</option>`).join('');
    };

    // --- adding a child
    const add = state.csNew;
    const addForm = `<form id="cs-add" class="cs-add">
      <label class="cs-add-photo" title="Add a photo">
        ${add.photo ? `<img src="${esc(add.photo)}" alt="">` : '<span>+ Photo</span>'}
        <input type="file" accept="image/jpeg,image/png,image/webp" id="cs-add-photo" style="display:none">
      </label>
      <div class="cs-add-fields">
        <input id="cs-add-name" type="text" maxlength="80" placeholder="Child's full name" value="${esc(add.name)}" required>
        <div class="cs-add-row">
          <select id="cs-add-level" aria-label="Level">${levelOptions(add.level)}</select>
          <select id="cs-add-family" aria-label="Family">${familyOptions('', add.family)}</select>
          <button class="btn btn-sm" type="submit">Add student</button>
        </div>
      </div>
    </form>`;

    // --- one table per level
    const tables = levels.map(level => {
      const list = data.students.filter(s => s.level === level);
      if (!list.length) return '';
      const isOpen = state.csGroups.has(level);
      const scored = list.map(s => s.month.percent).filter(v => typeof v === 'number');
      const avg = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null;
      const toPay = list.filter(s => s.active && (s.payment?.status === 'due' || s.payment?.status === 'overdue' || s.payment?.status === 'partial')).length;
      return `<div class="cs-level ${isOpen ? 'is-open' : ''}">
        <div class="cs-level-head">
          <button type="button" class="cs-group-toggle" data-cs-group="${level}" aria-expanded="${isOpen}" aria-controls="cs-group-${level}">
            <span class="cs-chev" aria-hidden="true">▸</span>
            <span class="tag">${level}</span>
            <span class="cs-group-count">${list.length} student${list.length === 1 ? '' : 's'}</span>
            <span class="cs-group-meta">${avg === null ? '' : `<span class="${csBand(avg)}">avg ${avg}%</span>`}${toPay ? `<span class="cs-miss">${toPay} to pay</span>` : ''}</span>
          </button>
          ${isOpen ? `<button class="btn btn-sm ${state.csRoll === level ? 'btn-ghost' : ''}" data-cs-roll="${level}">${state.csRoll === level ? 'Close attendance' : '✓ Take attendance'}</button>` : ''}
        </div>
        ${isOpen ? `<div id="cs-group-${level}" class="cs-group-body">
        ${state.csRoll === level ? rollCall(level, list) : ''}
        <div class="cs-table-wrap"><table class="cs-table">
          <thead><tr><th></th><th>Name</th><th>${esc(csMonthName(data.month).split(' ')[0])} average</th><th>Homeworks</th><th>Attendance</th><th>Payment</th><th>Parent code</th></tr></thead>
          <tbody>${list.map(s => {
            const open = state.csSel === s.id;
            return `<tr class="cs-tr ${open ? 'is-open' : ''} ${s.active ? '' : 'is-paused'}" data-cs-sel="${esc(s.id)}" tabindex="0">
                <td>${csFace(s, 36)}</td>
                <td><strong>${esc(s.name)}</strong>${s.active ? '' : ' <span class="tag">paused</span>'}${familySize(s.family) > 1 ? ' <span class="cs-fam" title="Shares the parent code with brothers/sisters">family</span>' : ''}</td>
                <td class="cs-num ${csBand(s.month.percent)}">${csPct(s.month.percent)}</td>
                <td class="cs-num">${s.month.homeworks}</td>
                <td class="cs-num">${s.attendance.lessons ? `${s.attendance.attended}/${s.attendance.lessons}${s.attendance.absent ? ` <span class="cs-miss">${s.attendance.absent} missed</span>` : ''}` : '<span class="muted">—</span>'}</td>
                <td>${csPayBadge(s.payment)}</td>
                <td class="cs-code-cell">${csCode(s)}</td>
              </tr>
              ${open ? `<tr class="cs-panel-row"><td colspan="7">${studentPanel(s, { levelOptions, familyOptions, byId })}</td></tr>` : ''}`;
          }).join('')}</tbody>
        </table></div>
        </div>` : ''}
      </div>`;
    }).join('');

    // --- the ranking
    const boards = (data.leaderboards || []).map(b => `<div class="cs-board">
        <h4><span class="tag">${esc(b.level)}</span></h4>
        <ol>${b.rows.map(r => `<li class="${r.rank === null ? 'is-unranked' : ''}">
          <span class="cs-rank">${r.rank ?? '—'}</span><span class="cs-rank-name">${esc(r.name)}</span>
          <span class="tag">${esc(r.level)}</span><span class="cs-rank-pct ${csBand(r.percent)}">${r.percent === null ? '<small>no homework</small>' : csPct(r.percent)}</span></li>`).join('')}</ol>
      </div>`).join('');

    return `<div class="card" style="margin-top:28px">
      <div class="row" style="justify-content:space-between">
        <h2 style="font-size:18px">Course students &amp; homework (${data.students.length})</h2>
        <div class="row" style="gap:8px">
          <button class="btn btn-ghost btn-sm" data-cs-report title="Emails who has paid and who hasn't, by group">✉ Payment report</button>
          <button class="btn btn-ghost btn-sm ${state.csUnitsOpen ? 'is-on' : ''}" data-cs-unitsopen aria-expanded="${state.csUnitsOpen}">Units per level</button>
          <button class="btn btn-ghost btn-sm cs-codes-toggle ${state.csShowCodes ? 'is-on' : ''}" data-cs-codes aria-pressed="${state.csShowCodes}">${state.csShowCodes ? '🙈 Hide codes' : '👁 Show codes'}</button>
          <button class="btn btn-ghost btn-sm" data-action="cs-close">Close</button>
        </div>
      </div>
      <p class="muted" style="margin-top:6px">Parents open <strong>${esc(location.host)}/ota-ona</strong> and type their family's code. Click a group to see its students, then click a student to enter today's homework.</p>
      ${state.csUnitsOpen ? `<form class="cs-units-set" id="cs-units-set">
        <strong>Vocabulary book and units per level</strong>
        <span class="muted">Choose the book each level studies: its units open in your students' accounts under <em>Vocabulary test → Uyga vazifani topshirish</em>, and their results come here by themselves. With no book, type the number of units yourself. Each level ends with a general test.</span>
        <div class="cs-units-books">${levels.map(l => {
          const cur = data.books?.[l]?.key || '';
          return `<div class="cs-units-book-row"><span class="tag">${l}</span>
            <select data-cs-book="${l}" aria-label="${l} book"><option value="">— no book —</option>${(data.bookChoices || []).map(b => `<option value="${esc(b.key)}" ${b.key === cur ? 'selected' : ''}>${esc(b.title)} (${b.units} units)</option>`).join('')}</select>
            <label class="cs-units-n ${cur ? 'is-off' : ''}">units <input type="number" min="1" max="60" step="1" data-cs-unitsn="${l}" value="${esc(data.unitsPerLevel?.[l] ?? 20)}" ${cur ? 'disabled' : ''} required></label></div>`;
        }).join('')}</div>
        <div><button class="btn btn-sm" type="submit">Save</button></div>
      </form>` : ''}
      ${addForm}
      ${tables || '<p class="muted" style="margin-top:12px">No students yet. Add the first one above.</p>'}
      ${boards ? `<h3 class="cs-board-title">Ranking — ${esc(csMonthName(data.month))}</h3>
        <p class="muted" style="font-size:13px">Average of every homework percent this month, per level. Parents see their child's level ranking.</p>
        <div class="cs-boards">${boards}</div>` : ''}
    </div>`;
  }

  /**
   * Attendance for one level: everyone starts as "Came" (or as already saved
   * for that date); tap who was late or missed, then Save.
   */
  function rollCall(level, list) {
    const date = state.csRollDate || csToday();
    const saved = list.some(s => s.marks?.[date]);
    const markOf = s => state.csRollMarks[s.id] || s.marks?.[date] || 'present';
    const counts = { present: 0, late: 0, absent: 0 };
    list.filter(s => s.active).forEach(s => { counts[markOf(s)] += 1; });
    return `<div class="cs-roll">
      <div class="cs-roll-top">
        <strong>Attendance — ${level}</strong>
        <label>Date <input type="date" id="cs-roll-date" value="${esc(date)}" max="${csToday()}"></label>
        ${saved ? '<span class="cs-saved">already saved for this date — saving again replaces it</span>' : ''}
      </div>
      <div class="cs-roll-list">${list.filter(s => s.active).map(s => `<div class="cs-roll-row">
          ${csFace(s, 32)}<span class="cs-roll-name">${esc(s.name)}</span>
          <div class="cs-seg" role="radiogroup" aria-label="${esc(s.name)}">${CS_MARKS.map(([k, label]) => `
            <button type="button" class="cs-seg-btn is-${k} ${markOf(s) === k ? 'is-on' : ''}" role="radio" aria-checked="${markOf(s) === k}" data-cs-mark="${esc(s.id)}:${k}">${label}</button>`).join('')}
          </div></div>`).join('')}
      </div>
      <div class="cs-roll-foot">
        <span class="muted">${counts.present} came · ${counts.late} late · ${counts.absent} missed</span>
        <div class="row" style="gap:8px">
          ${saved ? `<button class="btn btn-ghost btn-sm" data-cs-rollclear="${level}">No lesson this day</button>` : ''}
          <button class="btn btn-sm" data-cs-rollsave="${level}">Save attendance</button>
        </div>
      </div>
    </div>`;
  }

  /**
   * Vocabulary units: one chip per unit with its current result, then the
   * general test. Tap a unit to enter its result; tap "General test" to enter
   * the end-of-units test, which replaces the units' current results.
   */
  function vocabUnits(s) {
    const v = s.vocab;
    if (!v) return '';
    const sel = state.csUnit;
    const today = csToday();
    const fmt = d => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const chips = v.list.map(u => `<button type="button" class="cs-unit ${csBand(u.percent)} ${u.percent === null ? 'is-empty' : ''} ${sel === u.unit ? 'is-sel' : ''} ${u.percent !== null && u.percent < 60 ? 'is-weak' : ''}"
        data-cs-unit="${u.unit}" aria-pressed="${sel === u.unit}">
        <span class="cs-unit-no">Unit ${u.unit}${u.via === 'online' ? ' <span class="cs-online" title="The student took this test on the website">🌐</span>' : ''}</span>
        ${u.title ? `<span class="cs-unit-title">${esc(u.title)}</span>` : ''}
        <strong>${u.percent === null ? '—' : `${u.percent}%`}</strong>
        ${u.before !== null ? `<small>was ${u.before}%</small>` : u.source === 'general' ? '<small>general test</small>' : ''}
      </button>`).join('');
    const gen = v.latestTest;
    const genChip = `<button type="button" class="cs-unit cs-unit-gen ${csBand(gen?.percent)} ${sel === 'general' ? 'is-sel' : ''}" data-cs-unit="general" aria-pressed="${sel === 'general'}">
        <span class="cs-unit-no">General test</span><strong>${gen ? `${gen.percent}%` : 'All units'}</strong>${gen ? `<small>${esc(fmt(gen.date))}</small>` : ''}</button>`;

    let form = '';
    if (typeof sel === 'number') {
      const u = v.list.find(x => x.unit === sel);
      form = `<form class="cs-unit-form" id="cs-unit-form">
        <div class="cs-unit-form-top">
          <strong>Unit ${sel}</strong>
          <label>Date <input type="date" id="cs-unit-date" value="${esc(state.csUnitDate || today)}" max="${today}"></label>
          <label>Result <span class="cs-pct"><input type="number" id="cs-unit-pct" min="0" max="100" step="1" inputmode="numeric" value="${esc(state.csUnitVal)}" required><span>%</span></span></label>
          <button class="btn btn-sm" type="submit">Save Unit ${sel}</button>
        </div>
        ${u?.history.length ? `<ul class="cs-unit-hist">${u.history.map((h, i) => `<li class="${i === 0 ? 'is-now' : ''}">
            <span>${esc(fmt(h.date))}</span><strong class="${csBand(h.percent)}">${h.percent}%</strong>
            <span class="muted">${h.source === 'general' ? 'general test' : 'unit test'}${h.via === 'online' ? ' · on the website' : ''}${i === 0 ? ' · current' : ''}</span>
            ${h.source === 'unit' ? `<button type="button" class="cs-link" data-cs-unitdel="${esc(h.id)}">delete</button>` : ''}</li>`).join('')}</ul>`
          : '<p class="muted" style="font-size:13px">No result for this unit yet.</p>'}
      </form>`;
    } else if (sel === 'general') {
      form = `<form class="cs-unit-form" id="cs-gen-form">
        <div class="cs-unit-form-top">
          <strong>General test — all ${v.units} units</strong>
          <label>Date <input type="date" id="cs-gen-date" value="${esc(state.csGenDate || today)}" max="${today}"></label>
          <label>Overall <span class="cs-pct"><input type="number" id="cs-gen-overall" min="0" max="100" step="1" inputmode="numeric" value="${esc(state.csGenOverall)}" placeholder="auto"><span>%</span></span></label>
        </div>
        <p class="muted" style="font-size:13px">Type each unit's result from the test — or only the overall result, to give every unit that score. It replaces the units' current results; their earlier results stay in each unit's history.</p>
        <div class="cs-gen-grid">${v.list.map(u => `<label><span>Unit ${u.unit}</span><span class="cs-pct"><input type="number" min="0" max="100" step="1" inputmode="numeric" data-cs-gen="${u.unit}" value="${esc(state.csGenVals[u.unit] ?? '')}"><span>%</span></span></label>`).join('')}</div>
        <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn btn-sm" type="submit">Save general test</button></div>
        ${v.tests.length ? `<ul class="cs-unit-hist">${v.tests.map((t, i) => `<li class="${i === 0 ? 'is-now' : ''}">
            <span>${esc(fmt(t.date))}</span><strong class="${csBand(t.percent)}">${t.percent}%</strong>
            <span class="muted">${t.perUnit ? 'result per unit' : 'one result for all units'}${i === 0 ? ' · latest' : ''}</span>
            <button type="button" class="cs-link" data-cs-gendel="${esc(t.id)}">delete</button></li>`).join('')}</ul>` : ''}
      </form>`;
    }

    return `<div class="cs-vocab">
      <div class="cs-vocab-head">
        <strong>Vocabulary units — ${esc(v.level)}${v.book?.title ? ` · ${esc(v.book.title)}` : ""}</strong>
        <span class="cs-vocab-stats">
          <span>${v.done}/${v.units} units</span>
          ${v.unitAverage !== null ? `<span>Units average <b class="${csBand(v.unitAverage)}">${v.unitAverage}%</b></span>` : ''}
          ${gen ? `<span>General test <b class="${csBand(gen.percent)}">${gen.percent}%</b></span>` : ''}
          ${v.average !== null && gen ? `<span>Now <b class="${csBand(v.average)}">${v.average}%</b></span>` : ''}
        </span>
      </div>
      ${v.weak.length ? `<p class="cs-vocab-weak"><span class="cs-miss">Not learnt yet (below 60%):</span> ${v.weak.map(w => `Unit ${w.unit} (${w.percent}%)`).join(', ')}</p>` : ''}
      <div class="cs-units">${chips}${genChip}</div>
      ${form}
    </div>`;
  }

  /** Attendance and payment of one student, in their panel. */
  function moneyAndDays(s) {
    const a = s.attendance;
    const p = s.payment;
    const monthWord = csMonthName(p.month).split(' ')[0];
    const fmt = d => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', weekday: 'short' });
    return `<div class="cs-two">
      <div class="cs-box">
        <div class="cs-box-head"><strong>Attendance — ${esc(monthWord)}</strong>
          ${a.lessons ? `<span class="cs-num">${a.attended}/${a.lessons} · ${a.percent}%</span>` : ''}</div>
        ${a.lessons ? `
          <div class="cs-att-dots">${a.days.map(d => `<span class="cs-dot is-${d.status}" title="${esc(fmt(d.date))}: ${d.status === 'present' ? 'came' : d.status === 'late' ? 'late' : 'missed'}"></span>`).join('')}</div>
          ${a.missed.length ? `<p class="cs-att-line"><span class="cs-miss">Missed:</span> ${a.missed.map(fmt).map(esc).join(', ')}</p>` : '<p class="cs-att-line muted">No missed lessons this month.</p>'}
          ${a.lateDays.length ? `<p class="cs-att-line"><span class="cs-late">Late:</span> ${a.lateDays.map(fmt).map(esc).join(', ')}</p>` : ''}`
        : '<p class="muted" style="font-size:13px">No attendance taken this month yet. Use "Take attendance" above the level table.</p>'}
      </div>
    </div>
    ${paymentYear(s)}`;
  }

  /**
   * Payments by month for one school year (Sentabr → Avgust): tap a month to
   * enter a payment for it — this month, an earlier one, or one still to come.
   * Payments are never deleted; one typed by mistake is marked as a mistake
   * (kept, crossed out, not counted).
   */
  function paymentYear(s) {
    const year = state.csPayYear ?? state.cs?.schoolYear ?? Number(csToday().slice(0, 4));
    const months = Array.from({ length: 12 }, (_, i) => csAddMonths(`${year}-09`, i));
    const sel = state.csPayMonth && months.includes(state.csPayMonth) ? state.csPayMonth : null;
    const thisMonth = csToday().slice(0, 4) + '-' + csToday().slice(5, 7);
    const cells = months.map(ym => {
      const m = csMonthPay(s, ym);
      const [cls, label] = m.status === 'before' ? ['is-upcoming', 'not joined'] : CS_PAY[m.status] || CS_PAY.due;
      const voided = m.entries.some(e => e.voidedAt);
      return `<button type="button" class="cs-pm ${cls} ${ym === sel ? 'is-sel' : ''} ${ym === thisMonth ? 'is-now' : ''}" data-cs-pm="${ym}" aria-pressed="${ym === sel}">
        <span class="cs-pm-name">${CS_SHORT[Number(ym.slice(5)) - 1]} <small>${ym.slice(0, 4)}</small></span>
        <strong>${m.paid ? csMoney(m.paid).replace(' so‘m', '') : '—'}</strong>
        <span class="cs-pm-st">${label}${voided ? ' · mistake' : ''}</span>
      </button>`;
    }).join('');

    let form = '';
    if (sel) {
      const m = csMonthPay(s, sel);
      const amount = state.csPayAmount ?? (m.left || m.fee || '');
      form = `<form class="cs-pm-form" data-cs-pay="${esc(s.id)}" data-month="${sel}">
        <div class="cs-pm-form-top">
          <strong>${esc(csMonthName(sel))}</strong>
          ${m.fee ? `<span class="muted">${m.paid ? `${csMoney(m.paid)} of ${csMoney(m.fee)}${m.left ? ` · <span class="cs-miss">${csMoney(m.left)} left</span>` : ''}` : `fee ${csMoney(m.fee)}`}</span>` : '<span class="muted">Set the monthly fee below to see what is left.</span>'}
          ${sel > thisMonth ? '<span class="cs-pay is-paid">paying ahead</span>' : ''}
        </div>
        <div class="cs-pm-fields">
          <label>Amount <span class="cs-sum"><input type="number" min="1" step="any" inputmode="numeric" id="cs-pay-amount" value="${esc(amount)}" required><span>so‘m</span></span></label>
          <label>Paid on <input type="date" id="cs-pay-date" value="${esc(state.csPayDate || csToday())}" max="${csToday()}"></label>
          <label>Note <input type="text" id="cs-pay-note" maxlength="80" placeholder="optional, e.g. cash, Click" value="${esc(state.csPayNote || '')}"></label>
          <button class="btn btn-sm" type="submit">Save payment</button>
        </div>
        ${m.entries.length ? `<ul class="cs-pay-list">${m.entries.map(x => `<li class="${x.voidedAt ? 'is-void' : ''}">
            <span class="cs-pay-amt">${csMoney(x.amount)}</span>
            <span class="muted">paid ${esc(new Date(x.paidAt).toLocaleDateString())}${x.note ? ` · ${esc(x.note)}` : ''}</span>
            ${x.voidedAt
              ? `<span class="cs-void-why">mistake (${esc(new Date(x.voidedAt).toLocaleDateString())}): ${esc(x.voidReason)}</span>`
              : `<button type="button" class="cs-link" data-cs-void="${esc(s.id)}:${esc(x.id)}">mark as mistake</button>`}
          </li>`).join('')}</ul>` : '<p class="muted" style="font-size:13px">No payment for this month yet.</p>'}
      </form>`;
    }

    const ahead = (s.paidAhead || []).filter(a => a.status === 'advance' || a.status === 'partial');
    return `<div class="cs-box cs-pay-year">
      <div class="cs-box-head">
        <strong>Payments — school year ${year}–${String(year + 1).slice(2)}</strong>
        <span class="row" style="gap:6px">
          <button type="button" class="btn btn-ghost btn-sm" data-cs-py="-1" aria-label="Previous school year">‹ ${year - 1}</button>
          <button type="button" class="btn btn-ghost btn-sm" data-cs-py="1" aria-label="Next school year">${year + 1} ›</button>
        </span>
      </div>
      <p class="cs-att-line">This month: ${csPayBadge(s.payment)}${ahead.length ? ` · <span class="cs-ahead">Paid ahead: ${ahead.map(a => esc(csMonthName(a.month).split(' ')[0]) + (a.status === 'partial' ? ' (part)' : '')).join(', ')}</span>` : ''}</p>
      <div class="cs-pm-grid">${cells}</div>
      ${form || '<p class="muted" style="font-size:13px">Tap a month to enter a payment for it — including months still to come.</p>'}
      <form class="cs-fee-form" data-cs-fee="${esc(s.id)}">
        <label>Monthly fee <span class="cs-sum"><input type="number" min="0" step="any" inputmode="numeric" id="cs-fee" value="${esc(state.csFee ?? (s.monthlyFee ?? ''))}" placeholder="e.g. 500000"><span>so‘m</span></span></label>
        <button class="btn btn-ghost btn-sm" type="submit">Save fee</button>
      </form>
      <p class="muted" style="font-size:12px;margin:0">Payments are never deleted. A wrong one is marked as a mistake and stays in the record.</p>
    </div>
      </div>`;
  }

  /** The panel under a clicked student: today's homework, then details. */
  function studentPanel(s, { levelOptions, familyOptions }) {
    const types = state.csTypes;
    const vals = state.csVals;
    const hwDate = state.csDate || csToday();
    const savedDay = s.results.some(r => r.day === hwDate);
    return `<div class="cs-panel">
      <div class="cs-panel-head">
        <label class="cs-face-edit" title="Change photo">
          ${csFace(s, 72)}
          <span class="cs-face-cam">${s.hasPhoto ? 'Change' : '+ Photo'}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" data-cs-photo="${esc(s.id)}" style="display:none">
        </label>
        <div class="cs-panel-who">
          <form class="cs-name-form" data-cs-rename="${esc(s.id)}">
            <input type="text" id="cs-name-input" maxlength="80" value="${esc(state.csName ?? s.name)}" aria-label="Student's name" required>
            <button class="btn btn-sm" type="submit" ${state.csName === undefined || state.csName.trim() === s.name ? 'disabled' : ''}>Save name</button>
          </form>
          ${s.hasPhoto ? `<button type="button" class="cs-link" data-cs-unphoto="${esc(s.id)}">Remove photo</button>` : ''}
          <div class="muted" style="font-size:13px">${s.results.length} homework${s.results.length === 1 ? '' : 's'} in total · parents ${s.lastParentVisit ? `last opened ${esc(new Date(s.lastParentVisit).toLocaleDateString())}` : 'have not opened it yet'}</div>
        </div>
      </div>

      <form class="cs-hw" id="cs-hw">
        <div class="cs-hw-top">
          <strong>Homework results</strong>
          <label>Date <input type="date" id="cs-hw-date" value="${esc(hwDate)}"></label>
          <label>Note <input type="text" id="cs-hw-title" maxlength="80" placeholder="optional, e.g. Unit 5" value="${esc(state.csTitle || '')}"></label>
        </div>
        <p class="muted" style="font-size:13px">${savedDay
          ? '<span class="cs-saved">Already saved for this day</span> — add or change any type below; it stays one result for the day.'
          : 'Choose the homework types you gave, then type each result in percent. You can add more types for the same day later.'}</p>
        <div class="cs-types">${CS_SKILLS.map(([k, en, uz]) => `<button type="button" class="cs-type ${types.has(k) ? 'is-on' : ''}" data-cs-type="${k}" aria-pressed="${types.has(k)}">${en}<small>${uz}</small></button>`).join('')}
          <button type="button" class="cs-type cs-type-all" data-cs-type="all">${types.size === CS_SKILLS.length ? 'Clear all' : 'Choose all'}</button>
        </div>
        ${types.size ? `<div class="cs-vals">${CS_SKILLS.filter(([k]) => types.has(k)).map(([k, en]) => `
          <label>${en}<span class="cs-pct"><input type="number" min="0" max="100" step="1" inputmode="numeric" data-cs-val="${k}" value="${esc(vals[k] ?? '')}" required><span>%</span></span></label>`).join('')}
        </div>
        <button class="btn" type="submit">${savedDay ? 'Update this day' : 'Save homework'}</button>` : ''}
      </form>

      ${vocabUnits(s)}

      ${moneyAndDays(s)}

      <div class="cs-details">
        <label>Level <select data-cs-level="${esc(s.id)}">${levelOptions(s.level)}</select></label>
        <label>Family <select data-cs-family="${esc(s.id)}">${familyOptions(s.id, '')}</select></label>
        <div class="cs-code-box"><span class="muted">Parent code</span>${csCode(s, true)}</div>
        <form class="cs-account" data-cs-account="${esc(s.id)}">
          <label>Student's website account (Gmail)
            <input type="email" id="cs-account-input" maxlength="120" placeholder="student@gmail.com" value="${esc(state.csAccount ?? s.accountEmail ?? '')}" autocomplete="off"></label>
          <button class="btn btn-sm" type="submit" ${state.csAccount === undefined || state.csAccount.trim().toLowerCase() === (s.accountEmail || '') ? 'disabled' : ''}>Save</button>
          <span class="cs-account-state ${s.accountEmail ? (s.accountFound ? 'is-ok' : 'is-warn') : ''}">${!s.accountEmail
            ? 'Not linked — the student cannot hand in vocabulary homework on the website.'
            : s.accountFound ? '✓ Linked: “Uyga vazifani topshirish” shows in this account.'
            : 'No account with this email yet — it links by itself once the student signs up with it.'}</span>
        </form>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" data-cs-copy="${esc(s.parentCode)}" data-name="${esc(s.name)}">Copy message for parents</button>
          <button class="btn btn-ghost btn-sm" data-cs-newcode="${esc(s.id)}" data-name="${esc(s.name)}">New code</button>
          <button class="btn btn-ghost btn-sm" data-cs-active="${esc(s.id)}" data-active="${s.active ? '1' : ''}">${s.active ? 'Pause' : 'Turn back on'}</button>
          <button class="btn btn-ghost btn-sm cs-danger" data-cs-delete="${esc(s.id)}" data-name="${esc(s.name)}">Remove student</button>
        </div>
      </div>

      ${s.results.length ? `<details class="cs-history" ${state.csHistory ? 'open' : ''}>
        <summary>Homework history (${s.results.length})</summary>
        <div class="cs-table-wrap"><table class="cs-table cs-table-sm">
          <thead><tr><th>Date</th><th>Note</th><th>Level</th>${CS_SKILLS.map(([, en]) => `<th>${en}</th>`).join('')}<th></th></tr></thead>
          <tbody>${[...s.results].reverse().map(r => `<tr>
            <td>${esc(new Date(r.date).toLocaleDateString())}</td><td>${esc(r.title || '—')}</td><td>${esc(r.level)}</td>
            ${CS_SKILLS.map(([k]) => `<td class="cs-num ${csBand(r.skills[k])}">${r.skills[k] ?? '—'}</td>`).join('')}
            <td><button class="btn btn-ghost btn-sm" data-cs-deltest="${esc(s.id)}:${esc(r.id)}">Delete</button></td></tr>`).join('')}
          </tbody></table></div>
      </details>` : ''}
    </div>`;
  }

  async function loadCourse({ open } = {}) {
    setState({ csOpen: open || state.csOpen, loading: true, error: '' });
    try {
      const data = await api('/admin/course-students');
      setState({ cs: data, loading: false });
      loadCoursePhotos();
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  /** Photos need the admin's sign-in, so they are fetched and shown from memory. */
  async function loadCoursePhotos() {
    const missing = (state.cs?.students || []).filter(s => s.hasPhoto && !csPhotos.has(`${s.id}:${s.photoVersion}`));
    for (const s of missing) {
      try {
        const res = await fetch(`${API}/admin/course-students/${s.id}/photo`, { headers: { Authorization: `Bearer ${state.token}` } });
        if (res.ok) csPhotos.set(`${s.id}:${s.photoVersion}`, URL.createObjectURL(await res.blob()));
      } catch { /* initials stay */ }
    }
    if (missing.length) render();
  }

  /** Make the photo small and square before upload: 480 px, JPEG, centred a little above the middle (faces). */
  function shrinkPhoto(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - side) / 2;
        const sy = Math.max(0, (img.naturalHeight - side) / 2 - side * 0.08);
        const c = document.createElement('canvas');
        c.width = c.height = Math.min(480, side);
        c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = () => reject(new Error('That file could not be read as a picture.'));
      img.src = URL.createObjectURL(file);
    });
  }

  /** Every change returns the whole list again, so the tables and ranking update at once. */
  async function csCall(path, opts, notice, extra = {}) {
    try {
      const data = await api(path, opts);
      setState({ cs: data, notice: notice || '', error: '', ...extra });
      loadCoursePhotos();
      return true;
    } catch (error) {
      setState({ error: error.message });
      return false;
    }
  }

  let csRevealTimer = null;
  function wireCourseAdmin() {
    if (!state.csOpen) return;
    const $ = id => document.getElementById(id);

    // adding a child (the typed name is kept in state so a re-draw never loses it)
    $('cs-add-name')?.addEventListener('input', e => { state.csNew.name = e.target.value; });
    $('cs-add-level')?.addEventListener('change', e => { state.csNew.level = e.target.value; });
    $('cs-add-family')?.addEventListener('change', e => {
      state.csNew.family = e.target.value;
      const sib = state.cs?.students.find(s => s.id === e.target.value);
      if (sib) { state.csNew.level = state.csNew.level || sib.level; }
    });
    $('cs-add-photo')?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try { state.csNew.photo = await shrinkPhoto(file); render(); } catch (error) { setState({ error: error.message }); }
    });
    $('cs-add')?.addEventListener('submit', async e => {
      e.preventDefault();
      const n = state.csNew;
      if (!n.name.trim()) return setState({ error: 'Type the child’s name.' });
      const ok = await csCall('/admin/course-students', {
        method: 'POST', body: { name: n.name, level: n.level, photo: n.photo || undefined, sameFamilyAs: n.family || undefined }
      }, `${n.name.trim()} added — open them below to copy the parent code.`);
      if (ok) { state.csNew = { name: '', level: n.level, family: '', photo: '' }; state.csGroups = new Set([...state.csGroups, n.level]); render(); }
    });

    // the payment email, on demand
    root.querySelector('[data-cs-report]')?.addEventListener('click', async () => {
      setState({ loading: true, error: '', notice: '' });
      try {
        const r = await api('/admin/course-students/payments/report', { method: 'POST' });
        setState({ loading: false, notice: `Payment report emailed to ${r.to.join(', ')} — ${r.counts.paid} paid, ${r.counts.notPaid} not paid this month.` });
      } catch (error) { setState({ loading: false, error: error.message }); }
    });

    // vocabulary units
    root.querySelector('[data-cs-unitsopen]')?.addEventListener('click', () => setState({ csUnitsOpen: !state.csUnitsOpen }));
    $('cs-units-set')?.addEventListener('submit', e => {
      e.preventDefault();
      const body = {};
      root.querySelectorAll('[data-cs-unitsn]').forEach(el => { if (!el.disabled) body[el.dataset.csUnitsn] = Number(el.value); });
      body.books = {};
      root.querySelectorAll('[data-cs-book]').forEach(el => { body.books[el.dataset.csBook] = el.value; });
      csCall('/admin/course-students/settings/units', { method: 'PUT', body }, 'Units per level saved.', { csUnitsOpen: false });
    });
    root.querySelectorAll('[data-cs-book]').forEach(el => el.addEventListener('change', () => {
      const n = root.querySelector(`[data-cs-unitsn="${el.dataset.csBook}"]`);
      if (n) { n.disabled = Boolean(el.value); n.closest('label')?.classList.toggle('is-off', Boolean(el.value)); }
    }));
    $('cs-account-input')?.addEventListener('input', e => {
      state.csAccount = e.target.value;
      const btn = e.target.closest('form')?.querySelector('button[type=submit]');
      const st = state.cs?.students.find(x => x.id === state.csSel);
      if (btn) btn.disabled = e.target.value.trim().toLowerCase() === (st?.accountEmail || '');
    });
    root.querySelector('[data-cs-account]')?.addEventListener('submit', async e => {
      e.preventDefault();
      const id = e.currentTarget.dataset.csAccount;
      const email = String(state.csAccount ?? '').trim();
      const st = state.cs?.students.find(x => x.id === id);
      await csCall(`/admin/course-students/${id}`, { method: 'PATCH', body: { accountEmail: email } },
        email ? `${st?.name || 'Student'} linked to ${email}.` : `${st?.name || 'Student'} unlinked from the website account.`, { csAccount: undefined });
    });
    root.querySelectorAll('[data-cs-unit]').forEach(el => el.addEventListener('click', () => {
      const raw = el.dataset.csUnit;
      const unit = raw === 'general' ? 'general' : Number(raw);
      setState(state.csUnit === unit ? { csUnit: null } : { csUnit: unit, csUnitVal: '', csUnitDate: '', csGenVals: {}, csGenOverall: '', csGenDate: '' });
      if (unit !== 'general') document.getElementById('cs-unit-pct')?.focus();
    }));
    $('cs-unit-pct')?.addEventListener('input', e => { state.csUnitVal = e.target.value; });
    $('cs-unit-date')?.addEventListener('change', e => { state.csUnitDate = e.target.value; });
    $('cs-unit-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const unit = state.csUnit;
      const st = state.cs.students.find(x => x.id === state.csSel);
      await csCall(`/admin/course-students/${state.csSel}/vocab`, {
        method: 'POST', body: { unit, percent: state.csUnitVal, date: state.csUnitDate || csToday() }
      }, `Unit ${unit} saved for ${st?.name || 'the student'}.`, { csUnitVal: '' });
    });
    root.querySelectorAll('[data-cs-unitdel]').forEach(el => el.addEventListener('click', () => {
      if (!confirm('Delete this unit result?')) return;
      csCall(`/admin/course-students/${state.csSel}/vocab/${el.dataset.csUnitdel}`, { method: 'DELETE' }, 'Result deleted.');
    }));
    root.querySelectorAll('[data-cs-gen]').forEach(el => el.addEventListener('input', () => { state.csGenVals[el.dataset.csGen] = el.value; }));
    $('cs-gen-overall')?.addEventListener('input', e => { state.csGenOverall = e.target.value; });
    $('cs-gen-date')?.addEventListener('change', e => { state.csGenDate = e.target.value; });
    $('cs-gen-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      const units = Object.fromEntries(Object.entries(state.csGenVals).filter(([, v]) => String(v).trim() !== ''));
      if (!Object.keys(units).length && String(state.csGenOverall).trim() === '') return setState({ error: 'Type the overall result, or a result for each unit.' });
      const st = state.cs.students.find(x => x.id === state.csSel);
      const ok = await csCall(`/admin/course-students/${state.csSel}/vocab/general`, {
        method: 'POST', body: { date: state.csGenDate || csToday(), units, percent: state.csGenOverall === '' ? undefined : state.csGenOverall }
      }, `General test saved for ${st?.name || 'the student'} — the units now show its results.`);
      if (ok) setState({ csGenVals: {}, csGenOverall: '' });
    });
    root.querySelectorAll('[data-cs-gendel]').forEach(el => el.addEventListener('click', () => {
      if (!confirm('Delete this general test? The units go back to their earlier results.')) return;
      csCall(`/admin/course-students/${state.csSel}/vocab-tests/${el.dataset.csGendel}`, { method: 'DELETE' }, 'General test deleted.');
    }));

    // parent codes: all at once, or one for 15 seconds
    root.querySelector('[data-cs-codes]')?.addEventListener('click', () => setState({ csShowCodes: !state.csShowCodes, csReveal: null }));
    root.querySelectorAll('[data-cs-reveal]').forEach(el => el.addEventListener('click', ev => {
      ev.stopPropagation();   // inside a student's row: don't open/close the student
      const sid = el.dataset.csReveal;
      if (state.csShowCodes) return setState({ csShowCodes: false, csReveal: null });
      if (state.csReveal === sid) return setState({ csReveal: null });
      setState({ csReveal: sid });
      clearTimeout(csRevealTimer);
      csRevealTimer = setTimeout(() => { if (state.csReveal === sid) setState({ csReveal: null }); }, 15000);
    }));
    root.querySelectorAll('[data-cs-reveal]').forEach(el => el.addEventListener('keydown', ev => ev.stopPropagation()));

    // opening and closing a group (level)
    root.querySelectorAll('[data-cs-group]').forEach(el => el.addEventListener('click', () => {
      const level = el.dataset.csGroup;
      const groups = new Set(state.csGroups);
      const patch = { csGroups: groups };
      if (groups.has(level)) {
        groups.delete(level);
        if (state.csRoll === level) patch.csRoll = null;
        if (state.cs?.students.find(s => s.id === state.csSel)?.level === level) patch.csSel = null;
      } else groups.add(level);
      setState(patch);
    }));

    // opening a student
    root.querySelectorAll('[data-cs-sel]').forEach(el => {
      const open = () => {
        const id = el.dataset.csSel;
        const st = state.cs?.students.find(x => x.id === id);
        setState(state.csSel === id ? { csSel: null } : { csSel: id, ...csFormFor(st, csToday()), csUnit: null, csName: undefined, csAccount: undefined, csPayAmount: undefined, csPayDate: '', csPayNote: '', csPayMonth: null, csFee: undefined });
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', ev => { if (ev.key === 'Enter') open(); });
    });

    // today's homework
    const id = state.csSel;
    root.querySelectorAll('[data-cs-type]').forEach(el => el.addEventListener('click', () => {
      const k = el.dataset.csType;
      const types = new Set(state.csTypes);
      if (k === 'all') { if (types.size === CS_SKILLS.length) types.clear(); else CS_SKILLS.forEach(([s]) => types.add(s)); }
      else if (types.has(k)) types.delete(k); else types.add(k);
      setState({ csTypes: types });
      root.querySelector(`[data-cs-val="${k}"]`)?.focus();
    }));
    root.querySelectorAll('[data-cs-val]').forEach(el => el.addEventListener('input', () => { state.csVals[el.dataset.csVal] = el.value; }));
    $('cs-hw-date')?.addEventListener('change', e => {
      const st = state.cs?.students.find(x => x.id === id);
      setState(csFormFor(st, e.target.value || csToday()));
    });
    $('cs-hw-title')?.addEventListener('input', e => { state.csTitle = e.target.value; });
    $('cs-hw')?.addEventListener('submit', async e => {
      e.preventDefault();
      const skills = {};
      for (const [k] of CS_SKILLS) skills[k] = state.csTypes.has(k) ? Number(state.csVals[k]) : null;
      const s = state.cs.students.find(x => x.id === id);
      const date = state.csDate || csToday();
      const ok = await csCall(`/admin/course-students/${id}/results`, {
        method: 'POST', body: { date, title: state.csTitle, level: s?.level, skills, replace: true }
      }, `Saved — ${s?.name || 'the student'}'s parents can see it now.`);
      if (ok) setState(csFormFor(state.cs.students.find(x => x.id === id), date));
    });

    // details
    root.querySelectorAll('[data-cs-level]').forEach(el => el.addEventListener('change', () =>
      csCall(`/admin/course-students/${el.dataset.csLevel}`, { method: 'PATCH', body: { level: el.value } }, 'Level changed.')));
    root.querySelectorAll('[data-cs-family]').forEach(el => el.addEventListener('change', () => {
      const sib = el.value ? state.cs.students.find(s => s.id === el.value) : null;
      const me = state.cs.students.find(s => s.id === el.dataset.csFamily);
      if (sib && me && sib.family === me.family) return render();   // already together
      const msg = sib ? `Join ${sib.name}'s family? They will share one parent code.` : 'Give this student a family of their own, with a new code?';
      if (!confirm(msg)) return render();
      csCall(`/admin/course-students/${el.dataset.csFamily}/family`, { method: 'POST', body: { sameFamilyAs: el.value || null } }, 'Family changed — send the parents the new code if it changed.');
    }));
    root.querySelectorAll('[data-cs-active]').forEach(el => el.addEventListener('click', () =>
      csCall(`/admin/course-students/${el.dataset.csActive}`, { method: 'PATCH', body: { active: !el.dataset.active } })));
    root.querySelectorAll('[data-cs-newcode]').forEach(el => el.addEventListener('click', () => {
      if (!confirm(`Give ${el.dataset.name}'s family a new parent code? Phones that remember the old code will be signed out.`)) return;
      csCall(`/admin/course-students/${el.dataset.csNewcode}/code`, { method: 'POST' }, 'New code made — send it to the parents.');
    }));
    root.querySelectorAll('[data-cs-delete]').forEach(el => el.addEventListener('click', () => {
      if (!confirm(`Remove ${el.dataset.name} from the course list? They disappear from the lists, the parents' page and the ranking — their payment record is kept.`)) return;
      csCall(`/admin/course-students/${el.dataset.csDelete}`, { method: 'DELETE' }, `${el.dataset.name} removed.`, { csSel: null });
    }));
    root.querySelectorAll('[data-cs-copy]').forEach(el => el.addEventListener('click', async () => {
      const text = `Assalomu alaykum! Farzandingizning ingliz tilidagi natijalarini shu yerda kuzatishingiz mumkin: ${location.origin}/ota-ona\nKod: ${el.dataset.csCopy}`;
      try { await navigator.clipboard.writeText(text); setState({ notice: 'Message with the link and code copied — paste it to the parents (Telegram, SMS).' }); }
      catch { prompt('Copy this message for the parents:', text); }
    }));
    root.querySelectorAll('[data-cs-deltest]').forEach(el => el.addEventListener('click', () => {
      const [sid, rid] = el.dataset.csDeltest.split(':');
      if (!confirm('Delete this homework result?')) return;
      csCall(`/admin/course-students/${sid}/results/${rid}`, { method: 'DELETE' }, 'Homework deleted.', { csHistory: true });
    }));
    root.querySelectorAll('[data-cs-photo]').forEach(el => el.addEventListener('change', async () => {
      const file = el.files?.[0];
      if (!file) return;
      try {
        const photo = await shrinkPhoto(file);
        await csCall(`/admin/course-students/${el.dataset.csPhoto}/photo`, { method: 'POST', body: { photo } }, 'Photo saved.');
      } catch (error) { setState({ error: error.message }); }
    }));
    root.querySelector('.cs-history')?.addEventListener('toggle', e => { state.csHistory = e.target.open; });

    // attendance roll call
    root.querySelectorAll('[data-cs-roll]').forEach(el => el.addEventListener('click', () =>
      setState(state.csRoll === el.dataset.csRoll ? { csRoll: null } : { csRoll: el.dataset.csRoll, csRollDate: csToday(), csRollMarks: {} })));
    $('cs-roll-date')?.addEventListener('change', e => setState({ csRollDate: e.target.value, csRollMarks: {} }));
    root.querySelectorAll('[data-cs-mark]').forEach(el => el.addEventListener('click', () => {
      const [sid, mark] = el.dataset.csMark.split(':');
      setState({ csRollMarks: { ...state.csRollMarks, [sid]: mark } });
    }));
    root.querySelectorAll('[data-cs-rollsave]').forEach(el => el.addEventListener('click', () => {
      const level = el.dataset.csRollsave;
      const date = state.csRollDate || csToday();
      const list = state.cs.students.filter(s => s.level === level && s.active);
      const marks = Object.fromEntries(list.map(s => [s.id, state.csRollMarks[s.id] || s.marks?.[date] || 'present']));
      const missed = list.filter(s => marks[s.id] === 'absent').length;
      csCall('/admin/course-students/attendance', { method: 'POST', body: { date, level, marks } },
        `Attendance saved for ${level}: ${list.length - missed} came, ${missed} missed. Parents can see it now.`, { csRoll: null, csRollMarks: {} });
    }));
    root.querySelectorAll('[data-cs-rollclear]').forEach(el => el.addEventListener('click', () => {
      const date = state.csRollDate || csToday();
      if (!confirm(`Remove the attendance of ${el.dataset.csRollclear} on ${date}?`)) return;
      csCall(`/admin/course-students/attendance?date=${encodeURIComponent(date)}&level=${encodeURIComponent(el.dataset.csRollclear)}`, { method: 'DELETE' }, 'That day’s attendance was removed.', { csRollMarks: {} });
    }));

    // payments and the monthly fee
    $('cs-pay-amount')?.addEventListener('input', e => { state.csPayAmount = e.target.value; });
    $('cs-pay-date')?.addEventListener('change', e => { state.csPayDate = e.target.value; });
    $('cs-pay-note')?.addEventListener('input', e => { state.csPayNote = e.target.value; });
    root.querySelectorAll('[data-cs-pm]').forEach(el => el.addEventListener('click', () => {
      const ym = el.dataset.csPm;
      setState(state.csPayMonth === ym ? { csPayMonth: null } : { csPayMonth: ym, csPayAmount: undefined, csPayDate: '', csPayNote: '' });
    }));
    root.querySelectorAll('[data-cs-py]').forEach(el => el.addEventListener('click', () => {
      const year = (state.csPayYear ?? state.cs?.schoolYear ?? Number(csToday().slice(0, 4))) + Number(el.dataset.csPy);
      setState({ csPayYear: year, csPayMonth: null });
    }));
    root.querySelectorAll('[data-cs-void]').forEach(el => el.addEventListener('click', () => {
      const [sid, pid] = el.dataset.csVoid.split(':');
      const reason = prompt('Why is this payment a mistake? (It stays in the record, crossed out, and is no longer counted.)');
      if (!reason || !reason.trim()) return;
      csCall(`/admin/course-students/${sid}/payments/${pid}/void`, { method: 'POST', body: { reason: reason.trim() } }, 'Marked as a mistake — kept in the record, not counted.');
    }));
    $('cs-fee')?.addEventListener('input', e => { state.csFee = e.target.value; });
    root.querySelectorAll('[data-cs-pay]').forEach(form => form.addEventListener('submit', e => {
      e.preventDefault();
      const amount = Number(form.querySelector('#cs-pay-amount').value);
      if (!amount) return;
      const month = form.dataset.month || state.cs.month;
      csCall(`/admin/course-students/${form.dataset.csPay}/payments`, {
        method: 'POST', body: { month, amount, paidAt: state.csPayDate || csToday(), note: state.csPayNote || '' }
      }, `Payment of ${csMoney(amount)} for ${csMonthName(month)} saved — parents see it now.`, { csPayAmount: undefined, csPayDate: '', csPayNote: '' });
    }));
    root.querySelectorAll('[data-cs-fee]').forEach(form => form.addEventListener('submit', e => {
      e.preventDefault();
      const v = form.querySelector('#cs-fee').value;
      csCall(`/admin/course-students/${form.dataset.csFee}`, { method: 'PATCH', body: { monthlyFee: v === '' ? null : Number(v) } }, 'Monthly fee saved.', { csFee: undefined });
    }));

    // renaming: the typed name is kept in state, the Save button lights up when it differs
    const nameInput = $('cs-name-input');
    nameInput?.addEventListener('input', () => {
      state.csName = nameInput.value;
      const btn = nameInput.form.querySelector('button');
      const s = state.cs.students.find(x => x.id === state.csSel);
      btn.disabled = !nameInput.value.trim() || nameInput.value.trim() === s?.name;
    });
    root.querySelectorAll('[data-cs-rename]').forEach(form => form.addEventListener('submit', e => {
      e.preventDefault();
      const name = (state.csName ?? '').trim();
      if (!name) return;
      csCall(`/admin/course-students/${form.dataset.csRename}`, { method: 'PATCH', body: { name } }, `Name changed to ${name}.`, { csName: undefined });
    }));
    root.querySelectorAll('[data-cs-unphoto]').forEach(el => el.addEventListener('click', () => {
      if (!confirm('Remove this photo? Parents will see the initials instead.')) return;
      csCall(`/admin/course-students/${el.dataset.csUnphoto}/photo`, { method: 'DELETE' }, 'Photo removed.');
    }));
  }

  // ----------------------------------------------------------- website use

  /**
   * How many people used the website: today, right now, by hour and over the
   * last 30 days. Asks the server again every 2 minutes. Only this card is
   * redrawn, so a form being filled in elsewhere on the page is not touched.
   */
  const USAGE_EVERY_MS = 2 * 60 * 1000;
  let usageTimer = null;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDay = day => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
  const niceMax = max => {
    if (max <= 4) return 4;
    const step = Math.pow(10, Math.floor(Math.log10(max)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= max) return m * step;
    return 10 * step;
  };

  /** A bar chart in SVG: one series, a faint grid, the highlighted bar labelled. */
  function barChart({ values, labelAt, tip, highlight, hatched = () => false, width = 640, height = 170 }) {
    const W = width, H = height, L = 34, R = 8, T = 18, B = 24;
    const pw = W - L - R, ph = H - T - B;
    const max = niceMax(Math.max(1, ...values));
    const slot = pw / values.length;
    const bw = Math.max(3, slot - 3);
    const y = v => T + ph - (v / max) * ph;
    const grid = [0, max / 2, max].map(v => `
      <line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="u-grid" />
      <text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="u-axis">${Number.isInteger(v) ? v : v.toFixed(1)}</text>`).join('');
    const bars = values.map((v, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      const h = Math.max(v > 0 ? 3 : 0, (v / max) * ph);
      const cls = i === highlight ? 'u-bar is-now' : hatched(i) ? 'u-bar is-est' : 'u-bar';
      const label = labelAt(i);
      return `<g class="u-col"><title>${esc(tip(i))}</title>
        <rect x="${L + i * slot}" y="${T}" width="${slot}" height="${ph + B}" fill="transparent" />
        ${h ? `<path class="${cls}" d="M${x},${T + ph} v${-(h - Math.min(4, h / 2))} q0,${-Math.min(4, h / 2)} ${Math.min(4, bw / 2)},${-Math.min(4, h / 2)} h${bw - 2 * Math.min(4, bw / 2)} q${Math.min(4, bw / 2)},0 ${Math.min(4, bw / 2)},${Math.min(4, h / 2)} v${h - Math.min(4, h / 2)} z" />` : ''}
        ${i === highlight ? `<text x="${x + bw / 2}" y="${y(v) - 5}" text-anchor="middle" class="u-val">${v}</text>` : ''}
        ${label ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="u-axis">${esc(label)}</text>` : ''}
      </g>`;
    }).join('');
    return `<svg class="u-chart" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="xMidYMid meet">${grid}${bars}</svg>`;
  }

  function usageCard() {
    const u = state.usage;
    if (!u) {
      return `<div class="card usage-card" id="usage-card">
        <div class="usage-head"><h2 style="font-size:18px">Website use</h2></div>
        <p class="muted">${state.usageError ? esc(state.usageError) : '<span class="spinner"></span>'}</p>
      </div>`;
    }

    const updated = new Date(u.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // Compare with yesterday up to the same time, not with all of yesterday:
    // otherwise every morning looks like a drop.
    const diff = u.yesterdaySoFar == null ? null : u.activeToday - u.yesterdaySoFar;
    const vsYesterday = u.activeYesterday == null ? 'Counting started today'
      : u.yesterdaySoFar == null ? `Yesterday ${u.activeYesterday}${u.yesterdayEstimated ? ' (estimate)' : ''}`
      : `${u.yesterdaySoFar} by this time yesterday (${u.activeYesterday} all day)`;

    const tile = (label, value, note = '', cls = '') => `
      <div class="u-tile ${cls}">
        <div class="u-label">${label}</div>
        <div class="u-value">${value}</div>
        ${note ? `<div class="u-note">${note}</div>` : ''}
      </div>`;

    const days = u.days || [];
    const todayIndex = days.length - 1;
    const hasEstimates = days.some(d => d.estimated);
    const monthChart = barChart({
      values: days.map(d => d.users),
      highlight: todayIndex,
      hatched: i => days[i].estimated,
      labelAt: i => (i === todayIndex ? 'Today' : (todayIndex - i) % 7 === 0 && todayIndex - i >= 7 ? shortDay(days[i].day) : ''),
      tip: i => {
        const d = days[i];
        return `${shortDay(d.day)}: ${d.users} student${d.users === 1 ? '' : 's'}`
          + (d.estimated ? ' (estimate from mocks, writing and chat)' : d.guests ? `, ${d.guests} visitor${d.guests === 1 ? '' : 's'} not signed in` : '');
      }
    });

    const hourChart = barChart({
      values: u.hours,
      width: 420,
      height: 190,
      highlight: u.currentHour,
      labelAt: h => (h % 3 === 0 ? String(h).padStart(2, '0') : ''),
      tip: h => `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59: ${u.hours[h]} student${u.hours[h] === 1 ? '' : 's'}`
    });

    return `<div class="card usage-card" id="usage-card">
      <div class="usage-head">
        <h2 style="font-size:18px">Website use today</h2>
        <div class="row" style="gap:10px">
          <span class="muted u-updated">Updated ${esc(updated)} · refreshes every 2 min</span>
          <button class="btn btn-ghost btn-sm" data-usage-refresh>Refresh</button>
        </div>
      </div>

      <div class="u-tiles">
        ${tile('<span class="u-live"></span>Online now', u.onlineNow, 'active in the last 5 min')}
        ${tile('Students today', u.activeToday,
          `${esc(vsYesterday)}${diff ? ` <span class="${diff > 0 ? 'u-up' : 'u-down'}">${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)}</span>` : ''}`, 'is-main')}
        ${tile('Visitors not signed in', u.guestsToday, 'opened the site, no account')}
        ${tile('New sign-ups', u.newSignups)}
        ${tile('Speaking mocks', u.speakingToday, 'started today')}
        ${tile('Writing', u.writingToday, 'checks and mocks')}
        ${tile('AI Ustoz', u.aiSessionsToday, `${u.aiPeopleToday} student${u.aiPeopleToday === 1 ? '' : 's'}`)}
        ${u.weekAverage != null ? tile('7-day average', u.weekAverage, 'students a day') : ''}
      </div>

      <div class="u-charts">
        <figure class="u-fig">
          <figcaption>Students per day, last 30 days</figcaption>
          ${monthChart}
          ${hasEstimates ? `<div class="u-key"><span class="u-swatch is-est"></span>Before ${esc(shortDay(u.trackedFrom))}: estimate — students who did a mock, writing or chat (people who only looked around were not counted then)</div>` : ''}
        </figure>
        <figure class="u-fig">
          <figcaption>Today by hour (Tashkent time)</figcaption>
          ${hourChart}
        </figure>
      </div>
    </div>`;
  }

  function refreshUsageCard() {
    const card = document.getElementById('usage-card');
    if (!card) return;
    card.outerHTML = usageCard();
    wireUsage();
  }

  async function refreshUsage() {
    if (!state.token || state.screen === 'login') return;
    try {
      state.usage = await api('/admin/usage');
      state.usageError = '';
    } catch (error) {
      state.usageError = `Could not load the numbers: ${error.message}`;
    }
    refreshUsageCard();
  }

  function wireUsage() {
    document.querySelector('[data-usage-refresh]')?.addEventListener('click', e => {
      e.currentTarget.disabled = true;
      refreshUsage();
    });
    if (!usageTimer) {
      usageTimer = setInterval(() => { if (!document.hidden) refreshUsage(); }, USAGE_EVERY_MS);
      // Coming back to the tab after a while: catch up straight away.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden || !state.usage) return;
        if (Date.now() - new Date(state.usage.updatedAt).getTime() > USAGE_EVERY_MS) refreshUsage();
      });
    }
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
  const chatRoomName = (room, name) => CHAT_ROOM_NAMES[room] ||
    (String(room).startsWith('voice:') ? 'In a call' : String(room).startsWith('room-') ? `Room "${name || '…'}"` : room);

  function chatCard() {
    if (!state.chatOpen) {
      return `<div class="card" style="margin-top:28px">
        <h2 style="font-size:18px">Text chat</h2>
        <p class="muted" style="margin-top:6px">
          Messages (typed and voice) from the General, B1, B2 and C1 chat rooms, the rooms Premium
          students open, and from inside speaking calls, with student reports (kept ${esc(state.chat?.retentionDays || 30)} days, then deleted automatically).
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
            <span class="muted" style="font-size:13px"> ${esc(m.email)} · ${esc(chatRoomName(m.room, m.roomName))} · ${new Date(m.at).toLocaleString()}</span>
            ${m.reported ? '<span class="tag tag-draft">reported</span>' : ''}
            ${m.filtered ? '<span class="tag" title="The filter changed this message before anyone saw it">filtered</span>' : ''}
            ${m.deleted ? `<span class="tag">deleted${m.deletedBy ? ` by ${esc(m.deletedBy)}` : ''}</span>` : ''}
            ${m.kind === 'voice'
              ? `<div style="margin-top:6px"><span class="tag">voice ${esc(m.seconds || 0)}s</span>
                  <button class="btn btn-ghost btn-sm" data-chat-audio="${esc(m.audio || '')}">▶ Play</button></div>`
              : `<div style="margin-top:4px;overflow-wrap:anywhere">${esc(m.text)}</div>`}
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
    const openRooms = (data.community || []).map(r => `
      <div class="row" style="justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);flex-wrap:wrap">
        <div style="min-width:0;flex:1"><strong>${esc(r.name)}</strong>
          <span class="muted" style="font-size:13px"> · ${esc(r.level || 'All levels')} · host ${esc(r.host?.name || '')} · ${r.count}/${r.max} inside</span>
          ${r.topic ? `<div class="muted" style="font-size:13px">${esc(r.topic)}</div>` : ''}</div>
        <div class="row" style="gap:6px">
          <button class="btn btn-ghost btn-sm" data-chat-filter="${esc(r.id)}">Messages</button>
          <button class="btn btn-ghost btn-sm" data-chat-room-close="${esc(r.id)}" data-chat-name="${esc(r.name)}">Close room</button>
        </div>
      </div>`).join('');
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
      ${openRooms ? `<h3 style="font-size:15px;margin-top:16px">Open student rooms</h3>${openRooms}` : ''}
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
    root.querySelectorAll('[data-chat-room-close]').forEach(el =>
      el.addEventListener('click', async () => {
        if (!window.confirm(`Close the room "${el.dataset.chatName}"? Everyone inside goes back to the room list.`)) return;
        try {
          await api(`/chat/rooms/${encodeURIComponent(el.dataset.chatRoomClose)}/close`, { method: 'POST' });
          state.notice = `Room "${el.dataset.chatName}" closed.`;
          loadChat({});
        } catch (error) { setState({ error: error.message }); }
      }));
    // Voice messages are fetched with the sign-in token, only when played.
    root.querySelectorAll('[data-chat-audio]').forEach(el =>
      el.addEventListener('click', async () => {
        el.disabled = true;
        try {
          const res = await fetch(el.dataset.chatAudio, { headers: { Authorization: `Bearer ${state.token}` } });
          if (!res.ok) throw new Error(String(res.status));
          const audio = Object.assign(document.createElement('audio'), { controls: true, src: URL.createObjectURL(await res.blob()) });
          audio.style.cssText = 'display:block;margin-top:6px;width:100%;max-width:360px';
          el.replaceWith(audio);
          audio.play().catch(() => {});
        } catch {
          el.replaceWith(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Voice message unavailable.' }));
        }
      }));
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
      const data = await api(`/admin/${state.reviewModule === 'writing' ? 'writing-results' : 'results'}?${query}`);
      setState({ review: data, loading: false });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }


  // ------------------------------------------------------------- support chat

  const SP_KINDS = { question: ['❓', 'Question'], problem: ['🐞', 'Problem'], idea: ['💡', 'Idea'], praise: ['💚', 'Liked'] };
  const spImages = new Map();   // image url -> object URL (the pictures need the admin's sign-in)

  /**
   * English Hub Support (Jamshid, 2026-10-24): every student's conversation
   * with the team. Left: who wrote, newest first, with what is waiting;
   * right: the conversation and the reply box. Students see replies as
   * "English Hub Support".
   */
  function supportCard() {
    const unread = state.spUnread || 0;
    if (!state.spOpen) {
      return `<div class="card" style="margin-top:28px">
        <h2 style="font-size:18px">Support chat ${unread ? `<span class="sp-badge">${unread} new</span>` : ''}</h2>
        <p class="muted" style="margin-top:6px">Students' questions, problems, ideas and what they liked about the website. They write from their message box; you answer here as <strong>English Hub Support</strong>.</p>
        <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="sp-open">Open support chat</button>
      </div>`;
    }
    const data = state.sp;
    const t = data?.totals || {};
    const totals = Object.entries(SP_KINDS).map(([k, [e, l]]) => `<span class="sp-total is-${k}">${e} ${l} <b>${t[k] || 0}</b></span>`).join('');
    const ago = at => {
      const min = Math.round((Date.now() - new Date(at)) / 60000);
      if (min < 1) return 'now';
      if (min < 60) return `${min} min`;
      if (min < 60 * 24) return `${Math.round(min / 60)} h`;
      return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    };
    const list = (data?.conversations || []).map(c => `<button class="sp-conv ${state.spSel === c.user ? 'is-sel' : ''} ${c.unread ? 'is-unread' : ''}" data-sp-conv="${esc(c.user)}">
        <span class="sp-conv-top"><strong>${esc(c.name || c.email)}</strong><span class="muted">${esc(ago(c.lastAt))}</span></span>
        <span class="sp-conv-mail">${esc(c.email)}</span>
        <span class="sp-conv-last">${c.lastFrom === 'team' ? '<span class="muted">You: </span>' : c.lastKind ? `${SP_KINDS[c.lastKind]?.[0] || ''} ` : ''}${esc(c.lastText)}</span>
        ${c.unread ? `<span class="sp-badge">${c.unread}</span>` : ''}
      </button>`).join('');
    const th = state.spThread;
    const fmt = at => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const bubbles = th ? th.messages.map(m => {
      const team = m.from === 'team';
      const k = !team && m.kind ? SP_KINDS[m.kind] : null;
      return `<div class="sp-a-row ${team ? 'is-team' : 'is-user'}">
        <div class="sp-a-bubble">
          ${k ? `<span class="sp-a-kind is-${m.kind}">${k[0]} ${k[1]}</span>` : ''}
          ${m.image ? `<a class="sp-a-shot" data-sp-img="${esc(m.image)}" target="_blank" rel="noopener"><img data-sp-src="${esc(m.image)}" alt="Screenshot"></a>` : ''}
          ${m.text ? `<div class="sp-a-text">${esc(m.text)}</div>` : ''}
          <span class="sp-a-meta">${esc(fmt(m.at))}${team ? ` · ${m.seen ? '✓✓ seen' : '✓ sent'}` : ''}</span>
        </div>
      </div>`;
    }).join('') : '';
    const pane = th ? `<div class="sp-a-pane">
        <div class="sp-a-head">
          <div><strong>${esc(th.user.name || th.user.email)}</strong><span class="muted">${esc(th.user.email)}</span></div>
          <button class="btn btn-ghost btn-sm" data-msg-write="${esc(th.user.id)}" data-name="${esc(th.user.name)}" data-email="${esc(th.user.email)}" title="Send a message with a gift">🎁 Gift</button>
        </div>
        <div class="sp-a-msgs" id="sp-a-msgs">${bubbles || '<p class="muted">No messages.</p>'}</div>
        <form class="sp-a-reply" id="sp-a-reply">
          ${state.spImage ? `<div class="sp-a-preview"><img src="${state.spImage}" alt=""><button type="button" data-sp-unimage>×</button></div>` : ''}
          <div class="sp-a-input">
            <label class="sp-a-attach" title="Attach a picture">📎<input type="file" id="sp-a-file" accept="image/*" hidden></label>
            <textarea id="sp-a-text" rows="2" maxlength="4000" placeholder="Reply as English Hub Support… (Ctrl+Enter to send)">${esc(state.spDraft[th.user.id] || '')}</textarea>
            <button class="btn" type="submit" ${state.spBusy ? 'disabled' : ''}>${state.spBusy ? 'Sending…' : 'Send'}</button>
          </div>
        </form>
      </div>` : `<div class="sp-a-pane is-empty"><p class="muted">Choose a conversation on the left.</p></div>`;
    return `<div class="card" id="sp-card" style="margin-top:28px">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <h2 style="font-size:18px">Support chat ${unread ? `<span class="sp-badge">${unread} new</span>` : ''}</h2>
        <div class="row" style="gap:6px">
          <button class="btn btn-sm ${state.spOnly === 'waiting' ? '' : 'btn-ghost'}" data-sp-only="waiting">Waiting for reply</button>
          <button class="btn btn-sm ${state.spOnly === '' ? '' : 'btn-ghost'}" data-sp-only="">All</button>
          <button class="btn btn-ghost btn-sm" data-action="sp-close">Close</button>
        </div>
      </div>
      <div class="sp-totals">${totals}<span class="muted" style="font-size:12px">— everything students have written so far</span></div>
      <div class="sp-a-wrap">
        <div class="sp-a-list">${list || '<p class="muted" style="padding:12px">Nothing here yet.</p>'}</div>
        ${pane}
      </div>
    </div>`;
  }

  async function loadSupportAdmin({ open, only } = {}) {
    if (only !== undefined) state.spOnly = only;
    if (open) state.spOpen = true;
    try {
      const data = await api(`/admin/support?${new URLSearchParams(state.spOnly ? { only: state.spOnly } : {})}`);
      state.sp = data; state.spUnread = data.unread;
      if (state.spSel) await loadSupportThread(state.spSel, { quiet: true });
      renderKeepingReply();
    } catch (error) { setState({ error: error.message }); }
  }

  async function loadSupportThread(user, { quiet = false } = {}) {
    try {
      const data = await api(`/admin/support/${user}`);
      const before = state.spThread?.messages.length;
      state.spSel = user; state.spThread = data; state.spUnread = data.unread;
      const c = state.sp?.conversations.find(x => x.user === user);
      if (c) c.unread = 0;
      if (!quiet) { state.spImage = ''; render(); scrollSupportBottom(); }
      else if (before !== data.messages.length) { renderKeepingReply(); scrollSupportBottom(); }
    } catch (error) { setState({ error: error.message }); }
  }

  let spStickUntil = 0;   // pictures load after the scroll: keep to the bottom until they have
  function scrollSupportBottom() {
    const box = document.getElementById('sp-a-msgs');
    if (box) box.scrollTop = box.scrollHeight;
    spStickUntil = Date.now() + 3000;
  }

  /** Re-draw without losing the reply being typed. */
  function renderKeepingReply() {
    const ta = document.getElementById('sp-a-text');
    const focused = ta && document.activeElement === ta;
    const caret = focused ? ta.selectionStart : null;
    const box = document.getElementById('sp-a-msgs');
    const top = box ? box.scrollTop : null;
    render();
    const again = document.getElementById('sp-a-text');
    if (again && focused) { again.focus(); again.setSelectionRange(caret, caret); }
    const box2 = document.getElementById('sp-a-msgs');
    if (box2 && top !== null) box2.scrollTop = top;
  }

  async function refreshSupportBadge() {
    try {
      const d = await api('/admin/support/unread');
      if (d.unread !== state.spUnread) { state.spUnread = d.unread; if (state.spOpen) loadSupportAdmin(); else renderKeepingReply(); }
    } catch { /* badge stays */ }
  }

  async function loadSupportImages() {
    for (const el of root.querySelectorAll('img[data-sp-src]')) {
      const url = el.dataset.spSrc;
      if (!spImages.has(url)) {
        try {
          const res = await fetch(url, { headers: { Authorization: `Bearer ${state.token}` } });
          if (res.ok) spImages.set(url, URL.createObjectURL(await res.blob()));
        } catch { continue; }
      }
      if (spImages.has(url)) {
        el.addEventListener('load', () => {
          if (Date.now() < spStickUntil) { const box = document.getElementById('sp-a-msgs'); if (box) box.scrollTop = box.scrollHeight; }
        }, { once: true });
        el.src = spImages.get(url);
        const a = el.closest('a');
        if (a) a.href = spImages.get(url);
      }
    }
  }

  function shrinkScreenshot(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1280 / img.naturalWidth, 2000 / img.naturalHeight);
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => reject(new Error('That file could not be read as a picture.'));
      img.src = URL.createObjectURL(file);
    });
  }

  let spTimer = null;
  function wireSupportAdmin() {
    if (!spTimer) spTimer = setInterval(() => { if (!document.hidden && state.token) (state.spOpen ? loadSupportAdmin() : refreshSupportBadge()); }, 20000);
    if (!state.spOpen) return;
    loadSupportImages();
    root.querySelectorAll('[data-sp-conv]').forEach(el => el.addEventListener('click', () => loadSupportThread(el.dataset.spConv)));
    root.querySelectorAll('[data-sp-only]').forEach(el => el.addEventListener('click', () => loadSupportAdmin({ only: el.dataset.spOnly })));
    const ta = document.getElementById('sp-a-text');
    ta?.addEventListener('input', () => { state.spDraft[state.spSel] = ta.value; });
    ta?.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); document.getElementById('sp-a-reply')?.requestSubmit(); } });
    document.getElementById('sp-a-file')?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try { state.spImage = await shrinkScreenshot(file); } catch (error) { state.error = error.message; }
      renderKeepingReply();
    });
    root.querySelector('[data-sp-unimage]')?.addEventListener('click', () => { state.spImage = ''; renderKeepingReply(); });
    document.getElementById('sp-a-reply')?.addEventListener('submit', async e => {
      e.preventDefault();
      const user = state.spSel;
      const text = (state.spDraft[user] || '').trim();
      if ((!text && !state.spImage) || state.spBusy) return;
      state.spBusy = true; renderKeepingReply();
      try {
        const out = await api(`/admin/support/${user}`, { method: 'POST', body: { text, image: state.spImage || undefined } });
        state.spThread.messages.push(out.message);
        state.spDraft[user] = ''; state.spImage = '';
        const c = state.sp?.conversations.find(x => x.user === user);
        if (c) { c.lastFrom = 'team'; c.lastText = text || '📷'; c.lastAt = out.message.at; c.unread = 0; }
        state.error = '';
      } catch (error) { state.error = error.message; }
      state.spBusy = false;
      render(); scrollSupportBottom();
      document.getElementById('sp-a-text')?.focus();
    });
  }

  // ------------------------------------------------------------- messages

  const MSG_COLORS = [['#0f172a', 'Black'], ['#dc2626', 'Red'], ['#ea580c', 'Orange'], ['#ca8a04', 'Gold'], ['#16a34a', 'Green'], ['#2563eb', 'Blue'], ['#7c3aed', 'Purple'], ['#db2777', 'Pink']];
  const MSG_MARKS = [['#fef08a', 'Yellow'], ['#bbf7d0', 'Green'], ['#bfdbfe', 'Blue'], ['#fbcfe8', 'Pink']];
  const MSG_SIZES = [['2', 'Small'], ['3', 'Normal'], ['5', 'Large'], ['6', 'Huge']];
  const MSG_EMOJI = ['🎉', '🎁', '🔥', '⭐', '✅', '📢', '🏆', '💪', '📚', '❤️'];

  /**
   * Messages to students (Jamshid, 2026-10-23): one, several, his course
   * students or everyone, with bold, colours and sizes, and an optional gift
   * of mocks the student unwraps and activates. Below it, what was sent and
   * how many have read it.
   */
  function messagesCard() {
    if (!state.msgOpen) {
      return `<div class="card" style="margin-top:28px">
        <h2 style="font-size:18px">Messages</h2>
        <p class="muted" style="margin-top:6px">Write to one student, a few, your course students or everyone — website updates, news, anything —
          with colours and bold text. Add a 🎁 gift of mocks to motivate someone: they unwrap it and press <em>Activate</em>.</p>
        <button class="btn btn-ghost btn-sm" style="margin-top:12px" data-action="msg-open">Open messages</button>
      </div>`;
    }
    const d = state.msgDraft;
    const toBtn = (v, label) => `<button type="button" class="btn btn-sm ${d.to === v ? '' : 'btn-ghost'}" data-msg-to="${v}" aria-pressed="${d.to === v}">${label}</button>`;
    const picker = d.to === 'pick' ? `<div class="msg-pick">
        <div class="msg-chips">${d.picked.map(p => `<span class="msg-chip">${esc(p.name || p.email)}${p.name && p.email ? ` <small>${esc(p.email)}</small>` : ''}<button type="button" data-msg-unpick="${esc(p.id)}" aria-label="Remove ${esc(p.name || p.email)}">×</button></span>`).join('') || '<span class="muted" style="font-size:13px">No one chosen yet — search below.</span>'}</div>
        <input id="msg-find" type="search" placeholder="Search a student by name or email" value="${esc(state.msgFind)}" autocomplete="off">
        ${state.msgFound.length ? `<div class="msg-found">${state.msgFound.map(s => `<button type="button" data-msg-pick="${esc(s.id)}" data-name="${esc(s.name)}" data-email="${esc(s.email)}" ${d.picked.some(p => p.id === s.id) ? 'disabled' : ''}>
            <strong>${esc(s.name || s.email)}</strong><span class="muted">${esc(s.email)}</span></button>`).join('')}</div>` : ''}
      </div>` : '';
    const tool = (cmd, label, title, arg = '') => `<button type="button" class="msg-tool" data-msg-cmd="${cmd}" data-arg="${esc(arg)}" title="${esc(title)}" aria-label="${esc(title)}">${label}</button>`;
    const toolbar = `<div class="msg-toolbar" role="toolbar" aria-label="Text style">
        ${tool('bold', '<b>B</b>', 'Bold')}${tool('italic', '<i>I</i>', 'Italic')}${tool('underline', '<u>U</u>', 'Underline')}${tool('strikeThrough', '<s>S</s>', 'Strike through')}
        <span class="msg-sep"></span>
        ${MSG_SIZES.map(([v, l]) => tool('fontSize', l, `${l} text`, v)).join('')}
        ${tool('formatBlock', 'Heading', 'Heading', 'h3')}${tool('formatBlock', '¶', 'Normal paragraph', 'p')}
        <span class="msg-sep"></span>
        ${MSG_COLORS.map(([c, l]) => `<button type="button" class="msg-swatch" style="background:${c}" data-msg-cmd="foreColor" data-arg="${c}" title="${l} text" aria-label="${l} text"></button>`).join('')}
        <span class="msg-sep"></span>
        ${MSG_MARKS.map(([c, l]) => `<button type="button" class="msg-swatch is-mark" style="background:${c}" data-msg-cmd="hiliteColor" data-arg="${c}" title="${l} highlight" aria-label="${l} highlight">A</button>`).join('')}
        <span class="msg-sep"></span>
        ${tool('insertUnorderedList', '• List', 'Bullet list')}${tool('insertOrderedList', '1. List', 'Numbered list')}
        ${tool('justifyLeft', '⇤', 'Align left')}${tool('justifyCenter', '↔', 'Centre')}
        ${tool('createLink', '🔗', 'Add a link')}${tool('removeFormat', '✕ Style', 'Clear style')}
        <span class="msg-sep"></span>
        ${MSG_EMOJI.map(e => tool('insertText', e, `Insert ${e}`, e)).join('')}
      </div>`;
    const sent = state.msg?.sent || [];
    const fmt = at => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const rows = sent.map(m => `<div class="msg-sent-row">
        <div class="msg-sent-main">
          <strong>${m.kind === 'gift' ? '🎁 ' : m.kind === 'score' ? '📈 ' : ''}${esc(m.title)}</strong>
          <span class="muted">${esc(m.preview)}</span>
          <span class="muted msg-sent-meta">${esc(fmt(m.at))} · to ${m.to ? esc(m.to.join(', ')) : `${m.recipients} students`}${m.gift ? ` · gift: ${[m.gift.speaking ? `${m.gift.speaking} speaking` : '', m.gift.writing ? `${m.gift.writing} writing` : ''].filter(Boolean).join(' + ')}` : ''}</span>
        </div>
        <div class="msg-sent-stats">
          <span><b>${m.read}</b>/${m.recipients} read</span>
          ${m.gift ? `<span><b>${m.claimed}</b>/${m.recipients} activated</span>` : ''}
          <button type="button" class="btn btn-ghost btn-sm" data-msg-withdraw="${esc(m.batch)}" data-title="${esc(m.title)}">Withdraw</button>
        </div>
      </div>`).join('');

    return `<div class="card msg-card" id="msg-card" style="margin-top:28px">
      <div class="row" style="justify-content:space-between">
        <h2 style="font-size:18px">Messages</h2>
        <button class="btn btn-ghost btn-sm" data-action="msg-close">Close</button>
      </div>
      <form class="msg-compose" id="msg-compose">
        <div class="msg-field"><span class="msg-label">To</span>
          <div class="row" style="gap:6px;flex-wrap:wrap">${toBtn('all', 'Every student')}${toBtn('course', 'My course students')}${toBtn('pick', 'Chosen students')}</div>
          ${d.to === 'course' ? '<span class="muted" style="font-size:12px">The students whose Gmail you linked in Course students.</span>' : ''}
          ${picker}
        </div>
        <label class="msg-field"><span class="msg-label">Title</span>
          <input id="msg-title" type="text" maxlength="140" placeholder="e.g. New: vocabulary homework on the website" value="${esc(d.title)}"></label>
        <div class="msg-field"><span class="msg-label">Message</span>
          ${toolbar}
          <div id="msg-editor" class="msg-editor msg-body" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message text" data-placeholder="Write your message…"></div>
        </div>
        <div class="msg-gift ${d.giftOn ? 'is-on' : ''}">
          <label class="msg-gift-toggle"><input type="checkbox" id="msg-gift-on" ${d.giftOn ? 'checked' : ''}> 🎁 Add a gift of mocks</label>
          ${d.giftOn ? `<div class="row" style="gap:12px;flex-wrap:wrap;align-items:center">
            <label>Speaking <input type="number" id="msg-gs" min="0" max="${state.msg?.maxGift || 10}" value="${esc(d.gs)}"></label>
            <label>Writing <input type="number" id="msg-gw" min="0" max="${state.msg?.maxGift || 10}" value="${esc(d.gw)}"></label>
            <span class="muted" style="font-size:12px">Each student gets their own gift. The mocks go on their account when they press Activate — not before.</span>
          </div>` : ''}
        </div>
        <div class="row" style="gap:8px;justify-content:flex-end;flex-wrap:wrap">
          <button type="button" class="btn btn-ghost btn-sm" data-msg-clear>Clear</button>
          <button type="submit" class="btn" ${state.loading ? 'disabled' : ''}>${state.loading ? 'Sending…' : 'Send message'}</button>
        </div>
      </form>
      <h3 class="msg-sent-title">Sent</h3>
      ${rows || '<p class="muted" style="font-size:13px">Nothing sent yet.</p>'}
      <p class="muted" style="font-size:12px;margin-top:8px">Score updates from an expert review (📈) are written to the student by the site itself and appear here too.</p>
    </div>`;
  }

  async function loadMessages({ open } = {}) {
    setState({ msgOpen: open || state.msgOpen, loading: true, error: '' });
    try { setState({ msg: await api('/admin/messages'), loading: false }); }
    catch (error) { setState({ loading: false, error: error.message }); }
  }

  let msgFindTimer = null;
  function wireMessagesAdmin() {
    root.querySelectorAll('[data-msg-write]').forEach(el => el.addEventListener('click', () => {
      state.msgDraft.to = 'pick';
      if (!state.msgDraft.picked.some(p => p.id === el.dataset.msgWrite)) state.msgDraft.picked.push({ id: el.dataset.msgWrite, name: el.dataset.name, email: el.dataset.email });
      loadMessages({ open: true }).then(() => document.getElementById('msg-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }));
    if (!state.msgOpen) return;
    const d = state.msgDraft;
    const editor = document.getElementById('msg-editor');
    if (editor) {
      editor.innerHTML = d.html;
      editor.addEventListener('input', () => { d.html = editor.innerHTML; });
      editor.addEventListener('paste', e => {
        // Pasted text comes in plain, so another site's fonts and layout never arrive with it.
        e.preventDefault();
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
      });
    }
    root.querySelectorAll('[data-msg-cmd]').forEach(el => {
      el.addEventListener('mousedown', e => e.preventDefault());   // keep the selection in the editor
      el.addEventListener('click', () => {
        if (!editor) return;
        editor.focus();
        const cmd = el.dataset.msgCmd;
        let arg = el.dataset.arg || null;
        if (cmd === 'createLink') {
          arg = window.prompt('Link address (https://…)', 'https://');
          if (!arg || !/^https?:\/\/\S+$/i.test(arg)) return;
        }
        try { document.execCommand('styleWithCSS', false, true); } catch { /* old browsers */ }
        document.execCommand(cmd, false, cmd === 'formatBlock' ? `<${arg}>` : arg);
        d.html = editor.innerHTML;
      });
    });
    root.querySelectorAll('[data-msg-to]').forEach(el => el.addEventListener('click', () => { d.to = el.dataset.msgTo; render(); }));
    document.getElementById('msg-title')?.addEventListener('input', e => { d.title = e.target.value; });
    document.getElementById('msg-gift-on')?.addEventListener('change', e => { d.giftOn = e.target.checked; render(); });
    document.getElementById('msg-gs')?.addEventListener('input', e => { d.gs = e.target.value; });
    document.getElementById('msg-gw')?.addEventListener('input', e => { d.gw = e.target.value; });
    const find = document.getElementById('msg-find');
    find?.addEventListener('input', () => {
      state.msgFind = find.value;
      clearTimeout(msgFindTimer);
      msgFindTimer = setTimeout(async () => {
        const q = state.msgFind.trim();
        if (q.length < 2) { state.msgFound = []; return render(); }
        try {
          const data = await api(`/admin/students?${new URLSearchParams({ search: q })}`);
          state.msgFound = (data.students || []).filter(s => s.role === 'student').slice(0, 8);
        } catch { state.msgFound = []; }
        render();
        const again = document.getElementById('msg-find');
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      }, 300);
    });
    root.querySelectorAll('[data-msg-pick]').forEach(el => el.addEventListener('click', () => {
      d.picked.push({ id: el.dataset.msgPick, name: el.dataset.name, email: el.dataset.email });
      state.msgFind = ''; state.msgFound = [];
      render();
      document.getElementById('msg-find')?.focus();
    }));
    root.querySelectorAll('[data-msg-unpick]').forEach(el => el.addEventListener('click', () => {
      d.picked = d.picked.filter(p => p.id !== el.dataset.msgUnpick);
      render();
    }));
    root.querySelector('[data-msg-clear]')?.addEventListener('click', () => {
      state.msgDraft = { to: d.to, picked: d.picked, title: '', html: '', giftOn: false, gs: 1, gw: 0 };
      render();
    });
    document.getElementById('msg-compose')?.addEventListener('submit', async e => {
      e.preventDefault();
      if (editor) d.html = editor.innerHTML;
      if (d.to === 'pick' && !d.picked.length) return setState({ error: 'Choose at least one student.' });
      const who = d.to === 'all' ? 'EVERY student' : d.to === 'course' ? 'all your course students' : `${d.picked.length} student${d.picked.length === 1 ? '' : 's'}`;
      const gift = d.giftOn ? { speaking: Number(d.gs) || 0, writing: Number(d.gw) || 0 } : null;
      if (d.giftOn && !gift.speaking && !gift.writing) return setState({ error: 'Put at least one mock in the gift, or untick it.' });
      if (!window.confirm(`Send "${d.title || '(no title)'}" to ${who}?${gift ? `\nEach gets a gift: ${gift.speaking} speaking + ${gift.writing} writing.` : ''}`)) return;
      setState({ loading: true, error: '', notice: '' });
      try {
        const out = await api('/admin/messages', {
          method: 'POST',
          body: { to: d.to === 'pick' ? d.picked.map(p => p.id) : d.to, title: d.title, html: d.html, gift }
        });
        state.msgDraft = { to: d.to, picked: d.to === 'pick' ? [] : d.picked, title: '', html: '', giftOn: false, gs: 1, gw: 0 };
        setState({ loading: false, msg: { ...(state.msg || {}), sent: out.list }, notice: `Message sent to ${out.sent} student${out.sent === 1 ? '' : 's'}.` });
      } catch (error) { setState({ loading: false, error: error.message }); }
    });
    root.querySelectorAll('[data-msg-withdraw]').forEach(el => el.addEventListener('click', async () => {
      if (!window.confirm(`Withdraw "${el.dataset.title}" from every student who got it?\nGifts already activated keep their mocks.`)) return;
      try {
        const out = await api(`/admin/messages/${el.dataset.msgWithdraw}`, { method: 'DELETE' });
        setState({ msg: { ...(state.msg || {}), sent: out.list }, notice: `Withdrawn from ${out.removed} student${out.removed === 1 ? '' : 's'}.` });
      } catch (error) { setState({ error: error.message }); }
    }));
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
          : action === 'confirm-email'
          ? `${data.email}: email confirmed — they can use the site now.`
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
      loadTests().then(() => { refreshSupportBadge(); return restoreAfterRefresh().catch(() => {}); }, () => signOut());
      return;
    }
    render();
  })();
})();
