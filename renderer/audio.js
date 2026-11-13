/* Drift — audio engine (runs in one hidden window so sound never doubles across monitors) */
(async () => {
  const api = window.drift;
  let S = (await api.init()).state;
  const ctx = new AudioContext({ latencyHint: 'playback' });
  const T = () => ctx.currentTime;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const G = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };

  // ---------- graph ----------
  const master = G(0), comp = ctx.createDynamicsCompressor(), analyser = ctx.createAnalyser();
  comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.02; comp.release.value = 0.4;
  analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.75;
  master.connect(comp); comp.connect(analyser); analyser.connect(ctx.destination);
  const musicBus = G(0), natureBus = G(1), genBus = G(0), fileBus = G(1);
  musicBus.connect(master); natureBus.connect(master); genBus.connect(musicBus); fileBus.connect(musicBus);

  // reverb (generated impulse response) + echo for bells
  const reverb = ctx.createConvolver();
  {
    const len = Math.floor(ctx.sampleRate * 5), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
    reverb.buffer = ir;
  }
  const revIn = G(1), revOut = G(0.55); revIn.connect(reverb); reverb.connect(revOut); revOut.connect(genBus);
  const echo = ctx.createDelay(2), echoFb = G(0.42), echoIn = G(1);
  echo.delayTime.value = 0.52; echoIn.connect(echo); echo.connect(echoFb); echoFb.connect(echo); echo.connect(revIn); echo.connect(genBus);

  // ---------- generative music ----------
  const PRESETS = {
    pads:  { root: 48, scale: [0, 2, 4, 7, 9, 11],    wave: 'triangle', atk: 3.5, rel: 7,  gap: [2.2, 5.0], octs: [0, 1, 1, 2], cutoff: 1500, bell: 0.16, level: 0.085, drone: 0.05,  moves: [0, 5, -3, 7] },
    space: { root: 36, scale: [0, 3, 5, 7, 10],       wave: 'sine',     atk: 7,   rel: 11, gap: [3.5, 7.5], octs: [0, 1, 2],    cutoff: 900,  bell: 0.05, level: 0.12,  drone: 0.11,  moves: [0, -2, 3, 5] },
    bells: { root: 60, scale: [0, 2, 4, 7, 9],        wave: 'sine',     atk: 2.5, rel: 6,  gap: [1.1, 3.4], octs: [0, 0, 1],    cutoff: 2600, bell: 0.82, level: 0.06,  drone: 0.035, moves: [0, 5, 7, -5] },
    dawn:  { root: 53, scale: [0, 2, 4, 6, 7, 9, 11], wave: 'sawtooth', atk: 3,   rel: 6,  gap: [1.8, 4.2], octs: [0, 1, 1, 2], cutoff: 1100, bell: 0.32, level: 0.045, drone: 0.04,  moves: [0, 2, 7, -5] },
  };
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  let nextNote = 0, nextChord = 0, chord = 0, lastDeg = 0;

  function padNote(P, midi) {
    const t = T(), f = hz(midi), hold = rand(1.5, 4);
    const env = G(0), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = P.cutoff * rand(0.7, 1.3); lp.Q.value = 0.4;
    lp.frequency.setTargetAtTime(P.cutoff * 0.5, t + P.atk, P.rel);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(P.level, t + P.atk);
    env.gain.setTargetAtTime(0, t + P.atk + hold, P.rel / 3);
    const end = t + P.atk + hold + P.rel * 2;
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator(); o.type = P.wave; o.frequency.value = f; o.detune.value = det + rand(-2, 2);
      o.connect(lp); o.start(t); o.stop(end);
    }
    const pan = ctx.createStereoPanner(); pan.pan.value = rand(-0.6, 0.6);
    lp.connect(env); env.connect(pan); pan.connect(genBus); pan.connect(revIn);
    setTimeout(() => { pan.disconnect(); }, (end - t + 1) * 1000);
  }
  function bellNote(P, midi) {
    const t = T(), f = hz(midi + 12), env = G(0), pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.7, 0.7);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(P.level * 1.6, t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 5.5);
    [[1, 1], [2.0, 0.28], [3.01, 0.09]].forEach(([mul, amp]) => {
      const o = ctx.createOscillator(), g = G(amp); o.type = 'sine'; o.frequency.value = f * mul;
      o.connect(g); g.connect(env); o.start(t); o.stop(t + 5.6);
    });
    env.connect(pan); pan.connect(genBus); pan.connect(echoIn); pan.connect(revIn);
    setTimeout(() => pan.disconnect(), 12000);
  }

  // drone: root + fifth + sub, always running, level follows preset
  const droneGain = G(0), droneLp = ctx.createBiquadFilter(); droneLp.type = 'lowpass'; droneLp.frequency.value = 420;
  const dr = [0, 7, -12].map((_, i) => { const o = ctx.createOscillator(); o.type = i === 1 ? 'sine' : 'triangle'; const g = G([0.6, 0.3, 0.5][i]); o.connect(g); g.connect(droneLp); o.start(); return o; });
  droneLp.connect(droneGain); droneGain.connect(genBus); droneGain.connect(revIn);
  { const l = ctx.createOscillator(), lg = G(120); l.frequency.value = 0.045; l.connect(lg); lg.connect(droneLp.frequency); l.start(); }
  function tuneDrone(P, glide) {
    const r = P.root + chord - 12;
    [0, 7, -12].forEach((iv, i) => dr[i].frequency.setTargetAtTime(hz(r + iv), T(), glide));
    droneGain.gain.setTargetAtTime(P.drone, T(), 2.5);
  }

  let genOn = false, curPreset = null;
  function tickMusic() {
    const P = PRESETS[S.music.preset] || PRESETS.pads;
    const on = S.music.playing && S.music.source === 'generative';
    if (on !== genOn || curPreset !== S.music.preset) {
      if (on && (curPreset !== S.music.preset || !genOn)) { chord = 0; nextChord = T() + rand(35, 60); nextNote = T() + 0.3; tuneDrone(P, 0.8); }
      genOn = on; curPreset = S.music.preset;
      genBus.gain.setTargetAtTime(on ? 1 : 0, T(), on ? 0.6 : 1.2);
    }
    if (!on) return;
    const t = T();
    if (t >= nextChord) { chord = pick(P.moves); nextChord = t + rand(35, 65); tuneDrone(P, 3); }
    if (t >= nextNote) {
      // wander by small steps so melodies feel connected rather than random
      lastDeg = Math.max(0, Math.min(P.scale.length - 1, lastDeg + pick([-2, -1, -1, 1, 1, 2, 3])));
      const midi = P.root + chord + P.scale[lastDeg] + 12 * pick(P.octs);
      if (Math.random() < P.bell) bellNote(P, midi); else padNote(P, midi);
      if (Math.random() < 0.3) padNote(P, P.root + chord + pick([0, 7]) + (P.root < 45 ? 12 : 0));   // anchor tone
      nextNote = t + rand(P.gap[0], P.gap[1]);
    }
  }

  // ---------- nature sounds ----------
  function noiseBuf(kind, secs) {
    const len = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'white') d[i] = w; else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      }
      if (kind !== 'white') { const n = 2000; for (let i = 0; i < n; i++) { const k = i / n; d[len - n + i] = d[len - n + i] * (1 - k) + d[i] * k; } }  // seamless loop
    }
    return b;
  }
  const white = noiseBuf('white', 4), brown = noiseBuf('brown', 7);
  const src = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * 2); return s; };
  const filt = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const lfo = (rate, depth, target) => { const o = ctx.createOscillator(), g = G(depth); o.frequency.value = rate; o.connect(g); g.connect(target); o.start(); };
  const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };
  const N = { rain: G(0), waves: G(0), wind: G(0), fire: G(0) };
  Object.values(N).forEach((g) => g.connect(natureBus));
  chain(src(white), filt('highpass', 1300), filt('lowpass', 7500), G(0.16), N.rain);
  chain(src(brown), filt('lowpass', 320), G(0.35), N.rain);
  { const lp = filt('lowpass', 520), sw = G(0.5); chain(src(brown), lp, sw, G(1.1), N.waves); lfo(0.105, 330, lp.frequency); lfo(0.105, 0.38, sw.gain);
    const foam = G(0.035); chain(src(white), filt('highpass', 2800), foam, N.waves); lfo(0.105, 0.03, foam.gain); }
  { const bp = filt('bandpass', 520, 0.9), sw = G(0.5); chain(src(white), bp, sw, G(0.55), N.wind); lfo(0.07, 240, bp.frequency); lfo(0.19, 110, bp.frequency); lfo(0.05, 0.3, sw.gain); }
  chain(src(brown), filt('bandpass', 380, 0.5), G(0.7), N.fire);
  function crackle(v) {
    const s = ctx.createBufferSource(), hp = filt('highpass', rand(1200, 4500)), g = G(Math.pow(Math.random(), 3) * 0.55 * v + 0.02 * v);
    s.buffer = white; const t = T() + Math.random() * 0.2; s.connect(hp); hp.connect(g); g.connect(natureBus);
    s.start(t, Math.random() * 3, rand(0.003, 0.03));
    s.onended = () => g.disconnect();
  }

  // ---------- your own files ----------
  const player = document.getElementById('player');
  ctx.createMediaElementSource(player).connect(fileBus);
  let cur = -1, curPath = '', url = '', loadSeq = 0, errors = 0;
  const title = (p) => p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  async function playIndex(i) {
    const pl = S.music.playlist; if (!pl.length) return;
    i = ((i % pl.length) + pl.length) % pl.length;
    const seq = ++loadSeq, p = pl[i];
    cur = i; curPath = p; api.now({ title: title(p), index: i });
    try {
      const { data, mime } = await api.readFile(p);
      if (seq !== loadSeq) return;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([data], { type: mime }));
      player.src = url;
      if (S.music.playing && S.music.source === 'files') await player.play();
      errors = 0;
    } catch (e) { if (seq === loadSeq) skipBroken(); }
  }
  function skipBroken() { if (++errors <= S.music.playlist.length) step(1); else { api.now({ title: 'Could not play these files', index: -1 }); } }
  function step(dir) {
    const n = S.music.playlist.length; if (!n) return;
    if (S.music.shuffle && n > 1 && dir > 0) { let j; do { j = Math.floor(Math.random() * n); } while (j === cur); playIndex(j); }
    else playIndex(cur + dir);
  }
  player.addEventListener('ended', () => step(1));
  player.addEventListener('error', () => { if (player.src) skipBroken(); });

  // ---------- Spotify mode: listen to what the PC is playing so the visuals can react (analysis only, never recorded or replayed) ----------
  let pcStream = null, pcAnalyser = null, pcBusy = false, pcFailed = false;
  async function listenToPC(on) {
    if (!on) { pcFailed = false; if (pcStream) { pcStream.getTracks().forEach((t) => t.stop()); pcStream = null; pcAnalyser = null; } return; }
    if (pcStream || pcBusy || pcFailed) return;
    pcBusy = true;
    try {
      const st = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      st.getVideoTracks().forEach((t) => t.stop());
      if (!st.getAudioTracks().length) throw new Error('no system audio');
      if (S.music.source !== 'spotify') { st.getTracks().forEach((t) => t.stop()); }
      else { pcStream = st; pcAnalyser = ctx.createAnalyser(); pcAnalyser.fftSize = 2048; pcAnalyser.smoothingTimeConstant = 0.75; ctx.createMediaStreamSource(st).connect(pcAnalyser); }
    } catch (e) { pcFailed = true; console.log('system audio not available: ' + e.message); }
    pcBusy = false;
  }

  // ---------- apply state ----------
  let fading = false;
  function apply() {
    if (ctx.state === 'suspended') ctx.resume();
    const m = S.music, t = T();
    if (!fading) master.gain.setTargetAtTime(m.playing ? 1 : 0, t, 0.35);
    const videoSound = S.video.sound && !!S.videoLeader;   // the video's own soundtrack takes over from the music
    musicBus.gain.setTargetAtTime(m.source === 'off' || m.source === 'spotify' || videoSound ? 0 : m.volume * m.volume * 1.4, t, videoSound ? 0.5 : 0.08);
    for (const k of Object.keys(N)) N[k].gain.setTargetAtTime(Math.pow(m.nature[k] || 0, 1.6), t, 0.1);
    // files
    const wantFiles = m.source === 'files' && m.playing && m.playlist.length > 0;
    if (curPath && !m.playlist.includes(curPath)) { player.pause(); player.removeAttribute('src'); player.load(); cur = -1; curPath = ''; api.now({ title: '', index: -1 }); }
    else if (curPath) { const i = m.playlist.indexOf(curPath); if (i !== cur) { cur = i; api.now({ title: title(curPath), index: i }); } }
    if (wantFiles) { if (!curPath) playIndex(0); else if (player.paused && player.src) player.play().catch(() => {}); }
    else if (!player.paused) player.pause();
    listenToPC(m.source === 'spotify');
    tickMusic();
  }
  api.on('state', (ns) => { S = ns; apply(); });
  api.on('cmd', (c) => {
    if (c.type === 'next') step(1);
    else if (c.type === 'prev') { if (player.currentTime > 4) player.currentTime = 0; else step(-1); }
    else if (c.type === 'play-index') playIndex(c.index);
    else if (c.type === 'fadeout') { fading = true; master.gain.cancelScheduledValues(T()); master.gain.setTargetAtTime(0, T(), 2.2); }
  });

  // ---------- clock: scheduling + levels for audio-reactive visuals ----------
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const binHz = ctx.sampleRate / analyser.fftSize;
  const band = (lo, hi) => { let s = 0, a = Math.max(1, Math.round(lo / binHz)), b = Math.round(hi / binHz); for (let i = a; i <= b; i++) s += bins[i]; return Math.min(1, (s / (b - a + 1) / 255) * 1.6); };
  let n = 0, silent = true; const slow = [0, 0, 0];
  // 64 log-spaced bands (30 Hz .. 14 kHz) with slow auto-gain so quiet ambient music still moves the visuals
  const NB = 64, edges = Array.from({ length: NB + 1 }, (_, i) => Math.max(1, Math.round((30 * Math.pow(14000 / 30, i / NB)) / binHz)));
  for (let i = 1; i <= NB; i++) if (edges[i] <= edges[i - 1]) edges[i] = edges[i - 1] + 1;
  let gpeak = 0.3; const slowB = new Float32Array(NB), specOut = new Array(NB).fill(0), waveOut = new Array(NB).fill(128);
  const td = new Uint8Array(analyser.fftSize);
  let bassAvg = 0, prevBass = 0, lastBeat = 0, aclock = 0, lastTick = performance.now(), wGain = 1;
  const beatTimes = [0, 0, 0, 0];
  setInterval(() => {
    if (++n % 6 === 0) { tickMusic(); const f = S.music.nature.fire; if (f > 0.01 && S.music.playing) { const k = Math.floor(rand(0, 4) * f + 0.5); for (let i = 0; i < k; i++) crackle(f); } }
    (pcAnalyser || analyser).getByteFrequencyData(bins);
    const raw = [band(30, 250), band(250, 2000), band(2000, 9000)];
    // emphasise movement over steady level, so drones don't pin the visuals at full brightness
    const l = raw.map((v, i) => { slow[i] += (v - slow[i]) * 0.02; return Math.max(0, Math.min(1, (v - 0.8 * slow[i]) * 2.6)); });
    const quiet = raw[0] + raw[1] + raw[2] < 0.001;
    const now = performance.now(), dt = Math.min(0.2, (now - lastTick) / 1000); lastTick = now;
    const vals = [];
    for (let b = 0; b < NB; b++) {
      let s = 0; const lo = edges[b], hi = Math.min(bins.length - 1, edges[b + 1]);
      for (let i = lo; i < hi; i++) s += bins[i];
      vals.push(quiet ? 0 : s / Math.max(1, hi - lo) / 255);
    }
    gpeak = Math.max(Math.max(...vals), gpeak * 0.998, 0.25);
    for (let b = 0; b < NB; b++) {
      const v = vals[b] / gpeak, tr = Math.max(0, v - slowB[b]) * 2.5;
      slowB[b] += (v - slowB[b]) * 0.05;
      specOut[b] = Math.round(Math.min(1, Math.pow(v, 1.8) * 0.7 + tr * 0.5) * 255);
    }
    (pcAnalyser || analyser).getByteTimeDomainData(td);
    let mx = 1; for (let i = 0; i < td.length; i += 8) mx = Math.max(mx, Math.abs(td[i] - 128));
    wGain += (Math.min(5, 90 / mx) - wGain) * 0.1;
    for (let i = 0; i < NB; i++) { let s = 0; for (let j = 0; j < 8; j++) s += td[i * 16 + j] - 128; waveOut[i] = quiet ? 128 : Math.round(Math.max(0, Math.min(255, 128 + (s / 8) * wGain))); }
    // beats: a sudden jump in bass compared with its recent average
    let bs = 0; const b0 = Math.max(1, Math.round(35 / binHz)), b1 = Math.round(160 / binHz);
    for (let i = b0; i <= b1; i++) bs += bins[i];
    const bass = bs / (b1 - b0 + 1) / 255, rise = bass - prevBass; prevBass = bass;   // unclipped: kicks show as a sharp rise
    if (!quiet && rise > 0.045 && bass > bassAvg + 0.06 && now - lastBeat > 280) { lastBeat = now; beatTimes.unshift(Date.now()); beatTimes.length = 4; }
    bassAvg += (bass - bassAvg) * 0.04;
    aclock += dt * l[0] * S.reactivity * 1.6;
    if (!(quiet && silent)) api.levels({ l, s: specOut, w: waveOut, b: beatTimes, a: aclock });
    silent = quiet;
  }, 33);

  apply();
})();
