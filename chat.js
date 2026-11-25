// Drift — chat, this PC's side (docs/plans/voice-and-chat.md). Holds this PC's identity key, the hubs it belongs to
// and the connections to them, and runs a hub of its own when this PC hosts one (hub.js). The renderer reaches all of
// it through main.js over IPC; nothing here touches the page, and no message is ever turned into HTML here.
//
// hooks (from main.js; plain functions so this also runs under plain Node for tests):
//   seal(buf) / unseal(buf)   encrypt what is kept on disk (Electron's safeStorage), or pass it through
//   addrs()                   this PC's addresses for invites, LAN and public
//   upnp(port, proto)         promise of { ip, remove() }: open the hub's port (TCP) or voice relay (UDP) on the router (p2p.upnpMap), or reject
//   changed()                 the list of hubs, or one hub's state, changed
//   event(hubId, m)           something arrived from a hub: msg, gone, typing, members, channels, lives, removed,
//                             and for voice: voice-room, voice-room-off, voice-peers, voice-sdp, voice-candidate, voice-refused,
//                             voice-told, voice-verdict, voice-left, voice-ended, voice-said,
//                             and for broadcasts (each with `bc`, the broadcast id): bc-viewer, bc-viewer-left, bc-off
//                             (ours ended), bc-watch-off, bc-sdp, bc-candidate, bc-refused, bc-told, bc-verdict
//                             and for the Surf stream (docs/plans/streams.md): ss-wake (a member wants it and it isn't running:
//                             start it), ss-viewer, ss-viewer-left (host), ss-watch-off (member), ss-sdp, ss-candidate,
//                             ss-refused, ss-told, ss-verdict (both)
//   log(text)
//
// Voice (docs/plans/broadcast.md §1): one room per hub, and this PC is in the room of one hub at a time, its active hub.
// The hub only passes setup messages along, and it may be hostile. So every
// SDP this PC sends is signed here with its identity key, over the room, who it's from and for, a fresh nonce and its
// a=fingerprint lines (voiceText below), and every SDP that arrives is checked here against the sender's key before
// the voice window sees it. The window only ever gets SDPs that passed, and verdicts; never a key.
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const createHub = require('./hub');
const { wire, isPublic } = require('./p2p');
const { decodeInvite, pinOfPeer, memberId, rawKey, loginText, cleanAvatar, avatarId, LIMITS } = createHub;

// ---- checking what the hub says about people ----
const keyFromRaw = (raw) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
const rawOf = (k) => { try { const b = Buffer.from(String(k || ''), 'base64url'); return b.length === 32 ? b : null; } catch { return null; } };
// A member list from the hub: an entry counts only if its public key really hashes to its member id. Anything else is
// the hub (or a fault) making someone up, and is set aside with the name it claimed, so the panel can say so.
function checkMembers(list) {
  const good = [], bad = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x.id !== 'string') continue;
    const raw = rawOf(x.key);
    if (raw && memberId(raw) === x.id) good.push({ ...x, raw }); else bad.push({ id: x.id, name: String(x.name || '').slice(0, LIMITS.name) });
  }
  return { good, bad };
}
// A safety number: 12 digits that two people get the same of, made from both their public keys, to compare in person
// (or on the phone). If they match, nobody (not even the hub) has put a key of its own between them. It goes through
// scrypt so that finding another key with the same 12 digits takes far too long to be worth trying.
function safetyNumber(a, b) {
  const [x, y] = [Buffer.from(a), Buffer.from(b)].sort(Buffer.compare);
  return new Promise((resolve, reject) => crypto.scrypt(Buffer.concat([x, y]), 'drift-safety-v1', 16, { N: 16384, r: 8, p: 1 }, (e, out) => {
    if (e) { reject(e); return; }
    const n = (out.readBigUInt64BE(0) % 10n ** 12n).toString().padStart(12, '0');
    resolve(n.match(/..../g).join(' '));
  }));
}
// ---- signed setup messages for calls ----
// What gets signed: who and what the SDP is for, and its DTLS certificate fingerprints. A hub that swaps a fingerprint
// (to sit in the middle), strips the signature, hands one person's SDP to another, or replays one into another call
// (a different room id) or into the same one (a nonce already seen, or not the one the offer asked for) is refused.
// (The signed text still says "call": a room id goes where the call id went, so the format is unchanged.)
const fingerprints = (sdp) => (String(sdp || '').match(/^a=fingerprint:[^\r\n]*/gm) || []).map((l) => l.trim().replace(/\s+/g, ' ').toLowerCase()).sort();
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
function voiceText({ pin, call, from, to, nonce, sdp }) {
  const p = fingerprints(sdp);
  if (!p.length || ![pin, call, from, to, nonce].every((v) => TOKEN.test(String(v)))) return null;
  return Buffer.from(['drift-voice-v1', pin, call, from, to, nonce, ...p].join('\n'));
}
function signSdp(key, f) { const t = voiceText(f); return t ? crypto.sign(null, t, key).toString('base64url') : null; }
function verifySdp(raw, f, sig) {
  try {
    const t = voiceText(f);
    return !!t && !!raw && raw.length === 32 && memberId(raw) === f.from && typeof sig === 'string' && crypto.verify(null, t, keyFromRaw(raw), Buffer.from(sig, 'base64url'));
  } catch { return false; }
}
// Broadcasts (docs/plans/broadcast.md §2) are signed the same way, under their own first line so that a voice SDP can't
// pass as a broadcast one or the other way round, and with the broadcast id as well as the room. A viewer asks with a
// signed `want` (no SDP, so no fingerprints) carrying a fresh nonce; the broadcaster's offer must carry that nonce,
// and the viewer's answer the same one again. The type is signed too, so nothing signed as one can pass as another.
const BC_TYPES = ['want', 'offer', 'answer'];
function bcText({ pin, room, bc, type, from, to, nonce, sdp }) {
  const p = type === 'want' ? [] : fingerprints(sdp);
  if (!BC_TYPES.includes(type) || (type !== 'want' && !p.length) || ![pin, room, bc, from, to, nonce].every((v) => TOKEN.test(String(v)))) return null;
  return Buffer.from(['drift-broadcast-v1', type, pin, room, bc, from, to, nonce, ...p].join('\n'));
}
function signBc(key, f) { const t = bcText(f); return t ? crypto.sign(null, t, key).toString('base64url') : null; }
function verifyBc(raw, f, sig) {
  try {
    const t = bcText(f);
    return !!t && !!raw && raw.length === 32 && memberId(raw) === f.from && typeof sig === 'string' && crypto.verify(null, t, keyFromRaw(raw), Buffer.from(sig, 'base64url'));
  } catch { return false; }
}
// A broadcast's still for the Broadcast grid (§5) is signed by the broadcaster under a line of its own, so a hub can't put a
// picture of its own on someone's tile. The broadcast id is fresh for each broadcast, so a still can't be moved onto another.
function stillText({ pin, bc, from, img }) {
  if (![pin, bc, from].every((v) => TOKEN.test(String(v))) || typeof img !== 'string' || !img) return null;
  return Buffer.from(['drift-broadcast-still-v1', pin, bc, from, crypto.createHash('sha256').update(img).digest('base64url')].join('\n'));
}
// The Surf stream (docs/plans/streams.md §2) is signed the same way again, under its own first line: the host's browser,
// streamed to each member watching. Its room id is the stream's own (new each time it starts, and when someone is removed).
// A member asks with a signed `want`, the host's offer carries that nonce, and the member's answer the same one again.
function ssText({ pin, room, type, from, to, nonce, sdp }) {
  const p = type === 'want' ? [] : fingerprints(sdp);
  if (!BC_TYPES.includes(type) || (type !== 'want' && !p.length) || ![pin, room, from, to, nonce].every((v) => TOKEN.test(String(v)))) return null;
  return Buffer.from(['drift-surf-stream-v1', type, pin, room, from, to, nonce, ...p].join('\n'));
}
function signSs(key, f) { const t = ssText(f); return t ? crypto.sign(null, t, key).toString('base64url') : null; }
function verifySs(raw, f, sig) {
  try {
    const t = ssText(f);
    return !!t && !!raw && raw.length === 32 && memberId(raw) === f.from && typeof sig === 'string' && crypto.verify(null, t, keyFromRaw(raw), Buffer.from(sig, 'base64url'));
  } catch { return false; }
}
const nonce = () => crypto.randomBytes(16).toString('base64url');

