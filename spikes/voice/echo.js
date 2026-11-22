// Spike 2 of docs/plans/voice-and-chat.md (throwaway): while you're in a call with speakers on, does Drift's own
// playback leak into your microphone, so friends hear the video? Chromium's echo canceller removes what Chromium
// itself plays, but Drift plays sound from other windows (each scene window is its own renderer process), and
// converted sound comes from ffmpeg as an MP3 stream over a local port. This plays a speech-like noise through the
// speakers in each of those ways, with echo cancelling off and on, and measures how much of it the microphone picks up.
//
//   electron spikes/voice/echo.js            ECHO_OUT=Realtek ECHO_MIC=Snowball pick devices by part of their name
//   ECHO_AUTO=out.json                       write the numbers there (the log goes to out.json.log)
//   ECHO_DEFAULT=1                           make ECHO_OUT Windows' default output for the run (restored after), and
//                                            play to the default device as Drift does, instead of choosing a device
//   ECHO_TRIALS=2                            how many times to measure each case
// It plays about a minute of noise through the speakers, not too loud.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const AUTO = process.env.ECHO_AUTO || path.join(os.tmpdir(), 'drift-echo.json');
const OUT = process.env.ECHO_OUT || 'Speakers', MIC = process.env.ECHO_MIC || '';
const FFMPEG = path.join(__dirname, '..', '..', 'vendor', 'ffmpeg.exe');
const DEFAULT = !!process.env.ECHO_DEFAULT, TRIALS = +process.env.ECHO_TRIALS || 2;
const psFile = (...args) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'default-output.ps1'), ...args], { windowsHide: true, encoding: 'utf8' }).trim();
let restore = '';
const putBack = () => { if (restore) { try { psFile('-Set', restore); } catch { /* tried */ } restore = ''; } };
process.on('exit', putBack);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.writeFileSync(AUTO + '.log', '');
const log = (...a) => { fs.appendFileSync(AUTO + '.log', a.join(' ') + '\n'); console.log(...a); };
app.setPath('userData', path.join(os.tmpdir(), 'drift-echo-spike'));

// Nine seconds of noise shaped like speech: a few syllables a second, quieter at the top.
function noiseWav(file) {
  const rate = 48000, n = rate * 9, data = Buffer.alloc(n * 2);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate, env = Math.max(0, Math.sin(2 * Math.PI * 3.3 * t)) ** 2 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.4 * t));
    lp += 0.25 * ((Math.random() * 2 - 1) - lp);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, lp * env * 1.6)) * 32767 * 0.5), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

