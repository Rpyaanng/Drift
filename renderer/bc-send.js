/* Drift — the broadcaster's side of a broadcast (docs/plans/broadcast.md §3, §7). This hidden window exists only while
   you're live, so the capture can't outlive the broadcast. It captures exactly the source main.js hands its
   getDisplayMedia (the monitor or window picked in the Broadcast tab, and nothing else), and sends that one capture to
   every viewer, each over a connection of their own, relayed through the hub's TURN server unless "Connect directly" is
   on. Each connection carries a data channel for pointers (§9): a viewer who chose to share their cursor sends where it
   is over the picture, and this passes it on to main.js (for the overlay on this PC's screen) and to the other viewers.
   Pointers are only pictures: nothing here can click, type or move anything.

   Sound (§8): main.js runs a helper that captures the picked application's sound (or, for a whole screen, everything
   but Drift's own, so the voice room isn't sent back), and hands the PCM here in 20 ms pieces. This turns it into one
   audio track (MediaStreamTrackGenerator) that every connection sends. Each connection always has an audio sender, so
   sound can be turned on or off while live without anyone reconnecting.

   The window never sees a key or the hub. main.js hands it SDPs that chat.js has already checked against the viewer's
   signature, and its own offers go back to be signed. It applies exactly the SDP it was given. Once connected, it reports
   the certificate the other side really used, and chat.js closes the connection if that isn't the one they signed. */
