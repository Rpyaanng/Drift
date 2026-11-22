// Voice's checks, in plain Node (no Electron, no WebRTC): the signing that keeps calls end-to-end encrypted when the
// hub is hostile, the member keys and safety numbers, and the hub's relay. Real hubs and real chat.js copies, with the
// hub misbehaving on purpose (DRIFT_HUB_TAMPER) and stand-in SDPs where the voice window would send real ones.
//   node scripts/test-voice.js                      (and under Electron's Node: ELECTRON_RUN_AS_NODE=1 electron scripts/test-voice.js)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const createChat = require('../chat');
const { memberId, rawKey } = require('../hub');
const { checkMembers, safetyNumber, fingerprints, signSdp, verifySdp } = createChat;
const { parse, build, xaddr, xaddrBytes } = require('../turn')._test;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-voice-test-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
async function until(pred, what, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (pred()) return true; await wait(50); }
  ok(false, 'timed out: ' + what); return false;
}
// An SDP as Chromium would write it, cut down to what matters here: a fingerprint and an Opus line.
const hex = () => crypto.randomBytes(32).toString('hex').toUpperCase().match(/../g).join(':');
const sdpWith = (fp) => `v=0\r\no=- ${Date.now()} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${fp}\r\na=setup:actpass\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n`;

// ---- 1. the helpers on their own ----
async function helpers() {
  const a = crypto.generateKeyPairSync('ed25519'), b = crypto.generateKeyPairSync('ed25519'), c = crypto.generateKeyPairSync('ed25519');
  const A = rawKey(a.publicKey), B = rawKey(b.publicKey), C = rawKey(c.publicKey);
  const pin = crypto.randomBytes(32).toString('base64url'), call = crypto.randomBytes(16).toString('base64url'), nonce = crypto.randomBytes(16).toString('base64url');
  const sdp = sdpWith(hex());
  const f = { pin, call, from: memberId(A), to: memberId(B), nonce, sdp };
  const sig = signSdp(a.privateKey, f);
  ok(verifySdp(A, f, sig), 'an honest SDP passes');
  ok(verifySdp(A, { ...f, sdp: sdp.replace(/a=fmtp:111 [^\r]*/, 'a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1') }, sig), 'a DTX edit to the Opus line still passes (it isn\'t signed)');
  ok(!verifySdp(A, { ...f, sdp: sdp.replace(/(a=fingerprint:sha-256 )\S+/, `$1${hex()}`) }, sig), 'a swapped fingerprint is refused');
  ok(!verifySdp(A, { ...f, sdp: sdp + `a=fingerprint:sha-256 ${hex()}\r\n` }, sig), 'an extra fingerprint is refused');
  ok(!verifySdp(A, { ...f, sdp: sdp.replace(/a=fingerprint[^\r]*\r\n/, '') }, sig), 'an SDP with its fingerprint taken out is refused');
  ok(!verifySdp(A, f, undefined) && !verifySdp(A, f, ''), 'a missing signature is refused');
  ok(!verifySdp(C, { ...f, from: memberId(C) }, sig), 'the wrong sender (someone else\'s key) is refused');
  ok(!verifySdp(B, f, sig), 'a key that isn\'t the sender\'s is refused');
  ok(!verifySdp(A, { ...f, to: memberId(C) }, sig), 'the wrong recipient (one person\'s SDP handed to another) is refused');
  ok(!verifySdp(A, { ...f, call: crypto.randomBytes(16).toString('base64url') }, sig), 'a replay into another call is refused');
  ok(!verifySdp(A, { ...f, nonce: crypto.randomBytes(16).toString('base64url') }, sig), 'a replay with another nonce is refused');
  ok(!verifySdp(A, { ...f, pin: crypto.randomBytes(32).toString('base64url') }, sig), 'an SDP signed for another hub is refused');
  ok(!verifySdp(A, f, sig.slice(0, -4) + 'AAAA'), 'a damaged signature is refused');
  ok(!signSdp(a.privateKey, { ...f, call: 'bad\nline' }), 'nothing is signed with a field that could break the signed text apart');
  ok(fingerprints('a=fingerprint:SHA-256 AB:CD\r\na=fingerprint:sha-1 01:02\r\n').join('|') === 'a=fingerprint:sha-1 01:02|a=fingerprint:sha-256 ab:cd', 'fingerprint lines are lowercased and sorted');

  const list = [{ id: memberId(A), key: A.toString('base64url'), name: 'Ana' }, { id: memberId(B), key: C.toString('base64url'), name: 'Ben' }, { id: memberId(C), key: 'short', name: 'Cat' }, { id: 'made-up', name: 'Dev' }];
  const { good, bad } = checkMembers(list);
  ok(good.length === 1 && good[0].name === 'Ana', 'a member list entry whose key hashes to its id is kept');
  ok(bad.map((x) => x.name).join() === 'Ben,Cat,Dev', 'entries whose key doesn\'t hash to their id (or have none) are dropped');

  const s1 = await safetyNumber(A, B), s2 = await safetyNumber(B, A), s3 = await safetyNumber(A, C);
  ok(/^\d{4} \d{4} \d{4}$/.test(s1), `a safety number is 12 digits (${s1})`);
  ok(s1 === s2, 'both people get the same safety number');
  ok(s1 !== s3, 'a different key gives a different safety number');
}