module.exports = function createChat(opts) {       // (module.exports.decodeInvite: is this a hub's invite?)
  const dir = opts.dir, log = opts.log || (() => {});
  const seal = opts.seal || ((b) => b), unseal = opts.unseal || ((b) => b);
  fs.mkdirSync(dir, { recursive: true });
  const file = (n) => path.join(dir, n);
  const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
  const writeJson = (n, v) => { const f = file(n); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); };

  // ---- who this PC is: an Ed25519 key made on first use, kept encrypted ----
  let me = readJson('identity.json', null), key = null;
  if (me && me.key) { try { key = crypto.createPrivateKey(Buffer.from(unseal(Buffer.from(me.key, 'base64'))).toString()); } catch (e) { log('chat: the identity key could not be opened: ' + e.message); } }
  if (!key) {
    if (me && me.key) fs.renameSync(file('identity.json'), file(`identity-unreadable-${Date.now()}.json`));       // keep it, in case it can be read on another day
    key = crypto.generateKeyPairSync('ed25519').privateKey;
    me = { key: Buffer.from(seal(Buffer.from(key.export({ type: 'pkcs8', format: 'pem' })))).toString('base64'), name: me && me.name || '' };
    writeJson('identity.json', me);
  }
  const pub = rawKey(crypto.createPublicKey(key)), myId = memberId(pub);
  const sign = (b) => crypto.sign(null, b, key).toString('base64url');

  // ---- the hubs this PC belongs to ----
  // saved: { id (the certificate pin), port, addrs, name, token (until joined), joined, gone (why we can't go back) }
  const saved = readJson('hubs.json', []).filter((h) => h && h.id && h.port && Array.isArray(h.addrs));
  const blocked = new Set(readJson('blocked.json', []));
  const conns = new Map();        // hub id -> live state
  const save = () => writeJson('hubs.json', saved);

  // ---- who we've met: trust on first use, per hub ----
  // trust[hub][member id] = { name (the first name seen with that id), key, at, verified (safety number compared) }.
  // If a name we know turns up under a different id, the panel warns: it may be a new PC, or the hub pretending.
  const trust = readJson('trust.json', {});
  const saveTrust = () => writeJson('trust.json', trust);
  function meet(c) {
    const t = trust[c.h.id] || (trust[c.h.id] = {});
    let added = false;
    for (const m of c.members) if (m.id !== myId && !t[m.id]) { t[m.id] = { name: m.name, key: m.key, at: Date.now() }; added = true; }
    if (added) saveTrust();
  }
  // Members whose name matches someone we met earlier under another id, and who haven't been checked with a safety number.
  function lookalikes(c) {
    const t = trust[c.h.id] || {}, out = [];
    for (const m of c.members) {
      if (m.id === myId || (t[m.id] && t[m.id].verified)) continue;
      const since = t[m.id] ? t[m.id].at : Infinity;
      const was = Object.entries(t).find(([id, r]) => id !== m.id && r.at <= since && r.name.toLowerCase() === m.name.toLowerCase());
      if (was) out.push({ id: m.id, name: m.name, was: was[0] });
    }
    return out;
  }
  function setMembers(c, list) {
    const { good, bad } = checkMembers(list);
    c.keys = new Map(good.map((m) => [m.id, m.raw]));
    c.members = good.map(({ raw, ...m }) => m);
    for (const b of bad) if (!c.suspect.has(b.id)) log(`chat: ${c.h.name || c.h.id} sent a key for "${b.name}" that doesn't match their id; ignoring it`);
    c.suspect = new Map(bad.map((b) => [b.id, b.name]));
    meet(c);
  }

  // ---- hosting: this PC runs a hub of its own ----
  // fresh: the first time this run hosts, last run's messages are wiped (they last one session; see stop()).
  let hosting = readJson('hosting.json', null), hub = null, mappings = [], hostNote = '', fresh = true;
  async function startHub() {
    hub = createHub({ dir: file('hub'), owner: pub, name: hosting.name, port: hosting.port, seal, unseal, addrs: () => opts.addrs ? opts.addrs() : ['127.0.0.1'], log, fresh });
    fresh = false;
    const port = await hub.start();
    if (port !== hosting.port) { hosting.port = port; writeJson('hosting.json', hosting); }
    let h = saved.find((x) => x.id === hub.pin.toString('base64url'));
    if (!h) { h = { id: hub.pin.toString('base64url'), port, addrs: [], name: hub.name(), joined: true, mine: true }; saved.unshift(h); }
    Object.assign(h, { port, addrs: ['127.0.0.1', '::1'], mine: true, gone: '' }); save();       // the host reaches its own hub here
    hostNote = '';
    openService();       // the Surf stream's line to this hub, in-process
    if (hosting.internet && opts.upnp) {
      // The hub's TCP port, and the voice relay's UDP port beside it (the same number when it was free).
      const udp = hub.voicePort(), mine = hub;
      const ports = [[port, 'TCP'], ...(udp ? [[udp, 'UDP']] : [])];
      Promise.allSettled(ports.map(([p, proto]) => opts.upnp(p, proto))).then((rs) => {
        const ok = rs.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        if (hub === mine) mappings.push(...ok); else for (const m of ok) m.remove();
        if (ok.length < ports.length) {
          const need = udp ? (udp === port ? `port ${port} (TCP and UDP)` : `TCP port ${port} and UDP port ${udp}`) : `TCP port ${port}`;
          hostNote = `Friends on your own network can join. For friends elsewhere, ${need} has to be forwarded to this PC in the router's settings.`; opts.changed && opts.changed();
        }
      });
    }
    away.delete(h.id); resting.delete(h.id); open(h);       // hosting is being online in it too
  }
  // Host: start the hub this PC hosts and go online in it, making one first if there's none (its name and port are kept).
  async function host({ name, internet = true } = {}) {
    if (hub) return info();
    hosting = { name: String(name || '').slice(0, LIMITS.name) || (hosting && hosting.name) || `${me.name || 'My'} hub`, port: hosting && hosting.port || 47900, internet: !!internet };
    writeJson('hosting.json', hosting);
    await startHub();
    return info();
  }
  // Stop hosting: the hub stops for everyone. Its name, members and invites are kept (and this session's messages, until
  // Drift closes), so Host brings it back with the same invites. forget also drops the hub's name and port.
  async function unhost({ forget = false } = {}) {
    if (hub) {
      log('chat: stopped hosting');
      const id = hub.pin.toString('base64url');
      closeService();
      const h = hub; hub = null;
      close(id);
      await h.stop();
      for (const m of mappings.splice(0)) m.remove();
    }
    if (forget) { hosting = null; try { fs.unlinkSync(file('hosting.json')); } catch { /* gone */ } }
    changed();
  }

  // ---- connecting to a hub ----
  // Every address is tried at once; the first one whose certificate matches the pin wins.
  function dial(h) {
    const pin = Buffer.from(h.id, 'base64url');
    return new Promise((resolve, reject) => {
      let left = h.addrs.length, won = false;
      if (!left) { reject(new Error('no address')); return; }
      for (const addr of h.addrs) {
        const sock = tls.connect({ host: addr, port: h.port, minVersion: 'TLSv1.3', rejectUnauthorized: false, timeout: 7000, servername: undefined });
        const fail = () => { sock.destroy(); if (!--left && !won) reject(new Error('unreachable')); };
        sock.once('secureConnect', () => {
          const got = pinOfPeer(sock);
          if (won || !got || !got.equals(pin)) { fail(); return; }       // not our hub: someone else answering at that address
          won = true; sock.setTimeout(0); sock.driftAddr = addr; resolve(sock);       // (the address that worked: calls reach the hub's relay there too)
        });
        sock.once('timeout', fail); sock.once('error', fail);
      }
    });
  }
  function open(h) {
    if (conns.has(h.id)) return conns.get(h.id);
    const c = { h, status: 'connecting', note: '', wire: null, me: null, host: false, members: [], keys: new Map(), suspect: new Map(), voice: [], addr: '', channels: [], lives: [], typing: new Map(), pending: new Map(), seq: 0, retry: null, tries: 0, pinger: null, seen: 0, closed: false, roomId: '', oldRoomId: '', inRoom: false, roomNote: '', bumped: false, sent: '', rosterSeq: 0, bcs: [], surf: null };
    conns.set(h.id, c);
    connect(c);
    return c;
  }
  async function connect(c) {
    if (c.closed) return;
    let sock = null;
    try { sock = await dial(c.h); } catch { sock = null; }
    if (c.closed) { if (sock) sock.destroy(); return; }
    if (!sock) { again(c, c.h.joined ? 'Can\'t reach this hub right now. Drift keeps trying.' : 'Couldn\'t reach that hub. Check that the host\'s Drift is open.'); return; }
    sock.on('error', (e) => log(`chat: ${c.h.name || c.h.id}: ${e.message}`));
    c.addr = sock.driftAddr || '';
    c.wire = wire(sock, null, (m) => onMessage(c, m), () => {
      log(`chat: the connection to ${c.h.name || c.h.id} closed`);
      clearInterval(c.pinger); c.wire = null; c.voice = []; c.roomId = ''; c.oldRoomId = ''; c.inRoom = false; c.roomNote = ''; c.sent = ''; c.bcs = []; c.surf = null;
      ssGone(c.h.id, 'The connection to the hub dropped.');
      if (call && call.hub === c.h.id) endCall('');       // back in the room by itself once the hub is reachable again
      bcHubGone(c.h.id, 'The connection to the hub dropped.');       // the hub has ended them too
      for (const p of c.pending.values()) p({ error: 'The connection to the hub dropped.' });
      c.pending.clear();
      if (!c.closed && !c.h.gone) again(c, 'Reconnecting...');
    }, 4 * 1024 * 1024);
    c.seen = Date.now();
    c.pinger = setInterval(() => { if (Date.now() - c.seen > 45000) c.wire && c.wire.close(); else c.wire && c.wire.send({ t: 'ping' }); }, 15000);
  }
  function again(c, note) {
    c.status = 'offline'; c.note = note; changed();
    if (!c.h.joined && c.tries > 3) { c.note = 'Couldn\'t reach that hub. Check that the host\'s Drift is open, then try the invite again.'; return; }
    const ms = Math.min(30000, 1000 * 2 ** Math.min(5, c.tries++));
    c.retry = setTimeout(() => connect(c), ms);
  }
  function onMessage(c, m) {
    c.seen = Date.now();
    if (m.t === 'hello') {
      c.stillMax = Math.min(LIMITS.bcThumb, +m.still > 0 ? +m.still : 14000);       // a longer line than a hub takes and it hangs up on us
      const auth = { t: 'auth', re: 'auth', key: pub.toString('base64url'), sig: sign(loginText(Buffer.from(c.h.id, 'base64url'), String(m.nonce))), name: me.name || 'Friend' };
      if (!c.h.joined && c.h.token) auth.invite = c.h.token;
      c.wire.send(auth);
      return;
    }
    if (m.re === 'auth') {
      if (m.t === 'err') {
        c.note = String(m.error || 'The hub said no.');
        if (m.gone) { c.h.gone = c.note; save(); c.closed = true; c.status = 'gone'; c.wire.close(); }
        changed(); return;
      }
      c.status = 'connected'; c.note = ''; c.tries = 0;
      c.me = m.me; c.host = !!m.host; setMembers(c, m.members); c.channels = m.channels || []; c.lives = Array.isArray(m.lives) ? m.lives : []; c.voice = Array.isArray(m.voice) ? m.voice : []; c.roomId = TOKEN.test(String(m.room || '')) ? String(m.room) : ''; c.oldRoomId = ''; c.bcs = cleanBcs(m.bcs); c.surf = cleanSurf(m.surf);
      if (myLive && myLive.hub === c.h.id) sendLive(c, myLive.live);       // still sharing: tell the hub again after a reconnect
      const mine = c.members.find((x) => x.id === myId), want = avatarId(me.avatar || '');
      if (mine && (mine.av || '') !== want) c.wire.send({ t: 'avatar', re: 'av', data: me.avatar || '' });       // a picture chosen (or removed) while away
      if (myMic !== null) c.wire.send({ t: 'mic', on: myMic });
      if (myWhere) c.wire.send({ t: 'where', at: myWhere });
      Object.assign(c.h, { joined: true, token: undefined, name: String(m.hub || c.h.name || 'Hub').slice(0, 40) });
      if (Array.isArray(m.addrs) && m.addrs.length && !c.h.mine) c.h.addrs = [...new Set([...m.addrs, ...c.h.addrs])].slice(0, 8);
      save(); changed();
      opts.event && opts.event(c.h.id, { t: 'ready' });
      syncVoice();       // the active hub: back into its voice room
      return;
    }
    if (m.re === 'av') return;
    if (m.re !== undefined && c.pending.has(m.re)) { const p = c.pending.get(m.re); c.pending.delete(m.re); p(m.t === 'err' ? { ...m, error: String(m.error || 'The hub said no.') } : m); return; }
    switch (m.t) {
      case 'pong': return;
      case 'members': setMembers(c, m.list); changed(); break;
      case 'voice': c.rosterSeq++; c.voice = Array.isArray(m.list) ? m.list : []; onRoster(c, m.room); changed(); return;
      case 'voice-signal': onSignal(c, m); return;
      case 'voice-ended': c.inRoom = false; c.bumped = true; c.roomNote = String(m.why || '').slice(0, 200); if (call && call.hub === c.h.id) endCall(c.roomNote); changed(); return;
      case 'bc': c.bcs = cleanBcs(m.list); onBcRoster(c); changed(); return;
      case 'bc-ended': if (myBc && myBc.hub === c.h.id && myBc.id === m.id) endMyBc(String(m.why || '').slice(0, 200)); return;
      case 'bc-signal': onBcSignal(c, m); return;
      case 'bc-thumb': onBcThumb(c, m); return;
      case 'surf': c.surf = cleanSurf(m.s); onSsRoster(c); changed(); return;
      case 'surf-signal': onSsMember(c, m); return;
      case 'channels': c.channels = Array.isArray(m.list) ? m.list : []; changed(); break;
      case 'lives': c.lives = Array.isArray(m.list) ? m.list : []; changed(); break;
      case 'media-vote': if (!m.vote || typeof m.vote !== 'object') return; c.mediaVote = m.vote.result ? null : { ...m.vote, at: Date.now() }; changed(); break;       // a vote to change what's on (the hub counts it)
      case 'live-no': break;       // the hub didn't list our share, or took it off: someone else's is on, or someone can't reach this PC (why: 'reach', 'unreached'; who: their names)
      case 'msg': if (m.msg && blocked.has(m.msg.from)) return; if (m.msg) m.msg = unblocked(m.msg); break;
      case 'react': if (Array.isArray(m.reacts)) m.reacts = unblocked({ reacts: m.reacts }).reacts || []; break;
      case 'typing': if (blocked.has(m.from)) return; break;
      case 'removed': c.h.gone = 'The host removed you from this hub.'; save(); c.closed = true; c.status = 'gone'; c.note = c.h.gone; changed(); break;
      case 'bye': break;
      case 'gone': break;
      default: return;
    }
    opts.event && opts.event(c.h.id, m);
  }
  // Ask a hub something; resolves with its answer, or { error }.
  function ask(id, m, ms = 15000) {
    const c = conns.get(id);
    if (!c || c.status !== 'connected' || !c.wire) return Promise.resolve({ error: 'Not connected to that hub right now.' });
    const re = 'r' + (++c.seq);
    return new Promise((resolve) => {
      const t = setTimeout(() => { c.pending.delete(re); resolve({ error: 'The hub didn\'t answer.' }); }, ms);
      c.pending.set(re, (r) => { clearTimeout(t); resolve(r); });
      c.wire.send({ ...m, re });
    });
  }
  function close(id) {
    const c = conns.get(id);
    if (!c) return;
    c.closed = true; clearTimeout(c.retry); clearInterval(c.pinger);
    if (c.wire) c.wire.close();
    conns.delete(id);
    if (call && call.hub === id) endCall('');
    bcHubGone(id, '');
    ssGone(id, '');
  }

  // ---- sharing (the Hub tab): which hub hears about it ----
  // live: { code, title, watching } while this PC shares into hub `id`; null when it stops.
  let myLive = null;
  const sendLive = (c, live) => { if (c && c.wire && c.status === 'connected') c.wire.send(live ? { t: 'live', on: true, ...live } : { t: 'live', on: false }); };
  function announce(id, live) {
    const was = myLive;
    myLive = id && live ? { hub: id, live } : null;
    if (was && (!myLive || was.hub !== id)) sendLive(conns.get(was.hub), null);
    if (myLive) sendLive(conns.get(id), live);
  }

  // ---- voice: the active hub's room ----
  // want: what main.js asks for (the active hub, whether to listen, whether the microphone is open and working).
  // call: this PC in a room while it listens: { hub, id (the room id, signed into every setup message; oldId: the one
  // before it changed, for answers to offers made just before), peers (who else is in the room and listening), want
  // (peer -> whether this PC makes the offer: the connections to have), offered (peer -> the nonce of our offer that
  // their answer must carry), toAnswer (peer -> the nonce of their offer, for our answer), seen (nonces already
  // accepted), prints (peer -> the fingerprints we checked for them), refused (peer -> why), verdict (peer -> 'verified'
  // | 'mismatch'), told (peers who refused us) }
  let want = { hub: '', listen: true, talk: false, mic: false };
  let call = null;
  // Up to this many people listening, everyone connects to everyone (as calls always did), so nobody's first word is
  // clipped. Above it, a connection is only made where at least one of the two is talking (decision §11.1).
  const PRECONNECT = opts.preconnect !== undefined ? opts.preconnect : 8;
  const emit = (hub, m) => opts.event && opts.event(hub, m);
  const nameIn = (c, id) => { const m = c && c.members.find((x) => x.id === id); return m ? m.name : (c && c.suspect.get(id)) || 'someone'; };
  // Where to reach the hub's relay: the address this PC reached the hub at, unless that was this PC itself (Chromium
  // won't relay through 127.0.0.1) or IPv6 (the relay is IPv4); then the hub's own addresses, nearest first.
  function relayServer(c, r) {
    if (!r.relay || !(r.relay.port > 0)) return null;
    const v4 = /^\d+\.\d+\.\d+\.\d+$/, loop = /^(127\.|::1$|::ffff:127\.)/;
    const hosts = (Array.isArray(r.hosts) ? r.hosts : []).filter((x) => v4.test(x) && !loop.test(x));
    const pub = hosts.filter(isPublic), near = hosts.filter((x) => !isPublic(x));
    const host = v4.test(c.addr) && !loop.test(c.addr) ? c.addr : (loop.test(c.addr) || !c.addr.includes(':') ? [...near, ...pub] : [...pub, ...near])[0];
    return host ? { urls: `turn:${host}:${r.relay.port}?transport=udp`, username: String(r.relay.username), credential: String(r.relay.credential) } : null;
  }
  function setVoice(w = {}) {
    if (w.hub !== undefined && String(w.hub) !== want.hub) for (const c of conns.values()) { c.bumped = false; c.roomNote = ''; }       // picking a hub again takes the room back
    want = { hub: w.hub !== undefined ? String(w.hub) : want.hub, listen: w.listen !== undefined ? !!w.listen : want.listen, talk: w.talk !== undefined ? !!w.talk : want.talk, mic: w.mic !== undefined ? !!w.mic : want.mic };
    syncVoice();
  }
  // Tell each hub whether this PC is in its room, and how. Only what changed is sent.
  function syncVoice() {
    for (const c of conns.values()) {
      const up = c.status === 'connected' && !!c.wire, mine = up && c.h.id === want.hub && !c.bumped;
      if (!mine) {
        if (c.inRoom && up) c.wire.send({ t: 'voice-state', on: false });
        c.inRoom = false; c.sent = '';
        if (call && call.hub === c.h.id) endCall('');
        continue;
      }
      const st = { on: true, listen: want.listen, talk: want.listen && want.talk, mic: want.listen && want.talk && want.mic };
      const key = JSON.stringify(st);
      if (key === c.sent) continue;
      c.sent = key;
      const seq = c.rosterSeq;
      ask(c.h.id, { t: 'voice-state', ...st }).then((r) => onVoiceReply(c, st, key, r, seq));
    }
  }
  // (The reply's roster and room id are as they were when the hub answered: a roster message that came after it, and was
  // handled first, is newer, so the reply's are only taken when none has.)
  function onVoiceReply(c, st, key, r, seq) {
    if (c.sent !== key || conns.get(c.h.id) !== c) return;       // something newer was asked meanwhile
    if (r.error) {
      c.roomNote = String(r.error).slice(0, 200);
      if (r.talkers) { emit(c.h.id, { t: 'voice-said', why: c.roomNote, talk: false }); c.sent = ''; return changed(); }       // main.js closes the microphone again
      c.inRoom = false;
      if (call && call.hub === c.h.id) endCall('');
      return changed();
    }
    c.inRoom = true; c.roomNote = '';
    if (c.rosterSeq === seq) { if (Array.isArray(r.list)) c.voice = r.list; if (TOKEN.test(String(r.room || ''))) setRoom(c, String(r.room)); }
    if (!st.listen) { if (call && call.hub === c.h.id) endCall(''); return changed(); }
    const server = relayServer(c, r);
    if (!call || call.hub !== c.h.id) {
      if (call) endCall('');
      call = { hub: c.h.id, id: c.roomId, oldId: '', peers: new Set(), want: new Map(), offered: new Map(), toAnswer: new Map(), seen: new Set(), prints: new Map(), refused: new Map(), verdict: new Map(), told: new Set(), wantKey: '' };
      log(`chat: in the voice room of ${c.h.name}${server ? ', relayed through ' + server.urls : ', with no relay'}`);
      emit(c.h.id, { t: 'voice-room', me: myId, iceServers: server ? [server] : [] });
    }
    onRoster(c, c.roomId);
    changed();
  }
  function endCall(why) {
    if (!call) return;
    const id = call.hub;
    call = null;
    emit(id, { t: 'voice-room-off', why });
    changed();
  }
  // Which connections this PC should have: with everyone listening while the room is small, else only where one of
  // the two is talking. Both sides work it out the same way from the same roster, and the lower id makes the offer.
  function wanted(c) {
    const list = (c.voice || []).filter((v) => v && typeof v.id === 'string' && v.listen);
    const me = list.find((v) => v.id === myId), out = new Map();
    if (!me) return out;
    for (const v of list) if (v.id !== myId && (list.length <= PRECONNECT || me.talk || v.talk)) out.set(v.id, myId < v.id);
    return out;
  }
  // The hub's roster changed: who left starts afresh if they come back, and the connections to have are worked out again.
  function onRoster(c, room) {
    if (TOKEN.test(String(room || '')) && room !== c.roomId) setRoom(c, String(room));
    if (!call || call.hub !== c.h.id) return;
    const now = new Set(c.voice.filter((v) => v && v.listen && typeof v.id === 'string' && v.id !== myId).map((v) => v.id));
    for (const id of call.peers) {
      if (now.has(id)) continue;
      for (const k of ['offered', 'toAnswer', 'prints', 'refused', 'verdict']) call[k].delete(id);
      call.told.delete(id);
      emit(c.h.id, { t: 'voice-left', id });
    }
    call.peers = now;
    call.want = wanted(c);
    const key = JSON.stringify([...call.want].sort());
    if (key !== call.wantKey) { call.wantKey = key; emit(c.h.id, { t: 'voice-peers', list: [...call.want].map(([id, offer]) => ({ id, offer })) }); }
  }
  // From the voice window: a setup message for `peer`. SDPs are signed here; ICE candidates go as they are (a hub that
  // changes them can only stop the connection, not listen to it).
  function voiceSignal(peer, d) {
    const c = call && conns.get(call.hub);
    if (!c || !c.wire || !d || !call.peers.has(peer) || call.refused.has(peer)) return;
    if (d.c && typeof d.c === 'object') { c.wire.send({ t: 'voice-signal', to: peer, d: { c: d.c } }); return; }
    const type = d.sdp && d.sdp.type, sdp = d.sdp && String(d.sdp.sdp || '');
    if (!sdp || (type !== 'offer' && type !== 'answer')) return;
    let n = '';
    if (type === 'offer') { n = nonce(); call.offered.set(peer, n); }       // fresh for each offer: their answer must carry it back
    else { n = call.toAnswer.get(peer) || ''; call.toAnswer.delete(peer); }
    const sig = n && signSdp(key, { pin: call.hub, call: call.id, from: myId, to: peer, nonce: n, sdp });
    if (!sig) { log('chat: a voice setup message could not be signed, so it was not sent'); return; }
    c.wire.send({ t: 'voice-signal', to: peer, d: { sdp: { type, sdp }, nonce: n, sig } });
  }
  function onSignal(c, m) {
    if (!call || call.hub !== c.h.id) return;
    const from = String(m.from || ''), d = m.d && typeof m.d === 'object' ? m.d : {};
    if (!call.peers.has(from) || call.refused.has(from)) return;
    if (d.refused) {       // they couldn't verify us
      if (!call.told.has(from)) { call.told.add(from); emit(c.h.id, { t: 'voice-told', from, name: nameIn(c, from) }); changed(); }
      return;
    }
    if (d.c) { emit(c.h.id, { t: 'voice-candidate', from, c: d.c }); return; }
    if (!d.sdp) return;
    const type = d.sdp.type, sdp = String(d.sdp.sdp || ''), n = String(d.nonce || '');
    const why = checkIncoming(c, from, type, sdp, n, d.sig);
    if (why) { refuse(c, from, why); return; }
    call.seen.add(n);
    if (type === 'offer') call.toAnswer.set(from, n); else call.offered.delete(from);
    call.prints.set(from, fingerprints(sdp));
    call.verdict.delete(from);
    emit(c.h.id, { t: 'voice-sdp', from, sdp: { type, sdp } });       // exactly what was checked
  }
  function checkIncoming(c, from, type, sdp, n, sig) {
    if (type !== 'offer' && type !== 'answer') return 'it wasn\'t an offer or an answer';
    const raw = c.keys.get(from);
    if (!raw) return 'the hub has no key for them that matches their id';
    if (!sig) return 'it wasn\'t signed';
    if (call.seen.has(n)) return 'it was a copy of one already used';
    if (type === 'answer' && call.offered.get(from) !== n) return 'it answered an offer this PC never made';
    const f = { pin: call.hub, call: call.id, from, to: myId, nonce: n, sdp };
    // An answer may still carry the room id from before it changed: it answers our own fresh, single-use nonce, so it can't be a replay
    const good = verifySdp(raw, f, sig) || (type === 'answer' && !!call.oldId && verifySdp(raw, { ...f, call: call.oldId }, sig));
    if (!good) return 'its signature doesn\'t match (wrong fingerprint, sender, recipient or room)';
    return '';
  }
  function refuse(c, from, why) {
    log(`chat: refused a voice setup message from ${nameIn(c, from)}: ${why}`);
    call.refused.set(from, why);
    emit(c.h.id, { t: 'voice-refused', from, name: nameIn(c, from), why });
    if (c.wire) c.wire.send({ t: 'voice-signal', to: from, d: { refused: true } });       // so their side can say so too
    changed();
  }
  // From the voice window, once connected: the certificate the other side really used (getStats). It must be one of the
  // fingerprints their signed SDP promised, or the connection is closed.
  function voiceCert(peer, alg, fp) {
    if (!call || !call.prints.has(peer)) return { ok: false };
    const line = `a=fingerprint:${String(alg)} ${String(fp)}`.replace(/\s+/g, ' ').toLowerCase();
    const ok = call.prints.get(peer).includes(line);
    call.verdict.set(peer, ok ? 'verified' : 'mismatch');
    if (!ok) call.refused.set(peer, 'the certificate they used isn\'t the one they signed');       // and nothing more from them in this room
    if (!ok) log(`chat: the certificate ${nameIn(conns.get(call.hub), peer)} used doesn't match their signed one; closing that connection`);
    emit(call.hub, { t: 'voice-verdict', id: peer, ok });
    changed();
    return { ok };
  }
  // A new room id (someone was removed, or the room filled again from empty). Answers to offers made just before it
  // may still carry the one before.
  function setRoom(c, room) {
    if (room === c.roomId) return;
    c.oldRoomId = c.roomId; c.roomId = room;
    if (call && call.hub === c.h.id && call.id !== c.roomId) { call.oldId = call.id; call.id = c.roomId; }
    // A request to watch that hasn't been answered yet was signed for the old room, and the broadcaster won't take it now: ask again
    for (const [bc, w] of watches) if (w.hub === c.h.id && w.want) sendWant(c, bc, w);
  }

  // ---- broadcasts (docs/plans/broadcast.md §2–§4) ----
  // myBc: what this PC is broadcasting: { hub, id, title, kind, audio, viewers: Map(viewer -> { want (the nonce of
  // their request, for our offer), offered (the nonce our offer carried, which their answer must), prints, verdict,
  // refused, told }), seen (nonces of requests already taken) }. One at a time.
  // watches: broadcasts this PC watches: bc id -> { hub, from, want (the nonce of our request, which their offer must
  // carry), asked (every nonce we've asked with, so an offer to an older request is dropped, not refused), offered (the
  // nonce of the offer we took, for our answer), prints, verdict, refused, told }.
  // The broadcast and screen windows only ever get SDPs that passed, and verdicts, as voice's does.
  let myBc = null;
  const watches = new Map();
  const cleanBcs = (list) => (Array.isArray(list) ? list : []).filter((b) => b && TOKEN.test(String(b.id)) && typeof b.from === 'string').map((b) => ({
    id: String(b.id), from: b.from, title: String(b.title || '').slice(0, LIMITS.bcTitle), kind: b.kind === 'window' ? 'window' : 'screen', audio: !!b.audio, since: +b.since || 0,
    viewers: (Array.isArray(b.viewers) ? b.viewers : []).filter((v) => typeof v === 'string').slice(0, 32) }));
  const bcPeer = () => ({ want: '', offered: '', prints: null, verdict: '', refused: '', told: false });
  const bcFields = (c, bc, type, from, to, n, sdp) => ({ pin: c.h.id, room: c.roomId, bc, type, from, to, nonce: n, sdp });
  async function bcStart(hubId, { title = '', kind = 'screen', audio = false } = {}) {
    const c = conns.get(hubId);
    if (!c || !c.inRoom) return { error: 'Connect to a hub in the Hub tab to share your screen.' };
    if (myBc && myBc.hub !== hubId) return { error: 'You\'re already broadcasting in another hub.' };
    if (myBc) return bcUpdate({ title, audio });
    const id = crypto.randomBytes(18).toString('base64url');
    const r = await ask(hubId, { t: 'bc-start', id, title, kind, audio: !!audio });
    if (r.error) return { error: r.error, full: !!r.full };
    if (myBc || conns.get(hubId) !== c) { if (!myBc) ask(hubId, { t: 'bc-stop', id }); return { error: 'Something changed while starting. Try again.' }; }
    myBc = { hub: hubId, id, title, kind, audio: !!audio, viewers: new Map(), seen: new Set() };
    const server = relayServer(c, r);
    log(`chat: broadcasting in ${c.h.name}${server ? ', relayed through ' + server.urls : ''}`);
    changed();
    return { id, iceServers: server ? [server] : [] };
  }
  async function bcUpdate({ title, audio, kind } = {}) {       // rename it, switch what it shows, or turn its sound on or off, without stopping it
    if (!myBc) return { error: 'You aren\'t broadcasting.' };
    if (kind !== undefined) kind = kind === 'window' ? 'window' : 'screen';
    const r = await ask(myBc.hub, { t: 'bc-start', id: myBc.id, title: title !== undefined ? title : myBc.title, kind: kind !== undefined ? kind : myBc.kind, audio: audio !== undefined ? !!audio : myBc.audio });
    if (r.error) return { error: r.error };
    if (myBc) Object.assign(myBc, { title: title !== undefined ? title : myBc.title, audio: audio !== undefined ? !!audio : myBc.audio, kind: kind !== undefined ? kind : myBc.kind });
    changed();
    return { id: myBc && myBc.id };
  }
  function bcStop() {
    if (!myBc) return {};
    const { hub: h, id } = myBc;
    ask(h, { t: 'bc-stop', id });
    endMyBc('');
    return {};
  }
  function endMyBc(why) {
    if (!myBc) return;
    const { hub: h, id } = myBc;
    myBc = null;
    emit(h, { t: 'bc-off', bc: id, why });
    changed();
  }
  // The host stops someone else's broadcast (decision §11.6).
  const bcHostStop = (hubId, id) => ask(hubId, { t: 'bc-stop', id });
  // Watch a broadcast, or ask again (a fresh request, so the broadcaster makes a new offer) when already watching it.
  async function bcWatch(hubId, id) {
    const c = conns.get(hubId);
    if (!c || !c.inRoom) return { error: 'Connect to a hub in the Hub tab to watch.' };
    const b = c.bcs.find((x) => x.id === id);
    if (!b) return { error: 'That broadcast has ended.' };
    if (b.from === myId) return { error: 'That\'s your own broadcast.' };
    const had = watches.get(id);
    if (had && had.refused) return { error: `Drift couldn't check that this broadcast is really from ${nameIn(c, b.from)}, so it won't show it.`, refused: true };
    const r = await ask(hubId, { t: 'bc-watch', id, on: true });
    if (r.error) return { error: r.error, full: !!r.full };
    if (conns.get(hubId) !== c) return { error: 'The connection to the hub dropped.' };
    let w = watches.get(id);
    if (!w || w.hub !== hubId) { w = { ...bcPeer(), hub: hubId, from: b.from, asked: new Set() }; watches.set(id, w); }
    w.prints = null; w.verdict = ''; w.offered = '';
    sendWant(c, id, w);
    const server = relayServer(c, r);
    changed();
    return { id, from: b.from, iceServers: server ? [server] : [] };
  }
  function sendWant(c, bc, w) {
    const n = nonce(), sig = c.wire && signBc(key, bcFields(c, bc, 'want', myId, w.from, n));
    if (!sig) return;
    w.want = n; w.asked.add(n);
    c.wire.send({ t: 'bc-signal', bc, to: w.from, d: { want: true, nonce: n, sig } });
  }
  function bcUnwatch(id) {
    const w = watches.get(id);
    if (!w) return {};
    watches.delete(id);
    ask(w.hub, { t: 'bc-watch', id, on: false });
    emit(w.hub, { t: 'bc-watch-off', bc: id, why: '' });
    changed();
    return {};
  }
  function bcHubGone(hubId, why) {
    if (myBc && myBc.hub === hubId) endMyBc(why);
    for (const [id, w] of [...watches]) if (w.hub === hubId) { watches.delete(id); emit(hubId, { t: 'bc-watch-off', bc: id, why }); }
  }
  // The hub's list of broadcasts changed: ours may have ended (host stop, or we left the room), viewers may have gone,
  // and broadcasts we watch may have ended.
  function onBcRoster(c) {
    const now = new Map(c.bcs.map((b) => [b.id, b]));
    if (myBc && myBc.hub === c.h.id) {
      const b = now.get(myBc.id);
      if (!b || b.from !== myId) endMyBc('');
      else for (const id of [...myBc.viewers.keys()]) if (!b.viewers.includes(id)) { myBc.viewers.delete(id); emit(c.h.id, { t: 'bc-viewer-left', bc: myBc.id, id }); }
    }
    for (const [id, w] of [...watches]) {
      if (w.hub !== c.h.id) continue;
      const b = now.get(id);
      if (b && b.from === w.from && b.viewers.includes(myId)) continue;
      watches.delete(id);
      emit(c.h.id, { t: 'bc-watch-off', bc: id, why: b ? '' : 'ended' });
    }
  }
  // From the broadcast window (our offers and candidates for a viewer) or a screen window (our answer and candidates
  // for a broadcaster). SDPs are signed here, with the nonce of the request they belong to.
  function bcSignal(bc, peer, d) {
    if (!d || typeof d !== 'object') return;
    const mine = myBc && myBc.id === bc, w = !mine && watches.get(bc);
    const hubId = mine ? myBc.hub : w && w.hub, c = hubId && conns.get(hubId);
    if (!c || !c.wire) return;
    const p = mine ? myBc.viewers.get(peer) : w && w.from === peer ? w : null;
    if (!p || p.refused) return;
    if (d.c && typeof d.c === 'object') { c.wire.send({ t: 'bc-signal', bc, to: peer, d: { c: d.c } }); return; }
    const type = d.sdp && d.sdp.type, sdp = d.sdp && String(d.sdp.sdp || '');
    if (!sdp || type !== (mine ? 'offer' : 'answer')) return;       // the broadcaster always offers; the viewer answers
    let n = '';
    if (mine) { n = p.want; p.want = ''; p.offered = n; } else { n = p.offered; p.offered = ''; }
    const sig = n && signBc(key, bcFields(c, bc, type, myId, peer, n, sdp));
    if (!sig) { log('chat: a broadcast setup message could not be signed (or had no request to answer), so it was not sent'); return; }
    c.wire.send({ t: 'bc-signal', bc, to: peer, d: { sdp: { type, sdp }, nonce: n, sig } });
  }
  function onBcSignal(c, m) {
    const bc = String(m.bc || ''), from = String(m.from || ''), d = m.d && typeof m.d === 'object' ? m.d : {};
    const mine = myBc && myBc.hub === c.h.id && myBc.id === bc, w = !mine && watches.get(bc);
    if (!mine && !(w && w.hub === c.h.id && w.from === from)) return;       // not a broadcast this PC is part of
    const p = mine ? myBc.viewers.get(from) : w;
    if (d.refused) {       // they couldn't verify us
      if (p && !p.told) { p.told = true; emit(c.h.id, { t: 'bc-told', bc, from, name: nameIn(c, from) }); changed(); }
      return;
    }
    if (p && p.refused) return;
    if (d.c) { if (p) emit(c.h.id, { t: 'bc-candidate', bc, from, c: d.c }); return; }
    const n = String(d.nonce || ''), raw = c.keys.get(from);
    const f = { pin: c.h.id, room: c.roomId, bc, from, to: myId, nonce: n };
    // Offers and answers carry a fresh nonce this PC (or the other end) asked with, so one signed just before the room
    // id changed can't be a replay. A request to watch starts a fresh exchange, so it must be for the current room.
    const check = (type, sdp) => !!raw && (verifyBc(raw, { ...f, type, sdp }, d.sig) || (type !== 'want' && !!c.oldRoomId && verifyBc(raw, { ...f, type, sdp, room: c.oldRoomId }, d.sig)));
    if (d.want) {
      if (!mine) return bcRefuse(c, bc, from, w, 'it asked to watch a broadcast this PC isn\'t making');
      if (!raw) return bcRefuse(c, bc, from, p, 'the hub has no key for them that matches their id');
      if (!d.sig) return bcRefuse(c, bc, from, p, 'it wasn\'t signed');
      if (myBc.seen.has(n)) return bcRefuse(c, bc, from, p, 'it was a copy of one already used');
      if (!check('want')) {
        if (c.oldRoomId && verifyBc(raw, { ...f, type: 'want', room: c.oldRoomId }, d.sig)) return;       // asked just before the room changed: they ask again
        return bcRefuse(c, bc, from, p, 'its signature doesn\'t match (wrong sender, recipient, room or broadcast)');
      }
      myBc.seen.add(n);
      const v = p || bcPeer();
      myBc.viewers.set(from, v);
      Object.assign(v, { want: n, offered: '', prints: null, verdict: '' });
      emit(c.h.id, { t: 'bc-viewer', bc, id: from, name: nameIn(c, from) });       // the broadcast window makes them an offer
      changed();
      return;
    }
    if (!d.sdp) return;
    const type = d.sdp.type, sdp = String(d.sdp.sdp || '');
    const why = (() => {
      if (type !== (mine ? 'answer' : 'offer')) return mine ? 'a viewer sent something other than an answer' : 'the broadcaster sent something other than an offer';
      if (!p) return 'it answered an offer this PC never made';
      if (!raw) return 'the hub has no key for them that matches their id';
      if (!d.sig) return 'it wasn\'t signed';
      if (mine && p.offered !== n) return 'it answered an offer this PC never made';
      if (!mine && p.want !== n) return p.asked.has(n) ? 'stale' : 'it wasn\'t for a request this PC made';
      if (!check(type, sdp)) return 'its signature doesn\'t match (wrong fingerprint, sender, recipient, room or broadcast)';
      return '';
    })();
    if (why === 'stale') return;       // an offer to an earlier request of ours, made before we asked again: a newer one is coming
    if (why) return bcRefuse(c, bc, from, p, why);
    if (mine) p.offered = ''; else { p.want = ''; p.offered = n; }       // each nonce is used once
    p.prints = fingerprints(sdp); p.verdict = '';
    emit(c.h.id, { t: 'bc-sdp', bc, from, sdp: { type, sdp } });       // exactly what was checked
    changed();
  }
  function bcRefuse(c, bc, from, p, why) {
    log(`chat: refused a broadcast setup message from ${nameIn(c, from)}: ${why}`);
    if (p) p.refused = why;
    else if (myBc && myBc.id === bc) myBc.viewers.set(from, { ...bcPeer(), refused: why });       // and nothing more from them for this broadcast
    emit(c.h.id, { t: 'bc-refused', bc, from, name: nameIn(c, from), why });
    if (c.wire) c.wire.send({ t: 'bc-signal', bc, to: from, d: { refused: true } });
    changed();
  }
  // Once connected: the certificate the other end really used must be one their signed SDP promised.
  function bcCert(bc, peer, alg, fp) {
    const p = myBc && myBc.id === bc ? myBc.viewers.get(peer) : watches.has(bc) && watches.get(bc).from === peer ? watches.get(bc) : null;
    if (!p || !p.prints) return { ok: false };
    const line = `a=fingerprint:${String(alg)} ${String(fp)}`.replace(/\s+/g, ' ').toLowerCase();
    const ok = p.prints.includes(line);
    p.verdict = ok ? 'verified' : 'mismatch';
    if (!ok) { p.refused = 'the certificate they used isn\'t the one they signed'; log(`chat: a broadcast certificate doesn't match the signed one; closing that connection`); }
    emit(myBc && myBc.id === bc ? myBc.hub : watches.get(bc).hub, { t: 'bc-verdict', bc, id: peer, ok });
    changed();
    return { ok };
  }
  const peerInfo = (p) => ({ verdict: p.verdict, refused: p.refused, told: p.told });
  // Stills (§5): ours every few seconds from the broadcast window, signed here for the hub to hand round; everyone else's
  // checked against the key of the member the hub says is broadcasting it, and dropped if it doesn't match.
  const STILL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;
  function bcThumb(big, small) {       // the sharp one, if the hub takes one that large, else the small one (14000 characters, which every hub takes)
    const c = myBc && conns.get(myBc.hub), most = c && c.stillMax || 14000;
    const img = [big, small].find((x) => typeof x === 'string' && x.length <= most && STILL.test(x));
    if (!c || !c.wire || !img) return;
    const t = stillText({ pin: c.h.id, bc: myBc.id, from: myId, img });
    if (t) c.wire.send({ t: 'bc-thumb', id: myBc.id, img, sig: crypto.sign(null, t, key).toString('base64url') });
  }
  function onBcThumb(c, m) {
    const bc = String(m.id || ''), from = String(m.from || ''), img = String(m.img || ''), raw = c.keys.get(from);
    const b = c.bcs.find((x) => x.id === bc);
    if (!b || b.from !== from || from === myId || blocked.has(from) || !raw || img.length > LIMITS.bcThumb || !STILL.test(img)) return;
    let ok = false;
    try { const t = stillText({ pin: c.h.id, bc, from, img }); ok = !!t && raw.length === 32 && memberId(raw) === from && crypto.verify(null, t, keyFromRaw(raw), Buffer.from(String(m.sig || ''), 'base64url')); } catch { ok = false; }
    if (!ok) { log(`chat: a broadcast still that ${nameIn(c, from)} didn't sign came from the hub, so it isn't shown`); return; }
    emit(c.h.id, { t: 'bc-thumb', bc, img });
  }

  // ---- the Surf stream (docs/plans/streams.md §2, §7) ----
  // Hosting: this PC's hub has one browser for everyone (web.js, headless), streamed by main.js's stream window to each member
  // watching. This PC speaks to its own hub for it in-process (hub.service), so it works while this PC is disconnected from
  // that hub itself. ssHost: { on, title, room, oldRoom, people (id -> { raw, name }: the watchers' keys, from the hub), viewers
  // (member -> { want (the nonce of their request, for our offer), offered (the nonce our offer carried, for their answer),
  // prints, verdict, refused, told }), seen (nonces of requests already taken), pending (svc answers) }.
  // Watching another hub's: ssWatchOf: { hub, from (the host's id), want, asked, offered, prints, verdict, refused, told }.
  // The stream window and the member's screen window only ever get SDPs that passed, and verdicts.
  const cleanSurf = (x) => (x && typeof x === 'object' ? { on: !!x.on, title: String(x.title || '').slice(0, 120), room: TOKEN.test(String(x.room || '')) ? String(x.room) : '', since: +x.since || 0,
    watchers: (Array.isArray(x.watchers) ? x.watchers : []).filter((v) => typeof v === 'string').slice(0, 32) } : null);
  let svc = null, ssHost = null, ssSeq = 0, ssWatchOf = null;
  const hostedId = () => (hub ? hub.pin.toString('base64url') : '');
  function openService() {
    if (!hub || svc) return;
    ssHost = { on: false, title: '', room: '', oldRoom: '', watchers: [], people: new Map(), viewers: new Map(), seen: new Set(), pending: new Map() };
    svc = hub.service(onService);
  }
  function closeService() {
    if (svc) svc.close();
    svc = null;
    if (ssHost) for (const id of ssHost.viewers.keys()) emit(hostedId(), { t: 'ss-viewer-left', id });
    ssHost = null;
  }
  function askSvc(m, ms = 10000) {
    if (!svc) return Promise.resolve({ error: 'You aren\'t hosting a hub.' });
    const re = 's' + (++ssSeq);
    return new Promise((resolve) => {
      const t = setTimeout(() => { if (ssHost) ssHost.pending.delete(re); resolve({ error: 'The hub didn\'t answer.' }); }, ms);
      ssHost.pending.set(re, (r) => { clearTimeout(t); resolve(r); });
      svc.send({ ...m, re });
    });
  }
  // The relay, as this PC (the hub's own) reaches it: one of its own addresses that isn't loopback (Chromium won't relay through 127.0.0.1)
  function localRelay(r) {
    if (!r || !r.relay || !(r.relay.port > 0)) return [];
    const host = (Array.isArray(r.hosts) ? r.hosts : []).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x) && !/^127\./.test(x));
    return host ? [{ urls: `turn:${host}:${r.relay.port}?transport=udp`, username: String(r.relay.username), credential: String(r.relay.credential) }] : [];
  }
  function onService(m) {
    if (!ssHost) return;
    if (m.re !== undefined && ssHost.pending.has(m.re)) { const p = ssHost.pending.get(m.re); ssHost.pending.delete(m.re); p(m.t === 'err' ? { ...m, error: String(m.error || 'The hub said no.') } : m); return; }
    const id = hostedId();
    if (m.t === 'surf-wake') { emit(id, { t: 'ss-wake' }); return; }
    if (m.t === 'surf') {
      const s = cleanSurf(m.s) || { on: false, room: '', watchers: [] };
      if (s.room && s.room !== ssHost.room) { ssHost.oldRoom = ssHost.room; ssHost.room = s.room; }
      ssHost.watchers = s.watchers;
      ssHost.people = new Map(Object.entries(m.people && typeof m.people === 'object' ? m.people : {}).map(([k, v]) => [k, { raw: rawOf(v && v.key), name: String((v && v.name) || '').slice(0, LIMITS.name) }]).filter(([k, v]) => v.raw && memberId(v.raw) === k));
      for (const v of [...ssHost.viewers.keys()]) if (!s.watchers.includes(v)) { ssHost.viewers.delete(v); emit(id, { t: 'ss-viewer-left', id: v }); }
      changed();
      return;
    }
    if (m.t === 'surf-signal') onSsHost(m);
  }
  // main.js: the hub's browser started, stopped, or its front tab changed. Resolves with the relay to use, if any.
  async function ssSet({ on, title = '' } = {}) {
    if (!svc) return { error: 'You aren\'t hosting a hub.' };
    if (!on) { ssHost.on = false; await askSvc({ t: 'surf-stream', on: false }); return {}; }
    ssHost.on = true; ssHost.title = String(title || '').slice(0, 120);
    const r = await askSvc({ t: 'surf-stream', on: true, title: ssHost.title });
    if (r.error) return r;
    if (r.room && TOKEN.test(String(r.room)) && r.room !== ssHost.room) { ssHost.oldRoom = ssHost.room; ssHost.room = String(r.room); }
    return { iceServers: localRelay(r) };
  }
  // main.js, before making a watcher an offer: relay credentials (the hub only gives them while someone watches)
  const ssRelay = () => askSvc({ t: 'surf-relay' }).then((r) => (r.error ? r : { iceServers: localRelay(r) }));
  const ssName = (id) => (ssHost && ssHost.people.get(id) ? ssHost.people.get(id).name : 'someone') || 'someone';
  function ssRefuseHost(from, p, why) {
    log(`chat: refused a Surf stream setup message from ${ssName(from)}: ${why}`);
    if (p) p.refused = why; else ssHost.viewers.set(from, { ...bcPeer(), refused: why });
    emit(hostedId(), { t: 'ss-refused', from, name: ssName(from), why });
    svc.send({ t: 'surf-signal', to: from, d: { refused: true } });
    changed();
  }
  function onSsHost(m) {
    const from = String(m.from || ''), d = m.d && typeof m.d === 'object' ? m.d : {}, p = ssHost.viewers.get(from), id = hostedId();
    if (!ssHost.watchers.includes(from)) return;
    if (d.refused) { if (p && !p.told) { p.told = true; emit(id, { t: 'ss-told', from, name: ssName(from) }); changed(); } return; }
    if (p && p.refused) return;
    if (d.c) { if (p) emit(id, { t: 'ss-candidate', from, c: d.c }); return; }
    const n = String(d.nonce || ''), who = ssHost.people.get(from), raw = who && who.raw;
    const f = { pin: id, room: ssHost.room, from, to: myId, nonce: n };
    if (d.want) {
      if (!raw) return ssRefuseHost(from, p, 'the hub has no key for them that matches their id');
      if (!d.sig) return ssRefuseHost(from, p, 'it wasn\'t signed');
      if (ssHost.seen.has(n)) return ssRefuseHost(from, p, 'it was a copy of one already used');
      if (!verifySs(raw, { ...f, type: 'want' }, d.sig)) {
        if (ssHost.oldRoom && verifySs(raw, { ...f, type: 'want', room: ssHost.oldRoom }, d.sig)) return;       // asked just before the room changed: they ask again
        return ssRefuseHost(from, p, 'its signature doesn\'t match (wrong sender, recipient or room)');
      }
      ssHost.seen.add(n);
      const v = p || bcPeer();
      ssHost.viewers.set(from, v);
      Object.assign(v, { want: n, offered: '', prints: null, verdict: '' });
      emit(id, { t: 'ss-viewer', id: from, name: ssName(from) });       // the stream window makes them an offer
      changed();
      return;
    }
    if (!d.sdp) return;
    const type = d.sdp.type, sdp = String(d.sdp.sdp || '');
    const why = type !== 'answer' ? 'a watcher sent something other than an answer' : !p ? 'it answered an offer this PC never made' : !raw ? 'the hub has no key for them that matches their id'
      : !d.sig ? 'it wasn\'t signed' : p.offered !== n ? 'it answered an offer this PC never made'
      : !(verifySs(raw, { ...f, type, sdp }, d.sig) || (!!ssHost.oldRoom && verifySs(raw, { ...f, type, sdp, room: ssHost.oldRoom }, d.sig))) ? 'its signature doesn\'t match (wrong fingerprint, sender, recipient or room)' : '';
    if (why) return ssRefuseHost(from, p, why);
    p.offered = ''; p.prints = fingerprints(sdp); p.verdict = '';
    emit(id, { t: 'ss-sdp', from, sdp: { type, sdp } });       // exactly what was checked
    changed();
  }
  // Watching another hub's Surf stream: the member's side.
  const hostOf = (c) => (c.members.find((x) => x.host) || {}).id || '';
  async function ssWatch(hubId) {
    const c = conns.get(hubId);
    if (!c || c.status !== 'connected') return { error: 'Connect to the hub first.' };
    if (c.host) return { error: 'Your own Surf stream is on this PC.' };
    const from = hostOf(c);
    if (!from) return { error: 'This hub\'s host isn\'t known yet.' };
    if (ssWatchOf && ssWatchOf.hub === hubId && ssWatchOf.refused) return { error: 'Drift couldn\'t check that the Surf stream really comes from this hub\'s host, so it won\'t show it.', refused: true };
    const r = await ask(hubId, { t: 'surf-watch', on: true });
    if (r.error) return { error: r.error, full: !!r.full };
    if (conns.get(hubId) !== c) return { error: 'The connection to the hub dropped.' };
    if (ssWatchOf && ssWatchOf.hub !== hubId) ssUnwatch();
    if (!ssWatchOf) ssWatchOf = { ...bcPeer(), hub: hubId, from, asked: new Set() };
    ssWatchOf.prints = null; ssWatchOf.verdict = ''; ssWatchOf.offered = '';
    c.surf = cleanSurf(r) || c.surf;
    if (c.surf && c.surf.on) ssWant(c);
    const server = relayServer(c, r);
    changed();
    return { on: !!(c.surf && c.surf.on), iceServers: server ? [server] : [] };
  }
  function ssWant(c) {
    const w = ssWatchOf;
    if (!w || !c.wire || !c.surf || !c.surf.room) return;
    const n = nonce(), sig = signSs(key, { pin: c.h.id, room: c.surf.room, type: 'want', from: myId, to: w.from, nonce: n });
    if (!sig) return;
    w.want = n; w.asked.add(n); w.wantRoom = c.surf.room;
    c.wire.send({ t: 'surf-signal', to: w.from, d: { want: true, nonce: n, sig } });
  }
  function ssUnwatch() {
    const w = ssWatchOf;
    if (!w) return {};
    ssWatchOf = null;
    ask(w.hub, { t: 'surf-watch', on: false });
    emit(w.hub, { t: 'ss-watch-off', why: '' });
    changed();
    return {};
  }
  function ssGone(hubId, why) {
    if (ssWatchOf && ssWatchOf.hub === hubId) { ssWatchOf = null; emit(hubId, { t: 'ss-watch-off', why }); }
  }
  // The hub's word on the Surf stream changed: it started (ask for it), its room changed before our request was answered (ask
  // again), or it stopped.
  function onSsRoster(c) {
    const w = ssWatchOf;
    if (!w || w.hub !== c.h.id) return;
    const s = c.surf;
    if (!s || !s.watchers.includes(myId)) { ssWatchOf = null; emit(c.h.id, { t: 'ss-watch-off', why: s && s.on ? '' : 'ended' }); return; }
    if (!s.on) { w.want = ''; w.wantRoom = ''; emit(c.h.id, { t: 'ss-paused' }); return; }
    if (s.room && (!w.want || w.wantRoom !== s.room) && !w.offered && !w.prints) ssWant(c);
  }
  function onSsMember(c, m) {
    const w = ssWatchOf, from = String(m.from || ''), d = m.d && typeof m.d === 'object' ? m.d : {};
    if (!w || w.hub !== c.h.id || from !== w.from) return;
    if (d.refused) { if (!w.told) { w.told = true; emit(c.h.id, { t: 'ss-told', from, name: nameIn(c, from) }); changed(); } return; }
    if (w.refused) return;
    if (d.c) { emit(c.h.id, { t: 'ss-candidate', from, c: d.c }); return; }
    if (!d.sdp) return;
    const type = d.sdp.type, sdp = String(d.sdp.sdp || ''), n = String(d.nonce || ''), raw = c.keys.get(from), room = (c.surf && c.surf.room) || '';
    const f = { pin: c.h.id, room, type, from, to: myId, nonce: n, sdp };
    const why = type !== 'offer' ? 'the host sent something other than an offer' : !raw ? 'the hub has no key for the host that matches their id' : !d.sig ? 'it wasn\'t signed'
      : w.want !== n ? (w.asked.has(n) ? 'stale' : 'it wasn\'t for a request this PC made')
      : !(verifySs(raw, f, d.sig) || (!!w.wantRoom && w.wantRoom !== room && verifySs(raw, { ...f, room: w.wantRoom }, d.sig))) ? 'its signature doesn\'t match (wrong fingerprint, sender, recipient or room)' : '';
    if (why === 'stale') return;       // an offer to an earlier request of ours: a newer one is coming
    if (why) {
      log(`chat: refused a Surf stream setup message from ${nameIn(c, from)}: ${why}`);
      w.refused = why;
      emit(c.h.id, { t: 'ss-refused', from, name: nameIn(c, from), why });
      if (c.wire) c.wire.send({ t: 'surf-signal', to: from, d: { refused: true } });
      changed();
      return;
    }
    w.want = ''; w.offered = n; w.prints = fingerprints(sdp); w.verdict = '';
    log('chat: the Surf stream\'s offer checked out');
    emit(c.h.id, { t: 'ss-sdp', from, sdp: { type, sdp } });       // exactly what was checked
    changed();
  }
  // From the stream window (hosting: offers and candidates for a watcher) or the screen window (watching: the answer and
  // candidates for the host). SDPs are signed here, with the nonce of the request they belong to.
  function ssSignal(peer, d) {
    if (!d || typeof d !== 'object') return;
    if (ssHost && ssHost.viewers.has(peer)) {
      const p = ssHost.viewers.get(peer);
      if (p.refused || !svc) return;
      if (d.c && typeof d.c === 'object') { svc.send({ t: 'surf-signal', to: peer, d: { c: d.c } }); return; }
      const sdp = d.sdp && d.sdp.type === 'offer' ? String(d.sdp.sdp || '') : '';
      const n = p.want; p.want = ''; p.offered = n;
      const sig = sdp && n && signSs(key, { pin: hostedId(), room: ssHost.room, type: 'offer', from: myId, to: peer, nonce: n, sdp });
      if (!sig) { log('chat: a Surf stream offer could not be signed (or had no request to answer), so it was not sent'); return; }
      svc.send({ t: 'surf-signal', to: peer, d: { sdp: { type: 'offer', sdp }, nonce: n, sig } });
      return;
    }
    const w = ssWatchOf, c = w && w.from === peer && conns.get(w.hub);
    if (!c || !c.wire || w.refused) return;
    if (d.c && typeof d.c === 'object') { c.wire.send({ t: 'surf-signal', to: peer, d: { c: d.c } }); return; }
    const sdp = d.sdp && d.sdp.type === 'answer' ? String(d.sdp.sdp || '') : '';
    const n = w.offered; w.offered = '';
    const sig = sdp && n && signSs(key, { pin: c.h.id, room: w.wantRoom || (c.surf && c.surf.room) || '', type: 'answer', from: myId, to: peer, nonce: n, sdp });
    if (!sig) { log('chat: a Surf stream answer could not be signed, so it was not sent'); return; }
    c.wire.send({ t: 'surf-signal', to: peer, d: { sdp: { type: 'answer', sdp }, nonce: n, sig } });
  }
  // Once connected: the certificate the other end really used must be one their signed SDP promised.
  function ssCert(peer, alg, fp) {
    const hosting = ssHost && ssHost.viewers.has(peer), p = hosting ? ssHost.viewers.get(peer) : ssWatchOf && ssWatchOf.from === peer ? ssWatchOf : null;
    if (!p || !p.prints) return { ok: false };
    const line = `a=fingerprint:${String(alg)} ${String(fp)}`.replace(/\s+/g, ' ').toLowerCase();
    const ok = p.prints.includes(line);
    p.verdict = ok ? 'verified' : 'mismatch';
    if (!ok) { p.refused = 'the certificate they used isn\'t the one they signed'; log('chat: a Surf stream certificate doesn\'t match the signed one; closing that connection'); }
    emit(hosting ? hostedId() : ssWatchOf.hub, { t: 'ss-verdict', id: peer, ok });
    changed();
    return { ok };
  }

  // A safety number with someone, and marking them checked (kept on this PC only).
  async function safety(id, member) {
    const c = conns.get(id), raw = c && c.keys.get(member);
    if (!raw) return { error: 'There\'s no key for them to compare.' };
    return { code: await safetyNumber(pub, raw) };
  }
  function setVerified(id, member, on) {
    const c = conns.get(id), m = c && c.members.find((x) => x.id === member);
    if (!m) return { error: 'No such member.' };
    const t = trust[id] || (trust[id] = {});
    t[member] = { ...(t[member] || { name: m.name, key: m.key, at: Date.now() }), verified: on ? Date.now() : 0 };
    saveTrust(); changed();
    return {};
  }

  // ---- what main.js calls ----
  function join(code) {
    const inv = decodeInvite(code);
    if (!inv) return { error: 'That isn\'t a complete hub invite. Ask for the code again.' };
    const id = inv.pin.toString('base64url');
    let h = saved.find((x) => x.id === id);
    if (h && h.joined && !h.gone) { open(h); return { id, already: true }; }
    if (h) { close(id); Object.assign(h, { port: inv.port, addrs: inv.addrs, token: inv.token.toString('base64url'), gone: '' }); }
    else { h = { id, port: inv.port, addrs: inv.addrs, name: 'Hub', token: inv.token.toString('base64url'), joined: false }; saved.push(h); }
    save(); open(h); changed();
    return { id };
  }
  // Disconnect: offline from a hub without leaving it (no new invite needed). For this session; clicking it connects again.
  // resting: hubs not connected to since this started (opts.connectOnStart false): away too, until clicked.
  const away = new Set(), resting = new Set();
  function disconnect(id) {
    const h = saved.find((x) => x.id === id);
    if (!h) return { error: 'No such hub.' };
    away.add(id); close(id); changed();
    return {};
  }
  function reconnect(id) {
    const h = saved.find((x) => x.id === id);
    if (!h) return { error: 'No such hub.' };
    away.delete(id); resting.delete(id);
    if (h.joined && !h.gone && (!h.mine || hub)) open(h);
    changed();
    return {};
  }
  function leave(id) {
    const h = saved.find((x) => x.id === id);
    if (!h || h.mine) return { error: h ? 'Stop hosting to leave your own hub.' : 'No such hub.' };
    close(id); saved.splice(saved.indexOf(h), 1); save(); changed();
    return {};
  }
  const cid = () => crypto.randomBytes(9).toString('base64url');
  // Reactions from people you blocked are left out too
  const unblocked = (x) => (Array.isArray(x.reacts) ? { ...x, reacts: x.reacts.map((r) => ({ ...r, who: (r.who || []).filter((w) => !blocked.has(w)) })).filter((r) => r.who.length) } : x);
  const filterMsgs = (r) => (r && Array.isArray(r.msgs) ? { ...r, msgs: r.msgs.filter((x) => !blocked.has(x.from)).map(unblocked) } : r);
  // A picture or GIF in a message: sent to the hub in parts (file-start, file-part), then the message that carries it.
  async function sendFile(id, ch, buf, w, h, text, reply) {
    if (!createHub.sniffImage(buf)) return { error: 'Only pictures and GIFs (PNG, JPEG, WebP, GIF) can be sent.' };
    if (buf.length > LIMITS.file) return { error: `Pictures and GIFs can be up to ${LIMITS.file / 1024 / 1024} MB.` };
    const st = await ask(id, { t: 'file-start', size: buf.length, w, h });
    if (st.error) return st;
    const chunk = Math.min(LIMITS.fileChunk, +st.chunk || LIMITS.fileChunk);
    for (let at = 0; at < buf.length; at += chunk) {
      const r = await ask(id, { t: 'file-part', up: st.up, data: buf.subarray(at, at + chunk).toString('base64') }, 30000);
      if (r.error) return r;
    }
    return ask(id, { t: 'send', ch, text, reply, up: st.up, cid: cid() });
  }
  // A picture, fetched from the hub in parts and kept here (by its id, which never changes what it names) for a while.
  const pics = new Map(), picWait = new Map();
  let picBytes = 0;
  function getFile(id, fid) {
    fid = String(fid || '');
    if (pics.has(fid)) { const v = pics.get(fid); pics.delete(fid); pics.set(fid, v); return Promise.resolve(v); }
    if (picWait.has(fid)) return picWait.get(fid);
    const p = (async () => {
      const parts = [];
      let got = 0, size = 1;
      while (got < size) {
        const r = await ask(id, { t: 'file-get', id: fid, at: got, len: LIMITS.fileChunk }, 30000);
        if (r.error) return { error: r.error };
        const b = Buffer.from(String(r.data || ''), 'base64');
        size = Math.min(LIMITS.file, +r.size || 0);
        if (!b.length) break;
        parts.push(b); got += b.length;
      }
      const buf = Buffer.concat(parts), kind = createHub.sniffImage(buf);
      if (!kind || buf.length !== size) return { error: 'That picture couldn\'t be fetched.' };
      const v = { mime: kind, data: buf };
      pics.set(fid, v); picBytes += buf.length;
      while (picBytes > 150 * 1024 * 1024 && pics.size > 1) { const [k, o] = pics.entries().next().value; pics.delete(k); picBytes -= o.data.length; }
      return v;
    })().finally(() => picWait.delete(fid));
    picWait.set(fid, p);
    return p;
  }
  function setName(name) {
    me.name = String(name || '').replace(/[\x00-\x1f<>]/g, '').trim().slice(0, LIMITS.name);
    writeJson('identity.json', me);
    for (const c of conns.values()) if (c.status === 'connected') ask(c.h.id, { t: 'name', name: me.name });
  }
  // Your picture: kept with your identity and given to every hub you're in.
  function setAvatar(data) {
    const clean = data ? cleanAvatar(data) : '';
    if (clean === null) return { error: 'That picture can\'t be used.' };
    me.avatar = clean; writeJson('identity.json', me);
    for (const c of conns.values()) if (c.status === 'connected' && c.wire) c.wire.send({ t: 'avatar', re: 'av', data: clean });
    changed();
    return { av: avatarId(clean) };
  }
  // Someone's picture, by its id (members lists carry the id; the picture is fetched once and kept).
  const faces = new Map();
  async function avatar(id, member, av) {
    if (!av) return { data: '' };
    if (faces.has(av)) return { data: faces.get(av) };
    if (member === myId && avatarId(me.avatar || '') === av) return { data: me.avatar };
    const r = await ask(id, { t: 'avatar-get', member });
    const data = r && r.data && cleanAvatar(r.data) && avatarId(r.data) === av ? r.data : '';
    if (data) { faces.set(av, data); if (faces.size > 500) faces.delete(faces.keys().next().value); }
    return { data };
  }
  // Whether this PC has a microphone (the panel finds out and tells us); hubs pass it on.
  let myMic = null;
  function setMic(on) {
    on = !!on;
    if (myMic === on) return;
    myMic = on;
    for (const c of conns.values()) if (c.status === 'connected' && c.wire) c.wire.send({ t: 'mic', on });
  }
  // Which screen this PC shows (Scenes, Media, Surf or Share; the panel says), so friends can jump to it from the hub bar.
  let myWhere = '';
  function setWhere(at) {
    at = ['scenes', 'media', 'surf', 'broadcast'].includes(at) ? at : '';
    if (myWhere === at) return;
    myWhere = at;
    for (const c of conns.values()) if (c.status === 'connected' && c.wire) c.wire.send({ t: 'where', at });
  }
  function block(member, on) {
    if (on) blocked.add(member); else blocked.delete(member);
    writeJson('blocked.json', [...blocked]); changed();
  }
  function info() {
    return {
      me: { id: myId, name: me.name, av: avatarId(me.avatar || ''), mic: myMic },
      canHost: !hub, hostName: (hosting && hosting.name) || '',       // Host starts this PC's hub (making one if there's none)
      hosting: hub ? { id: hub.pin.toString('base64url'), name: hub.name(), port: hub.port(), voicePort: hub.voicePort(), note: hostNote, internet: !!(hosting && hosting.internet) } : null,
      blocked: [...blocked],
      hubs: saved.map((h) => {
        const c = conns.get(h.id), t = trust[h.id] || {}, up = !!c && c.status === 'connected';
        return { id: h.id, name: h.name, mine: !!h.mine, status: h.gone ? 'gone' : c ? c.status : away.has(h.id) ? 'away' : 'offline', note: h.gone || (c && c.note) || (away.has(h.id) ? (resting.has(h.id) ? 'Offline.' : 'Disconnected.') : ''),
          host: !!(c && c.host), members: c ? c.members.map(({ key: _k, ...m }) => ({ ...m, verified: !!(t[m.id] && t[m.id].verified) })) : [], channels: c ? c.channels : [], lives: up ? c.lives : [], vote: (up && c.mediaVote) || null,
          voice: up ? c.voice : [], bcs: up ? c.bcs.filter((b) => !blocked.has(b.from)) : [], surf: up ? c.surf : null, room:{ in: !!(c && c.inRoom), note: (c && c.roomNote) || '' }, away: away.has(h.id), suspect: c ? [...c.suspect].map(([id, name]) => ({ id, name })) : [], lookalikes: c ? lookalikes(c) : [] };
      }),
      voiceHub: want.hub,
      call: call ? { hub: call.hub, id: call.id, peers: [...call.peers], want: [...call.want.keys()], verdict: Object.fromEntries(call.verdict), refused: Object.fromEntries(call.refused), told: [...call.told] } : null,
      // (bcs above is the hub's word for who broadcasts what, titles included: "what they called it", not proof)
      bc: {
        mine: myBc ? { hub: myBc.hub, id: myBc.id, title: myBc.title, kind: myBc.kind, audio: myBc.audio, viewers: Object.fromEntries([...myBc.viewers].map(([id, p]) => [id, peerInfo(p)])) } : null,
        watching: [...watches].map(([id, w]) => ({ id, hub: w.hub, from: w.from, ...peerInfo(w) })),
      },
      // the Surf stream: as its host (who watches, from the hub, which this PC is part of even while disconnected from it), and as a watcher
      ss: {
        host: ssHost ? { hub: hostedId(), on: ssHost.on, watchers: ssHost.watchers, names: Object.fromEntries([...ssHost.people].map(([k, v]) => [k, v.name])), viewers: Object.fromEntries([...ssHost.viewers].map(([id, p]) => [id, peerInfo(p)])) } : null,
        watching: ssWatchOf ? { hub: ssWatchOf.hub, from: ssWatchOf.from, ...peerInfo(ssWatchOf) } : null,
      },
    };
  }
  let changeTimer = null;
  function changed() { if (changeTimer || !opts.changed) return; changeTimer = setTimeout(() => { changeTimer = null; opts.changed(); }, 30); }

  // Start: the hub this PC hosts, then a connection to every hub it belongs to (or, with connectOnStart false, none: each
  // waits, away, until it's clicked).
  async function start() {
    // (with connectOnStart off, your own hub doesn't run until you press Host)
    if (hosting && opts.connectOnStart !== false) { try { await startHub(); } catch (e) { log('chat: the hub could not start: ' + e.message); hostNote = 'Your hub could not start: ' + e.message; } }
    for (const h of saved) {
      if (!h.joined || h.gone || conns.has(h.id) || away.has(h.id) || (h.mine && !hub)) continue;
      if (opts.connectOnStart === false) { away.add(h.id); resting.add(h.id); } else open(h);
    }
    changed();
  }
  async function stop() {
    for (const id of [...conns.keys()]) close(id);
    closeService();
    if (hub) { const h = hub; hub = null; try { h.clearMessages(); } catch (e) { log('chat: could not wipe the messages: ' + e.message); } await h.stop(); }       // messages last one session
    if (mappings.length) await Promise.race([Promise.all(mappings.splice(0).map((m) => m.remove())), new Promise((r) => setTimeout(r, 1500))]);
  }

  return {
    start, stop, info, join, leave, host, unhost, setName, block, announce, setAvatar, avatar, setMic, setWhere,
    setVoice, voiceSignal, voiceCert, safety, setVerified, inRoom: () => (call ? call.hub : ''), disconnect, reconnect,
    bcStart, bcUpdate, bcStop, bcHostStop, bcWatch, bcUnwatch, bcSignal, bcCert, bcThumb,
    ssSet, ssRelay, ssWatch, ssUnwatch, ssSignal, ssCert, hostedHub: hostedId,
    hostVoicePort: () => (hub ? hub.voicePort() : 0), relayStats: () => (hub ? hub.relayStats() : null),
    history: (id, ch, o = {}) => ask(id, { t: 'history', ch, before: o.before, after: o.after, limit: o.limit }).then(filterMsgs),
    send: (id, ch, text, reply) => ask(id, { t: 'send', ch, text, reply, cid: cid() }),
    edit: (id, msg, text) => ask(id, { t: 'edit', id: msg, text }),
    remove: (id, msg) => ask(id, { t: 'delete', id: msg }),
    react: (id, msg, e, on) => ask(id, { t: 'react', id: msg, e, on: !!on }),
    sendFile, file: getFile,
    typing: (id, ch) => { const c = conns.get(id); if (c && c.wire && c.status === 'connected') c.wire.send({ t: 'typing', ch }); },
    channel: (id, name) => ask(id, { t: 'channel', name }),
    dropChannel: (id, ch) => ask(id, { t: 'channel-delete', ch }),
    invite: (id) => ask(id, { t: 'invite' }),
    withdrawInvites: (id) => ask(id, { t: 'withdraw-invites' }),
    removeMember: (id, member) => ask(id, { t: 'remove', member }),
    liveFail: (id, code) => { const c = conns.get(id); if (c && c.wire && c.status === 'connected') c.wire.send({ t: 'live-fail', code: String(code || '').slice(0, 400) }); },       // couldn't connect to that share (hub.js "reach")
    mediaAsk: (id, title) => ask(id, { t: 'media-ask', title: String(title || '').slice(0, 200) }),
    mediaVote: (id, vote, yes) => ask(id, { t: 'media-vote', id: String(vote || ''), yes: !!yes }),
    mediaCancel: (id, vote) => ask(id, { t: 'media-cancel', id: String(vote || '') }),
    myId: () => myId,
    _fromHub: (id, m) => { const c = conns.get(id); if (c) onMessage(c, m); },       // (tests only: as if hub `id` had sent m)
    _bcWant: (bc) => (watches.get(bc) || {}).want || '',
    _ssWant: () => (ssWatchOf || {}).want || '',       // (tests only: likewise for the Surf stream)       // (tests only: the nonce our request to watch carries, for forging what a hub might send)
  };
};
Object.assign(module.exports, { decodeInvite, checkMembers, safetyNumber, fingerprints, voiceText, signSdp, verifySdp, bcText, signBc, verifyBc, stillText, ssText, signSs, verifySs });
