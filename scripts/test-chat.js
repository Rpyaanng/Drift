// Chat's checks, in plain Node (no Electron): a host and three friends, each with their own chat.js and folder, on this
// PC. Covers joining with an invite, messages, edits and deletes, channels, the limits, a hub that isn't the one the
// invite names, withdrawn invites, the host removing someone, blocking, and the hub restarting.
//   node scripts/test-chat.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const createChat = require('../chat');
const { encodeInvite, decodeInvite } = require('../hub');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-chat-test-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

function person(name) {
  const events = [];
  const chat = createChat({ dir: path.join(root, name), addrs: () => ['127.0.0.1'], event: (hub, m) => events.push({ hub, ...m }), changed: () => {}, log: (t) => console.log(`  [${name}] ${t}`) });
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
  dev.chat.join(code);
  await until(() => dev.hub(H) && dev.hub(H).status === 'gone', 'a withdrawn invite is refused');
  ok(/expired or was withdrawn/.test(dev.hub(H).note), `Dev is told why: "${dev.hub(H).note}"`);
  dev.chat.leave(H);

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

  // ---- the hub stops and starts again: same port, history kept, friends reconnect by themselves ----
  const port = ana.chat.info().hosting.port;
  await ana.chat.unhost();
  await until(() => ben.hub(H).status === 'offline', 'friends notice the hub went away');
  await ana.chat.host({ name: 'Test hub', internet: false });
  ok(ana.chat.info().hosting.port === port, 'the hub comes back on the same port, so invites still work');
  await until(() => ben.hub(H).status === 'connected', 'Ben reconnects by himself', 15000);
  ok((await ben.chat.history(H, general)).msgs.some((m) => m.text === 'from Dev'), 'history survived');

  // ---- a second copy of Ana's chat (Drift restarted): the identity and hubs come back from disk ----
  const n = ana.chat.myId();
  await ana.chat.stop();
  const again = createChat({ dir: path.join(root, 'Ana'), addrs: () => ['127.0.0.1'], changed: () => {} });
  ok(again.myId() === n, 'the identity key is kept');
  await again.start();
  await until(() => again.info().hubs.some((h) => h.id === H && h.status === 'connected' && h.host), 'Ana\'s Drift restarts, hosts again and reconnects');
  await again.stop();

  for (const p of [ben, cat, dev]) await p.chat.stop();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
