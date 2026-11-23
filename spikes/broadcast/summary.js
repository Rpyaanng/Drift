// One line from one of encode.js's result files: node spikes/broadcast/summary.js <file> <label>
const fs = require('fs');
const [f, label] = process.argv.slice(2);
if (!fs.existsSync(f)) { console.log(label + ': FAILED (no result)'); process.exit(0); }
const r = JSON.parse(fs.readFileSync(f));
console.log(label + ': ' + JSON.stringify({
  enc: [...new Set(r.encoders.map((e) => (e || '?').replace('MediaFoundationVideoEncodeAccelerator', 'MF')))],
  codec: r.perViewer[0].codec, size: r.perViewer[0].size, fps: r.fpsEach, mbps: r.totalMbps, limited: r.limitedBy,
  casterCpu: r.casterCpuPercentOfOneCore, gpuProcCpu: r.gpuProcessCpuPercentOfOneCore, nvidia: r.nvidia,
}));
