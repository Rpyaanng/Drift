// YouTube playing in Surf (main.js DRIFT_TESTYT): each second, how far ahead the video is buffered, its stalls and dropped
// frames, and how long its video requests took, beside how late Drift's main process runs and each process's CPU. Not a
// pass/fail test: it prints a summary per video, and the full log is in <dir>/shots/log.txt. Needs the internet.
// The profile (and uBlock Origin in it) is kept between runs in %TEMP%/drift-yt-test, so only the first run downloads uBO.
//   node scripts/test-yt.js [seconds per video] [--webview] [--noblock] [--ids=a,b] [--root=<a Drift checkout>] [--profile=<a userData folder>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');       // (in plain Node this is the path to Electron itself)

const args = process.argv.slice(2);
const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const secs = +args.find((x) => /^\d+$/.test(x)) || 60;
const ROOT = path.resolve(opt('root') || path.join(__dirname, '..'));
const dir = path.join(os.tmpdir(), 'drift-yt-test'), shots = path.join(dir, 'shots-' + Date.now());
fs.mkdirSync(dir, { recursive: true });

const env = { ...process.env, DRIFT_USERDATA: path.resolve(opt('profile') || path.join(dir, 'profile')), DRIFT_SHOTS: shots, DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300',
  DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_TESTYT: String(secs) };
if (!args.includes('--webview')) env.DRIFT_TESTGPU = '1';
if (args.includes('--noblock')) env.DRIFT_TESTYT_OFF = '1';
if (opt('ids')) env.DRIFT_TESTYT_IDS = opt('ids');
delete env.ELECTRON_RUN_AS_NODE;

console.log(`running ${ROOT} in ${shots}`);
const p = spawn(electron, [ROOT], { env, stdio: ['ignore', 'pipe', 'ignore'] });
p.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (/^\[yt\] (start|SUMMARY|.* page not found|yt test failed)/.test(l)) console.log(l); });
const ids = (opt('ids') || 'a,b').split(',').length;
const t = setTimeout(() => { console.log('timed out'); try { p.kill(); } catch { /* gone */ } }, (60 + ids * (secs + 60)) * 1000);
p.on('exit', (code) => {
  clearTimeout(t);
  console.log(`exit ${code}; log: ${path.join(shots, 'log.txt')}`);
});
