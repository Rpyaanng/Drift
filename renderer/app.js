/* Drift — per-monitor renderer: WebGL scene + control panel */
(async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const api = window.drift;
  const init = await api.init();
  let S = init.state;
  const me = { key: init.key, index: init.index, bounds: init.bounds, union: init.union };
  // Is this screen showing HDR right now? (Windows' HDR switch for this monitor.) The main process is told, and told again if it changes.
  const hdrQuery = matchMedia('(dynamic-range: high)');
  const myHdr = () => (init.fakeHdr ? init.fakeHdr === '1' : hdrQuery.matches);
  const tellHdr = () => api.cmd({ type: 'hdr', on: myHdr() });
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
    if (S.palette === 'custom' && Array.isArray(S.customColors)) return S.customColors.map(hex);
    if (S.palette !== 'cycle') return rgb(PALETTES[S.palette] ? S.palette : 'aurora');
    const T = (at || Date.now()) / 1000 / Math.max(5, S.cycleSecs || 30), i = Math.floor(T), f = T - i;
    const a = rgb(PAL_IDS[i % PAL_IDS.length]), b = rgb(PAL_IDS[(i + 1) % PAL_IDS.length]);
    const k = f < 0.65 ? 0 : (x => x * x * (3 - 2 * x))((f - 0.65) / 0.35);
    return a.map((c, j) => c.map((v, n) => v + (b[j][n] - v) * k));
  }
  const customNow = () => (Array.isArray(S.customColors) ? [...S.customColors] : [...PALETTES.aurora.c]);
  function rgbToHsl([r, g, b]) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslToHex(h, s, l) {
    h = ((h % 1) + 1) % 1;
    const f = (n) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return toHex([f(0), f(8), f(4)]);
  }
  let thumbTimer = 0;
  // the controls take the palette's main colour, lifted when it is too dim to see on the panel (the Dark palette)
  const accentHex = () => { const c = currentColors()[2], m = Math.max(...c, 0.001); return toHex(m < 0.6 ? c.map((v) => Math.min(1, v * 0.6 / m)) : c); };
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
  const ctx = () => { if (tab !== 'settings') lastCtx = { scenes: 'scene', video: 'video', music: 'music', share: 'video' }[tab]; return lastCtx; };
  const volIsSpotify = () => !volIsVideo() && S.music.source === 'spotify';
  const volNow = () => (volIsVideo() ? S.video.volume : volIsSpotify() ? ((S.spotify || {}).vol || 0) : S.music.volume);
  const volIsVideo = () => (ctx() === 'video' ? true : ctx() === 'music' ? false : videoOn() && S.video.sound);
  // A video this screen can't show as it is (HDR on an SDR screen, a codec the player lacks, a smaller copy from a friend's PC)
  // arrives converted, as a live stream that begins at S.xc.start. A stream can't be searched: every jump is a new stream.
  const useX = () => { const x = S.xc || {}; return !!x.base && (x.all || (x.sdr && !myHdr())); };
  let xOn = false, xStart = 0, xBehind = 0, holdTimer = 0, xSetAt = 0, lastTarget = 0, lastTSeq, lastTUrl = '';
  video.addEventListener('loadeddata', () => { if (xOn && xSetAt) { api.cmd({ type: 'xc-started', ms: performance.now() - xSetAt }); xSetAt = 0; } });
  const vTime = () => (xOn ? xStart : 0) + video.currentTime;
  const vDur = () => { const d = (S.videoInfo || {}).dur || 0; return !xOn && isFinite(video.duration) && video.duration > 0 ? video.duration : d; };
  // A friend's video comes over the network, where a jump takes a moment: aim ahead by about that long, then wait for the clock.
  const far = () => (S.p2p || {}).role === 'guest' && !S.p2p.own;
  let farLead = 0.8, farAt = 0;
  video.addEventListener('seeked', () => { if (farAt) { farLead = Math.max(0.4, Math.min(6, (performance.now() - farAt) / 1000 * 1.25 + 0.2)); farAt = 0; } });
  function syncVideo() {
    const on = shown === 'video' && !!S.videoUrl;
    video.style.display = on ? 'block' : 'none';
    canvas.style.display = on ? 'none' : 'block';
    if (!on) { if (!video.paused) video.pause(); syncSound(false); vbg.style.display = 'none'; bgOn = false; return; }
    const x = useX(), url = x ? `${S.xc.base}&t=${S.xc.start}&e=${S.xc.epoch}` : S.videoUrl;
    if (curUrl !== url) { curUrl = url; xOn = x; xStart = x ? S.xc.start : 0; xBehind = 0; farAt = 0; video.src = url; seekHold = 0; xSetAt = x ? performance.now() : 0; }
    const lead = S.videoLeader === me.key;
    video.loop = !xOn && S.video.files.length === 1 && S.video.autoplay !== false;
    const converted = !xOn && S.videoAudio && S.videoAudio.mode === 'transcode' && !!S.audioBase;      // a converted stream carries its own sound
    video.muted = !(lead && S.video.sound) || converted;
    syncSound(lead && S.video.sound && converted);
    video.volume = S.video.volume;
    // Fit: Auto keeps the whole picture when its shape doesn't match the screen (vertical phone video), and fills when it nearly does.
    const spanIt = S.mode === 'span';
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
    const playing = !S.video.paused, now = performance.now(), dur = vDur();
    let target = playing ? (Date.now() - S.vclock.startedAt) / 1000 : S.vclock.pos;
    const early = playing && target < 0;        // the clock is being held back a moment so every screen (and friend) starts together
    if (early) target = 0;
    if (S.video.files.length === 1 && dur > 1) target %= dur;       // a single video loops
    let hold = early, rate = 1, drift = 0;
    if (xOn) {
      drift = vTime() - target;
      if (playing && drift > 0.06) hold = true;                                    // ready before the clock got there: wait for it
      else if (playing && Math.abs(drift) > 0.012) rate = Math.max(0.94, Math.min(1.12, 1 - drift * 0.5));
      const looped = playing && S.video.files.length === 1 && lastTarget - target > 1 && lastTSeq === S.vclock.seq && lastTUrl === curUrl;      // a single video went back to its start
      xBehind = playing && (drift < -3 || drift > 9) ? (xBehind || now) : 0;
      if (looped || (xBehind && now - xBehind > 2500)) { xBehind = 0; api.cmd({ type: 'xc-trouble', index: S.video.index }); }     // can't catch up: ask for a stream that starts from here
    } else if (isFinite(video.duration) && video.duration > 0 && (video.loop || target < video.duration)) {      // (past the end: wait for the next one)
      const d = video.duration;
      drift = video.currentTime - target;
      if (Math.abs(drift) > 0.3 && Math.abs(drift) < d - 0.3) {
        if (far() && playing && drift > 0 && drift < 6 && !video.seeking) hold = true;
        else if (now > seekHold) {
          const lead2 = far() && playing ? farLead : 0;
          video.currentTime = Math.min(Math.max(0, d - 0.2), target + lead2); seekHold = now + (lead2 ? 5000 : 2000); farAt = lead2 ? now : 0;
        }
      } else if (Math.abs(drift) > 0.012 && Math.abs(drift) < 1) rate = Math.max(0.94, Math.min(1.06, 1 - drift * 0.6));
    }
    lastTarget = target; lastTSeq = S.vclock.seq; lastTUrl = curUrl;
    if (!playing || hold) { if (!video.paused) video.pause(); } else if (video.paused && !video.ended) video.play().catch(() => {});
    video.playbackRate = rate;
    clearTimeout(holdTimer);
    if (hold && !early && drift < 0.3) holdTimer = setTimeout(syncVideo, Math.max(10, drift * 1000));      // start again exactly when the clock arrives
  }
  // Watching with a friend: tell their PC when this one has loaded enough to play, so it can wait for us (or carry on).
  let rdySent = '', rdyBadAt = 0;
  function reportReady() {
    const p = S.p2p || {};
    if (p.role !== 'guest' || p.status !== 'connected') { rdySent = ''; return; }
    const on = shown === 'video' && !!S.videoUrl;
    if (on ? S.videoLeader !== me.key : me.index !== init.displays.filter((d) => !S.displaysOff.includes(d.index)).map((d) => d.index)[0]) return;     // one window speaks for this PC
    let ahead = 0; const t = video.currentTime, b = video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.1 && b.end(i) > t) ahead = b.end(i) - t;
    const ok = !on || (!video.seeking && (video.readyState === 4 || (video.readyState >= 3 && ahead > 1.2)));
    const key = p.file + '|' + ok, now = performance.now();
    if (key === rdySent) { rdyBadAt = 0; return; }
    if (!ok && rdySent.startsWith(p.file + '|')) { if (!rdyBadAt) rdyBadAt = now; if (now - rdyBadAt < 900) return; }     // a brief hiccup isn't worth pausing everyone for
    rdySent = key; rdyBadAt = 0; api.cmd({ type: 'share-ready', ok });
  }
  setInterval(reportReady, 400);
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
  // A copy of Drift without ffmpeg can't convert Dolby / DTS sound, so the picture plays in silence. Say why, once per video.
  let silentFor = '', silentAt = 0;
  function checkSilent() {
    const va = S.videoAudio || {};
    if (va.ffmpeg !== false || S.videoLeader !== me.key || !S.video.sound || shown !== 'video' || video.paused) { silentAt = 0; return; }
    if (silentFor === S.videoUrl) return;
    if (!silentAt) { silentAt = performance.now(); return; }
    if (performance.now() - silentAt < 4000 || video.currentTime < 2) return;
    silentFor = S.videoUrl;
    if (!video.webkitAudioDecodedByteCount) toast('No sound? This video may use Dolby or DTS audio, and this copy of Drift is missing ffmpeg.exe to convert it.', 9000);
  }
  // ---------- subtitles ----------
  const subsEl = $('#subs'), subText = $('#subText');
  let cues = [], cueSeq = -1, cueKey = '', cueBusy = false, subAsk = false;
  const subMine = () => { const U = me.union, mid = U.x + U.width / 2; return mid >= me.bounds.x && mid < me.bounds.x + me.bounds.width; };   // a spanned video shows them on the middle screen
  async function syncSubs() {
    const info = S.subsInfo || {}, st = S.subs || {};
    subsEl.style.setProperty('--sub-size', st.size || 1);
    subsEl.style.setProperty('--sub-color', st.color || '#ffffff');
    subsEl.style.setProperty('--sub-lift', st.lift || 0);
    for (const b of ['outline', 'shadow', 'box']) subsEl.classList.toggle('bg-' + b, (st.bg || 'outline') === b);
    if (subAsk && !info.busy) { subAsk = false; const tr = (info.tracks || []).find((t) => t.id === info.sel); toast(info.note || (tr ? 'Subtitles: ' + tr.label : 'Subtitles off'), info.note ? 5000 : 2200); }
    if (info.seq === cueSeq || cueBusy) return;
    cueBusy = true;
    try { const r = await api.subCues(); cues = r.cues || []; cueSeq = r.seq; } catch { cues = []; }
    cueBusy = false; cueKey = '';
    if (cueSeq !== (S.subsInfo || {}).seq) syncSubs();
  }
  function drawSubs() {
    const info = S.subsInfo || {};
    const spanIt = S.mode === 'span';
    let html = '', top = false;
    if (shown === 'video' && S.videoUrl && info.sel && cues.length && (!spanIt || subMine())) {
      const t = vTime() - (info.offset || 0);
      let lo = 0, hi = cues.length - 1, at = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (cues[mid].s <= t) { at = mid; lo = mid + 1; } else hi = mid - 1; }
      const live = [];
      for (let i = at; i >= 0 && i > at - 8; i--) if (cues[i].e > t) live.unshift(cues[i]);
      html = live.map((c) => c.t).join('\n'); top = live.length > 0 && live.every((c) => c.top);
    }
    if (html) subsEl.style.setProperty('--raise', (panel.classList.contains('show') ? Math.min(innerHeight * 0.66, innerHeight - panel.getBoundingClientRect().top + 16) : 0) + 'px');
    const key = html + '|' + top;
    if (key === cueKey) return;
    cueKey = key; subText.innerHTML = html.replace(/\n/g, '<br>');
    subsEl.classList.toggle('on', !!html); subsEl.classList.toggle('top', top);
  }
  setInterval(drawSubs, 50);
  setInterval(checkSilent, 1000);
  setInterval(syncVideo, 250);
  video.addEventListener('loadedmetadata', syncVideo);
  video.addEventListener('ended', () => {
    if (xOn && vDur() - vTime() > 4) { api.cmd({ type: 'xc-trouble', index: S.video.index, hard: true }); return; }      // the converted stream stopped short
    if (S.videoLeader === me.key) api.cmd({ type: 'video-next', index: S.video.index, stream: xOn });
  });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    if (xOn) { api.cmd({ type: 'xc-trouble', index: S.video.index, hard: true }); return; }
    const code = (video.error || {}).code;
    if (far() && (code === 2 || (S.p2p || {}).status !== 'connected')) { setTimeout(() => { curUrl = ''; syncVideo(); }, 2000); return; }     // the connection dropped: try again shortly
    if (S.videoLeader === me.key) api.cmd({ type: 'video-failed', index: S.video.index });       // the main process converts it if it can, or moves on
  });

  // ---------- overlays ----------
  const U = me.union, cx = U.x + U.width / 2, cy = U.y + U.height / 2, b = me.bounds;
  const isCenter = cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
  const clockEl = $('#clockFace'), breathEl = $('#breath'), ring = $('#breath .ring'), breathTxt = $('#breath span');
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
    if (panel.classList.contains('show') && videoOn() && vDur() > 0) {
      const sk = $('#seek'), at = Math.min(vDur(), vTime());
      sk.max = vDur();
      if (!seeking) { sk.value = at; $('#vcur').textContent = clockStr(at); }
      fill(sk); $('#vdur').textContent = clockStr(vDur());
    }
    if (S.palette === 'cycle' && performance.now() - accentAt > 500) { accentAt = performance.now(); document.documentElement.style.setProperty('--accent', accentHex()); }
    const sl = $('#o-sleep');
    if (S.sleepAt > Date.now()) { const m = Math.ceil((S.sleepAt - Date.now()) / 60000); sl.textContent = m + ' min left'; } else if (sl.textContent) sl.textContent = '';
  }

  // ---------- thumbnails ----------
  const tcan = document.createElement('canvas'); tcan.width = 256; tcan.height = 144;
  let TR = null, thumbPalette = null, thumbJob = 0;
  function makeThumbs() {
    const palKey = S.palette + (S.palette === 'custom' ? (S.customColors || []).join('') : '');
    if (thumbPalette === palKey) return;
    thumbPalette = palKey; const job = ++thumbJob;
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

  // ---------- "Close Drift?" ----------
  // Esc, the ✕ button and Alt+F4 all ask first. Enter closes, Esc (or a click outside) stays.
  const confirmEl = $('#confirm');
  function askQuit() {
    const p = S.p2p || {}, n = (p.peers || []).length;
    $('#confirmNote').textContent = p.role === 'host' && n ? `${n === 1 ? p.peers[0].name : n + ' friends'} will stop seeing your video.`
      : p.role === 'guest' ? `You'll leave ${p.host || 'your friend'}'s video.` : 'Your settings are saved for next time.';
    $('#confirmMon').style.display = init.displays.filter((d) => !S.displaysOff.includes(d.index)).length > 1 ? '' : 'none';
    confirmEl.classList.add('on'); $('#confirmYes').focus();
  }
  function closeAsk() { confirmEl.classList.remove('on'); document.activeElement?.blur(); }

  // ---------- panel ----------
  const panel = $('#panel');
  let tab = 'scenes', hideTimer = null, overPanel = false;
  const tileHtml = (s) => { const i = SCENES.indexOf(s); return `<button class="tile" data-id="${s.id}"><kbd>${i < 9 ? i + 1 : ''}</kbd><span>${s.name}</span></button>`; };
  $('#tiles').innerHTML = `<div class="tilegrid">${SCENES.filter((s) => !s.group).map(tileHtml).join('')}</div>`
    + `<h3 class="sub">Landscapes</h3><div class="tilegrid">${SCENES.filter((s) => s.group === 'land').map(tileHtml).join('')}</div>`
    + `<h3 class="sub">Algorithms</h3><div class="tilegrid">${SCENES.filter((s) => s.group === 'algo').map(tileHtml).join('')}</div>`
    + `<h3 class="sub">3D geometry</h3><div class="tilegrid">${SCENES.filter((s) => s.group === '3d').map(tileHtml).join('')}</div>`
    + `<h3 class="sub">Mathematical geometry</h3><div class="tilegrid">${SCENES.filter((s) => s.group === 'geo').map(tileHtml).join('')}</div>`;
  $('#palettes').innerHTML = Object.entries(PALETTES).map(([id, p]) => `<button class="sw" data-id="${id}" title="${p.name}" style="background:linear-gradient(90deg,${p.c.join(',')})"></button>`).join('')
    + `<button class="sw cyc" data-id="cycle" title="Cycle through every colour" style="background:linear-gradient(90deg,${Object.values(PALETTES).map((p) => p.c[2]).join(',')})">↻</button>`
    + `<button class="sw cus" data-id="custom" title="Your own colours">✎</button>`;
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
  addEventListener('mousedown', (e) => { if (!panel.contains(e.target) && !confirmEl.contains(e.target)) { if (panel.classList.contains('open')) { panel.classList.remove('open'); } else showPanel(); } });

  const fill = (el) => el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');
  const setVal = (el, v) => { if (document.activeElement !== el || el.tagName !== 'INPUT') { el.value = v; } if (el.type === 'range') fill(el); };
  const base = (p) => p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  let plKey = '';

  function syncUI() {
    document.documentElement.style.setProperty('--accent', accentHex());
    $('#cycleSecs').value = String(S.cycleSecs); $('#cycleSecs').disabled = S.palette !== 'cycle';
    $('#overlay').value = S.overlay; $('#algoInfo').checked = !!S.algoInfo;
    const cur = sceneFor(S);
    $$('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    $$('#content section').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    $$('.tile').forEach((x) => x.classList.toggle('active', x.dataset.id === cur));
    $$('.sw').forEach((x) => x.classList.toggle('active', x.dataset.id === S.palette));
    const cc = customNow();
    $('.sw.cus').style.background = `linear-gradient(90deg,${cc.join(',')})`;
    $('#customRow').classList.toggle('on', S.palette === 'custom');
    $$('#customRow input').forEach((el) => { if (document.activeElement !== el) el.value = cc[+el.dataset.i]; });
    $$('#mode button').forEach((x) => x.classList.toggle('active', x.dataset.v === S.mode));
    const multi = init.displays.filter((d) => !S.displaysOff.includes(d.index)).length > 1;
    $('#modeHint').textContent = S.mode === 'span' ? 'Spanned across monitors' : S.mode === 'mirror' ? 'Mirrored on each monitor' : 'Mix: picking for this monitor';
    $('#modeHint').style.display = multi ? '' : 'none';
    $('#modeNote').textContent = !multi ? 'Only one monitor is on, so this changes nothing yet.'
      : S.mode === 'span' ? 'Scenes and videos stretch as one picture across all monitors.'
      : S.mode === 'mirror' ? 'Each monitor shows the whole scene or video.'
      : 'Each monitor plays its own scene or video: open the panel on a monitor and pick one there.';
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
    $('#qvol').disabled = volIsSpotify() && !sp.volMode; $('#qvol').style.opacity = $('#qvol').disabled ? 0.35 : 1;
    $('#spVolNote').textContent = !spOn || sp.status === 'unsupported' ? '' : sp.volMode === 'app' ? 'The volume bar controls Spotify\'s own volume.' : sp.volMode === 'system' ? 'The volume bar controls your PC\'s main volume until Spotify starts playing.' : 'Volume control is starting…';
    $('#offnote').style.display = S.music.source === 'off' ? '' : 'none';
    const sc = SCENES.find((x) => x.id === cur);
    $('#videoFit').value = S.video.fit; $('#videoSound').checked = !!S.video.sound; $('#videoAuto').checked = S.video.autoplay !== false;
    $('#stopVideo').style.display = cur === 'video' ? '' : 'none';
    const va = S.videoAudio || {}, vi = S.videoInfo || {}, pp = S.p2p || {}, guest = pp.role === 'guest';
    syncSubUI(); syncShareUI(); syncConvertUI();
    const from = guest ? ` (shared by ${pp.host || 'a friend'})` : '';
    $('#vnote').textContent = !videoOn() ? (guest ? `${pp.host || 'Your friend'} isn't playing a video right now.` : 'Pick a video to play it on your monitors.' + (S.video.autoplay !== false ? ' Videos in the same folder play one after another.' : ' Autoplay is off, so each video stops when it ends.'))
      : useX() ? `Now playing: ${S.videoName}${from} — ${pp.viaHost ? `${pp.host}'s PC is sending a ${pp.quality === 'original' ? 'converted' : pp.quality + 'p'} copy.`
        : vi.hdr && !vi.force ? 'this HDR video is being converted to SDR for this screen.' : vi.hdr ? 'it is being converted (HDR to SDR) so it can play here.' : 'the built-in player can\'t play this format, so it is being converted live.'}`
      : va.ffmpeg === false && !guest ? `Now playing: ${S.videoName} — this copy of Drift is missing ffmpeg.exe, so Dolby / DTS sound and HDR video can't be converted and subtitles stored inside a video can't be read. Put ffmpeg.exe in Drift's "resources" folder and restart.`
      : va.mode === 'transcode' && va.ffmpeg !== false ? `Now playing: ${S.videoName}${from} — its ${va.codec.toUpperCase().replace('EAC3', 'Dolby Digital Plus (E-AC-3)').replace(/^AC3$/, 'Dolby Digital (AC-3)')} sound is being converted live so you can hear it.`
      : va.mode === 'none' ? `Now playing: ${S.videoName}${from} — this file has no audio track.` : `Now playing: ${S.videoName}${from}${pp.own ? ' — playing your own copy of this file.' : ''}`;
    renderFolders(); markPlaying();
    panel.classList.toggle('hasvideo', videoOn());
    $('#vsound').style.display = videoOn() || ctx() === 'video' ? '' : 'none';
    $('#vsound').textContent = S.video.sound ? '🔊' : '🔇';
    setVal($('#qvol'), volNow());
    $('#qvol').title = volIsVideo() ? 'Video volume' : !volIsSpotify() ? 'Music volume' : sp.volMode === 'app' ? 'Spotify volume' : sp.volMode === 'system' ? 'PC volume (Spotify is not playing yet)' : 'Spotify volume is not available';
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

  // ---------- watch together: the Together tab ----------
  const QNAME = { original: 'Original', 1080: '1080p', 720: '720p', 480: '480p' };
  function syncShareUI() {
    const p = S.p2p || { role: 'off', peers: [] }, sh = S.share || {}, peers = p.peers || [], n = peers.length;
    $('#shOff').style.display = p.role === 'off' ? '' : 'none';
    $('#shHost').style.display = p.role === 'host' ? '' : 'none';
    $('#shGuest').style.display = p.role === 'guest' ? '' : 'none';
    $('.tabs button[data-tab="share"]').classList.toggle('live', p.role !== 'off');
    $('#shNote').textContent = p.note || '';
    if (p.role === 'host') {
      const wait = p.waitingFor || [];
      $('#shHost .spnow').classList.toggle('live', p.status === 'ready');
      $('#shTitle').textContent = p.status !== 'ready' ? 'Starting…' : wait.length ? `Paused while ${wait.join(' and ')} ${wait.length > 1 ? 'load' : 'loads'}…`
        : n ? `Sharing with ${n === 1 ? peers[0].name : n + ' friends'}` : 'Sharing — waiting for friends to join';
      $('#shSub').textContent = p.settling ? 'Getting your invite code ready…' : (p.reach === 'internet' ? 'Friends anywhere can join with this code.' : 'Friends on your network can join with this code.')
        + (videoOn() ? '' : ' Play a video and they will see it too.');
      const shown = p.settling ? '' : p.code || '';
      if ($('#shCodeOut').textContent !== shown) $('#shCodeOut').textContent = shown;
      $('#shCopy').style.opacity = p.settling ? 0.4 : 1; $('#shCopy').style.pointerEvents = p.settling ? 'none' : '';
      $('#shCopy').textContent = p.settling ? 'Preparing…' : 'Copy invite code';
    } else if (p.role === 'guest') {
      const live = p.status === 'connected';
      $('#shGuest .spnow').classList.toggle('live', live);
      $('#shGTitle').textContent = live ? `Watching with ${p.host || 'a friend'}` : p.status === 'reconnecting' ? 'Connection lost — trying again…' : 'Connecting…';
      $('#shGSub').textContent = !live ? '' : !S.videoName ? `${p.host || 'Your friend'} isn't playing a video right now.`
        : S.videoName + (p.own ? ' · playing your own copy of this file' : p.viaHost ? ` · ${p.quality === 'original' ? 'converted' : p.quality + 'p'} from ${p.host}'s PC` : '') + (p.ctrl ? '' : ` · only ${p.host} can control it`);
    }
    const pk = p.role + '|' + peers.map((x) => x.name + (x.ready ? 1 : 0)).join('|');
    if (pk !== peopleKey) {
      peopleKey = pk;
      $('#shPeople').innerHTML = p.role === 'off' || !n ? '' : '<h3 class="sub">Watching</h3>' + peers.map((x) => `<div class="who${x.ready ? ' ok' : ''}"><span class="spdot"></span>${esc(x.name)}<em>${x.ready ? '' : 'loading…'}</em></div>`).join('');
    }
    const nm = $('#shName');
    nm.placeholder = p.defaultName || 'Your name';
    if (document.activeElement !== nm) nm.value = sh.name || '';
    $('#shControl').checked = !!sh.control; $('#shWait').checked = !!sh.wait; $('#shInternet').checked = !!sh.internet;
    $('#shQuality').value = sh.quality || 'original';
    $('#shQNote').textContent = p.role === 'guest' && sh.quality !== p.quality ? `${p.host || 'Your friend'} is sending ${QNAME[p.quality] || p.quality} at most.` : '';
  }
  let peopleKey = '';
  // ---------- video conversion: the box in Settings ----------
  let encKey = null;
  function syncConvertUI() {
    const v = S.video, encs = S.encoders || [], vi = S.videoInfo || {}, va = S.videoAudio || {};
    const key = encs.map((x) => x.id).join('|');
    if (key !== encKey) {
      encKey = key;
      const auto = encs.find((x) => x.auto);
      $('#vEnc').innerHTML = `<option value="auto">Automatic${auto ? ' (' + esc(auto.label) + ')' : ''}</option>` + encs.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
    }
    $('#vEnc').value = encs.some((x) => x.id === v.enc) ? v.enc : 'auto';
    $('#vHdr').value = v.hdr || 'auto'; $('#vTone').value = v.tone || 'hable'; $('#vXq').value = String(v.xq || 'auto');
    const off = va.ffmpeg === false;
    for (const id of ['#vHdr', '#vTone', '#vEnc', '#vXq']) $(id).disabled = off;
    $('#xcNote').textContent = off ? 'Converting video needs ffmpeg.exe, which this copy of Drift is missing. Put it in Drift\'s "resources" folder and restart.'
      : (S.canTonemap === false ? 'This copy of ffmpeg can\'t convert HDR (it was built without the zscale and libplacebo filters). ' : '')
        + `This screen is ${myHdr() ? 'showing HDR, so HDR videos play as they are' : 'not showing HDR'}.`
        + (videoOn() && vi.hdr ? ` The video playing now is HDR${vi.dv ? ' (Dolby Vision)' : vi.hdr === 'hlg' ? ' (HLG)' : ''}${useX() ? ' and is being converted for this screen.' : '.'}` : videoOn() && useX() ? ' The video playing now is being converted.' : '')
        + ' Drift also converts videos in formats the built-in player can\'t play.';
  }

  // ---------- subtitles: the box in the Video tab ----------
  const LANGS = init.langs || [['en', 'English']];
  const langOpts = LANGS.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
  $('#subPref').innerHTML = langOpts;
  $('#subLang').innerHTML = langOpts + '<option value="">Any language</option>';
  $('#subLang').value = (S.subs || {}).lang || 'en';
  let subTrackKey = null, subFor = null, subRes = null, subJob = 0;
  const offStr = (v) => (!v ? 'In sync' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(Math.abs(v * 10 % 1) > 0.01 ? 2 : 1) + ' s');
  function syncSubUI() {
    const si = S.subsInfo || { tracks: [] }, sb = S.subs || {}, box = $('#subBox'), tracks = si.tracks || [];
    box.classList.toggle('on', videoOn());
    const vcc = $('#vcc');
    vcc.style.display = videoOn() ? '' : 'none'; vcc.classList.toggle('on', !!si.sel);
    if (si.file !== subFor) {       // a different video: start the online search over with its name filled in
      subFor = si.file; subRes = null; subJob++; renderSubResults();
      const g = si.guess || {};
      $('#subQ').value = g.title || ''; $('#subS').value = g.season || ''; $('#subE').value = g.episode || '';
    }
    const key = tracks.map((t) => t.id + t.label).join('|');
    if (key !== subTrackKey) {
      subTrackKey = key;
      $('#subTrack').innerHTML = '<option value="off">Off</option>' + tracks.map((t) => `<option value="${esc(t.id)}"${t.usable ? '' : ' disabled'}>${esc(t.label)}</option>`).join('');
    }
    if (document.activeElement !== $('#subTrack')) $('#subTrack').value = si.sel || 'off';
    $('#subNote').textContent = si.busy ? 'Reading subtitles…' : si.note ? si.note : !tracks.length ? 'None came with this video.' : !si.sel && tracks.some((t) => t.usable) ? `${tracks.filter((t) => t.usable).length} available` : '';
    $('#subOff').textContent = offStr(si.offset || 0);
    setVal($('#subSize'), sb.size || 1); setVal($('#subLift'), sb.lift || 0);
    $('#o-subSize').textContent = Math.round((sb.size || 1) * 100) + '%';
    $('#o-subLift').textContent = sb.lift ? '+' + Math.round(sb.lift) + '%' : 'Bottom';
    if (document.activeElement !== $('#subColor')) $('#subColor').value = sb.color || '#ffffff';
    $('#subBg').value = sb.bg || 'outline'; $('#subPref').value = sb.lang || 'en';
  }
  function renderSubResults() {
    const box = $('#subResults'), row = $('#subMatchRow');
    row.style.display = 'none';
    if (!subRes) { box.innerHTML = ''; return; }
    if (subRes.busy) { box.innerHTML = '<p class="note">Searching…</p>'; return; }
    if (!subRes.ok) { box.innerHTML = `<p class="note">${esc(subRes.error || 'The search failed.')}</p>`; return; }
    const titles = subRes.titles || [], pk = subRes.picked;
    if (!pk) { box.innerHTML = '<p class="note">Nothing by that name was found. Check the spelling or try a shorter name.</p>'; return; }
    if (titles.length > 1) {
      row.style.display = '';
      $('#subMatch').innerHTML = titles.map((t) => `<option value="${esc(t.id)}" data-type="${t.type}">${esc(t.name)}${t.year ? ' (' + t.year + ')' : ''} — ${t.type === 'series' ? 'show' : 'film'}</option>`).join('');
      $('#subMatch').value = pk.id;
    }
    const want = $('#subLang').value, wantName = (LANGS.find((l) => l[0] === want) || [])[1];
    if (!subRes.subs.length) {
      const others = (subRes.langs || []).map((c) => (LANGS.find((l) => l[0] === c) || [])[1]).filter(Boolean);
      box.innerHTML = `<p class="note">No ${wantName ? esc(wantName) + ' ' : ''}subtitles were found for ${esc(pk.name)}${pk.type === 'series' ? ' — check the season and episode numbers' : ''}.${others.length ? ' Other languages there: ' + esc(others.slice(0, 12).join(', ')) + '.' : ''}</p>`;
      return;
    }
    box.innerHTML = subRes.subs.map((s, i) => `<button class="subres" data-i="${i}" title="Use these subtitles"><b>${esc(s.langName)}</b><span>${esc(s.name)}</span>${s.score >= 4 ? '<em>Likely match</em>' : ''}</button>`).join('');
  }
  async function subSearch(id, type) {
    const text = $('#subQ').value.trim();
    if (!text) { toast('Type the name of the film or show first', 2400); return; }
    const job = ++subJob;
    subRes = { busy: true }; renderSubResults();
    const r = await api.subSearch({ text, season: parseInt($('#subS').value, 10) || 0, episode: parseInt($('#subE').value, 10) || 0, lang: $('#subLang').value, id, type });
    if (job !== subJob) return;
    subRes = r; renderSubResults();
  }
  $('#subTrack').addEventListener('change', (e) => { api.cmd({ type: 'sub-select', id: e.target.value }); e.target.blur(); });
  $('#subFile').addEventListener('click', () => api.cmd({ type: 'sub-file' }));
  $('#subFind').addEventListener('click', () => { const b = $('#subBox'); b.classList.remove('look'); if (b.classList.toggle('find')) $('#subQ').focus(); });
  $('#subMore').addEventListener('click', () => { const b = $('#subBox'); b.classList.remove('find'); b.classList.toggle('look'); });
  $('#subGo').addEventListener('click', () => subSearch());
  for (const id of ['#subQ', '#subS', '#subE']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') subSearch(); });
  $('#subLang').addEventListener('change', () => { if (subRes && !subRes.busy && $('#subQ').value.trim()) subSearch(subRes.picked && subRes.picked.id, subRes.picked && subRes.picked.type); });
  $('#subMatch').addEventListener('change', (e) => subSearch(e.target.value, e.target.selectedOptions[0].dataset.type));
  $('#subResults').addEventListener('click', async (e) => {
    const el = e.target.closest('.subres'); if (!el || !subRes || !subRes.subs) return;
    const it = subRes.subs[+el.dataset.i]; if (!it) return;
    el.classList.add('busy');
    const r = await api.subDownload({ id: it.id, url: it.url, name: it.name, lang: it.lang });
    el.classList.remove('busy');
    if (r && r.ok) { $$('.subres.done').forEach((x) => x.classList.remove('done')); el.classList.add('done'); toast('Subtitles added — now showing', 2600); }
    else toast((r && r.error) || 'The download failed.', 5000);
  });
  $('#subPref').addEventListener('change', (e) => { api.cmd({ type: 'sub-lang', lang: e.target.value }); $('#subLang').value = e.target.value; });
  $('#subSize').addEventListener('input', (e) => { fill(e.target); api.patch({ subs: { size: +e.target.value } }); });
  $('#subLift').addEventListener('input', (e) => { fill(e.target); api.patch({ subs: { lift: +e.target.value } }); });
  $('#subBg').addEventListener('change', (e) => api.patch({ subs: { bg: e.target.value } }));
  $('#subColor').addEventListener('input', (e) => api.patch({ subs: { color: e.target.value } }));
  $('#subTiming').addEventListener('click', (e) => { const d = e.target.dataset.d; if (d) api.cmd({ type: 'sub-offset', delta: +d }); });
  $('#subOffReset').addEventListener('click', () => api.cmd({ type: 'sub-offset', value: 0 }));
  $('#vcc').addEventListener('click', () => { subAsk = true; api.cmd({ type: 'sub-toggle' }); });
  const subNudge = (d) => { const v = Math.round((((S.subsInfo || {}).offset || 0) + d) * 20) / 20; api.cmd({ type: 'sub-offset', value: v }); toast('Subtitle timing: ' + offStr(v), 1400); };
  const subCycle = () => {
    const si = S.subsInfo || {}, ids = ['off', ...(si.tracks || []).filter((t) => t.usable).map((t) => t.id)];
    if (ids.length < 2) { toast('No subtitles for this video yet — use "Find online" in the Video tab.', 4000); return; }
    subAsk = true; api.cmd({ type: 'sub-select', id: ids[(ids.indexOf(si.sel || 'off') + 1) % ids.length] });
  };

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
  $('#palettes').addEventListener('click', (e) => {
    const t = e.target.closest('.sw'); if (!t) return;
    // the first time, Custom starts from the colours on screen right now
    if (t.dataset.id === 'custom' && !Array.isArray(S.customColors)) P({ customColors: currentColors().map(toHex), palette: 'custom' });
    else P({ palette: t.dataset.id });
  });
  let ccTimer = 0, ccPending = null;
  const sendCustom = (cols) => { ccPending = cols; S.customColors = cols; if (!ccTimer) ccTimer = setTimeout(() => { ccTimer = 0; P({ customColors: ccPending, palette: 'custom' }); }, 60); };
  $('#customRow').addEventListener('input', (e) => {
    if (e.target.type !== 'color') return;
    const cols = customNow(); cols[+e.target.dataset.i] = e.target.value; sendCustom(cols);
  });
  $('#customDark').addEventListener('click', () => {      // build a matching dark-to-light ramp from the main colour
    const [h, s] = rgbToHsl(hex(customNow()[2]));
    sendCustom([hslToHex(h, Math.min(s, 0.6), 0.05), hslToHex(h + 0.04, Math.min(1, s * 0.9), 0.22), customNow()[2], hslToHex(h - 0.06, Math.min(1, s + 0.1), 0.86)]);
  });
  $('#cycleSecs').addEventListener('change', (e) => P({ cycleSecs: +e.target.value }));
  $('#overlay').addEventListener('change', (e) => P({ overlay: e.target.value }));
  $('#algoInfo').addEventListener('change', (e) => P({ algoInfo: e.target.checked }));
  $('#modeHint').addEventListener('click', () => setTab('settings'));
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
  for (const [id, k] of [['#vHdr', 'hdr'], ['#vTone', 'tone'], ['#vEnc', 'enc'], ['#vXq', 'xq']]) $(id).addEventListener('change', (e) => P({ video: { [k]: e.target.value } }));
  $('#shStart').addEventListener('click', () => api.cmd({ type: 'share-start' }));
  $('#shStop').addEventListener('click', () => api.cmd({ type: 'share-stop' }));
  $('#shLeave').addEventListener('click', () => api.cmd({ type: 'share-stop' }));
  $('#shCopy').addEventListener('click', () => api.cmd({ type: 'share-copy' }));
  $('#shPaste').addEventListener('click', () => api.cmd({ type: 'share-paste' }));
  const joinNow = () => { const code = $('#shCode').value.trim(); if (!code) { toast('Paste your friend\'s invite code first', 2400); return; } api.cmd({ type: 'share-join', code }); $('#shCode').value = ''; };
  $('#shJoin').addEventListener('click', joinNow);
  $('#shCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinNow(); });
  $('#shName').addEventListener('change', (e) => P({ share: { name: e.target.value.trim() } }));
  $('#shName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  for (const [id, k] of [['#shControl', 'control'], ['#shWait', 'wait'], ['#shInternet', 'internet']]) $(id).addEventListener('change', (e) => P({ share: { [k]: e.target.checked } }));
  $('#shQuality').addEventListener('change', (e) => P({ share: { quality: e.target.value } }));
  $('#videoFit').addEventListener('change', (e) => P({ video: { fit: e.target.value } }));
  $('#videoSound').addEventListener('change', (e) => P({ video: { sound: e.target.checked } }));
  $('#videoAuto').addEventListener('change', (e) => P({ video: { autoplay: e.target.checked } }));
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
  const setVol = (v) => { if (volIsSpotify()) { if ((S.spotify || {}).volMode) { S.spotify.vol = v; api.cmd({ type: 'spotify-volume', value: v }); } } else P(volIsVideo() ? { video: { volume: v } } : { music: { volume: v } }); };
  $('#qvol').addEventListener('input', (e) => { fill(e.target); setVol(+e.target.value); });
  $('#vsound').addEventListener('click', () => P({ video: { sound: !S.video.sound } }));
  const seekEl = $('#seek');
  seekEl.addEventListener('pointerdown', () => { seeking = true; });
  seekEl.addEventListener('input', () => {
    fill(seekEl); $('#vcur').textContent = clockStr(+seekEl.value);
    if (performance.now() - lastJump > 140) { lastJump = performance.now(); api.cmd({ type: 'video-jump', pos: +seekEl.value }); }
  });
  seekEl.addEventListener('change', () => { api.cmd({ type: 'video-jump', pos: +seekEl.value, final: true }); setTimeout(() => { seeking = false; }, 400); });
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
      else if (dir < 0 && vTime() > 4) api.cmd({ type: 'video-jump', pos: 0, final: true });      // first press of "previous" restarts the video
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
  $('#exit').addEventListener('click', askQuit);
  $('#confirmYes').addEventListener('click', () => api.cmd({ type: 'quit' }));
  $('#confirmNo').addEventListener('click', closeAsk);
  $('#confirmMon').addEventListener('click', () => { closeAsk(); api.cmd({ type: 'monitor-off', index: me.index }); });
  confirmEl.addEventListener('mousedown', (e) => { if (e.target === confirmEl) closeAsk(); });      // a click outside the box means "stay"

  function stepScene(dir) {
    if (S.mode === 'mix') { const i = SCENES.findIndex((x) => x.id === sceneFor(S)); P({ perDisplay: { [me.key]: SCENES[(i + dir + SCENES.length) % SCENES.length].id } }); }
    else api.cmd({ type: 'step-scene', dir });
  }
  let toastTimer;
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms); }

  addEventListener('keydown', (e) => {
    if (confirmEl.classList.contains('on')) {       // the question is up: only it gets keys
      e.preventDefault();
      if (e.key === 'Enter') api.cmd({ type: 'quit' });
      else if (e.key === 'Escape') closeAsk();
      else if (e.key === 'Tab' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {      // move between the buttons that are showing
        const bs = $$('#confirm .btn').filter((b) => b.offsetParent), i = bs.indexOf(document.activeElement);
        bs[(i + ((e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) ? -1 : 1) + bs.length) % bs.length].focus();
      }
      return;
    }
    if (e.target.tagName === 'SELECT') return;
    if (e.target.type === 'search') { if (e.key === 'Escape') e.target.blur(); return; }   // typing in a search box
    const k = e.key;
    if (k === 'Escape') { if (panel.classList.contains('show') && panel.classList.contains('open')) { panel.classList.remove('open'); syncUI(); } else askQuit(); }
    else if (k === 'Tab' || k === 'h' || k === 'H') { e.preventDefault(); if (panel.classList.contains('show') && panel.classList.contains('open')) hidePanel(), panel.classList.remove('open'); else { showPanel(true); syncUI(); } }
    else if (k === 'ArrowRight') ctxStep(1);
    else if (k === 'ArrowLeft') ctxStep(-1);
    else if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      if (volIsSpotify() && !(S.spotify || {}).volMode) return;
      const v = Math.max(0, Math.min(1, +(volNow() + (k === 'ArrowUp' ? 0.05 : -0.05)).toFixed(2)));
      setVol(v); toast('Volume ' + Math.round(v * 100) + '%', 1200);
    }
    else if (k === ' ') { e.preventDefault(); ctxToggle(); }
    else if (k === 'n' || k === 'N') ctxStep(1);
    else if (k === 'p' || k === 'P') { const ids = [...Object.keys(PALETTES), 'cycle', ...(Array.isArray(S.customColors) ? ['custom'] : [])]; const n = ids[(ids.indexOf(S.palette) + 1) % ids.length]; P({ palette: n }); toast(n === 'cycle' ? 'Colour cycle' : n === 'custom' ? 'Your colours' : PALETTES[n].name, 1200); }
    else if ((k === 's' || k === 'S') && videoOn()) { subAsk = true; api.cmd({ type: 'sub-toggle' }); }
    else if ((k === 'v' || k === 'V') && videoOn()) subCycle();
    else if ((k === 'z' || k === 'Z') && videoOn()) subNudge(-0.1);
    else if ((k === 'x' || k === 'X') && videoOn()) subNudge(0.1);
    else if (k === 'c' || k === 'C') P({ clock: !S.clock });
    else if (k === 'b' || k === 'B') P({ breathing: !S.breathing });
    else if (/^[1-9]$/.test(k) && SCENES[+k - 1] && ctx() === 'scene') P(S.mode === 'mix' ? { perDisplay: { [me.key]: SCENES[+k - 1].id } } : { scene: SCENES[+k - 1].id });
  });

  // ---------- state sync ----------
  api.on('state', (ns) => {
    const prevPal = S.palette + (S.customColors || []).join('');
    S = ns; resize();
    if (sceneFor(S) !== shown) setScene(sceneFor(S));
    syncVideo();
    syncSubs();
    syncUI();
    if (prevPal !== S.palette + (S.customColors || []).join('') && panel.classList.contains('open')) { clearTimeout(thumbTimer); thumbTimer = setTimeout(makeThumbs, S.palette === 'custom' ? 350 : 0); }
  });
  api.on('levels', (m) => {
    const l = Array.isArray(m) ? m : m.l;
    audioTarget[0] = l[0]; audioTarget[1] = l[1]; audioTarget[2] = l[2];
    if (m.s) for (let i = 0; i < 64; i++) { specTarget[i] = m.s[i]; specTarget[64 + i] = m.w[i]; }
    if (m.b) beats = m.b;
    if (m.a !== undefined) { if (Math.abs(m.a - aTimeTarget) > 5) aTime = m.a; aTimeTarget = m.a; }
  });
  api.on('now', (n) => { S.nowPlaying = n; syncUI(); });
  api.on('cmd', (c) => {
    if (c.type === 'show-panel') { tab = c.tab; showPanel(true); clearTimeout(hideTimer); syncUI(); }
    else if (c.type === 'toast') { if (isCenter || panel.classList.contains('show')) toast(c.text, Math.max(3200, Math.min(9000, c.text.length * 70))); }     // one screen is enough
    else if (c.type === 'ask-quit') { if (confirmEl.classList.contains('on')) api.cmd({ type: 'quit' }); else askQuit(); }
    else if (c.type === 'share-code') { $('#shCode').value = c.code; $('#shCode').focus(); }
  });
  hdrQuery.addEventListener('change', () => { tellHdr(); syncUI(); });
  tellHdr();

  resize(); syncUI(); syncSubs(); requestAnimationFrame(frame);
  if (!R) toast('Your graphics driver has WebGL disabled — visuals cannot start.', 10000);
  else if (isCenter && !init.testMode) { toast('Move the mouse for controls  ·  Esc to exit', 5000); }
  document.body.classList.add('idle');
})();