(() => {
  const api = window.bcSend;
  const peers = new Map();        // viewer id -> { id, pc, dc, early, sender, audio (its audio sender) }
  const ptrs = new Map();         // viewer id -> { id, x, y, at } (only those sharing their cursor)
  let cfg = null, cert = null, cap = null, capGen = 0, startedOk = null, codecOrder = null, paused = false, budget = 0, encoder = '';
  const started = new Promise((ok) => { startedOk = ok; });
  const log = (t) => api.send('log', String(t));
  const QUALITY = {       // the most each viewer is sent, and how the encoder should treat the picture
    auto: { fps: 30, cap: 4e6, hint: 'detail' },
    detail: { fps: 30, cap: 5e6, hint: 'detail' },
    motion: { fps: 60, cap: 6e6, hint: 'motion' },
  };
  const q = () => QUALITY[cfg && cfg.quality] || QUALITY.auto;
  const AUDIO_KBPS = 128;       // stereo Opus: plenty for music and games

  // ---- sound: PCM from main.js (48 kHz, stereo, 16-bit) becomes the broadcast's audio track ----
  let gen = null, genW = null, soundOn = false, soundAt = 0, soundFrames = 0;
  function soundTrack() {
    if (!gen && typeof MediaStreamTrackGenerator === 'function') {
      try { gen = new MediaStreamTrackGenerator({ kind: 'audio' }); genW = gen.writable.getWriter(); } catch (e) { log('no audio track: ' + e.message); gen = null; }
    }
    return gen;
  }
  function pcm(d) {
    if (!soundOn || !genW || !(d instanceof Uint8Array) || d.length < 4) return;
    const frames = Math.floor(d.length / 4), s = new Int16Array(frames * 2);
    new Uint8Array(s.buffer).set(d.subarray(0, frames * 4));
    const now = performance.now() * 1000;
    if (!soundAt || Math.abs(soundAt - now) > 200e3) soundAt = now;       // (re)start the clock, or catch up after a gap
    try { genW.write(new AudioData({ format: 's16', sampleRate: 48000, numberOfChannels: 2, numberOfFrames: frames, timestamp: Math.round(soundAt), data: s })).catch(() => {}); } catch { /* closing */ }
    soundAt += (frames / 48000) * 1e6; soundFrames += frames;
  }
  function setSound(on) {
    soundOn = !!on && !!soundTrack();
    for (const p of peers.values()) if (p.audio) p.audio.replaceTrack(soundOn ? gen : null).catch(() => {});
  }

  // ---- the capture: the picked source (or, for tests, a moving test pattern) ----
  function testPattern() {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const g = c.getContext('2d');
    let n = 0;
    setInterval(() => {
      n++;
      g.fillStyle = '#123'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = `hsl(${(n * 3) % 360} 80% 60%)`; g.fillRect(100 + (n * 9) % 1000, 200 + Math.sin(n / 10) * 150, 160, 160);
      g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText('Drift test broadcast ' + n, 40, 80);
    }, 33);
    return c.captureStream(30);
  }
  async function grab() {
    if (cfg.test) return testPattern();
    for (let i = 0; i < 3; i++) {
      try {
        const st = await Promise.race([
          navigator.mediaDevices.getDisplayMedia({ video: { frameRate: q().fps }, audio: false }),
          new Promise((_r, no) => setTimeout(() => no(new Error('no answer')), 5000)),
        ]);
        if (st && st.getVideoTracks().length) return st;
      } catch (e) { if (i === 2) log('the source could not be captured: ' + e.message); }
      await new Promise((r) => setTimeout(r, 400));
    }
    return null;
  }
  function watchTrack(st) {
    const t = st.getVideoTracks()[0];
    t.contentHint = q().hint;
    t.enabled = !paused;
    t.addEventListener('ended', () => { if (cap && st === capNow) api.send('ended'); });       // the window was closed, or the monitor unplugged
  }
  let capNow = null;
  function capture() {
    if (!cap) {
      const g = ++capGen;
      cap = grab().then((st) => {
        if (g !== capGen) { if (st) st.getTracks().forEach((t) => t.stop()); return null; }
        if (!st) { api.send('ended', 'capture'); return null; }
        capNow = st; watchTrack(st); return st;
      });
    }
    return cap;
  }
  // Switch source: capture the new one and swap it in on every connection (replaceTrack), so nobody drops.
  async function recapture() {
    const old = capNow; cap = null; capNow = null;
    const st = await capture();
    if (!st) return;
    const t = st.getVideoTracks()[0];
    for (const p of peers.values()) if (p.sender) p.sender.replaceTrack(t).catch(() => {});
    if (old) old.getTracks().forEach((x) => x.stop());
    fresh = Date.now();
    tellAll({ t: 'state', paused, stalled: false });
  }
  // H.264 first when the graphics card encodes it efficiently (as page streaming does: renderer/app.js videoCodecs)
  function videoCodecs() {
    if (!codecOrder) codecOrder = (async () => {
      const all = (RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video') || {}).codecs || [];
      const h264 = all.filter((c) => /^video\/h264$/i.test(c.mimeType) && /packetization-mode=1/.test(c.sdpFmtpLine || ''));
      for (const c of h264) {
        const r = await navigator.mediaCapabilities.encodingInfo({ type: 'webrtc', video: { contentType: `${c.mimeType};${c.sdpFmtpLine}`, width: 1920, height: 1080, bitrate: 6e6, framerate: 30 } }).catch(() => null);
        if (r && r.supported && r.powerEfficient) return [c, ...all.filter((x) => x !== c)];
      }
      return null;
    })().catch(() => null);
    return codecOrder;
  }

  // ---- bitrate: each viewer gets min(quality cap, upload budget / viewers) (§7). The budget is the most the
  // connections have said they could send (availableOutgoingBitrate) over the first seconds; 20 Mb/s until known. Below
  // about 1 Mb/s each, or on the processor's encoder with several viewers (spike B), the picture is made smaller instead. ----
  function soft() { return !!encoder && !/MediaFoundation|NVENC|QuickSync|AMF|Hardware|VideoToolbox|D3D/i.test(encoder); }
  function applyRates() {
    const n = Math.max(1, peers.size), per = Math.min(q().cap, (budget || 20e6) / n);
    const st = capNow && capNow.getVideoTracks()[0], h = st ? (st.getSettings().height || 1080) : 1080;
    let scale = per < 1e6 ? 2 : 1;
    if (soft() && n > 1) scale = Math.max(scale, h / 720);
    for (const p of peers.values()) {
      if (!p.sender) continue;
      const prm = p.sender.getParameters();
      if (!prm.encodings || !prm.encodings[0]) continue;
      prm.encodings[0].maxBitrate = Math.round(Math.max(300e3, per));
      prm.encodings[0].scaleResolutionDownBy = Math.max(1, scale);
      prm.encodings[0].maxFramerate = q().fps;
      prm.degradationPreference = q().hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
      p.sender.setParameters(prm).catch(() => {});
      if (p.audio) {
        const ap = p.audio.getParameters();
        if (ap.encodings && ap.encodings[0] && ap.encodings[0].maxBitrate !== AUDIO_KBPS * 1000) { ap.encodings[0].maxBitrate = AUDIO_KBPS * 1000; p.audio.setParameters(ap).catch(() => {}); }
      }
    }
  }

  // ---- one connection per viewer ----
  function close(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { p.pc.close(); } catch { /* closed */ }
    api.send('peer', { id, state: '' });
    if (ptrs.delete(id)) ptrsChanged();
    applyRates();
  }
  async function offer(id, iceServers) {
    close(id);
    const p = { id, pc: null, dc: null, early: [], sender: null };
    peers.set(id, p);
    const st = await capture(), codecs = await videoCodecs();
    if (peers.get(id) !== p) return;
    if (!st) { close(id); return; }
    const pc = p.pc = new RTCPeerConnection({ iceServers: iceServers || [], iceTransportPolicy: cfg.policy === 'all' ? 'all' : 'relay', certificates: [cert], bundlePolicy: 'max-bundle' });
    p.sender = pc.addTrack(st.getVideoTracks()[0], st);
    p.audio = pc.addTransceiver('audio', { direction: 'sendonly', streams: [st] }).sender;       // silent until there's sound
    if (soundOn && gen) p.audio.replaceTrack(gen).catch(() => {});
    if (codecs) for (const tr of pc.getTransceivers()) { if (tr.sender === p.audio) continue; try { tr.setCodecPreferences(codecs); } catch { /* Chromium's own order then */ } }
    const dc = p.dc = pc.createDataChannel('ptr', { ordered: false, maxRetransmits: 0 });
    dc.onopen = () => sendTo(p, { t: 'state', paused, stalled: stalled() });
    dc.onmessage = (e) => onData(p, e.data);
    pc.onicecandidate = (e) => { if (e.candidate && peers.get(id) === p) api.send('signal', { to: id, d: { c: e.candidate.toJSON() } }); };
    pc.onconnectionstatechange = () => {
      if (peers.get(id) !== p) return;
      api.send('peer', { id, state: pc.connectionState });
      if (pc.connectionState === 'connected') { checkCert(p); applyRates(); }
      if (pc.connectionState === 'failed') close(id);       // they ask again
    };
    await pc.setLocalDescription(await pc.createOffer());
    applyRates();
    if (peers.get(id) === p) api.send('signal', { to: id, d: { sdp: { type: 'offer', sdp: pc.localDescription.sdp } } });
  }
  // The certificate the viewer really used. Over a relay, Chromium's stats now and then never list it, so the DTLS
  // transport is asked directly too (its DER certificate, hashed as the SDP's fingerprint is: SHA-256).
  async function remotePrint(pc) {
    const st = await pc.getStats().catch(() => null);
    for (const s of st ? st.values() : []) {
      if (s.type !== 'transport' || !s.remoteCertificateId) continue;
      const c = st.get(s.remoteCertificateId);
      if (c) return { alg: c.fingerprintAlgorithm, fp: c.fingerprint };
    }
    const tr = ((pc.getSenders()[0] || {}).transport) || (pc.sctp && pc.sctp.transport);
    const der = tr && tr.state === 'connected' && tr.getRemoteCertificates ? tr.getRemoteCertificates() : [];
    if (!der.length) return null;
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', der[0]));
    return { alg: 'sha-256', fp: [...h].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':') };
  }
  async function checkCert(p, tries = 0) {
    const c = await remotePrint(p.pc);
    if (c) { if (peers.get(p.id) === p) api.send('cert', { peer: p.id, ...c }); return; }
    if (tries < 40 && peers.get(p.id) === p) setTimeout(() => checkCert(p, tries + 1), 250);
  }
  const sendTo = (p, m) => { if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(JSON.stringify(m)); } catch { /* closing */ } } };
  const tellAll = (m) => { for (const p of peers.values()) sendTo(p, m); };

  // ---- pointers (§9): only from viewers who turned "Share my cursor" on. Fractions of the video frame. ----
  const rate = new Map();       // viewer -> { at, n, pingAt }
  function onData(p, raw) {
    if (typeof raw !== 'string' || raw.length > 512) return;
    let m = null; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const now = Date.now(), r = rate.get(p.id) || { at: 0, n: 0, pingAt: 0 };
    rate.set(p.id, r);
    if (now - r.at >= 1000) { r.at = now; r.n = 0; }
    if (++r.n > 40) return;       // at most 30 a second are sent; a flood is dropped
    const ok = (v) => typeof v === 'number' && v >= 0 && v <= 1;
    if (m.t === 'ptr') {
      if (m.gone || !ok(m.x) || !ok(m.y)) { if (ptrs.delete(p.id)) ptrsChanged(); return; }
      ptrs.set(p.id, { id: p.id, x: m.x, y: m.y, at: now });
      ptrsChanged();
    } else if (m.t === 'ping' && ok(m.x) && ok(m.y)) {
      if (now - r.pingAt < 1000) return;       // one "look here" a second each
      r.pingAt = now;
      api.send('ping', { id: p.id, x: m.x, y: m.y });
      for (const o of peers.values()) if (o !== p) sendTo(o, { t: 'ping', id: p.id, x: m.x, y: m.y });
    }
  }
  let ptrTimer = null;
  function ptrsChanged() {
    if (ptrTimer) return;
    ptrTimer = setTimeout(() => {       // at most 25 times a second
      ptrTimer = null;
      const list = [...ptrs.values()].map(({ id, x, y }) => ({ id, x, y }));
      api.send('ptrs', list);
      for (const p of peers.values()) sendTo(p, { t: 'ptrs', list: list.filter((x) => x.id !== p.id) });       // everyone's but their own
    }, 40);
  }

  // ---- how it's going: frames, bitrate, the encoder, and a picture that stopped (§10 spike D: a minimised window
  // sends no frames but its track stays live; a resized one drops to about 1 frame a second) ----
  let lastFrames = -1, lastBytes = 0, lastAt = 0, frameAt = Date.now(), fresh = Date.now(), fps = 0, kbps = 0, wasStalled = false;
  const stalled = () => !paused && !cfg.test && Date.now() - frameAt > 1500;
  async function stats() {
    let frames = 0, bytes = 0, avail = 0;
    for (const p of peers.values()) {
      const st = p.pc ? await p.pc.getStats().catch(() => null) : null;
      for (const s of st ? st.values() : []) {
        if (s.type === 'outbound-rtp' && s.kind === 'video') { frames = Math.max(frames, s.framesEncoded || 0); bytes += s.bytesSent || 0; if (s.encoderImplementation) encoder = s.encoderImplementation; }
        if (s.type === 'candidate-pair' && s.nominated && s.availableOutgoingBitrate) avail += s.availableOutgoingBitrate;
      }
    }
    const now = Date.now(), dt = (now - lastAt) / 1000;
    if (lastAt && dt > 0) { fps = lastFrames >= 0 && frames >= lastFrames ? (frames - lastFrames) / dt : 0; kbps = bytes >= lastBytes ? ((bytes - lastBytes) * 8) / dt / 1000 : 0; }
    if (frames !== lastFrames) frameAt = now;
    if (!peers.size) frameAt = now;
    lastFrames = frames; lastBytes = bytes; lastAt = now;
    if (avail && now - fresh < 15000) { const b = budget; budget = Math.max(budget, avail * 0.8); if (b !== budget) applyRates(); }
    const st = stalled(), slow = !st && !paused && peers.size > 0 && now - fresh > 5000 && fps > 0 && fps < 3;
    if (st !== wasStalled) { wasStalled = st; tellAll({ t: 'state', paused, stalled: st }); }
    const size = capNow && capNow.getVideoTracks()[0] ? capNow.getVideoTracks()[0].getSettings() : {};
    api.send('stats', { fps: Math.round(fps), kbps: Math.round(kbps), encoder, hardware: encoder ? !soft() : null, viewers: peers.size, stalled: st, slow, paused, size: size.width ? `${size.width}×${size.height}` : '' });
  }
  setInterval(() => { if (cfg) stats().catch(() => {}); }, 2000);

  api.on((m) => {
    if (m.t === 'start') {
      cfg = m;
      RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' }).then((c) => { cert = c; startedOk(); capture(); }, (e) => log('no certificate: ' + e.message));       // fresh for each broadcast
      return;
    }
    if (m.t === 'pcm') { pcm(m.d); return; }
    started.then(async () => {
      switch (m.t) {
        case 'viewer': await offer(String(m.id), m.iceServers); break;
        case 'sdp': {
          const p = peers.get(String(m.from));
          if (!p || !p.pc || !m.sdp || m.sdp.type !== 'answer') break;
          await p.pc.setRemoteDescription({ type: 'answer', sdp: String(m.sdp.sdp) });
          for (const c of p.early.splice(0)) p.pc.addIceCandidate(c).catch(() => {});
          break;
        }
        case 'candidate': { const p = peers.get(String(m.from)); if (!p || !m.c) break; if (p.pc && p.pc.remoteDescription) await p.pc.addIceCandidate(m.c).catch(() => {}); else p.early.push(m.c); break; }
        case 'left': close(String(m.id)); break;
        case 'switch': await recapture(); break;
        case 'pause': paused = !!m.on; if (capNow) capNow.getVideoTracks().forEach((t) => { t.enabled = !paused; }); tellAll({ t: 'state', paused, stalled: false }); frameAt = Date.now(); break;
        case 'quality': cfg.quality = m.quality; if (capNow) capNow.getVideoTracks().forEach((t) => { t.contentHint = q().hint; }); applyRates(); break;
        case 'sound': setSound(m.on); break;
        case 'unptr': if (ptrs.delete(String(m.id))) ptrsChanged(); break;       // that viewer stopped sharing, or the broadcaster hid them
        default: break;
      }
    }).catch((e) => log('broadcast: ' + (e && e.message || e)));
  });
  api.send('hello');

  // For main.js's checks: each connection's state, what it sends, and the certificates.
  window.bcSendTest = async () => {
    const out = { capture: !!capNow, paused, encoder, sound: soundOn, soundFrames, peers: {} };
    for (const [id, p] of peers) {
      const r = { state: p.pc ? p.pc.connectionState : 'new', dc: p.dc ? p.dc.readyState : '' };
      const st = p.pc ? await p.pc.getStats() : new Map();
      for (const s of st.values()) {
        if (s.type === 'outbound-rtp' && s.kind === 'video') { r.framesOut = s.framesEncoded; r.bytesOut = s.bytesSent; }
        if (s.type === 'outbound-rtp' && s.kind === 'audio') r.audioOut = s.bytesSent;
        if (s.type === 'transport') {
          const pair = st.get(s.selectedCandidatePairId);
          if (pair) { const l = st.get(pair.localCandidateId), rc = st.get(pair.remoteCandidateId); r.path = `${l && l.candidateType} -> ${rc && rc.candidateType}`; }
        }
      }
      const prm = p.sender ? p.sender.getParameters() : null;
      r.maxBitrate = prm && prm.encodings && prm.encodings[0] ? prm.encodings[0].maxBitrate : 0;
      out.peers[id] = r;
    }
    out.track = capNow ? capNow.getVideoTracks()[0].id : '';
    return out;
  };
})();