// A blank page from a file: a data: page isn't a secure context, so it has no microphone.
function page(name) {
  const f = path.join(app.getPath('userData'), name + '.html');
  fs.writeFileSync(f, `<!doctype html><meta charset="utf-8"><title>${name}</title><body style="background:#15171c;color:#dde;font:13px system-ui">${name}</body>`);
  return f;
}
function win(name) {
  const w = new BrowserWindow({ width: 320, height: 120, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  w.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  w.webContents.session.setPermissionCheckHandler(() => true);
  w.webContents.on('console-message', (e) => log(`[${name}] ${e.message}`));
  w.loadFile(page(name));
  return w;
}
const js = (w, code) => w.webContents.executeJavaScript(code);

// Runs in a window: play a URL through the chosen output device.
const PLAYER = `
  window.play = async (url, out) => {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const d = devs.find((x) => x.kind === 'audiooutput' && x.label.includes(out));
    if (window.el) window.el.pause();
    window.el = new Audio(url); window.el.volume = 1;
    if (d && out !== 'default') await window.el.setSinkId(d.deviceId);
    await window.el.play();
    return out === 'default' ? 'default: ' + ((devs.find((x) => x.kind === 'audiooutput' && x.deviceId === 'default') || {}).label || '?') : d ? d.label : 'default (' + out + ' not found)';
  };
  window.stop = () => { if (window.el) { window.el.pause(); window.el = null; } };
`;
// Runs in the call window: the microphone, with or without echo cancelling, and its level.
const CALL = PLAYER + `
  window.devices = async () => (await navigator.mediaDevices.enumerateDevices()).map((d) => d.kind + ': ' + d.label);
  window.openMic = async (aec, mic) => {
    if (window.mic) window.mic.getTracks().forEach((t) => t.stop());
    const devs = await navigator.mediaDevices.enumerateDevices();
    const d = mic && devs.find((x) => x.kind === 'audioinput' && x.label.includes(mic));
    window.mic = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: d ? { exact: d.deviceId } : undefined, echoCancellation: aec, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    window.ctx = window.ctx || new AudioContext();
    const an = window.ctx.createAnalyser(); an.fftSize = 2048;
    window.ctx.createMediaStreamSource(window.mic).connect(an);
    const buf = new Float32Array(an.fftSize);
    window.acc = { sum: 0, n: 0 };
    clearInterval(window.tick);
    window.tick = setInterval(() => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; window.acc.sum += s / buf.length; window.acc.n++; }, 40);
    const t = window.mic.getAudioTracks()[0];
    return { label: t.label, settings: t.getSettings() };
  };
  window.reset = () => { window.acc = { sum: 0, n: 0 }; };
  window.level = () => +(10 * Math.log10(window.acc.sum / Math.max(1, window.acc.n) + 1e-12)).toFixed(1);
`;

app.whenReady().then(async () => {
  const res = { when: new Date().toISOString(), chrome: process.versions.chrome, cases: {} };
  try {
    if (DEFAULT) {
      const id = psFile('-Name', OUT);
      if (!id) throw new Error('no output called ' + OUT);
      restore = psFile(); res.defaultWas = restore;
      psFile('-Set', id); await wait(1000);
    }
    const sink = DEFAULT ? 'default' : OUT;
    const wav = path.join(app.getPath('userData'), 'noise.wav');
    fs.mkdirSync(path.dirname(wav), { recursive: true });
    noiseWav(wav);
    // The same MP3 conversion Drift's local server does for sound the player can't decode.
    const srv = http.createServer((req, res2) => {
      const kid = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', wav, '-vn', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      res2.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      kid.stdout.pipe(res2); req.on('close', () => { try { kid.kill(); } catch { /* gone */ } });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const mp3 = `http://127.0.0.1:${srv.address().port}/a.mp3`, file = 'file:///' + wav.replace(/\\/g, '/');

    const call = win('call'), scene = win('scene');
    await Promise.all([call, scene].map((w) => new Promise((r) => w.webContents.once('did-finish-load', r))));
    await js(call, CALL + ";0"); await js(scene, PLAYER + ";0");       // (the scripts end in a function, which can't be sent back)
    await js(call, 'navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()))');       // so devices have names
    res.devices = await js(call, 'devices()');

    const sources = [
      ['sameWindow', call, file],          // the call's own renderer plays it
      ['otherWindow', scene, file],        // a scene window plays it (another renderer process), as Drift's videos do
      ['otherWindowFfmpegMp3', scene, mp3],       // ...and converted by ffmpeg, as Drift does for Dolby/DTS sound
    ];
    for (const aec of [false, true]) {
      const key = aec ? 'echoCancellationOn' : 'echoCancellationOff';
      res.cases[key] = { mic: await js(call, `openMic(${aec}, ${JSON.stringify(MIC)})`) };
      await wait(1500); await js(call, 'reset()'); await wait(2500);
      res.cases[key].roomDb = await js(call, 'level()');
      for (const [name, w, url] of sources) {
        const dbs = [];
        let dev = '';
        for (let k = 0; k < TRIALS; k++) {
          dev = await js(w, `play(${JSON.stringify(url)}, ${JSON.stringify(sink)})`);
          await wait(3500);       // the echo canceller needs a few seconds to learn the room
          await js(call, 'reset()'); await wait(4000);
          dbs.push(await js(call, 'level()'));
          await js(w, 'stop()'); await wait(1200);
        }
        res.cases[key][name] = { output: dev, micDb: dbs, aboveRoomDb: dbs.map((db) => +(db - res.cases[key].roomDb).toFixed(1)) };
        log(key, name, JSON.stringify(res.cases[key][name]));
      }
    }
    srv.close();
  } catch (e) { res.error = String(e && e.stack || e); }
  putBack();
  if (DEFAULT) res.defaultAfter = psFile();
  fs.writeFileSync(AUTO, JSON.stringify(res, null, 2));
  app.quit();
});
