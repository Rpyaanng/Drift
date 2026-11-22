// Drift — chat, this PC's side (docs/plans/voice-and-chat.md). Holds this PC's identity key, the hubs it belongs to
// and the connections to them, and runs a hub of its own when this PC hosts one (hub.js). The renderer reaches all of
// it through main.js over IPC; nothing here touches the page, and no message is ever turned into HTML here.
//
// hooks (from main.js; plain functions so this also runs under plain Node for tests):
//   seal(buf) / unseal(buf)   encrypt what is kept on disk (Electron's safeStorage), or pass it through
//   addrs()                   this PC's addresses for invites, LAN and public
//   upnp(port)                promise of { ip, remove() }: open the hub's port on the router (p2p.upnpMap), or reject
//   changed()                 the list of hubs, or one hub's state, changed
//   event(hubId, m)           something arrived from a hub: msg, gone, typing, members, channels, lives, removed
//   log(text)
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const createHub = require('./hub');
const { wire } = require('./p2p');
const { decodeInvite, pinOfPeer, memberId, rawKey, loginText, cleanAvatar, avatarId, LIMITS } = createHub;

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

  // ---- hosting: this PC runs a hub of its own ----
  let hosting = readJson('hosting.json', null), hub = null, mapping = null, hostNote = '';
  async function startHub() {
    hub = createHub({ dir: file('hub'), owner: pub, name: hosting.name, port: hosting.port, seal, unseal, addrs: () => opts.addrs ? opts.addrs() : ['127.0.0.1'], log });
    const port = await hub.start();
    if (port !== hosting.port) { hosting.port = port; writeJson('hosting.json', hosting); }
    let h = saved.find((x) => x.id === hub.pin.toString('base64url'));
    if (!h) { h = { id: hub.pin.toString('base64url'), port, addrs: [], name: hub.name(), joined: true, mine: true }; saved.unshift(h); }
    Object.assign(h, { port, addrs: ['127.0.0.1', '::1'], mine: true, gone: '' }); save();       // the host reaches its own hub here
    hostNote = '';
    if (hosting.internet && opts.upnp) {
      opts.upnp(port).then((m) => { if (hub) { mapping = m; } else m.remove(); }, () => { hostNote = `Friends on your own network can join. For friends elsewhere, TCP port ${port} has to be forwarded to this PC in the router's settings.`; opts.changed && opts.changed(); });
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
    if (mapping) { mapping.remove(); mapping = null; }
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
          won = true; sock.setTimeout(0); resolve(sock);
        });
        sock.once('timeout', fail); sock.once('error', fail);
      }
    });
  }
  function open(h) {
    if (conns.has(h.id)) return conns.get(h.id);
    const c = { h, status: 'connecting', note: '', wire: null, me: null, host: false, members: [], channels: [], lives: [], typing: new Map(), pending: new Map(), seq: 0, retry: null, tries: 0, pinger: null, seen: 0, closed: false };
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
    c.wire = wire(sock, null, (m) => onMessage(c, m), () => {
      log(`chat: the connection to ${c.h.name || c.h.id} closed`);
      clearInterval(c.pinger); c.wire = null;
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
      c.me = m.me; c.host = !!m.host; c.members = m.members || []; c.channels = m.channels || []; c.lives = Array.isArray(m.lives) ? m.lives : [];
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
      case 'members': c.members = Array.isArray(m.list) ? m.list : []; changed(); break;
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
      hosting: hub ? { id: hub.pin.toString('base64url'), name: hub.name(), port: hub.port(), note: hostNote, internet: !!(hosting && hosting.internet) } : null,
      blocked: [...blocked],
      hubs: saved.map((h) => {
        const c = conns.get(h.id);
        return { id: h.id, name: h.name, mine: !!h.mine, status: h.gone ? 'gone' : c ? c.status : 'offline', note: h.gone || (c && c.note) || '',
          host: !!(c && c.host), members: c ? c.members : [], channels: c ? c.channels : [], lives: c && c.status === 'connected' ? c.lives : [] };
      }),
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
    if (mapping) { await Promise.race([mapping.remove(), new Promise((r) => setTimeout(r, 1500))]); mapping = null; }
  }

  return {
    start, stop, info, join, leave, host, unhost, setName, block, announce, setAvatar, avatar, setMic,
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
  };
};
module.exports.decodeInvite = decodeInvite;
