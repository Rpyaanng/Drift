// Drift — the hub's voice relay: a minimal TURN server (RFC 8656) over UDP, in plain Node, so members of a call only
// ever see the hub's address, not each other's (docs/plans/voice-and-chat.md §5; it began as spike 3). Enough of TURN for
// Chromium: Allocate, Refresh, CreatePermission, ChannelBind, Send/Data indications and ChannelData, with long-term
// credentials and FINGERPRINT. Also answers STUN Binding. IPv4 only.
//
// It only relays between its own allocations. With iceTransportPolicy 'relay' on both sides of every call, each
// member's packets go to another member's relay address on this same server, so they are handed across in memory:
// no relay sockets, nothing but the one listening port to forward on the router, and the hub can't be used to send
// UDP anywhere else (an open TURN relay is a well-known way to attack other hosts). The media itself stays encrypted
// end to end (DTLS-SRTP between the members' PCs); the relay only ever sees ciphertext.
//
// Credentials are the usual "TURN REST" kind, so the hub hands each member short-lived ones and stores nothing:
//   username = `${expiresUnixSeconds}:${memberId}`, password = base64(HMAC-SHA1(secret, username))
// and `allowed(memberId, tag)` is asked on every request, so someone who leaves the call (or is removed) stops being relayed.
//   const t = createTurn({ secret, relayHost, allowed }); await t.listen(47900, '0.0.0.0'); t.credentials('alice', 3600)
//
// File transfers (docs/plans/files.md) get credentials with a tag, `${expires}:${memberId}:f.${transferId}`, and what their
// allocations send is held to `files`: a speed for each transfer and for all of them together, a most for each transfer and a
// most for the day. Over it, packets are dropped (the data channel's own congestion control slows down), so a file never
// crowds out voice, broadcasts or the Surf stream, and the host's connection can't be used up by one big download.
const dgram = require('dgram');
const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = 0x2112a442;
const M = { binding: 0x001, allocate: 0x003, refresh: 0x004, send: 0x006, data: 0x007, permission: 0x008, channelBind: 0x009 };
const C = { request: 0x0000, indication: 0x0010, success: 0x0100, error: 0x0110 };
const A = {
  username: 0x0006, integrity: 0x0008, errorCode: 0x0009, unknown: 0x000a, channel: 0x000c, lifetime: 0x000d,
  peer: 0x0012, data: 0x0013, realm: 0x0014, nonce: 0x0015, relayed: 0x0016, family: 0x0017, evenPort: 0x0018,
  transport: 0x0019, dontFragment: 0x001a, mapped: 0x0020, token: 0x0022, software: 0x8022, fingerprint: 0x8028,
};
const PERMISSION_S = 300, CHANNEL_S = 600, DEFAULT_S = 600, MAX_S = 3600;
const REASON = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 420: 'Unknown Attribute', 437: 'Allocation Mismatch', 438: 'Stale Nonce', 440: 'Address Family not Supported', 442: 'Unsupported Transport Protocol', 486: 'Allocation Quota Reached', 508: 'Insufficient Capacity' };

