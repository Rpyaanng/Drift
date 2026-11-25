/* Drift — the transfer window (docs/plans/files.md): hidden, one data channel for each file being sent or received.
   main.js gives it each transfer (send or recv, with the relay or STUN servers chat.js worked out), the other end's SDP and
   candidates once chat.js has checked their signatures, and `verified` once the certificate the other end really used is
   the one it signed. Nothing about the file goes over the channel before that.

   Over the channel (ordered and reliable), text is a message and binary is a file's bytes:
     sender -> receiver   { t: 'head', name, size, mime, piece, root, n }, then { t: 'hashes', at, list } until all n are sent;
                          for each piece asked for, { t: 'piece', i } and then its bytes, CHUNK at a time
     receiver -> sender   { t: 'get', i } (up to AHEAD pieces at once), { t: 'done' } when every piece checked out
     either               { t: 'cancel', why }
   The receiver checks each piece (files.js, through main.js) and asks again for one that arrives damaged. */
(() => {
  const api = window.ft;
  const log = (t) => api.send('log', String(t));
  const CHUNK = 64 * 1024, HIGH = 4 * 1024 * 1024, LOW = 1024 * 1024, BLOCK = 1024 * 1024, AHEAD = 4, HASHES_AT_ONCE = 2000;
  const xs = new Map();       // transfer id -> its state
  let certP = null;
  const cert = () => (certP = certP || RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' }));       // one for as long as this window is open

  // fatal: it went wrong in a way trying again wouldn't fix (a check failed, the disk, the sender's file changed), so a download
  // that ends like this waits for Resume instead of carrying on by itself.
  function close(x, why, tell = true, ok = false, fatal = false) {
    const t = xs.get(x);
    if (!t) return;
    xs.delete(x);
    if (t.wake) t.wake();
    try { if (t.dc) t.dc.close(); } catch { /* closed */ }
    try { if (t.pc) t.pc.close(); } catch { /* closed */ }
    if (tell) api.send('ended', { x, why: why || '', ok, fatal });
  }
  function fail(t, why, fatal = false) {
    try { if (t.dc && t.dc.readyState === 'open') t.dc.send(JSON.stringify({ t: 'cancel', why, fatal })); } catch { /* closing */ }
    close(t.x, why, true, false, fatal);
  }
  const say = (t, m) => { try { if (t.dc && t.dc.readyState === 'open') t.dc.send(JSON.stringify(m)); } catch { /* closing */ } };

  async function makePc(t, cfg) {
    const pc = t.pc = new RTCPeerConnection({ iceServers: Array.isArray(cfg.iceServers) ? cfg.iceServers : [], iceTransportPolicy: cfg.policy === 'all' ? 'all' : 'relay', certificates: [await cert()] });
    pc.onicecandidate = (e) => { if (e.candidate && xs.get(t.x) === t) api.send('signal', { x: t.x, d: { c: e.candidate.toJSON() } }); };
    pc.onconnectionstatechange = () => {
      if (xs.get(t.x) !== t) return;
      api.send('state', { x: t.x, state: pc.connectionState });
      if (pc.connectionState === 'connected') checkCert(t);
      if (pc.connectionState === 'failed') close(t.x, t.role === 'recv' ? 'Couldn\'t connect to their PC.' : 'Couldn\'t connect to their PC.');
    };
    return pc;
  }
  // The certificate the other end really used (as bc-send.js finds it): main.js has chat.js compare it with the signed one.
  async function remotePrint(pc) {
    const st = await pc.getStats().catch(() => null);
    for (const s of st ? st.values() : []) {
      if (s.type !== 'transport' || !s.remoteCertificateId) continue;
      const c = st.get(s.remoteCertificateId);
      if (c) return { alg: c.fingerprintAlgorithm, fp: c.fingerprint };
    }
    const tr = pc.sctp && pc.sctp.transport;
    const der = tr && tr.state === 'connected' && tr.getRemoteCertificates ? tr.getRemoteCertificates() : [];
    if (!der.length) return null;
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', der[0]));
    return { alg: 'sha-256', fp: [...h].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':') };
  }
  async function checkCert(t, tries = 0) {
    if (t.certSent) return;
    const c = await remotePrint(t.pc);
    if (xs.get(t.x) !== t) return;
    if (c) { t.certSent = true; api.send('cert', { x: t.x, ...c }); return; }
    if (tries < 40) setTimeout(() => checkCert(t, tries + 1), 250);
    else fail(t, 'Couldn\'t check the connection.');
  }
  async function onSdp(m) {
    const t = xs.get(m.x);
    if (!t || !m.sdp) return;
    await t.ready;
    if (xs.get(m.x) !== t) return;
    try {
      await t.pc.setRemoteDescription(m.sdp);
      for (const c of t.early.splice(0)) await t.pc.addIceCandidate(c).catch(() => {});
      if (t.role === 'recv') {
        await t.pc.setLocalDescription(await t.pc.createAnswer());
        if (xs.get(m.x) === t) api.send('signal', { x: t.x, d: { sdp: { type: 'answer', sdp: t.pc.localDescription.sdp } } });
      }
    } catch (e) { log('setup: ' + e.message); fail(t, 'The connection couldn\'t be set up.'); }
  }
  async function onCandidate(m) {
    const t = xs.get(m.x);
    if (!t || !m.c) return;
    await t.ready;
    if (!t.pc || !t.pc.remoteDescription) { t.early.push(m.c); return; }
    t.pc.addIceCandidate(m.c).catch(() => {});
  }
  function onVerified(m) {
    const t = xs.get(m.x);
    if (!t) return;
    t.verified = true;
    if (t.role === 'send') sendHead(t);
    else for (const d of t.inbox.splice(0)) take(t, d);
  }

  // ================= sending =================
  function startSend(m) {
    close(m.x, '', false);
    const t = { x: m.x, role: 'send', pc: null, dc: null, early: [], verified: false, open: false, head: null, queue: [], busy: false, done: false, wake: null };
    xs.set(m.x, t);
    t.ready = (async () => {
      const pc = await makePc(t, m);
      const dc = t.dc = pc.createDataChannel('file', { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = LOW;
      dc.onopen = () => { t.open = true; sendHead(t); };
      dc.onclose = () => { if (xs.get(t.x) === t) close(t.x, t.done ? '' : 'The connection closed.', true, t.done); };
      dc.onbufferedamountlow = () => { if (t.wake) { const w = t.wake; t.wake = null; w(); } };
      dc.onmessage = (e) => fromReceiver(t, e.data);
      await pc.setLocalDescription(await pc.createOffer());
      if (xs.get(t.x) === t) api.send('signal', { x: t.x, d: { sdp: { type: 'offer', sdp: pc.localDescription.sdp } } });
    })().catch((e) => { log('send: ' + e.message); fail(t, 'The connection couldn\'t be set up.'); });
  }
  async function sendHead(t) {
    if (!t.open || !t.verified || t.head) return;
    t.head = { pending: true };
    const h = await api.call('head', t.x);
    if (xs.get(t.x) !== t) return;
    if (!h || h.error) { fail(t, (h && h.error) || 'That file isn\'t on their PC any more.', true); return; }
    const { hashes, ...rest } = h;
    t.head = rest;
    say(t, { t: 'head', name: rest.name, size: rest.size, mime: rest.mime, piece: rest.piece, root: rest.root, n: hashes.length });
    for (let i = 0; i < hashes.length; i += HASHES_AT_ONCE) say(t, { t: 'hashes', at: i, list: hashes.slice(i, i + HASHES_AT_ONCE) });
  }
  function fromReceiver(t, data) {
    if (typeof data !== 'string' || data.length > 4096 || !t.verified) return;
    let m = null; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'get') {
      const n = t.head && t.head.size ? Math.ceil(t.head.size / t.head.piece) : 0;
      if (!Number.isInteger(m.i) || m.i < 0 || m.i >= n || t.queue.length >= 64) return;
      t.queue.push(m.i); pump(t);
    } else if (m.t === 'done') { t.done = true; close(t.x, '', true, true); }
    else if (m.t === 'cancel') close(t.x, String(m.why || '').slice(0, 200) || 'They stopped the download.');
  }
  const drained = (t) => new Promise((res) => { t.wake = res; });
  async function pump(t) {
    if (t.busy) return;
    t.busy = true;
    try {
      while (t.queue.length && xs.get(t.x) === t) {
        const i = t.queue.shift(), start = i * t.head.piece, len = Math.min(t.head.piece, t.head.size - start);
        say(t, { t: 'piece', i });
        for (let at = 0; at < len; at += BLOCK) {
          const r = await api.call('read', t.x, start + at, Math.min(BLOCK, len - at));
          if (xs.get(t.x) !== t) return;
          if (!r || r.error || !r.data) { fail(t, (r && r.error) || 'Couldn\'t read the file.', true); return; }
          const b = r.data;
          for (let o = 0; o < b.length; o += CHUNK) {
            while (t.dc.bufferedAmount > HIGH) { await drained(t); if (xs.get(t.x) !== t) return; }
            if (t.dc.readyState !== 'open') return;
            t.dc.send(b.subarray(o, o + CHUNK));
          }
        }
      }
    } catch (e) { log('send: ' + e.message); fail(t, 'Sending went wrong.'); } finally { t.busy = false; }
  }

  // ================= receiving =================
  function startRecv(m) {
    close(m.x, '', false);
    const t = { x: m.x, role: 'recv', pc: null, dc: null, early: [], verified: false, inbox: [], head: null, n: 0, hashes: [], want: [], asked: new Set(),
      cur: -1, curAt: 0, buf: [], bufLen: 0, chain: Promise.resolve(), tries: {}, finished: false, wake: null };
    xs.set(m.x, t);
    t.ready = (async () => {
      const pc = await makePc(t, m);
      pc.ondatachannel = (e) => {
        if (t.dc) return;
        const dc = t.dc = e.channel;
        dc.binaryType = 'arraybuffer';
        dc.onmessage = (ev) => { if (t.verified) take(t, ev.data); else if (t.inbox.length < 4096) t.inbox.push(ev.data); };
        dc.onclose = () => { if (xs.get(t.x) === t) close(t.x, t.finished ? '' : 'The connection closed.', true, t.finished); };
      };
    })().catch((e) => { log('recv: ' + e.message); fail(t, 'The connection couldn\'t be set up.'); });
  }
  // Everything from the sender is handled in order, one at a time (writing to the disk is slower than the network at times).
  function take(t, data) { t.chain = t.chain.then(() => handle(t, data)).catch((e) => { log('recv: ' + (e && e.message)); fail(t, 'Receiving went wrong.'); }); }
  const pieceLen = (t, i) => Math.min(t.head.piece, t.head.size - i * t.head.piece);
  async function handle(t, data) {
    if (xs.get(t.x) !== t) return;
    if (typeof data === 'string') {
      if (data.length > 200000) return fail(t, 'The sender sent something too big.');
      let m = null; try { m = JSON.parse(data); } catch { return fail(t, 'The sender sent something Drift can\'t read.'); }
      if (m.t === 'head' && !t.head) {
        const h = { name: String(m.name || ''), size: +m.size, mime: String(m.mime || ''), piece: +m.piece, root: String(m.root || ''), n: +m.n };
        const r = await api.call('head-in', t.x, h);
        if (r.error) return fail(t, r.error, true);
        t.head = h; t.n = h.n;
      } else if (m.t === 'hashes' && t.head) {
        if (m.at !== t.hashes.length || !Array.isArray(m.list) || t.hashes.length + m.list.length > t.n) return fail(t, 'The sender\'s list of pieces doesn\'t match the file.');
        t.hashes.push(...m.list.map(String));
        if (t.hashes.length < t.n) return;
        const r = await api.call('hashes', t.x, t.hashes);
        if (r.error) return fail(t, r.error, true);
        t.hashes = []; t.want = r.want;
        if (!t.want.length) return finish(t);
        ask(t);
      } else if (m.t === 'piece' && t.head) {
        await flush(t);
        if (!t.asked.has(m.i)) return fail(t, 'The sender sent a piece that wasn\'t asked for.');
        t.cur = m.i; t.curAt = 0;
      } else if (m.t === 'cancel') close(t.x, String(m.why || '').slice(0, 200) || 'They stopped sending it.', true, false, !!m.fatal);
      return;
    }
    if (t.cur < 0) return;       // the rest of a piece that already went wrong: it's asked for again
    t.buf.push(new Uint8Array(data)); t.bufLen += data.byteLength;
    if (t.bufLen >= BLOCK || t.curAt + t.bufLen >= pieceLen(t, t.cur)) await flush(t);
  }
  async function flush(t) {
    if (!t.bufLen || t.cur < 0) return;
    const bytes = new Uint8Array(t.bufLen);
    let o = 0; for (const b of t.buf) { bytes.set(b, o); o += b.length; }
    const at = t.curAt, i = t.cur;
    t.buf = []; t.curAt += t.bufLen; t.bufLen = 0;
    const r = await api.call('write', t.x, i, at, bytes);
    if (xs.get(t.x) !== t) return;
    if (!r || r.error) return fail(t, (r && r.error) || 'Couldn\'t write the file.', true);
    if (r.piece === 'more') return;
    t.cur = -1; t.asked.delete(i);
    if (r.piece === 'bad') {
      t.tries[i] = (t.tries[i] || 0) + 1;
      if (t.tries[i] > 3) return fail(t, 'Part of the file kept arriving damaged, so Drift stopped. Their copy may have changed.', true);
      log(`piece ${i} was damaged; asking for it again`);
      t.want.unshift(i);
    }
    if (!t.want.length && !t.asked.size) return finish(t);
    ask(t);
  }
  function ask(t) {
    while (t.asked.size < AHEAD && t.want.length) { const i = t.want.shift(); t.asked.add(i); say(t, { t: 'get', i }); }
  }
  async function finish(t) {
    const r = await api.call('finish', t.x);
    if (xs.get(t.x) !== t) return;
    if (r.error) return fail(t, r.error, true);
    t.finished = true;
    say(t, { t: 'done' });
    setTimeout(() => close(t.x, '', true, true), 400);       // (time for "done" to leave)
  }

  api.on((m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'send') startSend(m);
    else if (m.t === 'recv') startRecv(m);
    else if (m.t === 'sdp') onSdp(m);
    else if (m.t === 'candidate') onCandidate(m);
    else if (m.t === 'verified') onVerified(m);
    else if (m.t === 'stop') { const t = xs.get(m.x); if (t) { say(t, { t: 'cancel', why: String(m.why || '') }); close(m.x, '', false); } }
  });
  api.send('hello');
})();
