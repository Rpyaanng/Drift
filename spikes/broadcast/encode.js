// Spike B of docs/plans/broadcast.md (throwaway): what does it cost the broadcaster to send one capture to N viewers?
// In a mesh each viewer is a separate RTCPeerConnection and so a separate encode. Measures the encoder Chromium actually
// picks (hardware or software), frames per second actually sent, why quality is limited, and processor and GPU use.
//
//   electron spikes/broadcast/encode.js                       BC_N=1..10 viewers (default 3), writes JSON to stdout/BC_OUT
//   BC_CODEC=h264|vp8|vp9|av1   which codec to put first (default h264, as videoCodecs() in renderer/app.js does)
//   BC_SRC=canvas|window        canvas: a 1080p30 test pattern full of motion (the encoder's worst case), no capture.
//                               window: a real Windows Graphics Capture of a 1920x1080 window drawing the same pattern,
//                               through setDisplayMediaRequestHandler, as Drift would capture an application.
//   BC_MBPS=3.5                 the per-viewer cap (setParameters maxBitrate)
//   BC_SECS=15                  how long to measure, after 6 s of warm-up
//   BC_DEGRADE=maintain-resolution  what the encoder gives up first when short of bits (balanced, maintain-framerate)
//
// The viewers live in a second renderer process, so their decoding isn't counted against the broadcaster.
const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const N = Math.max(1, Math.min(16, +process.env.BC_N || 3));
const CODEC = (process.env.BC_CODEC || 'h264').toLowerCase();
const SRC = process.env.BC_SRC === 'window' ? 'window' : 'canvas';
const MBPS = +process.env.BC_MBPS || 3.5;
const SECS = +process.env.BC_SECS || 15;
const OUT = process.env.BC_OUT || '';
const DEGRADE = process.env.BC_DEGRADE || 'maintain-resolution';       // or balanced / maintain-framerate
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', path.join(os.tmpdir(), 'drift-broadcast-spike'));
const web = { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false };
let caster, viewers, motion;

const PATTERN = `<!doctype html><body style="margin:0;background:#000;overflow:hidden"><canvas id=c width=1920 height=1080></canvas><script>
const c = document.getElementById('c'), g = c.getContext('2d');
let t = 0;
function draw() {       // moving gradients, text and noise squares: hard to compress, like a game with a busy HUD
  t++;
  const gr = g.createLinearGradient(0, 0, 1920, 1080); gr.addColorStop(0, 'hsl(' + (t % 360) + ',70%,40%)'); gr.addColorStop(1, 'hsl(' + ((t * 3) % 360) + ',70%,20%)');
  g.fillStyle = gr; g.fillRect(0, 0, 1920, 1080);
  for (let i = 0; i < 400; i++) { g.fillStyle = 'hsl(' + ((i * 37 + t * 5) % 360) + ',80%,' + (30 + ((i * 13 + t) % 50)) + '%)'; g.fillRect((i * 97 + t * (3 + (i % 7))) % 1920, (i * 53 + t * (1 + (i % 5))) % 1080, 24 + (i % 40), 24 + (i % 30)); }
  g.fillStyle = '#fff'; g.font = '28px monospace'; for (let y = 40; y < 1080; y += 60) g.fillText('frame ' + t + '  ' + Math.random().toString(36).slice(2), (t * 4 + y) % 600, y);
}
setInterval(draw, 1000 / 30);
</script>`;

// Pages are files, not data: URLs, because a data: URL isn't a secure context and has no navigator.mediaDevices.
const DIR = path.join(os.tmpdir(), 'drift-broadcast-spike-pages');
function page(name, body) { fs.mkdirSync(DIR, { recursive: true }); const f = path.join(DIR, name + '.html'); fs.writeFileSync(f, `<!doctype html><body><script>${body}</script>`); return f; }

