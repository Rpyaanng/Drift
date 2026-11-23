// Spike E of docs/plans/broadcast.md (throwaway): the pointer overlay on the broadcaster's screen.
// A transparent, click-through, topmost, content-protected window draws a magenta square over a "game" window. Checks:
//   1. Windows reports WDA_EXCLUDEFROMCAPTURE (0x11) for it, not the older WDA_MONITOR (0x1, a black box in captures)
//   2. a capture of the monitor doesn't contain it (and does, as a control, with content protection off)
//   3. a click on it reaches the game underneath           (moves your mouse for a moment and puts it back)
//   4. it stays above another always-on-top window
//   5. a window-following helper (DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS), polled 10 times a second, as
//      §9.2 plans) keeps up while the game window is dragged around, including onto another monitor
//
//   electron spikes/broadcast/overlay.js      (windows appear on the main monitor, then move across monitors, ~20 s)
const { app, BrowserWindow, session, desktopCapturer, screen, ipcMain } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = process.env.OVERLAY_OUT || '';
const DIR = path.join(os.tmpdir(), 'drift-broadcast-spike-pages');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), 'drift-broadcast-spike'));
function page(name, html) { fs.mkdirSync(DIR, { recursive: true }); const f = path.join(DIR, name + '.html'); fs.writeFileSync(f, html); return f; }
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true }).toString().trim();
const hwndOf = (w) => { const b = w.getNativeWindowHandle(); return b.length === 8 ? b.readBigUInt64LE().toString() : String(b.readUInt32LE()); };

