/* Drift — the call (docs/plans/voice-and-chat.md §5). This hidden window exists only while you're in a call: it opens
   the microphone when the call starts and lets go of it when the window closes. It sends one audio track to everyone
   else in the call and plays each of theirs: a mesh, up to 8 people.

   It never sees a key or the hub. main.js hands it SDPs that chat.js has already checked against the sender's signature,
   and it sends its own SDPs back to be signed. It applies exactly the SDP it was given, apart from asking for DTX on the
   Opus line (which isn't signed; nothing here touches a=fingerprint). Once connected, it reports the certificate the
   other side really used, and chat.js closes the connection if that isn't the one their signed SDP promised. */
(() => {
  const api = window.voice;
  const peers = new Map();        // member id -> { pc, offerer, chain, early, el, an, vol, restarts, state, loudAt, max }
  let cfg = null, cert = null, local = null, ctx = null, micOk = false, localAn = null;
  let muted = false, deaf = false, ptt = false, keyDown = false, startedOk = null;
  const started = new Promise((ok) => { startedOk = ok; });
  const log = (t) => api.send('log', String(t));

  // Ask the other side's encoder for DTX, so a quiet person sends almost nothing (it has to be asked for: spike 1).
  // Only the Opus fmtp line changes; the fingerprints are checked to be exactly as signed.
  const prints = (sdp) => (sdp.match(/^a=fingerprint:[^\r\n]*/gm) || []).join('\n');
  function dtx(sdp) {
    const out = sdp.replace(/^(a=fmtp:\d+ [^\r\n]*useinbandfec=1)(?![^\r\n]*usedtx)/gm, '$1;usedtx=1');
    if (prints(out) !== prints(sdp)) throw new Error('the DTX edit touched a fingerprint');
    return out;
  }

  // ---- the microphone (or, for tests, a steady tone) ----
  async function openMic() {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    if (cfg.tone) {
      const osc = ctx.createOscillator(), dst = ctx.createMediaStreamDestination(), g = ctx.createGain();
      osc.frequency.value = 440; g.gain.value = 0.25; osc.connect(g).connect(dst); osc.start();
      local = dst.stream; micOk = true;
    } else {
      try {
        local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        micOk = true;
        local.getAudioTracks()[0].addEventListener('ended', () => { micOk = false; applyTalk(); });       // unplugged
      } catch (e) {
        log('no microphone: ' + e.message);
        micOk = false; local = ctx.createMediaStreamDestination().stream;       // silence, so you can still listen
      }
    }
    if (micOk) { localAn = ctx.createAnalyser(); localAn.fftSize = 1024; ctx.createMediaStreamSource(local).connect(localAn); }
  }
  // Muting (and hold-to-talk) switches the track off rather than stopping it, so talking starts at once and the
  // microphone light stays honest: grey while it's open but nobody can hear you, red while they can.
  const talking = () => micOk && !muted && !deaf && (!ptt || keyDown);
  function applyTalk() {
    for (const t of local ? local.getAudioTracks() : []) t.enabled = talking();
    for (const p of peers.values()) if (p.el) p.el.muted = deaf;
    api.send('state', { mic: !micOk ? 'off' : talking() ? 'live' : 'open', micOk, muted, deaf, ptt });
  }

  // ---- one connection per person ----
  function peer(id, offerer) {
    let p = peers.get(id);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers, iceTransportPolicy: cfg.policy, certificates: [cert], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    p = { id, pc, offerer, chain: Promise.resolve(), early: [], el: null, an: null, vol: cfg.volumes[id] ?? 1, restarts: 0, state: '', loudAt: 0, max: 0, timer: null };
    peers.set(id, p);
    for (const t of local.getAudioTracks()) pc.addTrack(t, local);
    pc.onicecandidate = (e) => { if (e.candidate) api.send('signal', { to: id, d: { c: e.candidate.toJSON() } }); };
    pc.ontrack = (e) => hear(p, e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => onState(p);
    p.timer = setTimeout(() => { if (pc.connectionState !== 'connected') setState(p, 'failed'); }, 30000);
    setState(p, 'connecting');
    return p;
  }
  function setState(p, s) { if (p.state === s) return; p.state = s; api.send('peer', { id: p.id, state: s }); }
  function onState(p) {
    const s = p.pc.connectionState;
    if (s === 'connected') { clearTimeout(p.timer); setState(p, 'connected'); checkCert(p); }
    else if (s === 'disconnected') setState(p, 'reconnecting');
    else if (s === 'failed') {
      if (p.offerer && p.restarts < 2) { p.restarts++; setState(p, 'reconnecting'); offer(p, true); }       // a fresh set of paths; signed like any offer
      else setState(p, 'failed');
    }
  }
  const run = (p, f) => { p.chain = p.chain.then(f).catch((e) => log(`${p.id}: ${e.message}`)); };
  function offer(p, restart = false) {
    run(p, async () => {
      await p.pc.setLocalDescription(await p.pc.createOffer(restart ? { iceRestart: true } : {}));
      api.send('signal', { to: p.id, d: { sdp: { type: 'offer', sdp: p.pc.localDescription.sdp } } });
    });
  }
  function onSdp(from, sdp) {
    if (sdp.type !== 'offer' && !peers.has(from)) return;       // an answer to nothing we asked
    const p = peer(from, false);
    run(p, async () => {
      await p.pc.setRemoteDescription({ type: sdp.type, sdp: dtx(sdp.sdp) });
      for (const c of p.early.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
      if (sdp.type === 'offer') {
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        api.send('signal', { to: from, d: { sdp: { type: 'answer', sdp: p.pc.localDescription.sdp } } });
      }
      if (p.pc.connectionState === 'connected') checkCert(p);       // a renegotiation: check again
    });
  }
  function onCandidate(from, c) {
    const p = peers.get(from);
    if (p) run(p, async () => { if (p.pc.remoteDescription) await p.pc.addIceCandidate(c).catch(() => {}); else p.early.push(c); });
  }
  // The certificate the other side really used, for chat.js to hold against their signed fingerprint.
  async function checkCert(p, tries = 0) {
    const st = await p.pc.getStats().catch(() => null);
    for (const s of st ? st.values() : []) {
      if (s.type !== 'transport' || !s.remoteCertificateId) continue;
      const c = st.get(s.remoteCertificateId);
      if (c) { api.send('cert', { peer: p.id, alg: c.fingerprintAlgorithm, fp: c.fingerprint }); return; }
    }
    if (tries < 20 && peers.get(p.id) === p) setTimeout(() => checkCert(p, tries + 1), 250);
  }
  function close(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id); clearTimeout(p.timer);
    try { p.pc.close(); } catch { /* closed */ }
    if (p.el) { p.el.pause(); p.el.srcObject = null; }
  }

  // ---- hearing them: an <audio> element plays each voice (Chromium only hands a remote stream to Web Audio while one
  // does), and an analyser on it drives the speaking ring ----
  function hear(p, stream) {
    if (p.el) { p.el.srcObject = stream; return; }
    p.el = new Audio();
    p.el.srcObject = stream; p.el.volume = p.vol; p.el.muted = deaf;
    p.el.play().catch(() => {});
    p.an = ctx.createAnalyser(); p.an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(p.an);
  }
  const buf = new Float32Array(1024);
  const level = (an) => { if (!an) return 0; an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };
  let said = '', me = { loudAt: 0, max: 0 };
  setInterval(() => {
    if (!ctx) return;
    const now = Date.now(), out = [];
    const look = (o, an, id, can) => { const l = can ? level(an) : 0; o.max = Math.max(o.max, l); if (l > 0.02) o.loudAt = now; if (now - o.loudAt < 300) out.push(id); };
    look(me, localAn, cfg.me, talking());
    for (const p of peers.values()) look(p, p.an, p.id, !deaf);
    const key = out.sort().join();
    if (key !== said) { said = key; api.send('speaking', out); }
  }, 100);

  // ---- what main.js says ----
  async function start(m) {
    cfg = { ...m, volumes: m.volumes || {} };
    muted = !!m.muted; deaf = !!m.deaf; ptt = !!m.ptt;
    cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });       // a fresh one for each call
    await openMic();
    applyTalk();
    startedOk();
    for (const id of m.peers) offer(peer(id, true));       // the newcomer offers to everyone already in the call
  }
  api.on((m) => {
    if (m.t === 'start') { start(m).catch((e) => api.send('failed', String(e && e.message || e))); return; }
    started.then(() => {
      switch (m.t) {
        case 'sdp': onSdp(m.from, m.sdp); break;
        case 'candidate': onCandidate(m.from, m.c); break;
        case 'left': case 'close': close(m.id); break;
        case 'mute': muted = !!m.on; applyTalk(); break;
        case 'deafen': deaf = !!m.on; applyTalk(); break;
        case 'ptt': ptt = !!m.on; keyDown = false; applyTalk(); break;
        case 'key': keyDown = !!m.down; applyTalk(); break;
        case 'volume': { const p = peers.get(m.id); cfg.volumes[m.id] = Math.max(0, Math.min(1, +m.v || 0)); if (p) { p.vol = cfg.volumes[m.id]; if (p.el) p.el.volume = p.vol; } break; }
        default: break;
      }
    });
  });
  api.send('hello');

  // For main.js's checks: each connection's state, path, sound and certificates.
  window.voiceTest = async () => {
    const out = { me: cfg && cfg.me, mic: micOk, peers: {} };
    for (const [id, p] of peers) {
      const st = await p.pc.getStats(), r = { state: p.pc.connectionState, level: +p.max.toFixed(3), signed: prints(p.pc.remoteDescription ? p.pc.remoteDescription.sdp : '').toLowerCase() };
      p.max = 0;
      for (const s of st.values()) {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') { r.bytesIn = s.bytesReceived; r.packetsIn = s.packetsReceived; }
        if (s.type === 'transport') {
          const c = st.get(s.remoteCertificateId);
          if (c) r.dtls = `a=fingerprint:${c.fingerprintAlgorithm} ${c.fingerprint}`.toLowerCase();
          const pair = st.get(s.selectedCandidatePairId);
          if (pair) { const l = st.get(pair.localCandidateId), rc = st.get(pair.remoteCandidateId); r.path = `${l && l.candidateType} -> ${rc && rc.candidateType}`; }
        }
      }
      out.peers[id] = r;
    }
    return out;
  };
})();
