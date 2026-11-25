(async () => {
  const out = {};
  try {
    // 1. can the page fetch the wasm from file:// itself?
    try { const r = await fetch('../../renderer/vendor/rnnoise.wasm'); out.fetchFile = r.ok ? (await r.arrayBuffer()).byteLength : 'status ' + r.status; } catch (e) { out.fetchFile = 'failed: ' + e.message; }
    // 2. bytes from main.js over IPC
    const bytes = await window.spike.wasm();
    const module = await WebAssembly.compile(bytes);
    out.compiled = true;
    const SR = 48000, LEN = SR * 4;
    const sig = new Float32Array(LEN), voiceOnly = new Float32Array(LEN);
    let seed = 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let i = 0; i < LEN; i++) {
      const t = i / SR, on = Math.floor(t) % 2 === 0;
      let v = 0;
      if (on) { const f0 = 140 * (1 + 0.1 * Math.sin(2 * Math.PI * 3 * t)); for (let k = 1; k <= 20; k++) v += Math.sin(2 * Math.PI * f0 * k * t) / k * (k > 3 && k < 9 ? 1.5 : 0.6); v *= 0.08 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t) ** 2); }
      const hiss = rnd() * 0.03, click = (i % 7919) < 120 ? rnd() * 0.25 * Math.exp(-(i % 7919) / 30) : 0;
      voiceOnly[i] = v; sig[i] = v + hiss + click;
    }
    const run = async (useNs) => {
      const ctx = new OfflineAudioContext(1, LEN, SR);
      const buf = ctx.createBuffer(1, LEN, SR); buf.copyToChannel(sig, 0);
      const src = ctx.createBufferSource(); src.buffer = buf;
      if (useNs) {
        await ctx.audioWorklet.addModule('../../renderer/noise-worklet.js');
        const node = new AudioWorkletNode(ctx, 'drift-denoise', { processorOptions: { module }, numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        src.connect(node).connect(ctx.destination);
      } else src.connect(ctx.destination);
      src.start();
      const t0 = performance.now();
      const r = await ctx.startRendering();
      return { data: r.getChannelData(0), ms: performance.now() - t0 };
    };
    const rms = (a, from, to) => { from = Math.floor(from); to = Math.floor(to); let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / (to - from)); };
    const db = (x) => +(20 * Math.log10(x + 1e-9)).toFixed(1);
    const measure = (a) => {
      // quiet: 1.2-1.8 s and 3.2-3.8 s; loud: 0.3-0.8 s and 2.3-2.8 s (skipping the edges)
      const q = (rms(a, 1.2 * SR, 1.8 * SR) + rms(a, 3.2 * SR, 3.8 * SR)) / 2, l = (rms(a, 0.3 * SR, 0.8 * SR) + rms(a, 2.3 * SR, 2.8 * SR)) / 2;
      return { quietDb: db(q), loudDb: db(l) };
    };
    const raw = await run(false), ns = await run(true);
    out.voiceOnly = measure(voiceOnly);
    out.input = measure(raw.data);
    out.denoised = measure(ns.data);
    out.renderMs4s = Math.round(ns.ms);
  } catch (e) { out.error = String(e && e.stack || e); }
  window.spike.out(out);
})();