const CASTER = `
const { ipcRenderer } = require('electron');
const pcs = [];
async function source() {
  if (${JSON.stringify(SRC)} === 'window') {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    return s.getVideoTracks()[0];
  }
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; document.body.append(c);
  const g = c.getContext('2d'); let t = 0;
  setInterval(() => { t++;
    const gr = g.createLinearGradient(0, 0, 1920, 1080); gr.addColorStop(0, 'hsl(' + (t % 360) + ',70%,40%)'); gr.addColorStop(1, 'hsl(' + ((t * 3) % 360) + ',70%,20%)');
    g.fillStyle = gr; g.fillRect(0, 0, 1920, 1080);
    for (let i = 0; i < 400; i++) { g.fillStyle = 'hsl(' + ((i * 37 + t * 5) % 360) + ',80%,' + (30 + ((i * 13 + t) % 50)) + '%)'; g.fillRect((i * 97 + t * (3 + (i % 7))) % 1920, (i * 53 + t * (1 + (i % 5))) % 1080, 24 + (i % 40), 24 + (i % 30)); }
    g.fillStyle = '#fff'; g.font = '28px monospace'; for (let y = 40; y < 1080; y += 60) g.fillText('frame ' + t + '  ' + Math.random().toString(36).slice(2), (t * 4 + y) % 600, y);
  }, 1000 / 30);
  return c.captureStream(30).getVideoTracks()[0];
}
ipcRenderer.on('start', async () => {
  try {
    const track = await source();
    track.contentHint = 'motion';
    const s = track.getSettings();
    ipcRenderer.send('log', 'source ' + s.width + 'x' + s.height + ' @' + s.frameRate);
    const caps = RTCRtpSender.getCapabilities('video').codecs;
    const first = caps.filter((c) => c.mimeType.toLowerCase() === 'video/${CODEC}');
    const order = [...first, ...caps.filter((c) => !first.includes(c))];
    for (let i = 0; i < ${N}; i++) {
      const pc = new RTCPeerConnection();
      const tr = pc.addTransceiver(track, { direction: 'sendonly' });
      tr.setCodecPreferences(order);
      pc.onicecandidate = (e) => e.candidate && ipcRenderer.send('to-viewers', { i, cand: e.candidate.toJSON() });
      await pc.setLocalDescription();
      ipcRenderer.send('to-viewers', { i, sdp: pc.localDescription.toJSON() });
      pcs.push({ pc, tr });
    }
  } catch (e) { ipcRenderer.send('log', 'caster failed: ' + e.message); ipcRenderer.send('fail', e.message); }
});
ipcRenderer.on('from-viewer', async (_e, m) => {
  const p = pcs[m.i];
  if (m.sdp) {
    await p.pc.setRemoteDescription(m.sdp);
    const prm = p.tr.sender.getParameters();
    prm.encodings[0].maxBitrate = ${MBPS} * 1e6; prm.encodings[0].maxFramerate = 30; prm.degradationPreference = '${DEGRADE}';
    await p.tr.sender.setParameters(prm).catch((e) => ipcRenderer.send('log', 'setParameters: ' + e.message));
  }
  if (m.cand) p.pc.addIceCandidate(m.cand).catch(() => {});
});
async function snap() {
  const out = [];
  for (const { pc } of pcs) {
    const st = await pc.getStats(); let o = null, codec = '';
    st.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') o = r; });
    if (o && o.codecId) codec = (st.get(o.codecId) || {}).mimeType || '';
    out.push(o ? { framesEncoded: o.framesEncoded, bytesSent: o.bytesSent, encoder: o.encoderImplementation, powerEfficient: o.powerEfficientEncoder, limited: o.qualityLimitationReason,
      w: o.frameWidth, h: o.frameHeight, fps: o.framesPerSecond, encodeTime: o.totalEncodeTime, codec, state: pc.connectionState } : { state: pc.connectionState });
  }
  return out;
}
window.snap = snap;
`;

const VIEWERS = `
const { ipcRenderer } = require('electron');
const pcs = {};
ipcRenderer.on('from-caster', async (_e, m) => {
  let pc = pcs[m.i];
  if (!pc) {
    pc = pcs[m.i] = new RTCPeerConnection();
    pc.onicecandidate = (e) => e.candidate && ipcRenderer.send('to-caster', { i: m.i, cand: e.candidate.toJSON() });
    pc.ontrack = (e) => { const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.width = 160; v.srcObject = new MediaStream([e.track]); document.body.append(v); };
  }
  if (m.sdp) { await pc.setRemoteDescription(m.sdp); await pc.setLocalDescription(); ipcRenderer.send('to-caster', { i: m.i, sdp: pc.localDescription.toJSON() }); }
  if (m.cand) pc.addIceCandidate(m.cand).catch(() => {});
});
ipcRenderer.handle('snap', async () => {
  const out = [];
  for (const pc of Object.values(pcs)) { const st = await pc.getStats(); let f = 0; st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') f = r.framesDecoded; }); out.push(f); }
  return out;
});
`;

