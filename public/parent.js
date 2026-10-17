/*
 * Ota-onalar kabineti — the parents' page.
 *
 * A parent types the family's 6-digit code and sees their children. With
 * brothers and sisters, a list of the children comes first; tapping a child
 * opens their page: a big round photo, name, current CEFR level, the six
 * homework types (vocabulary, grammar, listening, reading, speaking, writing)
 * homework by homework and level by level, and this month's ranking of the
 * child's level. "Remember on this phone" keeps them signed in.
 *
 * Buildless, like the rest of the client. All text is Uzbek.
 */
(() => {
  'use strict';

  const API = '/api/parent';
  const root = document.getElementById('root');

  const T = {
    brand: 'English Hub Family',
    title: 'Ota-onalar kabineti',
    intro: 'Farzandingizning ingliz tilidagi natijalarini shu yerda kuzatasiz. Ustoz bergan 6 xonali kodni kiriting.',
    codeLabel: '6 xonali kod',
    remember: 'Bu qurilmada eslab qolish',
    rememberHint: 'Keyingi safar kodni qayta yozish shart emas.',
    signIn: 'Kirish',
    signingIn: 'Tekshirilmoqda…',
    noCode: 'Kodni bilmasangiz, farzandingizning ustoziga murojaat qiling.',
    home: 'Asosiy sahifa',
    signOut: 'Chiqish',
    myChildren: 'Farzandlarim',
    pickChild: 'Natijalarini ko‘rish uchun farzandingizni tanlang.',
    back: 'Farzandlarim',
    level: 'Daraja',
    overall: 'Umumiy natija',
    overallNote: 'Oltita yo‘nalish bo‘yicha oxirgi natijalar o‘rtachasi',
    lastTest: 'Oxirgi uy vazifasi',
    monthAvg: m => `${m} oyi o‘rtachasi`,
    place: (r, n) => `${r}-o‘rin · ${n} nafardan`,
    noPlace: 'Bu oy hali uy vazifasi yo‘q',
    skillsTitle: 'Yo‘nalishlar',
    skillsNote: 'Oxirgi natija va undan oldingisiga nisbatan o‘zgarish',
    byLevelTitle: 'Darajalar bo‘yicha',
    byLevelNote: 'Har bir darajada o‘rtacha natija (%)',
    historyTitle: 'Uy vazifalari tarixi',
    tests: n => `${n} ta uy vazifasi`,
    rankTitle: (lvl, m) => `${lvl} darajasi reytingi — ${m}`,
    rankNote: 'Shu oydagi barcha uy vazifalari o‘rtachasi bo‘yicha',
    rankNo: 'O‘rin', rankName: 'Ism', rankPct: 'Natija',
    noHomework: 'vazifa yo‘q',
    you: 'farzandingiz',
    empty: 'Hali natijalar kiritilmagan. Ustoz birinchi uy vazifasidan keyin natijalarni kiritadi.',
    noScore: '—',
    first: 'birinchi natija',
    same: 'o‘zgarmagan',
    sincePrev: 'oldingisiga nisbatan',
    test: 'Uy vazifasi',
    date: 'Sana',
    lvl: 'Daraja',
    good: 'Yaxshi', mid: 'O‘rtacha', low: 'E’tibor kerak',
    loading: 'Yuklanmoqda…',
    footer: 'Natijalarni ustoz har bir darsdan keyin kiritadi.'
  };

  const SKILL = {
    vocabulary: 'Lug‘at',
    grammar: 'Grammatika',
    listening: 'Tinglab tushunish',
    reading: 'O‘qib tushunish',
    speaking: 'Gapirish',
    writing: 'Yozish'
  };
  const LEVEL_NAME = { A1: 'Boshlang‘ich', A2: 'Elementar', B1: 'O‘rta', B2: 'O‘rtadan yuqori', C1: 'Yuqori' };
  const MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtDate = d => { const x = new Date(d); return `${x.getDate()}-${MONTHS[x.getMonth()]} ${x.getFullYear()}`; };
  const monthName = ym => { const [y, m] = String(ym).split('-'); return `${MONTHS[Number(m) - 1] || ''} ${y}`; };
  const monthOnly = ym => MONTHS[Number(String(ym).split('-')[1]) - 1] || '';
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const band = v => (v === null || v === undefined ? '' : v >= 75 ? 'is-good' : v >= 50 ? 'is-mid' : 'is-low');
  const bandWord = v => (v === null || v === undefined ? '' : v >= 75 ? T.good : v >= 50 ? T.mid : T.low);
  const initials = name => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const pct = v => (v === null || v === undefined ? T.noScore : `${Number.isInteger(v) ? v : v.toFixed(1)}%`);

  // The token lives in localStorage when "remember" is ticked, otherwise only for this tab.
  const KEY = 'parentToken';
  const store = {
    get() { try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY); } catch { return null; } },
    set(token, remember) {
      try {
        localStorage.removeItem(KEY); sessionStorage.removeItem(KEY);
        (remember ? localStorage : sessionStorage).setItem(KEY, token);
      } catch { /* private mode: signed in for this visit only */ }
    },
    clear() { try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch { /* nothing */ } }
  };

  const state = {
    screen: 'login', token: null, children: [], child: null,
    error: '', busy: false, remember: true, code: ''
  };
  const photos = new Map();   // "id:version" -> blob URL

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let payload = {};
    try { payload = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const error = new Error(payload.message || 'Xatolik yuz berdi. Qayta urinib ko‘ring.');
      error.status = res.status;
      throw error;
    }
    return payload.data;
  }

  // ------------------------------------------------------------------ login

  function loginScreen() {
    return `
      <main class="pp-login">
        <div class="pp-login-card">
          <a class="pp-brand" href="/"><img src="/favicon.svg" alt="" width="34" height="34"><span>${T.brand}</span></a>
          <h1>${T.title}</h1>
          <p class="pp-intro">${T.intro}</p>
          <form id="pp-form" novalidate>
            <label class="pp-code-label" for="pp-code">${T.codeLabel}</label>
            <div class="pp-code">
              <input id="pp-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*"
                maxlength="6" value="${esc(state.code)}" aria-describedby="pp-err" autofocus>
              <div class="pp-code-boxes" aria-hidden="true">${[0, 1, 2, 3, 4, 5].map(i => `<span class="${i < state.code.length ? 'is-on' : ''} ${i === state.code.length ? 'is-next' : ''}">${esc(state.code[i] || '')}</span>`).join('')}</div>
            </div>
            <label class="pp-remember">
              <input type="checkbox" id="pp-remember" ${state.remember ? 'checked' : ''}>
              <span><strong>${T.remember}</strong><small>${T.rememberHint}</small></span>
            </label>
            <div id="pp-err" class="pp-error" role="alert">${esc(state.error)}</div>
            <button class="btn btn-lg btn-block" type="submit" ${state.busy || state.code.length < 6 ? 'disabled' : ''}>${state.busy ? T.signingIn : T.signIn}</button>
          </form>
          <p class="pp-help">${T.noCode}</p>
        </div>
        <a class="pp-home" href="/">← ${T.home}</a>
      </main>`;
  }

  function wireLogin() {
    const input = document.getElementById('pp-code');
    input?.addEventListener('input', () => {
      state.code = input.value.replace(/\D/g, '').slice(0, 6);
      state.error = '';
      const pos = state.code.length;
      render();
      const again = document.getElementById('pp-code');
      again.focus();
      again.setSelectionRange(pos, pos);
      if (state.code.length === 6) signIn();
    });
    document.getElementById('pp-remember')?.addEventListener('change', e => { state.remember = e.target.checked; });
    document.getElementById('pp-form')?.addEventListener('submit', e => { e.preventDefault(); signIn(); });
  }

  async function signIn() {
    if (state.busy || state.code.length !== 6) return;
    state.busy = true; state.error = ''; render();
    try {
      const { token } = await api('/login', { method: 'POST', body: { code: state.code, remember: state.remember } });
      state.token = token;
      store.set(token, state.remember);
      state.code = '';
      await loadChildren();
    } catch (error) {
      state.error = error.message;
      state.busy = false;
      state.code = '';
      render();
      document.getElementById('pp-code')?.focus();
    }
  }

  function signOut() {
    store.clear();
    for (const url of photos.values()) URL.revokeObjectURL(url);
    photos.clear();
    Object.assign(state, { screen: 'login', token: null, children: [], child: null, error: '', busy: false, code: '' });
    render();
  }

  function lostSignIn(error) {
    store.clear();
    Object.assign(state, {
      screen: 'login', token: null, busy: false,
      error: error.status === 401 ? error.message : 'Ulanishda xatolik. Internetni tekshirib, qayta urinib ko‘ring.'
    });
    render();
  }

  // --------------------------------------------------------------- children

  async function loadChildren() {
    state.screen = 'loading'; render();
    try {
      const { children } = await api('/children');
      state.children = children;
      state.busy = false;
      if (children.length === 1) return openChild(children[0].id);
      state.screen = 'children';
      render();
      children.forEach(loadPhoto);
    } catch (error) { lostSignIn(error); }
  }

  async function openChild(id) {
    state.screen = 'loading'; render();
    try {
      state.child = await api(`/children/${id}`);
      state.screen = 'child';
      render();
      window.scrollTo(0, 0);
      loadPhoto(state.child);
    } catch (error) { lostSignIn(error); }
  }

  /** Photos need the sign-in, so they are fetched and shown from memory. */
  async function loadPhoto(c) {
    if (!c?.hasPhoto) return;
    const key = `${c.id}:${c.photoVersion}`;
    if (!photos.has(key)) {
      try {
        const res = await fetch(`${API}/children/${c.id}/photo`, { headers: { Authorization: `Bearer ${state.token}` } });
        if (!res.ok) return;
        photos.set(key, URL.createObjectURL(await res.blob()));
      } catch { return; }
    }
    root.querySelectorAll(`[data-photo="${c.id}"]`).forEach(el => {
      const img = el.querySelector('img');
      img.src = photos.get(key);
      el.classList.add('has-photo');
    });
  }

  const avatar = (c, cls = '') => {
    const url = c.hasPhoto ? photos.get(`${c.id}:${c.photoVersion}`) : '';
    return `<div class="pp-avatar ${cls} ${url ? 'has-photo' : ''}" data-photo="${esc(c.id)}">
      <img alt="${esc(c.name)}" src="${esc(url || '')}"><span>${esc(initials(c.name))}</span></div>`;
  };

  const topBar = () => `
    <header class="pp-bar-top">
      <a class="pp-brand" href="/"><img src="/favicon.svg" alt="" width="30" height="30"><span>${T.brand}</span></a>
      <button class="btn btn-ghost btn-sm" data-action="signout">${T.signOut}</button>
    </header>`;

  function childrenScreen() {
    return `${topBar()}
      <main class="pp-dash">
        <section class="pp-family">
          <h1>${T.myChildren}</h1>
          <p>${T.pickChild}</p>
          <div class="pp-kids">
            ${state.children.map(c => `
              <button class="pp-kid" data-child="${esc(c.id)}">
                ${avatar(c, 'is-medium')}
                <strong>${esc(c.name)}</strong>
                <span class="pp-lvl">${esc(c.level)}</span>
                <small>${esc(LEVEL_NAME[c.level] || '')}</small>
              </button>`).join('')}
          </div>
        </section>
      </main>`;
  }

  // -------------------------------------------------------------- one child

  /** A small line of one type across the homeworks (oldest to newest). */
  function sparkline(values) {
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => v !== null);
    if (pts.length < 2) return '';
    const W = 120, H = 34, P = 3;
    const n = values.length - 1 || 1;
    const x = i => P + (i / n) * (W - 2 * P);
    // Fitted to this child's own range (at least 20 points tall), so progress shows.
    const vals = pts.map(([, v]) => v);
    let lo = Math.max(0, Math.min(...vals) - 6), hi = Math.min(100, Math.max(...vals) + 6);
    if (hi - lo < 20) { const mid = (hi + lo) / 2; lo = Math.max(0, mid - 10); hi = Math.min(100, lo + 20); }
    const y = v => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
    const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const area = `${d} L${x(pts[pts.length - 1][0]).toFixed(1)} ${H - P} L${x(pts[0][0]).toFixed(1)} ${H - P} Z`;
    const [li, lv] = pts[pts.length - 1];
    return `<svg class="pp-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <path d="${area}" class="pp-spark-area"/><path d="${d}" class="pp-spark-line"/>
      <circle cx="${x(li)}" cy="${y(lv)}" r="3.2" class="pp-spark-dot"/></svg>`;
  }

  function change(now, before) {
    if (now === null) return '';
    if (before === null) return `<span class="pp-delta">${T.first}</span>`;
    const d = now - before;
    if (d === 0) return `<span class="pp-delta">${T.same}</span>`;
    return `<span class="pp-delta ${d > 0 ? 'is-up' : 'is-down'}">${d > 0 ? '▲ +' : '▼ −'}${Math.abs(d)} <span class="pp-muted">${T.sincePrev}</span></span>`;
  }

  function childScreen() {
    const d = state.child;
    const idx = d.levels.indexOf(d.level);
    const board = d.leaderboard;
    const me = board.rows.find(r => r.self);
    const rankedCount = board.rows.filter(r => r.rank !== null).length;

    const ladder = d.levels.map((l, i) => `
      <li class="${i < idx ? 'is-done' : ''} ${i === idx ? 'is-now' : ''}">
        <span class="pp-step">${l}</span><span class="pp-step-name">${LEVEL_NAME[l] || ''}</span>
      </li>`).join('');

    const skillCards = d.skills.map(k => {
      const v = d.latest[k];
      const series = d.results.map(r => r.skills[k]);
      return `
        <article class="pp-skill ${band(v)}">
          <header><h3>${SKILL[k]}</h3>${v !== null ? `<span class="pp-pill ${band(v)}">${bandWord(v)}</span>` : ''}</header>
          <div class="pp-skill-row">
            <div class="pp-skill-value">${v === null ? T.noScore : `${v}<small>%</small>`}</div>
            ${sparkline(series)}
          </div>
          <div class="pp-bar" role="img" aria-label="${SKILL[k]} ${v ?? 0}%"><span style="width:${v ?? 0}%"></span></div>
          ${change(v, d.previous[k])}
        </article>`;
    }).join('');

    const ranking = board.rows.length ? `
      <section class="pp-card" id="pp-rank">
        <div class="pp-card-head"><h2>${T.rankTitle(esc(board.level), monthName(board.month))}</h2><p>${T.rankNote}</p></div>
        <ol class="pp-rank">
          ${board.rows.map(r => `
            <li class="${r.mine ? 'is-mine' : ''} ${r.rank === null ? 'is-unranked' : ''} ${r.rank && r.rank <= 3 ? `is-top is-top${r.rank}` : ''}">
              <span class="pp-rank-no">${r.rank ?? '—'}</span>
              <span class="pp-rank-name">${esc(r.name)}${r.mine ? ` <em>${T.you}</em>` : ''}</span>
              <span class="pp-lvl">${esc(r.level)}</span>
              <span class="pp-rank-pct ${band(r.percent)}">${r.percent === null ? `<small>${T.noHomework}</small>` : pct(r.percent)}</span>
            </li>`).join('')}
        </ol>
      </section>` : '';

    const byLevel = d.levelsStudied.length ? `
      <section class="pp-card">
        <div class="pp-card-head"><h2>${T.byLevelTitle}</h2><p>${T.byLevelNote}</p></div>
        <div class="pp-table-wrap">
          <table class="pp-matrix">
            <thead><tr><th>${T.lvl}</th>${d.skills.map(k => `<th>${SKILL[k]}</th>`).join('')}<th>${T.overall}</th></tr></thead>
            <tbody>${d.levelsStudied.map(l => `
              <tr><th scope="row"><span class="pp-lvl">${l.level}</span><small>${T.tests(l.tests)}</small></th>
                ${d.skills.map(k => `<td class="${band(l.skills[k])}">${l.skills[k] ?? T.noScore}</td>`).join('')}
                <td class="pp-strong ${band(l.overall)}">${l.overall ?? T.noScore}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>` : '';

    const history = d.results.length ? `
      <section class="pp-card">
        <div class="pp-card-head"><h2>${T.historyTitle}</h2><p>${T.tests(d.results.length)}</p></div>
        <div class="pp-table-wrap">
          <table class="pp-history">
            <thead><tr><th>${T.date}</th><th>${T.test}</th><th>${T.lvl}</th>${d.skills.map(k => `<th>${SKILL[k]}</th>`).join('')}</tr></thead>
            <tbody>${[...d.results].reverse().map(r => `
              <tr><td class="pp-nowrap">${fmtDate(r.date)}</td><td>${esc(r.title) || '—'}</td><td><span class="pp-lvl">${r.level}</span></td>
                ${d.skills.map(k => `<td class="${band(r.skills[k])}">${r.skills[k] ?? T.noScore}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>` : '';

    return `${topBar()}
      <main class="pp-dash">
        ${state.children.length > 1 ? `<button class="pp-back" data-action="back">← ${T.back}</button>` : ''}
        <section class="pp-hero">
          ${avatar(d, 'is-big')}
          <h1>${esc(d.name)}</h1>
          <div class="pp-level-now">${T.level}: <strong>${esc(d.level)}</strong> · ${esc(LEVEL_NAME[d.level] || '')}</div>
          <ol class="pp-ladder">${ladder}</ol>
        </section>

        <section class="pp-overall">
          <div class="pp-ring ${band(d.month.percent)}" style="--p:${d.month.percent ?? 0}">
            <div><strong>${d.month.percent === null ? T.noScore : Math.round(d.month.percent)}</strong>${d.month.percent !== null ? '<small>%</small>' : ''}</div>
          </div>
          <div class="pp-overall-text">
            <h2>${cap(T.monthAvg(monthOnly(board.month)))}</h2>
            <p class="pp-place">${me && me.rank ? `<a href="#pp-rank">${T.place(me.rank, rankedCount)}</a>` : T.noPlace}</p>
            ${d.lastTest ? `<p class="pp-muted">${T.lastTest}: <strong>${fmtDate(d.lastTest)}</strong></p>` : ''}
          </div>
        </section>

        ${d.results.length ? `
        <section class="pp-card">
          <div class="pp-card-head"><h2>${T.skillsTitle}</h2><p>${T.skillsNote}</p></div>
          <div class="pp-skills">${skillCards}</div>
        </section>` : `<section class="pp-card pp-empty"><p>${T.empty}</p></section>`}
        ${ranking}
        ${byLevel}
        ${history}

        <p class="pp-foot">${T.footer}</p>
      </main>`;
  }

  // ----------------------------------------------------------------- render

  function render() {
    root.innerHTML = state.screen === 'child' ? childScreen()
      : state.screen === 'children' ? childrenScreen()
      : state.screen === 'loading' ? `<main class="pp-loading"><span class="spinner"></span><p>${T.loading}</p></main>`
      : loginScreen();
    if (state.screen === 'login') wireLogin();
    root.querySelector('[data-action="signout"]')?.addEventListener('click', signOut);
    root.querySelector('[data-action="back"]')?.addEventListener('click', () => {
      state.screen = 'children'; state.child = null; render(); state.children.forEach(loadPhoto);
    });
    root.querySelectorAll('[data-child]').forEach(el => el.addEventListener('click', () => openChild(el.dataset.child)));
  }

  const saved = store.get();
  if (saved) { state.token = saved; loadChildren(); } else render();
})();
