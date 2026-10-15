/*
 * Living scene — makes a still photo of an AI teacher look like a video call.
 *
 * No video and no paid service. The photo is drawn by a small WebGL shader
 * that bends it smoothly every frame, region by region:
 *   - body: breathing, a slow sway of the whole figure;
 *   - head: tilts, nods and small turns, which change with what she is doing
 *     (talking, listening, thinking) and with the rhythm of her voice;
 *   - face: eyebrows lift on emphasis, eyes blink, the jaw and lips open with
 *     the loudness of her voice, with teeth and the inside of the mouth;
 *   - hands: a small movement on stressed words.
 * The photo fills the whole area ("cover"), kept centred on her.
 *
 * Every photo is described once, in its own pixels (see AI_CHARACTERS in
 * app.js). If WebGL is unavailable the photo is shown still.
 *
 * Usage:
 *   const s = LivingPortrait.mount(canvas, { src, scene, getLevel });
 *   s.setMode('idle' | 'listening' | 'thinking' | 'speaking');
 *   s.destroy();
 */
(function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const VERT = `
    attribute vec2 aPos;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FRAG = `
    precision highp float;
    uniform sampler2D uImg;
    uniform vec2 uImgSize;
    uniform vec2 uView;
    uniform vec3 uFit;            // canvas px per photo px, photo x/y at the canvas origin

    uniform vec4 uBody;  uniform vec2 uBodyShift;
    uniform vec4 uChest; uniform float uBreath;
    uniform vec4 uHead;  uniform vec2 uPivot; uniform float uTilt; uniform vec2 uHeadShift;
    uniform vec4 uFace;  uniform float uYaw;
    uniform vec4 uBrowL; uniform vec4 uBrowR; uniform float uBrow;
    uniform vec4 uHands; uniform vec2 uHandShift;

    uniform vec4 uMouth;          // centre x, lip line y at centre, half width, curve
    uniform vec4 uMouthRows;      // above, lower lip, chin, neck
    uniform vec2 uJaw;            // chin half width, jaw half width
    uniform float uOpen;          // opening, photo px
    uniform float uTeeth;         // most of the upper teeth that can show, photo px

    // Her real teeth, cut from a smiling photo of the same picture.
    uniform sampler2D uTeethImg;
    uniform float uHasTeeth;
    uniform vec4 uTeethBox;       // the cut-out's x, y, width, height in the smiling photo
    uniform vec4 uSmile;          // centre x, top lip inner edge y, bottom lip inner edge y, half width of the opening
    uniform float uSmileCurve;    // how the bottom lip rises toward the corners
    uniform vec3 uTips;           // upper teeth: tip y at the centre, how the tips rise to the sides, most that shows
    uniform float uTongue;        // how high the tongue is, 0..1 (moves while she talks)

    uniform vec4 uEyeL; uniform vec4 uEyeR;   // cx, cy, half width, upper lid distance
    uniform vec2 uEyeBottom;                  // lower lid distance, left and right
    uniform vec2 uLid;                        // lid skin rows, lash rows
    uniform float uBlink;

    float ell(vec2 p, vec4 e, float inner) {
      float r = length((p - e.xy) / e.zw);
      return 1.0 - smoothstep(inner, 1.0, r);
    }
    float remap(float y, float d0, float d1, float s0, float s1) {
      return s0 + (y - d0) * (s1 - s0) / max(d1 - d0, 0.001);
    }

    // A blink: lid skin stretches down, the lashes slide down whole, the eye folds away.
    vec2 eyeInv(vec2 q, vec4 e, float bottom) {
      float u = (q.x - e.x) / e.z;
      if (abs(u) >= 1.0 || uBlink < 0.01) return q;
      float sh = sqrt(1.0 - u * u);
      float t = e.y - e.w * sh;
      float btm = e.y + bottom * sh;
      float c = uBlink * (btm - t) * 0.96;
      float A = t - uLid.x, L = t - uLid.y;
      if (q.y < A || q.y > btm) return q;
      if (q.y < L + c) return vec2(q.x, remap(q.y, A, L + c, A, L));
      if (q.y < t + c) return vec2(q.x, remap(q.y, L + c, t + c, L, t));
      return vec2(q.x, remap(q.y, t + c, btm, t, btm));
    }

    void main() {
      vec2 px = vec2(gl_FragCoord.x, uView.y - gl_FragCoord.y);
      vec2 q = px / uFit.x + uFit.yz;

      // Whole figure, then the head on it, then the face in the head.
      q -= uBodyShift * ell(q, uBody, 0.62);
      q.y += uBreath * ell(q, uChest, 0.35);
      q -= uHandShift * ell(q, uHands, 0.45);

      float wh = ell(q, uHead, 0.58);
      float cs = cos(uTilt), sn = sin(uTilt);
      vec2 r = q - uPivot;
      vec2 moved = vec2(cs * r.x - sn * r.y, sn * r.x + cs * r.y) + uPivot + uHeadShift;
      q -= (moved - q) * wh;
      q.x -= uYaw * ell(q, uFace, 0.45);
      q.y += uBrow * (ell(q, uBrowL, 0.3) + ell(q, uBrowR, 0.3));

      q = eyeInv(q, uEyeL, uEyeBottom.x);
      q = eyeInv(q, uEyeR, uEyeBottom.y);

      // The mouth: the line between the lips opens, the lower lip and chin drop.
      float gapT = -1.0, lipsW = 0.0, gapH = 0.0, gapIn = 0.0, dx = abs(q.x - uMouth.x), sx = q.x - uMouth.x;
      if (uOpen > 0.05 && dx < uJaw.y && q.y > uMouthRows.x && q.y < uMouthRows.w) {
        float halfW = uMouth.z;
        float B = uMouth.y + uMouth.w * dx * dx;
        float lw = dx < halfW ? pow(max(0.0, 1.0 - pow(dx / (halfW * 0.86), 2.0)), 1.6) : 0.0;
        float jw = 1.0 - smoothstep(uJaw.x, uJaw.y, dx);
        float up = uOpen * 0.3 * lw, low = uOpen * 0.7 * lw, chin = uOpen * 0.7 * jw;
        float above = uMouthRows.x, LL = uMouthRows.y, C = uMouthRows.z, N = uMouthRows.w;
        float y = q.y;
        if (y < B - up) q.y = remap(y, above, B - up, above, B - 0.5);
        else if (y < B + low) { q.y = B; gapIn = y - (B - up); gapT = gapIn / max(up + low, 0.001); lipsW = lw; gapH = up + low; }
        else if (y < LL + low) q.y = remap(y, B + low, LL + low, B + 0.5, LL);
        else if (y < C + chin) q.y = remap(y, LL + low, C + chin, LL, C);
        else q.y = remap(y, C + chin, N, C, N);
      }

      vec2 uv = clamp(q / uImgSize, vec2(0.0), vec2(1.0));
      vec3 col = texture2D(uImg, uv).rgb;

      if (gapT >= 0.0) {
        float halfW = uMouth.z;
        float front = max(0.0, 1.0 - dx / (halfW * 0.78));
        float teethT = min(gapH * 0.48, uTeeth) * pow(front, 0.6) / max(gapH, 0.001);
        vec3 dark = mix(vec3(0.29, 0.10, 0.12), vec3(0.19, 0.06, 0.08), gapT);
        vec3 teeth = mix(vec3(0.66, 0.60, 0.56), vec3(0.85, 0.81, 0.76), front);
        teeth *= mix(0.72, 1.0, smoothstep(0.0, 0.45, gapT / max(teethT, 0.001)));   // shadow of the top lip
        float lowerT = gapH > uTeeth * 1.6 ? 0.16 * front : 0.0;
        vec3 inside = mix(teeth, dark, smoothstep(teethT - 0.07, teethT + 0.07, gapT));
        inside = mix(inside, vec3(0.62, 0.56, 0.52) * (0.7 + 0.3 * front), smoothstep(1.0 - lowerT - 0.05, 1.0 - lowerT + 0.05, gapT) * step(0.001, lowerT));
        if (uHasTeeth > 0.5) {
          // Her own mouth, top to bottom, as in real speech: the tips of her
          // upper teeth below the top lip, then the inside of the mouth (the
          // dark of the throat, the tongue rising from the bottom), then a
          // little of her lower teeth above the bottom lip when she opens wide.
          float xn = clamp(sx / (halfW * 0.86), -1.0, 1.0);
          float xs = uSmile.x + xn * uSmile.w;
          float dxs = xs - uSmile.x;
          float tipS = uTips.x + uTips.y * dxs * dxs;
          float botS = uSmile.z + uSmileCurve * dxs * dxs;
          float upperVis = min(gapH * 0.42, uTips.z);
          float lowerVis = min(max(gapH - 6.0, 0.0) * 0.3, 2.5);
          float midTop = upperVis, midBot = gapH - lowerVis;

          vec3 up = texture2D(uTeethImg, clamp((vec2(xs, tipS - (upperVis - gapIn)) - uTeethBox.xy) / uTeethBox.zw, vec2(0.0), vec2(1.0))).rgb;
          vec3 lowT = texture2D(uTeethImg, clamp((vec2(xs, botS - (gapH - gapIn)) - uTeethBox.xy) / uTeethBox.zw, vec2(0.0), vec2(1.0))).rgb;

          float m = clamp((gapIn - midTop) / max(midBot - midTop, 0.001), 0.0, 1.0);
          float side = xn * xn;
          vec3 throat = mix(vec3(0.17, 0.045, 0.06), vec3(0.32, 0.11, 0.12), side);
          float tongueTop = 1.0 - uTongue * (1.0 - side * 0.85);
          vec3 tongue = vec3(0.66, 0.36, 0.37) * (1.0 - 0.32 * side);
          tongue *= 0.72 + 0.28 * smoothstep(tongueTop, tongueTop + 0.6, m);       // its back is in shadow
          tongue += vec3(0.06, 0.04, 0.04) * (1.0 - smoothstep(0.0, 0.35, abs(xn))) * smoothstep(tongueTop + 0.1, tongueTop + 0.45, m); // wet sheen
          vec3 mid = mix(throat, tongue, smoothstep(tongueTop - 0.07, tongueTop + 0.07, m));
          mid *= mix(0.65, 1.0, smoothstep(0.0, 0.3, m));                        // shadow under the upper teeth

          float px1 = 0.45;                                                       // soft edges between the parts
          inside = mid;
          inside = mix(inside, up, 1.0 - smoothstep(midTop - px1, midTop + px1, gapIn));
          inside = mix(inside, lowT, smoothstep(midBot - px1, midBot + px1, gapIn) * step(0.01, lowerVis));
          inside *= mix(0.85, 1.0, smoothstep(0.0, 5.0, gapH));                  // a slightly open mouth is darker inside
        }
        float a = smoothstep(0.02, 0.3, lipsW) * smoothstep(0.0, 0.1, gapT) * (1.0 - smoothstep(0.92, 1.0, gapT));
        col = mix(col, inside, a);
      }
      gl_FragColor = vec4(col, 1.0);
    }`;

  function compile(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  /** A value that eases toward its target like a soft spring. */
  const spring = (value = 0) => ({ value, target: value, ease(rate) { this.value += (this.target - this.value) * rate; return this.value; } });

  function mount(canvas, { src, scene, getLevel = () => 0, fixed }) {
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: Boolean(fixed) });
    let alive = true;
    let raf = 0;
    let mode = 'idle';
    if (!gl) {
      canvas.style.backgroundImage = `url('${src}')`;
      return { setMode() {}, destroy() {} };
    }

    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (error) {
      console.warn('Living scene unavailable:', error.message);
      canvas.style.backgroundImage = `url('${src}')`;
      return { setMode() {}, destroy() {} };
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const U = {};
    const u = name => (U[name] ||= gl.getUniformLocation(prog, name));
    const v4 = e => [e.cx, e.cy, e.rx, e.ry];

    const img = new Image();
    let ready = false;
    let teethReady = !scene.teeth;
    if (scene.teeth) {
      const t = new Image();
      t.onload = () => {
        gl.activeTexture(gl.TEXTURE1);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, t);
        gl.activeTexture(gl.TEXTURE0);
        const T = scene.teeth;
        gl.uniform1i(u('uTeethImg'), 1);
        gl.uniform1f(u('uHasTeeth'), 1);
        gl.uniform4f(u('uTeethBox'), ...T.box);
        gl.uniform4f(u('uSmile'), T.cx, T.top, T.bottom, T.half);
        gl.uniform1f(u('uSmileCurve'), T.curve);
        gl.uniform3f(u('uTips'), T.tip, T.tipCurve, T.show);
        teethReady = true;
      };
      t.onerror = () => { teethReady = true; };   // fall back to drawn teeth
      t.src = scene.teeth.src;
    }
    img.onload = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.activeTexture(gl.TEXTURE0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      setStatic();
      ready = true;
    };
    img.src = src;

    // The parts of the photo that never change.
    function setStatic() {
      const S = scene, m = S.mouth;
      gl.uniform1i(u('uImg'), 0);
      if (!scene.teeth) gl.uniform1f(u('uHasTeeth'), 0);
      gl.uniform2f(u('uImgSize'), S.width, S.height);
      gl.uniform4f(u('uBody'), ...v4(S.body));
      gl.uniform4f(u('uChest'), ...v4(S.chest));
      gl.uniform4f(u('uHead'), ...v4(S.head));
      gl.uniform2f(u('uPivot'), ...S.pivot);
      gl.uniform4f(u('uFace'), ...v4(S.face));
      gl.uniform4f(u('uBrowL'), ...v4(S.brows[0]));
      gl.uniform4f(u('uBrowR'), ...v4(S.brows[1]));
      gl.uniform4f(u('uHands'), ...v4(S.hands));
      gl.uniform4f(u('uMouth'), m.cx, m.seam, m.half, m.curve);
      gl.uniform4f(u('uMouthRows'), m.above, m.lowerLip, m.chin, m.neck);
      gl.uniform2f(u('uJaw'), m.chinHalf, m.jaw);
      gl.uniform1f(u('uTeeth'), m.teeth);
      const [L, R] = S.eyes;
      gl.uniform4f(u('uEyeL'), L.cx, L.cy, L.rx, L.top);
      gl.uniform4f(u('uEyeR'), R.cx, R.cy, R.rx, R.top);
      gl.uniform2f(u('uEyeBottom'), L.bottom, R.bottom);
      gl.uniform2f(u('uLid'), ...S.lid);
    }

    // Size the drawing to the element, and fit the photo to cover it, centred on her.
    let lastW = 0, lastH = 0;
    function fit() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (w === lastW && h === lastH) return;
      lastW = w; lastH = h;
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
      const S = scene;
      // On a tall phone screen come in closer, head to waist, so her face is
      // bigger; on a wide screen show more of the room.
      const frame = (h > w * 1.1 ? S.framing?.tall : S.framing?.wide) || {};
      const k = Math.max(w / S.width, h / S.height) * 1.02 * (frame.zoom || 1);   // a little extra, so moving edges never show
      const [fx, fy] = frame.focus || S.focus;
      const ox = clamp(fx - w / k / 2, 0, S.width - w / k);
      const oy = clamp(fy - h / k / 2, 0, S.height - h / k);
      gl.uniform2f(u('uView'), w, h);
      gl.uniform3f(u('uFit'), k, ox, oy);
    }

    // ------------------------------------------------------------- behaviour
    const still = reducedMotion();
    const tilt = spring(0), yaw = spring(0), headX = spring(0), headY = spring(0), brow = spring(0), sway = spring(0);
    let open = 0, emphasis = 0, slow = 0;
    const tongue = spring(0.5);
    let nextTongue = 0;
    let nextPose = 0, nextBlink = performance.now() + 1200, blinkStart = -1, doubleBlink = false, nextNod = 0, nod = 0;

    function blinkAmount(now) {
      if (blinkStart < 0 && now >= nextBlink) { blinkStart = now; doubleBlink = Math.random() < 0.18; }
      if (blinkStart < 0) return 0;
      const one = t => (t < 70 ? t / 70 : t < 110 ? 1 : t < 230 ? 1 - (t - 110) / 120 : 0);
      const t = now - blinkStart;
      if (t < 230) return one(t);
      if (doubleBlink && t < 290) return 0;
      if (doubleBlink && t < 520) return one(t - 290);
      blinkStart = -1;
      const base = mode === 'speaking' ? 2600 : mode === 'listening' ? 4600 : 3600;
      nextBlink = now + base * (0.55 + Math.random() * 0.9);
      return 0;
    }

    /** A new head pose now and then: what a person does without thinking. */
    function choosePose(now) {
      if (now < nextPose) return;
      const r = a => (Math.random() * 2 - 1) * a;
      if (mode === 'speaking') {
        tilt.target = r(1.1) * Math.PI / 180;
        yaw.target = r(1.6);
        headX.target = r(1.2);
        sway.target = r(1.6);
        nextPose = now + 1200 + Math.random() * 1800;
      } else if (mode === 'listening') {
        // Head a little to one side: paying attention.
        tilt.target = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.6) * Math.PI / 180;
        yaw.target = r(0.6);
        headX.target = r(0.6);
        sway.target = r(0.8);
        nextPose = now + 3000 + Math.random() * 3000;
      } else if (mode === 'thinking') {
        tilt.target = r(0.5) * Math.PI / 180;
        yaw.target = (Math.random() < 0.5 ? -1 : 1) * 1.4;   // a glance away while thinking
        headX.target = 0;
        brow.target = 0.8;
        nextPose = now + 1600;
      } else {
        tilt.target = r(0.4) * Math.PI / 180;
        yaw.target = r(0.5);
        headX.target = r(0.4);
        sway.target = r(0.6);
        nextPose = now + 4000 + Math.random() * 3000;
      }
    }

    function frame(now) {
      if (!alive) return;
      if (ready && !canvas.isConnected) { alive = false; return; }
      raf = requestAnimationFrame(frame);
      if (!ready || !teethReady) return;
      fit();

      const level = fixed ? fixed.level : mode === 'speaking' || mode === 'idle' ? clamp(getLevel() || 0, 0, 1) : 0;
      open += (level - open) * (level > open ? 0.55 : 0.32);
      if (fixed) {                          // test pictures: hold one pose exactly
        open = fixed.level || 0;
        tilt.value = tilt.target = (fixed.tilt || 0) * Math.PI / 180;
        yaw.value = yaw.target = fixed.yaw || 0;
        brow.target = brow.value = fixed.brow || 0;
      }
      if (open < 0.01) open = 0;
      emphasis += (level - emphasis) * (level > emphasis ? 0.12 : 0.04);   // the stress of a phrase
      slow += (emphasis - slow) * 0.02;

      const t = now / 1000;
      if (!still && !fixed) choosePose(now);
      if (mode !== 'thinking' && !fixed) brow.target = clamp((emphasis - slow) * 4, 0, 1);

      // Listening: a small nod every few seconds.
      if (mode === 'listening' && now > nextNod && !still) { nod = 1; nextNod = now + 2500 + Math.random() * 3500; }
      nod *= 0.93;

      const breath = still ? 0 : Math.sin(t * 2 * Math.PI / 4.4);
      const talkNod = open * 1.1 + Math.max(0, emphasis - slow) * 3;
      const listenNod = Math.sin((1 - nod) * Math.PI) * nod * 2.2;

      const S = scene;
      gl.uniform2f(u('uBodyShift'), sway.ease(0.025) + (still ? 0 : Math.sin(t * 2 * Math.PI / 8.3) * 0.6), 0);
      gl.uniform1f(u('uBreath'), breath * S.breath);
      gl.uniform2f(u('uHandShift'), 0, -Math.max(0, emphasis - slow) * S.handLift + breath * 0.4);
      gl.uniform1f(u('uTilt'), tilt.ease(0.04));
      gl.uniform2f(u('uHeadShift'), headX.ease(0.04), headY.ease(0.1) + talkNod + listenNod - breath * S.breath * 0.6);
      gl.uniform1f(u('uYaw'), yaw.ease(0.035));
      gl.uniform1f(u('uBrow'), brow.ease(0.12) * S.browLift);
      gl.uniform1f(u('uOpen'), open * S.mouth.maxOpen);
      // The tongue: up and down with the sounds, every syllable or so.
      if (now > nextTongue) {
        tongue.target = mode === 'speaking' ? 0.4 + Math.random() * 0.45 : 0.5;
        nextTongue = now + 110 + Math.random() * 120;
      }
      gl.uniform1f(u('uTongue'), fixed && fixed.tongue !== undefined ? fixed.tongue : tongue.ease(0.22));
      gl.uniform1f(u('uBlink'), fixed ? fixed.blink || 0 : still ? 0 : blinkAmount(now));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    raf = requestAnimationFrame(frame);

    return {
      setMode(next) {
        if (next === mode) return;
        mode = next;
        nextPose = 0;                       // react at once
        if (next === 'speaking') nextBlink = Math.min(nextBlink, performance.now() + 300);
      },
      destroy() { alive = false; cancelAnimationFrame(raf); }
    };
  }

  window.LivingPortrait = { mount };
})();
