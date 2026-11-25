/* Drift — noise suppression for the microphone (renderer/voice.js). An AudioWorklet that runs RNNoise (Xiph's small
   recurrent network, built to WebAssembly by Jitsi: renderer/vendor/rnnoise.wasm, Apache-2.0 / BSD) on the voice room's
   microphone before it's sent. It runs on this PC alone, costs about 1% of one core, and adds 10 ms of delay: RNNoise works
   on 480-sample frames (10 ms at 48 kHz) and a worklet is handed 128 at a time, so samples wait in a queue for a frame.

   voice.js compiles the wasm and passes the module in processorOptions. It is Emscripten's build without Emscripten's
   glue, so the export names are its minified ones: c memory, d constructors, f rnnoise_create, g malloc, h rnnoise_destroy,
   i free, j rnnoise_process_frame. Its two imports are a.a (grow the heap) and a.b (a big memcpy). */
const FRAME = 480;
class Denoise extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    let mem = null;
    const x = new WebAssembly.Instance(opts.processorOptions.module, { a: {
      a: (size) => { try { mem.grow(Math.ceil(((size >>> 0) - mem.buffer.byteLength) / 65536)); return 1; } catch { return 0; } },
      b: (dest, src, num) => { new Uint8Array(mem.buffer).copyWithin(dest, src, src + num); },
    } }).exports;
    mem = x.c;
    x.d();
    this.x = x;
    this.st = x.f(0);
    this.ptr = x.g(FRAME * 4);       // in and out share one buffer: rnnoise_process_frame allows it
    this.frame = new Float32Array(FRAME); this.n = 0;
    this.q = new Float32Array(4096); this.qr = 0; this.qn = 0;       // denoised samples waiting to go out (a ring)
    this.vad = 0; this.frames = 0;
    this.done = false;
    this.port.onmessage = (e) => { if (e.data === 'close') this.close(); else if (e.data === 'vad') this.port.postMessage({ vad: this.vad, frames: this.frames }); };
  }
  close() {
    if (this.done) return;
    this.done = true;
    this.x.h(this.st); this.x.i(this.ptr);
  }
  run() {
    const heap = new Float32Array(this.x.c.buffer, this.ptr, FRAME), f = this.frame;
    for (let i = 0; i < FRAME; i++) heap[i] = f[i] * 32768;       // RNNoise wants 16-bit sample values
    this.vad = this.x.j(this.st, this.ptr, this.ptr);
    this.frames++;
    const q = this.q, len = q.length;
    for (let i = 0; i < FRAME; i++) q[(this.qr + this.qn + i) % len] = heap[i] / 32768;
    this.qn = Math.min(len, this.qn + FRAME);
  }
  process(inputs, outputs) {
    if (this.done) return false;
    const inp = inputs[0] && inputs[0][0], out = outputs[0][0];
    const n = out.length;
    for (let i = 0; i < n; i++) {
      this.frame[this.n++] = inp ? inp[i] : 0;
      if (this.n === FRAME) { this.run(); this.n = 0; }
    }
    if (this.qn >= n) {       // (until the first frame is ready, silence)
      const q = this.q, len = q.length;
      for (let i = 0; i < n; i++) out[i] = q[(this.qr + i) % len];
      this.qr = (this.qr + n) % len; this.qn -= n;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor('drift-denoise', Denoise);
