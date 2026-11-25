// Files sent straight between PCs (docs/plans/files.md), with two real copies of Drift on this PC (each with its own
// DRIFT_USERDATA): the host offers a 40 MB file and a 600 MB one; the guest presses Download on the first (through the hub's
// relay, held to its speed for files), pauses partway, resumes, then downloads the second directly. Both must arrive whole.
// (The signed setup messages, the limits and files.js on its own are checked in plain Node: scripts/test-files.js.)
//   node scripts/test-file-transfer.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');       // (in plain Node this is the path to Electron itself)

const ROOT = path.resolve(__dirname, '..');
const ROLES = ['host', 'guest'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-ft-test-'));

function runDrift(role) {
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, role), DRIFT_SHOTS: path.join(dir, 'shots-' + role), DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300',
    DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_SHARE_LOCAL: '1', DRIFT_TESTFT: role, DRIFT_TESTCODE: path.join(dir, 'code.txt'), DRIFT_TESTFT_OUT: path.join(dir, 'out') };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 300000);       // a pass takes about a minute and a half; a failure stops early (main.js `need`)
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
  if (!failed && !process.env.DRIFT_KEEP) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left for the OS */ }       // (DRIFT_KEEP=1 keeps the logs of a pass too)
  process.exit(failed ? 1 : 0);
})();
