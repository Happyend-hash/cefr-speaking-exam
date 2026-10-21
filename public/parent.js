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
    // payment
    payPaid: m => `${m} oyi uchun to‘lov: To‘langan`,
    payPartial: m => `${m} oyi uchun to‘lov: Qisman to‘langan`,
    payDue: (m, d) => `${m} oyi uchun to‘lov: ${d}\u2011${m.toLowerCase()}gacha to‘lash kerak`,
    payOverdue: m => `Siz ${m} oyi uchun to‘lov qilishingiz kerak`,
    payOverduePart: m => `Siz ${m} oyi uchun to‘lovni to‘liq qilishingiz kerak`,
    left: 'qolgan',
    deadlineWas: (d, m) => `to‘lov muddati ${d}\u2011${m.toLowerCase()} edi`,
    badgePaid: 'To‘langan', badgePartial: 'Qisman to‘langan', badgeDue: 'To‘lov 10-gacha', badgeOverdue: 'To‘lov kerak',
    payHistTitle: 'To‘lovlar tarixi',
    // attendance
    attTitle: m => `Davomat — ${m}`,
    attLessons: 'Darslar', attPresent: 'Keldi', attLate: 'Kechikdi', attAbsent: 'Kelmadi',
    attPercent: p => `Darslarning ${p} foiziga qatnashdi`,
    attMissed: 'Kelmagan kunlar',
    attLateDays: 'Kechikkan kunlar',
    attNoMiss: 'Bu oy birorta ham darsni qoldirmadi. Barakalla!',
    attNone: 'Bu oy hali davomat kiritilmagan.',
    attPrev: 'Oldingi oylar',
    attPrevRow: (a, l) => `${a}/${l} dars`,
    noLesson: 'dars yo‘q',
    // vocabulary units
    vocabTitle: l => `Lug‘at bo‘limlari (Unit) — ${l}`,
    vocabDone: (d, n) => `${n} ta unitdan ${d} tasi topshirildi`,
    vocabUnitAvg: 'Unitlar o‘rtachasi',
    vocabGeneral: 'Umumiy test',
    vocabNow: 'Hozirgi natija',
    vocabNote: 'Umumiy test natijasi har bir unit natijasini yangilaydi. Oldingi natijalar ham ko‘rsatiladi.',
    vocabWeak: 'Qayta takrorlash kerak (60% dan past)',
    vocabUnit: n => `${n}-unit`,
    vocabWas: p => `avval ${p}%`,
    vocabAll: 'Barcha unitlar',
    vocabNotYet: 'hali yo‘q',
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
  const WEEKDAYS = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];
  const WEEK_SHORT = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];
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
  const money = n => `${Math.round(n || 0).toLocaleString('en-US').replace(/,/g, ' ')} so‘m`;
  /** "2026-10-09" -> "9-oktabr, payshanba" (dates are lesson days, not moments). */
  const dayName = iso => { const [y, m, d] = iso.split('-').map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return `${d}-${MONTHS[m - 1]}, ${WEEKDAYS[w]}`; };
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

  function payBadge(p) {
    if (!p) return '';
    const [cls, text] = { paid: ['is-paid', T.badgePaid], partial: ['is-partial', T.badgePartial], due: ['is-due', T.badgeDue], overdue: ['is-overdue', T.badgeOverdue] }[p.status] || [];
    return cls ? `<span class="pp-paybadge ${cls}">${text}</span>` : '';
  }

  /** The payment banner at the top of a child's page. */
  function paymentBanner(p) {
    const m = cap(monthOnly(p.month));
    const last = p.lastPaidAt ? fmtDate(p.lastPaidAt) : '';
    let cls, icon, title, sub;
    if (p.status === 'paid') {
      cls = 'is-paid'; icon = '✓'; title = T.payPaid(m);
      sub = [p.paid ? money(p.paid) : '', last].filter(Boolean).join(' · ');
    } else if (p.status === 'partial' && !p.overdue) {
      cls = 'is-partial'; icon = '◐'; title = T.payPartial(m);
      sub = `${money(p.paid)}${p.fee ? ` / ${money(p.fee)} · ${T.left} ${money(p.left)}` : ''}`;
    } else if (p.status === 'partial') {
      cls = 'is-overdue'; icon = '!'; title = T.payOverduePart(m);
      sub = `${T.left} ${money(p.left)} · ${T.deadlineWas(p.dueDay, m)}`;
    } else if (p.status === 'due') {
      cls = 'is-due'; icon = '⏳'; title = T.payDue(m, p.dueDay);
      sub = p.fee ? money(p.fee) : '';
    } else {
      cls = 'is-overdue'; icon = '!'; title = T.payOverdue(m);
      sub = [p.fee ? money(p.fee) : '', T.deadlineWas(p.dueDay, m)].filter(Boolean).join(' · ');
    }
    return `<section class="pp-pay ${cls}" role="status">
      <span class="pp-pay-icon" aria-hidden="true">${icon}</span>
      <div><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
    </section>`;
  }

  /** Attendance this month: counts, a calendar of lesson days, and the days missed. */
  function attendanceCard(a, history) {
    const m = monthName(a.month);
    if (!a.lessons) {
      return `<section class="pp-card"><div class="pp-card-head"><h2>${T.attTitle(m)}</h2></div><p class="pp-muted">${T.attNone}</p></section>`;
    }
    const [y, mo] = a.month.split('-').map(Number);
    const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const lead = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7;   // Monday first
    const marks = Object.fromEntries(a.days.map(d => [d.date, d.status]));
    const word = { present: T.attPresent, late: T.attLate, absent: T.attAbsent };
    const cells = [];
    for (let i = 0; i < lead; i += 1) cells.push('<span class="pp-cal-pad"></span>');
    for (let d = 1; d <= daysIn; d += 1) {
      const key = `${a.month}-${String(d).padStart(2, '0')}`;
      const st = marks[key];
      cells.push(`<span class="pp-cal-day ${st ? `is-${st}` : ''}" title="${esc(dayName(key))}: ${st ? word[st] : T.noLesson}">${d}</span>`);
    }
    return `<section class="pp-card pp-att">
      <div class="pp-card-head"><h2>${T.attTitle(m)}</h2><p>${T.attPercent(a.percent)}</p></div>
      <div class="pp-att-stats">
        <div><strong>${a.lessons}</strong><span>${T.attLessons}</span></div>
        <div class="is-present"><strong>${a.present}</strong><span>${T.attPresent}</span></div>
        <div class="is-late"><strong>${a.late}</strong><span>${T.attLate}</span></div>
        <div class="is-absent"><strong>${a.absent}</strong><span>${T.attAbsent}</span></div>
      </div>
      <div class="pp-att-bar" role="img" aria-label="${T.attPercent(a.percent)}">
        <span class="is-present" style="width:${(a.present / a.lessons) * 100}%"></span><span class="is-late" style="width:${(a.late / a.lessons) * 100}%"></span><span class="is-absent" style="width:${(a.absent / a.lessons) * 100}%"></span>
      </div>
      <div class="pp-cal">
        ${WEEK_SHORT.map(w => `<span class="pp-cal-head">${w}</span>`).join('')}
        ${cells.join('')}
      </div>
      <div class="pp-cal-key"><span><i class="is-present"></i>${T.attPresent}</span><span><i class="is-late"></i>${T.attLate}</span><span><i class="is-absent"></i>${T.attAbsent}</span><span><i></i>${T.noLesson}</span></div>
      ${a.missed.length ? `<div class="pp-days is-absent"><h3>${T.attMissed} (${a.missed.length})</h3><div>${a.missed.map(d => `<span>${esc(dayName(d))}</span>`).join('')}</div></div>`
        : `<p class="pp-att-good">${T.attNoMiss}</p>`}
      ${a.lateDays.length ? `<div class="pp-days is-late"><h3>${T.attLateDays} (${a.lateDays.length})</h3><div>${a.lateDays.map(d => `<span>${esc(dayName(d))}</span>`).join('')}</div></div>` : ''}
      ${history?.length ? `<div class="pp-att-prev"><h3>${T.attPrev}</h3>${history.map(h => `<div><span>${esc(cap(monthName(h.month)))}</span><span>${T.attPrevRow(h.attended, h.lessons)}${h.absent ? ` · <b class="pp-red">${h.absent} ${T.attAbsent.toLowerCase()}</b>` : ''}</span></div>`).join('')}</div>` : ''}
    </section>`;
  }

  /** Vocabulary units: the current result of each unit, the general test, and the units to revise. */
  function vocabCard(v) {
    if (!v || (!v.done && !v.tests.length)) return '';
    const gen = v.latestTest;
    const chips = v.list.map(u => `
      <div class="pp-unit ${u.percent !== null && u.percent < 60 ? 'is-low' : band(u.percent)} ${u.percent === null ? 'is-empty' : ''}">
        <span>${T.vocabUnit(u.unit)}</span>
        <strong>${u.percent === null ? T.noScore : `${u.percent}%`}</strong>
        ${u.before !== null ? `<small>${T.vocabWas(u.before)}</small>` : ''}
      </div>`).join('');
    return `<section class="pp-card pp-vocab">
      <div class="pp-card-head"><h2>${T.vocabTitle(esc(v.level))}</h2><p>${T.vocabDone(v.done, v.units)}</p></div>
      <div class="pp-vocab-stats">
        ${v.unitAverage !== null ? `<div><span>${T.vocabUnitAvg}</span><strong class="${band(v.unitAverage)}">${pct(v.unitAverage)}</strong></div>` : ''}
        <div><span>${T.vocabGeneral}</span><strong class="${band(gen?.percent)}">${gen ? pct(gen.percent) : `<small>${T.vocabNotYet}</small>`}</strong>${gen ? `<small>${fmtDate(`${gen.date}T12:00:00`)}</small>` : ''}</div>
        ${gen && v.average !== null ? `<div><span>${T.vocabNow}</span><strong class="${band(v.average)}">${pct(v.average)}</strong></div>` : ''}
      </div>
      ${gen ? `<p class="pp-muted pp-vocab-note">${T.vocabNote}</p>` : ''}
      ${v.weak.length ? `<div class="pp-days is-absent"><h3>${T.vocabWeak}</h3><div>${v.weak.map(w => `<span>${T.vocabUnit(w.unit)} · ${w.percent}%</span>`).join('')}</div></div>` : ''}
      <div class="pp-units">${chips}</div>
    </section>`;
  }

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
                ${payBadge(c.payment)}
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
        ${paymentBanner(d.payment)}
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

        ${attendanceCard(d.attendance, d.attendanceHistory)}

        ${d.results.length ? `
        <section class="pp-card">
          <div class="pp-card-head"><h2>${T.skillsTitle}</h2><p>${T.skillsNote}</p></div>
          <div class="pp-skills">${skillCards}</div>
        </section>` : `<section class="pp-card pp-empty"><p>${T.empty}</p></section>`}
        ${vocabCard(d.vocab)}
        ${ranking}
        ${byLevel}
        ${history}
        ${d.paymentHistory?.length ? `<section class="pp-card"><div class="pp-card-head"><h2>${T.payHistTitle}</h2></div>
          <div class="pp-payhist">${d.paymentHistory.map(h => `<div><span>${esc(cap(monthName(h.month)))}</span>${payBadge(h)}${h.paid ? `<small>${money(h.paid)}</small>` : ''}</div>`).join('')}</div></section>` : ''}

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
