// The Broadcast tab with two real copies of Drift on this PC (each with its own DRIFT_USERDATA), pressing the real
// buttons (docs/plans/broadcast.md §5). Hosty hosts a hub and Guesty joins; neither has the tab until they're in the
// hub's voice room. Hosty picks a screen and goes live, Guesty sees the card (and a toast), presses Watch and then
// Stop watching, Hosty sees Guesty come and go and presses Stop broadcasting, and Guesty presses Disconnect while on the
// tab: the tab goes and the panel is back on Together. (scripts/test-broadcast.js checks the picture itself.)
//   node scripts/test-broadcast-ui.js            (KEEP=1 keeps the folder, with screenshots of each step)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');       // (in plain Node this is the path to Electron itself)

const ROOT = path.resolve(__dirname, '..');
const ROLES = ['host', 'guest'];
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

function runDrift(dir, role) {
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, role), DRIFT_SHOTS: path.join(dir, 'shots-' + role), DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300',
    DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_TESTBCUI: role, DRIFT_TESTCODE: path.join(dir, 'code.txt'), DRIFT_TESTBC_OUT: path.join(dir, 'out') };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 240000);
    p.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

function check(R) {
  const H = R.host.seen, G = R.guest.seen;
  for (const [who, s] of [['Hosty', H], ['Guesty', G]]) {
    ok(s.before && !s.before.tab, `${who}: no Broadcast tab before being in a hub`);
    ok(s.connected && s.connected.tab, `${who}: the Broadcast tab shows once connected (in the hub's voice room)`);
  }
  const p = H.picker || {};
  ok(p.screens && p.screens.length >= 1 && p.screens.every((id) => /^screen:/.test(id)), `Hosty's picker lists the monitors (${(p.screens || []).length})`);
  ok(Array.isArray(p.apps) && p.apps.every((id) => /^window:/.test(id)) && !p.apps.some((id) => R.host.own.includes(id)), `...and application windows, none of them Drift's own (${(p.apps || []).length} listed)`);
  ok(p.go && !p.mine && !p.start, 'Go live waits until something is picked');
  ok(H.picked && H.picked.start && /^Showing: Screen \d/.test(H.picked.picked), `picking a monitor allows Go live ("${H.picked && H.picked.picked}")`);
  ok(H.live && H.live.mine && !H.live.go && /^Screen \d/.test(H.live.mineTitle) && H.live.onair, `Hosty goes live: "You're live" with "${H.live && H.live.mineTitle}", and a red dot on the tab`);
  ok(H.live && H.live.cards.length === 1 && H.live.cards[0].btns.includes('Stop broadcasting') && /You · Screen/.test(H.live.cards[0].text), `Hosty's own card is in Live now ("${H.live && H.live.cards[0] && H.live.cards[0].text}")`);
  const c = G.card && G.card.cards[0];
  ok(c && /Hosty · Screen \d/.test(c.text) && /A whole screen/.test(c.text) && c.btns.includes('Watch'), `Guesty sees "Hosty · Screen" with Watch ("${c && c.text}")`);
  ok(c && !c.btns.includes('Stop it'), 'Guesty, not the host, has no button to stop it');
  ok(/Hosty started broadcasting/.test(R.guest.toast || ''), `Guesty is told by a toast ("${R.guest.toast}")`);
  ok(G.card && !G.card.onair, 'no red dot on Guesty\'s tab: Guesty isn\'t live');
  ok(G.watching && G.watching.cards[0].btns.includes('Stop watching'), 'Guesty presses Watch: the card says Stop watching');
  ok(H.watched && /Guesty · watching/.test(H.watched.mineWho), `Hosty sees Guesty watching ("${H.watched && H.watched.mineWho}")`);
  ok((R.host.hubSaysWatching || []).includes(R.guest.me), 'the hub lists Guesty as a viewer');
  ok(G.unwatched && G.unwatched.cards[0].btns.includes('Watch'), 'Guesty presses Stop watching: Watch again');
  ok(H.unwatched && /Nobody is watching/.test(H.unwatched.mineWho), 'Hosty sees nobody watching');
  ok(H.stopped && H.stopped.go && !H.stopped.mine && !H.stopped.onair, 'Hosty presses Stop broadcasting: back to Go live, no red dot');
  ok(G.ended && /Nobody is broadcasting/.test(G.ended.empty), 'the card is gone for Guesty');
  ok(G.disconnected && !G.disconnected.tab && G.disconnected.active === 'share', 'Guesty presses Disconnect while on the tab: it goes, and the panel is back on Together');
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-bcui-'));
  console.log(`(${dir})`);
  const exits = await Promise.all(ROLES.map((r) => runDrift(dir, r)));
  const R = {};
  for (const r of ROLES) { try { R[r] = JSON.parse(fs.readFileSync(path.join(dir, 'out', r + '.json'), 'utf8')); } catch { R[r] = null; } }
  if (ROLES.some((r) => !R[r])) {
    ok(false, `every copy reported (exits: ${exits.join(', ')}; missing: ${ROLES.filter((r) => !R[r]).join(', ')})`);
    for (const r of ROLES) { try { console.log(`  ${r} log:\n` + fs.readFileSync(path.join(dir, 'shots-' + r, 'log.txt'), 'utf8').split('\n').filter((l) => /bcui|error|Error/.test(l)).slice(-25).join('\n')); } catch { /* no log */ } }
  } else check(R);
  if (process.env.VERBOSE) console.log(JSON.stringify(R, null, 1));
  if (!process.env.KEEP && !failed) fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
