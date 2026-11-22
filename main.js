// Drift — main process: one fullscreen window per monitor, shared state, hidden audio engine window.
const { app, BrowserWindow, ipcMain, screen, dialog, powerSaveBlocker, shell, session, desktopCapturer, net, clipboard, webContents, protocol, safeStorage } = require('electron');
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
const createChat = require('./chat');
const createWeb = require('./web');
const createUpdater = require('./updater');

if (process.env.DRIFT_USERDATA) app.setPath('userData', path.resolve(process.env.DRIFT_USERDATA));   // dev: a second copy with its own settings (e.g. to try sharing on one PC)

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,WebRtcHideLocalIpsWithMdns');   // media keys must reach Spotify, not Drift; a shared web page's stream is offered on this PC's real local address
app.commandLine.appendSwitch('disable-background-timer-throttling');
protocol.registerSchemesAsPrivileged([{ scheme: 'drift', privileges: { standard: true, secure: true } }]);       // drift://home/, the Surf tab's own start page: see web.js

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
  cycleSkip: [],           // scenes left out of the automatic scene changes
  displaysOff: [],         // indices of monitors left alone
  quality: 0.75,
  fps: 60,
  clock: false,
  breathing: false,
  keepAwake: true,
  onTop: false,
  surfMirror: false,       // the Surf page shows on every other monitor too (see "mirroring" in renderer/app.js)
  surfGpu: false,          // Surf's pages are drawn offscreen and handed to the windows as textures on the graphics card (see web.js)
  autoUpdate: false,       // download a new release by itself and install it when Drift closes (new releases are looked for either way)
  sleepAt: 0,
  // hdr: auto = convert HDR videos to SDR on screens that aren't showing HDR | always | never; tone = how bright highlights are squeezed in;
  // enc = which ffmpeg encoder converts (auto = the fastest that works on this PC); xq = picture height of converted video (auto = the screen's)
  video: { files: [], index: 0, fit: 'auto', paused: false, sound: true, autoplay: true, volume: 0.8, folders: [], foldersInit: false,
    hdr: 'auto', tone: 'hable', enc: 'auto', xq: 'auto', progress: {} },
  // watch together: internet = ask the router to let friends outside the home in; control = friends may play / pause / seek;
  // wait = pause for everyone while someone is loading; quality = picture size sent to (and asked from) friends
  share: { name: '', internet: true, control: true, wait: true, quality: 'original', port: 47800, adblock: true, overlay: 'unheard' },       // overlay: whose chat messages go over the video (unheard / all / off)
  // subtitles: on = show them when a video has some; perFile remembers the track and timing chosen for each video
  subs: { on: true, lang: 'en', size: 1, color: '#ffffff', bg: 'outline', lift: 0, perFile: {} },
  prevScene: 'aurora',
  frozen: false,           // scene animation paused
  settingsVersion: 6,
  music: {
    playing: true,
    source: 'generative',  // generative (Ambient) | files (music from the library) | off
    folders: [], foldersInit: false,
    preset: 'pads',
    ambientOff: false,     // Ambient sound (in Scenes) set to Off: what comes back when music from the library stops
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
let vEnded = false;      // autoplay is off and the video stopped at its end, so play starts it again from the top
let videoFails = 0, xcAt = 0, goodbye = false;
let clock = { base: 0, ref: Date.now() };   // visual time: t = base + (now-ref)/1000*speed
let saveTimer = null, cycleTimer = null, sleepTimer = null, rebuildTimer = null;
let blockerId = null;
let quitting = false;
let updater = null, updTold = '';

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
    const pr = state.video.progress;
    state.video.progress = pr && typeof pr === 'object' && !Array.isArray(pr) ? Object.fromEntries(Object.entries(pr).filter(([, r]) => r && isFinite(r.pos)).slice(-PROGRESS_KEEP)) : {};
    if (!state.video.files.length) dropVideoScene();
    if ((s.settingsVersion || 1) < 2) state.video.sound = true;     // video sound used to default to off, which read as "broken audio"
    if ((s.settingsVersion || 1) < 3) {       // fit used to hold the layout too
      const old = (s.video || {}).fit;
      state.video.fit = old === 'contain' || old === 'fill' ? old : 'auto';
    }
    if ((s.settingsVersion || 1) < 4 && state.reactivity === 0.5) state.reactivity = 0.7;   // sound reactions are stronger by default now
    delete state.video.layout;                // Span / Mirror / Mix now covers videos too, so videos no longer have their own layout
    if (!['span', 'mirror', 'mix'].includes(state.mode)) state.mode = 'span';
    if ((s.settingsVersion || 1) < 6) {       // music and videos share one library now, and Spotify is no longer a music source (Drift follows it by itself)
      for (const f of (s.music || {}).folders || []) if (!state.video.folders.includes(f)) state.video.folders.push(f);
      state.music.folders = []; state.music.foldersInit = true; state.video.foldersInit = true;
      state.music.ambientOff = state.music.source === 'off' || state.music.source === 'spotify';
    }
    if (!['generative', 'files', 'off'].includes(state.music.source)) state.music.source = 'off';
    state.settingsVersion = 6;
    // Drift opens where it was left, but quietly: a video or a song from the library comes back paused, ready to carry on with play.
    state.video.paused = state.video.files.length > 0;
    const known = (id) => id === 'video' || SCENES.includes(id);
    if (!known(state.scene)) state.scene = 'aurora';
    for (const k of Object.keys(state.perDisplay || {})) if (!known(state.perDisplay[k])) delete state.perDisplay[k];
    state.cycleSkip = Array.isArray(state.cycleSkip) ? state.cycleSkip.filter((id) => SCENES.includes(id)) : [];
    if (state.palette === 'custom' && !Array.isArray(state.customColors)) state.palette = 'aurora';
    state.video.folders = (state.video.folders || []).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    state.music.playlist = (state.music.playlist || []).filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (state.music.source === 'files' && !state.music.playlist.length) state.music.source = state.music.ambientOff ? 'off' : 'generative';
    if (state.music.source === 'files') state.music.playing = false;
    if (!state.surf || typeof state.surf !== 'object' || !Array.isArray(state.surf.urls)) state.surf = null;
  } catch { /* first run */ }
}
const QUALITY = { original: { h: 0, kbps: 0 }, 1080: { h: 1080, kbps: 6000 }, 720: { h: 720, kbps: 3000 }, 480: { h: 480, kbps: 1200 } };
function cleanShare(q) {
  return { name: String(q.name || '').replace(/[\x00-\x1f<>]/g, '').slice(0, 24), internet: !!q.internet, control: !!q.control, wait: !!q.wait, adblock: !!q.adblock,
    quality: QUALITY[q.quality] ? String(q.quality) : 'original', overlay: ['unheard', 'all', 'off'].includes(q.overlay) ? q.overlay : 'unheard', port: q.port >= 1024 && q.port <= 65535 ? Math.round(q.port) : DEFAULTS.share.port };
}
function dropVideoScene() {
  if (state.scene === 'video') state.scene = 'aurora';
  for (const k of Object.keys(state.perDisplay)) if (state.perDisplay[k] === 'video') delete state.perDisplay[k];
}
// The browser's tabs are kept with the settings too (only while it is open), so it comes back next time.
function saveNow() {
  if (!remote) state.surf = web.saved();
  try { fs.writeFileSync(settingsFile, JSON.stringify(state, null, 1)); } catch { /* ignore */ }
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

function allDisplays() {
  let list;
  if (FAKE > 1) {
    const b = screen.getPrimaryDisplay().bounds;
    const parts = (process.env.DRIFT_FAKE_WIDTHS || '').split(',').map(Number).filter((n) => n > 0);       // dev: monitors of different widths, e.g. "1,2"
    const ws = parts.length === FAKE ? parts : Array(FAKE).fill(1), all = ws.reduce((a, n) => a + n, 0);
    let x = b.x;
    list = ws.map((n, i) => { const w = Math.floor(b.width * n / all), d = { id: i, bounds: { x, y: b.y, width: w, height: b.height }, primary: i === 0 }; x += w; return d; });
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
// ---- where each video was left (saved with the settings), so it carries on from there next time ----
const PROGRESS_KEEP = 300;
const endOf = (dur) => dur - Math.min(30, dur * 0.1);       // past this it counts as watched
function resumeAt(p) {
  const r = p && state.video.progress[p];
  return r && !r.done && r.pos >= 10 && (!r.dur || r.pos < endOf(r.dur)) ? r.pos : 0;
}
// done: the video played to its end
function noteProgress(done) {
  const c = cur();
  if (remote || !c || !c.path || !visWins.some((v) => showsVideo(v.key))) return;
  const all = state.video.progress, old = all[c.path], dur = videoInfo.dur || (old && old.dur) || 0;
  const pos = done ? dur || vpos() : Math.max(0, vpos());
  if (!old && pos < 10) return;
  delete all[c.path];       // re-added last: the newest is at the end, and the oldest go first
  all[c.path] = { pos: Math.round(pos * 10) / 10, dur: Math.round(dur * 10) / 10, done: !!done || (dur > 0 && pos >= endOf(dur)), at: Date.now() };
  const keys = Object.keys(all); for (let i = 0; i < keys.length - PROGRESS_KEEP; i++) delete all[keys[i]];
  saveSoon();
}
// a new video starts where it was left
function startClock(p) { const pos = resumeAt(p); vclock = { startedAt: Date.now() - pos * 1000, pos, seq: (vclock.seq || 0) + 1 }; xc = { epoch: xc.epoch + 1, start: pos }; }
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
  const h = state.mode === 'span' ? unionOf(act).height : Math.max(...act.map((d) => d.bounds.height));
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
  if (!subInfo.sel) subInfo = { ...subInfo, busy: false, note: subInfo.tracks.some((t) => t.usable) ? 'No subtitles in your language here — pick a track in the Media tab.' : 'No subtitles for this video yet — use "Find online" in the Media tab.' };
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
// It is watched all the time: whenever Spotify is playing and Drift itself has no video or music on, the toolbar's controls are Spotify's.
// `had`: it has played since it was opened, so "paused" means a song is paused (not just an idle window).
let spotify = { status: process.platform === 'win32' ? 'closed' : 'unsupported', title: '', volMode: '', vol: 0, had: false }, spotifyProc = null;
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
      spotify = { ...spotify, ...next, had: next.status === 'playing' || (spotify.had && next.status !== 'closed') };
      spotifyVolWatch(next.status !== 'closed');
      pushState();
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

// Volume while Spotify has the toolbar. Drift turns down Spotify's own slot in the Windows volume mixer;
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
// Spotify takes the toolbar (and the visuals listen to the PC's sound) while a song is on in it and nothing of Drift's own is playing:
// no video running and no music from the library (or a friend's).
function spotifyLead() {
  if (!(spotify.status === 'playing' || (spotify.status === 'paused' && spotify.had))) return false;
  if (remote && remote.music && remote.music.on) return false;
  if (state.music.source === 'files' && state.music.playing && state.music.playlist.length) return false;
  return !(cur() && !state.video.paused && visWins.some((v) => showsVideo(v.key)));
}
// Every Drift window draws through Chromium's one GPU process, which works through their drawing in turn, so two monitors of
// heavy scenes can keep a video on a third waiting for its frames. The window playing the video says when frames come late
// (video-strain in app.js), and the other screens' scenes then draw fewer frames a second (never fewer pixels) until it is smooth again.
const STRAIN = [1, 0.8, 0.66, 0.5];
let strain = 0, strainAt = 0;
function sceneFps() {
  const busy = strain && cur() && !vpaused() && visWins.some((v) => showsVideo(v.key)) && visWins.some((v) => !showsVideo(v.key));
  return busy ? Math.max(24, Math.round(state.fps * STRAIN[strain])) : state.fps;
}
function publicState() {
  const c = cur(), lead = visWins.find((v) => showsVideo(v.key));
  // while watching with a friend, the list, position and pause state are theirs
  const video = remote ? { ...state.video, files: remote.files.map((f) => f.name), index: remote.index, paused: !!remote.paused } : state.video;
  return { ...state, video, subs: { ...state.subs, perFile: undefined }, subsInfo: subInfo, time: clock, nowPlaying, vclock,
    videoUrl: c ? (c.path ? pathToFileURL(c.path).href : c.src) : '', videoName: c ? c.name : '', videoPath: c ? c.path : '', videoLeader: lead && c ? lead.key : '',
    sceneFps: sceneFps(), screens: visWins.length, spotify: { ...spotify, lead: spotifyLead() }, videoAudio, videoInfo, audioBase: audioPort && c ? local(`/a?i=${c.index}`) : '',
    xc: { ...xc, ...xcWant(), base: xcBase() }, encoders: xcoder.list(), canTonemap: !xcoder.ready() || xcoder.canTonemap(),
    p2p: { ...p2p.info(), ctrl: !remote || !!remote.ctrl, own: !!(c && c.remote && c.path), viaHost: viaHost(), quality: shareQuality(), waitingFor: heldFor || [], defaultName: shareName(true), file: remote ? remote.file || '' : '', music: remote ? remote.music : null, chatHub: sessionHub() },       // music: a friend's, playing here in place of ours; chatHub: the hub this session is in
    // a friend's page arrives as a stream; our own is a page in one of our windows
    update: updater ? updater.info() : null,
    web: remote ? { open: !!remote.web && streamShown, has: !!remote.web, stream: true, key: remote.web && streamShown ? screenFor(streamKey) : '', ...(remote.web || {}) } : web.info() };
}
function broadcast(channel, payload, includeAudio = true) {
  for (const v of visWins) if (!v.win.isDestroyed()) v.win.webContents.send(channel, payload);
  if (includeAudio && audioWin && !audioWin.isDestroyed()) audioWin.webContents.send(channel, payload);
}
function pushState() { broadcast('state', publicState()); p2p.sync(); syncLive(); }
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
// The music friends hear too (Ambient or My music; Spotify isn't ours to send). It reaches them as a live stream from the
// audio window: see renderer/audio.js. `video` says a video is up here, whose sound takes over from the music.
function sharedMusic(video) {
  const m = state.music;
  if (m.source !== 'files' && m.source !== 'generative') return null;
  return { on: !!m.playing && !(video && state.video.sound), src: m.source, title: m.source === 'files' ? String(nowPlaying.title || '') : '', preset: m.preset };
}
function shareSnapshot() {
  const on = !remote && visWins.some((v) => showsVideo(v.key)), c = on ? cur() : null;
  return { files: on ? state.video.files.map((f) => ({ name: path.basename(f), size: sizeOf(f) })) : [], index: on ? state.video.index : 0,
    file: c ? `${c.index}|${c.name}|${sizeOf(c.path)}` : '', paused: state.video.paused, pos: vclock.pos, startedAt: vclock.startedAt, seq: vclock.seq || 0,
    info: videoInfo, audio: { mode: videoAudio.mode, codec: videoAudio.codec },
    // subtitle tracks are named by a hash so no folder names leave this PC
    tracks: probing ? null : subInfo.tracks.filter((t) => t.usable && t.kind !== 'shared').map((t) => ({ id: subsLib.hash(t.id), kind: t.kind, lang: t.lang, label: t.label, def: !!t.def, forced: !!t.forced, sdh: !!t.sdh })),
    ctrl: state.share.control, cap: state.share.quality, xc: !!ffmpegPath(), web: remote ? null : web.shared(), music: remote ? null : sharedMusic(on && !!cur()) };
}
function videoJump(pos, play) {
  pos = Math.max(0, +pos || 0); vEnded = false;
  vclock = { startedAt: Date.now() - pos * 1000, pos, seq: (vclock.seq || 0) + 1 };
  if (play) state.video.paused = false;
  pushState();
  if (xcActive()) xcRestart(pos, 180);       // wait for the seek bar to settle before starting a new stream
}
function videoStep(dir) {
  const n = state.video.files.length; if (!n) return;
  noteProgress();
  vEnded = false;
  videoFails = 0; xcFails = 0;
  state.video.index = (state.video.index + (dir < 0 ? -1 : 1) + n) % n;
  state.video.paused = false;
  startClock(state.video.files[state.video.index]);
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
  if (!was) web.close();       // their page, if they have one open, is shown here in place of ours
  const w = s.web && typeof s.web === 'object' && s.web.sid ? { url: String(s.web.url || '').slice(0, 2000), title: String(s.web.title || '').slice(0, 200), sid: String(s.web.sid).slice(0, 40),
    tabs: (Array.isArray(s.web.tabs) ? s.web.tabs : []).slice(0, 20).map((t) => ({ id: +(t || {}).id || 0, title: String((t || {}).title || '').slice(0, 200) })), active: +s.web.active || 0, back: !!s.web.back, fwd: !!s.web.fwd } : null;
  if (w && !(was && was.web)) streamShown = true;       // they opened their browser: it comes up here too
  const mu = s.music && typeof s.music === 'object' ? { on: !!s.music.on, src: s.music.src === 'files' ? 'files' : 'generative', title: String(s.music.title || '').slice(0, 200), preset: String(s.music.preset || '').slice(0, 40) } : null;
  remote = { ...s, web: w, music: mu, files: (Array.isArray(s.files) ? s.files : []).slice(0, 5000).map((f) => ({ name: path.basename(String(f.name || 'video')).slice(0, 200), size: +f.size || 0 })),
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
  else if (m.a === 'music') {       // their play / pause / next / previous for our music
    if (!sharedMusic(false)) return;
    if (m.do === 'toggle') patch({ music: { playing: !state.music.playing } });
    else if ((m.do === 'next' || m.do === 'prev') && state.music.source === 'files' && audioWin && !audioWin.isDestroyed()) audioWin.webContents.send('cmd', { type: m.do });
  }
  else if (m.a === 'surf') { if (web.info().open && !web.info().out && m.m && typeof m.m === 'object' && SURF.includes(m.m.do)) web.act({ do: m.m.do, text: m.m.text, id: m.m.id, n: m.m.n }); }       // the browser's own controls: tabs, back, the address…
  else if (m.a === 'input') web.input(m.e);       // their mouse or keyboard, over the picture of our web page
}
// The Surf tab's browser, which friends see too while this PC shares: see web.js.
const SURF = ['go', 'home', 'new', 'tab', 'close', 'back', 'fwd', 'reload', 'hard', 'reopen', 'step', 'nth', 'zoom'];       // (the last five: keyboard shortcuts)
const screenFor = (key) => (visWins.some((x) => x.key === key) ? key : (visWins.find((x) => (allDisplays().find((d) => d.key === x.key) || {}).primary) || visWins[0] || { key: 'd0' }).key);
let streamKey = '', streamShown = true;       // as a guest: the monitor a friend's browser is shown on, and whether it is showing here
const web = createWeb({
  changed: () => pushState(),
  screen: screenFor,
  escape: () => { const x = visWins.find((y) => y.key === web.info().key); if (x && !x.win.isDestroyed()) { x.win.webContents.focus(); x.win.webContents.send('cmd', { type: 'web-esc' }); } },
  unfull: (hostWc) => setTimeout(() => {       // leaving a video's full screen must not take Drift's window out of full screen with it
    const x = visWins.find((y) => !y.win.isDestroyed() && y.win.webContents === hostWc);
    if (x && FAKE <= 1 && !process.env.DRIFT_HIDDEN && !x.win.isFullScreen()) x.win.setFullScreen(true);
  }, 150),
  blockAds: () => state.share.adblock,
  ublockDir: () => path.join(app.getPath('userData'), 'ublock'),
  say,
  bounds: (key) => { const x = visWins.find((y) => y.key === screenFor(key)); return x && !x.win.isDestroyed() ? x.win.getBounds() : screen.getPrimaryDisplay().bounds; },
  away: (on) => {       // the PC's own browser is over the Surf monitor: Drift's window there must not stay above it
    webAway = on;
    const x = visWins.find((y) => y.key === web.info().key);
    if (x && !x.win.isDestroyed()) x.win.setAlwaysOnTop(!on && !!state.onTop, 'screen-saver');
  },
  profile: () => path.join(app.getPath('userData'), 'browser-profile'),
  gpu: () => !!state.surfGpu,
  win: (key) => { const x = visWins.find((y) => y.key === key); return x && !x.win.isDestroyed() ? x.win : null; },
  display: (key) => { const x = visWins.find((y) => y.key === key); return x && !x.win.isDestroyed() ? screen.getDisplayMatching(x.win.getBounds()) : null; },
  // The size in pixels to draw the page at: that of the widest monitor it shows on (its own, and every other one while mirroring).
  // Monitors of another shape show it whole, with black bars.
  pageSize: (key) => {
    let best = null;
    for (const x of visWins) {
      if (x.win.isDestroyed() || (x.key !== key && !state.surfMirror)) continue;
      const k = screen.getDisplayMatching(x.win.getBounds()).scaleFactor || 1, [w, h] = x.win.getContentSize(), px = { w: Math.round(w * k), h: Math.round(h * k) };
      if (!best || px.w > best.w || (px.w === best.w && px.h > best.h)) best = px;
    }
    return best;
  },
});
let webAway = false;
// Where everyone's mouse is over a shared web page, as fractions of the page, so each PC can draw the others' pointers.
// This PC, sharing, gathers them (its own included) and passes each friend everyone's but their own.
const pointers = new Map();
let ptrTimer = null;
const ptrClean = (list) => (Array.isArray(list) ? list : []).slice(0, 12).filter((q) => q && typeof q === 'object' && q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1)
  .map((q) => ({ id: String(q.id).slice(0, 16), name: String(q.name || '').replace(/[\x00-\x1f<>]/g, '').slice(0, 24), x: +q.x, y: +q.y }));
function ptrShow(key, list) { const x = visWins.find((y) => y.key === key); if (x && !x.win.isDestroyed()) x.win.webContents.send('cmd', { type: 'ptrs', list }); }
function ptrSet(id, name, m) {
  const ok = m && typeof m === 'object' && m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1 && web.info().open;
  if (!ok && !pointers.has(id)) return;
  if (ok) pointers.set(id, { id, name, x: +m.x, y: +m.y }); else pointers.delete(id);
  if (ptrTimer) return;
  ptrTimer = setTimeout(() => {       // at most 25 times a second
    ptrTimer = null;
    const all = ptrClean([...pointers.values()]);
    ptrShow(web.info().key, all.filter((q) => q.id !== 'host'));
    for (const peer of p2p.ids()) p2p.sendTo(peer, { t: 'ptrs', list: all.filter((q) => q.id !== peer) });
  }, 40);
}
setInterval(() => {       // this PC's own mouse: the page swallows it, so ask Windows where it is
  const w = web.info(), x = p2p.role() === 'host' && p2p.count() && w.open ? visWins.find((y) => y.key === w.key) : null;
  if (!x || x.win.isDestroyed()) { if (pointers.size && (p2p.role() !== 'host' || !w.open)) { pointers.clear(); ptrSet('host', '', null); } return; }
  if (SHOT_DIR) return;       // dev runs place it by hand
  const c = screen.getCursorScreenPoint(), b = x.win.getContentBounds();
  ptrSet('host', shareName(), { x: (c.x - b.x) / b.width, y: (c.y - b.y) / b.height });
}, 60);
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
  ptr: (id, name, m) => { if (p2p.role() === 'host') ptrSet(id, name, m); },
  ptrs: (list) => { if (remote && remote.web) ptrShow(screenFor(streamKey), ptrClean(list)); },
  rtc: (id, d) => {       // setting up the stream of a web page: hand it to the window that has the page (sharing) or shows it (watching)
    if (!d || typeof d !== 'object' || (id ? p2p.role() !== 'host' : !remote)) return;
    if (d.ch === 'music') { if (audioWin && !audioWin.isDestroyed()) audioWin.webContents.send('cmd', { type: 'rtc', from: id, d }); return; }       // the music's stream is the audio window's
    const k = id ? web.info().key : screenFor(streamKey), x = visWins.find((y) => y.key === k);
    if (x && !x.win.isDestroyed()) x.win.webContents.send('cmd', { type: 'rtc', from: id, d });
  },
  playing: () => !remote && !state.video.paused && !!cur() && visWins.some((v) => showsVideo(v.key)),
  hold: (names) => {       // pause for everyone while a friend loads; carry on when they have caught up
    if (names) { if (!heldFor) setPaused(true); if ((heldFor || []).join() !== names.join()) { heldFor = names; pushState(); } }
    else if (heldFor) { heldFor = null; setPaused(false); pushState(); }
  },
  remote: onRemote,
  publicIp,
  say,
  changed: () => pushState(),
});

async function publicIp() { const r = await net.fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) }); const ip = (await r.text()).trim(); return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : ''; }

