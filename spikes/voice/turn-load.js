// Spike 3's load test (plain Node, no Electron): what does turn.js cost the hub when everyone in an 8-person call talks
// at once? Each fake member makes an allocation for each other member (as Chromium does: one per connection), binds a
// channel and sends 50 Opus-sized packets a second down every one: 8 x 7 x 50 = 2,800 packets/s in and the same out.
// Also checks the server refuses what it should. Run: node spikes/voice/turn-load.js [members] [seconds]
const dgram = require('dgram');
const crypto = require('crypto');
const createTurn = require('./turn');
const { parse, build, xaddr, xaddrBytes } = createTurn._test;

const N = +process.argv[2] || 8, SECS = +process.argv[3] || 10, HOST = '127.0.0.1';
const A = { username: 0x0006, errorCode: 0x0009, channel: 0x000c, peer: 0x0012, realm: 0x0014, nonce: 0x0015, relayed: 0x0016, transport: 0x0019 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A TURN client just good enough to drive the server: one socket, one allocation.
function client(port, creds) {
  const s = dgram.createSocket('udp4'), pending = new Map();
  let got = 0, key = null, realm = '', nonce = '';
  s.on('message', (b) => {
    if (b[0] >= 0x40 && b[0] <= 0x7f) { got++; return; }
    const m = parse(b), p = m && pending.get(m.tx.toString('hex'));
    if (p) { pending.delete(m.tx.toString('hex')); p(m); }
  });
  const ask = (method, attrs, signed = true) => new Promise((ok) => {
    const tx = crypto.randomBytes(12);
    pending.set(tx.toString('hex'), ok);
    const extra = signed && key ? [[A.username, Buffer.from(creds.username)], [A.realm, Buffer.from(realm)], [A.nonce, Buffer.from(nonce)]] : [];
    s.send(build(method, 0, tx, [...attrs, ...extra], signed ? key : null), port, HOST);
  });
  const ok = (m) => { if (m.cls !== 0x0100) throw new Error('refused: ' + (m.attrs.get(A.errorCode) || '').toString('latin1').slice(4)); return m; };
  return {
    sock: s,
    received: () => got,
    async allocate() {
      const ch = await ask(3, [[A.transport, Buffer.from([17, 0, 0, 0])]], false);       // the 401 with realm and nonce
      realm = ch.attrs.get(A.realm).toString(); nonce = ch.attrs.get(A.nonce).toString();
      key = crypto.createHash('md5').update(`${creds.username}:${realm}:${creds.credential}`).digest();
      const m = ok(await ask(3, [[A.transport, Buffer.from([17, 0, 0, 0])]]));
      return xaddr(m.attrs.get(A.relayed), m.tx);
    },
    async bind(ch, peer) { const c = Buffer.alloc(4); c.writeUInt16BE(ch); ok(await ask(9, [[A.channel, c], [A.peer, xaddrBytes(peer.address, peer.port)]])); },
    send(ch, payload) { const h = Buffer.alloc(4); h.writeUInt16BE(ch); h.writeUInt16BE(payload.length, 2); s.send(Buffer.concat([h, payload]), port, HOST); },
    raw: ask,
    close: () => s.close(),
  };
}

(async () => {
  const turn = createTurn({ secret: crypto.randomBytes(32), relayHost: HOST, maxAllocations: 256 });
  const { port } = await turn.listen(0, HOST);
  const res = { members: N, seconds: SECS, checks: {} };

  // ---- what must be refused ----
  const bad = client(port, { username: `${Math.floor(Date.now() / 1000) + 60}:mallory`, credential: 'not-the-password' });
  await new Promise((r) => bad.sock.bind(0, HOST, r));
  res.checks.wrongPassword = await bad.allocate().then(() => 'ACCEPTED (bad)', (e) => e.message);
  const old = client(port, (() => { const c = turn.credentials('eve', 60); return { ...c, username: `${Math.floor(Date.now() / 1000) - 5}:eve`, credential: crypto.createHmac('sha1', 'x').digest('base64') }; })());
  await new Promise((r) => old.sock.bind(0, HOST, r));
  res.checks.expiredCredentials = await old.allocate().then(() => 'ACCEPTED (bad)', (e) => e.message);
  bad.close(); old.close();

  // ---- the call: N members, each with an allocation per other member ----
  const legs = [];       // legs[i][j]: member i's connection to member j
  for (let i = 0; i < N; i++) {
    legs[i] = [];
    for (let j = 0; j < N; j++) if (i !== j) {
      const c = client(port, turn.credentials('m' + i, 600));
      await new Promise((r) => c.sock.bind(0, HOST, r));
      c.relay = await c.allocate();
      legs[i][j] = c;
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) await legs[i][j].bind(0x4000, legs[j][i].relay);

  // Someone outside the call, with good credentials, tries to use the hub to reach an address on the internet.
  const out = legs[0][1];
  await out.raw(8, [[A.peer, xaddrBytes('203.0.113.9', 9)]]);
  const before = turn.stats().dropped;
  const c = Buffer.alloc(4); c.writeUInt16BE(0x4001);
  await out.raw(9, [[A.channel, c], [A.peer, xaddrBytes('203.0.113.9', 9)]]);
  for (let k = 0; k < 10; k++) out.send(0x4001, Buffer.alloc(100));
  await wait(100);
  res.checks.relayToTheInternet = turn.stats().dropped - before === 10 ? 'dropped' : 'SENT (bad)';

  // ---- load ----
  const payload = crypto.randomBytes(100);       // an Opus frame at ~40 kb/s, before RTP/SRTP headers (~30 more bytes)
  const pkt = Buffer.concat([Buffer.alloc(12), payload, Buffer.alloc(18)]);
  const s0 = turn.stats(), cpu0 = process.cpuUsage(), t0 = performance.now();
  let ticks = 0;
  await new Promise((done) => {
    const timer = setInterval(() => {       // per 20 ms, every member sends one packet to every other member (Windows' timers are coarse, so catch up)
      const due = Math.min(SECS * 50, Math.floor((performance.now() - t0) / 20));
      for (; ticks < due; ticks++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) legs[i][j].send(0x4000, pkt);
      if (ticks >= SECS * 50) { clearInterval(timer); done(); }
    }, 5);
  });
  await wait(200);
  const secs = (performance.now() - t0) / 1000, cpu = process.cpuUsage(cpu0), s1 = turn.stats();
  const received = legs.flat().filter(Boolean).reduce((a, l) => a + l.received(), 0);
  res.packetsPerSecondIn = Math.round((s1.packetsIn - s0.packetsIn) / secs);
  res.packetsPerSecondOut = Math.round((s1.packetsOut - s0.packetsOut) / secs);
  res.mbpsEachWay = +(((s1.bytesIn - s0.bytesIn) * 8) / secs / 1e6).toFixed(2);
  res.delivered = `${received} of ${ticks * N * (N - 1)}`;
  res.cpuPercentOfOneCore = +((100 * (cpu.user + cpu.system)) / 1e6 / secs).toFixed(1);
  res.note = 'the fake members run in this same process, so the server costs less than this';
  console.log(JSON.stringify(res, null, 2));
  for (const l of legs.flat()) if (l) l.close();
  turn.close();
})().catch((e) => { console.error(e); process.exit(1); });
