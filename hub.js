// Drift — the hub: one small server for a group of friends' chat (docs/plans/voice-and-chat.md). It runs inside the
// host's Drift (or on its own later) and keeps the channels and their history in SQLite. Members are Ed25519 public
// keys; there are no accounts or passwords. Everyone is equal except the host, who can remove someone (a ban by key),
// delete any message and withdraw every invite. It also passes on who is sharing a video or page right now (Together):
// a member's Drift announces its watch-together code here, and everyone else gets a Join button in the chat.
//
// The connection is TLS 1.3 with the hub's own self-signed certificate (ECDSA P-256: Electron's BoringSSL refuses an
// Ed25519 one in the handshake, though members' Ed25519 signatures inside the connection are fine). Invite codes carry the certificate's
// fingerprint, so members pin it and nobody holding a code can pretend to be the hub. Inside, the hub sends a random
// challenge and the member signs it, bound to that fingerprint, with their identity key.
//
//   const hub = createHub({ dir, owner, name, addrs, port });  await hub.start();  hub.invite({ by })  hub.stop()
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { wire, ipBytes, ipText } = require('./p2p');

const VERSION = 1;
const LIMITS = { line: 16 * 1024, text: 4000, name: 24, channel: 32, channels: 50, page: 100, actions: 10, perSecs: 10, connections: 64 };
const INVITE_DAYS = 7;

// ---- the hub's certificate: X.509 for a P-256 key, written by hand (Node can read certificates but not make them) ----
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts), n = body.length;
  const len = n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const ECDSA_SHA256 = der(0x30, der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])));       // AlgorithmIdentifier 1.2.840.10045.4.3.2
function selfSigned(key, cn) {
  const name = der(0x30, der(0x31, der(0x30, der(0x06, Buffer.from([0x55, 0x04, 0x03])), der(0x0c, Buffer.from(cn)))));
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const utc = new Date(Date.now() - 86400e3).toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  const tbs = der(0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), ECDSA_SHA256, name,
    der(0x30, der(0x17, Buffer.from(utc)), der(0x18, Buffer.from('20991231235959Z'))), name,
    crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }));
  const cert = der(0x30, tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), crypto.sign('sha256', tbs, key)));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}
// What members pin: the SHA-256 of the certificate (the same bytes Node's fingerprint256 describes).
const pinOf = (pem) => crypto.createHash('sha256').update(new crypto.X509Certificate(pem).raw).digest();
const pinOfPeer = (sock) => { const c = sock.getPeerX509Certificate && sock.getPeerX509Certificate(); return c ? crypto.createHash('sha256').update(c.raw).digest() : null; };

// ---- identity: raw 32-byte Ed25519 public keys, and what a member signs to log in ----
const rawKey = (k) => (k.type === 'public' ? k : crypto.createPublicKey(k)).export({ type: 'spki', format: 'der' }).subarray(-32);
const keyFromRaw = (raw) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
const memberId = (raw) => crypto.createHash('sha256').update(raw).digest().subarray(0, 9).toString('base64url');
const loginText = (pin, nonce) => Buffer.from(`drift-hub-login-v${VERSION}\n${Buffer.from(pin).toString('base64url')}\n${nonce}`);

// ---- invite codes: "drift:" + base64url of [2, port, pin, token, addresses..., check] (Together's codes start with 1) ----
const check = (b) => crypto.createHash('sha256').update(b).digest().subarray(0, 2);
function encodeInvite({ port, pin, token, addrs }) {
  const parts = [Buffer.from([2, port >> 8, port & 255]), pin, token];
  for (const a of addrs) { const b = ipBytes(a); if (b) parts.push(Buffer.from([b.length]), b); }
  const body = Buffer.concat(parts);
  return 'drift:' + Buffer.concat([body, check(body)]).toString('base64url');
}
function decodeInvite(text) {
  try {
    const b = Buffer.from(String(text || '').replace(/^\s*drift:/i, '').replace(/[^A-Za-z0-9_-]/g, ''), 'base64url');
    if (b.length < 3 + 32 + 16 + 2 || b[0] !== 2) return null;
    const body = b.subarray(0, b.length - 2);
    if (!check(body).equals(b.subarray(b.length - 2))) return null;
    const out = { port: body.readUInt16BE(1), pin: Buffer.from(body.subarray(3, 35)), token: Buffer.from(body.subarray(35, 51)), addrs: [] };
    for (let i = 51; i < body.length;) {
      const n = body[i];
      if ((n !== 4 && n !== 16) || i + 1 + n > body.length) return null;
      out.addrs.push(ipText(body.subarray(i + 1, i + 1 + n))); i += 1 + n;
    }
    return out.port && out.addrs.length ? out : null;
  } catch { return null; }
}

