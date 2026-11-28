// Drift — the hub: one small server for a group of friends' chat (docs/plans/voice-and-chat.md). It runs inside the
// host's Drift (or on its own later) and keeps the channels and their history in SQLite. Members are Ed25519 public
// keys; there are no accounts or passwords. Everyone is equal except the host, who can remove someone (a ban by key),
// delete any message and withdraw every invite. It also passes on who is sharing a video or page right now (the Hub tab):
// a member's Drift announces its watch-together code here, and everyone else gets a Join button in the chat.
//
// Voice: one voice room per hub (docs/plans/broadcast.md §1). Being online in a hub, with it as your active hub, puts
// you in its room, listening; talking is opt-in. Up to 16 people in the room and 8 talking at once, as a mesh. The hub
// keeps who is in the room (and who talks or listens), passes setup messages between them and relays the media through
// its TURN server (turn.js) on one UDP port. It is never trusted with the sound itself: every setup message carries the sender's signature over their DTLS fingerprint, made and checked by the
// members' own Drift (chat.js), so a hub that swaps fingerprints, drops signatures or replays old ones is caught.
// Member lists carry each member's public key for that check; chat.js makes sure each key hashes to its member id.
//
// Broadcast (docs/plans/broadcast.md §2–§4): anyone in the voice room can stream a monitor or a window to the others,
// one each and four per hub at a time, to up to 7 viewers each. The hub keeps who is broadcasting what and who watches
// (bc), passes their signed setup messages along (bc-signal) and relays the picture, the same way as voice.
//
// The Surf stream (docs/plans/streams.md §7): one web browser for the whole hub, running on the host's PC. The host's Drift
// says when it runs and what its front tab is (surf-stream), members online say whether they're watching (surf-watch, up to 7
// at once), and the hub passes the signed setup messages between the host and each watcher (surf-signal) and relays the
// picture. The host's Drift talks to its own hub for this in-process (service()), apart from its ordinary connection, so the
// stream carries on for everyone while the host is disconnected from the hub themselves.
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
const { wire, ipBytes, ipText, localAddrs } = require('./p2p');
const createTurn = require('./turn');
const { createTable } = require('./blackjack');
const GAME_RULES = { roulette: require('./roulette').createTable, poker: require('./poker').createTable, sketch: require('./sketch').createTable, pachinko: require('./pachinko').createTable, crane: require('./crane').createTable };       // the Games room's other tables (hub `games`)
const { createWallet } = require('./wallet');

const VERSION = 1;
const LIMITS = { line: 256 * 1024, text: 4000, name: 24, channel: 32, channels: 50, page: 100, actions: 10, perSecs: 10, connections: 64, avatar: 14000, voice: 16, talkers: 8, signals: 200, broadcasts: 4, viewers: 7, bcTitle: 80, bcThumb: 200000, surfWatchers: 7,
  file: 4 * 1024 * 1024, fileChunk: 160 * 1024, files: 300 * 1024 * 1024, reactions: 20,       // file: the biggest picture or GIF (bytes), sent fileChunk at a time; files: all of a hub's together
  // Files sent straight between members' PCs (docs/plans/files.md): offered in a message, never kept here. offerMax: the
  // biggest a file may say it is; relayMax: the biggest that may go through the hub's relay (bigger ones connect directly);
  // offers: open at once for each member; ftSend / ftRecv: transfers at once for each member; ftRelayed: through the relay at
  // once in the whole hub; ftRate / ftRateAll / ftDay: the relay's speed for each file and for all, and its most in a day.
  offerName: 200, offerMax: 2 ** 40, relayMax: 500 * 1024 * 1024, offers: 50, ftSend: 3, ftRecv: 3, ftRelayed: 8,
  ftRate: 2 * 1024 * 1024, ftRateAll: 4 * 1024 * 1024, ftDay: 5e9, piece: 16 * 1024 * 1024 };
const TURN_SECS = 24 * 3600;       // how long relay credentials last (the relay also stops as soon as someone leaves the room or stops listening)
const INVITE_DAYS = 7;
// Where a member connects from, as far as reaching each other's shares goes ("reach" below): 'near' for this PC, its own network
// and the other private ranges (a VPN such as Tailscale included), whose PCs reach one another; otherwise their public address
// (for IPv6 its first half, one home's).
function placeOf(ip) {
  const a = String(ip || '').replace(/^::ffff:/i, ''), b = ipBytes(a);
  if (!b) return 'near';
  if (b.length === 4) return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) ? 'near' : a;
  const loop = b.subarray(0, 15).every((x) => !x) && b[15] === 1;
  return loop || (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) ? 'near' : b.subarray(0, 8).toString('hex');
}

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

// ---- invite codes: "drift:" + base64url of [2, port, pin, token, addresses..., check] (the old watch-together codes start with 1) ----
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
// A profile picture: a small raster image as a data: URL, made by the member's Drift (cropped, re-encoded, so no EXIF).
// Only WebP, JPEG and PNG, and the bytes must really start like one: never SVG, which can carry script.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function cleanAvatar(d) {
  d = String(d || '');
  const m = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(d);
  if (!m || d.length > LIMITS.avatar) return null;
  const b = Buffer.from(m[2], 'base64');
  const ok = m[1] === 'jpeg' ? b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff : m[1] === 'png' ? b.subarray(0, 8).equals(PNG)
    : b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
  return ok ? d : null;
}
// A picture or GIF sent in a channel: what it is, from its first bytes (never from what the sender says), so only these four
// ever get to a page. null for anything else.
function sniffImage(b) {
  if (!b || b.length < 12) return null;
  const head = b.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (b.subarray(0, 8).equals(PNG)) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
// A reaction: one emoji (a single grapheme that is a pictograph, a flag or a keycap), nothing else.
const EMOJI_OK = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Presentation}|‍|️|⃣)+$/u;
function cleanEmoji(e) {
  e = String(e || '').normalize('NFC').trim();
  if (!e || e.length > 32 || !EMOJI_OK.test(e) || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(e)) return '';
  return [...new Intl.Segmenter().segment(e)].length === 1 ? e : '';
}
const avatarId = (d) => (d ? crypto.createHash('sha256').update(d).digest().subarray(0, 9).toString('base64url') : '');
// A file's name as offered: no folders, nothing Windows can't keep in a name, and not too long (the receiving Drift cleans it again).
function cleanFileName(n) {
  let s = String(n || '').normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '');
  if (s.length > LIMITS.offerName) { const ext = (s.match(/\.[^.]{1,12}$/) || [''])[0]; s = s.slice(0, LIMITS.offerName - ext.length) + ext; }
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) s = '_' + s;
  return s;
}
const OFFER_ID = /^[A-Za-z0-9_-]{16,64}$/, ROOT = /^[A-Za-z0-9_-]{43}$/;
const cleanMime = (t) => (/^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,80}$/i.test(String(t || '')) ? String(t).toLowerCase() : 'application/octet-stream');
const cleanChannel = (n) => String(n || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, LIMITS.channel);

