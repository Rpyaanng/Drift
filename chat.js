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
//                             and for calls: voice-sdp, voice-candidate, voice-refused, voice-told, voice-verdict, voice-left, voice-ended
//   log(text)
//
// Calls (docs/plans/voice-and-chat.md §5): the hub only passes setup messages along, and it may be hostile. So every
// SDP this PC sends is signed here with its identity key, over the call, who it's from and for, a fresh nonce and its
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
// (a different call id) or into the same one (a nonce already seen, or not the one the offer asked for) is refused.
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
  let hosting = readJson('hosting.json', null), hub = null, mappings = [], hostNote = '';
  async function startHub() {
    hub = createHub({ dir: file('hub'), owner: pub, name: hosting.name, port: hosting.port, seal, unseal, addrs: () => opts.addrs ? opts.addrs() : ['127.0.0.1'], log });
    const port = await hub.start();
    if (port !== hosting.port) { hosting.port = port; writeJson('hosting.json', hosting); }
    let h = saved.find((x) => x.id === hub.pin.toString('base64url'));
    if (!h) { h = { id: hub.pin.toString('base64url'), port, addrs: [], name: hub.name(), joined: true, mine: true }; saved.unshift(h); }
    Object.assign(h, { port, addrs: ['127.0.0.1', '::1'], mine: true, gone: '' }); save();       // the host reaches its own hub here
    hostNote = '';
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
    open(h);
  }
  async function host({ name, internet = true } = {}) {
    if (hub) return info();
    hosting = { name: String(name || '').slice(0, LIMITS.name) || `${me.name || 'My'} hub`, port: hosting && hosting.port || 47900, internet: !!internet };
    writeJson('hosting.json', hosting);
    await startHub();
    return info();
  }
  // Stop hosting. The hub's history stays on disk, so hosting again later brings it all back with the same invites.
  async function unhost() {
    if (!hub) return;
    log('chat: stopped hosting');
    const h = hub; hub = null;
    const id = h.pin.toString('base64url');
    close(id);
    await h.stop();
    for (const m of mappings.splice(0)) m.remove();
    hosting = null; try { fs.unlinkSync(file('hosting.json')); } catch { /* gone */ }
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
    const c = { h, status: 'connecting', note: '', wire: null, me: null, host: false, members: [], keys: new Map(), suspect: new Map(), voice: [], addr: '', channels: [], lives: [], typing: new Map(), pending: new Map(), seq: 0, retry: null, tries: 0, pinger: null, seen: 0, closed: false };
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
      clearInterval(c.pinger); c.wire = null; c.voice = [];
      if (call && call.hub === c.h.id) endCall('The connection to the hub dropped, so you left the call.');
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
      c.me = m.me; c.host = !!m.host; setMembers(c, m.members); c.channels = m.channels || []; c.lives = Array.isArray(m.lives) ? m.lives : []; c.voice = Array.isArray(m.voice) ? m.voice : [];
      if (myLive && myLive.hub === c.h.id) sendLive(c, myLive.live);       // still sharing: tell the hub again after a reconnect
      const mine = c.members.find((x) => x.id === myId), want = avatarId(me.avatar || '');
      if (mine && (mine.av || '') !== want) c.wire.send({ t: 'avatar', re: 'av', data: me.avatar || '' });       // a picture chosen (or removed) while away
      if (myMic !== null) c.wire.send({ t: 'mic', on: myMic });
      Object.assign(c.h, { joined: true, token: undefined, name: String(m.hub || c.h.name || 'Hub').slice(0, 40) });
      if (Array.isArray(m.addrs) && m.addrs.length && !c.h.mine) c.h.addrs = [...new Set([...m.addrs, ...c.h.addrs])].slice(0, 8);
      save(); changed();
      opts.event && opts.event(c.h.id, { t: 'ready' });
      return;
    }
    if (m.re === 'av') return;
    if (m.re !== undefined && c.pending.has(m.re)) { const p = c.pending.get(m.re); c.pending.delete(m.re); p(m.t === 'err' ? { error: String(m.error || 'The hub said no.') } : m); return; }
    switch (m.t) {
      case 'pong': return;
      case 'members': setMembers(c, m.list); changed(); break;
      case 'voice': c.voice = Array.isArray(m.list) ? m.list : []; onRoster(c); changed(); return;
      case 'voice-signal': onSignal(c, m); return;
      case 'voice-ended': if (call && call.hub === c.h.id) endCall(String(m.why || 'The call ended.').slice(0, 200)); return;
      case 'channels': c.channels = Array.isArray(m.list) ? m.list : []; changed(); break;
      case 'lives': c.lives = Array.isArray(m.list) ? m.list : []; changed(); break;
      case 'msg': if (m.msg && blocked.has(m.msg.from)) return; break;
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
  }

  // ---- sharing (Together): which hub hears about it ----
  // live: { code, title, watching } while this PC shares into hub `id`; null when it stops.
  let myLive = null;
  const sendLive = (c, live) => { if (c && c.wire && c.status === 'connected') c.wire.send(live ? { t: 'live', on: true, ...live } : { t: 'live', on: false }); };
  function announce(id, live) {
    const was = myLive;
    myLive = id && live ? { hub: id, live } : null;
    if (was && (!myLive || was.hub !== id)) sendLive(conns.get(was.hub), null);
    if (myLive) sendLive(conns.get(id), live);
  }

  // ---- calls ----
  // One call at a time, in one hub. call = { hub, id (the call id, signed into every setup message), peers (who else is
  // in it, as the hub says), offered (peer -> the nonce of our offer that their answer must carry), toAnswer (peer ->
  // the nonce of their offer, for our answer), seen (nonces already accepted), prints (peer -> the fingerprints we
  // checked for them), refused (peer -> why), verdict (peer -> 'verified' | 'mismatch'), told (peers who refused us) }
  let call = null;
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
  async function voiceJoin(id, o = {}) {
    const c = conns.get(id);
    if (!c || c.status !== 'connected') return { error: 'Not connected to that hub right now.' };
    if (call) await voiceLeave();
    const r = await ask(id, { t: 'voice-join', call: nonce(), muted: !!o.muted, deaf: !!o.deaf });
    if (r.error) return r;
    if (!TOKEN.test(String(r.call))) return { error: 'The hub answered with a call that doesn\'t make sense.' };
    const server = relayServer(c, r);
    call = { hub: id, id: String(r.call), peers: new Set((r.peers || []).filter((p) => typeof p === 'string' && p !== myId)), offered: new Map(), toAnswer: new Map(), seen: new Set(), prints: new Map(), refused: new Map(), verdict: new Map(), told: new Set() };
    log(`chat: joined the call in ${c.h.name}, with ${call.peers.size} other(s)${server ? ', relayed through ' + server.urls : ', with no relay'}`);
    changed();
    return { hub: id, me: myId, peers: [...call.peers], iceServers: server ? [server] : [] };
  }
  async function voiceLeave() {
    if (!call) return {};
    const id = call.hub;
    call = null; changed();
    await ask(id, { t: 'voice-leave' }, 4000);
    return {};
  }
  function endCall(why) {
    if (!call) return;
    const id = call.hub;
    call = null;
    emit(id, { t: 'voice-ended', why });
    changed();
  }
  function voiceState(s) {
    const c = call && conns.get(call.hub);
    if (c && c.wire) c.wire.send({ t: 'voice-state', muted: !!s.muted, deaf: !!s.deaf, mic: !!s.mic });
  }
  // The hub's list of who is in the call changed: anyone who left starts afresh if they come back.
  function onRoster(c) {
    if (!call || call.hub !== c.h.id) return;
    const now = new Set(c.voice.map((v) => v.id).filter((x) => typeof x === 'string' && x !== myId));
    for (const id of call.peers) {
      if (now.has(id)) continue;
      for (const k of ['offered', 'toAnswer', 'prints', 'refused', 'verdict']) call[k].delete(id);
      call.told.delete(id);
      emit(c.h.id, { t: 'voice-left', id });
    }
    call.peers = now;
  }
  // From the voice window: a setup message for `peer`. SDPs are signed here; ICE candidates go as they are (a hub that
  // changes them can only stop the call, not listen to it).
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
    if (!sig) { log('chat: a call setup message could not be signed, so it was not sent'); return; }
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
    if (!verifySdp(raw, { pin: call.hub, call: call.id, from, to: myId, nonce: n, sdp }, sig)) return 'its signature doesn\'t match (wrong fingerprint, sender, recipient or call)';
    return '';
  }
  function refuse(c, from, why) {
    log(`chat: refused a call setup message from ${nameIn(c, from)}: ${why}`);
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
    if (!ok) call.refused.set(peer, 'the certificate they used isn\'t the one they signed');       // and nothing more from them this call
    if (!ok) log(`chat: the certificate ${nameIn(conns.get(call.hub), peer)} used doesn't match their signed one; closing that connection`);
    emit(call.hub, { t: 'voice-verdict', id: peer, ok });
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
  function leave(id) {
    const h = saved.find((x) => x.id === id);
    if (!h || h.mine) return { error: h ? 'Stop hosting to leave your own hub.' : 'No such hub.' };
    close(id); saved.splice(saved.indexOf(h), 1); save(); changed();
    return {};
  }
  const cid = () => crypto.randomBytes(9).toString('base64url');
  const filterMsgs = (r) => (r && Array.isArray(r.msgs) ? { ...r, msgs: r.msgs.filter((x) => !blocked.has(x.from)) } : r);
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
  function block(member, on) {
    if (on) blocked.add(member); else blocked.delete(member);
    writeJson('blocked.json', [...blocked]); changed();
  }
  function info() {
    return {
      me: { id: myId, name: me.name, av: avatarId(me.avatar || ''), mic: myMic },
      hosting: hub ? { id: hub.pin.toString('base64url'), name: hub.name(), port: hub.port(), voicePort: hub.voicePort(), note: hostNote, internet: !!(hosting && hosting.internet) } : null,
      blocked: [...blocked],
      hubs: saved.map((h) => {
        const c = conns.get(h.id), t = trust[h.id] || {}, up = !!c && c.status === 'connected';
        return { id: h.id, name: h.name, mine: !!h.mine, status: h.gone ? 'gone' : c ? c.status : 'offline', note: h.gone || (c && c.note) || '',
          host: !!(c && c.host), members: c ? c.members.map(({ key: _k, ...m }) => ({ ...m, verified: !!(t[m.id] && t[m.id].verified) })) : [], channels: c ? c.channels : [], lives: up ? c.lives : [],
          voice: up ? c.voice : [], suspect: c ? [...c.suspect].map(([id, name]) => ({ id, name })) : [], lookalikes: c ? lookalikes(c) : [] };
      }),
      call: call ? { hub: call.hub, id: call.id, peers: [...call.peers], verdict: Object.fromEntries(call.verdict), refused: Object.fromEntries(call.refused), told: [...call.told] } : null,
    };
  }
  let changeTimer = null;
  function changed() { if (changeTimer || !opts.changed) return; changeTimer = setTimeout(() => { changeTimer = null; opts.changed(); }, 30); }

  // Start: the hub this PC hosts, then a connection to every hub it belongs to.
  async function start() {
    if (hosting) { try { await startHub(); } catch (e) { log('chat: the hub could not start: ' + e.message); hostNote = 'Your hub could not start: ' + e.message; } }
    for (const h of saved) if (h.joined && !h.gone && !conns.has(h.id) && (!h.mine || hub)) open(h);
    changed();
  }
  async function stop() {
    for (const id of [...conns.keys()]) close(id);
    if (hub) { const h = hub; hub = null; await h.stop(); }
    if (mappings.length) await Promise.race([Promise.all(mappings.splice(0).map((m) => m.remove())), new Promise((r) => setTimeout(r, 1500))]);
  }

  return {
    start, stop, info, join, leave, host, unhost, setName, block, announce, setAvatar, avatar, setMic,
    voiceJoin, voiceLeave, voiceState, voiceSignal, voiceCert, safety, setVerified, inCall: () => (call ? call.hub : ''),
    hostVoicePort: () => (hub ? hub.voicePort() : 0), relayStats: () => (hub ? hub.relayStats() : null),
    history: (id, ch, o = {}) => ask(id, { t: 'history', ch, before: o.before, after: o.after, limit: o.limit }).then(filterMsgs),
    send: (id, ch, text, reply) => ask(id, { t: 'send', ch, text, reply, cid: cid() }),
    edit: (id, msg, text) => ask(id, { t: 'edit', id: msg, text }),
    remove: (id, msg) => ask(id, { t: 'delete', id: msg }),
    typing: (id, ch) => { const c = conns.get(id); if (c && c.wire && c.status === 'connected') c.wire.send({ t: 'typing', ch }); },
    channel: (id, name) => ask(id, { t: 'channel', name }),
    dropChannel: (id, ch) => ask(id, { t: 'channel-delete', ch }),
    invite: (id) => ask(id, { t: 'invite' }),
    withdrawInvites: (id) => ask(id, { t: 'withdraw-invites' }),
    removeMember: (id, member) => ask(id, { t: 'remove', member }),
    myId: () => myId,
    _fromHub: (id, m) => { const c = conns.get(id); if (c) onMessage(c, m); },       // (tests only: as if hub `id` had sent m)
  };
};
Object.assign(module.exports, { decodeInvite, checkMembers, safetyNumber, fingerprints, voiceText, signSdp, verifySdp });
