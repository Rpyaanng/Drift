// A hub's Surf stream (docs/plans/streams.md), with two real copies of Drift on this PC (each with its own DRIFT_USERDATA).
// The host's Drift runs the hub, and the hub's own browser in a profile of its own: the host's Surf tab shows it, with their own
// browser put away. The guest's Surf tab is a picture of it, streamed from the host's PC through the hub's relay, with the
// certificate checked; the guest clicks a link and types over the picture, and the host's copy follows. A flood of input is
// slowed. Downloads wait for the host's Save or Refuse; a pop-up opens as a tab, file pickers and page boxes don't open, and a
// local address that wasn't allowed isn't reached. A video plays on the media stream meanwhile (if ffmpeg is on the PATH).
// The host disconnecting from their own hub gets their own browser back while the stream carries on for the guest.
// (The hub tampering with the stream's signed setup messages is checked in plain Node: scripts/test-chat.js.)
//   node scripts/test-surf-stream.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const electron = require('electron');       // (in plain Node this is the path to Electron itself)

const ROOT = path.resolve(__dirname, '..');
const ROLES = ['host', 'guest'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-surf-test-'));
let clip = '';
try {
  fs.mkdirSync(path.join(dir, 'clips'));
  clip = path.join(dir, 'clips', 'a.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=120', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
} catch { clip = ''; console.log('(no ffmpeg: the media stream part is left out)'); }

function runDrift(role) {
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, role), DRIFT_SHOTS: path.join(dir, 'shots-' + role), DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300',
    DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_SHARE_LOCAL: '1', DRIFT_TESTSS: role, DRIFT_TESTCODE: path.join(dir, 'code.txt'), DRIFT_TESTSS_OUT: path.join(dir, 'out'), DRIFT_TESTSS_CLIP: clip };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 420000);
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
  console.log(failed ? `${failed} failed (logs: ${dir}\\shots-*\\log.txt and chat.log)` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
