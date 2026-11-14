// Drift — main process: one fullscreen window per monitor, shared state, hidden audio engine window.
const { app, BrowserWindow, ipcMain, screen, dialog, powerSaveBlocker, shell, session, desktopCapturer, net, clipboard } = require('electron');
const { pathToFileURL } = require('url');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const subsLib = require('./subtitles');
const createXcoder = require('./xcode');
const createP2P = require('./p2p');

if (process.env.DRIFT_USERDATA) app.setPath('userData', path.resolve(process.env.DRIFT_USERDATA));   // dev: a second copy with its own settings (e.g. to try sharing on one PC)

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');   // media keys must reach Spotify, not Drift
app.commandLine.appendSwitch('disable-background-timer-throttling');

const FAKE = parseInt(process.env.DRIFT_FAKE_DISPLAYS || '0', 10); // dev: split one screen into N panes
const SHOT_DIR = process.env.DRIFT_SHOTS || '';                    // dev: write screenshots here
const AUDIO_EXT = ['.mp3', '.flac', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.weba', '.webm'];
const VIDEO_EXT = ['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv', '.avi'];
const MIME = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg', '.weba': 'audio/webm', '.webm': 'audio/webm' };

const DEFAULTS = {
  scene: 'aurora',
  mode: 'span',            // span | mirror | mix
  perDisplay: {},          // mix mode: { d0: 'nebula', ... }
  palette: 'aurora',
  speed: 1,
  brightness: 1,
  reactivity: 0.7,
  overlay: 'none',
  cycleSecs: 30,
  algoInfo: true,
  customColors: null,      // four '#rrggbb' colours once the user has made their own palette
  autoCycle: 0,            // minutes, 0 = off
  cycleShuffle: false,
  displaysOff: [],         // indices of monitors left alone
  quality: 0.75,
  fps: 60,
  clock: false,
  breathing: false,
  keepAwake: true,
  onTop: false,
  sleepAt: 0,
  // hdr: auto = convert HDR videos to SDR on screens that aren't showing HDR | always | never; tone = how bright highlights are squeezed in;
  // enc = which ffmpeg encoder converts (auto = the fastest that works on this PC); xq = picture height of converted video (auto = the screen's)
  video: { files: [], index: 0, layout: 'each', fit: 'auto', paused: false, sound: true, volume: 0.8, folders: [], foldersInit: false,
    hdr: 'auto', tone: 'hable', enc: 'auto', xq: 'auto' },
  // watch together: internet = ask the router to let friends outside the home in; control = friends may play / pause / seek;
  // wait = pause for everyone while someone is loading; quality = picture size sent to (and asked from) friends
  share: { name: '', internet: true, control: true, wait: true, quality: 'original', port: 47800 },
  // subtitles: on = show them when a video has some; perFile remembers the track and timing chosen for each video
  subs: { on: true, lang: 'en', size: 1, color: '#ffffff', bg: 'outline', lift: 0, perFile: {} },
  prevScene: 'aurora',
  frozen: false,           // scene animation paused
  settingsVersion: 4,
  music: {
    playing: true,
    source: 'generative',  // generative | files | spotify | off
    folders: [], foldersInit: false,
    preset: 'pads',
    volume: 0.6,
    nature: { rain: 0, waves: 0, wind: 0, fire: 0 },
    playlist: [],
    shuffle: false,
  },
};

let state = JSON.parse(JSON.stringify(DEFAULTS));
let settingsFile;
let visWins = [];          // [{win, key, index, bounds}]
let audioWin = null;
let nowPlaying = { title: '', index: -1 };
let vclock = { startedAt: Date.now(), pos: 0 };   // shared video timeline so every monitor stays in step
let videoFails = 0, xcAt = 0, goodbye = false;
let clock = { base: 0, ref: Date.now() };   // visual time: t = base + (now-ref)/1000*speed
let saveTimer = null, cycleTimer = null, sleepTimer = null, rebuildTimer = null;
let blockerId = null;
let quitting = false;

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    state = { ...DEFAULTS, ...s, music: { ...DEFAULTS.music, ...(s.music || {}), nature: { ...DEFAULTS.music.nature, ...((s.music || {}).nature || {}) } } };
    state.sleepAt = 0; state.frozen = false;
    state.video = { ...DEFAULTS.video, ...(s.video || {}) };
    state.subs = { ...DEFAULTS.subs, ...(s.subs || {}) };
    state.share = cleanShare({ ...DEFAULTS.share, ...(s.share || {}) });
    if (!state.subs.perFile || typeof state.subs.perFile !== 'object' || Array.isArray(state.subs.perFile)) state.subs.perFile = {};
    state.video.files = (state.video.files || []).filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    state.video.index = Math.min(state.video.index || 0, Math.max(0, state.video.files.length - 1));
    if (!state.video.files.length) dropVideoScene();
    if ((s.settingsVersion || 1) < 2) state.video.sound = true;     // video sound used to default to off, which read as "broken audio"
    if ((s.settingsVersion || 1) < 3) {       // layout and fit used to be one setting
      const old = (s.video || {}).fit;
      state.video.layout = old && old !== 'each' ? 'span' : 'each';
      state.video.fit = old === 'contain' || old === 'fill' ? old : 'auto';
    }
    if ((s.settingsVersion || 1) < 4 && state.reactivity === 0.5) state.reactivity = 0.7;   // sound reactions are stronger by default now
    state.settingsVersion = 4; state.video.paused = false;
    const known = (id) => id === 'video' || SCENES.includes(id);
    if (!known(state.scene)) state.scene = 'aurora';
    for (const k of Object.keys(state.perDisplay || {})) if (!known(state.perDisplay[k])) delete state.perDisplay[k];
    if (state.palette === 'custom' && !Array.isArray(state.customColors)) state.palette = 'aurora';
    state.video.folders = (state.video.folders || []).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    state.music.playlist = (state.music.playlist || []).filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (state.music.source === 'files' && !state.music.playlist.length) state.music.source = 'generative';
    state.music.folders = (state.music.folders || []).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  } catch { /* first run */ }
}
const QUALITY = { original: { h: 0, kbps: 0 }, 1080: { h: 1080, kbps: 6000 }, 720: { h: 720, kbps: 3000 }, 480: { h: 480, kbps: 1200 } };
function cleanShare(q) {
  return { name: String(q.name || '').replace(/[\x00-\x1f<>]/g, '').slice(0, 24), internet: !!q.internet, control: !!q.control, wait: !!q.wait,
    quality: QUALITY[q.quality] ? String(q.quality) : 'original', port: q.port >= 1024 && q.port <= 65535 ? Math.round(q.port) : DEFAULTS.share.port };
}
function dropVideoScene() {
  if (state.scene === 'video') state.scene = 'aurora';
  for (const k of Object.keys(state.perDisplay)) if (state.perDisplay[k] === 'video') delete state.perDisplay[k];
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(settingsFile, JSON.stringify(state, null, 1)); } catch { /* ignore */ }
  }, 400);
}