// ---- cleaning what members send ----
const cleanName = (n) => String(n || '').replace(/[\x00-\x1f\x7f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);
const cleanText = (t) => String(t || '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
const cleanChannel = (n) => String(n || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, LIMITS.channel);

// opts: dir (where the database and key live), owner (the host's public key, raw 32 bytes), name (what the hub is
// called), addrs() (the addresses to put in invites), port (to listen on, 0 = any), host (to listen on).
module.exports = function createHub(opts) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(opts.dir, { recursive: true });
  const db = new DatabaseSync(path.join(opts.dir, 'hub.db'));
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB);
    CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, key BLOB NOT NULL, name TEXT NOT NULL, joined INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, made_by TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ch INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      author TEXT NOT NULL, cid TEXT NOT NULL, v INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL, reply INTEGER, at INTEGER NOT NULL, edited INTEGER, UNIQUE (author, cid));
    CREATE INDEX IF NOT EXISTS messages_by_channel ON messages (ch, id);
    CREATE TABLE IF NOT EXISTS invites (token BLOB PRIMARY KEY, made_by TEXT NOT NULL, at INTEGER NOT NULL, expires INTEGER NOT NULL, uses INTEGER NOT NULL);
  `);
  const q = (sql) => db.prepare(sql);
  const getMeta = q('SELECT v FROM meta WHERE k = ?'), setMeta = q('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)');
  const meta = (k) => { const r = getMeta.get(k); return r ? r.v : null; };

  // The hub's own key and certificate, made once. `seal` / `unseal` let the host's Drift keep the key encrypted.
  const seal = opts.seal || ((b) => b), unseal = opts.unseal || ((b) => b);
  let keyPem = meta('key');
  if (!keyPem) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    keyPem = seal(Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })));
    setMeta.run('key', keyPem);
  }
  const hubKey = crypto.createPrivateKey(Buffer.from(unseal(Buffer.from(keyPem))).toString());
  let certPem = meta('cert') && Buffer.from(meta('cert')).toString();
  if (!certPem) { certPem = selfSigned(hubKey, 'Drift hub'); setMeta.run('cert', certPem); }
  const pin = pinOf(certPem);
  const owner = Buffer.from(opts.owner), ownerId = memberId(owner);
  let hubName = cleanName(opts.name) || (meta('name') && Buffer.from(meta('name')).toString()) || 'Drift hub';
  setMeta.run('name', hubName);
  if (!q('SELECT 1 FROM channels LIMIT 1').get()) q('INSERT INTO channels (name, made_by, at) VALUES (?, ?, ?)').run('general', ownerId, Date.now());

  const S = {
    member: q('SELECT * FROM members WHERE id = ?'), addMember: q('INSERT INTO members (id, key, name, joined) VALUES (?, ?, ?, ?)'),
    rename: q('UPDATE members SET name = ? WHERE id = ?'), ban: q('UPDATE members SET banned = 1 WHERE id = ?'),
    members: q('SELECT id, name, joined FROM members WHERE banned = 0 ORDER BY joined'),
    channels: q('SELECT id, name FROM channels ORDER BY id'), channel: q('SELECT * FROM channels WHERE id = ?'),
    addChannel: q('INSERT INTO channels (name, made_by, at) VALUES (?, ?, ?)'), dropChannel: q('DELETE FROM channels WHERE id = ?'),
    channelCount: q('SELECT COUNT(*) n FROM channels'), channelNamed: q('SELECT id FROM channels WHERE name = ?'),
    msg: q('SELECT * FROM messages WHERE id = ?'), byCid: q('SELECT * FROM messages WHERE author = ? AND cid = ?'),
    addMsg: q('INSERT INTO messages (ch, author, cid, body, reply, at) VALUES (?, ?, ?, ?, ?, ?)'),
    editMsg: q('UPDATE messages SET body = ?, edited = ? WHERE id = ?'), dropMsg: q('DELETE FROM messages WHERE id = ?'),
    before: q('SELECT * FROM messages WHERE ch = ? AND id < ? ORDER BY id DESC LIMIT ?'),
    after: q('SELECT * FROM messages WHERE ch = ? AND id > ? ORDER BY id ASC LIMIT ?'),
    invite: q('SELECT * FROM invites WHERE token = ?'), addInvite: q('INSERT INTO invites (token, made_by, at, expires, uses) VALUES (?, ?, ?, ?, ?)'),
    useInvite: q('UPDATE invites SET uses = uses - 1 WHERE token = ?'), dropInvites: q('DELETE FROM invites'), oldInvites: q('DELETE FROM invites WHERE expires < ? OR uses <= 0'),
  };
  const row = (m) => m && { id: m.id, ch: m.ch, from: m.author, text: m.body, reply: m.reply || null, at: m.at, edited: m.edited || null };

  // ---- connections ----
  const online = new Map();       // member id -> Set of sessions (a member may be on two PCs)
  const lives = new Map();        // member id -> what they're sharing right now: { from, code, title, watching, since }. Never stored.
  const liveList = () => [...lives.values()];
  const sessions = new Set();
  let server = null, port = 0;
  const everyone = (m, but) => { const line = JSON.stringify(m); for (const s of sessions) if (s.id && s !== but) s.wire.send(line); };
  const memberList = () => S.members.all().map((m) => ({ id: m.id, name: m.name, host: m.id === ownerId, online: online.has(m.id) }));
  const channelList = () => S.channels.all().map((c) => ({ id: c.id, name: c.name }));

  function invite({ by, days = INVITE_DAYS, uses = 25 }) {
    const token = crypto.randomBytes(16), now = Date.now();
    S.oldInvites.run(now);
    S.addInvite.run(token, by, now, now + Math.max(1, Math.min(30, +days || INVITE_DAYS)) * 86400e3, Math.max(1, Math.min(100, +uses || 25)));
    return encodeInvite({ port, pin, token, addrs: opts.addrs ? opts.addrs() : ['127.0.0.1'] });
  }

  function onConnection(sock) {
    if (sessions.size >= LIMITS.connections) { sock.destroy(); return; }
    const s = { id: null, nonce: crypto.randomBytes(24).toString('base64url'), wire: null, acts: { msg: [], other: [], live: [] }, typed: 0 };
    sessions.add(s);
    const login = setTimeout(() => { if (!s.id) s.wire.close(); }, 15000);
    s.wire = wire(sock, null, (m) => { try { onMessage(s, m); } catch (e) { reply(s, m, { error: 'Something went wrong on the hub.' }); if (opts.log) opts.log('hub: ' + (e && e.stack || e)); } }, () => {
      clearTimeout(login); sessions.delete(s);
      if (s.id && online.has(s.id)) {
        const set = online.get(s.id); set.delete(s);
        if (!set.size) { online.delete(s.id); everyone({ t: 'members', list: memberList() }); if (lives.delete(s.id)) everyone({ t: 'lives', list: liveList() }); }
      }
    }, LIMITS.line);
    s.wire.send({ t: 'hello', v: VERSION, nonce: s.nonce, name: hubName });
  }
  const reply = (s, m, out) => s.wire.send({ t: out.error ? 'err' : 'ok', re: m && m.re, ...out });
  // Ten of each kind of action every ten seconds for each member (messages and edits; everything else), so one person
  // (or a stuck script) can't flood everyone, and a burst of messages doesn't stop them making an invite.
  function slow(s, kind = 'msg') {
    const now = Date.now();
    s.acts[kind] = s.acts[kind].filter((t) => now - t < LIMITS.perSecs * 1000);
    if (s.acts[kind].length >= LIMITS.actions) return true;
    s.acts[kind].push(now); return false;
  }

  function onMessage(s, m) {
    if (m.t === 'ping') { s.wire.send({ t: 'pong' }); return; }
    if (!s.id) {
      if (m.t !== 'auth') { s.wire.close(); return; }
      let raw = null, ok = false;
      try { raw = Buffer.from(String(m.key), 'base64url'); ok = raw.length === 32 && crypto.verify(null, loginText(pin, s.nonce), keyFromRaw(raw), Buffer.from(String(m.sig), 'base64url')); } catch { ok = false; }
      if (!ok) { reply(s, m, { error: 'That sign-in didn\'t check out.' }); s.wire.close(); return; }
      const id = memberId(raw), known = S.member.get(id);
      if (known && known.banned) { reply(s, m, { error: 'The host has removed you from this hub.', gone: true }); s.wire.close(); return; }
      if (!known) {
        let inv = null;
        try { inv = m.invite && S.invite.get(Buffer.from(String(m.invite), 'base64url')); } catch { inv = null; }
        if (!raw.equals(owner) && (!inv || inv.expires < Date.now() || inv.uses <= 0)) { reply(s, m, { error: 'That invite has expired or was withdrawn. Ask for a new one.', gone: true }); s.wire.close(); return; }
        if (inv) S.useInvite.run(inv.token);
        S.addMember.run(id, raw, cleanName(m.name) || 'Friend', Date.now());
      } else if (cleanName(m.name) && cleanName(m.name) !== known.name) S.rename.run(cleanName(m.name), id);
      s.id = id;
      if (!online.has(id)) online.set(id, new Set());
      online.get(id).add(s);
      reply(s, m, { me: id, host: id === ownerId, hub: hubName, addrs: opts.addrs ? opts.addrs() : [], members: memberList(), channels: channelList(), lives: liveList() });       // addrs: so members can still find the hub when its addresses change
      everyone({ t: 'members', list: memberList() }, s);
      return;
    }
    const isHost = s.id === ownerId;
    switch (m.t) {
      case 'history': {       // a page of a channel: the newest (or those before `before`), or those after `after` when catching up
        const ch = +m.ch, n = Math.max(1, Math.min(LIMITS.page, +m.limit || 50));
        if (!S.channel.get(ch)) return reply(s, m, { error: 'No such channel.' });
        const list = m.after ? S.after.all(ch, +m.after, n) : S.before.all(ch, m.before ? +m.before : Number.MAX_SAFE_INTEGER, n).reverse();
        return reply(s, m, { ch, msgs: list.map(row) });
      }
      case 'send': {
        const ch = +m.ch, text = cleanText(m.text), cid = String(m.cid || '').slice(0, 40);
        if (!S.channel.get(ch)) return reply(s, m, { error: 'No such channel.' });
        if (!text) return reply(s, m, { error: 'Nothing to send.' });
        if (text.length > LIMITS.text) return reply(s, m, { error: `Messages can be up to ${LIMITS.text} characters.` });
        if (!cid) return reply(s, m, { error: 'Missing message id.' });
        const again = S.byCid.get(s.id, cid);       // the same message sent twice (a retry after a dropped connection)
        if (again) return reply(s, m, { msg: row(again) });
        if (slow(s)) return reply(s, m, { error: 'Slow down a little.' });
        const to = m.reply ? S.msg.get(+m.reply) : null;
        const r = S.addMsg.run(ch, s.id, cid, text, to && to.ch === ch ? to.id : null, Date.now());
        const msg = row(S.msg.get(r.lastInsertRowid));
        everyone({ t: 'msg', msg });
        return reply(s, m, { msg });
      }
      case 'edit': {
        const old = S.msg.get(+m.id), text = cleanText(m.text);
        if (!old || old.author !== s.id) return reply(s, m, { error: 'You can only edit your own messages.' });
        if (!text || text.length > LIMITS.text) return reply(s, m, { error: `Messages can be up to ${LIMITS.text} characters.` });
        if (slow(s)) return reply(s, m, { error: 'Slow down a little.' });
        S.editMsg.run(text, Date.now(), old.id);
        const msg = row(S.msg.get(old.id));
        everyone({ t: 'msg', msg });
        return reply(s, m, { msg });
      }
      case 'delete': {       // deleting really deletes: the row goes, and everyone connected drops it
        const old = S.msg.get(+m.id);
        if (!old || (old.author !== s.id && !isHost)) return reply(s, m, { error: 'You can only delete your own messages.' });
        S.dropMsg.run(old.id);
        everyone({ t: 'gone', ch: old.ch, id: old.id });
        return reply(s, m, {});
      }
      case 'typing': {
        const now = Date.now();
        if (now - s.typed < 2000 || !S.channel.get(+m.ch)) return;
        s.typed = now;
        everyone({ t: 'typing', ch: +m.ch, from: s.id }, s);
        return;
      }
      case 'channel': {       // anyone can make a channel
        const name = cleanChannel(m.name);
        if (!name) return reply(s, m, { error: 'Channel names use letters, numbers and dashes.' });
        if (S.channelNamed.get(name)) return reply(s, m, { error: `There's already a #${name}.` });
        if (S.channelCount.get().n >= LIMITS.channels) return reply(s, m, { error: 'This hub has as many channels as it can hold.' });
        if (slow(s, 'other')) return reply(s, m, { error: 'Slow down a little.' });
        const r = S.addChannel.run(name, s.id, Date.now());
        everyone({ t: 'channels', list: channelList() });
        return reply(s, m, { ch: Number(r.lastInsertRowid) });
      }
      case 'channel-delete': {       // the host, or whoever made it
        const c = S.channel.get(+m.ch);
        if (!c) return reply(s, m, { error: 'No such channel.' });
        if (!isHost && c.made_by !== s.id) return reply(s, m, { error: 'Only the host or whoever made a channel can delete it.' });
        if (S.channelCount.get().n <= 1) return reply(s, m, { error: 'A hub needs at least one channel.' });
        S.dropChannel.run(c.id);
        everyone({ t: 'channels', list: channelList() });
        return reply(s, m, {});
      }
      case 'name': {
        const name = cleanName(m.name);
        if (!name) return reply(s, m, { error: 'Pick a name.' });
        S.rename.run(name, s.id);
        everyone({ t: 'members', list: memberList() });
        return reply(s, m, {});
      }
      case 'invite': {       // anyone can invite
        if (slow(s, 'other')) return reply(s, m, { error: 'Slow down a little.' });
        return reply(s, m, { code: invite({ by: s.id, days: m.days, uses: m.uses }) });
      }
      case 'live': {       // this member started, changed or stopped sharing (Together). The code is their PC's watch-together invite.
        if (!m.on) { if (lives.delete(s.id)) everyone({ t: 'lives', list: liveList() }); return; }
        if (slow(s, 'live')) return;
        const code = String(m.code || '').replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 400);
        if (!code) return;
        const was = lives.get(s.id);
        lives.set(s.id, { from: s.id, code, title: cleanText(m.title).replace(/\s+/g, ' ').slice(0, 120),
          watching: (Array.isArray(m.watching) ? m.watching : []).slice(0, 8).map(cleanName).filter(Boolean), since: was && was.code === code ? was.since : Date.now() });
        everyone({ t: 'lives', list: liveList() });
        return;
      }
      case 'withdraw-invites': {
        if (!isHost) return reply(s, m, { error: 'Only the host can do that.' });
        S.dropInvites.run();
        return reply(s, m, {});
      }
      case 'remove': {       // the host removes someone: banned by key, and every session of theirs ends now
        const who = S.member.get(String(m.member || ''));
        if (!isHost) return reply(s, m, { error: 'Only the host can remove people.' });
        if (!who || who.id === ownerId) return reply(s, m, { error: 'No such member.' });
        S.ban.run(who.id);
        for (const x of online.get(who.id) || []) { x.wire.send({ t: 'removed' }); setTimeout(() => x.wire.close(), 100); }
        online.delete(who.id);
        everyone({ t: 'members', list: memberList() });
        if (lives.delete(who.id)) everyone({ t: 'lives', list: liveList() });
        return reply(s, m, {});
      }
      default: return reply(s, m, { error: 'The hub doesn\'t know how to do that.' });
    }
  }

  return {
    pin, ownerId,
    start: () => new Promise((resolve, reject) => {
      server = tls.createServer({ key: hubKey.export({ type: 'pkcs8', format: 'pem' }), cert: certPem, minVersion: 'TLSv1.3' }, onConnection);
      server.on('tlsClientError', () => {});
      // The port the hub had before (so invites keep working), else any; IPv6 and IPv4 together, else IPv4 alone.
      const tries = [...(opts.port ? [[opts.port, opts.host || '::'], [opts.port, '0.0.0.0']] : []), [0, opts.host || '::'], [0, '0.0.0.0']];
      const next = () => {
        const [p, h] = tries.shift() || [];
        if (h === undefined) { reject(new Error('no port')); return; }
        server.once('error', next);
        server.listen(p, h, () => { server.removeListener('error', next); server.on('error', () => {}); port = server.address().port; resolve(port); });
      };
      next();
    }),
    port: () => port,
    name: () => hubName,
    invite: (o = {}) => invite({ by: ownerId, ...o }),
    stats: () => ({ online: online.size, sessions: sessions.size, members: S.members.all().length }),
    stop: () => new Promise((resolve) => {
      for (const s of sessions) { s.wire.send({ t: 'bye' }); s.wire.close(); }
      if (!server) { db.close(); resolve(); return; }
      server.close(() => { db.close(); resolve(); });
      server = null;
    }),
  };
};
Object.assign(module.exports, { encodeInvite, decodeInvite, pinOfPeer, memberId, rawKey, loginText, cleanText, VERSION, LIMITS });
