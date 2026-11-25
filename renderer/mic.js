/* Drift — opening the microphone the way Options sets it: the device, and noise suppression. Used by the voice room
   (voice.js), to send it, and by Options' microphone test (chat.js), to show what the others would hear.

   Devices are { id, label }. An id can change (a new USB port, Windows updating a driver), so the label finds the device
   again; one that's gone falls back to Windows' default.

   Noise suppression (ns). strong: RNNoise in an AudioWorklet (noise-worklet.js) cleans the microphone, with Chromium's
   own suppression off (the two together smear voices); standard: Chromium's alone; off: neither. The worklet and the wasm
   load the first time they're needed. If they can't, strong falls back to standard. Echo cancellation and automatic gain
   stay on in every mode. A page using this needs script-src 'wasm-unsafe-eval' in its CSP. */
window.driftMic = (() => {
  async function pickDevice(kind, want) {
    if (!want || (!want.id && !want.label)) return '';
    const all = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === kind);
    const d = all.find((x) => want.id && x.deviceId === want.id) || all.find((x) => want.label && x.label === want.label);
    return d ? d.deviceId : '';
  }

  let wasm = null;
  const worklets = new WeakMap();       // AudioContext -> the worklet module being added to it
  function loadDenoise(ctx) {
    wasm = wasm || fetch('vendor/rnnoise.wasm').then((r) => { if (!r.ok) throw new Error('rnnoise.wasm: ' + r.status); return r.arrayBuffer(); }).then((b) => WebAssembly.compile(b));
    if (!worklets.has(ctx)) worklets.set(ctx, ctx.audioWorklet.addModule('noise-worklet.js'));
    return Promise.all([wasm, worklets.get(ctx)]).then(([mod]) => mod, (e) => { wasm = null; worklets.delete(ctx); throw e; });       // (tried again next time)
  }

  // Opens it: { raw (the microphone's stream), stream (what to send: raw itself, or the denoiser's output), src (raw, as
  // a node in ctx), out (stream's sound, as a node in ctx: connect an analyser to it), ns (the suppression really used),
  // close() }. Throws if there's no microphone. ctx must run at 48 kHz, RNNoise's rate.
  async function open(ctx, { mic, ns }, log = () => {}) {
    const id = await pickDevice('audioinput', mic);
    const raw = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: true,
      noiseSuppression: ns === 'standard', autoGainControl: true, channelCount: 1 } });
    const src = ctx.createMediaStreamSource(raw);
    let node = null, dst = null;
    if (ns === 'strong') {
      try {
        node = new AudioWorkletNode(ctx, 'drift-denoise', { processorOptions: { module: await loadDenoise(ctx) }, numberOfInputs: 1, numberOfOutputs: 1,
          channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
        dst = ctx.createMediaStreamDestination();
        dst.channelCount = 1;
        src.connect(node).connect(dst);
      } catch (e) {       // no denoiser: open it again with Chromium's suppression instead
        log('noise suppression unavailable, using the standard one: ' + e.message);
        src.disconnect();
        for (const t of raw.getTracks()) t.stop();
        return open(ctx, { mic, ns: 'standard' }, log);
      }
    }
    const stream = dst ? dst.stream : raw;
    let closed = false;
    return { raw, stream, src, out: node || src, ns: ns === 'strong' || ns === 'standard' ? ns : 'off',
      close() {
        if (closed) return;
        closed = true;
        for (const t of [...raw.getTracks(), ...stream.getTracks()]) t.stop();       // stopped, so Windows' microphone light goes out too
        src.disconnect();
        if (node) { node.disconnect(); node.port.postMessage('close'); }       // the worklet frees RNNoise's memory
      } };
  }
  return { open, pickDevice };
})();
