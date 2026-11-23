// Checks bc-sound.js (the real helper) against a quiet tone from another process: include it, and exclude this one.
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const snd = require('../../bc-sound');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const f = path.join(os.tmpdir(), 'drift-tone1000.wav'), rate = 48000, n = rate * 30, b = Buffer.alloc(44 + n * 2);
b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / rate) * 100), 44 + i * 2);
fs.writeFileSync(f, b);
function level(s, hz) { const w = (2 * Math.PI * hz) / rate, c = 2 * Math.cos(w); let s1 = 0, s2 = 0; for (const x of s) { const v = x + c * s1 - s2; s2 = s1; s1 = v; } const p = s1 * s1 + s2 * s2 - c * s1 * s2; return +(20 * Math.log10((2 * Math.sqrt(Math.max(p, 1e-12))) / s.length)).toFixed(1); }
async function grab(what) {
  const chunks = []; let why = null, readyAt = 0; const t0 = Date.now();
  const h = snd.start(what, { onPcm: (d) => chunks.push(Buffer.from(d)), onReady: () => { readyAt = Date.now() - t0; }, onEnd: (e) => { why = e; } });
  await wait(4000); h.stop();
  const pcm = Buffer.concat(chunks), m = new Float32Array(pcm.length / 4);
  for (let i = 0; i < m.length; i++) m[i] = (pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) / 65536;
  return { readyMs: readyAt, secs: +(m.length / rate).toFixed(2), k1000: level(m, 1000), k700: level(m, 700), ended: why };
}
(async () => {
  const pl = spawn('powershell.exe', ['-NoProfile', '-Command', `$p = New-Object System.Media.SoundPlayer '${f}'; $p.PlayLooping(); Start-Sleep 40`], { windowsHide: true });
  await wait(2500);
  console.log('include tone :', JSON.stringify(await grab({ pid: pl.pid })));
  console.log('exclude self :', JSON.stringify(await grab({ pid: process.pid, exclude: true })));
  console.log('exclude tone :', JSON.stringify(await grab({ pid: pl.pid, exclude: true })));
  console.log('bad window   :', JSON.stringify(await grab({ hwnd: 1 })));
  pl.kill(); process.exit(0);
})();
