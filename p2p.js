// Drift — watch together. One PC shares the video it is playing; friends join with an invite code and their copy of
// Drift plays the same video in step. The PCs talk straight to each other: there is no server in the middle.
// Everything (the video, the controls) travels over TLS keyed by a secret inside the invite code, so only people
// holding the code can connect or see what is being watched.
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const path = require('path');

const TLS = { ciphers: 'ECDHE-PSK-CHACHA20-POLY1305', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' };
const ID = 'drift', MAX_PEERS = 8;
const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo' };

// ---- invite codes: version, port, secret and every address the sharing PC might be reached on ----
function ipBytes(ip) {
  ip = String(ip).replace(/%.*$/, '');
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  if (!net.isIPv6(ip) || ip.includes('.')) return null;
  const [a, b] = ip.split('::'), head = a ? a.split(':') : [], tail = b ? b.split(':') : [];
  const groups = b === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) || 0, i * 2));
  return out;
}
const ipText = (b) => (b.length === 4 ? [...b].join('.') : Array.from({ length: 8 }, (_x, i) => b.readUInt16BE(i * 2).toString(16)).join(':'));
const check = (b) => crypto.createHash('sha256').update(b).digest().subarray(0, 2);
function encodeCode({ port, key, addrs }) {
  const parts = [Buffer.from([1, port >> 8, port & 255]), key];
  for (const a of addrs) { const b = ipBytes(a); if (b) parts.push(Buffer.from([b.length]), b); }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, check(body)]).toString('base64url');
}
function decodeCode(text) {
  try {
    const b = Buffer.from(String(text || '').replace(/^\s*drift:/i, '').replace(/[^A-Za-z0-9_-]/g, ''), 'base64url');
    if (b.length < 26 || b[0] !== 1) return null;
    const body = b.subarray(0, b.length - 2);
    if (!check(body).equals(b.subarray(b.length - 2))) return null;
    const out = { port: body.readUInt16BE(1), key: Buffer.from(body.subarray(3, 19)), addrs: [] };
    for (let i = 19; i < body.length;) {
      const n = body[i];
      if ((n !== 4 && n !== 16) || i + 1 + n > body.length) return null;
      out.addrs.push(ipText(body.subarray(i + 1, i + 1 + n))); i += 1 + n;
    }
    return out.port && out.addrs.length ? out : null;
  } catch { return null; }
}
const isPublic = (ip) => net.isIPv4(ip) && !/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
function localAddrs() {
  const v4 = [], v6 = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.internal) continue;
    if (a.family === 'IPv4' && !a.address.startsWith('169.254.')) v4.push(a.address);
    else if (a.family === 'IPv6' && /^[23]/.test(a.address) && !v6.length) v6.push(a.address);     // one address the whole internet can route to
  }
  return [...v4.slice(0, 4), ...v6];
}