// ---- 2. calls through a real hub, honest and hostile ----
function person(name, dir = name) {
  const events = [];
  const chat = createChat({ dir: path.join(root, dir), addrs: () => ['127.0.0.1'], event: (hub, m) => events.push({ hub, ...m }), changed: () => {}, log: (t) => { if (process.env.VERBOSE) console.log(`  [${name}] ${t}`); } });
  chat.setName(name);
  return { name, chat, events, id: () => chat.myId(), seen: (pred) => events.some(pred), hub: (id) => chat.info().hubs.find((h) => h.id === id) };
}
const offerTo = (p, to) => { const sdp = sdpWith(hex()); p.chat.voiceSignal(to.id(), { sdp: { type: 'offer', sdp } }); return sdp; };
const answerTo = (p, to) => { const sdp = sdpWith(hex()); p.chat.voiceSignal(to.id(), { sdp: { type: 'answer', sdp } }); return sdp; };
const sdpFrom = (p, from, type) => p.events.find((e) => e.t === 'voice-sdp' && e.from === from.id() && e.sdp.type === type);
const refusedFrom = (p, from) => p.events.some((e) => e.t === 'voice-refused' && e.from === from.id());

async function calls() {
  const ana = person('Ana'), ben = person('Ben'), cat = person('Cat'), dev = person('Dev');
  for (const p of [ana, ben, cat, dev]) await p.chat.start();
  delete process.env.DRIFT_HUB_TAMPER;
  const H = (await ana.chat.host({ name: 'Voice hub', internet: false })).hosting.id;
  await until(() => ana.hub(H) && ana.hub(H).status === 'connected', 'the host reaches its hub');
  const code = (await ana.chat.invite(H)).code;
  for (const p of [ben, cat, dev]) p.chat.join(code);
  await until(() => [ben, cat, dev].every((p) => p.hub(H) && p.hub(H).status === 'connected'), 'friends join');
  await until(() => ben.hub(H).members.length === 4, 'everyone is in Ben\'s member list');
  ok(ben.hub(H).members.every((m) => !('key' in m)), 'the panel\'s member list doesn\'t carry keys (they stay in chat.js)');

  // ---- an honest call between Ben and Cat (Dev joins later) ----
  const j1 = await ben.chat.voiceJoin(H);
  ok(!j1.error && j1.peers.length === 0, 'Ben starts the call');
  ok(j1.iceServers.length === 1 && /^turn:\d+\.\d+\.\d+\.\d+:\d+\?transport=udp$/.test(j1.iceServers[0].urls) && !/127\.0\.0\.1/.test(j1.iceServers[0].urls), `the hub hands out its relay at a real address (${j1.iceServers[0] && j1.iceServers[0].urls})`);
  ok(/^\d+:/.test(j1.iceServers[0].username) && j1.iceServers[0].username.endsWith(':' + ben.id()), 'with short-lived TURN REST credentials for Ben');
  const j2 = await cat.chat.voiceJoin(H);
  ok(j2.peers.length === 1 && j2.peers[0] === ben.id(), 'Cat joins and is told Ben is there');
  await until(() => ana.hub(H).voice.length === 2, 'everyone in the hub sees two people in the call');
  const o1 = offerTo(cat, ben);
  await until(() => sdpFrom(ben, cat, 'offer'), 'Ben gets Cat\'s offer');
  ok(sdpFrom(ben, cat, 'offer').sdp.sdp === o1, 'exactly the SDP Cat signed reaches Ben\'s voice window');
  const a1 = answerTo(ben, cat);
  await until(() => sdpFrom(cat, ben, 'answer'), 'Cat gets Ben\'s answer');
  ok(sdpFrom(cat, ben, 'answer').sdp.sdp === a1, '...exactly as Ben signed it');
  const fp = (s) => /a=fingerprint:(\S+) (\S+)/.exec(s);
  ok(ben.chat.voiceCert(cat.id(), fp(o1)[1], fp(o1)[2]).ok, 'the certificate Cat really used matches her signed one: verified');
  ok(ben.chat.info().call.verdict[cat.id()] === 'verified', 'and Ben\'s Drift says so');
  ok(!cat.chat.voiceCert(ben.id(), 'sha-256', hex()).ok, 'a certificate that doesn\'t match the signed fingerprint is caught');
  ok(cat.chat.info().call.verdict[ben.id()] === 'mismatch', '...and marked');
  const n0 = cat.events.length;
  answerTo(ben, cat);       // a second answer with no offer to answer: Ben's Drift has no nonce for it, so it isn't sent
  await wait(400);
  ok(!cat.events.slice(n0).some((e) => e.t === 'voice-sdp'), 'an answer to no offer goes nowhere');

  // ---- the relay: credentials work while in the call, and stop when you leave ----
  const turnAt = /turn:([\d.]+):(\d+)/.exec(j1.iceServers[0].urls);
  const t1 = await turnClient(turnAt[1], +turnAt[2], j1.iceServers[0]);
  ok(!!(await t1.allocate().catch((e) => ({ error: e.message }))).address, 'Ben can use the relay while he\'s in the call');
  const wrong = await turnClient(turnAt[1], +turnAt[2], { ...j1.iceServers[0], credential: 'not-the-password' });
  ok(/Unauthorized/.test(await wrong.allocate().then(() => 'ACCEPTED', (e) => e.message)), 'a wrong TURN password is refused');
  const forged = await turnClient(turnAt[1], +turnAt[2], { username: `${Math.floor(Date.now() / 1000) + 600}:${dev.id()}`, credential: j1.iceServers[0].credential });
  ok(/Unauthorized/.test(await forged.allocate().then(() => 'ACCEPTED', (e) => e.message)), 'Ben\'s password doesn\'t work for another name');
  ok(ana.chat.relayStats().open >= 1, 'the relay has Ben\'s allocation');
  await ben.chat.voiceLeave();
  await until(() => ana.chat.relayStats().open === 0, 'leaving the call ends Ben\'s allocations at once');
  const t2 = await turnClient(turnAt[1], +turnAt[2], j1.iceServers[0]);
  ok(/Forbidden/.test(await t2.allocate().then(() => 'ACCEPTED', (e) => e.message)), 'after leaving, Ben\'s credentials no longer work');
  for (const t of [t1, t2, wrong, forged]) t.close();
  await cat.chat.voiceLeave();
  await until(() => ana.hub(H).voice.length === 0, 'the call is empty');

  // ---- the call is full at 8 ----
  {
    const extra = [];
    for (let i = 0; i < 5; i++) { const p = person('Extra' + i); await p.chat.start(); p.chat.join(code); extra.push(p); }
    await until(() => extra.every((p) => p.hub(H) && p.hub(H).status === 'connected'), 'five more join the hub');
    const all = [ana, ben, cat, ...extra];
    for (const p of all) ok(!(await p.chat.voiceJoin(H)).error, `${p.name} joins the call`);
    ok(/full/.test((await dev.chat.voiceJoin(H)).error || ''), 'the ninth person is told the call is full');
    for (const p of all) await p.chat.voiceLeave();
    for (const p of extra) await p.chat.stop();
  }

  // ---- a hostile hub: for each kind of interference, Cat's setup messages to Ben are tampered with ----
  for (const how of ['fingerprint', 'unsigned', 'replay', 'swapkey']) {
    process.env.DRIFT_HUB_TAMPER = how; process.env.DRIFT_HUB_TAMPER_PAIR = 'Cat>Ben';
    await ana.chat.unhost();
    await ana.chat.host({ name: 'Voice hub', internet: false });
    await until(() => [ana, ben, cat, dev].every((p) => p.hub(H) && p.hub(H).status === 'connected'), `everyone reconnects (${how})`, 20000);
    for (const p of [ana, ben, cat, dev]) p.events.length = 0;
    await ben.chat.voiceJoin(H); await dev.chat.voiceJoin(H); await cat.chat.voiceJoin(H);
    await until(() => ana.hub(H).voice.length === 3, 'three people are in the call');
    if (how === 'swapkey') {
      await until(() => ben.hub(H).suspect.some((s) => s.id === cat.id()), 'Ben\'s Drift sets aside the key the hub made up for Cat');
      ok(!ben.hub(H).members.some((m) => m.id === cat.id()), 'and drops her entry from his member list');
      ok(dev.hub(H).members.some((m) => m.id === cat.id()), 'Dev, told the truth, still has her');
    }
    // Cat (the newcomer) offers to both; Dev answers her; then Ben and Dev, already in the call, connect as they would have
    offerTo(cat, dev); offerTo(cat, ben);
    await until(() => sdpFrom(dev, cat, 'offer'), `Dev gets Cat's offer (${how})`);
    answerTo(dev, cat);
    await until(() => sdpFrom(cat, dev, 'answer'), `Cat gets Dev's answer (${how})`);
    await until(() => refusedFrom(ben, cat), `Ben refuses what the hub passed him as Cat's (${how})`);
    ok(!sdpFrom(ben, cat, 'offer'), `nothing from Cat reaches Ben's voice window (${how})`);
    const r = ben.events.find((e) => e.t === 'voice-refused' && e.from === cat.id());
    ok(r && r.name === 'Cat', `Ben's Drift knows who to name in the warning: "${r && r.name}" (${r && r.why})`);
    await until(() => cat.seen((e) => e.t === 'voice-told' && e.from === ben.id()), `Cat is told Ben couldn't verify her (${how})`);
    ok(ben.chat.info().call.refused[cat.id()], 'Ben won\'t connect to Cat for the rest of the call');
    offerTo(cat, ben); await wait(400);
    ok(!sdpFrom(ben, cat, 'offer'), 'not even if a good one comes along afterwards');
    offerTo(dev, ben);
    await until(() => sdpFrom(ben, dev, 'offer'), `Ben and Dev still connect (${how})`);
    for (const p of [ben, cat, dev]) await p.chat.voiceLeave();
  }

  // ---- replays the hub could try by hand: an old SDP sent again, or one from an earlier call ----
  process.env.DRIFT_HUB_TAMPER = '';
  await ana.chat.unhost(); await ana.chat.host({ name: 'Voice hub', internet: false });
  await until(() => [ana, ben, cat].every((p) => p.hub(H) && p.hub(H).status === 'connected'), 'everyone reconnects (honest again)', 20000);
  ok(ben.hub(H).members.some((m) => m.id === cat.id()) && !ben.hub(H).suspect.length, 'with an honest hub, Cat\'s key checks out again');
  {
    // A message really signed by Cat (her key, from her folder: the worst a hub could hold is one she sent), which the
    // hub then sends Ben again, or keeps for a later call. _fromHub hands Ben's Drift a line as if the hub had sent it.
    const catKey = crypto.createPrivateKey(Buffer.from(JSON.parse(fs.readFileSync(path.join(root, 'Cat', 'identity.json'), 'utf8')).key, 'base64').toString());
    const signed = (callId, n) => { const sdp = sdpWith(hex()); return { t: 'voice-signal', from: cat.id(), d: { sdp: { type: 'offer', sdp }, nonce: n, sig: signSdp(catKey, { pin: H, call: callId, from: cat.id(), to: ben.id(), nonce: n, sdp }) } }; };
    for (const p of [ben, cat]) p.events.length = 0;
    await ben.chat.voiceJoin(H); await cat.chat.voiceJoin(H);
    await until(() => ben.chat.info().call.peers.includes(cat.id()), 'Ben hears Cat is in the call');
    const call1 = ben.chat.info().call.id, first = signed(call1, crypto.randomBytes(16).toString('base64url'));
    ben.chat._fromHub(H, first);
    ok(!!sdpFrom(ben, cat, 'offer'), 'an offer signed by Cat for this call is taken');
    ben.events.length = 0;
    ben.chat._fromHub(H, first);
    ok(refusedFrom(ben, cat), 'the same offer sent again is refused (its nonce was used)');
    await ben.chat.voiceLeave(); await cat.chat.voiceLeave();
    await until(() => ana.hub(H).voice.length === 0, 'the call ends');
    await ben.chat.voiceJoin(H); await cat.chat.voiceJoin(H);
    await until(() => ben.chat.info().call.peers.includes(cat.id()), 'Ben hears Cat is in the new call');
    ok(ben.chat.info().call.id !== call1, 'a new call has a new id');
    ben.events.length = 0;
    ben.chat._fromHub(H, first);
    ok(refusedFrom(ben, cat), 'an offer from an earlier call is refused (another call id)');
    await ben.chat.voiceLeave(); await cat.chat.voiceLeave();
  }

  // ---- trust on first use: a name we know, under a different id ----
  const ben2 = person('Ben', 'Ben-again');       // someone else (or the hub) calling themselves Ben, with a new key
  await ben2.chat.start(); ben2.chat.join((await ana.chat.invite(H)).code);
  await until(() => cat.hub(H).lookalikes.some((x) => x.id === ben2.id()), 'Cat is warned: a "Ben" she didn\'t meet before');
  ok(cat.hub(H).lookalikes.find((x) => x.id === ben2.id()).was === ben.id(), '...naming the Ben she knew');
  ok(!cat.hub(H).lookalikes.some((x) => x.id === ben.id()), 'the Ben she met first isn\'t the one flagged');
  const n1 = (await cat.chat.safety(H, ben2.id())).code, n2 = (await ben2.chat.safety(H, cat.id())).code;
  ok(n1 && n1 === n2, `Cat and the new Ben see the same safety number (${n1})`);
  ok(n1 !== (await cat.chat.safety(H, ben.id())).code, 'and a different one from the first Ben\'s');
  ok(!cat.chat.setVerified(H, ben2.id(), true).error, 'Cat marks him verified after comparing');
  ok(!cat.hub(H).lookalikes.length && cat.hub(H).members.find((m) => m.id === ben2.id()).verified, 'the warning goes and he shows as verified');
  const kept = JSON.parse(fs.readFileSync(path.join(root, 'Cat', 'trust.json'), 'utf8'))[H];
  ok(kept[ben.id()].name === 'Ben' && kept[ben.id()].key && kept[ben2.id()].verified, 'what Cat has seen is kept on her PC');

  for (const p of [ben, cat, dev, ben2]) await p.chat.stop();
  await ana.chat.stop();
}
// A TURN client just good enough to ask for an allocation (as in spikes/voice/turn-load.js).
async function turnClient(host, port, creds) {
  const s = dgram.createSocket('udp4'), pending = new Map();
  await new Promise((r) => s.bind(0, '0.0.0.0', r));
  let key = null, realm = '', nonce = '';
  s.on('message', (b) => { const m = parse(b), p = m && pending.get(m.tx.toString('hex')); if (p) { pending.delete(m.tx.toString('hex')); p(m); } });
  const ask = (method, attrs, signed) => new Promise((done) => {
    const tx = crypto.randomBytes(12);
    pending.set(tx.toString('hex'), done);
    const extra = signed ? [[0x0006, Buffer.from(creds.username)], [0x0014, Buffer.from(realm)], [0x0015, Buffer.from(nonce)]] : [];
    s.send(build(method, 0, tx, [...attrs, ...extra], signed ? key : null), port, host);
    setTimeout(() => { if (pending.delete(tx.toString('hex'))) done(null); }, 2000);
  });
  const why = (m) => (!m ? 'no answer' : (m.attrs.get(0x0009) || Buffer.alloc(4)).toString('latin1').slice(4));
  return {
    async allocate() {
      const ch = await ask(3, [[0x0019, Buffer.from([17, 0, 0, 0])]], false);
      if (!ch || !ch.attrs.get(0x0014)) throw new Error(why(ch));
      realm = ch.attrs.get(0x0014).toString(); nonce = ch.attrs.get(0x0015).toString();
      key = crypto.createHash('md5').update(`${creds.username}:${realm}:${creds.credential}`).digest();
      const m = await ask(3, [[0x0019, Buffer.from([17, 0, 0, 0])]], true);
      if (!m || m.cls !== 0x0100) throw new Error(why(m));
      return xaddr(m.attrs.get(0x0016), m.tx);
    },
    close: () => s.close(),
  };
}
void xaddrBytes;

(async () => {
  console.log(`(${process.versions.electron ? 'Electron ' + process.versions.electron + "'s Node" : 'Node ' + process.version})`);
  await helpers();
  await calls();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
