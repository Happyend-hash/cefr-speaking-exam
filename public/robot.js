/*
 * The robot teacher's face — an original SVG character for AI Ustoz.
 *
 * A friendly robot wearing a headset, its face on a screen. Everything moves:
 *   - the mouth opens and closes with the loudness of its voice;
 *   - the eyes blink, and change with its mood: listening, thinking, talking,
 *     happy, heart eyes (strong praise), surprised, sad/sympathetic, asleep;
 *   - the head floats, nods while talking and tilts while listening;
 *   - the light on the headset changes colour with the mood.
 * Moods come from what it is doing (setMode) and from what it says (setMood,
 * picked by app.js from the words of its replies).
 *
 * Usage:
 *   const r = RobotFace.mount(element, { getLevel });
 *   r.setMode('sleeping' | 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking');
 *   r.setMood('joy' | 'love' | 'surprised' | 'sad', ms);
 *   r.destroy();
 */
(function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let uid = 0;

  const heart = (cx, cy, s) =>
    `M ${cx} ${cy + 7 * s} C ${cx - 14 * s} ${cy - 3 * s}, ${cx - 9 * s} ${cy - 13 * s}, ${cx} ${cy - 6 * s} C ${cx + 9 * s} ${cy - 13 * s}, ${cx + 14 * s} ${cy - 3 * s}, ${cx} ${cy + 7 * s} Z`;

  function markup(id) {
    return `
<svg class="rb" viewBox="0 0 300 300" role="img" aria-hidden="true">
  <defs>
    <linearGradient id="${id}-head" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#c7cede"/>
    </linearGradient>
    <linearGradient id="${id}-screen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#241f5c"/><stop offset="1" stop-color="#151236"/>
    </linearGradient>
    <linearGradient id="${id}-cup" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#818cf8"/><stop offset="1" stop-color="#4338ca"/>
    </linearGradient>
    <filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="2.4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="${id}-clip"><rect x="80" y="102" width="140" height="106" rx="40"/></clipPath>
  </defs>

  <ellipse class="rb-shadow" cx="150" cy="276" rx="70" ry="9"/>
  <g class="rb-float">
    <g class="rb-head">
      <!-- headset band, its light, the ear cups and the microphone -->
      <path d="M 58 136 C 58 40, 242 40, 242 136" fill="none" stroke="#3730a3" stroke-width="11" stroke-linecap="round"/>
      <circle class="rb-light" cx="150" cy="54" r="8"/>
      <rect x="60" y="80" width="180" height="150" rx="66" fill="url(#${id}-head)"/>
      <rect x="60" y="80" width="180" height="150" rx="66" fill="none" stroke="#ffffff" stroke-opacity=".7" stroke-width="2"/>
      <rect x="38" y="122" width="32" height="62" rx="15" fill="url(#${id}-cup)"/>
      <rect x="230" y="122" width="32" height="62" rx="15" fill="url(#${id}-cup)"/>
      <path d="M 250 178 C 252 214, 228 226, 206 226" fill="none" stroke="#3730a3" stroke-width="6" stroke-linecap="round"/>
      <rect x="192" y="219" width="18" height="13" rx="6" fill="#6366f1"/>

      <!-- the screen -->
      <rect x="80" y="102" width="140" height="106" rx="40" fill="url(#${id}-screen)"/>
      <rect x="86" y="106" width="128" height="34" rx="17" fill="#ffffff" opacity=".05"/>

      <g clip-path="url(#${id}-clip)" filter="url(#${id}-glow)">
        <g class="rb-blush" opacity="0">
          <ellipse cx="104" cy="170" rx="11" ry="6" fill="#fb7185" opacity=".55"/>
          <ellipse cx="196" cy="170" rx="11" ry="6" fill="#fb7185" opacity=".55"/>
        </g>
        <g class="rb-look">
          <g class="rb-blink">
            <g class="rb-eyes" data-eyes="talk">
              <rect x="114" y="130" width="17" height="27" rx="8.5" fill="#a5f3fc"/>
              <rect x="169" y="130" width="17" height="27" rx="8.5" fill="#a5f3fc"/>
            </g>
            <g class="rb-eyes" data-eyes="listening">
              <circle cx="122.5" cy="143" r="13" fill="#a5f3fc"/><circle cx="177.5" cy="143" r="13" fill="#a5f3fc"/>
              <circle cx="127" cy="138" r="4" fill="#ffffff"/><circle cx="182" cy="138" r="4" fill="#ffffff"/>
            </g>
            <g class="rb-eyes" data-eyes="surprised">
              <circle cx="122.5" cy="144" r="15" fill="none" stroke="#a5f3fc" stroke-width="5"/>
              <circle cx="177.5" cy="144" r="15" fill="none" stroke="#a5f3fc" stroke-width="5"/>
              <circle cx="122.5" cy="144" r="6" fill="#a5f3fc"/><circle cx="177.5" cy="144" r="6" fill="#a5f3fc"/>
              <path d="M 108 121 Q 122 112 136 121 M 164 121 Q 178 112 192 121" fill="none" stroke="#a5f3fc" stroke-width="4" stroke-linecap="round"/>
            </g>
            <g class="rb-eyes" data-eyes="sad">
              <rect x="114" y="136" width="17" height="22" rx="8.5" fill="#a5f3fc"/>
              <rect x="169" y="136" width="17" height="22" rx="8.5" fill="#a5f3fc"/>
              <path d="M 108 128 L 134 122 M 166 122 L 192 128" fill="none" stroke="#a5f3fc" stroke-width="4" stroke-linecap="round"/>
              <path class="rb-tear" d="M 118 162 Q 112 172 118 176 Q 124 172 118 162 Z" fill="#7dd3fc"/>
            </g>
            <g class="rb-eyes" data-eyes="joy">
            <path d="M 110 148 Q 122.5 128 135 148 M 165 148 Q 177.5 128 190 148" fill="none" stroke="#a5f3fc" stroke-width="6" stroke-linecap="round"/>
          </g>
          <g class="rb-eyes" data-eyes="love">
            <path class="rb-heart" d="${heart(122.5, 143, 1.2)}" fill="#fb7185"/>
            <path class="rb-heart" d="${heart(177.5, 143, 1.2)}" fill="#fb7185"/>
          </g>
          <g class="rb-eyes" data-eyes="thinking">
            <rect x="120" y="126" width="15" height="22" rx="7.5" fill="#a5f3fc"/>
            <rect x="175" y="126" width="15" height="22" rx="7.5" fill="#a5f3fc"/>
            <g class="rb-dots"><circle cx="168" cy="186" r="3.5" fill="#a5f3fc"/><circle cx="180" cy="186" r="3.5" fill="#a5f3fc"/><circle cx="192" cy="186" r="3.5" fill="#a5f3fc"/></g>
          </g>
          <g class="rb-eyes" data-eyes="sleepy">
            <path d="M 110 144 Q 122.5 154 135 144 M 165 144 Q 177.5 154 190 144" fill="none" stroke="#a5f3fc" stroke-width="5" stroke-linecap="round"/>
          </g>
          </g>
        </g>
        <path class="rb-mouth" d="" fill="#a5f3fc" stroke="#a5f3fc" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    </g>
  </g>
  <g class="rb-zzz" font-family="Inter, system-ui, sans-serif" font-weight="800" fill="#c7d2fe">
    <text x="214" y="88" font-size="22">z</text><text x="232" y="66" font-size="28">z</text><text x="252" y="40" font-size="34">Z</text>
  </g>
</svg>`;
  }

  // What the face shows for each thing it can be doing, unless a mood is on.
  const MODE_FACE = { sleeping: 'sleepy', connecting: 'surprised', idle: 'joy', listening: 'listening', thinking: 'thinking', speaking: 'talk' };
  const LIGHT = {
    sleepy: '#64748b', surprised: '#fde047', joy: '#a5b4fc', listening: '#4ade80', thinking: '#fbbf24',
    talk: '#a5b4fc', love: '#fb7185', sad: '#7dd3fc'
  };

  function mount(el, { getLevel = () => 0 } = {}) {
    const id = `rb${++uid}`;
    el.innerHTML = markup(id);
    const $ = sel => el.querySelector(sel);
    const svg = $('.rb');
    const floatG = $('.rb-float'), headG = $('.rb-head'), blinkG = $('.rb-blink'), lookG = $('.rb-look');
    const mouth = $('.rb-mouth'), light = $('.rb-light'), blush = $('.rb-blush'), zzz = $('.rb-zzz'), shadow = $('.rb-shadow');
    const eyes = [...el.querySelectorAll('[data-eyes]')];
    const still = reducedMotion();

    let mode = 'sleeping', mood = null, moodUntil = 0, face = '';
    let open = 0, tilt = 0, tiltTarget = 0, nextPose = 0, nextBlink = performance.now() + 1500, blinkAt = -1;
    let alive = true, raf = 0, lookX = 0, lookY = 0, floatAmp = 2;

    // A change of expression happens behind a quick blink, like a cartoon
    // face: the eyes close, the new eyes are put in, they open again.
    let swapAt = -1, pending = '';
    function applyFace(next) {
      face = next;
      for (const g of eyes) g.classList.toggle('is-on', g.dataset.eyes === next);
      blush.style.opacity = next === 'joy' || next === 'love' ? '1' : '0';
      zzz.classList.toggle('is-on', next === 'sleepy');
      light.style.fill = LIGHT[next] || '#a5b4fc';
      svg.dataset.face = next;
    }
    function wantFace(next, now) {
      if (next === face || next === pending) return;
      if (!face || still) { applyFace(next); return; }
      pending = next;
      swapAt = now;
    }

    // The mouth is one shape — width, how much it smiles (or frowns), how
    // open it is, how round — and every expression is a target it eases to.
    const MOUTH = {
      joy: { w: 32, s: 8, h: 0, r: 0 }, talk: { w: 30, s: 3, h: 0, r: 0.3 }, listening: { w: 22, s: 4, h: 0, r: 0 },
      thinking: { w: 18, s: -1, h: 0, r: 0 }, sad: { w: 26, s: -7, h: 0, r: 0 }, surprised: { w: 14, s: 0, h: 13, r: 1 },
      sleepy: { w: 16, s: 0, h: 0, r: 0 }, love: { w: 30, s: 9, h: 2, r: 0 }
    };
    const m = { w: 16, s: 0, h: 0, r: 0 };
    function mouthPath(level) {
      const target = MOUTH[pending || face] || MOUTH.joy;
      const ease = 0.14;
      m.w += (target.w - level * 6 - m.w) * ease;
      m.s += (target.s - m.s) * ease;
      m.r += (target.r - m.r) * ease;
      const wantH = target.h + level * 17;
      m.h += (wantH - m.h) * (wantH > m.h ? 0.5 : 0.25);
      const y = 180, x0 = 150 - m.w / 2, x1 = 150 + m.w / 2;
      const topMid = y + m.s - m.h * 0.25 * (0.4 + m.r);
      const botMid = y + m.s + m.h;
      return `M ${x0.toFixed(2)} ${y} Q 150 ${(2 * topMid - y).toFixed(2)} ${x1.toFixed(2)} ${y} Q 150 ${(2 * botMid - y).toFixed(2)} ${x0.toFixed(2)} ${y} Z`;
    }

    function frame(now) {
      if (!alive) return;
      if (!el.isConnected) { alive = false; return; }
      raf = requestAnimationFrame(frame);

      if (mood && now > moodUntil) mood = null;
      wantFace(mood || MODE_FACE[mode] || 'joy', now);

      const level = mode === 'speaking' ? clamp(getLevel() || 0, 0, 1) : 0;
      open += (level - open) * (level > open ? 0.55 : 0.3);
      if (open < 0.02) open = 0;
      mouth.setAttribute('d', mouthPath(open));

      // Eyes: a change of expression (close, swap, open), or an ordinary blink.
      let blink = 1;
      if (swapAt >= 0) {
        const t = now - swapAt;
        if (t < 90) blink = 1 - t / 90;
        else {
          if (pending) { applyFace(pending); pending = ''; }
          blink = t < 120 ? 0.05 : Math.min(1, (t - 120) / 150);
          if (t >= 270) { swapAt = -1; blink = 1; }
        }
      } else if (!still && !['sleepy', 'joy', 'love'].includes(face)) {
        if (blinkAt < 0 && now > nextBlink) blinkAt = now;
        if (blinkAt >= 0) {
          const t = now - blinkAt;
          blink = t < 70 ? 1 - t / 70 : t < 110 ? 0.05 : t < 210 ? (t - 110) / 100 : 1;
          if (t >= 210) { blinkAt = -1; nextBlink = now + (mode === 'speaking' ? 2200 : 3600) * (0.6 + Math.random() * 0.8); }
        }
      }
      const b = Math.max(blink, 0.05);
      blinkG.setAttribute('transform', `translate(0 ${(143 * (1 - b)).toFixed(2)}) scale(1 ${b.toFixed(3)})`);

      // Where it looks: up and aside while thinking. Eased, not jumped.
      lookX += ((face === 'thinking' ? 6 : 0) - lookX) * 0.1;
      lookY += ((face === 'thinking' ? -6 : 0) - lookY) * 0.1;
      lookG.setAttribute('transform', `translate(${lookX.toFixed(2)} ${lookY.toFixed(2)})`);

      // The head: floats, tilts while listening, nods with the voice.
      if (!still && now > nextPose) {
        tiltTarget = mode === 'listening' ? (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 3)
          : mode === 'speaking' ? (Math.random() * 2 - 1) * 5
          : mode === 'thinking' ? -6
          : (Math.random() * 2 - 1) * 2;
        nextPose = now + (mode === 'speaking' ? 1100 : 2600) + Math.random() * 1600;
      }
      tilt += (tiltTarget - tilt) * 0.05;
      const t = now / 1000;
      floatAmp += ((mode === 'sleeping' ? 2 : 5) - floatAmp) * 0.02;
      const float = still ? 0 : Math.sin(t * 2 * Math.PI / 3.4) * floatAmp;
      const nod = still ? 0 : open * 5;
      floatG.setAttribute('transform', `translate(0 ${float.toFixed(2)})`);
      headG.setAttribute('transform', `rotate(${tilt.toFixed(2)} 150 200) translate(0 ${nod.toFixed(2)})`);
      shadow.setAttribute('rx', (70 - float * 1.2).toFixed(1));
    }
    raf = requestAnimationFrame(frame);

    return {
      setMode(next) {
        if (next === mode) return;
        mode = next;
        nextPose = 0;
        if (next === 'speaking') nextBlink = Math.min(nextBlink, performance.now() + 400);
      },
      setMood(next, ms = 3500) {
        if (!next) return;
        mood = next;
        moodUntil = performance.now() + ms;
      },
      destroy() { alive = false; cancelAnimationFrame(raf); }
    };
  }

  /** A still face for small places (the chat log, buttons). */
  function thumbnail() {
    const id = `rbt${++uid}`;
    const div = document.createElement('div');
    div.innerHTML = markup(id);
    return div.innerHTML;
  }

  window.RobotFace = { mount, thumbnail };
})();