// ---- asking the home router to let friends in (UPnP) ----
function httpText(url, opts = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { timeout: 4000, ...opts }, (res) => {
      let out = ''; res.setEncoding('utf8');
      res.on('data', (d) => { if (out.length < 400000) out += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: out, local: res.socket && res.socket.localAddress }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
    req.end(body);
  });
}
function findGateways(ms = 2200) {
  return new Promise((resolve) => {
    const found = new Set(), s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => { try { s.close(); } catch { /* closed */ } resolve([...found]); };
    s.on('error', done);
    s.on('message', (m) => { const loc = /^location:\s*(\S+)/im.exec(m.toString()); if (loc) found.add(loc[1]); });
    s.bind(0, () => {
      for (const st of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2', 'urn:schemas-upnp-org:service:WANIPConnection:1']) {
        const msg = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        try { s.send(msg, 1900, '239.255.255.250'); } catch { /* no network */ }
      }
      setTimeout(done, ms);
    });
  });
}
async function gatewayService(location) {
  const r = await httpText(location, { timeout: 2500 });
  const base = (/<URLBase>\s*([^<\s]+)/i.exec(r.text) || [])[1] || location;
  for (const m of r.text.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
    const type = (/<serviceType>\s*([^<\s]+)/i.exec(m[1]) || [])[1] || '', ctl = (/<controlURL>\s*([^<\s]+)/i.exec(m[1]) || [])[1];
    if (ctl && /:WAN(IP|PPP)Connection:[12]$/i.test(type)) return { type, url: new URL(ctl, base).href, local: r.local };
  }
  throw new Error('no WAN service');
}
async function soap(svc, action, fields) {
  const inner = Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.type}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const r = await httpText(svc.url, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${svc.type}#${action}"`, 'Content-Length': Buffer.byteLength(body) } }, body);
  if (r.status !== 200) { const e = new Error('upnp ' + ((/<errorCode>\s*(\d+)/i.exec(r.text) || [])[1] || r.status)); e.code = +((/<errorCode>\s*(\d+)/i.exec(r.text) || [])[1] || 0); throw e; }
  return r.text;
}
async function gateway() {
  for (const loc of (await findGateways(1800)).filter((l) => !/\/\/169\.254\./.test(l))) { try { return await gatewayService(loc); } catch { /* not a router, try the next */ } }
  throw new Error('no gateway');
}
const externalIp = async (svc) => (/<NewExternalIPAddress>\s*([^<\s]*)/i.exec(await soap(svc, 'GetExternalIPAddress', {})) || [])[1] || '';
// Opens `port` (TCP) on the router and points it at this PC. Resolves { ip, remove() } or throws.
async function upnpMap(port) {
  const svc = await gateway();
  const map = (lease) => soap(svc, 'AddPortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP', NewInternalPort: port, NewInternalClient: svc.local,
    NewEnabled: 1, NewPortMappingDescription: 'Drift', NewLeaseDuration: lease });
  const unmap = () => soap(svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' });
  let lease = 7200;
  try { await map(lease); } catch (e) {
    if (e.code === 725) lease = 0;                         // this router only does mappings that never expire
    else if (e.code === 718) await unmap().catch(() => {});  // left over from an earlier run
    else throw e;
    await map(lease);
  }
  const renew = lease ? setInterval(() => map(lease).catch(() => {}), 1800000) : null;
  return { ip: await externalIp(svc).catch(() => ''), remove: () => { clearInterval(renew); return unmap().catch(() => {}); } };
}

// ---- newline-separated JSON over a socket ----
function wire(sock, head, onMsg, onClose) {
  let buf = '', closed = false;
  const end = () => { if (closed) return; closed = true; try { sock.destroy(); } catch { /* gone */ } onClose(); };
  const feed = (d) => {
    buf += d;
    if (buf.length > 2e6) { end(); return; }
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) { let m = null; try { m = JSON.parse(line); } catch { /* skip */ } if (m && typeof m === 'object') onMsg(m); } }
  };
  sock.setNoDelay(true); sock.setTimeout(0);
  sock.on('data', (d) => feed(d.toString('utf8'))); sock.on('close', end); sock.on('error', end);
  if (head && head.length) feed(head.toString('utf8'));
  return { send: (m) => { if (!closed && sock.writable) { try { sock.write((typeof m === 'string' ? m : JSON.stringify(m)) + '\n'); } catch { /* gone */ } } }, close: end };
}

