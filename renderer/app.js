/* Drift — per-monitor renderer: WebGL scene + control panel */
(async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const api = window.drift;
  const init = await api.init();
  let S = init.state;
  const me = { key: init.key, index: init.index, bounds: init.bounds, union: init.union };
  const PRESETS = [
    { id: 'pads', name: 'Warm Pads', desc: 'Slow, soft chords' },
    { id: 'space', name: 'Deep Space', desc: 'Low drones, wide and dark' },
    { id: 'bells', name: 'Crystal Bells', desc: 'Sparse chimes with long echoes' },
    { id: 'dawn', name: 'Morning Light', desc: 'Bright, airy and hopeful' },
  ];

  // ---------- WebGL ----------
  function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  function makeRenderer(canvas, opts) {
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance', ...opts });
    if (!gl) return null;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const progs = {};
    const compile = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.log('SHADER ERROR ' + gl.getShaderInfoLog(s)); return null; }
      return s;
    };
    const get = (id) => {
      if (id in progs) return progs[id];
      const vs = compile(gl.VERTEX_SHADER, SHADER_VERT);
      const fs = compile(gl.FRAGMENT_SHADER, SHADER_HEAD + SCENE_SRC[id] + SHADER_TAIL);
      if (!vs || !fs) { console.log('scene failed: ' + id); return (progs[id] = null); }
      const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.log('LINK ERROR ' + id + ' ' + gl.getProgramInfoLog(p)); return (progs[id] = null); }
      const u = {};
      for (const n of ['uRes', 'uView', 'uAspect', 'uTime', 'uAudio', 'uBright', 'uC0', 'uC1', 'uC2', 'uC3',
        'uData', 'uDataSize', 'uSpec', 'uReact', 'uBeat', 'uBeatAge', 'uATime', 'uOverlay']) u[n] = gl.getUniformLocation(p, n);
      return (progs[id] = { p, u });
    };
    const mkTex = () => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return t;
    };
    const dataTex = mkTex(), specTex = mkTex(), specBytes = new Uint8Array(64 * 2 * 4);
    let lastSim = null, lastVer = -1;
    return {
      gl,
      draw(id, o) {
        const pr = get(id) || get('aurora'); if (!pr) return;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(pr.p);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(pr.u.uRes, canvas.width, canvas.height);
        gl.uniform4f(pr.u.uView, ...o.view);
        gl.uniform1f(pr.u.uAspect, o.aspect);
        gl.uniform1f(pr.u.uTime, o.time);
        gl.uniform3f(pr.u.uAudio, ...o.audio);
        gl.uniform1f(pr.u.uBright, o.bright);
        o.colors.forEach((c, i) => gl.uniform3f(pr.u['uC' + i], ...c));
        // simulation state (Sorting / Life / Maze) on texture unit 0
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dataTex);
        if (o.sim && (o.sim !== lastSim || o.sim.version !== lastVer)) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, o.sim.w, o.sim.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, o.sim.data);
          lastSim = o.sim; lastVer = o.sim.version;
        }
        gl.uniform1i(pr.u.uData, 0);
        if (o.sim) gl.uniform2f(pr.u.uDataSize, o.sim.w, o.sim.h);
        // live spectrum + waveform on unit 1
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, specTex);
        const sp = o.spec;
        for (let i = 0; i < 128; i++) { const v = sp ? sp[i] : (i < 64 ? 0 : 128); specBytes[i * 4] = v; specBytes[i * 4 + 3] = 255; }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, specBytes);
        gl.uniform1i(pr.u.uSpec, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1f(pr.u.uReact, o.react || 0);
        gl.uniform1f(pr.u.uBeat, o.beat || 0);
        gl.uniform4f(pr.u.uBeatAge, ...(o.beatAge || [99, 99, 99, 99]));
        gl.uniform1f(pr.u.uATime, o.atime || 0);
        gl.uniform1f(pr.u.uOverlay, o.overlay || 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  }

  const canvas = $('#c');
  let R = makeRenderer(canvas);
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => { R = makeRenderer(canvas); });

  const sceneFor = (st) => (st.mode === 'mix' ? (st.perDisplay[me.key] || st.scene) : st.scene);
  let shown = sceneFor(S), fading = false;
  const audio = [0, 0, 0], audioTarget = [0, 0, 0];
  const specTarget = new Float32Array(128).fill(0), specNow = new Float32Array(128).fill(0);
  for (let i = 64; i < 128; i++) specTarget[i] = specNow[i] = 128;
  let beats = [0, 0, 0, 0], aTime = 0, aTimeTarget = 0;

  // simulation for Sorting / Life / Maze — rebuilt if the scene or the screen shape changes
  let simObj = null, simKey = '';
  function simFor(id, aspect) {
    if (!window.SIMS[id]) return null;
    const key = id + '|' + aspect.toFixed(3);
    if (key !== simKey) { simObj = new window.SIMS[id](aspect); simKey = key; }
    return simObj;
  }

  // colours: a fixed palette, or "Cycle" which blends through every palette on the wall clock (same on every monitor)
  const PAL_IDS = Object.keys(PALETTES);
  const rgb = (id) => PALETTES[id].c.map(hex);
  function currentColors(at) {
    if (S.palette !== 'cycle') return rgb(PALETTES[S.palette] ? S.palette : 'aurora');
    const T = (at || Date.now()) / 1000 / Math.max(5, S.cycleSecs || 30), i = Math.floor(T), f = T - i;
    const a = rgb(PAL_IDS[i % PAL_IDS.length]), b = rgb(PAL_IDS[(i + 1) % PAL_IDS.length]);
    const k = f < 0.65 ? 0 : (x => x * x * (3 - 2 * x))((f - 0.65) / 0.35);
    return a.map((c, j) => c.map((v, n) => v + (b[j][n] - v) * k));
  }
  const toHex = (c) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

  // caption for algorithm scenes (bottom-left of the leftmost screen in Span)
  const algoEl = $('#algo'); let capAt = 0;
  function algoCaption(t, sm) {
    const leftmost = S.mode !== 'span' || me.bounds.x === me.union.x;
    const fn = window.ALGO_LABELS[shown];
    const on = S.algoInfo && leftmost && shown !== 'video' && (sm || fn);
    algoEl.classList.toggle('on', !!on);
    if (!on || performance.now() - capAt < 200) return;
    capAt = performance.now();
    const txt = sm ? sm.label() : fn(t);
    if (algoEl.textContent !== txt) algoEl.textContent = txt;
  }

  function viewParams() {
    if (S.mode === 'span') {
      const b = me.bounds, U = me.union;
      return { view: [(b.x - U.x) / U.width, (U.y + U.height - (b.y + b.height)) / U.height, b.width / U.width, b.height / U.height], aspect: U.width / U.height };
    }
    return { view: [0, 0, 1, 1], aspect: innerWidth / innerHeight };
  }
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(2, Math.round(innerWidth * dpr * S.quality)), h = Math.max(2, Math.round(innerHeight * dpr * S.quality));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  addEventListener('resize', resize);

  const sceneTime = () => init.freeze ? 47 : S.frozen ? S.time.base : S.time.base + ((Date.now() - S.time.ref) / 1000) * S.speed;
  let lastDraw = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (now - lastDraw < 1000 / S.fps - 3) return;
    lastDraw = now;
    for (let i = 0; i < 3; i++) audio[i] += (audioTarget[i] * S.reactivity * 1.6 - audio[i]) * 0.12;
    for (let i = 0; i < 128; i++) specNow[i] += (specTarget[i] - specNow[i]) * (i < 64 ? 0.35 : 0.5);
    aTime += (aTimeTarget - aTime) * 0.15;
    if (R && shown !== 'video') {
      const vp = viewParams(), t = sceneTime(), sm = simFor(shown, vp.aspect);
      if (sm) sm.update(t);
      const now = Date.now(), age = beats.map((b) => (b ? (now - b) / 1000 : 99));
      R.draw(shown, { ...vp, time: t, audio, bright: S.brightness, colors: currentColors(), sim: sm, spec: specNow, react: S.reactivity * 1.6,
        beat: Math.exp(-age[0] * 4), beatAge: age, atime: aTime, overlay: { none: 0, bars: 1, wave: 2 }[S.overlay] || 0 });
      algoCaption(t, sm);
    } else algoCaption(0, null);
    tickOverlays();
  }

  function setScene(id) {
    if (id === shown || fading) return;
    fading = true; stage.style.opacity = 0;
    setTimeout(() => { shown = sceneFor(S); syncVideo(); stage.style.opacity = 1; fading = false; }, 720);
  }

  // ---------- your own video ----------
  // Every monitor plays the same file and chases one shared timeline, so Span shows one picture across all screens.
  const stage = $('#stage'), video = $('#v');
  const vbg = $('#vbg'); let bgOn = false, bgAspect = 16 / 9;
  // soft blurred copy of the picture behind it, so bars beside a vertical video aren't plain black
  setInterval(() => {
    if (!bgOn || video.readyState < 2) return;
    const w = 96, h = Math.max(8, Math.round(96 / bgAspect));
    if (vbg.width !== w || vbg.height !== h) { vbg.width = w; vbg.height = h; }
    const vw = video.videoWidth, vh = video.videoHeight, k = Math.max(w / vw, h / vh);
    try { vbg.getContext('2d').drawImage(video, (w - vw * k) / 2, (h - vh * k) / 2, vw * k, vh * k); } catch { /* frame not ready */ }
  }, 120);
  let seekHold = 0, curUrl = '', lastSeq, seeking = false, lastJump = 0;
  const clockStr = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
  const videoOn = () => sceneFor(S) === 'video' && !!S.videoUrl;
  // The toolbar's play / previous / next / volume act on whichever tab is selected: Scenes, Video or Music.
  let lastCtx = 'scene';
  const ctx = () => { if (tab !== 'settings') lastCtx = { scenes: 'scene', video: 'video', music: 'music' }[tab]; return lastCtx; };
  const volIsVideo = () => (ctx() === 'video' ? true : ctx() === 'music' ? false : videoOn() && S.video.sound);
  function syncVideo() {
    const on = shown === 'video' && !!S.videoUrl;
    video.style.display = on ? 'block' : 'none';
    canvas.style.display = on ? 'none' : 'block';
    if (!on) { if (!video.paused) video.pause(); syncSound(false); vbg.style.display = 'none'; bgOn = false; return; }
    if (curUrl !== S.videoUrl) { curUrl = S.videoUrl; video.src = S.videoUrl; seekHold = 0; }
    const lead = S.videoLeader === me.key;
    video.loop = S.video.files.length === 1;
    const converted = S.videoAudio && S.videoAudio.mode === 'transcode' && !!S.audioBase;
    video.muted = !(lead && S.video.sound) || converted;
    syncSound(lead && S.video.sound && converted);
    video.volume = S.video.volume;
    // Fit: Auto keeps the whole picture when its shape doesn't match the screen (vertical phone video), and fills when it nearly does.
    const spanIt = S.mode === 'span' && S.video.layout === 'span';
    const ta = spanIt ? me.union.width / me.union.height : innerWidth / innerHeight;
    const va = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : ta;
    let fit = S.video.fit;
    if (fit === 'auto') fit = spanIt ? (va < 1 ? 'contain' : 'cover') : (Math.max(va / ta, ta / va) > 1.15 ? 'contain' : 'cover');
    video.style.objectFit = fit;
    bgOn = fit === 'contain' && Math.max(va / ta, ta / va) > 1.02; bgAspect = ta;
    vbg.style.display = bgOn ? 'block' : 'none';
    if (S.vclock.seq !== lastSeq) { lastSeq = S.vclock.seq; seekHold = 0; }      // someone dragged the seek bar: jump right away
    const b = me.bounds, U = me.union;
    const box = spanIt ? { left: U.x - b.x + 'px', top: U.y - b.y + 'px', width: U.width + 'px', height: U.height + 'px' } : { left: 0, top: 0, width: '100%', height: '100%' };
    Object.assign(video.style, box); Object.assign(vbg.style, box);
    const playing = !S.video.paused;
    let target = playing ? (Date.now() - S.vclock.startedAt) / 1000 : S.vclock.pos;
    if (!playing) { if (!video.paused) video.pause(); } else if (video.paused && !video.ended) video.play().catch(() => {});
    const dur = video.duration;
    if (!dur || !isFinite(dur)) return;
    if (video.loop) target %= dur; else if (target >= dur) return;         // clip finished: wait for the next one
    const drift = video.currentTime - target, now = performance.now();
    if (Math.abs(drift) > 0.3 && Math.abs(drift) < dur - 0.3) { if (now > seekHold) { video.currentTime = target; seekHold = now + 2000; } video.playbackRate = 1; }
    else video.playbackRate = Math.abs(drift) > 0.012 && Math.abs(drift) < 1 ? Math.max(0.94, Math.min(1.06, 1 - drift * 0.6)) : 1;
  }
  // Sound track the built-in player can't decode: play the converted stream from the main process alongside the picture.
  const vaud = $('#va');
  let vaOffset = 0, vaUrl = '', vaHold = 0, vaSeq;
  function syncSound(want) {
    if (!want) { if (vaUrl) { vaUrl = ''; vaud.pause(); vaud.removeAttribute('src'); vaud.load(); } return; }
    vaud.volume = S.video.volume;
    const now = performance.now(), vt = video.currentTime;
    const err = vt - (vaOffset + vaud.currentTime);
    const fresh = vaUrl.split('&t=')[0] !== S.audioBase || vaSeq !== S.vclock.seq;
    const stuck = vaud.error || vaud.ended;
    if (fresh || ((Math.abs(err) > 2.5 || stuck) && now > vaHold)) {
      vaSeq = S.vclock.seq; vaOffset = vt + (!S.video.paused ? 0.6 : 0);     // aim a little ahead to cover start-up time
      vaUrl = `${S.audioBase}&t=${vaOffset.toFixed(2)}&n=${Date.now()}`;
      vaud.src = vaUrl; vaHold = now + 4000;
    }
    if (S.video.paused || video.paused) { if (!vaud.paused) vaud.pause(); return; }
    if (vaud.paused) vaud.play().catch(() => {});
    vaud.playbackRate = Math.abs(err) > 0.04 && Math.abs(err) < 2.5 ? Math.max(0.9, Math.min(1.1, 1 + err * 0.25)) : 1;
    if (init.testMode && Math.random() < 0.3) console.log(`fallback audio: video=${vt.toFixed(2)} audio=${(vaOffset + vaud.currentTime).toFixed(2)} ready=${vaud.readyState}`);
  }
  setInterval(syncVideo, 250);
  video.addEventListener('loadedmetadata', syncVideo);
  video.addEventListener('ended', () => { if (S.videoLeader === me.key) api.cmd({ type: 'video-next', index: S.video.index }); });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src') || S.videoLeader !== me.key) return;
    toast('That video can\'t be played here — MP4 (H.264) or WebM work best.', 6000);
    api.cmd({ type: 'video-next', index: S.video.index, failed: true });
  });

  // ---------- overlays ----------
  const U = me.union, cx = U.x + U.width / 2, cy = U.y + U.height / 2, b = me.bounds;
  const isCenter = cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
  const clockEl = $('#clock'), breathEl = $('#breath'), ring = $('#breath .ring'), breathTxt = $('#breath span');
  const ease = (x) => x * x * (3 - 2 * x);
  let lastClock = '', accentAt = 0;
  function tickOverlays() {
    const showHere = S.mode !== 'span' || isCenter;
    clockEl.classList.toggle('on', S.clock && showHere);
    if (S.clock) {
      const d = new Date(), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (t !== lastClock) clockEl.textContent = lastClock = t;
    }
    breathEl.classList.toggle('on', S.breathing && showHere);
    if (S.breathing) {
      const ph = (Date.now() / 1000) % 14; let k, label;   // 4 in · 2 hold · 6 out · 2 rest
      if (ph < 4) { k = ease(ph / 4); label = 'Breathe in'; }
      else if (ph < 6) { k = 1; label = 'Hold'; }
      else if (ph < 12) { k = 1 - ease((ph - 6) / 6); label = 'Breathe out'; }
      else { k = 0; label = 'Rest'; }
      ring.style.transform = `scale(${0.45 + 0.55 * k})`;
      if (breathTxt.textContent !== label) breathTxt.textContent = label;
    }
    if (panel.classList.contains('show') && videoOn() && isFinite(video.duration) && video.duration > 0) {
      const sk = $('#seek');
      sk.max = video.duration;
      if (!seeking) { sk.value = video.currentTime; $('#vcur').textContent = clockStr(video.currentTime); }
      fill(sk); $('#vdur').textContent = clockStr(video.duration);
    }
    if (S.palette === 'cycle' && performance.now() - accentAt > 500) { accentAt = performance.now(); document.documentElement.style.setProperty('--accent', toHex(currentColors()[2])); }
    const sl = $('#o-sleep');
    if (S.sleepAt > Date.now()) { const m = Math.ceil((S.sleepAt - Date.now()) / 60000); sl.textContent = m + ' min left'; } else if (sl.textContent) sl.textContent = '';
  }

  // ---------- thumbnails ----------
  const tcan = document.createElement('canvas'); tcan.width = 256; tcan.height = 144;
  let TR = null, thumbPalette = null, thumbJob = 0;
  function makeThumbs() {
    if (thumbPalette === S.palette) return;
    thumbPalette = S.palette; const job = ++thumbJob;
    if (!TR) TR = makeRenderer(tcan, { preserveDrawingBuffer: true });
    if (!TR) return;
    const list = [...SCENES]; const cols = currentColors();
    const step = () => {
      if (job !== thumbJob || !list.length) return;
      const s = list.shift();
      let sm = null; if (window.SIMS[s.id]) { sm = new window.SIMS[s.id](16 / 9); sm.update(47); }
      TR.draw(s.id, { view: [0, 0, 1, 1], aspect: 16 / 9, time: 47, audio: [0, 0, 0], bright: 1, colors: cols, sim: sm });
      const el = $(`.tile[data-id="${s.id}"]`); if (el) el.style.backgroundImage = `url(${tcan.toDataURL('image/jpeg', 0.8)})`;
      setTimeout(step, 40);
    };
    step();
  }

  // ---------- panel ----------
  const panel = $('#panel');
  let tab = 'scenes', hideTimer = null, overPanel = false;
  const tileHtml = (s) => { const i = SCENES.indexOf(s); return `<button class="tile" data-id="${s.id}"><kbd>${i < 9 ? i + 1 : ''}</kbd><span>${s.name}</span></button>`; };
  $('#tiles').innerHTML = `<div class="tilegrid">${SCENES.filter((s) => !s.group).map(tileHtml).join('')}</div>`
    + `<h3 class="sub">Algorithms</h3><div class="tilegrid">${SCENES.filter((s) => s.group === 'algo').map(tileHtml).join('')}</div>`;
  $('#palettes').innerHTML = Object.entries(PALETTES).map(([id, p]) => `<button class="sw" data-id="${id}" title="${p.name}" style="background:linear-gradient(90deg,${p.c.join(',')})"></button>`).join('')
    + `<button class="sw cyc" data-id="cycle" title="Cycle through every colour" style="background:linear-gradient(90deg,${Object.values(PALETTES).map((p) => p.c[2]).join(',')})">↻</button>`;
  $('#presets').innerHTML = PRESETS.map((p) => `<button class="preset" data-id="${p.id}"><b>${p.name}</b><span>${p.desc}</span></button>`).join('');
  $('#monitors').innerHTML = init.displays.map((d) => `<button class="mon" data-i="${d.index}"><b>Monitor ${d.index + 1}</b>${d.width} × ${d.height}${d.index === me.index ? '<em>this screen</em>' : ''}</button>`).join('');

  function showPanel(open) {
    panel.classList.add('show'); document.body.classList.remove('idle');
    if (open !== undefined) panel.classList.toggle('open', open);
    if (panel.classList.contains('open')) makeThumbs();
    armHide();
  }
  function hidePanel() { panel.classList.remove('show'); document.body.classList.add('idle'); }
  function armHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (overPanel || document.activeElement?.tagName === 'SELECT') armHide(); else hidePanel(); }, 3500);
  }
  function setTab(t, toggle) {
    const same = t === tab && panel.classList.contains('open');
    tab = t;
    panel.classList.toggle('open', !(toggle && same));
    syncUI(); if (panel.classList.contains('open')) makeThumbs();
  }
  panel.addEventListener('mouseenter', () => { overPanel = true; });
  panel.addEventListener('mouseleave', () => { overPanel = false; armHide(); });
  let lastMove = [0, 0];
  addEventListener('mousemove', (e) => {
    if (Math.abs(e.screenX - lastMove[0]) + Math.abs(e.screenY - lastMove[1]) < 4) return;   // ignore jitter
    lastMove = [e.screenX, e.screenY]; showPanel();
  });
  addEventListener('mousedown', (e) => { if (!panel.contains(e.target)) { if (panel.classList.contains('open')) { panel.classList.remove('open'); } else showPanel(); } });

  const fill = (el) => el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');
  const setVal = (el, v) => { if (document.activeElement !== el || el.tagName !== 'INPUT') { el.value = v; } if (el.type === 'range') fill(el); };
  const base = (p) => p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  let plKey = '';

  function syncUI() {
    document.documentElement.style.setProperty('--accent', toHex(currentColors()[2]));
    $('#cycleSecs').value = String(S.cycleSecs); $('#cycleSecs').disabled = S.palette !== 'cycle';
    $('#overlay').value = S.overlay; $('#algoInfo').checked = !!S.algoInfo;
    const cur = sceneFor(S);
    $$('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    $$('#content section').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    $$('.tile').forEach((x) => x.classList.toggle('active', x.dataset.id === cur));
    $$('.sw').forEach((x) => x.classList.toggle('active', x.dataset.id === S.palette));
    $$('#mode button').forEach((x) => x.classList.toggle('active', x.dataset.v === S.mode));
    $$('#source button').forEach((x) => x.classList.toggle('active', x.dataset.v === S.music.source));
    $$('.preset').forEach((x) => x.classList.toggle('active', x.dataset.id === S.music.preset));
    $$('.mon').forEach((x) => x.classList.toggle('on', !S.displaysOff.includes(+x.dataset.i)));
    for (const k of ['speed', 'brightness', 'reactivity']) setVal($('#' + k), S[k]);
    setVal($('#volume'), S.music.volume);
    $$('[data-nature]').forEach((x) => setVal(x, S.music.nature[x.dataset.nature]));
    $('#o-speed').textContent = S.speed.toFixed(2) + '×';
    $('#o-brightness').textContent = Math.round(S.brightness * 100) + '%';
    $('#o-reactivity').textContent = S.reactivity < 0.01 ? 'Off' : Math.round(S.reactivity * 100) + '%';
    $('#o-volume').textContent = Math.round(S.music.volume * 100) + '%';
    for (const k of ['autoCycle', 'quality', 'fps']) $('#' + k).value = String(S[k]);
    for (const k of ['cycleShuffle', 'clock', 'breathing', 'keepAwake', 'onTop']) $('#' + k).checked = !!S[k];
    $('#shuffle').checked = !!S.music.shuffle;
    if (!(S.sleepAt > Date.now())) $('#sleep').value = '0';
    $('#presets').style.display = S.music.source === 'generative' ? '' : 'none';
    $('#files').style.display = S.music.source === 'files' ? '' : 'none';
    const sp = S.spotify || { status: 'unsupported', title: '' }, spOn = S.music.source === 'spotify';
    $('#spotify').style.display = spOn ? '' : 'none';
    $('.spnow').classList.toggle('live', sp.status === 'playing');
    $('#spTitle').textContent = sp.status === 'playing' ? sp.title : { paused: 'Spotify is paused', running: 'Spotify is running', closed: 'Spotify isn\'t open', unsupported: 'Spotify control needs Windows' }[sp.status];
    $('#spSub').textContent = sp.status === 'playing' ? 'Playing in Spotify' : sp.status === 'closed' ? 'Press Open Spotify, then start a song.' : sp.status === 'running' ? 'Open its window to see the song name here.' : sp.status === 'paused' ? 'Press play to continue.' : '';
    $('#qvol').disabled = spOn && !volIsVideo(); $('#qvol').style.opacity = $('#qvol').disabled ? 0.35 : 1;
    $('#offnote').style.display = S.music.source === 'off' ? '' : 'none';
    const sc = SCENES.find((x) => x.id === cur);
    $('#videoFit').value = S.video.fit; $('#videoLayout').value = S.video.layout; $('#videoSound').checked = !!S.video.sound;
    $('#stopVideo').style.display = cur === 'video' ? '' : 'none';
    const va = S.videoAudio || {};
    $('#vnote').textContent = !videoOn() ? 'Pick a video to play it on your monitors. Videos in the same folder play one after another.'
      : va.mode === 'transcode' ? `Now playing: ${S.videoName} — its ${va.codec.toUpperCase().replace('EAC3', 'Dolby Digital Plus (E-AC-3)').replace(/^AC3$/, 'Dolby Digital (AC-3)')} sound is being converted live so you can hear it.`
      : va.mode === 'none' ? `Now playing: ${S.videoName} — this file has no audio track.` : `Now playing: ${S.videoName}`;
    renderFolders(); markPlaying();
    panel.classList.toggle('hasvideo', videoOn());
    $('#vsound').style.display = videoOn() || ctx() === 'video' ? '' : 'none';
    $('#vsound').textContent = S.video.sound ? '🔊' : '🔇';
    setVal($('#qvol'), volIsVideo() ? S.video.volume : S.music.volume);
    $('#qvol').title = volIsVideo() ? 'Video volume' : 'Music volume';
    const c = ctx(), pr = PRESETS.find((x) => x.id === S.music.preset);
    $('#ctxTag').textContent = { scene: 'Scene', video: 'Video', music: 'Music' }[c];
    const playing = c === 'scene' ? !S.frozen : c === 'video' ? videoOn() && !S.video.paused : spOn ? sp.status === 'playing' : S.music.playing && S.music.source !== 'off';
    $('#play').textContent = playing ? '⏸' : '▶';
    $('#nowName').textContent = c === 'scene' ? (cur === 'video' ? 'My Video' : sc ? sc.name : '')
      : c === 'video' ? (S.videoName ? S.videoName.replace(/\.[^.]+$/, '') : 'No video chosen')
      : spOn ? (sp.title || 'Spotify') : S.music.source === 'off' ? 'Music off' : S.music.source === 'files' ? (S.nowPlaying.title || 'My music') : (pr ? pr.name : '');
    $('#nowName').title = $('#nowName').textContent;
    renderMusicLib();
  }

  // ---------- video library (folders -> videos, with thumbnails) ----------
  let libRoot = '', libDir = '', lib = null, libJob = 0, folderKey = '';
  const thumbs = new Map();          // path -> { img, dur }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sizeStr = (b) => (b > 1e9 ? (b / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1048576)) + ' MB');
  const folderName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  function renderFolders() {
    const fs = S.video.folders || [];
    if (!fs.includes(libRoot)) { libRoot = fs[0] || ''; libDir = ''; }
    const key = fs.join('|') + '>' + libRoot;
    if (key !== folderKey) {
      folderKey = key;
      $('#vfolders').innerHTML = fs.length ? fs.map((f) => `<div class="vf${f === libRoot ? ' active' : ''}" data-p="${esc(f)}" title="${esc(f)}">📁<span>${esc(folderName(f))}</span><button title="Remove from this list (files are not deleted)">✕</button></div>`).join('')
        : '<p class="note">No folders yet.</p>';
    }
    if (tab === 'video' && panel.classList.contains('open') && libRoot && !libDir) openDir(libRoot);
    if (!libRoot && lib) { lib = null; $('#vgrid').innerHTML = '<p>Add a folder to see your videos here.</p>'; $('#vcrumb').innerHTML = ''; }
  }
  async function openDir(dir) {
    libDir = dir; const job = ++libJob;
    const data = await api.listDir(dir);
    if (job !== libJob) return;
    lib = data;
    $('#vcrumb').innerHTML = (data.parent ? '<button class="icon" title="Back">‹</button>' : '') + `<b>${esc(data.name || '')}</b><span class="note" style="margin:0">${data.videos.length} video${data.videos.length === 1 ? '' : 's'}</span>`;
    $('#vgrid').innerHTML = (data.dirs.map((d) => `<button class="vt dir" data-dir="${esc(d.path)}"><div class="th">📁</div><div class="nm">${esc(d.name)}</div></button>`).join('')
      + data.videos.map((v, i) => `<button class="vt" data-i="${i}" title="${esc(v.name)}"><div class="th">▶<i></i></div><div class="nm">${esc(v.name.replace(/\.[^.]+$/, ''))}</div><div class="sz">${sizeStr(v.size)}</div></button>`).join(''))
      || '<p>No videos in this folder.</p>';
    markPlaying(); $('#content').scrollTop = 0;
    makeVideoThumbs(job);
  }
  async function searchVideos(q) {
    const job = ++libJob, res = await api.searchLib('video', libRoot, q);
    if (job !== libJob) return;
    lib = { dir: libRoot, name: `Results for "${q}"`, parent: null, dirs: [], videos: res }; libDir = libRoot;
    $('#vcrumb').innerHTML = `<b>${esc(lib.name)}</b><span class="note" style="margin:0">${res.length}${res.length >= 300 ? '+' : ''} found</span>`;
    $('#vgrid').innerHTML = res.map((v, i) => `<button class="vt" data-i="${i}" title="${esc(v.path)}"><div class="th">▶<i></i></div><div class="nm">${esc(v.name.replace(/\.[^.]+$/, ''))}</div><div class="sz">${sizeStr(v.size)}</div></button>`).join('') || '<p>Nothing matches.</p>';
    markPlaying(); makeVideoThumbs(job);
  }

  // ---------- music library ----------
  let mRoot = '', mDir = '', mLib = null, mJob = 0, mKey = '';
  function renderMusicLib() {
    const fs = S.music.folders || [];
    if (!fs.includes(mRoot)) { mRoot = fs[0] || ''; mDir = ''; }
    const key = fs.join('|') + '>' + mRoot;
    if (key !== mKey) {
      mKey = key;
      $('#mfolders').innerHTML = fs.map((f) => `<div class="vf${f === mRoot ? ' active' : ''}" data-p="${esc(f)}" title="${esc(f)}">📁<span>${esc(folderName(f))}</span><button title="Remove from this list (files are not deleted)">✕</button></div>`).join('') + '<button class="add">+ Add folder…</button>';
    }
    if (tab === 'music' && S.music.source === 'files' && panel.classList.contains('open') && mRoot && !mDir) openMusicDir(mRoot);
    if (!mRoot) { mLib = null; $('#playlist').innerHTML = '<p>Add a folder to browse your music here.</p>'; $('#mcrumb').innerHTML = ''; }
    markTrack();
  }
  function paintMusic(data, label) {
    mLib = data;
    $('#mcrumb').innerHTML = (data.parent ? '<button class="icon" title="Back">‹</button>' : '') + `<b>${esc(label)}</b>`;
    $('#playlist').innerHTML = (data.dirs.map((d) => `<div class="dir" data-dir="${esc(d.path)}">📁&nbsp; ${esc(d.name)}</div>`).join('')
      + data.videos.slice(0, 600).map((v, i) => `<div data-i="${i}" title="${esc(v.path)}">♪&nbsp; ${esc(v.name.replace(/\.[^.]+$/, ''))}</div>`).join(''))
      || '<p>No music here. Try another folder, or add one.</p>';
    $('#playlist').scrollTop = 0; markTrack();
  }
  async function openMusicDir(dir) {
    mDir = dir; const job = ++mJob, data = await api.listDir(dir, 'audio');
    if (job === mJob) paintMusic(data, data.name || '');
  }
  async function searchMusic(q) {
    const job = ++mJob, res = await api.searchLib('audio', mRoot, q);
    if (job === mJob) paintMusic({ parent: null, dirs: [], videos: res }, `${res.length}${res.length >= 300 ? '+' : ''} results`);
  }
  function markTrack() {
    if (!mLib) return;
    const cur = S.music.source === 'files' ? S.music.playlist[S.nowPlaying.index] : '';
    $$('#playlist div[data-i]').forEach((d) => d.classList.toggle('active', mLib.videos[+d.dataset.i].path === cur));
  }
  function markPlaying() {
    if (!lib) return;
    $$('#vgrid .vt[data-i]').forEach((t) => t.classList.toggle('active', videoOn() && lib.videos[+t.dataset.i].path === S.videoPath));
  }
  function paintThumb(i, t) {
    const el = $(`#vgrid .vt[data-i="${i}"] .th`); if (!el) return;
    if (t.img) { el.style.backgroundImage = `url(${t.img})`; el.firstChild.textContent = ''; }
    if (t.dur) el.querySelector('i').textContent = clockStr(t.dur);
  }
  // one hidden player grabs a frame from each file in turn; results are cached while the app runs
  const tv = document.createElement('video'); tv.muted = true; tv.preload = 'metadata';
  const tcv = document.createElement('canvas'); tcv.width = 320; tcv.height = 180;
  function grab(url) {
    return new Promise((res) => {
      let done = false; const out = { img: '', dur: 0 };
      const fin = () => { if (done) return; done = true; clearTimeout(to); tv.onloadedmetadata = tv.onseeked = tv.onerror = null; tv.removeAttribute('src'); tv.load(); res(out); };
      const to = setTimeout(fin, 7000);
      tv.onerror = fin;
      tv.onloadedmetadata = () => { out.dur = isFinite(tv.duration) ? tv.duration : 0; tv.currentTime = Math.min((out.dur || 10) * 0.12, 90); };
      tv.onseeked = () => {
        try {
          const g = tcv.getContext('2d'), vw = tv.videoWidth, vh = tv.videoHeight;
          if (vw && vh) { const k = Math.max(320 / vw, 180 / vh); g.drawImage(tv, (320 - vw * k) / 2, (180 - vh * k) / 2, vw * k, vh * k); out.img = tcv.toDataURL('image/jpeg', 0.7); }
        } catch { /* leave the placeholder */ }
        fin();
      };
      tv.src = url;
    });
  }
  async function makeVideoThumbs(job) {
    const vids = lib.videos;
    for (let i = 0; i < vids.length; i++) {
      if (job !== libJob) return;
      let t = thumbs.get(vids[i].path);
      if (!t) { t = await grab(vids[i].url); thumbs.set(vids[i].path, t); }
      if (job === libJob) paintThumb(i, t);
    }
  }

  // wiring
  document.addEventListener('change', (e) => { if (e.target.type === 'range') e.target.blur(); });
  const P = (p) => api.patch(p);
  $$('.tabs button').forEach((x) => x.addEventListener('click', () => setTab(x.dataset.tab, true)));
  $('#tiles').addEventListener('click', (e) => { const t = e.target.closest('.tile'); if (!t) return; if (t.dataset.id === 'video' && !S.video.files.length) { api.cmd({ type: 'pick-video', key: me.key }); return; } P(S.mode === 'mix' ? { perDisplay: { [me.key]: t.dataset.id } } : { scene: t.dataset.id }); });
  $('#palettes').addEventListener('click', (e) => { const t = e.target.closest('.sw'); if (t) P({ palette: t.dataset.id }); });
  $('#cycleSecs').addEventListener('change', (e) => P({ cycleSecs: +e.target.value }));
  $('#overlay').addEventListener('change', (e) => P({ overlay: e.target.value }));
  $('#algoInfo').addEventListener('change', (e) => P({ algoInfo: e.target.checked }));
  $('#mode').addEventListener('click', (e) => { const v = e.target.dataset.v; if (v) P({ mode: v }); });
  $('#source').addEventListener('click', (e) => { const v = e.target.dataset.v; if (v) P({ music: { source: v, playing: true } }); });
  $('#presets').addEventListener('click', (e) => { const t = e.target.closest('.preset'); if (t) P({ music: { preset: t.dataset.id, playing: true } }); });
  $('#monitors').addEventListener('click', (e) => {
    const t = e.target.closest('.mon'); if (!t) return; const i = +t.dataset.i;
    const off = S.displaysOff.includes(i) ? S.displaysOff.filter((x) => x !== i) : [...S.displaysOff, i];
    if (off.length >= init.displays.length) { toast('At least one monitor has to stay on'); return; }
    P({ displaysOff: off });
  });
  for (const k of ['speed', 'brightness', 'reactivity']) $('#' + k).addEventListener('input', (e) => { fill(e.target); P({ [k]: +e.target.value }); });
  $('#volume').addEventListener('input', (e) => { fill(e.target); P({ music: { volume: +e.target.value } }); });
  $$('[data-nature]').forEach((x) => x.addEventListener('input', () => { fill(x); P({ music: { nature: { [x.dataset.nature]: +x.value } } }); }));
  for (const k of ['autoCycle', 'quality', 'fps']) $('#' + k).addEventListener('change', (e) => P({ [k]: +e.target.value }));
  for (const k of ['cycleShuffle', 'clock', 'breathing', 'keepAwake', 'onTop']) $('#' + k).addEventListener('change', (e) => P({ [k]: e.target.checked }));
  $('#shuffle').addEventListener('change', (e) => P({ music: { shuffle: e.target.checked } }));
  $('#sleep').addEventListener('change', (e) => P({ sleepAt: +e.target.value ? Date.now() + +e.target.value * 60000 : 0 }));
  $('#pickVideo').addEventListener('click', () => api.cmd({ type: 'pick-video', key: me.key }));
  $('#videoFit').addEventListener('change', (e) => P({ video: { fit: e.target.value } }));
  $('#videoLayout').addEventListener('change', (e) => P({ video: { layout: e.target.value } }));
  $('#videoSound').addEventListener('change', (e) => P({ video: { sound: e.target.checked } }));
  $('#stopVideo').addEventListener('click', () => api.cmd({ type: 'stop-video', key: me.key }));
  $('#addVFolder').addEventListener('click', () => api.cmd({ type: 'add-video-folder' }));
  $('#vfolders').addEventListener('click', (e) => {
    const f = e.target.closest('.vf'); if (!f) return;
    if (e.target.tagName === 'BUTTON') { if (libRoot === f.dataset.p) { libRoot = ''; libDir = ''; } api.cmd({ type: 'remove-video-folder', path: f.dataset.p }); }
    else { libRoot = f.dataset.p; openDir(libRoot); }
  });
  $('#vgrid').addEventListener('click', (e) => {
    const t = e.target.closest('.vt'); if (!t || !lib) return;
    if (t.dataset.dir) openDir(t.dataset.dir);
    else api.cmd({ type: 'play-videos', files: lib.videos.map((v) => v.path), index: +t.dataset.i, key: me.key });
  });
  $('#vcrumb').addEventListener('click', (e) => { if (e.target.closest('button') && lib && lib.parent) openDir(lib.parent); });
  const setVol = (v) => P(volIsVideo() ? { video: { volume: v } } : { music: { volume: v } });
  $('#qvol').addEventListener('input', (e) => { fill(e.target); setVol(+e.target.value); });
  $('#vsound').addEventListener('click', () => P({ video: { sound: !S.video.sound } }));
  const seekEl = $('#seek');
  seekEl.addEventListener('pointerdown', () => { seeking = true; });
  seekEl.addEventListener('input', () => {
    fill(seekEl); $('#vcur').textContent = clockStr(+seekEl.value);
    if (performance.now() - lastJump > 140) { lastJump = performance.now(); api.cmd({ type: 'video-jump', pos: +seekEl.value }); }
  });
  seekEl.addEventListener('change', () => { api.cmd({ type: 'video-jump', pos: +seekEl.value }); setTimeout(() => { seeking = false; }, 400); });
  $('#addFiles').addEventListener('click', () => api.cmd({ type: 'add-files' }));
  // play / pause: Spotify when that's the music source (and no video is up), otherwise Drift's own sound + video
  const ctxToggle = () => {
    const c = ctx();
    if (c === 'scene') P({ frozen: !S.frozen });
    else if (c === 'video') {
      if (videoOn()) P({ video: { paused: !S.video.paused } });
      else if (S.video.files.length) P({ ...(S.mode === 'mix' ? { perDisplay: { [me.key]: 'video' } } : { scene: 'video' }), video: { paused: false } });   // bring the last video back
      else toast('Pick a video in the Video tab first', 1800);
    }
    else if (S.music.source === 'spotify') api.cmd({ type: 'spotify', action: 'toggle' });
    else if (S.music.source === 'off') toast('Music is off — choose Ambient, My music or Spotify', 2200);
    else P({ music: { playing: !S.music.playing } });
  };
  const ctxStep = (dir) => {
    const c = ctx();
    if (c === 'scene') stepScene(dir);
    else if (c === 'video') {
      if (!videoOn()) toast('Pick a video in the Video tab first', 1800);
      else if (dir < 0 && video.currentTime > 4) api.cmd({ type: 'video-jump', pos: 0 });      // first press of "previous" restarts the video
      else api.cmd({ type: 'video-step', dir });
    }
    else if (S.music.source === 'spotify') api.cmd({ type: 'spotify', action: dir > 0 ? 'next' : 'prev' });
    else if (S.music.source === 'files') api.cmd({ type: dir > 0 ? 'next' : 'prev' });
    else if (S.music.source === 'generative') { const i = PRESETS.findIndex((x) => x.id === S.music.preset), n = PRESETS[(i + dir + PRESETS.length) % PRESETS.length]; P({ music: { preset: n.id, playing: true } }); toast(n.name, 1200); }
  };
  $('#spPlay').addEventListener('click', () => api.cmd({ type: 'spotify', action: 'toggle' }));
  $('#spPrev').addEventListener('click', () => api.cmd({ type: 'spotify', action: 'prev' }));
  $('#spNext').addEventListener('click', () => api.cmd({ type: 'spotify', action: 'next' }));
  $('#spOpen').addEventListener('click', () => api.cmd({ type: 'spotify', action: 'open' }));
  $('#mfolders').addEventListener('click', (e) => {
    if (e.target.closest('.add')) { api.cmd({ type: 'add-music-folder' }); return; }
    const f = e.target.closest('.vf'); if (!f) return;
    if (e.target.tagName === 'BUTTON') { if (mRoot === f.dataset.p) { mRoot = ''; mDir = ''; } api.cmd({ type: 'remove-music-folder', path: f.dataset.p }); }
    else { mRoot = f.dataset.p; $('#msearch').value = ''; openMusicDir(mRoot); }
  });
  $('#mcrumb').addEventListener('click', (e) => { if (e.target.closest('button') && mLib && mLib.parent) { $('#msearch').value = ''; openMusicDir(mLib.parent); } });
  $('#playlist').addEventListener('click', (e) => {
    const d = e.target.closest('div'); if (!d || !mLib) return;
    if (d.dataset.dir) { $('#msearch').value = ''; openMusicDir(d.dataset.dir); }
    else if (d.dataset.i) api.cmd({ type: 'play-tracks', files: mLib.videos.map((v) => v.path), index: +d.dataset.i });
  });
  let mTimer, vTimer;
  $('#msearch').addEventListener('input', (e) => { clearTimeout(mTimer); mTimer = setTimeout(() => { const q = e.target.value.trim(); if (q) searchMusic(q); else openMusicDir(mDir && mDir !== '?' ? mDir : mRoot); }, 250); });
  $('#vsearch').addEventListener('input', (e) => { clearTimeout(vTimer); vTimer = setTimeout(() => { const q = e.target.value.trim(); if (q) searchVideos(q); else openDir(libRoot); }, 250); });
  $('#reset').addEventListener('click', () => api.cmd({ type: 'reset' }));
  $('#play').addEventListener('click', ctxToggle);
  $('#prevTrack').addEventListener('click', () => ctxStep(-1));
  $('#nextTrack').addEventListener('click', () => ctxStep(1));
  $('#exit').addEventListener('click', () => api.cmd({ type: 'quit' }));

  function stepScene(dir) {
    if (S.mode === 'mix') { const i = SCENES.findIndex((x) => x.id === sceneFor(S)); P({ perDisplay: { [me.key]: SCENES[(i + dir + SCENES.length) % SCENES.length].id } }); }
    else api.cmd({ type: 'step-scene', dir });
  }
  let toastTimer;
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms); }

  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT') return;
    if (e.target.type === 'search') { if (e.key === 'Escape') e.target.blur(); return; }   // typing in a search box
    const k = e.key;
    if (k === 'Escape') { if (panel.classList.contains('show') && panel.classList.contains('open')) { panel.classList.remove('open'); syncUI(); } else api.cmd({ type: 'quit' }); }
    else if (k === 'Tab' || k === 'h' || k === 'H') { e.preventDefault(); if (panel.classList.contains('show') && panel.classList.contains('open')) hidePanel(), panel.classList.remove('open'); else { showPanel(true); syncUI(); } }
    else if (k === 'ArrowRight') ctxStep(1);
    else if (k === 'ArrowLeft') ctxStep(-1);
    else if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      const v = Math.max(0, Math.min(1, +((volIsVideo() ? S.video.volume : S.music.volume) + (k === 'ArrowUp' ? 0.05 : -0.05)).toFixed(2)));
      setVol(v); toast('Volume ' + Math.round(v * 100) + '%', 1200);
    }
    else if (k === ' ') { e.preventDefault(); ctxToggle(); }
    else if (k === 'n' || k === 'N') ctxStep(1);
    else if (k === 'p' || k === 'P') { const ids = [...Object.keys(PALETTES), 'cycle']; const n = ids[(ids.indexOf(S.palette) + 1) % ids.length]; P({ palette: n }); toast(n === 'cycle' ? 'Colour cycle' : PALETTES[n].name, 1200); }
    else if (k === 'c' || k === 'C') P({ clock: !S.clock });
    else if (k === 'b' || k === 'B') P({ breathing: !S.breathing });
    else if (/^[1-9]$/.test(k) && SCENES[+k - 1] && ctx() === 'scene') P(S.mode === 'mix' ? { perDisplay: { [me.key]: SCENES[+k - 1].id } } : { scene: SCENES[+k - 1].id });
  });

  // ---------- state sync ----------
  api.on('state', (ns) => {
    const prevPal = S.palette;
    S = ns; resize();
    if (sceneFor(S) !== shown) setScene(sceneFor(S));
    syncVideo();
    syncUI();
    if (prevPal !== S.palette && panel.classList.contains('open')) makeThumbs();
  });
  api.on('levels', (m) => {
    const l = Array.isArray(m) ? m : m.l;
    audioTarget[0] = l[0]; audioTarget[1] = l[1]; audioTarget[2] = l[2];
    if (m.s) for (let i = 0; i < 64; i++) { specTarget[i] = m.s[i]; specTarget[64 + i] = m.w[i]; }
    if (m.b) beats = m.b;
    if (m.a !== undefined) { if (Math.abs(m.a - aTimeTarget) > 5) aTime = m.a; aTimeTarget = m.a; }
  });
  api.on('now', (n) => { S.nowPlaying = n; syncUI(); });
  api.on('cmd', (c) => { if (c.type === 'show-panel') { tab = c.tab; showPanel(true); clearTimeout(hideTimer); syncUI(); } });

  resize(); syncUI(); requestAnimationFrame(frame);
  if (!R) toast('Your graphics driver has WebGL disabled — visuals cannot start.', 10000);
  else if (isCenter && !init.testMode) { toast('Move the mouse for controls  ·  Esc to exit', 5000); }
  document.body.classList.add('idle');
})();
