// Spike D of docs/plans/broadcast.md (throwaway): what an application capture does when the window misbehaves.
// Captures a window drawing a moving pattern (Windows Graphics Capture, through setDisplayMediaRequestHandler, as Drift
// would) and counts the frames that arrive while it is: normal, covered by another window, minimised, moved half off
// the screen, resized, and finally closed (does the track end, and how fast?).
//
//   electron spikes/broadcast/quirks.js       (windows appear at the top left of the main monitor for about 25 s)
//
// Not automated here, and still to check by hand: an exclusive-fullscreen game (WGC may give black), the yellow capture
// border on Windows 10 (Windows 11 lets Chromium turn it off), and DRM video (black, by design).
const { app, BrowserWindow, session, desktopCapturer, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = process.env.QUIRKS_OUT || '';
const DIR = path.join(os.tmpdir(), 'drift-broadcast-spike-pages');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), 'drift-broadcast-spike'));
function page(name, body) { fs.mkdirSync(DIR, { recursive: true }); const f = path.join(DIR, name + '.html'); fs.writeFileSync(f, `<!doctype html><body style="margin:0;background:#000">${body}`); return f; }

const MOTION = `<canvas id=c width=800 height=450></canvas><script>
const c = document.getElementById('c'), g = c.getContext('2d'); window.t = 0;
setInterval(() => { t++; g.fillStyle = 'hsl(' + (t * 4 % 360) + ',70%,40%)'; g.fillRect(0, 0, 800, 450); g.fillStyle = '#fff'; g.fillRect((t * 9) % 800, 200, 40, 40); }, 1000 / 30);
</script>`;

const VIEWER = `<video id=v muted autoplay></video><script>
const { ipcRenderer } = require('electron');
let frames = 0, track = null, endedAt = 0, size = '';
ipcRenderer.on('start', async () => {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    track = s.getVideoTracks()[0];
    track.onended = () => { endedAt = Date.now(); ipcRenderer.send('ended', endedAt); };
    track.onmute = () => ipcRenderer.send('log', 'track muted');
    track.onunmute = () => ipcRenderer.send('log', 'track unmuted');
    const v = document.getElementById('v'); v.srcObject = s;
    const tick = (_n, m) => { frames++; size = m.width + 'x' + m.height; v.requestVideoFrameCallback(tick); };
    v.requestVideoFrameCallback(tick);
    ipcRenderer.send('started');
  } catch (e) { ipcRenderer.send('log', 'capture failed: ' + e.message); }
});
// Ask for the same window again and swap the new track in, as Switch source would (replaceTrack keeps viewers connected)
window.recapture = async () => {
  const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  const old = track; track = s.getVideoTracks()[0]; track.onended = old.onended; old.onended = null; old.stop();
  document.getElementById('v').srcObject = s;
  const v = document.getElementById('v'), tick = (_n, m) => { frames++; size = m.width + 'x' + m.height; v.requestVideoFrameCallback(tick); };
  v.requestVideoFrameCallback(tick);
};
window.count = () => { const r = { frames, size, readyState: track && track.readyState, muted: track && track.muted }; frames = 0; return r; };
</script>`;

app.whenReady().then(async () => {
  const log = (...a) => process.stderr.write(a.join(' ') + '\n');
  const wa = screen.getPrimaryDisplay().workArea;
  const target = new BrowserWindow({ x: wa.x + 40, y: wa.y + 40, width: 800, height: 450, useContentSize: true, title: 'quirks-target', webPreferences: { backgroundThrottling: false } });
  await target.loadFile(page('quirks-target', MOTION));
  await wait(500);
  const id = target.getMediaSourceId();
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }).then((src) => cb({ video: src.find((s) => s.id === id) })).catch(() => cb({}));
  });
  const viewer = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await viewer.loadFile(page('quirks-viewer', VIEWER));
  ipcMain.on('log', (_e, m) => log(m));
  const events = [];
  ipcMain.on('log', (_e, m) => events.push({ at: Date.now(), m }));
  const started = new Promise((r) => ipcMain.once('started', r));
  viewer.webContents.send('start');
  await started;
  await wait(1500);
  const count = () => viewer.webContents.executeJavaScript('count()');
  await count();
  const res = {};
  const phase = async (name, ms = 3000) => { await count(); const t0 = await target.webContents.executeJavaScript('t').catch(() => null); await wait(ms); const c = await count(); const t1 = await target.webContents.executeJavaScript('t').catch(() => null);
    res[name] = { targetPaintsPerSec: t0 === null || t1 === null ? null : +(((t1 - t0) * 1000) / ms).toFixed(1), fps: +((c.frames * 1000) / ms).toFixed(1), size: c.size, track: c.readyState, muted: c.muted }; };

  await phase('normal');
  const cover = new BrowserWindow({ x: wa.x + 20, y: wa.y + 20, width: 900, height: 550, alwaysOnTop: true, backgroundColor: '#336', title: 'cover' });
  await wait(500); await phase('coveredByAnotherWindow'); cover.destroy();
  target.minimize(); await wait(500); await phase('minimised');
  target.restore(); await wait(800); await phase('restored');
  target.setPosition(wa.x + wa.width - 400, wa.y + 40); await wait(500); await phase('halfOffScreen');
  target.setPosition(wa.x + 40, wa.y + 40); target.setContentSize(1200, 700); await wait(500); await phase('resizedTo1200x700');
  await phase('resizedThen3sMore'); await phase('resizedThen6sMore');
  target.webContents.invalidate(); await phase('afterRepaintRequest');
  await viewer.webContents.executeJavaScript('recapture()'); await wait(500); await phase('afterRecapture');
  target.setContentSize(700, 400); await wait(500); await phase('resizedAgainSmaller');
  const closedAt = Date.now();
  const ended = new Promise((r) => { ipcMain.once('ended', (_e, at) => r(at)); setTimeout(() => r(0), 5000); });
  target.destroy();
  const at = await ended;
  res.closed = at ? { trackEndedAfterMs: at - closedAt } : { trackEnded: 'NO (waited 5 s)', ...(await count()) };
  res.events = events.map((e) => e.m);
  const txt = JSON.stringify(res, null, 2);
  if (OUT) fs.writeFileSync(OUT, txt);
  process.stdout.write(txt + '\n');
  app.exit(0);
});