const USER32 = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class U {
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct POINT { public int X, Y; }
}
'@
[U]::SetProcessDPIAware() | Out-Null
`;

// The window-following helper: prints "x y w h minimised" in physical pixels, 10 times a second
const FOLLOW = (hwnd) => `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class D {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
}
'@
[D]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null       # per-monitor v2: real pixels on every monitor
$h = [IntPtr]${hwnd}
while ($true) {
  $r = New-Object D+RECT
  [D]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null       # DWMWA_EXTENDED_FRAME_BOUNDS
  $t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  [Console]::Out.WriteLine("$t $($r.L) $($r.T) $($r.R - $r.L) $($r.B - $r.T) $([D]::IsIconic($h))")
  Start-Sleep -Milliseconds 100
}`;

const GAME = `<!doctype html><body style="margin:0;background:#0a0;font:20px sans-serif;color:#fff"><div id=n>clicks: 0</div><script>
let n = 0; addEventListener('mousedown', () => { n++; document.getElementById('n').textContent = 'clicks: ' + n; });
window.clicks = () => n;
</script>`;
const OVERLAY = `<!doctype html><body style="margin:0;background:transparent"><div style="position:absolute;left:100px;top:100px;width:120px;height:120px;background:#f0f"></div>`;
const GRAB = `<!doctype html><script>
// One frame of a capture of the screen, and the colour at a point in it (in the capture's own pixels)
window.colourAt = async (fx, fy) => {
  const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const t = s.getVideoTracks()[0], v = document.createElement('video'); v.muted = true; v.srcObject = s; await v.play();
  await new Promise((r) => setTimeout(r, 600));
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  const g = c.getContext('2d'); g.drawImage(v, 0, 0);
  const p = g.getImageData(Math.round(fx * c.width), Math.round(fy * c.height), 1, 1).data;
  t.stop();
  return { rgb: [p[0], p[1], p[2]], size: c.width + 'x' + c.height };
};
</script>`;

app.whenReady().then(async () => {
  const res = {};
  const d = screen.getPrimaryDisplay(), b = d.bounds;
  res.displays = screen.getAllDisplays().map((x) => ({ id: x.id, bounds: x.bounds, scale: x.scaleFactor, primary: x.id === d.id }));
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((src) => cb({ video: src.find((s) => s.display_id === String(d.id)) || src[0] })).catch(() => cb({}));
  });

  // the "game", and a second always-on-top window over it, to be sure the overlay sits above topmost windows too
  const game = new BrowserWindow({ x: b.x + 200, y: b.y + 200, width: 500, height: 400, useContentSize: true, frame: false, alwaysOnTop: true, title: 'overlay-game', webPreferences: { backgroundThrottling: false } });
  await game.loadFile(page('ov-game', GAME));
  const overlay = new BrowserWindow({ x: b.x + 200, y: b.y + 200, width: 500, height: 400, transparent: true, frame: false, focusable: false, skipTaskbar: true, resizable: false, hasShadow: false, show: false, webPreferences: { backgroundThrottling: false } });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  await overlay.loadFile(page('ov-overlay', OVERLAY));
  overlay.showInactive();
  const grab = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await grab.loadFile(page('ov-grab', GRAB));
  await wait(800);
  // the middle of the magenta square, as a fraction of the monitor
  const sq = { x: b.x + 200 + 160, y: b.y + 200 + 160 };
  const at = () => grab.webContents.executeJavaScript(`colourAt(${(sq.x - b.x) / b.width}, ${(sq.y - b.y) / b.height})`);
  const name = ({ rgb: [r, g, bl] }) => (r > 200 && g < 60 && bl > 200 ? 'magenta (overlay visible)' : g > 120 && r < 60 ? 'green (game, overlay not in capture)' : r < 20 && g < 20 && bl < 20 ? 'black (WDA_MONITOR-style box)' : `other ${r},${g},${bl}`);

  overlay.setContentProtection(false); await wait(400);
  const off = await at(); res.captureWithProtectionOff = { ...off, seen: name(off) };
  overlay.setContentProtection(true); await wait(400);
  const on = await at(); res.captureWithProtectionOn = { ...on, seen: name(on) };
  const aff = ps(USER32 + `$a = 0; [U]::GetWindowDisplayAffinity([IntPtr]${hwndOf(overlay)}, [ref]$a) | Out-Null; $a`);
  res.displayAffinity = { value: '0x' + (+aff).toString(16), meaning: +aff === 0x11 ? 'WDA_EXCLUDEFROMCAPTURE' : +aff === 1 ? 'WDA_MONITOR (black box)' : 'none' };

  // a real click on the square: does it reach the game? (cursor put back afterwards)
  const before = await game.webContents.executeJavaScript('clicks()');
  const phys = screen.dipToScreenPoint(sq);
  ps(USER32 + `$p = New-Object U+POINT; [U]::GetCursorPos([ref]$p) | Out-Null; [U]::SetCursorPos(${Math.round(phys.x)}, ${Math.round(phys.y)}) | Out-Null; Start-Sleep -Milliseconds 50; [U]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [U]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 100; [U]::SetCursorPos($p.X, $p.Y) | Out-Null`);
  await wait(300);
  res.clickReachedGame = (await game.webContents.executeJavaScript('clicks()')) > before;
  res.overlayAboveOtherTopmostWindow = off.rgb[0] > 200 && off.rgb[1] < 60;

  // ---- following the game window as it moves, including onto other monitors ----
  overlay.hide();
  const follow = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(FOLLOW(hwndOf(game)), 'utf16le').toString('base64')], { windowsHide: true });
  const reports = []; let buf = '';
  follow.stdout.on('data', (x) => { buf += x; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); const [t, X, Y, W, H, min] = l.split(' '); if (W) reports.push({ t: +t, r: { x: +X, y: +Y, width: +W, height: +H }, min: min === 'True' }); } });
  while (!reports.length) await wait(50);
  const truth = [];       // where the window really was (DIPs), when
  const others = screen.getAllDisplays().filter((x) => x.id !== d.id);
  const path_ = [];
  for (let k = 0; k <= 40; k++) path_.push({ x: b.x + 100 + k * 15, y: b.y + 150 + k * 5 });       // a drag across the main monitor
  for (const o of others) for (let k = 0; k <= 10; k++) path_.push({ x: o.bounds.x + 100 + k * 20, y: o.bounds.y + 150 });       // then each other monitor
  for (const p of path_) { game.setPosition(p.x, p.y); truth.push({ t: Date.now(), r: game.getBounds() }); await wait(50); }
  await wait(400);
  game.minimize(); await wait(500);
  res.helperSeesMinimised = reports.slice(-2).some((x) => x.min);
  follow.kill();
  // For each report, the error against where the window really was at that moment, after turning pixels into DIPs
  const errs = [], lags = [];
  for (const rp of reports) {
    if (rp.min) continue;       // a minimised window sits at -32000: nothing to follow
    const tr = [...truth].reverse().find((x) => x.t <= rp.t); if (!tr) continue;
    const dip = screen.screenToDipRect(null, rp.r);
    const e = Math.max(Math.abs(dip.x - tr.r.x), Math.abs(dip.y - tr.r.y), Math.abs(dip.width - tr.r.width), Math.abs(dip.height - tr.r.height));
    errs.push(e);
    const exact = truth.find((x) => Math.abs(x.r.x - dip.x) <= 2 && Math.abs(x.r.y - dip.y) <= 2);       // when the window was where the helper says
    if (exact) lags.push(rp.t - exact.t);
  }
  errs.sort((a, b) => a - b); lags.sort((a, b) => a - b);
  res.follow = { reports: reports.length, moves: truth.length, msBetweenReports: +((reports.at(-1).t - reports[0].t) / (reports.length - 1)).toFixed(0),
    errorDipsMedian: errs[errs.length >> 1], errorDipsP90: errs[Math.floor(errs.length * 0.9)], errorDipsMax: errs.at(-1),
    lagMsMedian: lags[lags.length >> 1], lagMsP90: lags[Math.floor(lags.length * 0.9)], lagMsMax: lags.at(-1), matched: lags.length };
  const txt = JSON.stringify(res, null, 2);
  if (OUT) fs.writeFileSync(OUT, txt);
  process.stdout.write(txt + '\n');
  app.exit(0);
});
