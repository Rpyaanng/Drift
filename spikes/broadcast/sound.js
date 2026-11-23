// Spike A of docs/plans/broadcast.md (throwaway): which sound can a broadcast capture without the voice room echoing?
// Electron 45's setDisplayMediaRequestHandler only offers audio: 'loopback' (the whole PC's output). Chromium also has
// a getDisplayMedia constraint, restrictOwnAudio, meant to leave out the capturing browser's own sound. On Windows that
// should mean process loopback with EXCLUDE_TARGET_PROCESS_TREE on Chromium's own process, i.e. "whole PC minus Drift".
// This checks whether it really does, in Electron.
//
//   electron spikes/broadcast/sound.js        (plays two quiet tones on the default output for about 12 s)
//
// A Drift window plays 440 Hz, standing in for the voice room. Another program (PowerShell's SoundPlayer) plays
// 1,000 Hz, standing in for a game or Spotify. A capture window records loopback with and without restrictOwnAudio,
// and measures how loud each tone is in what it captured. Results go to stdout and SOUND_OUT.
const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const OUT = process.env.SOUND_OUT || '';
const DIR = path.join(os.tmpdir(), 'drift-broadcast-spike-pages');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), 'drift-broadcast-spike'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function wav(file, hz, secs) {       // 16-bit mono 48 kHz sine, quiet
  const rate = 48000, n = rate * secs, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 3000), 44 + i * 2);
  fs.writeFileSync(file, b);
}
function page(name, body) { fs.mkdirSync(DIR, { recursive: true }); const f = path.join(DIR, name + '.html'); fs.writeFileSync(f, `<!doctype html><body><script>${body}</script>`); return f; }

const VOICE = `const c = new AudioContext(), o = c.createOscillator(), g = c.createGain(); o.frequency.value = 440; g.gain.value = 0.1; o.connect(g).connect(c.destination); o.start();`;

const CAPTURE = `
const { ipcRenderer } = require('electron');
// How loud each tone is in a captured stream, in dB relative to full scale, from an FFT averaged over 2 s
async function measure(audio) {
  const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio });
  const t = s.getAudioTracks()[0];
  if (!t) { s.getTracks().forEach((x) => x.stop()); return { error: 'no audio track' }; }
  const settings = t.getSettings();
  const c = new AudioContext({ sampleRate: 48000 }), a = c.createAnalyser(); a.fftSize = 8192; a.smoothingTimeConstant = 0;
  c.createMediaStreamSource(new MediaStream([t])).connect(a);
  await new Promise((r) => setTimeout(r, 700));
  const bins = new Float32Array(a.frequencyBinCount), sum = { 440: 0, 1000: 0, floor: 0 }; let k = 0;
  const at = (hz) => { const i = Math.round((hz * a.fftSize) / c.sampleRate); return Math.max(bins[i - 1], bins[i], bins[i + 1]); };
  const t0 = performance.now();
  while (performance.now() - t0 < 2000) { a.getFloatFrequencyData(bins); sum[440] += at(440); sum[1000] += at(1000); sum.floor += at(700); k++; await new Promise((r) => setTimeout(r, 50)); }
  s.getTracks().forEach((x) => x.stop()); c.close();
  const db = (x) => +(x / k).toFixed(1);
  return { drift440Hz: db(sum[440]), otherProgram1000Hz: db(sum[1000]), floor700Hz: db(sum.floor), restrictOwnAudioSetting: settings.restrictOwnAudio, suppressLocalAudioPlayback: settings.suppressLocalAudioPlayback };
}
ipcRenderer.on('go', async () => {
  const res = {};
  try {
    res.supported = Object.keys(navigator.mediaDevices.getSupportedConstraints()).filter((k) => /restrict|suppress|system/i.test(k));
    res.loopback = await measure(true);
    res.loopbackRestrictOwnAudio = await measure({ restrictOwnAudio: true });
    res.loopbackSuppressLocalPlayback = await measure({ suppressLocalAudioPlayback: true });
  } catch (e) { res.error = e.message; }
  ipcRenderer.send('done', res);
});
`;

app.whenReady().then(async () => {
  const tone = path.join(DIR, 'tone1000.wav');
  fs.mkdirSync(DIR, { recursive: true }); wav(tone, 1000, 30);
  const other = spawn('powershell.exe', ['-NoProfile', '-Command', `$p = New-Object System.Media.SoundPlayer '${tone}'; $p.PlayLooping(); Start-Sleep 25`], { windowsHide: true });
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((src) => cb({ video: src[0], audio: 'loopback' })).catch(() => cb({}));
  });
  const voice = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await voice.loadFile(page('voice-tone', VOICE));
  const cap = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await cap.loadFile(page('capture', CAPTURE));
  await wait(1500);
  ipcMain.once('done', (_e, res) => {
    res.note = 'dBFS of each tone in the captured audio; within a few dB of floor700Hz means it was not captured';
    const txt = JSON.stringify(res, null, 2);
    if (OUT) fs.writeFileSync(OUT, txt);
    process.stdout.write(txt + '\n');
    other.kill(); app.exit(0);
  });
  cap.webContents.send('go');
});
