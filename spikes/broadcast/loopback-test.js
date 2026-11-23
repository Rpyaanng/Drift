// Spike A, part 2 (throwaway): does loopback.ps1 (Windows process loopback through a PowerShell helper) capture only
// what it should? Two other programs play quiet tones: "game" at 1,000 Hz and "drift" at 440 Hz (standing in for the
// voice room). Then:
//   include game  -> only 1,000 Hz expected  (per-application sound, for broadcasting a window)
//   exclude drift -> 1,000 Hz but not 440 Hz (whole PC minus Drift, for broadcasting a monitor)
// Run: node spikes/broadcast/loopback-test.js     (plays two quiet tones on the default output for about 20 s)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.tmpdir(), 'drift-broadcast-spike-pages');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (args, opts) => spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, ...opts });

function wav(file, hz, secs) {
  const rate = 48000, n = rate * secs, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 3000), 44 + i * 2);
  fs.writeFileSync(file, b);
}
function player(hz) {
  const f = path.join(DIR, `tone${hz}.wav`); wav(f, hz, 60);
  return ps(['-Command', `$p = New-Object System.Media.SoundPlayer '${f}'; $p.PlayLooping(); Start-Sleep 60`]);
}
// Goertzel: the level of one frequency in a block of mono samples, in dBFS
function level(samples, hz, rate = 48000) {
  const w = (2 * Math.PI * hz) / rate, c = 2 * Math.cos(w); let s1 = 0, s2 = 0;
  for (const x of samples) { const s = x + c * s1 - s2; s2 = s1; s1 = s; }
  const p = s1 * s1 + s2 * s2 - c * s1 * s2;
  return +(20 * Math.log10((2 * Math.sqrt(Math.max(p, 1e-12))) / samples.length)).toFixed(1);
}
async function capture(pid, mode) {
  const h = ps(['-File', path.join(__dirname, 'loopback.ps1'), '-TargetPid', String(pid), '-Mode', mode]);
  const chunks = []; let err = '', readyAt = 0, firstAudioAt = 0;
  const started = Date.now();
  h.stderr.on('data', (d) => { err += d; if (!readyAt && err.includes('READY')) readyAt = Date.now(); });
  h.stdout.on('data', (d) => { if (!firstAudioAt) firstAudioAt = Date.now(); chunks.push(d); });
  const t0 = Date.now();
  while (!readyAt && Date.now() - t0 < 15000 && h.exitCode === null) await wait(50);
  if (!readyAt) { h.kill(); return { error: (err.trim().split('\n').slice(-3).join(' ') || 'no READY').slice(0, 400) }; }
  const before = Buffer.concat(chunks).length;
  await wait(3000);
  h.kill();
  const all = Buffer.concat(chunks), pcm = all.subarray(before - (before % 4));
  const mono = new Float32Array(pcm.length / 4);
  for (let i = 0; i < mono.length; i++) mono[i] = (pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) / 65536;
  const stat = (err.match(/STAT [^\r\n]+/g) || []).pop() || '';
  return { secondsCaptured: +(mono.length / 48000).toFixed(2), helperStartMs: readyAt - started, game1000Hz: level(mono, 1000), drift440Hz: level(mono, 440), electron1500Hz: level(mono, 1500), floor700Hz: level(mono, 700), stat };
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const game = player(1000), drift = player(440);
  await wait(2500);
  const res = {
    includeGame: await capture(game.pid, 'include'),
    excludeDrift: await capture(drift.pid, 'exclude'),
    includeDrift: await capture(drift.pid, 'include'),
    // Electron plays sound from its audio service, a child process: excluding the main process's tree must cover it
    excludeRealElectron: await (async () => {
      const app = spawn(require('electron'), [path.join(__dirname, 'tone-app.js')], { windowsHide: true });
      await wait(3000);
      const r = { exclude: await capture(app.pid, 'exclude'), includeAsControl: await capture(app.pid, 'include') };
      app.kill();
      return r;
    })(),
    note: 'dBFS; near floor700Hz means absent. Both tones play at about -21 dBFS before Windows mixes them.',
  };
  console.log(JSON.stringify(res, null, 2));
  game.kill(); drift.kill();
  process.exit(0);
})();