function allDisplays() {
  let list;
  if (FAKE > 1) {
    const b = screen.getPrimaryDisplay().bounds;
    const w = Math.floor(b.width / FAKE);
    list = Array.from({ length: FAKE }, (_, i) => ({ id: i, bounds: { x: b.x + i * w, y: b.y, width: w, height: b.height }, primary: i === 0 }));
  } else {
    const pid = screen.getPrimaryDisplay().id;
    list = screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, primary: d.id === pid, scale: d.scaleFactor || 1 }));
  }
  list.sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  return list.map((d, i) => ({ ...d, index: i, key: 'd' + i }));
}
function activeDisplays() {
  const all = allDisplays();
  const act = all.filter((d) => !state.displaysOff.includes(d.index));
  return act.length ? act : all;
}
function unionOf(list) {
  const x0 = Math.min(...list.map((d) => d.bounds.x)), y0 = Math.min(...list.map((d) => d.bounds.y));
  const x1 = Math.max(...list.map((d) => d.bounds.x + d.bounds.width)), y1 = Math.max(...list.map((d) => d.bounds.y + d.bounds.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// ---- what is playing, and what the built-in player can do with it ------------------------------------
// ffmpeg helps in three ways: it converts sound the player can't decode (Dolby AC-3 / E-AC-3, DTS, TrueHD...), reads
// subtitles stored inside a video, and re-encodes the picture when the player can't show it properly (HDR on an SDR
// screen, codecs Chromium lacks). All of it is served to the monitors over a private local port.
const NATIVE_AUDIO = /^(aac|mp3|opus|vorbis|flac|pcm_|alac)/;
const NATIVE_VIDEO = /^(h264|hevc|vp8|vp9|av1|theora)$/;      // anything else (MPEG-2, Xvid, WMV, ProRes...) is converted from the start
const INFO_BLANK = { dur: 0, hdr: '', vcodec: '', w: 0, h: 0, fps: 0, prim: '', mtx: '', range: '', dv: 0, interlaced: false, force: false };
const audioToken = crypto.randomBytes(16).toString('hex');
let audioPort = 0, videoAudio = { mode: 'native', codec: '', ffmpeg: true }, videoInfo = { ...INFO_BLANK }, probeSeq = 0, probing = false;
const audioKids = new Set();
const forced = new Set();     // videos the built-in player choked on: these are converted
let remote = null;            // while watching with a friend: what their PC says is playing
let ownCopy = { key: '', path: '' };      // ...and this PC's own copy of that file, when it has one
const local = (p) => `http://127.0.0.1:${audioPort}${p}${p.includes('?') ? '&' : '?'}k=${audioToken}`;
// The video that is up right now: its place in the list, where its bytes come from, and a name to remember choices by.
function cur() {
  if (remote) {
    const r = remote.files[remote.index];
    if (!r) return null;
    const key = `shared:${r.name}|${r.size}`, mine = ownCopy.key === key ? ownCopy.path : '';
    return { index: remote.index, name: r.name, key, src: mine || local(`/p/f?i=${remote.index}`), path: mine, remote: true };
  }
  const f = state.video.files[state.video.index];
  return f ? { index: state.video.index, name: path.basename(f), key: f, src: f, path: f, remote: false } : null;
}
// ffmpeg.exe normally sits in the app's resources folder. A copy run from source, or a build made without it, also
// looks in vendor/ and then anywhere on the PATH, so sound conversion doesn't silently switch off.
let ffFound = null;
function ffmpegPath() {
  if (ffFound) return ffFound;
  if (process.env.DRIFT_NO_FFMPEG) return null;       // dev: behave like a copy that shipped without it
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const cands = [process.env.DRIFT_FFMPEG, path.join(process.resourcesPath || '', exe), path.join(__dirname, exe), path.join(__dirname, 'vendor', exe),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe))].filter(Boolean);
  ffFound = cands.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
  return ffFound;
}
// Reads what ffmpeg prints about a file: length, sound format, picture size and whether it is HDR.
function readProbe(err, name) {
  const info = { ...INFO_BLANK };
  const d = /Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(err);
  if (d) info.dur = +d[1] * 3600 + +d[2] * 60 + +d[3];
  const v = [...err.matchAll(/Stream #0:\d+[^\n]*?: Video: ([a-z0-9_]+)([^\n]*)/gi)].find((m) => !/attached pic/.test(m[2]));     // not the cover picture
  if (v) {
    const rest = v[2];
    info.vcodec = v[1].toLowerCase();
    const sz = /, (\d{2,5})x(\d{2,5})\b/.exec(rest); if (sz) { info.w = +sz[1]; info.h = +sz[2]; }
    const fps = /([\d.]+) fps/.exec(rest) || /([\d.]+) tbr/.exec(rest); if (fps) info.fps = +fps[1] || 0;
    const col = /\((?:(?:tv|pc), )?([a-z0-9-]+)\/([a-z0-9-]+)\/([a-z0-9-]+)/i.exec(rest);      // "yuv420p10le(tv, bt2020nc/bt2020/smpte2084, progressive)"
    if (col) {
      info.hdr = col[3] === 'smpte2084' ? 'pq' : col[3] === 'arib-std-b67' ? 'hlg' : '';
      info.mtx = /^bt2020n?c$/.test(col[1]) ? col[1] : ''; info.prim = col[2] === 'bt2020' ? col[2] : '';
    }
    info.range = (/\((tv|pc)[,)]/.exec(rest) || [])[1] || '';
    info.interlaced = /\b(top|bottom) (coded )?first\b/.test(rest);
    const dv = /DOVI configuration record:[^\n]*profile: (\d+)/.exec(err);
    if (dv) { info.dv = +dv[1]; if (!info.hdr) info.hdr = 'pq'; }
    info.force = !NATIVE_VIDEO.test(info.vcodec) || /\.avi$/i.test(name);
  }
  const m = /Stream #0:\d+[^\n]*?: Audio: ([a-z0-9_]+)/i.exec(err);
  const audio = m ? { mode: NATIVE_AUDIO.test(m[1]) ? 'native' : 'transcode', codec: m[1] } : { mode: v ? 'none' : 'native', codec: '' };
  return { info, audio };
}
function probe() {
  const c = cur(), ff = ffmpegPath(), seq = ++probeSeq;
  videoAudio = { mode: 'native', codec: '', ffmpeg: !!ff }; videoInfo = { ...INFO_BLANK, force: !!c && forced.has(c.key) }; probing = false;
  if (c && c.remote) {       // the sharing PC has already looked inside the file
    const ri = remote.info || {};
    videoInfo = { ...INFO_BLANK, ...ri, force: !!ri.force || forced.has(c.key) };
    videoAudio = { mode: 'native', codec: '', ...(remote.audio || {}), ffmpeg: !!ff };
    startSubs(c, remote.tracks ? [] : null);
    return;
  }
  if (!c || !ff) { startSubs(c, []); return; }     // without ffmpeg only subtitle files next to the video can be used
  probing = true; startSubs(c, null);
  let err = '';
  const p = spawn(ff, ['-hide_banner', '-i', c.src], { windowsHide: true });
  p.stderr.on('data', (d) => { if (err.length < 400000) err += d; });
  p.on('error', () => {});
  p.on('close', () => {
    if (seq !== probeSeq) return;
    const r = readProbe(err, c.name);
    probing = false; videoAudio = { ...r.audio, ffmpeg: true }; videoInfo = { ...r.info, force: r.info.force || forced.has(c.key) };
    startSubs(c, embeddedSubs(err));
    if (xcActive()) xcRestart(vpos() < 3 ? 0 : undefined); else pushState();
  });
}

// ---- converted video: one live stream per video, started again whenever playback jumps ----------------
let xcLead = 1500;        // ms ffmpeg needs before pictures arrive (measured as it goes); the shared clock waits this long so nothing is skipped
const xcoder = createXcoder(ffmpegPath);
let xc = { epoch: 1, start: 0 }, xcTimer = null, xcFails = 0, encFallback = false;
const vpaused = () => (remote ? !!remote.paused : state.video.paused);
const vcount = () => (remote ? remote.files.length : state.video.files.length);
function vpos() {
  let p = vpaused() ? vclock.pos : (Date.now() - vclock.startedAt) / 1000;
  if (vcount() === 1 && videoInfo.dur > 1 && p > 0) p %= videoInfo.dur;      // a single video loops
  return p;
}
// The picture size friends get: the smaller of what this PC asks for and what the sharing PC allows.
function shareQuality() {
  const a = state.share.quality, b = remote && QUALITY[remote.cap] ? String(remote.cap) : 'original';
  return !QUALITY[a].h ? b : !QUALITY[b].h ? a : QUALITY[a].h <= QUALITY[b].h ? a : b;
}
// As a guest: let the sharing PC do the converting when a smaller picture was asked for, or when this PC has no ffmpeg of its own.
function viaHost() {
  const c = cur();
  if (!c || !c.remote || c.path || !remote.xc) return false;
  return shareQuality() !== 'original' || (!ffmpegPath() && (videoInfo.force || videoAudio.mode === 'transcode'));
}
// Which monitors should take the converted stream: all of them, or only the ones not showing HDR.
function xcWant() {
  const c = cur(), host = viaHost();
  if (!c || !(host || ffmpegPath())) return { all: false, sdr: false };
  const hdr = !!videoInfo.hdr && (host || !xcoder.ready() || xcoder.canTonemap());
  return { all: host || videoInfo.force || (hdr && state.video.hdr === 'always'), sdr: hdr && state.video.hdr === 'auto' };
}
const xcActive = () => { const w = xcWant(); return w.all || (w.sdr && visWins.some((v) => v.hdr === false)); };
function xcBase() {
  const c = cur(), v = state.video;
  if (!c || !audioPort) return '';
  if (viaHost()) return local(`/p/x?i=${c.index}&q=${shareQuality()}`);
  return ffmpegPath() ? local(`/x?i=${c.index}&c=${[v.tone, encFallback ? 'auto' : v.enc, v.xq].join('.')}`) : '';
}
// No point converting more pixels than the screens have.
function xcHeight() {
  const q = parseInt(state.video.xq, 10);
  if (q) return q;
  const act = activeDisplays(), scale = Math.max(...act.map((d) => d.scale || 1));
  const h = state.mode === 'span' && state.video.layout === 'span' ? unionOf(act).height : Math.max(...act.map((d) => d.bounds.height));
  return Math.max(480, Math.round(h * scale));
}
// Starts the stream again from where playback is (or from `from`). A stream can't be searched, so every jump needs a new one.
function xcRestart(from, wait) {
  clearTimeout(xcTimer);
  const go = () => {
    let pos = from !== undefined ? from : Math.max(0, vpos());
    if (!vpaused() && xcActive()) {
      if (remote) pos += (xcLead + 700) / 1000;                                    // a friend's clock can't be moved: start a little ahead and wait for it
      else vclock = { ...vclock, startedAt: Date.now() + xcLead - pos * 1000 };     // hold the clock until pictures arrive
    }
    xc = { epoch: xc.epoch + 1, start: Math.round(pos * 100) / 100 };
    pushState();
  };
  if (wait) xcTimer = setTimeout(go, wait); else go();
}
function xcSpec(key, input, start, q) {
  return { key, input, start, info: videoInfo, tone: state.video.tone, enc: encFallback ? 'auto' : state.video.enc,
    height: q ? QUALITY[q].h : xcHeight(), rate: q ? QUALITY[q].kbps : 0 };
}

// ---- subtitles ---------------------------------------------------------------------------------------
// Sources: tracks inside the video (read with ffmpeg), subtitle files next to it, files the user loads, and online lookups.
const SUB_EXT = ['.srt', '.vtt', '.ass', '.ssa'];
const TEXT_SUB = /^(subrip|srt|ass|ssa|mov_text|webvtt|text)$/i;
const SUB_BLANK = { file: '', tracks: [], sel: '', offset: 0, busy: false, note: '', guess: null };
let subInfo = { ...SUB_BLANK, seq: 0 }, subCues = [], subJob = 0, subEmbedded = [];
let subSrc = null;        // the video the subtitles belong to (see cur())
const kindOf = (t) => t.from || t.kind;
function embeddedSubs(err) {
  const out = [], lines = String(err).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([a-z]{2,3})\))?: Subtitle: ([a-z0-9_]+)(.*)$/i.exec(lines[i]);
    if (!m) continue;
    let title = '';
    for (let j = i + 1; j < lines.length && !/^\s*Stream #/.test(lines[j]); j++) { const t = /^\s*title\s*:\s*(.+)$/i.exec(lines[j]); if (t) { title = t[1].trim(); break; } }
    const lang = (subsLib.langOf(m[2]) || { code: '' }).code, usable = TEXT_SUB.test(m[3]);
    const name = subsLib.langName(lang) || (m[2] && m[2] !== 'und' ? m[2].toUpperCase() : 'Unknown language');
    out.push({ id: 'e:' + m[1], kind: 'embedded', stream: +m[1], lang, usable, def: /\(default\)/.test(m[4]), forced: /\(forced\)/.test(m[4]) || /forced/i.test(title),
      sdh: /sdh|hearing|\bcc\b|comment/i.test(title),
      label: name + (title && title.toLowerCase() !== name.toLowerCase() ? ' — ' + title : '') + (usable ? ' · in the video' : ' · picture-based, can\'t be shown') });
  }
  return out;
}
function sidecarSubs(f) {
  const dir = path.dirname(f), stem = path.basename(f, path.extname(f)).toLowerCase(), out = [], seen = new Set();
  for (const d of [dir, path.join(dir, 'Subs'), path.join(dir, 'Subtitles')]) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      const ext = path.extname(n).toLowerCase(), full = path.join(d, n);
      if (!SUB_EXT.includes(ext) || !n.toLowerCase().startsWith(stem) || seen.has(full.toLowerCase()) || out.length >= 40) continue;
      seen.add(full.toLowerCase());
      const rest = n.slice(stem.length, n.length - ext.length).split(/[._\s()[\]-]+/).filter(Boolean);
      const lang = rest.map((w) => subsLib.langOf(w)).find(Boolean);
      out.push({ id: 'f:' + full, kind: 'file', path: full, lang: lang ? lang.code : '', usable: true, sdh: rest.some((w) => /^(sdh|cc|hi)$/i.test(w)), forced: rest.some((w) => /^forced$/i.test(w)),
        label: (lang ? lang.name : 'Subtitle file') + ' · ' + n });
    }
  }
  return out;
}
function subPrefs(f, make) {
  let p = state.subs.perFile[f];
  if (!p && make) {
    const keys = Object.keys(state.subs.perFile);
    if (keys.length >= 300) for (const k of keys.slice(0, keys.length - 299)) delete state.subs.perFile[k];    // remember the most recent 300 videos
    p = state.subs.perFile[f] = {};
  }
  return p || {};
}
function autoSub(tracks) {
  const ok = tracks.filter((t) => t.usable), want = state.subs.lang;
  const rank = (t) => (kindOf(t) !== 'embedded' ? 4 : 0) + (t.sdh ? 0 : 2) + (t.def ? 1 : 0) - (t.forced ? 8 : 0);
  const inLang = ok.filter((t) => t.lang === want).sort((a, b) => rank(b) - rank(a));
  if (inLang.length) return inLang[0].id;
  const loose = ok.filter((t) => kindOf(t) !== 'embedded' && !t.lang);       // "movie.srt" beside "movie.mkv" is almost always meant for it
  if (loose.length) return loose[0].id;
  const emb = ok.filter((t) => kindOf(t) === 'embedded');
  return emb.length === 1 && !emb[0].lang ? emb[0].id : '';
}
// embedded === null means the video is still being examined.
// c is the current video (see cur()), or null when nothing is playing.
function startSubs(c, embedded) {
  const job = ++subJob;
  subCues = []; subSrc = c || null;
  if (!c) { subEmbedded = []; subInfo = { ...SUB_BLANK, seq: subInfo.seq + 1 }; return; }
  const f = c.key;
  if (embedded) subEmbedded = embedded; else if (subInfo.file !== f) subEmbedded = [];
  const prefs = subPrefs(f);
  const added = (prefs.added || []).filter((a) => { try { return fs.statSync(a.path).isFile(); } catch { return false; } })
    .map((a) => ({ id: 'f:' + a.path, kind: 'added', path: a.path, lang: a.lang || '', usable: true, label: a.label }));
  const files = c.remote ? [] : sidecarSubs(f).filter((t) => !added.some((a) => a.id === t.id));
  // A friend's video: their PC lists the subtitles it has and hands over the lines of whichever one is picked here.
  const theirs = c.remote ? ((remote && remote.tracks) || []).map((t) => ({ id: 'r:' + t.id, kind: 'shared', from: t.kind, lang: t.lang || '', usable: true, def: !!t.def, forced: !!t.forced, sdh: !!t.sdh,
    label: String(t.label || 'Subtitles').slice(0, 160) })) : [];
  const tracks = [...added, ...files, ...subEmbedded, ...theirs];
  let sel = '';
  if (state.subs.on && embedded) sel = tracks.some((t) => t.id === prefs.sel && t.usable) ? prefs.sel : autoSub(tracks);
  subInfo = { file: f, tracks, sel, offset: +prefs.offset || 0, busy: !!sel || (!embedded && state.subs.on), note: '', guess: subsLib.parseName(c.name), seq: subInfo.seq + 1 };
  if (sel) loadSub(job, tracks.find((t) => t.id === sel));
}
function embeddedCues(f, stream) {
  return new Promise((resolve, reject) => {
    const ff = ffmpegPath();
    if (!ff) { reject(new Error('no ffmpeg')); return; }
    let st = { size: 0, mtimeMs: 0 };
    try { st = fs.statSync(f); } catch { /* read it anyway */ }
    const dir = path.join(app.getPath('userData'), 'subcache'), cache = path.join(dir, subsLib.hash(`${f}|${st.size}|${st.mtimeMs}|${stream}`) + '.vtt');
    try { resolve(subsLib.parseSubtitle(fs.readFileSync(cache), 'vtt')); return; } catch { /* not read before */ }
    const chunks = []; let size = 0;
    const kid = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-i', f, '-map', '0:' + stream, '-f', 'webvtt', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    audioKids.add(kid);
    kid.stdout.on('data', (d) => { size += d.length; if (size < 30e6) chunks.push(d); });
    kid.on('error', (e) => { audioKids.delete(kid); reject(e); });
    kid.on('close', (code) => {
      audioKids.delete(kid);
      const buf = Buffer.concat(chunks);
      if (code !== 0 && !buf.length) { reject(new Error('ffmpeg exit ' + code)); return; }
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cache, buf); } catch { /* cache is optional */ }
      resolve(subsLib.parseSubtitle(buf, 'vtt'));
    });
  });
}
const readCues = async (tr, file) => (tr.kind === 'embedded' ? embeddedCues(file, tr.stream) : subsLib.parseSubtitle(await fs.promises.readFile(tr.path), path.extname(tr.path)));
// Lines sent by another PC are cleaned again here, so nothing but plain text and italics / bold can reach the screen.
const safeCues = (list) => (Array.isArray(list) ? list : []).slice(0, 20000).map((c) => ({ s: +c.s, e: +c.e, t: subsLib.cleanText(String(c.t || '').slice(0, 2000)).t, top: !!c.top }))
  .filter((c) => isFinite(c.s) && c.e > c.s && c.t);
