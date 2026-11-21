// Runs on the audio thread for each incoming voice: reports the moment a sound starts after a silence (for measuring
// delay), and the loudness every 50 ms (for the "speaking" ring).
class Onset extends AudioWorkletProcessor {
  constructor() { super(); this.quiet = 0; this.on = false; this.peak = 0; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let s = 0;
    for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
    const rms = Math.sqrt(s / ch.length);
    if (rms < 0.005) { this.quiet += ch.length; if (this.quiet > sampleRate * 0.1) this.on = false; } else this.quiet = 0;
    if (!this.on && rms > 0.02) { this.on = true; this.port.postMessage({ on: currentTime }); }
    this.peak = Math.max(this.peak, rms);
    if ((this.n += ch.length) >= sampleRate * 0.05) { this.port.postMessage({ level: this.peak }); this.peak = 0; this.n = 0; }
    return true;
  }
}
registerProcessor('onset', Onset);