// ---- chat ------------------------------------------------------------------------------------------
// chat.js holds this PC's identity, its hubs and (when hosting) a hub of its own; this passes what it says to the windows.
// Every window's panel has a Chat tab, so all of them hear about changes. A new message pops up on one screen only.
let chat = null, chatPub = '', shownSessionHub = '';
function startChat() {
  const enc = safeStorage.isEncryptionAvailable();
  chat = createChat({
    dir: path.join(app.getPath('userData'), 'chat'),
    seal: (b) => (enc ? safeStorage.encryptString(b.toString('latin1')) : b),
    unseal: (b) => (enc ? Buffer.from(safeStorage.decryptString(Buffer.from(b)), 'latin1') : b),
    addrs: () => [...(createP2P.isPublic(chatPub) ? [chatPub] : []), ...createP2P.localAddrs()],
    upnp: async (port) => { const m = await createP2P.upnpMap(port); if (createP2P.isPublic(m.ip)) chatPub = m.ip; return m; },
    changed: () => {
      broadcast('chat', { type: 'info', info: chat.info() }, false);
      const sh = sessionHub();       // the session's hub is known once that hub lists the share: the panels need it to chat over the video
      if (sh !== shownSessionHub) { shownSessionHub = sh; pushState(); }
    },
    event: (hub, m) => {
      broadcast('chat', { type: 'event', hub, m }, false);
      // A new message pops up on one screen: over the video, while watching together in that hub (yours too, so the
      // conversation reads in order), or as a note at the top for anyone else's.
      const over = m.t === 'msg' && m.msg && !m.msg.edited && hub === sessionHub();
      if (m.t === 'msg' && m.msg && !m.msg.edited && (over || m.msg.from !== chat.myId())) {
        const f = BrowserWindow.getFocusedWindow(), v = visWins.find((x) => x.win === f) || visWins[0];
        if (v && !v.win.isDestroyed()) v.win.webContents.send('chat', { type: 'notify', hub, msg: m.msg, overlay: over });
      }
    },
    log: (t) => { console.log(t); if (SHOT_DIR) { try { fs.appendFileSync(path.join(SHOT_DIR, 'chat.log'), new Date().toISOString().slice(11, 23) + ' ' + t + '\n'); } catch { /* fine */ } } },       // test runs keep chat's log
  });
  chat.setName(shareName());
  if (!SHOT_DIR || process.env.DRIFT_TESTCHAT) chat.start().catch((e) => console.log('chat: ' + e.message));
  publicIp().then((ip) => { chatPub = ip; }).catch(() => {});
}
// Sharing (Together) happens in a hub: the hub hears this PC's watch-together code, what's on and who's watching, and
// everyone in it gets a Join button in the chat. liveHub is the hub the current share was started in.
let liveHub = '', liveSent = '', joinedCode = '';
// The hub the watch-together session belongs to: the one this PC shares into, or the one whose card it joined from.
function sessionHub() {
  if (!chat || p2p.role() === 'off') return '';
  if (p2p.role() === 'host') return liveHub;
  const h = chat.info().hubs.find((x) => (x.lives || []).some((l) => l.code === joinedCode));
  return h ? h.id : '';
}
function shareTitle() {
  const c = cur(), w = web.info();
  return c && visWins.some((v) => showsVideo(v.key)) ? c.name : w && w.open ? (w.title || 'a web page') : 'nothing yet';
}
function syncLive() {
  if (!chat) return;
  const p = p2p.info();
  const live = p.role === 'host' && liveHub && p.code && !p.settling ? { code: p.code, title: shareTitle(), watching: (p.peers || []).map((x) => x.name).slice(0, 8) } : null;
  const key = JSON.stringify([liveHub, live]);
  if (key === liveSent) return;
  liveSent = key;
  chat.announce(live ? liveHub : '', live);
  if (!live && p.role !== 'host') liveHub = '';
}
// The hub to share into: the one asked for, else the first one this PC is connected to, else a new one of its own.
async function shareHub(want) {
  const up = (id) => chat.info().hubs.some((h) => h.id === id && h.status === 'connected');
  if (want && up(want)) return want;
  const any = chat.info().hubs.find((h) => h.status === 'connected');
  if (any) return any.id;
  const r = await chat.host({ name: '', internet: state.share.internet !== false });
  return r.hosting ? r.hosting.id : '';
}