async function loadSub(job, tr) {
  let cues = [], note = '';
  try {
    cues = tr.kind === 'shared' ? safeCues(await p2p.json(`/c?i=${subSrc.index}&id=${encodeURIComponent(tr.id.slice(2))}`)) : await readCues(tr, subInfo.file);
    if (!cues.length) note = 'That subtitle track has nothing in it.';
  } catch { note = 'Those subtitles could not be read.'; }
  if (job !== subJob) return;
  subCues = cues; subInfo = { ...subInfo, busy: false, note, seq: subInfo.seq + 1 };
  pushState();
}
function selectSub(id) {
  const f = subInfo.file; if (!f) return;
  const job = ++subJob;
  subCues = [];
  if (!id || id === 'off') { state.subs.on = false; subInfo = { ...subInfo, sel: '', busy: false, note: '', seq: subInfo.seq + 1 }; pushState(); saveSoon(); return; }
  const tr = subInfo.tracks.find((t) => t.id === id && t.usable);
  if (!tr) return;
  state.subs.on = true; subPrefs(f, true).sel = id;
  subInfo = { ...subInfo, sel: id, busy: true, note: '', seq: subInfo.seq + 1 };
  pushState(); saveSoon();
  loadSub(job, tr);
}
function toggleSubs() {
  if (!subInfo.file) return;
  if (state.subs.on && subInfo.sel) { selectSub('off'); return; }
  state.subs.on = true;
  startSubs(subSrc, subEmbedded);
  if (!subInfo.sel) subInfo = { ...subInfo, busy: false, note: subInfo.tracks.some((t) => t.usable) ? 'No subtitles in your language here — pick a track in the Video tab.' : 'No subtitles for this video yet — use "Find online" in the Video tab.' };
  pushState(); saveSoon();
}
function addSubFile(p, label, lang) {
  const f = subInfo.file; if (!f) return;
  const prefs = subPrefs(f, true);
  prefs.added = [{ path: p, label, lang: lang || '' }, ...(prefs.added || []).filter((a) => a.path !== p)].slice(0, 12);
  prefs.sel = 'f:' + p; state.subs.on = true;
  startSubs(subSrc, subEmbedded);
  pushState(); saveSoon();
}
const webFetch = (url, opts) => net.fetch(url, opts);
// Only this PC's own windows (and its own ffmpeg) use this server: it listens on 127.0.0.1 and wants the token.
function startLocalServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1'), c = cur(), ff = ffmpegPath(), i = parseInt(u.searchParams.get('i'), 10);
    const no = () => { res.writeHead(404); res.end(); };
    if (u.searchParams.get('k') !== audioToken || !c || i !== c.index) { no(); return; }
    const t = Math.max(0, parseFloat(u.searchParams.get('t')) || 0);
    if (u.pathname === '/p/f') { if (c.remote) p2p.relay(req, res, `/f?i=${i}`); else no(); return; }       // a friend's video, fetched from their PC
    if (u.pathname === '/p/x') {                                                                            // ...or a smaller copy their PC converts for us
      if (c.remote) p2p.relay(req, res, `/x?i=${i}&t=${t}&q=${QUALITY[u.searchParams.get('q')] ? u.searchParams.get('q') : 'original'}&e=${parseInt(u.searchParams.get('e'), 10) || 0}`); else no();
      return;
    }
    if (!ff) { no(); return; }
    if (u.pathname === '/x') { xcoder.serve(req, res, xcSpec(req.url, c.src, t)); return; }
    if (u.pathname !== '/a') { no(); return; }
    const f = c.src;
    const kid = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', f, '-vn', '-map', '0:a:0', '-ac', '2',
      '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    audioKids.add(kid);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
    kid.stdout.pipe(res);
    const done = () => { audioKids.delete(kid); try { kid.kill(); } catch { /* gone */ } };
    kid.on('error', () => { done(); res.end(); });
    kid.on('close', () => audioKids.delete(kid));
    req.on('close', done);
  });
  srv.listen(0, '127.0.0.1', () => { audioPort = srv.address().port; pushState(); });
}

