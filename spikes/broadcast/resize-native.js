// Spike D, part 2 (throwaway): quirks.js found an Electron window's capture drops to ~1 fps after the window is resized,
// though the window keeps painting. Is that Windows Graphics Capture in general, or only Electron windows? This
// captures an ordinary WinForms window (changing colour 30 times a second) that resizes itself after 5 s.
//   electron spikes/broadcast/resize-native.js
const { app, BrowserWindow, session, desktopCapturer } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = process.env.QUIRKS_OUT || '';
const DIR = path.join(os.tmpdir(), 'drift-broadcast-spike-pages');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), 'drift-broadcast-spike'));
// QUIRKS_DISABLE=FeatureA,FeatureB: try Chromium's capture switches, e.g. AllowWgcWindowZeroHz, WebRtcAllowWgcWindowCapturer
if (process.env.QUIRKS_DISABLE) app.commandLine.appendSwitch('disable-features', process.env.QUIRKS_DISABLE);

const FORM = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'resize-native-target'; $f.StartPosition = 'Manual'; $f.Left = 60; $f.Top = 60; $f.Width = 800; $f.Height = 450; $f.TopMost = $true
$box = New-Object System.Windows.Forms.Panel; $box.Width = 60; $box.Height = 60; $box.BackColor = 'White'; $f.Controls.Add($box)
$script:n = 0
$t = New-Object System.Windows.Forms.Timer; $t.Interval = 33
$t.Add_Tick({ $script:n++; $f.BackColor = [System.Drawing.Color]::FromArgb(($script:n * 7) % 255, 80, 120); $box.Left = ($script:n * 9) % 700; if ($script:n -eq 150) { $f.Width = 1200; $f.Height = 700 } if ($script:n -eq 450) { $f.Close() } })
$t.Start()
[System.Windows.Forms.Application]::Run($f)`;

const VIDEO = process.env.QUIRKS_VIDEO || '{ frameRate: 30 }';       // the getDisplayMedia video constraints, e.g. true
const VIEWER = `<!doctype html><video id=v muted autoplay></video><script>
const { ipcRenderer } = require('electron');
let frames = 0, size = '';
(async () => {
  const s = await navigator.mediaDevices.getDisplayMedia({ video: ${VIDEO}, audio: false });
  const v = document.getElementById('v'); v.srcObject = s;
  const tick = (_n, m) => { frames++; size = m.width + 'x' + m.height; v.requestVideoFrameCallback(tick); };
  v.requestVideoFrameCallback(tick);
})();
window.count = () => { const r = { frames, size }; frames = 0; return r; };
</script>`;

app.whenReady().then(async () => {
  const form = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', FORM], { windowsHide: false });
  let src = null;
  for (let i = 0; i < 40 && !src; i++) { await wait(250); src = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })).find((s) => s.name === 'resize-native-target'); }
  if (!src) { process.stderr.write('form never appeared\n'); app.exit(1); return; }
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => cb({ video: src }));
  fs.mkdirSync(DIR, { recursive: true }); const f = path.join(DIR, 'resize-viewer.html'); fs.writeFileSync(f, VIEWER);
  const viewer = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await viewer.loadFile(f);
  const res = [];
  for (let s = 0; s < 14; s++) { await wait(1000); res.push(await viewer.webContents.executeJavaScript('count()')); }
  const txt = JSON.stringify({ note: 'frames per second, one entry per second; the form resizes about 5 s after it opens', perSecond: res.map((r) => `${r.frames}@${r.size}`) }, null, 2);
  if (OUT) fs.writeFileSync(OUT, txt);
  process.stdout.write(txt + '\n');
  form.kill(); app.exit(0);
});