// What the panel may ask of chat. Each argument is checked here; chat.js and the hub check them again.
const CHAT_OPS = {
  info: () => chat.info(),
  join: async (code) => {       // a hub's invite, or (from before Together and Chat were one) a friend's watch-together code
    code = String(code || '').slice(0, 400);
    if (!createChat.decodeInvite(code) && createP2P.decodeCode(code)) { const r = await p2p.join(code, shareName()); return r.ok ? { watching: true } : { error: r.error }; }
    return chat.join(code);
  },
  leave: (hub) => chat.leave(String(hub)),
  host: (name) => chat.host({ name: String(name || ''), internet: state.share.internet !== false }),
  unhost: () => chat.unhost(),
  history: (hub, ch, o) => chat.history(String(hub), +ch, { before: +(o && o.before) || undefined, after: +(o && o.after) || undefined, limit: +(o && o.limit) || undefined }),
  send: (hub, ch, text, reply) => chat.send(String(hub), +ch, String(text || ''), +reply || undefined),
  edit: (hub, id, text) => chat.edit(String(hub), +id, String(text || '')),
  delete: (hub, id) => chat.remove(String(hub), +id),
  typing: (hub, ch) => chat.typing(String(hub), +ch),
  channel: (hub, name) => chat.channel(String(hub), String(name || '')),
  dropChannel: (hub, ch) => chat.dropChannel(String(hub), +ch),
  invite: async (hub) => { const r = await chat.invite(String(hub)); if (r.code) clipboard.writeText(r.code); return r; },
  withdrawInvites: (hub) => chat.withdrawInvites(String(hub)),
  removeMember: (hub, member) => chat.removeMember(String(hub), String(member || '')),
  block: (member, on) => chat.block(String(member || ''), !!on),
  paste: () => clipboard.readText().slice(0, 400),
  setAvatar: (data) => chat.setAvatar(String(data || '').slice(0, 20000)),
  avatar: (hub, member, av) => chat.avatar(String(hub), String(member || ''), String(av || '')),
  mic: (on) => chat.setMic(!!on),
};
ipcMain.handle('chat', async (_e, op, ...args) => {
  if (!chat || !Object.hasOwn(CHAT_OPS, op)) return { error: 'Chat isn\'t ready.' };
  try { return (await CHAT_OPS[op](...args)) ?? {}; } catch (e) { return { error: String(e && e.message || e) }; }
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
    tab: v ? tabOf[v.key] || startTab(v.key) : '', reopen: !!v && v.key === refocusKey,
    langs: subsLib.LANGS.map(([code, name]) => [code, name]),
    testMode: !!SHOT_DIR, freeze: !!process.env.DRIFT_FREEZE, fakeHdr: process.env.DRIFT_FAKE_HDR || '',     // dev: pretend this screen is ('1') or isn't ('0') showing HDR
  };
}

// The tab a screen opens on when Drift starts: whatever was left up there. Surf if the browser came back on it (app.js sees to
// that), Media for a video on this screen or a song from the library, otherwise Scenes.
function startTab(key) {
  if (cur() && showsVideo(key)) return 'media';
  if (state.music.source === 'files' && state.music.playlist.length) return 'media';
  return 'scenes';
}