// opts: dir (where the database and key live), owner (the host's public key, raw 32 bytes), name (what the hub is
// called), addrs() (the addresses to put in invites), port (to listen on, 0 = any), host (to listen on), gameSettings(g)
// (the host's settings for a game's table, e.g. Sketch & Guess's time, rounds and words; read between games).
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
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, msg INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, mime TEXT NOT NULL,
      w INTEGER NOT NULL, h INTEGER NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS files_by_msg ON files (msg);
    CREATE TABLE IF NOT EXISTS offers (id TEXT PRIMARY KEY, msg INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, name TEXT NOT NULL,
      size INTEGER NOT NULL, mime TEXT NOT NULL, root TEXT NOT NULL, piece INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS offers_by_msg ON offers (msg);
    CREATE TABLE IF NOT EXISTS reactions (msg INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, who TEXT NOT NULL, emoji TEXT NOT NULL,
      at INTEGER NOT NULL, PRIMARY KEY (msg, who, emoji));
    CREATE TABLE IF NOT EXISTS bj_pots (member TEXT PRIMARY KEY, win INTEGER NOT NULL, blackjack INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS game_records (game TEXT NOT NULL, member TEXT NOT NULL, value INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (game, member));
  `);
  for (const col of ['avatar TEXT', 'av TEXT']) { try { db.exec(`ALTER TABLE members ADD COLUMN ${col}`); } catch { /* there already */ } }       // added after the first hubs were made
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
  // Messages last one session of the host's Drift: wiped when it closes (clearMessages) and, in case it didn't close
  // cleanly, when it first hosts again (opts.fresh). Channels, members and invites stay.
  function clearMessages() {
    db.exec('DELETE FROM files; DELETE FROM offers; DELETE FROM reactions; DELETE FROM messages');
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM'); } catch { /* still wiped; the file shrinks next time */ }
  }
  if (opts.fresh) clearMessages();
  if (!q('SELECT 1 FROM channels LIMIT 1').get()) q('INSERT INTO channels (name, made_by, at) VALUES (?, ?, ?)').run('general', ownerId, Date.now());

  const S = {
    member: q('SELECT * FROM members WHERE id = ?'), addMember: q('INSERT INTO members (id, key, name, joined) VALUES (?, ?, ?, ?)'),
    rename: q('UPDATE members SET name = ? WHERE id = ?'), ban: q('UPDATE members SET banned = 1 WHERE id = ?'),
    members: q('SELECT id, key, name, joined, av FROM members WHERE banned = 0 ORDER BY joined'),
    setAvatar: q('UPDATE members SET avatar = ?, av = ? WHERE id = ?'), avatar: q('SELECT avatar FROM members WHERE id = ? AND banned = 0'),
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
  Object.assign(S, {
    addFile: q('INSERT INTO files (id, msg, mime, w, h, size, data, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'), fileOf: q('SELECT id, mime, w, h, size FROM files WHERE msg = ?'),
    filePart: q('SELECT mime, size, substr(data, ?, ?) part FROM files WHERE id = ?'), fileBytes: q('SELECT COALESCE(SUM(size), 0) n FROM files'),
    oldestFile: q('SELECT id, msg FROM files ORDER BY at LIMIT 1'), dropFile: q('DELETE FROM files WHERE id = ?'),
    reactsOf: q('SELECT emoji, who FROM reactions WHERE msg = ? ORDER BY at, rowid'), addReact: q('INSERT OR IGNORE INTO reactions (msg, who, emoji, at) VALUES (?, ?, ?, ?)'),
    dropReact: q('DELETE FROM reactions WHERE msg = ? AND who = ? AND emoji = ?'), reactKinds: q('SELECT COUNT(DISTINCT emoji) n FROM reactions WHERE msg = ?'),
    reactKind: q('SELECT 1 FROM reactions WHERE msg = ? AND emoji = ? LIMIT 1'),
    addOffer: q('INSERT INTO offers (id, msg, name, size, mime, root, piece) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    offerOf: q('SELECT id, name, size, mime, root, piece, gone FROM offers WHERE msg = ?'),
    offer: q('SELECT o.*, m.author, m.ch FROM offers o JOIN messages m ON m.id = o.msg WHERE o.id = ?'),
    offersBy: q('SELECT COUNT(*) n FROM offers o JOIN messages m ON m.id = o.msg WHERE m.author = ? AND o.gone = 0'),
    dropOffer: q('UPDATE offers SET gone = 1 WHERE id = ?'),
    // the blackjack table's biggest pots: each member's best round (kept, unlike their chips), and the top five
    bjPot: q('INSERT INTO bj_pots (member, win, blackjack, at) VALUES (?, ?, ?, ?) ON CONFLICT (member) DO UPDATE SET win = excluded.win, blackjack = excluded.blackjack, at = excluded.at WHERE excluded.win > bj_pots.win'),
    bjBoard: q('SELECT p.member, p.win, p.blackjack, p.at FROM bj_pots p JOIN members m ON m.id = p.member WHERE m.banned = 0 ORDER BY p.win DESC, p.at ASC LIMIT 5'),
    // the other tables' records (Roulette: the biggest win on one spin; Hold'em: the biggest pot won), each member's best, the top five
    gameRecord: q('INSERT INTO game_records (game, member, value, at) VALUES (?, ?, ?, ?) ON CONFLICT (game, member) DO UPDATE SET value = excluded.value, at = excluded.at WHERE excluded.value > game_records.value'),
    gameBoard: q('SELECT r.member, r.value, r.at FROM game_records r JOIN members m ON m.id = r.member WHERE r.game = ? AND m.banned = 0 ORDER BY r.value DESC, r.at ASC LIMIT 5'),
  });
  // Reactions on a message, in the order they were first given: [{ e, who: [member ids] }]
  function reactsOf(id) {
    const by = new Map();
    for (const r of S.reactsOf.all(id)) { if (!by.has(r.emoji)) by.set(r.emoji, []); by.get(r.emoji).push(r.who); }
    return [...by].map(([e, who]) => ({ e, who }));
  }
  // A message as members get it. file: the picture or GIF it carries (fetched apart, with file-get); a message whose file was
  // let go to make room has neither text nor file.
  const row = (m) => {
    if (!m) return m;
    const out = { id: m.id, ch: m.ch, from: m.author, text: m.body, reply: m.reply || null, at: m.at, edited: m.edited || null };
    const f = S.fileOf.get(m.id), reacts = reactsOf(m.id);
    if (f) out.file = { id: f.id, mime: f.mime, w: f.w, h: f.h, size: f.size };
    const o = S.offerOf.get(m.id);
    if (o) out.offer = { id: o.id, name: o.name, size: o.size, mime: o.mime, root: o.root, piece: o.piece, gone: !!o.gone };
    if (reacts.length) out.reacts = reacts;
    return out;
  };
  // Pictures past LIMITS.files altogether: the oldest go (their messages stay, with whatever was written with them).
  function makeRoom() {
    for (let i = 0; i < 1000 && S.fileBytes.get().n > LIMITS.files; i++) {
      const f = S.oldestFile.get();
      if (!f) break;
      S.dropFile.run(f.id);
      const msg = row(S.msg.get(f.msg));
      if (msg) everyone({ t: 'msg', msg, again: true });       // (again: a change to an old message, not news)
    }
  }

  // ---- connections ----
  const online = new Map();       // member id -> Set of sessions (a member may be on two PCs)
  const mics = new Map();         // member id -> does their PC have a microphone (only while online)
  const wheres = new Map();       // member id -> the screen their Drift shows ('scenes' | 'media' | 'surf' | 'broadcast' | 'blackjack' | 'roulette' | 'poker'), for the hub bar's jump to it (only while online)
  const lives = new Map();        // member id -> what they're sharing right now: { from, code, title, watching, since, reach, place }. Never stored.
  const liveList = () => [...lives.values()].map(({ place: _p, ...l }) => l);
  // ---- reach: can everyone online get to a share? ----
  // A share is watched by connecting straight to the sharing PC (p2p.js), so someone whose router doesn't let friends in can only
  // be watched from their own network. Listed anyway, everyone else was pulled into something they couldn't get, while its sender
  // thought it was on. So the sharer says how far their PC can be reached (reach: 'internet', 'lan', or 'manual': couldn't be
  // checked). 'lan' and 'manual' are only guesses about the router's IPv4 port: the invite also carries the PC's IPv6 and VPN
  // (Tailscale) addresses, which friends elsewhere often get in by. So they go on anyway, and come off if a member says they
  // couldn't connect to it (live-fail). Taken off, its sender hears why (live-no, why 'unreached', with who), and plays it alone.
  // ('internet', and a Drift from before that says nothing, are left on: a member who can't connect then is likely the trouble.)
  // (Hubs before 1.11.2 kept a 'lan' share off while anyone online was elsewhere: live-no why 'reach'. main.js still reads it.)
  const placesOf = (id) => new Set([...(online.get(id) || [])].map((x) => x.place));
  const nameOf = (id) => (S.member.get(id) || {}).name || 'Someone';
  function liveOff(from, why, who) {
    if (!lives.delete(from)) return;
    everyone({ t: 'lives', list: liveList() });
    for (const x of online.get(from) || []) x.wire.send({ t: 'live-no', why, who: who.slice(0, 3).map(nameOf) });
    recount();       // (a vote to replace it has nothing left to replace)
  }
  // Who online is somewhere else than session `s` (only their ids: nobody learns where anyone is). Each member's Drift uses it to
  // say, before they share, whether their router matters (main.js shareCheck).
  const apartFrom = (s) => [...online.keys()].filter((id) => id !== s.id && !placesOf(id).has(s.place));
  const sessions = new Set();
  let server = null, port = 0;
  const everyone = (m, but) => { const line = JSON.stringify(m); for (const s of sessions) if (s.id && s !== but) s.wire.send(line); };

  // ---- the blackjack table (docs/plans/blackjack.md §5): one per hub, dealt here ----
  // Members at it send what they want to do (bj-sit, or bj-watch to look on; bj-bet, bj-insure, bj-act; bj-stand to give up their
  // seat and keep looking on; bj-leave), the rules (blackjack.js) decide, and
  // everyone at the table gets the table as they see it (bj-view) whenever it changes. Chips are the hub's wallet (below),
  // shared with the other casino tables; a crapped-out member's wait is the wallet's too, so standing up doesn't skip it.
  // Where everyone's mouse is over the table goes round too (bj-ptr up, bj-ptrs down), at most 25 times a second.
  // The biggest pots: whenever a round settles, each member's winnings for it (net, over all their hands) beat their record
  // or don't; the top five go out with the table (board), with how long ago each was set (ago, so a new one can light up).
  // The casino's one wallet at this hub (wallet.js): each member's chips at Blackjack, Roulette, Hold'em and Pachinko are the
  // same chips. They're the member's own (main.js state.wallet, the same at every hub and alone): their PC sends its count when
  // they sit down at a table here and aren't at any yet (walletTake), and every view sent them carries the count back
  // (walletOf, bets still riding counted as theirs, as alone), for their PC to keep. A change shows at every table they're at
  // (walletNews), a moment later and once however many balls went in. Trusted as sent: the stakes are low.
  const walletDirty = new Set();
  let walletTimer = null;
  const wallet = createWallet({ owns: (id) => !!S.member.get(id), onChange: (id) => { walletDirty.add(id); if (!walletTimer) walletTimer = setTimeout(walletNews, 60); } });
  function walletNews() {
    walletTimer = null;
    const ids = [...walletDirty]; walletDirty.clear();
    if (ids.some((id) => bjAt.has(id))) bjNews(true);
    for (const x of games.values()) if (ids.some((id) => x.at.has(id))) gameNews(x, true);
  }
  const bj = createTable({ times: opts.bjTimes, wallet, onSettle: (list) => { const now = Date.now(); for (const x of list) if (x.net > 0 && S.member.get(x.id)) S.bjPot.run(x.id, Math.floor(x.net), x.blackjack ? 1 : 0, now); } });
  const bjAt = new Map();       // member id -> their session at the table, seated or looking on (one: the last PC they came to it from)
  const bjPtrs = new Map();     // member id -> { x, y } over the table
  let bjSent = -1, bjTimer = null, bjPtrTimer = null;
  const bjBoard = () => { const now = Date.now(); return S.bjBoard.all().map((r) => ({ id: r.member, name: nameOf(r.member), win: r.win, bj: !!r.blackjack, ago: Math.max(0, now - r.at) })); };
  function bjNews(force) {
    if (!force && bj.version === bjSent) return;
    bjSent = bj.version;
    const board = bjBoard();
    for (const [id, s] of bjAt) s.wire.send({ t: 'bj-view', v: { ...bj.view(id), board, wallet: walletOf(id) } });
  }
  // a member's chips as their PC should keep them: the wallet's, with what's still riding at any table here counted as theirs
  function walletOf(id) {
    if (!wallet.has(id)) return undefined;
    const w = wallet.peek(id);
    let riding = 0;
    for (const t of [bj, ...[...games.values()].map((x) => x.t)]) { const k = t.mine(id); if (k) riding += Math.max(0, k.chips - w.chips); }
    return { chips: w.chips + riding, outUntil: w.outUntil };
  }
  // sitting down here, at no table yet: the chips their PC sent are the ones they play (an older Drift sends none: the hub's)
  function walletTake(id, q) {
    if (!q || typeof q !== 'object' || bjAt.has(id) || [...games.values()].some((x) => x.at.has(id))) return;
    if (!Number.isFinite(+q.chips)) return;
    wallet.set(id, { chips: Math.min(1e12, +q.chips), outUntil: Math.min(Date.now() + 120000, +q.outUntil || 0) });
  }
  function bjRun() {
    if (bjTimer) return;
    bjTimer = setInterval(() => {
      bj.tick(); bjNews();
      if (!bjAt.size && bj.phase === 'idle') { clearInterval(bjTimer); bjTimer = null; }
    }, 200);
  }
  function bjPtrNews() {
    if (bjPtrTimer) return;
    bjPtrTimer = setTimeout(() => {
      bjPtrTimer = null;
      const all = [...bjPtrs].filter(([id]) => bjAt.has(id)).map(([id, q]) => ({ id, name: nameOf(id), x: q.x, y: q.y }));
      for (const [id, s] of bjAt) s.wire.send({ t: 'bj-ptrs', list: all.filter((q) => q.id !== id) });
    }, 40);
  }
  function bjLeave(id) {
    if (!bjAt.delete(id)) return;
    bj.leave(id);
    if (bjPtrs.delete(id)) bjPtrNews();
    bj.tick(); bjNews();
  }
  function bjMessage(s, m) {
    if (m.t === 'bj-ptr') {       // mouse moves: many, small, and dropped past 30 a second
      const now = Date.now();
      if (now - (s.bjPtrAt || 0) >= 1000) { s.bjPtrAt = now; s.bjPtrN = 0; }
      if (++s.bjPtrN > 30 || bjAt.get(s.id) !== s) return;
      const ok = +m.x >= 0 && +m.x <= 1 && +m.y >= 0 && +m.y <= 1;
      if (ok) bjPtrs.set(s.id, { x: +(+m.x).toFixed(4), y: +(+m.y).toFixed(4) }); else if (!bjPtrs.delete(s.id)) return;
      bjPtrNews();
      return;
    }
    if (slow(s, 'bj', 40)) return reply(s, m, { error: 'Slow down a little.' });
    let r = { ok: true };
    if (m.t === 'bj-sit' || m.t === 'bj-watch') {       // at the table: sitting down (or in line for a seat), or only looking on
      const was = bjAt.get(s.id);
      if (was && was !== s) was.wire.send({ t: 'bj-view', v: null });       // came to the table from another PC: this one takes it
      if (m.t === 'bj-sit') walletTake(s.id, m.wallet);
      bjAt.set(s.id, s);
      if (m.t === 'bj-sit') r = bj.sit(s.id, nameOf(s.id));
      bjRun(); bj.tick(); bjNews(true);
      return reply(s, m, r);
    }
    if (m.t === 'bj-leave') { if (bjAt.get(s.id) === s) bjLeave(s.id); return reply(s, m, {}); }
    if (bjAt.get(s.id) !== s) return reply(s, m, { error: 'Sit down at the table first.' });
    if (m.t === 'bj-stand') { bj.leave(s.id); bj.tick(); bjNews(true); return reply(s, m, {}); }       // up from the seat (or out of the line), still looking on
    if (m.t === 'bj-bet') r = bj.bet(s.id, +m.amount);
    else if (m.t === 'bj-insure') r = bj.insure(s.id, !!m.yes);
    else if (m.t === 'bj-act') r = bj.act(s.id, String(m.do || ''));
    bj.tick(); bjNews();
    return reply(s, m, r.error ? { error: r.error } : {});
  }

  // ---- the Games room's other tables (docs/plans/games-room.md): Roulette and Texas Hold'em, one of each per hub ----
  // The same as the blackjack table above, for any game in GAME_RULES: each message names its game (g). Up: game-sit,
  // game-watch, game-stand, game-leave, game-move ({ m: the move, for the rules to judge }), game-ptr. Down: game-view
  // (the table as that member sees it, with the game's board of records) and game-ptrs. A table is made when first sat at,
  // and ticks only while anyone is at it or a round is still settling. Hold'em seats a computer player when only one
  // person is there (fill: 2), so they're never left with nobody to play.
  const games = new Map();       // game id -> { t: its table, at: member id -> session, ptrs, sent, timer, ptrTimer }
  function gameOf(g) {
    if (!Object.hasOwn(GAME_RULES, g)) return null;
    let x = games.get(g);
    if (!x) {
      x = { g, at: new Map(), ptrs: new Map(), sent: -1, timer: null, ptrTimer: null };
      x.t = GAME_RULES[g]({ times: (opts.gameTimes || {})[g], fill: 2, wallet, settings: opts.gameSettings ? () => opts.gameSettings(g) : undefined, onSettle: (list) => { const now = Date.now(); for (const r of list) if (r.score > 0 && !r.bot && S.member.get(r.id)) S.gameRecord.run(g, r.id, Math.floor(r.score), now); } });
      games.set(g, x);
    }
    return x;
  }
  const gameBoard = (g) => { const now = Date.now(); return S.gameBoard.all(g).map((r) => ({ id: r.member, name: nameOf(r.member), win: r.value, ago: Math.max(0, now - r.at) })); };
  // A drawing game's sheet (sketch.js: ink, inkRev, inkLen) goes out apart from the views, as it grows: each session gets what
  // it hasn't had yet (game-ink { rev, from, list }), all of it when the sheet is new or the session is
  function gameInk(x) {
    if (typeof x.t.ink !== 'function') return;
    const rev = x.t.inkRev, len = x.t.inkLen;
    for (const s of x.at.values()) {
      const had = (s.gInk = s.gInk || {})[x.g];
      if (!had || had.rev !== rev) { s.wire.send({ t: 'game-ink', g: x.g, rev, from: 0, list: x.t.ink(0) }); s.gInk[x.g] = { rev, n: len }; }
      else if (had.n < len) { s.wire.send({ t: 'game-ink', g: x.g, rev, from: had.n, list: x.t.ink(had.n) }); had.n = len; }
    }
  }
  function gameNews(x, force) {
    gameInk(x);
    if (!force && x.t.version === x.sent) return;
    x.sent = x.t.version;
    const records = gameBoard(x.g);       // (not "board": Hold'em's view has its own board, the cards in the middle)
    for (const [id, s] of x.at) s.wire.send({ t: 'game-view', g: x.g, v: { ...x.t.view(id), records, wallet: walletOf(id) } });
  }
  function gameRun(x) {
    if (x.timer) return;
    x.timer = setInterval(() => {
      x.t.tick(); gameNews(x);
      if (!x.at.size && x.t.phase === 'idle') { clearInterval(x.timer); x.timer = null; }
    }, x.t.tickMs || 200);       // (Pachinko's balls: every 50 ms)
  }
  function gamePtrNews(x) {
    if (x.ptrTimer) return;
    x.ptrTimer = setTimeout(() => {
      x.ptrTimer = null;
      const all = [...x.ptrs].filter(([id]) => x.at.has(id)).map(([id, q]) => ({ id, name: nameOf(id), x: q.x, y: q.y }));
      for (const [id, s] of x.at) s.wire.send({ t: 'game-ptrs', g: x.g, list: all.filter((q) => q.id !== id) });
    }, 40);
  }
  function gameLeave(x, id) {
    if (!x.at.delete(id)) return;
    x.t.leave(id);
    if (x.ptrs.delete(id)) gamePtrNews(x);
    x.t.tick(); gameNews(x);
  }
  function gameMessage(s, m) {
    const x = gameOf(String(m.g || ''));
    if (m.t === 'game-ptr') {       // mouse moves: many, small, and dropped past 30 a second
      if (!x) return;
      const now = Date.now();
      if (now - (s.gamePtrAt || 0) >= 1000) { s.gamePtrAt = now; s.gamePtrN = 0; }
      if (++s.gamePtrN > 30 || x.at.get(s.id) !== s) return;
      const ok = +m.x >= 0 && +m.x <= 1 && +m.y >= 0 && +m.y <= 1;
      if (ok) x.ptrs.set(s.id, { x: +(+m.x).toFixed(4), y: +(+m.y).toFixed(4) }); else if (!x.ptrs.delete(s.id)) return;
      gamePtrNews(x);
      return;
    }
    if (m.t === 'game-ink') {       // a piece of the drawing: many, small, no answer, at most 40 a second
      if (!x) return;
      const now = Date.now();
      if (now - (s.gameInkAt || 0) >= 1000) { s.gameInkAt = now; s.gameInkN = 0; }
      if (++s.gameInkN > 40 || x.at.get(s.id) !== s || !m.op || typeof m.op !== 'object' || JSON.stringify(m.op).length > 4000) return;
      if (!x.t.move(s.id, { do: 'ink', op: m.op }).error) gameInk(x);
      return;
    }
    if (!x) return reply(s, m, { error: 'There\'s no such table.' });
    if (slow(s, 'game', 60)) return reply(s, m, { error: 'Slow down a little.' });
    let r = { ok: true };
    if (m.t === 'game-sit' || m.t === 'game-watch') {       // at the table: sitting down (or in line for a place), or only looking on
      const was = x.at.get(s.id);
      if (was && was !== s) was.wire.send({ t: 'game-view', g: x.g, v: null });       // came to the table from another PC: this one takes it
      if (m.t === 'game-sit') walletTake(s.id, m.wallet);
      x.at.set(s.id, s);
      if (m.t === 'game-sit') r = x.t.sit(s.id, nameOf(s.id));
      gameRun(x); x.t.tick(); gameNews(x, true);
      return reply(s, m, r);
    }
    if (m.t === 'game-leave') { if (x.at.get(s.id) === s) gameLeave(x, s.id); return reply(s, m, {}); }
    if (x.at.get(s.id) !== s) return reply(s, m, { error: 'Sit down at the table first.' });
    if (m.t === 'game-stand') { x.t.leave(s.id); x.t.tick(); gameNews(x, true); return reply(s, m, {}); }       // up from the seat (or out of the line), still looking on
    const mv = m.m && typeof m.m === 'object' ? m.m : {};
    r = x.t.move(s.id, { do: String(mv.do || '').slice(0, 12), key: String(mv.key || '').slice(0, 24), amount: +mv.amount || 0, text: String(mv.text || '').slice(0, 80) });
    x.t.tick(); gameNews(x);
    return reply(s, m, r.error ? { error: r.error } : {});
  }
  // ---- the media stream: one share at a time, changed by a vote ----
  // While someone is sharing, nobody else's share is listed unless they won a vote: more than half of the people online
  // when it was asked (the asker counts as a yes) agree within VOTE_MS. Whoever goes offline drops out of the count.
  // If the share that's on stops meanwhile, the asker wins. granted: who won, for a minute, until their share arrives.
  const VOTE_MS = opts.voteMs || 30000;
  let vote = null, granted = null;
  const sharingBesides = (id) => [...lives.keys()].some((x) => x !== id);
  const voteOut = () => ({ id: vote.id, from: vote.from, title: vote.title, voters: [...vote.voters], yes: [...vote.yes], no: [...vote.no], ms: Math.max(0, vote.until - Date.now()) });
  function voteEnd(result) {
    const v = voteOut();
    clearTimeout(vote.timer);
    if (result === 'yes') granted = { id: vote.from, until: Date.now() + 60000 };
    vote = null;
    everyone({ t: 'media-vote', vote: { ...v, ms: 0, result } });
  }
  function recount() {
    if (!vote) return;
    for (const id of [...vote.voters]) if (!online.has(id)) { vote.voters.delete(id); vote.yes.delete(id); vote.no.delete(id); }
    if (!online.has(vote.from)) return voteEnd('cancel');
    const n = vote.voters.size;
    if (!sharingBesides(vote.from) || vote.yes.size * 2 > n) return voteEnd('yes');
    if (vote.no.size * 2 >= n) return voteEnd('no');
    everyone({ t: 'media-vote', vote: voteOut() });
  }
  // key: the member's raw Ed25519 public key, so members can check each other's call signatures (and that it hashes to the id)
  const memberList = () => S.members.all().map((m) => ({ id: m.id, key: Buffer.from(m.key).toString('base64url'), name: m.name, host: m.id === ownerId, online: online.has(m.id), av: m.av || '', mic: online.has(m.id) && mics.has(m.id) ? mics.get(m.id) : null, at: online.has(m.id) ? wheres.get(m.id) || '' : '' }));
  const membersNews = (but) => { const list = memberList(); for (const s of sessions) if (s.id && s !== but) s.wire.send({ t: 'members', list: bent.list(s, list), apart: apartFrom(s) }); };
  const channelList = () => S.channels.all().map((c) => ({ id: c.id, name: c.name }));

  function invite({ by, days = INVITE_DAYS, uses = 25 }) {
    const token = crypto.randomBytes(16), now = Date.now();
    S.oldInvites.run(now);
    S.addInvite.run(token, by, now, now + Math.max(1, Math.min(30, +days || INVITE_DAYS)) * 86400e3, Math.max(1, Math.min(100, +uses || 25)));
    return encodeInvite({ port, pin, token, addrs: opts.addrs ? opts.addrs() : ['127.0.0.1'] });
  }

  function onConnection(sock) {
    if (sessions.size >= LIMITS.connections) { sock.destroy(); return; }
    const s = { id: null, nonce: crypto.randomBytes(24).toString('base64url'), wire: null, acts: { msg: [], other: [], live: [], sig: [], bc: [], react: [], part: [], offer: [], ft: [], bj: [], game: [] }, typed: 0, upload: null, place: placeOf(sock.remoteAddress) };
    sessions.add(s);
    const login = setTimeout(() => { if (!s.id) s.wire.close(); }, 15000);
    s.wire = wire(sock, null, (m) => { try { onMessage(s, m); } catch (e) { reply(s, m, { error: 'Something went wrong on the hub.' }); if (opts.log) opts.log('hub: ' + (e && e.stack || e)); } }, () => {
      clearTimeout(login); sessions.delete(s); s.upload = null;
      if (opts.log) opts.log(`hub: ${s.id || 'someone not signed in'} disconnected`);
      if (s.id && online.has(s.id)) {
        const set = online.get(s.id); set.delete(s);
        if (!set.size) { online.delete(s.id); mics.delete(s.id); wheres.delete(s.id); membersNews(); if (lives.delete(s.id)) everyone({ t: 'lives', list: liveList() }); recount(); }
      }
      if (s.id && surfWatch.get(s.id) === s) { surfWatch.delete(s.id); relayCheck(s.id); relayCheck(ownerId); surfNews(); }
      if (s.id && voice.get(s.id) && voice.get(s.id).s === s) leaveRoom(s.id);
      ftSessionGone(s);
      if (s.id && bjAt.get(s.id) === s) bjLeave(s.id);
      if (s.id) for (const x of games.values()) if (x.at.get(s.id) === s) gameLeave(x, s.id);
    }, LIMITS.line);
    s.wire.send({ t: 'hello', v: VERSION, nonce: s.nonce, name: hubName, still: LIMITS.bcThumb });       // (still: the largest broadcast still it takes; a hub from before says nothing, and takes 14000 characters)
  }
  const reply = (s, m, out) => s.wire.send({ t: out.error ? 'err' : 'ok', re: m && m.re, ...out });
  // Ten of each kind of action every ten seconds for each member (messages and edits; everything else), so one person
  // (or a stuck script) can't flood everyone, and a burst of messages doesn't stop them making an invite.
  function slow(s, kind = 'msg', most = LIMITS.actions) {
    const now = Date.now();
    s.acts[kind] = s.acts[kind].filter((t) => now - t < LIMITS.perSecs * 1000);
    if (s.acts[kind].length >= most) return true;
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
      reply(s, m, { me: id, host: id === ownerId, hub: hubName, addrs: opts.addrs ? opts.addrs() : [], members: bent.list(s, memberList()), apart: apartFrom(s), channels: channelList(), lives: liveList(), voice: voiceList(), room: roomId, bcs: bcList(), surf: surfOut() });       // addrs: so members can still find the hub when its addresses change
      membersNews(s);
      for (const b of bcs.values()) if (b.thumb) s.wire.send({ t: 'bc-thumb', id: b.id, from: b.from, ...b.thumb });       // each broadcast's latest still, for their grid
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
      case 'send': {       // up: the token of a finished upload (file-start, file-part), for a message carrying a picture or GIF
        const ch = +m.ch, text = cleanText(m.text), cid = String(m.cid || '').slice(0, 40);
        if (!S.channel.get(ch)) return reply(s, m, { error: 'No such channel.' });
        const again = cid && S.byCid.get(s.id, cid);       // the same message sent twice (a retry after a dropped connection)
        if (again) return reply(s, m, { msg: row(again) });
        const up = m.up ? s.upload : null;
        if (m.up && (!up || up.token !== m.up || up.got !== up.size)) return reply(s, m, { error: 'That picture didn\'t finish uploading. Try again.' });
        let offer = null;
        if (m.offer) {       // a file that stays on the sender's PC, for others to download from it (docs/plans/files.md)
          const o = m.offer, size = Math.floor(+o.size), piece = Math.floor(+o.piece), name = cleanFileName(o.name);
          if (up) return reply(s, m, { error: 'A message can carry a picture or a file, not both.' });
          if (!OFFER_ID.test(String(o.id || '')) || S.offer.get(String(o.id))) return reply(s, m, { error: 'That file\'s id can\'t be used.' });
          if (!name) return reply(s, m, { error: 'That file needs a name.' });
          if (!(size > 0 && size <= LIMITS.offerMax)) return reply(s, m, { error: 'That file is too big to offer.' });
          if (!ROOT.test(String(o.root || '')) || !(piece >= 1 << 20 && piece <= 1 << 26 && (piece & (piece - 1)) === 0)) return reply(s, m, { error: 'That file\'s check doesn\'t look right.' });
          if (S.offersBy.get(s.id).n >= LIMITS.offers) return reply(s, m, { error: `You can offer up to ${LIMITS.offers} files at once. Stop offering one first.` });
          if (slow(s, 'offer', 20)) return reply(s, m, { error: 'Slow down a little.' });       // (a handful dropped at once is fine; the 50 open at once is the real limit)
          offer = { id: String(o.id), name, size, mime: cleanMime(o.mime), root: String(o.root), piece };
        }
        if (!text && !up && !offer) return reply(s, m, { error: 'Nothing to send.' });
        if (text.length > LIMITS.text) return reply(s, m, { error: `Messages can be up to ${LIMITS.text} characters.` });
        if (!cid) return reply(s, m, { error: 'Missing message id.' });
        if (slow(s)) return reply(s, m, { error: 'Slow down a little.' });
        let data = null, mime = null;
        if (up) {
          data = Buffer.concat(up.parts); mime = sniffImage(data); s.upload = null;
          if (!mime) return reply(s, m, { error: 'Only pictures and GIFs (PNG, JPEG, WebP, GIF) can be sent.' });
        }
        const to = m.reply ? S.msg.get(+m.reply) : null;
        const r = S.addMsg.run(ch, s.id, cid, text, to && to.ch === ch ? to.id : null, Date.now());
        if (data) {
          S.addFile.run(crypto.randomBytes(12).toString('base64url'), r.lastInsertRowid, mime, up.w, up.h, data.length, data, Date.now());
          makeRoom();
        }
        if (offer) { S.addOffer.run(offer.id, r.lastInsertRowid, offer.name, offer.size, offer.mime, offer.root, offer.piece); holders.set(offer.id, s); }
        const msg = row(S.msg.get(r.lastInsertRowid));
        everyone({ t: 'msg', msg });
        return reply(s, m, { msg });
      }
      case 'file-start': {       // about to send a picture or GIF of `size` bytes, w × h, in parts of up to fileChunk
        const size = Math.floor(+m.size), w = Math.floor(+m.w), hgt = Math.floor(+m.h);
        if (!(size > 0 && size <= LIMITS.file)) return reply(s, m, { error: `Pictures and GIFs can be up to ${LIMITS.file / 1024 / 1024} MB.` });
        if (!(w > 0 && w <= 16384 && hgt > 0 && hgt <= 16384)) return reply(s, m, { error: 'That picture\'s size doesn\'t look right.' });
        if (slow(s, 'other')) return reply(s, m, { error: 'Slow down a little.' });
        s.upload = { token: crypto.randomBytes(9).toString('base64url'), size, w, h: hgt, parts: [], got: 0 };       // (one at a time: a new one drops the last)
        return reply(s, m, { up: s.upload.token, chunk: LIMITS.fileChunk });
      }
      case 'file-part': {
        const up = s.upload;
        if (!up || m.up !== up.token || typeof m.data !== 'string') return reply(s, m, { error: 'That upload is over.' });
        if (slow(s, 'part', 60)) return reply(s, m, { error: 'Slow down a little.' });
        const b = Buffer.from(m.data, 'base64');
        if (!b.length || b.length > LIMITS.fileChunk || up.got + b.length > up.size) { s.upload = null; return reply(s, m, { error: 'That upload went wrong.' }); }
        if (!up.got && !sniffImage(b)) { s.upload = null; return reply(s, m, { error: 'Only pictures and GIFs (PNG, JPEG, WebP, GIF) can be sent.' }); }
        up.parts.push(b); up.got += b.length;
        return reply(s, m, { got: up.got });
      }
      case 'file-get': {       // part of a picture: `len` bytes from `at`
        const at = Math.max(0, Math.floor(+m.at) || 0), len = Math.max(1, Math.min(LIMITS.fileChunk, Math.floor(+m.len) || LIMITS.fileChunk));
        const f = S.filePart.get(at + 1, len, String(m.id || ''));
        if (!f) return reply(s, m, { error: 'That picture isn\'t kept any more.' });
        return reply(s, m, { mime: f.mime, size: f.size, data: Buffer.from(f.part || []).toString('base64') });
      }
      case 'react': {       // add (on) or take back an emoji reaction on a message
        const old = S.msg.get(+m.id), e = cleanEmoji(m.e);
        if (!old) return reply(s, m, { error: 'That message is gone.' });
        if (!e) return reply(s, m, { error: 'Reactions are a single emoji.' });
        if (slow(s, 'react', 20)) return reply(s, m, { error: 'Slow down a little.' });
        if (m.on) {
          if (!S.reactKind.get(old.id, e) && S.reactKinds.get(old.id).n >= LIMITS.reactions) return reply(s, m, { error: 'That message has as many kinds of reaction as it can hold.' });
          S.addReact.run(old.id, s.id, e, Date.now());
        } else S.dropReact.run(old.id, s.id, e);
        everyone({ t: 'react', ch: old.ch, id: old.id, reacts: reactsOf(old.id) });
        return reply(s, m, {});
      }
      case 'edit': {
        const old = S.msg.get(+m.id), text = cleanText(m.text);
        if (!old || old.author !== s.id) return reply(s, m, { error: 'You can only edit your own messages.' });
        if ((!text && !S.fileOf.get(old.id)) || text.length > LIMITS.text) return reply(s, m, { error: `Messages can be up to ${LIMITS.text} characters.` });
        if (slow(s)) return reply(s, m, { error: 'Slow down a little.' });
        S.editMsg.run(text, Date.now(), old.id);
        const msg = row(S.msg.get(old.id));
        everyone({ t: 'msg', msg });
        return reply(s, m, { msg });
      }
      case 'delete': {       // deleting really deletes: the row goes, and everyone connected drops it
        const old = S.msg.get(+m.id);
        if (!old || (old.author !== s.id && !isHost)) return reply(s, m, { error: 'You can only delete your own messages.' });
        const o = S.offerOf.get(old.id);
        if (o) offerGone(o.id, 'The file\'s message was deleted.');
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
        membersNews();
        return reply(s, m, {});
      }
      case 'invite': {       // anyone can invite
        if (slow(s, 'other')) return reply(s, m, { error: 'Slow down a little.' });
        return reply(s, m, { code: invite({ by: s.id, days: m.days, uses: m.uses }) });
      }
      case 'live': {       // this member started, changed or stopped sharing (the Hub tab). The code is their PC's watch-together invite.
        if (!m.on) { if (lives.delete(s.id)) everyone({ t: 'lives', list: liveList() }); recount(); return; }
        if (slow(s, 'live')) return;
        const code = String(m.code || '').replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 400);
        if (!code) return;
        const reach = ['lan', 'manual'].includes(m.reach) ? m.reach : 'internet';       // (see "reach")
        if (sharingBesides(s.id)) {       // someone else's is on: only the winner of a vote takes over, and theirs replaces it
          if (!granted || granted.id !== s.id || granted.until < Date.now()) { s.wire.send({ t: 'live-no' }); return; }
          for (const id of [...lives.keys()]) if (id !== s.id) lives.delete(id);
        }
        if (granted && granted.id === s.id) granted = null;
        const was = lives.get(s.id);
        lives.set(s.id, { from: s.id, code, title: cleanText(m.title).replace(/\s+/g, ' ').slice(0, 120),
          watching: (Array.isArray(m.watching) ? m.watching : []).slice(0, 8).map(cleanName).filter(Boolean), since: was && was.code === code ? was.since : Date.now(), reach, place: s.place });
        everyone({ t: 'lives', list: liveList() });
        return;
      }
      case 'live-fail': {       // this member couldn't connect to a share that's on (see "reach")
        if (slow(s, 'live')) return;
        const code = String(m.code || '').replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 400), l = [...lives.values()].find((x) => x.code === code);
        if (l && l.from !== s.id && l.reach !== 'internet') liveOff(l.from, 'unreached', [s.id]);
        return;
      }
      case 'media-ask': {       // put something on while someone else's is on: ask everyone online
        if (slow(s, 'other')) return reply(s, m, { error: 'Slow down a little.' });
        if (!sharingBesides(s.id)) return reply(s, m, { free: true });       // nothing else on: just share
        if (vote) return reply(s, m, { error: vote.from === s.id ? 'Your vote is still going.' : 'Someone else is asking already. Try again once that vote is over.' });
        vote = { id: crypto.randomBytes(9).toString('base64url'), from: s.id, title: cleanText(m.title).replace(/\s+/g, ' ').slice(0, 120),
          voters: new Set(online.keys()), yes: new Set([s.id]), no: new Set(), until: Date.now() + VOTE_MS };
        vote.timer = setTimeout(() => { if (vote) voteEnd('time'); }, VOTE_MS);
        reply(s, m, { id: vote.id });
        recount();
        return;
      }
      case 'media-vote': {
        if (!vote || m.id !== vote.id || !vote.voters.has(s.id) || s.id === vote.from) return reply(s, m, { error: 'That vote is over.' });
        vote.yes.delete(s.id); vote.no.delete(s.id);
        (m.yes ? vote.yes : vote.no).add(s.id);
        reply(s, m, {});
        recount();
        return;
      }
      case 'media-cancel': {       // the asker changed their mind
        if (!vote || m.id !== vote.id || s.id !== vote.from) return reply(s, m, { error: 'That vote is over.' });
        voteEnd('cancel');
        return reply(s, m, {});
      }
      case 'avatar': {       // set (or with no data, clear) this member's picture
        const data = m.data ? cleanAvatar(m.data) : '';
        if (data === null) return reply(s, m, { error: 'That picture can\'t be used. Pictures are small WebP, JPEG or PNG images.' });
        if (slow(s, 'other')) return reply(s, m, { error: 'Slow down a little.' });
        S.setAvatar.run(data || null, avatarId(data) || null, s.id);
        membersNews();
        return reply(s, m, { av: avatarId(data) });
      }
      case 'avatar-get': {
        const r = S.avatar.get(String(m.member || ''));
        return reply(s, m, { data: r && r.avatar ? r.avatar : '' });
      }
      case 'mic': {       // whether this member's PC has a microphone: people without one are shown, and their messages go over the video
        const on = !!m.on;
        if (mics.get(s.id) === on) return;
        mics.set(s.id, on);
        membersNews();
        return;
      }
      case 'where': {       // which screen this member's Drift shows: the hub bar jumps there when someone clicks them
        const at = ['scenes', 'media', 'surf', 'broadcast', 'blackjack', 'roulette', 'poker', 'sketch', 'pachinko', 'crane', 'slots'].includes(m.at) ? m.at : '';
        if ((wheres.get(s.id) || '') === at) return;
        wheres.set(s.id, at);
        membersNews();
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
        if (voice.has(who.id)) leaveRoom(who.id);
        newRoom();       // so nothing they were sent in this room can be replayed into it later
        surfWatch.delete(who.id);
        if (surf) surf.room = crypto.randomBytes(16).toString('base64url');       // (the same for the Surf stream's signed messages)
        surfNews();
        membersNews();
        if (lives.delete(who.id)) everyone({ t: 'lives', list: liveList() });
        recount();
        return reply(s, m, {});
      }
      case 'offer-here': return offerHere(s, m);
      case 'offer-drop': return offerDrop(s, m, isHost);
      case 'ft-want': return ftWant(s, m);
      case 'ft-signal': return ftSignal(s, m);
      case 'ft-end': return ftEnd(s, m);
      case 'voice-state': return voiceState(s, m);
      case 'voice-signal': {       // a setup message for one other person in the call, passed on as it is: the signature inside is theirs, not the hub's
        const v = voice.get(s.id), to = String(m.to || '');
        if (!v || v.s !== s || !v.listen || !voice.has(to) || !voice.get(to).listen || to === s.id || !m.d || typeof m.d !== 'object') return;
        if (slow(s, 'sig', LIMITS.signals)) return;
        for (const [dest, d] of bent.signal(s.id, to, m.d)) { const x = voice.get(dest); if (x) x.s.wire.send({ t: 'voice-signal', from: s.id, d }); }
        return;
      }
      case 'bc-start': return bcStart(s, m);
      case 'bc-stop': {       // the broadcaster stops, or the host stops someone's (decision §11.6)
        const b = bcs.get(String(m.id || ''));
        if (!b || (b.from !== s.id && !isHost)) return reply(s, m, { error: 'No such broadcast.' });
        endBc(b.id, b.from === s.id ? '' : 'The host stopped this broadcast.');
        return reply(s, m, {});
      }
      case 'bc-watch': return bcWatch(s, m);
      case 'bc-thumb': return bcThumb(s, m);
      case 'surf-watch': return surfWatchMsg(s, m);
      case 'bj-sit': case 'bj-watch': case 'bj-stand': case 'bj-leave': case 'bj-bet': case 'bj-insure': case 'bj-act': case 'bj-ptr': return bjMessage(s, m);
      case 'game-sit': case 'game-watch': case 'game-stand': case 'game-leave': case 'game-move': case 'game-ptr': case 'game-ink': return gameMessage(s, m);
      case 'surf-signal': {       // a watcher's setup message for the host, passed on as it is (signed by them)
        const d = m.d;
        if (surfWatch.get(s.id) !== s || !surf || String(m.to || '') !== ownerId || !svc || !d || typeof d !== 'object') return;
        if (slow(s, 'sig', LIMITS.signals)) return;
        for (const [, dd] of bent.signal(s.id, ownerId, d)) svc.out({ t: 'surf-signal', from: s.id, d: dd });
        return;
      }
      case 'bc-signal': {       // a setup message between a broadcaster and one of their viewers, passed on as it is (it's signed by them)
        const b = bcs.get(String(m.bc || '')), to = String(m.to || '');
        if (!b || !inRoom(s) || !voice.has(to) || to === s.id || !m.d || typeof m.d !== 'object') return;
        if (!(b.from === s.id && b.viewers.has(to)) && !(b.from === to && b.viewers.has(s.id))) return;       // only between the two ends of one broadcast
        if (slow(s, 'sig', LIMITS.signals)) return;
        for (const [dest, d] of bent.signal(s.id, to, m.d)) { const x = voice.get(dest); if (x) x.s.wire.send({ t: 'bc-signal', from: s.id, bc: b.id, d }); }
        return;
      }
      default: return reply(s, m, { error: 'The hub doesn\'t know how to do that.' });
    }
  }

  // ---- files sent straight between members' PCs (docs/plans/files.md) ----
  // A file is offered in a message (its name, size and check); the file itself stays on the sender's PC. Someone who wants it
  // asks here (ft-want, with their signed request), the hub finds the session whose PC has it and passes their setup messages
  // between the two (ft-signal), and the bytes go over a data channel between them: through the hub's relay for files up to
  // relayMax, so nobody learns anyone's address, or directly for bigger ones (the receiver agrees to that first). The hub never
  // sees the file and can't change it unnoticed: the request and both SDPs are signed (chat.js), and the receiving Drift checks
  // every piece against the check in the offer, which came over the verified connection too.
  const holders = new Map();       // offer id -> the session whose PC has the file (the one that offered it, or said so again after reconnecting)
  const xfers = new Map();         // transfer id -> { x, offer, from (who has it), fs (their session), to, ts, relay, since }. Memory only.
  const XFER = /^[A-Za-z0-9_-]{16,64}$/;
  const live = (x) => !!x && sessions.has(x) && !!x.wire;
  const fileRelay = (id, x, relay) => ({ relay: relay && turn ? { port: turn.port(), ...turn.credentials(id, TURN_SECS, 'f.' + x) } : null, hosts: relayHosts(), stun: turn ? turn.port() : 0 });
  function offerHere(s, m) {       // after reconnecting: the files this PC still has, of those it offered here. Answers which are still offered.
    const have = [];
    for (const id of (Array.isArray(m.ids) ? m.ids : []).slice(0, 500)) {
      const o = S.offer.get(String(id));
      if (!o || o.gone || o.author !== s.id) continue;
      holders.set(o.id, s); have.push(o.id);
    }
    return reply(s, m, { have });
  }
  function offerGone(id, why) {       // no longer offered: transfers of it end
    holders.delete(id);
    for (const t of [...xfers.values()]) if (t.offer === id) ftClose(t, why);
  }
  function offerDrop(s, m, isHost) {
    const o = S.offer.get(String(m.id || ''));
    if (!o) return reply(s, m, { error: 'That file isn\'t offered.' });
    if (o.author !== s.id && !isHost) return reply(s, m, { error: 'Only whoever offered it (or the host) can stop offering it.' });
    if (!o.gone) {
      S.dropOffer.run(o.id); offerGone(o.id, 'They stopped offering it.');
      const msg = row(S.msg.get(o.msg));
      if (msg) everyone({ t: 'msg', msg, again: true });
    }
    return reply(s, m, {});
  }
  function ftWant(s, m) {
    const o = S.offer.get(String(m.offer || '')), x = String(m.x || ''), relay = m.relay !== false, d = m.d;
    if (!o || o.gone) return reply(s, m, { error: 'That file isn\'t offered any more.', gone: true });
    if (!XFER.test(x) || xfers.has(x)) return reply(s, m, { error: 'That transfer id can\'t be used.' });
    if (!d || typeof d !== 'object') return reply(s, m, { error: 'That request wasn\'t signed.' });
    const h = holders.get(o.id);
    if (h === s) return reply(s, m, { error: 'That file is on this PC already.' });
    if (!live(h)) return reply(s, m, { error: `${nameOf(o.author)}'s PC with that file isn't online right now.`, offline: true });
    if (relay && o.size > LIMITS.relayMax) return reply(s, m, { error: `Files over ${LIMITS.relayMax / 1024 / 1024} MB need a direct connection.`, direct: true });
    if (relay && !turn) return reply(s, m, { error: 'The hub\'s relay isn\'t running, so files can only go directly.', direct: true });
    const all = [...xfers.values()];
    if (all.filter((t) => t.fs === h).length >= LIMITS.ftSend) return reply(s, m, { error: `${nameOf(o.author)} is already sending ${LIMITS.ftSend} files. Try again in a little while.`, busy: true });
    if (all.filter((t) => t.ts === s).length >= LIMITS.ftRecv) return reply(s, m, { error: `You can download ${LIMITS.ftRecv} files at once. Wait for one to finish.`, busy: true });
    if (relay && all.filter((t) => t.relay).length >= LIMITS.ftRelayed) return reply(s, m, { error: `The hub's relay is carrying ${LIMITS.ftRelayed} files already. Try again in a little while.`, busy: true });
    if (slow(s, 'ft')) return reply(s, m, { error: 'Slow down a little.' });
    const t = { x, offer: o.id, from: o.author, fs: h, to: s.id, ts: s, relay, since: Date.now() };
    xfers.set(x, t);
    h.wire.send({ t: 'ft-want', x, offer: o.id, from: s.id, relayed: relay, d, ...fileRelay(o.author, x, relay) });
    return reply(s, m, { x, ...fileRelay(s.id, x, relay) });
  }
  function ftSignal(s, m) {       // an offer, answer or candidate between the two ends of one transfer, passed on as it is (signed by them)
    const t = xfers.get(String(m.x || ''));
    if (!t || (s !== t.fs && s !== t.ts) || !m.d || typeof m.d !== 'object') return;
    if (slow(s, 'sig', LIMITS.signals)) return;
    const to = s === t.fs ? t.ts : t.fs, toId = s === t.fs ? t.to : t.from;
    for (const [dest, d] of bent.signal(s.id, toId, m.d)) if (dest === toId && live(to)) to.wire.send({ t: 'ft-signal', x: t.x, from: s.id, d });
  }
  function ftEnd(s, m) {       // either end: done, cancelled, or it went wrong
    const t = xfers.get(String(m.x || ''));
    if (t && (s === t.fs || s === t.ts)) ftClose(t, String(m.why || '').slice(0, 200), s);
    return reply(s, m, {});
  }
  function ftClose(t, why, by, soft = false) {
    xfers.delete(t.x);
    if (turn) turn.dropTag('f.' + t.x);
    for (const x of [t.fs, t.ts]) if (x !== by && live(x)) x.wire.send({ t: 'ft-end', x: t.x, why, ...(soft ? { soft: true } : {}) });
  }
  // One end went offline. A relayed transfer can't go on. A direct one may still be going between the two PCs, which don't need
  // the hub once connected: the other end is told with `soft`, and carries on if its connection was already verified.
  function ftSessionGone(s) {
    for (const [id, h] of [...holders]) if (h === s) holders.delete(id);
    for (const t of [...xfers.values()]) if (t.fs === s || t.ts === s) ftClose(t, s === t.fs ? 'The sender went offline.' : 'They went offline.', s, !t.relay);
  }

  // ---- the voice room: one per hub, up to 16 people and 8 talking ----
  // Someone is in the room while their Drift says so (voice-state on): online here, with this as their active hub.
  // listen: connected to voice at all ("Don't listen" turns it off, and they leave the mesh); talk: their microphone is
  // open. The room id is signed into every setup message. It is new whenever the room empties and whenever someone is
  // removed, so an old signed offer can't be replayed into a later room.
  const voice = new Map();       // member id -> { s (their session), listen, talk, mic, since }. Kept in memory only.
  let roomId = '';
  let turn = null, relayHost = '';
  const voiceList = () => [...voice].map(([id, v]) => ({ id, listen: v.listen, talk: v.talk, mic: v.mic, since: v.since }));
  const roster = () => everyone({ t: 'voice', list: voiceList(), room: roomId });
  function newRoom() { roomId = voice.size ? crypto.randomBytes(16).toString('base64url') : ''; bent.reset(); if (voice.size) roster(); }
  function voiceState(s, m) {
    const was = voice.get(s.id);
    if (!m.on) { if (was && was.s === s) leaveRoom(s.id); return reply(s, m, {}); }
    const listen = m.listen !== false, talk = listen && !!m.talk;
    if (!was && voice.size >= LIMITS.voice) return reply(s, m, { error: `The voice room is full: up to ${LIMITS.voice} people can be in it at once. You can still chat.`, full: true });
    if (talk && !(was && was.s === s && was.talk) && [...voice.values()].filter((v) => v.talk).length >= LIMITS.talkers) return reply(s, m, { error: `${LIMITS.talkers} people are already talking. Wait for one of them to stop.`, talkers: true });
    if (!was || was.s !== s) {
      if (slow(s, 'other')) return reply(s, m, { error: 'Slow down a little.' });
      if (was) { was.s.wire.send({ t: 'voice-ended', why: 'You\'re in this hub\'s voice room on another PC now.' }); bcLeave(s.id, 'They moved to another PC.'); }       // the same person on two PCs: the newer one wins
      if (!voice.size) roomId = crypto.randomBytes(16).toString('base64url');
      if (turn) turn.drop(s.id);       // anything left from before
    }
    voice.set(s.id, { s, listen, talk, mic: !!m.mic, since: was && was.s === s ? was.since : Date.now() });
    if (was && was.s === s && was.listen && !listen) relayCheck(s.id);       // stopped listening: out of the mesh now (unless broadcasting or watching)
    reply(s, m, { room: roomId, list: voiceList(), ...relayFor(s.id) });
    roster();
  }
  function leaveRoom(id) {
    voice.delete(id);
    bcLeave(id, '');
    if (turn) turn.drop(id);
    if (!voice.size) { roomId = ''; bent.reset(); }
    roster();
  }
  const inRoom = (s) => !!(voice.get(s.id) && voice.get(s.id).s === s);
  // Who the relay is for: in the room and listening, or broadcasting, or watching a broadcast (with listening off).
  // (a tag is a file transfer's, 'f.' and its id: only its two ends, and only while it goes through the relay)
  const relayed = (id, tag = '') => {
    if (tag) { const t = tag.startsWith('f.') && xfers.get(tag.slice(2)); return !!t && t.relay && (t.from === id || t.to === id); }
    return (!!voice.get(id) && (voice.get(id).listen || [...bcs.values()].some((b) => b.from === id || b.viewers.has(id)))) || surfRelayed(id);
  };
  const relayCheck = (id) => { if (turn && !relayed(id)) turn.drop(id); };
  const relayHosts = () => [...new Set([...(opts.addrs ? opts.addrs() : []), relayHost])].filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));       // where members can reach the relay (IPv4 only)
  function relayFor(id) {
    return { relay: turn && relayed(id) ? { port: turn.port(), ...turn.credentials(id, TURN_SECS) } : null, hosts: relayHosts() };
  }

  // ---- broadcasts: one per person, four per hub, up to 7 viewers each (§4, §11.3) ----
  // The broadcaster's Drift makes the id (fresh for every broadcast, and signed into every setup message for it). The
  // title is only what the broadcaster called it; the hub can't vouch for it and chat.js says so.
  const bcs = new Map();       // broadcast id -> { id, from, title, kind ('screen' | 'window'), audio, since, viewers: Set of member ids }. Memory only.
  const bcList = () => [...bcs.values()].map((b) => ({ id: b.id, from: b.from, title: b.title, kind: b.kind, audio: b.audio, since: b.since, viewers: [...b.viewers] }));
  const bcNews = () => everyone({ t: 'bc', list: bcList() });
  const BC_ID = /^[A-Za-z0-9_-]{16,64}$/;
  const cleanTitle = (t) => cleanText(t).replace(/\s+/g, ' ').trim().slice(0, LIMITS.bcTitle);
  function bcStart(s, m) {       // start one, or (the same id again) rename it or turn its sound on or off
    if (!inRoom(s)) return reply(s, m, { error: 'Join this hub\'s voice room to broadcast.' });
    const id = String(m.id || ''), was = bcs.get(id);
    if (!BC_ID.test(id) || (was && was.from !== s.id)) return reply(s, m, { error: 'That broadcast id can\'t be used.' });
    if (slow(s, 'bc')) return reply(s, m, { error: 'Slow down a little.' });
    const kind = m.kind === 'window' ? 'window' : 'screen', title = cleanTitle(m.title) || (kind === 'window' ? 'A window' : 'A screen');
    if (!was) {
      if ([...bcs.values()].some((b) => b.from === s.id)) return reply(s, m, { error: 'You\'re already broadcasting. Stop that one first.', mine: true });
      if (bcs.size >= LIMITS.broadcasts) return reply(s, m, { error: `${LIMITS.broadcasts} people are already broadcasting in this hub. Wait for one of them to stop.`, full: true });
    }
    bcs.set(id, { id, from: s.id, title, kind,       // (Switch source may go from a screen to a window)
      audio: !!m.audio, since: was ? was.since : Date.now(), viewers: was ? was.viewers : new Set(), thumb: was ? was.thumb : null, thumbAt: was ? was.thumbAt : 0 });
    bcNews();
    return reply(s, m, { id, ...relayFor(s.id) });
  }
  // A still of a broadcast, for everyone's Broadcast grid (§5). The broadcaster signs it, so the hub can pass it on but can't
  // put a picture of its own on anyone's tile. One every few seconds at most; the latest is kept for whoever comes online,
  // and goes when the broadcast ends.
  const STILL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;
  function bcThumb(s, m) {
    const b = bcs.get(String(m.id || '')), img = String(m.img || ''), sig = String(m.sig || '');
    if (!b || b.from !== s.id || !inRoom(s) || img.length > LIMITS.bcThumb || !STILL.test(img) || !/^[A-Za-z0-9_-]{40,200}$/.test(sig)) return;
    if (Date.now() - b.thumbAt < 4000) return;
    b.thumbAt = Date.now(); b.thumb = { img, sig };
    everyone({ t: 'bc-thumb', id: b.id, from: b.from, img, sig });
  }
  function bcWatch(s, m) {
    const b = bcs.get(String(m.id || ''));
    if (!m.on) {
      if (b && b.viewers.delete(s.id)) { relayCheck(s.id); bcNews(); }
      return reply(s, m, {});
    }
    if (!inRoom(s)) return reply(s, m, { error: 'Join this hub\'s voice room to watch.' });
    if (!b) return reply(s, m, { error: 'That broadcast has ended.', ended: true });
    if (b.from === s.id) return reply(s, m, { error: 'That\'s your own broadcast.' });
    if (!b.viewers.has(s.id)) {
      if (b.viewers.size >= LIMITS.viewers) return reply(s, m, { error: `Full: ${LIMITS.viewers} people are already watching.`, full: true });
      if (slow(s, 'bc')) return reply(s, m, { error: 'Slow down a little.' });
      b.viewers.add(s.id);
      bcNews();
    }
    return reply(s, m, { id: b.id, ...relayFor(s.id) });
  }
  function endBc(id, why) {
    const b = bcs.get(id);
    if (!b) return;
    bcs.delete(id);
    const owner = voice.get(b.from);
    if (owner && why) owner.s.wire.send({ t: 'bc-ended', id, why });
    for (const v of [b.from, ...b.viewers]) relayCheck(v);
    bcNews();
  }
  // Someone left the room (or the hub): their broadcast ends and they stop watching anyone's.
  function bcLeave(id, why) {
    let news = false;
    const left = [];       // their viewers, who may now have no reason to use the relay
    for (const b of [...bcs.values()]) {
      if (b.from === id) {
        bcs.delete(b.id); news = true; left.push(...b.viewers);
        const o = voice.get(id);
        if (why && o) o.s.wire.send({ t: 'bc-ended', id: b.id, why });
      } else if (b.viewers.delete(id)) news = true;
    }
    for (const v of left) relayCheck(v);
    if (news) bcNews();
  }
  // ---- the Surf stream (docs/plans/streams.md §7) ----
  // surf: { title, room (signed into its setup messages: new each time it starts, and whenever someone is removed), since }
  // while the host's Drift says it runs. surfWatch: member id -> the session watching (a member's Surf tab is open on it).
  // Watching while it isn't running wakes it: the host's Drift starts the browser (decision §11.3).
  let surf = null, svc = null;
  const surfWatch = new Map();
  const surfOut = () => ({ on: !!surf, title: surf ? surf.title : '', room: surf ? surf.room : '', since: surf ? surf.since : 0, watchers: [...surfWatch.keys()] });
  // (the host's Drift also gets each watcher's key and name, to check their signed messages while it isn't connected itself)
  const surfPeople = () => Object.fromEntries([...surfWatch.keys()].map((id) => { const r = S.member.get(id); return [id, r ? { key: Buffer.from(r.key).toString('base64url'), name: r.name } : null]; }).filter(([, v]) => v));
  const surfNews = () => { everyone({ t: 'surf', s: surfOut() }); if (svc) svc.out({ t: 'surf', s: surfOut(), people: surfPeople() }); };
  // (a watcher may use the relay while waiting for the stream to start: the credentials they were given at surf-watch must still work then)
  const surfRelayed = (id) => (id === ownerId && !!surf && surfWatch.size > 0 && !!svc) || (surfWatch.has(id) && online.has(id));
  function surfWatchMsg(s, m) {
    if (!m.on) {
      if (surfWatch.get(s.id) === s) { surfWatch.delete(s.id); relayCheck(s.id); relayCheck(ownerId); surfNews(); }
      return reply(s, m, {});
    }
    if (s.id === ownerId) return reply(s, m, { error: 'Your own Surf stream is on this PC.' });
    if (surfWatch.get(s.id) !== s) {
      if (!surfWatch.has(s.id) && surfWatch.size >= LIMITS.surfWatchers) return reply(s, m, { error: `${LIMITS.surfWatchers} people are already watching the Surf stream. Try again when someone stops.`, full: true });
      if (slow(s, 'other')) return reply(s, m, { error: 'Slow down a little.' });
      surfWatch.set(s.id, s);       // (the same person on another PC: this one now)
      surfNews();
    }
    if (!surf && svc) svc.out({ t: 'surf-wake' });
    return reply(s, m, { ...surfOut(), ...relayFor(s.id) });
  }
  // What the host's Drift sends its own hub's service session: surf-stream { on, title } and surf-signal { to, d }.
  function onService(m) {
    const answer = (out) => svc && svc.out({ t: out.error ? 'err' : 'ok', re: m && m.re, ...out });
    if (m.t === 'surf-stream') {
      if (!m.on) { surf = null; surfNews(); return answer({}); }
      const title = cleanText(m.title).replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!surf) surf = { title, room: crypto.randomBytes(16).toString('base64url'), since: Date.now() };
      else surf.title = title;
      surfNews();
      return answer({ ...surfOut(), ...relayFor(ownerId) });
    }
    if (m.t === 'surf-relay') return answer(relayFor(ownerId));       // fresh relay credentials (watchers came, so the host is relayed now)
    if (m.t === 'surf-signal') {
      const to = String(m.to || ''), x = surfWatch.get(to);
      if (!surf || !x || !m.d || typeof m.d !== 'object') return;
      for (const [dest, d] of bent.signal(ownerId, to, m.d)) { const y = surfWatch.get(dest); if (y) y.wire.send({ t: 'surf-signal', from: ownerId, d }); }
    }
  }
  // The voice relay listens on UDP, on the same port number as the hub when it can (one number to forward on the
  // router). Its relay addresses only exist inside this process, so any of this PC's IPv4 addresses will do to name
  // them; a real one, because Chromium won't relay through 127.0.0.1.
  async function startRelay() {
    relayHost = localAddrs().find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || '127.0.0.1';
    for (const p of [port, 0]) {
      // Allocations are only bookkeeping (no socket each). A full room of 16 with 8 talking, plus four broadcasts to 7
      // viewers each, is a few hundred; one member broadcasting to 7 while talking to 7 others is about 28.
      // (files: a relayed file may be relayMax, and a little more goes with it: the data channel's own headers and resends)
      const files = { rate: LIMITS.ftRate, rateAll: LIMITS.ftRateAll, max: LIMITS.relayMax * 1.15 + (8 << 20), day: LIMITS.ftDay, ...(opts.files || {}) };
      const t = createTurn({ secret: crypto.randomBytes(32), relayHost, allowed: relayed, files, maxAllocations: 512, perMember: 48, log: (x) => opts.log && opts.log('hub relay: ' + x) });
      try { await t.listen(p, opts.relayBind || '0.0.0.0'); turn = t; return; } catch { try { t.close(); } catch { /* never opened */ } }
    }
    if (opts.log) opts.log('hub: the voice relay could not start');
  }

  // ---- a hub that misbehaves on purpose (tests only): DRIFT_HUB_TAMPER=fingerprint|unsigned|replay|swapkey ----
  // It interferes with what one member sends another (DRIFT_HUB_TAMPER_PAIR="From>To", by name), the way a hostile hub
  // could, so the tests can check that the members' Drift refuses it and that the rest of the call still connects.
  const bent = (() => {
    const how = opts.tamper !== undefined ? opts.tamper : process.env.DRIFT_HUB_TAMPER || '';
    const [fromName, toName] = String(opts.tamperPair !== undefined ? opts.tamperPair : process.env.DRIFT_HUB_TAMPER_PAIR || '').split('>');
    const named = (id, n) => { const r = n && S.member.get(id); return !!r && r.name === n; };
    let sent = null, held = '';       // replay: the last thing From sent anyone else; who is waiting for one to be swapped in
    return {
      list(s, list) {       // swapkey: To is told a different key for From (From's id stays the same)
        if (how !== 'swapkey' || !named(s.id, toName)) return list;
        return list.map((x) => (named(x.id, fromName) ? { ...x, key: crypto.randomBytes(32).toString('base64url') } : x));
      },
      signal(from, to, d) {
        if (!how || !d.sdp || !named(from, fromName)) return [[to, d]];
        if (!named(to, toName)) {
          if (how !== 'replay') return [[to, d]];
          sent = d;
          if (held) { const w = held; held = ''; return [[to, d], [w, d]]; }       // To gets what From just sent someone else
          return [[to, d]];
        }
        if (how === 'fingerprint') {       // swap in another certificate's fingerprint, the way a hub listening in would
          const fake = crypto.randomBytes(32).toString('hex').toUpperCase().match(/../g).join(':');
          return [[to, { ...d, sdp: { ...d.sdp, sdp: String(d.sdp.sdp).replace(/^(a=fingerprint:\S+ )\S+/gm, `$1${fake}`) } }]];
        }
        if (how === 'unsigned') { const { sig, ...rest } = d; return [[to, rest]]; }
        if (how === 'replay') { if (sent) return [[to, sent]]; held = to; return []; }
        return [[to, d]];
      },
      reset() { sent = null; held = ''; },
    };
  })();

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
        server.listen(p, h, () => { server.removeListener('error', next); server.on('error', () => {}); port = server.address().port; startRelay().finally(() => resolve(port)); });
      };
      next();
    }),
    port: () => port,
    voicePort: () => (turn ? turn.port() : 0),
    relayStats: () => (turn ? turn.stats() : null),
    name: () => hubName,
    invite: (o = {}) => invite({ by: ownerId, ...o }),
    // The host's Drift, in this same process, for the Surf stream: what the hub sends it goes to onMsg; send() is what it says.
    service: (onMsg) => {
      svc = { out: (m) => { try { onMsg(typeof m === 'string' ? JSON.parse(m) : m); } catch { /* its problem */ } } };
      setImmediate(() => svc && svc.out({ t: 'surf', s: surfOut(), people: surfPeople() }));
      return { send: (m) => { if (svc && m && typeof m === 'object') onService(m); }, close: () => { svc = null; surf = null; surfNews(); } };
    },
    clearMessages,
    stats: () => ({ online: online.size, sessions: sessions.size, members: S.members.all().length }),
    stop: () => new Promise((resolve) => {
      if (opts.log) opts.log('hub: stopping');
      clearInterval(bjTimer); bjTimer = null; clearTimeout(bjPtrTimer);
      for (const x of games.values()) { clearInterval(x.timer); x.timer = null; clearTimeout(x.ptrTimer); }
      for (const s of sessions) { s.wire.send({ t: 'bye' }); s.wire.close(); }
      if (turn) { try { turn.close(); } catch { /* closed */ } turn = null; }
      if (!server) { db.close(); resolve(); return; }
      server.close(() => { db.close(); resolve(); });
      server = null;
    }),
  };
};
Object.assign(module.exports, { encodeInvite, decodeInvite, pinOfPeer, memberId, rawKey, loginText, cleanText, cleanAvatar, avatarId, sniffImage, cleanEmoji, placeOf, cleanFileName, VERSION, LIMITS });
