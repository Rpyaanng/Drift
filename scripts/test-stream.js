// A hub's media stream, with two real copies of Drift on this PC (each with its own DRIFT_USERDATA). Picking a video
// with no hub just plays it. In a hub with nothing on, picking a video or music shares it straight away. While someone
// else's is on, a vote card comes over everyone's video (pressed for real here): no keeps what's on, yes switches.
// Everyone online in the hub is pulled into whatever is on, and disconnecting from the hub is how you get off it.
// Needs ffmpeg on the PATH (for the test clips).
//   node scripts/test-stream.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const electron = require('electron');       // (in plain Node this is the path to Electron itself)

const ROOT = path.resolve(__dirname, '..');
const ROLES = ['host', 'guest'];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-stream-test-')), clips = path.join(dir, 'clips');
fs.mkdirSync(clips);
for (const [f, c] of [['a.mp4', 'red'], ['b.mp4', 'blue']]) {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=640x360:d=120`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(clips, f)]);
}
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120', path.join(clips, 'c.wav')]);

function runDrift(role) {
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, role), DRIFT_SHOTS: path.join(dir, 'shots-' + role), DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300',
    DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_SHARE_LOCAL: '1', DRIFT_TESTSTREAM: role, DRIFT_TESTCODE: path.join(dir, 'code.txt'), DRIFT_TESTSTREAM_DIR: clips, DRIFT_TESTSTREAM_OUT: path.join(dir, 'out') };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 300000);
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
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
