// Voice's checks, in plain Node (no Electron, no WebRTC): the signing that keeps calls end-to-end encrypted when the
// hub is hostile, the member keys and safety numbers, and the hub's relay. Real hubs and real chat.js copies, with the
// hub misbehaving on purpose (DRIFT_HUB_TAMPER) and stand-in SDPs where the voice window would send real ones.
// Voice is one room per hub (docs/plans/broadcast.md §1): being in it, Talk, Don't listen, who connects to whom, limits.
// Broadcasts (§2–§4, Phase 2) are signed and checked the same way: going live, watching, forgeries, limits, endings.
//   node scripts/test-voice.js                      (and under Electron's Node: ELECTRON_RUN_AS_NODE=1 electron scripts/test-voice.js)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const createChat = require('../chat');
const { memberId, rawKey } = require('../hub');
const { checkMembers, safetyNumber, fingerprints, signSdp, verifySdp, signBc, verifyBc } = createChat;
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

  // Broadcasts: their own first line (so voice and broadcast signatures never pass as each other), the broadcast id and the type
  const bf = { pin, room: call, bc: crypto.randomBytes(18).toString('base64url'), type: 'offer', from: memberId(A), to: memberId(B), nonce, sdp };
  const bsig = signBc(a.privateKey, bf);
  ok(verifyBc(A, bf, bsig), 'an honest broadcast offer passes');
  ok(!verifyBc(A, bf, sig), 'a voice SDP\'s signature is refused as a broadcast one');
  ok(!verifySdp(A, f, bsig), 'a broadcast SDP\'s signature is refused as a voice one');
  ok(!verifyBc(A, { ...bf, bc: crypto.randomBytes(18).toString('base64url') }, bsig), 'an offer signed for another broadcast is refused');
  ok(!verifyBc(A, { ...bf, type: 'answer' }, bsig), 'an offer can\'t pass as an answer');
  ok(!verifyBc(A, { ...bf, sdp: sdp.replace(/(a=fingerprint:sha-256 )\S+/, `$1${hex()}`) }, bsig), 'a swapped fingerprint in a broadcast offer is refused');
  ok(!verifyBc(A, { ...bf, room: crypto.randomBytes(16).toString('base64url') }, bsig), 'a broadcast offer from another room is refused');
  const want = { ...bf, type: 'want', sdp: undefined }, wsig = signBc(a.privateKey, want);
  ok(verifyBc(A, want, wsig) && !verifyBc(A, { ...bf }, wsig), 'a request to watch (no SDP) is signed, and can\'t pass as an offer');
  ok(!signBc(a.privateKey, { ...bf, sdp: 'v=0\r\n' }) && !signBc(a.privateKey, { ...bf, type: 'pranswer' }), 'nothing is signed as an offer without a fingerprint, or as an unknown type');

  const list = [{ id: memberId(A), key: A.toString('base64url'), name: 'Ana' }, { id: memberId(B), key: C.toString('base64url'), name: 'Ben' }, { id: memberId(C), key: 'short', name: 'Cat' }, { id: 'made-up', name: 'Dev' }];
  const { good, bad } = checkMembers(list);
  ok(good.length === 1 && good[0].name === 'Ana', 'a member list entry whose key hashes to its id is kept');
  ok(bad.map((x) => x.name).join() === 'Ben,Cat,Dev', 'entries whose key doesn\'t hash to their id (or have none) are dropped');

  const s1 = await safetyNumber(A, B), s2 = await safetyNumber(B, A), s3 = await safetyNumber(A, C);
  ok(/^\d{4} \d{4} \d{4}$/.test(s1), `a safety number is 12 digits (${s1})`);
  ok(s1 === s2, 'both people get the same safety number');
  ok(s1 !== s3, 'a different key gives a different safety number');
}

// ---- 2. voice rooms through a real hub, honest and hostile ----
function person(name, dir = name, o = {}) {
  const events = [];
  const chat = createChat({ dir: path.join(root, dir), addrs: () => ['127.0.0.1'], event: (hub, m) => events.push({ hub, ...m }), changed: () => {}, log: (t) => { if (process.env.VERBOSE) console.log(`  [${name}] ${t}`); }, ...o });
  chat.setName(name);
  return { name, chat, events, id: () => chat.myId(), seen: (pred) => events.some(pred), hub: (id) => chat.info().hubs.find((h) => h.id === id) };
}
const offerTo = (p, to) => { const sdp = sdpWith(hex()); p.chat.voiceSignal(to.id(), { sdp: { type: 'offer', sdp } }); return sdp; };
const answerTo = (p, to) => { const sdp = sdpWith(hex()); p.chat.voiceSignal(to.id(), { sdp: { type: 'answer', sdp } }); return sdp; };
const sdpFrom = (p, from, type) => p.events.find((e) => e.t === 'voice-sdp' && e.from === from.id() && e.sdp.type === type);
const refusedFrom = (p, from) => p.events.some((e) => e.t === 'voice-refused' && e.from === from.id());
const roomOf = (p) => [...p.events].reverse().find((e) => e.t === 'voice-room');
const peersOf = (p) => { const e = [...p.events].reverse().find((x) => x.t === 'voice-peers'); return e ? e.list : []; };
const wants = (p, q) => peersOf(p).some((x) => x.id === q.id());
const listeners = (p, H) => (p.hub(H).voice || []).filter((v) => v.listen).length;
// Into a hub's room (as main.js does when it's your active hub), and out again
const enter = (p, H, o = {}) => p.chat.setVoice({ hub: H, listen: true, talk: false, mic: false, ...o });
const out = (p) => p.chat.setVoice({ hub: '' });