// ---- the wire format ----
function parse(buf) {
  if (buf.length < 20 || (buf[0] & 0xc0) || buf.readUInt32BE(4) !== MAGIC) return null;
  const type = buf.readUInt16BE(0), len = buf.readUInt16BE(2);
  if (len % 4 || 20 + len > buf.length) return null;
  const msg = { method: (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2), cls: type & 0x0110, tx: buf.subarray(8, 20), attrs: new Map(), order: [], raw: buf.subarray(0, 20 + len) };
  for (let o = 20; o + 4 <= 20 + len;) {
    const t = buf.readUInt16BE(o), l = buf.readUInt16BE(o + 2);
    if (o + 4 + l > 20 + len) return null;
    if (!msg.attrs.has(t)) msg.attrs.set(t, buf.subarray(o + 4, o + 4 + l));
    msg.order.push({ t, at: o });
    o += 4 + l + ((4 - (l % 4)) % 4);
  }
  return msg;
}
const typeOf = (method, cls) => (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2) | cls;
function xaddr(v, tx) {       // XOR-MAPPED-ADDRESS and friends, decoded
  if (!v || v.length < 8 || v[1] !== 0x01) return null;
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16), ip = (v.readUInt32BE(4) ^ MAGIC) >>> 0;
  return { address: [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'), port };
}
function xaddrBytes(address, port) {
  const b = Buffer.alloc(8), ip = address.split('.').reduce((a, x) => ((a << 8) | +x) >>> 0, 0);
  b[1] = 0x01; b.writeUInt16BE(port ^ (MAGIC >>> 16), 2); b.writeUInt32BE((ip ^ MAGIC) >>> 0, 4);
  return b;
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
function errorBytes(code) {
  const r = Buffer.from(REASON[code] || 'Error'), b = Buffer.alloc(4 + r.length);
  b[2] = Math.floor(code / 100); b[3] = code % 100; r.copy(b, 4);
  return b;
}
// Builds a message. With a key it gets MESSAGE-INTEGRITY; it always ends with FINGERPRINT.
function build(method, cls, tx, attrs, key) {
  const parts = [];
  for (const [t, v] of attrs) {
    const h = Buffer.alloc(4); h.writeUInt16BE(t); h.writeUInt16BE(v.length, 2);
    parts.push(h, v, Buffer.alloc((4 - (v.length % 4)) % 4));
  }
  let body = Buffer.concat(parts);
  const head = (extra) => { const h = Buffer.alloc(20); h.writeUInt16BE(typeOf(method, cls)); h.writeUInt16BE(body.length + extra, 2); h.writeUInt32BE(MAGIC, 4); tx.copy(h, 8); return h; };
  if (key) {
    const mac = crypto.createHmac('sha1', key).update(Buffer.concat([head(24), body])).digest();
    body = Buffer.concat([body, Buffer.from([0x00, 0x08, 0x00, 0x14]), mac]);
  }
  const crc = (zlib.crc32(Buffer.concat([head(8), body])) ^ 0x5354554e) >>> 0;
  body = Buffer.concat([body, Buffer.from([0x80, 0x28, 0x00, 0x04]), u32(crc)]);
  return Buffer.concat([head(0), body]);
}
// Checks MESSAGE-INTEGRITY: HMAC-SHA1 over the message up to that attribute, with the length field cut to end there.
function integrityOk(msg, key) {
  const mi = msg.order.find((a) => a.t === A.integrity);
  if (!mi) return false;
  const cut = Buffer.from(msg.raw.subarray(0, mi.at));
  cut.writeUInt16BE(mi.at + 24 - 20, 2);
  const want = crypto.createHmac('sha1', key).update(cut).digest(), got = msg.raw.subarray(mi.at + 4, mi.at + 24);
  return got.length === 20 && crypto.timingSafeEqual(want, got);
}

module.exports = function createTurn({ secret, realm = 'drift', relayHost = '127.0.0.1', maxAllocations = 128, perMember = 24, allowed = () => true, files = {}, log = () => {} }) {
  const sock = dgram.createSocket('udp4');
  const allocs = new Map();       // "ip:port" of the client -> its allocation
  const byRelay = new Map();      // relay port (an address on this server that only exists in here) -> its allocation
  let nextPort = 49152;
  const stats = { allocations: 0, packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0, refused: 0, dropped: 0, fileBytes: 0, fileDropped: 0 };
  const nonceKey = crypto.randomBytes(16);
  // A nonce says when it was made and is signed, so the server keeps no state for it; it goes stale after 10 minutes.
  const makeNonce = () => { const t = Math.floor(Date.now() / 1000).toString(16); return t + crypto.createHmac('sha256', nonceKey).update(t).digest('hex').slice(0, 16); };
  const nonceState = (n) => {
    const t = n.slice(0, -16), sig = n.slice(-16);
    if (!t || crypto.createHmac('sha256', nonceKey).update(t).digest('hex').slice(0, 16) !== sig) return 'bad';
    return Date.now() / 1000 - parseInt(t, 16) > 600 ? 'stale' : 'ok';
  };
  const memberOf = (user) => user.split(':')[1] || '';
  const tagOf = (user) => user.split(':').slice(2).join(':');
  // ---- what file transfers may send through here (see the top) ----
  const fileMax = { rate: 2 << 20, rateAll: 4 << 20, max: 550e6, day: 5e9, ...files };
  const fileUse = new Map();       // tag -> { tokens, at, bytes }
  const fileAll = { tokens: 0, at: 0, day: '', dayBytes: 0 };
  const isFile = (tag) => tag.startsWith('f.');
  function fileOk(tag, n) {
    const now = Date.now(), today = new Date(now).toISOString().slice(0, 10);
    if (fileAll.day !== today) { fileAll.day = today; fileAll.dayBytes = 0; }
    let u = fileUse.get(tag);
    if (!u) { u = { tokens: fileMax.rate / 2, at: now, bytes: 0 }; fileUse.set(tag, u); }
    const fill = (b, rate) => { b.tokens = Math.min(rate / 2, b.tokens + ((now - b.at) * rate) / 1000); b.at = now; };       // (half a second's worth can go at once)
    fill(u, fileMax.rate); fill(fileAll, fileMax.rateAll);
    if (u.bytes + n > fileMax.max || fileAll.dayBytes + n > fileMax.day || u.tokens < n || fileAll.tokens < n) { stats.fileDropped++; return false; }
    u.tokens -= n; fileAll.tokens -= n; u.bytes += n; fileAll.dayBytes += n; stats.fileBytes += n;
    return true;
  }
  const password = (user) => crypto.createHmac('sha1', secret).update(user).digest('base64');
  const keyFor = (user) => crypto.createHash('md5').update(`${user}:${realm}:${password(user)}`).digest();
  const send = (buf, port, address) => sock.send(buf, port, address);
  const reply = (msg, from, attrs, key) => send(build(msg.method, C.success, msg.tx, [...attrs, [A.software, Buffer.from('drift-turn')]], key), from.port, from.address);
  const fail = (msg, from, code, key, extra = []) => { stats.refused++; send(build(msg.method, C.error, msg.tx, [[A.errorCode, errorBytes(code)], ...extra], key), from.port, from.address); };

  // Long-term credentials: an unsigned request gets a 401 with a realm and nonce; a signed one must use a username
  // that hasn't expired and a fresh nonce. Returns the key to sign the response with, or null after answering.
  function auth(msg, from) {
    const user = msg.attrs.get(A.username), nonce = msg.attrs.get(A.nonce);
    const challenge = [[A.realm, Buffer.from(realm)], [A.nonce, Buffer.from(makeNonce())]];
    if (!user || !nonce || !msg.attrs.has(A.integrity)) { fail(msg, from, 401, null, challenge); return null; }
    const name = user.toString(), exp = parseInt(name.split(':')[0], 10), key = keyFor(name);
    if (!integrityOk(msg, key) || !(exp > Date.now() / 1000)) { fail(msg, from, 401, null, challenge); return null; }
    if (!allowed(memberOf(name), tagOf(name))) { fail(msg, from, 403, key); return null; }       // not in the call (any more), or the transfer is over
    const ns = nonceState(nonce.toString());
    if (ns !== 'ok') { fail(msg, from, 438, null, challenge); return null; }
    return { key, user: name };
  }

  function expire(a) {
    allocs.delete(a.id); byRelay.delete(a.port);
    clearTimeout(a.timer);
    if (a.tag && ![...allocs.values()].some((x) => x.tag === a.tag)) fileUse.delete(a.tag);
    log(`allocation ${a.id} closed`);
  }
  const touch = (a, secs) => { clearTimeout(a.timer); a.timer = setTimeout(() => expire(a), secs * 1000); a.timer.unref?.(); };
  const permitted = (a, ip) => (a.perms.get(ip) || 0) > Date.now();

  function allocate(msg, from, id) {
    const old = allocs.get(id);
    const who = auth(msg, from);
    if (!who) return;
    if (old) {       // a retransmitted Allocate gets the same answer; anything else is a mismatch
      if (old.tx.equals(msg.tx)) return reply(msg, from, [[A.relayed, xaddrBytes(relayHost, old.port)], [A.mapped, xaddrBytes(from.address, from.port)], [A.lifetime, u32(old.lifetime)]], who.key);
      return fail(msg, from, 437, who.key);
    }
    const tr = msg.attrs.get(A.transport);
    if (!tr || tr[0] !== 17) return fail(msg, from, 442, who.key);
    const fam = msg.attrs.get(A.family);
    if (fam && fam[0] !== 0x01) return fail(msg, from, 440, who.key);
    if (msg.attrs.has(A.token) || msg.attrs.has(A.evenPort)) return fail(msg, from, 508, who.key);
    if (allocs.size >= maxAllocations) return fail(msg, from, 486, who.key);
    let mine = 0; for (const x of allocs.values()) if (memberOf(x.user) === memberOf(who.user)) mine++;
    if (mine >= perMember) return fail(msg, from, 486, who.key);       // one member can't use up the hub's room
    let port = nextPort;
    while (byRelay.has(port)) port = port >= 65535 ? 49152 : port + 1;
    nextPort = port >= 65535 ? 49152 : port + 1;
    const want = msg.attrs.get(A.lifetime);
    const a = { id, client: from, user: who.user, tag: tagOf(who.user), key: who.key, tx: Buffer.from(msg.tx), port, perms: new Map(), chans: new Map(), chanOf: new Map(), lifetime: Math.min(MAX_S, Math.max(DEFAULT_S, want ? want.readUInt32BE(0) : DEFAULT_S)), timer: null };
    allocs.set(id, a); byRelay.set(port, a); stats.allocations++;
    touch(a, a.lifetime);
    log(`allocation ${id} for ${who.user} relays on ${relayHost}:${port}`);
    reply(msg, from, [[A.relayed, xaddrBytes(relayHost, port)], [A.mapped, xaddrBytes(from.address, from.port)], [A.lifetime, u32(a.lifetime)]], who.key);
  }
  // A member sends to a peer: only another allocation here can be one.
  function deliver(a, data, peer) {
    const b = peer.address === relayHost && byRelay.get(peer.port);
    if (!b) { stats.dropped++; return; }
    if ((isFile(a.tag) || isFile(b.tag)) && !fileOk(a.tag || b.tag, data.length)) return;       // (a file's allocations only reach each other, but either end's tag counts)
    stats.packetsIn++; stats.bytesIn += data.length;
    fromPeer(b, data, { address: relayHost, port: a.port });
  }

  // A request on an existing allocation must be signed by the same user that made it.
  function owned(msg, from, id) {
    const a = allocs.get(id);
    const who = auth(msg, from);
    if (!who) return null;
    if (!a || a.user !== who.user) { fail(msg, from, 437, who.key); return null; }
    return a;
  }

  function fromClient(buf, from) {
    const id = `${from.address}:${from.port}`;
    if (buf.length >= 4 && buf[0] >= 0x40 && buf[0] <= 0x7f) {       // ChannelData: the cheap way to send
      const a = allocs.get(id), ch = buf.readUInt16BE(0), len = buf.readUInt16BE(2), peer = a && a.chans.get(ch);
      if (!peer || 4 + len > buf.length || !permitted(a, peer.address)) return;
      deliver(a, buf.subarray(4, 4 + len), peer);
      return;
    }
    const msg = parse(buf);
    if (!msg) return;
    if (msg.cls === C.request && msg.method === M.binding) return reply(msg, from, [[A.mapped, xaddrBytes(from.address, from.port)]]);
    if (msg.cls === C.indication && msg.method === M.send) {
      const a = allocs.get(id), peer = xaddr(msg.attrs.get(A.peer), msg.tx), data = msg.attrs.get(A.data);
      if (!a || !peer || !data || !permitted(a, peer.address)) return;
      deliver(a, data, peer);
      return;
    }
    if (msg.cls !== C.request) return;
    if (msg.method === M.allocate) return allocate(msg, from, id);
    if (msg.method === M.refresh) {
      const a = owned(msg, from, id);
      if (!a) return;
      const want = msg.attrs.get(A.lifetime), secs = want ? want.readUInt32BE(0) : DEFAULT_S;
      if (secs === 0) { reply(msg, from, [[A.lifetime, u32(0)]], a.key); expire(a); return; }
      a.lifetime = Math.min(MAX_S, Math.max(DEFAULT_S, secs)); touch(a, a.lifetime);
      return reply(msg, from, [[A.lifetime, u32(a.lifetime)]], a.key);
    }
    if (msg.method === M.permission) {
      const a = owned(msg, from, id);
      if (!a) return;
      const peers = msg.order.filter((x) => x.t === A.peer).map((x) => xaddr(msg.raw.subarray(x.at + 4, x.at + 4 + msg.raw.readUInt16BE(x.at + 2)), msg.tx));
      if (!peers.length || peers.some((p) => !p)) return fail(msg, from, 400, a.key);
      for (const p of peers) a.perms.set(p.address, Date.now() + PERMISSION_S * 1000);
      return reply(msg, from, [], a.key);
    }
    if (msg.method === M.channelBind) {
      const a = owned(msg, from, id);
      if (!a) return;
      const cv = msg.attrs.get(A.channel), peer = xaddr(msg.attrs.get(A.peer), msg.tx), ch = cv && cv.readUInt16BE(0), pk = peer && `${peer.address}:${peer.port}`;
      if (!peer || !(ch >= 0x4000 && ch <= 0x4fff) || (a.chans.has(ch) && `${a.chans.get(ch).address}:${a.chans.get(ch).port}` !== pk) || (a.chanOf.has(pk) && a.chanOf.get(pk) !== ch)) return fail(msg, from, 400, a.key);
      a.chans.set(ch, peer); a.chanOf.set(pk, ch);
      a.perms.set(peer.address, Date.now() + Math.max(PERMISSION_S, CHANNEL_S) * 1000);
      return reply(msg, from, [], a.key);
    }
    fail(msg, from, 400);
  }

  // Something arrived at a's relay address from a peer: forward it to a's member if they asked to hear from that peer.
  function fromPeer(a, data, peer) {
    if (!permitted(a, peer.address)) return;
    stats.packetsOut++; stats.bytesOut += data.length;
    const ch = a.chanOf.get(`${peer.address}:${peer.port}`);
    if (ch) {
      const h = Buffer.alloc(4); h.writeUInt16BE(ch); h.writeUInt16BE(data.length, 2);
      send(Buffer.concat([h, data]), a.client.port, a.client.address);
    } else send(build(M.data, C.indication, crypto.randomBytes(12), [[A.peer, xaddrBytes(peer.address, peer.port)], [A.data, data]]), a.client.port, a.client.address);
  }

  sock.on('message', (buf, from) => { try { fromClient(buf, from); } catch (e) { log('bad packet: ' + e.message); } });
  return {
    listen: (port, host) => new Promise((ok, no) => { sock.once('error', no); sock.bind(port, host, () => {
      sock.off('error', no);
      // Windows' default 64 KB socket buffer drops video bursts before they're read (docs/plans/broadcast.md, spike C): 4 MB holds them
      try { sock.setRecvBufferSize(4 << 20); sock.setSendBufferSize(4 << 20); } catch (e) { log('udp buffers: ' + e.message); }
      sock.on('error', (e) => log('udp: ' + e.message)); ok(sock.address()); }); }),
    credentials: (member, secs = 3600, tag = '') => { const username = `${Math.floor(Date.now() / 1000) + secs}:${member}${tag ? ':' + tag : ''}`; return { username, credential: password(username) }; },
    stats: () => ({ ...stats, open: allocs.size, fileDay: fileAll.dayBytes }),
    // they left the call: stop relaying for them now (with a tag, only those allocations: a file transfer that ended)
    drop: (member, tag) => { for (const a of [...allocs.values()]) if (memberOf(a.user) === member && (tag === undefined ? !a.tag : a.tag === tag)) expire(a); },
    dropTag: (tag) => { for (const a of [...allocs.values()]) if (a.tag === tag) expire(a); },
    port: () => sock.address().port,
    close: () => { for (const a of [...allocs.values()]) expire(a); sock.close(); },
  };
};
module.exports._test = { parse, build, integrityOk, xaddr, xaddrBytes, typeOf };
