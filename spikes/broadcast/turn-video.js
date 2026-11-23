// Spike C of docs/plans/broadcast.md (throwaway): can the hub's relay (the real turn.js, plain JavaScript handing UDP
// packets across in memory) carry broadcasts? A broadcaster sends video-sized packets down one relayed connection per
// viewer, as WebRTC does (one RTCPeerConnection, so one allocation on each side, per viewer). Unlike the voice spike,
// the fake members run in a separate process, so the processor figure is the relay's own.
//
//   node spikes/broadcast/turn-video.js [viewers=7] [mbpsPerViewer=3.5] [seconds=10] [broadcasts=1]
//
// Packets are 1,200 bytes (what Chromium's video packetiser aims for), sent in bursts per frame at 30 fps, which is
// how real video arrives: a 3.5 Mb/s stream is about 12 packets every 33 ms, not an even trickle.
const { fork } = require('child_process');
const dgram = require('dgram');
const crypto = require('crypto');
const path = require('path');

const PKT = 1200, FPS = 30;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv[2] === '--clients') return clients();

(async () => {
  const V = +process.argv[2] || 7, MBPS = +process.argv[3] || 3.5, SECS = +process.argv[4] || 10, B = +process.argv[5] || 1;
  // RELAY_BUF=4: give the relay's socket a 4 MB receive buffer (turn.js leaves Windows' default), to see if that's where packets go
  if (process.env.RELAY_BUF) {
    const make = dgram.createSocket;
    dgram.createSocket = (...a) => { const s = make(...a); s.on('listening', () => { s.setRecvBufferSize(process.env.RELAY_BUF * 1048576); s.setSendBufferSize(process.env.RELAY_BUF * 1048576); }); return s; };
  }
  const createTurn = require('../../turn');
  // Each broadcast is V allocations at the broadcaster plus one per viewer. The real limits are 24 per member, 128 in all.
  const turn = createTurn({ secret: crypto.randomBytes(32), relayHost: '127.0.0.1', maxAllocations: 1024, perMember: 1024 });
  const { port } = await turn.listen(0, '127.0.0.1');
  const kid = fork(__filename, ['--clients'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const ask = (m) => new Promise((ok) => { kid.once('message', ok); kid.send(m); });
  const creds = [];
  for (let b = 0; b < B; b++) { creds.push(turn.credentials('caster' + b, 600)); for (let v = 0; v < V; v++) creds.push(turn.credentials(`viewer${b}-${v}`, 600)); }
  await ask({ setup: { port, V, B, creds } });
  const s0 = turn.stats(), cpu0 = process.cpuUsage(), t0 = performance.now();
  const lag = [];       // how late this process's event loop runs: a busy relay shows up here before it drops anything
  let last = performance.now();
  const probe = setInterval(() => { const n = performance.now(); lag.push(n - last - 10); last = n; }, 10);
  const r = await ask({ run: { MBPS, SECS } });
  clearInterval(probe);
  await wait(300);
  const secs = (performance.now() - t0) / 1000, cpu = process.cpuUsage(cpu0), s1 = turn.stats();
  lag.sort((a, b) => a - b);
  console.log(JSON.stringify({
    broadcasts: B, viewersEach: V, mbpsPerViewer: MBPS, seconds: SECS,
    relayPacketsPerSecondIn: Math.round((s1.packetsIn - s0.packetsIn) / secs),
    relayMbpsIn: +(((s1.bytesIn - s0.bytesIn) * 8) / secs / 1e6).toFixed(1),
    relayMbpsOut: +(((s1.bytesOut - s0.bytesOut) * 8) / secs / 1e6).toFixed(1),
    delivered: `${r.received} of ${r.sent}`,
    lostBeforeRelay: r.sent - (s1.packetsIn - s0.packetsIn),
    lostPercent: +((100 * (r.sent - r.received)) / r.sent).toFixed(2),
    relayCpuPercentOfOneCore: +((100 * (cpu.user + cpu.system)) / 1e6 / secs).toFixed(1),
    relayEventLoopLagMs: { median: +lag[lag.length >> 1].toFixed(1), p99: +lag[Math.floor(lag.length * 0.99)].toFixed(1) },
    allocations: s1.open,
  }, null, 2));
  kid.kill(); turn.close();
})().catch((e) => { console.error(e); process.exit(1); });

// ---- the fake broadcasters and viewers, in their own process ----
function clients() {
  const { parse, build, xaddr, xaddrBytes } = require('../../turn')._test;
  const A = { username: 0x0006, errorCode: 0x0009, channel: 0x000c, peer: 0x0012, realm: 0x0014, nonce: 0x0015, relayed: 0x0016, transport: 0x0019 };
  let port, legs = [];
  function client(cr) {
    const s = dgram.createSocket('udp4'), pending = new Map();
    // A bigger receive buffer, as Chromium sets: Windows' default (64 KB) drops bursts before anyone reads them.
    s.on('listening', () => { try { s.setRecvBufferSize(1 << 20); s.setSendBufferSize(1 << 20); } catch {} });
    let got = 0, key = null, realm = '', nonce = '';
    s.on('message', (b) => {
      if (b[0] >= 0x40 && b[0] <= 0x7f) { got++; return; }
      const m = parse(b), p = m && pending.get(m.tx.toString('hex'));
      if (p) { pending.delete(m.tx.toString('hex')); p(m); }
    });
    const ask = (method, attrs, signed = true) => new Promise((ok) => {
      const tx = crypto.randomBytes(12);
      pending.set(tx.toString('hex'), ok);
      const extra = signed && key ? [[A.username, Buffer.from(cr.username)], [A.realm, Buffer.from(realm)], [A.nonce, Buffer.from(nonce)]] : [];
      s.send(build(method, 0, tx, [...attrs, ...extra], signed ? key : null), port, '127.0.0.1');
    });
    const ok = (m) => { if (m.cls !== 0x0100) throw new Error('refused: ' + (m.attrs.get(A.errorCode) || '').toString('latin1').slice(4)); return m; };
    return {
      sock: s, received: () => got,
      async allocate() {
        const ch = await ask(3, [[A.transport, Buffer.from([17, 0, 0, 0])]], false);
        realm = ch.attrs.get(A.realm).toString(); nonce = ch.attrs.get(A.nonce).toString();
        key = crypto.createHash('md5').update(`${cr.username}:${realm}:${cr.credential}`).digest();
        const r = ok(await ask(3, [[A.transport, Buffer.from([17, 0, 0, 0])]]));
        return xaddr(r.attrs.get(A.relayed), r.tx);
      },
      async bind(peer) { const c = Buffer.alloc(4); c.writeUInt16BE(0x4000); ok(await ask(9, [[A.channel, c], [A.peer, xaddrBytes(peer.address, peer.port)]])); },
      head: (() => { const h = Buffer.alloc(4); h.writeUInt16BE(0x4000); h.writeUInt16BE(PKT, 2); return h; })(),
    };
  }
  process.on('message', async (m) => {
    if (m.setup) {
      ({ port } = m.setup);
      const { V, B, creds } = m.setup;
      for (let b = 0; b < B; b++) {
        const base = b * (V + 1);
        for (let v = 0; v < V; v++) {
          const up = client(creds[base]), down = client(creds[base + 1 + v]);
          for (const c of [up, down]) await new Promise((r) => c.sock.bind(0, '127.0.0.1', r));
          up.relay = await up.allocate(); down.relay = await down.allocate();
          await up.bind(down.relay); await down.bind(up.relay);
          legs.push({ up, down });
        }
      }
      process.send({ ok: 1 });
    }
    if (m.run) {
      const { MBPS, SECS } = m.run;
      const perFrame = Math.max(1, Math.round((MBPS * 1e6) / 8 / PKT / FPS));
      const pkt = Buffer.concat([legs[0].up.head, Buffer.from([0x80]), crypto.randomBytes(PKT - 1)]);       // 0x80: looks like RTP
      let frames = 0, sent = 0;
      const t0 = performance.now(), total = SECS * FPS;
      await new Promise((done) => {
        const timer = setInterval(() => {
          const due = Math.min(total, Math.floor(((performance.now() - t0) * FPS) / 1000));
          for (; frames < due; frames++) for (const l of legs) for (let k = 0; k < perFrame; k++) { l.up.sock.send(pkt, port, '127.0.0.1'); sent++; }
          if (frames >= total) { clearInterval(timer); done(); }
        }, 4);
      });
      await wait(250);
      process.send({ sent, received: legs.reduce((a, l) => a + l.down.received(), 0) });
    }
  });
}