async function rooms() {
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
  ok(!(ana.hub(H).voice || []).length && !ben.chat.info().call, 'online alone puts nobody in the voice room: only an active hub does');

  // ---- Ben and Cat make it their active hub: in the room, listening, microphones closed ----
  enter(ben, H);
  await until(() => roomOf(ben), 'Ben is in the voice room');
  const j1 = roomOf(ben);
  ok(j1.iceServers.length === 1 && /^turn:\d+\.\d+\.\d+\.\d+:\d+\?transport=udp$/.test(j1.iceServers[0].urls) && !/127\.0\.0\.1/.test(j1.iceServers[0].urls), `the hub hands out its relay at a real address (${j1.iceServers[0] && j1.iceServers[0].urls})`);
  ok(/^\d+:/.test(j1.iceServers[0].username) && j1.iceServers[0].username.endsWith(':' + ben.id()), 'with short-lived TURN REST credentials for Ben');
  enter(cat, H);
  await until(() => listeners(ana, H) === 2, 'everyone in the hub sees two people listening');
  ok(ana.hub(H).voice.every((v) => v.listen && !v.talk && !v.mic), 'both are listening with their microphones closed');
  await until(() => wants(ben, cat) && wants(cat, ben), 'in a small room, two listeners connect (so nobody\'s first word is clipped)');
  const bOffers = peersOf(ben).find((x) => x.id === cat.id()).offer, cOffers = peersOf(cat).find((x) => x.id === ben.id()).offer;
  ok(bOffers !== cOffers && bOffers === (ben.id() < cat.id()), 'exactly one of them makes the offer: the lower id');
  const [off, ans] = bOffers ? [ben, cat] : [cat, ben];
  const o1 = offerTo(off, ans);
  await until(() => sdpFrom(ans, off, 'offer'), 'the offer arrives');
  ok(sdpFrom(ans, off, 'offer').sdp.sdp === o1, 'exactly the SDP that was signed reaches the voice window');
  const a1 = answerTo(ans, off);
  await until(() => sdpFrom(off, ans, 'answer'), 'the answer arrives');
  ok(sdpFrom(off, ans, 'answer').sdp.sdp === a1, '...exactly as signed');
  const fp = (s) => /a=fingerprint:(\S+) (\S+)/.exec(s);
  ok(ans.chat.voiceCert(off.id(), fp(o1)[1], fp(o1)[2]).ok, 'the certificate really used matches the signed one: verified');
  ok(ans.chat.info().call.verdict[off.id()] === 'verified', 'and the Drift says so');
  ok(!off.chat.voiceCert(ans.id(), 'sha-256', hex()).ok, 'a certificate that doesn\'t match the signed fingerprint is caught');
  ok(off.chat.info().call.verdict[ans.id()] === 'mismatch', '...and marked');
  const n0 = off.events.length;
  answerTo(ans, off);       // a second answer with no offer to answer: there's no nonce for it, so it isn't sent
  await wait(400);
  ok(!off.events.slice(n0).some((e) => e.t === 'voice-sdp'), 'an answer to no offer goes nowhere');

  // ---- Talk: the hub hears of it ----
  enter(ben, H, { talk: true, mic: true });
  await until(() => (ana.hub(H).voice.find((v) => v.id === ben.id()) || {}).talk === true, 'Ben presses Talk: the hub shows him talking');
  enter(ben, H, { talk: false });
  await until(() => (ana.hub(H).voice.find((v) => v.id === ben.id()) || {}).talk === false, 'and closing the microphone shows too');

  // ---- the relay: credentials work while listening, and stop when you don't ----
  const turnAt = /turn:([\d.]+):(\d+)/.exec(j1.iceServers[0].urls);
  const t1 = await turnClient(turnAt[1], +turnAt[2], j1.iceServers[0]);
  ok(!!(await t1.allocate().catch((e) => ({ error: e.message }))).address, 'Ben can use the relay while he listens');
  const wrong = await turnClient(turnAt[1], +turnAt[2], { ...j1.iceServers[0], credential: 'not-the-password' });
  ok(/Unauthorized/.test(await wrong.allocate().then(() => 'ACCEPTED', (e) => e.message)), 'a wrong TURN password is refused');
  const forged = await turnClient(turnAt[1], +turnAt[2], { username: `${Math.floor(Date.now() / 1000) + 600}:${dev.id()}`, credential: j1.iceServers[0].credential });
  ok(/Unauthorized/.test(await forged.allocate().then(() => 'ACCEPTED', (e) => e.message)), 'Ben\'s password doesn\'t work for another name');
  ok(ana.chat.relayStats().open >= 1, 'the relay has Ben\'s allocation');
  enter(ben, H, { listen: false });
  await until(() => ana.chat.relayStats().open === 0, 'Don\'t listen ends Ben\'s allocations at once');
  await until(() => !ben.chat.info().call, 'and Ben\'s Drift leaves the mesh (the voice window closes)');
  ok(ana.hub(H).voice.some((v) => v.id === ben.id() && !v.listen), 'he is still in the room, shown as not listening');
  const t2 = await turnClient(turnAt[1], +turnAt[2], j1.iceServers[0]);
  ok(/Forbidden/.test(await t2.allocate().then(() => 'ACCEPTED', (e) => e.message)), 'not listening, Ben\'s credentials no longer work');
  for (const t of [t1, t2, wrong, forged]) t.close();
  await until(() => !wants(cat, ben), 'Cat no longer wants a connection to Ben');
  out(ben); out(cat);
  await until(() => ana.hub(H).voice.length === 0, 'the room is empty');

  // ---- big rooms: connections only where someone talks ----
  {
    const few = ['Fay', 'Gus', 'Hal'].map((n) => person(n, n, { preconnect: 2 }));       // pre-connect only up to 2, so 3 is "big"
    for (const p of few) { await p.chat.start(); p.chat.join(code); }
    await until(() => few.every((p) => p.hub(H) && p.hub(H).status === 'connected'), 'three more join the hub');
    for (const p of few) enter(p, H);
    await until(() => listeners(ana, H) === 3, 'all three listen');
    await wait(500);
    ok(few.every((p) => peersOf(p).length === 0), 'above the pre-connect size, a pair of listeners never connects');
    if (process.env.VERBOSE) console.log(few.map((p) => p.name + ' ' + JSON.stringify(peersOf(p)) + ' ' + JSON.stringify(p.hub(H).voice)).join(' || '));
    enter(few[0], H, { talk: true, mic: true });
    await until(() => wants(few[1], few[0]) && wants(few[2], few[0]) && wants(few[0], few[1]) && wants(few[0], few[2]), 'Fay presses Talk: everyone listening connects to her');
    ok(!wants(few[1], few[2]) && !wants(few[2], few[1]), 'but Gus and Hal, both only listening, still don\'t connect');
    enter(few[0], H, { talk: false });
    await until(() => few.every((p) => peersOf(p).length === 0), 'when she stops talking, those connections go again');
    for (const p of few) { out(p); await p.chat.stop(); }
  }

  // ---- the room is full at 16, and 8 can talk at once ----
  {
    const extra = [];
    for (let i = 0; i < 13; i++) { const p = person('Extra' + i); await p.chat.start(); p.chat.join(code); extra.push(p); }
    await until(() => extra.every((p) => p.hub(H) && p.hub(H).status === 'connected'), 'thirteen more join the hub', 30000);
    const all = [ana, ben, cat, ...extra];
    for (const p of all) enter(p, H);
    await until(() => ana.hub(H).voice.length === 16, 'sixteen people are in the room', 20000);
    enter(dev, H);
    await until(() => /full/.test((dev.hub(H).room || {}).note || ''), 'the seventeenth is told the voice room is full');
    ok(!dev.chat.info().call && dev.hub(H).status === 'connected', '...and stays in the hub\'s chat');
    for (let i = 0; i < 8; i++) enter(all[i], H, { talk: true, mic: true });
    await until(() => ana.hub(H).voice.filter((v) => v.talk).length === 8, 'eight people talk at once');
    enter(all[8], H, { talk: true, mic: true });
    await until(() => all[8].seen((e) => e.t === 'voice-said' && e.talk === false), 'the ninth to press Talk is told to wait (and main.js closes their microphone)');
    ok(!ana.hub(H).voice.find((v) => v.id === all[8].id()).talk, '...and isn\'t shown talking');
    for (const p of all) out(p);
    out(dev);
    await until(() => ana.hub(H).voice.length === 0, 'everyone leaves the room');
    for (const p of extra) await p.chat.stop();
  }

  // ---- a hostile hub: for each kind of interference, Cat's setup messages to Ben are tampered with ----
  for (const how of ['fingerprint', 'unsigned', 'replay', 'swapkey']) {
    process.env.DRIFT_HUB_TAMPER = how; process.env.DRIFT_HUB_TAMPER_PAIR = 'Cat>Ben';
    for (const p of [ben, cat, dev]) out(p);
    await ana.chat.unhost();
    await ana.chat.host({ name: 'Voice hub', internet: false });
    await until(() => [ana, ben, cat, dev].every((p) => p.hub(H) && p.hub(H).status === 'connected'), `everyone reconnects (${how})`, 20000);
    for (const p of [ana, ben, cat, dev]) p.events.length = 0;
    enter(ben, H); enter(dev, H); enter(cat, H);
    await until(() => listeners(ana, H) === 3, 'three people are in the room');
    await until(() => [ben, cat, dev].every((p) => !!p.chat.info().call && p.chat.info().call.peers.length === 2), 'each knows the other two are there');
    if (process.env.VERBOSE) console.log([ben, cat, dev].map((p) => p.name + ' ' + JSON.stringify(p.chat.info().call && p.chat.info().call.peers) + ' room=' + JSON.stringify(p.hub(H).room) + ' voice=' + JSON.stringify(p.hub(H).voice)).join(' || '));
    if (how === 'swapkey') {
      await until(() => ben.hub(H).suspect.some((s) => s.id === cat.id()), 'Ben\'s Drift sets aside the key the hub made up for Cat');
      ok(!ben.hub(H).members.some((m) => m.id === cat.id()), 'and drops her entry from his member list');
      ok(dev.hub(H).members.some((m) => m.id === cat.id()), 'Dev, told the truth, still has her');
    }
    // Cat offers to both (whoever chat.js says offers, the checks are the same); Dev answers her; Dev and Ben still connect
    offerTo(cat, dev); offerTo(cat, ben);
    await until(() => sdpFrom(dev, cat, 'offer'), `Dev gets Cat's offer (${how})`);
    answerTo(dev, cat);
    await until(() => sdpFrom(cat, dev, 'answer'), `Cat gets Dev's answer (${how})`);
    await until(() => refusedFrom(ben, cat), `Ben refuses what the hub passed him as Cat's (${how})`);
    ok(!sdpFrom(ben, cat, 'offer'), `nothing from Cat reaches Ben's voice window (${how})`);
    const r = ben.events.find((e) => e.t === 'voice-refused' && e.from === cat.id());
    ok(r && r.name === 'Cat', `Ben's Drift knows who to name in the warning: "${r && r.name}" (${r && r.why})`);
    await until(() => cat.seen((e) => e.t === 'voice-told' && e.from === ben.id()), `Cat is told Ben couldn't verify her (${how})`);
    ok(ben.chat.info().call.refused[cat.id()], 'Ben won\'t connect to Cat for the rest of the room');
    offerTo(cat, ben); await wait(400);
    ok(!sdpFrom(ben, cat, 'offer'), 'not even if a good one comes along afterwards');
    offerTo(dev, ben);
    await until(() => sdpFrom(ben, dev, 'offer'), `Ben and Dev still connect (${how})`);
    for (const p of [ben, cat, dev]) out(p);
  }

  // ---- replays the hub could try by hand: an old SDP sent again, or one from an earlier room ----
  process.env.DRIFT_HUB_TAMPER = '';
  await ana.chat.unhost(); await ana.chat.host({ name: 'Voice hub', internet: false });
  await until(() => [ana, ben, cat].every((p) => p.hub(H) && p.hub(H).status === 'connected'), 'everyone reconnects (honest again)', 20000);
  ok(ben.hub(H).members.some((m) => m.id === cat.id()) && !ben.hub(H).suspect.length, 'with an honest hub, Cat\'s key checks out again');
  {
    // A message really signed by Cat (her key, from her folder: the worst a hub could hold is one she sent), which the
    // hub then sends Ben again, or keeps for a later room. _fromHub hands Ben's Drift a line as if the hub had sent it.
    const catKey = crypto.createPrivateKey(Buffer.from(JSON.parse(fs.readFileSync(path.join(root, 'Cat', 'identity.json'), 'utf8')).key, 'base64').toString());
    const signed = (roomId, n) => { const sdp = sdpWith(hex()); return { t: 'voice-signal', from: cat.id(), d: { sdp: { type: 'offer', sdp }, nonce: n, sig: signSdp(catKey, { pin: H, call: roomId, from: cat.id(), to: ben.id(), nonce: n, sdp }) } }; };
    for (const p of [ben, cat]) p.events.length = 0;
    enter(ben, H); enter(cat, H);
    await until(() => ben.chat.info().call && ben.chat.info().call.peers.includes(cat.id()), 'Ben hears Cat is in the room');
    const room1 = ben.chat.info().call.id, first = signed(room1, crypto.randomBytes(16).toString('base64url'));
    ben.chat._fromHub(H, first);
    ok(!!sdpFrom(ben, cat, 'offer'), 'an offer signed by Cat for this room is taken');
    ben.events.length = 0;
    ben.chat._fromHub(H, first);
    ok(refusedFrom(ben, cat), 'the same offer sent again is refused (its nonce was used)');
    out(ben); out(cat);
    await until(() => ana.hub(H).voice.length === 0, 'the room empties');
    enter(ben, H); enter(cat, H);
    await until(() => ben.chat.info().call && ben.chat.info().call.peers.includes(cat.id()), 'Ben hears Cat is in the room again');
    ok(ben.chat.info().call.id !== room1, 'a room that emptied comes back with a new id');
    ben.events.length = 0;
    ben.chat._fromHub(H, first);
    ok(refusedFrom(ben, cat), 'an offer from the earlier room is refused (another room id)');
    out(ben); out(cat);
    await until(() => ana.hub(H).voice.length === 0, 'the room empties again');
    enter(ben, H); enter(cat, H);
    await until(() => ben.chat.info().call && ben.chat.info().call.peers.includes(cat.id()), 'a fresh room, where Ben has not refused Cat');
    // Someone removed: the room gets a new id at once, though it never emptied
    const eve = person('Eve'); await eve.chat.start(); eve.chat.join((await ana.chat.invite(H)).code);
    await until(() => eve.hub(H) && eve.hub(H).status === 'connected', 'Eve joins the hub');
    enter(eve, H);
    await until(() => listeners(ana, H) === 3, 'Eve is in the room');
    const room2 = ben.chat.info().call.id;
    ok(!(await ana.chat.removeMember(H, eve.id())).error, 'the host removes Eve');
    await until(() => ben.chat.info().call && ben.chat.info().call.id !== room2, 'removing someone gives the room a new id');
    ok(cat.chat.info().call.id === ben.chat.info().call.id, 'and everyone still in it has the same new id');
    const later = signed(room2, crypto.randomBytes(16).toString('base64url'));
    ben.events.length = 0;
    ben.chat._fromHub(H, later);
    ok(refusedFrom(ben, cat), 'an offer signed for the room before the removal is refused');
    await eve.chat.stop();
    out(ben); out(cat);
  }

  // ---- Disconnect: offline from a hub without leaving it ----
  ok(!dev.chat.disconnect(H).error && dev.hub(H).status === 'away', 'Dev disconnects: the hub shows as away');
  await until(() => !ana.hub(H).members.find((m) => m.id === dev.id()).online, '...and the others see him go offline');
  ok(!dev.chat.reconnect(H).error, 'clicking the hub connects again');
  await until(() => dev.hub(H).status === 'connected', '...with no new invite');

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
// ---- 3. broadcasts through a real hub, honest and hostile (docs/plans/broadcast.md, Phase 2) ----
// Stand-in SDPs where the broadcast and screen windows would send real ones, as above.
const keyOf = (p) => crypto.createPrivateKey(Buffer.from(JSON.parse(fs.readFileSync(path.join(root, p.name, 'identity.json'), 'utf8')).key, 'base64').toString());
const fpOf = (s) => /a=fingerprint:(\S+) (\S+)/.exec(s);
const bcSend = (type) => (p, bc, to) => { const sdp = sdpWith(hex()); p.chat.bcSignal(bc, to.id(), { sdp: { type, sdp } }); return sdp; };
const bcOffer = bcSend('offer'), bcAnswer = bcSend('answer');
const bcSdp = (p, bc, from, type) => p.events.find((e) => e.t === 'bc-sdp' && e.bc === bc && e.from === from.id() && (!type || e.sdp.type === type));
const bcRefused = (p, bc, from) => p.events.find((e) => e.t === 'bc-refused' && e.bc === bc && e.from === from.id());
const asks = (p, bc, viewer) => p.events.filter((e) => e.t === 'bc-viewer' && e.bc === bc && e.id === viewer.id()).length;
const bcOf = (p, H, bc) => (p.hub(H).bcs || []).find((b) => b.id === bc);
const watchOff = (p, bc) => p.events.find((e) => e.t === 'bc-watch-off' && e.bc === bc);
const myOff = (p, bc) => p.events.find((e) => e.t === 'bc-off' && e.bc === bc);

async function broadcasts() {
  delete process.env.DRIFT_HUB_TAMPER; delete process.env.DRIFT_HUB_TAMPER_PAIR;
  const ivy = person('Ivy'), jo = person('Jo'), kit = person('Kit'), lu = person('Lu');
  const crew = [ivy, jo, kit, lu];
  for (const p of crew) await p.chat.start();
  const H = (await ivy.chat.host({ name: 'Broadcast hub', internet: false })).hosting.id;
  await until(() => ivy.hub(H) && ivy.hub(H).status === 'connected', 'the host reaches the broadcast hub');
  const code = (await ivy.chat.invite(H)).code;
  for (const p of [jo, kit, lu]) p.chat.join(code);
  await until(() => [jo, kit, lu].every((p) => p.hub(H) && p.hub(H).status === 'connected'), 'friends join the broadcast hub');
  ok(/Connect to a hub/.test((await jo.chat.bcStart(H, { title: 'Screen 1' })).error || ''), 'outside the voice room, nobody can broadcast');
  const inRoom = async (what) => { for (const p of crew) enter(p, H); await until(() => listeners(ivy, H) === 4 && crew.every((p) => p.hub(H).room.in), what); };
  await inRoom('all four are in the voice room');
  const watch = async (p, bc) => { await until(() => bcOf(p, H, bc), `${p.name} sees the broadcast`); return p.chat.bcWatch(H, bc); };       // (the hub's list reaches each Drift in its own time)

  // ---- going live, and watching ----
  const s1 = await jo.chat.bcStart(H, { title: 'Screen 2', kind: 'screen' });
  ok(!!s1.id && s1.iceServers.length === 1 && /^turn:/.test(s1.iceServers[0].urls), 'Jo goes live, with the relay to send through');
  const B = s1.id;
  await until(() => { const b = bcOf(kit, H, B); return b && b.from === jo.id() && b.title === 'Screen 2' && b.kind === 'screen'; }, 'everyone sees "Jo · Screen 2"');
  ok(!(await jo.chat.bcUpdate({ title: 'x'.repeat(200) })).error, 'Jo renames it while live');
  await until(() => (bcOf(kit, H, B) || {}).title === 'x'.repeat(80), 'the title is cut to 80 characters');
  ok(/own broadcast/.test((await jo.chat.bcWatch(H, B)).error || ''), 'Jo can\'t watch her own broadcast');
  const w1 = await watch(kit, B);
  ok(w1.from === jo.id() && w1.iceServers.length === 1, 'Kit watches, with the relay');
  await until(() => asks(jo, B, kit) === 1, 'Jo\'s Drift gets Kit\'s signed request to watch');
  await until(() => (bcOf(lu, H, B) || { viewers: [] }).viewers.includes(kit.id()), 'everyone sees Kit watching');
  const o1 = bcOffer(jo, B, kit);
  await until(() => bcSdp(kit, B, jo, 'offer'), 'Jo\'s offer reaches Kit');
  ok(bcSdp(kit, B, jo, 'offer').sdp.sdp === o1, '...exactly as signed');
  const a1 = bcAnswer(kit, B, jo);
  await until(() => bcSdp(jo, B, kit, 'answer'), 'Kit\'s answer reaches Jo');
  ok(bcSdp(jo, B, kit, 'answer').sdp.sdp === a1, '...exactly as signed');
  ok(kit.chat.bcCert(B, jo.id(), fpOf(o1)[1], fpOf(o1)[2]).ok && kit.chat.info().bc.watching[0].verdict === 'verified', 'the certificate Jo used is the signed one: verified');
  ok(jo.chat.bcCert(B, kit.id(), fpOf(a1)[1], fpOf(a1)[2]).ok, '...and Kit\'s, on Jo\'s side');
  const k0 = kit.events.length, j0 = jo.events.length;
  bcOffer(jo, B, kit); bcAnswer(kit, B, jo); await wait(400);
  ok(![...kit.events.slice(k0), ...jo.events.slice(j0)].some((e) => e.t === 'bc-sdp'), 'with no fresh request (or offer) to answer, nothing is sent');
  await kit.chat.bcWatch(H, B);
  await until(() => asks(jo, B, kit) === 2, 'Kit asks again (as after a monitor change): a fresh request');
  bcOffer(jo, B, kit);
  await until(() => kit.events.filter((e) => e.t === 'bc-sdp' && e.bc === B).length === 2, '...and gets a fresh offer');

  // ---- what a hostile hub could hand Lu as Jo's offer (_fromHub: as if the hub had sent it) ----
  const joKey = keyOf(jo), kitKey = keyOf(kit);
  const room = () => lu.chat.info().call.id;
  async function luAsks(what) {
    const before = asks(jo, B, lu);
    if (lu.chat.info().bc.watching.length) { lu.chat.bcUnwatch(B); await until(() => !(bcOf(ivy, H, B) || { viewers: [] }).viewers.includes(lu.id()), 'Lu stops watching'); }
    await lu.chat.bcWatch(H, B);
    await until(() => asks(jo, B, lu) === before + 1, 'Lu asks to watch: ' + what);
    lu.events.length = 0;
    return lu.chat._bcWant(B);
  }
  const forged = (from, d) => lu.chat._fromHub(H, { t: 'bc-signal', from: from.id(), bc: B, d });
  const offerD = (key, f, sdp = sdpWith(hex())) => ({ sdp: { type: 'offer', sdp }, nonce: f.nonce, sig: signBc(key, { pin: H, room: room(), bc: B, type: 'offer', from: jo.id(), to: lu.id(), sdp, ...f }) });
  let n = await luAsks('a control');
  forged(jo, offerD(joKey, { nonce: n }));
  ok(!!bcSdp(lu, B, jo, 'offer'), 'an offer really signed by Jo, for Lu\'s request, is taken (so the refusals below mean something)');
  n = await luAsks('a voice signature');
  { const sdp = sdpWith(hex()); forged(jo, { sdp: { type: 'offer', sdp }, nonce: n, sig: signSdp(joKey, { pin: H, call: room(), from: jo.id(), to: lu.id(), nonce: n, sdp }) }); }
  ok(bcRefused(lu, B, jo) && !bcSdp(lu, B, jo), 'a voice SDP signed by Jo is refused as a broadcast one');
  n = await luAsks('another broadcast id');
  forged(jo, offerD(joKey, { nonce: n, bc: crypto.randomBytes(18).toString('base64url') }));
  ok(bcRefused(lu, B, jo) && !bcSdp(lu, B, jo), 'an offer Jo signed for another broadcast is refused');
  n = await luAsks('another nonce');
  forged(jo, offerD(joKey, { nonce: crypto.randomBytes(16).toString('base64url') }));
  ok(bcRefused(lu, B, jo) && !bcSdp(lu, B, jo), 'an offer that wasn\'t for Lu\'s request is refused');
  n = await luAsks('someone else\'s key');
  forged(jo, offerD(kitKey, { nonce: n }));
  ok(bcRefused(lu, B, jo) && !bcSdp(lu, B, jo), 'an offer "from Jo" signed by Kit (who isn\'t broadcasting) is refused');
  forged(kit, offerD(kitKey, { nonce: n, from: kit.id() }));
  ok(!bcSdp(lu, B, kit) && !bcRefused(lu, B, kit), 'and one from Kit, who isn\'t the broadcaster, goes nowhere');
  n = await luAsks('an unsigned offer');
  { const d = offerD(joKey, { nonce: n }); delete d.sig; forged(jo, d); }
  ok(bcRefused(lu, B, jo) && !bcSdp(lu, B, jo), 'an unsigned offer is refused');
  // and the other way: a broadcast SDP passed to Lu's voice window as a voice one
  { const sdp = sdpWith(hex()), vn = crypto.randomBytes(16).toString('base64url');
    lu.chat._fromHub(H, { t: 'voice-signal', from: jo.id(), d: { sdp: { type: 'offer', sdp }, nonce: vn, sig: signBc(joKey, { pin: H, room: room(), bc: B, type: 'offer', from: jo.id(), to: lu.id(), nonce: vn, sdp }) } }); }
  ok(refusedFrom(lu, jo) && !sdpFrom(lu, jo, 'offer'), 'a broadcast SDP signed by Jo is refused as a voice one');
  // A request to watch, forged: signed for voice, or by someone else, is refused by Jo's Drift
  { const fn = crypto.randomBytes(16).toString('base64url'), jn = jo.events.length;
    jo.chat._fromHub(H, { t: 'bc-signal', from: ivy.id(), bc: B, d: { want: true, nonce: fn, sig: signBc(kitKey, { pin: H, room: room(), bc: B, type: 'want', from: ivy.id(), to: jo.id(), nonce: fn }) } });
    ok(bcRefused(jo, B, ivy) && !jo.events.slice(jn).some((e) => e.t === 'bc-viewer'), 'a request to watch "from Ivy" that Kit signed is refused'); }
  n = await luAsks('a certificate check');
  forged(jo, offerD(joKey, { nonce: n }));
  ok(!lu.chat.bcCert(B, jo.id(), 'sha-256', hex()).ok && lu.chat.info().bc.watching[0].verdict === 'mismatch', 'a certificate that isn\'t the signed one is caught');

  // ---- limits: four broadcasts per hub, one each, seven viewers ----
  const s2 = await kit.chat.bcStart(H, { title: 'Notepad', kind: 'window' });
  ok(!!s2.id, 'Kit goes live too: two in the hub');
  const s3 = await lu.chat.bcStart(H, { title: 'Screen 1' }), s4 = await ivy.chat.bcStart(H, { title: 'Screen 1' });
  ok(!!s3.id && !!s4.id, 'Lu and Ivy go live as well: four in the hub');
  const nia = person('Nia'); await nia.chat.start(); nia.chat.join(code);
  await until(() => nia.hub(H) && nia.hub(H).status === 'connected', 'Nia joins');
  enter(nia, H); await until(() => nia.hub(H).room.in, 'and is in the room');
  const s5 = await nia.chat.bcStart(H, { title: 'Screen 1' });
  ok(s5.full && /4 people are already broadcasting in this hub/.test(s5.error || ''), `a fifth is told to wait ("${s5.error}")`);
  out(nia); await nia.chat.stop();
  lu.chat.bcStop(); ivy.chat.bcStop();
  await until(() => !bcOf(jo, H, s3.id) && !bcOf(jo, H, s4.id), 'Lu and Ivy stop');
  kit.chat.bcStop();
  await until(() => !bcOf(ivy, H, s2.id), 'Kit stops: his broadcast is gone for everyone');
  ok(!!myOff(kit, s2.id), '...and his Drift closes it');
  {
    const extra = [];
    for (let i = 0; i < 6; i++) { const p = person('Viewer' + i); await p.chat.start(); p.chat.join(code); extra.push(p); }
    await until(() => extra.every((p) => p.hub(H) && p.hub(H).status === 'connected'), 'six more join', 20000);
    for (const p of extra) enter(p, H);
    await until(() => extra.every((p) => p.hub(H).room.in), 'and are in the room', 20000);
    lu.chat.bcUnwatch(B);
    await until(() => (bcOf(ivy, H, B) || { viewers: [] }).viewers.length === 1, 'only Kit is watching');
    for (const p of extra.slice(0, 6)) await watch(p, B);
    await until(() => (bcOf(ivy, H, B) || { viewers: [] }).viewers.length === 7, 'seven are watching');
    const r = await lu.chat.bcWatch(H, B);
    ok(r.full && /7 people/.test(r.error || ''), `the eighth is told it's full ("${r.error}")`);
    for (const p of extra) { out(p); await p.chat.stop(); }
    await until(() => (bcOf(ivy, H, B) || { viewers: [] }).viewers.length === 1, 'viewers who leave the room stop watching');
  }

  // ---- the relay: a viewer who isn't listening can still use it while watching ----
  enter(lu, H, { listen: false });
  await until(() => !lu.chat.info().call, 'Lu turns listening off');
  const w2 = await lu.chat.bcWatch(H, B);
  ok(w2.iceServers.length === 1, 'not listening, Lu can still watch, through the relay');
  const at = /turn:([\d.]+):(\d+)/.exec(w2.iceServers[0].urls);
  const t1 = await turnClient(at[1], +at[2], w2.iceServers[0]);
  ok(!!(await t1.allocate().catch((e) => ({ error: e.message }))).address, '...and her credentials work while she watches');
  const before = ivy.chat.relayStats().open;
  lu.chat.bcUnwatch(B);
  await until(() => ivy.chat.relayStats().open < before, 'stopping watching (while not listening) ends her allocations');
  const t2 = await turnClient(at[1], +at[2], w2.iceServers[0]);
  ok(/Forbidden/.test(await t2.allocate().then(() => 'ACCEPTED', (e) => e.message)), '...and her credentials no longer work');
  for (const t of [t1, t2]) t.close();
  enter(lu, H);

  // ---- a broadcast ends: the host stops it, the broadcaster disconnects or leaves the room, or is removed ----
  ok(/No such broadcast/.test((await kit.chat.bcHostStop(H, B)).error || ''), 'only the host can stop someone else\'s broadcast');
  ok(!(await ivy.chat.bcHostStop(H, B)).error, 'the host stops Jo\'s broadcast');
  await until(() => myOff(jo, B), 'Jo\'s Drift hears it ended');
  ok(/host stopped/.test(myOff(jo, B).why), `...and why ("${myOff(jo, B).why}")`);
  await until(() => watchOff(kit, B), 'Kit\'s view of it closes');
  ok(!bcOf(kit, H, B) && !jo.chat.info().bc.mine && !kit.chat.info().bc.watching.length, 'it\'s gone everywhere');

  const B2 = (await jo.chat.bcStart(H, { title: 'Screen 2' })).id;
  await watch(kit, B2);
  await until(() => asks(jo, B2, kit) === 1, 'Jo goes live again and Kit watches');
  jo.chat.disconnect(H);
  await until(() => watchOff(kit, B2) && !bcOf(kit, H, B2), 'Jo disconnects: the broadcast ends for Kit');
  ok(!!myOff(jo, B2) && !jo.chat.info().bc.mine, '...and on Jo\'s side');
  jo.chat.reconnect(H);
  await until(() => jo.hub(H).status === 'connected' && jo.hub(H).room.in, 'Jo connects again');

  const B3 = (await jo.chat.bcStart(H, { title: 'Screen 2' })).id;
  out(jo);
  await until(() => myOff(jo, B3) && !bcOf(kit, H, B3), 'Jo moves her voice to another hub: the broadcast ends');
  enter(jo, H);
  await until(() => jo.hub(H).room.in, 'Jo is back in the room');

  // Removing someone: their broadcast ends, the room gets a new id, and a request signed for the old one is asked again
  const mo = person('Mo'); await mo.chat.start(); mo.chat.join((await ivy.chat.invite(H)).code);
  await until(() => mo.hub(H) && mo.hub(H).status === 'connected', 'Mo joins');
  enter(mo, H); await until(() => mo.hub(H).room.in, 'Mo is in the room');
  const M = (await mo.chat.bcStart(H, { title: 'Game' })).id, B4 = (await jo.chat.bcStart(H, { title: 'Screen 2' })).id;
  await watch(kit, M); await watch(lu, B4);
  await until(() => asks(mo, M, kit) === 1 && asks(jo, B4, lu) === 1, 'Kit watches Mo, and Lu asks to watch Jo (no offer yet)');
  const r0 = room();
  ok(!(await ivy.chat.removeMember(H, mo.id())).error, 'the host removes Mo');
  await until(() => watchOff(kit, M) && !bcOf(kit, H, M), 'Mo\'s broadcast ends for Kit');
  await until(() => room() !== r0, 'the room gets a new id');
  await until(() => asks(jo, B4, lu) === 2, 'Lu\'s request, signed for the old room, is made again for the new one');
  lu.events.length = 0;
  bcOffer(jo, B4, lu);
  await until(() => bcSdp(lu, B4, jo, 'offer'), 'and Jo\'s offer, signed for the new room, is taken');
  ok(!bcRefused(lu, B4, jo), '...with nothing refused');
  await mo.chat.stop();
  jo.chat.bcStop(); kit.chat.bcUnwatch(M); lu.chat.bcUnwatch(B4);

  // ---- a hostile hub: for each kind of interference, what Jo sends Kit is tampered with; Lu, told the truth, still watches ----
  for (const how of ['fingerprint', 'unsigned', 'replay', 'swapkey']) {
    process.env.DRIFT_HUB_TAMPER = how; process.env.DRIFT_HUB_TAMPER_PAIR = 'Jo>Kit';
    for (const p of crew) out(p);
    await ivy.chat.unhost();
    await ivy.chat.host({ name: 'Broadcast hub', internet: false });
    await until(() => crew.every((p) => p.hub(H) && p.hub(H).status === 'connected'), `everyone reconnects (${how})`, 20000);
    for (const p of crew) p.events.length = 0;
    await inRoom(`all four are in the room (${how})`);
    const T = (await jo.chat.bcStart(H, { title: 'Screen 2' })).id;
    await until(() => bcOf(kit, H, T) && bcOf(lu, H, T), `Kit and Lu see Jo's broadcast (${how})`);
    await kit.chat.bcWatch(H, T); await lu.chat.bcWatch(H, T);
    await until(() => asks(jo, T, kit) === 1 && asks(jo, T, lu) === 1, `both ask to watch (${how})`);
    bcOffer(jo, T, kit); bcOffer(jo, T, lu);       // Kit's first: in replay, the hub holds it back and sends him Lu's
    await until(() => bcSdp(lu, T, jo, 'offer'), `Lu gets Jo's offer (${how})`);
    await until(() => bcRefused(kit, T, jo), `Kit refuses what the hub passed him as Jo's (${how})`);
    ok(!bcSdp(kit, T, jo), `nothing from Jo reaches Kit's screen window (${how}: ${bcRefused(kit, T, jo).why})`);
    await until(() => jo.events.some((e) => e.t === 'bc-told' && e.bc === T && e.from === kit.id()), `Jo is told Kit couldn't verify her (${how})`);
    ok(/couldn't check/.test((await kit.chat.bcWatch(H, T)).error || ''), `Kit won't take this broadcast again (${how})`);
    jo.chat.bcStop();
  }
  process.env.DRIFT_HUB_TAMPER = ''; process.env.DRIFT_HUB_TAMPER_PAIR = '';
  for (const p of crew) out(p);
  for (const p of [jo, kit, lu]) await p.chat.stop();
  await ivy.chat.stop();
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
  await rooms();
  await broadcasts();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
