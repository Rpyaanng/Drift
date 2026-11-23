// Spike A, part 3 (throwaway): can a page turn raw PCM into a WebRTC audio track? (MediaStreamTrackGenerator, AudioData)
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  w.webContents.setAudioMuted(true); await w.loadURL('data:text/html,<title>x</title>');
  const r = await w.webContents.executeJavaScript(`(async () => {
    const out = { gen: typeof MediaStreamTrackGenerator, audioData: typeof AudioData, worklet: typeof AudioWorkletNode };
    try {
      const g = new MediaStreamTrackGenerator({ kind: 'audio' }); const wr = g.writable.getWriter();
      const a = new RTCPeerConnection(), b = new RTCPeerConnection();
      a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate); b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
      a.addTrack(g, new MediaStream([g]));
      let got = null; b.ontrack = (e) => { got = e.streams[0]; const el = new Audio(); el.srcObject = got; el.volume = 1; el.play().catch(()=>{}); };
      await a.setLocalDescription(); await b.setRemoteDescription(a.localDescription); await b.setLocalDescription(); await a.setRemoteDescription(b.localDescription);
      let ts = 0; const t0 = performance.now();
      const iv = setInterval(() => { const d = new Int16Array(960); for (let i = 0; i < 480; i++) { const v = Math.round(Math.sin(2*Math.PI*1000*(ts/1e6 + i/48000))*8000); d[2*i]=v; d[2*i+1]=v; }
        wr.write(new AudioData({ format: 's16', sampleRate: 48000, numberOfFrames: 480, numberOfChannels: 2, timestamp: ts, data: d })); ts += 10000; }, 10);
      await new Promise((r) => setTimeout(r, 3000)); clearInterval(iv);
      const st = await b.getStats(); for (const s of st.values()) if (s.type === 'inbound-rtp' && s.kind === 'audio') { out.bytes = s.bytesReceived; out.level = s.audioLevel; out.energy = s.totalAudioEnergy; out.samples = s.totalSamplesReceived; }
      out.track = g.readyState;
    } catch (e) { out.err = e.message; }
    return out; })()`);
  console.log(JSON.stringify(r)); app.quit();
});
