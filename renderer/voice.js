/* Drift — the voice room (docs/plans/broadcast.md §1). This hidden window exists while you listen in your active hub's
   voice room. It never opens the microphone until you press Talk, and closes it again when you stop: before that,
   every connection it makes is receive-only. Each connection has one audio transceiver from the start; talking puts
   the microphone's track on it with replaceTrack, so nothing is renegotiated and talking starts at once.

   chat.js decides which connections to have (everyone, while the room is small; else only where someone talks) and who
   makes each offer, and tells this window through main.js. The window never sees a key or the hub. main.js hands it
   SDPs that chat.js has already checked against the sender's signature, and it sends its own SDPs back to be signed.
   It applies exactly the SDP it was given, apart from asking for DTX on the Opus line (which isn't signed; nothing here
   touches a=fingerprint). Once connected, it reports the certificate the other side really used, and chat.js closes
   the connection if that isn't the one their signed SDP promised. */
(() => {
  const api = window.voice;
  const peers = new Map();        // member id -> { pc, tr, offerer, chain, early, el, an, vol, restarts, state, loudAt, max }
  let cfg = null, cert = null, local = null, ctx = null, micOk = false, localAn = null, micSrc = null;
  let master = 1;       // the volume mixer's master: every voice is scaled by it
  let talk = false, ptt = false, keyDown = false, startedOk = null, opening = null, opens = 0;
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

  // ---- the microphone (or, for tests, a steady tone): opened on Talk, closed (not just muted) when you stop ----
  async function openMic() {
    if (local) return;
    opens++;
    if (cfg.tone) {
      const osc = ctx.createOscillator(), dst = ctx.createMediaStreamDestination(), g = ctx.createGain();
      osc.frequency.value = 440; g.gain.value = 0.25; osc.connect(g).connect(dst); osc.start();
      local = dst.stream; local.stopTone = () => osc.stop(); micOk = true;
    } else {
      try {
        local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        micOk = true;
        local.getAudioTracks()[0].addEventListener('ended', () => { micOk = false; applyTalk(); });       // unplugged
      } catch (e) {
        log('no microphone: ' + e.message);
        micOk = false; local = null;
        return;
      }
    }
    localAn = ctx.createAnalyser(); localAn.fftSize = 1024;
    micSrc = ctx.createMediaStreamSource(local); micSrc.connect(localAn);
  }
  function closeMic() {
    if (!local) return;
    for (const t of local.getTracks()) t.stop();       // stopped, so Windows' microphone light goes out too
    if (local.stopTone) local.stopTone();
    if (micSrc) micSrc.disconnect();
    local = null; localAn = null; micSrc = null; micOk = false;
  }
  const track = () => (local ? local.getAudioTracks()[0] || null : null);
  // Hold-to-talk switches the track off rather than taking it away, so talking starts at once once Talk is on.
  const sending = () => talk && micOk && (!ptt || keyDown);
  async function setTalk(on) {
    talk = on;
    if (talk) {
      opening = opening || openMic().finally(() => { opening = null; });
      await opening;
      if (!talk) { closeMic(); return applyTalk(); }       // Talk was turned off again while the microphone opened
    } else closeMic();
    const t = track();
    for (const p of peers.values()) if (p.tr) p.tr.sender.replaceTrack(talk ? t : null).catch((e) => log(`${p.id}: ${e.message}`));
    applyTalk();
  }
  function applyTalk() {
    const t = track();
    if (t) t.enabled = sending();
    // closed: the microphone isn't open; none: Talk is on but there's no microphone; open: it's open but hold-to-talk isn't held; live: people can hear you
    api.send('state', { mic: !talk ? 'closed' : !micOk ? 'none' : sending() ? 'live' : 'open', micOk, talk, ptt });
  }

  // ---- one connection per person chat.js wants us connected to ----
  function peer(id, offerer) {
    let p = peers.get(id);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers, iceTransportPolicy: cfg.policy, certificates: [cert], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    // Always sendrecv: with no track it sends nothing, and replaceTrack later starts the sound without a new offer.
    // The offerer makes it now; the answerer takes the one the offer brings (setRemoteDescription doesn't reuse one made
    // with addTransceiver), in onSdp.
    const tr = offerer ? pc.addTransceiver('audio', { direction: 'sendrecv' }) : null;
    p = { id, pc, tr, offerer, chain: Promise.resolve(), early: [], el: null, an: null, vol: cfg.volumes[id] ?? 1, restarts: 0, state: '', loudAt: 0, max: 0, timer: null };
    peers.set(id, p);
    if (tr && talk && track()) tr.sender.replaceTrack(track()).catch(() => {});
    pc.onicecandidate = (e) => { if (e.candidate) api.send('signal', { to: id, d: { c: e.candidate.toJSON() } }); };
    pc.ontrack = (e) => hear(p, new MediaStream([e.track]));
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
        if (!p.tr) {
          p.tr = p.pc.getTransceivers().find((x) => x.receiver.track.kind === 'audio' && !x.stopped) || null;
          if (p.tr && talk && track()) await p.tr.sender.replaceTrack(track()).catch(() => {});
        }
        if (p.tr) p.tr.direction = 'sendrecv';
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
    api.send('peer', { id, state: '' });
  }
  // chat.js's list of connections to have: make the ones this PC offers, close the ones no longer wanted. (Those the
  // other side offers are made when their offer arrives.)
  function setPeers(list) {
    const keepIds = new Set(list.map((x) => x.id));
    for (const id of [...peers.keys()]) if (!keepIds.has(id)) close(id);
    for (const x of list) if (x.offer && !peers.has(x.id)) offer(peer(x.id, true));
  }

  // ---- hearing them: an <audio> element plays each voice (Chromium only hands a remote stream to Web Audio while one
  // does), and an analyser on it drives the speaking ring ----
  function hear(p, stream) {
    if (p.el) { p.el.srcObject = stream; return; }
    p.el = new Audio();
    p.el.srcObject = stream; p.el.volume = p.vol * master;
    p.el.play().catch(() => {});
    p.an = ctx.createAnalyser(); p.an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(p.an);
  }
  const buf = new Float32Array(1024);
  const level = (an) => { if (!an) return 0; an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };
  let said = '';
  const me = { loudAt: 0, max: 0 };
  setInterval(() => {
    if (!ctx) return;
    const now = Date.now(), out = [];
    const look = (o, an, id, can) => { const l = can ? level(an) : 0; o.max = Math.max(o.max, l); if (l > 0.02) o.loudAt = now; if (now - o.loudAt < 300) out.push(id); };
    look(me, localAn, cfg.me, sending());
    for (const p of peers.values()) look(p, p.an, p.id, true);
    const key = out.sort().join();
    if (key !== said) { said = key; api.send('speaking', out); }
  }, 100);

  // ---- what main.js says ----
  async function start(m) {
    cfg = { ...m, volumes: m.volumes || {} };
    if (isFinite(m.master)) master = Math.max(0, Math.min(1, +m.master));
    ptt = !!m.ptt;
    ctx = new AudioContext({ latencyHint: 'interactive' });
    cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });       // a fresh one each time you enter a room
    startedOk();
    applyTalk();
    if (m.talk) await setTalk(true);
  }
  api.on((m) => {
    if (m.t === 'start') { start(m).catch((e) => api.send('failed', String(e && e.message || e))); return; }
    started.then(() => {
      switch (m.t) {
        case 'peers': setPeers(Array.isArray(m.list) ? m.list : []); break;
        case 'sdp': onSdp(m.from, m.sdp); break;
        case 'candidate': onCandidate(m.from, m.c); break;
        case 'left': case 'close': close(m.id); break;
        case 'talk': setTalk(!!m.on); break;
        case 'ptt': ptt = !!m.on; keyDown = false; applyTalk(); break;
        case 'key': keyDown = !!m.down; applyTalk(); break;
        case 'volume': { const p = peers.get(m.id); cfg.volumes[m.id] = Math.max(0, Math.min(1, +m.v || 0)); if (p) { p.vol = cfg.volumes[m.id]; if (p.el) p.el.volume = p.vol * master; } break; }
        case 'master': master = Math.max(0, Math.min(1, +m.v || 0)); for (const p of peers.values()) if (p.el) p.el.volume = p.vol * master; break;       // the volume mixer's master
        default: break;
      }
    });
  });
  api.send('hello');

  // For main.js's checks: each connection's state, path, sound and certificates, and whether the microphone was ever opened.
  window.voiceTest = async () => {
    const out = { me: cfg && cfg.me, mic: micOk, micOpens: opens, talk, peers: {} };
    for (const [id, p] of peers) {
      const st = await p.pc.getStats(), r = { state: p.pc.connectionState, level: +p.max.toFixed(3), signed: prints(p.pc.remoteDescription ? p.pc.remoteDescription.sdp : '').toLowerCase() };
      p.max = 0;
      for (const s of st.values()) {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') { r.bytesIn = s.bytesReceived; r.packetsIn = s.packetsReceived; }
        if (s.type === 'outbound-rtp' && s.kind === 'audio') r.bytesOut = s.bytesSent;
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