// Turning a monitor on or off rebuilds every window. Each screen comes back on the panel tab it was on (Surf if the browser is
// there), and the window that had focus gets it back, with its panel open where it was.
const tabOf = {};       // display key -> panel tab
let refocusKey = '';
let lastSig = '';
const displaySig = () => JSON.stringify(allDisplays().map((d) => d.bounds));
function buildWindows() {
  lastSig = displaySig();
  const old = visWins;
  const had = old.find((o) => !o.win.isDestroyed() && o.win.isFocused());
  refocusKey = had ? had.key : '';
  visWins = [];
  const act = activeDisplays();
  for (const d of act) {
    const win = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false, show: false, backgroundColor: '#000000', skipTaskbar: false,
      title: 'Drift', icon: path.join(__dirname, 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, webviewTag: true },       // the tag is for a web page watched together: see web.js
    });
    win.setMenuBarVisibility(false);
    web.host(win.webContents);
    win.on('app-command', (_e, c) => { if (c === 'browser-backward') web.nav(-1); else if (c === 'browser-forward') web.nav(1); });       // the mouse's side buttons
    if (process.env.DRIFT_MUTE) win.webContents.setAudioMuted(true);      // dev: silent runs
    const entry = { win, key: d.key, index: d.index, bounds: d.bounds, hdr: undefined };
    visWins.push(entry);
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.setBounds(d.bounds);
      if (FAKE <= 1 && !process.env.DRIFT_HIDDEN) win.setFullScreen(true);
      if (state.onTop) win.setAlwaysOnTop(true, 'screen-saver');
      if (!process.env.DRIFT_HIDDEN) win.show();        // dev: run without putting anything on screen
      if (d.key === refocusKey) win.focus();
    });
    win.on('close', (e) => {       // Alt+F4 and the like: ask first, the same as Esc and the ✕ button
      if (quitting || !visWins.includes(entry) || win.webContents.isCrashed() || Date.now() - (entry.askedAt || 0) < 5000) return;      // asked twice in a row (or the window is stuck): just close
      e.preventDefault(); entry.askedAt = Date.now();
      win.webContents.send('cmd', { type: 'ask-quit' });
    });
    win.on('closed', () => {
      if (visWins.includes(entry) && !quitting) { quitting = true; app.quit(); } // closing any live window exits
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(() => {});       // (a window replaced while it loads)
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
  if (prev && prev.autoUpdate !== state.autoUpdate && updater) updater.settingChanged();
  // always on top
  if (!prev || prev.onTop !== state.onTop) for (const v of visWins) if (!v.win.isDestroyed()) v.win.setAlwaysOnTop(!!state.onTop && !(webAway && v.key === web.info().key), 'screen-saver');       // (not over the PC's own browser)
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
  // monitors on/off
  if (prev && JSON.stringify(prev.displaysOff) !== JSON.stringify(state.displaysOff)) rebuildSoon();
}

const SCENES = ['aurora', 'nebula', 'silk', 'water', 'stars', 'lava', 'ridges', 'ripples', 'mandala', 'bokeh', 'lines',
  'sierpinski', 'sorting', 'life', 'maze', 'julia', 'hilbert', 'voronoi',
  'polyhedra', 'globe', 'tunnel', 'cubes', 'lattice', 'menger',
  'quasi', 'hyperbolic', 'apollonian', 'phyllotaxis', 'rose', 'chladni',
  'lake', 'pines', 'dunes', 'seaside', 'meadow', 'canyon'];
function stepScene(dir, shuffle, auto) {
  // automatic changes only pick the scenes ticked for rotation; Next / Previous still go through all of them
  const pool = auto ? SCENES.filter((id) => !state.cycleSkip.includes(id)) : SCENES;
  const next = (cur) => {
    if (auto && cur === 'video') return cur;   // auto-change never interrupts your video
    const others = pool.filter((id) => id !== cur);
    if (!others.length) return cur;
    if (shuffle) return others[Math.floor(Math.random() * others.length)];
    const i = SCENES.indexOf(cur);
    for (let k = 1; k <= SCENES.length; k++) {   // the next scene in order that's in the pool
      const n = SCENES[(((i + dir * k) % SCENES.length) + SCENES.length) % SCENES.length];
      if (n !== cur && pool.includes(n)) return n;
    }
    return cur;
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
  const replay = !!(p.video && p.video.paused === false && vEnded && state.video.paused);
  if (p.video && p.video.paused !== undefined && p.video.paused !== state.video.paused) {   // pause / resume the shared video timeline
    if (p.video.paused) vclock.pos = (Date.now() - vclock.startedAt) / 1000;
    else vclock.startedAt = Date.now() - vclock.pos * 1000;
  }
  if (p.scene === 'video' && state.scene !== 'video') state.prevScene = state.scene;
  for (const k of Object.keys(p)) {
    if (k === 'video') {
      const v = state.video = { ...state.video, ...p.video };
      delete v.layout;
      v.autoplay = v.autoplay !== false;
      if (!['auto', 'always', 'never'].includes(v.hdr)) v.hdr = 'auto';
      if (!['hable', 'mobius', 'reinhard'].includes(v.tone)) v.tone = 'hable';
      if (!/^[a-z0-9_]{1,24}$/.test(v.enc)) v.enc = 'auto';
      if (!['auto', '2160', '1440', '1080', '720', '480'].includes(String(v.xq))) v.xq = 'auto';
    }
    else if (k === 'share') { state.share = cleanShare({ ...state.share, ...(p.share || {}) }); p2p.setOptions({ wait: state.share.wait, name: shareName() }); if (chat && p.share && p.share.name !== undefined) chat.setName(shareName()); web.blockChanged(); }
    else if (k === 'music') {
      state.music = { ...state.music, ...p.music };
      if (p.music.nature) state.music.nature = { ...prev.music.nature, ...p.music.nature };
      if (!['generative', 'files', 'off'].includes(state.music.source)) state.music.source = prev.music.source;
    } else if (k === 'perDisplay') state.perDisplay = { ...state.perDisplay, ...p.perDisplay };
    else if (k === 'subs') {       // look only; which track is showing goes through the sub-* commands
      const q = p.subs || {}, t = state.subs;
      if (isFinite(q.size)) t.size = Math.max(0.5, Math.min(2.5, +q.size));
      if (/^#[0-9a-f]{6}$/i.test(q.color || '')) t.color = q.color.toLowerCase();
      if (['outline', 'box', 'shadow'].includes(q.bg)) t.bg = q.bg;
      if (isFinite(q.lift)) t.lift = Math.max(0, Math.min(70, +q.lift));
    }
    else if (k === 'customColors') { if (Array.isArray(p[k]) && p[k].length === 4 && p[k].every((c) => /^#[0-9a-f]{6}$/i.test(c))) state.customColors = p[k].map((c) => c.toLowerCase()); }
    else if (k === 'mode') { if (['span', 'mirror', 'mix'].includes(p[k])) state.mode = p[k]; }
    else if (k === 'surfMirror') state.surfMirror = !!p[k];
    else if (k === 'surfGpu') state.surfGpu = !!p[k];
    else if (k in DEFAULTS) state[k] = p[k];
  }
  if (allDisplays().every((d) => state.displaysOff.includes(d.index))) state.displaysOff = prev.displaysOff;
  // Settings' Mirror layout takes a page open in our own Surf along with it: Mirror shows it on every monitor, Span and Mix put it back on its own one
  if (prev.mode !== state.mode && !('surfMirror' in p) && !remote && web.info().open) state.surfMirror = state.mode === 'mirror';
  applySideEffects(prev);
  if (prev.surfGpu !== state.surfGpu) web.gpuChanged();       // the browser goes up again the other way
  else if (prev.surfMirror !== state.surfMirror) web.resized();       // the page's size follows the widest monitor it is on
  const pv = prev.video, nv = state.video;
  if (pv.enc !== nv.enc) encFallback = false;
  // anything that changes what the converted stream looks like, or who needs it, starts a new one
  if (cur() && (pv.hdr !== nv.hdr || pv.tone !== nv.tone || pv.enc !== nv.enc || pv.xq !== nv.xq || prev.share.quality !== state.share.quality
    || (xcActive() && prev.mode !== state.mode && nv.xq === 'auto'))) xcRestart();
  else pushState();
  if (replay) videoJump(0, true);
  saveSoon();
}

function setVideos(files, key, index = 0) {
  const c = cur(), shows = key && state.mode === 'mix' ? { [key]: 'video' } : null;
  if (!remote && c && c.path && files[index] === c.path && visWins.some((v) => showsVideo(v.key))) {      // already playing on a monitor: join it where it is
    const p = { video: { files, index } };
    if (shows) p.perDisplay = shows; else p.scene = 'video';
    if (state.music.source === 'files') p.music = { source: state.music.ambientOff ? 'off' : 'generative', playing: true };
    patch(p);
    return;
  }
  noteProgress();
  vEnded = false;
  videoFails = 0; xcFails = 0;
  const p = { video: { files, index, paused: false } };
  if (state.mode === 'mix' && key) p.perDisplay = { [key]: 'video' }; else p.scene = 'video';
  if (!remote && state.music.source === 'files') p.music = { source: state.music.ambientOff ? 'off' : 'generative', playing: true };      // a video or a song, not both
  startClock(files[index]);
  patch(p);
  probe();
}
// ---- video library ----
const isVideo = (name) => VIDEO_EXT.includes(path.extname(name).toLowerCase());
const isAudio = (name) => AUDIO_EXT.includes(path.extname(name).toLowerCase());
const libFolders = () => state.video.folders;       // one list of folders for videos and music
const libMatch = (kind) => (kind === 'audio' ? isAudio : kind === 'media' ? (n) => isVideo(n) || isAudio(n) : isVideo);
const inLib = (kind, p) => { const r = path.resolve(p); return libFolders(kind).some((f) => r === path.resolve(f) || r.startsWith(path.resolve(f) + path.sep)); };
const inLibrary = (p) => inLib('video', p);
const fileInfo = (full) => { let size = 0; try { size = fs.statSync(full).size; } catch { /* ignore */ } return { name: path.basename(full), path: full, url: pathToFileURL(full).href, size, kind: isVideo(full) ? 'video' : 'audio' }; };
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
  return { dir, name: path.basename(dir) || dir, parent: isRoot ? null : path.dirname(dir), dirs, videos };       // (for 'media', videos holds both: each says its kind)
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
// Music was put on: the scene and its visualizer come up in place of a video that is showing here.
function showVisualizer() {
  if (remote) return;       // a friend's video stays
  noteProgress();
  const back = state.prevScene && state.prevScene !== 'video' ? state.prevScene : 'aurora', p = {};
  if (state.scene === 'video') p.scene = back;
  const pd = Object.keys(state.perDisplay).filter((k) => state.perDisplay[k] === 'video');
  if (pd.length) p.perDisplay = Object.fromEntries(pd.map((k) => [k, back]));
  if (state.overlay === 'none') p.overlay = 'bars';
  if (Object.keys(p).length) patch(p);
}
function addTracks(paths) {
  if (!paths.length) return;
  showVisualizer();
  const had = state.music.playlist.length;
  const list = [...state.music.playlist];
  for (const p of paths) if (!list.includes(p)) list.push(p);
  patch({ music: { playlist: list, source: 'files', playing: true } });
  if (!had && audioWin) audioWin.webContents.send('cmd', { type: 'play-index', index: 0 });
}

ipcMain.handle('init', (e) => initFor(e.sender));
const libKind = (k) => (k === 'audio' || k === 'media' ? k : 'video');
ipcMain.handle('list-dir', (_e, dir, kind) => listDir(dir, libKind(kind)));
ipcMain.handle('search-lib', (_e, kind, root, q) => searchLib(libKind(kind), root, q));
ipcMain.on('patch', (_e, p) => patch(p || {}));
ipcMain.on('levels', (_e, l) => broadcast('levels', l, false));
ipcMain.on('now', (_e, n) => { nowPlaying = n; broadcast('now', n, false); p2p.sync(); });       // friends listening see the title too
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
    case 'update-check': if (updater) updater.check(); break;
    case 'update-download': if (updater) updater.download(); break;
    case 'update-page': if (updater) shell.openExternal(updater.info().page).catch(() => {}); break;
    case 'update-install': if (updater && updater.install(true)) { quitting = true; app.quit(); } break;
    case 'monitor-off': {      // from the "Close Drift?" prompt: leave this one monitor alone and keep Drift on the others
      const i = c.index | 0;
      if (state.displaysOff.includes(i) || activeDisplays().length < 2) break;
      patch({ displaysOff: [...state.displaysOff, i] });
      setTimeout(() => say(`Monitor ${i + 1} is off. Turn it back on in Settings.`), 2500);
      break;
    }
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
      const r = await dialog.showOpenDialog(parent, { title: 'Choose videos or music (pick several to play them in order)', properties: ['openFile', 'multiSelections'],
        defaultPath: app.getPath('videos'), filters: [{ name: 'Video and music', extensions: [...new Set([...VIDEO_EXT, ...AUDIO_EXT])].map((x) => x.slice(1)) }, { name: 'Video', extensions: VIDEO_EXT.map((x) => x.slice(1)) }, { name: 'Music', extensions: AUDIO_EXT.map((x) => x.slice(1)) }] });
      if (r.canceled || !r.filePaths.length) break;
      const vids = r.filePaths.filter(isVideo), songs = r.filePaths.filter((f) => !isVideo(f) && isAudio(f));
      if (vids.length) { if (remote) await p2p.stop(); setVideos(vids, c.key); }      // playing your own video leaves a friend's session
      else if (songs.length) {
        showVisualizer();
        patch({ music: { playlist: songs, source: 'files', playing: true } });
        if (audioWin && !audioWin.isDestroyed()) audioWin.webContents.send('cmd', { type: 'play-index', index: 0 });
      }
      break;
    }
    // ---- watch together ----
    case 'share-start':
      if (remote) await p2p.stop();
      liveHub = chat ? await shareHub(String(c.hub || '')) : '';
      p2p.share({ port: state.share.port, internet: state.share.internet, wait: state.share.wait, name: shareName(), local: !!process.env.DRIFT_SHARE_LOCAL });     // dev: stay on this PC
      break;
    case 'share-stop': p2p.stop(); break;
    case 'surf-forget':       // Settings: forget Surf's sign-ins, cookies and history (Drift's own settings stay)
      try { await web.forget(); say('Surf has forgotten its sign-ins, cookies and history'); } catch { say('Surf\'s data couldn\'t be cleared. Try again after restarting Drift.'); }
      break;
    case 'surf': {       // the browser: the Surf tab and the bar along the top of a page
      const k = (visWins.find((x) => x.win.webContents === e.sender) || {}).key, d = c.do, was = web.info().open;
      if (d === 'attached') web.attached(e.sender, +c.tab, +c.wc);
      else if (d === 'hide') { if (!remote) web.hide(); else if (streamShown) { streamShown = false; pushState(); } }
      else if (d === 'show' || d === 'move') {       // show: bring it back where it was; move: onto the screen that asked
        if (!remote) web.show(d === 'move' || !was ? k : '');
        else { if (d === 'move') streamKey = k || ''; streamShown = true; pushState(); }
      }
      else if (d === 'quit') { if (!remote) web.close(); }
      else if (d === 'outside') { if (!remote) web.outside(); }       // open the page in the PC's own browser
      else if (d === 'view') { if (k) web.viewer(e.sender, !!c.on && !remote); }       // this window starts or stops drawing the offscreen page
      else if (!SURF.includes(d)) break;
      else if (remote) {       // a friend's browser: ask their PC
        if (!remote.web) say('Leave your friend\'s session to open your own page');
        else if (!remote.ctrl) say(`Only ${p2p.info().host || 'the host'} can control the page`);
        else p2p.send({ t: 'cmd', a: 'surf', m: { do: d, text: String(c.text || '').slice(0, 2000), id: +c.id || 0, n: +c.n || 0 } });
      } else { const r = web.act(c, was ? web.info().key : k); if (r.error) say(r.error); }       // (the bar on a monitor mirroring the page steers it where it is)
      break;
    }
    case 'rtc': {       // setting up a web page's stream: with a friend, or (local) between the window holding the page and another monitor mirroring it
      if (!c.d || typeof c.d !== 'object') break;
      const to = String(c.to || '');
      if (c.local) {       // a mirroring window, to the one holding the page
        const k = (visWins.find((x) => x.win.webContents === e.sender) || {}).key, x = !remote && k && visWins.find((y) => y.key === web.info().key);
        if (x && x.key !== k && !x.win.isDestroyed()) x.win.webContents.send('cmd', { type: 'rtc', from: 'local:' + k, d: c.d });
      } else if (to.startsWith('local:')) {       // ...and back
        const x = visWins.find((y) => y.key === to.slice(6));
        if (x && !x.win.isDestroyed() && x.win.webContents !== e.sender) x.win.webContents.send('cmd', { type: 'rtc', local: true, d: c.d });
      } else if (to) p2p.sendTo(to, { t: 'rtc', d: c.d }); else if (remote) p2p.send({ t: 'rtc', d: c.d });
      break;
    }
    case 'share-music':       // play / pause / next / previous for a friend's music
      if (!remote || !remote.music || !['toggle', 'next', 'prev'].includes(c.do)) break;
      if (remote.ctrl) p2p.send({ t: 'cmd', a: 'music', do: c.do }); else say(`Only ${p2p.info().host || 'the host'} can control the music`);
      break;
    case 'web-ptr': if (remote && remote.web) p2p.send({ t: 'ptr', x: +c.x, y: +c.y }); break;       // where this PC's mouse is over a friend's web page
    case 'web-input':       // mouse and keyboard over a friend's web page, or over our own page mirrored on another monitor
      if (!c.e || typeof c.e !== 'object') break;
      if (remote) { if (remote.ctrl && remote.web) p2p.send({ t: 'cmd', a: 'input', e: c.e }); }
      else if (visWins.some((x) => x.win.webContents === e.sender && (x.key !== web.info().key ? state.surfMirror : web.info().gpu))) web.input(c.e, true);       // (the Surf monitor's own, when the page is drawn offscreen)
      break;
    case 'share-join': { joinedCode = String(c.code || ''); const r = await p2p.join(c.code, shareName()); if (!r.ok) say(r.error); break; }
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
    case 'play-tracks': {
      const files = (c.files || []).filter((f) => typeof f === 'string' && isAudio(f) && inLib('audio', f));
      if (!files.length) break;
      showVisualizer();
      patch({ music: { playlist: files, source: 'files', playing: true } });
      if (audioWin && !audioWin.isDestroyed()) audioWin.webContents.send('cmd', { type: 'play-index', index: Math.max(0, Math.min(files.length - 1, c.index | 0)) });
      break;
    }
    case 'show-viz': showVisualizer(); break;       // an Ambient preset or another music source was chosen
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
      const r = await dialog.showOpenDialog(parent, { title: 'Add a folder of videos or music', properties: ['openDirectory'], defaultPath: app.getPath('videos') });
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
      noteProgress();
      if (state.mode === 'mix') { const pd = { ...state.perDisplay }; pd[c.key] = state.prevScene || 'aurora'; state.perDisplay = pd; if (state.scene === 'video') state.scene = state.prevScene || 'aurora'; pushState(); saveSoon(); }
      else patch({ scene: state.prevScene && state.prevScene !== 'video' ? state.prevScene : 'aurora' });
      break;
    case 'video-next':   // sent by the leading monitor when a clip ends
      if (remote || c.index !== state.video.index) break;        // with a friend, their PC decides what comes next
      noteProgress(true);
      if (!state.video.autoplay) { if (!state.video.paused) { setPaused(true); vEnded = true; pushState(); } break; }     // autoplay off: stay on the last frame
      if (state.video.files.length < 2) { if (c.stream) videoJump(0); break; }      // a converted stream can't loop by itself
      videoFails = 0; xcFails = 0;
      state.video.index = (state.video.index + 1) % state.video.files.length;
      startClock(state.video.files[state.video.index]);
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
      patch({ music: { playlist: [], source: state.music.source === 'files' ? (state.music.ambientOff ? 'off' : 'generative') : state.music.source } });
      break;
    case 'reset': {
      const keep = state.music.playlist, folders = state.video.folders, name = state.share.name;
      await p2p.stop();
      state = JSON.parse(JSON.stringify(DEFAULTS)); state.music.playlist = keep; state.share.name = name; state.video.folders = folders; state.video.foldersInit = true; state.music.foldersInit = true;
      startSubs(cur(), subEmbedded);
      applySideEffects(null); pushState(); saveSoon(); rebuildSoon();
      break;
    }
    case 'video-strain': {       // the video's window: frames are coming late (more), or have been on time for a while
      if (Date.now() - strainAt < 1800) break;
      const was = strain;
      strain = Math.max(0, Math.min(STRAIN.length - 1, strain + (c.more ? 1 : -1)));
      if (strain !== was) { strainAt = Date.now(); pushState(); }
      break;
    }
    case 'tab-focus': {       // the panel tab a window is on: kept for a rebuild, and friends see how many are on each
      const v = visWins.find((x) => x.win.webContents === e.sender);
      if (v) tabOf[v.key] = String(c.tab || '').slice(0, 20);
      p2p.setTab(String(c.tab || ''));
      break;
    }       // the panel tab this PC is looking at: friends see how many are on each
    case 'next': case 'prev': case 'play-index': case 'music-seek':
      if (audioWin && !audioWin.isDestroyed()) audioWin.webContents.send('cmd', c);
      break;
    case 'music-pos':       // from the audio window: where the song is, for the panel's progress bar
      broadcast('cmd', { type: 'music-pos', t: +c.t || 0, d: +c.d || 0, path: String(c.path || '') }, false);
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
    { const c = cur(); if (c) startClock(c.path); }       // the video that was up carries on where it was
    setInterval(() => noteProgress(), 5000);
    if (!state.video.foldersInit) {
      for (const n of ['videos', 'music', 'downloads']) { try { const p = app.getPath(n); if (fs.existsSync(p) && !state.video.folders.includes(p)) state.video.folders.push(p); } catch { /* ignore */ } }
      state.video.foldersInit = true;
    }
    startLocalServer();
    startChat();
    // lets the audio engine listen to what the PC is playing (e.g. Spotify) so visuals can react to it; nothing is recorded
    // and lets the window holding a shared web page capture that page's picture and sound, to send to friends
    session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
      const from = req.frame ? webContents.fromFrame(req.frame) : null;
      if (from && visWins.some((v) => !v.win.isDestroyed() && v.win.webContents === from)) {
        const may = p2p.role() === 'host' || (!!state.surfMirror && !remote);       // for friends, or for this PC's other monitors
        const f = may ? web.frame(from) : null;
        const out = !f && may ? web.source(from) : null;
        if (out) {       // the page is open in the PC's own browser: its window, and the PC's sound (a window's own sound can't be picked out)
          desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }).then((src) => { const w = src.find((x) => x.id === out); cb(w ? { video: w, audio: 'loopback' } : {}); }).catch(() => cb({}));
          return;
        }
        cb(f ? { video: f, audio: f, enableLocalEcho: true } : {});       // without local echo, capturing the page's sound silences it on this PC
        return;
      }
      desktopCapturer.getSources({ types: ['screen'] }).then((src) => cb({ video: src[0], audio: 'loopback' })).catch(() => cb({}));
    });
    if (state.video.files.length) probe();
    setTimeout(() => xcoder.detect().then(() => pushState()), 1500);       // find out which encoders work here, off the start-up path
    clock = { base: 0, ref: Date.now() };
    createAudioWindow();
    buildWindows();
    if (state.surf && !SHOT_DIR) web.restore(state.surf);       // the browser that was open last time, its pages held paused
    applySideEffects(null);
    spotifyWatch(true);       // Drift follows Spotify by itself: see spotifyLead()
    const onDisplays = () => { if (displaySig() !== lastSig) rebuildSoon(); };   // ignore work-area-only changes
    screen.on('display-added', onDisplays);
    screen.on('display-removed', onDisplays);
    screen.on('display-metrics-changed', onDisplays);
    if (SHOT_DIR) runShots();
    updater = createUpdater({
      app, net, version: process.env.DRIFT_FAKE_VERSION || app.getVersion(),       // dev: pretend to be an older copy
      enabled: () => !SHOT_DIR || !!process.env.DRIFT_FAKE_VERSION,
      auto: () => state.autoUpdate,
      onChange: (u) => {
        if (u.status === 'ready' && updTold !== u.version) { updTold = u.version; say(`Drift ${u.version} is ready. It installs when you close Drift, or restart now from Settings`); }
        pushState();
      },
      onReadyDev: () => { if (updater.install(true)) { quitting = true; app.quit(); } },
      log: (m) => console.log(m),
    });
    updater.start();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    quitting = true;
    if ((p2p.role() !== 'off' || chat) && !goodbye) {       // tell friends, and close the door on the router, before going
      goodbye = true; e.preventDefault();
      Promise.all([p2p.stop().catch(() => {}), chat ? chat.stop().catch(() => {}) : null]).finally(() => app.quit());
      return;
    }
    if (updater) updater.install(false);       // a downloaded update goes in once Drift has closed
    spotifyWatch(false); spotifyVolWatch(false); xcoder.stopAll(); for (const k of audioKids) { try { k.kill(); } catch { /* gone */ } } noteProgress(); saveNow(); });
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
  const shotWait = +process.env.DRIFT_SHOTWAIT || 2600;
  for (const s of (only.length ? only : SCENES)) { patch({ scene: s }); await wait(shotWait); await snap(s); }
  const lv = lastLevels || {};
  log.push('levels(generative): ' + JSON.stringify(lv.l) + ' spec max=' + Math.max(...(lv.s || [0])) + ' bands>0=' + (lv.s || []).filter((x) => x > 0).length + ' wave range=' + Math.min(...(lv.w || [128])) + '..' + Math.max(...(lv.w || [128])) + ' beats=' + JSON.stringify(lv.b) + ' aclock=' + (lv.a || 0).toFixed(3) + ' beatsSoFar=' + beatCount);
  if (process.env.DRIFT_OVERLAY) {
    patch({ scene: 'lines', overlay: 'bars' }); await wait(2600); await snap('ov-bars');
    patch({ scene: 'aurora', overlay: 'wave', palette: 'cycle', cycleSecs: 10 }); await wait(2600); await snap('ov-wave');
    patch({ scene: 'nebula', overlay: 'halo', palette: 'aurora' }); await wait(2600); await snap('ov-halo');
    patch({ overlay: 'none', palette: 'aurora' });
  }
  if (process.env.DRIFT_TESTWAV) {
    const b0 = beatCount; addTracks([process.env.DRIFT_TESTWAV]); await wait(6000); beatCount -= b0;
    log.push('beats during file: ' + beatCount);
    log.push('levels(file): ' + JSON.stringify(lastLevels) + ' now=' + JSON.stringify(nowPlaying));
  }
  if (process.env.DRIFT_TESTVIDEO) {
    state.video.folders = [path.dirname(process.env.DRIFT_TESTVIDEO)];
    patch({ mode: 'span', video: { fit: 'auto' } });
    setVideos(listDir(path.dirname(process.env.DRIFT_TESTVIDEO)).videos.map((v) => v.path)); await wait(7000); await snap('video-span');
    log.push('videoAudio: ' + JSON.stringify(videoAudio));
    await snap('video-spanlayout'); patch({ mode: 'mirror', video: { fit: 'auto', sound: true } }); await wait(1500);
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
    state.video.folders = [dir]; patch({ scene: 'ridges', music: { source: 'files' } });
    visWins[0].win.webContents.send('cmd', { type: 'show-panel', tab: 'media' }); await wait(2500);
    log.push('listDir: ' + JSON.stringify(listDir(dir, 'media')).slice(0, 300));
    log.push('search: ' + searchLib('audio', dir, 'deep').map((x) => x.name).join(','));
    ipcMain.emit('cmd', { sender: visWins[0].win.webContents }, { type: 'play-tracks', files: listDir(dir, 'audio').videos.map((v) => v.path), index: 1 });
    await wait(2500); await snap('music-lib'); log.push('now=' + JSON.stringify(nowPlaying) + ' levels=' + JSON.stringify(lastLevels));
    log.push('spotify=' + JSON.stringify(spotify) + ' lead=' + spotifyLead());
    {       // choosing another folder moves the highlight with it, straight away
      const wc = visWins[0].win.webContents, other = app.getPath('temp');
      patch({ video: { folders: [dir, other] } }); await wait(1200);
      const look = () => wc.executeJavaScript("JSON.stringify({ lit: [...document.querySelectorAll('#vfolders .vf.active span')].map((x) => x.textContent), open: (document.querySelector('#vcrumb b') || {}).textContent })");
      log.push('folders before: ' + await look());
      await wc.executeJavaScript("document.querySelectorAll('#vfolders .vf span')[1].click()"); await wait(1200);
      log.push('folders after clicking the second: ' + await look());
      await wc.executeJavaScript("document.querySelectorAll('#vfolders .vf span')[0].click()"); await wait(1200);
      log.push('folders after clicking the first: ' + await look());
    }
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
  if (process.env.DRIFT_TESTCHAT) {     // the Together tab between two copies of Drift on one PC (DRIFT_USERDATA apart), pressing the real buttons: =host or =guest, DRIFT_TESTCODE = a file both can reach.
    // The host presses Share with no hub yet (one is made), the guest joins the hub with its invite, sees the Join card, joins the video, and they chat.
    const role = process.env.DRIFT_TESTCHAT, codeFile = process.env.DRIFT_TESTCODE, wc = visWins[0].win.webContents, js = (c) => wc.executeJavaScript(c);
    const hubs = () => chat.info().hubs, until = async (f, ms = 20000) => { for (let t = 0; t < ms && !f(); t += 250) await wait(250); return f(); };
    const dom = () => js(`JSON.stringify({ title: document.querySelector('#chTitle').textContent, sub: document.querySelector('#chSub').textContent, side: document.querySelector('#chHubs').innerText.replace(/\\n+/g, ' | '),
      lives: document.querySelector('#chLives').innerText.replace(/\\n+/g, ' | '), share: [document.querySelector('#shTitle').textContent, document.querySelector('#shGTitle').textContent].join(' / '),
      msgs: [...document.querySelectorAll('#chList .chMsg')].map((m) => m.innerText.replace(/\\n+/g, ' ')), imgs: document.querySelectorAll('#chList .chText img').length, faces: document.querySelectorAll('#chList .msgFace img').length, overlay: window.chatUI.overlay(), nomic: document.querySelectorAll('#chHubs .nomic').length, bold: document.querySelectorAll('#chList .chText b').length,
      links: [...document.querySelectorAll('#chList a')].map((a) => a.textContent), tabUnread: document.querySelector('.tabs button[data-tab=share]').classList.contains('unread') })`);
    patch({ music: { source: 'off' }, share: { internet: false, wait: false, name: role === 'host' ? 'Hosty' : 'Guesty' } });
    wc.send('cmd', { type: 'show-panel', tab: 'share' }); await wait(800);
    if (role === 'host') {
      if (process.env.DRIFT_TESTVIDEO) { setVideos([process.env.DRIFT_TESTVIDEO]); await wait(2500); }
      const pic = await js("(() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); g.fillStyle = '#e0457b'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#fff'; g.font = 'bold 80px sans-serif'; g.fillText('H', 34, 94); return c.toDataURL('image/webp', 0.8); })()");
      log.push('host: picture ' + JSON.stringify(chat.setAvatar(pic)));
      await js("document.querySelector('#shStart').click()");
      log.push('host: hub made and up ' + await until(() => hubs().some((h) => h.mine && h.status === 'connected')));
      log.push('host: sharing ' + await until(() => p2p.info().role === 'host' && !!p2p.info().code && !p2p.info().settling));
      const h = hubs().find((x) => x.mine);
      log.push('host: hub hears the share ' + await until(() => (hubs().find((x) => x.mine) || {}).lives?.length === 1) + ' ' + JSON.stringify((hubs().find((x) => x.mine) || {}).lives?.map((l) => [l.title, l.watching])));
      const inv = await chat.invite(h.id);
      fs.writeFileSync(codeFile, inv.code || ''); log.push('host: invite ' + (inv.code ? inv.code.length + ' chars' : inv.error));
      log.push('host: guest watching ' + await until(() => p2p.count() === 1, 40000));
      log.push('host: card says who watches ' + await until(() => (hubs().find((x) => x.mine) || {}).lives?.[0]?.watching?.includes('Guesty')));
      await wait(3000);
      await js("window.chatUI.send('Hi **Guesty**! Try https://example.com <img src=x onerror=alert(1)>')");
      await wait(6000);
      log.push('host sees: ' + await dom()); await snap('together-host');
      ipcMain.emit('cmd', { sender: wc }, { type: 'share-stop' });
      log.push('host: the card goes when sharing stops ' + await until(() => !(hubs().find((x) => x.mine) || {}).lives?.length));
      await wait(4000);
    } else {
      for (let i = 0; i < 80 && !(fs.existsSync(codeFile) && fs.readFileSync(codeFile, 'utf8')); i++) await wait(500);
      await js(`document.querySelector('#chCode').value = ${JSON.stringify(fs.readFileSync(codeFile, 'utf8'))}; document.querySelector('#chJoin').click()`);
      log.push('guest: joined the hub ' + await until(() => hubs().some((h) => h.status === 'connected')));
      log.push('guest: sees the card ' + await until(() => hubs().some((h) => (h.lives || []).length)));
      await wait(500); log.push('guest, before: ' + await dom());
      await js("[...document.querySelectorAll('#chLives button')].find((b) => b.textContent === 'Join').click()");
      log.push('guest: watching ' + await until(() => p2p.connected()));
      await js("document.querySelector('#panel').classList.remove('open')");       // watching, the panel away: messages come over the video
      log.push('guest: session hub ' + JSON.stringify({ chatHub: publicState().p2p.chatHub, joined: joinedCode.slice(0, 16), lives: hubs().map((h) => (h.lives || []).map((l) => l.code.slice(0, 16))), focused: (visWins.find((v) => v.win === BrowserWindow.getFocusedWindow()) || {}).key || 'none' }));
      const overlays = async () => (await Promise.all(visWins.map((v) => v.win.webContents.executeJavaScript('window.chatUI.overlay()')))).flat();       // (on whichever screen has focus)
      log.push('guest: the message comes over the video ' + await (async () => { for (let t = 0; t < 15000; t += 250) { if ((await overlays()).length > 0) return true; await wait(250); } return false; })());
      log.push('guest: overlay ' + JSON.stringify(await overlays()));
      await snap('together-overlay');
      log.push('guest: answers over the video ' + await js("window.chatUI.compose('typed over the video')"));
      await wait(1500);
      wc.send('cmd', { type: 'show-panel', tab: 'share' }); await wait(800);
      log.push('guest sees: ' + await dom());
      await js("window.chatUI.send('> quoted\\nhello back, `code` and ||secret||')");
      await wait(2500); log.push('guest after sending: ' + await dom()); await snap('together-guest');
      log.push('guest: the card goes when the host stops ' + await until(() => !hubs().some((h) => (h.lives || []).length), 30000));
      log.push('guest: session over ' + (p2p.role() === 'off'));
    }
  }
  if (process.env.DRIFT_TESTWEB) {     // exercise watching a web page together, the same way: =host or =guest, DRIFT_TESTCODE as above, DRIFT_TESTURL = the page. The host's page is streamed to the guest, whose mouse and keys go back
    const role = process.env.DRIFT_TESTWEB, codeFile = process.env.DRIFT_TESTCODE, wc = visWins[0].win.webContents, cmd = (c) => ipcMain.emit('cmd', { sender: wc }, c);
    const page = () => { const f = web.frame(wc); return f ? webContents.fromFrame(f) : null; };       // the tab in front
    const inPage = (code) => { const g = page(); return g ? Promise.race([g.executeJavaScript(code, true), wait(3000)]).catch((e) => 'error ' + e.message) : Promise.resolve('no page'); };
    const note = () => wc.executeJavaScript("document.querySelector('#nowName').textContent.slice(0, 140)").catch((e) => 'failed: ' + e.message);
    wc.on('render-process-gone', (_e, d) => log.push('web: the renderer of this window went: ' + JSON.stringify(d)));
    patch({ music: { source: 'off' }, share: { internet: false, wait: true, control: process.env.DRIFT_TESTCTRL !== 'off', quality: 'original', name: process.env.DRIFT_TESTNAME || (role === 'host' ? 'Hosty' : 'Guesty'), adblock: process.env.DRIFT_TESTADS !== 'off' } });
    if (role === 'host') {
      cmd({ type: 'share-start' }); await wait(1500);
      fs.writeFileSync(codeFile, p2p.info().code);
      cmd({ type: 'surf', do: 'go', text: process.env.DRIFT_TESTURL }); await wait(1000);
      for (let i = 0; i < 40 && !p2p.count(); i++) await wait(500);
      const tabsNow = () => { const w = web.info(); return `tabs=${w.tabs.map((t) => (t.id === w.active ? '*' : '') + t.title).join(' | ')} open=${w.open} sid=${w.sid} back=${w.back}`; };
      for (let i = 0; i < 27; i++) {       // what the guest's mouse and keyboard did to the page, then tabs and putting the browser away
        await wait(2000);
        log.push(`web host +${i * 2}s: ${JSON.stringify(await inPage('({ y: Math.round(scrollY), hash: location.hash, typed: (document.querySelector("input") || {}).value || "", keys: window.keys || "", q: location.host + location.search })'))} ${tabsNow()} note=${await note()}`);
        if (i === 4) ptrSet('host', shareName(), { x: 0.62, y: 0.44 });
        if (i === 5) { await snap('pointers'); log.push('pointers on the host: ' + await wc.executeJavaScript("JSON.stringify([...document.querySelectorAll('#ptrs .ptr')].map((q) => q.textContent + ' ' + q.style.left + ' ' + q.style.top))")); }
        if (i === 6) { wc.send('cmd', { type: 'show-panel', tab: 'music' }); await wait(1500); await snap('media-music'); wc.send('cmd', { type: 'show-panel', tab: 'video' }); await wait(1500); await snap('media-video'); log.push('media tab: ' + await wc.executeJavaScript("JSON.stringify({ tabs: [...document.querySelectorAll('.tabs button')].map((b) => b.textContent), section: document.querySelector('#content section.active').dataset.tab, tag: document.querySelector('#ctxTag').textContent })")); await wc.executeJavaScript("document.querySelector('#panel').classList.remove('open')"); }
        if (i === 9) { log.push('host goes to another site in the same tab'); cmd({ type: 'surf', do: 'go', text: process.env.DRIFT_TESTURL.replace('127.0.0.1', 'localhost') + '?other' }); }
        if (i === 11) { log.push('host opens a second tab'); cmd({ type: 'surf', do: 'new' }); cmd({ type: 'surf', do: 'go', text: process.env.DRIFT_TESTURL + '?two' }); }
        if (i === 12) { await wc.executeJavaScript("document.querySelector('#surfBar').classList.add('show')"); await wait(500); await snap('surf-bar'); wc.send('cmd', { type: 'show-panel', tab: 'surf' }); await wait(1200); await snap('surf-tab'); log.push('bar: ' + await wc.executeJavaScript("JSON.stringify({ tabs: [...document.querySelectorAll('#sbTabs .sbTab')].map((b) => b.textContent), url: document.querySelector('#sbUrl').value, views: document.querySelectorAll('webview').length, front: document.querySelectorAll('webview.on').length, vbar: getComputedStyle(document.querySelector('#vbar')).display })")); }
        if (i === 13) { log.push('host goes back to the first tab'); cmd({ type: 'surf', do: 'tab', id: web.info().tabs[0].id }); }
        if (i === 15) { log.push('host picks the Scenes tab'); await wc.executeJavaScript("document.querySelector('.tabs button[data-tab=scenes]').click()"); }
        if (i === 17) { log.push('host picks the Surf tab again'); await wc.executeJavaScript("document.querySelector('.tabs button[data-tab=surf]').click()"); }
        if (i === 18) { log.push('host goes to the second tab'); cmd({ type: 'surf', do: 'tab', id: web.info().tabs[1].id }); }
      }
      cmd({ type: 'surf', do: 'quit' }); await wait(1500); log.push('web host closed: page=' + !!page() + ' info=' + JSON.stringify(web.info()));
    } else {
      for (let i = 0; i < 80 && !fs.existsSync(codeFile); i++) await wait(500);
      await wait(600); cmd({ type: 'share-join', code: fs.readFileSync(codeFile, 'utf8') });
      await wait(1500); cmd({ type: 'surf', do: 'move' });       // on the monitor this test looks at
      // the picture that arrived: its size, whether it is moving, whether sound came with it, and the colour at the top left quarter
      const see = () => wc.executeJavaScript(`(() => { const v = document.querySelector('#webStream'); if (!v) return null; const c = document.createElement('canvas'); c.width = 64; c.height = 36; let px = null;
        try { const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36); px = [...g.getImageData(16, 5, 1, 1).data].slice(0, 3); } catch (e) { px = e.message; }
        return { size: v.videoWidth + 'x' + v.videoHeight, t: +v.currentTime.toFixed(1), sound: v.srcObject ? v.srcObject.getAudioTracks().length : 0, px, focus: document.activeElement === v }; })()`).catch((e) => 'failed: ' + e.message);
      const [W, H] = visWins[0].win.getContentSize(), at = (fx, fy) => ({ x: Math.round(W * fx), y: Math.round(H * fy) });
      const click = (fx, fy) => { const q = at(fx, fy); wc.sendInputEvent({ type: 'mouseMove', ...q }); wc.sendInputEvent({ type: 'mouseDown', ...q, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', ...q, button: 'left', clickCount: 1 }); };
      for (let i = 0; i < 26; i++) {
        await wait(2000); log.push(`web guest +${i * 2}s: ${JSON.stringify(await see())} tabs=${(publicState().web.tabs || []).map((t) => t.title).join(' | ')} note=${await note()}`);
        if (i === 2) { log.push('guest moves the mouse'); for (const [fx, fy] of [[0.3, 0.5], [0.34, 0.56], [0.38, 0.62]]) { wc.sendInputEvent({ type: 'mouseMove', ...at(fx, fy) }); await wait(120); } }
        if (i === 4) { await snap('pointers'); log.push('pointers on the guest: ' + await wc.executeJavaScript("JSON.stringify([...document.querySelectorAll('#ptrs .ptr')].map((q) => q.textContent + ' ' + q.style.left + ' ' + q.style.top))")); }
        if (i === 3) { log.push('guest turns the wheel'); wc.sendInputEvent({ type: 'mouseWheel', ...at(0.5, 0.6), deltaX: 0, deltaY: -400, canScroll: true }); }
        if (i === 5) { log.push('guest clicks the link'); click(0.25, 0.15); }
        if (i === 22) { log.push('guest uses the address bar'); cmd({ type: 'surf', do: 'go', text: process.env.DRIFT_TESTURL + '?guest' }); }
        if (i === 7) { log.push('guest clicks the box and types'); click(0.75, 0.1); await wait(500); for (const k of ['h', 'i', 'Enter']) { wc.sendInputEvent({ type: 'keyDown', keyCode: k }); if (k.length === 1) wc.sendInputEvent({ type: 'char', keyCode: k }); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); await wait(150); } }
      }
      await snap('web-guest');
      await wait(5000); log.push('web guest after host closed: ' + JSON.stringify(await see()) + ' note=' + await note());
    }
  }
  if (process.env.DRIFT_TESTSURF) {     // the README's Surf picture: a new tab on Drift's start page
    const wc = visWins[0].win.webContents;
    ipcMain.emit('cmd', { sender: wc }, { type: 'surf', do: 'new' }); await wait(5000);
    await wc.executeJavaScript("document.querySelector('#panel').classList.remove('open')"); await wait(800); await snap('surf-home');
  }
  if (process.env.DRIFT_TESTTUNE) {     // exercise listening to music together, the same way: =host or =guest, DRIFT_TESTCODE as above. The guest's own music is off, so any sound it reports came from the host
    const role = process.env.DRIFT_TESTTUNE, codeFile = process.env.DRIFT_TESTCODE, wc = visWins[0].win.webContents, cmd = (c) => ipcMain.emit('cmd', { sender: wc }, c);
    const heard = () => { const l = lastLevels || {}; lastLevels = null; return 'loudest band=' + Math.max(0, ...(l.s || [0])); };
    const ui = () => wc.executeJavaScript("JSON.stringify({ now: document.querySelector('#nowName').textContent, play: document.querySelector('#play').textContent, note: document.querySelector('#mShare').textContent.slice(0, 90) })").catch((e) => 'failed: ' + e.message);
    patch({ share: { internet: false, wait: true, control: true, quality: 'original', name: role === 'host' ? 'Hosty' : 'Guesty' } });
    wc.send('cmd', { type: 'show-panel', tab: 'music' });
    if (role === 'host') {
      patch({ music: { source: 'generative', preset: 'bells', playing: true, volume: 0.8 } });
      cmd({ type: 'share-start' }); await wait(1500);
      fs.writeFileSync(codeFile, p2p.info().code);
      for (let i = 0; i < 40 && !p2p.count(); i++) await wait(500);
      for (let i = 0; i < 13; i++) {
        await wait(2000); log.push(`tune host +${i * 2}s: playing=${state.music.playing} ${heard()} ui=${await ui()}`);
        if (i === 5) { log.push('host pauses the music'); patch({ music: { playing: false } }); }
      }
    } else {
      patch({ music: { source: 'off', playing: true, volume: 0.8 } });
      for (let i = 0; i < 80 && !fs.existsSync(codeFile); i++) await wait(500);
      await wait(600); cmd({ type: 'share-join', code: fs.readFileSync(codeFile, 'utf8') });
      for (let i = 0; i < 12; i++) {
        await wait(2000); log.push(`tune guest +${i * 2}s: theirs=${JSON.stringify(publicState().p2p.music)} ${heard()} ui=${await ui()}`);
        if (i === 8) { log.push('guest presses play'); await wc.executeJavaScript("document.querySelector('#play').click()"); }
      }
    }
  }
  if (process.env.DRIFT_TESTSHAREUI) {     // press the real buttons in the Together tab and read back what it says
    const wc = visWins[0].win.webContents, js = (c) => wc.executeJavaScript(c);
    const dump = async (tag) => log.push('shareui ' + tag + ': ' + await js("JSON.stringify({ off: getComputedStyle(document.querySelector('#shOff')).display, host: getComputedStyle(document.querySelector('#shHost')).display, title: document.querySelector('#shTitle').textContent, sub: document.querySelector('#shSub').textContent, note: document.querySelector('#shNote').textContent, lives: document.querySelector('#chLives').innerText, toast: document.querySelector('#toast').className + '|' + document.querySelector('#toast').textContent, tab: (document.querySelector('#content section.active') || {}).dataset && document.querySelector('#content section.active').dataset.tab })"));
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
  if (process.env.DRIFT_TESTAUTO) {      // a folder of short clips: autoplay off stops at the end and play starts over; on moves to the next
    const dir = path.resolve(process.env.DRIFT_TESTAUTO); state.video.folders = [dir]; const files = listDir(dir).videos.map((v) => v.path), st = () => `index=${state.video.index} paused=${state.video.paused} ended=${vEnded} pos=${vpos().toFixed(1)}`;
    patch({ video: { autoplay: false } }); setVideos(files); await wait(7000);
    log.push('autoplay off, after the end: ' + st());
    patch({ video: { paused: false } }); await wait(1500);
    log.push('autoplay off, after play: ' + st());
    patch({ video: { autoplay: true } }); await wait(6000);
    log.push('autoplay on, after the end: ' + st());
  }
  if (process.env.DRIFT_TESTJOIN) {      // a folder of clips 15 s or longer, with two monitors: a second monitor joins the video where it is, then is turned off from the exit prompt
    const dir = path.resolve(process.env.DRIFT_TESTJOIN); state.video.folders = [dir]; const files = listDir(dir).videos.map((v) => v.path);
    const [a, b] = visWins.map((v) => v.key), send = (w, c) => ipcMain.emit('cmd', { sender: visWins[w].win.webContents }, c);
    patch({ mode: 'mix', perDisplay: { [b]: 'aurora' } }); setVideos(files, a); await wait(6000);
    const before = vpos();
    send(1, { type: 'play-videos', files, index: 0, key: b }); await wait(1000);
    log.push(`join: before=${before.toFixed(1)} after=${vpos().toFixed(1)} second monitor shows video=${showsVideo(b)}`); await look('join');
    visWins[1].win.webContents.send('cmd', { type: 'ask-quit' }); await wait(800); await snap('monitor-off-ask');
    send(1, { type: 'monitor-off', index: 1 }); await wait(4000);
    log.push(`monitor off: windows=${visWins.length} off=${JSON.stringify(state.displaysOff)}`);
    patch({ displaysOff: [] }); await wait(3000);
  }
  if (process.env.DRIFT_TESTGUARD) {       // Surf's password guard: a page tries every usual way of showing a password as text
    const PAGE = `<!DOCTYPE html><body><form><input id="u" value="me"><input id="p" type="password" value="hunter2"><button type="button" id="eye" onclick="p.type = p.type === 'password' ? 'text' : 'password'">show</button></form>
      <input id="late"><div id="host"></div><iframe id="f" src="/frame"></iframe>
      <script>host.attachShadow({ mode: 'open' }).innerHTML = '<input id="sp" type="password" value="s3cret">';</script></body>`;
    const FRAME = '<!DOCTYPE html><input id="fp" type="password" value="framepw">';
    const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(q.url === '/frame' ? FRAME : PAGE); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`;
    web.act({ do: 'go', text: url }, visWins[0].key); await wait(5000);
    const page = webContents.getAllWebContents().find((w) => w.getURL() === url);
    if (!page) log.push('guard: the test page never loaded');
    else {
      const js = (code) => page.executeJavaScript(code);
      await js("document.querySelector('#eye').click()");                                     // a site's eye button
      await js("document.querySelector('#late').type = 'password'");                         // a box that becomes a password box later...
      await wait(100);
      await js("document.querySelector('#late').setAttribute('type', 'text')");              // ...and is turned back
      const sp = "document.querySelector('#host').shadowRoot.querySelector('#sp')";
      await js(`${sp}.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true })); ${sp}.type = 'text'`);       // inside a shadow root, once someone types in it
      await js("document.querySelector('#f').contentDocument.querySelector('#fp').type = 'text'");       // inside a frame
      await js("const n = document.createElement('input'); n.type = 'password'; n.id = 'dyn'; document.body.append(n); setTimeout(() => { n.type = 'text'; }, 50)");      // added by script
      await wait(400);
      log.push('guard: ' + await js(`JSON.stringify({ eye: p.type, late: late.type, shadow: ${sp}.type, frame: f.contentDocument.querySelector('#fp').type, added: dyn.type, plainStaysText: u.type, value: p.value })`));
    }
    srv.close(); web.close(); await wait(800);
  }
  if (process.env.DRIFT_TESTKEYS) {       // Surf's keyboard shortcuts, pressed in the page (with DRIFT_TESTGPU=1, over the offscreen page's picture)
    try {
    const gpuRun = !!process.env.DRIFT_TESTGPU;
    if (gpuRun) { patch({ surfGpu: true }); await wait(300); }
    const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(`<!DOCTYPE html><title>page ${q.url}</title><body>keys</body>`); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`, sw = visWins[0].win.webContents;
    web.act({ do: 'go', text: url + 'one' }, visWins[0].key); await wait(4000);
    const front = () => { const w = web.info(); return webContents.getAllWebContents().find((x) => x.getURL() === w.url); };
    const press = async (key, m = []) => {
      if (gpuRun) { web.input({ k: 'key', d: true, key, m }, true); web.input({ k: 'key', d: false, key, m }, true); }
      else { const pg = front(); if (pg) { pg.focus(); pg.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: m }); pg.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: m }); } }
      await wait(1500);
    };
    const tabs = () => { const w = web.info(); return w.tabs.map((t) => (t.id === w.active ? '*' : '') + t.title).join(' | '); };
    log.push(`keys (${gpuRun ? 'gpu' : 'webview'}) start: ${tabs()}`);
    await press('t', ['control']); log.push('Ctrl+T: ' + tabs());
    await press('Tab', ['control']); log.push('Ctrl+Tab: ' + tabs());
    await press('2', ['control']); log.push('Ctrl+2: ' + tabs());
    await press('w', ['control']); log.push('Ctrl+W: ' + tabs());
    web.act({ do: 'go', text: url + 'two' }); await wait(2500);
    await press('t', ['control']); web.act({ do: 'go', text: url + 'three' }); await wait(2500); await press('w', ['control']); log.push('Ctrl+T, to /three, Ctrl+W: ' + tabs());
    await press('t', ['control', 'shift']); await wait(1500); log.push('Ctrl+Shift+T: ' + tabs());
    await press('=', ['control']); await press('=', ['control']); log.push('Ctrl+= twice: zoom ' + (front() && front().getZoomFactor()));
    await press('0', ['control']); log.push('Ctrl+0: zoom ' + (front() && front().getZoomFactor()));
    if (!gpuRun) { await press('l', ['control']); log.push('Ctrl+L: focus in ' + await sw.executeJavaScript('document.activeElement.id')); }
    if (gpuRun) {
      const pw = front() && BrowserWindow.fromWebContents(front()), hb = visWins[0].win.getBounds();
      log.push(`offscreen window: onTop=${pw && pw.isAlwaysOnTop()} visible=${pw && pw.isVisible()} at ${pw && JSON.stringify(pw.getBounds())}, Surf monitor at ${JSON.stringify(hb)}`);
      patch({ surfGpu: false }); await wait(1000);
    }
    srv.close(); web.close(); await wait(800);
    } catch (e) { log.push('keys test failed: ' + (e && e.stack || e)); web.close(); }
  }
  if (process.env.DRIFT_TESTMIRROR && visWins.length > 1) {       // Surf mirrored on the other monitors (run with DRIFT_FAKE_DISPLAYS=2): the picture arrives, and a click there reaches the page. With DRIFT_TESTGPU=1, drawn offscreen
    try {
    const gpuRun = !!process.env.DRIFT_TESTGPU;
    if (gpuRun) { patch({ surfGpu: true }); await wait(300); }
    const PAGE = `<!DOCTYPE html><title>clicks 0</title><body style="margin:0;height:100vh;background:#e33" onclick="if (event.target === document.body) { document.title = 'clicks ' + (+document.title.split(' ')[1] + 1); document.body.style.background = '#3e3'; }">
      <input id="i" style="position:absolute;left:20px;top:20px;width:300px;height:30px"><select id="s" style="position:absolute;left:20px;top:80px;width:200px;height:30px"><option>one</option><option>two</option><option>three</option></select>
      <a id="a" href="#x" style="position:absolute;left:20px;top:140px;font-size:30px">a link</a>
      <script>window.hits = []; addEventListener('click', (e) => hits.push(e.target.tagName + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY)), true);</script></body>`;
    const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(PAGE); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`, sw = visWins[0].win.webContents, mw = visWins[1].win.webContents;
    web.act({ do: 'go', text: url }, visWins[0].key); await wait(4000);
    const page = () => webContents.getAllWebContents().find((w) => w.getURL().startsWith(url));
    // what a window shows of the page: its mirror <video> or offscreen canvas, and the colour in the middle of it
    const see = (wc) => wc.executeJavaScript(`(() => { const v = document.querySelector('#webMirror') || document.querySelector('#webGpu'), bar = document.body.classList.contains('surfing'), views = document.querySelectorAll('webview').length;
      if (!v) return { shows: 'nothing', bar, views };
      const vw = v.videoWidth || +v.dataset.fw || 0, vh = v.videoHeight || +v.dataset.fh || 0, c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d');
      let px = null; if (vw) { if (v.tagName === 'VIDEO') g.drawImage(v, vw / 2, vh / 2, 1, 1, 0, 0, 1, 1); else g.drawImage(v, v.width / 2, v.height * 0.75, 1, 1, 0, 0, 1, 1); px = [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); }
      return { shows: v.id, size: vw + 'x' + vh, px, bar, views, cursor: v.style.cursor || '' }; })()`);
    // a mouse or key event on the window's picture of the page, at page position (x, y) given as fractions
    const poke = (wc, js) => wc.executeJavaScript(`(() => { const v = document.querySelector('#webMirror') || document.querySelector('#webGpu'); if (!v) return false;
      const r = v.getBoundingClientRect(), vw = v.videoWidth || +v.dataset.fw, vh = v.videoHeight || +v.dataset.fh, k = Math.min(r.width / vw, r.height / vh), pw = vw * k, ph = vh * k;
      const at = (x, y) => ({ clientX: r.left + (r.width - pw) / 2 + x * pw, clientY: r.top + (r.height - ph) / 2 + y * ph, button: 0, detail: 1, bubbles: true });
      const click = (x, y) => { v.dispatchEvent(new MouseEvent('mousedown', at(x, y))); v.dispatchEvent(new MouseEvent('mouseup', at(x, y))); };
      const move = (x, y) => v.dispatchEvent(new MouseEvent('mousemove', at(x, y)));
      const type = (s) => { for (const ch of s) { v.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true })); v.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true })); } };
      ${js}; return true; })()`);
    const pageSays = async () => { const p = page(); return p ? p.executeJavaScript("JSON.stringify({ title: document.title, typed: document.querySelector('#i').value, picked: document.querySelector('#s').value })") : 'no page'; };
    log.push(`mode=${gpuRun ? 'gpu' : 'webview'} info.gpu=${web.info().gpu}`);
    log.push('surf monitor: ' + JSON.stringify(await see(sw)) + ' mirror monitor (off): ' + JSON.stringify(await see(mw)));
    patch({ surfMirror: true }); await wait(4000);
    log.push('mirror on: ' + JSON.stringify(await see(mw)) + ' page=' + await pageSays());
    {       // the page takes the widest monitor's size; the narrower Surf monitor shows it whole with black bars, and a real click there lands where it should
      const size = () => page().executeJavaScript('innerWidth + "x" + innerHeight + "@" + devicePixelRatio');
      const img = (await sw.capturePage()).toBitmap(), [W, H] = sw.getOwnerBrowserWindow().getContentSize(), px = (x, y) => { const i = (y * W + x) * 4; return [img[i + 2], img[i + 1], img[i]]; };
      log.push(`page size with mirroring: ${await size()} (monitors ${visWins.map((v) => v.win.getContentSize().join('x')).join(', ')}); surf monitor corner=${px(4, 4)} middle=${px(W >> 1, H >> 1)}`);
      const box = await sw.executeJavaScript(`(() => { const v = document.querySelector('webview.on') || document.querySelector('#webGpu'); const r = v.getBoundingClientRect();
        const pw = v.tagName === 'CANVAS' ? +v.dataset.fw : r.width, ph = v.tagName === 'CANVAS' ? +v.dataset.fh : r.height, k = Math.min(r.width / pw, r.height / ph);
        return { l: r.left + (r.width - pw * k) / 2, t: r.top + (r.height - ph * k) / 2, w: pw * k, h: ph * k }; })()`);
      const [pw] = (await size()).split('x').map(parseFloat), k = box.w / pw, x = Math.round(box.l + 100 * k), y = Math.round(box.t + 35 * k);
      if (gpuRun) {       // (a click sent to a Drift window never reaches a <webview> in it, so this is checked with the page drawn offscreen only)
        await page().executeJavaScript('hits.length = 0');
        sw.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); sw.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await wait(800);
        log.push(`real click on the surf monitor at ${x},${y}: page saw ${await page().executeJavaScript('hits.join(" ")')}`);
      }
      patch({ surfMirror: false }); await wait(2000);
      log.push(`page size without mirroring: ${await size()}`);
      patch({ surfMirror: true }); await wait(3000);
    }
    await snap(gpuRun ? 'mirror-gpu' : 'mirror-on');
    await poke(mw, 'click(0.5, 0.75)'); await wait(1500);
    log.push('after a click on the mirror: ' + JSON.stringify(await see(mw)) + ' page=' + await pageSays());
    if (gpuRun) {       // the Surf monitor itself is a picture of the offscreen page too: typing, a dropdown, the pointer over a link
      const [W, H] = (await page().executeJavaScript('[innerWidth, innerHeight]'));       // (positions below are fractions of the page)
      await poke(sw, `click(100 / ${W}, 35 / ${H}); type('hi!')`); await wait(800);
      await poke(sw, `click(100 / ${W}, 95 / ${H})`); await wait(800);
      const open = await page().executeJavaScript("(() => { const h = document.body.lastElementChild; return !!h && h.tagName === 'DIV' && h.style.zIndex === '2147483647'; })()");
      await snap('mirror-gpu-select');
      await poke(sw, `click(100 / ${W}, (110 + 26 + 13) / ${H})`); await wait(800);       // the list's second row, under the box
      await poke(sw, `move(50 / ${W}, 155 / ${H})`); await wait(800);
      log.push(`surf monitor: dropdown list shown=${open} page=${await pageSays()} pointer over the link=${(await see(sw)).cursor}`);
      log.push('clicks the page saw: ' + await page().executeJavaScript('hits.join(" ")'));
    }
    ipcMain.emit('cmd', { sender: mw }, { type: 'surf', do: 'new' }); await wait(4000);       // a new tab, from the mirror's bar: it opens where the browser is, and the mirror follows it
    log.push('new tab from the mirror: browser on ' + web.info().key + ', tabs=' + web.info().tabs.length + ' ' + JSON.stringify(await see(mw)));
    { const f = web.frame(sw), pg = f && webContents.fromFrame(f); log.push('new tab (made while mirroring) size: ' + (pg ? await pg.executeJavaScript('innerWidth + "x" + innerHeight') : 'no page')); }
    patch({ surfMirror: false }); await wait(1500);
    log.push('mirror stopped: ' + JSON.stringify(await see(mw)) + ' surf monitor: ' + JSON.stringify(await see(sw)));
    const layout = (v) => mw.executeJavaScript(`document.querySelector('#mode [data-v=${v}]').click()`);       // Settings' Span / Mirror / Mix buttons
    await layout('mirror'); await wait(3000);
    log.push(`layout Mirror: surfMirror=${state.surfMirror} mirror monitor: ${JSON.stringify(await see(mw))}`);
    await layout('span'); await wait(1500);
    log.push(`layout Span: surfMirror=${state.surfMirror} mirror monitor: ${JSON.stringify(await see(mw))}`);
    if (gpuRun) { patch({ surfGpu: false }); await wait(3000); log.push('setting off again: info.gpu=' + web.info().gpu + ' surf monitor: ' + JSON.stringify(await see(sw))); }
    srv.close(); web.close(); await wait(800);
    } catch (e) { log.push('mirror test failed: ' + (e && e.stack || e)); web.close(); }
  }
  if (process.env.DRIFT_TESTREFOCUS && visWins.length > 1) {       // turning a monitor off and on: each screen keeps its tab, Surf included
    const tabs = () => Promise.all(visWins.map(async (v) => `${v.key}=${await v.win.webContents.executeJavaScript("document.querySelector('.tabs button.active').dataset.tab + (document.querySelectorAll('webview.web').length ? '+browser' : '')")}`));
    if (!process.env.DRIFT_REFOCUS_NOSURF) await visWins[0].win.webContents.executeJavaScript("document.querySelector('.tabs button[data-tab=surf]').click()");
    await visWins[1].win.webContents.executeJavaScript("document.querySelector('.tabs button[data-tab=settings]').click()");
    await wait(3000); log.push('refocus before: ' + (await tabs()).join(' '));
    patch({ displaysOff: [1] }); await wait(5000); log.push('refocus monitor 2 off: ' + (await tabs()).join(' '));
    patch({ displaysOff: [] }); await wait(5000); log.push('refocus monitor 2 on: ' + (await tabs()).join(' '));
    await snap('refocus');
    patch({ displaysOff: [0] }); await wait(5000); log.push('refocus monitor 1 off (browser moves): ' + (await tabs()).join(' ') + ' web=' + web.info().key);
    patch({ displaysOff: [] }); await wait(5000);
  }
  if (process.env.DRIFT_PANEL) {
    log.push('spotify: ' + JSON.stringify(publicState().spotify) + ' toolbar: ' + await visWins[0].win.webContents.executeJavaScript("document.querySelector('#ctxTag').textContent + ' | ' + document.querySelector('#nowName').textContent"));
    for (const tab of ['scenes', 'media', 'settings']) { visWins[0].win.webContents.send('cmd', { type: 'show-panel', tab }); await wait(tab === 'scenes' || tab === 'media' ? 6000 : 1500); await snap('panel-' + tab);
      if (tab === 'settings') log.push('updates: ' + await visWins[0].win.webContents.executeJavaScript("JSON.stringify({ shown: getComputedStyle(document.querySelector('#updRow')).display, button: document.querySelector('#updBtn').textContent, note: document.querySelector('#updNote').textContent, auto: document.querySelector('#autoUpdate').checked })"));
      if (tab === 'scenes') { await visWins[0].win.webContents.executeJavaScript("document.querySelector('#presets').scrollIntoView({ block: 'center' })"); await wait(1500); log.push('ambient: ' + await visWins[0].win.webContents.executeJavaScript("JSON.stringify({ top: document.querySelector('#content').scrollTop, presets: [...document.querySelectorAll('.preset')].map((b) => b.textContent + (b.classList.contains('active') ? '*' : '')) })")); await snap('panel-scenes-ambient'); } }
    await visWins[0].win.webContents.executeJavaScript("document.querySelector('.tabs button[data-tab=surf]').click()"); await wait(5000); await snap('panel-surf');       // Surf: the browser opens on Drift's start page
    log.push('surf: ' + JSON.stringify(web.info()));
    {       // Settings' "Forget Surf's sign-ins and history": a cookie set in Surf is gone after two clicks, and so is the browser
      const ws = session.fromPartition('persist:web'), wc = visWins[0].win.webContents;
      await ws.cookies.set({ url: 'https://example.com', name: 'drifttest', value: '1', expirationDate: Date.now() / 1000 + 3600 });
      const before = (await ws.cookies.get({})).length;
      await wc.executeJavaScript("document.querySelector('.tabs button[data-tab=settings]').click(); document.querySelector('#content').scrollTop = 1e5"); await wait(800);
      await wc.executeJavaScript("document.querySelector('#forgetSurf').click()"); await wait(300);
      const asked = await wc.executeJavaScript("document.querySelector('#forgetSurf').textContent");
      log.push('settings dom: ' + await wc.executeJavaScript("JSON.stringify({ active: document.querySelector('.tabs button.active').dataset.tab, open: document.querySelector('#panel').className, section: (document.querySelector('#content section.active') || {}).dataset, btnVisible: !!document.querySelector('#forgetSurf').offsetParent })"));
      await snap('forget-ask');
      await wc.executeJavaScript("document.querySelector('#forgetSurf').click()"); await wait(1500);
      log.push(`forget: cookies ${before} -> ${(await ws.cookies.get({})).length}, asked="${asked}", browser open=${web.info().open} tabs=${web.info().tabs.length}`);
    }
  }
  if (process.env.DRIFT_TESTBLOCK) {       // the advert blocker (uBlock Origin) in Surf, and the Sec-CH-UA headers beside it. With DRIFT_TESTGPU=1, drawn offscreen; =ytquit quits with YouTube still open
    const tl = (x) => { log.push(x); console.log('[test] ' + x); };       // (also printed: a crash leaves no log.txt)
    try {
      const gpuRun = !!process.env.DRIFT_TESTGPU;
      patch({ surfGpu: gpuRun, share: { adblock: true } }); await wait(300);
      const srv = http.createServer((q, r) => {       // shows the headers it was sent, and asks for the detailed hints
        r.writeHead(200, { 'Content-Type': 'text/html', 'Accept-CH': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version' });
        r.end(`<!DOCTYPE html><title>hints</title><pre id="h">${JSON.stringify(Object.fromEntries(Object.entries(q.headers).filter(([k]) => k.startsWith('sec-ch-ua')))).replace(/</g, '&lt;')}</pre>`);
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const ws = session.fromPartition('persist:web');
      const page = (host) => webContents.getAllWebContents().find((x) => !x.isDestroyed() && x.session === ws && x.getType() !== 'backgroundPage' && x.getURL().includes(host));
      const probe = `JSON.stringify({
        ytAds: typeof ytInitialPlayerResponse === 'undefined' ? 'n/a' : !!(ytInitialPlayerResponse && (ytInitialPlayerResponse.adPlacements || ytInitialPlayerResponse.playerAds)),
        iframes: document.querySelectorAll('iframe').length, sheets: document.adoptedStyleSheets.length,
        adEls: [...document.querySelectorAll('[id*=google_ads], ins.adsbygoogle, [data-ad-slot], [id^=div-gpt-ad], ytd-ad-slot-renderer')].filter((e) => e.offsetHeight > 0).length })`;
      const visit = async (what, u, host, ms = 12000) => {
        const t0 = Date.now();
        web.act({ do: 'go', text: u }, visWins[0].key); await wait(ms);
        const p = page(host);
        tl(`block ${what}: ${p ? await p.executeJavaScript(probe).catch((e) => e.message) : 'page not found'} (${Date.now() - t0}ms)`);
      };
      const exts = () => (ws.extensions || ws).getAllExtensions().map((e) => e.name).join(', ');
      tl(`block (${gpuRun ? 'gpu' : 'webview'}) start`);
      await visit('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube.com', 25000);       // (the first time, uBO is downloaded first)
      tl('block extensions: ' + exts());
      await visit('news', 'https://www.theverge.com/', 'theverge.com');
      const hu = `http://127.0.0.1:${srv.address().port}/hints`;
      web.act({ do: 'go', text: hu }); await wait(2500); web.act({ do: 'reload' }); await wait(2500);       // (the detailed ones come on the second visit)
      const hp = page('127.0.0.1');
      tl('block hints: ' + (hp ? await hp.executeJavaScript("document.querySelector('#h').textContent").catch((e) => e.message) : 'page not found'));
      patch({ share: { adblock: false } }); await wait(500);
      await visit('youtube, blocking off', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube.com');
      tl('block extensions, blocking off (uBO stays loaded, everything trusted): ' + exts());
      patch({ share: { adblock: true } }); await wait(500);
      await visit('youtube, blocking on again', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube.com');
      await snap('block-youtube');
      if (process.env.DRIFT_TESTBLOCK === 'ytquit') { tl('quitting with the page open'); fs.writeFileSync(path.join(SHOT_DIR, 'log.txt'), log.join('\n')); quitting = true; app.quit(); return; }
      srv.close(); web.close(); await wait(800); patch({ surfGpu: false }); await wait(800);
    } catch (e) { tl('block test failed: ' + (e && e.stack || e)); web.close(); }
  }
  fs.writeFileSync(path.join(SHOT_DIR, 'log.txt'), log.join('\n'));
  quitting = true; app.quit();
}
