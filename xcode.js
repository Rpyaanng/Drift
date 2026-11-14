// Drift — live video conversion. ffmpeg re-encodes a video the built-in player can't show properly (HDR on an SDR
// screen, a codec Chromium lacks, or a smaller copy for a slow connection) into a stream it can, while it plays.
const { spawn, execFile } = require('child_process');

// Encoders Drift knows how to drive. speed = flags for real-time work; quality(q, kbps) = flags for a constant-quality
// encode (q is an H.264-style number, lower is better; kbps is a size-based fallback for encoders with no such mode).
const nv = (add) => ({ hw: true, speed: ['-preset', 'p4'], quality: (q) => ['-rc', 'vbr', '-cq', String(q + add), '-b:v', '0'] });
const qsv = (add) => ({ hw: true, speed: ['-preset', 'faster'], quality: (q) => ['-global_quality', String(q + add)] });
const amf = (add) => ({ hw: true, speed: ['-quality', 'speed'], quality: (q) => ['-rc', 'cqp', '-qp_i', String(q + add), '-qp_p', String(q + add + 2)] });
const byRate = { quality: (_q, kbps) => ['-b:v', kbps + 'k'] };
const ENCODERS = [
  { id: 'h264_nvenc', codec: 'H.264', name: 'NVIDIA graphics card', ...nv(1) },
  { id: 'h264_qsv', codec: 'H.264', name: 'Intel graphics', ...qsv(1) },
  { id: 'h264_amf', codec: 'H.264', name: 'AMD graphics card', ...amf(0) },
  { id: 'h264_videotoolbox', codec: 'H.264', name: 'Apple hardware', hw: true, speed: ['-realtime', '1'], ...byRate },
  { id: 'libx264', codec: 'H.264', name: 'processor (x264)', speed: ['-preset', 'veryfast'], quality: (q) => ['-crf', String(q)] },
  { id: 'h264_mf', codec: 'H.264', name: 'Windows built-in', hw: true, speed: [], ...byRate },
  { id: 'libopenh264', codec: 'H.264', name: 'processor (OpenH264)', speed: [], ...byRate },
  { id: 'hevc_nvenc', codec: 'H.265', name: 'NVIDIA graphics card', tag: 'hvc1', ...nv(3) },
  { id: 'hevc_qsv', codec: 'H.265', name: 'Intel graphics', tag: 'hvc1', ...qsv(3) },
  { id: 'hevc_amf', codec: 'H.265', name: 'AMD graphics card', tag: 'hvc1', ...amf(2) },
  { id: 'libx265', codec: 'H.265', name: 'processor (x265)', tag: 'hvc1', speed: ['-preset', 'ultrafast', '-x265-params', 'log-level=error'], quality: (q) => ['-crf', String(q + 4)] },
  { id: 'av1_nvenc', codec: 'AV1', name: 'NVIDIA graphics card', ...nv(9) },
  { id: 'av1_qsv', codec: 'AV1', name: 'Intel graphics', ...qsv(9) },
  { id: 'av1_amf', codec: 'AV1', name: 'AMD graphics card', ...amf(8) },
  { id: 'libsvtav1', codec: 'AV1', name: 'processor (SVT-AV1)', speed: ['-preset', '10'], quality: (q) => ['-crf', String(q + 12)] },
];
const AUTO = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'libx264', 'h264_mf', 'libopenh264'];   // what "Automatic" tries, in order
const TONES = { hable: 'hable', mobius: 'mobius', reinhard: 'reinhard' };
const REPLAY = 48e6;      // a stream can be joined from its start until this much has gone out
const AHEAD = 6e6;        // ffmpeg is held back once it is this far ahead of the slowest viewer

