/* Drift — the Surf stream's sender (docs/plans/streams.md §2, §3). This hidden window exists, on the PC hosting a hub, while
   anyone in the hub watches its Surf stream. It captures the hub's browser (main.js answers getDisplayMedia with the browser's
   own frame: never a screen or any other page), and sends that one capture to every watcher, each over a connection of
   their own, relayed through the hub's TURN server unless "Connect directly" is on. Each connection also carries a data
   channel: what the watcher does (their mouse and keys over the picture, the Surf bar, where their pointer is) comes back
   over it, and goes to main.js, which checks it and plays it into the browser. What the host's Drift says (the browser's
   tabs and address, everyone's pointers, notes) goes out over it.

   The window never sees a key or the hub. main.js hands it SDPs that chat.js has already checked against the watcher's
   signature, and its own offers go back to be signed. It applies exactly the SDP it was given. Once connected, it reports
   the certificate the other side really used, and chat.js closes the connection if that isn't the one they signed.
   When another tab comes to the front, the capture is taken again and swapped in on every connection (replaceTrack), so
   nobody has to connect again. */
(() => {
  const api = window.surfStream;
  const peers = new Map();        // watcher id -> { pc, dc, early, ready }
  let cfg = null, cert = null, cap = null, capGen = 0, startedOk = null, codecOrder = null;
  const started = new Promise((ok) => { startedOk = ok; });
  const log = (t) => api.send('log', String(t));

  // ---- the capture: the hub browser's tab in front, picture and sound, 30 frames a second ----
  async function grab() {
    for (let i = 0; i < 10; i++) {       // a page that has only just come in can't be captured straight away
      try {
        const st = await Promise.race([
          navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }),
          new Promise((_r, no) => setTimeout(() => no(new Error('no answer')), 3000)),
        ]);
        if (st && st.getVideoTracks().length) { for (const t of st.getVideoTracks()) t.contentHint = 'detail'; return st; }
      } catch (e) { if (i === 9) log('the hub\'s browser could not be captured: ' + e.message); }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }
  function capture() { if (!cap) { const g = ++capGen; cap = grab().then((st) => { if (g !== capGen && st) { st.getTracks().forEach((t) => t.stop()); return null; } return st; }); } return cap; }
  // Another tab came to the front (or its page came in): capture again, and swap the new tracks in everywhere.
  async function recapture() {
    const old = cap; cap = null;
    const st = await capture();
    if (!st) return;
    for (const p of peers.values()) {
      for (const s of p.pc.getSenders()) {
        const t = s.track ? st.getTracks().find((x) => x.kind === s.track.kind) : null;
        if (t) s.replaceTrack(t).catch(() => {});
      }
    }
    if (old) old.then((o) => { if (o && o !== st) o.getTracks().forEach((t) => t.stop()); });
  }
  // H.264 first when the graphics card encodes it efficiently (as page streaming does: renderer/app.js videoCodecs)
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
  const stereo = (sdp) => sdp.replace(/useinbandfec=1/g, 'useinbandfec=1;stereo=1;maxaveragebitrate=192000');       // it's a soundtrack, not a phone call

  // ---- one connection per watcher ----
  function close(id) {
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { p.pc.close(); } catch { /* closed */ }
    api.send('peer', { id, state: '' });
    if (!peers.size) { const c = cap; cap = null; capGen++; if (c) c.then((st) => st && st.getTracks().forEach((t) => t.stop())); }       // nobody left: the capture stops
  }
  async function offer(id, iceServers) {
    close(id);
    const p = { pc: null, dc: null, early: [], id };
    peers.set(id, p);
    const st = await capture(), codecs = await videoCodecs();
    if (peers.get(id) !== p) return;
    if (!st) { close(id); return; }
    const pc = p.pc = new RTCPeerConnection({ iceServers: iceServers || [], iceTransportPolicy: cfg.policy === 'all' ? 'all' : 'relay', certificates: [cert] });
    for (const t of st.getTracks()) pc.addTrack(t, st);
    if (codecs) for (const tr of pc.getTransceivers()) if (tr.sender.track && tr.sender.track.kind === 'video') { try { tr.setCodecPreferences(codecs); } catch { /* Chromium's own order then */ } }
    const dc = p.dc = pc.createDataChannel('surf', { ordered: true });
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data.length > 16384) return;
      let m = null; try { m = JSON.parse(e.data); } catch { return; }
      api.send('data', { from: id, m });
    };
    pc.onicecandidate = (e) => { if (e.candidate && peers.get(id) === p) api.send('signal', { to: id, d: { c: e.candidate.toJSON() } }); };
    pc.onconnectionstatechange = () => {
      if (peers.get(id) !== p) return;
      api.send('peer', { id, state: pc.connectionState });
      if (pc.connectionState === 'connected') checkCert(p);
      if (pc.connectionState === 'failed') close(id);       // they ask again
    };
    const o = await pc.createOffer();
    await pc.setLocalDescription({ type: 'offer', sdp: stereo(o.sdp) });
    const out = pc.getSenders().find((x) => x.track && x.track.kind === 'video'), prm = out && out.getParameters();
    if (prm && prm.encodings && prm.encodings[0]) { prm.encodings[0].maxBitrate = 8e6; out.setParameters(prm).catch(() => {}); }
    if (peers.get(id) === p) api.send('signal', { to: id, d: { sdp: { type: 'offer', sdp: pc.localDescription.sdp } } });
  }
  async function checkCert(p, tries = 0) {
    const st = await p.pc.getStats().catch(() => null);
    for (const s of st ? st.values() : []) {
      if (s.type !== 'transport' || !s.remoteCertificateId) continue;
      const c = st.get(s.remoteCertificateId);
      if (c) { api.send('cert', { peer: p.id, alg: c.fingerprintAlgorithm, fp: c.fingerprint }); return; }
    }
    if (tries < 20 && peers.get(p.id) === p) setTimeout(() => checkCert(p, tries + 1), 250);
  }
  const sendTo = (p, m) => { if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(JSON.stringify(m)); } catch { /* closing */ } } };

  api.on((m) => {
    if (m.t === 'start') {
      cfg = m;
      RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' }).then((c) => { cert = c; startedOk(); }, (e) => log('no certificate: ' + e.message));       // fresh for each time the stream window opens
      return;
    }
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
        case 'recapture': if (peers.size) await recapture(); break;
        case 'send': for (const [id, p] of peers) if (!m.to || m.to === id) sendTo(p, m.m); break;
        case 'ptrs': for (const [id, p] of peers) sendTo(p, { t: 'ptrs', list: (m.list || []).filter((q) => q.id !== id) }); break;       // everyone's but their own
        default: break;
      }
    }).catch((e) => log('stream: ' + (e && e.message || e)));
  });
  api.send('hello');

  // For main.js's checks: each connection's state, what it sends, and the certificates on both ends.
  window.surfStreamTest = async () => {
    const out = { peers: {}, capture: !!(cap && await cap) };
    for (const [id, p] of peers) {
      const r = { state: p.pc ? p.pc.connectionState : 'new', dc: p.dc ? p.dc.readyState : '' };
      const st = p.pc ? await p.pc.getStats() : new Map();
      for (const s of st.values()) {
        if (s.type === 'outbound-rtp' && s.kind === 'video') { r.framesOut = s.framesEncoded; r.bytesOut = s.bytesSent; r.size = `${s.frameWidth}x${s.frameHeight}`; }
        if (s.type === 'outbound-rtp' && s.kind === 'audio') r.audioOut = s.bytesSent;
        if (s.type === 'transport') {
          const pair = st.get(s.selectedCandidatePairId);
          if (pair) { const l = st.get(pair.localCandidateId), rc = st.get(pair.remoteCandidateId); r.path = `${l && l.candidateType} -> ${rc && rc.candidateType}`; }
        }
      }
      out.peers[id] = r;
    }
    return out;
  };
})();
