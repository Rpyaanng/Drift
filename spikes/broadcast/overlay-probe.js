// Probe (throwaway): opens the pointer overlay the way main.js bcOvSync does (over a whole monitor), sends it a pointer and a
// message, and checks it really paints them: a capture of the monitor with protection off must show them.
//   electron spikes/broadcast/overlay-probe.js
const { app, BrowserWindow, session, desktopCapturer, screen } = require('electron');
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..', '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), 'drift-overlay-probe'));

const GRAB = `<!doctype html><script>
window.grab = async (pts) => {
  const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const t = s.getVideoTracks()[0], v = document.createElement('video'); v.muted = true; v.srcObject = s; await v.play();
  await new Promise((r) => setTimeout(r, 700));
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  const g = c.getContext('2d'); g.drawImage(v, 0, 0); t.stop();
  return pts.map(([fx, fy, fw, fh]) => { const d = g.getImageData(Math.round(fx * c.width), Math.round(fy * c.height), Math.max(1, Math.round(fw * c.width)), Math.max(1, Math.round(fh * c.height))).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] > 200) n++; return n; });
};
</script>`;

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay(), r = d.bounds, res = { display: r, scale: d.scaleFactor };
  session.defaultSession.setDisplayMediaRequestHandler((_q, cb) => { desktopCapturer.getSources({ types: ['screen'] }).then((s) => cb({ video: s.find((x) => x.display_id === String(d.id)) || s[0] })).catch(() => cb({})); });
  const w = new BrowserWindow({ show: false, transparent: true, frame: false, focusable: false, skipTaskbar: true, resizable: false, hasShadow: false, alwaysOnTop: true, title: 'Drift pointers',
    webPreferences: { preload: path.join(ROOT, 'bc-overlay-preload.js'), sandbox: true, contextIsolation: true } });
  w.setIgnoreMouseEvents(true);
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setContentProtection(process.env.PROTECT === '1');
  w.webContents.on('console-message', (e) => { (res.console = res.console || []).push(e.message); });
  await w.loadFile(path.join(ROOT, 'renderer', 'bc-overlay.html'));
  w.setBounds(r);
  w.showInactive();
  // a magenta-named pointer is hard to arrange; instead colour checks look at the DOM, and the capture checks *anything* drawn
  const send = () => w.webContents.send('bc-overlay', { list: [{ id: 'a', x: 0.5, y: 0.5, name: 'Guesty' }], ping: null, msgs: [{ id: '1', from: 'a', name: 'Guesty', ch: '', text: 'hi over the game', pic: null, at: Date.now(), old: false }], pics: {} });
  send(); await wait(1000); send();
  res.bounds = w.getBounds(); res.visible = w.isVisible();
  res.dom = await w.webContents.executeJavaScript(`(() => { const p = document.querySelector('.ptr'), m = document.querySelector('#msgs .msg'); const R = (e) => e && (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }))(e.getBoundingClientRect()); return { inner: [innerWidth, innerHeight], ptr: R(p), ptrStyle: p && [getComputedStyle(p).opacity, p.style.transform, getComputedStyle(p).display], msg: R(m), msgOpacity: m && getComputedStyle(m).opacity, bodyBg: getComputedStyle(document.body).backgroundColor, sheets: document.styleSheets.length, cssRules: (() => { try { return document.styleSheets[0].cssRules.length; } catch (e) { return String(e); } })() }; })()`);
  // paint the pointer magenta so a capture can find it
  await w.webContents.executeJavaScript(`document.querySelector('.ptr').style.setProperty('--c', '#ff00ff'); document.querySelector('#msgs .msg').style.background = '#ff00ff'; 1`);
  await wait(500);
  const g = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  console.log('dom: ' + JSON.stringify(res.dom));
  const gf = path.join(os.tmpdir(), 'drift-overlay-probe-grab.html'); require('fs').writeFileSync(gf, GRAB);
  await g.loadFile(gf);
  const P = res.dom.ptr, M = res.dom.msg, f = (b) => [b.x / r.width, b.y / r.height, b.width / r.width, b.height / r.height];
  res.magentaPixels = await g.webContents.executeJavaScript(`grab(${JSON.stringify([f(P), f(M)])})`);
  console.log(JSON.stringify(res, null, 1));
  app.exit(0);
});