// ---- Spotify desktop app -------------------------------------------------------------------------
// No account or API key: Drift presses the same media keys a keyboard has, and reads the song from Spotify's window title.
let spotify = { status: process.platform === 'win32' ? 'closed' : 'unsupported', title: '', volMode: '', vol: 0 }, spotifyProc = null;
const ps = (script, opts) => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, ...opts });
const SPOTIFY_WATCH = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  $all = @(Get-Process -Name Spotify -ErrorAction SilentlyContinue)
  $w = $all | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
  if ($w) { [Console]::Out.WriteLine('T|' + $w.MainWindowTitle) } elseif ($all.Count -gt 0) { [Console]::Out.WriteLine('R|') } else { [Console]::Out.WriteLine('N|') }
  Start-Sleep -Milliseconds 1500
}`;
function spotifyWatch(on) {
  if (process.platform !== 'win32') return;
  if (!on) { if (spotifyProc) { try { spotifyProc.kill(); } catch { /* gone */ } spotifyProc = null; } return; }
  if (spotifyProc) return;
  let buf = '';
  const p = spotifyProc = ps(SPOTIFY_WATCH, { stdio: ['ignore', 'pipe', 'ignore'] });
  p.on('error', () => { if (spotifyProc === p) spotifyProc = null; });
  p.on('close', () => { if (spotifyProc === p) spotifyProc = null; });
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop();
    const line = lines.filter(Boolean).pop(); if (!line) return;
    const kind = line[0], t = line.slice(2).trim();
    // Spotify's window says "Artist - Song" while playing and just "Spotify ..." when paused
    const next = kind === 'N' ? { status: 'closed', title: '' } : kind === 'R' ? { status: 'running', title: '' }
      : /^Spotify( |$)/i.test(t) ? { status: 'paused', title: '' } : { status: 'playing', title: t };
    if (next.status !== spotify.status || next.title !== spotify.title) {
      const started = next.status === 'playing' && spotify.status !== 'playing';
      spotify = { ...spotify, ...next }; pushState();
      if (started) setTimeout(() => spotifyVolSend('?'), 800);   // Spotify's mixer slot appears once it plays
    }
  });
}
function spotifyDo(action) {
  if (action === 'open') { shell.openExternal('spotify:').catch(() => {}); return; }
  if (process.platform !== 'win32') return;
  const key = { toggle: 179, next: 176, prev: 177 }[action];
  if (!key) return;
  if (spotify.status === 'closed') { shell.openExternal('spotify:').catch(() => {}); return; }
  const p = ps(`(New-Object -ComObject WScript.Shell).SendKeys([char]${key})`, { stdio: 'ignore' });
  p.on('error', () => {});
}

// Volume while Spotify is the music source. Drift turns down Spotify's own slot in the Windows volume mixer;
// if Spotify has no slot there (it has not played anything yet), it changes the PC's main volume instead.
const SPOTIFY_VOL = `
$src = @'
using System; using System.Runtime.InteropServices; using System.Diagnostics; using System.Globalization;
namespace DriftAudio {
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int NotImpl1(); [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 { int NotImpl1(); int NotImpl2(); [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e); }
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator { [PreserveSig] int GetCount(out int n); [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s); }
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 { int f0(); int f1(); int f2(); int f3(); int f4(); int f5(); int f6(); int f7(); int f8(); int g0(); int g1(); [PreserveSig] int GetProcessId(out uint pid); }
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume { [PreserveSig] int SetMasterVolume(float l, ref Guid ctx); [PreserveSig] int GetMasterVolume(out float l); }
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int f0(); int f1(); int f2(); int f3(); [PreserveSig] int SetMasterVolumeLevelScalar(float l, ref Guid ctx); int f5(); [PreserveSig] int GetMasterVolumeLevelScalar(out float l); }
public static class Vol {
  public static string Apply(float v, bool set) {
    IMMDevice d; ((IMMDeviceEnumerator)(new MMDeviceEnumerator())).GetDefaultAudioEndpoint(0, 1, out d);
    Guid g = Guid.Empty; object o; int hit = 0; float cur = 0;
    Guid iid = typeof(IAudioSessionManager2).GUID; d.Activate(ref iid, 23, IntPtr.Zero, out o);
    IAudioSessionEnumerator en; ((IAudioSessionManager2)o).GetSessionEnumerator(out en); int n; en.GetCount(out n);
    for (int i = 0; i < n; i++) {
      try {
        IAudioSessionControl2 c; en.GetSession(i, out c); uint pid; c.GetProcessId(out pid);
        if (pid == 0 || Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant() != "spotify") continue;
        ISimpleAudioVolume sv = (ISimpleAudioVolume)c; if (set) sv.SetMasterVolume(v, ref g); sv.GetMasterVolume(out cur); hit++;
      } catch { }
    }
    if (hit > 0) return "S|" + cur.ToString("0.000", CultureInfo.InvariantCulture);
    iid = typeof(IAudioEndpointVolume).GUID; d.Activate(ref iid, 23, IntPtr.Zero, out o);
    IAudioEndpointVolume ev = (IAudioEndpointVolume)o; if (set) ev.SetMasterVolumeLevelScalar(v, ref g); ev.GetMasterVolumeLevelScalar(out cur);
    return "M|" + cur.ToString("0.000", CultureInfo.InvariantCulture);
  }
} }
'@
try { Add-Type -TypeDefinition $src } catch { [Console]::Out.WriteLine('E|type'); exit }
[Console]::Out.WriteLine('READY|')
while ($true) {
  $l = [Console]::In.ReadLine(); if ($l -eq $null) { break }
  try {
    if ($l -eq '?') { [Console]::Out.WriteLine([DriftAudio.Vol]::Apply(0, $false)) }
    else { [Console]::Out.WriteLine([DriftAudio.Vol]::Apply([single]::Parse($l, [System.Globalization.CultureInfo]::InvariantCulture), $true)) }
  } catch { [Console]::Out.WriteLine('E|call') }
}`;
let volProc = null, volPoll = null, volSetAt = 0;
function spotifyVolSend(line) { if (volProc && volProc.stdin.writable) { try { volProc.stdin.write(line + '\n'); } catch { /* gone */ } } }
function spotifyVolWatch(on) {
  if (process.platform !== 'win32') return;
  if (!on) {
    clearInterval(volPoll); volPoll = null;
    if (volProc) { try { volProc.stdin.end(); volProc.kill(); } catch { /* gone */ } volProc = null; }
    return;
  }
  if (volProc) return;
  let buf = '';
  const p = volProc = ps(SPOTIFY_VOL, { stdio: ['pipe', 'pipe', 'ignore'] });
  const gone = () => { if (volProc === p) { volProc = null; clearInterval(volPoll); volPoll = null; if (spotify.volMode) { spotify = { ...spotify, volMode: '' }; pushState(); } } };
  p.on('error', gone); p.on('close', gone); p.stdin.on('error', () => {});
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const line of lines) {
      const kind = line[0], v = parseFloat(line.slice(2));
      if (line.startsWith('READY')) { spotifyVolSend('?'); continue; }
      if ((kind !== 'S' && kind !== 'M') || !(v >= 0)) continue;
      const mode = kind === 'S' ? 'app' : 'system';
      if (Date.now() - volSetAt < 1200 && mode === spotify.volMode) continue;     // don't fight the slider while it is being dragged
      if (mode !== spotify.volMode || Math.abs(v - (spotify.vol || 0)) > 0.004) { spotify = { ...spotify, volMode: mode, vol: v }; pushState(); }
    }
  });
  volPoll = setInterval(() => { if (Date.now() - volSetAt > 1200) spotifyVolSend('?'); }, 3000);   // follow changes made in Spotify or Windows
}
function spotifyVolSet(v) {
  v = Math.max(0, Math.min(1, +v || 0));
  if (!volProc || !spotify.volMode) return;
  volSetAt = Date.now(); spotify = { ...spotify, vol: v };
  spotifyVolSend(v.toFixed(3)); pushState();
}

const showsVideo = (key) => (state.mode === 'mix' ? (state.perDisplay[key] || state.scene) : state.scene) === 'video';
function publicState() {
  const c = cur(), lead = visWins.find((v) => showsVideo(v.key));
  // while watching with a friend, the list, position and pause state are theirs
  const video = remote ? { ...state.video, files: remote.files.map((f) => f.name), index: remote.index, paused: !!remote.paused } : state.video;
  return { ...state, video, subs: { ...state.subs, perFile: undefined }, subsInfo: subInfo, time: clock, nowPlaying, vclock,
    videoUrl: c ? (c.path ? pathToFileURL(c.path).href : c.src) : '', videoName: c ? c.name : '', videoPath: c ? c.path : '', videoLeader: lead && c ? lead.key : '',
    spotify, videoAudio, videoInfo, audioBase: audioPort && c ? local(`/a?i=${c.index}`) : '',
    xc: { ...xc, ...xcWant(), base: xcBase() }, encoders: xcoder.list(), canTonemap: !xcoder.ready() || xcoder.canTonemap(),
    p2p: { ...p2p.info(), ctrl: !remote || !!remote.ctrl, own: !!(c && c.remote && c.path), viaHost: viaHost(), quality: shareQuality(), waitingFor: heldFor || [], defaultName: shareName(true), file: remote ? remote.file || '' : '' } };
}
function broadcast(channel, payload, includeAudio = true) {
  for (const v of visWins) if (!v.win.isDestroyed()) v.win.webContents.send(channel, payload);
  if (includeAudio && audioWin && !audioWin.isDestroyed()) audioWin.webContents.send(channel, payload);
}
function pushState() { broadcast('state', publicState()); p2p.sync(); }
const say = (text) => { if (text) broadcast('cmd', { type: 'toast', text: String(text) }, false); };

// ---- watch together --------------------------------------------------------------------------------
// One PC shares the video it is playing; friends who join with its invite code see the same video in step.
// p2p.js does the talking between PCs; this is what Drift tells friends, and what it does with what they say.
const sizes = new Map();
const sizeOf = (f) => { if (!sizes.has(f)) { let n = 0; try { n = fs.statSync(f).size; } catch { /* gone */ } sizes.set(f, n); } return sizes.get(f); };
const shareName = (fallbackOnly) => (!fallbackOnly && state.share.name) || (() => { try { return os.userInfo().username; } catch { return ''; } })() || 'Friend';
let heldFor = null;       // names of friends the video is paused for while they load
function setPaused(v) {
  if (v === state.video.paused) return;
  if (v) vclock.pos = (Date.now() - vclock.startedAt) / 1000; else vclock.startedAt = Date.now() - vclock.pos * 1000;
  state.video.paused = v;
}
function shareSnapshot() {
  const on = !remote && visWins.some((v) => showsVideo(v.key)), c = on ? cur() : null;
  return { files: on ? state.video.files.map((f) => ({ name: path.basename(f), size: sizeOf(f) })) : [], index: on ? state.video.index : 0,
    file: c ? `${c.index}|${c.name}|${sizeOf(c.path)}` : '', paused: state.video.paused, pos: vclock.pos, startedAt: vclock.startedAt, seq: vclock.seq || 0,
    info: videoInfo, audio: { mode: videoAudio.mode, codec: videoAudio.codec },
    // subtitle tracks are named by a hash so no folder names leave this PC
    tracks: probing ? null : subInfo.tracks.filter((t) => t.usable && t.kind !== 'shared').map((t) => ({ id: subsLib.hash(t.id), kind: t.kind, lang: t.lang, label: t.label, def: !!t.def, forced: !!t.forced, sdh: !!t.sdh })),
    ctrl: state.share.control, cap: state.share.quality, xc: !!ffmpegPath() };
}
function videoJump(pos, play) {
  pos = Math.max(0, +pos || 0);
  vclock = { startedAt: Date.now() - pos * 1000, pos, seq: (vclock.seq || 0) + 1 };
  if (play) state.video.paused = false;
  pushState();
  if (xcActive()) xcRestart(pos, 180);       // wait for the seek bar to settle before starting a new stream
}
function videoStep(dir) {
  const n = state.video.files.length; if (!n) return;
  videoFails = 0; xcFails = 0;
  state.video.index = (state.video.index + (dir < 0 ? -1 : 1) + n) % n;
  state.video.paused = false;
  vclock = { startedAt: Date.now(), pos: 0, seq: (vclock.seq || 0) + 1 };
  xc = { epoch: xc.epoch + 1, start: 0 };
  probe(); pushState(); saveSoon();
}
// This PC's own copy of a shared video (same name and size, somewhere in its video folders) saves streaming it.
let copyIndex = null;
async function buildCopyIndex() {
  const idx = new Map(); let budget = 40000;
  const walk = async (dir, depth) => {
    if (depth > 6 || budget <= 0) return;
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (--budget <= 0) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.') && !e.name.startsWith('$')) await walk(full, depth + 1); }
      else if (isVideo(e.name)) { const k = e.name.toLowerCase(); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(full); }
    }
  };
  for (const f of state.video.folders) await walk(f, 0);
  return idx;
}
async function findOwnCopy(c) {
  const r = c && remote && remote.files[c.index];
  if (!r || !r.size || c.path) return;
  if (!copyIndex) copyIndex = buildCopyIndex();
  for (const p of (await copyIndex).get(String(r.name).toLowerCase()) || []) {
    let n = -1;
    try { n = (await fs.promises.stat(p)).size; } catch { /* gone */ }
    if (n !== r.size) continue;
    const now = cur();
    if (!now || now.key !== c.key || now.path) return;
    ownCopy = { key: c.key, path: p };
    probe(); if (xcActive()) xcRestart(); else pushState();
    return;
  }
}
// Called with what the sharing PC is doing, each time it changes; null when the session is over.
function onRemote(s, why) {
  if (!s) {
    if (remote) {
      remote = null; ownCopy = { key: '', path: '' }; copyIndex = null;
      if (state.scene === 'video') state.scene = state.prevScene && state.prevScene !== 'video' ? state.prevScene : 'aurora';     // back to what was on before
      for (const k of Object.keys(state.perDisplay)) if (state.perDisplay[k] === 'video') delete state.perDisplay[k];
      vclock = { startedAt: Date.now(), pos: 0, seq: (vclock.seq || 0) + 1 }; state.video.paused = false;
      xc = { epoch: xc.epoch + 1, start: 0 };
      probe();
    }
    pushState(); say(why);
    return;
  }
  const was = remote, wasKey = (cur() || {}).key;
  remote = { ...s, files: (Array.isArray(s.files) ? s.files : []).slice(0, 5000).map((f) => ({ name: path.basename(String(f.name || 'video')).slice(0, 200), size: +f.size || 0 })),
    index: Math.max(0, s.index | 0), pos: +s.pos || 0, seq: s.seq | 0 };
  vclock = { startedAt: +s.startedAt || Date.now(), pos: remote.pos, seq: remote.seq };
  if (!was) {
    if (state.scene !== 'video') state.prevScene = state.scene;
    state.scene = 'video';
    if (state.mode === 'mix') for (const d of allDisplays()) state.perDisplay[d.key] = 'video';
  }
  const c = cur();
  if (!was || (c && c.key) !== wasKey || remote.index !== was.index) {       // a different video
    videoFails = 0; xcFails = 0; xc = { epoch: xc.epoch + 1, start: 0 };
    probe(); findOwnCopy(c);
    if (xcActive()) { xcRestart(); return; }
  } else if (JSON.stringify([s.info, s.audio, s.tracks]) !== JSON.stringify([was.info, was.audio, was.tracks])) {     // their PC finished examining it
    const before = xcActive();
    probe();
    if (xcActive() && !before) { xcRestart(); return; }
  } else if (remote.seq !== was.seq && xcActive()) { xcRestart(); return; }      // they jumped: converted video needs a new stream
  pushState();
}
function guestCmd(m) {
  if (!state.share.control || remote) return;
  if (m.a === 'pause' || m.a === 'play') patch({ video: { paused: m.a === 'pause' } });
  else if (m.a === 'jump' && isFinite(m.pos)) videoJump(m.pos, !!m.play);
  else if (m.a === 'step') videoStep(m.dir < 0 ? -1 : 1);
}
const p2p = createP2P({
  snapshot: shareSnapshot,
  fileAt: (i) => (!remote && Number.isInteger(i) && visWins.some((v) => showsVideo(v.key)) ? state.video.files[i] || '' : ''),
  cues: (i, id) => {
    const tr = !remote && i === state.video.index ? subInfo.tracks.find((t) => t.usable && t.kind !== 'shared' && subsLib.hash(t.id) === id) : null;
    return tr ? readCues(tr, subInfo.file) : Promise.reject(new Error('no such track'));
  },
  convert: (req, res, q) => {
    const c = cur();
    if (!c || c.remote || q.i !== c.index || !ffmpegPath()) { res.writeHead(404); res.end(); return; }
    xcoder.serve(req, res, xcSpec('share|' + req.url, c.src, q.t, QUALITY[q.q] ? q.q : 'original'));
  },
  guestCmd,
  playing: () => !remote && !state.video.paused && !!cur() && visWins.some((v) => showsVideo(v.key)),
  hold: (names) => {       // pause for everyone while a friend loads; carry on when they have caught up
    if (names) { if (!heldFor) setPaused(true); if ((heldFor || []).join() !== names.join()) { heldFor = names; pushState(); } }
    else if (heldFor) { heldFor = null; setPaused(false); pushState(); }
  },
  remote: onRemote,
  publicIp: async () => { const r = await net.fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) }); const ip = (await r.text()).trim(); return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : ''; },
  say,
  changed: () => pushState(),
});

function initFor(wc) {
  const v = visWins.find((x) => x.win.webContents === wc);
  const act = activeDisplays();
  return {
    key: v ? v.key : 'd0', index: v ? v.index : 0,
    bounds: v ? v.bounds : act[0].bounds,
    union: unionOf(act),
    displays: allDisplays().map((d) => ({ index: d.index, key: d.key, width: d.bounds.width, height: d.bounds.height, primary: d.primary })),
    state: publicState(),
    langs: subsLib.LANGS.map(([code, name]) => [code, name]),
    testMode: !!SHOT_DIR, freeze: !!process.env.DRIFT_FREEZE, fakeHdr: process.env.DRIFT_FAKE_HDR || '',     // dev: pretend this screen is ('1') or isn't ('0') showing HDR
  };
}

let lastSig = '';
const displaySig = () => JSON.stringify(allDisplays().map((d) => d.bounds));
function buildWindows() {
  lastSig = displaySig();
  const old = visWins;
  visWins = [];
  const act = activeDisplays();
  for (const d of act) {
    const win = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, show: false, backgroundColor: '#000000', skipTaskbar: false,
      title: 'Drift', icon: path.join(__dirname, 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
    });
    win.setMenuBarVisibility(false);
    if (process.env.DRIFT_MUTE) win.webContents.setAudioMuted(true);      // dev: silent runs
    const entry = { win, key: d.key, index: d.index, bounds: d.bounds, hdr: undefined };
    visWins.push(entry);
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.setBounds(d.bounds);
      if (FAKE <= 1 && !process.env.DRIFT_HIDDEN) win.setFullScreen(true);
      if (state.onTop) win.setAlwaysOnTop(true, 'screen-saver');
      if (!process.env.DRIFT_HIDDEN) win.show();        // dev: run without putting anything on screen
    });
    win.on('close', (e) => {       // Alt+F4 and the like: ask first, the same as Esc and the ✕ button
      if (quitting || !visWins.includes(entry) || win.webContents.isCrashed() || Date.now() - (entry.askedAt || 0) < 5000) return;      // asked twice in a row (or the window is stuck): just close
      e.preventDefault(); entry.askedAt = Date.now();
      win.webContents.send('cmd', { type: 'ask-quit' });
    });
    win.on('closed', () => {
      if (visWins.includes(entry) && !quitting) { quitting = true; app.quit(); } // closing any live window exits
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }
  for (const o of old) if (!o.win.isDestroyed()) o.win.destroy();
}
function rebuildSoon() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(buildWindows, 600);
}

function createAudioWindow() {
  audioWin = new BrowserWindow({
    width: 300, height: 200, show: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  if (process.env.DRIFT_MUTE) audioWin.webContents.setAudioMuted(true);
  audioWin.loadFile(path.join(__dirname, 'renderer', 'audio.html'));
}

function applySideEffects(prev) {
  // keep-awake
  if (state.keepAwake && blockerId === null) blockerId = powerSaveBlocker.start('prevent-display-sleep');
  if (!state.keepAwake && blockerId !== null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
  // always on top
  if (!prev || prev.onTop !== state.onTop) for (const v of visWins) if (!v.win.isDestroyed()) v.win.setAlwaysOnTop(!!state.onTop, 'screen-saver');
  // auto-cycle
  if (!prev || prev.autoCycle !== state.autoCycle) {
    clearInterval(cycleTimer); cycleTimer = null;
    if (state.autoCycle > 0) cycleTimer = setInterval(() => stepScene(1, state.cycleShuffle, true), state.autoCycle * 60000);
  }
  // sleep timer
  if (!prev || prev.sleepAt !== state.sleepAt) {
    clearTimeout(sleepTimer); sleepTimer = null;
    if (state.sleepAt > Date.now()) {
      sleepTimer = setTimeout(() => {
        broadcast('cmd', { type: 'fadeout' });
        setTimeout(() => { quitting = true; app.quit(); }, 9000);
      }, Math.max(0, state.sleepAt - Date.now() - 9000));
    }
  }
  if (!prev || prev.music.source !== state.music.source) { spotifyWatch(state.music.source === 'spotify'); spotifyVolWatch(state.music.source === 'spotify'); }
  // monitors on/off
  if (prev && JSON.stringify(prev.displaysOff) !== JSON.stringify(state.displaysOff)) rebuildSoon();
}

const SCENES = ['aurora', 'nebula', 'silk', 'water', 'stars', 'lava', 'ridges', 'ripples', 'mandala', 'bokeh', 'lines',
  'sierpinski', 'sorting', 'life', 'maze', 'julia', 'hilbert', 'voronoi',
  'polyhedra', 'globe', 'tunnel', 'cubes', 'lattice', 'menger',
  'quasi', 'hyperbolic', 'apollonian', 'phyllotaxis', 'rose', 'chladni',
  'lake', 'pines', 'dunes', 'seaside', 'meadow', 'canyon'];
function stepScene(dir, shuffle, auto) {
  const next = (cur) => {
    if (auto && cur === 'video') return cur;   // auto-change never interrupts your video
    if (shuffle) { let n; do { n = SCENES[Math.floor(Math.random() * SCENES.length)]; } while (n === cur); return n; }
    const i = SCENES.indexOf(cur);
    return SCENES[(i + dir + SCENES.length) % SCENES.length];
  };
  if (state.mode === 'mix') {
    const pd = { ...state.perDisplay };
    for (const d of allDisplays()) pd[d.key] = next(pd[d.key] || state.scene);
    patch({ perDisplay: pd });
  } else patch({ scene: next(state.scene) });
}

function patch(p) {
  if (remote && p.video && p.video.paused !== undefined) {       // watching with a friend: play / pause is theirs to do (or to allow)
    if (remote.ctrl) p2p.send({ t: 'cmd', a: p.video.paused ? 'pause' : 'play' }); else say(`Only ${p2p.info().host || 'the host'} can play and pause`);
    p = { ...p, video: { ...p.video } }; delete p.video.paused;
  }
  if (p.video && p.video.paused === false && heldFor) { heldFor = null; p2p.carryOn(); }      // "play" while waiting for a friend: stop waiting
  const prev = JSON.parse(JSON.stringify(state));
  if ((p.speed !== undefined && p.speed !== state.speed) || (p.frozen !== undefined && p.frozen !== state.frozen)) {
    const now = Date.now();   // keep visual time continuous when speed changes or the scene is paused / resumed
    clock = { base: state.frozen ? clock.base : clock.base + ((now - clock.ref) / 1000) * state.speed, ref: now };
  }
  if (p.video && p.video.paused !== undefined && p.video.paused !== state.video.paused) {   // pause / resume the shared video timeline
    if (p.video.paused) vclock.pos = (Date.now() - vclock.startedAt) / 1000;
    else vclock.startedAt = Date.now() - vclock.pos * 1000;
  }
  if (p.scene === 'video' && state.scene !== 'video') state.prevScene = state.scene;
  for (const k of Object.keys(p)) {
    if (k === 'video') {
      const v = state.video = { ...state.video, ...p.video };
      if (!['auto', 'always', 'never'].includes(v.hdr)) v.hdr = 'auto';
      if (!['hable', 'mobius', 'reinhard'].includes(v.tone)) v.tone = 'hable';
      if (!/^[a-z0-9_]{1,24}$/.test(v.enc)) v.enc = 'auto';
      if (!['auto', '2160', '1440', '1080', '720', '480'].includes(String(v.xq))) v.xq = 'auto';
    }
    else if (k === 'share') { state.share = cleanShare({ ...state.share, ...(p.share || {}) }); p2p.setOptions({ wait: state.share.wait, name: shareName() }); }
    else if (k === 'music') {
      state.music = { ...state.music, ...p.music };
      if (p.music.nature) state.music.nature = { ...prev.music.nature, ...p.music.nature };
    } else if (k === 'perDisplay') state.perDisplay = { ...state.perDisplay, ...p.perDisplay };
    else if (k === 'subs') {       // look only; which track is showing goes through the sub-* commands
      const q = p.subs || {}, t = state.subs;
      if (isFinite(q.size)) t.size = Math.max(0.5, Math.min(2.5, +q.size));
      if (/^#[0-9a-f]{6}$/i.test(q.color || '')) t.color = q.color.toLowerCase();
      if (['outline', 'box', 'shadow'].includes(q.bg)) t.bg = q.bg;
      if (isFinite(q.lift)) t.lift = Math.max(0, Math.min(70, +q.lift));
    }
    else if (k === 'customColors') { if (Array.isArray(p[k]) && p[k].length === 4 && p[k].every((c) => /^#[0-9a-f]{6}$/i.test(c))) state.customColors = p[k].map((c) => c.toLowerCase()); }
    else if (k in DEFAULTS) state[k] = p[k];
  }
  if (allDisplays().every((d) => state.displaysOff.includes(d.index))) state.displaysOff = prev.displaysOff;
  applySideEffects(prev);
  const pv = prev.video, nv = state.video;
  if (pv.enc !== nv.enc) encFallback = false;
  // anything that changes what the converted stream looks like, or who needs it, starts a new one
  if (cur() && (pv.hdr !== nv.hdr || pv.tone !== nv.tone || pv.enc !== nv.enc || pv.xq !== nv.xq || prev.share.quality !== state.share.quality
    || (xcActive() && (pv.layout !== nv.layout || prev.mode !== state.mode) && nv.xq === 'auto'))) xcRestart();
  else pushState();
  saveSoon();
}

function setVideos(files, key, index = 0) {
  videoFails = 0; xcFails = 0;
  vclock = { startedAt: Date.now(), pos: 0, seq: (vclock.seq || 0) + 1 };
  xc = { epoch: xc.epoch + 1, start: 0 };
  const p = { video: { files, index, paused: false } };
  if (state.mode === 'mix' && key) p.perDisplay = { [key]: 'video' }; else p.scene = 'video';
  patch(p);
  probe();
}
// ---- video library ----
const isVideo = (name) => VIDEO_EXT.includes(path.extname(name).toLowerCase());
const isAudio = (name) => AUDIO_EXT.includes(path.extname(name).toLowerCase());
const libFolders = (kind) => (kind === 'audio' ? state.music.folders : state.video.folders);
const libMatch = (kind) => (kind === 'audio' ? isAudio : isVideo);
const inLib = (kind, p) => { const r = path.resolve(p); return libFolders(kind).some((f) => r === path.resolve(f) || r.startsWith(path.resolve(f) + path.sep)); };
const inLibrary = (p) => inLib('video', p);
const fileInfo = (full) => { let size = 0; try { size = fs.statSync(full).size; } catch { /* ignore */ } return { name: path.basename(full), path: full, url: pathToFileURL(full).href, size }; };
function searchLib(kind, root, query) {
  const q = String(query || '').toLowerCase().trim(), out = [], match = libMatch(kind);
  if (!q || !root || !inLib(kind, root)) return out;
  const words = q.split(/\s+/);
  const walk = (dir, depth) => {
    if (depth > 7 || out.length >= 300) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 300) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.') && !e.name.startsWith('$')) walk(full, depth + 1); }
      else if (match(e.name)) { const n = e.name.toLowerCase(); if (words.every((w) => n.includes(w))) out.push(fileInfo(full)); }
    }
  };
  walk(root, 0);
  return out;
}
function hasVideo(dir, depth, budget, isVideo) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  if (entries.some((e) => e.isFile() && isVideo(e.name))) return true;
  if (depth <= 0) return false;
  for (const e of entries) {
    if (budget.n-- <= 0) return false;
    if (e.isDirectory() && !e.name.startsWith('.') && hasVideo(path.join(dir, e.name), depth - 1, budget, isVideo)) return true;
  }
  return false;
}
function listDir(dir, kind = 'video') {
  const isVideo = libMatch(kind);
  if (!dir || !inLib(kind, dir)) return { dir: '', parent: null, dirs: [], videos: [] };
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* unreadable */ }
  const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const budget = { n: 4000 };
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) })).filter((d) => hasVideo(d.path, 2, budget, isVideo)).sort(cmp);
  const videos = entries.filter((e) => e.isFile() && isVideo(e.name)).map((e) => fileInfo(path.join(dir, e.name))).sort(cmp);
  const isRoot = libFolders(kind).some((f) => path.resolve(f) === path.resolve(dir));
  return { dir, name: path.basename(dir) || dir, parent: isRoot ? null : path.dirname(dir), dirs, videos };
}
function scanFolder(dir, out, depth = 0) {
  if (depth > 6 || out.length > 5000) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scanFolder(full, out, depth + 1);
    else if (AUDIO_EXT.includes(path.extname(e.name).toLowerCase())) out.push(full);
  }
}
function addTracks(paths) {
  if (!paths.length) return;
  const had = state.music.playlist.length;
  const list = [...state.music.playlist];
  for (const p of paths) if (!list.includes(p)) list.push(p);
  patch({ music: { playlist: list, source: 'files', playing: true } });
  if (!had && audioWin) audioWin.webContents.send('cmd', { type: 'play-index', index: 0 });
}

ipcMain.handle('init', (e) => initFor(e.sender));
ipcMain.handle('list-dir', (_e, dir, kind) => listDir(dir, kind === 'audio' ? 'audio' : 'video'));
ipcMain.handle('search-lib', (_e, kind, root, q) => searchLib(kind === 'audio' ? 'audio' : 'video', root, q));
ipcMain.on('patch', (_e, p) => patch(p || {}));
ipcMain.on('levels', (_e, l) => broadcast('levels', l, false));
ipcMain.on('now', (_e, n) => { nowPlaying = n; broadcast('now', n, false); });
ipcMain.handle('read-file', async (_e, p) => {
  if (!state.music.playlist.includes(p)) throw new Error('not in playlist');
  const buf = await fs.promises.readFile(p);
  return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), mime: MIME[path.extname(p).toLowerCase()] || 'audio/mpeg' };
});
ipcMain.handle('sub-cues', () => ({ seq: subInfo.seq, cues: subCues }));
// Looks a video up online. Nothing is sent anywhere until the user presses Search: then only the title typed in the box goes out.
ipcMain.handle('sub-search', async (_e, q) => {
  q = q || {};
  try {
    const r = await subsLib.searchOnline(webFetch, { text: String(q.text || '').slice(0, 120), season: Math.max(0, q.season | 0), episode: Math.max(0, q.episode | 0),
      year: (subInfo.guess || {}).year || 0, lang: (subsLib.langOf(q.lang) || { code: '' }).code, id: /^tt\d+$/.test(q.id || '') ? q.id : '', type: q.type === 'series' ? 'series' : 'movie',
      videoName: subSrc ? subSrc.name : '' });
    return { ok: true, ...r };
  } catch (err) { return { ok: false, error: /abort|timeout/i.test(String(err && err.name) + String(err && err.message)) ? 'The subtitle service took too long to answer. Try again in a moment.' : 'Could not reach the subtitle service. Check your internet connection.' }; }
});
ipcMain.handle('sub-download', async (_e, it) => {
  const f = subInfo.file;
  if (!f || !it || !subsLib.okHost(it.url)) return { ok: false, error: 'That subtitle can\'t be downloaded.' };
  try {
    const buf = await subsLib.downloadSub(webFetch, it.url);
    const dir = path.join(app.getPath('userData'), 'subtitles'), file = path.join(dir, `${subsLib.hash(f)}-${String(it.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 20) || subsLib.hash(it.url)}.srt`);
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, buf);
    if (subInfo.file !== f) return { ok: false, error: 'The video changed before the download finished.' };
    const lang = subsLib.langOf(it.lang);
    addSubFile(file, (lang ? lang.name : 'Subtitles') + ' · ' + String(it.name || 'downloaded').slice(0, 90) + ' · downloaded', lang ? lang.code : '');
    return { ok: true };
  } catch (err) { return { ok: false, error: /^(That|HTTP)/.test(String(err && err.message)) ? (String(err.message).startsWith('HTTP') ? 'The server didn\'t have that file any more — try another one in the list.' : err.message) : 'The download failed. Check your internet connection and try again.' }; }
});
ipcMain.on('cmd', async (e, c) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  switch (c.type) {
    case 'quit': quitting = true; app.quit(); break;
    case 'step-scene': stepScene(c.dir || 1, false); break;
    case 'add-files': {
      const r = await dialog.showOpenDialog(parent, { title: 'Add music', properties: ['openFile', 'multiSelections'],
        defaultPath: app.getPath('music'), filters: [{ name: 'Audio', extensions: AUDIO_EXT.map((x) => x.slice(1)) }] });
      if (!r.canceled) addTracks(r.filePaths);
      break;
    }
    case 'add-folder': {
      const r = await dialog.showOpenDialog(parent, { title: 'Add a music folder', properties: ['openDirectory'], defaultPath: app.getPath('music') });
      if (!r.canceled) { const out = []; scanFolder(r.filePaths[0], out); addTracks(out); }
      break;
    }
    case 'pick-video': {
      const r = await dialog.showOpenDialog(parent, { title: 'Choose a video (pick several to play them in order)', properties: ['openFile', 'multiSelections'],
        defaultPath: app.getPath('videos'), filters: [{ name: 'Video', extensions: VIDEO_EXT.map((x) => x.slice(1)) }] });
      if (!r.canceled && r.filePaths.length) { if (remote) await p2p.stop(); setVideos(r.filePaths, c.key); }      // playing your own video leaves a friend's session
      break;
    }
    // ---- watch together ----
    case 'share-start':
      if (remote) await p2p.stop();
      p2p.share({ port: state.share.port, internet: state.share.internet, wait: state.share.wait, name: shareName(), local: !!process.env.DRIFT_SHARE_LOCAL });     // dev: stay on this PC
      break;
    case 'share-stop': p2p.stop(); break;
    case 'share-join': { const r = await p2p.join(c.code, shareName()); if (!r.ok) say(r.error); break; }
    case 'share-copy': if (p2p.info().code && !p2p.info().settling) { clipboard.writeText(p2p.info().code); say('Invite code copied — send it to your friend'); } break;
    case 'share-paste': e.sender.send('cmd', { type: 'share-code', code: clipboard.readText().trim().slice(0, 300) }); break;
    case 'xc-started': if (c.ms > 0) xcLead = Math.round(Math.max(1500, Math.min(7000, Math.max(c.ms * 1.25 + 300, xcLead * 0.8)))); break;      // how long a stream took to show its first picture
    case 'share-ready': if (remote) p2p.ready(!!c.ok, remote.file || ''); break;       // this PC has (or hasn't) loaded enough to play
    case 'hdr': {       // a window saying whether its screen is showing HDR right now
      const v = visWins.find((x) => x.win.webContents === e.sender);
      if (!v || v.hdr === !!c.on) break;
      const before = xcActive();
      v.hdr = !!c.on;
      if (xcActive() && !before) xcRestart(); else pushState();
      break;
    }
    case 'video-failed': {       // the built-in player gave up on this video (sent by the leading monitor)
      const cc = cur();
      if (!cc || c.index !== cc.index) break;
      if (!forced.has(cc.key) && (ffmpegPath() || (cc.remote && !cc.path && remote.xc))) {      // convert it instead
        forced.add(cc.key); videoInfo = { ...videoInfo, force: true }; xcFails = 0;
        xcRestart();
        break;
      }
      say('That video can\'t be played here' + (ffmpegPath() ? '.' : ' — MP4 (H.264) or WebM work best, or add ffmpeg.exe so Drift can convert it.'));
      if (!remote && state.video.files.length > 1 && ++videoFails < state.video.files.length) videoStep(1);
      break;
    }
    case 'xc-trouble': {       // a monitor's converted stream broke, ended early or fell far behind
      const cc = cur(), now = Date.now();
      if (!cc || c.index !== cc.index || now - xcAt < 3000) break;
      if (now - xcAt > 60000) xcFails = 0;
      xcAt = now;
      if (c.hard && ++xcFails > 3) {
        if (xcFails === 4) { say('This video couldn\'t be converted' + (xcoder.lastError() ? ' (ffmpeg stopped unexpectedly).' : '.')); if (!remote && state.video.files.length > 1) videoStep(1); }
        break;
      }
      if (c.hard && xcFails === 2 && state.video.enc !== 'auto' && !encFallback) { encFallback = true; say('That converter didn\'t work for this video — using the automatic one.'); }
      xcRestart();
      break;
    }
    case 'add-music-folder': {
      const r = await dialog.showOpenDialog(parent, { title: 'Add a music folder', properties: ['openDirectory'], defaultPath: app.getPath('music') });
      if (!r.canceled && !state.music.folders.includes(r.filePaths[0])) patch({ music: { folders: [...state.music.folders, r.filePaths[0]] } });
      break;
    }
    case 'remove-music-folder':
      patch({ music: { folders: state.music.folders.filter((f) => f !== c.path) } });
      break;
    case 'play-tracks': {
      const files = (c.files || []).filter((f) => typeof f === 'string' && isAudio(f) && inLib('audio', f));
      if (!files.length) break;
      patch({ music: { playlist: files, source: 'files', playing: true } });
      if (audioWin && !audioWin.isDestroyed()) audioWin.webContents.send('cmd', { type: 'play-index', index: Math.max(0, Math.min(files.length - 1, c.index | 0)) });
      break;
    }
    case 'spotify': spotifyDo(c.action); break;
    case 'spotify-volume': spotifyVolSet(c.value); break;
    case 'sub-select': selectSub(c.id); break;
    case 'sub-toggle': toggleSubs(); break;
    case 'sub-offset': {
      if (!subInfo.file) break;
      const v = Math.max(-600, Math.min(600, Math.round((c.value !== undefined ? +c.value : subInfo.offset + (+c.delta || 0)) * 20) / 20)) || 0;
      subPrefs(subInfo.file, true).offset = v; subInfo = { ...subInfo, offset: v };
      pushState(); saveSoon();
      break;
    }
    case 'sub-lang': {
      const l = subsLib.langOf(c.lang); if (!l) break;
      state.subs.lang = l.code;
      if (subInfo.file && state.subs.on && !subPrefs(subInfo.file).sel) startSubs(subSrc, subEmbedded);     // re-pick for the new language unless a track was chosen by hand
      pushState(); saveSoon();
      break;
    }
    case 'sub-file': {
      if (!subInfo.file) break;
      const r = await dialog.showOpenDialog(parent, { title: 'Choose a subtitle file', properties: ['openFile'], defaultPath: subSrc && subSrc.path ? path.dirname(subSrc.path) : app.getPath('videos'),
        filters: [{ name: 'Subtitles', extensions: SUB_EXT.map((x) => x.slice(1)) }] });
      if (r.canceled || !r.filePaths.length) break;
      const sp = r.filePaths[0], lang = path.basename(sp, path.extname(sp)).split(/[._\s()[\]-]+/).map((w) => subsLib.langOf(w)).find(Boolean);
      addSubFile(sp, (lang ? lang.name : 'Subtitle file') + ' · ' + path.basename(sp), lang ? lang.code : '');
      break;
    }
    case 'add-video-folder': {
      const r = await dialog.showOpenDialog(parent, { title: 'Add a video folder', properties: ['openDirectory'], defaultPath: app.getPath('videos') });
      if (!r.canceled && !state.video.folders.includes(r.filePaths[0])) patch({ video: { folders: [...state.video.folders, r.filePaths[0]] } });
      break;
    }
    case 'remove-video-folder':
      patch({ video: { folders: state.video.folders.filter((f) => f !== c.path) } });
      break;
    case 'play-videos': {
      const files = (c.files || []).filter((f) => typeof f === 'string' && isVideo(f) && inLibrary(f));
      if (!files.length) break;
      if (remote) await p2p.stop();
      setVideos(files, c.key, Math.max(0, Math.min(files.length - 1, c.index | 0)));
      break;
    }
    case 'stop-video':
      if (remote) { p2p.stop(); break; }       // stopping a friend's video means leaving their session
      if (state.mode === 'mix') { const pd = { ...state.perDisplay }; pd[c.key] = state.prevScene || 'aurora'; state.perDisplay = pd; if (state.scene === 'video') state.scene = state.prevScene || 'aurora'; pushState(); saveSoon(); }
      else patch({ scene: state.prevScene && state.prevScene !== 'video' ? state.prevScene : 'aurora' });
      break;
    case 'video-next':   // sent by the leading monitor when a clip ends
      if (remote || c.index !== state.video.index) break;        // with a friend, their PC decides what comes next
      if (state.video.files.length < 2) { if (c.stream) videoJump(0); break; }      // a converted stream can't loop by itself
      videoFails = 0; xcFails = 0;
      state.video.index = (state.video.index + 1) % state.video.files.length;
      vclock = { startedAt: Date.now(), pos: 0, seq: (vclock.seq || 0) + 1 };
      xc = { epoch: xc.epoch + 1, start: 0 };
      probe(); pushState(); saveSoon();
      break;
    case 'video-step':       // previous / next video in the list that is playing
      if (!remote) videoStep(c.dir);
      else if (remote.ctrl) p2p.send({ t: 'cmd', a: 'step', dir: c.dir < 0 ? -1 : 1 });
      else say(`Only ${p2p.info().host || 'the host'} can change the video`);
      break;
    case 'video-jump':
      if (!remote) videoJump(c.pos, c.play);
      else if (remote.ctrl) p2p.send({ t: 'cmd', a: 'jump', pos: Math.max(0, +c.pos || 0), play: !!c.play });
      else if (c.final) say(`Only ${p2p.info().host || 'the host'} can move through the video`);
      break;
    case 'clear-playlist':
      patch({ music: { playlist: [], source: state.music.source === 'files' ? 'generative' : state.music.source } });
      break;
    case 'reset': {
      const keep = state.music.playlist, folders = state.video.folders, mf = state.music.folders, name = state.share.name;
      await p2p.stop();
      state = JSON.parse(JSON.stringify(DEFAULTS)); state.music.playlist = keep; state.share.name = name; state.video.folders = folders; state.video.foldersInit = true; state.music.folders = mf; state.music.foldersInit = true;
      startSubs(cur(), subEmbedded);
      applySideEffects(null); pushState(); saveSoon(); rebuildSoon();
      break;
    }
    case 'next': case 'prev': case 'play-index':
      if (state.music.source === 'spotify' && c.type !== 'play-index') { spotifyDo(c.type); break; }
      if (audioWin && !audioWin.isDestroyed()) audioWin.webContents.send('cmd', c);
      break;
    default: break;
  }
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { const v = visWins[0]; if (v && !v.win.isDestroyed()) v.win.focus(); });
  app.whenReady().then(() => {
    settingsFile = path.join(app.getPath('userData'), 'settings.json');
    loadSettings();
    if (!state.music.foldersInit) {
      for (const n of ['music', 'downloads']) { try { const p = app.getPath(n); if (fs.existsSync(p) && !state.music.folders.includes(p)) state.music.folders.push(p); } catch { /* ignore */ } }
      state.music.foldersInit = true;
    }
    if (!state.video.foldersInit) {
      for (const n of ['videos', 'downloads']) { try { const p = app.getPath(n); if (fs.existsSync(p) && !state.video.folders.includes(p)) state.video.folders.push(p); } catch { /* ignore */ } }
      state.video.foldersInit = true;
    }
    startLocalServer();
    // lets the audio engine listen to what the PC is playing (e.g. Spotify) so visuals can react to it; nothing is recorded
    session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((src) => cb({ video: src[0], audio: 'loopback' })).catch(() => cb({}));
    });
    if (state.video.files.length) probe();
    setTimeout(() => xcoder.detect().then(() => pushState()), 1500);       // find out which encoders work here, off the start-up path
    clock = { base: 0, ref: Date.now() };
    createAudioWindow();
    buildWindows();
    applySideEffects(null);
    const onDisplays = () => { if (displaySig() !== lastSig) rebuildSoon(); };   // ignore work-area-only changes
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
    screen.on('display-metrics-changed', onDisplays);
    if (SHOT_DIR) runShots();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    quitting = true;
    if (p2p.role() !== 'off' && !goodbye) {       // tell friends, and close the door on the router, before going
      goodbye = true; e.preventDefault();
      p2p.stop().catch(() => {}).finally(() => app.quit());
      return;
    }
    spotifyWatch(false); spotifyVolWatch(false); xcoder.stopAll(); for (const k of audioKids) { try { k.kill(); } catch { /* gone */ } } try { fs.writeFileSync(settingsFile, JSON.stringify(state, null, 1)); } catch { /* ignore */ } });
}

// ---- dev-only screenshot harness -------------------------------------------------
async function runShots() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const log = [];
  const hook = () => { for (const v of visWins) v.win.webContents.on('console-message', (_e, _l, m) => log.push(`[${v.key}] ${m}`)); };
  hook();
  audioWin.webContents.on('console-message', (_e, _l, m) => log.push(`[audio] ${m}`));
  let lastLevels = null, beatCount = 0, lastB = 0; ipcMain.on('levels', (_e, l) => { lastLevels = l; if (l && l.b && l.b[0] && l.b[0] !== lastB) { lastB = l.b[0]; beatCount++; } });
  const snap = async (name) => {
    for (const v of visWins) {
      const img = await Promise.race([v.win.webContents.capturePage(), wait(4000)]);      // a hidden window may never answer
      if (img) fs.writeFileSync(path.join(SHOT_DIR, `${name}-${v.key}.png`), img.toPNG());
    }
  };
  // what each monitor's player is doing, next to where the shared clock says it should be
  const look = async (tag) => {
    for (const v of visWins) {
      const r = await v.win.webContents.executeJavaScript(`(() => { const v = document.querySelector('#v'); return { src: (v.currentSrc || '').replace(/k=[0-9a-f]+/, 'k').replace(/^file:.*\\//, 'file:').slice(0, 70), t: +v.currentTime.toFixed(2), rs: v.readyState, paused: v.paused, size: v.videoWidth + 'x' + v.videoHeight, err: v.error && v.error.code, rate: +v.playbackRate.toFixed(3) }; })()`);
      const at = (/\/x\?/.test(r.src) ? xc.start : 0) + r.t;
      log.push(`${tag} [${v.key} hdr=${v.hdr}] at=${at.toFixed(2)} clock=${vpos().toFixed(2)} off=${(at - vpos()).toFixed(2)} ${JSON.stringify(r)}`);
    }
  };
  await wait(5000);
  const only = (process.env.DRIFT_ONLY || '').split(',').filter(Boolean);
  if (process.env.DRIFT_PALETTE) patch({ palette: process.env.DRIFT_PALETTE });
  for (const s of (only.length ? only : SCENES)) { patch({ scene: s }); await wait(2600); await snap(s); }
  const lv = lastLevels || {};
  log.push('levels(generative): ' + JSON.stringify(lv.l) + ' spec max=' + Math.max(...(lv.s || [0])) + ' bands>0=' + (lv.s || []).filter((x) => x > 0).length + ' wave range=' + Math.min(...(lv.w || [128])) + '..' + Math.max(...(lv.w || [128])) + ' beats=' + JSON.stringify(lv.b) + ' aclock=' + (lv.a || 0).toFixed(3) + ' beatsSoFar=' + beatCount);
  if (process.env.DRIFT_OVERLAY) {
    patch({ scene: 'lines', overlay: 'bars' }); await wait(2600); await snap('ov-bars');
    patch({ scene: 'aurora', overlay: 'wave', palette: 'cycle', cycleSecs: 10 }); await wait(2600); await snap('ov-wave');
    patch({ overlay: 'none', palette: 'aurora' });
  }
  if (process.env.DRIFT_TESTWAV) {
    const b0 = beatCount; addTracks([process.env.DRIFT_TESTWAV]); await wait(6000); beatCount -= b0;
    log.push('beats during file: ' + beatCount);
    log.push('levels(file): ' + JSON.stringify(lastLevels) + ' now=' + JSON.stringify(nowPlaying));
  }
  if (process.env.DRIFT_TESTVIDEO) {
    state.video.folders = [path.dirname(process.env.DRIFT_TESTVIDEO)];
    patch({ video: { layout: 'span', fit: 'auto' } });
    setVideos(listDir(path.dirname(process.env.DRIFT_TESTVIDEO)).videos.map((v) => v.path)); await wait(7000); await snap('video-span');
    log.push('videoAudio: ' + JSON.stringify(videoAudio));
    await snap('video-spanlayout'); patch({ video: { layout: 'each', fit: 'auto', sound: true } }); await wait(1500);
    ipcMain.emit('cmd', { sender: visWins[0].win.webContents }, { type: 'video-jump', pos: 9 }); await wait(1500); await snap('video-each');
  }
  if (process.env.DRIFT_TESTSUBS) {     // exercise subtitles: auto-pick, styling, timing, online lookup, on / off (run with DRIFT_TESTVIDEO)
    const wc = visWins[0].win.webContents, js = (c) => wc.executeJavaScript(c);
    ipcMain.emit('cmd', { sender: wc }, { type: 'video-jump', pos: +process.env.DRIFT_TESTSUBS || 20 }); await wait(9000);
    log.push('subs: ' + JSON.stringify({ ...subInfo, tracks: subInfo.tracks.length, first: subInfo.tracks.slice(0, 3).map((t) => t.label) }) + ' cues=' + subCues.length);
    const seen = new Set();
    for (let i = 0; i < 14; i++) { seen.add(await js("document.querySelector('#subText').innerHTML + ' @' + document.querySelector('#v').currentTime.toFixed(1)")); await wait(300); }
    log.push('subs on screen: ' + [...seen].join(' || '));
    await snap('subs-auto');
    wc.send('cmd', { type: 'show-panel', tab: 'video' }); await wait(1500);
    await js("document.querySelector('#subMore').click()"); await wait(600); await snap('subs-look');
    patch({ subs: { size: 1.5, bg: 'box', color: '#ffe46b', lift: 12 } }); ipcMain.emit('cmd', { sender: wc }, { type: 'sub-offset', delta: 0.5 }); await wait(900); await snap('subs-styled');
    log.push('styled: ' + JSON.stringify({ ...state.subs, perFile: Object.keys(state.subs.perFile).length }) + ' offset=' + subInfo.offset);
    if (process.env.DRIFT_TESTSUBS_ONLINE) {
      await js("document.querySelector('#subFind').click()");
      await js(`(() => { document.querySelector('#subQ').value = ${JSON.stringify(process.env.DRIFT_TESTSUBS_ONLINE)}; document.querySelector('#subS').value = '1'; document.querySelector('#subE').value = '1'; document.querySelector('#subGo').click(); })()`); await wait(8000);
      log.push('online results: ' + await js("document.querySelectorAll('.subres').length + ' | ' + (document.querySelector('#subResults').innerText || '').slice(0, 160).replace(/\\n/g, ' / ')"));
      await snap('subs-online');
      await js("(document.querySelectorAll('.subres')[1] || document.querySelector('.subres')).click()"); await wait(7000);
      log.push('after download: sel=' + subInfo.sel + ' cues=' + subCues.length + ' note=' + subInfo.note + ' tracks=' + subInfo.tracks.length);
    }
    selectSub('off'); await wait(600); log.push('off: ' + JSON.stringify([state.subs.on, subInfo.sel]) + ' shown=' + await js("document.querySelector('#subs').classList.contains('on')"));
    toggleSubs(); await wait(3000); log.push('toggle on: sel=' + subInfo.sel + ' cues=' + subCues.length + ' note=' + subInfo.note);
  }
  if (process.env.DRIFT_TESTMUSIC) {
    const dir = process.env.DRIFT_TESTMUSIC;
    patch({ scene: 'ridges', music: { folders: [dir], source: 'files' } });
    visWins[0].win.webContents.send('cmd', { type: 'show-panel', tab: 'music' }); await wait(2500);
    log.push('listDir: ' + JSON.stringify(listDir(dir, 'audio')).slice(0, 300));
    log.push('search: ' + searchLib('audio', dir, 'deep').map((x) => x.name).join(','));
    ipcMain.emit('cmd', { sender: visWins[0].win.webContents }, { type: 'play-tracks', files: listDir(dir, 'audio').videos.map((v) => v.path), index: 1 });
    await wait(2500); await snap('music-lib'); log.push('now=' + JSON.stringify(nowPlaying) + ' levels=' + JSON.stringify(lastLevels));
    patch({ music: { source: 'spotify' } }); await wait(2500); await snap('music-spotify'); log.push('spotify=' + JSON.stringify(spotify));
    patch({ music: { source: 'generative' } });
  }
  if (process.env.DRIFT_CTX) {     // exercise the tab-aware transport
    const wc = visWins[0].win.webContents, press = (code) => wc.executeJavaScript(code);
    wc.send('cmd', { type: 'show-panel', tab: 'video' }); await wait(1500);
    const i0 = state.video.index; await press("document.querySelector('#nextTrack').click()"); await wait(800);
    log.push(`video tab next: index ${i0} -> ${state.video.index}, scene=${state.scene}`);
    await press("document.querySelector('#play').click()"); await wait(500); log.push(`video tab pause: video.paused=${state.video.paused} music.playing=${state.music.playing} frozen=${state.frozen}`);
    await press("document.querySelector('#play').click()"); await wait(300);
    wc.send('cmd', { type: 'show-panel', tab: 'music' }); await wait(800);
    const p0 = state.music.preset; await press("document.querySelector('#nextTrack').click()"); await wait(500);
    log.push(`music tab next: preset ${p0} -> ${state.music.preset}, scene=${state.scene}, video index=${state.video.index}`);
    await press("document.querySelector('#play').click()"); await wait(500); log.push(`music tab pause: music.playing=${state.music.playing} video.paused=${state.video.paused}`);
    await press("document.querySelector('#play').click()"); await wait(300);
    wc.send('cmd', { type: 'show-panel', tab: 'scenes' }); await wait(800);
    await press("document.querySelector('#play').click()"); await wait(500); log.push(`scenes tab pause: frozen=${state.frozen} music.playing=${state.music.playing}`);
    await press("document.querySelector('#play').click()"); await wait(300);
    await press("document.querySelector('#nextTrack').click()"); await wait(1500); log.push(`scenes tab next: scene=${state.scene}`);
    await snap('ctx-scenes');
  }
  if (process.env.DRIFT_CUSTOM) {     // exercise the custom colour picker through the real UI
    const wc = visWins[0].win.webContents;
    patch({ scene: 'polyhedra', palette: 'sunset' });
    wc.send('cmd', { type: 'show-panel', tab: 'scenes' }); await wait(1500);
    await wc.executeJavaScript("document.querySelector('.sw.cus').click()"); await wait(600);
    log.push('custom seeded: ' + state.palette + ' ' + JSON.stringify(state.customColors));
    await wc.executeJavaScript("(() => { const el = document.querySelector('#customRow input[data-i=\"2\"]'); el.value = '#ff2d95'; el.dispatchEvent(new Event('input', { bubbles: true })); })()"); await wait(600);
    log.push('custom edited: ' + JSON.stringify(state.customColors));
    await wc.executeJavaScript("document.querySelector('#customDark').click()"); await wait(7000);
    log.push('custom matched: ' + JSON.stringify(state.customColors));
    patch({ customColors: ['red', '#000000', '#111111', '#222222'] }); log.push('bad input ignored: ' + JSON.stringify(state.customColors));
    await wc.executeJavaScript("document.querySelector('#customRow').scrollIntoView({ block: 'center' })"); await wait(500);
    await snap('custom-panel');
    await wc.executeJavaScript("document.querySelector('#panel').classList.remove('show')"); await wait(800); await snap('custom-scene');
    spotifyVolSet(0.5); log.push('spotify vol off-Windows: ' + JSON.stringify(spotify));
  }
  if (process.env.DRIFT_TESTXC) {     // exercise live conversion: HDR to SDR, jumping, pausing, changing settings (DRIFT_FAKE_HDR=0 / 1 picks the kind of screen)
    const f = process.env.DRIFT_TESTXC, wc = visWins[0].win.webContents;
    state.video.folders = [path.dirname(f)]; patch({ music: { source: 'off' }, video: { hdr: 'auto', tone: 'hable', xq: 'auto', enc: 'auto' } });
    setVideos([f]); await wait(1500);
    log.push('xc info: ' + JSON.stringify(videoInfo) + ' audio=' + JSON.stringify(videoAudio) + ' want=' + JSON.stringify(xcWant()) + ' active=' + xcActive() + ' height=' + xcHeight());
    await wait(5000); await look('xc playing'); await snap('xc-playing');
    log.push('xc encoders: ' + JSON.stringify(xcoder.list()) + ' sessions=' + xcoder.active());
    ipcMain.emit('cmd', { sender: wc }, { type: 'video-jump', pos: 20 }); await wait(5000); await look('xc after jump to 20');
    patch({ video: { paused: true } }); await wait(1500); await look('xc paused');
    patch({ video: { paused: false } }); await wait(2500); await look('xc resumed');
    patch({ video: { tone: 'mobius', xq: '720' } }); await wait(5000); await look('xc mobius 720p'); await snap('xc-mobius');
    patch({ video: { hdr: 'never' } }); await wait(3500); await look('xc hdr never');
    patch({ video: { hdr: 'always', tone: 'hable', xq: 'auto', enc: process.env.DRIFT_TESTENC || 'auto' } }); await wait(6000); await look('xc hdr always, ' + state.video.enc);
    wc.send('cmd', { type: 'show-panel', tab: 'settings' }); await wait(1200); await snap('xc-settings');
    log.push('xc last error: ' + (xcoder.lastError() || 'none') + ' sessions=' + xcoder.active() + ' fails=' + xcFails + ' fallback=' + encFallback);
  }
  if (process.env.DRIFT_TESTSHARE) {     // exercise watch together with two copies of Drift on one PC (DRIFT_USERDATA apart): =host or =guest, DRIFT_TESTCODE = a file both can reach
    const role = process.env.DRIFT_TESTSHARE, codeFile = process.env.DRIFT_TESTCODE, wc = visWins[0].win.webContents, cmd = (c) => ipcMain.emit('cmd', { sender: wc }, c);
    const info = () => { const p = publicState().p2p; return JSON.stringify({ ...p, code: (p.code || '').length }); };
    patch({ music: { source: 'off' }, share: { internet: false, wait: true, control: true, quality: 'original', name: role === 'host' ? 'Hosty' : 'Guesty' } });
    if (role === 'host') {
      setVideos([process.env.DRIFT_TESTVIDEO]); await wait(2500);
      cmd({ type: 'share-start' }); await wait(1500);
      fs.writeFileSync(codeFile, p2p.info().code); log.push('host: ' + info());
      for (let i = 0; i < 40 && !p2p.count(); i++) await wait(500);
      for (let i = 0; i < 27; i++) {
        await wait(2000); await look('host +' + i * 2 + 's paused=' + state.video.paused + ' held=' + JSON.stringify(heldFor));
        if (i === 3) { wc.send('cmd', { type: 'show-panel', tab: 'share' }); await wait(800); await snap('share-host'); }
      }
      log.push('host end: ' + info() + ' sessions=' + xcoder.active() + ' err=' + (xcoder.lastError() || 'none'));
    } else {
      for (let i = 0; i < 80 && !fs.existsSync(codeFile); i++) await wait(500);
      await wait(600); cmd({ type: 'share-join', code: fs.readFileSync(codeFile, 'utf8') });
      for (let i = 0; i < 22; i++) {
        await wait(2000); await look('guest +' + i * 2 + 's');
        if (i === 1) {
          log.push('guest: ' + info() + ' info=' + JSON.stringify(videoInfo) + ' subs=' + subInfo.tracks.length + ' xc=' + JSON.stringify(publicState().xc).replace(/k=[0-9a-f]+/, 'k'));
          wc.send('cmd', { type: 'show-panel', tab: 'share' }); await wait(800); await snap('share-guest');
        }
        if (i === 3) { log.push('guest presses pause'); patch({ video: { paused: true } }); }
        if (i === 5) { log.push('guest presses play'); patch({ video: { paused: false } }); }
        if (i === 7) { log.push('guest jumps to 25'); cmd({ type: 'video-jump', pos: 25, final: true }); }
        if (i === 10) { log.push('guest asks for 720p'); patch({ share: { quality: '720' } }); }
        if (i === 14) { log.push('guest back to original: ' + info()); patch({ share: { quality: 'original' } }); }
        if (i === 17) { log.push('guest leaves'); cmd({ type: 'share-stop' }); }
      }
      log.push('guest end: ' + info() + ' scene=' + state.scene);
    }
  }
  if (process.env.DRIFT_TESTSHAREUI) {     // press the real buttons in the Together tab and read back what it says
    const wc = visWins[0].win.webContents, js = (c) => wc.executeJavaScript(c);
    const dump = async (tag) => log.push('shareui ' + tag + ': ' + await js("JSON.stringify({ off: getComputedStyle(document.querySelector('#shOff')).display, host: getComputedStyle(document.querySelector('#shHost')).display, title: document.querySelector('#shTitle').textContent, sub: document.querySelector('#shSub').textContent, note: document.querySelector('#shNote').textContent, code: document.querySelector('#shCodeOut').textContent.length, toast: document.querySelector('#toast').className + '|' + document.querySelector('#toast').textContent, tab: (document.querySelector('#content section.active') || {}).dataset && document.querySelector('#content section.active').dataset.tab })"));
    patch({ music: { source: 'off' } });
    wc.send('cmd', { type: 'show-panel', tab: 'share' }); await wait(1000); await dump('before');
    await js("document.querySelector('#shStart').click()"); await wait(1500); await dump('clicked with no video');
    if (process.env.DRIFT_TESTVIDEO) { setVideos([process.env.DRIFT_TESTVIDEO]); await wait(2500); await js("document.querySelector('#shStart').click()"); await wait(1500); await dump('clicked with video'); await wait(15000); await dump('15 s later'); }
    await js("document.querySelector('#shStop').click()"); await wait(2500); await dump('stopped');
  }
  if (process.env.DRIFT_TESTQUIT) {     // exercise the "Close Drift?" question: Esc asks, Esc again stays, closing the window asks too
    const v = visWins[0], wc = v.win.webContents, up = () => wc.executeJavaScript("document.querySelector('#confirm').classList.contains('on')");
    const key = (keyCode) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); wc.sendInputEvent({ type: 'keyUp', keyCode }); };
    key('Escape'); await wait(2000); log.push('quit: after Esc, asking=' + await up() + ' note=' + await wc.executeJavaScript("document.querySelector('#confirmNote').textContent")); await snap('quit-ask');
    key('Escape'); await wait(500); log.push('quit: after a second Esc, asking=' + await up());
    v.win.close(); await wait(500); log.push('quit: after closing the window, asking=' + await up() + ' window still there=' + !v.win.isDestroyed());
    key('Escape'); await wait(300);
  }
  if (process.env.DRIFT_PANEL) {
    for (const tab of ['scenes', 'video', 'music', 'settings']) { visWins[0].win.webContents.send('cmd', { type: 'show-panel', tab }); await wait(tab === 'scenes' || tab === 'video' ? 6000 : 1500); await snap('panel-' + tab); }
  }
  fs.writeFileSync(path.join(SHOT_DIR, 'log.txt'), log.join('\n'));
  quitting = true; app.quit();
}
