// Options' microphone test (renderer/chat.js, renderer/mic.js) in one hidden copy of Drift, with Chromium's beeping stand-in
// microphone: Test opens it with strong noise suppression (RNNoise) and both bars move, picking Standard reopens it with
// that, and Stop closes it.
//   node scripts/test-mic.js            (KEEP=1 keeps the folder)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-mic-'));
  const shots = path.join(dir, 'shots');
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, 'host'), DRIFT_SHOTS: shots, DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300', DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_TESTMIC: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve) => {
    const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 60000);
    p.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  let R = {};
  try { R = JSON.parse(fs.readFileSync(path.join(shots, 'mic.json'), 'utf8')); } catch { ok(false, `Drift wrote what it saw (exit ${code})`); }
  if (R.error) ok(false, 'no error: ' + R.error);
  ok(R.idle === null, 'the microphone is closed until Test is pressed');
  ok(R.opens, 'Test opens the microphone with strong noise suppression (RNNoise)');
  const s = R.strong || {};
  ok(s.btn === 'Stop' && /Faint/.test(s.note || ''), `...the button says Stop and the note explains both bars ("${s.btn}", "${s.note}")`);
  ok(s.max && s.max.raw > 0.2 && s.max.out > 0.2, `...both bars move (loudest: microphone ${s.max && s.max.raw}, after suppression ${s.max && s.max.out})`);
  ok(R.reopened, 'picking Standard reopens it with that');
  const t = R.standard || {};
  ok(t.max && t.max.out > 0.2 && /^Green/.test(t.note || ''), `...its bar moves, and the note only speaks of one (${t.max && t.max.out}, "${t.note}")`);
  const x = R.stopped || {};
  ok(x.info === null && x.btn === 'Test' && /Nothing is sent/.test(x.note || ''), `Stop closes it (${JSON.stringify(x)})`);
  if (!process.env.KEEP && !failed) fs.rmSync(dir, { recursive: true, force: true }); else console.log(`\nfiles in ${dir}`);
  console.log(failed ? `\n${failed} check(s) failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
