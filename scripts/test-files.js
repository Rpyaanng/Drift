// Files sent straight between PCs (docs/plans/files.md), in plain Node (no Electron, no WebRTC):
//   1. files.js: an offer's pieces and root, receiving piece by piece, a bad piece, carrying on after a restart, a file that changed.
//   2. hub.js + chat.js: offering in a message, asking for it, the signed setup messages, the certificate check, the limits,
//      stopping an offer, the sender going offline and coming back.
//   node scripts/test-files.js            (DRIFT_BIG=1 also sends a 5 GB sparse file through files.js: the over-4 GB path)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const createFiles = require('../files');
const createChat = require('../chat');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-files-test-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
async function until(pred, what, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (pred()) return true; await wait(40); }
  ok(false, 'timed out: ' + what); return false;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fileSha = (p) => new Promise((res) => { const h = crypto.createHash('sha256'); fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))); });

// Send pieces `list` from the sender's files.js to the receiver's, as the transfer window would (blocks of `block` bytes).
async function move(snd, rcv, id, list, piece, size, { block = 256 * 1024, spoil = -1 } = {}) {
  const out = {};
  for (const i of list) {
    const len = Math.min(piece, size - i * piece);
    let r = null;
    for (let at = 0; at < len; at += block) {
      const b = Buffer.from(await snd.read(id, i * piece + at, Math.min(block, len - at)));
      if (i === spoil && at === 0) b[0] ^= 0xff;
      r = await rcv.recvWrite(id, i, at, new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    }
    out[i] = r.piece;
  }
  return out;
}

async function disk() {
  console.log('-- files.js');
  const src = path.join(root, 'holiday video.mkv'), size = 5.5 * 1024 * 1024, piece = 1024 * 1024;
  fs.writeFileSync(src, crypto.randomBytes(size));
  const snd = createFiles({ dir: path.join(root, 'snd'), downloads: () => path.join(root, 'dl') });
  let rcv = createFiles({ dir: path.join(root, 'rcv'), downloads: () => path.join(root, 'dl') });
  const seen = [];
  const o = await snd.prepare(src, (d, n) => seen.push([d, n]), piece);
  ok(o.name === 'holiday video.mkv' && o.size === size && o.mime === 'video/x-matroska' && /^[A-Za-z0-9_-]{43}$/.test(o.root), 'an offer has its name, size, kind and root');
  ok(seen.length && seen[seen.length - 1][0] === size, 'preparing says how far it got');
  const h = snd.head(o.id);
  ok(h.hashes.length === 6 && createFiles.rootOf(h.hashes.map((x) => Buffer.from(x, 'base64url'))) === o.root, 'six pieces, and their hashes make the root');
  ok(snd.has(o.id), 'the file is there, as offered');

  const st = await rcv.recvStart({ offer: o.id, hub: 'H', from: 'B', name: '../../evil\\name.mkv', size, root: o.root, piece });
  ok(st.have === 0 && st.total === 6, 'a download starts with nothing');
  ok(!/[\\/]/.test(st.name) && st.name.endsWith('.mkv'), `a name with folders in it is cleaned (${st.name})`);
  ok(fs.statSync(path.join(root, 'dl', st.name + '.drift-part')).size === size, 'the .part file is made at full size');
  const bad = [...h.hashes]; bad[2] = h.hashes[3];
  ok(rcv.recvHashes(o.id, bad).error, 'a list of pieces that doesn\'t make the root is refused');
  ok(rcv.recvHashes(o.id, h.hashes.slice(1)).error, 'so is one with a piece missing');
  ok(JSON.stringify(rcv.recvHashes(o.id, h.hashes).want) === '[0,1,2,3,4,5]', 'the right list: every piece to fetch');
  const r1 = await move(snd, rcv, o.id, [0, 1, 2, 3], piece, size, { spoil: 3 });
  ok(r1[0] === 'ok' && r1[1] === 'ok' && r1[2] === 'ok', 'pieces are checked as they arrive');
  ok(r1[3] === 'bad', 'a spoiled piece is caught');
  ok((await rcv.recvWrite(o.id, 4, 4096, new Uint8Array(10))).piece === 'bad', 'bytes out of order are refused');
  ok((await rcv.recvFinish(o.id)).error, 'it can\'t finish with pieces missing');

  await rcv.recvPause(o.id);
  rcv = createFiles({ dir: path.join(root, 'rcv'), downloads: () => path.join(root, 'dl') });       // (as if Drift restarted)
  const back = rcv.downloads().find((x) => x.offer === o.id);
  ok(back && back.partial && back.got === 3 * piece, 'after a restart the panel knows it stopped part of the way');
  const st2 = await rcv.recvStart({ offer: o.id, hub: 'H', from: 'B', name: 'x.mkv', size, root: o.root, piece });
  ok(st2.have === 3, 'carrying on: the three good pieces are kept');
  const want = rcv.recvHashes(o.id, h.hashes).want;
  ok(JSON.stringify(want) === '[3,4,5]', 'only the missing pieces are fetched, the bad one again');
  const r2 = await move(snd, rcv, o.id, want, piece, size, { block: 300 * 1000 });
  ok(Object.values(r2).every((x) => x === 'ok'), 'the rest arrives (in blocks of another size)');
  const fin = await rcv.recvFinish(o.id);
  ok(fin.path && await fileSha(fin.path) === await fileSha(src), 'the finished file is the same as the one offered');
  ok(!fs.existsSync(fin.path + '.drift-part'), 'the .part file is gone');
  ok((await rcv.recvStart({ offer: o.id, hub: 'H', from: 'B', name: 'x.mkv', size, root: o.root, piece })).error, 'a file already downloaded isn\'t started again');
  const st3 = await rcv.recvStart({ offer: 'another-offer-id-0001', hub: 'H', from: 'B', name: path.basename(fin.path), size, root: 'R'.repeat(43), piece });       // (another file, of the same name)
  ok(st3.name === path.basename(fin.path).replace(/\.mkv$/, ' (2).mkv'), `the same name again gets a number (${st3.name})`);
  await rcv.recvDrop('another-offer-id-0001');
  ok(!fs.existsSync(path.join(root, 'dl', st3.name + '.drift-part')), 'dropping a download removes its .part file');

  // the same file offered again (another message, another id): it carries on from what came of the first offer
  const src2 = path.join(root, 'again.zip'), size2 = 3 * piece + 777;
  fs.writeFileSync(src2, crypto.randomBytes(size2));
  const a1 = await snd.prepare(src2, () => {}, piece), a2 = await snd.prepare(src2, () => {}, piece);
  ok(a1.id !== a2.id && a1.root === a2.root, 'offering the same file twice: two ids, one root');
  await rcv.recvStart({ offer: a1.id, hub: 'H', from: 'B', name: a1.name, size: size2, root: a1.root, piece });
  rcv.recvHashes(a1.id, snd.head(a1.id).hashes);
  await move(snd, rcv, a1.id, [0, 1], piece, size2);
  await rcv.recvPause(a1.id);
  rcv.setPaused(a1.id, true, 'It isn\'t offered any more.');
  rcv = createFiles({ dir: path.join(root, 'rcv'), downloads: () => path.join(root, 'dl') });       // (a restart)
  const p1 = rcv.download(a1.id);
  ok(p1 && p1.paused && p1.why === 'It isn\'t offered any more.' && p1.root === a1.root, 'a download stopped on purpose stays stopped across a restart, and says why');
  const s2 = await rcv.recvStart({ offer: a2.id, hub: 'H2', from: 'B', name: a2.name, size: size2, root: a2.root, piece });
  ok(s2.have === 2, 'the second offer carries on from the first one\'s two pieces');
  ok(!rcv.download(a1.id) && rcv.download(a2.id) && !rcv.download(a2.id).paused, 'the download now goes by the new offer, and may carry on by itself again');
  await move(snd, rcv, a2.id, rcv.recvHashes(a2.id, snd.head(a2.id).hashes).want, piece, size2);
  const f2 = await rcv.recvFinish(a2.id);
  ok(f2.path && await fileSha(f2.path) === await fileSha(src2), 'and it finishes whole');
  const a3 = await snd.prepare(src2, () => {}, piece);
  const s3 = await rcv.recvStart({ offer: a3.id, hub: 'H', from: 'B', name: a3.name, size: size2, root: a3.root, piece });
  ok(s3.error && s3.path === f2.path, 'offered a third time: it says it\'s already here');

  fs.appendFileSync(src, 'more');
  ok(!snd.has(o.id), 'a file that changed is no longer the one offered');
  let threw = ''; try { await snd.read(o.id, 0, 10); } catch (e) { threw = e.message; }
  ok(/changed/.test(threw), 'and reading it says so');
  ok(createFiles.RISKY.test('setup.exe') && createFiles.RISKY.test('a.LNK') && !createFiles.RISKY.test('song.mp3'), 'programs and shortcuts count as risky to open');

  if (process.env.DRIFT_BIG) {       // over 4 GB: a sparse file, so this doesn't write 5 GB of real data first
    const big = path.join(root, 'big.bin'), bsize = 5 * 1024 ** 3 + 12345, bp = 64 * 1024 * 1024;
    const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, bsize); fs.writeSync(fd, Buffer.from('end'), 0, 3, bsize - 3); fs.closeSync(fd);
    const t0 = Date.now(), bo = await snd.prepare(big, () => {}, bp);
    console.log(`  (hashed 5 GB in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    const bs = await rcv.recvStart({ offer: bo.id, hub: 'H', from: 'B', name: 'big.bin', size: bsize, root: bo.root, piece: bp });
    ok(!bs.error, 'a 5 GB download starts: the .part file is made at full size' + (bs.error ? ` (${bs.error})` : ''));
    const bw = rcv.recvHashes(bo.id, snd.head(bo.id).hashes).want;
    const last = await move(snd, rcv, bo.id, bw, bp, bsize, { block: 4 * 1024 * 1024 });
    ok(Object.values(last).every((x) => x === 'ok'), `all ${bw.length} pieces past 4 GB check out`);
    const bf = await rcv.recvFinish(bo.id);
    ok(bf.path && fs.statSync(bf.path).size === bsize, 'and the file is whole');
  }
}

async function protocol() {
  console.log('-- hub.js + chat.js');
  const person = (name, hooks = {}) => {
    const events = [];
    const chat = createChat({ dir: path.join(root, 'chat-' + name), addrs: () => ['127.0.0.1'], event: (hub, m) => events.push({ hub, ...m }), changed: () => {}, log: (t) => console.log(`  [${name}] ${t}`), ...hooks });
    chat.setName(name);
    return { name, chat, events, seen: (pred) => events.find(pred), hub: (id) => chat.info().hubs.find((h) => h.id === id) };
  };
  const gone = new Set();
  const ana = person('Ana'), ben = person('Ben', { hasOffer: (id) => !gone.has(id) }), cat = person('Cat');
  for (const p of [ana, ben, cat]) await p.chat.start();
  const H = (await ana.chat.host({ name: 'Files hub', internet: false })).hosting.id;
  await until(() => ana.hub(H) && ana.hub(H).status === 'connected', 'the host reaches its own hub');
  const code = (await ana.chat.invite(H)).code;
  ben.chat.join(code); cat.chat.join(code);
  await until(() => [ben, cat].every((p) => p.hub(H) && p.hub(H).status === 'connected') && cat.hub(H).members.length === 3 && ben.hub(H).members.length === 3, 'friends join');
  const ch = ben.hub(H).channels[0].id, B = ben.chat.myId(), C = cat.chat.myId();
  const meta = (size = 3e6) => ({ id: crypto.randomBytes(18).toString('base64url'), name: 'notes.pdf', size, mime: 'application/pdf', root: crypto.randomBytes(32).toString('base64url'), piece: 16 * 1024 * 1024 });

  // ---- offering ----
  const m1 = meta(), sent = await ben.chat.offer(H, ch, m1, 'here you go');
  ok(sent.msg && sent.msg.offer && sent.msg.offer.id === m1.id && sent.msg.offer.name === 'notes.pdf' && sent.msg.text === 'here you go', 'a message carries an offered file');
  ok(ben.chat.info().offers.includes(m1.id), 'the sender keeps it as offered from this PC');
  ok((await cat.chat.history(H, ch)).msgs.some((m) => m.offer && m.offer.id === m1.id && !m.offer.gone), 'others see it in the history');
  ok((await ben.chat.offer(H, ch, { ...meta(), root: 'short' }, '')).error, 'an offer with a broken check is refused');
  ok((await ben.chat.offer(H, ch, meta(2 ** 41), '')).error, 'an offer over 1 TB is refused');
  ok((await ben.chat.offer(H, ch, { ...meta(), name: '' }, '')).error, 'an offer with no name is refused');
  const weird = await ben.chat.offer(H, ch, { ...meta(), name: 'CON.txt' }, '');
  ok(weird.msg && weird.msg.offer.name === '_CON.txt', 'a name Windows can\'t keep is changed');
  ok((await ben.chat.offer(H, ch, { ...meta(), id: m1.id }, '')).error, 'two offers can\'t share an id');

  // ---- downloading: the signed setup ----
  const got = await cat.chat.ftGet(H, m1.id, B);
  ok(got.x && got.policy === 'relay' && got.iceServers.length === 1 && /^turn:/.test(got.iceServers[0].urls) && /:f\./.test(got.iceServers[0].username), 'Cat asks for it: through the relay, with credentials for this transfer only');
  await until(() => ben.seen((e) => e.t === 'ft-want' && e.x === got.x), 'Ben\'s PC hears who wants it');
  const want = ben.seen((e) => e.t === 'ft-want' && e.x === got.x);
  ok(want.from === C && want.offer === m1.id && want.policy === 'relay' && /:f\./.test(want.iceServers[0].username), 'with their name and relay credentials for Ben too');
  const fpB = Array.from({ length: 32 }, () => 'AB').join(':'), fpC = Array.from({ length: 32 }, () => 'CD').join(':');
  const sdp = (fp) => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 ${fp}\r\n`;
  ben.chat.ftSignal(got.x, { sdp: { type: 'offer', sdp: sdp(fpB) } });
  await until(() => cat.seen((e) => e.t === 'ft-sdp' && e.x === got.x), 'Cat gets Ben\'s signed offer');
  cat.chat.ftSignal(got.x, { sdp: { type: 'answer', sdp: sdp(fpC) } });
  await until(() => ben.seen((e) => e.t === 'ft-sdp' && e.x === got.x), 'Ben gets Cat\'s signed answer');
  ben.chat.ftSignal(got.x, { c: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0' } });
  await until(() => cat.seen((e) => e.t === 'ft-candidate' && e.x === got.x), 'candidates pass between them');
  ok(cat.chat.ftCert(got.x, 'sha-256', fpB).ok && ben.chat.ftCert(got.x, 'sha-256', fpC).ok, 'each end\'s certificate is the one it signed');
  cat.chat.ftEnd(got.x, '');
  await until(() => ben.seen((e) => e.t === 'ft-end' && e.x === got.x), 'when Cat finishes, Ben\'s PC is told');

  const g2 = await cat.chat.ftGet(H, m1.id, B);
  await until(() => ben.seen((e) => e.t === 'ft-want' && e.x === g2.x), 'Cat asks again');
  ben.chat.ftSignal(g2.x, { sdp: { type: 'offer', sdp: sdp(fpB) } });
  await until(() => cat.seen((e) => e.t === 'ft-sdp' && e.x === g2.x), 'the offer arrives');
  ok(!cat.chat.ftCert(g2.x, 'sha-256', fpC).ok, 'a certificate that isn\'t the signed one is caught');
  await until(() => ben.seen((e) => e.t === 'ft-end' && e.x === g2.x), 'and the transfer stops for both');

  ben.chat._fromHub(H, { t: 'ft-want', x: crypto.randomBytes(18).toString('base64url'), offer: m1.id, from: C, relayed: true, d: { want: true, nonce: crypto.randomBytes(16).toString('base64url') } });
  ok(ben.seen((e) => e.t === 'ft-refused'), 'an unsigned request (a hub making one up) is refused');
  const g3 = await cat.chat.ftGet(H, m1.id, B);
  await until(() => ben.seen((e) => e.t === 'ft-want' && e.x === g3.x), 'a fresh request');
  const n = ben.events.filter((e) => e.t === 'ft-refused').length;
  ben.chat.ftSignal(g3.x, { sdp: { type: 'offer', sdp: sdp(fpB) } });
  await until(() => cat.seen((e) => e.t === 'ft-sdp' && e.x === g3.x), 'its offer arrives');
  cat.chat._fromHub(H, { t: 'ft-signal', x: g3.x, from: B, d: { sdp: { type: 'offer', sdp: sdp(fpC) }, nonce: 'x'.repeat(22), sig: 'y'.repeat(86) } });
  ok(cat.seen((e) => e.t === 'ft-refused' && e.x === g3.x), 'an offer with a swapped fingerprint and a bad signature is refused');
  ok(ben.events.filter((e) => e.t === 'ft-refused').length === n, '(Ben refused nothing of his own)');
  await until(() => ben.seen((e) => e.t === 'ft-end' && e.x === g3.x), 'and that transfer stops');

  // ---- relayed or direct ----
  const bigM = meta(600 * 1024 * 1024);
  await ben.chat.offer(H, ch, bigM, '');
  const viaRelay = await cat.chat.ftGet(H, bigM.id, B);
  ok(viaRelay.error && viaRelay.direct, 'a file over 500 MB won\'t go through the relay');
  const direct = await cat.chat.ftGet(H, bigM.id, B, { direct: true });
  ok(direct.x && direct.policy === 'all' && direct.iceServers.every((s) => /^stun:/.test(s.urls)), 'directly, it connects with no relay at all');
  await until(() => ben.seen((e) => e.t === 'ft-want' && e.x === direct.x), 'Ben hears of it');
  ok(ben.seen((e) => e.t === 'ft-want' && e.x === direct.x).policy === 'all', 'and connects directly too (the mode was signed by Cat)');
  cat.chat.ftEnd(direct.x, '');

  // ---- limits ----
  const extra = [meta(), meta(), meta()];
  for (const x of extra) await ben.chat.offer(H, ch, x, '');
  const three = [];
  for (const x of extra) three.push(await cat.chat.ftGet(H, x.id, B));
  ok(three.every((r) => r.x), 'Cat downloads three files at once' + three.map((r) => (r.error ? ` (${r.error})` : '')).join(''));
  const fourth = await cat.chat.ftGet(H, m1.id, B);
  ok(fourth.error && fourth.busy, 'a fourth waits');
  for (const r of three) cat.chat.ftEnd(r.x, '');
  await wait(200);
  ok((await ben.chat.ftGet(H, m1.id, B)).error, 'Ben can\'t download from his own PC');

  // ---- stopping an offer, deleting its message ----
  ok((await cat.chat.offerDrop(H, m1.id)).error, 'Cat can\'t stop Ben offering his file');
  const g4 = await cat.chat.ftGet(H, m1.id, B);
  await until(() => ben.seen((e) => e.t === 'ft-want' && e.x === g4.x), 'a download is under way');
  ok(!(await ben.chat.offerDrop(H, m1.id)).error, 'Ben stops offering it');
  await until(() => cat.seen((e) => e.t === 'ft-end' && e.x === g4.x), 'the download stops');
  await until(() => cat.seen((e) => e.t === 'msg' && e.again && e.msg.offer && e.msg.offer.id === m1.id && e.msg.offer.gone), 'everyone sees it isn\'t offered any more');
  ok((await cat.chat.ftGet(H, m1.id, B)).gone, 'and it can\'t be asked for');
  ok(!ben.chat.info().offers.includes(m1.id), 'Ben\'s PC forgets it');

  // ---- the sender offline, and back ----
  const m5 = meta();
  await ben.chat.offer(H, ch, m5, '');
  const g5 = await cat.chat.ftGet(H, m5.id, B);
  if (g5.error) console.log('  (g5: ' + g5.error + ')');
  await until(() => ben.seen((e) => e.t === 'ft-want' && e.x === g5.x), 'a download is under way');
  ben.chat.disconnect(H);
  await until(() => cat.seen((e) => e.t === 'ft-end' && e.x === g5.x), 'Ben goes offline: Cat\'s download stops');
  const off = await cat.chat.ftGet(H, m5.id, B);
  ok(off.error && off.offline, 'while he\'s away, his files can\'t be had');
  gone.add(extra[0].id);       // (that file went from Ben's PC meanwhile)
  ben.chat.reconnect(H);
  await until(() => ben.hub(H).status === 'connected', 'Ben comes back');
  await wait(400);
  const g6 = await cat.chat.ftGet(H, m5.id, B);
  ok(g6.x, 'his PC says it still has the file, so it can be had again');
  if (g6.x) cat.chat.ftEnd(g6.x, '');
  await until(() => cat.seen((e) => e.t === 'msg' && e.again && e.msg.offer && e.msg.offer.id === extra[0].id && e.msg.offer.gone), 'a file that went from his PC is marked as no longer offered');

  await wait(10200);       // (the hub takes 10 requests in 10 s from each person: wait that out)
  const m7 = meta(), s7 = await ben.chat.offer(H, ch, m7, '');
  const g7 = await cat.chat.ftGet(H, m7.id, B);
  if (g7.error) console.log('  (g7: ' + g7.error + ')');
  await until(() => ben.seen((e) => e.t === 'ft-want' && e.x === g7.x), 'a download is under way');
  ok(!(await ben.chat.remove(H, s7.msg.id)).error, 'Ben deletes the message with the file');
  await until(() => cat.seen((e) => e.t === 'ft-end' && e.x === g7.x), 'the download stops');

  // ---- the hub dropping mid-transfer: only what goes through it stops ----
  await wait(10200);
  const setUp = async (g) => {       // as the two transfer windows would: offer, answer, both certificates checked
    await until(() => ben.seen((e) => e.t === 'ft-want' && e.x === g.x), 'Ben hears of it');
    ben.chat.ftSignal(g.x, { sdp: { type: 'offer', sdp: sdp(fpB) } });
    await until(() => cat.seen((e) => e.t === 'ft-sdp' && e.x === g.x), 'the offer reaches Cat');
    cat.chat.ftSignal(g.x, { sdp: { type: 'answer', sdp: sdp(fpC) } });
    await until(() => ben.seen((e) => e.t === 'ft-sdp' && e.x === g.x), 'the answer reaches Ben');
    return cat.chat.ftCert(g.x, 'sha-256', fpB).ok && ben.chat.ftCert(g.x, 'sha-256', fpC).ok;
  };
  const mD = meta(600 * 1024 * 1024), mU = meta(700 * 1024 * 1024), mR = meta();
  for (const x of [mD, mU, mR]) await ben.chat.offer(H, ch, x, '');
  const gD = await cat.chat.ftGet(H, mD.id, B, { direct: true }), gR = await cat.chat.ftGet(H, mR.id, B), gU = await cat.chat.ftGet(H, mU.id, B, { direct: true });
  ok((await setUp(gD)) && (await setUp(gR)), 'a direct and a relayed transfer are connected and verified (and one direct still connecting)');
  ben.chat.disconnect(H);
  await until(() => cat.seen((e) => e.t === 'ft-end' && e.x === gR.x), 'Ben\'s connection to the hub drops: the relayed one stops');
  await until(() => cat.seen((e) => e.t === 'ft-end' && e.x === gU.x), '...and so does the direct one that wasn\'t connected yet');
  await wait(1500);
  ok(!cat.seen((e) => e.t === 'ft-end' && e.x === gD.x) && !ben.seen((e) => e.t === 'ft-end' && e.x === gD.x), 'the verified direct one carries on, at both ends');
  ok(!!ben.chat.ftPeer(gD.x) && !!cat.chat.ftPeer(gD.x) && !ben.chat.ftPeer(gR.x), '(each end still has it; the relayed one is gone)');
  ok(!ben.chat.ftEnd(gD.x, '').error && !ben.chat.ftPeer(gD.x), 'it can still be ended with no hub at all');
  cat.chat.ftEnd(gD.x, '');
  ben.chat.reconnect(H);
  await until(() => ben.hub(H).status === 'connected', 'Ben comes back');
  for (const p of [ana, ben, cat]) await p.chat.stop();
}

(async () => {
  try { await disk(); await protocol(); } catch (e) { ok(false, 'threw: ' + (e && e.stack || e)); }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* left for the OS */ }
  console.log(failed ? `\n${failed} failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
