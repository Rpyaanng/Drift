// What's new (renderer/whatsnew.js) in one real copy of Drift: a new install doesn't show it; as if just updated from 1.8.6 it
// opens by itself on the main monitor with every version since marked New, its pictures loaded; ← and →, a picture opened
// bigger, Esc, and Settings → What's new; and it doesn't open by itself twice. (The notes files themselves are checked by
// scripts/check-notes.js, and the reader by scripts/test-notes.js.)
//   node scripts/test-whats-new.js            (KEEP=1 keeps the folder)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-notes-'));
  const shots = path.join(dir, 'shots');
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, 'user'), DRIFT_SHOTS: shots, DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300', DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_TESTNOTES: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve) => {
    const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 120000);       // a pass takes about 30 s
    p.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  let R = null;
  try { R = JSON.parse(fs.readFileSync(path.join(shots, 'notes.json'), 'utf8')); } catch { /* none */ }
  if (!R) { console.log(`FAIL Drift wrote what it saw (exit ${code}; see ${path.join(shots, 'log.txt')})`); failed++; }
  for (const [k, v] of Object.entries(R || {})) if (typeof v === 'boolean') { console.log(`${v ? 'ok  ' : 'FAIL'} ${k}`); if (!v) failed++; }
  console.log(failed ? `${failed} failed (log: ${path.join(shots, 'log.txt')})` : 'all passed');
  if (!failed && !process.env.KEEP) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* left for the OS */ }
  process.exit(failed ? 1 : 0);
})();
