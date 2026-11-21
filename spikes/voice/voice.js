// One member of a voice channel: sends one audio track to every other member and plays each of theirs.
// main.js calls the functions at the bottom (connected, beep, tone, setPtt, bytesOut, report) to measure the call.
const q = new URLSearchParams(location.search);
const me = +q.get('me'), N = +q.get('n'), SRC = q.get('src'), PTT = !!q.get('ptt'), MUTE = !!q.get('mute');
const api = window.voice;
const $ = (s) => document.querySelector(s);
const now = () => performance.timeOrigin + performance.now();
const log = (t) => { $('#log').textContent += t + '\n'; console.log(t); };
$('#me').textContent = `Window ${me}` + (me ? '' : ' (you)');

const ctx = new AudioContext({ latencyHint: 'interactive' });
const worklet = ctx.audioWorklet.addModule('onset.js');
let local = null, gain = null, talking = !PTT;

// What this member sends: the microphone (with Chromium's echo cancelling, noise suppression and level control), or a
// test tone that main.js can switch on and off.
async function makeLocal() {
  if (SRC === 'mic') {
    local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    log('mic: ' + local.getAudioTracks()[0].label);
  } else {
    const osc = ctx.createOscillator(), dst = ctx.createMediaStreamDestination();
    osc.frequency.value = 880; gain = ctx.createGain(); gain.gain.value = 0;
    osc.connect(gain).connect(dst); osc.start();
    local = dst.stream;
  }
  applyTalk();
}
// Hold-to-talk mutes the track rather than stopping it, so the microphone stays open for the whole call (as Discord
// does) and talking starts instantly. A muted track sends silence, which DTX shrinks to almost nothing.
function applyTalk() {
  const t = local && local.getAudioTracks()[0];
  if (t) t.enabled = talking;
  const state = !local ? 'off' : talking ? 'live' : 'open';
  $('#mic').textContent = { off: 'mic off', open: 'mic open, muted', live: 'mic LIVE' }[state];
  $('#mic').className = state === 'live' ? 'live' : '';
  if (SRC === 'mic' || me === 0) api.mic(state);
}

// ---- the mesh: the lower-numbered member of each pair makes the offer ----
const pcs = new Map();
// Ask the other side's encoder to use DTX (Opus sends a tiny packet every 400 ms while it's quiet, not 50 a second).
const dtx = (sdp) => q.get("nodtx") ? sdp :  sdp.replace(/(a=fmtp:\d+ [^\r\n]*useinbandfec=1)(?![^\r\n]*usedtx)/g, '$1;usedtx=1');
function pcFor(id) {
  let pc = pcs.get(id);
  if (pc) return pc;
  pc = new RTCPeerConnection({ iceServers: [] });
  pcs.set(id, pc);
  for (const t of local.getTracks()) pc.addTrack(t, local);
  pc.onicecandidate = (e) => { if (e.candidate) api.signal(id, { c: e.candidate.toJSON() }); };
  pc.ontrack = (e) => hear(id, e.streams[0] || new MediaStream([e.track]));
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') log(`window ${id}: connection failed`); };
  return pc;
}
async function onSignal(from, d) {
  const pc = pcFor(from);
  if (d.sdp) {
    await pc.setRemoteDescription({ type: d.sdp.type, sdp: dtx(d.sdp.sdp) });
    if (d.sdp.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); api.signal(from, { sdp: pc.localDescription.toJSON() }); }
  } else if (d.c) await pc.addIceCandidate(d.c).catch((e) => log('candidate: ' + e.message));
}
let chain = makeLocal().then(async () => {
  for (let i = me + 1; i < N; i++) { const pc = pcFor(i); await pc.setLocalDescription(await pc.createOffer()); api.signal(i, { sdp: pc.localDescription.toJSON() }); }
}).catch((e) => log('could not start: ' + e.message));
api.onSignal((from, d) => { chain = chain.then(() => onSignal(from, d)).catch((e) => log('signal: ' + e.message)); });

// ---- hearing the others: play the stream, watch its level for the speaking ring and for sounds starting ----
const ring = (id) => {
  let el = document.getElementById('p' + id);
  if (!el) { el = document.createElement('div'); el.id = 'p' + id; el.className = 'peer'; el.textContent = id; $('#peers').appendChild(el); }
  return el;
};
async function hear(id, stream) {
  const el = new Audio();       // Chromium only delivers a remote stream's sound to Web Audio while a media element plays it
  el.srcObject = stream; el.muted = MUTE; el.play().catch(() => {});
  ring(id);
  await worklet;
  const node = new AudioWorkletNode(ctx, 'onset');
  ctx.createMediaStreamSource(stream).connect(node).connect(ctx.destination);       // the node outputs silence; this keeps it running
  let quietSince = 0;
  node.port.onmessage = (e) => {
    if (e.data.on !== undefined) api.heard(id, now() - (ctx.currentTime - e.data.on) * 1000);
    else {
      const loud = e.data.level > 0.015, el2 = ring(id);
      if (loud) { quietSince = 0; el2.classList.add('speaking'); } else if (!quietSince) quietSince = Date.now(); else if (Date.now() - quietSince > 250) el2.classList.remove('speaking');
    }
  };
}

// ---- called by main.js ----
window.connected = () => [...pcs.values()].filter((pc) => pc.connectionState === 'connected').length;
window.setPtt = (down) => { if (!PTT) return; talking = down; applyTalk(); };
window.tone = (on) => { gain.gain.setValueAtTime(on ? 0.5 : 0, ctx.currentTime); };
window.beep = (ms) => { const t = ctx.currentTime; gain.gain.setValueAtTime(0.5, t); gain.gain.setValueAtTime(0, t + ms / 1000); return now(); };
window.bytesOut = async () => {
  const out = {};
  for (const [id, pc] of pcs) for (const s of (await pc.getStats()).values()) if (s.type === 'outbound-rtp' && s.kind === 'audio') out[id] = s.bytesSent + (s.headerBytesSent || 0);
  return out;
};
window.report = async () => {
  const out = { baseLatencyMs: +(ctx.baseLatency * 1000).toFixed(1), outputLatencyMs: +(ctx.outputLatency * 1000).toFixed(1), from: {} };
  for (const [id, pc] of pcs) {
    const all = await pc.getStats(), r = {};
    for (const s of all.values()) {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        Object.assign(r, { jitterBufferMs: +((s.jitterBufferDelay / Math.max(1, s.jitterBufferEmittedCount)) * 1000).toFixed(1),
          jitterTargetMs: s.jitterBufferTargetDelay !== undefined ? +((s.jitterBufferTargetDelay / Math.max(1, s.jitterBufferEmittedCount)) * 1000).toFixed(1) : null,
          packetsReceived: s.packetsReceived, packetsLost: s.packetsLost, concealedPct: +((100 * s.concealedSamples) / Math.max(1, s.totalSamplesReceived)).toFixed(2) });
        const c = all.get(s.codecId); if (c) r.codec = `${c.mimeType} ${c.sdpFmtpLine || ''}`;
      }
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') r.rttMs = +((s.currentRoundTripTime || 0) * 1000).toFixed(1);
    }
    out.from[id] = r;
  }
  return out;
};
