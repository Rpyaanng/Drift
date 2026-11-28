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

  // The cats: main.js decides which screen each one is on (they wander, get shooed, and gather); this shows the ones on this
  // screen. catAt[k] is cat k's screen.
  const CAT_MAX = 12;
  const CAT_NAMES = ['Miso', 'Pebble', 'Biscuit', 'Mochi', 'Juniper', 'Tofu', 'Pickle', 'Clover', 'Noodle', 'Saffron', 'Ziggy', 'Marble'];       // one each, never shared
  const catCount = () => (S.catsUnlocked ? Math.max(1, Math.min(CAT_MAX, Math.round(+S.catCount || 3))) : 1);       // one cat, till "meow" is typed in Settings
  let catAt = Array.isArray(init.cats) ? init.cats : [];

  // ---------- WebGL ----------
  function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  function makeRenderer(canvas, opts) {
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance', ...opts });
    if (!gl) return null;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    // Programs build in the background where the browser allows it (the heavier scenes take a moment to compile),
    // so the screen keeps moving: get() returns undefined while a scene is still being built.
    const progs = {}, pending = {};
    const par = gl.getExtension('KHR_parallel_shader_compile');
    const finish = (id) => {
      const { p, vs, fs } = pending[id]; delete pending[id];
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        for (const sh of [vs, fs]) if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.log('SHADER ERROR ' + gl.getShaderInfoLog(sh));
        console.log('scene failed: ' + id + ' ' + gl.getProgramInfoLog(p));
        return (progs[id] = null);
      }
      const u = {};
      for (const n of ['uRes', 'uView', 'uAspect', 'uTime', 'uAudio', 'uBright', 'uC0', 'uC1', 'uC2', 'uC3',
        'uData', 'uDataSize', 'uSpec', 'uReact', 'uBeat', 'uBeatAge', 'uATime', 'uOverlay']) u[n] = gl.getUniformLocation(p, n);
      return (progs[id] = { p, u });
    };
    const get = (id) => {
      if (id in progs) return progs[id];
      if (!pending[id]) {
        const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
        const vs = mk(gl.VERTEX_SHADER, SHADER_VERT), fs = mk(gl.FRAGMENT_SHADER, SHADER_HEAD + SCENE_SRC[id] + SHADER_TAIL);
        const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p);
        pending[id] = { p, vs, fs };
      }
      if (par && !gl.getProgramParameter(pending[id].p, par.COMPLETION_STATUS_KHR)) return undefined;
      return finish(id);
    };
    let lastOk = null;
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
      warm: (id) => { if (SCENE_SRC[id]) get(id); },       // (start building a scene now, in the background, to draw it later without a stall: Scene Slots' reveal)
      // returns false when it couldn't draw this scene yet (still building); `exact` = draw nothing rather than the last scene
      draw(id, o, exact) {
        let pr = get(id);
        if (pr === null) pr = get('aurora');
        if (!pr) { if (exact || !lastOk) return false; pr = lastOk; } else lastOk = pr;
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
        for (let i = 0; i < 128; i++) { const v = sp ? sp[i] : (i < 64 ? 0 : 128); specBytes[i * 4] = v; specBytes[i * 4 + 1] = i < 64 && o.peak ? o.peak[i] : 0; specBytes[i * 4 + 3] = 255; }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, specBytes);
        gl.uniform1i(pr.u.uSpec, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1f(pr.u.uReact, o.react || 0);
        gl.uniform1f(pr.u.uBeat, o.beat || 0);
        gl.uniform4f(pr.u.uBeatAge, ...(o.beatAge || [99, 99, 99, 99]));
        gl.uniform1f(pr.u.uATime, o.atime || 0);
        gl.uniform1f(pr.u.uOverlay, o.overlay || 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return true;
      },
    };
  }

  const canvas = $('#c');
  let R = makeRenderer(canvas);
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => { R = makeRenderer(canvas); });

  const sceneFor = (st) => (st.mode === 'mix' ? (st.perDisplay[me.key] || st.scene) : st.scene);
  let shown = sceneFor(S), fading = false;
  let scenePreview = '';       // (Scene Slots' showcase: a scene just won drawn behind the machine for a moment, without switching to it)
  let webUp = false;       // a Surf page covers this screen (syncWeb): the scene under it isn't drawn
  let bjOn = false;        // the Blackjack table is up on this screen (bjSync)
  let gmOn = '';           // Roulette's or Hold'em's table is up on this screen: which (gmSync)
  const audio = [0, 0, 0], audioTarget = [0, 0, 0];
  const specTarget = new Float32Array(128).fill(0), specNow = new Float32Array(128).fill(0);
  for (let i = 64; i < 128; i++) specTarget[i] = specNow[i] = 128;
  let beats = [0, 0, 0, 0], aTime = 0, aTimeTarget = 0;
  // the overlays' peak caps: each band's highest level lately, which hangs a moment and then falls (green channel of the spectrum row)
  const peakNow = new Float32Array(64), peakHeld = new Float32Array(64); let peakT = 0;
  function tickPeaks(now) {
    const dt = Math.min(0.1, (now - (peakT || now)) / 1000); peakT = now;
    for (let i = 0; i < 64; i++) {
      if (specNow[i] >= peakNow[i]) { peakNow[i] = specNow[i]; peakHeld[i] = 0.4; }
      else if ((peakHeld[i] -= dt) < 0) peakNow[i] = Math.max(specNow[i], peakNow[i] - dt * 255 * Math.min(1.6, -peakHeld[i] * 4 + 0.25));
    }
  }

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
  // "What's playing" (palette 'content'): the colours of the cover of the song that's on (syncContentPal), eased in from the
  // ones before over 2 s. With no cover, the last ones stay (Aurora before there are any).
  // A page open in Surf, or else a friend's broadcast being watched, comes before the cover: main.js contentTick sends a small
  // picture of it every few seconds (contentLive: { from, url }, null when neither is up).
  let contentFor = null, contentPal = null, contentHex = null, contentFrom = null, contentAt = 0, contentLive = null;
  function currentColors(at) {
    if (S.palette === 'custom' && Array.isArray(S.customColors)) return S.customColors.map(hex);
    if (S.palette === 'content') {
      if (!contentPal) return rgb('aurora');
      const k = Math.min(1, (performance.now() - contentAt) / 2000), e = k * k * (3 - 2 * k);
      return e >= 1 || !contentFrom ? contentPal : contentFrom.map((c, j) => c.map((v, n) => v + (contentPal[j][n] - v) * e));
    }
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
  // The accent goes to main too, for Surf's start page, which takes it by default (surf-home.js /api/accent), with the palette's
  // lightest colour as its second (Aurora's two are the start page's own green and lilac). Only a change is sent.
  let accentSent = '';
  let coverPal = null;       // the cover's colours while Media's screen shows another app's song (coverColors): they're that screen's, in place of the palette
  function setAccent() {
    const a = accentHex(), b = toHex(currentColors()[3]);
    document.documentElement.style.setProperty('--accent', a);
    const pc = currentColors(); ['--mbr0', '--mbr1', '--mbr2', '--mbr3'].forEach((v, i) => $('#mediaBack').style.setProperty(v, coverPal ? coverPal[i] : i === 2 ? a : toHex(pc[i])));       // Media's own screen wears the palette (style.css tones it down to --mb0..3 until something plays)
    if (a + b !== accentSent) {
      accentSent = a + b; api.cmd({ type: 'accent', a, b });
      for (const el of document.querySelectorAll('.ptr')) if (el.lastChild) el.style.setProperty('--c', el.classList.contains('self') ? window.driftSelfColor(a) : window.driftPtrColor(el.lastChild.textContent, a));       // everyone's pointer takes the new palette (yours is the accent itself)
    }
  }

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
  // Frames are drawn on a fixed beat of 1000/fps ms. (Waiting "at least that long since the last one" overshoots on a fast monitor:
  // 60 fps on a 144 Hz screen came out at 72, a fifth more GPU work for nothing.) sceneFps: lowered for a while if a video on another
  // screen is being kept waiting (see video-strain).
  let nextDraw = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const iv = 1000 / Math.min(S.fps, S.sceneFps || S.fps);
    if (now < nextDraw - 2) return;
    nextDraw = now - nextDraw > iv ? now + iv : nextDraw + iv;
    for (let i = 0; i < 3; i++) audio[i] += (audioTarget[i] * S.reactivity * 1.6 - audio[i]) * 0.12;
    for (let i = 0; i < 128; i++) specNow[i] += (specTarget[i] - specNow[i]) * (i < 64 ? 0.35 : 0.5);
    aTime += (aTimeTarget - aTime) * 0.15;
    tickPeaks(now);
    tickMediaBack();
    if (R && shown !== 'video' && !mbOn && !webUp) {       // (under Media's own screen the scene rests, and under a Surf page, which covers it all)
      const drawId = scenePreview && shown === 'slots' ? scenePreview : shown;
      const vp = viewParams(), t = sceneTime(), sm = simFor(drawId, vp.aspect);
      if (sm) sm.update(t);
      const now = Date.now(), age = beats.map((b) => (b ? (now - b) / 1000 : 99));
      R.draw(drawId, { ...vp, time: t, audio, bright: S.brightness, colors: currentColors(), sim: sm, spec: specNow, peak: peakNow, react: S.reactivity * 1.6,
        beat: Math.exp(-age[0] * 4), beatAge: age, atime: aTime, overlay: { none: 0, bars: 1, wave: 2, halo: 3 }[S.overlay] || 0 });
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
  // soft blurred copy of the picture behind it, so bars beside a vertical video aren't plain black.
  // It is blurred and dimmed here, at its small size, rather than with a CSS filter on a screen-sized layer (a 48px blur over the whole
  // monitor, done again by the GPU every time the picture changed). And it is kept big enough (192 wide) for Chromium to draw it on
  // the GPU: a canvas under 128×129 is drawn by the processor, so each copy pulled the video's whole frame back from the graphics card.
  setInterval(() => {
    if (!bgOn || video.readyState < 2) return;
    const w = 192, h = Math.max(16, Math.round(192 / bgAspect));
    if (vbg.width !== w || vbg.height !== h) { vbg.width = w; vbg.height = h; }
    const vw = video.videoWidth, vh = video.videoHeight, k = Math.max(w / vw, h / vh);
    try {
      const g = vbg.getContext('2d', { alpha: false });
      g.filter = 'blur(2.5px) brightness(.45) saturate(1.2)';
      g.drawImage(video, (w - vw * k) / 2, (h - vh * k) / 2, vw * k, vh * k);
    } catch { /* frame not ready */ }
  }, 120);
  let seekHold = 0, curUrl = '', lastSeq, seeking = false, lastJump = 0;
  // the song from the library: the audio window says where it is (music-pos); the bar shows it when no video is up
  let musicPos = { t: 0, d: 0, at: 0 };
  const musicBar = () => !videoOn() && filesOn() && !theirMusic() && musicPos.d > 0 && ctx() !== 'surf';
  const clockStr =(s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
  const videoOn = () => sceneFor(S) === 'video' && !!S.videoUrl;
  // The toolbar's play / previous / next / volume act on whichever tab is selected: Scenes, Media or Surf.
  let lastCtx = 'scene';
  // In Media they act on whichever is up, the video or the music. Spotify gets them only when all of Drift's own media is ejected
  // (main works that out: spotify.lead) and nothing else has the focus: in Media, or in Hub / Settings coming from Media. On Scenes
  // they stay the scene's.
  const filesOn = () => S.music.source === 'files' && S.music.playlist.length > 0;      // music from the library is up (playing or paused)
  const musicOn = () => !!theirMusic() || filesOn();
  const musicPlaying = () => (theirMusic() ? !!theirMusic().on : filesOn() && S.music.playing);
  const spLead = () => !!(S.spotify || {}).lead;
  const mediaCtx = () => (videoOn() ? 'video' : musicPlaying() ? 'music' : spLead() ? 'spotify' : musicOn() ? 'music' : 'video');
  const ctx = () => {
    // Hub, Share and Settings: the bar stays on what's on screen. A video or music that's up (a shared one, say) takes
    // it, and a Media context with nothing left in it goes back to the scene
    if (tab === 'hub' || tab === 'settings' || tab === 'broadcast') {
      if (lastCtx === 'surf') { /* the page stays */ }
      else if (videoOn() || musicOn()) { if (tab === 'hub' || lastCtx === 'scene') lastCtx = mediaCtx(); }
      else if (lastCtx === 'video' || lastCtx === 'music') lastCtx = spLead() ? 'spotify' : 'scene';
    } else lastCtx = tab === 'media' ? mediaCtx() : tab === 'surf' ? 'surf' : 'scene';
    return lastCtx;
  };
  // watching with a friend who has music on: theirs plays here in place of ours, and the Music controls are for theirs
  const theirMusic = () => ((S.p2p || {}).role === 'guest' && S.p2p.music) || null;
  const hostMusic = (what) => api.cmd({ type: 'share-music', do: what });
  const volIsSpotify = () => ctx() === 'spotify';
  const volIsSurf = () => ctx() === 'surf';       // on Surf: the browser's pages, all of them (the mixer's Surf level)
  const volNow = () => (volIsSurf() ? S.mixer.surf : volIsVideo() ? S.video.volume : volIsSpotify() ? ((S.spotify || {}).vol || 0) : S.music.volume);
  // the volume mixer (the toolbar's speaker): master scales all of Drift's own sound; surf is the pages' (see web.js and surf-volume.js)
  const mixMaster = () => (S.mixer.mute ? 0 : S.mixer.master);
  const mixSurf = () => (S.mixer.surfMute ? 0 : mixMaster() * S.mixer.surf);
  const mixVideo = () => (S.mixer.mediaMute ? 0 : mixMaster() * S.video.volume);       // a video plays at the Media level
  const musicIsMedia = () => (theirMusic() ? theirMusic().src === 'files' : S.music.source === 'files');       // music from the Media tab, not Ambient
  const volIsVideo = () => (ctx() === 'video' ? true : ctx() === 'music' ? musicIsMedia() : ctx() === 'spotify' ? false : videoOn() && S.video.sound);       // (the Media level: video.volume)
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
    video.volume = mixVideo();
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
    syncSound(lead && S.video.sound && converted);       // after any jump above, so the sound starts from where the picture is going
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
  video.addEventListener('seeked', () => { vaHold = 0; syncVideo(); });       // the picture jumped: the sound may follow straight away
  function syncSound(want) {
    if (!want) { if (vaUrl) { vaUrl = ''; vaud.pause(); vaud.removeAttribute('src'); vaud.load(); } return; }
    vaud.volume = mixVideo();
    // Not until the picture is where it is going. On start the video is still at 0 until its length is known and it jumps to where
    // it was left: a stream asked for then began at the start of the video, and stayed wrong for the 4 s before it could be asked again.
    if (video.readyState < 1 || video.seeking) { if (!vaud.paused) vaud.pause(); return; }
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
  // Is the video being kept waiting for its frames? Chromium's one GPU process draws for every window in turn, so heavy scenes on the
  // other monitors can hold the video's frames back: it shows as frames skipped (the picture jumps further than one frame) or late.
  // The window playing the video counts that, and main slows the other screens' scenes a step at a time until it stops (sceneFps).
  let vfPrev = null, vfDur = 1, vfLate = 0, vfCleanAt = performance.now();
  const vfReset = () => { vfPrev = null; };
  for (const ev of ['pause', 'play', 'seeking', 'seeked', 'emptied', 'ratechange']) video.addEventListener(ev, vfReset);
  function onVideoFrame(now, md) {
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onVideoFrame);
    if (!vfPrev) { vfPrev = { t: now, m: md.mediaTime }; return; }
    const media = md.mediaTime - vfPrev.m, wall = (now - vfPrev.t) / 1000;
    vfPrev = { t: now, m: md.mediaTime };
    if (!(media > 0) || media > 0.5 || wall > 1) return;         // a jump, a loop or a stall that isn't the GPU's doing
    vfDur = Math.min(vfDur * 1.01, media);                       // about one frame of this video (follows a change of video slowly)
    if (media > vfDur * 1.6 || wall * (video.playbackRate || 1) > media * 1.8 + 0.02) vfLate++;
  }
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onVideoFrame);
  setInterval(() => {
    const late = vfLate, now = performance.now(); vfLate = 0;
    const mine = shown === 'video' && S.videoLeader === me.key && !video.paused && !document.hidden;
    if (!mine) { vfCleanAt = now; return; }
    if (late >= 3) { vfCleanAt = now; api.cmd({ type: 'video-strain', more: true }); }
    else if (late) vfCleanAt = now;
    else if (S.sceneFps < S.fps && now - vfCleanAt > 10000) { vfCleanAt = now; api.cmd({ type: 'video-strain', more: false }); }       // smooth for a while: try more
  }, 2000);
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
  const clockEl = $('#clockFace'), breathEl = $('#breath'), coEl = $('#chatOverlay'), ring = $('#breath .ring'), breathTxt = $('#breath span');
  // when a cat lands (catIn, 1.1 s in style.css) after waiting d seconds, then starts breathing, each cat out of step with the others
  const CAT_IN = 1.1;
  function landAt(c, d) { const k = +c.dataset.k || 0; c.style.animationDelay = `${d.toFixed(2)}s, ${(d + CAT_IN + (k * 1.1) % 3.6).toFixed(2)}s`; }
  // the cats: the drawing in index.html is only a template. cats.js draws its pieces once into small images, and each cat is
  // a stack of those (all the cats share them), which CSS only moves. They sit in a row under the chat.
  const catEls = (() => {
    const tpl = $('#coCat'), row = document.createElement('div'), out = [];
    row.id = 'coCats'; tpl.replaceWith(row); Cats.start(tpl);
    for (let k = 0; k < CAT_MAX; k++) out.push(row.appendChild(Cats.make()));
    out.forEach((c, k) => { c.dataset.k = k; landAt(c, 0); });
    // each has its own name (the same cat k on every screen), shown in a little tag above it while the mouse is on it
    const tag = document.createElement('span'); tag.id = 'coCatTag'; row.append(tag);
    out.forEach((c, k) => {
      c.dataset.name = CAT_NAMES[k]; c.setAttribute('role', 'img'); c.setAttribute('aria-label', CAT_NAMES[k]);
      c.addEventListener('mouseenter', () => {
        tag.textContent = CAT_NAMES[k]; tag.dataset.for = k;
        tag.style.left = Math.round((parseFloat(c.style.getPropertyValue('--cat-x')) || 0) + (c.getBoundingClientRect().width || 33) / 2) + 'px';
        tag.classList.add('on');
      });
      c.addEventListener('mouseleave', () => tag.classList.remove('on'));
    });
    return out;
  })();
  const catTagOff = (k) => { const t = $('#coCatTag'); if (t.dataset.for === String(k)) t.classList.remove('on'); };
  let catWas = '';
  // spread the cats on this screen at random along the edge, never overlapping (called again when the overlay moves: lift in chat.js)
  // where along the edge the cats can sit (the panel's top while it shows, else the bottom of the screen), and a free spot on it
  const catRoom = () => { const pan = $('#panel'); return Math.max(0, (pan.classList.contains('show') ? pan.offsetWidth - 44 : innerWidth - 56) - (catEls[0].getBoundingClientRect().width || 33)); };
  // i: its place among the cats landing at once, so they come one after another (a moment after the overlay fades back in)
  function placeCat(c, i = 0) {
    landAt(c, 0.15 + i * 0.14);
    const room = catRoom(), w = (c.getBoundingClientRect().width || 33) + 8;
    const taken = catEls.filter((o) => o !== c && o.classList.contains('here') && !o.classList.contains('leaving')).map((o) => parseFloat(o.style.getPropertyValue('--cat-x')) || 0);
    let best = Math.random() * room, bestGap = -1;
    for (let i = 0; i < 24; i++) {       // the roomiest of a few random spots, so it doesn't land on another cat
      const x = Math.random() * room, gap = Math.min(Infinity, ...taken.map((t) => Math.abs(t - x)));
      if (gap >= w) { best = x; break; }
      if (gap > bestGap) { best = x; bestGap = gap; }
    }
    c.style.setProperty('--cat-x', Math.round(best) + 'px');
  }
  function fadeOff(c) {       // gone to another screen: it fades away where it sat
    c.classList.add('leaving');
    setTimeout(() => { if (c.classList.contains('leaving')) c.classList.remove('here', 'leaving'); }, 400);
  }
  // Opening or closing the panel (or its bar) the cats sit on shoos them: most of them go to another screen. main.js decides
  // which; the overlay is faded out meanwhile (lift in chat.js), and the ones that stay land somewhere new on the new edge.
  let shooAt = 0;
  coEl.addEventListener('catshoo', () => {
    if (!S.cat || performance.now() < 3000 || performance.now() - shooAt < 800 || !catEls.some((c) => c.classList.contains('here'))) return;
    shooAt = performance.now(); api.cmd({ type: 'cat-shoo', from: me.index });
  });
  function scatterCats() {       // the edge moved (lift in chat.js): every cat here takes a new spot on it
    const here = catEls.filter((c) => c.classList.contains('here') && !c.classList.contains('leaving'));
    $('#coCatTag').classList.remove('on');
    here.forEach((c) => c.style.removeProperty('--cat-x'));
    here.forEach((c) => { c.classList.remove('here'); });
    void coEl.offsetWidth;       // (seen without 'here' for a moment, so they land again rather than just jump)
    here.forEach((c, i) => { c.classList.add('here'); placeCat(c, i); });
  }
  coEl.addEventListener('catmove', scatterCats);
  $('#catCount').max = CAT_MAX;
  $('#catCount').addEventListener('input', (e) => { fill(e.target); $('#o-catCount').textContent = e.target.value; P({ catCount: +e.target.value }); });
  const ease = (x) => x * x * (3 - 2 * x);
  let lastClock = '', accentAt = 0, pgAt = 0;
  const clockHm = $('#clockFace .hm'), clockAp = $('#clockFace .ap'), clockDate = $('#clockFace .date'), clockRule = $('#clockFace .rule i');
  const clockFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  // the small clock in the bottom bar, beside the exit button; the date shows on hover
  const barClock = $('#barClock');
  let barClockWas = '';
  const tickBarClock = () => {
    const d = new Date(), t = clockFmt.format(d);
    if (t === barClockWas) return;
    barClockWas = t; barClock.textContent = t;
    barClock.title = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };
  tickBarClock(); setInterval(tickBarClock, 1000);
  function tickOverlays() {
    const showHere = S.mode !== 'span' || isCenter;
    clockEl.classList.toggle('on', S.clock && showHere);
    if (S.clock) {
      const d = new Date(), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (t !== lastClock) {
        lastClock = t;
        const parts = clockFmt.formatToParts(d), ap = parts.filter((x) => x.type === 'dayPeriod').map((x) => x.value).join('');
        // the hours and minutes, with the colon wrapped so it can pulse; AM/PM (where the locale uses it) set small beside them
        clockHm.innerHTML = parts.filter((x) => x.type !== 'dayPeriod').map((x) => x.type === 'literal' ? (/[:.]/.test(x.value) ? '<b>' + x.value.trim() + '</b>' : '') : x.value).join('');
        clockAp.textContent = ap; clockDate.textContent = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
      }
      clockRule.style.transform = `scaleX(${((d.getSeconds() + d.getMilliseconds() / 1000) / 60).toFixed(4)})`;      // fills across each minute
    }
    breathEl.classList.toggle('on', S.breathing && showHere);
    const catsHere = catEls.map((c, k) => !!S.cat && k < catCount() && catAt[k] === me.index), catKey = catsHere.join();
    if (catKey !== catWas) {       // one arrived or left. One that's leaving fades away; the ones arriving land in free spots
      const was = catWas.split(','); catWas = catKey;
      let landing = 0;
      catEls.forEach((c, k) => {
        if (catsHere[k]) { c.classList.remove('leaving'); if (!c.classList.contains('here')) { c.classList.add('here'); placeCat(c, landing++); } }
        else if (c.classList.contains('here') && was[k] === 'true' && S.cat && k < catCount()) { fadeOff(c); catTagOff(k); }
        else { c.classList.remove('here', 'leaving'); catTagOff(k); }
      });
    }
    coEl.classList.toggle('cat', catEls.some((c) => c.classList.contains('here')));       // (one fading away still counts, till it's gone)
    // While a video plays (on any screen: they all draw in Chromium's one GPU process) the cats fall asleep. Awake, their breathing,
    // blinking and tail have every window drawn again 60 times a second, and with a 4K video that left no room for its frames: it
    // froze. Asleep, only their "z Z Z" changes: a letter about once a second, then a beat with none.
    // The same while Surf plays something (a page making sound) or shows a friend's live Surf stream: even drawn once and
    // only moved (cats.js), awake cats have every window composited again each frame, and a 60 fps video in Surf stuttered.
    // (window.catForce: DRIFT_CATCOST in main.js holds them 'awake' or 'asleep' to measure what they cost)
    const w = S.web || {}, surfPlays = !!w.audible || !!S.surfVideo || (!!w.open && !!w.stream && !!w.live);       // (surfVideo: a video playing there, sound or not: main.js)
    const asleep = coEl.classList.contains('cat') && (window.catForce ? window.catForce === 'asleep' : (!!S.videoLeader && !S.video.paused) || surfPlays), zStep = Math.floor(Date.now() / 1100) % 5;
    coEl.classList.toggle('asleep', asleep);
    const z = asleep ? String(zStep > 3 ? 0 : zStep) : '';
    if (coEl.dataset.z !== z) coEl.dataset.z = z;
    if (S.breathing) {
      const ph = (Date.now() / 1000) % 14; let k, label;   // 4 in · 2 hold · 6 out · 2 rest
      if (ph < 4) { k = ease(ph / 4); label = 'Breathe in'; }
      else if (ph < 6) { k = 1; label = 'Hold'; }
      else if (ph < 12) { k = 1 - ease((ph - 6) / 6); label = 'Breathe out'; }
      else { k = 0; label = 'Rest'; }
      ring.style.transform = `scale(${0.45 + 0.55 * k})`;
      if (breathTxt.textContent !== label) breathTxt.textContent = label;
    }
    const barMusic = musicBar();
    panel.classList.toggle('hasmusic', barMusic);
    if (panel.classList.contains('show') && (barMusic || (videoOn() && vDur() > 0))) {
      const dur = barMusic ? musicPos.d : vDur();
      const now = barMusic ? musicPos.t + (S.music.playing ? (performance.now() - musicPos.at) / 1000 : 0) : vTime();
      const sk = $('#seek'), at = Math.min(dur, now);
      sk.max = dur; sk.title = barMusic ? 'Drag to move through the song' : 'Drag to move through the video';
      if (!seeking) { sk.value = at; $('#vcur').textContent = clockStr(at); }
      fill(sk); $('#vdur').textContent = clockStr(dur);
    }
    if (vtEl.classList.contains('on')) syncPausedTitle(sceneFor(S));       // (moved while paused: where it is now)
    if (tab === 'media' && panel.classList.contains('show') && videoOn() && performance.now() - pgAt > 1000) { pgAt = performance.now(); paintProgress(); }
    if (S.palette === 'cycle' && performance.now() - accentAt > 500) { accentAt = performance.now(); setAccent(); }
    const sl = $('#o-sleep');
    if (S.sleepAt > Date.now()) { const m = Math.ceil((S.sleepAt - Date.now()) / 60000); sl.textContent = m + ' min left'; } else if (sl.textContent) sl.textContent = '';
  }

  // ---------- thumbnails ----------
  const tcan = document.createElement('canvas'); tcan.width = 256; tcan.height = 144;
  let TR = null, thumbPalette = null, thumbJob = 0;
  window.driftThumbs = () => makeThumbs();       // (scripts/game-pics.js: the pictures drawn, to keep as Scene Slots' reels: renderer/scenes)
  function makeThumbs() {
    const palKey = S.palette + (S.palette === 'custom' ? (S.customColors || []).join('') : S.palette === 'content' ? (contentHex || []).join('') : '');
    if (thumbPalette === palKey) return;
    thumbPalette = palKey; const job = ++thumbJob;
    if (!TR) TR = makeRenderer(tcan, { preserveDrawingBuffer: true });
    if (!TR) return;
    const list = SCENES.filter((s) => !s.game); const cols = currentColors();       // (the Games room's tiles are pictures of the tables: renderer/games, scripts/game-pics.js)
    const step = () => {
      if (job !== thumbJob || !list.length) return;
      const s = list.shift();
      let sm = null; if (window.SIMS[s.id]) { sm = new window.SIMS[s.id](16 / 9); sm.update(47); }
      if (!TR.draw(s.id, { view: [0, 0, 1, 1], aspect: 16 / 9, time: 47, audio: [0, 0, 0], bright: 1, colors: cols, sim: sm }, true)) { list.unshift(s); setTimeout(step, 150); return; }   // still building
      const el = $(`.tile[data-id="${s.id}"]`); if (el) el.style.backgroundImage = `url(${tcan.toDataURL('image/jpeg', 0.8)})`;
      setTimeout(step, 40);
    };
    step();
  }

  // ---------- questions: "Close Drift?", and every other "are you sure?" ----------
  // Drift's own box, in place of the system's (confirm()), so it looks like the rest of Drift and stays on Drift's screen.
  // question({ title, note, detail, yes, no, danger, mon }) resolves true for yes, false for anything else: no, Esc, a click outside,
  // or another question taking its place. `detail` is a line shown as it is (a link's whole address); `danger: false` makes yes a
  // plain go-ahead rather than red. Enter answers with the button that has the keyboard (yes, to begin with); chat.js uses it too.
  // `alt` adds a third answer between no and yes: its button resolves 'alt' (a pick in a hub: play it just here).
  // `yesOff` shows yes but greys it out (sharing to a hub friends couldn't watch it in), and the keyboard starts on alt instead.
  const confirmEl = $('#confirm');
  let asking = null;       // { done(answer), quit }
  function question(o) {
    if (asking) asking.done(false);
    $('#confirmTitle').textContent = o.title || 'Are you sure?';
    $('#confirmNote').textContent = o.note || '';
    $('#confirmDetail').textContent = o.detail || ''; $('#confirmDetail').hidden = !o.detail;
    $('#confirmNo').textContent = o.no || 'Cancel';
    const yes = $('#confirmYes'), alt = $('#confirmAlt');
    yes.textContent = o.yes || 'OK'; yes.className = `btn ${o.danger === false ? 'primary' : 'danger'}`;
    yes.title = o.yesTip || ''; alt.textContent = o.alt || ''; alt.title = o.altTip || '';
    alt.style.display = o.alt ? '' : 'none'; alt.hidden = !o.alt;
    yes.disabled = !!o.yesOff;
    $('#confirmMon').style.display = o.mon ? '' : 'none';
    confirmEl.classList.add('on'); (o.yesOff ? (o.alt ? alt : $('#confirmNo')) : yes).focus();
    return new Promise((resolve) => {
      asking = { quit: !!o.quit, done: (v) => { asking = null; confirmEl.classList.remove('on'); document.activeElement?.blur(); resolve(v === 'alt' ? 'alt' : !!v); } };
    });
  }
  // A video or music picked while online in a hub (main.js mediaPlay): play it just here, share it to the hub (which asks
  // everyone first when someone else's is on: the vote card), or neither. The answer goes back as 'media-choice'.
  // c.reach (main.js shareCheck): friends elsewhere couldn't watch it (block: Share is greyed out, and says why), or might not.
  function askMedia(c) {
    const what = String(c.title || 'this').slice(0, 80), hub = String(c.hub || 'the hub').slice(0, 40), r = c.reach || null;
    const about = c.vote ? `${c.on || 'Something'} is on in ${hub}. Sharing asks everyone there to switch to yours.`
      : c.hosting ? `It replaces what you're sharing in ${hub} now.`
      : `Everyone online in ${hub} will watch along with you.`;
    const note = !r ? about : r.block ? String(r.text || '') : `${about}\n\n${String(r.text || '')}`;       // (#confirm p keeps the line breaks)
    question({ title: `Play “${what}”`, note, no: 'Cancel', alt: 'Just for me', altTip: 'Play it on this PC only. Nobody in the hub sees it.',
      yes: c.vote ? 'Ask to share' : 'Share to hub', yesOff: !!(r && r.block), danger: false,
      yesTip: r && r.block ? 'Friends on other networks can\'t reach this PC' : c.vote ? 'Everyone online votes, and it goes on if more than half agree' : 'Play it for everyone online in the hub' })
      .then((v) => api.cmd({ type: 'media-choice', id: c.id, choice: v === 'alt' ? 'private' : v ? 'share' : 'cancel' }));
  }
  window.driftAsk = question;
  // Esc, the ✕ button and Alt+F4 all ask first. Enter closes, Esc (or a click outside) stays.
  function askQuit() {
    const p = S.p2p || {}, n = (p.peers || []).length;
    const note = p.role === 'host' && n ? `${n === 1 ? p.peers[0].name : n + ' friends'} will stop seeing your video.`
      : p.role === 'guest' ? `You'll leave ${p.host || 'your friend'}'s video.` : 'Your settings are saved for next time.';
    question({ title: 'Close Drift?', note, yes: 'Close Drift', no: 'Stay', quit: true, mon: !S.windowed && init.displays.filter((d) => !S.displaysOff.includes(d.index)).length > 1 })
      .then((yes) => { if (yes) api.cmd({ type: 'quit' }); });
  }
  function closeAsk() { if (asking) asking.done(false); }

  // ---------- panel ----------
  const panel = $('#panel');
  let hideTimer = null, overPanel = false;
  // After the monitors change, the windows are made again: carry on with the tab this screen was on. Surf if the browser is here;
  // Surf's tab without its browser (that monitor went off and the browser moved) falls back to Scenes.
  const TAB_IDS = ['scenes', 'media', 'surf', 'hub', 'broadcast', 'settings'];
  const webHere = () => { const w = S.web || {}; return !!w.open && w.key === me.key; };
  let tab = webHere() ? 'surf' : TAB_IDS.includes(init.tab) && init.tab !== 'surf' ? init.tab : 'scenes';
  // (a game has no rotation tick: the automatic changes never pick one, main.js GAMES. A scene can be locked, S.locked: it shows
  // dimmed under a padlock until a scene token unlocks it at Scene Slots, docs/plans/scene-slots.md)
  const tileHtml = (s) => { const i = SCENES.indexOf(s); return `<button class="tile${s.game ? ' game' : ''}" data-id="${s.id}"${s.game ? ` style="background-image:url(games/${s.id}.jpg)"` : ''}>${s.game ? '' : '<i class="rot" role="checkbox" aria-checked="true" title="Include in automatic scene changes"></i><i class="lock" aria-hidden="true"></i>'}<kbd>${i < 9 ? i + 1 : ''}</kbd><span>${s.name}</span></button>`; };
  const isLocked = (id) => (S.locked || []).includes(id);
  const lockedSay = () => toast('Locked. Win a scene token (the crane\'s grand prize, a Pachinko fever round filled, or a Sketch & Guess game won) and spend it at Scene Slots.', 4200);
  $('#tiles').innerHTML = `<div class="tilegrid">${SCENES.filter((s) => !s.group).map(tileHtml).join('')}</div>`
    + `<h3 class="sub">Landscapes</h3><div class="tilegrid">${SCENES.filter((s) => s.group === 'land').map(tileHtml).join('')}</div>`
    + `<h3 class="sub">Algorithms</h3><div class="tilegrid">${SCENES.filter((s) => s.group === 'algo').map(tileHtml).join('')}</div>`
    + `<h3 class="sub">3D geometry</h3><div class="tilegrid">${SCENES.filter((s) => s.group === '3d').map(tileHtml).join('')}</div>`
    + `<h3 class="sub">Mathematical geometry</h3><div class="tilegrid">${SCENES.filter((s) => s.group === 'geo').map(tileHtml).join('')}</div>`
    + `<h3 class="sub">Games room</h3><div class="tilegrid">${SCENES.filter((s) => s.group === 'games').map(tileHtml).join('')}</div>`
    + `<h3 class="sub">Multiplayer only</h3><div class="tilegrid">${SCENES.filter((s) => s.group === 'multi').map(tileHtml).join('')}</div>`;
  const CYCLED = SCENES.filter((s) => !s.game);       // the scenes the automatic changes, and Next / Previous, go through
  $('#palettes').innerHTML = Object.entries(PALETTES).map(([id, p]) => `<button class="sw" data-id="${id}" title="${p.name}" style="background:linear-gradient(90deg,${p.c.join(',')})"></button>`).join('')
    + `<button class="sw cyc" data-id="cycle" title="Cycle through every colour" style="background:linear-gradient(90deg,${Object.values(PALETTES).map((p) => p.c[2]).join(',')})">↻</button>`
    + `<button class="sw art" data-id="content" title="What's playing: colours from the cover of the song that's on">♪</button>`
    + `<button class="sw cus" data-id="custom" title="Your own colours">✎</button>`;
  $('#presets').innerHTML = PRESETS.map((p) => `<button class="preset" data-id="${p.id}"><b>${p.name}</b><span>${p.desc}</span></button>`).join('')
    + '<button class="preset off" data-id="off"><b>Off</b><span>Silence, or just nature sounds</span></button>';
  // Settings' "Mirrored page size": after the styles, one choice per monitor, whose layout the mirrored page then takes
  if (init.displays.length > 1) $('#surfFit').insertAdjacentHTML('beforeend', init.displays.map((d) => `<option value="${d.key}">Match monitor ${d.index + 1} (${d.width} × ${d.height})</option>`).join(''));
  $('#monitors').innerHTML = init.displays.map((d) => `<button class="mon" data-i="${d.index}"><b>Monitor ${d.index + 1}</b>${d.width} × ${d.height}${d.index === me.index ? '<em>this screen</em>' : ''}</button>`).join('');

  // ---------- windowed (Settings → Show Drift → In a window; main.js buildWindows) ----------
  // Drift's own title bar over the top of the scene: it shows with the panel and the pointer, and goes with them (body.idle),
  // so the scene stays whole. It names what's on, and has the window's buttons. Its middle drags the window; a double click
  // there maximises it, as Windows does with any title bar.
  // It follows what you're looking at (data-ctx, and style.css #winBar[data-ctx]): what's on, in words that fit it, a look that
  // suits what's under it (a soft shade over a scene, a deeper one over a video, a solid strip over a web page, the felt's gold over
  // a game), and the two or three controls that matter there, which are the panel toolbar's own (ctx, ctxToggle, ctxStep).
  // Settings and the Hub, open over the screen, name themselves while they're open.
  const winBar = $('#winBar');
  const WB_GAMES = ['blackjack', 'roulette', 'poker', 'sketch', 'pachinko', 'crane', 'slots'];
  const wbHost = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? { host: x.hostname.replace(/^www\./, ''), safe: x.protocol === 'https:' } : null; } catch { return null; } };
  let wbLast = null, wbOnAir = null;       // (null: not heard yet, so S.bcOnAir from the last state)
  api.on('chat', (c) => { if (c && c.type === 'bclive') { wbOnAir = !!c.live; if (S.windowed) syncWinBar(); } });
  function wbContext(a) {
    const open = panel.classList.contains('show') && panel.classList.contains('open');
    if (open && tab === 'settings') return { ctx: 'settings', kind: '', title: 'Settings', sub: 'Saved as you change them' };
    if (open && tab === 'hub') { const pp = S.p2p || {}; return { ctx: 'hub', kind: 'Hub', title: 'Friends', sub: pp.role === 'guest' ? `with ${pp.host || 'a friend'}` : pp.role === 'host' && (pp.peers || []).length ? `${pp.peers.length} watching with you` : '' }; }
    const bv = S.bcView;
    if (bv && bv.key === me.key) {
      // Live: this PC is really sending your screen (main.js bcLiveInfo, as 'bclive' says it changes), not just the hub listing a broadcast as yours
      const tiles = bv.tiles || [], full = bv.full ? tiles.find((t) => t.bc === bv.full) : null, live = wbOnAir === null ? !!S.bcOnAir : wbOnAir;
      return { ctx: 'share', kind: 'Share', title: full ? (full.mine ? 'Your screen' : `${full.who}'s ${full.kind === 'window' ? 'window' : 'screen'}`) : 'Shared screens',
        sub: full ? full.title || '' : tiles.length ? `${tiles.length} sharing` : 'Nobody is sharing yet', live };
    }
    if (a.c === 'surf') {
      const w = S.web || {}, h = wbHost(w.url || '');
      if (w.hub && w.mine === false) return { ctx: 'surf', kind: 'Surf', title: w.title || (h ? h.host : 'New tab'), sub: `${w.hubName || 'Hub'}'s stream`, ctl: 'surf' };
      return { ctx: 'surf', kind: 'Surf', title: w.has ? w.title || (h ? h.host : 'New tab') : 'No page open', sub: h ? h.host : '', safe: !!(h && h.safe), ctl: 'surf' };
    }
    if (WB_GAMES.includes(a.cur)) {
      const pp = S.p2p || {};
      return { ctx: 'game', kind: 'Games room', title: (SCENES.find((s) => s.id === a.cur) || {}).name || 'Game', sub: pp.status === 'connected' ? `at ${pp.role === 'host' ? 'your' : `${pp.host || 'a friend'}'s`} table` : 'Practice table' };
    }
    if (a.c === 'video') {
      const pp = S.p2p || {};
      return { ctx: 'video', kind: 'Video', title: a.nowName, sub: pp.role === 'guest' ? `from ${pp.host || 'a friend'}` : !videoOn() ? '' : S.video.paused ? 'Paused' : '', ctl: 'media' };
    }
    if (a.c === 'music' || a.c === 'spotify') {
      const artist = a.c === 'spotify' || a.tm ? '' : (S.nowPlaying || {}).artist;       // (Spotify's title has the artist in it already)
      return { ctx: 'music', kind: a.c === 'spotify' ? 'Spotify' : 'Music', title: a.nowName, sub: artist || (a.playing ? '' : 'Paused'), ctl: 'media' };
    }
    const pal = S.palette === 'cycle' ? 'Every colour' : S.palette === 'content' ? 'Cover colours' : S.palette === 'custom' ? 'Your colours' : (PALETTES[S.palette] || {}).name || '';
    return { ctx: 'scene', kind: 'Scene', title: a.nowName || 'Scene', sub: S.frozen ? 'Paused' : pal, ctl: a.cur === 'video' ? '' : 'media' };
  }
  function syncWinBar(a) {
    const on = !!S.windowed;
    document.body.classList.toggle('windowed', on);
    $$('#windowed button').forEach((x) => x.classList.toggle('active', x.dataset.v === (on ? 'win' : 'full')));
    $('#winNote').textContent = on ? 'One window you can move and resize. Monitor layouts come back in full screen.'
      : init.displays.length > 1 ? 'Edge to edge on every monitor that\'s on.' : 'Edge to edge on your monitor.';
    if (a) wbLast = a;
    if (!on || !wbLast) return;
    const k = wbContext(wbLast), w = S.web || {};
    winBar.dataset.ctx = k.ctx;
    winBar.classList.toggle('live', !!k.live);
    const set = (sel, v) => { const el = $(sel); if (el.textContent !== v) el.textContent = v; };
    set('#wbKind', k.kind); set('#wbTitle', k.title || ''); set('#wbSub', k.sub || '');
    $('#wbLock').toggleAttribute('hidden', !k.safe);       // (an <svg>: no .hidden property)
    $('#wbLive').hidden = !k.live;
    // the controls for this context: a scene, a video or music step and pause; a web page goes back, forward and reloads
    const ctl = k.ctl || '';
    $('#wbCtl').dataset.ctl = ctl; $('#wbCtl').hidden = !ctl;
    const surfing = ctl === 'surf';
    $('#wbPrev').title = surfing ? 'Back' : k.ctx === 'scene' ? 'Previous scene' : 'Previous';
    $('#wbNext').title = surfing ? 'Forward' : k.ctx === 'scene' ? 'Next scene' : 'Next';
    $('#wbPrev').disabled = surfing && !w.back; $('#wbNext').disabled = surfing && !w.fwd;
    $('#wbPlay').hidden = surfing; $('#wbReload').hidden = !surfing;
    $('#wbPlay').classList.toggle('paused', !wbLast.playing);
    $('#wbPlay').title = wbLast.playing ? (k.ctx === 'scene' ? 'Pause the scene' : 'Pause') : (k.ctx === 'scene' ? 'Play the scene' : 'Play');
    $('#wbTop').classList.toggle('lit', !!S.onTop);
    $('#wbTop').title = S.onTop ? 'Staying above other windows. Click to stop' : 'Stay above other windows';
  }
  new MutationObserver(() => { if (S.windowed) syncWinBar(); }).observe(panel, { attributes: true, attributeFilter: ['class'] });       // Settings or the Hub opened or put away
  $('#wbPrev').addEventListener('click', () => ($('#wbCtl').dataset.ctl === 'surf' ? surf('back') : ctxStep(-1)));
  $('#wbNext').addEventListener('click', () => ($('#wbCtl').dataset.ctl === 'surf' ? surf('fwd') : ctxStep(1)));
  $('#wbPlay').addEventListener('click', () => ctxToggle());
  $('#wbReload').addEventListener('click', () => surf('reload'));
  // The parts of the window that drag it (Surf's toolbar, the logo) are worked out from the layout and handed to Windows. After a
  // resize Electron can keep the old ones: part of the address bar, which grew or moved, then sat in a stale drag area, with no hover
  // or click there until something else (maximising) had them worked out again. So once a resize settles they're dropped for a frame
  // and put back, which makes them be worked out afresh from the layout as it is now.
  let wbRegionT = null;
  function wbRegionsFresh() {
    clearTimeout(wbRegionT);
    wbRegionT = setTimeout(() => {
      document.body.classList.add('wbRegionsOff');
      requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('wbRegionsOff')));
    }, 150);
  }
  addEventListener('resize', () => { if (S.windowed) wbRegionsFresh(); });
  function winState(c) {
    wbRegionsFresh();       // (maximised, restored, full screen: the same)
    winBar.classList.toggle('max', !!c.max || !!c.full);
    winBar.classList.toggle('blur', c.focus === false);
    $('#wbMax').title = $('#wbMax').ariaLabel = c.full ? 'Leave full screen' : c.max ? 'Restore' : 'Maximise';
  }
  $('#wbMin').addEventListener('click', () => api.cmd({ type: 'win', op: 'min' }));
  $('#wbMax').addEventListener('click', () => api.cmd({ type: 'win', op: 'max' }));
  $('#wbClose').addEventListener('click', () => askQuit());
  $('#wbTop').addEventListener('click', () => P({ onTop: !S.onTop }));
  $('#wbSpan').addEventListener('click', () => P({ windowed: false }));
  $('#windowed').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) P({ windowed: b.dataset.v === 'win' }); });

  function showPanel(open) {
    panel.classList.add('show'); document.body.classList.remove('idle');
    if (open !== undefined) panel.classList.toggle('open', open);
    if (panel.classList.contains('open')) makeThumbs();
    armHide();
  }
  function hidePanel() { panel.classList.remove('show'); document.body.classList.add('idle'); $('#mixer').classList.remove('open'); $('#mixBtn').classList.remove('lit'); }
  function armHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (overPanel || document.activeElement?.tagName === 'SELECT' || document.activeElement?.tagName === 'TEXTAREA') armHide(); else hidePanel(); }, 3500);       // (not while choosing from a list or typing a message)
  }
  function setTab(t, toggle) {
    const same = t === tab && panel.classList.contains('open'), bcWas = bcHere();
    tab = t; surfFor(t); bcFor(t); tellTab();
    if (!SIDE_TABS.includes(t)) screenTab = t;       // (Hub and Settings leave the screen as it is)
    pickScreen(t);
    if (t === 'scenes' && sceneFor(S) === 'video') {       // Scenes over a video: the scene that was on before it comes straight back, as picking its tile would
      const back = S.prevScene && S.prevScene !== 'video' ? S.prevScene : 'aurora';
      P(S.mode === 'mix' ? { perDisplay: { [me.key]: back } } : { scene: back });
    }
    // Surf has no page of its own in the panel: the browser is it. Broadcast's grid is its scene, so picking it shows the grid;
    // picking it again (the grid already here) opens its page (Go live, how it's going) over it.
    panel.classList.toggle('open', t === 'surf' ? false : t === 'broadcast' ? bcWas && !same : !(toggle && same));
    syncUI(); if (panel.classList.contains('open')) makeThumbs();
  }
  // The Broadcast scene belongs to the Share tab: picking it shows the hub's broadcasts on this screen (moving them from
  // another monitor); picking Scenes, Media or Surf on its screen puts it away, and whatever was playing in it stops.
  const bcHere = () => !!(S.bcView && S.bcView.key === me.key);
  // A paused video shows its name over the frame (top left; in Span only on the leftmost screen), with where it stopped. The name
  // is tidied from the file's: no extension, and dots or underscores between words read as spaces.
  const vtEl = $('#vTitle');
  function syncPausedTitle(cur) {
    const leftmost = S.mode !== 'span' || me.bounds.x === me.union.x;
    const on = cur === 'video' && !!S.videoUrl && !!S.video.paused && leftmost && !document.body.classList.contains('web') && !bcHere();
    vtEl.classList.toggle('on', on);
    if (!on) return;
    let name = (S.videoName || 'Video').replace(/\.[^.\s]{2,4}$/, '');
    if (!/\s/.test(name)) name = name.replace(/[._]+/g, ' ').trim();
    const pp = S.p2p || {}, d = vDur(), at = Math.min(vTime(), d || Infinity);
    const meta = [d > 0 ? `${clockStr(at)} of ${clockStr(d)}` : '', pp.role === 'guest' ? `Shared by ${pp.host || 'a friend'}` : ''].filter(Boolean).join('  ·  ');
    const nm = vtEl.querySelector('.vtName'), mt = vtEl.querySelector('.vtMeta');
    if (nm.textContent !== name) nm.textContent = name;
    if (mt.textContent !== meta) mt.textContent = meta;
  }
  function bcFor(t) {
    if (t === 'broadcast') { const h = window.broadcastUI && window.broadcastUI.hub(); if (h) api.chat('bcOpen', h, me.key).catch(() => {}); }
    else if (!SIDE_TABS.includes(t) && bcHere()) api.chat('bcClose').catch(() => {});
  }
  // Friends watching together see how many people are on each tab.
  const tellTab = () => api.cmd({ type: 'tab-focus', tab });
  // The browser belongs to the Surf tab. Choosing Surf shows it on this screen, opening a first tab on Drift's start page if there is
  // none yet. Choosing Scenes or Media on its screen puts it away (its tabs are kept) so they can be seen. Hub and Settings leave it be.
  function surfFor(t) {
    const w = S.web || {};
    if (t === 'surf') {
      // (Mirror: a page already up on another monitor is mirrored here, so it stays where it is; main.js turns mirroring on)
      if (w.has) { if (!w.open) surf('show'); else if (w.key !== me.key) surf(S.mode === 'mirror' && !w.hub ? 'show' : 'move'); }       // (a hub's Surf is one picture: it moves)
      else surf('new');
    }
    else if (!SIDE_TABS.includes(t) && w.open && (w.key === me.key || S.mode === 'mirror')) surf('hide');       // (Mirror: whichever monitor it was picked on, it comes down on all of them)
    else if (!SIDE_TABS.includes(t) && (mirEl || (gpuEl && !gpuEl.own))) api.patch({ surfMirror: false });       // on a monitor mirroring the page: Scenes or Media is what was asked for here
  }
  const SIDE_TABS = ['settings', 'hub'];       // tabs that leave what's on screen where it is (the browser, the Broadcast scene)
  // Mirror: every monitor shows what was last picked on any of them. Scenes and Media are each window's own screen (screenTab),
  // so a pick here is passed to the others (main.js screen-pick; they take it in the 'cmd' handler). Surf has surfMirror.
  const pickScreen = (t) => { if (S.mode === 'mirror' && (t === 'scenes' || t === 'media')) api.cmd({ type: 'screen-pick', tab: t }); };
  // ---- Media's own screen. Scenes, Media, Surf and Share each put something on this screen; picking Media with no video up used
  // to leave the scene showing, as if nothing had happened. Now it shows Media's backdrop: what's playing (music, with its
  // spectrum), or how to start. screenTab: the last of those four picked here (Hub and Settings don't change it). ----
  let screenTab = ['scenes', 'media', 'surf', 'broadcast'].includes(tab) ? tab : 'scenes';
  const mbEl = $('#mediaBack'), mbBars = [];
  for (let i = 0; i < 64; i++) { const b = document.createElement('i'); mbEl.querySelector('.mbBars').append(b); mbBars.push(b); }       // a mirrored skyline: the bass in the middle
  let mbOn = false, mbKey = '', whereSent = '';
  // The sleeve shows the song's own cover when it has one (in its tags, or a cover.jpg beside it: main.js song-tags), over the
  // lights drawn from its title. For this PC's own songs, and another app's (Spotify, Apple Music, a browser...: p is then
  // 'app:<n>', its cover's number: main.js appNowWatch, which reads it from Windows' media controls); a friend's music keeps the
  // drawn sleeve. Another app's cover colours the screen as well (coverColors).
  const mbSleeve = mbEl.querySelector('.mbSleeve'), mbCover = mbEl.querySelector('.mbCover'), mbArts = new Map();       // path -> data: URL ('' for none), the last few
  let mbArtFor = null;
  function sleeveArt(p) {
    if (p === mbArtFor) return;
    mbArtFor = p;
    const sp = p.startsWith('app:');
    const show = (url, done) => {
      if (url) mbCover.style.backgroundImage = `linear-gradient(to top, rgba(0,0,0,.42), transparent 34%), url("${url}")`;       // (darker at the foot, for the track number)
      mbSleeve.classList.toggle('art', !!url);       // (going without: it fades out, and the picture stays under it until the next)
      if (!url) mbBack.classList.remove('on');       // the same cover across the screen behind it, once its blurred copy is made
      else coverBackdrop(url).then((b) => { if (mbArtFor !== p) return; if (b) mbBack.style.setProperty('--art', `url("${b}")`); mbBack.classList.toggle('on', !!b); });
      if (done) tintFrom(sp ? url : '');       // (not while the next one loads: the colours stay till it's there)
    };
    if (!p || p === 'app:0') { show('', true); return; }
    if (mbArts.has(p)) { show(mbArts.get(p), true); return; }
    show('', false);
    artFor(p).then((url) => { if (mbArtFor === p) show(url, true); });
  }
  function artFor(p) {       // a song's cover as a data: URL ('' for none): p as for sleeveArt
    if (!p || p === 'app:0') return Promise.resolve('');
    if (mbArts.has(p)) return Promise.resolve(mbArts.get(p));
    return (p.startsWith('app:') ? api.appArt().then((a) => (a && a.url) || '') : api.songTags(p, true).then((t) => (t && t.art) || '')).then((url) => {
      mbArts.set(p, url);
      if (mbArts.size > 12) mbArts.delete(mbArts.keys().next().value);
      return url;
    }).catch(() => '');
  }
  // The song that's on, for its cover: another app's when none of Drift's own is on, as syncMediaBack picks it; a friend's has none
  function nowArtPath() {
    const an = S.appNow, sp = !musicPlaying() && an && an.show && an.title ? an : null;
    if (sp) return 'app:' + (sp.key || 0);
    const list = musicOn() && !theirMusic() && filesOn() ? S.music.playlist : [], at = (S.nowPlaying || {}).index ?? -1;
    return list.length && at >= 0 ? list[at] || '' : '';
  }
  // the "What's playing" palette follows it: each window reads the same cover, so every monitor gets the same colours
  function syncContentPal() {
    if (S.palette !== 'content') return;
    const live = contentLive ? contentLive.url : '', p = live ? 'live:' + live : nowArtPath();
    if (p === contentFor) return;
    contentFor = p;
    (live ? Promise.resolve(live) : artFor(p)).then((url) => (url ? coverColors(url) : null)).then((pal) => {
      if (contentFor !== p || !pal || S.palette !== 'content') return;
      if (contentHex && pal.join() === contentHex.join()) return;       // (a page that's still, or barely changed: nothing to ease to)
      contentFrom = contentPal ? currentColors() : rgb('aurora'); contentPal = pal.map(hex); contentHex = pal; contentAt = performance.now();
      syncUI();
      setTimeout(() => { setAccent(); if (!live && panel.classList.contains('open')) makeThumbs(); }, 2100);       // (once it has eased in; not the tiles again every few seconds for a page)
    });
  }
  // A cover blurred for the screen's backdrop (style.css .mbBackArt): drawn once into a 64 × 64 canvas with a blur, a little
  // larger than it so the blur's soft edges fall outside, and kept as a small JPEG that the browser scales up across the screen.
  const mbBack = mbEl.querySelector('.mbBackArt'), mbBlurs = new Map();       // cover URL -> its blurred copy ('' if it wouldn't load)
  function coverBackdrop(url) {
    if (mbBlurs.has(url)) return Promise.resolve(mbBlurs.get(url));
    return new Promise((res) => {
      const done = (b) => { mbBlurs.set(url, b); if (mbBlurs.size > 12) mbBlurs.delete(mbBlurs.keys().next().value); res(b); };
      const img = new Image();
      img.onerror = () => done('');
      img.onload = () => {
        try {
          const c = document.createElement('canvas'); c.width = c.height = 64;
          const g = c.getContext('2d'); g.filter = 'blur(3px) saturate(1.2)'; g.drawImage(img, -10, -10, 84, 84);
          done(c.toDataURL('image/jpeg', 0.9));
        } catch { done(''); }
      };
      img.src = url;
    });
  }
  // A cover's colours, for Media's screen (--mbr0..3, which style.css tones down until something plays, as it does the palette's):
  // its strongest colour for the lights and the glow, one of another hue for the second light, and two darks of the first for
  // the background. Read once per cover, from a 32 × 32 copy of it. Only setting them has the screen painted again: once a song.
  let tintFor = '';
  function tintFrom(url) {
    if (url === tintFor) return;
    tintFor = url;
    if (!url) { if (coverPal) { coverPal = null; setAccent(); } return; }
    coverColors(url).then((pal) => { if (tintFor === url) { coverPal = pal; setAccent(); } });
  }
  function coverColors(url) {
    const hsl = (r, g, b) => {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
      if (!d) return [0, 0, l];
      const s = d / (1 - Math.abs(2 * l - 1)), h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return [h / 6, s, l];
    };
    const hex = (h, s, l) => {
      const f = (n) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
      return '#' + f(0) + f(8) + f(4);
    };
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    return new Promise((res) => {
      const img = new Image();
      img.onerror = () => res(null);
      img.onload = () => {
        try {
          const c = document.createElement('canvas'); c.width = c.height = 32;
          const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 32, 32);
          const d = g.getImageData(0, 0, 32, 32).data, bins = Array.from({ length: 12 }, () => ({ w: 0, h: 0, s: 0, l: 0 }));
          for (let i = 0; i < d.length; i += 4) {
            const [h, s, l] = hsl(d[i], d[i + 1], d[i + 2]);
            if (s < 0.18 || l < 0.08 || l > 0.94) continue;       // greys, near-black and near-white say nothing of its colour
            const w = s * (1 - Math.abs(l - 0.5)), bin = bins[Math.floor(h * 12) % 12];       // (vivid mid-tones count most)
            bin.w += w; bin.h += h * w; bin.s += s * w; bin.l += l * w;
          }
          const top = bins.map((x, i) => ({ ...x, i })).filter((x) => x.w > 0).sort((a, b) => b.w - a.w);
          if (!top.length || top[0].w < 3) { res(['#07080a', '#262a30', '#9aa3ad', '#eef1f4']); return; }       // a cover with no colour to speak of: greys
          const one = top[0], h1 = one.h / one.w, s1 = one.s / one.w, l1 = one.l / one.w;
          const far = top.find((x) => Math.min(Math.abs(x.i - one.i), 12 - Math.abs(x.i - one.i)) >= 2 && x.w >= one.w * 0.2);       // another hue, 60° or more away
          const h2 = far ? far.h / far.w : (h1 + 0.1) % 1, s2 = far ? far.s / far.w : s1;
          res([hex(h1, Math.min(s1, 0.5), 0.05), hex(h1, Math.min(s1, 0.6), 0.2), hex(h1, clamp(s1, 0.45, 0.9), clamp(l1, 0.5, 0.65)), hex(h2, clamp(s2, 0.4, 0.85), 0.72)]);
        } catch { res(null); }
      };
      img.src = url;
    });
  }
  // Three scenes side by side, the camera panning between them with the arrows at the screen's edges: the song's numbers on the
  // left (mbStats: Deezer), the song in the middle, and who sings it on the right (mbBio: Wikipedia's page on the artist, or a
  // band's lead singer, main.js artistBio). The links open their pages in Surf. A new song brings its own; a scene with nothing
  // to show loses its arrow, and the camera comes back to the song. (Tour dates, set aside: docs/plans/tour-dates.md)
  const mbWorldCard = mbEl.querySelector('.mbCard'), mbBioEl = mbEl.querySelector('.mbBio'), mbNumsEl = mbEl.querySelector('.mbNums'), mbSongWiki = mbEl.querySelector('.mbInfo .mbWiki');
  const mbPanR = mbEl.querySelector('.mbPan.r'), mbPanL = mbEl.querySelector('.mbPan.l');
  let mbBioFor = null, mbBioNow = null, mbStatsNow = null, mbScene = 'song';
  mbBioEl.inert = mbNumsEl.inert = true;
  const panBtn = (b, label, aria) => { b.hidden = !label; b.querySelector('span').textContent = label || ''; b.setAttribute('aria-label', aria || label || ''); };
  function mbPan(to) {
    if ((to === 'bio' && !mbBioNow) || (to === 'nums' && !mbStatsNow)) to = 'song';
    if (to === 'nums' && mbScene !== 'nums') for (const c of mbNumsEl.querySelectorAll('.mbNum')) { c.style.animation = 'none'; void c.offsetWidth; c.style.animation = ''; }       // (the cards come in again as the camera arrives)
    mbScene = to;
    mbEl.classList.toggle('bio', to === 'bio'); mbEl.classList.toggle('nums', to === 'nums');
    for (const [el, s] of [[mbWorldCard, 'song'], [mbBioEl, 'bio'], [mbNumsEl, 'nums']]) { el.inert = to !== s; el.setAttribute('aria-hidden', String(to !== s)); }
    if (to === 'song') { panBtn(mbPanR, mbBioNow && mbBioNow.name, mbBioNow && `About ${mbBioNow.name}`); panBtn(mbPanL, mbStatsNow && 'By the numbers'); }
    else if (to === 'bio') { panBtn(mbPanR, ''); panBtn(mbPanL, 'The song'); }
    else { panBtn(mbPanR, 'The song'); panBtn(mbPanL, ''); }
  }
  mbPanR.addEventListener('click', () => mbPan(mbScene === 'song' ? 'bio' : 'song'));
  mbPanL.addEventListener('click', () => mbPan(mbScene === 'song' ? 'nums' : 'song'));
  function mbBio(artist) {
    if (artist === mbBioFor) return;
    mbBioFor = artist; showBio(null);
    if (artist) api.artistBio(artist).then((b) => { if (mbBioFor === artist) showBio(b); }).catch(() => {});
  }
  function showBio(b) {
    mbBioNow = b || null;
    mbSongWiki.hidden = !b;
    if (b) mbSongWiki.querySelector('span').textContent = `${b.band || b.name} on Wikipedia`;
    if (b) {
      mbBioEl.querySelector('.mbBioKick').textContent = b.band ? `Lead singer of ${b.band}` : 'About the artist';
      mbBioEl.querySelector('.mbBioName').textContent = b.name;
      mbBioEl.querySelector('.mbBioDesc').textContent = b.desc;
      mbBioEl.querySelector('.mbAbout').textContent = b.about;
      mbBioEl.querySelector('.mbPicName').textContent = b.band || b.name;
      const pic = mbBioEl.querySelector('.mbPic'), port = mbBioEl.querySelector('.mbPortrait');
      pic.style.backgroundImage = b.pic ? `url("${b.pic}")` : '';
      pic.classList.toggle('on', !!b.pic);
      port.querySelector('.mbInitials')?.remove();
      if (!b.pic) port.prepend(Object.assign(document.createElement('div'), { className: 'mbInitials', textContent: b.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() }));
    }
    mbPan(mbScene);       // (no page: back to the song)
    setMbNote();
  }
  // The line under the artist: what Wikipedia says of the song (main.js songAbout), else of the singer (the bio's first sentence
  // or two), else how it's playing (mbNoteBase, from syncMediaBack). Each fills in as its answer comes.
  let mbNoteBase = '', mbSongFor = null, mbSongText = '';
  function mbSongNote(title, artist) {
    const k = title && artist ? title + '\n' + artist : '';
    if (k === mbSongFor) return;
    mbSongFor = k; mbSongText = '';
    if (k) api.songAbout(title, artist).then((t) => { if (mbSongFor === k) { mbSongText = t || ''; setMbNote(); } }).catch(() => {});
  }
  // The scene at the left, the song by the numbers, from Deezer (main.js deezerStats): how popular it is there, its artist's fans,
  // when it came out, where it sits on its album, its genre, its length and, when Deezer knows it, its tempo. Each a card. A song
  // Deezer doesn't have has no arrow to it.
  let mbStatsFor = null;
  function mbStats(title, artist) {
    const k = title && artist ? title + '\n' + artist : '';
    if (k === mbStatsFor) return;
    mbStatsFor = k;
    if (!k) { drawStats(null); return; }
    mbNumsEl.querySelector('.mbNumsGrid').replaceChildren();       // (the next song's: the camera stays where it is till they come, or don't)
    api.songStats(title, artist).then((s) => { if (mbStatsFor === k) drawStats(s, title, artist); }).catch(() => { if (mbStatsFor === k) drawStats(null); });
  }
  function drawStats(s, title, artist) {
    mbStatsNow = s || null;
    const grid = mbNumsEl.querySelector('.mbNumsGrid'), dz = mbNumsEl.querySelector('.mbDz');
    dz.hidden = !(s && s.link);
    if (!s) { grid.replaceChildren(); mbPan(mbScene); return; }
    mbNumsEl.querySelector('.mbNumsTitle').textContent = title;
    mbNumsEl.querySelector('.mbNumsArtist').textContent = artist;
    const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text || '' });
    const card = (label, value, under, wide) => {
      const c = el('div', 'mbNum' + (wide ? ' wide' : ''));
      c.append(el('small', '', label), typeof value === 'string' ? el('b', '', value) : value);
      if (under) c.append(typeof under === 'string' ? el('span', '', under) : under);
      return c;
    };
    const out = [];
    if (s.rank) {       // (Deezer's rank runs to a million: shown out of 100)
      const bar = el('span', 'mbMeter'), fill = el('i');
      fill.style.width = Math.max(3, Math.min(100, s.rank / 10000)).toFixed(1) + '%'; bar.append(fill);
      out.push(card('Popularity on Deezer', `${Math.max(1, Math.round(s.rank / 10000))} / 100`, bar, true));
    }
    if (s.fans) out.push(card('Fans', new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(s.fans), s.albums > 1 ? `${s.albums} albums on Deezer` : ''));
    if (/^\d{4}-\d\d-\d\d$/.test(s.released)) {
      const [y, m, d] = s.released.split('-').map(Number), at = new Date(y, m - 1, d), yrs = Math.floor((Date.now() - at) / (365.25 * 864e5));
      out.push(card('Released', at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), yrs >= 1 ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-yrs, 'year') : 'This year'));
    }
    if (s.albumType === 'single' || s.of === 1) out.push(card('Released as', 'Single', s.album));
    else if (s.pos && s.of) out.push(card(s.albumType === 'ep' ? 'On the EP' : 'On the album', `${s.pos} of ${s.of}`, s.album));
    if (s.genre) out.push(card('Genre', s.genre));
    if (s.duration) out.push(card('Length', `${Math.floor(s.duration / 60)}:${String(s.duration % 60).padStart(2, '0')}`));
    if (s.bpm) out.push(card('Tempo', `${s.bpm} BPM`));
    out.forEach((c, i) => c.style.setProperty('--i', i));
    grid.replaceChildren(...out);
    mbPan(mbScene);       // (its arrow: there are numbers now)
  }
  mbNumsEl.querySelector('.mbDz').addEventListener('click', (e) => { e.preventDefault(); if (mbStatsNow && mbStatsNow.link) surf('go', { text: mbStatsNow.link }); });
  const firstWords = (s) => { const m = /^[\s\S]{40,260}?[.!?](?=\s+[A-Z]|$)/.exec(s || ''); return m ? m[0] : (s || '').length > 260 ? s.slice(0, 260).replace(/\s+\S*$/, '') + '…' : s || ''; };
  function setMbNote() {
    const el = mbEl.querySelector('.mbNote'), t = mbSongText || (mbBioNow && mbSongFor ? firstWords(mbBioNow.about) : '') || mbNoteBase;
    if (el.textContent !== t) el.textContent = t;
  }
  mbSongWiki.addEventListener('click', (e) => { e.preventDefault(); if (mbBioNow) surf('go', { text: mbBioNow.bandUrl || mbBioNow.url }); });
  mbBioEl.querySelector('.mbWiki').addEventListener('click', (e) => { e.preventDefault(); if (mbBioNow) surf('go', { text: mbBioNow.url }); });
  function syncMediaBack() {
    const surfUp = document.body.classList.contains('web');
    if (surfUp) screenTab = 'surf'; else if (bcHere()) screenTab = 'broadcast';       // (put up some other way: a link, a friend's broadcast)
    else if (screenTab === 'surf' || screenTab === 'broadcast') screenTab = tab === 'media' ? 'media' : 'scenes';       // (put away: back to what's under it)
    const slUp = !!document.querySelector('#slTable.on');       // (Scene Slots: friends see you're there, but it's yours, so there's no sitting down next to you)
    const whereNow = screenTab === 'scenes' && (bjOn || gmOn || slUp) ? (bjOn ? 'blackjack' : gmOn || 'slots') : screenTab;       // (at a table: friends who click you sit down next to you)
    if (whereNow !== whereSent) { whereSent = whereNow; api.chat('where', whereNow).catch(() => {}); }       // friends' hub bars jump here when they click you (chat.js drawCall)
    const on = screenTab === 'media' && !videoOn() && !surfUp && !bcHere();
    if (on !== mbOn) { mbOn = on; mbEl.classList.toggle('on', on); }
    if (!on) return;
    // a video playing on another monitor shares the GPU with this screen: its drifting lights hold still meanwhile (tickMediaBack)
    const vidElsewhere = S.mode === 'mix' && !!S.videoUrl && !S.video.paused && Object.entries(S.perDisplay || {}).some(([k, v]) => k !== me.key && v === 'video');
    mbEl.classList.toggle('rest', vidElsewhere);
    // another app's song (Spotify, Apple Music, a browser...: main.js appNowWatch) when none of Drift's own is playing (a paused
    // playlist doesn't hide it) and it has played (appNowShown)
    const tm = theirMusic(), an = S.appNow, sp = !musicPlaying() && an && an.show && an.title ? an : null, music = musicOn() || !!sp;
    const playingNow = sp ? !!sp.playing : musicPlaying();
    const title = sp ? sp.title : tm ? (tm.src === 'files' ? tm.title || 'Music' : (PRESETS.find((x) => x.id === tm.preset) || { name: 'Ambient' }).name) : (S.nowPlaying || {}).title || 'Music';
    const artist = !music ? '' : sp ? sp.artist || '' : tm ? (tm.src === 'files' ? tm.artist || '' : '') : (S.nowPlaying || {}).artist || '';
    const list = !tm && filesOn() ? S.music.playlist : [], at = (S.nowPlaying || {}).index ?? -1;
    sleeveArt(sp ? 'app:' + (sp.key || 0) : music && list.length && at >= 0 ? list[at] || '' : '');
    mbBio(artist);
    const k = JSON.stringify([music, title, artist, playingNow, !!tm, !!sp, sp && sp.album, sp && sp.app, sp && spLead(), at, list.length, !!S.music.shuffle]);
    if (k === mbKey) return;
    mbKey = k;
    mbEl.classList.toggle('music', music);
    if (!music) mbSleeve.style.rotate = '';       // (the lean is only while music plays: tickMediaBack)
    mbEl.querySelector('.mbArtist').textContent = artist;
    mbEl.classList.toggle('playing', music && playingNow);
    // the sleeve's art: where its two lights sit and which way it's lit, from the title, so each song has its own cover
    let hh = 7; for (const ch of music ? title : '') hh = (Math.imul(hh, 31) + ch.charCodeAt(0)) >>> 0;
    const r = (n) => { hh = (Math.imul(hh ^ (hh >>> 15), 2246822507) + n) >>> 0; return (hh % 1000) / 1000; };
    const sl = mbEl.querySelector('.mbSleeve').style;
    sl.setProperty('--ax', (12 + r(1) * 40).toFixed(1) + '%'); sl.setProperty('--ay', (8 + r(2) * 40).toFixed(1) + '%');
    sl.setProperty('--bx', (52 + r(3) * 40).toFixed(1) + '%'); sl.setProperty('--by', (55 + r(4) * 40).toFixed(1) + '%');
    sl.setProperty('--rot', Math.round(110 + r(5) * 140) + 'deg');
    const two = (n) => String(n).padStart(2, '0');
    mbEl.querySelector('.mbNo').textContent = !music ? 'Drift · Media' : sp ? sp.album || sp.app || 'Music' : list.length && at >= 0 ? `Track ${two(at + 1)} / ${two(list.length)}` : tm ? 'Listening along' : 'Ambient';
    mbEl.querySelector('.mbKickTxt').textContent = music ? (playingNow ? (sp && sp.app ? `Now playing on ${sp.app}` : 'Now playing') : 'Paused') : 'Media';
    mbEl.querySelector('.mbTitle').textContent = music ? title : 'Nothing playing';
    const next = mbEl.querySelector('.mbNext');
    if (!music || !list.length || at < 0 || list.length < 2) next.replaceChildren();
    else if (S.music.shuffle) next.replaceChildren(Object.assign(document.createElement('h4'), { textContent: 'Up next: shuffled' }));
    else {
      const rows = [];
      for (let j = 1; j <= Math.min(3, list.length - 1); j++) {
        const n = (at + j) % list.length, row = document.createElement('div');
        row.append(Object.assign(document.createElement('b'), { textContent: two(n + 1) }), Object.assign(document.createElement('span'), { textContent: base(list[n]) }));
        rows.push(row);
      }
      next.replaceChildren(Object.assign(document.createElement('h4'), { textContent: 'Up next' }), ...rows);
    }
    mbSongNote(music && !tm ? title : '', music && !tm ? artist : '');
    mbStats(music && !tm ? title : '', music && !tm ? artist : '');
    mbNoteBase = music ? (sp ?`Playing in ${sp.app || 'another app'}.${spLead() ? ' The toolbar\'s controls are Spotify\'s while it plays.' : ''} Pick a song or a video to play one of yours here instead.`
      : tm ? `${(S.p2p || {}).host || 'Your friend'}'s music, playing along with you` : 'Songs in the same folder play one after another. Pick a video to watch it here.')
      : 'Pick a video or a song in the panel to play it on this screen.';
    setMbNote();
  }
  // Each frame while it's up, the music moves it the way it moves the scenes: the bass swells the light behind it and the treble
  // the other light (uAudio), each beat kicks the sleeve, lifts the bars and washes light up from the floor (uBeat), a ring leaves
  // the record on each of the last four beats (beatRings), and the record turns faster while the music is loud (uATime).
  const mbOrbs = [...mbEl.querySelectorAll('.mbOrb')], mbWaves = [...mbEl.querySelectorAll('.mbWaves i')], mbFlash = mbEl.querySelector('.mbFlash');
  const mbGlow = mbEl.querySelector('.mbGlow'), mbRings = mbEl.querySelector('.mbRings'), mbBarsEl = mbEl.querySelector('.mbBars');
  const mbLabel = mbEl.querySelector('.mbLabel'), stillMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let mbSpin = 0, mbAT = 0, mbT = 0;
  // The record and the sleeve each lean toward the pointer: aim is where the pointer is from its middle (-1..1 across the screen), tilt the lean so far
  const mbDisc = mbEl.querySelector('.mbDisc'), mbLean = [{ el: mbDisc, aim: [0, 0], tilt: [0, 0], deg: 7 }, { el: mbSleeve, aim: [0, 0], tilt: [0, 0], deg: 8 }];
  addEventListener('mousemove', (e) => {
    if (!mbOn) return;
    for (const m of mbLean) {
      const r = m.el.getBoundingClientRect();
      m.aim[0] = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (innerWidth / 2)));
      m.aim[1] = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (innerHeight / 2)));
    }
  });
  let mbDrift = 0; const mbAt = ['', ''];
  const mbEqBars = [...mbEl.querySelectorAll('.mbEq i')], mbEqAt = ['', '', ''], MB_EQ = [[0, 8], [8, 24], [24, 48]];       // (the spectrum's 64 bands, low to high: which each bar follows)
  const thereAndBack = (t, secs) => { const p = (t / secs) % 2, x = p < 1 ? p : 2 - p; return x * x * (3 - 2 * x); };       // 0 → 1 → 0, eased (as CSS's ease-in-out alternate)
  function tickMediaBack() {
    if (!mbOn) return;
    const now = performance.now(), dt = Math.min(0.1, (now - (mbT || now)) / 1000); mbT = now;
    // the lights drift slowly about, there and back over 38 s and 46 s (here, not a CSS animation: that ran at the monitor's rate
    // whatever the frame cap), a whole pixel at a time: a few steps a second, where a fraction of one each frame had it all drawn
    // again for nothing. Resting (a video playing on another monitor: syncMediaBack) they hold where they are.
    if (!stillMotion.matches && !mbEl.classList.contains('rest')) {
      mbDrift += dt;
      const vm = Math.max(innerWidth, innerHeight) / 100, a = thereAndBack(mbDrift, 38), b = thereAndBack(mbDrift, 46);
      const ta = `${Math.round(14 * a * vm)}px ${Math.round(10 * a * vm)}px`, tb = `${Math.round(-12 * b * vm)}px ${Math.round(-8 * b * vm)}px`;
      if (ta !== mbAt[0]) mbOrbs[0].style.translate = mbAt[0] = ta;
      if (tb !== mbAt[1]) mbOrbs[1].style.translate = mbAt[1] = tb;
    }
    if (!mbEl.classList.contains('music')) return;
    for (let i = 0; i < 32; i++) { const t = `scaleY(${(0.02 + 0.98 * Math.min(1, (specNow[i * 2] + specNow[i * 2 + 1]) / 510)).toFixed(3)})`; mbBars[31 - i].style.transform = t; mbBars[32 + i].style.transform = t; }
    const playing = mbEl.classList.contains('playing');
    // the equaliser beside "Now playing": the lows, the mids and the highs, a quarter of its height to all of it (each written only when it changes)
    const eqOn = playing && !stillMotion.matches;
    for (let k = 0; k < 3; k++) {
      let t = '';
      if (eqOn) { const [a, b] = MB_EQ[k]; let s = 0; for (let i = a; i < b; i++) s += specNow[i]; t = `scaleY(${(0.25 + 0.75 * Math.min(1, s / (b - a) / 200)).toFixed(2)})`; }
      if (t !== mbEqAt[k]) mbEqBars[k].style.transform = mbEqAt[k] = t;
    }
    const ages = beats.map((b) => (b && playing ? (Date.now() - b) / 1000 : 99)), beat = Math.exp(-ages[0] * 4) * Math.min(1, S.reactivity);
    const lo = Math.min(1.5, audio[0]), mid = Math.min(1.5, audio[1]), hi = Math.min(1.5, audio[2]);
    // set on the elements that use them, as scale and opacity: a custom property on #mediaBack had every style under it worked out again each frame
    mbGlow.style.scale = (1 + Math.min(0.12, lo * 0.08) * 0.6).toFixed(3);
    mbGlow.style.opacity = (0.72 + 0.28 * beat).toFixed(3);
    mbSleeve.style.scale = (1 + 0.018 * beat).toFixed(4);       // a small kick on each beat
    mbRings.style.opacity = (0.4 + 0.6 * Math.min(1, mid * 0.7)).toFixed(3);
    mbBarsEl.style.opacity = (0.42 + 0.12 * beat).toFixed(3);
    mbOrbs[0].style.transform = `scale(${(1 + lo * 0.1 + beat * 0.05).toFixed(3)})`; mbOrbs[0].style.opacity = (0.5 + lo * 0.18).toFixed(3);
    mbOrbs[1].style.transform = `scale(${(1 + hi * 0.12).toFixed(3)})`; mbOrbs[1].style.opacity = (0.32 + hi * 0.2).toFixed(3);
    mbFlash.style.opacity = (beat * 0.18).toFixed(3);
    // the record and the sleeve lean a little toward the pointer (eased, so they follow rather than snap); the sleeve's sheen goes with it
    for (const { el, aim, tilt, deg } of mbLean) {
      tilt[0] += (aim[0] - tilt[0]) * Math.min(1, dt * 5); tilt[1] += (aim[1] - tilt[1]) * Math.min(1, dt * 5);
      const tl = Math.hypot(tilt[0], tilt[1]), still = tl < 0.002 || stillMotion.matches;
      el.style.rotate = still ? '' : `${(-tilt[1] / tl).toFixed(3)} ${(tilt[0] / tl).toFixed(3)} 0 ${(Math.min(1, tl) * deg).toFixed(2)}deg`;
      if (el === mbSleeve) { el.style.setProperty('--gx', still ? '0' : tilt[0].toFixed(3)); el.style.setProperty('--gy', still ? '0' : tilt[1].toFixed(3)); }
    }
    for (let i = 0; i < 4; i++) {
      const a = ages[i], w = mbWaves[i].style;
      if (a > 3) { if (w.opacity !== '0') w.opacity = '0'; continue; }
      w.transform = `scale(${(1 + a * 0.75).toFixed(3)})`; w.opacity = (Math.exp(-a * 1.3) * 0.4 * Math.min(1, S.reactivity)).toFixed(3);
    }
    // the turn: 33⅓ at rest, gaining a little with every bit the audio clock runs ahead (it only runs while the music is loud)
    const dA = aTime - mbAT; mbAT = aTime;
    if (playing && !stillMotion.matches) { mbSpin = (mbSpin + dt * 200 + Math.max(0, Math.min(1, dA)) * 140) % 360; mbLabel.style.setProperty('--spin', mbSpin.toFixed(1) + 'deg'); }
  }
  window.appUI = { toTable: (g) => { g = ['roulette', 'poker', 'sketch', 'pachinko', 'crane'].includes(g) ? g : 'blackjack'; P(S.mode === 'mix' ? { perDisplay: { [me.key]: g } } : { scene: g }); window.appUI.setTab('scenes'); }, tab: () => tab, setTab: (t) => { if (panel.classList.contains('open')) setTab(t); else { tab = t; if (!SIDE_TABS.includes(t)) screenTab = t; pickScreen(t); tellTab(); syncUI(); } }, open: () => panel.classList.contains('open'), key: me.key };       // (a closed panel stays closed)       // (broadcast.js: its tab comes and goes)
  panel.addEventListener('mouseenter', () => { overPanel = true; });
  panel.addEventListener('mouseleave', () => { overPanel = false; armHide(); });
  let lastMove = [0, 0];
  addEventListener('mousemove', (e) => {
    if (e.target === vidEl || e.target === mirEl || (gpuEl && e.target === gpuEl) || surfBar.contains(e.target) || e.target === surfEdge) return;
    if (document.body.classList.contains('surfing') && winBar.contains(e.target)) return;       // (windowed: the window's buttons over Surf's bar are part of it)       // over a friend's web page the mouse is theirs to follow, not a call for the panel; nor is the browser's own bar
    if (Math.abs(e.screenX - lastMove[0]) + Math.abs(e.screenY - lastMove[1]) < 4) return;   // ignore jitter
    lastMove = [e.screenX, e.screenY]; showPanel();
  });
  // (the mixer belongs to the panel, though it is drawn apart from it)
  addEventListener('mousedown', (e) => {
    if (e.target === vidEl || e.target === mirEl || (gpuEl && e.target === gpuEl) || surfBar.contains(e.target)) return;
    if ($('#bcView').contains(e.target)) { panel.classList.remove('open'); return; }       // the Broadcast scene's tiles and bar: a click is for them (it only puts the panel's page away)
    if (e.target.closest('#mediaBack a, #mediaBack button')) return;       // the Media screen's links and arrows (mbPan)
    if (e.target.closest('#bjTable .bjFelt, #bjTable .bjBar, #rlTable .rlFelt, #rlTable .bjBar, #pkTable .pkFelt, #pkTable .bjBar, #skTable .skFelt, #skTable .bjBar, #paTable .paCab, #paTable .bjBar, #crTable .crCab, #crTable .bjBar')) return;       // a game's table and its buttons (the room around it still brings the panel)
    if (!panel.contains(e.target) && !confirmEl.contains(e.target) && !$('#mixer').contains(e.target)) { if (panel.classList.contains('open')) { panel.classList.remove('open'); } else showPanel(); } });

  const fill = (el) => el.style.setProperty('--fill', ((el.value - el.min) / (el.max - el.min)) * 100 + '%');
  const setVal = (el, v) => { if (document.activeElement !== el || el.tagName !== 'INPUT') { el.value = v; } if (el.type === 'range') fill(el); };
  const base = (p) => p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  let plKey = '';

  // The underline in the tabs' pill slides along to the one on screen. It goes straight there (no slide) the first time, after
  // the pill wasn't laid out, and when the pill itself changes size (Share comes or goes, a badge)
  let inkAt = null;
  function placeInk(still) {
    const ink = $('.tabInk'), b = $('.tabGroup button.showing');
    if (!b || !b.offsetWidth) { ink.style.opacity = '0'; inkAt = null; return; }
    const r = document.createRange(); r.selectNodeContents(b);       // the icon and the name (not the padding): the line is as wide as them
    const bb = b.getBoundingClientRect(), cb = r.getBoundingClientRect(), w = Math.round(cb.width) || 14;
    const x = Math.round(b.offsetLeft + (cb.left - bb.left) + (cb.width - w) / 2), at = x + ':' + w;
    ink.style.opacity = '1';
    if (at === inkAt) return;
    const put = () => { ink.style.transform = `translateX(${x}px)`; ink.style.width = w + 'px'; };
    if (still || inkAt === null) { ink.classList.add('still'); put(); void ink.offsetWidth; ink.classList.remove('still'); }
    else put();
    inkAt = at;
  }
  new ResizeObserver(() => placeInk(true)).observe($('.tabGroup'));
  function syncUI() {
    syncContentPal();
    setAccent();
    $('#cycleSecs').value = String(S.cycleSecs); $('#cycleSecs').disabled = S.palette !== 'cycle';
    $('#overlay').value = S.overlay; $('#algoInfo').checked = !!S.algoInfo;
    const cur = sceneFor(S);
    $$('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    $$('#content section').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    panel.classList.toggle('notab', tab === 'surf');
    $$('.tile').forEach((x) => x.classList.toggle('active', x.dataset.id === cur));
    const skip = S.cycleSkip || [];                  // ticks for which scenes the automatic changes may pick
    $('#tiles').classList.toggle('rotating', S.autoCycle > 0);
    $$('.tile[data-id]').forEach((x) => { const on = !skip.includes(x.dataset.id), lk = isLocked(x.dataset.id); x.classList.toggle('skip', !on); x.classList.toggle('locked', lk); x.title = lk ? 'Locked: unlock it with a scene token at Scene Slots' : ''; const r = x.querySelector('.rot'); if (r) r.setAttribute('aria-checked', String(on)); });
    const open = CYCLED.filter((s) => !isLocked(s.id)), ticked = open.filter((s) => !skip.includes(s.id)).length;       // (the rotation goes through the open ones only)
    $('#rotNote').textContent = S.autoCycle > 0 ? (ticked < 2 ? 'Tick at least two scenes to rotate between.' : `Rotating through ${ticked} of ${open.length} scenes. Untick a scene to leave it out. Games and locked scenes are never picked.`) : '';
    $$('.sw').forEach((x) => x.classList.toggle('active', x.dataset.id === S.palette));
    const cc = customNow();
    $('.sw.cus').style.background = `linear-gradient(90deg,${cc.join(',')})`;
    $('.sw.art').style.background = contentHex ? `linear-gradient(90deg,${contentHex.join(',')})` : '';       // (style.css's rainbow until a cover has been read)
    $('#customRow').classList.toggle('on', S.palette === 'custom');
    $$('#customRow input').forEach((el) => { if (document.activeElement !== el) el.value = cc[+el.dataset.i]; });
    $$('#mode button').forEach((x) => x.classList.toggle('active', x.dataset.v === S.mode));
    const multi = !S.windowed && init.displays.filter((d) => !S.displaysOff.includes(d.index)).length > 1;       // (windowed: one window, so nothing is across monitors)
    $('#modeHint').textContent = S.mode === 'span' ? 'Spanned across monitors' : S.mode === 'mirror' ? 'Mirrored on each monitor' : 'Mix: picking for this monitor';
    $('#modeHint').style.display = multi ? '' : 'none';
    $('#modeNote').textContent = !multi ? 'Only one monitor is on, so this changes nothing yet.'
      : S.mode === 'span' ? 'Scenes and videos stretch as one picture across all monitors.'
      : S.mode === 'mirror' ? 'Each monitor shows the whole scene or video, and a page open in Surf.'
      : 'Each monitor plays its own scene or video: open the panel on a monitor and pick one there.';
    const ambOn = !S.music.ambientOff && S.music.source !== 'off';       // the ambient choice (it waits while your music plays)
    $$('.preset').forEach((x) => x.classList.toggle('active', x.dataset.id === (ambOn ? S.music.preset : 'off')));
    $('#presets').classList.toggle('waiting', S.music.source === 'files' || !!theirMusic());
    $$('.mon').forEach((x) => x.classList.toggle('on', !S.displaysOff.includes(+x.dataset.i)));
    for (const k of ['speed', 'brightness', 'reactivity']) setVal($('#' + k), S[k]);
    setVal($('#volume'), S.music.volume);
    $$('[data-nature]').forEach((x) => setVal(x, S.music.nature[x.dataset.nature]));
    $('#o-speed').textContent = S.speed.toFixed(2) + '×';
    $('#o-brightness').textContent = Math.round(S.brightness * 100) + '%';
    $('#o-reactivity').textContent = S.reactivity < 0.01 ? 'Off' : Math.round(S.reactivity * 100) + '%';
    $('#o-volume').textContent = Math.round(S.music.volume * 100) + '%';
    setVal($('#catCount'), catCount()); $('#o-catCount').textContent = catCount();
    $('#catCountRow').hidden = !S.catsUnlocked;
    $('#catName').textContent = S.catsUnlocked ? 'Summon the cats' : 'Summon the cat';
    for (const k of ['autoCycle', 'quality', 'fps']) $('#' + k).value = String(S[k]);
    $('#surfFit').value = [...$('#surfFit').options].some((o) => o.value === S.surfFit) ? S.surfFit : 'own';       // (a monitor that's been unplugged: shown as the default)
    const sbTheme = S.surfTheme || 'glass';       // Surf's bar wears its style as a class (style.css #surfBar.t-*)
    $('#surfTheme').value = sbTheme;
    for (const c of [...$('#surfBar').classList]) if (c.startsWith('t-') && c !== 't-' + sbTheme) $('#surfBar').classList.remove(c);
    $('#surfBar').classList.add('t-' + sbTheme);
    for (const k of ['cycleShuffle', 'clock', 'breathing', 'cat', 'keepAwake', 'onTop', 'autoUpdate', 'surfGpu', 'ambientYields']) $('#' + k).checked = !!S[k];
    $('#hsCard').hidden = !S.hosting;       // the hub's Surf stream: its host's to set
    if (S.hubSurf) { $('#hsNoDl').checked = !!S.hubSurf.noDownloads; $('#hsSpecs').checked = !!S.hubSurf.showSpecs; $('#hsBrowsing').checked = !!S.hubSurf.showBrowsing; if (document.activeElement !== $('#hsLan')) $('#hsLan').value = S.hubSurf.allowLan || ''; }
    if (S.hubHeld && JSON.stringify(S.hubHeld.map((d) => d.id)) !== JSON.stringify(heldList.map((d) => d.id))) drawHeld(S.hubHeld);       // (a window that opened while one waits)
    syncUpdate();
    $('#shuffle').checked = !!S.music.shuffle;
    if (!(S.sleepAt > Date.now())) $('#sleep').value = '0';
    const sp = S.spotify || { status: 'unsupported', title: '' }, spOn = ctx() === 'spotify';
    $('#qvol').disabled = volIsSpotify() && !sp.volMode; $('#qvol').style.opacity = $('#qvol').disabled ? 0.35 : 1;
    const tm0 = theirMusic();
    $('#ambNote').textContent = tm0 ? `Waiting while you listen to ${(S.p2p || {}).host || 'your friend'}'s music` : S.music.source === 'files' ? 'Waiting while your music plays — it comes back when you stop it'
      : ambOn && S.music.playing && spLead() && sp.status === 'playing' ? 'Spotify is playing too. Choose Off to hear only Spotify.' : '';
    $('#stopMusic').style.display = S.music.source === 'files' ? '' : 'none';
    const sc = SCENES.find((x) => x.id === cur);
    $('#videoFit').value = S.video.fit; $('#videoSound').checked = !!S.video.sound; $('#videoAuto').checked = S.video.autoplay !== false;
    $('#stopVideo').style.display = cur === 'video' ? '' : 'none';
    const va = S.videoAudio || {}, vi = S.videoInfo || {}, pp = S.p2p || {}, guest = pp.role === 'guest';
    syncSubUI(); syncShareUI(); syncConvertUI();
    const from = guest ? ` (shared by ${pp.host || 'a friend'})` : '';
    $('#vnote').textContent = !videoOn() ? (guest ? `${pp.host || 'Your friend'} isn't playing a video right now.`
      : filesOn() && S.nowPlaying.title ? `Music: ${S.nowPlaying.title}${S.music.playing ? '' : ' (paused)'} — the scene and its visualizer play along. Songs in the same folder play one after another.`
      : 'Pick a video or a song to play it. Videos fill your monitors; music plays over the scene.' + (S.video.autoplay !== false ? ' Files in the same folder play one after another.' : ' Video autoplay is off, so each video stops when it ends.'))
      : useX() ? `Now playing: ${S.videoName}${from} — ${pp.viaHost ? `${pp.host}'s PC is sending a ${pp.quality === 'original' ? 'converted' : pp.quality + 'p'} copy.`
        : vi.hdr && !vi.force ? 'this HDR video is being converted to SDR for this screen.' : vi.hdr ? 'it is being converted (HDR to SDR) so it can play here.' : 'the built-in player can\'t play this format, so it is being converted live.'}`
      : va.ffmpeg === false && !guest ? `Now playing: ${S.videoName} — this copy of Drift is missing ffmpeg.exe, so Dolby / DTS sound and HDR video can't be converted and subtitles stored inside a video can't be read. Put ffmpeg.exe in Drift's "resources" folder and restart.`
      : va.mode === 'transcode' && va.ffmpeg !== false ? `Now playing: ${S.videoName}${from} — its ${va.codec.toUpperCase().replace('EAC3', 'Dolby Digital Plus (E-AC-3)').replace(/^AC3$/, 'Dolby Digital (AC-3)')} sound is being converted live so you can hear it.`
      : va.mode === 'none' ? `Now playing: ${S.videoName}${from} — this file has no audio track.` : `Now playing: ${S.videoName}${from}${pp.own ? ' — playing your own copy of this file.' : ''}`;
    renderFolders(); markPlaying();
    panel.classList.toggle('hasvideo', videoOn()); panel.classList.toggle('surf', ctx() === 'surf');
    syncMixer();
    setVal($('#qvol'), volNow());
    $('#qvol').title = volIsSurf() ? 'Surf volume (every web page)' : volIsVideo() ? 'Media volume (videos and your music)' : !volIsSpotify() ? 'Ambient volume (music and nature sounds)' : sp.volMode === 'app' ? 'Spotify volume' : sp.volMode === 'system' ? 'PC volume (Spotify is not playing yet)' : 'Spotify volume is not available';
    const c = ctx();
    $('#ctxTag').textContent = { scene: 'Scene', video: 'Video', music: 'Music', surf: 'Surf', spotify: 'Spotify' }[c];
    // in the tabs' pill, the one on this screen now: a broadcast being watched here, else what the bar's controls are for
    syncMediaBack();
    const onScreen = S.bcView && S.bcView.key === me.key ? 'broadcast' : c === 'surf' ? 'surf' : mbOn ? 'media' : c === 'scene' && cur !== 'video' ? 'scenes' : 'media';
    $$('.tabGroup button').forEach((x) => x.classList.toggle('showing', x.dataset.tab === onScreen));
    placeInk();
    $('#play').style.display = c === 'surf' ? 'none' : '';
    // Eject: put away your own video or music and go back to Media's "Nothing playing" screen (not a friend's shared video or
    // music: that's theirs, and stopping their video would leave their session)
    const ej = c === 'video' ? (videoOn() && (S.p2p || {}).role !== 'guest' ? 'video' : '') : c === 'music' && filesOn() && !theirMusic() ? 'music' : '';
    $('#eject').style.display = ej ? '' : 'none'; $('#eject').dataset.what = ej;
    $('#eject').title = ej === 'video' ? 'Eject: close the video' : 'Eject: stop the music';
    $('#prevTrack').title = c === 'surf' ? 'Back (←)' : 'Previous (←)'; $('#nextTrack').title = c === 'surf' ? 'Forward (→)' : 'Next (→)';
    syncPausedTitle(cur);
    const noStep = c === 'scene' && cur === 'video';       // on Scenes with a video on screen: no scene playing to step from
    const wb = S.web || {};       // (on Surf: Back and Forward, when the page has somewhere to go)
    $('#prevTrack').disabled = noStep || (c === 'surf' && !wb.back); $('#nextTrack').disabled = noStep || (c === 'surf' && !wb.fwd);
    const tm = theirMusic(), tmName = tm ? (tm.src === 'files' ? tm.title || 'Music' : (PRESETS.find((x) => x.id === tm.preset) || { name: 'Ambient' }).name) : '';
    const playing = c === 'scene' ? !S.frozen : c === 'video' ? videoOn() && !S.video.paused : c === 'surf' ? false : spOn ? sp.status === 'playing' : musicPlaying();
    $('#play').textContent = playing ? '⏸' : '▶';
    // what the controls are on: no longer written on the bar (it's on screen), but in Play's tooltip (and data-now, for the tests)
    const nowName = c === 'scene' ? (cur === 'video' ? 'My Video' : sc ? sc.name : '')
      : c === 'video' ? (S.videoName ? S.videoName.replace(/\.[^.]+$/, '') : 'No video chosen')
      : c === 'surf' ? ((S.web || {}).has ? (S.web.title || S.web.url || 'New tab') : 'No page open')
      : spOn ? (sp.title || 'Spotify (paused)') : tm ? `${tmName} · from ${S.p2p.host || 'your friend'}` : filesOn() ? (S.nowPlaying.title || 'Music') : 'No music chosen';
    $('#play').dataset.now = nowName; $('#play').title = (playing ? 'Pause' : 'Play') + (nowName ? `: ${nowName}` : '') + ' (Space)';
    syncWinBar({ cur, c, nowName, playing, tm, tmName });
    const pp2 = S.p2p || {}, mine = S.music.source === 'files' || S.music.source === 'generative';
    $('#mShare').textContent = tm ? `You are listening to ${pp2.host || 'your friend'}'s music${tm.on ? '' : ' (paused)'}: ${tmName}. Your own music waits until you leave${pp2.ctrl ? '. Play, pause and skip work on theirs' : `. Only ${pp2.host || 'your friend'} can change it`}.`
      : pp2.role === 'host' ? (spOn ? 'Spotify can\'t be sent to friends. Ambient sound and music from your library can.' : mine ? `Friends${(pp2.peers || []).length ? '' : ' who join'} hear your ${S.music.source === 'files' ? 'music' : 'ambient sound'} with you.` : '') : S.mediaSolo || '';       // (mediaSolo: why what you play isn't on the hub's stream: main.js mediaRefused)
  }

  // ---------- a web page on this screen (watching a web page together): main's web.js loads and steers it ----------
  const webEls = new Map(), surfBar = $('#surfBar'), surfEdge = $('#surfEdge');       // one <webview> for each of the browser's tabs
  let webEl = null, webGen = 0, capSid = '';       // webEl: the tab in front
  let heldList = [], heldTick = 0;       // downloads on the hub's Surf stream waiting for this PC (its host): drawHeld
  let gpuEl = null;       // the canvas a page drawn offscreen is drawn in (web.js), here on its own monitor (gpuEl.own) or mirroring it
  const pageEl = () => webEl || (gpuEl && gpuEl.own ? gpuEl : null);       // what stands for our own page on this screen, for friends' capture
  // Where the hidden controls are, said quietly along the bottom (the bar is peeking at the top at the same moment), for the first few
  // visits only. The start page says it in its own footer.
  let edgeTimer = 0;
  const edgeHint = () => {
    const w = S.web || {};
    if (init.testMode || /^drift:\/\/home/i.test(w.url || '')) return;
    let n = 0; try { n = +localStorage.getItem('drift.edgeHints') || 0; localStorage.setItem('drift.edgeHints', n + 1); } catch { /* shown anyway */ }
    if (n >= 3) return;
    const el = $('#edgeHint');
    el.innerHTML = '<span><b>↑</b> Top edge: tabs and address</span><span><b>↓</b> Bottom edge: Drift’s controls</span>';
    el.classList.add('on'); clearTimeout(edgeTimer); edgeTimer = setTimeout(() => el.classList.remove('on'), 5000);
  };
  // A page drawn bigger than this monitor (while mirroring, other monitors' shapes stretch it a little: pageSize in main.js) is shrunk to fit, whole, with
  // black bars where its shape differs. Its layout stays its own; friends and mirrors get its full size.
  // Windowed, the page sits under Surf's bar, pinned across the window's top as its tabs and toolbar (style.css --wbChrome, main.js WIN_SURF_ROW): its room is the window less those rows.
  const WB_ROW = 80;
  function fitPage(el, px) {
    const top = S.windowed ? WB_ROW : 0, iw = innerWidth, ih = innerHeight - top;
    const dpr = devicePixelRatio || 1, w = px ? px.w / dpr : iw, h = px ? px.h / dpr : ih;
    if (Math.abs(w - iw) < 2 && Math.abs(h - ih) < 2) { el.style.cssText = ''; return; }
    const k = Math.min(iw / w, ih / h);
    el.style.cssText = `top:${top}px;width:${w}px;height:${h}px;right:auto;bottom:auto;transform-origin:0 0;transform:translate(${(iw - w * k) / 2}px,${(ih - h * k) / 2}px) scale(${k})`;
  }
  addEventListener('resize', () => { for (const el of webEls.values()) fitPage(el, (S.web || {}).page); });
  function syncWeb() {
    const w = S.web || {}, here = !!w.open && w.key === me.key, live = !!w.live;       // live: a hub's Surf stream is running (renderer/surf-stream.js on the host's PC)
    const parked = !here && !!w.parked && w.parked === me.key;       // put away on this screen: its pages stay loaded, out of sight (web.js hide)
    const pages = (here || parked) && !w.stream && !w.gpu;
    if (webEls.size && (!pages || w.gen !== webGen)) { for (const el of webEls.values()) el.remove(); webEls.clear(); webEl = null; dropPeers(); }
    if (pages) {
      const first = !webEls.size && here, was = webEl;
      webGen = w.gen;
      for (const [id, el] of webEls) if (!(w.tabs || []).some((t) => t.id === id)) { el.remove(); webEls.delete(id); }
      for (const t of w.tabs || []) {
        if (webEls.has(t.id)) continue;
        const el = document.createElement('webview');
        el.className = 'web'; el.setAttribute('partition', 'persist:web'); el.setAttribute('allowpopups', ''); el.setAttribute('src', 'about:blank');       // which windows a page may open is decided in main (web.js)
        const tell = () => { try { api.cmd({ type: 'surf', do: 'attached', tab: t.id, wc: el.getWebContentsId() }); return true; } catch { return false; } };       // main matches the page to its tab
        el.addEventListener('did-attach', () => { if (!tell()) el.addEventListener('dom-ready', tell, { once: true }); });
        document.body.insertBefore(el, $('#webEdge'));
        webEls.set(t.id, el);
      }
      webEl = here ? webEls.get(w.active) || null : null;
      if (parked && was && document.activeElement === was) { was.blur(); window.focus(); }       // a hidden page keeps no keys
      for (const el of webEls.values()) { el.classList.toggle('on', el === webEl); fitPage(el, w.page); }
      if (webEl && webEl !== was && !surfBar.contains(document.activeElement) && !panel.contains(document.activeElement)) { try { webEl.focus(); } catch { /* not ready to take the keys yet */ } }
      if (first) { edgeHint(); surfPeek(); }
    }
    if ((w.sid || '') !== capSid) { capSid = w.sid || ''; dropPeers(); }       // another tab came to the front: friends ask for its picture
    if ((S.p2p || {}).role !== 'host') for (const id of [...pcs.keys()]) if (!isLocal(id)) dropPeer(id);       // (this PC's other monitors keep theirs)
    if (!S.surfMirror || !webEl) for (const id of [...pcs.keys(), ...asks.keys()]) if (isLocal(id)) dropPeer(id);
    const gpuWant = !!w.open && !w.stream && !!w.gpu && (here || !!S.surfMirror);       // drawn offscreen: shown here, or mirrored here
    if (gpuEl && (!gpuWant || gpuEl.own !== here)) dropGpuView();
    if (gpuWant && !gpuEl) { makeGpuView(here); if (here) { edgeHint(); surfPeek(); } }
    const mirror = mirrorHere(), mirroring = mirror || (!!gpuEl && !gpuEl.own);
    if (mirEl && !mirror) { mirHangUp(); mirEl.remove(); mirEl = null; msid = ''; }
    if (mirror && !mirEl) makeMirrorView();
    if (mirEl && w.sid !== msid) { msid = w.sid; mirAsk(); }       // a new page, or another tab came to the front
    // (a hub's Surf stream put away on this screen, Scenes or Media chosen: its picture goes, its sound plays on, decision §11.1)
    const streamHere = !!w.stream && (here || w.parked === me.key);
    if (vidEl && !streamHere) { vidEl.remove(); vidEl = null; hangUp(); gsid = ''; }
    if (streamHere && !vidEl) { makeStreamView(); if (here) { edgeHint(); surfPeek(); } }
    if (vidEl) { const was = vidEl.classList.contains('parked'); vidEl.classList.toggle('parked', !here); if (was && here) { edgeHint(); surfPeek(); vidEl.focus(); } else if (!here && document.activeElement === vidEl) { vidEl.blur(); window.focus(); } }
    if (vidEl) vidEl.volume = mixSurf();       // the Surf stream: the mixer's Surf level here (it keeps playing on other tabs: decision §11.1)
    if (vidEl && live && (w.sid !== gsid || !gLive)) { gsid = w.sid; ask(); }       // a new page, or the connection came back
    gLive = live;
    webUp = (here && !!webEls.size) || (!!vidEl && here) || !!mirEl || !!gpuEl;       // (each of them fills the screen, opaque: frame() stops drawing the scene under it)
    document.body.classList.toggle('web', webUp);
    document.body.classList.toggle('surfing', here || mirroring);       // the bar: everyone can steer a hub's Surf stream
    syncSsLine(w, here);
    if (!here && !mirroring) surfBar.classList.remove('show');
    syncSurfBar();
  }

  // ---------- other people's pointers over the page: a small arrow in their colour, with their name ----------
  const ptrBox = $('#ptrs'), ptrEls = new Map();
  // A person's colour: their hue from their name (the same on every PC), as light and as strong as this screen's palette (cursors.js)
  const ptrColor = (name) => window.driftPtrColor(name, accentSent.slice(0, 7) || accentHex());       // (accentSent: the accent as last set)
  let ptrGrad = 0;
  // a soft, rounded shape in the person's colour with a white edge (renderer/cursors.js), its hotspot where the element is, and their name
  function ptrShape(el, kind) {
    const c = window.driftCursor(kind || 'default');
    if (el.dataset.k === c.name) return;
    const name = el.lastChild ? el.lastChild.textContent : '';
    el.dataset.k = c.name; el.innerHTML = c.svg + '<b></b>'; el.lastChild.textContent = name;
    const id = 'ptrg' + (++ptrGrad);       // a soft light from above, in the person's colours (style.css --c-hi / --c-lo)
    el.firstChild.insertAdjacentHTML('afterbegin', `<defs><linearGradient id="${id}" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" style="stop-color:var(--c-hi)"/><stop offset=".55" style="stop-color:var(--c)"/><stop offset="1" style="stop-color:var(--c-lo)"/></linearGradient></defs>`);
    el.style.setProperty('--fill', `url(#${id})`);
    el.style.setProperty('--lx', c.lx + 'px'); el.style.setProperty('--ly', c.ly + 'px');
  }
  // where the page is on this screen: all of it here, or the picture inside a friend's stream (which may have bars beside it)
  function pageBox() {
    if (webEl) { const r = webEl.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; }
    const [el, vw, vh] = gpuEl && gpuEl.own ? [gpuEl, +gpuEl.dataset.fw || 0, +gpuEl.dataset.fh || 0] : vidEl ? [vidEl, vidEl.videoWidth, vidEl.videoHeight] : [null, 0, 0];
    if (!vw || !vh) return null;
    const r = el.getBoundingClientRect(), k = Math.min(r.width / vw, r.height / vh), w = vw * k, h = vh * k;
    return { l: r.left + (r.width - w) / 2, t: r.top + (r.height - h) / 2, w, h };
  }
  const showPtrs = (list) => drawPtrs(ptrBox, ptrEls, pageBox(), list);
  function drawPtrs(holder, els, box, list) {
    const now = Date.now();
    if (!box) list = [];
    for (const [id, q] of els) if (!list.some((x) => x.id === id)) { q.el.remove(); els.delete(id); }
    for (const x of list) {
      let q = els.get(x.id);
      if (!q) {
        const el = document.createElement('div'); el.className = 'ptr';
        el.style.setProperty('--c', ptrColor(x.name)); ptrShape(el);
        holder.appendChild(el); els.set(x.id, q = { el, x: -1, y: -1, at: now });
      }
      if (q.x !== x.x || q.y !== x.y) { q.x = x.x; q.y = x.y; q.at = now; }
      q.el.lastChild.textContent = x.name;
      q.el.style.left = (box.l + x.x * box.w).toFixed(1) + 'px'; q.el.style.top = (box.t + x.y * box.h).toFixed(1) + 'px';
      q.el.classList.toggle('idle', now - q.at > 6000);
    }
  }
  setInterval(() => {       // a pointer that has stopped fades away; one whose page has gone is taken away
    if (!ptrEls.size) return;
    if (!pageBox()) { showPtrs([]); return; }
    for (const q of ptrEls.values()) q.el.classList.toggle('idle', Date.now() - q.at > 6000);
  }, 1000);

  // ---------- our own pointer, drawn as the others see it, in place of the real one. Online in a hub (with the hub bar's cursor
  // toggle on) it's ours everywhere on Drift's screens, from the moment we're online. Over a picture the others see it on it says
  // so (selfCtx): a paused shared video ('vid'), a broadcast watched full screen ('bc'), a hub's Surf page ('surf', in the shape
  // the page asks for: 'web-cursor', surfCur). Anywhere else ('ui') it takes the shape Drift's own CSS gives what's under it. ----------
  const selfBox = document.createElement('div'); selfBox.id = 'selfPtrBox';
  document.body.appendChild(selfBox);
  const selfPtr = document.createElement('div');
  selfPtr.className = 'ptr self'; ptrShape(selfPtr);
  let surfCur = 'default';       // the pointer the hub's page wants while its hover is ours (web.js takeHover)
  let selfCtx = '', selfClaimed = false;       // selfClaimed: this mouse move was seen to by a picture's own handler
  const mouse = { x: 0, y: 0, t: null, in: false };       // where the mouse last was in this window, and over what
  const hubPtr = () => document.body.classList.contains('inHub') && (S.share || {}).cursor !== false;
  function showSelf(ctx, x, y, kind) {
    if (!ctx) { selfCtx = ''; if (selfPtr.isConnected) { selfPtr.remove(); document.documentElement.classList.remove('selfPtr'); } return; }
    selfCtx = ctx; selfPtr.dataset.ctx = ctx;
    if (ctx !== 'ui') selfClaimed = true;
    if (selfPtr.parentNode !== selfBox) selfBox.appendChild(selfPtr);
    const priv = ctx === 'surf' && (S.share || {}).cursor === false;       // over a hub's page with cursor sharing off: nobody sees it, and it says so
    selfPtr.classList.toggle('priv', priv);
    const n = priv ? 'Cursor off · view only' : myPtrName();
    const col = window.driftSelfColor(accentSent.slice(0, 7) || accentHex());       // yours wears the accent; friends' pointers keep their own colours
    if (selfPtr.lastChild.textContent !== n || selfPtr.dataset.col !== col) { selfPtr.lastChild.textContent = n; selfPtr.dataset.col = col; selfPtr.style.setProperty('--c', col); }       // (the palette may have changed while it was away)
    ptrShape(selfPtr, kind === 'none' ? 'default' : kind);
    selfPtr.style.visibility = kind === 'none' ? 'hidden' : '';       // (a page that hides the pointer, as video players do: none at all)
    selfPtr.style.left = x + 'px'; selfPtr.style.top = y + 'px';
    document.documentElement.classList.add('selfPtr');
  }
  // the pointer Drift's CSS gives an element (looked up once each, with ours out of the way for a moment) as a cursors.js shape
  const cssCur = new WeakMap();
  function uiKind(t) {
    if (!t || t.nodeType !== 1) return 'default';
    if (!cssCur.has(t)) {
      const html = document.documentElement, on = html.classList.contains('selfPtr');
      if (on) html.classList.remove('selfPtr');
      let c = getComputedStyle(t).cursor;
      if (on) html.classList.add('selfPtr');
      if (c === 'auto') c = t.closest('textarea, [contenteditable]:not([contenteditable="false"])') || (t.tagName === 'INPUT' && /^(text|search|url|email|password|number|tel|)$/.test(t.type)) ? 'text' : 'default';
      cssCur.set(t, c);
    }
    return cssCur.get(t);
  }
  // a picture is done with our pointer: online it goes on as the plain one where the mouse is, offline the real one is back
  function selfOff() {
    if (hubPtr() && mouse.in && !(mouse.t && mouse.t.tagName === 'WEBVIEW')) showSelf('ui', mouse.x, mouse.y, uiKind(mouse.t));
    else showSelf('');
  }
  addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.t = e.target; mouse.in = true; }, true);
  document.addEventListener('mouseleave', () => { mouse.in = false; showSelf(''); });
  addEventListener('mouseover', (e) => { if (e.target.tagName === 'WEBVIEW' && selfCtx === 'ui') showSelf(''); });       // (a page of our own browser: the mouse is its, out of our sight)
  addEventListener('blur', () => { mouse.in = false; showSelf(''); });
  // going online (or turning the toggle on) puts ours where the mouse is now; going offline gives the real one back
  const selfSync = () => { if (hubPtr()) { if (!selfCtx && mouse.in) selfOff(); } else if (selfCtx === 'ui') showSelf(''); };
  new MutationObserver(selfSync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  const surfSelf = (e) => { if ((S.web || {}).hub) showSelf('surf', e.clientX, e.clientY, surfCur); else if (selfCtx === 'surf') selfOff(); };       // (your own browser, offline: nobody else sees it, so the real pointer)
  setInterval(() => { if (selfCtx === 'surf' && (!document.body.classList.contains('web') || !(S.web || {}).hub)) selfOff(); }, 1000);       // the page went

  // ---------- pointers over a shared video while it's paused (main.js vptrSet): ours goes out, the others' are drawn ----------
  const vptrBox = $('#vptrs'), vptrEls = new Map();
  let vptrList = [];
  function vidBox() {       // the picture inside the video element, as object-fit places it (cover crops: the box runs off the edges)
    if (shown !== 'video' || !S.videoUrl || !video.videoWidth || !video.videoHeight) return null;
    const r = video.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
    const k = (video.style.objectFit === 'cover' ? Math.max : Math.min)(r.width / vw, r.height / vh), w = vw * k, h = vh * k;
    return { l: r.left + (r.width - w) / 2, t: r.top + (r.height - h) / 2, w, h };
  }
  const showVptrs = (list) => { vptrList = list; drawPtrs(vptrBox, vptrEls, vidBox(), list); };
  const vptrOn = () => { const p = S.p2p || {}; return !!S.video && S.video.paused && (S.share || {}).cursor !== false && (p.role === 'host' ? (p.peers || []).length > 0 : p.role === 'guest' && p.status === 'connected'); };
  let vptrAt = 0, vptrOut = false;
  addEventListener('mousemove', (e) => {
    const box = vptrOn() && stage.contains(e.target) ? vidBox() : null;       // (over the panel, the hub bar or the chat it isn't over the picture)
    const x = box ? (e.clientX - box.l) / box.w : -1, y = box ? (e.clientY - box.t) / box.h : -1, over = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    if (!over) { if (selfCtx === 'vid') selfOff(); if (vptrOut) { vptrOut = false; api.cmd({ type: 'vid-ptr', x: -1, y: -1 }); } return; }
    showSelf('vid', e.clientX, e.clientY);
    if (Date.now() - vptrAt < 40) return;       // at most 25 a second
    vptrAt = Date.now(); vptrOut = true;
    api.cmd({ type: 'vid-ptr', x: +x.toFixed(4), y: +y.toFixed(4) });
  });
  document.addEventListener('mouseleave', () => { if (vptrOut) { vptrOut = false; api.cmd({ type: 'vid-ptr', x: -1, y: -1 }); } });
  addEventListener('resize', () => { if (vptrEls.size) showVptrs(vptrList); });
  setInterval(() => {
    for (const q of vptrEls.values()) q.el.classList.toggle('idle', Date.now() - q.at > 6000);
    if (selfCtx === 'vid' && !vptrOn()) selfOff();       // it played again, or sharing went off: the plain pointer (or the real one) is back
  }, 1000);
  // online in a hub, everywhere a picture's own handler didn't see to (they run first: on the element, or on the window above)
  addEventListener('mousemove', (e) => {
    if (selfClaimed) { selfClaimed = false; return; }
    if (hubPtr() && e.target.tagName !== 'WEBVIEW') showSelf('ui', e.clientX, e.clientY, uiKind(e.target));
    else if (selfCtx) showSelf('');
  });

  // ---------- the Blackjack scene's table (renderer/blackjack.js; main.js bjMove; docs/plans/blackjack.md) ----------
  // Over the room the shader draws, on this screen while it shows the scene: every screen in Mix and Mirror, the middle one in
  // Span (the others have the room's light without a table). While it's up main.js is told, and seats you: at the active hub's
  // table when you're online in one, at your own otherwise. Online, the others' pointers over the table show on it, and yours goes to them.
  const bjEl = $('#bjTable'), bjPtrBox = $('#bjPtrs'), bjPtrEls = new Map();
  let bjPtrList = [], bjColKey = '', bjHub = '';       // bjHub: the hub whose table it is ('' alone)
  // at a hub's table, each seat wears its player's picture from the hub (renderer/chat.js face: their initial without one)
  const bjT = window.driftBJ(bjEl, (m) => api.cmd({ type: 'bj', ...m }), { face: (id) => (bjHub && window.chatUI ? window.chatUI.face(bjHub, id, '') : null),
    me: () => (window.chatUI ? window.chatUI.info().me.id || '' : '') });       // (you, on the hub's board of biggest pots)
  const bjHere = () => shown === 'blackjack' && sceneFor(S) === 'blackjack' && (S.mode !== 'span' || isCenter) && !webUp && !mbOn && !bcHere();
  function bjSync() {
    bjColors();
    const on = bjHere();
    if (on === bjOn) return;
    bjOn = on; bjEl.classList.toggle('on', on);
    if (!on) { bjT.view(null); bjPtrList = []; drawPtrs(bjPtrBox, bjPtrEls, null, []); }
    api.cmd({ type: 'bj', op: 'here', on, key: me.key });
    syncMediaBack();       // (where you are, for friends' hub bars)
  }
  setInterval(bjSync, 250);
  function bjCmd(c) {
    if (c.note && bjOn) bjT.note(c.note);
    if ('v' in c && bjOn) { bjHub = String(c.hub || ''); bjT.view(c.v || null, c.mode); }
    if (Array.isArray(c.ptrs)) { bjPtrList = c.ptrs; drawPtrs(bjPtrBox, bjPtrEls, bjOn ? bjT.box() : null, bjPtrList); }
  }
  // The room's light is the palette's: the felt from its second colour (pulled a little toward a card table's green), the rail
  // and the lamp from the accent, the chips from the darkest and lightest. Set again whenever the colours change.
  function bjColors() {
    const pc = currentColors(), a = accentHex(), key = a + pc.map((c) => toHex(c)).join('');
    if (key === bjColKey) return;
    bjColKey = key;
    const [h, s] = rgbToHsl(pc[1]), dh = ((0.44 - h + 1.5) % 1) - 0.5, fh = h + dh * 0.25, fs = Math.max(0.3, Math.min(0.65, s));
    const lamp = toHex(hex(a).map((v, i) => v * 0.7 + [1, 0.91, 0.78][i] * 0.3));
    const look = { colorOf: (n) => window.driftPtrColor(n, a), self: window.driftSelfColor(a),
      vars: { '--bjAccent': a, '--bjFelt': hslToHex(fh, fs, 0.2), '--bjFeltDeep': hslToHex(fh, fs, 0.075), '--bjHi': toHex(pc[3]), '--bjDark': toHex(pc[0]), '--bjLamp': lamp } };
    bjT.colors(look);
    for (const x of Object.values(GM)) x.t.colors(look);       // (Roulette's and Hold'em's tables: the same room)
    slT.colors(look);       // (and Scene Slots)
  }
  addEventListener('resize', () => { if (bjPtrEls.size) drawPtrs(bjPtrBox, bjPtrEls, bjOn ? bjT.box() : null, bjPtrList); });
  // (your pointer isn't sent from this table: each player sees it turned so their own seat is in the middle, so it wouldn't
  // land where you aimed it. main.js leaves the others' out too.)
  setInterval(() => { for (const q of bjPtrEls.values()) q.el.classList.toggle('idle', Date.now() - q.at > 6000); }, 1000);

  // ---------- the Games room's other tables: Roulette and Hold'em (renderer/roulette.js, renderer/poker.js; main.js gmMove) ----------
  // The same as the Blackjack table's above, one holder each: up on this screen while it shows that scene, seated by main.js at
  // the active hub's table or your own, the others' pointers over the felt and yours to them. The same light from the palette.
  const gmPtrBox = $('#gmPtrs'), gmPtrEls = new Map();
  let gmPtrList = [], gmPtrAt = 0, gmPtrOut = false, gmHub = '';
  const GM = { roulette: { el: $('#rlTable'), make: window.driftRoulette }, poker: { el: $('#pkTable'), make: window.driftPoker }, sketch: { el: $('#skTable'), make: window.driftSketch }, pachinko: { el: $('#paTable'), make: window.driftPachinko }, crane: { el: $('#crTable'), make: window.driftCrane } };
  for (const [g, x] of Object.entries(GM)) {
    x.on = false;
    x.t = x.make(x.el, (m) => api.cmd({ type: 'game', g, ...m }), { face: (id) => (gmHub && window.chatUI ? window.chatUI.face(gmHub, id, '') : null),
      me: () => (window.chatUI ? window.chatUI.info().me.id || '' : '') });
  }
  const gmHere = (g) => shown === g && sceneFor(S) === g && (S.mode !== 'span' || isCenter) && !webUp && !mbOn && !bcHere();
  const gmBox = () => (gmOn ? GM[gmOn].t.box() : null);
  function gmPtrOff() { if (gmPtrOut) { const g = gmPtrOut; gmPtrOut = false; api.cmd({ type: 'game', g, op: 'ptr', x: -1, y: -1 }); } }
  function gmSync() {
    for (const [g, x] of Object.entries(GM)) {
      if (x.t.tokens) x.t.tokens(S.tokens || 0);       // (the crane's and Pachinko's bars show your scene tokens: yours, not the table's)
      const on = gmHere(g);
      if (on === x.on) continue;
      x.on = on; x.el.classList.toggle('on', on);
      if (on) gmOn = g; else if (gmOn === g) gmOn = '';
      if (!on) { x.t.view(null); gmPtrList = []; drawPtrs(gmPtrBox, gmPtrEls, null, []); if (gmPtrOut === g) gmPtrOff(); }
      api.cmd({ type: 'game', g, op: 'here', on, key: me.key });
      syncMediaBack();
    }
  }
  setInterval(gmSync, 250);
  function gmCmd(c) {
    const x = GM[c.g]; if (!x) return;
    if (c.note && x.on) x.t.note(c.note);
    if ('v' in c && x.on) { gmHub = String(c.hub || ''); x.t.view(c.v || null, c.mode); }
    if (c.ink && x.t.ink) x.t.ink(c.ink);       // (Sketch & Guess: the drawing as it grows)
    if (c.settings && x.t.settings) x.t.settings(c.settings);       // (and its settings)
    if (Array.isArray(c.ptrs) && gmOn === c.g) { gmPtrList = c.ptrs; drawPtrs(gmPtrBox, gmPtrEls, gmBox(), gmPtrList); }
  }
  addEventListener('resize', () => { if (gmPtrEls.size) drawPtrs(gmPtrBox, gmPtrEls, gmBox(), gmPtrList); });
  addEventListener('mousemove', (e) => {       // your pointer over the table, for the others at it (main.js sends it only online, with cursor sharing on)
    if (!gmOn || gmOn === 'poker') return;       // (none from Hold'em's table: it's turned for each player, as Blackjack's is)
    const x0 = GM[gmOn], b = x0.t.box(), over = !!b && x0.el.contains(e.target);
    const x = over ? (e.clientX - b.l) / b.w : -1, y = over ? (e.clientY - b.t) / b.h : -1;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) { gmPtrOff(); return; }
    if (Date.now() - gmPtrAt < 40) return;       // at most 25 a second
    gmPtrAt = Date.now(); gmPtrOut = gmOn;
    api.cmd({ type: 'game', g: gmOn, op: 'ptr', x: +x.toFixed(4), y: +y.toFixed(4) });
  });
  setInterval(() => { for (const q of gmPtrEls.values()) q.el.classList.toggle('idle', Date.now() - q.at > 6000); }, 1000);

  // ---------- Scene Slots (renderer/slots.js; docs/plans/scene-slots.md): always your own machine, never a hub's ----------
  // Up on this screen while it shows the scene, like the tables. It's given your tokens and the scenes still locked (S.tokens,
  // S.locked: main.js), asks main.js for a scene when you pull (slotsSpin), and spins round to the one it's told.
  const slEl = $('#slTable'), SCENE_NAMES = Object.fromEntries(SCENES.filter((s) => !s.game).map((s) => [s.id, s.name]));
  // (its reels' pictures are drawn once, ahead, in Aurora's colours: renderer/scenes, scripts/game-pics.js; here they're turned
  // round the colour wheel to the palette that's on: --slHue, the turn from Aurora's hue to its. Instant, where drawing each
  // scene live took a while, and close: a palette is mostly a hue)
  const paletteHue = (cols) => {       // the palette's hue, its colours' (bar the darkest) averaged round the wheel, the more saturated counting more
    let x = 0, y = 0; for (const c of cols.slice(1)) { const [h, s] = rgbToHsl(c); x += Math.cos(h * 2 * Math.PI) * s; y += Math.sin(h * 2 * Math.PI) * s; }
    return Math.atan2(y, x) / (2 * Math.PI) * 360;
  };
  const AURORA_HUE = paletteHue(rgb('aurora'));
  let slHue = null;
  const slT = window.driftSlots(slEl, (m) => api.cmd({ type: 'slots', ...m }), {
    names: SCENE_NAMES, preview: (id) => { scenePreview = id && SCENE_NAMES[id] ? id : ''; }, warm: (id) => { if (R && SCENE_NAMES[id]) R.warm(id); },
    thumb: (id) => (SCENE_NAMES[id] ? `url(scenes/${id}.jpg)` : ''),
    go: (id) => P(S.mode === 'mix' ? { perDisplay: { [me.key]: id } } : { scene: id }) });
  let slOn = false;
  const slHere = () => shown === 'slots' && sceneFor(S) === 'slots' && (S.mode !== 'span' || isCenter) && !webUp && !mbOn && !bcHere();
  function slSync() {
    const on = slHere();
    if (on !== slOn) { slOn = on; slEl.classList.toggle('on', on); if (!on) slT.view(null); syncMediaBack(); }
    if (on) { const h = Math.round(((paletteHue(currentColors()) - AURORA_HUE) % 360 + 540) % 360 - 180); if (h !== slHue) { slHue = h; slEl.style.setProperty('--slHue', h + 'deg'); } }
    if (on) slT.view({ tokens: S.tokens || 0, locked: (S.locked || []).filter((id) => SCENE_NAMES[id]), unlocked: S.unlocked || [], total: Object.keys(SCENE_NAMES).length });
  }
  setInterval(slSync, 250);

  // ---------- the browser's bar: tabs, back and forward, home and the address. It floats at the top and keeps out of the way ----------
  const surf = (what, more) => api.cmd({ type: 'surf', do: what, ...more });
  let sbTimer = null, sbOver = false, sbKey = '';
  function surfHideSoon(ms = 900) {
    clearTimeout(sbTimer);
    sbTimer = setTimeout(() => { if (sbOver || document.activeElement === $('#sbUrl')) surfHideSoon(); else surfBar.classList.remove('show'); }, ms);
  }
  const surfPeek = () => { surfBar.classList.add('show'); surfHideSoon(3500); };       // a first look at where it is
  surfEdge.addEventListener('mouseenter', () => { surfBar.classList.add('show'); surfHideSoon(1500); });
  surfBar.addEventListener('mouseenter', () => { sbOver = true; surfBar.classList.add('show'); });
  surfBar.addEventListener('mouseleave', () => { sbOver = false; surfHideSoon(); });
  // A tab's icon: the site's own (web.js favicon, a small PNG), Drift's globe for the start page, or else the first letter of its
  // name on a colour picked from it (the same on every PC)
  const SB_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9s1.2-6.4 3.8-9z"/></svg>';
  const SB_AUDIO = '<svg class="sbAud" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-label="Playing sound"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/></svg>';
  function sbIcon(t) {
    if (t.home) return SB_GLOBE;
    if (t.icon && /^data:image\/png;base64,/.test(t.icon)) return `<img src="${t.icon}" alt="">`;
    const name = String(t.title || '?').trim() || '?';
    let h = 0; for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
    return `<b style="--h:${h}">${esc([...name][0])}</b>`;
  }
  const tabsHtml = (w) => (w.tabs || []).map((t) => `<button class="sbTab${t.id === w.active ? ' active' : ''}" data-id="${t.id}" title="${esc(t.title)}" role="tab" aria-selected="${t.id === w.active}">`
    + `<span class="sbFav${t.loading ? ' spin' : ''}">${sbIcon(t)}</span><span class="sbTitle">${esc(t.title)}</span>${t.audible ? SB_AUDIO : ''}`
    + `<i data-x="1" title="Close tab (Ctrl+W)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" pointer-events="none"><path d="M6 6l12 12M18 6L6 18"/></svg></i></button>`).join('');
  // the address as a browser shows it until it's clicked: no https:// or www., the site bright and the rest of it dimmed
  function sbPretty(url) {
    let u; try { u = new URL(url); } catch { return ''; }
    if (!/^https?:$/.test(u.protocol)) return '';
    const host = u.host.replace(/^www\./, ''), rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    return `${u.protocol === 'http:' ? '<span class="sbPath">http://</span>' : ''}<b>${esc(host)}</b><span class="sbPath">${esc(rest)}</span>`;       // (the Minimal style shows the site alone)
  }
  const SB_CHIP = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.4v.1"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  };
  let sbChipKey = '';
  function syncSurfBar() {
    const w = S.web || {}, k = JSON.stringify([w.tabs, w.active]);
    if (k !== sbKey) { sbKey = k; $('#sbTabs').innerHTML = tabsHtml(w) + '<button class="sbAdd" data-new="1" title="New tab (Ctrl+T)" aria-label="New tab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>'; }
    $('#sbBack').classList.toggle('off', !w.back); $('#sbFwd').classList.toggle('off', !w.fwd);
    const front = (w.tabs || []).find((t) => t.id === w.active) || {}, busy = !!front.loading && !w.out;
    const rb = $('#sbReload');       // reload, or stop while the page is loading
    rb.classList.toggle('stop', busy); rb.title = busy ? 'Stop loading this page' : 'Reload (Ctrl+R)'; rb.setAttribute('aria-label', busy ? 'Stop' : 'Reload');
    surfBar.classList.toggle('loading', busy);
    // what kind of page it is, at the start of the address bar: the start page (a search), a secure page, one that isn't, or one open in the PC's browser
    const raw = w.url || '', isHome = /^drift:\/\/home\//i.test(raw) || !raw;
    const chip = w.out ? ['ext', `In ${w.out}`, `Open in ${w.out}`] : isHome ? ['search', '', 'Search the web or type an address']
      : /^https:/i.test(raw) ? ['lock', '', 'Connection is secure'] : /^http:/i.test(raw) ? ['warn', 'Not secure', 'Your connection to this site is not secure'] : ['search', '', ''];
    const ck = chip.join('|');
    if (ck !== sbChipKey) { sbChipKey = ck; const c = $('#sbChip'); c.className = 'sbChip' + (chip[0] === 'warn' ? ' warn' : chip[0] === 'ext' ? ' ext' : ''); c.innerHTML = SB_CHIP[chip[0]] + (chip[1] ? `<span>${esc(chip[1])}</span>` : ''); c.title = chip[2]; }
    const ob = $('#sbOut');       // open the page in the PC's own browser: for the host, when there is one
    ob.hidden = !!w.stream || !w.ext;
    ob.title = w.out ? `Open in ${w.out}: close its window to come back to Surf` : `Open this page in ${w.ext || 'your browser'} (for sign-ins Surf can't do, like Google). Friends watch it but can't click in it`;
    ob.classList.toggle('off', !!w.out);
    const mb = $('#sbMirror');       // show the page on every other monitor too: this PC's own browser, with more than one monitor
    mb.hidden = !!w.stream || !((S.screens || 0) > 1);
    mb.classList.toggle('lit', !!S.surfMirror);
    mb.title = S.surfMirror ? 'Showing this page on your other monitors too. Click to stop' : 'Show this page on your other monitors too';
    const u = $('#sbUrl'), url = /^drift:\/\/home\//i.test(w.url || '') ? '' : w.url || '';       // Drift's start page: an empty box to type in
    if (document.activeElement !== u && u.value !== url) u.value = url;
    const view = $('#sbUrlView'), pretty = w.out ? '' : sbPretty(url);
    if (view.dataset.k !== pretty) { view.dataset.k = pretty; view.innerHTML = pretty; }
    $('#sbOmni').classList.toggle('pretty', !!pretty);
  }
  const tabClick = (e) => {
    const b = e.target.closest('[data-id]');
    if (e.target.closest('[data-new]')) { surf('new'); $('#sbUrl').value = ''; $('#sbUrl').focus(); }
    else if (b) surf(e.target.dataset.x ? 'close' : 'tab', { id: +b.dataset.id });
  };
  $('#sbTabs').addEventListener('click', tabClick);
  $('#sbTabs').addEventListener('auxclick', (e) => { const b = e.target.closest('[data-id]'); if (b && e.button === 1) surf('close', { id: +b.dataset.id }); });       // middle click closes
  $('#sbBack').addEventListener('click', () => surf('back'));
  $('#sbFwd').addEventListener('click', () => surf('fwd'));
  $('#sbReload').addEventListener('click', (e) => surf(e.currentTarget.classList.contains('stop') ? 'stop' : 'reload'));
  $('#sbTabs').addEventListener('dblclick', (e) => { if (e.target === e.currentTarget) { surf('new'); $('#sbUrl').value = ''; $('#sbUrl').focus(); } });       // the empty strip, as in a browser: a new tab
  $('#sbHome').addEventListener('click', () => surf('home'));
  $('#sbOut').addEventListener('click', () => { surf('outside'); surfHideSoon(300); });
  $('#sbMirror').addEventListener('click', () => api.patch({ surfMirror: !S.surfMirror }));
  // The hub chat's quick box (chat.js) over Surf: 💬 in the chat overlay's corner (pressed again, it closes), or Enter pressed in
  // the page while nothing in it was taking typing (web.js "Enter"; main.js sends 'chat-quick'). Once the box closes, the keys
  // go back to the page.
  function quickOverSurf() {
    if ($('#chatOverlay').classList.contains('typing') || !window.chatUI || !window.chatUI.quick()) return;
    $('#coInput').addEventListener('blur', () => setTimeout(() => { if (document.body.classList.contains('surfing') && document.activeElement !== $('#coInput')) toPage(); }, 120), { once: true });
  }
  $('#coBtn').addEventListener('mousedown', (e) => e.preventDefault());       // (so pressing it doesn't first take the box's focus away)
  $('#coBtn').addEventListener('click', () => {
    if ($('#chatOverlay').classList.contains('typing')) { $('#coInput').value = ''; if (window.chatUI) window.chatUI.closeQuick(); return; }
    quickOverSurf();
  });
  const keyMods = (e) => [e.shiftKey && 'shift', e.ctrlKey && 'control', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean);
  const toPage = () => { if (webEl) webEl.focus(); else if (vidEl) vidEl.focus(); else if (mirEl) mirEl.focus(); else if (gpuEl) gpuEl.focus(); };       // the keys go back to the page
  // Ctrl+L, Alt+D or F6 (see surf-keys.js): the bar comes down with the address picked, to type over
  function toBar() { if (webEl) webEl.blur(); surfBar.classList.add('show'); const u = $('#sbUrl'); u.focus(); u.select(); surfHideSoon(); }
  $('#sbUrl').addEventListener('focus', (e) => e.target.select());
  $('#sbUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.target.blur(); syncSurfBar(); toPage(); surfHideSoon(); return; }       // the address as it was, and back to the page
    const s = surfKey(e.key, keyMods(e));       // the browser's shortcuts work here too (Ctrl+T, Ctrl+W, Ctrl+Tab…)
    if (s && s.do !== 'url') { e.preventDefault(); surf(s.do, { n: s.n }); return; }
    if (e.key !== 'Enter') return;
    surf('go', { text: e.target.value.trim() }); e.target.blur();
    toPage();
    surfHideSoon();
  });

  // The page's picture and sound travel straight between the PCs over WebRTC. The messages that set that up go through
  // main, over the watch-together connection. Friends outside the home network are found with a public STUN server.
  const rtcConf = (stun) => ({ iceServers: stun ? [{ urls: 'stun:stun.l.google.com:19302' }] : [] });
  const stereo = (sdp) => sdp.replace(/useinbandfec=1/g, 'useinbandfec=1;stereo=1;maxaveragebitrate=192000');       // it is a soundtrack, not a phone call
  const signal = (d, to) => api.cmd({ type: 'rtc', to, d });
  const isLocal = (id) => String(id).startsWith('local:');       // another of this PC's monitors, mirroring the page

  // -- sharing: one connection per friend, all fed by a single capture of the page --
  const pcs = new Map(), asks = new Map();
  let cap = null;
  function capture() {
    if (!cap) {
      const el = pageEl();
      const got = navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const late = new Promise((_r, no) => setTimeout(() => no(new Error('no answer')), 2500));       // it has been known not to answer at all
      got.then((st) => { if (cap !== mine || pageEl() !== el) st.getTracks().forEach((t) => t.stop()); }, () => {});
      const mine = cap = Promise.race([got, late])
        .then((st) => (cap === mine && pageEl() === el ? st : null))
        .catch((e) => { console.log('the page could not be captured: ' + e.message); if (cap === mine) cap = null; return null; });
    }
    return cap;
  }
  // The order to offer video codecs in. Left alone, Chromium sends VP8, encoded on the processor, once for every friend. If
  // the graphics card can encode one of the H.264 kinds Chromium offers, that one goes first: on a PC with an NVIDIA card that
  // took a 1080p stream from about 0.7 of a processor core to about 0.45, at the same frame rate and size. Asked once; the
  // answer differs between H.264 kinds, so the one asked about is the one offered. null: no such kind, keep Chromium's order.
  let codecOrder = null;
  function videoCodecs() {
    if (!codecOrder) codecOrder = (async () => {
      const all = (RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video') || {}).codecs || [];
      const h264 = all.filter((c) => /^video\/h264$/i.test(c.mimeType) && /packetization-mode=1/.test(c.sdpFmtpLine || ''));
      for (const c of h264) {
        const r = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType: `${c.mimeType};${c.sdpFmtpLine}`, width: 1920, height: 1080, bitrate: 8e6, framerate: 30 } }).catch(() => null);
        if (r && r.supported && r.powerEfficient) return [c, ...all.filter((x) => x !== c)];
      }
      return null;
    })().catch(() => null);
    return codecOrder;
  }
  function uncapture() { const c = cap; cap = null; if (c) c.then((st) => { if (st) st.getTracks().forEach((t) => t.stop()); }); }
  function dropPeer(id) { asks.delete(id); const pc = pcs.get(id); if (pc) { pcs.delete(id); pc.close(); } if (!pcs.size && !asks.size) uncapture(); }
  function dropPeers() { for (const id of [...pcs.keys(), ...asks.keys()]) dropPeer(id); uncapture(); }
  async function rtcHost(id, d) {
    if (d.type === 'bye') { dropPeer(id); return; }
    if (d.type === 'want') {       // a friend asks for the page (or another monitor, to mirror it)
      if (isLocal(id) && !S.surfMirror) return;
      dropPeer(id);
      if (!pageEl() || d.sid !== (S.web || {}).sid) return;       // not this page: they will ask again when they hear of the new one
      const my = {}, el = pageEl(); asks.set(id, my);
      let st = null;
      for (let i = 0; i < 8 && !st; i++) {       // a page that has only just appeared can't be captured straight away
        if (i) await new Promise((r) => setTimeout(r, 400));
        if (asks.get(id) !== my) return;
        st = await capture();
        if (asks.get(id) !== my) return;
      }
      const codecs = await videoCodecs();
      if (asks.get(id) !== my) return;
      asks.delete(id);
      if (!st || pageEl() !== el) { if (!pcs.size && !asks.size) uncapture(); return; }
      const local = isLocal(id), stun = !local && !!(S.share || {}).internet, pc = new RTCPeerConnection(rtcConf(stun));
      pcs.set(id, pc); pc.early = [];
      for (const t of st.getTracks()) pc.addTrack(t, st);
      if (codecs) for (const tr of pc.getTransceivers()) if (tr.sender.track && tr.sender.track.kind === 'video') { try { tr.setCodecPreferences(codecs); } catch { /* Chromium's own order then */ } }
      pc.onicecandidate = (e) => { if (e.candidate) signal({ type: 'ice', c: e.candidate.toJSON() }, id); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && pcs.get(id) === pc) dropPeer(id); };       // they ask again
      const offer = await pc.createOffer();
      await pc.setLocalDescription({ type: 'offer', sdp: stereo(offer.sdp) });
      const out = pc.getSenders().find((x) => x.track && x.track.kind === 'video'), prm = out && out.getParameters();
      if (prm && prm.encodings && prm.encodings[0]) { prm.encodings[0].maxBitrate = local ? 25e6 : 8e6; out.setParameters(prm).catch(() => {}); }       // (between monitors of one PC there is room to spare)
      if (pcs.get(id) === pc) signal({ type: 'offer', sdp: pc.localDescription.sdp, sid: d.sid, stun }, id);
      return;
    }
    const pc = pcs.get(id);
    if (!pc) return;
    if (d.type === 'answer') { await pc.setRemoteDescription({ type: 'answer', sdp: String(d.sdp) }); for (const c of pc.early.splice(0)) pc.addIceCandidate(c).catch(() => {}); }
    else if (d.type === 'ice' && d.c) { if (pc.remoteDescription) await pc.addIceCandidate(d.c); else pc.early.push(d.c); }
  }

  // -- watching a hub's Surf stream (docs/plans/streams.md §4): the host's browser is a video here, and this PC's mouse, keyboard and
  // Surf bar go back over the connection's data channel. Set up from SDPs main.js passes on once chat.js has checked them; this
  // window's answer goes back to be signed. Relayed through the hub unless "Connect directly" is on. Once connected, the
  // certificate the host really used goes to chat.js to be checked against the one they signed. --
  let vidEl = null, gpc = null, gdc = null, gsid = '', gLive = false, gAsked = 0, gGood = 0, gCert = null;
  function hangUp() { if (gpc) { const pc = gpc; gpc = null; gdc = null; pc.close(); api.cmd({ type: 'ss', do: 'state', state: '' }); } if (vidEl) vidEl.srcObject = null; }
  function ask() { hangUp(); gAsked = Date.now(); api.cmd({ type: 'surf', do: 'want' }); }
  setInterval(() => {       // no picture for a while (the host's capture restarted, the route failed…): ask again
    if (!vidEl || !gLive) return;
    const now = Date.now();
    if (gpc && gpc.connectionState === 'connected') gGood = now; else if (now - Math.max(gAsked, gGood) > 6000) ask();
  }, 2000);
  async function ssCert(pc, tries = 0) {
    const st = await pc.getStats().catch(() => null);
    for (const x of st ? st.values() : []) {
      if (x.type !== 'transport' || !x.remoteCertificateId) continue;
      const c = st.get(x.remoteCertificateId);
      if (c) { api.cmd({ type: 'ss', do: 'cert', alg: c.fingerprintAlgorithm, fp: c.fingerprint }); return; }
    }
    // Over a relay, now and then the certificate the host used never shows in the stats. A connection that can't be checked isn't kept:
    // after 10 s it's dropped, and this screen asks again (a fresh connection, which has shown it every time).
    if (tries < 40) { if (gpc === pc) setTimeout(() => ssCert(pc, tries + 1), 250); return; }
    if (gpc === pc) { console.log('surf stream: the host\'s certificate never showed: asking again'); ask(); }
  }
  async function ssRtc(d) {
    if (d.type === 'bye') { hangUp(); return; }
    if (!vidEl) return;
    if (d.type === 'offer') {
      hangUp();
      if (!gCert) gCert = RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });       // fresh each time this window starts watching
      const cert = await gCert;
      const pc = gpc = new RTCPeerConnection({ iceServers: Array.isArray(d.iceServers) ? d.iceServers : [], iceTransportPolicy: d.policy === 'all' ? 'all' : 'relay', certificates: [cert] });
      pc.ontrack = (e) => {
        if (gpc !== pc || !vidEl) return;
        try { e.receiver.jitterBufferTarget = 0; } catch { /* older Chromium */ }       // as little delay as the network allows: clicks should feel close
        if (vidEl.srcObject !== e.streams[0]) vidEl.srcObject = e.streams[0];
      };
      pc.ondatachannel = (e) => {
        if (gpc !== pc) return;
        const dc = gdc = e.channel;
        dc.onopen = () => { if (gdc === dc) dc.send(JSON.stringify({ t: 'hello' })); };
        dc.onmessage = (ev) => { if (gdc !== dc || typeof ev.data !== 'string' || ev.data.length > 65536) return; let m = null; try { m = JSON.parse(ev.data); } catch { return; } api.cmd({ type: 'ss', do: 'dc', m }); };
      };
      pc.onicecandidate = (e) => { if (e.candidate && gpc === pc) api.cmd({ type: 'ss', do: 'signal', d: { c: e.candidate.toJSON() } }); };
      pc.onconnectionstatechange = () => { if (gpc !== pc) return; api.cmd({ type: 'ss', do: 'state', state: pc.connectionState }); if (pc.connectionState === 'connected') ssCert(pc); };
      pc.setRemoteDescription({ type: 'offer', sdp: String(d.sdp) }).catch(() => {});       // candidates that follow wait their turn behind this
      const ans = await pc.createAnswer();
      await pc.setLocalDescription({ type: 'answer', sdp: stereo(ans.sdp) });
      if (gpc === pc) api.cmd({ type: 'ss', do: 'signal', d: { sdp: { type: 'answer', sdp: pc.localDescription.sdp } } });
    } else if (d.type === 'ice' && d.c && gpc) await gpc.addIceCandidate(d.c).catch(() => {});
  }
  // To the host, over the data channel: this PC's mouse and keys over the picture, the Surf bar, where the pointer is (main.js sends them here)
  const ssSend = (m) => { if (gdc && gdc.readyState === 'open') { try { gdc.send(JSON.stringify(m)); } catch { /* closing */ } } };
  window.ssTest = async () => {       // (for main.js's checks)
    const r = { video: vidEl ? vidEl.videoWidth + 'x' + vidEl.videoHeight : '', state: gpc ? gpc.connectionState : '', dc: gdc ? gdc.readyState : '', framesIn: 0, audioIn: 0 };
    const st = gpc ? await gpc.getStats() : new Map();
    for (const x of st.values()) {
      if (x.type === 'inbound-rtp' && x.kind === 'video') { r.framesIn = x.framesDecoded; r.bytesIn = x.bytesReceived; }
      if (x.type === 'inbound-rtp' && x.kind === 'audio') r.audioIn = x.bytesReceived;
      if (x.type === 'transport') { const pair = st.get(x.selectedCandidatePairId); if (pair) { const l = st.get(pair.localCandidateId), rc = st.get(pair.remoteCandidateId); r.path = `${l && l.candidateType} -> ${rc && rc.candidateType}`; } }
    }
    return r;
  };
  // -- the Broadcast scene (docs/plans/broadcast.md §5, §6; changed 2026-11-23). Picking the Share tab turns this screen
  // into a black grid with a tile for each broadcast in the hub: a still (a picture the broadcaster sends every 10 s, signed
  // by them) until it's watched. Watch fills the screen with it, with a slim bar along the top (Back, volume,
  // Stop watching); Back (or Esc) goes to the grid, where it plays on in its tile without reconnecting. With more than one
  // up, "Preview" plays one in its tile, so several can be watched side by side. Each one watched has its own connection,
  // set up from SDPs main.js passes on once chat.js has checked them; this window's answer goes back to be signed. Relayed
  // through the hub unless "Connect directly" is on. Once connected, the certificate the broadcaster really used goes to
  // chat.js to be checked against the one they signed. Your cursor only ever goes to a broadcaster from the full-screen view,
  // while the hub bar's cursor toggle is on, and is only a picture there: nothing you do here clicks or types on their PC. --
  const bcEl = $('#bcView'), bcGridEl = $('#bcGrid'), bcTopEl = $('#bcTop'), bcEmptyEl = $('#bcEmpty'), bcBarEl = $('#bcBar'), bcPtrBox = $('#bcPtrs');
  const bcTiles = new Map();       // broadcast id -> { id, el, img, vid, ph, note, foot, still (the stamp of the still shown), key (what its foot was drawn from) }
  const bcRx = new Map();       // broadcast id -> { pc, dc, early, gen, asked, good, vrx, stream }: the connection to each one watched here
  let bcOn = false, bcCertP = null, bcFull = '', bcList = [], bcHub = '', bcHost = false;
  const bcInfo = (id) => bcList.find((t) => t.bc === id) || null;
  const bcName = (t) => `${t.who} · ${t.title || (t.kind === 'window' ? 'A window' : 'A screen')}`;
  // The certificate the other end really used. Over a relay, Chromium's stats now and then never list it, so the DTLS
  // transport is asked directly too (its DER certificate, hashed as the SDP's fingerprint is: SHA-256).
  async function remotePrint(pc) {
    const st = await pc.getStats().catch(() => null);
    for (const x of st ? st.values() : []) {
      if (x.type !== 'transport' || !x.remoteCertificateId) continue;
      const c = st.get(x.remoteCertificateId);
      if (c) return { alg: c.fingerprintAlgorithm, fp: c.fingerprint };
    }
    const t = ((pc.getReceivers()[0] || pc.getSenders()[0] || {}).transport) || (pc.sctp && pc.sctp.transport);
    const der = t && t.state === 'connected' && t.getRemoteCertificates ? t.getRemoteCertificates() : [];
    if (!der.length) return null;
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', der[0]));
    return { alg: 'sha-256', fp: [...h].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':') };
  }
  const bcCmd = (bc, d, more) => api.cmd({ type: 'bc', do: d, bc, ...more });
  const bcAct = (op, ...a) => api.chat(op, ...a).then((r) => { if (r && r.error) toast(r.error, 3200); return r || {}; }, (e) => { toast(String(e && e.message || e), 3200); return {}; });
  const bcWatch = (id, full) => bcAct('bcWatch', bcHub, id, me.key, !!full);
  const bcBack = () => bcAct('bcFull', '');
  // ---- one connection for each broadcast watched ----
  function bcRxFor(id) {
    let r = bcRx.get(id);
    if (!r) { r = { pc: null, dc: null, early: [], gen: 0, asked: Date.now(), good: 0, vrx: null, stream: null }; bcRx.set(id, r); }
    return r;
  }
  function bcDrop(id, r) {       // its connection closes (a new offer is on its way, or it's asked for again)
    r.vrx = null; r.stream = null;
    if (r.pc) { const pc = r.pc; r.pc = null; r.dc = null; pc.close(); bcCmd(id, 'state', { state: '' }); }
    const t = bcTiles.get(id); if (t) t.vid.srcObject = null;
    if (id === bcFull) bcDrawPtrs([]);
  }
  function bcHang(id) { const r = bcRx.get(id); if (!r) return; r.gen++; bcDrop(id, r); bcRx.delete(id); }
  function bcAsk(id, r) { console.log(`broadcast: no picture (${r.pc ? r.pc.connectionState : "no connection"}): asking again`); bcDrop(id, r); r.asked = Date.now(); bcCmd(id, 'want'); }
  setInterval(() => {       // no picture for a while (the monitors changed, the route failed…): ask again
    const now = Date.now();
    for (const [id, r] of bcRx) { if (r.pc && r.pc.connectionState === 'connected') r.good = now; else if (now - Math.max(r.asked, r.good) > 6000) bcAsk(id, r); }
  }, 2000);
  async function bcCheckCert(id, r, pc, tries = 0) {
    const c = await remotePrint(pc);
    if (r.pc !== pc) return;
    if (c) { bcCmd(id, 'cert', c); return; }
    if (tries < 40) { setTimeout(() => bcCheckCert(id, r, pc, tries + 1), 250); return; }
    bcAsk(id, r);       // a connection that can't be checked isn't kept
  }
  async function bcRtc(id, d) {
    if (d.type === 'bye') { bcHang(id); return; }
    const t = bcInfo(id), r = bcOn && t && t.live ? bcRxFor(id) : null;
    if (!r) return;       // only for one this screen is watching
    if (d.type === 'offer') {
      bcDrop(id, r);
      const gen = ++r.gen;
      r.early = [];       // its candidates come right behind it: held until the connection is ready for them
      if (!bcCertP) bcCertP = RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });       // fresh each time this screen's scene opens
      const cert = await bcCertP;
      if (gen !== r.gen || bcRx.get(id) !== r) return;       // a newer offer came while waiting, or it stopped
      const pc = r.pc = new RTCPeerConnection({ iceServers: Array.isArray(d.iceServers) ? d.iceServers : [], iceTransportPolicy: d.policy === 'all' ? 'all' : 'relay', certificates: [cert], bundlePolicy: 'max-bundle' });
      pc.ontrack = (e) => {
        if (r.pc !== pc) return;
        if (e.track.kind === 'video') { r.vrx = e.receiver; bcSoundSync(); }
        r.stream = e.streams[0];
        const tl = bcTiles.get(id); if (tl && tl.vid.srcObject !== r.stream) tl.vid.srcObject = r.stream;
      };
      pc.ondatachannel = (e) => {
        if (r.pc !== pc) return;
        const dc = r.dc = e.channel;
        dc.onmessage = (ev) => { if (r.dc !== dc || typeof ev.data !== 'string' || ev.data.length > 8192) return; let m = null; try { m = JSON.parse(ev.data); } catch { return; } bcCmd(id, 'dc', { m }); };
      };
      pc.onicecandidate = (e) => { if (e.candidate && r.pc === pc) bcCmd(id, 'signal', { d: { c: e.candidate.toJSON() } }); };
      pc.onconnectionstatechange = () => { if (r.pc !== pc) return; bcCmd(id, 'state', { state: pc.connectionState }); if (pc.connectionState === 'connected') bcCheckCert(id, r, pc); };
      await pc.setRemoteDescription({ type: 'offer', sdp: String(d.sdp) });
      for (const c of r.early.splice(0)) pc.addIceCandidate(c).catch(() => {});
      const ans = await pc.createAnswer();
      await pc.setLocalDescription({ type: 'answer', sdp: bcStereo(ans.sdp) });       // (the answer is signed as set, by chat.js)
      if (r.pc === pc) bcCmd(id, 'signal', { d: { sdp: { type: 'answer', sdp: pc.localDescription.sdp } } });
    } else if (d.type === 'ice' && d.c) {
      if (r.pc && r.pc.remoteDescription) await r.pc.addIceCandidate(d.c).catch(() => {}); else r.early.push(d.c);
    }
  }
  // A broadcast's sound is music and games, not a voice: ask for stereo Opus at a music bitrate (the receiver's fmtp is
  // what tells the sender it may send stereo).
  function bcStereo(sdp) {
    const pt = (/^a=rtpmap:(\d+) opus\/48000/mi.exec(sdp) || [])[1];
    if (!pt) return sdp;
    return sdp.replace(new RegExp(`^(a=fmtp:${pt} )([^\r\n]*)`, 'm'), (_m, a, b) => a + b.split(';').filter((x) => !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(x)).concat(['stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000']).join(';'));
  }
  // Each one's sound plays from its own tile, at the volume set for that person's broadcasts (apart from their voice) and
  // Drift's master volume. While one fills the screen, only it is heard; in the grid, every one playing is.
  // The sound comes through the broadcaster's helper and arrives about 70–90 ms after the picture (spike A: av-sync.js),
  // so while there's sound the picture is held back 100 ms to match. Without sound it isn't, so nothing is later than it must be.
  const BC_AV_MS = 100;
  function bcSoundSync() {
    for (const [id, tl] of bcTiles) {
      const t = bcInfo(id), on = !!(bcOn && t && t.live && t.audio && (!bcFull || bcFull === id));
      tl.vid.muted = !on;
      if (on) tl.vid.volume = Math.max(0, Math.min(1, +t.vol || 0));
      const r = bcRx.get(id), rx = r && r.vrx;
      if (rx && 'jitterBufferTarget' in rx) { const want = t && t.audio ? BC_AV_MS : null; if (rx.jitterBufferTarget !== want) { try { rx.jitterBufferTarget = want; } catch { /* closing */ } } }
    }
  }
  // ---- the full-screen view: pointers and the bar (your cursor goes while the hub bar's cursor toggle is on) ----
  const bcSend = (m) => { const r = bcRx.get(bcFull); if (r && r.dc && r.dc.readyState === 'open') { try { r.dc.send(JSON.stringify(m)); } catch { /* closing */ } } };
  // where the picture is on the screen (it's letterboxed), and the mouse as fractions of the video frame
  function bcBox() {
    const tl = bcTiles.get(bcFull), v = tl && tl.vid, vw = v ? v.videoWidth : 0, vh = v ? v.videoHeight : 0;
    if (!vw || !vh) return null;
    const r = v.getBoundingClientRect(), k = Math.min(r.width / vw, r.height / vh), w = vw * k, h = vh * k;
    return { l: r.left + (r.width - w) / 2, t: r.top + (r.height - h) / 2, w, h };
  }
  const bcAt = (e) => { const b = bcBox(); if (!b) return null; const x = (e.clientX - b.l) / b.w, y = (e.clientY - b.t) / b.h; return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null; };
  let bcPtrAt = 0, bcPtrSent = false, bcPingAt = 0;
  const bcSharing = () => !!(bcFull && (bcInfo(bcFull) || {}).share);
  // The "What's playing" colours: while the broadcast grid is on this screen, a small picture of the one watched full screen (or
  // the first one with a picture) every few seconds, to main.js (content-pic-in), which hands it to every window
  const bcPicCan = document.createElement('canvas'); bcPicCan.width = bcPicCan.height = 32;
  setInterval(() => {
    if (S.palette !== 'content' || !bcHere()) return;
    const ok = (t) => t && ((t.vid && t.vid.videoWidth) || (t.img && t.img.complete && t.img.naturalWidth));
    const tl = ok(bcTiles.get(bcFull)) ? bcTiles.get(bcFull) : [...bcTiles.values()].find(ok);
    if (!tl) return;
    try {
      bcPicCan.getContext('2d').drawImage(tl.vid && tl.vid.videoWidth ? tl.vid : tl.img, 0, 0, 32, 32);
      api.cmd({ type: 'content-pic-in', url: bcPicCan.toDataURL('image/jpeg', 0.85) });
    } catch { /* a picture that can't be read back */ }
  }, 4000);
  function bcPoint(e) {
    if (!bcSharing()) { if (selfCtx === 'bc') selfOff(); return; }
    const q = e && bcAt(e);
    if (!q) { if (selfCtx === 'bc') selfOff(); if (bcPtrSent) { bcSend({ t: 'ptr', gone: true }); bcPtrSent = false; } return; }
    if (e.target) showSelf('bc', e.clientX, e.clientY);       // (not for the tests' made-up moves)
    if (Date.now() - bcPtrAt < 33) return;       // at most 30 a second
    bcPtrAt = Date.now(); bcPtrSent = true;
    bcSend({ t: 'ptr', x: +q.x.toFixed(4), y: +q.y.toFixed(4) });
  }
  function bcPingAtMouse(e) {       // a "look here" ripple where you click, at most one a second (only while sharing your cursor)
    if (!bcSharing() || e.button !== 0) return;
    const q = bcAt(e); if (!q || Date.now() - bcPingAt < 1000) return;
    bcPingAt = Date.now();
    bcSend({ t: 'ping', x: +q.x.toFixed(4), y: +q.y.toFixed(4) });
    bcRipple({ x: q.x, y: q.y, name: myPtrName() });
  }
  let bcBarTimer = null;
  const bcBarShow = () => { bcBarEl.classList.add('show'); clearTimeout(bcBarTimer); bcBarTimer = setTimeout(() => { if (!bcBarEl.matches(':hover')) bcBarEl.classList.remove('show'); }, 2600); };
  bcBarEl.addEventListener('mouseleave', () => bcBarShow());
  const myPtrName = () => String((S.share || {}).name || (S.p2p || {}).defaultName || '').replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 24) || 'You';
  // everyone else's pointers over the full-screen picture (the broadcaster passes on those who share theirs; main.js names them)
  const bcPtrEls = new Map();
  function bcDrawPtrs(list) {
    const box = bcBox(), now = Date.now();
    if (!box) list = [];
    for (const [id, q] of bcPtrEls) if (!list.some((x) => x.id === id)) { q.el.remove(); bcPtrEls.delete(id); }
    for (const x of list) {
      let q = bcPtrEls.get(x.id);
      if (!q) { const el = document.createElement('div'); el.className = 'ptr'; ptrShape(el); bcPtrBox.appendChild(el); bcPtrEls.set(x.id, q = { el, x: -1, y: -1, at: now }); }
      q.el.style.setProperty('--c', ptrColor(x.name)); q.el.lastChild.textContent = x.name;
      if (q.x !== x.x || q.y !== x.y) { q.x = x.x; q.y = x.y; q.at = now; }
      q.el.style.left = (box.l + x.x * box.w).toFixed(1) + 'px'; q.el.style.top = (box.t + x.y * box.h).toFixed(1) + 'px';
      q.el.classList.toggle('idle', now - q.at > 6000);
    }
  }
  setInterval(() => { for (const q of bcPtrEls.values()) q.el.classList.toggle('idle', Date.now() - q.at > 6000); }, 1000);
  function bcRipple(p) {
    const box = bcBox(); if (!box) return;
    const r = document.createElement('div'); r.className = 'bcPing';
    r.style.setProperty('--c', ptrColor(p.name));
    r.style.left = (box.l + p.x * box.w).toFixed(1) + 'px'; r.style.top = (box.t + p.y * box.h).toFixed(1) + 'px';
    bcPtrBox.appendChild(r); setTimeout(() => r.remove(), 1200);
  }
  const bcBtn = (cls, text, title, fn, icon) => {
    const el = document.createElement('button'); el.className = cls; el.textContent = text; if (title) el.title = title;
    if (icon) { el.classList.add('ico'); el.insertAdjacentHTML('afterbegin', icon); }       // (an icon's svg has no text: the label is still the button's textContent)
    el.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return el;
  };
  const BC_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const BC_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.7 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.2 3.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/></svg>';
  const bcLock = (t) => { const l = document.createElement('span'); l.className = 'lock' + (t.verdict === 'verified' ? ' ok' : ''); l.textContent = t.verdict === 'verified' ? '🔒' : ''; l.title = t.verdict === 'verified' ? `End-to-end encrypted, and checked that it's really from ${t.who}` : ''; return l; };
  let bcBarKey = '';
  function bcBarDraw() {
    const t = bcInfo(bcFull);
    if (!t) { bcBarKey = ''; bcBarEl.replaceChildren(); return; }
    const slider = bcBarEl.querySelector('.bcVol input');
    if (slider && document.activeElement !== slider) slider.value = Math.round((+t.level || 0) * 100);
    const k = JSON.stringify([t.bc, t.who, t.title, t.verdict, t.audio]);
    if (k === bcBarKey) return;
    bcBarKey = k;
    const back = bcBtn('bcBtn bcBack', '← Back', 'Back to every broadcast (Esc). It goes on playing in its tile', bcBack);
    const where = document.createElement('span'); where.className = 'bcWho';
    const dot = document.createElement('span'); dot.className = 'spdot';
    where.append(dot, bcLock(t), bcName(t));
    where.title = 'The name of what they show is what they called it: the hub passes it on and can\'t vouch for it';
    const vol = t.audio ? document.createElement('label') : null;
    if (vol) {
      vol.className = 'bcVol'; vol.title = `The sound of ${t.who}'s broadcast (their voice has its own volume, in the Hub tab)`;
      const r = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 100, step: 1, value: Math.round((+t.level || 0) * 100) });
      r.setAttribute('aria-label', `Volume of ${t.who}'s broadcast`);
      r.addEventListener('input', () => api.patch({ voice: { volumes: { ['bc:' + t.from]: +r.value / 100 } } }));
      vol.append('🔊', r);
    }
    bcBarEl.replaceChildren(...[back, where, vol, bcBtn('bcBtn stop', 'Stop watching', `Stop watching ${t.who}'s broadcast`, () => bcAct('bcUnwatch', t.bc))].filter(Boolean));
  }
  addEventListener('keydown', (e) => { if (bcOn && bcFull && e.key === 'Escape' && !panel.classList.contains('open')) { e.preventDefault(); e.stopImmediatePropagation(); bcBack(); } }, true);
  // ---- the grid ----
  // Every tile the same size (16:9) and as large as it can be on this screen: each way of splitting them into rows and
  // columns is tried and the biggest wins. Names and buttons sit over the bottom of each tile, so no room goes on labels.
  // The top edge is left for the hub bar and Go live; one watched full screen covers everything.
  const BC_GAP = 10, BC_EDGE = 16, BC_TOP = 60;
  function bcLayout() {
    const n = bcList.length, W = innerWidth - 2 * BC_EDGE, H = innerHeight - BC_TOP - BC_EDGE;
    if (!n || W <= 0 || H <= 0) return;
    let best = { w: 0, cols: 1, rows: 1 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols), w = Math.min((W - (cols - 1) * BC_GAP) / cols, ((H - (rows - 1) * BC_GAP) / rows) * (16 / 9));
      if (w > best.w + 0.5) best = { w, cols, rows };
    }
    const w = Math.floor(best.w), h = Math.floor((w * 9) / 16), top = BC_TOP + Math.max(0, (H - (best.rows * h + (best.rows - 1) * BC_GAP)) / 2);
    bcList.forEach((t, i) => {
      const tl = bcTiles.get(t.bc); if (!tl) return;
      const row = Math.floor(i / best.cols), inRow = Math.min(best.cols, n - row * best.cols), col = i % best.cols;
      const left = BC_EDGE + (W - (inRow * w + (inRow - 1) * BC_GAP)) / 2 + col * (w + BC_GAP);
      Object.assign(tl.el.style, { left: Math.round(left) + 'px', top: Math.round(top + row * (h + BC_GAP)) + 'px', width: w + 'px', height: h + 'px' });
    });
  }
  addEventListener('resize', () => { if (bcOn) { bcLayout(); if (bcFull) bcDrawPtrs([]); } });
  // Preview: your own broadcast, live and silent, in your tile. This PC captures what you picked a second time (main.js
  // bcPreview lets this window have exactly that source, picture only); nothing goes through the hub. A Switch source
  // starts it again on the new one. (Previewing the monitor this grid is on shows the grid inside itself, as any screen share does.)
  let bcPrev = null, bcPrevGen = 0;       // { id, src, stream (null while it starts) }
  function bcPreviewOff() {
    bcPrevGen++;
    if (!bcPrev) return;
    if (bcPrev.stream) bcPrev.stream.getTracks().forEach((t) => t.stop());
    const tl = bcTiles.get(bcPrev.id); if (tl) tl.vid.srcObject = null;
    bcPrev = null;
  }
  async function bcPreviewOn(id) {
    bcPreviewOff();
    const g = bcPrevGen; bcPrev = { id, src: '', stream: null };
    const r = await api.chat('bcPreview', me.key).catch(() => null);
    let st = null;
    if (r && r.ok && g === bcPrevGen) { try { st = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false }); } catch { st = null; } }
    if (g !== bcPrevGen) { if (st) st.getTracks().forEach((t) => t.stop()); return; }       // turned off (or started again) meanwhile
    if (!st || !st.getVideoTracks().length) { bcPrev = null; toast('Drift couldn\'t show a preview of your broadcast.'); syncBcView(); return; }
    st.getVideoTracks()[0].addEventListener('ended', () => { if (bcPrev && bcPrev.stream === st) { bcPreviewOff(); syncBcView(); } });
    bcPrev = { id, src: r.src, stream: st };
    syncBcView();
  }
  function bcPreviewSync() {       // (after the tiles are drawn) your broadcast ended: off; you switched source: again, on the new one
    if (!bcPrev) return;
    const t = bcInfo(bcPrev.id);
    if (!t || !t.mine) { bcPreviewOff(); return; }
    if (bcPrev.stream && t.src && t.src !== bcPrev.src) bcPreviewOn(t.bc);
  }
  function bcTileMake(id) {
    const el = document.createElement('div'); el.className = 'bcTile'; el.dataset.bc = id;
    const ph = document.createElement('div'); ph.className = 'bcPh';
    const img = Object.assign(document.createElement('img'), { className: 'bcStill', alt: '', draggable: false });
    const vid = Object.assign(document.createElement('video'), { className: 'bcVid', autoplay: true, playsInline: true, muted: true });
    const note = document.createElement('div'); note.className = 'bcTNote';
    const foot = document.createElement('div'); foot.className = 'bcTFoot';
    el.append(ph, img, vid, note, foot);
    img.addEventListener('load', () => el.classList.add('hasStill'));
    vid.addEventListener('mousemove', (e) => { if (bcFull === id) { bcBarShow(); bcPoint(e); } });
    vid.addEventListener('mouseleave', () => { if (bcFull === id) bcPoint(null); });
    vid.addEventListener('mousedown', (e) => { if (bcFull === id) bcPingAtMouse(e); });
    el.addEventListener('click', (e) => {       // the picture itself: Watch (in the grid)
      if (bcFull || e.target.closest('button, input, label')) return;
      const t = bcInfo(id);
      if (t && !t.mine && !(t.crowded && !t.live)) bcWatch(id, true);
    });
    const tl = { id, el, ph, img, vid, note, foot, still: 0, key: '' };
    const r = bcRx.get(id); if (r && r.stream) vid.srcObject = r.stream;
    return tl;
  }
  function bcTileSync(tl, t, many) {
    const prev = t.mine && bcPrev && bcPrev.id === t.bc ? bcPrev : null;
    tl.el.classList.toggle('live', t.live || !!(prev && prev.stream));
    tl.el.classList.toggle('mine', t.mine);
    if (prev && prev.stream && tl.vid.srcObject !== prev.stream) tl.vid.srcObject = prev.stream;
    if (t.still !== tl.still) {       // a newer still: fetch it (the state only says when it changed)
      tl.still = t.still;
      if (t.still) api.chat('bcStill', t.bc).then((u) => { if (u && tl.still === t.still) tl.img.src = u; }, () => {});
    }
    tl.ph.textContent = t.mine ? 'Your picture shows here in a moment' : `Waiting for a picture from ${t.who}…`;
    tl.note.textContent = t.bad ? `Couldn't check that this broadcast is really from ${t.who}. The hub may be interfering.`
      : t.mine ? (t.paused ? 'Paused' : '')
      : !t.live ? ''
      : t.paused ? `${t.who} paused the broadcast` : t.stalled ? `${t.who}'s picture stopped (the window may be minimised)` : t.state !== 'connected' ? `Connecting to ${t.who}…` : '';
    tl.note.classList.toggle('on', !!tl.note.textContent);
    tl.note.classList.toggle('warn', !!t.bad);
    const k = JSON.stringify([t.who, t.title, t.kind, t.audio, t.viewers, t.crowded, t.live, t.verdict, t.mine, many, bcHost, !!prev]);
    if (k === tl.key) return;
    tl.key = k;
    const who = document.createElement('span'); who.className = 'bcTWho';
    if (t.live || t.mine) { const d = document.createElement('span'); d.className = 'spdot'; who.append(d); }
    const name = document.createElement('b'); name.textContent = bcName(t); name.title = 'What they called it. The hub passes the name on and can\'t vouch for it.';
    const meta = document.createElement('em');
    meta.textContent = [t.mine ? 'You\'re live' : '', t.audio ? 'with sound' : 'no sound', t.viewers ? `${t.viewers} watching` : 'nobody watching yet'].filter(Boolean).join(' · ');
    who.append(bcLock(t), name, meta);
    const btns = document.createElement('span'); btns.className = 'bcTBtns';
    if (t.mine) btns.append(prev ? bcBtn('bcBtn', 'Stop preview', 'Back to a still of your broadcast', () => { bcPreviewOff(); syncBcView(); }, BC_EYE_OFF)
      : bcBtn('bcBtn', 'Preview', 'Watch what you\'re sending, live and without sound, here in your tile (only you see it)', () => bcPreviewOn(t.bc), BC_EYE));
    if (t.mine) btns.append(bcBtn('bcBtn', 'Manage', 'What you\'re sending, who\'s watching, Switch source, Pause and Stop', bcPage));
    else if (t.crowded) btns.append(Object.assign(bcBtn('bcBtn', 'Full', 'Seven people are already watching', () => {}), { disabled: true }));
    else {
      btns.append(bcBtn('bcBtn primary', 'Watch', `Fill the screen with ${t.who}'s broadcast`, () => (t.live ? bcAct('bcFull', t.bc) : bcWatch(t.bc, true))));
      if (many) btns.append(t.live ? bcBtn('bcBtn', 'Stop preview', `Stop watching ${t.who}'s broadcast: its tile goes back to a still`, () => bcAct('bcUnwatch', t.bc), BC_EYE_OFF)
        : bcBtn('bcBtn', 'Preview', `Play ${t.who}'s broadcast here in its tile, next to the others`, () => bcWatch(t.bc, false), BC_EYE));
    }
    if (bcHost && !t.mine) btns.append(bcBtn('bcBtn ghost', 'Stop it', 'As the host, you can stop anyone\'s broadcast', async () => { if (await question({ title: `Stop ${t.who}'s broadcast?`, note: 'It stops for everyone watching it.', yes: 'Stop it' })) bcAct('bcHostStop', bcHub, t.bc); }));
    tl.foot.replaceChildren(who, btns);
  }
  // The Share tab's own page (Go live, and while you're live, how it's going) opens in the panel over the grid
  function bcPage() { tab = 'broadcast'; tellTab(); showPanel(true); clearTimeout(hideTimer); syncUI(); }
  bcTopEl.append(bcBtn('bcBtn bcGo', 'Go live', 'Show a screen or an application to everyone here', bcPage));
  bcEmptyEl.append(Object.assign(document.createElement('p'), { textContent: 'Nobody is broadcasting right now.' }), bcBtn('bcBtn primary', 'Go live', 'Show a screen or an application to everyone here', bcPage));
  function bcSetFull(id) {
    if (id === bcFull) return;
    if (bcPtrSent) { bcSend({ t: 'ptr', gone: true }); bcPtrSent = false; }
    bcFull = id;
    bcEl.classList.toggle('full', !!id);
    document.body.classList.toggle('bcfull', !!id);
    for (const [k, tl] of bcTiles) tl.el.classList.toggle('full', k === id);
    bcDrawPtrs([]); bcBarKey = ''; if (selfCtx === 'bc') selfOff();
    if (id) bcBarShow();
  }
  // The scene comes and goes with main.js's word (S.bcView), on the monitor it names.
  function syncBcView() {
    const v = S.bcView, here = !!(v && v.key === me.key);
    if (here !== bcOn) {
      bcOn = here;
      document.body.classList.toggle('bc', here);
      if (!here) { bcPreviewOff(); for (const id of [...bcRx.keys()]) bcHang(id); for (const tl of bcTiles.values()) tl.el.remove(); bcTiles.clear(); bcList = []; bcSetFull(''); bcCertP = null; bcBarDraw(); }
    }
    if (!here) { bcSoundSync(); return; }
    bcHub = v.hub; bcHost = !!v.host;
    bcList = [...v.tiles].sort((a, b) => a.mine - b.mine);       // yours last
    for (const [id, tl] of bcTiles) if (!bcInfo(id)) { bcHang(id); tl.el.remove(); bcTiles.delete(id); }       // ended
    for (const id of [...bcRx.keys()]) { const t = bcInfo(id); if (!t || !t.live) bcHang(id); }       // no longer watched
    const many = bcList.length > 1;
    for (const t of bcList) {
      let tl = bcTiles.get(t.bc);
      if (!tl) { tl = bcTileMake(t.bc); bcTiles.set(t.bc, tl); bcGridEl.appendChild(tl.el); }
      bcTileSync(tl, t, many);
      if (t.live) bcRxFor(t.bc);       // (its offer is on its way)
    }
    bcPreviewSync();
    const f = bcInfo(v.full);
    bcSetFull(f && f.live ? v.full : '');
    if (bcPtrSent && !bcSharing()) { bcSend({ t: 'ptr', gone: true }); bcPtrSent = false; }       // sharing turned off
    if (selfCtx === 'bc' && !bcSharing()) selfOff();       // (and the real pointer is back)
    bcEmptyEl.classList.toggle('on', !bcList.length);
    bcTopEl.classList.toggle('live', bcList.some((t) => t.mine));
    bcLayout();
    bcSoundSync();
    bcBarDraw();
  }
  window.bcTest = async (want) => {       // (for main.js's checks) one watched here: `want`, else the one full screen, else the first playing
    const id = want || bcFull || (bcList.find((t) => t.live) || {}).bc || '', r = bcRx.get(id) || {}, pc = r.pc || null, tl = bcTiles.get(id), vid = tl ? tl.vid : null;
    const out = { on: bcOn && !!bcRx.get(id), id, full: bcFull, video: vid ? vid.videoWidth + 'x' + vid.videoHeight : '0x0', state: pc ? pc.connectionState : '', dc: r.dc ? r.dc.readyState : '', framesIn: 0, ptrs: [...bcPtrEls.keys()],
      bar: bcBarEl.innerText.replace(/\n+/g, ' | '), note: tl ? tl.note.textContent : '',      barOut: bcBarEl.classList.contains('show') || bcBarEl.classList.contains('hint'), empty: bcEmptyEl.classList.contains('on'),
      tiles: bcList.map((t) => { const x = bcTiles.get(t.bc); const b = x ? x.el.getBoundingClientRect() : {}; return { bc: t.bc, who: t.who, live: t.live, full: t.bc === bcFull, still: !!(x && x.img.naturalWidth), stillW: x ? x.img.naturalWidth : 0,
        shown: !!(x && b.width > 0 && getComputedStyle(x.el).visibility !== 'hidden'), rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], muted: x ? x.vid.muted : true,
        text: x ? x.foot.innerText.replace(/\n+/g, ' | ') : '', btns: x ? [...x.foot.querySelectorAll('button')].map((y) => y.textContent + (y.disabled ? ' (off)' : '')) : [] }; }) };
    const st = pc ? await pc.getStats() : new Map();
    for (const x of st.values()) {
      if (x.type === 'inbound-rtp' && x.kind === 'video') { out.framesIn = x.framesDecoded; out.bytesIn = x.bytesReceived; }
      if (x.type === 'inbound-rtp' && x.kind === 'audio') { out.audioIn = x.bytesReceived; out.audioLevel = x.audioLevel || 0; }
      if (x.type === 'transport') { const pair = st.get(x.selectedCandidatePairId); if (pair) { const l = st.get(pair.localCandidateId), rc = st.get(pair.remoteCandidateId); out.path = `${l && l.candidateType} -> ${rc && rc.candidateType}`; } }
    }
    out.muted = vid ? vid.muted : true; out.volume = vid ? +vid.volume.toFixed(3) : 0; out.avDelay = r.vrx ? r.vrx.jitterBufferTarget : null;
    if (pc && pc.localDescription) out.stereo = /stereo=1/.test(pc.localDescription.sdp);
    const rp = pc && await remotePrint(pc); if (rp) out.dtls = `a=fingerprint:${rp.alg} ${rp.fp}`.toLowerCase();
    if (pc && pc.remoteDescription) out.signed = (pc.remoteDescription.sdp.match(/^a=fingerprint:[^\r\n]*/gm) || []).join('\n').toLowerCase();
    return out;
  };
  window.bcTestClick = (id, label) => {       // press a button on a tile, as a mouse would (for main.js's checks)
    const tl = bcTiles.get(id || (bcList.find((t) => !t.mine) || {}).bc), b = tl && [...tl.foot.querySelectorAll('button')].find((x) => x.textContent === label);
    if (b) b.click();
    return !!b;
  };
  let bcTone = null;
  window.bcTestTone = async (hz, want) => {       // how loud one frequency is in a broadcast's sound, in dB (for the sound checks)
    const tl = bcTiles.get(want || bcFull || (bcList.find((t) => t.live) || {}).bc), st = tl && tl.vid.srcObject;
    if (!st || !st.getAudioTracks().length) return null;
    if (!bcTone || bcTone.st !== st) {
      const ac = new AudioContext(), an = ac.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0;
      ac.createMediaStreamSource(st).connect(an);
      bcTone = { st, ac, an };
      await new Promise((r) => setTimeout(r, 400));
    }
    const { ac, an } = bcTone, f = new Float32Array(an.frequencyBinCount);
    if (ac.state !== 'running') await ac.resume().catch(() => {});
    an.getFloatFrequencyData(f);
    const i = Math.round((hz / ac.sampleRate) * an.fftSize);
    return Math.max(f[i - 1], f[i], f[i + 1]);
  };
  window.bcTestPoint =       // a mouse at fractions of the full-screen picture, as the real mousemove handler sends it (for the pointer checks)
    (x, y) => { const b = bcBox(); if (!b) return false; const e = { clientX: b.l + x * b.w, clientY: b.t + y * b.h }; bcPtrAt = 0; bcPoint(e); return true; };

  // While the Surf tab is a hub's Surf stream: whose it is, that everyone can steer it, and who's watching. It sits at the end of the
  // bar's row of tabs, out of sight with the bar. Only "starting…" and a note (something went wrong) float on their own at the top.
  let ssLineKey = '';
  function syncSsLine(w, here) {
    const el = $('#ssLine'), on = here && !!w.hub, loud = !!(w.note || w.waiting);
    el.classList.toggle('on', on);
    if (!on) { ssLineKey = ''; return; }
    const home = loud ? document.body : $('#surfBar .sbTop');
    if (el.parentNode !== home) home.append(el);
    el.classList.toggle('docked', !loud);
    const ids = (w.watchers || []).slice(0, 8), k = JSON.stringify([w.hubId, w.hubName, ids, w.waiting, w.note]);
    if (k === ssLineKey) return;
    ssLineKey = k;
    const ui = window.chatUI, faces = ids.map((id) => (ui ? ui.face(w.hubId, id, '.small') : null)).filter(Boolean);
    const text = document.createElement('span');
    text.textContent = w.note || (w.waiting ? `${w.hubName} · starting the stream…` : w.hubName);
    el.title = `Surf stream · ${w.hubName} · everyone can control`;
    el.replaceChildren(...(loud ? [] : [Object.assign(document.createElement('i'), { className: 'live' })]), text, ...faces);
  }
  const onRtc = (c) => { if (!c.d || typeof c.d !== 'object') return; (c.local ? rtcMirror(c.d) : c.from ? rtcHost(c.from, c.d) : Promise.resolve()).catch((e) => console.log('stream set-up: ' + e.message)); };

  // -- mirroring: this PC's own page, held in the window of another monitor, shown here too. It comes over a WebRTC connection
  // between the two windows (on this PC only), fed by the same single capture friends get. Its sound stays on the page's monitor.
  // The mouse, keyboard and the Surf bar here steer the page as they would there.
  let mirEl = null, mpc = null, msid = '', mAsked = 0, mGood = 0;
  const mirrorHere = () => { const w = S.web || {}; return !!S.surfMirror && !!w.open && !w.stream && !w.gpu && !!w.sid && w.key !== me.key; };       // (a page drawn offscreen is mirrored by gpuEl instead)
  const mirSignal = (d) => api.cmd({ type: 'rtc', local: true, d });
  function mirHangUp() { if (mpc) { const pc = mpc; mpc = null; pc.close(); mirSignal({ type: 'bye' }); } if (mirEl) mirEl.srcObject = null; }
  function mirAsk() { mirHangUp(); mAsked = Date.now(); mirSignal({ type: 'want', sid: msid }); }
  setInterval(() => {       // no picture yet (the page had only just changed, its window was rebuilt...): ask again
    if (!mirEl) return;
    const now = Date.now();
    if (mpc && mpc.connectionState === 'connected') mGood = now; else if (now - Math.max(mAsked, mGood) > 3000) mirAsk();
  }, 1000);
  async function rtcMirror(d) {
    if (!mirEl) return;
    if (d.type === 'offer') {
      if (d.sid !== msid) return;
      if (mpc) { const old = mpc; mpc = null; old.close(); }
      const pc = mpc = new RTCPeerConnection(rtcConf(false));
      pc.ontrack = (e) => {
        if (mpc !== pc || !mirEl) return;
        try { e.receiver.jitterBufferTarget = 0; } catch { /* older Chromium */ }
        if (mirEl.srcObject !== e.streams[0]) mirEl.srcObject = e.streams[0];
      };
      pc.onicecandidate = (e) => { if (e.candidate) mirSignal({ type: 'ice', c: e.candidate.toJSON() }); };
      pc.setRemoteDescription({ type: 'offer', sdp: String(d.sdp) }).catch(() => {});       // candidates that follow wait their turn behind this
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      if (mpc === pc) mirSignal({ type: 'answer', sdp: pc.localDescription.sdp });
    } else if (d.type === 'ice' && d.c && mpc) await mpc.addIceCandidate(d.c);
  }
  function makeMirrorView() {
    const v = mirEl = document.createElement('video');
    v.id = 'webMirror'; v.autoplay = true; v.playsInline = true; v.muted = true; v.tabIndex = 0;
    document.body.insertBefore(v, $('#webEdge'));
    steer(v, () => [v.videoWidth, v.videoHeight]);
  }
  // -- a page drawn offscreen (web.js, "Draw Surf on the graphics card"): its frames come from main as textures on the graphics card and
  // preload.js draws them into this canvas, on the page's own monitor and on any mirroring it. Mouse and keyboard go back to it.
  function makeGpuView(own) {
    const c = gpuEl = document.createElement('canvas');
    c.id = 'webGpu'; c.tabIndex = 0; c.own = own;
    document.body.insertBefore(c, $('#webEdge'));
    steer(c, () => [+c.dataset.fw || 0, +c.dataset.fh || 0]);
    api.cmd({ type: 'surf', do: 'view', on: true });       // main starts sending it frames
    if (own && !surfBar.contains(document.activeElement) && !panel.contains(document.activeElement)) c.focus();
  }
  function dropGpuView() {
    const c = gpuEl; gpuEl = null;
    api.cmd({ type: 'surf', do: 'view', on: false });
    c.remove();
    if (c.own) dropPeers();       // friends' capture was of this page
  }
  // This PC's mouse and keyboard over a picture of its own page (`el`, showing a page `size()` pixels big) go to the page
  function steer(v, size) {
    const at = (e) => {       // where on the page the mouse is, as fractions of its width and height (the picture may have bars beside it)
      const r = v.getBoundingClientRect(), [vw, vh] = size();
      if (!vw || !vh) return null;
      const k = Math.min(r.width / vw, r.height / vh), w = vw * k, h = vh * k;
      return { x: Math.max(0, Math.min(1, (e.clientX - r.left - (r.width - w) / 2) / w)), y: Math.max(0, Math.min(1, (e.clientY - r.top - (r.height - h) / 2) / h)) };
    };
    const mods = (e) => [e.shiftKey && 'shift', e.ctrlKey && 'control', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean);
    const send = (e, p, more) => { if (p) api.cmd({ type: 'web-input', e: { ...p, ...more, m: mods(e) } }); };
    let move = null;
    v.addEventListener('mouseleave', () => { if (selfCtx === 'surf') selfOff(); });
    v.addEventListener('mousemove', (e) => {       // at most one a frame
      if (v.own) surfSelf(e);       // (our own page, the hub's: the others see this pointer too)
      const first = !move; move = e;
      if (first) requestAnimationFrame(() => { const m = move; move = null; if (v.isConnected) send(m, at(m), { k: 'move', bt: m.buttons }); });
    });
    v.addEventListener('mousedown', (e) => { e.preventDefault(); v.focus(); send(e, at(e), { k: 'down', b: e.button, n: e.detail }); });
    v.addEventListener('mouseup', (e) => send(e, at(e), { k: 'up', b: e.button, n: e.detail }));
    v.addEventListener('wheel', (e) => { e.preventDefault(); const u = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1; send(e, at(e), { k: 'wheel', dx: e.deltaX * u, dy: e.deltaY * u }); }, { passive: false });
    v.addEventListener('contextmenu', (e) => e.preventDefault());
    const key = (d) => (e) => {
      if (e.key === 'Escape') { if (d) { v.blur(); tab = 'surf'; showPanel(true); syncUI(); } e.stopPropagation(); return; }       // Esc: our controls, and the keys come back to us
      e.preventDefault(); e.stopPropagation();
      if ((surfKey(e.key, mods(e)) || {}).do === 'url') { if (d) toBar(); return; }       // this screen's bar (the other shortcuts are seen to where the page is: web.js)
      api.cmd({ type: 'web-input', e: { k: 'key', d, key: e.key, m: mods(e) } });
    };
    v.addEventListener('keydown', key(true)); v.addEventListener('keyup', key(false));
  }

  function makeStreamView() {
    const v = vidEl = document.createElement('video');
    v.id = 'webStream'; v.autoplay = true; v.playsInline = true; v.tabIndex = 0;
    document.body.insertBefore(v, $('#webEdge'));
    const may = () => (S.share || {}).cursor !== false;       // a hub's Surf stream has no owner and no lock: everyone online can steer it, unless their cursor sharing is off (view-only; main.js web-input says so)    // where on the page the mouse is, as fractions of its width and height (the picture may have bars beside it)
    const at = (e) => {
      const r = v.getBoundingClientRect(), vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return null;
      const k = Math.min(r.width / vw, r.height / vh), w = vw * k, h = vh * k;
      return { x: Math.max(0, Math.min(1, (e.clientX - r.left - (r.width - w) / 2) / w)), y: Math.max(0, Math.min(1, (e.clientY - r.top - (r.height - h) / 2) / h)) };
    };
    const mods = (e) => [e.shiftKey && 'shift', e.ctrlKey && 'control', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean);
    const send = (e, p, more) => { if (p) api.cmd({ type: 'web-input', e: { ...p, ...more, m: mods(e) } }); };
    // This PC's own mouse is drawn as the others see it (showSelf), in the shape the page asks for (a hand over a link) while the
    // page's hover is ours (web.js takeHover; the host sends it: 'web-cursor'). Its first version was a plain arrow that never
    // changed shape, so nothing on the page looked clickable: renderer/cursors.js has a shape for each.
    let move = null, ptrAt = 0;
    const point = (e, gone) => { const q = gone ? null : at(e); ptrAt = Date.now(); api.cmd(q ? { type: 'web-ptr', x: q.x, y: q.y } : { type: 'web-ptr', x: -1, y: -1 }); };       // so the others can see where this mouse is
    v.addEventListener('mouseleave', (e) => { point(e, true); if (selfCtx === 'surf') selfOff(); });
    v.addEventListener('mousemove', (e) => {       // at most one a frame
      surfSelf(e);
      if (Date.now() - ptrAt > 45) point(e);
      if (!may()) return;
      const first = !move; move = e;
      if (first) requestAnimationFrame(() => { const m = move; move = null; if (vidEl === v) send(m, at(m), { k: 'move', bt: m.buttons }); });
    });
    v.addEventListener('mousedown', (e) => { e.preventDefault(); v.focus(); send(e, at(e), { k: 'down', b: e.button, n: e.detail }); });
    v.addEventListener('mouseup', (e) => { if (may()) send(e, at(e), { k: 'up', b: e.button, n: e.detail }); });
    v.addEventListener('wheel', (e) => { e.preventDefault(); if (!may()) return; const u = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1; send(e, at(e), { k: 'wheel', dx: e.deltaX * u, dy: e.deltaY * u }); }, { passive: false });
    v.addEventListener('contextmenu', (e) => e.preventDefault());
    const key = (d) => (e) => {
      if (e.key === 'Escape') { if (d) { v.blur(); tab = 'surf'; showPanel(true); syncUI(); } e.stopPropagation(); return; }       // Esc: our controls, and the keys come back to us
      if (!may()) return;       // Drift's own shortcuts then
      e.preventDefault(); e.stopPropagation();
      if ((surfKey(e.key, mods(e)) || {}).do === 'url') { if (d) toBar(); return; }       // our bar (the other shortcuts are seen to on their PC: web.js)
      api.cmd({ type: 'web-input', e: { k: 'key', d, key: e.key, m: mods(e) } });
    };
    v.addEventListener('keydown', key(true)); v.addEventListener('keyup', key(false));
    v.focus();
  }

  // ---------- watch together: the Hub tab ----------
  const QNAME = { original: 'Original', 1080: '1080p', 720: '720p', 480: '480p' };
  function syncShareUI() {
    const p = S.p2p || { role: 'off', peers: [] }, sh = S.share || {}, peers = p.peers || [], n = peers.length;
    $('#shBox').style.display = p.role === 'off' && !p.note ? 'none' : '';       // (nothing to show until something is shared: picking it shares it)
    $('#shHost').style.display = p.role === 'host' ? '' : 'none';
    $('#shGuest').style.display = p.role === 'guest' ? '' : 'none';
    $('.tabs button[data-tab="hub"]').classList.toggle('live', p.role !== 'off');
    $('#shNote').textContent = p.note || '';
    if (p.role === 'host') {
      const wait = p.waitingFor || [];
      $('#shHost .spnow').classList.toggle('live', p.status === 'ready');
      $('#shTitle').textContent = p.status !== 'ready' ? 'Starting…' : wait.length ? `Paused while ${wait.join(' and ')} ${wait.length > 1 ? 'load' : 'loads'}…`
        : n ? `Sharing with ${n === 1 ? peers[0].name : n + ' friends'}` : 'Sharing — waiting for friends to join';
      $('#shSub').textContent = p.settling ? 'Getting ready…' : (p.reach === 'internet' ? 'Everyone in the hub can join from the chat.' : p.reach === 'manual' ? 'Everyone in the hub on your network can join from the chat. Friends elsewhere can only if your port is open (below).' : 'Only people in the hub on your network can join from the chat.')
        + (videoOn() ? '' : ' Play a video, open a page in Surf or put music on, and they get it too.');
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
    $('#shControl').checked = !!sh.control; $('#shWait').checked = !!sh.wait; $('#shInternet').checked = !!sh.internet; $('#shAdblock').checked = !!sh.adblock;
    $('#shAdblock').closest('label').style.display = p.role === 'guest' ? 'none' : '';       // a friend's pages are theirs
    $('#shQuality').value = sh.quality || 'original';
    $('#shOverlay').value = sh.overlay || 'all';
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

  // ---------- subtitles: the box in the Media tab ----------
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
    vcc.style.display = videoOn() && tab === 'media' ? '' : 'none'; vcc.classList.toggle('on', !!si.sel);       // (subtitles are the Media tab's)
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
    if (ids.length < 2) { toast('No subtitles for this video yet — use "Find online" in the Media tab.', 4000); return; }
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
    const key = fs.join('|');
    if (key !== folderKey) {
      folderKey = key;
      $('#vfolders').innerHTML = fs.length ? fs.map((f) => `<div class="vf" data-p="${esc(f)}" title="${esc(f)}">📁<span>${esc(folderName(f))}</span><button title="Remove from this list (files are not deleted)">✕</button></div>`).join('')
        : '<p class="note">No folders yet.</p>';
    }
    $$('#vfolders .vf').forEach((x) => x.classList.toggle('active', x.dataset.p === libRoot));       // every time: choosing a folder doesn't wait for new state
    if (tab === 'media' && panel.classList.contains('open') && libRoot && !libDir) openDir(libRoot);
    if (!libRoot && lib) { lib = null; $('#vgrid').innerHTML = '<p>Add a folder to see your videos here.</p>'; $('#vcrumb').innerHTML = ''; }
  }
  // A folder's (or a search's) files, split into videos and music. Each kind plays as its own list.
  const fileTiles = (l, full) => l.videos.map((v, i) => `<button class="vt" data-i="${i}" title="${esc(full ? v.path : v.name)}"><div class="th">▶<i></i><b class="pg"></b></div><div class="nm">${esc(v.name.replace(/\.[^.]+$/, ''))}</div><div class="sz">${sizeStr(v.size)}</div></button>`).join('')
    + l.tracks.map((v, i) => `<button class="vt song" data-t="${i}" title="${esc(full ? v.path : v.name)}"><div class="th">♪<i></i></div><div class="nm">${esc(v.name.replace(/\.[^.]+$/, ''))}</div><div class="sz">${sizeStr(v.size)}</div></button>`).join('');
  const splitKinds = (files) => ({ videos: files.filter((f) => f.kind !== 'audio'), tracks: files.filter((f) => f.kind === 'audio') });
  const counted = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  async function openDir(dir) {
    libDir = dir; const job = ++libJob;
    const data = await api.listDir(dir, 'media');
    if (job !== libJob) return;
    lib = { ...data, ...splitKinds(data.videos) };
    const what = [lib.videos.length || !lib.tracks.length ? counted(lib.videos.length, 'video', 'videos') : '', lib.tracks.length ? counted(lib.tracks.length, 'song', 'songs') : ''].filter(Boolean).join(' · ');
    $('#vcrumb').innerHTML = (data.parent ? '<button class="icon" title="Back">‹</button>' : '') + `<b>${esc(data.name || '')}</b><span class="note" style="margin:0">${what}</span>`;
    $('#vgrid').innerHTML = (data.dirs.map((d) => `<button class="vt dir" data-dir="${esc(d.path)}" title="${esc(d.name)}"><div class="th">📁</div><div class="nm">${esc(d.name)}</div></button>`).join('') + fileTiles(lib, false))
      || '<p>No videos or music in this folder.</p>';
    markPlaying(); $('#content').scrollTop = 0;
    makeVideoThumbs(job);
  }
  async function searchVideos(q) {
    const job = ++libJob, res = await api.searchLib('media', libRoot, q);
    if (job !== libJob) return;
    lib = { dir: libRoot, name: `Results for "${q}"`, parent: null, dirs: [], ...splitKinds(res) }; libDir = libRoot;
    $('#vcrumb').innerHTML = `<b>${esc(lib.name)}</b><span class="note" style="margin:0">${res.length}${res.length >= 300 ? '+' : ''} found</span>`;
    $('#vgrid').innerHTML = fileTiles(lib, true) || '<p>Nothing matches.</p>';
    markPlaying(); makeVideoThumbs(job);
  }

  function markPlaying() {
    if (!lib) return;
    const song = filesOn() ? S.music.playlist[S.nowPlaying.index] : '';
    $$('#vgrid .vt[data-i]').forEach((t) => t.classList.toggle('active', !song && videoOn() && lib.videos[+t.dataset.i].path === S.videoPath));      // a video or a song, never both
    $$('#vgrid .vt[data-t]').forEach((t) => t.classList.toggle('active', !!song && lib.tracks[+t.dataset.t].path === song));
    paintProgress();
  }
  // how far each video got (saved between sessions by main; the one playing now is live)
  function paintProgress() {
    if (!lib) return;
    const saved = S.video.progress || {};
    $$('#vgrid .vt[data-i]').forEach((t) => {
      const v = lib.videos[+t.dataset.i], r = saved[v.path], bar = t.querySelector('.pg'); if (!v || !bar) return;
      let k = 0;
      if (videoOn() && v.path === S.videoPath && vDur() > 0) k = Math.min(1, vTime() / vDur());
      else if (r) { const d = r.dur || (thumbs.get(v.path) || {}).dur || 0; k = r.done ? 1 : d ? Math.min(1, r.pos / d) : 0; }
      bar.style.setProperty('--p', (k * 100).toFixed(1) + '%');
      bar.classList.toggle('on', k > 0.005);
    });
  }
  function paintThumb(sel, t) {
    const el = $(`#vgrid .vt[${sel}] .th`); if (!el) return;
    if (sel.startsWith('data-t')) {       // a song: its cover, whole, over a blurred copy of itself (style.css); its own title, and the artist by the size
      if (t.img) { el.style.setProperty('--art', `url("${t.img}")`); el.classList.add('art'); el.firstChild.textContent = ''; }
      const tile = el.parentElement, sz = tile.querySelector('.sz');
      if (t.title) tile.querySelector('.nm').textContent = t.title;
      if (t.artist && !sz.dataset.size) { sz.dataset.size = sz.textContent; sz.textContent = `${t.artist} · ${sz.textContent}`; }
    } else if (t.img) { el.style.backgroundImage = `url(${t.img})`; el.firstChild.textContent = ''; }
    if (t.dur) el.querySelector('i').textContent = clockStr(t.dur);
    if (sel.startsWith('data-i')) paintProgress();
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
  async function makeVideoThumbs(job) {       // a picture and the length for each video; for each song its length, and its cover, title and artist from its tags
    const all = [...lib.videos.map((v, i) => [v, `data-i="${i}"`]), ...lib.tracks.map((v, i) => [v, `data-t="${i}"`])];
    for (const [v, sel] of all) {
      if (job !== libJob) return;
      let t = thumbs.get(v.path);
      if (!t) {
        const song = sel.startsWith('data-t');
        const [g, tags] = await Promise.all([grab(v.url), song ? api.songTags(v.path).catch(() => null) : null]);
        t = tags ? { ...g, img: tags.art || '', title: tags.title, artist: tags.artist } : g;
        thumbs.set(v.path, t);
      }
      if (job === libJob) paintThumb(sel, t);
    }
  }

  // wiring
  document.addEventListener('change', (e) => { if (e.target.type === 'range') e.target.blur(); });
  const P = (p) => api.patch(p);
  $$('.tabs button').forEach((x) => x.addEventListener('click', () => setTab(x.dataset.tab, true)));
  $('#tiles').addEventListener('click', (e) => {
    const r = e.target.closest('.rot');
    if (r && S.autoCycle > 0) {                       // the corner tick: in or out of the rotation, without switching to the scene
      e.stopPropagation();
      const id = r.closest('.tile').dataset.id, skip = S.cycleSkip || [];
      P({ cycleSkip: skip.includes(id) ? skip.filter((x) => x !== id) : [...skip, id] });
      return;
    }
    const t = e.target.closest('.tile'); if (!t) return; if (isLocked(t.dataset.id)) { lockedSay(); return; } if (t.dataset.id === 'video' && !S.video.files.length) { api.cmd({ type: 'pick-video', key: me.key }); return; } P(S.mode === 'mix' ? { perDisplay: { [me.key]: t.dataset.id } } : { scene: t.dataset.id }); });
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
  $('#mode').addEventListener('click', (e) => { const v = e.target.dataset.v; if (v) P(v === 'mirror' && S.mode !== 'mirror' ? { mode: v, mirrorFrom: { key: me.key, tab: screenTab } } : { mode: v }); });       // (into Mirror: every monitor takes what this one shows)
  // Ambient sound, in Scenes: a preset, or Off. Music from the library takes over from it while it plays, and it comes back after.
  $('#presets').addEventListener('click', (e) => {
    const t = e.target.closest('.preset'); if (!t) return;
    if (t.dataset.id === 'off') P({ music: { ambientOff: true, ...(S.music.source === 'generative' ? { source: 'off' } : {}) } });
    else P({ music: { preset: t.dataset.id, ambientOff: false, source: 'generative', playing: true } });
  });
  $('#stopMusic').addEventListener('click', () => P({ music: { source: S.music.ambientOff ? 'off' : 'generative', playing: true } }));
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
  $('#surfFit').addEventListener('change', (e) => P({ surfFit: e.target.value }));
  $('#surfTheme').addEventListener('change', (e) => P({ surfTheme: e.target.value }));
  for (const k of ['cycleShuffle', 'clock', 'breathing', 'cat', 'keepAwake', 'onTop', 'autoUpdate', 'surfGpu', 'ambientYields']) $('#' + k).addEventListener('change', (e) => P({ [k]: e.target.checked }));
  $('#shuffle').addEventListener('change', (e) => P({ music: { shuffle: e.target.checked } }));
  // Settings → Updates: what the updater is doing, and the one button that does the next thing
  function syncUpdate() {
    const u = S.update, b = $('#updBtn'), n = $('#updNote');
    $('#updRow').style.display = u && u.supported ? '' : 'none';
    // a newer version is out and hasn't been downloaded: the same download icon on the Settings tab and on the button
    const waiting = !!(u && u.supported && ['available', 'manual'].includes(u.status));
    $('#updTabIcon').classList.toggle('on', waiting);
    b.querySelector('.updIcon').classList.toggle('on', waiting);
    if (!u || !u.supported) return;
    const pct = Math.round((u.progress || 0) * 100);
    b.querySelector('span').textContent = { available: 'Download update', manual: 'Download update', ready: `Restart to update to ${u.version}`, checking: 'Checking…', downloading: `Downloading ${u.version}… ${pct}%` }[u.status] || 'Check for updates';
    b.classList.toggle('ghost', !['available', 'ready', 'manual'].includes(u.status));
    b.style.pointerEvents = ['checking', 'downloading'].includes(u.status) ? 'none' : '';
    n.textContent = u.error || { latest: `Drift ${u.current} is the latest version`, available: `Drift ${u.version} is out (you have ${u.current})`, ready: 'Or it installs by itself when you close Drift', manual: `Drift ${u.version} is out. This copy can’t update itself here: the button opens the releases page` }[u.status] || `You have Drift ${u.current}`;
  }
  $('#wnBtn').addEventListener('click', () => { if (window.whatsNew) window.whatsNew.open({ since: S.notesSeen || '' }); });       // (whatsnew.js: every version, this one first)
  $('#updBtn').addEventListener('click', () => {
    const u = S.update || {};
    if (u.status === 'ready') api.cmd({ type: 'update-install' });
    else if (u.status === 'available') api.cmd({ type: 'update-download' });
    else if (u.status === 'manual') api.cmd({ type: 'update-page' });
    else api.cmd({ type: 'update-check' });
  });
  $('#sleep').addEventListener('change', (e) => P({ sleepAt: +e.target.value ? Date.now() + +e.target.value * 60000 : 0 }));
  $('#pickVideo').addEventListener('click', () => api.cmd({ type: 'pick-video', key: me.key }));
  for (const [id, k] of [['#vHdr', 'hdr'], ['#vTone', 'tone'], ['#vEnc', 'enc'], ['#vXq', 'xq']]) $(id).addEventListener('change', (e) => P({ video: { [k]: e.target.value } }));
  $('#shStop').addEventListener('click', () => api.cmd({ type: 'share-stop' }));
  $('#shLeave').addEventListener('click', () => api.cmd({ type: 'share-stop' }));
  $('#shName').addEventListener('change', (e) => P({ share: { name: e.target.value.trim() } }));
  $('#shName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  for (const [id, k] of [['#shControl', 'control'], ['#shWait', 'wait'], ['#shInternet', 'internet'], ['#shAdblock', 'adblock']]) $(id).addEventListener('change', (e) => P({ share: { [k]: e.target.checked } }));
  $('#shQuality').addEventListener('change', (e) => P({ share: { quality: e.target.value } }));
  $('#shOverlay').addEventListener('change', (e) => P({ share: { overlay: e.target.value } }));
  $('#videoFit').addEventListener('change', (e) => P({ video: { fit: e.target.value } }));
  $('#videoSound').addEventListener('change', (e) => P({ video: { sound: e.target.checked } }));
  $('#videoAuto').addEventListener('change', (e) => P({ video: { autoplay: e.target.checked } }));
  $('#stopVideo').addEventListener('click', () => api.cmd({ type: 'stop-video', key: me.key }));
  $('#addVFolder').addEventListener('click', () => api.cmd({ type: 'add-video-folder' }));
  $('#vfolders').addEventListener('click', (e) => {
    const f = e.target.closest('.vf'); if (!f) return;
    if (e.target.tagName === 'BUTTON') { if (libRoot === f.dataset.p) { libRoot = ''; libDir = ''; } api.cmd({ type: 'remove-video-folder', path: f.dataset.p }); }
    else { libRoot = f.dataset.p; $('#vsearch').value = ''; openDir(libRoot); renderFolders(); }
  });
  $('#vgrid').addEventListener('click', (e) => {
    const t = e.target.closest('.vt'); if (!t || !lib) return;
    if (t.dataset.dir) openDir(t.dataset.dir);
    else if (t.dataset.t) api.cmd({ type: 'play-tracks', files: lib.tracks.map((v) => v.path), index: +t.dataset.t });
    else api.cmd({ type: 'play-videos', files: lib.videos.map((v) => v.path), index: +t.dataset.i, key: me.key });
  });
  $('#vcrumb').addEventListener('click', (e) => { if (e.target.closest('button') && lib && lib.parent) openDir(lib.parent); });
  const setVol = (v) => { if (volIsSurf()) P({ mixer: { surf: v, ...(v > 0 ? { surfMute: false } : {}) } }); else if (volIsSpotify()) { if ((S.spotify || {}).volMode) { S.spotify.vol = v; api.cmd({ type: 'spotify-volume', value: v }); } } else P(volIsVideo() ? { video: { volume: v } } : { music: { volume: v } }); };
  $('#qvol').addEventListener('input', (e) => { fill(e.target); setVol(+e.target.value); });

  // ---------- the volume mixer: the toolbar's speaker opens it, a row for each of Drift's sounds, as Windows' own mixer ----------
  // Clicking a row's icon mutes it. Drift's row scales all the others but Spotify, which is Spotify's own volume.
  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const SPK = '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/>';
  const speaker = (v) => svg(SPK + (v <= 0 ? '<path d="M16 9.5l5 5M21 9.5l-5 5"/>' : (v > 0.02 ? '<path d="M15.5 9.2a4 4 0 0 1 0 5.6"/>' : '') + (v > 0.5 ? '<path d="M18.3 6.6a7.6 7.6 0 0 1 0 10.8"/>' : '')));
  const MIX = [
    { id: 'master', name: 'Drift', label: 'Drift', note: 'Everything Drift plays', icon: () => speaker(mixMaster()), get: () => S.mixer.master, muted: () => S.mixer.mute,
      set: (v) => P({ mixer: { master: v, ...(v > 0 ? { mute: false } : {}) } }), mute: () => P({ mixer: { mute: !S.mixer.mute } }) },
    { id: 'ambient', name: 'Ambient (music and nature sounds)', label: 'Ambient', icon: () => svg('<path d="M4 15.5a4 4 0 0 1 1.6-7.7 5.5 5.5 0 0 1 10.6 1.2A3.5 3.5 0 0 1 17.5 16H6"/><path d="M8 19.5l-.8 1.5M12 19.5l-.8 1.5M16 19.5l-.8 1.5"/>'),
      get: () => S.music.volume, muted: () => S.mixer.ambientMute,
      set: (v) => P({ music: { volume: v }, ...(v > 0 && S.mixer.ambientMute ? { mixer: { ambientMute: false } } : {}) }), mute: () => P({ mixer: { ambientMute: !S.mixer.ambientMute } }) },
    { id: 'media', name: 'Media (videos and your music)', label: 'Media', icon: () => svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor"/>'),
      get: () => S.video.volume, muted: () => S.mixer.mediaMute,
      set: (v) => P({ video: { volume: v }, ...(v > 0 && S.mixer.mediaMute ? { mixer: { mediaMute: false } } : {}) }), mute: () => P({ mixer: { mediaMute: !S.mixer.mediaMute } }) },
    { id: 'surf', name: 'Surf (every web page)', label: 'Surf', icon: () => svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9s1.2-6.4 3.8-9z"/>'), get: () => S.mixer.surf, muted: () => S.mixer.surfMute,
      set: (v) => P({ mixer: { surf: v, ...(v > 0 ? { surfMute: false } : {}) } }), mute: () => P({ mixer: { surfMute: !S.mixer.surfMute } }) },
    { id: 'spotify', name: 'Spotify', label: 'Spotify', icon: () => svg('<circle cx="12" cy="12" r="9" fill="#1ed760" stroke="none"/><path d="M7.5 9.6c3-.9 6.4-.6 9 .9M8 12.6c2.4-.7 5-.4 7.2.8M8.5 15.3c1.9-.5 3.8-.3 5.5.6" stroke="#0b0d13" stroke-width="1.5"/>'),
      show: () => !!(S.spotify || {}).volMode, get: () => (S.spotify || {}).vol || 0, muted: () => false, nomute: true,
      set: (v) => { S.spotify.vol = v; api.cmd({ type: 'spotify-volume', value: v }); } },
  ];
  const mixEl = $('#mixer'), mixBtn = $('#mixBtn');
  for (const r of MIX) {
    const row = document.createElement('div');
    row.className = 'mixRow' + (r.id === 'master' ? ' master' : ''); row.dataset.id = r.id;
    row.title = r.name;
    row.innerHTML = `<button class="mixIco"></button><div class="mixMain"><div class="mixTop"><b>${r.label}</b>${r.note ? `<em>${r.note}</em>` : ''}<output></output></div><input type="range" min="0" max="1" step="0.01" aria-label="${r.name} volume"></div>`;
    const ico = row.querySelector('.mixIco'), sl = row.querySelector('input'), out = row.querySelector('output');
    if (r.nomute) ico.disabled = true; else ico.addEventListener('click', () => r.mute());
    sl.addEventListener('input', () => { fill(sl); out.textContent = Math.round(sl.value * 100) + '%'; r.set(+sl.value); });
    Object.assign(r, { row, ico, sl, out });
    $('#mixRows').append(row);
  }
  function syncMixer() {
    const v = mixMaster();
    mixBtn.innerHTML = speaker(v);
    mixBtn.title = S.mixer.mute ? 'Volume mixer (Drift is muted)' : `Volume mixer (Drift ${Math.round(v * 100)}%)`;
    for (const r of MIX) {
      r.row.style.display = !r.show || r.show() ? '' : 'none';
      const off = r.muted();
      r.ico.innerHTML = r.icon(); r.ico.classList.toggle('muted', off);
      r.ico.title = r.nomute ? `${r.name} (its own volume)` : `${off ? 'Unmute' : 'Mute'} ${r.name}`;
      r.row.classList.toggle('off', off);
      setVal(r.sl, r.get()); if (document.activeElement !== r.sl) r.out.textContent = Math.round(r.get() * 100) + '%';
    }
    placeMixer();       // (rows come and go: Spotify's)
  }
  // Drawn over everything (not inside the panel, whose blur would show through it): placed above the speaker, its right edge
  // in line with the volume slider's, and kept on screen
  function placeMixer() {
    if (!mixEl.classList.contains('open')) return;
    const b = mixBtn.getBoundingClientRect(), q = $('#qvol').getBoundingClientRect(), w = mixEl.offsetWidth, h = mixEl.offsetHeight;
    const right = Math.max(b.right, q.right);
    mixEl.style.left = Math.round(Math.max(8, Math.min(innerWidth - w - 8, right - w))) + 'px';
    mixEl.style.top = Math.round(Math.max(8, b.top - 12 - h)) + 'px';
  }
  const mixOpen = (on) => { mixEl.classList.toggle('open', on); mixBtn.classList.toggle('lit', on); mixBtn.setAttribute('aria-expanded', String(on)); if (on) { syncMixer(); placeMixer(); } };
  addEventListener('resize', placeMixer);
  panel.addEventListener('transitionend', placeMixer);       // (the panel slides a little as it comes up)
  mixEl.addEventListener('mouseenter', () => { overPanel = true; });       // over the mixer is over the panel: it stays up
  mixEl.addEventListener('mouseleave', () => { overPanel = false; armHide(); });
  mixBtn.addEventListener('click', () => mixOpen(!mixEl.classList.contains('open')));
  addEventListener('mousedown', (e) => { if (mixEl.classList.contains('open') && !mixEl.contains(e.target) && !mixBtn.contains(e.target)) mixOpen(false); }, true);
  mixEl.addEventListener('keydown', (e) => {       // its keys are its own: arrows move a slider, not the toolbar's volume
    if (e.key === 'Escape') { mixOpen(false); mixBtn.focus(); }
    if (['Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.stopPropagation();
  });
  const seekEl = $('#seek');
  seekEl.addEventListener('pointerdown', () => { seeking = true; });
  seekEl.addEventListener('input', () => {
    fill(seekEl); $('#vcur').textContent = clockStr(+seekEl.value);
    if (performance.now() - lastJump > 140) { lastJump = performance.now(); api.cmd(musicBar() ? { type: 'music-seek', pos: +seekEl.value } : { type: 'video-jump', pos: +seekEl.value }); }
  });
  seekEl.addEventListener('change', () => {
    if (musicBar()) { api.cmd({ type: 'music-seek', pos: +seekEl.value }); musicPos = { ...musicPos, t: +seekEl.value, at: performance.now() }; }
    else api.cmd({ type: 'video-jump', pos: +seekEl.value, final: true });
    setTimeout(() => { seeking = false; }, 400);
  });
  // play / pause: whatever the toolbar is on (see ctx): the scene, the video, the music, or Spotify
  const ctxToggle = () => {
    const c = ctx();
    if (c === 'scene') P({ frozen: !S.frozen });
    else if (c === 'surf') { /* the page has its own play button */ }
    else if (c === 'video') {
      if (videoOn()) P({ video: { paused: !S.video.paused } });
      else if (S.video.files.length) P({ ...(S.mode === 'mix' ? { perDisplay: { [me.key]: 'video' } } : { scene: 'video' }), video: { paused: false } });   // bring the last video back
      else toast('Pick a video in the Media tab first', 1800);
    }
    else if (c === 'spotify') api.cmd({ type: 'spotify', action: 'toggle' });
    else if (theirMusic()) hostMusic('toggle');
    else if (filesOn()) P({ music: { playing: !S.music.playing } });
    else toast('Pick a song in the Media tab first', 1800);
  };
  const ctxStep = (dir) => {
    const c = ctx();
    if (c === 'scene') { if (sceneFor(S) !== 'video') stepScene(dir); }       // (a video on screen: no scene to step from)
    else if (c === 'surf') { if ((S.web || {}).open) surf(dir < 0 ? 'back' : 'fwd'); }
    else if (c === 'video') {
      if (!videoOn()) toast('Pick a video in the Media tab first', 1800);
      else if (dir < 0 && vTime() > 4) api.cmd({ type: 'video-jump', pos: 0, final: true });      // first press of "previous" restarts the video
      else api.cmd({ type: 'video-step', dir });
    }
    else if (c === 'spotify') api.cmd({ type: 'spotify', action: dir > 0 ? 'next' : 'prev' });
    else if (theirMusic()) hostMusic(dir > 0 ? 'next' : 'prev');
    else if (filesOn()) api.cmd({ type: dir > 0 ? 'next' : 'prev' });
    else toast('Pick a song in the Media tab first', 1800);
  };
  let vTimer;
  $('#vsearch').addEventListener('input', (e) => { clearTimeout(vTimer); vTimer = setTimeout(() => { const q = e.target.value.trim(); if (q) searchVideos(q); else openDir(libRoot); }, 250); });
  $('#reset').addEventListener('click', async () => {       // (main.js 'reset': the settings only; hubs, chat and Surf's data are their own)
    if (await question({ title: 'Reset everything?', note: 'Every setting goes back to how it started, on every monitor, and sharing stops. Your playlist, folders and name stay, and so do your hubs and Surf.', yes: 'Reset everything' })) api.cmd({ type: 'reset' });
  });
  // It signs you out everywhere in Surf, so the first click asks and a second click within a few seconds does it.
  // Settings: the hub's Surf stream, for its host
  $('#hsNoDl').addEventListener('change', (e) => api.patch({ hubSurf: { noDownloads: e.target.checked } }));
  $('#hsLan').addEventListener('change', (e) => api.patch({ hubSurf: { allowLan: e.target.value } }));
  $('#hsSpecs').addEventListener('change', (e) => api.patch({ hubSurf: { showSpecs: e.target.checked } }));
  $('#hsBrowsing').addEventListener('change', (e) => api.patch({ hubSurf: { showBrowsing: e.target.checked } }));
  $('#hsClear').addEventListener('click', async () => {
    if (await question({ title: 'Clear the hub\'s browser?', note: 'Its tabs close, and it forgets every sign-in, cookie and page it has visited, for everyone in the hub.', yes: 'Clear it' })) api.cmd({ type: 'hub-surf-clear' });
  });
  $('#forgetSurf').addEventListener('click', async () => {
    if (await question({ title: 'Forget Surf\'s sign-ins and history?', note: 'You\'ll be signed out of every site in Surf, and its cookies, site data, cache and history are cleared. Your normal browser isn\'t touched.', yes: 'Forget everything' })) api.cmd({ type: 'surf-forget' });
  });
  $('#play').addEventListener('click', ctxToggle);
  $('#prevTrack').addEventListener('click', () => ctxStep(-1));
  $('#nextTrack').addEventListener('click', () => ctxStep(1));
  $('#eject').addEventListener('click', (e) => {
    const what = e.currentTarget.dataset.what;
    if (what === 'video') api.cmd({ type: 'stop-video', key: me.key });
    else if (what === 'music') P({ music: { source: S.music.ambientOff ? 'off' : 'generative', playing: true } });       // (as Stop music does)
    if (what) { screenTab = 'media'; pickScreen('media'); syncUI(); }
  });
  $('#exit').addEventListener('click', askQuit);
  $('#confirmYes').addEventListener('click', () => { if (asking) asking.done(true); });
  $('#confirmNo').addEventListener('click', closeAsk);
  $('#confirmAlt').addEventListener('click', () => { if (asking) asking.done('alt'); });
  $('#confirmMon').addEventListener('click', () => { closeAsk(); api.cmd({ type: 'monitor-off', index: me.index }); });
  confirmEl.addEventListener('mousedown', (e) => { if (e.target === confirmEl) closeAsk(); });      // a click outside the box means "stay"

  function stepScene(dir) {
    if (S.mode === 'mix') {       // (from a game: on from where it sits in the list; never onto a locked scene)
      const cur = sceneFor(S), at = SCENES.findIndex((x) => x.id === cur), open = CYCLED.filter((x) => !isLocked(x.id));
      let i = open.findIndex((x) => x.id === cur);
      if (i < 0) i = dir > 0 ? open.filter((x) => SCENES.indexOf(x) < at).length - 1 : open.filter((x) => SCENES.indexOf(x) < at).length;
      if (open.length) P({ perDisplay: { [me.key]: open[(i + dir + open.length * 2) % open.length].id } });
    }
    else api.cmd({ type: 'step-scene', dir });
  }
  let toastTimer;
  // A download on the hub's Surf stream, waiting for the host (main.js "held downloads"): a row on every screen of the host's,
  // whether or not they're in the hub. Only this PC's own windows ever get it; it's never sent over the hub.
  // (heldList, heldTick: declared at the top)
  const bytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? Math.round(n / 1e6) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n > 0 ? n + ' bytes' : '');
  function drawHeld(list) {
    heldList = list; clearTimeout(heldTick);
    const box = $('#heldCard');
    box.hidden = !list.length;
    box.replaceChildren(...list.map((d) => {
      const row = document.createElement('div'); row.className = 'hdRow';
      const text = document.createElement('div'); text.className = 'hdText';
      const b1 = document.createElement('b'), b2 = document.createElement('b');
      b1.textContent = d.name; b2.textContent = d.site || 'a site';
      text.append(`${d.who === 'You' ? 'You want' : (d.who || 'Someone') + ' wants'} to download `, b1, bytes(d.size) ? ` (${bytes(d.size)})` : '', ' from ', b2);
      text.title = text.textContent + '. It saves to your Downloads folder.';
      const left = document.createElement('span'); left.className = 'hdLeft'; left.textContent = Math.max(0, Math.ceil((d.until - Date.now()) / 1000)) + 's';
      const btn = (label, save, cls) => { const x = document.createElement('button'); x.className = 'btn ' + cls; x.textContent = label; x.addEventListener('click', () => api.cmd({ type: 'hub-held', id: d.id, save })); return x; };
      row.append(text, left, btn('Save', true, 'primary'), btn('Refuse', false, 'ghost'));
      return row;
    }));
    if (list.length) heldTick = setTimeout(() => drawHeld(heldList), 1000);
  }
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms); }

  let meow = '';
  // four kitten meows, made with Web Audio: a buzzy voice through two "mouth" filters that open and close as the pitch
  // rises and falls. [start, top, end] pitch in Hz, length in seconds, where the top comes (0 to 1)
  const MEOWS = { m: [700, 1150, 760, 0.42, 0.35], e: [880, 1400, 1000, 0.3, 0.3], o: [600, 960, 560, 0.58, 0.45], w: [820, 1250, 620, 0.5, 0.25] };
  let mewCtx = null;
  function mew(ch) {
    const [f0, f1, f2, dur, top] = MEOWS[ch], a = mewCtx || (mewCtx = new AudioContext()), t = a.currentTime + 0.01, j = 1 + (Math.random() - 0.5) * 0.06;
    const voice = a.createOscillator(); voice.type = 'sawtooth';
    voice.frequency.setValueAtTime(f0 * j, t); voice.frequency.exponentialRampToValueAtTime(f1 * j, t + dur * top); voice.frequency.exponentialRampToValueAtTime(f2 * j, t + dur);
    const vib = a.createOscillator(), vibAmt = a.createGain(); vib.frequency.value = 6.5; vibAmt.gain.value = f1 * 0.012; vib.connect(vibAmt).connect(voice.frequency);
    const out = a.createGain(); out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(0.22, t + 0.05); out.gain.setValueAtTime(0.2, t + dur * 0.7); out.gain.exponentialRampToValueAtTime(0.001, t + dur);
    for (const [from, mid, to, q, lvl] of [[900, 1700, 750, 4, 1], [2400, 3300, 1500, 6, 0.5]]) {       // "m" opening to "ee-ah", closing to "ow"
      const bp = a.createBiquadFilter(), g = a.createGain(); bp.type = 'bandpass'; bp.Q.value = q; g.gain.value = lvl;
      bp.frequency.setValueAtTime(from, t); bp.frequency.linearRampToValueAtTime(mid, t + dur * top); bp.frequency.linearRampToValueAtTime(to, t + dur);
      voice.connect(bp).connect(g).connect(out);
    }
    out.connect(a.destination);
    voice.start(t); vib.start(t); voice.stop(t + dur + 0.05); vib.stop(t + dur + 0.05);
  }
  addEventListener('keydown', (e) => {
    if (confirmEl.classList.contains('on')) {       // the question is up: only it gets keys
      e.preventDefault();
      if (e.key === 'Enter') { const b = document.activeElement; if (b && b.matches('#confirm .btn')) b.click(); else $('#confirmYes').click(); }
      else if (e.key === 'Escape') closeAsk();
      else if (e.key === 'Tab' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {      // move between the buttons that are showing
        const bs = $$('#confirm .btn').filter((b) => b.offsetParent), i = bs.indexOf(document.activeElement);
        bs[(i + ((e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey)) ? -1 : 1) + bs.length) % bs.length].focus();
      }
      return;
    }
    if (e.target.tagName === 'SELECT') return;
    if (e.key.length === 1 && e.target.type !== 'search' && e.target.tagName !== 'TEXTAREA' && tab === 'settings' && panel.classList.contains('open')) {
      // in Settings, M E O W each meow like a kitten; typing "meow" unlocks more cats (Summon the cats, and how many)
      const ch = e.key.toLowerCase();
      if (MEOWS[ch]) mew(ch);
      meow = (meow + ch).slice(-4);
      if (meow === 'meow' && !S.catsUnlocked) { P({ catsUnlocked: true }); toast('🐈 🐈 🐈  More cats', 2200); }
    }
    if (e.target.type === 'search' || e.target.tagName === 'TEXTAREA') { if (e.key === 'Escape' && !e.defaultPrevented) e.target.blur(); return; }   // typing in a search box or a message
    const k = e.key;
    if (k === 'Escape') { if (panel.classList.contains('show') && panel.classList.contains('open')) { panel.classList.remove('open'); syncUI(); } else askQuit(); }
    else if (k === 'F11' && S.windowed) { e.preventDefault(); api.cmd({ type: 'win', op: 'full' }); }       // the window fills its own monitor, and back
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
    else if (k === 'p' || k === 'P') { const ids = [...Object.keys(PALETTES), 'cycle', 'content', ...(Array.isArray(S.customColors) ? ['custom'] : [])]; const n = ids[(ids.indexOf(S.palette) + 1) % ids.length]; P({ palette: n }); toast(n === 'cycle' ? 'Colour cycle' : n === 'custom' ? 'Your colours' : PALETTES[n].name, 1200); }
    else if ((k === 's' || k === 'S') && videoOn()) { subAsk = true; api.cmd({ type: 'sub-toggle' }); }
    else if ((k === 'v' || k === 'V') && videoOn()) subCycle();
    else if ((k === 'z' || k === 'Z') && videoOn()) subNudge(-0.1);
    else if ((k === 'x' || k === 'X') && videoOn()) subNudge(0.1);
    else if (k === 'c' || k === 'C') P({ clock: !S.clock });
    else if (k === 'b' || k === 'B') P({ breathing: !S.breathing });
    else if (/^[1-9]$/.test(k) && SCENES[+k - 1] && (ctx() === 'scene' || tab === 'scenes') && isLocked(SCENES[+k - 1].id)) lockedSay();
    else if (/^[1-9]$/.test(k) && SCENES[+k - 1] && (ctx() === 'scene' || tab === 'scenes')) P(S.mode === 'mix' ? { perDisplay: { [me.key]: SCENES[+k - 1].id } } : { scene: SCENES[+k - 1].id });
  });

  // ---------- state sync ----------
  api.on('state', (ns) => {
    const prevPal = S.palette + (S.customColors || []).join('');
    S = ns; resize(); syncWeb(); syncBcView(); selfSync();
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
    if (c.type === 'win-state') { winState(c); return; }
    if (c.type === 'show-panel') { tab = c.tab === 'video' || c.tab === 'music' ? 'media' : c.tab; tellTab(); showPanel(true); clearTimeout(hideTimer); syncUI(); }
    else if (c.type === 'toast') { if (isCenter || panel.classList.contains('show')) toast(c.text, Math.max(3200, Math.min(9000, c.text.length * 70))); }     // one screen is enough
    else if (c.type === 'media-ask') askMedia(c);
    else if (c.type === 'content-pic') {       // the Surf page's or a broadcast's picture, for the "What's playing" colours (main.js contentTick)
      if ((contentLive ? contentLive.url : '') === (c.url || '')) return;
      contentLive = c.url ? { from: c.from, url: c.url } : null;
      syncContentPal();
    }
    else if (c.type === 'screen-pick') {       // Mirror: Scenes or Media was picked on another monitor (pickScreen): this one shows it too
      if (S.mode !== 'mirror' && !c.into) return;
      screenTab = c.tab;
      if (tab !== c.tab && !SIDE_TABS.includes(tab)) { tab = c.tab; tellTab(); }       // (the panel follows, unless it's on Hub or Settings)
      syncUI();
    }
    else if (c.type === 'ask-quit') { if (asking && asking.quit) api.cmd({ type: 'quit' }); else askQuit(); }       // (asked twice: Alt+F4 again closes)
    else if (c.type === 'rtc') onRtc(c);
    else if (c.type === 'ss-rtc') { if (c.d && typeof c.d === 'object') ssRtc(c.d).catch((e) => console.log('Surf stream set-up: ' + e.message)); }
    else if (c.type === 'ss-out') ssSend(c.m);
    else if (c.type === 'bc-rtc') { if (c.d && typeof c.d === 'object') bcRtc(String(c.bc || ''), c.d).catch((e) => console.log('broadcast set-up: ' + e.message)); }
    else if (c.type === 'bc-ptrs') { if (c.bc === bcFull) bcDrawPtrs(Array.isArray(c.list) ? c.list : []); }       // (pointers show only over the one full screen)
    else if (c.type === 'bc-ping') { if (c.p && c.bc === bcFull) bcRipple(c.p); }
    else if (c.type === 'hub-held') drawHeld(Array.isArray(c.list) ? c.list : []);
    else if (c.type === 'web-cursor' && /^[a-z-]{1,24}$/.test(c.c)) {       // the pointer the page wants, while its hover is ours (web.js takeHover)
      const el = gpuEl || vidEl; if (el) el.style.cursor = c.c;       // (the real one, where ours isn't drawn)
      surfCur = c.c;
      if (selfCtx === 'surf') { showSelf('surf', parseFloat(selfPtr.style.left) || 0, parseFloat(selfPtr.style.top) || 0, surfCur); selfClaimed = false; }       // (a new shape, not a mouse move)
    }
    else if (c.type === 'cats') catAt = Array.isArray(c.at) ? c.at : [];
    else if (c.type === 'music-pos') musicPos = { t: +c.t || 0, d: +c.d || 0, at: performance.now() };
    else if (c.type === 'ptrs') showPtrs(Array.isArray(c.list) ? c.list : []);
    else if (c.type === 'vptrs') showVptrs(Array.isArray(c.list) ? c.list : []);
    else if (c.type === 'bj') bjCmd(c);
    else if (c.type === 'game') gmCmd(c);
    else if (c.type === 'slots') slT.result(c);       // (Scene Slots: the scene won, or why not)
    else if (c.type === 'web-url') toBar();       // Ctrl+L in the web page
    else if (c.type === 'chat-quick') { if (webEl) webEl.blur(); quickOverSurf(); }       // Enter in a Surf page that wasn't for the page (web.js "Enter")
    else if (c.type === 'web-esc') { if (webEl) webEl.blur(); window.focus(); tab = 'surf'; showPanel(true); syncUI(); }       // Esc in the web page: our controls, and the keys come back to us
    else if (c.type === 'share-code') { $('#chCode').value = c.code; $('#chCode').focus(); }
  });
  hdrQuery.addEventListener('change', () => { tellHdr(); syncUI(); });
  tellHdr();

  resize(); syncWeb(); syncBcView(); syncUI(); syncSubs(); tellTab(); requestAnimationFrame(frame);
  if (init.reopen && tab !== 'surf') { showPanel(true); syncUI(); }       // the window in use when the monitors changed: its panel is back where it was
  if (!R) toast('Your graphics driver has WebGL disabled — visuals cannot start.', 10000);
  else if (isCenter && !init.testMode) { toast('Move the mouse for controls  ·  Esc to exit', 5000); }
  document.body.classList.add('idle');
})();
