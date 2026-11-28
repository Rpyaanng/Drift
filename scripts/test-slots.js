// Locked scenes, scene tokens and Scene Slots (docs/plans/scene-slots.md), in one real copy of Drift on this PC, hidden, with its
// own settings folder and the locks on (DRIFT_LOCKS: test runs otherwise open every scene). The checks are in main.js, the
// DRIFT_TESTSLOTS block; a failure that the rest depends on stops it early.
//   timeout 120 node scripts/test-slots.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');       // (in plain Node this is the path to Electron itself)

const ROOT = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-slots-test-'));

(async () => {
  console.log('running in ' + dir);
  const out = path.join(dir, 'out');
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, 'user'), DRIFT_SHOTS: path.join(dir, 'shots'), DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300',
    DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_LOCKS: '1', DRIFT_TESTSLOTS: out };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve) => {
    const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 100000);
    p.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  let res = null, failed = 0;
  try { res = JSON.parse(fs.readFileSync(path.join(out, 'solo.json'), 'utf8')); } catch { /* none */ }
  if (!res) { console.log(`FAIL: wrote nothing (Drift exited: ${code}; see ${path.join(dir, 'shots')})`); process.exit(1); }
  for (const [k, v] of Object.entries(res)) if (typeof v === 'boolean') { console.log(`${v ? 'ok  ' : 'FAIL'} ${k}`); if (!v) failed++; }
  try { console.log(`STOPPED EARLY (${fs.readFileSync(path.join(out, 'abort'), 'utf8')}): the checks after it didn't run`); } catch { /* ran to the end */ }
  console.log(failed ? `${failed} failed (log: ${path.join(dir, 'shots', 'log.txt')})` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
