// The Share tab with two real copies of Drift on this PC (each with its own DRIFT_USERDATA), pressing the real
// buttons (docs/plans/broadcast.md §5). Hosty hosts a hub and Guesty joins; neither has the tab until they're in the
// hub's voice room. Hosty picks a screen and goes live, picks the tab again for the grid (its own tile, with Manage);
// Guesty picks the tab, sees Hosty's tile in the grid (and a toast), presses Watch and then Stop watching, Hosty sees
// Guesty come and go and presses Stop sharing, Guesty's grid empties, and Guesty leaves the hub from it: the tab and
// the grid go and the panel is back on the Hub tab. (scripts/test-broadcast.js checks the picture itself.)
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
    ok(s.before && !s.before.tab, `${who}: no Share tab before being in a hub`);
    ok(s.connected && s.connected.tab, `${who}: the Share tab shows once connected (in the hub's voice room)`);
  }
  const p = H.picker || {};
  ok(p.screens && p.screens.length >= 1 && p.screens.every((id) => /^screen:/.test(id)), `Hosty's picker lists the monitors (${(p.screens || []).length})`);
  ok(Array.isArray(p.apps) && p.apps.every((id) => /^window:/.test(id)) && !p.apps.some((id) => R.host.own.includes(id)), `...and application windows, none of them Drift's own (${(p.apps || []).length} listed)`);
  ok(p.go && !p.mine && !p.start, 'Go live waits until something is picked');
  ok(H.picked && H.picked.start && /^Showing: Screen \d/.test(H.picked.picked), `picking a monitor allows Go live ("${H.picked && H.picked.picked}")`);
  ok(H.live && H.live.mine && !H.live.go && /^Screen \d/.test(H.live.mineTitle) && H.live.onair, `Hosty goes live: "You're live" with "${H.live && H.live.mineTitle}", and a red dot on the tab`);
  const hs = H.hostScene || { cards: [] }, own = hs.cards[0] || {};
  ok(hs.scene && !hs.open && hs.pill === 'broadcast', `Hosty picks the Share tab again: its page goes and the grid is on screen, the tab lit (${JSON.stringify({ scene: hs.scene, open: hs.open, pill: hs.pill })})`);
  ok(hs.cards.length === 1 && /You · Screen/.test(own.text) && /You're live/.test(own.text) && (own.btns || []).includes('Manage') && !(own.btns || []).includes('Watch'), `...with Hosty's own tile, Manage and no Watch ("${own.text}", ${JSON.stringify(own.btns)})`);
  const pv = H.preview || {}, po = H.previewOff || {};
  ok(pv.live && pv.w > 0 && pv.t > 1 && pv.audio === 0 && pv.muted && (pv.btns || []).includes('Stop preview'), `Hosty presses Preview: its own tile plays what it's sending, without sound (${JSON.stringify(pv)})`);
  ok(!po.live && (po.btns || []).includes('Preview'), `...and Stop preview puts it back to a still (${JSON.stringify(po)})`);
  ok(H.manage && H.manage.open && H.manage.active === 'broadcast' && H.manage.mine, 'Manage opens the Share page over the grid');
  ok(H.manage && H.manage.onTop, '...drawn on top of the grid, so its tabs can be clicked');
  const c = G.card && G.card.cards[0];
  ok(G.card && G.card.scene && !G.card.open, 'Guesty picks the Share tab: the grid is on screen');
  ok(c && /Hosty · Screen \d/.test(c.text) && c.btns.includes('Watch') && !c.btns.includes('Preview'), `Guesty sees "Hosty · Screen" with Watch, and no "Preview" with only one up ("${c && c.text}", ${JSON.stringify(c && c.btns)})`);
  ok(c && !c.btns.includes('Stop it'), 'Guesty, not the host, has no button to stop it');
  ok(/Hosty started broadcasting/.test(R.guest.toast || ''), `Guesty is told by a toast ("${R.guest.toast}")`);
  ok(G.card && !G.card.onair, 'no red dot on Guesty\'s tab: Guesty isn\'t live');
  ok(G.watching && G.watching.full && G.watching.scene, 'Guesty presses Watch: the broadcast fills the screen');
  ok(H.watched && /Guesty · watching/.test(H.watched.mineWho), `Hosty sees Guesty watching ("${H.watched && H.watched.mineWho}")`);
  ok((R.host.hubSaysWatching || []).includes(R.guest.me), 'the hub lists Guesty as a viewer');
  ok(G.unwatched && !G.unwatched.full && G.unwatched.cards[0].btns.includes('Watch'), 'Guesty presses Stop watching in its bar: back to the grid, Watch again');
  ok(H.unwatched && /Nobody is watching/.test(H.unwatched.mineWho), 'Hosty sees nobody watching');
  ok(H.stopped && H.stopped.go && !H.stopped.mine && !H.stopped.onair, 'Hosty presses Stop sharing: back to Go live, no red dot');
  ok(G.ended && /Nobody is broadcasting/.test(G.ended.empty) && !G.ended.cards.length, 'the tile is gone for Guesty: the empty grid says nobody is broadcasting');
  ok(G.goLive && G.goLive.open && G.goLive.active === 'broadcast' && G.goLive.go && G.goLive.onTop, 'the empty grid\'s Go live opens the Share page on top, where it can be clicked');
  ok(G.disconnected && !G.disconnected.tab && G.disconnected.active === 'hub' && !G.disconnected.scene, 'Guesty leaves the hub from the grid: the tab and the grid go, and the panel is back on the Hub tab');
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
