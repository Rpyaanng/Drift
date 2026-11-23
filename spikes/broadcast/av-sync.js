// Spike A, part 4 (throwaway): how far apart do picture and sound arrive? A window flashes white and beeps (1 kHz,
// quiet) at the same moment every 1.5 s. It's captured as a broadcast is: the picture through getDisplayMedia (Windows
// Graphics Capture), the sound through bc-sound.js (process loopback, the window's own process tree) and a
// MediaStreamTrackGenerator, both in one stream on a local RTCPeerConnection. The far end notes when each flash shows
// (requestVideoFrameCallback) and when each beep starts (an analyser), and reports sound minus picture.
//   node_modules/.bin/electron spikes/broadcast/av-sync.js
const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const snd = require('../../bc-sound');
const fs = require('fs'), os = require('os'), path = require('path');
const page = (name, html) => { const f = path.join(os.tmpdir(), 'drift-av-' + name + '.html'); fs.writeFileSync(f, html); return f; };
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const FLASH = `<body style="margin:0;background:#000"><script>
  const ac = new AudioContext(), g = ac.createGain(); g.gain.value = 0.02; g.connect(ac.destination);
  let next = performance.now() + 1500;
  function frame(t) {
    if (t >= next) {
      next += 1500; document.body.style.background = '#fff';
      const o = ac.createOscillator(); o.frequency.value = 1000; o.connect(g); o.start(); o.stop(ac.currentTime + 0.15);
      setTimeout(() => { document.body.style.background = '#000'; }, 150);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  setTimeout(() => { document.title = 'lat ' + Math.round((ac.baseLatency + (ac.outputLatency || 0)) * 1000); }, 3000);
</script></body>`;

const RX = `<body style="margin:0"><video id=v autoplay muted style="width:320px"></video><script>
  const { ipcRenderer } = require('electron');
  const log = (m) => ipcRenderer.send('log', m);
  (async () => {
    log('asking for the window');
    const cap = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: false });
    log('captured');
    const gen = new MediaStreamTrackGenerator({ kind: 'audio' }), w = gen.writable.getWriter();
    let at = 0;
    ipcRenderer.on('pcm', (_e, d) => {
      const n = Math.floor(d.length / 4), s = new Int16Array(n * 2); new Uint8Array(s.buffer).set(d.subarray(0, n * 4));
      const now = performance.now() * 1000; if (!at || Math.abs(at - now) > 200e3) at = now;
      w.write(new AudioData({ format: 's16', sampleRate: 48000, numberOfChannels: 2, numberOfFrames: n, timestamp: Math.round(at), data: s })); at += n / 48000 * 1e6;
    });
    const out = new MediaStream([cap.getVideoTracks()[0], gen]);
    const a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate); b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    for (const t of out.getTracks()) a.addTrack(t, out);
    let remote = null; b.ontrack = (e) => { remote = e.streams[0]; if (e.track.kind === 'video' && +process.env.AV_VIDEO_DELAY) e.receiver.jitterBufferTarget = +process.env.AV_VIDEO_DELAY; };
    await a.setLocalDescription(); await b.setRemoteDescription(a.localDescription); await b.setLocalDescription(); await a.setRemoteDescription(b.localDescription);
    while (!remote || remote.getTracks().length < 2) await new Promise((r) => setTimeout(r, 50));
    log('connected');
    const v = document.getElementById('v'); v.srcObject = remote; v.muted = false;
    const c = document.createElement('canvas'); c.width = 8; c.height = 8; const g = c.getContext('2d', { willReadFrequently: true });
    const vOn = [], aOn = [];
    let lit = false;
    const onFrame = (now) => {
      g.drawImage(v, 0, 0, 8, 8); const px = g.getImageData(0, 0, 8, 8).data; let sum = 0; for (let i = 0; i < px.length; i += 4) sum += px[i];
      const bright = sum / 64 > 128; if (bright && !lit) vOn.push(now); lit = bright;
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
    const ac = new AudioContext(), an = ac.createAnalyser(); an.fftSize = 256; ac.createMediaStreamSource(remote).connect(an);
    const buf = new Float32Array(an.fftSize); let loud = false;
    setInterval(() => {
      an.getFloatTimeDomainData(buf); let e = 0; for (const x of buf) e += x * x; const on = Math.sqrt(e / buf.length) > 0.002;
      if (on && !loud) aOn.push(performance.now()); loud = on;
    }, 2);
    await new Promise((r) => setTimeout(r, 16000));
    const pairs = vOn.map((t) => { const x = aOn.find((y) => Math.abs(y - t) < 700); return x === undefined ? null : Math.round(x - t); }).filter((x) => x !== null);
    const st = await b.getStats(); let jb = {};
    for (const s of st.values()) if (s.type === 'inbound-rtp') jb[s.kind] = s.jitterBufferEmittedCount ? Math.round(s.jitterBufferDelay / s.jitterBufferEmittedCount * 1000) : null;
    log(JSON.stringify({ flashes: vOn.length, beeps: aOn.length, soundMinusPictureMs: pairs, median: pairs.sort((p, q) => p - q)[pairs.length >> 1], jitterBufferMs: jb }));
    ipcRenderer.send('done');
  })().catch((e) => { log('error ' + e.message); ipcRenderer.send('done'); });
</script></body>`;

app.whenReady().then(async () => {
  setTimeout(() => { console.log('timed out'); app.exit(1); }, 45000);
  const flash = new BrowserWindow({ width: 400, height: 300, x: 100, y: 100, title: 'av-sync flash', alwaysOnTop: true });
  await flash.loadFile(page('flash', FLASH));
  await new Promise((r) => setTimeout(r, 800));
  const id = flash.getMediaSourceId(), hwnd = +/^window:(\d+):/.exec(id)[1];
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }).then((s) => cb({ video: s.find((x) => x.id === id) }));
  });
  const rx = new BrowserWindow({ width: 340, height: 220, x: 520, y: 100, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  rx.webContents.setAudioMuted(true);       // (it measures, it doesn't play)
  ipcMain.on('log', (_e, m) => console.log(m));
  let h = null;
  ipcMain.on('done', () => { console.log('flash page audio output latency: ' + flash.getTitle()); if (h) h.stop(); setTimeout(() => app.quit(), 300); });
  await rx.loadFile(page('rx', RX));
  h = snd.start({ hwnd }, { onPcm: (d) => { if (!rx.isDestroyed()) rx.webContents.send('pcm', new Uint8Array(d.buffer, d.byteOffset, d.length)); }, onEnd: (e) => console.log('sound ended: ' + e) });
});