module.exports = function createXcoder(ffmpegPath) {
  let caps = null, detecting = null;
  const sessions = new Map(), bad = new Set();
  let lastError = '';

  const run = (args, ms = 15000) => new Promise((resolve) => {
    execFile(ffmpegPath(), args, { windowsHide: true, timeout: ms, maxBuffer: 8e6 }, (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), err: String(errOut || '') }));
  });
  // Which encoders and filters this copy of ffmpeg has, and which encoders actually start on this PC
  // (a build can include the NVIDIA encoder on a machine with no NVIDIA card).
  function detect() {
    if (caps) return Promise.resolve(caps);
    if (!ffmpegPath()) return Promise.resolve({ encoders: [], filters: new Set(), auto: '' });
    if (!detecting) detecting = (async () => {
      const [e, f] = await Promise.all([run(['-hide_banner', '-encoders']), run(['-hide_banner', '-filters'])]);
      const have = new Set([...e.out.matchAll(/^\s*V[\w.]{5}\s+(\S+)/gm)].map((m) => m[1]));
      const filters = new Set([...f.out.matchAll(/^\s*[\w.|]{2,3}\s+(\S+)\s+\S+->\S+/gm)].map((m) => m[1]));
      const present = ENCODERS.filter((x) => have.has(x.id));
      const ok = await Promise.all(present.map((x) => run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=30', '-frames:v', '3',
        '-pix_fmt', 'yuv420p', '-c:v', x.id, '-f', 'null', '-'], 12000).then((r) => r.ok)));
      const encoders = present.filter((_x, i) => ok[i]);
      caps = { encoders, filters, auto: (AUTO.map((id) => encoders.find((x) => x.id === id)).find(Boolean) || { id: '' }).id };
      return caps;
    })();
    return detecting;
  }
  const canTonemap = () => !!caps && ((caps.filters.has('zscale') && caps.filters.has('tonemap')) || caps.filters.has('libplacebo'));
  const list = () => (caps ? caps.encoders.map((x) => ({ id: x.id, label: `${x.codec} — ${x.name}`, auto: x.id === caps.auto })) : []);

  // ---- building the ffmpeg command ----
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  function size(info, height) {
    const h = Math.min(height || info.h || 0, 2160) || 0;
    if (!info.h || !info.w || !h || h >= info.h) return info.h > 2160 ? { w: even(info.w * 2160 / info.h), h: 2160 } : null;
    return { w: even(info.w * h / info.h), h: even(h) };
  }
  function filters(spec, tm) {
    const info = spec.info || {}, sz = size(info, spec.height), out = [];
    if (info.interlaced) out.push('yadif=0:-1:1');
    if (!info.hdr || tm === 'none') { if (sz) out.push(`scale=${sz.w}:${sz.h}:flags=bicubic`); out.push('format=yuv420p'); return out.join(','); }
    const tone = TONES[spec.tone] || 'hable';
    if (tm === 'placebo') {
      out.push(`libplacebo=${sz ? `w=${sz.w}:h=${sz.h}:` : ''}tonemapping=${tone}:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p`);
      return out.join(',');
    }
    // Say what the picture is before converting: plenty of HDR files carry no colour tags and zscale refuses to guess.
    out.push(`setparams=color_primaries=${info.prim || 'bt2020'}:color_trc=${info.hdr === 'hlg' ? 'arib-std-b67' : 'smpte2084'}:colorspace=${info.mtx || 'bt2020nc'}:range=${info.range === 'pc' ? 'pc' : 'tv'}`,
      `zscale=${sz ? `w=${sz.w}:h=${sz.h}:` : ''}t=linear:npl=100`, 'format=gbrpf32le', 'zscale=p=bt709', `tonemap=tonemap=${tone}:desat=0`, 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p');
    return out.join(',');
  }
  // Every way worth trying for this video, best first: graphics-card decoding, then plain; the chosen encoder, then Automatic's.
  function plans(spec) {
    const info = spec.info || {}, f = caps.filters, tms = [];
    if (!info.hdr) tms.push('none');
    else {
      const z = f.has('zscale') && f.has('tonemap'), p = f.has('libplacebo');
      if (info.dv === 5 && p) tms.push('placebo');       // Dolby Vision without an HDR10 layer needs libplacebo to get the colours right
      if (z) tms.push('zscale');
      if (p && !tms.includes('placebo')) tms.push('placebo');
      if (!tms.length) tms.push('none');
    }
    const encs = [];
    const want = caps.encoders.find((x) => x.id === spec.enc);
    if (want) encs.push(want);
    for (const id of AUTO) { const x = caps.encoders.find((y) => y.id === id); if (x && !encs.includes(x)) encs.push(x); }
    const out = [];
    for (const enc of encs.slice(0, want ? 3 : 2)) for (const tm of tms) for (const hw of [true, false]) out.push({ enc, tm, hw, sig: `${enc.id}|${tm}|${hw}` });
    const good = out.filter((p) => !bad.has(p.sig));
    return good.length ? good : out;
  }
  function args(spec, plan) {
    const info = spec.info || {}, enc = plan.enc, sz = size(info, spec.height), h = (sz ? sz.h : info.h) || 1080;
    const kbps = spec.rate || (h > 1440 ? 20000 : h > 1080 ? 12000 : h > 720 ? 8000 : h > 480 ? 4500 : 2000);
    const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (plan.hw) a.push('-hwaccel', 'auto');
    if (/^https?:/i.test(spec.input)) a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4');
    if (spec.start > 0) a.push('-ss', spec.start.toFixed(3));
    a.push('-i', spec.input, '-map', '0:V:0', '-map', '0:a:0?', '-sn', '-dn', '-vf', filters(spec, plan.tm), '-c:v', enc.id, ...enc.speed,
      ...(spec.rate ? ['-b:v', kbps + 'k', '-maxrate', kbps + 'k', '-bufsize', kbps * 2 + 'k'] : enc.quality(20, kbps)));
    if (enc.tag) a.push('-tag:v', enc.tag);
    a.push('-g', String(Math.round(Math.min(120, Math.max(10, info.fps || 30)) * 2)), '-c:a', 'aac', '-ac', '2', '-b:a', spec.rate && spec.rate < 2500 ? '128k' : '192k',
      '-max_muxing_queue_size', '2048', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000', '-f', 'mp4', 'pipe:1');
    return a;
  }

  // ---- one ffmpeg per stream, shared by every screen (or friend) that asks for the same thing ----
  function pump(s, c) {
    while (!c.waiting && c.at < s.base + s.chunks.length) {
      const ch = s.chunks[c.at - s.base]; c.at++; c.sent += ch.length;
      if (!c.head) { c.head = true; c.res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' }); }
      if (!c.res.write(ch)) { c.waiting = true; c.res.once('drain', () => { c.waiting = false; pump(s, c); flow(s); }); }
    }
    if (s.done && !c.waiting && c.at >= s.base + s.chunks.length && !c.res.writableEnded) { if (!c.head) { c.head = true; c.res.writeHead(s.total ? 200 : 500); } c.res.end(); }
  }
  function flow(s) {
    const cs = [...s.clients];
    if (cs.length && s.total > REPLAY) {      // too much to keep: drop what everyone has already had
      const keep = Math.min(...cs.map((c) => c.at));
      if (keep > s.base) { s.chunks.splice(0, keep - s.base); s.base = keep; s.intact = false; }
    }
    const behind = s.total - (cs.length ? Math.min(...cs.map((c) => c.sent)) : 0);
    if (s.kid && !s.done) { if (behind > AHEAD) s.kid.stdout.pause(); else s.kid.stdout.resume(); }
  }
  function start(s) {
    const plan = s.plans[s.plan], kid = spawn(ffmpegPath(), args(s.spec, plan), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    s.kid = kid; let err = '';
    kid.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    kid.stdout.on('data', (d) => { s.chunks.push(d); s.total += d.length; for (const c of s.clients) pump(s, c); flow(s); });
    const over = (code) => {
      if (s.kid !== kid) return;
      s.kid = null;
      if (s.dead) return;
      if (code !== 0 && !s.total) {          // never produced a frame: that way of converting doesn't work here
        bad.add(plan.sig); lastError = `${plan.sig}: ${err.trim().slice(-600)}`;
        if (++s.plan < s.plans.length) { start(s); return; }
      } else if (code !== 0) lastError = `${plan.sig} (mid-stream): ${err.trim().slice(-600)}`;
      s.done = true; for (const c of s.clients) pump(s, c);
    };
    kid.on('error', () => over(-1)); kid.on('close', over);
  }
  function drop(s) {
    s.dead = true; clearTimeout(s.idle); sessions.delete(s.key);
    if (s.kid) { try { s.kid.kill(); } catch { /* gone */ } }
    for (const c of s.clients) { if (!c.head) { c.head = true; c.res.writeHead(503); } c.res.end(); }
    s.clients.clear(); s.chunks = [];
  }
  // spec: { key, input, start, info, height, tone, enc, rate }. Answers the request with a fragmented MP4 that starts at `start`.
  async function serve(req, res, spec) {
    let gone = false; res.on('close', () => { gone = true; });
    await detect();
    if (gone) return;
    if (!ffmpegPath() || !caps.encoders.length) { res.writeHead(503); res.end(); return; }
    let s = sessions.get(spec.key);
    if (s && !s.intact) { res.writeHead(409); res.end(); return; }     // too far along to join: the caller asks for a fresh stream
    if (!s) {
      if (sessions.size >= 12) drop([...sessions.values()].find((x) => !x.clients.size) || sessions.values().next().value);
      s = { key: spec.key, spec, plans: plans(spec), plan: 0, chunks: [], base: 0, total: 0, clients: new Set(), kid: null, done: false, dead: false, intact: true, idle: null };
      sessions.set(s.key, s); start(s);
    }
    const c = { res, at: 0, sent: 0, waiting: false, head: false };
    s.clients.add(c); clearTimeout(s.idle);
    res.on('close', () => { s.clients.delete(c); if (!s.clients.size && !s.dead) s.idle = setTimeout(() => drop(s), 2500); else flow(s); });
    pump(s, c); flow(s);
  }
  const stopAll = () => { for (const s of [...sessions.values()]) drop(s); };

  return { detect, list, canTonemap, serve, stopAll, lastError: () => lastError, active: () => sessions.size, ready: () => !!caps, auto: () => (caps ? caps.auto : '') };
};