function gpu() {       // NVIDIA only: encoder and 3D use, in percent
  return new Promise((ok) => execFile('nvidia-smi', ['--query-gpu=utilization.encoder,utilization.gpu,utilization.decoder', '--format=csv,noheader,nounits'], { windowsHide: true }, (e, out) => {
    if (e) return ok(null);
    const [enc, g3d, dec] = out.trim().split(/\s*,\s*/).map(Number); ok({ enc, g3d, dec });
  }));
}
// Processor time from Windows itself (app.getAppMetrics' percentCPUUsage is scaled in a way that doesn't match "percent of one core")
function cpuMs(pids) {
  return new Promise((ok) => execFile('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalMilliseconds)" }`], { windowsHide: true }, (e, out) => {
    const r = {}; for (const l of (out || '').trim().split(String.fromCharCode(10))) { const [id, ms] = l.trim().split(' '); r[id] = +ms; } ok(r);
  }));
}

app.whenReady().then(async () => {
  const log = (...a) => process.stderr.write(a.join(' ') + '\n');
  if (SRC === 'window') {
    motion = new BrowserWindow({ width: 1920, height: 1080, useContentSize: true, x: 0, y: 0, show: true, title: 'broadcast-spike-motion', webPreferences: { backgroundThrottling: false } });
    await motion.loadURL('data:text/html;base64,' + Buffer.from(PATTERN).toString('base64'));
    await wait(800);
    const id = motion.getMediaSourceId();
    session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
      desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }).then((src) => cb({ video: src.find((s) => s.id === id) || src.find((s) => s.name === 'broadcast-spike-motion') })).catch(() => cb({}));
    });
  }
  caster = new BrowserWindow({ show: false, webPreferences: web });
  viewers = new BrowserWindow({ show: false, webPreferences: web });
  ipcMain.on('log', (_e, m) => log(m));
  ipcMain.on('fail', () => app.exit(1));
  ipcMain.on('to-viewers', (_e, m) => viewers.webContents.send('from-caster', m));
  ipcMain.on('to-caster', (_e, m) => caster.webContents.send('from-viewer', m));
  await viewers.loadFile(page('viewers', VIEWERS));
  await caster.loadFile(page('caster', CASTER));
  caster.webContents.send('start');
  await wait(6000);
  const casterPid = caster.webContents.getOSProcessId();
  const a = await caster.webContents.executeJavaScript('snap()');
  const g = [], gpuPid = app.getAppMetrics().find((m) => m.type === 'GPU').pid;
  const c0 = await cpuMs([casterPid, gpuPid]);
  const t0 = Date.now();
  while (Date.now() - t0 < SECS * 1000) {
    await wait(1000);
    const x = await gpu(); if (x) g.push(x);
  }
  const c1 = await cpuMs([casterPid, gpuPid]);
  const b = await caster.webContents.executeJavaScript('snap()');
  const secs = (Date.now() - t0) / 1000;
  const core = (pid) => +((100 * (c1[pid] - c0[pid])) / 1000 / secs).toFixed(1);
  const avg = (xs) => +(xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)).toFixed(1);
  const per = b.map((y, i) => {
    const x = a[i] || {};
    return { state: y.state, codec: y.codec, encoder: y.encoder, powerEfficient: y.powerEfficient, limited: y.limited, size: `${y.w}x${y.h}`,
      fps: +(((y.framesEncoded - (x.framesEncoded || 0)) / secs)).toFixed(1), mbps: +((((y.bytesSent - (x.bytesSent || 0)) * 8) / secs / 1e6)).toFixed(2),
      msPerFrame: y.framesEncoded > (x.framesEncoded || 0) ? +((1000 * (y.encodeTime - (x.encodeTime || 0))) / (y.framesEncoded - x.framesEncoded)).toFixed(1) : null };
  });
  const res = {
    viewers: N, codecAsked: CODEC, source: SRC, mbpsCap: MBPS, seconds: Math.round(secs),
    encoders: [...new Set(per.map((p) => p.encoder))], limitedBy: [...new Set(per.map((p) => p.limited))],
    fpsEach: { min: Math.min(...per.map((p) => p.fps)), max: Math.max(...per.map((p) => p.fps)) },
    totalMbps: +per.reduce((s, p) => s + p.mbps, 0).toFixed(1),
    casterCpuPercentOfOneCore: core(casterPid), gpuProcessCpuPercentOfOneCore: core(gpuPid), cores: os.cpus().length,
    nvidia: g.length ? { encoderPercent: avg(g.map((x) => x.enc)), gpuPercent: avg(g.map((x) => x.g3d)), decoderPercent: avg(g.map((x) => x.dec)) } : 'not available',
    perViewer: per,
  };
  const txt = JSON.stringify(res, null, 2);
  if (OUT) fs.writeFileSync(OUT, txt);
  process.stdout.write(txt + '\n');
  app.exit(0);
});
