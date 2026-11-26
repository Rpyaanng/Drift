// Chat's checks, in plain Node (no Electron): a host and three friends, each with their own chat.js and folder, on this
// PC. Covers joining with an invite, messages, edits and deletes, channels, the limits, a hub that isn't the one the
// invite names, withdrawn invites, the host removing someone, blocking, and the hub restarting.
//   node scripts/test-chat.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const createChat = require('../chat');
const { encodeInvite, decodeInvite, placeOf } = require('../hub');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-chat-test-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

const BJ_TIMES = { bet: 2000, insure: 1000, turn: 3000, dealer: 20, done: 100, out: 500 };       // the blackjack table, fast (the hub Ana hosts)
function person(name) {
  const events = [];
  const chat = createChat({ dir: path.join(root, name), addrs: () => ['127.0.0.1'], event: (hub, m) => events.push({ hub, ...m }), changed: () => {}, log: (t) => console.log(`  [${name}] ${t}`), bjTimes: BJ_TIMES });
  chat.setName(name);
  return { name, chat, events, seen: (pred) => events.some(pred), hub: (id) => chat.info().hubs.find((h) => h.id === id) };
}
async function until(pred, what, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (pred()) return true; await wait(50); }
  ok(false, 'timed out: ' + what); return false;
}

(async () => {
  const ana = person('Ana'), ben = person('Ben'), cat = person('Cat'), dev = person('Dev');
  for (const p of [ana, ben, cat, dev]) await p.chat.start();

  // ---- hosting and joining ----
  const hosted = (await ana.chat.host({ name: 'Test hub', internet: false })).hosting;
  const H = hosted.id;
  await until(() => ana.hub(H) && ana.hub(H).status === 'connected', 'the host reaches its own hub');
  ok(ana.hub(H).host, 'the host is the host');
  const code = (await ana.chat.invite(H)).code;
  ok(/^drift:/.test(code) && decodeInvite(code), 'an invite code is made');
  ben.chat.join(code); cat.chat.join(code);
  await until(() => [ben, cat].every((p) => p.hub(H) && p.hub(H).status === 'connected'), 'friends join');
  ok(ben.hub(H).name === 'Test hub' && !ben.hub(H).host, 'a friend sees the hub\'s name and isn\'t the host');
  await until(() => ana.hub(H).members.filter((m) => m.online).length === 3, 'the host sees three people online');
  const general = ben.hub(H).channels[0].id;

  // ---- messages ----
  const sent = await ben.chat.send(H, general, 'hello **everyone** <img src=x onerror=alert(1)>');
  ok(sent.msg && sent.msg.id, 'a message is sent');
  await until(() => cat.seen((e) => e.t === 'msg' && e.msg.id === sent.msg.id), 'others get it');
  ok(sent.msg.text.includes('<img'), 'text is kept as text (the page shows it with textContent, never as HTML)');
  const hist = await cat.chat.history(H, general);
  ok(hist.msgs && hist.msgs.length === 1 && hist.msgs[0].from === ben.chat.myId(), 'history has it, from Ben');
  const edited = await ben.chat.edit(H, sent.msg.id, 'hello everyone');
  ok(edited.msg && edited.msg.edited && edited.msg.text === 'hello everyone', 'Ben edits his message');
  ok((await cat.chat.edit(H, sent.msg.id, 'hacked')).error, 'Cat can\'t edit Ben\'s message');
  ok((await cat.chat.remove(H, sent.msg.id)).error, 'Cat can\'t delete Ben\'s message');
  const reply = await cat.chat.send(H, general, 'hi Ben', sent.msg.id);
  ok(reply.msg && reply.msg.reply === sent.msg.id, 'Cat replies to it');
  ok(!(await ana.chat.remove(H, sent.msg.id)).error, 'the host deletes Ben\'s message');
  await until(() => ben.seen((e) => e.t === 'gone' && e.id === sent.msg.id), 'everyone is told it\'s gone');
  ok((await cat.chat.history(H, general)).msgs.every((m) => m.id !== sent.msg.id), 'and it\'s gone from history');
  ok(!(await cat.chat.remove(H, reply.msg.id)).error, 'Cat deletes her own message');

  // ---- limits ----
  ok((await ben.chat.send(H, general, 'x'.repeat(4001))).error, 'a message over 4,000 characters is refused');
  ok((await ben.chat.send(H, general, '   ')).error, 'an empty message is refused');
  const burst = await Promise.all(Array.from({ length: 14 }, (_x, i) => ben.chat.send(H, general, 'spam ' + i)));
  ok(burst.filter((r) => r.error).length >= 4, `sending too fast is slowed (${burst.filter((r) => r.error).length} of 14 refused)`);
  const page = await ana.chat.history(H, general, { limit: 3 });
  const older = await ana.chat.history(H, general, { before: page.msgs[0].id, limit: 3 });
  ok(page.msgs.length === 3 && older.msgs.length === 3 && older.msgs[2].id < page.msgs[0].id, 'history comes a page at a time');

  // ---- channels ----
  const made = await cat.chat.channel(H, 'Board Games!');
  ok(made.ch, 'anyone can make a channel');
  await until(() => ben.hub(H).channels.some((c) => c.name === 'board-games'), 'everyone sees #board-games');
  ok((await cat.chat.channel(H, 'board games')).error, 'no two channels with the same name');
  ok((await ben.chat.dropChannel(H, made.ch)).error, 'Ben can\'t delete Cat\'s channel');
  ok(!(await cat.chat.dropChannel(H, made.ch)).error, 'Cat can delete her own channel');

  // ---- pictures and microphones ----
  const PNG1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  ok(!ana.chat.setAvatar(PNG1).error, 'Ana sets a picture');
  await until(() => (ben.hub(H).members.find((m) => m.id === ana.chat.myId()) || {}).av, 'friends see she has one');
  const av = ben.hub(H).members.find((m) => m.id === ana.chat.myId()).av;
  ok((await ben.chat.avatar(H, ana.chat.myId(), av)).data === PNG1, 'and can fetch it');
  ok(!!ben.chat.setAvatar('data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+').error, 'an SVG picture is refused (it could carry script)');
  ok(!!ben.chat.setAvatar(PNG1.replace('image/png', 'image/jpeg')).error, 'a picture whose bytes don\'t match its type is refused');
  ok(!!ben.chat.setAvatar('data:image/png;base64,' + 'A'.repeat(20000)).error, 'a picture that is too big is refused');
  ana.chat.setAvatar('');
  await until(() => !(ben.hub(H).members.find((m) => m.id === ana.chat.myId()) || {}).av, 'removing the picture reaches friends');
  ben.chat.setMic(false); cat.chat.setMic(true);
  await until(() => { const ms = ana.hub(H).members; return (ms.find((m) => m.id === ben.chat.myId()) || {}).mic === false && (ms.find((m) => m.id === cat.chat.myId()) || {}).mic === true; }, 'everyone sees who has no microphone');

  // ---- pictures and GIFs in messages, and reactions ----
  const crypto = require('crypto');
  const gif = Buffer.concat([Buffer.from('GIF89a'), crypto.randomBytes(600 * 1024)]);       // (only its first bytes are looked at: big enough to go in parts)
  const withPic = await cat.chat.sendFile(H, general, gif, 320, 200, 'look', undefined);
  ok(withPic.msg && withPic.msg.file && withPic.msg.file.mime === 'image/gif' && withPic.msg.file.size === gif.length && withPic.msg.text === 'look', 'Cat sends a GIF with a message, in parts');
  await until(() => ben.seen((e) => e.t === 'msg' && e.msg.id === (withPic.msg || {}).id && e.msg.file), 'others get the message with the GIF');
  const got = withPic.msg ? await ben.chat.file(H, withPic.msg.file.id) : {};
  ok(got.data && got.data.equals(gif) && got.mime === 'image/gif', 'Ben fetches the GIF, byte for byte');
  ok((await cat.chat.sendFile(H, general, Buffer.from('<svg onload=alert(1)></svg>'.padEnd(64)), 10, 10, '')).error, 'an SVG (or anything not a picture) is refused');
  ok((await cat.chat.sendFile(H, general, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(4 * 1024 * 1024)]), 10, 10, '')).error, 'a picture over 4 MB is refused');
  ok((await ana.chat.send(H, general, 'x', undefined)).msg, 'plain messages still go');
  if (withPic.msg) {
    const id = withPic.msg.id;
    ok(!(await ben.chat.react(H, id, '👍', true)).error && !(await ana.chat.react(H, id, '👍', true)).error && !(await ana.chat.react(H, id, '❤️', true)).error, 'Ben and Ana react');
    await until(() => cat.seen((e) => e.t === 'react' && e.id === id && e.reacts.length === 2 && e.reacts[0].e === '👍' && e.reacts[0].who.length === 2), 'everyone sees 👍 2 and ❤️ 1');
    ok(!(await ana.chat.react(H, id, '❤️', false)).error, 'Ana takes her ❤️ back');
    await until(() => cat.seen((e) => e.t === 'react' && e.id === id && e.reacts.length === 1), 'and it goes');
    ok((await ben.chat.react(H, id, 'lol', true)).error && (await ben.chat.react(H, id, '👍👍', true)).error && (await ben.chat.react(H, id, '<b>', true)).error, 'a reaction is one emoji, nothing else');
    const h1 = (await cat.chat.history(H, general)).msgs.find((m) => m.id === id);
    ok(h1 && h1.file && h1.reacts && h1.reacts[0].e === '👍', 'history carries the picture and the reactions');
    ok(!(await cat.chat.remove(H, id)).error && (await cat.chat.file(H, withPic.msg.file.id)).error, 'deleting the message deletes its picture');
  }

  // ---- sharing (the Hub tab): the hub passes on who is sharing, so everyone gets a Join button ----
  ben.chat.announce(H, { code: 'drift:AAAA-bbbb_1', title: 'Dune.mkv', watching: [] });
  await until(() => (cat.hub(H).lives || []).some((l) => l.from === ben.chat.myId() && l.title === 'Dune.mkv' && l.code === 'drift:AAAA-bbbb_1'), 'everyone hears Ben is sharing');
  ben.chat.announce(H, { code: 'drift:AAAA-bbbb_1', title: 'Dune.mkv', watching: ['Cat'] });
  await until(() => (ana.hub(H).lives || []).some((l) => l.watching.includes('Cat')), 'and who is watching');
  ben.chat.announce(H, { code: 'drift:<script>', title: 'x'.repeat(500), watching: [] });
  await until(() => (cat.hub(H).lives || []).some((l) => l.code === 'drift:script'), 'a code is cleaned');
  ok(cat.hub(H).lives.find((l) => l.from === ben.chat.myId()).title.length <= 120, 'a title is cut short');
  ben.chat.announce('', null);
  await until(() => !(cat.hub(H).lives || []).length, 'the card goes when Ben stops sharing');
  dev.chat.join((await ana.chat.invite(H)).code);
  await until(() => dev.hub(H) && dev.hub(H).status === 'connected', 'Dev joins to test leaving');
  dev.chat.announce(H, { code: 'drift:dev', title: 'a web page', watching: [] });
  await until(() => (ben.hub(H).lives || []).length === 1, 'Dev shares');
  dev.chat.leave(H);
  await until(() => !(ben.hub(H).lives || []).length, 'the card goes when the sharer disconnects');

  // ---- the media stream: one share at a time; putting something else on takes a vote of everyone online (Ana, Ben, Cat) ----
  const votesOf = (p) => p.events.filter((e) => e.t === 'media-vote').map((e) => e.vote);
  const lastVote = (p) => votesOf(p).slice(-1)[0] || {};
  const livesOf = (p) => (p.hub(H).lives || []).map((l) => l.from);
  ok((await ben.chat.mediaAsk(H, 'B')).free, 'with nothing on, asking needs no vote');
  ana.chat.announce(H, { code: 'drift:ana', title: 'A', watching: [] });
  await until(() => livesOf(cat).join() === ana.chat.myId(), 'Ana puts something on');
  ben.chat.announce(H, { code: 'drift:ben', title: 'B', watching: [] });
  await until(() => ben.seen((e) => e.t === 'live-no'), 'Ben sharing without a vote is refused');
  ok(livesOf(cat).join() === ana.chat.myId(), '...and only Ana\'s is listed');
  const asked = await ben.chat.mediaAsk(H, 'B');
  ok(asked.id, 'Ben asks to switch');
  await until(() => lastVote(cat).id === asked.id && !lastVote(cat).result, 'everyone sees the vote');
  ok(lastVote(cat).voters.length === 3 && lastVote(cat).yes.join() === ben.chat.myId() && lastVote(cat).title === 'B', 'three can vote, and the asker counts as a yes');
  ok((await cat.chat.mediaAsk(H, 'C')).error, 'only one vote at a time');
  ok((await ben.chat.mediaVote(H, asked.id, true)).error, 'the asker can\'t vote again');
  await ana.chat.mediaVote(H, asked.id, false);
  await until(() => lastVote(cat).no.length === 1, 'Ana says no');
  ok(!lastVote(cat).result, 'one yes and one no of three: not decided yet');
  await cat.chat.mediaVote(H, asked.id, true);
  await until(() => lastVote(ana).result === 'yes', 'Cat says yes: two of three, it passes');
  ben.chat.announce(H, { code: 'drift:ben', title: 'B', watching: [] });
  await until(() => livesOf(cat).join() === ben.chat.myId(), 'the winner\'s share replaces Ana\'s');
  ana.events.length = 0;
  ana.chat.announce(H, { code: 'drift:ana2', title: 'A again', watching: [] });
  await until(() => ana.seen((e) => e.t === 'live-no'), 'Ana can\'t put hers back without a vote');
  const c1 = await cat.chat.mediaAsk(H, 'C');
  await ana.chat.mediaVote(H, c1.id, false); await ben.chat.mediaVote(H, c1.id, false);
  await until(() => lastVote(cat).id === c1.id && lastVote(cat).result === 'no', 'two of three say no: it fails');
  ok(livesOf(ana).join() === ben.chat.myId(), '...and Ben\'s stays on');
  const c2 = await cat.chat.mediaAsk(H, 'C');
  ok(!(await cat.chat.mediaCancel(H, c2.id)).error, 'the asker can call it off');
  await until(() => lastVote(ana).id === c2.id && lastVote(ana).result === 'cancel', 'everyone hears it\'s off');
  const c3 = await cat.chat.mediaAsk(H, 'C');
  ben.chat.announce('', null);
  await until(() => lastVote(ana).id === c3.id && lastVote(ana).result === 'yes', 'what\'s on stops during a vote: the asker wins');
  ana.chat.announce('', null);
  await until(() => !livesOf(cat).length, 'nothing on');

  // ---- reach (hub.js "reach"): a share nobody elsewhere can get to stays off the stream while someone online is elsewhere ----
  const near = ['127.0.0.1', '::ffff:192.168.1.20', '10.0.0.5', '100.101.1.2', '::1', 'fd12:3456::1', 'fe80::1'].map(placeOf);
  ok(near.every((p) => p === 'near'), `this PC, its network and private ranges (a VPN's too) are all one place (${near})`);
  ok(placeOf('::ffff:203.0.113.7') === '203.0.113.7' && placeOf('203.0.113.7') !== placeOf('198.51.100.2'), 'two homes on the internet are two places');
  ok(placeOf('2001:db8:1:2::5') === placeOf('2001:db8:1:2:ffff::9') && placeOf('2001:db8:1:2::5') !== placeOf('2001:db8:1:3::5'), 'an IPv6 home is its first half');
  const fails = (p) => p.events.filter((e) => e.t === 'live-no');
  // apart (hub.js apartFrom): who online is somewhere else, before anyone shares. All here are on this PC: nobody.
  ok([ana, ben, cat].every((p) => Array.isArray(p.hub(H).apart) && !p.hub(H).apart.length), 'everyone hears that nobody online is on another network');
  ben.events.length = 0;
  ben.chat.announce(H, { code: 'drift:benlan', title: 'B', watching: [], reach: 'lan' });
  await until(() => livesOf(cat).join() === ben.chat.myId(), 'only reachable on its own network, but everyone online is on it: it goes on');
  ben.chat.announce('', null);
  await until(() => !livesOf(cat).length, 'off again');
  ben.chat.announce(H, { code: 'drift:benman', title: 'B', watching: [], reach: 'manual' });
  await until(() => livesOf(cat).join() === ben.chat.myId(), 'couldn\'t be checked: it goes on');
  ok((cat.hub(H).lives[0] || {}).reach === 'manual' && !('place' in (cat.hub(H).lives[0] || {})), 'members hear how far it reaches, not where anyone is');
  ben.chat.liveFail(H, 'drift:benman');
  await wait(300);
  ok(livesOf(cat).join() === ben.chat.myId(), 'the sharer saying it can\'t reach its own share changes nothing');
  cat.chat.liveFail(H, 'drift:benman');
  await until(() => !livesOf(ana).length, 'a member who couldn\'t connect to it: it comes off the stream for everyone');
  await until(() => fails(ben).some((e) => e.why === 'unreached' && (e.who || []).join() === 'Cat'), 'and the sharer hears who couldn\'t connect');
  ben.chat.announce('', null);
  ben.chat.announce(H, { code: 'drift:bennet', title: 'B', watching: [], reach: 'internet' });
  await until(() => livesOf(cat).join() === ben.chat.myId(), 'reachable from the internet: it goes on');
  cat.chat.liveFail(H, 'drift:bennet');
  await wait(300);
  ok(livesOf(cat).join() === ben.chat.myId(), '...and a member who can\'t connect to that one doesn\'t take it off (the trouble is likely theirs)');
  ben.chat.announce('', null);
  await until(() => !livesOf(cat).length, 'nothing on');

  // ---- the Surf stream (docs/plans/streams.md §7): the host's browser, streamed to members who watch; signed setup messages ----
  const A = ana.chat.myId(), B = ben.chat.myId();
  const sdpOf = (fp) => `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\na=fingerprint:sha-256 ${fp}\r\n`;
  const ssEv = (p, t) => p.events.filter((e) => e.t === t);
  const w1 = await ben.chat.ssWatch(H);
  ok(!w1.error && w1.on === false, 'Ben opens Surf: he watches, though it isn\'t running yet');
  await until(() => ssEv(ana, 'ss-wake').length > 0, 'the host is asked to start it');
  ok((await ana.chat.ssWatch(H)).error, 'the host can\'t watch their own (it\'s on their PC)');
  const on1 = await ana.chat.ssSet({ on: true, title: 'Drift start page' });
  ok(!on1.error, 'the host starts the Surf stream');
  await until(() => (cat.hub(H).surf || {}).on && cat.hub(H).surf.title === 'Drift start page', 'everyone sees it running, with its front tab\'s title');
  await until(() => ssEv(ana, 'ss-viewer').some((e) => e.id === B), 'Ben\'s signed request reaches the host');
  ok(ana.chat.info().ss.host.watchers.includes(B) && ana.chat.info().ss.host.names[B] === 'Ben', 'the host knows Ben is watching');
  ana.chat.ssSignal(B, { sdp: { type: 'offer', sdp: sdpOf('AA:AA') } });
  await until(() => ssEv(ben, 'ss-sdp').some((e) => e.sdp.type === 'offer'), 'the host\'s signed offer reaches Ben, checked');
  ben.chat.ssSignal(A, { sdp: { type: 'answer', sdp: sdpOf('BB:BB') } });
  await until(() => ssEv(ana, 'ss-sdp').some((e) => e.from === B && e.sdp.type === 'answer'), 'Ben\'s signed answer reaches the host, checked');
  ok(ben.chat.ssCert(A, 'sha-256', 'AA:AA').ok, 'the certificate the host used matches the signed one');
  ok(ana.chat.ssCert(B, 'sha-256', 'BB:BB').ok, '...and Ben\'s');
  const cur = ben.chat.info().ss.watching;
  ok(cur && cur.from === A, 'Ben\'s watch names the host');
  // the host disconnects from their own hub: the stream carries on (the service line is in-process)
  ana.chat.disconnect(H);
  await until(() => !ben.hub(H).members.find((m) => m.id === A).online, 'the host shows offline');
  ok((ben.hub(H).surf || {}).on, '...but the Surf stream still runs');
  const n1 = ssEv(ana, 'ss-viewer').length;
  await ben.chat.ssWatch(H);
  await until(() => ssEv(ana, 'ss-viewer').length > n1, 'Ben asking again still reaches the host');
  ana.chat.reconnect(H);
  await until(() => ana.hub(H).status === 'connected', 'the host comes back');
  // a forged offer: for Ben's real request, but signed by a key that isn't the host's (a hub sitting in the middle)
  await ben.chat.ssWatch(H);
  await until(() => !!ben.chat._ssWant(), 'Ben asks again');
  const n2 = ben.chat._ssWant();
  const forged = createChat.signSs(require('crypto').generateKeyPairSync('ed25519').privateKey, { pin: H, room: ben.hub(H).surf.room, type: 'offer', from: A, to: B, nonce: n2, sdp: sdpOf('CC:CC') });
  const offers = ssEv(ben, 'ss-sdp').length;
  ben.chat._fromHub(H, { t: 'surf-signal', from: A, d: { sdp: { type: 'offer', sdp: sdpOf('CC:CC') }, nonce: n2, sig: forged } });
  ok(ssEv(ben, 'ss-refused').length === 1 && ssEv(ben, 'ss-sdp').length === offers, 'an offer signed by anyone but the host is refused, and never reaches the window');
  ok(!!(await ben.chat.ssWatch(H)).refused, '...and Ben\'s Drift won\'t show that stream');
  await ana.chat.ssSet({ on: false });
  await until(() => ssEv(ben, 'ss-paused').length > 0, 'the host\'s browser stops: Ben hears');
  ben.chat.ssUnwatch();
  await until(() => !(ana.chat.info().ss.host.watchers || []).length, 'Ben stops watching');

  // ---- an invite pointing at the right address but a different hub (someone answering in its place) ----
  const inv = decodeInvite(code);
  const fake = encodeInvite({ ...inv, pin: Buffer.alloc(32, 7) });
  dev.chat.join(fake);
  await wait(2500);
  ok(dev.chat.info().hubs.every((h) => h.status !== 'connected'), 'a hub whose certificate doesn\'t match the invite is refused');
  dev.chat.leave(dev.chat.info().hubs[0].id);

  // ---- withdrawn invites ----
  ok(!!(await ben.chat.withdrawInvites(H)).error, 'only the host can withdraw invites');
  ok(!(await ana.chat.withdrawInvites(H)).error, 'the host withdraws every invite');
  const eve = person('Eve'); await eve.chat.start();
  eve.chat.join(code);
  await until(() => eve.hub(H) && eve.hub(H).status === 'gone', 'a withdrawn invite is refused');
  ok(/expired or was withdrawn/.test(eve.hub(H).note), `Eve is told why: "${eve.hub(H).note}"`);
  await eve.chat.stop();

  // ---- removing someone ----
  ok((await ben.chat.removeMember(H, cat.chat.myId())).error, 'Ben can\'t remove anyone');
  ok(!(await ana.chat.removeMember(H, cat.chat.myId())).error, 'the host removes Cat');
  await until(() => cat.hub(H).status === 'gone', 'Cat is disconnected');
  await until(() => !ben.hub(H).members.some((m) => m.id === cat.chat.myId()), 'Cat is gone from the member list');
  const code2 = (await ben.chat.invite(H)).code;
  ok(!!code2, 'a friend can invite, even right after sending a lot');
  cat.chat.leave(H); cat.chat.join(code2);
  await until(() => cat.hub(H) && cat.hub(H).status === 'gone', 'Cat can\'t come back with a new invite');
  ok(/removed/.test(cat.hub(H).note), `Cat is told why: "${cat.hub(H).note}"`);
  dev.chat.join(code2);
  await until(() => dev.hub(H) && dev.hub(H).status === 'connected', 'Dev joins with the new invite');

  // ---- blocking ----
  ben.chat.block(ana.chat.myId(), true);
  const n0 = ben.events.length;
  await ana.chat.send(H, general, 'from the host');
  await dev.chat.send(H, general, 'from Dev');
  await until(() => ben.events.slice(n0).some((e) => e.t === 'msg' && e.msg.text === 'from Dev'), 'Ben still gets Dev\'s messages');
  ok(!ben.events.slice(n0).some((e) => e.t === 'msg' && e.msg.text === 'from the host'), 'Ben doesn\'t see messages from someone he blocked');
  ok(!(await ben.chat.history(H, general)).msgs.some((m) => m.from === ana.chat.myId()), '...in history either');
  ben.chat.block(ana.chat.myId(), false);

  // ---- the blackjack table (docs/plans/blackjack.md §5): dealt by the hub, which keeps the biggest pots ----
  const bjView = (p) => { const e = [...p.events].reverse().find((x) => x.t === 'bj-view' && x.hub === H); return e ? e.v : null; };
  async function playOut(p) {       // one round with a bet of 10 (never out of chips): no insurance, stand, till it's settled
    for (let i = 0; i < 400; i++) {
      const v = bjView(p), me = v && v.you >= 0 ? v.seats[v.you] : null;
      if (v && v.phase === 'done' && me && me.hands.length) return v;
      if (v && v.phase === 'betting' && me && !me.bet && !me.outMs) await p.chat.bj(H, { t: 'bj-bet', amount: 10 });
      else if (v && v.phase === 'insurance' && me && me.insure) await p.chat.bj(H, { t: 'bj-insure', yes: false });
      else if (v && v.phase === 'turns' && v.turn && v.turn.seat === v.you) await p.chat.bj(H, { t: 'bj-act', do: 'stand' });
      await wait(25);
    }
    return null;
  }
  ok((await dev.chat.bj(H, { t: 'bj-bet', amount: 100 })).error, 'blackjack: no bet without sitting down');
  ok(!(await dev.chat.bj(H, { t: 'bj-sit' })).error, 'Dev sits at the hub\'s table');
  await until(() => bjView(dev) && bjView(dev).you >= 0, 'Dev gets the table, seated');
  ok(Array.isArray(bjView(dev).board) && bjView(dev).board.length === 0, 'a new hub\'s board of biggest pots is empty');
  ok((await dev.chat.bj(H, { t: 'bj-bet', amount: 5 })).error, 'a bet under the minimum is refused');
  let best = 0, rounds = 0;
  while (!best && rounds++ < 40) {
    const v = await playOut(dev);
    if (!v) break;
    if (v.seats[v.you].net > 0) best = v.seats[v.you].net;
    await until(() => bjView(dev).phase !== 'done', 'the next round');
  }
  ok(best > 0, `Dev wins a round (+${best}, in ${rounds})`);
  ok(bjView(dev).board.length === 1 && bjView(dev).board[0].id === dev.chat.myId() && bjView(dev).board[0].name === 'Dev' && bjView(dev).board[0].win === best, '...and it\'s on the board as Dev\'s biggest pot');
  ok(!(await dev.chat.bj(H, { t: 'bj-leave' })).error, 'Dev leaves the table');

  // ---- the hub stops and starts again: same port, history kept, friends reconnect by themselves ----
  const port = ana.chat.info().hosting.port;
  await ana.chat.unhost();
  await until(() => ben.hub(H).status === 'offline', 'friends notice the hub went away');
  await ana.chat.host({ name: 'Test hub', internet: false });
  ok(ana.chat.info().hosting.port === port, 'the hub comes back on the same port, so invites still work');
  await until(() => ben.hub(H).status === 'connected', 'Ben reconnects by himself', 15000);
  ok((await ben.chat.history(H, general)).msgs.some((m) => m.text === 'from Dev'), 'history survived');
  await ben.chat.bj(H, { t: 'bj-watch' });       // looking on, not sitting
  await until(() => bjView(ben) && Array.isArray(bjView(ben).board), 'Ben looks at the table');
  ok(bjView(ben).board.some((x) => x.name === 'Dev' && x.win === best) && bjView(ben).you === -1, 'the biggest pots survive the hub restarting (and looking on takes no seat)');
  await ben.chat.bj(H, { t: 'bj-leave' });

  // ---- a second copy of Ana's chat (Drift restarted): the identity and hubs come back from disk ----
  const n = ana.chat.myId();
  await ana.chat.stop();
  const again = createChat({ dir: path.join(root, 'Ana'), addrs: () => ['127.0.0.1'], changed: () => {} });
  ok(again.myId() === n, 'the identity key is kept');
  await again.start();
  await until(() => again.info().hubs.some((h) => h.id === H && h.status === 'connected' && h.host), 'Ana\'s Drift restarts, hosts again and reconnects');
  ok(!(await again.history(H, general)).msgs.length, 'messages last one session: closing Drift wiped them');
  await until(() => again.info().hubs.find((h) => h.id === H).members.some((m) => m.id === ben.chat.myId() && m.online), '...but members are kept: Ben gets back in by himself, without a new invite');
  await again.stop();
  // As Drift runs it (connectOnStart false): her hub doesn't run until she presses Host, which starts it and puts her online in it.
  const third = createChat({ dir: path.join(root, 'Ana'), addrs: () => ['127.0.0.1'], changed: () => {}, connectOnStart: false });
  await third.start();
  await wait(1500);
  const rest = third.info().hubs.find((h) => h.id === H);
  ok(rest && rest.status === 'offline' && !third.info().hosting && third.info().canHost, `with connectOnStart off, her hub isn't running on start (${rest && rest.status})`);
  ok(third.info().hostName === 'Test hub', '...and Host knows its name');
  await third.host({ internet: false });
  ok(third.info().hosting && third.info().hosting.id === H && third.info().hosting.name === 'Test hub', 'Host starts the same hub, with the same name');
  await until(() => third.info().hubs.some((h) => h.id === H && h.status === 'connected'), '...and she is online in it');
  await third.unhost();
  ok(third.info().canHost && third.info().hostName === 'Test hub', 'Stop hosting keeps the hub to host again');
  await third.stop();

  for (const p of [ben, cat, dev]) await p.chat.stop();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
