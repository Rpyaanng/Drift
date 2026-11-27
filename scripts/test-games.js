// The Roulette and Texas Hold'em scenes (docs/plans/games-room.md), with two real copies of Drift on this PC (each with its
// own DRIFT_USERDATA). Each plays alone first, at tables dealt on its own PC: bets clicked onto the roulette layout and a
// spin, then hands of Hold'em against the computer players. Then the host makes a hub, the guest joins, and both sit at the
// hub's Hold'em table and then its roulette wheel, side by side. The main.js side is the DRIFT_TESTGAMES block.
// The rules themselves are checked in plain Node, in seconds: scripts/test-roulette-engine.js and scripts/test-poker-engine.js.
//   timeout 430 node scripts/test-games.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');       // (in plain Node this is the path to Electron itself)

const ROOT = path.resolve(__dirname, '..');
const ROLES = ['host', 'guest'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-games-test-'));

function runDrift(role) {
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, role), DRIFT_SHOTS: path.join(dir, 'shots-' + role), DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300',
    DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_SHARE_LOCAL: '1', DRIFT_TESTGAMES: role, DRIFT_BJ_FAST: '1', DRIFT_TESTCODE: path.join(dir, 'code.txt'), DRIFT_TESTGAMES_OUT: path.join(dir, 'out') };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 420000);       // a failure stops early (main.js `need`)
    p.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

(async () => {
  console.log('running in ' + dir);
  await Promise.all(ROLES.map(runDrift));
  let failed = 0;
  for (const r of ROLES) {
    let res = null;
    try { res = JSON.parse(fs.readFileSync(path.join(dir, 'out', r + '.json'), 'utf8')); } catch { /* none */ }
    if (!res) { console.log(`FAIL ${r}: wrote nothing (see ${path.join(dir, 'shots-' + r)})`); failed++; continue; }
    for (const [k, v] of Object.entries(res)) if (typeof v === 'boolean') { console.log(`${v ? 'ok  ' : 'FAIL'} ${r}: ${k}`); if (!v) failed++; }
  }
  try { console.log(`STOPPED EARLY (${fs.readFileSync(path.join(dir, 'out', 'abort'), 'utf8')}): the checks after it didn't run`); } catch { /* ran to the end */ }
  console.log(failed ? `${failed} failed (logs: ${dir}\\shots-*\\log.txt and chat.log)` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