// hooks (all supplied by the main process):
//   snapshot()            what is playing right now, for friends
//   fileAt(i)             path of the i-th video being shared, or ''
//   cues(i, id)           promise of one subtitle track's lines
//   convert(req, res, q)  answer with a converted (smaller / SDR) stream
//   guestCmd(m)           a friend pressed play / pause / seek / next
//   playing()             is the shared video running?
//   hold(names | null)    pause for everyone while these friends load, or carry on
//   remote(state | null, why)   as a guest: what the sharing PC is doing (null = the session is over)
//   publicIp()            promise of this PC's address on the internet
//   say(text)             show a message on screen
//   changed()             something in info() changed
module.exports = function createP2P(hooks) {
  let role = 'off', status = '', note = '', code = '', reach = '', port = 0, gen = 0;
  let server = null, key = null, mapping = null, opts = {}, tick = null, lastSnap = '', lastFile = '', holding = false, pubIp = '', settling = false;
  const peers = new Map();
  let g = null;        // as a guest: the connection to the sharing PC
  let myName = '';

  const changed = () => hooks.changed();
  const cleanName = (n) => String(n || '').replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 24);
  const who = () => [...peers.values()].map((p) => ({ name: p.name, ready: p.ready }));

  // ================= sharing =================
  function listen(srv, want) {
    return new Promise((resolve, reject) => {
      const tries = [...Array.from({ length: 8 }, (_x, i) => want + i).filter((p) => p > 1023 && p < 65536), 0];
      let host = opts.local ? '127.0.0.1' : '::';
      const next = () => {
        if (!tries.length) { reject(new Error('no port')); return; }
        const p = tries[0];
        srv.once('error', (e) => {
          if (host === '::' && e.code !== 'EADDRINUSE' && e.code !== 'EACCES') host = '0.0.0.0'; else tries.shift();   // no IPv6 on this PC
          next();
        });
        srv.listen(p, host, () => { srv.removeAllListeners('error'); srv.on('error', () => {}); resolve(srv.address().port); });
      };
      next();
    });
  }
  const makeCode = () => { code = encodeCode({ port, key, addrs: opts.local ? ['127.0.0.1'] : [...(isPublic(pubIp) ? [pubIp] : []), ...localAddrs()] }); };
  async function share(o) {
    if (role !== 'off') await stop();
    const my = ++gen;
    opts = { ...o }; myName = cleanName(o.name) || 'Host';
    role = 'host'; status = 'starting'; note = ''; reach = 'lan'; code = ''; pubIp = ''; settling = false; lastSnap = ''; lastFile = ''; holding = false;
    key = crypto.randomBytes(16);
    const srv = server = https.createServer({ ...TLS, pskCallback: (_s, id) => (id === ID ? key : null) }, onRequest);
    srv.on('upgrade', onUpgrade); srv.on('tlsClientError', () => {}); srv.on('clientError', (_e, sock) => { try { sock.destroy(); } catch { /* gone */ } });
    srv.keepAliveTimeout = 30000;
    changed();
    try { port = await listen(srv, +o.port || 47800); } catch { if (my === gen) { await stop(); note = 'Sharing could not start: no network port was free.'; changed(); } return; }
    if (my !== gen) { srv.close(); return; }
    makeCode(); status = 'ready';
    tick = setInterval(() => { const now = Date.now(); for (const p of [...peers.values()]) if (now - p.seen > 12000) p.wire.close(); weigh(); }, 2000);
    changed();
    if (o.internet) openInternet(my);
  }
  // Can this PC already be reached at its public address (a port forwarded by hand)? Many routers let a PC call its own
  // public address, so a yes is certain; a no only means it couldn't be checked from inside.
  const reachable = (ip) => new Promise((resolve) => {
    const req = https.request({ host: ip, port, path: '/ping', agent: false, timeout: 3500, ...clientTls(key) }, (r) => { r.resume(); resolve(true); });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false)); req.end();
  });
  // Works out how friends outside the home can get in. The invite code isn't offered until this is settled, so a code
  // copied early can never be missing the public address.
  async function openInternet(my) {
    settling = true; note = ''; changed();
    const mapping0 = upnpMap(port).catch(() => null);
    const drop = () => mapping0.then((m) => { if (m) m.remove(); });
    const seen = await hooks.publicIp().catch(() => '');
    if (my !== gen) { drop(); return; }
    if (isPublic(seen)) { pubIp = seen; makeCode(); }
    if (pubIp && await reachable(pubIp)) {       // the port is already open: nothing more to do
      if (my !== gen) { drop(); return; }
      reach = 'internet'; note = ''; settling = false; changed();
      mapping0.then((m) => { if (my === gen) mapping = m; else if (m) m.remove(); });
      return;
    }
    const mapped = await mapping0;
    if (my !== gen) { if (mapped) mapped.remove(); return; }
    mapping = mapped;
    if (mapped) {
      if (isPublic(mapped.ip)) pubIp = mapped.ip; else if (mapped.ip) pubIp = '';      // the router itself sits behind a shared address
      reach = pubIp ? 'internet' : 'lan';
      note = pubIp ? '' : 'Your internet provider shares one address between several homes, so friends elsewhere can\'t reach this PC directly. Friends on your own network can still join — or connect both PCs with a VPN such as Tailscale and start sharing again.';
    } else {
      reach = 'manual';
      note = `Friends on your own network can join now. Drift couldn't confirm that friends elsewhere can: your router doesn't open ports by itself (no UPnP), so TCP port ${port} has to be forwarded to this PC (${localAddrs()[0] || 'its local address'}) in the router's settings. If that's already done, send the code and try it — some routers can't be checked from the inside.`;
    }
    makeCode(); settling = false; changed();
  }
  function fileSpec(req) {
    const u = new URL(req.url, 'http://x');
    return { u, i: parseInt(u.searchParams.get('i'), 10) };
  }
  function onRequest(req, res) {
    const { u, i } = fileSpec(req);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    if (u.pathname === '/f') { sendFile(req, res, hooks.fileAt(i)); return; }
    if (u.pathname === '/c') {
      Promise.resolve().then(() => hooks.cues(i, u.searchParams.get('id') || '')).then((cues) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(cues || [])); })
        .catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (u.pathname === '/x') { hooks.convert(req, res, { i, t: Math.max(0, parseFloat(u.searchParams.get('t')) || 0), q: u.searchParams.get('q') || '' }); return; }
    res.writeHead(404); res.end();
  }
  function sendFile(req, res, file) {
    let st = null;
    try { st = file && fs.statSync(file); } catch { /* gone */ }
    if (!st || !st.isFile()) { res.writeHead(404); res.end(); return; }
    const head = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let from = 0, to = st.size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) { from = +m[1]; if (m[2]) to = Math.min(to, +m[2]); } else from = Math.max(0, st.size - +m[2]);
      if (from > to || from >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${from}-${to}/${st.size}`, 'Content-Length': to - from + 1 });
    } else res.writeHead(200, { ...head, 'Content-Length': st.size });
    if (req.method === 'HEAD' || !st.size) { res.end(); return; }
    const rs = fs.createReadStream(file, { start: from, end: to, highWaterMark: 256 * 1024 });
    rs.on('error', () => res.destroy()); res.on('close', () => rs.destroy());
    rs.pipe(res);
  }
  function onUpgrade(req, sock, head) {
    const u = new URL(req.url, 'http://x');
    if (role !== 'host' || u.pathname !== '/ctl' || peers.size >= MAX_PEERS) { sock.end(`HTTP/1.1 ${peers.size >= MAX_PEERS ? 503 : 404} No\r\nConnection: close\r\n\r\n`); return; }
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: drift\r\nConnection: Upgrade\r\n\r\n');
    const p = { id: crypto.randomBytes(4).toString('hex'), name: cleanName(u.searchParams.get('n')) || 'Friend', ready: false, since: Date.now(), seen: Date.now(), wire: null };
    p.wire = wire(sock, head, (m) => {
      p.seen = Date.now();
      if (m.t === 'ping') p.wire.send({ t: 'pong', c: m.c, h: Date.now() });
      else if (m.t === 'ready') { const ok = !!m.ok && m.f === lastFile; if (ok !== p.ready) { p.ready = ok; if (!ok) p.since = Date.now(); weigh(); sync(true); changed(); } }
      else if (m.t === 'cmd') hooks.guestCmd(m, p.name);
      else if (m.t === 'bye') p.wire.close();
    }, () => {
      if (peers.get(p.id) !== p) return;
      peers.delete(p.id);
      if (role === 'host') { hooks.say(`${p.name} left`); weigh(); sync(true); changed(); }
    });
    peers.set(p.id, p);
    hooks.say(`${p.name} joined`);
    lastSnap = ''; sync(); weigh(); changed();
  }
  // Tells every friend what is playing, whenever that changes.
  function sync(force) {
    if (role !== 'host' || !peers.size) return;
    let s = hooks.snapshot();
    if ((s.file || '') !== lastFile) {       // a different video: everyone has to load it (which may pause it, so look again afterwards)
      lastFile = s.file || ''; const now = Date.now();
      for (const p of peers.values()) { p.ready = false; p.since = now; }
      weigh(); s = hooks.snapshot();
    }
    const msg = JSON.stringify({ t: 'state', s, host: myName, who: who() });
    if (msg === lastSnap && !force) return;
    lastSnap = msg;
    for (const p of peers.values()) p.wire.send(msg);
  }
  // Pause for everyone while a friend is still loading; give up on anyone who takes more than 20 seconds.
  function weigh() {
    if (role !== 'host') return;
    const now = Date.now(), slow = opts.wait ? [...peers.values()].filter((p) => !p.ready && now - p.since < 20000) : [];
    if (slow.length) { if (holding || hooks.playing()) { holding = true; hooks.hold(slow.map((p) => p.name)); } }
    else if (holding) { holding = false; hooks.hold(null); }
  }
  // The host pressed play while waiting: stop waiting for whoever is still loading.
  function carryOn() { if (!holding) return; holding = false; for (const p of peers.values()) if (!p.ready) p.since = 0; }
  function setOptions(o) { opts = { ...opts, ...o }; if (o.name !== undefined) myName = cleanName(o.name) || myName; weigh(); if (role === 'host') { lastSnap = ''; sync(); } }

  // ================= joining =================
  const clientTls = (k) => ({ ...TLS, pskCallback: () => ({ psk: k, identity: ID }), checkServerIdentity: () => undefined });
  function dial(c, addr) {
    return new Promise((resolve, reject) => {
      const req = https.request({ host: addr, port: c.port, path: '/ctl?v=1&n=' + encodeURIComponent(myName), headers: { Connection: 'Upgrade', Upgrade: 'drift' }, agent: false, timeout: 7000, ...clientTls(c.key) });
      req.on('upgrade', (_res, sock, head) => resolve({ sock, head, addr }));
      req.on('response', (res) => { res.resume(); reject(Object.assign(new Error('refused'), { full: res.statusCode === 503 })); });
      req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
      req.end();
    });
  }
  async function connect(c, my) {
    const tries = (c.addr ? [c.addr, ...c.addrs.filter((a) => a !== c.addr)] : c.addrs).map((a) => dial(c, a));
    // Every address is tried at once; the first to answer is used and the rest are dropped.
    let hit = null, full = false;
    await new Promise((first) => {
      let left = tries.length;
      for (const t of tries) t.then((r) => { if (!hit && my === gen) { hit = r; first(); } else r.sock.destroy(); }, (e) => { if (e && e.full) full = true; }).then(() => { if (!--left) first(); });
    });
    if (my !== gen) { if (hit) hit.sock.destroy(); return; }
    if (!hit) {
      if (full) { over('That session is full.'); return; }
      if (Date.now() > c.until) { over(c.was ? 'Lost the connection to your friend\'s PC.' : 'Couldn\'t connect. Check that your friend is still sharing and that this is their latest invite code.'); return; }
      c.retry = setTimeout(() => connect(c, my), 2000);
      return;
    }
    c.addr = hit.addr; c.was = true; c.best = Infinity; status = 'connected'; note = '';
    c.wire = wire(hit.sock, hit.head, (m) => {
      c.seen = Date.now();
      if (m.t === 'pong') {
        const now = Date.now(), rtt = now - m.c;
        if (rtt >= 0 && rtt <= c.best + 15) {       // the quickest round trip gives the best estimate of the other PC's clock
          const off = m.h - (m.c + rtt / 2), moved = Math.abs(off - c.offset) > 20;
          c.best = Math.min(c.best, rtt); c.offset = off;
          if (moved) emit(c);
        }
      } else if (m.t === 'state') { const first = !c.state; c.state = m.s; c.host = cleanName(m.host) || 'Host'; c.who = Array.isArray(m.who) ? m.who : []; if (first) hooks.say(`Watching with ${c.host}`); emit(c); changed(); }
      else if (m.t === 'bye') over(`${c.host || 'Your friend'} stopped sharing.`);
    }, () => {
      if (my !== gen || role !== 'guest') return;
      clearInterval(c.pinger); status = 'reconnecting'; c.until = Date.now() + 45000; changed();
      c.retry = setTimeout(() => connect(c, my), 800);
    });
    let n = 0;
    const ping = () => { c.wire.send({ t: 'ping', c: Date.now() }); if (c.seen && Date.now() - c.seen > 12000) c.wire.close(); if (c.best < Infinity && ++n % 15 === 0) c.best += 10; };
    c.seen = Date.now(); c.pinger = setInterval(ping, 2000);
    for (let i = 0; i < 4; i++) setTimeout(() => { if (my === gen) ping(); }, i * 250);
    if (c.ready) c.wire.send(c.ready);
    changed();
  }
  const emit = (c) => { if (c.state) hooks.remote({ ...c.state, startedAt: c.state.startedAt - c.offset }, ''); };
  function over(why) {
    if (role !== 'guest') return;
    const c = g; g = null; gen++; role = 'off'; status = ''; note = why || '';
    if (c) { clearTimeout(c.retry); clearInterval(c.pinger); if (c.wire) c.wire.close(); c.agent.destroy(); }
    hooks.remote(null, why || ''); changed();
  }
  async function join(text, name) {
    const c = decodeCode(text);
    if (!c) return { ok: false, error: 'That invite code isn\'t complete. Ask your friend to copy it again.' };
    if (role !== 'off') await stop();
    const my = ++gen;
    myName = cleanName(name) || 'Friend';
    role = 'guest'; status = 'connecting'; note = ''; code = '';
    g = { ...c, addr: '', offset: 0, best: Infinity, state: null, host: '', who: [], until: Date.now() + 20000, was: false, agent: new https.Agent({ keepAlive: true, maxSockets: 16 }) };
    changed(); connect(g, my);
    return { ok: true };
  }
  // A request to the sharing PC (video bytes, subtitles, a converted stream). cb gets the response.
  function request(pathname, headers, cb) {
    if (!g || !g.addr) return null;
    const req = https.request({ host: g.addr, port: g.port, path: pathname, headers: headers || {}, agent: g.agent, ...clientTls(g.key) }, cb);
    req.end();
    return req;
  }
  // Passes a request from this PC's own player on to the sharing PC, so the player only ever talks to this machine.
  function relay(req, res, pathname) {
    const up = request(pathname, req.headers.range ? { Range: req.headers.range } : {}, (r) => {
      const head = {};
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (r.headers[k]) head[k] = r.headers[k];
      res.writeHead(r.statusCode, { ...head, 'Cache-Control': 'no-store' });
      r.pipe(res); r.on('error', () => res.destroy());
    });
    if (!up) { res.writeHead(503); res.end(); return; }
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => up.destroy());
  }
  function json(pathname) {
    return new Promise((resolve, reject) => {
      const up = request(pathname, {}, (r) => {
        const parts = []; let size = 0;
        r.on('data', (d) => { size += d.length; if (size < 40e6) parts.push(d); });
        r.on('end', () => { try { if (r.statusCode !== 200) throw new Error('status ' + r.statusCode); resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { reject(e); } });
        r.on('error', reject);
      });
      if (!up) { reject(new Error('not connected')); return; }
      up.setTimeout(60000, () => up.destroy(new Error('timeout'))); up.on('error', reject);
    });
  }
  const send = (m) => { if (g && g.wire) g.wire.send(m); };
  function ready(ok, file) { if (!g) return; const m = { t: 'ready', ok: !!ok, f: file }; if (g.ready && g.ready.ok === m.ok && g.ready.f === m.f) return; g.ready = m; send(m); }

  // ================= both =================
  async function stop() {
    gen++;
    if (role === 'guest') { send({ t: 'bye' }); over(''); note = ''; changed(); return; }
    if (role !== 'host') return;
    clearInterval(tick); tick = null;
    for (const p of [...peers.values()]) { p.wire.send({ t: 'bye' }); peers.delete(p.id); setTimeout(() => p.wire.close(), 150); }
    const srv = server, m = mapping; server = null; mapping = null;
    role = 'off'; status = ''; code = ''; note = ''; reach = ''; settling = false;
    if (holding) { holding = false; hooks.hold(null); }
    if (srv) { srv.close(); if (srv.closeAllConnections) setTimeout(() => srv.closeAllConnections(), 400); }
    changed();
    if (m) await Promise.race([m.remove(), new Promise((r) => setTimeout(r, 1500))]);
  }
  const info = () => ({ role, status, note, code, reach, port, settling: role === 'host' && settling,
    peers: role === 'host' ? who() : g ? g.who : [], host: role === 'host' ? myName : g ? g.host : '', waiting: holding });

  return { share, join, stop, info, sync, weigh, carryOn, setOptions, relay, json, send, ready, role: () => role, connected: () => role === 'guest' && status === 'connected', count: () => peers.size };
};
module.exports.encodeCode = encodeCode;
module.exports.decodeCode = decodeCode;
module.exports.isPublic = isPublic;
module.exports.findGateways = findGateways;
module.exports.gatewayService = gatewayService;
module.exports.externalIp = externalIp;
