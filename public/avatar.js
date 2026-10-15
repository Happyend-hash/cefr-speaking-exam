/*
 * Living portrait — makes a still photo of an AI teacher look alive.
 *
 * No video and no paid service: the photo is redrawn every frame in thin
 * vertical strips, each strip stretched a little, which is enough to
 *   - open the jaw and lips in time with the voice (the loudness of the audio
 *     that is playing, read by the app and passed in as getLevel()),
 *   - blink now and then, behind the glasses,
 *   - breathe and move slightly, so she never looks frozen.
 *
 * Every face is described once, in the photo's own pixels (see FACES in
 * app.js): where the lips meet, the mouth corners, the chin, and each eye.
 *
 * Usage:
 *   const p = LivingPortrait.mount(canvas, { src, face, getLevel });
 *   p.setMode('idle' | 'listening' | 'thinking' | 'speaking');
 *   p.destroy();
 */
(function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** y of the line where the lips meet, at column x (photo pixels). */
  function seamAt(points, x) {
    if (x <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i += 1) {
      const [x1, y1] = points[i];
      if (x <= x1) {
        const [x0, y0] = points[i - 1];
        return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return points[points.length - 1][1];
  }

  /**
   * Draw one column of the photo, its rows moved: `map` is a list of
   * [sourceY, destY] control points, straight lines between them.
   */
  function drawColumn(ctx, img, x, w, map, s) {
    for (let i = 1; i < map.length; i += 1) {
      const [sy0, dy0] = map[i - 1];
      const [sy1, dy1] = map[i];
      const sh = sy1 - sy0, dh = dy1 - dy0;
      if (sh <= 0 || dh <= 0) continue;
      ctx.drawImage(img, x * s, sy0 * s, w * s, sh * s, x * s, dy0 * s, w * s, dh * s);
    }
  }

  function mount(canvas, { src, face, getLevel = () => 0, fixedBlink }) {
    const ctx = canvas.getContext('2d');
    const work = document.createElement('canvas');
    const wctx = work.getContext('2d');
    const img = new Image();
    let s = 1;                 // asset pixels per photo pixel
    let raf = 0;
    let mode = 'idle';
    let open = 0;              // smoothed mouth opening, 0..1
    let nextBlink = performance.now() + 1500;
    let blinkStart = -1;
    let doubleBlink = false;
    let alive = true;
    const still = reducedMotion();

    img.onload = () => {
      s = img.naturalWidth / face.width;
      canvas.width = work.width = img.naturalWidth;
      canvas.height = work.height = img.naturalHeight;
      frame(performance.now());
    };
    img.src = src;

    function blinkAmount(now) {
      if (blinkStart < 0 && now >= nextBlink) { blinkStart = now; doubleBlink = Math.random() < 0.18; }
      if (blinkStart < 0) return 0;
      // One blink: closes in 70 ms, stays shut 40 ms, opens in 120 ms.
      const one = t => (t < 70 ? t / 70 : t < 110 ? 1 : t < 230 ? 1 - (t - 110) / 120 : 0);
      const t = now - blinkStart;
      if (t < 230) return one(t);
      if (doubleBlink && t < 290) return 0;
      if (doubleBlink && t < 520) return one(t - 290);
      blinkStart = -1;
      // People blink more while talking and less while listening closely.
      const base = mode === 'speaking' ? 2600 : mode === 'listening' ? 4800 : 3600;
      nextBlink = now + base * (0.55 + Math.random() * 0.9);
      return 0;
    }

    /**
     * A blink. Per column: the eyelid skin between the glasses and the lashes
     * stretches down, the lashes slide down with it intact, and the eye folds
     * away under them, so the lashes end up resting on the lower lid.
     */
    function drawEye(eye, b) {
      const { cx, cy, rx, top, bottom, lid = 20, lashes = 11 } = eye;
      for (let x = Math.floor(cx - rx * 1.05); x <= Math.ceil(cx + rx * 1.05); x += 1) {
        const u = (x - cx) / rx;
        const shape = Math.sqrt(Math.max(0, 1 - u * u));
        if (shape <= 0) continue;
        const t = cy - top * shape;          // upper lash line at this column
        const btm = cy + bottom * shape;     // lower lid
        const c = b * (btm - t) * 0.96;      // how far the lid has come down
        drawColumn(wctx, img, x, 1, [
          [t - lid, t - lid],
          [t - lashes, t - lashes + c],      // lid skin stretches
          [t, t + c],                        // lashes slide down whole
          [btm, btm],                        // the eye folds away
          [btm + 3, btm + 3]
        ], s);
      }
    }

    function drawMouth(o) {
      const m = face.mouth;
      const d = o * m.maxOpen;              // jaw drop at full opening, photo px
      if (d < 0.3) return;
      const half = (m.right - m.left) / 2;
      const mcx = (m.left + m.right) / 2;
      const gapTop = [], gapBottom = [];
      for (let x = Math.floor(mcx - m.jaw); x <= Math.ceil(mcx + m.jaw); x += 2) {
        const dx = Math.abs(x + 1 - mcx);
        const jaw = 1 - smooth(m.chinHalf, m.jaw, dx);            // the chin moves as one
        const lips = dx < half ? Math.pow(1 - (dx / half) ** 2, 0.6) : 0; // the corners stay closed
        const B = seamAt(m.seam, x + 1);
        const up = d * 0.22 * lips;
        const low = d * 0.78 * lips;
        const chin = d * 0.78 * jaw;
        drawColumn(wctx, img, x, 2, [
          [m.above, m.above],
          [B - 0.5, B - up],                // upper lip lifts a little
          [B + 0.5, B + low],               // the line between the lips opens
          [m.lowerLip, m.lowerLip + low],   // lower lip moves with the jaw
          [m.chin, m.chin + chin],          // so does the chin
          [m.neck, m.neck]                  // the neck takes up the difference
        ], s);
        if (lips > 0) { gapTop.push([x + 1, B - up]); gapBottom.push([x + 1, B + low]); }
      }
      if (gapTop.length < 2 || d < 1) return;

      // Inside of the mouth: dark, a little lighter at the top (teeth).
      const path = new Path2D();
      path.moveTo(gapTop[0][0] * s, gapTop[0][1] * s);
      gapTop.forEach(([x, y]) => path.lineTo(x * s, y * s));
      for (let i = gapBottom.length - 1; i >= 0; i -= 1) path.lineTo(gapBottom[i][0] * s, gapBottom[i][1] * s);
      path.closePath();
      const yTop = Math.min(...gapTop.map(p => p[1])) * s;
      const yBot = Math.max(...gapBottom.map(p => p[1])) * s;
      const g = wctx.createLinearGradient(0, yTop, 0, yBot);
      const teeth = clamp((d - 5) / 8, 0, 1) * 0.45;
      g.addColorStop(0, `rgba(236, 226, 220, ${teeth})`);
      g.addColorStop(0.28, `rgba(92, 34, 38, ${0.55 + 0.25 * o})`);
      g.addColorStop(1, `rgba(58, 18, 24, ${0.65 + 0.25 * o})`);
      wctx.save();
      wctx.fillStyle = g;
      wctx.fill(path);
      wctx.restore();
    }

    function frame(now) {
      if (!alive) return;
      // Taken off the page (another screen opened): stop for good.
      if (img.naturalWidth && !canvas.isConnected) { alive = false; return; }
      raf = requestAnimationFrame(frame);
      if (!img.naturalWidth) return;

      // Mouth: follow the voice, opening fast and closing a little slower.
      const level = mode === 'speaking' || mode === 'idle' ? clamp(getLevel() || 0, 0, 1) : 0;
      open += (level - open) * (level > open ? 0.55 : 0.32);
      if (open < 0.01) open = 0;

      wctx.drawImage(img, 0, 0);
      const b = fixedBlink !== undefined ? fixedBlink : still ? 0 : blinkAmount(now);
      if (b > 0.02) face.eyes.forEach(eye => drawEye(eye, b));
      drawMouth(open);

      // The whole picture: breathing, a slow drift, small nods while talking.
      const t = now / 1000;
      const breathe = still ? 0 : Math.sin(t * 2 * Math.PI / 4.6);
      const drift = still ? 0 : Math.sin(t * 2 * Math.PI / 9.3);
      const nod = still ? 0 : open * 0.6 + (mode === 'listening' ? Math.sin(t * 2 * Math.PI / 3.1) * 0.25 : 0);
      const W = canvas.width, H = canvas.height;
      const zoom = 1.035 + breathe * 0.004 + (mode === 'listening' ? 0.008 : 0);
      ctx.save();
      ctx.clearRect(0, 0, W, H);
      ctx.translate(W / 2, H * 0.62);
      ctx.rotate((drift * 0.35 + nod * 0.25) * Math.PI / 180);
      ctx.scale(zoom, zoom);
      ctx.translate(-W / 2 + drift * W * 0.003, -H * 0.62 + breathe * H * 0.0025 + nod * H * 0.003);
      ctx.drawImage(work, 0, 0);
      ctx.restore();
    }

    return {
      setMode(next) { mode = next; },
      destroy() { alive = false; cancelAnimationFrame(raf); }
    };
  }

  window.LivingPortrait = { mount };
})();
