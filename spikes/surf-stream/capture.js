// Spike S1 of docs/plans/streams.md (throwaway): capturing an offscreen page, picture and sound, while no window shows it.
// An offscreen window (as web.js makes for "gpu" Surf) plays a moving canvas and a 440 Hz tone. A hidden capture window
// calls getDisplayMedia, answered with the page's own frame (setDisplayMediaRequestHandler → { video: frame, audio: frame }).
// It measures the frames a second that arrive and whether the sound is there, in four cases: painting on or stopped, and the
// page's audio muted (setAudioMuted) or not. Also S2 (two sessions with one module-level sync IPC handler answering each
// by session), S3 (refusing <input type=file> in one session) and S4 (holding a download: pause in will-download, resume later,
// cancel leaves nothing).
//   SPIKE_OUT=out.json electron spikes/surf-stream/capture.js
const { app, BrowserWindow, session, ipcMain, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const OUT = process.env.SPIKE_OUT || path.join(os.tmpdir(), 'surf-stream-spike.json');
app.setPath('userData', path.join(os.tmpdir(), 'drift-surf-stream-spike'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const res = {};
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><body style="margin:0;background:#123"><canvas id=c width=1920 height=1080></canvas><script>
const g = c.getContext('2d'); let n = 0;
(function f() { n++; g.fillStyle = 'hsl(' + (n % 360) + ' 80% 50%)'; g.fillRect(0, 0, 1920, 1080); g.fillStyle = '#fff'; g.font = '200px sans-serif'; g.fillText(n, 100, 400); requestAnimationFrame(f); })();
const ctx = new AudioContext(), o = ctx.createOscillator(), gg = ctx.createGain(); gg.gain.value = 0.2; o.frequency.value = 440; o.connect(gg).connect(ctx.destination); o.start();
</script>`)}`;
const CAP = `data:text/html,${encodeURIComponent(`<!doctype html><script>
window.measure = async () => {
  const st = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const v = document.createElement('video'); v.muted = true; v.srcObject = st; await v.play();
  const a = st.getAudioTracks()[0];
  let level = -1;
  if (a) { const ctx = new AudioContext(), an = ctx.createAnalyser(); ctx.createMediaStreamSource(new MediaStream([a])).connect(an); an.fftSize = 2048;
    await new Promise((r) => setTimeout(r, 800)); const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf); level = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length); }
  let frames = 0; const t0 = performance.now();
  await new Promise((r) => { const f = () => { frames++; if (performance.now() - t0 < 3000) v.requestVideoFrameCallback(f); else r(); }; v.requestVideoFrameCallback(f); setTimeout(r, 4000); });
  const out = { fps: +(frames / ((performance.now() - t0) / 1000)).toFixed(1), size: v.videoWidth + 'x' + v.videoHeight, audio: !!a, level: +level.toFixed(4) };
  st.getTracks().forEach((t) => t.stop());
  return out;
};
</script>`)}`;

app.whenReady().then(async () => {
  try {
    // ---- S1 ----
    const page = new BrowserWindow({ show: false, width: 1920, height: 1080, useContentSize: true, frame: false,
      webPreferences: { partition: 'persist:spike-hub', offscreen: { useSharedTexture: true, deviceScaleFactor: 1 }, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    page.webContents.setFrameRate(30);
    page.webContents.on('paint', (e) => { if (e.texture) e.texture.release(); });
    const tmp = (n, html) => { const f = path.join(os.tmpdir(), n); fs.writeFileSync(f, decodeURIComponent(html.slice('data:text/html,'.length))); return f; };
    await page.loadFile(tmp('spike-page.html', PAGE));
    const cap = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    session.defaultSession.setDisplayMediaRequestHandler((req, cb) => cb({ video: page.webContents.mainFrame, audio: page.webContents.mainFrame }));
    await cap.loadFile(tmp('spike-cap.html', CAP));
    await wait(1500);
    const run = async (tag) => { const t0 = process.cpuUsage(); res['s1 ' + tag] = await cap.webContents.executeJavaScript('measure()').catch((e) => ({ error: e.message })); res['s1 ' + tag].mainCpu = process.cpuUsage(t0).user; };
    await run('painting, unmuted');
    page.webContents.setAudioMuted(true); await wait(300);
    await run('painting, muted');
    page.webContents.setAudioMuted(false);
    page.webContents.stopPainting(); await wait(300);
    await run('stopped painting');
    page.webContents.startPainting(); await wait(300);
    await run('painting again');
    // all processes' CPU while capturing, for a rough cost
    const m0 = app.getAppMetrics();
    const p = cap.webContents.executeJavaScript('measure()');
    await wait(2500);
    res['s1 metrics while capturing'] = app.getAppMetrics().map((x) => ({ type: x.type, cpu: +x.cpu.percentCPUUsage.toFixed(1) })).filter((x) => x.cpu > 0.5);
    await p; void m0;

    // ---- S2: two sessions, one module-level sync handler, answered by session ----
    const sA = session.fromPartition('persist:spike-a'), sB = session.fromPartition('persist:spike-b');
    const pre = path.join(os.tmpdir(), 'spike-pre.js');
    fs.writeFileSync(pre, "const { ipcRenderer } = require('electron'); window.__who = ipcRenderer.sendSync('who');");
    for (const s of [sA, sB]) s.registerPreloadScript({ type: 'frame', id: 'who', filePath: pre });
    ipcMain.on('who', (e) => { e.returnValue = e.sender.session === sA ? 'A' : e.sender.session === sB ? 'B' : '?'; });
    const wa = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:spike-a', sandbox: true, contextIsolation: false } });
    const wb = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:spike-b', sandbox: true, contextIsolation: false } });
    await Promise.all([wa.loadURL('data:text/html,a'), wb.loadURL('data:text/html,b')]);
    res.s2 = { a: await wa.webContents.executeJavaScript('window.__who'), b: await wb.webContents.executeJavaScript('window.__who') };

    // ---- S3: refusing a file picker in one session ----
    // Candidate: a preload in that session only that stops clicks on <input type=file> and its showPicker() (Electron has no
    // per-session hook for the file dialog). Checked by whether a file dialog would open: we look for 'select-file' via the
    // webContents event that fires before Electron shows it? There isn't one, so the page records whether the click got through.
    const pre3 = path.join(os.tmpdir(), 'spike-nofile.js');
    fs.writeFileSync(pre3, `(() => {
      const stop = (e) => { const t = e.target && e.target.closest ? e.target.closest('input[type=file], label') : null; const i = t && (t.tagName === 'LABEL' ? t.control : t); if (i && i.type === 'file') { e.preventDefault(); e.stopImmediatePropagation(); window.__blocked = (window.__blocked || 0) + 1; } };
      addEventListener('click', stop, true);
      const sp = HTMLInputElement.prototype.showPicker; HTMLInputElement.prototype.showPicker = function () { if (this.type === 'file') { window.__blocked = (window.__blocked || 0) + 1; return; } return sp.call(this); };
      const ck = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function () { if (this.type === 'file') { window.__blocked = (window.__blocked || 0) + 1; return; } return ck.call(this); };
    })()`);
    sA.registerPreloadScript({ type: 'frame', id: 'nofile', filePath: pre3 });
    await wa.loadURL('data:text/html,<input type=file id=f><label id=l for=f>x</label>');
    res.s3 = await wa.webContents.executeJavaScript(`(() => { f.click(); try { f.showPicker(); } catch (e) {} l.click(); f.dispatchEvent(new MouseEvent('click', { bubbles: true })); return window.__blocked || 0; })()`);
    // (In the isolated world this is in the page's own world only with contextIsolation off; with it on the preload's
    // prototypes are its own. The real thing uses webFrame.executeJavaScript into the main world, or the session's
    // 'select-file' handling. Recorded either way.)

    // ---- S4: holding a download ----
    const body = Buffer.alloc(3 * 1024 * 1024, 7);
    const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, 'Content-Disposition': 'attachment; filename="big.bin"' }); let i = 0; const push = () => { while (i < body.length) { const ok = r.write(body.subarray(i, i + 65536)); i += 65536; if (!ok) { r.once('drain', push); return; } } r.end(); }; setTimeout(push, 50); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const hold = path.join(os.tmpdir(), 'spike-hold'); fs.rmSync(hold, { recursive: true, force: true }); fs.mkdirSync(hold);
    const items = [];
    sB.on('will-download', (_e, item) => { item.setSavePath(path.join(hold, `${items.length}-${item.getFilename()}`)); item.pause(); items.push(item); });
    const url = `http://127.0.0.1:${srv.address().port}/big.bin`;
    wb.webContents.downloadURL(url); await wait(1500);
    const a = items[0];
    res.s4 = { paused: a && a.isPaused(), receivedWhilePaused: a && a.getReceivedBytes(), state: a && a.getState() };
    const done = new Promise((r) => a.once('done', (_e, st) => r(st)));
    a.resume();
    res.s4.afterResume = await Promise.race([done, wait(8000).then(() => 'timeout')]);
    res.s4.fileSize = (() => { try { return fs.statSync(a.getSavePath()).size; } catch { return -1; } })();
    wb.webContents.downloadURL(url); await wait(1500);
    const b = items[1];
    const done2 = new Promise((r) => b.once('done', (_e, st) => r(st)));
    b.cancel();
    res.s4.cancelled = await Promise.race([done2, wait(5000).then(() => 'timeout')]);
    await wait(500);
    res.s4.leftAfterCancel = fs.readdirSync(hold).filter((f) => f.startsWith('1-'));
    srv.close();
  } catch (e) { res.error = e.stack; }
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
  app.quit();
});
