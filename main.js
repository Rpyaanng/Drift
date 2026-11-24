// Drift — main process: one fullscreen window per monitor, shared state, hidden audio engine window.
const { app, BrowserWindow, ipcMain, screen, dialog, powerSaveBlocker, shell, session, desktopCapturer, net, clipboard, webContents, protocol, safeStorage, Tray, Menu, nativeImage } = require('electron');
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
protocol.registerSchemesAsPrivileged([{ scheme: 'drift', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);       // drift://home/, the Surf tab's own start page: see web.js
// Surf's extensions (surf-net, uBlock Origin) are Manifest V2 on purpose: they need blocking webRequest, which V3 lacks.
// Electron warns about that every time one loads, and the warning's link gets printed (and, from some terminals, opened in
// the PC's browser). That warning alone is dropped; any other warning loading an extension still shows.
const emitWarning = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const m = String((w && w.message) || w);
  if (/^Warnings loading extension at /.test(m) && m.split('\n').slice(1).every((l) => !l.trim() || /Manifest version 2 is deprecated/.test(l))) return;
  return emitWarning.call(this, w, ...rest);
};

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
  cat: false,              // cats sit in the chat overlay, each hopping to a different screen every few minutes
  catsUnlocked: false,     // typing "meow" in Settings: Summon the cat becomes Summon the cats, and the number can be set
  catCount: 3,             // how many, once unlocked (one before)
  keepAwake: true,
  onTop: false,
  surfMirror: false,       // the Surf page shows on every other monitor too (see "mirroring" in renderer/app.js)
  surfGpu: false,          // Surf's pages are drawn offscreen and handed to the windows as textures on the graphics card (see web.js)
  // the volume mixer (the toolbar's speaker): master scales all of Drift's own sound (ambient, media, Surf, voices); surf is the
  // browser's pages; the mutes are its icons. Its Ambient level (generated music and nature sounds) is music.volume, its Media
  // level (videos, and music from the Media tab) video.volume.
  mixer: { master: 1, mute: false, surf: 1, surfMute: false, ambientMute: false, mediaMute: false },
  ambientYields: true,     // the generated music pauses while a video or a Surf page plays sound (Settings), and carries on underneath when off
  autoUpdate: false,       // download a new release by itself and install it when Drift closes (new releases are looked for either way)
  sleepAt: 0,
  // hdr: auto = convert HDR videos to SDR on screens that aren't showing HDR | always | never; tone = how bright highlights are squeezed in;
  // enc = which ffmpeg encoder converts (auto = the fastest that works on this PC); xq = picture height of converted video (auto = the screen's)
  video: { files: [], index: 0, fit: 'auto', paused: false, sound: true, autoplay: true, volume: 0.8, folders: [], foldersInit: false,
    hdr: 'auto', tone: 'hable', enc: 'auto', xq: 'auto', progress: {} },
  // watch together: internet = ask the router to let friends outside the home in; control = friends may play / pause / seek;
  // wait = pause for everyone while someone is loading; quality = picture size sent to (and asked from) friends
  share: { name: '', internet: true, control: true, wait: true, quality: 'original', port: 47800, adblock: true, overlay: 'all' },       // overlay: whose chat messages go over what you're watching (all / unheard / off)
  // voice: direct = connect straight to the others (lower delay, but they see this PC's address) instead of through the
  // hub's relay; ptt = hold a key to talk (pttKey, see VOICE_KEYS); talk = your microphone is open (closed at every start
  // unless keepMic); deaf = out of the voice room (set at every start; Join voice clears it); pin = the hub whose voice room you stay in ('' = whichever is open in
  // the Hub tab); volumes = each person's volume, by member id
  voice: { direct: false, ptt: false, pttKey: 'backquote', talk: false, keepMic: false, deaf: false, pin: '', volumes: {} },
  // broadcast (docs/plans/broadcast.md §5): quality = auto | detail (text and detail) | motion (smooth); pointers = show
  // viewers' pointers on this screen while live
  broadcast: { quality: 'auto', pointers: true, sound: false },
  // Hub sounds (renderer/sfx.js): on, and how loud (under the mixer's master)
  sfx: { on: true, volume: 0.7 },
  // GIF search in the Hub tab: the user's own GIPHY API key ('' = search is off; pictures from this PC still send)
  gif: { key: '' },
  // the Surf stream of the hub this PC hosts (docs/plans/streams.md): its tabs (kept with the hub they belong to), whether every
  // download on it is refused, the local addresses it may open (surf-lan.js), and whether the host was told pages load from their connection
  hubSurf: { hub: '', urls: [], active: 0, noDownloads: false, allowLan: [], told: false, showSpecs: false, showBrowsing: false },
  // subtitles: on = show them when a video has some; perFile remembers the track and timing chosen for each video
  subs: { on: true, lang: 'en', size: 1, color: '#ffffff', bg: 'outline', lift: 0, perFile: {} },
  prevScene: 'aurora',
  frozen: false,           // scene animation paused
  settingsVersion: 7,
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
    state.voice = cleanVoice({ ...DEFAULTS.voice, ...(s.voice || {}) });
    state.broadcast = cleanBroadcast({ ...DEFAULTS.broadcast, ...(s.broadcast || {}) });
    state.sfx = cleanSfx({ ...DEFAULTS.sfx, ...(s.sfx && typeof s.sfx === 'object' ? s.sfx : {}) });
    state.gif = cleanGif(s.gif);
    state.hubSurf = cleanHubSurf({ ...DEFAULTS.hubSurf, ...(s.hubSurf && typeof s.hubSurf === 'object' ? s.hubSurf : {}) });
    if (!state.voice.keepMic) state.voice.talk = false;       // nobody is ever live by surprise: the microphone starts closed
    state.voice.deaf = true;       // and nobody is in a voice room by surprise either: Join voice puts you in
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
    if ((s.settingsVersion || 1) < 7 && state.share.overlay === 'unheard') state.share.overlay = 'all';       // typed messages from people in the call go over the video too now (hiding them read as broken)
    if (!['generative', 'files', 'off'].includes(state.music.source)) state.music.source = 'off';
    state.settingsVersion = 7;
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
    state.mixer = cleanMixer({ ...DEFAULTS.mixer, ...(state.mixer && typeof state.mixer === 'object' ? state.mixer : {}) });
  } catch { /* first run */ }
}
const QUALITY = { original: { h: 0, kbps: 0 }, 1080: { h: 1080, kbps: 6000 }, 720: { h: 720, kbps: 3000 }, 480: { h: 480, kbps: 1200 } };
function cleanShare(q) {
  return { name: String(q.name || '').replace(/[\x00-\x1f<>]/g, '').slice(0, 24), internet: !!q.internet, control: !!q.control, wait: !!q.wait, adblock: !!q.adblock,
    quality: QUALITY[q.quality] ? String(q.quality) : 'original', overlay: ['unheard', 'all', 'off'].includes(q.overlay) ? q.overlay : 'all', port: q.port >= 1024 && q.port <= 65535 ? Math.round(q.port) : DEFAULTS.share.port };
}
const VOICE_KEYS = { backquote: 0xc0, rctrl: 0xa3, mouse4: 0x05, mouse5: 0x06 };       // hold-to-talk keys, as Windows virtual-key codes
function cleanVoice(q) {
  const vols = Object.entries(q.volumes && typeof q.volumes === 'object' ? q.volumes : {}).filter(([id, v]) => /^(bc:)?[A-Za-z0-9_-]{6,20}$/.test(id) && isFinite(v)).slice(-200);
  return { direct: !!q.direct, ptt: !!q.ptt, pttKey: Object.hasOwn(VOICE_KEYS, q.pttKey) ? q.pttKey : 'backquote', talk: !!q.talk, keepMic: !!q.keepMic, deaf: !!q.deaf,
    pin: /^[A-Za-z0-9_-]{20,64}$/.test(String(q.pin || '')) ? String(q.pin) : '',
    volumes: Object.fromEntries(vols.map(([id, v]) => [id, Math.max(0, Math.min(1, +v))])) };
}
const cleanSfx = (q) => ({ on: q.on !== false, volume: unitVol(q.volume, 0.7) });
const cleanGif = (q) => ({ key: String((q && q.key) || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 64) });
const unitVol = (v, d) => (isFinite(v) && v !== null && v !== '' ? Math.max(0, Math.min(1, +v)) : d);
const cleanMixer = (q) => ({ master: unitVol(q.master, 1), mute: !!q.mute, surf: unitVol(q.surf, 1), surfMute: !!q.surfMute, ambientMute: !!q.ambientMute, mediaMute: !!q.mediaMute });
// What the mixer makes of Drift's own sound (master) and of the Surf pages' (surf)
const mixGain = () => { const x = state.mixer, m = x.mute ? 0 : x.master; return { master: m, surf: x.surfMute ? 0 : m * x.surf }; };
const cleanHubSurf = (q) => ({ hub: /^[A-Za-z0-9_-]{20,64}$/.test(String(q.hub || '')) ? String(q.hub) : '', urls: (Array.isArray(q.urls) ? q.urls : []).map(String).filter((u) => /^(https?:\/\/|drift:\/\/home\/)/i.test(u)).slice(0, 12),
  active: Math.max(0, q.active | 0), noDownloads: !!q.noDownloads, told: !!q.told, showSpecs: !!q.showSpecs, showBrowsing: !!q.showBrowsing,
  allowLan: (Array.isArray(q.allowLan) ? q.allowLan : String(q.allowLan || '').split(/[\s,]+/)).map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z0-9.:[\]-]{1,80}$/.test(x)).slice(0, 20) });
const cleanBroadcast = (q) => ({ quality: ['auto', 'detail', 'motion'].includes(q.quality) ? q.quality : 'auto', pointers: q.pointers !== false, sound: !!q.sound });
function dropVideoScene() {
  if (state.scene === 'video') state.scene = 'aurora';
  for (const k of Object.keys(state.perDisplay)) if (state.perDisplay[k] === 'video') delete state.perDisplay[k];
}
// The browser's tabs are kept with the settings too (only while it is open), so it comes back next time.
function saveNow() {
  state.surf = web.saved() || surfKept || null;       // (your own tabs, put away while you're online in a hub, count too)
  const hs = hubWeb && hubWeb.saved(true);       // the hub's Surf stream keeps its tabs too, with the hub they belong to
  if (hs) state.hubSurf = { ...state.hubSurf, hub: hubWebId, urls: hs.urls, active: hs.active };
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
// q: a friend's copy (QUALITY). Their "Original" is no bigger than this PC converts for its own screens: full 4K beside our own
// stream left neither keeping up.
function xcSpec(key, input, start, q) {
  return { key, input, start, info: videoInfo, tone: state.video.tone, enc: encFallback ? 'auto' : state.video.enc,
    height: (q && QUALITY[q].h) || xcHeight(), rate: q ? QUALITY[q].kbps : 0 };
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
    p2p: { ...p2p.info(), ctrl: !remote || !!remote.ctrl, own: !!(c && c.remote && c.path), viaHost: viaHost(), quality: shareQuality(), waitingFor: heldFor || [], defaultName: shareName(true), file: remote ? remote.file || '' : '', music: remote ? remote.music : null, chatHub: sessionHub(), lan: createP2P.localAddrs().find((a) => a.includes('.')) || '' },
    mediaSolo: mediaSolo ? mediaSolo.text : '',       // why what this PC plays isn't on the hub's stream (mediaRefused)       // music: a friend's, playing here in place of ours; chatHub: the hub this session is in; lan: this PC's address on its network (Help)
    update: updater ? updater.info() : null,
    // this PC's own browser, or a hub's Surf stream (here on the hub's host; a picture from the host's PC elsewhere)
    web: surfView(), bcView: bcViewInfo(), hosting: !!(chat && chat.hostedHub()), hubHeld: heldView(), hubSurf: { noDownloads: state.hubSurf.noDownloads, allowLan: state.hubSurf.allowLan.join(', '), showSpecs: state.hubSurf.showSpecs, showBrowsing: state.hubSurf.showBrowsing } };
}
function broadcast(channel, payload, includeAudio = true) {
  for (const v of visWins) if (!v.win.isDestroyed()) v.win.webContents.send(channel, payload);
  if (includeAudio && audioWin && !audioWin.isDestroyed()) audioWin.webContents.send(channel, payload);
}
function pushState() { broadcast('state', publicState()); p2p.sync(); syncLive(); sfxTick(); }

// ---- the cats (Summon the cats) --------------------------------------------------------------------
// Where each cat is lives here, so every screen agrees. Now and then a cat wanders to another screen; opening or closing the
// panel a cat sits on shoos it (most of the time) to another screen Drift is showing on (with just one, it stays); and every 20 minutes
// they all come back, one by one, to the middle screen and stay there a while. Not saved: they start somewhere new each run.
const CAT_MAX = 12, CAT_TICK = 15 * 1000, CAT_WANDER = CAT_TICK / (5 * 60 * 1000), CAT_SHOO = 0.85;
const CAT_GATHER_EVERY = 20 * 60 * 1000, CAT_GATHER_GAP = 3500, CAT_GATHER_STAY = 3 * 60 * 1000;
let catAt = Array(CAT_MAX).fill(-1), catGatherAt = Date.now() + CAT_GATHER_EVERY, catStayTill = 0, catGathering = [];
const catPick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const catScreens = () => visWins.filter((v) => !v.win.isDestroyed()).map((v) => v.index);
function catMiddle() {       // the middle screen from left to right; of two in the middle, the main one
  const ws = visWins.filter((v) => !v.win.isDestroyed()).sort((a, b) => a.bounds.x - b.bounds.x);
  if (!ws.length) return -1;
  if (ws.length % 2) return ws[(ws.length - 1) / 2].index;
  const two = ws.slice(ws.length / 2 - 1, ws.length / 2 + 1), main = allDisplays().find((d) => d.primary);
  return (two.find((v) => main && v.index === main.index) || two[0]).index;
}
const catSend = () => broadcast('cmd', { type: 'cats', at: catAt }, false);
function catGather() {
  catGathering.forEach(clearTimeout); catGathering = [];
  const order = [...Array(CAT_MAX).keys()].sort(() => Math.random() - 0.5), shown = state.catsUnlocked ? Math.max(1, Math.min(CAT_MAX, Math.round(+state.catCount || 3))) : 1;
  const seen = order.filter((k) => k < shown), rest = order.filter((k) => k >= shown);       // the ones you can see come first, one at a time
  catStayTill = Date.now() + seen.length * CAT_GATHER_GAP + CAT_GATHER_STAY;
  seen.forEach((k, i) => catGathering.push(setTimeout(() => { const m = catMiddle(); if (m >= 0 && catAt[k] !== m) { catAt[k] = m; catSend(); } }, (i + 1) * CAT_GATHER_GAP)));
  const m = catMiddle(); for (const k of rest) catAt[k] = m;
}
function catTick() {
  const on = catScreens(); if (!on.length) return;
  const now = Date.now(); let moved = false;
  if (!state.cat) { catGatherAt = now + CAT_GATHER_EVERY; return; }       // the clock to the next gathering runs while they're out
  for (let k = 0; k < CAT_MAX; k++) {
    if (!on.includes(catAt[k])) { catAt[k] = catPick(on); moved = true; continue; }       // new, or its screen went away
    if (now < catStayTill || on.length < 2) continue;
    if (Math.random() < CAT_WANDER) { catAt[k] = catPick(on.filter((i) => i !== catAt[k])); moved = true; }
  }
  if (moved) catSend();
  if (now >= catGatherAt) { catGatherAt = now + CAT_GATHER_EVERY; catGather(); }
}
function catShoo(from) {       // every cat on that screen, each most likely
  const others = catScreens().filter((i) => i !== from); let moved = false;
  if (!others.length) return;       // nowhere else Drift is showing: they stay, and just hop to new spots on the edge (scatterCats in app.js)
  for (let k = 0; k < CAT_MAX; k++) {
    if (catAt[k] !== from || Math.random() > CAT_SHOO) continue;
    catAt[k] = catPick(others); moved = true;
  }
  if (moved) catSend();
}
// The windows were rebuilt (a monitor turned off or on, or plugged in or out): a cat on a screen Drift no longer shows on would
// sit out of sight there till the next tick, so it moves to one that is showing straight away.
function catRehome() {
  const on = catScreens(); if (!on.length) return;
  let moved = false;
  for (let k = 0; k < CAT_MAX; k++) if (!on.includes(catAt[k])) { catAt[k] = catPick(on); moved = true; }
  if (moved) catSend();
}
setInterval(catTick, CAT_TICK);
let lastToast = '';       // (test runs read it)
const say = (text) => { if (text) { lastToast = String(text); broadcast('cmd', { type: 'toast', text: String(text) }, false); } };

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
    ctrl: state.share.control, cap: state.share.quality, xc: !!ffmpegPath(), music: remote ? null : sharedMusic(on && !!cur()) };       // (Surf isn't on the media stream: it has a stream of its own, docs/plans/streams.md)
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
  const mu = s.music && typeof s.music === 'object' ? { on: !!s.music.on, src: s.music.src === 'files' ? 'files' : 'generative', title: String(s.music.title || '').slice(0, 200), preset: String(s.music.preset || '').slice(0, 40) } : null;
  remote = { ...s, web: null, music: mu, files: (Array.isArray(s.files) ? s.files : []).slice(0, 5000).map((f) => ({ name: path.basename(String(f.name || 'video')).slice(0, 200), size: +f.size || 0 })),
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
}
// ---- Surf: this PC's own browser, or a hub's Surf stream (docs/plans/streams.md) ----
// Offline, the Surf tab is this PC's own browser (`web`, see web.js). Online in a hub it's that hub's Surf stream: one browser
// for the whole hub, running on its host's PC. On the host's PC that's `hubWeb`, a second web.js browser in a profile of its
// own, drawn here straight from its offscreen frames; on everyone else's it's a picture streamed from the host's PC, with
// their mouse, keyboard and Surf bar sent back. Your own browser is put away meanwhile (surfKept) and comes back, with its
// tabs, once you disconnect.
const SURF = ['go', 'home', 'new', 'tab', 'close', 'back', 'fwd', 'reload', 'hard', 'reopen', 'step', 'nth', 'zoom'];       // (the last five: keyboard shortcuts)
let appAccent = { a: '#22c08a', b: '#b58cff' };       // Drift's accent and its second colour, as the windows last said ('accent'): the start page's by default
const screenFor = (key) => (visWins.some((x) => x.key === key) ? key : (visWins.find((x) => (allDisplays().find((d) => d.key === x.key) || {}).primary) || visWins[0] || { key: 'd0' }).key);
const SURF_FIT_MIN = 0.85;       // while mirroring, the least the Surf monitor shrinks the page to make room for other monitors' shapes (pageSize)
const web = createWeb({
  changed: () => pushState(),
  screen: screenFor,
  escape: () => surfEsc(web.info().key),
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
  gain: () => mixGain().surf,
  accent: () => appAccent,
  win: (key) => { const x = visWins.find((y) => y.key === key); return x && !x.win.isDestroyed() ? x.win : null; },
  display: (key) => { const x = visWins.find((y) => y.key === key); return x && !x.win.isDestroyed() ? screen.getDisplayMatching(x.win.getBounds()) : null; },
  // The size in pixels to draw the page at, with the browser on monitor `key`. Its layout is that monitor's own, at its scale: it's
  // the one the page is used on. While mirroring, a monitor of another shape (an ultrawide, a portrait one) stretches the page toward
  // its own shape, so it shows smaller bars, but only so far that the Surf monitor still shows the page at SURF_FIT_MIN of its size or
  // more: the bars are shared out, and no monitor's size or scale can make the page tiny on another (it used to take the widest
  // monitor's pixels, which shrank and barred the page on a smaller or differently shaped Surf monitor). Monitors show it whole.
  pageSize: (key) => {
    const own = visWins.find((x) => x.key === key && !x.win.isDestroyed());
    if (!own) return null;
    const k = screen.getDisplayMatching(own.win.getBounds()).scaleFactor || 1, [sw, sh] = own.win.getContentSize();
    if (!sw || !sh) return null;
    let w = sw, h = sh;
    if (state.surfMirror) for (const x of visWins) {
      if (x === own || x.win.isDestroyed()) continue;
      const [mw, mh] = x.win.getContentSize();
      if (!mw || !mh) continue;
      const a = mw / mh;       // (a wider monitor widens the page, a taller one makes it taller)
      w = Math.max(w, Math.min(sh * a, sw / SURF_FIT_MIN));
      h = Math.max(h, Math.min(sw / a, sh / SURF_FIT_MIN));
    }
    return { w: Math.round(w * k), h: Math.round(h * k) };
  },
});
let webAway = false;
function surfEsc(key) { const x = visWins.find((y) => y.key === key); if (x && !x.win.isDestroyed()) { x.win.webContents.focus(); x.win.webContents.send('cmd', { type: 'web-esc' }); } }

// Which browser the Surf tab is: 'own' (this PC's), 'hub' (online in the hub this PC hosts: its Surf stream, here) or
// 'stream' (online in someone else's hub: their Surf stream, streamed). The hub is your active one, else the first you're online in.
const surfHub = () => (chat ? mediaHub() : null);
function surfMode() { const h = surfHub(); return !h ? 'own' : h.mine && h.id === chat.hostedHub() ? 'hub' : 'stream'; }
let surfModeWas = 'own', surfShown = false, surfKey = '';       // (for 'hub' and 'stream': whether the Surf tab shows it, and on which monitor)
let surfKept = null;       // your own tabs, put away while you're online in a hub
function surfBack() {
  if (!surfKept || web.info().has) return false;
  const s = surfKept; surfKept = null;
  web.restore(s);
  return true;
}
// Online, offline, or another hub: the Surf tab changes browser. Whatever showed carries on showing, on the same monitor.
function surfModeCheck() {
  const m = surfMode();
  if (m === surfModeWas) return;
  const was = surfModeWas; surfModeWas = m;
  if (was === 'own') { const w = web.info(); surfShown = w.open; surfKey = w.key || surfKey; if (w.has) { surfKept = web.saved(true) || surfKept; web.close(); } }
  else if (was === 'hub') { if (hubWeb) hubWeb.hide(); }
  else if (was === 'stream') ssStop();
  if (m === 'own') { if (surfShown && surfBack()) web.show(surfKey); surfShown = false; }
  else if (m === 'hub') { if (surfShown) hubShow(surfKey); }
  else if (m === 'stream') { if (surfShown) ssStart(); }
  hubSound();
  ptrClear();
  pushState();
}

// ---- the hub's browser, on the PC hosting the hub ----
let hubWeb = null, hubWebId = '', hubTitleSent = null, hubPwTold = false;
function hubBrowser() {
  const id = chat ? chat.hostedHub() : '';
  if (hubWeb && hubWebId !== id) { saveNow(); hubWeb.stop(); hubWeb = null; hubTitleSent = null; ssWinClose(); }
  if (!id) return null;
  if (!hubWeb) {
    hubWebId = id;
    hubWeb = createWeb({
      changed: hubChanged,
      screen: screenFor,
      escape: () => surfEsc(screenFor(surfKey)),
      say: (t) => { if (surfMode() === 'hub' && surfShown) say(t); ssNote(t); },       // to whoever is looking at it
      blockAds: () => state.share.adblock,
      ublockDir: () => path.join(app.getPath('userData'), 'ublock'),
      // The members' own mixers set what they hear, so while the stream is captured the pages play at full level and are silent
      // here; the host hears the capture instead, at their Surf level (ssEar). Otherwise the pages play here at that level.
      gain: () => (ssEar ? 1 : mixGain().surf),
      muted: () => ssEar || hubHear() === 0,       // (setAudioMuted doesn't silence the capture: spike S1)
      held: hubHeld,
      holdDir: () => path.join(app.getPath('userData'), 'hub-downloads'),
      allowLan: () => state.hubSurf.allowLan,
      showcase: () => ({ specs: state.hubSurf.showSpecs, browsing: state.hubSurf.showBrowsing }),       // the host's choice, in Settings
      owner: () => web.home,
      accent: () => appAccent,       // (the host's: it's their start page everyone in the hub sees)
      cursor: ssCursor,
      // Enter that the page didn't take (web.js "Enter"): the chat box of whoever pressed it, the host's here, a member's on their PC
      chatOk: (who) => { const h = chat && chat.info().hubs.find((x) => x.id === hubWebId); return !!(h && h.channels.length) && (who !== chat.myId() || h.status === 'connected'); },
      chat: (who, from) => {
        if (who !== chat.myId()) { toSs({ t: 'send', to: who, m: { t: 'chat' } }); return; }
        const x = visWins.find((y) => !y.win.isDestroyed() && y.win.webContents === from);
        if (x) { x.win.webContents.focus(); x.win.webContents.send('cmd', { type: 'chat-quick' }); }
      },
      note: (what) => { if (what === 'password' && !hubPwTold) { hubPwTold = true; const t = 'Everyone in the hub can use what you sign in to here.'; if (surfMode() === 'hub') say(t); ssNote(t); } },
    }, { partition: `persist:hub-${id}`, headless: true });
  }
  return hubWeb;
}
// The hub's browser starts the first time anyone opens Surf while online, with the tabs it had (decision §11.3).
function hubStart() {
  const hw = hubBrowser();
  if (!hw || hw.running()) return hw;
  const hs = state.hubSurf;
  if (hs.hub === hubWebId && hs.urls.length) hw.restore({ urls: hs.urls, active: hs.active }); else hw.start();
  return hw;
}
function hubShow(k) { const hw = hubStart(); if (hw) { surfShown = true; surfKey = k || surfKey; hw.show(surfKey); } }
let hubChangeTimer = null;
function hubChanged() {
  if (surfMode() === 'hub') pushState();
  if (hubChangeTimer) return;
  hubChangeTimer = setTimeout(() => {       // what the members see of it, and what the hub says it is, at most 5 times a second
    hubChangeTimer = null;
    const hw = hubWeb, i = hw && hw.info(), running = !!(hw && hw.running());
    const title = running ? i.title || (/^drift:\/\/home\//i.test(i.url || '') ? 'New tab' : i.url) || 'New tab' : null;
    if (title !== hubTitleSent && chat) {
      hubTitleSent = title;
      chat.ssSet(running ? { on: true, title } : { on: false }).catch(() => {});
      if (running && !state.hubSurf.told) { state.hubSurf.told = true; say('Your hub\'s Surf stream runs on this PC: its pages load from your internet connection, so sites see your address.'); }
    }
    if (running) ssState();
    ssWinSync();
    if (ssWin && i && i.sid !== ssSid) { ssSid = i.sid; toSs({ t: 'recapture' }); }       // another tab came to the front, or a page came in
    saveSoon();
  }, 200);
}
// ---- held downloads (§6): only the host can say yes, on this PC's own screens ----
const held = [];       // { d (from web.js), from (member id, or ''), until, timer }
const heldView = () => held.map((h) => ({ id: h.d.id, name: h.d.name, size: h.d.size, site: h.d.site, who: hubName(h.from), until: h.until }));
const heldNews = () => broadcast('cmd', { type: 'hub-held', list: heldView() }, false);
function hubName(id) { if (!id) return 'Someone'; if (chat && id === chat.myId()) return 'You'; const x = chat && chat.info().ss.host; return (x && x.names && x.names[id]) || 'Someone'; }
function hubHeld(d) {
  if (state.hubSurf.noDownloads) { ssNote('The host has turned off downloads on the Surf stream.'); return false; }
  if (held.length >= 3 || (d.who && held.some((h) => h.from === d.who))) { ssNote('Too many downloads waiting'); return false; }
  const h = { d, from: d.who || '', until: Date.now() + 60000 };
  h.timer = setTimeout(() => heldAnswer(d.id, false), 60000);
  held.push(h);
  heldNews();
  ssNote(`Waiting for the host to allow ${d.name}`);
  return true;
}
function heldAnswer(id, yes) {
  const i = held.findIndex((h) => h.d.id === id);
  if (i < 0) return;
  const h = held.splice(i, 1)[0];
  clearTimeout(h.timer);
  if (yes) h.d.save(); else { h.d.refuse(); ssNote(`The host didn't allow ${h.d.name}`); }
  heldNews();
}

// ---- the host's side of the stream: the stream window (renderer/surf-stream.html) ----
// A hidden window, made while anyone watches and closed when nobody does. It captures the hub's browser (main.js answers its
// getDisplayMedia with the browser's own frame), holds one connection per watcher, all fed by that one capture, and their data
// channels. It never sees a key or the hub: chat.js signs what it sends and checks what arrives before it sees it.
let ssWin = null, ssUp = false, ssQueue = [], ssSid = '', ssEar = false;       // ssEar: the stream window is capturing, and plays its sound here
// What the host hears of their hub's browser: their Surf level while they're in the hub, else nothing
const hubHear = () => (surfMode() === 'hub' ? mixGain().surf : 0);
function hubSound() {
  if (hubWeb) { hubWeb.gainChanged(); hubWeb.audioChanged(); }
  toSs({ t: 'hear', v: hubHear() });
}
const ssPeers = {};       // watcher -> connection state (tests read it)
const ssWatchers = () => { const x = chat && chat.info().ss.host; return x ? x.watchers : []; };
function toSs(m) { if (!ssWin) return; if (ssUp && !ssWin.isDestroyed()) ssWin.webContents.send('surf-stream', m); else ssQueue.push(m); }
function ssWinSync() {
  const need = !!(hubWeb && hubWeb.running() && ssWatchers().length);
  if (need && !ssWin) {
    ssUp = false; ssSid = hubWeb.info().sid;
    ssQueue = [{ t: 'start', policy: state.voice.direct ? 'all' : 'relay' }, { t: 'hear', v: hubHear() }];
    const w = ssWin = new BrowserWindow({ show: false, width: 240, height: 120, skipTaskbar: true, title: 'Drift Surf stream',
      webPreferences: { preload: path.join(__dirname, 'surf-stream-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    w.on('closed', () => { if (ssWin === w) { ssWin = null; ssUp = false; ssQueue = []; for (const k of Object.keys(ssPeers)) delete ssPeers[k]; if (ssEar) { ssEar = false; hubSound(); } } });
    w.loadFile(path.join(__dirname, 'renderer', 'surf-stream.html')).catch(() => {});
  } else if (!need && ssWin) ssWinClose();
}
function ssWinClose() { const w = ssWin; ssWin = null; ssUp = false; ssQueue = []; for (const k of Object.keys(ssPeers)) delete ssPeers[k]; if (w && !w.isDestroyed()) w.destroy(); if (ssEar) { ssEar = false; hubSound(); } }
function ssState() {       // what the watchers' Surf bar shows
  if (!hubWeb) return;
  const i = hubWeb.info();
  toSs({ t: 'send', m: { t: 'state', url: i.url, title: i.title, tabs: i.tabs, active: i.active, back: i.back, fwd: i.fwd } });
}
// The pointer the hub's page asks for (a hand over a link, a bar over text) belongs to whoever has its hover (web.js takeHover):
// it goes to that watcher alone, and the one who had it before gets the plain arrow back.
let ssCur = { who: '', c: '' };
function ssCursor(who, c) {
  if (who === ssCur.who && c === ssCur.c) return;
  if (ssCur.who && ssCur.who !== who) toSs({ t: 'send', to: ssCur.who, m: { t: 'cur', c: 'default' } });
  if (who) toSs({ t: 'send', to: who, m: { t: 'cur', c } });
  ssCur = { who, c };
}
function ssNote(text) { if (text) toSs({ t: 'send', m: { t: 'note', text: String(text).slice(0, 200) } }); }
// What a watcher sends over their data channel. The channel is end to end, so the hub can't check any of it: it's checked here.
const SS_RATE = { in: 150, bar: 8, ptr: 30, hello: 2 };       // the most of each a second, per watcher (mouse moves come at most once a frame)
const ssRate = new Map();
function onSsData(from, m) {
  if (!m || typeof m !== 'object' || !Object.hasOwn(SS_RATE, m.t) || !hubWeb || !ssWatchers().includes(from)) return;
  const now = Date.now(), r = ssRate.get(from) || {};
  if (!r[m.t] || now - r[m.t].at >= 1000) r[m.t] = { at: now, n: 0 };
  ssRate.set(from, r);
  if (++r[m.t].n > SS_RATE[m.t]) { ssDropped++; return; }       // a flood is slowed: the rest of that second is dropped
  if (m.t === 'in' && m.e && typeof m.e === 'object') hubWeb.input(m.e, false, from);
  else if (m.t === 'bar' && m.m && typeof m.m === 'object' && SURF.includes(m.m.do)) {
    const res = hubWeb.act({ do: m.m.do, text: String(m.m.text || '').slice(0, 2000), id: +m.m.id || 0, n: +m.m.n || 0 });       // (only web addresses and the start page: web.js address())
    if (res.error) toSs({ t: 'send', to: from, m: { t: 'note', text: res.error } });
  } else if (m.t === 'ptr') ptrSet(from, hubName(from), m.x >= 0 ? { x: +m.x, y: +m.y } : null);
  else if (m.t === 'hello') ssState();
}
let ssDropped = 0;
ipcMain.on('surf-stream', (e, type, d) => {
  if (!ssWin || ssWin.isDestroyed() || e.sender !== ssWin.webContents) return;
  if (type === 'log') { chatLog('surf stream: ' + String(d).slice(0, 300)); return; }
  if (type === 'hello') { ssUp = true; for (const m of ssQueue.splice(0)) ssWin.webContents.send('surf-stream', m); ssState(); return; }
  if (!d || typeof d !== 'object') return;
  if (type === 'signal') chat.ssSignal(String(d.to || ''), d.d);
  else if (type === 'cert') chat.ssCert(String(d.peer || ''), String(d.alg || ''), String(d.fp || ''));       // a mismatch comes back as ss-verdict and closes it
  else if (type === 'data') onSsData(String(d.from || ''), d.m);
  else if (type === 'peer') { if (d.state) ssPeers[String(d.id)] = String(d.state); else delete ssPeers[String(d.id)]; }
  else if (type === 'ear') { if (ssEar !== !!d.on) { ssEar = !!d.on; hubSound(); } }       // the capture started or stopped: the host's sound comes from it, or from the pages
});
// What chat.js says about the Surf stream (all of it already checked there).
async function onSsEvent(hub, m) {
  switch (m.t) {
    case 'ss-wake': hubStart(); break;       // a member opened Surf: the hub's browser starts (decision §11.3)
    case 'ss-viewer': {       // a watcher's request checked out: the stream window makes them an offer, through the relay
      ssWinSync();
      const r = await chat.ssRelay();
      if (!r.error && (r.iceServers.length || state.voice.direct)) toSs({ t: 'viewer', id: m.id, iceServers: r.iceServers });
      else chatLog('surf stream: no relay for a watcher' + (r.error ? ': ' + r.error : ''));
      break;
    }
    case 'ss-viewer-left': toSs({ t: 'left', id: m.id }); ptrSet(m.id, '', null); if (ssCur.who === m.id) ssCur = { who: '', c: '' }; setTimeout(ssWinSync, 0); break;
    // (hosting, these are for the stream window; watching another hub's, for the screen window that shows it)
    case 'ss-sdp':
      if (hub !== chat.hostedHub()) { if (ssW && m.from === ssW.host) toScreen({ type: 'ss-rtc', d: { type: 'offer', sdp: m.sdp.sdp, iceServers: ssW.ice, policy: ssW.policy } }); }
      else toSs({ t: 'sdp', from: m.from, sdp: m.sdp });
      break;
    case 'ss-candidate':
      if (hub !== chat.hostedHub()) { if (ssW && m.from === ssW.host) toScreen({ type: 'ss-rtc', d: { type: 'ice', c: m.c } }); }
      else toSs({ t: 'candidate', from: m.from, c: m.c });
      break;
    case 'ss-verdict': if (!m.ok) { if (hub !== chat.hostedHub()) toScreen({ type: 'ss-rtc', d: { type: 'bye' } }); else toSs({ t: 'left', id: m.id }); say('A Surf stream connection didn\'t match its signed certificate, so it was closed. The hub may be interfering.'); } break;
    case 'ss-refused': say(ssW ? `Couldn't check the Surf stream really comes from ${m.name}. The hub may be interfering.` : `Couldn't verify ${m.name}. The hub may be interfering.`); break;
    case 'ss-told': say(`${m.name} couldn't verify the Surf stream's connection. The hub may be interfering.`); break;
    case 'ss-paused': toScreen({ type: 'ss-rtc', d: { type: 'bye' } }); pushState(); break;       // the host's browser stopped: it comes back by itself when it starts again
    case 'ss-watch-off': if (ssW) { ssW = null; toScreen({ type: 'ss-rtc', d: { type: 'bye' } }); ptrClear(); if (surfShown && surfMode() === 'stream') setTimeout(() => ssStart(), 1500); pushState(); } break;
    default: break;
  }
}

// ---- the member's side: someone else's hub's Surf stream, in the Surf tab ----
// Watching starts when the Surf tab is opened, not on coming online, so nobody pays for a stream they aren't looking at.
// The picture is a <video> in the screen window of the Surf monitor (renderer/app.js), set up from SDPs chat.js has checked.
let ssLive = '';       // the screen window's connection to the host: its state (tests read it)
let ssW = null;       // { hub, host, sid, state (the host's browser, for the Surf bar), on, at, ice, policy }
async function ssStart(again) {
  const h = surfHub();
  if (!h || surfMode() !== 'stream') return;
  if (again && ssW && Date.now() - ssW.at < 2500) return;       // (the screen asks again by itself: at most every few seconds)
  chatLog(`surf stream: asking to watch${again ? ' again' : ''}`);
  const was = ssW && ssW.hub === h.id ? ssW : null, host = (h.members.find((x) => x.host) || {}).id || '';
  ssW = { hub: h.id, host, sid: was ? was.sid : 's' + Date.now().toString(36), state: was ? was.state : null, on: false, at: Date.now(), ice: [], policy: state.voice.direct ? 'all' : 'relay' };
  const mine = ssW, r = await chat.ssWatch(h.id);
  if (ssW !== mine) return;
  if (r.error) { if (!was || !was.err) say(r.error); ssW.err = r.error; pushState(); return; }
  Object.assign(ssW, { on: !!r.on, ice: r.iceServers || [], host: (chat.info().ss.watching || {}).from || host });
  pushState();
}
function ssStop() { if (!ssW) return; ssW = null; chat.ssUnwatch(); toScreen({ type: 'ss-rtc', d: { type: 'bye' } }); ptrClear(); pushState(); }
const toScreen = (c) => { const x = visWins.find((y) => y.key === screenFor(surfKey)); if (x && !x.win.isDestroyed()) x.win.webContents.send('cmd', c); };
const ssOut = (m) => { if (ssW) toScreen({ type: 'ss-out', m }); };       // to the host, over the data channel the screen window holds
const cleanTabs = (t) => (Array.isArray(t) ? t : []).slice(0, 12).map((x) => ({ id: +(x || {}).id || 0, title: String((x || {}).title || '').replace(/[\x00-\x1f]/g, '').slice(0, 200) }));
function onSsDc(m) {       // from the host, over the data channel (the screen window passes it on as it is)
  if (!ssW || !m || typeof m !== 'object') return;
  if (m.t === 'state') {
    ssW.state = { url: String(m.url || '').slice(0, 2000), title: String(m.title || '').replace(/[\x00-\x1f]/g, '').slice(0, 200), tabs: cleanTabs(m.tabs), active: +m.active || 0, back: !!m.back, fwd: !!m.fwd };
    pushState();
  } else if (m.t === 'ptrs') {
    const blocked = new Set(chat.info().blocked), me = chat.myId();
    ptrShow(screenFor(surfKey), ptrClean(m.list).filter((q) => q.id !== me && !blocked.has(q.id)));       // (blocking someone hides their pointer: their input still reaches the page)
  } else if (m.t === 'cur') {       // the pointer the page asks for, while the hover is ours (web.js takeHover)
    const c = String(m.c || '');
    if (/^[a-z-]{1,24}$/.test(c)) { ssCurSeen.add(c); toScreen({ type: 'web-cursor', c }); }
  } else if (m.t === 'note') say(String(m.text || '').slice(0, 200));
  else if (m.t === 'chat') {       // our Enter wasn't for the page (web.js "Enter"): the chat box, over the stream
    const x = visWins.find((y) => y.key === screenFor(surfKey));
    if (x && !x.win.isDestroyed()) x.win.webContents.send('cmd', { type: 'chat-quick' });
  }
}
const ssCurSeen = new Set();       // (the pointers the host has sent: tests read it)
function surfView() {
  const m = surfMode(), h = surfHub();
  const hubBits = h ? { hub: true, hubId: h.id, hubName: h.name || 'Hub', mine: m === 'hub' } : {};
  if (m === 'hub') {
    const x = chat.info().ss.host, i = hubWeb ? hubWeb.info() : { open: false, has: false, tabs: [] };
    return { ...i, open: surfShown && !!i.open, key: surfShown && i.open ? screenFor(surfKey) : '', has: true, ...hubBits, watchers: x ? x.watchers : [] };
  }
  if (m === 'stream') {
    const st = (ssW && ssW.state) || { url: '', title: '', tabs: [], active: 0, back: false, fwd: false };
    const live = !!(ssW && h.surf && h.surf.on);
    return { open: surfShown, has: true, stream: true, key: surfShown ? screenFor(surfKey) : '', parked: !surfShown && ssW ? screenFor(surfKey) : '', sid: ssW ? ssW.sid : '', live, ctrl: true, ...st, ...hubBits,
      watchers: h.surf ? h.surf.watchers : [], waiting: !!ssW && !live, note: (ssW && ssW.err) || '' };
  }
  return web.info();
}

// Where everyone's mouse is over the Surf stream, as fractions of the page, so everyone can draw the others' pointers. The
// host's Drift gathers them (the host's own too, while they look at it) and passes each watcher everyone's but their own.
const pointers = new Map();
let ptrTimer = null;
const ptrClean = (list) => (Array.isArray(list) ? list : []).slice(0, 12).filter((q) => q && typeof q === 'object' && q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1)
  .map((q) => ({ id: String(q.id).slice(0, 16), name: String(q.name || '').replace(/[\x00-\x1f<>]/g, '').slice(0, 24), x: +q.x, y: +q.y }));
function ptrShow(key, list) { const x = visWins.find((y) => y.key === key); if (x && !x.win.isDestroyed()) x.win.webContents.send('cmd', { type: 'ptrs', list }); }
function ptrClear() { pointers.clear(); for (const v of visWins) if (!v.win.isDestroyed()) v.win.webContents.send('cmd', { type: 'ptrs', list: [] }); }
function ptrSet(id, name, m) {
  const ok = m && typeof m === 'object' && m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1 && !!hubWeb && hubWeb.running();
  if (!ok && !pointers.has(id)) return;
  if (ok) pointers.set(id, { id, name, x: +m.x, y: +m.y }); else pointers.delete(id);
  if (ptrTimer) return;
  ptrTimer = setTimeout(() => {       // at most 25 times a second
    ptrTimer = null;
    const all = ptrClean([...pointers.values()]), me = chat ? chat.myId() : '', blocked = new Set(chat ? chat.info().blocked : []);
    if (surfMode() === 'hub' && surfShown) ptrShow(screenFor(surfKey), all.filter((q) => q.id !== me && !blocked.has(q.id)));
    toSs({ t: 'ptrs', list: all });       // (the stream window leaves out each watcher's own)
  }, 40);
}
setInterval(() => {       // the host's own mouse over the hub's browser: the page swallows it, so ask Windows where it is
  const me = chat ? chat.myId() : '', x = me && surfMode() === 'hub' && surfShown && ssWin ? visWins.find((y) => y.key === screenFor(surfKey)) : null;
  if (!x || x.win.isDestroyed()) { if (me && pointers.has(me)) ptrSet(me, '', null); return; }
  if (SHOT_DIR) return;       // dev runs place it by hand
  const c = screen.getCursorScreenPoint(), b = x.win.getContentBounds();
  ptrSet(me, shareName(), { x: (c.x - b.x) / b.width, y: (c.y - b.y) / b.height });
}, 60);
// The mouse moving over one of Drift's screens, told to that screen (at most 5 times a second, only while it moves): over a
// web page the window can't see it, and the chat button over Surf (renderer/chat.js coWake) shows while it moves.
let lastCursor = '';
setInterval(() => {
  if (SHOT_DIR || !chat || !visWins.length) return;
  const c = screen.getCursorScreenPoint(), k = c.x + ',' + c.y;
  if (k === lastCursor) return;
  lastCursor = k;
  const v = visWins.find((x) => { if (x.win.isDestroyed() || !x.win.isVisible()) return false; const b = x.win.getContentBounds(); return c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height; });
  if (v) v.win.webContents.send('cmd', { type: 'pointer-moved' });
}, 200);
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
  ptr: () => {}, ptrs: () => {},       // (pointers are the Surf stream's now)
  rtc: (id, d) => {       // setting up the stream of the music friends hear: the audio window's
    if (!d || typeof d !== 'object' || (id ? p2p.role() !== 'host' : !remote) || d.ch !== 'music') return;
    if (audioWin && !audioWin.isDestroyed()) audioWin.webContents.send('cmd', { type: 'rtc', from: id, d });
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
  // A hub's media stream we couldn't get to: unless its PC was found to be reachable (then the trouble is likely at this end),
  // the hub is told, and takes it off the stream so everyone is on the same thing (hub.js "reach").
  unreached: (code) => {
    const h = chat && chat.info().hubs.find((x) => x.status === 'connected' && (x.lives || []).some((l) => l.code === code));
    const l = h && h.lives.find((x) => x.code === code);
    if (!l || l.reach === 'internet') return '';
    chat.liveFail(h.id, code);
    const who = ((h.members || []).find((m) => m.id === l.from) || {}).name || 'your friend';
    return `Couldn't connect to ${who}'s PC: their router isn't letting friends in. It's off the hub's stream now, so everyone stays on the same thing.`;
  },
});

async function publicIp() { const r = await net.fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) }); const ip = (await r.text()).trim(); return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : ''; }

// ---- chat ------------------------------------------------------------------------------------------
// chat.js holds this PC's identity, its hubs and (when hosting) a hub of its own; this passes what it says to the windows.
// Every window's panel has a Chat tab, so all of them hear about changes. A new message pops up on one screen only.
let chat = null, chatPub = '', shownSessionHub = '';
const chatLog = (t) => { console.log(t); if (SHOT_DIR) { try { fs.appendFileSync(path.join(SHOT_DIR, 'chat.log'), new Date().toISOString().slice(11, 23) + ' ' + t + '\n'); } catch { /* fine */ } } };       // test runs keep chat's log
function startChat() {
  const enc = safeStorage.isEncryptionAvailable();
  chat = createChat({
    dir: path.join(app.getPath('userData'), 'chat'),
    seal: (b) => (enc ? safeStorage.encryptString(b.toString('latin1')) : b),
    unseal: (b) => (enc ? Buffer.from(safeStorage.decryptString(Buffer.from(b)), 'latin1') : b),
    addrs: () => [...(createP2P.isPublic(chatPub) ? [chatPub] : []), ...createP2P.localAddrs()],
    upnp: async (port, proto) => { const m = await createP2P.upnpMap(port, proto); if (createP2P.isPublic(m.ip)) chatPub = m.ip; return m; },
    changed: () => {
      broadcast('chat', { type: 'info', info: chatInfo() }, false);
      const sh = sessionHub();       // the session's hub is known once that hub lists the share: the panels need it to chat over the video
      if (sh !== shownSessionHub) { shownSessionHub = sh; pushState(); }
      bcNews();
      bcSceneCheck();
      sfxTick();
      mediaCheck();
      surfModeCheck();
      if (hubWeb || chat.hostedHub()) { hubBrowser(); ssWinSync(); }
      if (surfMode() !== 'own') pushState();       // (who watches the Surf stream)
    },
    event: (hub, m) => {
      if (String(m.t).startsWith('voice-')) { onVoiceEvent(hub, m); return; }       // for the call's window, not the panels
      if (String(m.t).startsWith('ss-')) { onSsEvent(hub, m); return; }       // the Surf stream's: for its windows
      if (m.t === 'media-vote') onMediaVote(hub, m.vote);
      if (m.t === 'live-no' && p2p.role() === 'host' && liveHub === hub) { mediaRefused(hub, m); return; }
      if ((m.t === 'bc-off' || m.t === 'bc-watch-off') && m.why && m.why !== 'ended') say(m.why);       // e.g. the host stopped your broadcast
      if (m.t === 'bc-thumb') { onBcEvent(hub, m); return; }       // a still, for the Broadcast scene only (it fetches it with bcStill)
      if (String(m.t).startsWith('bc-')) onBcEvent(hub, m);       // for the broadcast window and the screen showing one (the panels hear of it too)
      broadcast('chat', { type: 'event', hub, m }, false);
      // A new message pops up on one screen: over what you're watching from that hub (yours too, so the conversation
      // reads in order), over what you're broadcasting into it (games too), or as a note at the top for anyone else's.
      if (m.t === 'msg' && m.msg && !m.msg.edited && !m.again) {
        const o = overFor(hub);
        if (o && o.game) bcMsgAdd(hub, m.msg);
        else if (o || m.msg.from !== chat.myId()) {
          const f = BrowserWindow.getFocusedWindow(), v = (o && o.win) || visWins.find((x) => x.win === f) || visWins[0];
          if (v && !v.win.isDestroyed()) v.win.webContents.send('chat', { type: 'notify', hub, msg: m.msg, overlay: !!o });
        }
      }
    },
    log: chatLog,
    connectOnStart: false,       // online in a hub means on its stream (and sharing what you pick): only once you click it
  });
  chat.setName(shareName());
  if (!SHOT_DIR || process.env.DRIFT_TESTCHAT || process.env.DRIFT_TESTSTREAM || process.env.DRIFT_TESTSS || process.env.DRIFT_TESTPICS) chat.start().catch((e) => console.log('chat: ' + e.message));
  publicIp().then((ip) => { chatPub = ip; }).catch(() => {});
}
// ---- Hub sounds (renderer/sfx.js makes them, in the hidden audio window, so they never double across monitors) ----
// Each one is a change this PC can see: a small picture of the hub is taken whenever something may have changed, and
// compared with the last one. The first picture only sets the scene, so starting Drift is quiet.
const SFX_NAMES = new Set(['join', 'leave', 'peerJoin', 'peerLeave', 'mute', 'unmute', 'connect', 'disconnect', 'lost',
  'liveOn', 'liveOff', 'viewerJoin', 'viewerLeave', 'bcStart', 'shareOn', 'shareOff', 'message']);
let sfxWas = null, sfxJoinedAt = 0;
function sfxPlay(names, preview = false) {
  if ((!state.sfx.on && !preview) || !audioWin || audioWin.isDestroyed()) return;
  const vol = mixGain().master * state.sfx.volume * state.sfx.volume;       // (squared, like the mixer's sliders: the slider feels even)
  if (vol > 0) audioWin.webContents.send('cmd', { type: 'sfx', names, vol });
}
function sfxSnap() {
  const I = chat.info(), me = chat.myId(), act = activeHub(), h = I.hubs.find((x) => x.id === act && x.status === 'connected');
  const inVoice = !!(h && !state.voice.deaf && h.room && h.room.in), mine = I.bc && I.bc.mine, p = p2p.info();
  return { act: h ? h.id : '', status: new Map(I.hubs.map((x) => [x.id, x.status])), inVoice, talk: inVoice && !!state.voice.talk,
    voice: new Set(inVoice ? (h.voice || []).filter((v) => v.listen && v.id !== me).map((v) => v.id) : []),
    bcs: new Set(h ? (h.bcs || []).filter((b) => b.from !== me).map((b) => b.id) : []),
    live: mine ? mine.id : '', viewers: new Set(mine ? Object.keys(mine.viewers || {}) : []),
    share: p.role || 'off', friends: new Set(p.role === 'host' ? (p.peers || []).map((x) => (x && x.name) || String(x)) : []) };
}
const sfxDiff = (a, b) => [[...b].some((x) => !a.has(x)), [...a].some((x) => !b.has(x))];       // [someone came, someone went]
function sfxTick() {
  if (!chat) return;
  let now;
  try { now = sfxSnap(); } catch { return; }       // (chat not started yet)
  const was = sfxWas; sfxWas = now;
  if (!was) return;
  const out = [];
  // your hubs: online, offline because you chose it (Disconnect, Leave hub), or dropped
  let hub = '';
  for (const [id, st] of now.status) { const w = was.status.get(id); if (st !== w && st === 'connected') hub = 'connect'; else if (w === 'connected' && st !== 'connected') hub = hub || (st === 'away' ? 'disconnect' : 'lost'); }       // (away: you pressed Disconnect; offline or gone: dropped, or removed)
  for (const [id, w] of was.status) if (w === 'connected' && !now.status.has(id)) hub = hub || 'disconnect';
  if (hub) out.push(hub);
  // your voice room: in, out, or moved to another hub's
  const moved = was.inVoice && now.inVoice && was.act !== now.act;
  if (now.inVoice !== was.inVoice || moved) {
    if (now.inVoice) { out.push('join'); sfxJoinedAt = Date.now(); } else if (!hub) out.push('leave');       // (dropped with the hub: its sound says it)
  } else if (now.inVoice) {
    if (was.talk !== now.talk) out.push(now.talk ? 'unmute' : 'mute');
    if (Date.now() - sfxJoinedAt > 1500) {       // (the room's list catching up just after you joined isn't people arriving)
      const [came, went] = sfxDiff(was.voice, now.voice);
      if (came) out.push('peerJoin'); else if (went) out.push('peerLeave');
    }
  }
  // your broadcast, and who watches it
  if (now.live !== was.live) out.push(now.live ? 'liveOn' : 'liveOff');
  else if (now.live) { const [came, went] = sfxDiff(was.viewers, now.viewers); if (came) out.push('viewerJoin'); else if (went) out.push('viewerLeave'); }
  // someone else going live in your hub
  if (now.act && now.act === was.act && [...now.bcs].some((id) => !was.bcs.has(id))) out.push('bcStart');
  // watching together: started or over, and friends joining what you share
  if ((now.share === 'off') !== (was.share === 'off')) out.push(now.share === 'off' ? 'shareOff' : 'shareOn');
  else if (now.share === 'host' && was.share === 'host') { const [came, went] = sfxDiff(was.friends, now.friends); if (came) out.push('peerJoin'); else if (went) out.push('peerLeave'); }
  if (out.length) sfxPlay([...new Set(out)]);
}
// A broadcast that starts in your active hub is a toast ("Sam started broadcasting"), never something opening by itself (§6).
let bcSeen = null;
function bcNews() {
  const h = chat.info().hubs.find((x) => x.id === activeHub() && x.status === 'connected');
  const now = new Map(((h && h.bcs) || []).map((b) => [b.id, b]));
  if (bcSeen && h && bcSeen.hub === h.id) {
    for (const [id, b] of now) if (!bcSeen.ids.has(id) && b.from !== chat.myId()) {
      const who = (h.members.find((m) => m.id === b.from) || {}).name || 'Someone';
      say(`${who} started broadcasting · open Share to watch`);
    }
  }
  bcSeen = { hub: h ? h.id : '', ids: new Set(now.keys()) };
}
// Sharing (the Hub tab) happens in a hub: the hub hears this PC's watch-together code, what's on and who's watching, and
// everyone in it gets a Join button in the chat. liveHub is the hub the current share was started in.
let liveHub = '', liveSent = '', joinedCode = '';
// The hub the watch-together session belongs to: the one this PC shares into, or the one whose card it joined from.
function sessionHub() {
  if (!chat || p2p.role() === 'off') return '';
  if (p2p.role() === 'host') return liveHub;
  const h = chat.info().hubs.find((x) => (x.lives || []).some((l) => l.code === joinedCode));
  return h ? h.id : '';
}
// Where a new message from `hub` goes over what you're watching from it: the monitor showing its watch-together video, its
// Surf stream or a broadcast in it ({ win }; the focused one first when several do), else, while you broadcast into it, the
// overlay over what you're showing ({ game }: games too). null: nothing of that hub's is on, so it's a note at the top.
function overFor(hub) {
  if (!chat || !hub) return null;
  const keys = [], add = (k) => { const v = k && visWins.find((x) => x.key === k && !x.win.isDestroyed()); if (v && !keys.includes(v)) keys.push(v); };
  if (bcScene && bcScene.hub === hub) add(bcSceneKey());
  const sh = surfHub();
  if (sh && sh.id === hub && surfMode() !== 'own') { const sv = surfView(); if (sv.open) add(sv.key); }
  if (hub === sessionHub()) {
    for (const v of visWins) if (showsVideo(v.key)) add(v.key);
    if (!keys.length) { const f = BrowserWindow.getFocusedWindow(); add((visWins.find((x) => x.win === f) || visWins[0] || {}).key); }       // (music only: any screen)
  }
  const f = BrowserWindow.getFocusedWindow(), win = keys.find((v) => v.win === f) || keys[0];
  if (win) return { win };
  const mine = chat.info().bc.mine;
  return bcWin && mine && mine.hub === hub ? { game: true } : null;
}
// Messages over what you're broadcasting, in the pointer overlay (bcOvSync): it's on top of everything, games too, and kept
// out of the capture, so viewers don't see them twice. The panel's setting decides which, as over the video (renderer/chat.js).
let bcMsgs = [], bcMsgTimer = null;
const bcPics = new Map(), bcPicsSent = new Set();       // picture id -> data: URL ('' while it's fetched), for messages on the overlay; and which the overlay window has
function bcMsgAdd(hub, msg) {
  const set = state.share.overlay, I = chat.info(), me = I.me.id;
  if (set === 'off') return;
  const heard = msg.from !== me && I.call && I.call.hub === hub && (I.call.peers || []).includes(msg.from) && ((I.hubs.find((x) => x.id === hub) || {}).voice || []).some((v) => v.id === msg.from && v.talk && v.mic);
  if (set === 'unheard' && heard) return;
  const h = I.hubs.find((x) => x.id === hub), c = h && h.channels.find((y) => y.id === msg.ch);
  bcMsgs = [...bcMsgs, { id: String(msg.id), from: String(msg.from), name: msg.from === me ? (I.me.name || 'You') : memberName(hub, msg.from), ch: h && h.channels.length > 1 && c ? c.name : '',
    text: String(msg.text || '').slice(0, 600), pic: msg.file ? { id: String(msg.file.id), w: +msg.file.w || 1, h: +msg.file.h || 1, gif: msg.file.mime === 'image/gif' } : null, at: Date.now() }].slice(-6);
  // its picture or GIF: fetched from the hub once (chat.js keeps it), and handed to the overlay window once (bcOvSync)
  if (msg.file && !bcPics.has(String(msg.file.id))) {
    const id = String(msg.file.id);
    bcPics.set(id, '');
    chat.file(hub, id).then((r) => { if (r && !r.error && bcPics.has(id)) { bcPics.set(id, `data:${r.mime};base64,${r.data.toString('base64')}`); bcOvSync(); } }, () => {});
  }
  if (msg.from !== me) sfxPlay(['message']);
  bcMsgTick();
  bcOvSync();
}
function bcMsgTick() {       // each one stays 12 s; the overlay hides once nothing is left on it
  clearTimeout(bcMsgTimer);
  const now = Date.now(), n = bcMsgs.length;
  bcMsgs = bcMsgs.filter((x) => now - x.at < 13000);
  if (bcMsgs.length !== n) bcOvSync();
  if (bcMsgs.length) bcMsgTimer = setTimeout(bcMsgTick, 1000);
}
function shareTitle() {
  const c = cur();
  return c && visWins.some((v) => showsVideo(v.key)) ? c.name : state.music.source === 'files' && state.music.playing && nowPlaying.title ? nowPlaying.title : 'nothing yet';
}
function syncLive() {
  if (!chat) return;
  const p = p2p.info();
  // reach: can friends elsewhere get to this PC (p2p.js openInternet)? 'internet' yes; 'lan' no, only those on this network can
  // (or so it turned out: someone couldn't, mediaRefused); 'manual' couldn't be checked. The hub uses it to keep the share off
  // the stream while someone online couldn't watch it (hub.js "reach").
  const reach = p.reach === 'manual' && mediaUnreached.has(liveHub) ? 'lan' : p.reach || 'lan';
  const live = p.role === 'host' && liveHub && p.code && !p.settling ? { code: p.code, title: shareTitle(), watching: (p.peers || []).map((x) => x.name).slice(0, 8), reach } : null;
  const key = JSON.stringify([liveHub, live]);
  if (key === liveSent) return;
  liveSent = key;
  chat.announce(live ? liveHub : '', live);
  if (!live && p.role !== 'host') liveHub = '';
}
// A hub's media stream: playing your own video or music while you're online in a hub shares it there, and a hub
// streams one at a time. With nothing on, it's shared straight away. While someone else's is on, everyone online
// votes (a card over the video, drawn by renderer/chat.js; the hub counts, see hub.js "the media stream"): if more than half
// agree, theirs stops and yours goes on. Everyone online in the hub watches what's on, by themselves. Not wanting to
// watch means disconnecting from the hub: that leaves the stream too. Leave (or Stop sharing) skips the share that's on;
// the next thing put on pulls you back in. (The hub stamps each share with when it started, `since`, on its own clock:
// if two are ever listed, the newest is the stream.)
let mediaTried = '', mediaIn = '';       // mediaTried: the code of the last share this PC joined (never joined again by itself); mediaIn: the hub of this PC's session
const mediaNewer = (a, b) => a.since > b.since || (a.since === b.since && a.from > b.from);
const mediaTop = (h) => ((h && h.lives) || []).reduce((a, l) => (!a || mediaNewer(l, a) ? l : a), null);
// The hub the stream is in: your active hub, else the first one you're online in.
function mediaHub() {
  const up = chat ? chat.info().hubs.filter((x) => x.status === 'connected') : [];
  return up.find((x) => x.id === activeHub()) || up[0] || null;
}
async function mediaShare() {
  const h = mediaHub();
  if (!h || p2p.role() === 'host') return;       // not online in a hub (just play it here), or already sharing (the session plays it)
  liveHub = h.id; mediaIn = h.id;
  await p2p.share({ port: state.share.port, internet: state.share.internet, wait: state.share.wait, name: shareName(), local: !!process.env.DRIFT_SHARE_LOCAL });
}
// The hub didn't list this PC's share, or took it off: someone else's came first, or someone online can't reach this PC, whose
// router doesn't let friends in (hub.js "reach"). Then it isn't shared at all, so nobody is left looking at something the others
// can't get: it plays here only, and the Media tab says why (mediaSolo) until something of this PC's is on the stream again.
let mediaSolo = null;       // { hub, text }
const mediaUnreached = new Set();       // hubs where someone couldn't connect to this PC's share: its port turned out to be closed
function mediaRefused(hub, m) {
  const why = String(m.why || ''), p = p2p.info();
  liveHub = ''; p2p.stop();
  if (why !== 'reach' && why !== 'unreached') { say('Someone else put something on first'); return; }
  if (why === 'unreached') mediaUnreached.add(hub);
  const who = (Array.isArray(m.who) ? m.who : []).map((n) => String(n || '').replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 24)).filter(Boolean).slice(0, 3);
  const names = who.length ? who.join(', ') : 'Someone in the hub', one = who.length === 1;
  const fix = state.share.internet === false ? 'Sharing over the internet is off in Options, so only people on this network can watch.'
    : /shares one address/.test(p.note || '') ? 'Your internet provider shares one address between several homes, so nobody outside can connect to this PC. A VPN such as Tailscale on both PCs gets round it.'
    : `Your router doesn't let friends in by itself: forward TCP port ${p.port || state.share.port || 47800} to this PC in the router's settings, or turn on UPnP there.`;
  mediaSolo = { hub, text: `Not shared to the hub: ${names} ${why === 'unreached' ? 'couldn\'t connect' : one ? 'isn\'t on your network and can\'t reach' : 'aren\'t on your network and can\'t reach'} this PC, so what you play stays here. ${fix}` };
  say(`Playing for you only: ${names} can't reach this PC`);
  pushState();
}
// Playing something of your own while watching someone else's: leave theirs (it isn't joined again), then share yours.
async function mediaOwn() { if (remote) { mediaTried = joinedCode; await p2p.stop(); } }
// Something picked to play (`go` plays it here). With nothing else on in the hub, or no hub, it plays and is shared now.
// While someone else's is on, the hub asks everyone first; the pick waits (mediaPending) and plays only if the vote passes.
let mediaPending = null, mediaBusy = false;       // mediaPending: { hub, go }, this PC's pick, waiting on its vote; mediaBusy: putting a pick on now
async function mediaPlay(title, go) {
  const now = async () => { mediaBusy = true; try { await mediaOwn(); await go(); await mediaShare(); } finally { mediaBusy = false; } };
  const h = mediaHub(), t = mediaTop(h);
  if (!h || !t || t.from === chat.myId() || (p2p.role() === 'host' && liveHub === h.id)) return now();
  if (mediaPending) { say('Your vote is still going'); return; }
  mediaPending = { hub: h.id, go: now };       // (set before asking: the result can arrive right behind the answer)
  const r = await chat.mediaAsk(h.id, title);
  if (r.error || r.free) { mediaPending = null; if (r.error) say(r.error); else await now(); }
}
const mediaName = (f) => path.basename(String(f || '')).replace(/\.[^.]+$/, '');
// A vote from the hub: open (the panels draw it over the video) or decided.
function onMediaVote(hub, v) {
  if (!v.result) return;
  const h = chat.info().hubs.find((x) => x.id === hub), who = ((h && h.members.find((m) => m.id === v.from)) || {}).name || 'Someone';
  if (v.from === chat.myId()) {
    const p = mediaPending && mediaPending.hub === hub ? mediaPending : null;
    mediaPending = null;
    if (!p) return;
    if (v.result === 'yes') p.go();
    else if (v.result === 'no') say('Everyone wants to keep watching what\'s on');
    else if (v.result === 'time') say('Not enough people agreed in time');
    return;
  }
  if (v.result !== 'yes') return;
  if (p2p.role() === 'host' && liveHub === hub) { liveHub = ''; p2p.stop(); }       // ours was on: it gives way
  say(`Switching to ${who}'s ${v.title || 'pick'}`);
}
function mediaCheck() {
  if (!chat) return;
  const me = chat.myId(), role = p2p.role(), hubs = chat.info().hubs;
  if (role === 'off') mediaIn = '';
  else if (role === 'host' && liveHub) mediaIn = liveHub;
  else { const sh = sessionHub(); if (sh) mediaIn = sh; }
  if (mediaSolo && (hubs.find((x) => x.id === mediaSolo.hub) || {}).status !== 'connected') { mediaSolo = null; pushState(); }       // (off that hub: its stream is nothing to do with what plays here)
  if (mediaIn && (hubs.find((x) => x.id === mediaIn) || {}).status === 'away') {       // disconnected from the hub: off the stream
    mediaTried = joinedCode; mediaIn = ''; liveHub = '';
    p2p.stop();
    return;
  }
  if (role === 'host' && liveHub) {
    const h = hubs.find((x) => x.id === liveHub), mine = h && (h.lives || []).find((l) => l.from === me), t = mediaTop(h);
    if (mine && mediaSolo && mediaSolo.hub === liveHub) { mediaSolo = null; pushState(); }       // on the stream after all
    if (mine && t && t.from !== me) {       // someone put something else on: stop ours, and watch theirs
      const who = (h.members.find((m) => m.id === t.from) || {}).name || 'Someone';
      liveHub = '';
      p2p.stop().then(mediaCheck);
      say(`${who} put on ${t.title || 'something else'}`);
    }
    return;
  }
  const h = mediaHub(), t = mediaTop(h);
  if (!t || t.from === me || t.code === mediaTried || (role === 'guest' && t.code === joinedCode)) return;
  mediaTried = t.code; joinedCode = t.code; mediaIn = h.id;
  const go = () => p2p.join(t.code, shareName()).then((r) => { if (!r.ok) say(r.error); });
  if (role === 'guest') p2p.stop().then(go); else go();
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
// ---- GIF search (the GIF button in the Hub tab): GIPHY, with the user's own API key (Options) ----
// Only the PC searching talks to GIPHY. The GIF picked is downloaded here and sent through the hub like any picture, so
// friends' PCs never reach GIPHY, and nothing in a message is ever a link to fetch.
const GIF_HOST = /^https:\/\/(media\d*|i)\.giphy\.com\//;
async function gifSearch(q) {
  const key = state.gif && state.gif.key;
  if (!key) return { error: 'nokey' };
  const u = new URL(q ? 'https://api.giphy.com/v1/gifs/search' : 'https://api.giphy.com/v1/gifs/trending');
  u.search = new URLSearchParams({ api_key: key, limit: '30', rating: 'pg-13', bundle: 'messaging_non_clips', ...(q ? { q } : {}) });
  let j = null;
  try {
    const r = await net.fetch(u.href, { signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) return { error: 'GIPHY didn\'t accept that API key.' };
    if (!r.ok) return { error: `GIPHY answered ${r.status}.` };
    j = await r.json();
  } catch (e) { return { error: 'Couldn\'t reach GIPHY: ' + (e && e.message || e) }; }
  const out = [];
  for (const g of (j && Array.isArray(j.data) ? j.data : [])) {
    const im = g && g.images, pv = im && (im.fixed_width_small || im.fixed_width), big = im && (im.downsized || im.fixed_width);
    if (!pv || !big || !GIF_HOST.test(String(pv.url)) || !GIF_HOST.test(String(big.url))) continue;
    out.push({ title: String(g.title || '').slice(0, 100), preview: String(pv.webp && GIF_HOST.test(pv.webp) ? pv.webp : pv.url), url: String(big.url), w: +big.width || 1, h: +big.height || 1 });
  }
  return { gifs: out };
}
async function gifFetch(url) {
  if (!GIF_HOST.test(url)) return { error: 'That isn\'t a GIPHY GIF.' };
  try {
    const r = await net.fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { error: `GIPHY answered ${r.status}.` };
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > require('./hub').LIMITS.file ? { error: 'That GIF is too big to send.' } : b;
  } catch (e) { return { error: 'Couldn\'t fetch that GIF: ' + (e && e.message || e) }; }
}
const CHAT_OPS = {
  info: () => chatInfo(),
  join: async (code) => {       // a hub's invite, or (from before the Hub tab and Chat were one) a friend's watch-together code
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
  react: (hub, id, e, on) => chat.react(String(hub), +id, String(e || '').slice(0, 32), !!on),
  // a picture or GIF from this PC (pasted, dropped or picked): its bytes, as the panel read them
  sendFile: (hub, ch, bytes, w, h, text, reply) => chat.sendFile(String(hub), +ch, Buffer.from(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer ? bytes : []), +w || 1, +h || 1, String(text || ''), +reply || undefined),
  file: async (hub, id) => { const r = await chat.file(String(hub), String(id || '')); return r.error ? r : { data: `data:${r.mime};base64,${r.data.toString('base64')}` }; },
  gifSearch: (q) => gifSearch(String(q || '').slice(0, 100)),
  gifSend: async (hub, ch, url, w, h, reply) => { const b = await gifFetch(String(url || '')); return b.error ? b : chat.sendFile(String(hub), +ch, b, +w || 1, +h || 1, '', +reply || undefined); },
  typing: (hub, ch) => chat.typing(String(hub), +ch),
  channel: (hub, name) => chat.channel(String(hub), String(name || '')),
  dropChannel: (hub, ch) => chat.dropChannel(String(hub), +ch),
  invite: async (hub) => { const r = await chat.invite(String(hub)); if (r.code) clipboard.writeText(r.code); return r; },
  withdrawInvites: (hub) => chat.withdrawInvites(String(hub)),
  removeMember: (hub, member) => chat.removeMember(String(hub), String(member || '')),
  mediaVote: (hub, id, yes) => chat.mediaVote(String(hub || ''), String(id || ''), !!yes),       // a vote to change what's on
  mediaCancel: (hub, id) => chat.mediaCancel(String(hub || ''), String(id || '')),
  block: (member, on) => chat.block(String(member || ''), !!on),
  paste: () => clipboard.readText().slice(0, 400),
  setAvatar: (data) => chat.setAvatar(String(data || '').slice(0, 20000)),
  avatar: (hub, member, av) => chat.avatar(String(hub), String(member || ''), String(av || '')),
  mic: (on) => chat.setMic(!!on),
  // the hub open in the Hub tab: your active hub, unless one is pinned. A different active hub starts out of its voice room
  voiceHub: (hub) => { const was = activeHub(); voiceSel = String(hub || ''); if (activeHub() !== was) leaveVoice(); syncVoice(); return {}; },
  disconnect: (hub) => chat.disconnect(String(hub || '')),
  reconnect: (hub) => { if (String(hub || '') === activeHub()) leaveVoice(); return chat.reconnect(String(hub || '')); },
  safety: (hub, member) => chat.safety(String(hub || ''), String(member || '')),
  verify: (hub, member, on) => chat.setVerified(String(hub || ''), String(member || ''), !!on),
  // Broadcast (docs/plans/broadcast.md §5). The page never names a source itself: it picks one of the ids bcSources
  // just listed, and main.js keeps which one (§3), so only that one can ever be handed to a capture.
  bcSources: () => bcSources(),
  bcStart: (id) => bcStart(String(id || '')),
  bcStop: () => { bcSource = null; bcClose(); return chat.bcStop(); },
  bcSwitch: (id) => bcSwitch(String(id || '')),
  bcPause: (on) => bcPause(!!on),
  bcHide: (member, on) => bcHide(String(member || ''), !!on),       // the broadcaster hides one viewer's pointer (§9.3)
  bcLive: () => bcLiveInfo(),
  // The Broadcast scene on monitor `key` (§5): its grid of stills comes up there, or goes (Scenes, Media or Surf was picked there)
  bcOpen: (hub, key) => bcSceneOpen(String(hub || ''), String(key || '')),
  bcClose: () => bcSceneClose(),
  // Watch: play one in the scene, filling the screen (`full`) or in its tile. bcFull('') is Back to the grid.
  bcWatch: (hub, id, key, full) => bcWatchOn(String(hub || ''), String(id || ''), String(key || ''), !!full),
  bcFull: (id) => bcFull(String(id || '')),
  bcUnwatch: (id) => bcUnwatchOp(String(id || '')),
  bcStill: (id) => (bcThumbs.get(String(id || '')) || {}).img || '',       // a tile's latest still (the scene's state only says when it changed)
  // Preview: your own broadcast, live and silent, in your tile: the screen window on monitor `key` may capture exactly the
  // source you're sending (the picture, no sound), once, in the next 10 s. It never leaves this PC.
  bcPreview: (key) => { const v = visWins.find((x) => x.key === key && !x.win.isDestroyed()); if (!v || !bcSource || !chat.info().bc.mine) return { ok: false }; bcPreviewFor = { wc: v.win.webContents, until: Date.now() + 10000 }; return { ok: true, src: bcSource.id }; },
  bcCursor: (id, on) => bcCursor(String(id || ''), !!on),       // share my cursor with this broadcast (opt-in, per broadcast)
  bcHostStop: (hub, id) => chat.bcHostStop(String(hub || ''), String(id || '')),
};

// ---- broadcast: the broadcaster (docs/plans/broadcast.md §3, §5, §7) ---------------------------------------
// The Share tab lists each monitor and each application window, with thumbnails, and nothing is captured until Go
// live. Drift's own windows are left out of Applications. bcSource is the one picked for the live broadcast: the
// broadcast window's getDisplayMedia is answered with exactly that source and nothing else (see
// setDisplayMediaRequestHandler). The window lives only while you're live, so the capture can't outlive the broadcast.
let bcSource = null, bcListed = new Map();
async function bcSources() {
  const own = new Set(BrowserWindow.getAllWindows().map((w) => { try { return w.getMediaSourceId(); } catch { return ''; } }));
  const src = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcon: true });
  const covered = new Set(visWins.filter((v) => !v.win.isDestroyed()).map((v) => String(screen.getDisplayMatching(v.win.getBounds()).id)));       // monitors Drift is showing on
  const displays = screen.getAllDisplays();
  bcListed = new Map();
  const out = { screens: [], apps: [] };
  for (const x of src) {
    if (x.id.startsWith('window:') && (own.has(x.id) || !x.name || x.thumbnail.isEmpty())) continue;       // Drift's own, or a window with nothing to show (minimised)
    const kind = x.id.startsWith('screen:') ? 'screen' : 'window';
    const i = kind === 'screen' ? displays.findIndex((d) => String(d.id) === String(x.display_id)) : -1;
    const title = kind === 'screen' ? `Screen ${i >= 0 ? i + 1 : out.screens.length + 1}` : x.name.slice(0, 80);
    const thumb = x.thumbnail.toDataURL();
    bcListed.set(x.id, { id: x.id, kind, title, display: kind === 'screen' ? String(x.display_id) : '', thumb });
    const item = { id: x.id, title, thumb, icon: x.appIcon && !x.appIcon.isEmpty() ? x.appIcon.resize({ width: 16, height: 16 }).toDataURL() : '' };
    if (kind === 'screen') out.screens.push({ ...item, drift: covered.has(String(x.display_id)) }); else out.apps.push(item);
  }
  out.screens.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return out;
}
async function bcStart(id) {
  const s = bcListed.get(id);
  if (!s) return { error: 'Pick a screen or an application first.' };
  const hub = activeHub(), h = chat.info().hubs.find((x) => x.id === hub);
  if (!h || !h.room.in) return { error: 'Connect to a hub in the Hub tab to share your screen.' };
  const r = await chat.bcStart(hub, { title: s.title, kind: s.kind, audio: !!state.broadcast.sound && bcSoundCan });
  if (r.error) return r;
  if (!r.iceServers.length && !state.voice.direct) {       // as voice: without the relay, viewers would learn this PC's address
    chat.bcStop();
    return { error: 'This hub\'s relay isn\'t running, so a broadcast can\'t keep your address private. Turn on "Connect directly" under Voice in Options to broadcast without it.' };
  }
  bcSource = s;
  bcOpen(r.iceServers);
  return { id: r.id, source: { id: s.id, title: s.title, kind: s.kind } };
}
// Switch source while live: capture the new one and swap it in (replaceTrack), so nobody watching drops.
async function bcSwitch(id) {
  const s = bcListed.get(id);
  if (!chat.info().bc.mine || !bcWin) return { error: 'You aren\'t broadcasting.' };
  if (!s) return { error: 'Pick a screen or an application first.' };
  const r = await chat.bcUpdate({ title: s.title, kind: s.kind });
  if (r.error) return r;
  bcSource = s; bcRect = null; bcFollow(); bcOvSync();
  toBc({ t: 'switch' });
  bcSoundSync();
  if (state.broadcast.sound) chat.bcUpdate({ audio: bcSoundWanted() });       // (a new program to listen to gets a fresh try)
  bcPush();
  return {};
}
function bcPause(on) { if (!bcWin) return { error: 'You aren\'t broadcasting.' }; bcPaused = on; toBc({ t: 'pause', on }); bcPush(); return {}; }
function bcHide(member, on) { if (on) bcHidden.add(member); else bcHidden.delete(member); bcOvSync(); bcPush(); return {}; }

let bcWin = null, bcUp = false, bcQueue = [], bcIce = [], bcStats = null, bcPaused = false, bcPtrs = [], bcPeers = {};
const bcHidden = new Set();       // viewers whose pointer the broadcaster hid
const toBc = (m) => { if (!bcWin) return; if (bcUp && !bcWin.isDestroyed()) bcWin.webContents.send('bc-send', m); else bcQueue.push(m); };
function bcOpen(ice) {
  bcClose();
  bcIce = ice; bcPaused = false; bcStats = null; bcPtrs = []; bcPeers = {}; bcHidden.clear();
  bcQueue = [{ t: 'start', policy: state.voice.direct ? 'all' : 'relay', quality: state.broadcast.quality, test: !!process.env.DRIFT_TESTBROADCAST }];
  const w = bcWin = new BrowserWindow({ show: false, width: 240, height: 120, skipTaskbar: true, title: 'Drift broadcast',
    webPreferences: { preload: path.join(__dirname, 'bc-send-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  w.webContents.setAudioMuted(true);       // (it only sends)
  w.on('closed', () => { if (bcWin === w) { bcWin = null; bcUp = false; bcQueue = []; } });
  w.loadFile(path.join(__dirname, 'renderer', 'bc-send.html')).catch(() => {});
  bcFollow(); bcSoundFail = ''; bcSoundSync();
  micLight(); bcPush();
}
function bcClose() {
  const w = bcWin, had = !!w;
  bcWin = null; bcUp = false; bcQueue = []; bcStats = null; bcPtrs = []; bcPeers = {}; bcRect = null;
  bcFollow(); bcOvSync(); bcSoundSync();
  if (w && !w.isDestroyed()) w.destroy();       // the capture goes with it
  if (had) { micLight(); bcPush(); }
}
// What the Share tab and the hub bar show while you're live.
function bcLiveInfo() {
  if (!bcWin || !bcSource) return null;
  return { source: { id: bcSource.id, title: bcSource.title, kind: bcSource.kind }, thumb: bcSource.thumb || '', paused: bcPaused, stats: bcStats, peers: bcPeers,
    pointers: !!state.broadcast.pointers, hidden: [...bcHidden], ptrs: bcPtrs.map((p) => p.id), sound: bcSoundState() };
}
let bcPushed = '';
function bcPush() {
  const live = bcLiveInfo(), k = JSON.stringify(live);
  if (k === bcPushed) return;
  bcPushed = k;
  broadcast('chat', { type: 'bclive', live }, false);
  sfxTick();
}
ipcMain.on('bc-send', (e, type, d) => {
  if (!bcWin || bcWin.isDestroyed() || e.sender !== bcWin.webContents) return;
  if (type === 'log') { chatLog('broadcast: ' + String(d).slice(0, 300)); return; }
  const mine = chat.info().bc.mine;
  if (type === 'hello') { bcUp = true; for (const m of bcQueue.splice(0)) bcWin.webContents.send('bc-send', m); return; }
  if (type === 'ended') {       // the window closed, or the source couldn't be captured
    say(d === 'capture' ? 'Drift couldn\'t capture what you picked, so the broadcast stopped.' : `${bcSource ? bcSource.title : 'What you were showing'} closed, so the broadcast stopped.`);
    bcSource = null; bcClose(); chat.bcStop(); return;
  }
  if (!mine) return;
  if (type === 'signal' && d && typeof d === 'object') chat.bcSignal(mine.id, String(d.to || ''), d.d);
  else if (type === 'cert' && d && typeof d === 'object') chat.bcCert(mine.id, String(d.peer || ''), String(d.alg || ''), String(d.fp || ''));       // a mismatch comes back as bc-verdict and closes it
  else if (type === 'peer' && d && typeof d === 'object') { if (d.state) bcPeers[String(d.id)] = String(d.state); else delete bcPeers[String(d.id)]; bcPush(); }
  else if (type === 'stats' && d && typeof d === 'object') {
    const was = bcStats;
    bcStats = { fps: +d.fps || 0, kbps: +d.kbps || 0, encoder: String(d.encoder || '').slice(0, 60), hardware: d.hardware === null ? null : !!d.hardware, viewers: +d.viewers || 0, stalled: !!d.stalled, slow: !!d.slow, size: String(d.size || '').slice(0, 20) };
    if (bcStats.slow && !(was && was.slow) && bcSource && bcSource.kind === 'window') say('The picture nearly stopped (this happens when a window is resized). Press Switch source and pick it again.');
    bcPush();
  } else if (type === 'ptrs') { bcPtrs = (Array.isArray(d) ? d : []).slice(0, 8).filter((p) => p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1).map((p) => ({ id: String(p.id), x: +p.x, y: +p.y })); bcOvSync(); bcPush(); }
  else if (type === 'ping' && d && typeof d === 'object' && d.x >= 0 && d.x <= 1 && d.y >= 0 && d.y <= 1) bcOvSync({ id: String(d.id), x: +d.x, y: +d.y });
  else if (type === 'thumb' && d && typeof d === 'object') {       // a still of what's being sent, every 10 s: a sharp one, and a small one for an older hub
    const still = (x, most) => (typeof x === 'string' && x.length <= most && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(x) ? x : '');
    const small = still(d.small, 14000), big = still(d.big, require('./hub').LIMITS.bcThumb) || small;
    if (!small) return;
    bcThumbs.set(mine.id, { img: big, at: Date.now() }); chat.bcThumb(big, small);       // for our own tile, and (signed) for everyone else's grid
    if (bcSource) bcSource.thumb = small;       // the Share tab's preview of it (small: it goes with each second's numbers)
    bcPush();
    if (bcScene) pushState();
  }
});

// ---- the broadcast's sound (§8, spike A; bc-sound.js): Windows' process loopback, through a helper. For an
// application, only the sound of the process that owns its window (and its children); for a whole screen, everything
// the PC plays except Drift itself, so the voice room isn't sent back to the people in it. The PCM goes to the broadcast
// window in 20 ms pieces, which turns it into the broadcast's audio track. The helper runs only while you're live with
// Sound on, and is restarted when Switch source changes what to listen to. ----
const bcSound = require('./bc-sound');
const bcSoundCan = process.platform === 'win32';
let bcSnd = null, bcSoundFail = '', bcSoundBuf = [], bcSoundLen = 0;       // bcSnd: { key, h, ready }; bcSoundFail: the key that failed (not retried)
const bcSoundWanted = () => bcSoundCan && !!state.broadcast.sound && bcSoundFail !== bcSoundKey();
function bcSoundKey() {
  if (!bcWin || !bcSource || !state.broadcast.sound) return '';
  if (bcSource.kind === 'window') { const m = /^window:(\d+):/.exec(bcSource.id); return m ? 'w' + m[1] : ''; }
  return 'x' + process.pid;
}
function bcSoundState() {
  if (!state.broadcast.sound) return 'off';
  if (!bcSoundCan || (bcSoundFail && bcSoundFail === bcSoundKey())) return 'failed';
  return bcSnd && bcSnd.ready ? 'on' : 'starting';
}
function bcSoundSync() {
  const key = bcSoundKey(), want = key && key !== bcSoundFail && bcSoundCan;
  if (bcSnd && bcSnd.key === key && want) return;
  if (bcSnd) { bcSnd.h.stop(); bcSnd = null; toBc({ t: 'sound', on: false }); }
  bcSoundBuf = []; bcSoundLen = 0;
  if (!want) return;
  const what = key[0] === 'w' ? { hwnd: +key.slice(1) } : { pid: process.pid, exclude: true };
  const me = bcSnd = { key, ready: false, h: null };
  me.h = bcSound.start(what, {
    onReady: () => { if (bcSnd !== me) return; me.ready = true; chatLog(`broadcast: sound from ${key[0] === 'w' ? 'the application' : 'the PC, without Drift'}`); toBc({ t: 'sound', on: true }); bcPush(); },
    onPcm: (d) => {
      if (bcSnd !== me || !bcUp || !bcWin || bcWin.isDestroyed()) return;
      bcSoundBuf.push(d); bcSoundLen += d.length;
      if (bcSoundLen < 3840) return;       // 20 ms at a time
      const all = Buffer.concat(bcSoundBuf, bcSoundLen); bcSoundBuf = []; bcSoundLen = 0;
      bcWin.webContents.send('bc-send', { t: 'pcm', d: new Uint8Array(all.buffer, all.byteOffset, all.length) });
    },
    onEnd: (why) => {
      if (bcSnd !== me) return;
      bcSnd = null; bcSoundFail = key;
      chatLog('broadcast: sound stopped: ' + String(why).slice(0, 200));
      toBc({ t: 'sound', on: false });
      if (chat.info().bc.mine) chat.bcUpdate({ audio: false });
      say(/unsupported|type/.test(why) ? "This version of Windows can't capture one program's sound, so your broadcast has no sound. It needs Windows 11, or a recent Windows 10."
        : /window|process/.test(why) ? "Drift couldn't find the program behind that window, so your broadcast has no sound."
          : "Your broadcast's sound stopped. The picture carries on. Turn Sound off and on again to retry.");
      bcPush();
    },
  });
}

// ---- viewers' pointers on the broadcaster's real screen (§9.2): one transparent, click-through, topmost window over
// what's being shown, kept out of every capture (setContentProtection gives WDA_EXCLUDEFROMCAPTURE: spike E), so the
// pointers aren't baked into the stream as well. It's shown only while a pointer is. For a window, a small helper
// follows where it is (DWMWA_EXTENDED_FRAME_BOUNDS, ten times a second) and whether it's minimised. ----
let bcOv = null, bcOvUp = false, bcOvLast = null, bcRect = null, bcFollowProc = null;
const memberName = (hubId, id) => { const h = chat && chat.info().hubs.find((x) => x.id === hubId); return ((h && h.members.find((m) => m.id === id)) || {}).name || 'Someone'; };
const followScript = (hwnd) => [
  'Add-Type -TypeDefinition @\'',
  'using System; using System.Runtime.InteropServices;',
  'public static class D {',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }',
  '  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);',
  '}',
  '\'@',
  '[D]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null',
  `$h = [IntPtr]${hwnd}`,
  'while ([D]::IsWindow($h)) {',
  '  $r = New-Object D+RECT',
  '  [D]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null',
  '  [Console]::Out.WriteLine("$($r.L) $($r.T) $($r.R - $r.L) $($r.B - $r.T) $([D]::IsIconic($h))")',
  '  Start-Sleep -Milliseconds 100',
  '}'].join('\n');
function bcFollow() {
  if (bcFollowProc) { try { bcFollowProc.kill(); } catch { /* gone */ } bcFollowProc = null; }
  const m = bcWin && bcSource && bcSource.kind === 'window' && process.platform === 'win32' && /^window:(\d+):/.exec(bcSource.id);
  if (!m) return;
  const p = bcFollowProc = ps(followScript(m[1]), { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop();
    const l = lines.pop(); if (!l || bcFollowProc !== p) return;
    const [x, y, w, h, min] = l.trim().split(/\s+/);
    const r = min === 'True' || !(+w > 0 && +h > 0) ? null : screen.screenToDipRect(null, { x: +x, y: +y, width: +w, height: +h });
    if (JSON.stringify(r) !== JSON.stringify(bcRect)) { bcRect = r; bcOvSync(); }
  });
  p.on('error', () => { if (bcFollowProc === p) bcFollowProc = null; });
  p.on('close', () => { if (bcFollowProc === p) bcFollowProc = null; });
}
function bcTarget() {       // where what's shown is on this PC's screen, in DIPs
  if (!bcSource) return null;
  if (bcSource.kind === 'window') return bcRect;
  const d = screen.getAllDisplays().find((x) => String(x.id) === bcSource.display);
  return d ? d.bounds : null;
}
function bcOvSync(ping) {
  const mine = chat && chat.info().bc.mine, blocked = new Set(chat ? chat.info().blocked : []);
  const list = !mine || !bcWin || !state.broadcast.pointers ? [] : bcPtrs.filter((p) => !bcHidden.has(p.id) && !blocked.has(p.id)).map((p) => ({ ...p, name: memberName(mine.hub, p.id) }));
  const r = bcTarget(), pin = ping && mine && state.broadcast.pointers && !bcHidden.has(ping.id) && !blocked.has(ping.id) ? { ...ping, name: memberName(mine.hub, ping.id) } : null;
  if (!mine || !bcWin) bcMsgs = [];
  const msgs = bcMsgs.map((x) => ({ ...x, old: Date.now() - x.at > 12000 }));
  for (const id of [...bcPics.keys()]) if (!bcMsgs.some((x) => x.pic && x.pic.id === id)) { bcPics.delete(id); bcPicsSent.delete(id); }       // its message has gone from the overlay
  bcOvLast = { list, ping: pin, rect: r, msgs };       // (tests read it)
  if ((!list.length && !pin && !msgs.length) || !r) {
    if (bcOv && !bcOv.isDestroyed()) { if (!bcWin) { bcOv.destroy(); bcOv = null; } else if (bcOv.isVisible()) bcOv.hide(); }
    return;
  }
  if (!bcOv || bcOv.isDestroyed()) {
    bcOvUp = false; bcPicsSent.clear();
    const w = bcOv = new BrowserWindow({ show: false, transparent: true, frame: false, focusable: false, skipTaskbar: true, resizable: false, hasShadow: false, alwaysOnTop: true, title: 'Drift pointers',
      webPreferences: { preload: path.join(__dirname, 'bc-overlay-preload.js'), sandbox: true, contextIsolation: true } });
    w.setIgnoreMouseEvents(true);       // every click goes straight through to what's underneath
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setContentProtection(true);       // kept out of the capture
    w.webContents.once('did-finish-load', () => { if (bcOv === w) { bcOvUp = true; bcOvSync(); } });
    w.loadFile(path.join(__dirname, 'renderer', 'bc-overlay.html')).catch(() => {});
  }
  const b = bcOv.getBounds();
  if (b.x !== r.x || b.y !== r.y || b.width !== r.width || b.height !== r.height) bcOv.setBounds(r);
  if (bcOvUp) {
    const pics = {};       // only the pictures it doesn't have yet: a GIF can be megabytes, and this is sent whenever a pointer moves
    for (const [id, d] of bcPics) if (d && !bcPicsSent.has(id)) { pics[id] = d; bcPicsSent.add(id); }
    bcOv.webContents.send('bc-overlay', { list, ping: pin, msgs, pics });
  }
  if (!bcOv.isVisible() && !process.env.DRIFT_HIDDEN) bcOv.showInactive();
}

// ---- broadcast: watching (§5, §6; changed 2026-11-23). The Broadcast scene: picking the Share tab on a monitor turns it
// into a black grid of everyone broadcasting in the hub, each a still (a signed picture the broadcaster sends every 10 s) until
// it's watched. Watch fills the screen with one; Back goes to the grid, where it plays on in its tile; with more than one up,
// any of them can play in its tile at once. Each one watched is its own connection, set up in that screen's window
// (renderer/app.js #bcView) from SDPs chat.js has checked. Nothing plays by itself. Your cursor is shared only with broadcasts
// you turned "Share my cursor" on for (opt-in, per broadcast), and only from the full-screen view. ----
let bcScene = null;       // { hub, key, full (the broadcast filling the screen, or '') } while the scene is on a monitor
const bcStreams = new Map();       // broadcast id -> { hub, bc, from, ice, policy, at, state (the connection), remote: { paused, stalled } }: each one watched
const bcThumbs = new Map();       // broadcast id -> { img, at }: the latest still of each (others' checked by chat.js; ours from the broadcast window)
let bcPreviewFor = null;       // { wc, until }: the screen window allowed to capture your broadcast's source for Preview (bcPreview)
const bcShareOn = new Set();       // broadcast ids you chose to share your cursor with (forgotten when they end)
const BC_VIEWERS = require('./hub').LIMITS.viewers;
const bcSceneKey = () => (bcScene ? screenFor(bcScene.key) : '');
function toBcScene(c) { if (!bcScene) return; const x = visWins.find((y) => y.key === bcSceneKey()); if (x && !x.win.isDestroyed()) x.win.webContents.send('cmd', c); }
const bcBye = (bc) => toBcScene({ type: 'bc-rtc', bc, d: { type: 'bye' } });
// The Share tab was picked on monitor `key`: the scene comes up there, or moves there with whatever is playing in it
function bcSceneOpen(hub, key) {
  key = screenFor(key || (visWins[0] || {}).key || '');
  const h = chat && chat.info().hubs.find((x) => x.id === hub && x.status === 'connected' && x.room && x.room.in);
  if (!h) return { error: 'Connect to a hub in the Hub tab to watch broadcasts.' };
  if (bcScene && bcScene.hub !== hub) bcSceneClose();
  if (!bcScene) bcScene = { hub, key, full: '' };
  else if (bcSceneKey() !== key) {       // the old screen lets go of each one, and the new one asks for it afresh
    for (const s of bcStreams.values()) bcBye(s.bc);
    bcScene.key = key;
    for (const s of bcStreams.values()) { s.at = 0; s.state = ''; bcAgain(s.bc); }
  }
  pushState();
  return {};
}
// Scenes, Media or Surf was picked on its monitor, or the hub went: everything watched in it stops
function bcSceneClose() {
  if (!bcScene) return {};
  for (const id of [...bcStreams.keys()]) bcUnwatchOp(id);
  bcScene = null;
  pushState();
  return {};
}
// Play one in the scene (opening it on `key` first if it isn't up), filling the screen when `full`
async function bcWatchOn(hub, id, key, full) {
  if (!bcScene || bcScene.hub !== hub || (key && screenFor(key) !== bcSceneKey())) { const o = bcSceneOpen(hub, key || (bcScene && bcScene.key)); if (o.error) return o; }
  if (!bcStreams.has(id)) {
    const r = await chat.bcWatch(hub, id);
    if (r.error) { pushState(); return r; }
    if (!bcScene || bcScene.hub !== hub) { chat.bcUnwatch(id); return {}; }       // the scene closed meanwhile
    if (!bcStreams.has(id)) bcStreams.set(id, { hub, bc: id, from: r.from, ice: r.iceServers || [], policy: state.voice.direct ? 'all' : 'relay', at: Date.now(), state: '', remote: {} });
  }
  if (full) bcScene.full = id;
  pushState();
  return {};
}
function bcFull(id) {       // fill the screen with one being watched, or ('') Back to the grid
  if (!bcScene) return {};
  bcScene.full = id && bcStreams.has(id) ? id : '';
  pushState();
  return {};
}
async function bcAgain(id) {       // a screen had no picture for a while: a fresh request, so the broadcaster makes a new offer
  const s = bcStreams.get(id);
  if (!s || Date.now() - s.at < 2500) return;
  s.at = Date.now();
  chatLog('broadcast: asking to watch again');
  const r = await chat.bcWatch(s.hub, s.bc);
  if (bcStreams.get(id) !== s) return;
  if (r.error) { bcStreamEnd(id, r.error); return; }
  s.ice = r.iceServers || s.ice;
}
function bcDrop(id) {       // its connection goes; its tile shows the still again (or goes, with the broadcast)
  if (!bcStreams.has(id)) return false;
  bcBye(id);
  bcStreams.delete(id);
  if (bcScene && bcScene.full === id) bcScene.full = '';
  return true;
}
function bcStreamEnd(id, why) {
  if (!bcStreams.has(id)) return;
  chatLog(`broadcast: stopped watching (${why || "no reason"})`);
  bcDrop(id);
  if (why) say(why);
  pushState();
}
function bcUnwatchOp(id) {
  chatLog("broadcast: stop watching pressed");
  if (bcDrop(id)) pushState();
  return chat.bcUnwatch(id);
}
const bcLevel = (from) => { const v = state.voice.volumes['bc:' + from]; return isFinite(v) ? v : 1; };       // a broadcast's sound, apart from that person's voice
function bcCursor(id, on) { if (on) bcShareOn.add(id); else bcShareOn.delete(id); pushState(); return {}; }
// The hub's list changed: stills of broadcasts that ended go, and the scene goes when you're no longer in its hub's room
function bcSceneCheck() {
  if (!chat) return;
  const I = chat.info(), live = new Set(I.hubs.flatMap((h) => (h.bcs || []).map((b) => b.id)));
  const mine = I.bc.mine;
  for (const id of [...bcThumbs.keys()]) if (!live.has(id) && !(mine && mine.id === id)) bcThumbs.delete(id);
  if (!bcScene) return;
  const h = I.hubs.find((x) => x.id === bcScene.hub);
  if (!h || h.status !== 'connected' || !(h.room && h.room.in)) bcSceneClose();
}
// What the scene's screen shows: a tile for each broadcast in the hub (yours too), and which one fills the screen
function bcViewInfo() {
  if (!bcScene || !chat) return null;
  const I = chat.info(), h = I.hubs.find((x) => x.id === bcScene.hub), me = I.me.id;
  const tiles = (h ? h.bcs || [] : []).map((b) => {
    const s = bcStreams.get(b.id), w = (I.bc.watching || []).find((x) => x.id === b.id) || {}, t = bcThumbs.get(b.id), mine = b.from === me;
    return { bc: b.id, from: b.from, mine, who: mine ? 'You' : memberName(h.id, b.from), title: b.title, kind: b.kind, audio: !!b.audio, viewers: b.viewers.length,
      crowded: !s && !mine && b.viewers.length >= BC_VIEWERS, live: !!s, state: s ? s.state : '', paused: mine ? bcPaused : !!(s && s.remote.paused), stalled: !!(s && s.remote.stalled),
      share: bcShareOn.has(b.id), verdict: w.verdict || '', bad: !!(w.refused || w.told || w.verdict === 'mismatch'), level: bcLevel(b.from), vol: bcLevel(b.from) * mixGain().master, still: t ? t.at : 0, src: mine && bcSource ? bcSource.id : '' };
  });
  return { key: bcSceneKey(), hub: bcScene.hub, host: !!(h && h.host), full: bcScene.full, tiles };
}
// From a broadcaster, over the data channel of one watched here: everyone's pointers (named here; blocked members left
// out, without telling them), pings, and whether it's paused or the picture stopped.
function onBcDc(s, m) {
  if (!m || typeof m !== 'object') return;
  const blocked = new Set(chat.info().blocked), me = chat.myId();
  const named = (q) => ({ id: String(q.id).slice(0, 64), name: memberName(s.hub, String(q.id)).replace(/[\x00-\x1f<>]/g, '').slice(0, 24), x: +q.x, y: +q.y });
  const fine = (q) => q && typeof q === 'object' && q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1 && q.id !== me && !blocked.has(String(q.id));
  if (m.t === 'ptrs') toBcScene({ type: 'bc-ptrs', bc: s.bc, list: (Array.isArray(m.list) ? m.list : []).slice(0, 8).filter(fine).map(named) });
  else if (m.t === 'ping' && fine(m)) toBcScene({ type: 'bc-ping', bc: s.bc, p: named(m) });
  else if (m.t === 'state') { const r = { paused: !!m.paused, stalled: !!m.stalled }; if (JSON.stringify(r) !== JSON.stringify(s.remote)) { s.remote = r; pushState(); } }
}
// What chat.js says about broadcasts (all of it already checked there).
function onBcEvent(hub, m) {
  const mine = chat.info().bc.mine, isMine = !!(bcWin && mine && m.bc === mine.id), s = bcStreams.get(m.bc);
  switch (m.t) {
    case 'bc-viewer': if (isMine) toBc({ t: 'viewer', id: m.id, iceServers: bcIce }); break;
    case 'bc-viewer-left': if (bcWin) toBc({ t: 'left', id: m.id }); bcHidden.delete(m.id); break;
    case 'bc-off': bcSource = null; bcClose(); break;
    case 'bc-watch-off': bcShareOn.delete(m.bc); if (s) bcStreamEnd(m.bc, m.why === 'ended' ? `${memberName(hub, s.from)} stopped broadcasting` : ''); break;
    case 'bc-thumb': bcThumbs.set(m.bc, { img: m.img, at: Date.now() }); if (bcScene && bcScene.hub === hub) pushState(); break;
    case 'bc-sdp':
      if (isMine) toBc({ t: 'sdp', from: m.from, sdp: m.sdp });
      else if (s && m.from === s.from) toBcScene({ type: 'bc-rtc', bc: m.bc, d: { type: 'offer', sdp: m.sdp.sdp, iceServers: s.ice, policy: s.policy } });
      break;
    case 'bc-candidate':
      if (isMine) toBc({ t: 'candidate', from: m.from, c: m.c });
      else if (s && m.from === s.from) toBcScene({ type: 'bc-rtc', bc: m.bc, d: { type: 'ice', c: m.c } });
      break;
    case 'bc-refused':
      if (isMine) { toBc({ t: 'left', id: m.from }); say(`Couldn't verify ${m.name}, so they can't watch. The hub may be interfering.`); }
      else if (s) { bcBye(m.bc); say(`Couldn't check that this broadcast is really from ${m.name}, so Drift won't show it. The hub may be interfering.`); pushState(); }
      break;
    case 'bc-told': say(`${m.name} couldn't verify your broadcast connection. The hub may be interfering.`); break;
    case 'bc-verdict':
      if (!m.ok) { if (isMine) toBc({ t: 'left', id: m.id }); else if (s) bcBye(m.bc); say('A broadcast connection didn\'t match its signed certificate, so it was closed. The hub may be interfering.'); }
      pushState();
      break;
    default: break;
  }
}
ipcMain.handle('chat', async (_e, op, ...args) => {
  if (!chat || !Object.hasOwn(CHAT_OPS, op)) return { error: 'Chat isn\'t ready.' };
  try { return (await CHAT_OPS[op](...args)) ?? {}; } catch (e) { return { error: String(e && e.message || e) }; }
});

// ---- the voice room ---------------------------------------------------------------------------------
// Online in a hub, with it as your active hub (the one open in the Hub tab, or the one you pinned), you can be in its voice
// room (docs/plans/broadcast.md §1). You start out of it (deaf), at every start and whenever the active hub changes or you
// come back online in it: Join voice puts you in, listening. The room lives in its own hidden window (renderer/voice.html), made
// while you listen and closed when you stop. It never opens the microphone until you press Talk. chat.js signs what
// this PC sends and checks what arrives before the window sees it; this only carries messages between the two, keeps
// the light in the tray, and watches the hold-to-talk key. voiceLive is what the panels draw: the room's hub, the
// microphone, who is speaking, each connection.
let voiceWin = null, voiceUp = false, voiceQueue = [], voiceLive = null, micTray = null, pttProc = null, voiceSel = '', voiceNote = '';
const chatInfo = () => ({ ...chat.info(), live: voiceLive, voiceNote, bcLive: bcLiveInfo() });
const pushVoice = () => broadcast('chat', { type: 'voice', live: voiceLive }, false);
function toVoice(m) {       // to the room's window; held until it has loaded
  if (!voiceLive) return;
  if (voiceUp && voiceWin && !voiceWin.isDestroyed()) voiceWin.webContents.send('voice', m); else voiceQueue.push(m);
}
// Which hub's room to be in, and how: told to chat.js whenever any of it changes.
const activeHub = () => (state.voice.pin && chat.info().hubs.some((h) => h.id === state.voice.pin) ? state.voice.pin : voiceSel);
function syncVoice() {
  if (!chat) return;
  chat.setVoice({ hub: activeHub(), listen: !state.voice.deaf, talk: state.voice.talk, mic: !!(voiceLive && voiceLive.micOk) });
}
// chat.js is in a room (and listening): open its window. Nothing is opened before Talk.
function openRoom(hub, r) {
  closeVoiceWin();
  if (!r.iceServers.length && !state.voice.direct) {
    voiceNote = 'This hub\'s voice relay isn\'t running, so voice can\'t keep your address private. Turn on "Connect directly" under Voice in Options to talk without it.';
    broadcast('chat', { type: 'info', info: chatInfo() }, false); return;
  }
  voiceNote = '';
  voiceLive = { hub, mic: 'closed', micOk: false, speaking: [], peers: {} }; voiceUp = false;
  voiceQueue.unshift({ t: 'start', me: r.me, iceServers: r.iceServers, policy: state.voice.direct ? 'all' : 'relay', tone: !!process.env.DRIFT_TESTVOICE,
    talk: state.voice.talk, ptt: state.voice.ptt, volumes: state.voice.volumes, master: mixGain().master });
  const w = voiceWin = new BrowserWindow({ show: false, width: 240, height: 120, skipTaskbar: true, title: 'Drift voice',
    webPreferences: { preload: path.join(__dirname, 'voice-preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  if (process.env.DRIFT_MUTE) w.webContents.setAudioMuted(true);
  w.on('closed', () => { if (voiceWin === w) { voiceWin = null; voiceLive = null; voiceQueue = []; pttWatch(); micLight(); pushVoice(); } });
  w.loadFile(path.join(__dirname, 'renderer', 'voice.html')).catch(() => {});
  pttWatch(); micLight(); pushVoice();
}
function closeVoiceWin() {
  const had = !!voiceLive;
  voiceLive = null; voiceUp = false; voiceQueue = [];
  const w = voiceWin; voiceWin = null;
  if (w && !w.isDestroyed()) w.destroy();       // the microphone goes with it
  if (had) { pttWatch(); micLight(); pushVoice(); }
}
// What chat.js says about the room (all of it already checked there).
function onVoiceEvent(hub, m) {
  const named = String(m.name || 'someone');
  switch (m.t) {
    case 'voice-room': openRoom(hub, m); break;
    case 'voice-room-off': closeVoiceWin(); if (voiceNote) { voiceNote = ''; broadcast('chat', { type: 'info', info: chatInfo() }, false); } if (m.why) say(m.why); break;
    case 'voice-peers': toVoice({ t: 'peers', list: m.list }); break;
    case 'voice-said': if (m.talk === false && state.voice.talk) { applyVoice({ talk: false }); pushState(); } say(m.why); break;       // e.g. too many people talking
    case 'voice-sdp': toVoice({ t: 'sdp', from: m.from, sdp: m.sdp }); break;
    case 'voice-candidate': toVoice({ t: 'candidate', from: m.from, c: m.c }); break;
    case 'voice-left': toVoice({ t: 'left', id: m.id }); if (voiceLive) { delete voiceLive.peers[m.id]; pushVoice(); } break;
    case 'voice-refused': toVoice({ t: 'close', id: m.from }); say(`Couldn't verify ${named}. The hub may be interfering.`); break;
    case 'voice-told': say(`${named} couldn't verify your connection. The hub may be interfering.`); break;
    case 'voice-verdict': if (!m.ok) { toVoice({ t: 'close', id: m.id }); say('A voice connection didn\'t match its signed certificate, so it was closed. The hub may be interfering.'); } break;
    default: break;
  }
}
ipcMain.on('voice', (e, type, d) => {
  if (!voiceWin || voiceWin.isDestroyed() || e.sender !== voiceWin.webContents) return;
  if (type === 'log') { chatLog('voice: ' + String(d).slice(0, 300)); return; }
  if (!voiceLive) return;
  switch (type) {
    case 'hello': voiceUp = true; for (const m of voiceQueue.splice(0)) voiceWin.webContents.send('voice', m); break;
    case 'signal': if (d && typeof d === 'object') chat.voiceSignal(String(d.to || ''), d.d); break;
    case 'cert': if (d && typeof d === 'object') chat.voiceCert(String(d.peer || ''), String(d.alg || ''), String(d.fp || '')); break;       // a mismatch comes back as voice-verdict and closes it
    case 'state':
      if (!d || typeof d !== 'object') break;
      Object.assign(voiceLive, { mic: ['closed', 'none', 'open', 'live'].includes(d.mic) ? d.mic : 'closed', micOk: !!d.micOk });
      syncVoice();       // the hub hears whether the microphone really opened
      micLight(); pushVoice(); break;
    case 'speaking': voiceLive.speaking = (Array.isArray(d) ? d : []).map(String).slice(0, 17); pushVoice(); break;
    case 'peer': if (d && typeof d === 'object') { if (d.state) voiceLive.peers[String(d.id)] = String(d.state); else delete voiceLive.peers[String(d.id)]; pushVoice(); } break;
    case 'failed': say('Voice couldn\'t start: ' + String(d).slice(0, 120)); closeVoiceWin(); break;
    default: break;
  }
});
function applyVoice(q) {
  const was = state.voice;
  const v = state.voice = cleanVoice({ ...was, ...q, volumes: { ...was.volumes, ...(q.volumes && typeof q.volumes === 'object' ? q.volumes : {}) } });
  if (v.deaf) v.talk = false;       // not listening: not talking either
  if (v.talk !== was.talk) toVoice({ t: 'talk', on: v.talk });
  if (v.ptt !== was.ptt) toVoice({ t: 'ptt', on: v.ptt });
  for (const id of Object.keys(q.volumes || {})) if (id in v.volumes) toVoice({ t: 'volume', id, v: v.volumes[id] });
  if (v.ptt !== was.ptt || v.pttKey !== was.pttKey) pttWatch();
  if (v.talk !== was.talk || v.deaf !== was.deaf || v.pin !== was.pin) syncVoice();
  if (v.talk !== was.talk) micLight();
}
// The light in the tray while you're in a voice room: grey while your microphone is closed, red while it's open.
// Clicking it turns Talk on or off.
function dotImage(r, g, b) {
  const s = 16, buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const a = Math.max(0, Math.min(1, 6.5 - Math.hypot(x - 7.5, y - 7.5))), i = (y * s + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = Math.round(a * 255);
  }
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}
const toggleTalk = () => patch({ voice: { talk: !state.voice.talk } });
// Out of the voice room (still online in the hub, still in its chat), until Join voice.
function leaveVoice() { if (!state.voice.deaf) { applyVoice({ deaf: true }); pushState(); } }
function micLight() {
  const live = !!bcWin;       // broadcasting: the light is red too (docs/plans/broadcast.md §12), with Stop one click away
  if (!voiceLive && !live) { if (micTray) { micTray.destroy(); micTray = null; } return; }
  const open = !!voiceLive && state.voice.talk;
  const img = open || live ? dotImage(230, 40, 40) : dotImage(140, 140, 140);
  // Clicking it: Talk on or off while in voice; otherwise (only live) the Share tab
  if (!micTray) { micTray = new Tray(img); micTray.on('click', () => (voiceLive ? toggleTalk() : visWins[0] && visWins[0].win.webContents.send('cmd', { type: 'show-panel', tab: 'broadcast' }))); } else micTray.setImage(img);
  const hubId = voiceLive ? voiceLive.hub : (chat.info().bc.mine || {}).hub, where = (chat.info().hubs.find((h) => h.id === hubId) || {}).name || 'a hub';
  const mic = !voiceLive ? '' : !open ? `listening in ${where}. Your microphone is closed` : voiceLive.mic === 'none' ? 'no microphone found' : voiceLive.mic === 'open' ? `your microphone is open in ${where}. Hold the key to talk` : `your microphone is on in ${where}: people can hear you`;
  micTray.setToolTip('Drift: ' + [live ? `you're live in ${where} (${bcSource ? bcSource.title : 'broadcasting'})` : '', mic].filter(Boolean).join('. '));
  micTray.setContextMenu(Menu.buildFromTemplate([
    ...(live ? [{ label: 'Stop sharing', click: () => CHAT_OPS.bcStop() }, { type: 'separator' }] : []),
    ...(voiceLive ? [{ label: open ? 'Mute (close the microphone)' : 'Talk', click: toggleTalk }, { label: 'Leave voice', click: () => patch({ voice: { deaf: true } }) }] : []),
    { label: `Leave ${where}`, click: () => chat.disconnect(hubId) },
  ]));
}
// Hold-to-talk: Electron's globalShortcut only reports presses, never releases (spike 1), so a small helper watches
// the key with GetAsyncKeyState, which also sees it while a game or another program has the keyboard.
const pttScript = (vk) => [
  'Add-Type -TypeDefinition @\'',
  'using System; using System.Runtime.InteropServices;',
  'public static class K {',
  '  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);',
  '  [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);',
  '}',
  '\'@',
  '[K]::timeBeginPeriod(1) | Out-Null',
  '$down = $false',
  'while ($true) {',
  `  $now = ([K]::GetAsyncKeyState(${vk}) -band 0x8000) -ne 0`,
  '  if ($now -ne $down) { $down = $now; if ($down) { [Console]::Out.WriteLine(\'D\') } else { [Console]::Out.WriteLine(\'U\') } }',
  '  Start-Sleep -Milliseconds 5',
  '}'].join('\n');
function pttWatch() {
  if (pttProc) { try { pttProc.kill(); } catch { /* gone */ } pttProc = null; }
  if (!voiceLive || !state.voice.talk || !state.voice.ptt || process.platform !== 'win32') return;
  const p = pttProc = ps(pttScript(VOICE_KEYS[state.voice.pttKey]), { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); for (const l of lines) if (l === 'D' || l === 'U') toVoice({ t: 'key', down: l === 'D' }); });
  p.on('error', () => { if (pttProc === p) pttProc = null; });
  p.on('close', () => { if (pttProc === p) pttProc = null; });
}

function initFor(wc) {
  const v = visWins.find((x) => x.win.webContents === wc);
  const act = activeDisplays();
  return {
    key: v ? v.key : 'd0', index: v ? v.index : 0,
    bounds: v ? v.bounds : act[0].bounds,
    union: unionOf(act),
    displays: allDisplays().map((d) => ({ index: d.index, key: d.key, width: d.bounds.width, height: d.bounds.height, primary: d.primary })),
    cats: catAt,
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
  catRehome();       // before the new windows ask where the cats are (initFor)
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
  if (state.cat && (!prev || !prev.cat || prev.catCount !== state.catCount || prev.catsUnlocked !== state.catsUnlocked)) catTick();       // the cats show up straight away
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
    else if (k === 'voice') applyVoice(p.voice || {});
    else if (k === 'broadcast') {
      const was = state.broadcast;
      state.broadcast = cleanBroadcast({ ...state.broadcast, ...(p.broadcast || {}) });
      if (state.broadcast.quality !== was.quality) toBc({ t: 'quality', quality: state.broadcast.quality });
      if (state.broadcast.pointers !== was.pointers) { bcOvSync(); bcPush(); }
      if (state.broadcast.sound !== was.sound && bcWin) { bcSoundFail = ''; chat.bcUpdate({ audio: bcSoundWanted() }); bcSoundSync(); bcPush(); }
    }
    else if (k === 'hubSurf') { const q = p.hubSurf || {}; state.hubSurf = cleanHubSurf({ ...state.hubSurf, ...(q.noDownloads !== undefined ? { noDownloads: q.noDownloads } : {}), ...(q.allowLan !== undefined ? { allowLan: q.allowLan } : {}),
      ...(q.showSpecs !== undefined ? { showSpecs: q.showSpecs } : {}), ...(q.showBrowsing !== undefined ? { showBrowsing: q.showBrowsing } : {}) }); }       // (only these four are the panel's to set)
    else if (k === 'gif') state.gif = cleanGif(p.gif);
    else if (k === 'sfx') state.sfx = cleanSfx({ ...state.sfx, ...(p.sfx && typeof p.sfx === 'object' ? p.sfx : {}) });
    else if (k === 'mixer') state.mixer = cleanMixer({ ...state.mixer, ...(p.mixer && typeof p.mixer === 'object' ? p.mixer : {}) });
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
  if (JSON.stringify(prev.mixer) !== JSON.stringify(state.mixer)) { web.gainChanged(); hubSound(); toVoice({ t: 'master', v: mixGain().master }); }       // (a voice room not open yet takes it as it starts)
  if (prev.surfGpu !== state.surfGpu) web.gpuChanged();       // the browser goes up again the other way
  else if (prev.surfMirror !== state.surfMirror) web.resized();       // the page's shape meets the other monitors' partway while mirroring (pageSize)
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
ipcMain.on('now', (_e, n) => { nowPlaying = n; broadcast('now', n, false); p2p.sync(); syncLive(); });       // friends listening see the title too
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
    case 'cat-shoo': catShoo(+c.from); break;
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
      if (!r.canceled && r.filePaths.length) await mediaPlay(mediaName(r.filePaths[0]), () => addTracks(r.filePaths));
      break;
    }
    case 'add-folder': {
      const r = await dialog.showOpenDialog(parent, { title: 'Add a music folder', properties: ['openDirectory'], defaultPath: app.getPath('music') });
      if (!r.canceled) { const out = []; scanFolder(r.filePaths[0], out); if (out.length) await mediaPlay(path.basename(r.filePaths[0]), () => addTracks(out)); }
      break;
    }
    case 'pick-video': {
      const r = await dialog.showOpenDialog(parent, { title: 'Choose videos or music (pick several to play them in order)', properties: ['openFile', 'multiSelections'],
        defaultPath: app.getPath('videos'), filters: [{ name: 'Video and music', extensions: [...new Set([...VIDEO_EXT, ...AUDIO_EXT])].map((x) => x.slice(1)) }, { name: 'Video', extensions: VIDEO_EXT.map((x) => x.slice(1)) }, { name: 'Music', extensions: AUDIO_EXT.map((x) => x.slice(1)) }] });
      if (r.canceled || !r.filePaths.length) break;
      const vids = r.filePaths.filter(isVideo), songs = r.filePaths.filter((f) => !isVideo(f) && isAudio(f));
      if (vids.length) await mediaPlay(mediaName(vids[0]), () => setVideos(vids, c.key));      // playing your own video leaves a friend's session, and shares it into your hub
      else if (songs.length) await mediaPlay(mediaName(songs[0]), () => {
        showVisualizer();
        patch({ music: { playlist: songs, source: 'files', playing: true } });
        if (audioWin && !audioWin.isDestroyed()) audioWin.webContents.send('cmd', { type: 'play-index', index: 0 });
      });
      break;
    }
    // ---- watch together ----
    case 'share-start': {
      const want = chat ? await shareHub(String(c.hub || '')) : '', h = want && chat.info().hubs.find((x) => x.id === want), t = mediaTop(h);
      if (t && t.from !== chat.myId()) {       // someone else's is on there: ask everyone, as picking something does
        if (mediaPending) { say('Your vote is still going'); break; }
        mediaPending = { hub: want, go: () => ipcMain.emit('cmd', e, { ...c, type: 'share-start', hub: want }) };
        const r = await chat.mediaAsk(want, shareTitle());
        if (r.error || r.free) { const p = mediaPending; mediaPending = null; if (r.error) say(r.error); else p.go(); }
        break;
      }
      if (remote) await p2p.stop();
      liveHub = want;
      p2p.share({ port: state.share.port, internet: state.share.internet, wait: state.share.wait, name: shareName(), local: !!process.env.DRIFT_SHARE_LOCAL });     // dev: stay on this PC
      break;
    }
    case 'share-stop': if (p2p.role() === 'guest') mediaTried = joinedCode; p2p.stop(); break;       // (Leave skips the share that's on; Stop sharing ends ours)
    case 'surf-forget':       // Settings: forget Surf's sign-ins, cookies and history (Drift's own settings stay)
      try { await web.forget(); say('Surf has forgotten its sign-ins, cookies and history'); } catch { say('Surf\'s data couldn\'t be cleared. Try again after restarting Drift.'); }
      break;
    case 'surf': {       // the browser: the Surf tab and the bar along the top of a page
      const k = (visWins.find((x) => x.win.webContents === e.sender) || {}).key, d = c.do, mode = surfMode();
      if (mode === 'hub') {       // the hub's Surf stream, on this PC
        if (d === 'hide' || d === 'quit') { surfShown = false; if (hubWeb) hubWeb.hide(); ptrClear(); }
        else if (d === 'show' || d === 'move' || d === 'new' && !(hubWeb && hubWeb.running())) hubShow(d === 'move' || !surfShown ? k : surfKey);       // (a first "new tab" just starts it, on its start page)
        else if (d === 'view') { if (k && hubWeb) hubWeb.viewer(e.sender, !!c.on); }       // this window starts or stops drawing it
        else if (SURF.includes(d)) { if (!surfShown) hubShow(k); const r = hubWeb ? hubWeb.act(c) : {}; if (r.error) say(r.error); }
        pushState();
        break;
      }
      if (mode === 'stream') {       // another hub's Surf stream: shown here as a picture, steered from here
        if (d === 'hide') surfShown = false;       // put away: its sound plays on (decision §11.1); the picture comes back when Surf is chosen again
        else if (d === 'quit') { surfShown = false; ssStop(); }
        else if (d === 'show' || d === 'move' || (d === 'new' && !surfShown)) {
          const was = surfKey; surfShown = true; surfKey = d === 'move' || !was ? k : was;
          if (!ssW || ssW.err || ssW.hub !== (surfHub() || {}).id || surfKey !== was) ssStart();       // (back from being put away on the same screen: the same connection, shown again)
        }
        else if (d === 'want') ssStart(true);       // the screen holding the picture asks again (no picture for a while)
        else if (SURF.includes(d)) ssOut({ t: 'bar', m: { do: d, text: String(c.text || '').slice(0, 2000), id: +c.id || 0, n: +c.n || 0 } });
        pushState();
        break;
      }
      if (d === 'show' || d === 'move' || SURF.includes(d)) surfBack();       // your own tabs, kept while you were online in a hub, come back first
      const was = web.info().open;
      if (d === 'attached') web.attached(e.sender, +c.tab, +c.wc);
      else if (d === 'hide') web.hide();
      else if (d === 'show' || d === 'move') web.show(d === 'move' || !was ? k : '');       // show: bring it back where it was; move: onto the screen that asked
      else if (d === 'quit') web.close();
      else if (d === 'outside') web.outside();       // open the page in the PC's own browser
      else if (d === 'view') { if (k) web.viewer(e.sender, !!c.on); }       // this window starts or stops drawing the offscreen page
      else if (SURF.includes(d)) { const r = web.act(c, was ? web.info().key : k); if (r.error) say(r.error); }       // (the bar on a monitor mirroring the page steers it where it is)
      break;
    }
    case 'ss': {       // the Surf stream's picture, in the screen window that shows it (renderer/app.js)
      const x = visWins.find((y) => y.win.webContents === e.sender);
      if (surfMode() !== 'stream' || !ssW || !x || x.key !== screenFor(surfKey)) { if (c.do === 'cert') chatLog('surf stream: a certificate came while not watching here'); break; }
      if (c.do === 'signal' && c.d && typeof c.d === 'object') chat.ssSignal(ssW.host, c.d);
      else if (c.do === 'cert') { const r = chat.ssCert(ssW.host, String(c.alg || ''), String(c.fp || '')); if (!r.ok) chatLog('surf stream: the host\'s certificate couldn\'t be checked (' + JSON.stringify(chat.info().ss.watching) + ')'); }
      else if (c.do === 'dc') onSsDc(c.m);
      else if (c.do === 'state') ssLive = String(c.state || '');
      break;
    }
    case 'bc': {       // one of the broadcasts watched in the Broadcast scene, from the screen window that shows it (renderer/app.js #bcView)
      const x = visWins.find((y) => y.win.webContents === e.sender), s = bcStreams.get(String(c.bc || ''));
      if (!bcScene || !s || !x || x.key !== bcSceneKey()) break;
      if (c.do === 'signal' && c.d && typeof c.d === 'object') chat.bcSignal(s.bc, s.from, c.d);
      else if (c.do === 'cert') chat.bcCert(s.bc, s.from, String(c.alg || ''), String(c.fp || ''));
      else if (c.do === 'dc') onBcDc(s, c.m);
      else if (c.do === 'state') { const st = String(c.state || '').slice(0, 20); if (st !== s.state) { s.state = st; pushState(); } }
      else if (c.do === 'want') bcAgain(s.bc);
      break;
    }
    case 'hub-held': heldAnswer(+c.id, !!c.save); break;       // the host's answer to a download on the Surf stream
    case 'hub-surf-clear':       // Settings: the hub's browser closes its tabs and forgets its sign-ins
      if (!hubBrowser()) break;
      try { await hubWeb.forget(); state.hubSurf = { ...state.hubSurf, urls: [], active: 0 }; saveSoon(); say('The hub\'s browser has closed its tabs and forgotten its sign-ins'); } catch { say('The hub\'s browser couldn\'t be cleared. Try again after restarting Drift.'); }
      if (surfMode() === 'hub' && surfShown) hubShow(surfKey);
      break;
    case 'rtc': {       // setting up a web page's stream: with a friend, or (local) between the window holding the page and another monitor mirroring it
      if (!c.d || typeof c.d !== 'object') break;
      const to = String(c.to || '');
      if (c.local) {       // a mirroring window, to the one holding the page
        const k = (visWins.find((x) => x.win.webContents === e.sender) || {}).key, x = !remote && k && visWins.find((y) => y.key === web.info().key);
        if (x && x.key !== k && !x.win.isDestroyed()) x.win.webContents.send('cmd', { type: 'rtc', from: 'local:' + k, d: c.d });
      } else if (to.startsWith('local:')) {       // ...and back
        const x = visWins.find((y) => y.key === to.slice(6));
        if (x && !x.win.isDestroyed() && x.win.webContents !== e.sender) x.win.webContents.send('cmd', { type: 'rtc', local: true, d: c.d });
      } else if (c.d.ch === 'music') { if (to) p2p.sendTo(to, { t: 'rtc', d: c.d }); else if (remote) p2p.send({ t: 'rtc', d: c.d }); }       // (the music friends hear)
      break;
    }
    case 'share-music':       // play / pause / next / previous for a friend's music
      if (!remote || !remote.music || !['toggle', 'next', 'prev'].includes(c.do)) break;
      if (remote.ctrl) p2p.send({ t: 'cmd', a: 'music', do: c.do }); else say(`Only ${p2p.info().host || 'the host'} can control the music`);
      break;
    case 'web-ptr': if (surfMode() === 'stream') ssOut({ t: 'ptr', x: +c.x, y: +c.y }); break;       // where this PC's mouse is over the Surf stream
    case 'web-input':       // mouse and keyboard over a friend's web page, or over our own page mirrored on another monitor
      if (!c.e || typeof c.e !== 'object') break;
      if (surfMode() === 'stream') ssOut({ t: 'in', e: c.e });       // over another hub's Surf stream: to its host
      else if (surfMode() === 'hub') { if (hubWeb && visWins.some((x) => x.win.webContents === e.sender)) hubWeb.input(c.e, true, chat.myId(), e.sender); }       // over the hub's own, on this PC
      else if (visWins.some((x) => x.win.webContents === e.sender && (x.key !== web.info().key ? state.surfMirror : web.info().gpu))) web.input(c.e, true);       // (the Surf monitor's own, when the page is drawn offscreen)
      break;
    case 'share-join': { joinedCode = mediaTried = String(c.code || ''); const r = await p2p.join(c.code, shareName()); if (!r.ok) say(r.error); break; }
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
      await mediaPlay(mediaName(files[c.index | 0] || files[0]), () => {
        showVisualizer();
        patch({ music: { playlist: files, source: 'files', playing: true } });
        if (audioWin && !audioWin.isDestroyed()) audioWin.webContents.send('cmd', { type: 'play-index', index: Math.max(0, Math.min(files.length - 1, c.index | 0)) });
      });
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
      await mediaPlay(mediaName(files[c.index | 0] || files[0]), () => setVideos(files, c.key, Math.max(0, Math.min(files.length - 1, c.index | 0))));
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
    case 'sfx': {       // a panel's: a new message it showed (one screen gets those), or a sound tried in Options
      const names = (Array.isArray(c.names) ? c.names : [c.name]).filter((n) => SFX_NAMES.has(n));
      if (names.length) sfxPlay(names, !!c.preview);
      break;
    }
    case 'accent': {       // the windows' accent (the palette's main colour, renderer/app.js setAccent): Surf's start page takes it
      const hex = (x) => (/^#[0-9a-f]{6}$/i.test(String(x)) ? String(x).toLowerCase() : '');
      if (hex(c.a) && hex(c.b)) appAccent = { a: hex(c.a), b: hex(c.b) };
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
      if (from && ssWin && !ssWin.isDestroyed() && from === ssWin.webContents) {       // the Surf stream's window: the hub's browser, and nothing else
        const f = hubWeb && hubWeb.captureFrame();
        cb(f ? { video: f, audio: f, enableLocalEcho: true } : {});       // (local echo: the host hears it when muted() lets them)
        return;
      }
      if (from && bcWin && !bcWin.isDestroyed() && from === bcWin.webContents) {       // the broadcast window: exactly the source picked in the Share tab, and nothing else
        if (!bcSource) { cb({}); return; }
        desktopCapturer.getSources({ types: [bcSource.kind], thumbnailSize: { width: 0, height: 0 } }).then((src) => { const x = src.find((y) => y.id === bcSource.id); cb(x ? { video: x } : {}); }).catch(() => cb({}));
        return;
      }
      if (from && bcPreviewFor && bcPreviewFor.wc === from && Date.now() < bcPreviewFor.until) {       // Preview in your Broadcast tile (bcPreview): what you're sending, without its sound
        bcPreviewFor = null;
        if (!bcSource) { cb({}); return; }
        desktopCapturer.getSources({ types: [bcSource.kind], thumbnailSize: { width: 0, height: 0 } }).then((src) => { const x = src.find((y) => y.id === bcSource.id); cb(x ? { video: x } : {}); }).catch(() => cb({}));
        return;
      }
      if (from && visWins.some((v) => !v.win.isDestroyed() && v.win.webContents === from)) {
        const may = !!state.surfMirror;       // for this PC's other monitors
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
    if (process.env.DRIFT_CATCOST) setTimeout(() => catCost().catch((e) => console.log('[catcost] ' + e.message)), 20000);
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
    if (pttProc) { try { pttProc.kill(); } catch { /* gone */ } }
    spotifyWatch(false); spotifyVolWatch(false); xcoder.stopAll(); for (const k of audioKids) { try { k.kill(); } catch { /* gone */ } } noteProgress(); saveNow(); });
}

// ---- dev-only screenshot harness -------------------------------------------------
// Test runs drive the pages with scripts. Every one goes through pageJs, never webContents.executeJavaScript itself: the
// script's syntax is checked here first, so a slip (often an escape lost inside a quoted script) fails at once with the real
// reason and the script, not Electron's bare "Script failed to execute" after a whole run. Better still, write new ones with
// pageRun: a real function, checked by `node --check` with the rest of this file, so nothing needs escaping twice. It runs in
// the page, so it can't see anything here: pass what it needs as arguments (JSON).
//   pageRun(wc, (sel) => document.querySelector(sel).innerText.replace(/\n+/g, ' | '), '#callBar')
function pageJs(wc, code, ...more) {
  try { new (require('vm').Script)(code); } catch (e) { return Promise.reject(new Error(`page script doesn't parse (${e.message}): ${code.slice(0, 400)}`)); }
  return wc.executeJavaScript(code, ...more);
}
const pageRun = (wc, fn, ...args) => pageJs(wc, `(${fn})(...${JSON.stringify(args)})`);
// dev: DRIFT_CATCOST=1, in a normal (visible) run: what the cats cost. 20 s after starting (time to get a video playing in
// Surf), the CPU of the GPU process and of the windows over 10 s each: cats off, awake, asleep, awake with the chat's
// blurred boxes unblurred, and off again. Hidden test windows don't animate, so this can't be a test. Printed, and written
// to cat-cost.txt in the user data folder.
async function catCost() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms)), out = [], wasCat = state.cat;
  const say = (t) => { console.log('[catcost] ' + t); out.push(t); };
  const all = (fn, ...a) => Promise.all(visWins.map((v) => pageRun(v.win.webContents, fn, ...a).catch(() => null)));
  const force = (f) => all((x) => { window.catForce = x; }, f);
  const blur = (on) => all((x) => {
    let s = document.querySelector('#catCostNoBlur');
    if (x) { if (s) s.remove(); return; }
    if (!s) { s = document.createElement('style'); s.id = 'catCostNoBlur'; s.textContent = '#chatOverlay * { backdrop-filter: none !important; }'; document.head.append(s); }
  }, on);
  const cpu = (ms) => ms.reduce((n, m) => n + m.cpu.percentCPUUsage, 0).toFixed(0) + '%';
  say(`screens ${screen.getAllDisplays().map((d) => `${d.size.width}x${d.size.height}@${d.displayFrequency}Hz`).join(', ')}; cats ${state.catsUnlocked ? state.catCount : 1}; Surf audible ${!!surfView().audible}`);
  const measure = async (tag) => {
    await wait(2000); app.getAppMetrics();       // (settle; each reading is since the one before)
    await wait(10000); const m = app.getAppMetrics();
    const cats = await all(() => [document.querySelectorAll('.coCat.here').length, document.querySelector('#chatOverlay').classList.contains('asleep')]);
    say(`${tag.padEnd(22)} GPU process ${cpu(m.filter((x) => x.type === 'GPU')).padStart(5)}   windows ${cpu(m.filter((x) => x.type === 'Tab')).padStart(5)}   cats per screen ${cats.map((c) => c ? c[0] + (c[1] ? 'z' : '') : '?').join(' ')}`);
  };
  try {
    patch({ cat: false }); await force(''); await measure('off');
    patch({ cat: true }); await force('awake'); await measure('awake');
    await force('asleep'); await measure('asleep');
    await force('awake'); await blur(false); await measure('awake, no blur');
    await blur(true); patch({ cat: false }); await force(''); await measure('off again');
  } finally { await blur(true); await force(''); patch({ cat: wasCat }); }
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'cat-cost.txt'), out.join('\n') + '\n'); } catch { /* printed anyway */ }
  say('done: ' + path.join(app.getPath('userData'), 'cat-cost.txt'));
}

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
      const r = await pageJs(v.win.webContents, `(() => { const v = document.querySelector('#v'); return { src: (v.currentSrc || '').replace(/k=[0-9a-f]+/, 'k').replace(/^file:.*\\//, 'file:').slice(0, 70), t: +v.currentTime.toFixed(2), rs: v.readyState, paused: v.paused, size: v.videoWidth + 'x' + v.videoHeight, err: v.error && v.error.code, rate: +v.playbackRate.toFixed(3) }; })()`);
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
  if (process.env.DRIFT_TESTCATS) {     // the cats as images drawn once (renderer/cats.js, scripts/test-cats.js): drawn, stacked to look as the one drawing did, asleep, and drawn again for a new palette
    const res = {}, tl = (k, v) => { res[k] = v; log.push(`cats: ${k} ${JSON.stringify(v).slice(0, 600)}`); };
    const until = async (f, ms = 15000) => { for (let t = 0; t < ms; t += 250) { if (await f()) return true; await wait(250); } return !!(await f()); };
    const end = () => { fs.writeFileSync(path.join(SHOT_DIR, 'cats.json'), JSON.stringify(res, null, 1)); fs.writeFileSync(path.join(SHOT_DIR, 'log.txt'), log.join('\n')); quitting = true; app.quit(); };
    await Promise.all(visWins.map((v) => pageRun(v.win.webContents, () => document.querySelector('#panel').classList.remove('show', 'open')).catch(() => {})));
    patch({ cat: true, catsUnlocked: true, catCount: 12, palette: 'aurora' });
    const here = (v) => pageRun(v.win.webContents, () => document.querySelectorAll('.coCat.here').length).catch(() => 0);
    let v = null;
    tl('catsShow', await until(async () => { for (const x of visWins) if (await here(x) > 0) { v = x; return true; } return false; }));
    if (!v) { end(); return; }
    const wc = v.win.webContents;
    const drawn = () => pageRun(wc, () => [...document.querySelectorAll('.coCat.here img[data-l]')].every((i) => i.src.startsWith('data:image/png')));
    tl('drawn', await until(drawn));
    const look = () => pageRun(wc, async () => {
      const cats = [...document.querySelectorAll('.coCat.here')], c = cats[0], imgs = [...c.querySelectorAll('img[data-l]')];
      await Promise.all(imgs.map((i) => i.decode().catch(() => {})));
      const alpha = (i) => { const k = document.createElement('canvas'); k.width = i.naturalWidth; k.height = i.naturalHeight; const x = k.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, k.width, k.height).data; let n = 0; for (let p = 3; p < d.length; p += 4) if (d[p] > 8) n++; return n; };
      const layers = {};
      for (const i of imgs) { const cs = getComputedStyle(i); layers[i.dataset.l] = { w: i.naturalWidth, h: i.naturalHeight, shown: cs.display !== 'none', anim: cs.animationName, origin: cs.transformOrigin, lit: alpha(i) }; }
      const root = getComputedStyle(document.documentElement), wcs = getComputedStyle(c), r = (e) => { return [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight]; };       // (untransformed: the cat may be mid-breath)
      const vars = Object.fromEntries(['--cat-pad', '--cat-iw', '--cat-ih', '--cat-tail-o', '--cat-eyes-o', '--cat-w'].map((n) => [n, root.getPropertyValue(n).trim()]));
      const shared = imgs.every((i) => cats.every((o) => o.querySelector(`img[data-l="${i.dataset.l}"]`).src === i.src));
      // the awake layers stacked at rest, against the whole cat drawn as one with CSS's drop-shadow (as it was shown before)
      const ref = new Image(); ref.src = await window.Cats.reference(); await ref.decode();
      const W = ref.naturalWidth, H = ref.naturalHeight, mk = () => { const k = document.createElement('canvas'); k.width = W; k.height = H; return k; };
      const A = mk(), B = mk(); for (const i of imgs) if (i.classList.contains('catAwake')) A.getContext('2d').drawImage(i, 0, 0); B.getContext('2d').drawImage(ref, 0, 0);
      const S = mk(); for (const i of imgs) if (i.classList.contains('catAsleep')) S.getContext('2d').drawImage(i, 0, 0);       // asleep with all three z's, to look at
      const a =A.getContext('2d').getImageData(0, 0, W, H).data, b = B.getContext('2d').getImageData(0, 0, W, H).data;
      let sum = 0, big = 0, max = 0;       // (premultiplied: a see-through pixel's colour doesn't count)
      for (let p = 0; p < a.length; p++) { const q = p - (p % 4) + 3, d = p % 4 === 3 ? Math.abs(a[p] - b[p]) : Math.abs(a[p] * a[q] - b[p] * b[q]) / 255; sum += d; if (d > max) max = d; if (d > 40) big++; }
      // asleep (only the CSS: the frame loop sets it back next frame)
      const o = document.querySelector('#chatOverlay'), was = [o.className, o.dataset.z], asleep = {};
      for (const z of ['0', '1', '3']) { o.classList.add('asleep'); o.dataset.z = z; asleep[z] = imgs.filter((i) => getComputedStyle(i).display !== 'none').map((i) => i.dataset.l); }
      o.className = was[0]; o.dataset.z = was[1] || '';
      return { cats: cats.length, layers, vars, shared, wrapper: { filter: wcs.filter, clip: wcs.clipPath, anim: wcs.animationName, box: r(c), clipBox: r(c.querySelector('.catClip')), imgBox: r(imgs[0]) },
        diff: { mean: +(sum / a.length).toFixed(3), max, big, px: W * H }, asleep, body: c.querySelector('.cl-body').src.length, A: A.toDataURL(), B: B.toDataURL(), S: S.toDataURL(), dpr: devicePixelRatio };
    });
    const save = (name, url) => fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(url.split(',')[1], 'base64'));
    const r1 = await look(); save('cats-layers-aurora.png', r1.A); save('cats-reference-aurora.png', r1.B); save('cats-asleep-aurora.png', r1.S); delete r1.A; delete r1.B; delete r1.S;
    tl('aurora', r1);
    const src = () => pageRun(wc, () => document.querySelector('.coCat.here .cl-body').src);
    const before = await src();
    patch({ palette: 'mono' });
    tl('redrawnForPalette', await until(async () => (await src()) !== before, 8000));
    const r2 = await look(); save('cats-layers-mono.png', r2.A); save('cats-reference-mono.png', r2.B); save('cats-asleep-mono.png', r2.S); delete r2.A; delete r2.B; delete r2.S;
    tl('mono', r2);
    patch({ cat: false, catsUnlocked: false, catCount: 3 });
    end(); return;
  }
  if (process.env.DRIFT_CAT) {       // dev: the cat in the chat overlay, with the panel hidden, as just its bar, and open
    const panelJs = (js) => Promise.all(visWins.map((v) => pageJs(v.win.webContents, `(() => { const p = document.querySelector('#panel'); ${js} })()`).catch(() => {})));
    patch({ scene: 'lake', cat: true }); await panelJs("p.classList.remove('show')"); await wait(1500); await snap('cat');
    await panelJs("p.classList.remove('open'); p.classList.add('show')"); await wait(900); await snap('cat-bar');
    await panelJs("document.querySelector('.tabs [data-tab=\"settings\"]').click(); p.classList.add('show')"); await wait(900); await panelJs("p.classList.add('show')"); await snap('cat-panel');
    // shoo: the mouse runs at every cat on each screen, a few times; then they all gather on the middle screen
    const count = async (tag) => log.push(`${tag} ` + JSON.stringify(await Promise.all(visWins.map((v) => pageJs(v.win.webContents, "document.querySelectorAll('.coCat.here').length").catch(() => -1)))));
    await panelJs("p.classList.remove('show', 'open')"); await wait(1200); await count('cats before shoo');
    log.push(`cats at ${JSON.stringify(catAt)} screens ${JSON.stringify(catScreens())} off ${JSON.stringify(state.displaysOff)} unlocked ${state.catsUnlocked} count ${state.catCount}`);
    await count('cats before unlock');
    await panelJs("document.querySelector('.tabs [data-tab=\\\"settings\\\"]').click(); p.classList.add('show', 'open'); for (const key of 'meow') dispatchEvent(new KeyboardEvent('keydown', { key }))");
    await wait(1500); log.push('unlocked: ' + state.catsUnlocked + ' / label: ' + await pageJs(visWins[0].win.webContents, "document.querySelector('#catName').textContent + ' / slider hidden: ' + document.querySelector('#catCountRow').hidden"));
    await snap('cat-unlocked'); await panelJs("p.classList.remove('show', 'open')"); await wait(1500); await count('cats after unlock');
    for (let i = 0; i < 3; i++) { await panelJs(`p.classList.${i % 2 ? 'remove' : 'add'}('show')`); await wait(1300); await count('cats after panel ' + (i % 2 ? 'closed' : 'opened')); }
    await count('cats after shoo'); await snap('cat-shooed');
    catGather(); await wait(CAT_GATHER_GAP * 3 + 1200); await count('cats gathered (middle ' + catMiddle() + ')'); await snap('cat-gather');
    log.push('cat names: ' + await pageJs(visWins[0].win.webContents, "[...document.querySelectorAll('.coCat')].map((c) => c.dataset.name).join(' ')"));
    log.push('hover tag: ' + await pageJs(visWins[0].win.webContents, "(() => { const c = document.querySelector('.coCat.here'); if (!c) return 'no cat here'; c.dispatchEvent(new MouseEvent('mouseenter')); const t = document.querySelector('#coCatTag'); return t.textContent + ' on=' + t.classList.contains('on'); })()"));
    const offWas = state.displaysOff; patch({ displaysOff: [] }); await wait(3000);
    if (visWins.length > 1) {       // a monitor turned off: its cats move to the screens still showing, right away (not at the next tick)
      const off = visWins[visWins.length - 1].index; patch({ displaysOff: [off] }); await wait(3000);
      log.push(`monitor ${off} off: cats at ${JSON.stringify(catAt.slice(0, state.catCount))} screens ${JSON.stringify(catScreens())}`); await count('cats after monitor off');
    }
    patch({ displaysOff: offWas }); await wait(3000);
    patch({ cat: false });
  }
  if (process.env.DRIFT_TESTWAV) {
    const b0 = beatCount; addTracks([process.env.DRIFT_TESTWAV]); await wait(6000); beatCount -= b0;
    log.push('beats during file: ' + beatCount);
    log.push('levels(file): ' + JSON.stringify(lastLevels) + ' now=' + JSON.stringify(nowPlaying));
  }
  if (process.env.DRIFT_TESTPERF) {       // dev: DRIFT_TESTPERF=<a video>. Frames it shows and drops in 6 s on each screen, spanned, with the cats off and on
    setVideos([process.env.DRIFT_TESTPERF]); patch({ mode: 'span', video: { fit: 'auto' } }); await wait(5000);
    const measure = async (tag) => {
      ipcMain.emit('cmd', { sender: visWins[0].win.webContents }, { type: 'video-jump', pos: 2 }); await wait(1500);
      const r = await Promise.all(visWins.map((v) => pageJs(v.win.webContents, `new Promise((res) => {
        const v = document.querySelector('#v'), q0 = v.getVideoPlaybackQuality(); let n = 0, on = true;
        const f = () => { n++; if (on) v.requestVideoFrameCallback(f); }; v.requestVideoFrameCallback(f);
        let raf = 0, lag = 0, last = performance.now(); const r = () => { raf++; if (on) requestAnimationFrame(r); }; requestAnimationFrame(r);
        const tk = setInterval(() => { const t = performance.now(); lag = Math.max(lag, t - last - 50); last = t; }, 50);
        setTimeout(() => { on = false; clearInterval(tk); const q = v.getVideoPlaybackQuality(); res({ shown: n, dropped: q.droppedVideoFrames - q0.droppedVideoFrames, raf, lag: Math.round(lag), t: +v.currentTime.toFixed(1), size: v.videoWidth + 'x' + v.videoHeight, paused: v.paused }); }, 6000);
      })`).catch((e) => ({ error: e.message }))));
      log.push(`perf ${tag}: ` + JSON.stringify(r));
    };
    const panelJs = (js) => Promise.all(visWins.map((v) => pageJs(v.win.webContents, `(() => { const p = document.querySelector('#panel'); ${js} })()`).catch(() => {})));
    await panelJs("p.classList.remove('show', 'open')");
    for (const [tag, st] of [['off', { cat: false }], ['1 cat', { cat: true, catsUnlocked: false }], ['off', { cat: false }], ['12 cats', { cat: true, catsUnlocked: true, catCount: 12 }],
      ['off', { cat: false }], ['12 cats', { cat: true, catsUnlocked: true, catCount: 12 }]]) { patch(st); await wait(1500); await measure(tag); }
    for (let i = 0; i < 4; i++) {       // asleep: the "z Z Z", a letter at a time
      log.push('cats asleep: ' + await pageJs(visWins[0].win.webContents, "(() => { const o = document.querySelector('#chatOverlay'); return o.classList.contains('asleep') + ' z=' + o.dataset.z + ' cats=' + document.querySelectorAll('.coCat.here').length; })()"));
      await snap('cat-asleep-' + i); await wait(1100);
    }
    patch({ video: { paused: true } }); await wait(1200); await snap('cat-awake');
    log.push('paused: ' + await pageJs(visWins[0].win.webContents, "document.querySelector('#chatOverlay').classList.contains('asleep')"));
    patch({ cat: false, catsUnlocked: false, catCount: 3 });
  }
  if (process.env.DRIFT_CATNAP) {       // dev: DRIFT_CATNAP=<a video>. The cats asleep while it plays (close-ups of the "z Z Z" growing), then awake when it pauses
    const closeUp = async (name) => {
      const v = visWins.find((x) => x.index === catAt[0]) || visWins[0];
      const r = await pageJs(v.win.webContents, "(() => { const cs = [...document.querySelectorAll('.coCat.here')].map((c) => c.getBoundingClientRect()), b = cs.length ? { x: Math.min(...cs.map((c) => c.x)), y: Math.min(...cs.map((c) => c.y)), width: Math.max(...cs.map((c) => c.right)) - Math.min(...cs.map((c) => c.x)), height: Math.max(...cs.map((c) => c.height)) } : document.querySelector('#coCats').getBoundingClientRect(); const o = document.querySelector('#chatOverlay'); return { x: Math.max(0, Math.floor(b.x - 20)), y: Math.max(0, Math.floor(b.y - 60)), width: Math.ceil(Math.min(innerWidth, b.width + 40)), height: Math.ceil(b.height + 70), asleep: o.classList.contains('asleep'), z: o.dataset.z || '', cats: document.querySelectorAll('.coCat.here').length }; })()");
      log.push(`catnap ${name}: asleep=${r.asleep} z=${r.z} cats here=${r.cats}`);
      const full = await v.win.webContents.capturePage(), sz = full.getSize(), k = sz.width / v.bounds.width;       // (captured in device pixels)
      log.push(`  window ${v.key} ${JSON.stringify(v.bounds)} image ${sz.width}x${sz.height} crop ${JSON.stringify(r)}`);
      const img = full.crop({ x: Math.round(r.x * k), y: Math.round(r.y * k), width: Math.round(r.width * k), height: Math.round(Math.min(r.height, v.bounds.height - r.y) * k) });
      fs.writeFileSync(path.join(SHOT_DIR, `catnap-${name}.png`), img.resize({ width: Math.round(r.width * 3) }).toPNG());
    };
    const panelJs = (js) => Promise.all(visWins.map((v) => pageJs(v.win.webContents, `(() => { const p = document.querySelector('#panel'); ${js} })()`).catch(() => {})));
    await panelJs("p.classList.remove('show', 'open')");
    patch({ cat: true, catsUnlocked: true, catCount: 3, palette: 'aurora' }); await wait(1500); await closeUp('awake-scene');
    setVideos([process.env.DRIFT_CATNAP]); patch({ mode: 'span', video: { fit: 'auto', paused: false } }); await wait(3000);
    for (let i = 0; i < 4; i++) { await closeUp('asleep-' + i); await wait(1100); }
    patch({ video: { paused: true } }); await wait(1200); await closeUp('paused');
    patch({ cat: false, catsUnlocked: false });
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
    const wc = visWins[0].win.webContents, js = (c) => pageJs(wc, c);
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
      const look = () => pageJs(wc, "JSON.stringify({ lit: [...document.querySelectorAll('#vfolders .vf.active span')].map((x) => x.textContent), open: (document.querySelector('#vcrumb b') || {}).textContent })");
      log.push('folders before: ' + await look());
      await pageJs(wc, "document.querySelectorAll('#vfolders .vf span')[1].click()"); await wait(1200);
      log.push('folders after clicking the second: ' + await look());
      await pageJs(wc, "document.querySelectorAll('#vfolders .vf span')[0].click()"); await wait(1200);
      log.push('folders after clicking the first: ' + await look());
    }
    patch({ music: { source: 'generative' } });
  }
  if (process.env.DRIFT_CTX) {     // exercise the tab-aware transport
    const wc = visWins[0].win.webContents, press = (code) => pageJs(wc, code);
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
    await pageJs(wc, "document.querySelector('.sw.cus').click()"); await wait(600);
    log.push('custom seeded: ' + state.palette + ' ' + JSON.stringify(state.customColors));
    await pageJs(wc, "(() => { const el = document.querySelector('#customRow input[data-i=\"2\"]'); el.value = '#ff2d95'; el.dispatchEvent(new Event('input', { bubbles: true })); })()"); await wait(600);
    log.push('custom edited: ' + JSON.stringify(state.customColors));
    await pageJs(wc, "document.querySelector('#customDark').click()"); await wait(7000);
    log.push('custom matched: ' + JSON.stringify(state.customColors));
    patch({ customColors: ['red', '#000000', '#111111', '#222222'] }); log.push('bad input ignored: ' + JSON.stringify(state.customColors));
    await pageJs(wc, "document.querySelector('#customRow').scrollIntoView({ block: 'center' })"); await wait(500);
    await snap('custom-panel');
    await pageJs(wc, "document.querySelector('#panel').classList.remove('show')"); await wait(800); await snap('custom-scene');
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
        if (i === 3) { wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(800); await snap('share-host'); }
      }
      log.push('host end: ' + info() + ' sessions=' + xcoder.active() + ' err=' + (xcoder.lastError() || 'none'));
    } else {
      for (let i = 0; i < 80 && !fs.existsSync(codeFile); i++) await wait(500);
      await wait(600); cmd({ type: 'share-join', code: fs.readFileSync(codeFile, 'utf8') });
      for (let i = 0; i < 22; i++) {
        await wait(2000); await look('guest +' + i * 2 + 's');
        if (i === 1) {
          log.push('guest: ' + info() + ' info=' + JSON.stringify(videoInfo) + ' subs=' + subInfo.tracks.length + ' xc=' + JSON.stringify(publicState().xc).replace(/k=[0-9a-f]+/, 'k'));
          wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(800); await snap('share-guest');
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
  if (process.env.DRIFT_TESTCHAT) {     // the Hub tab between two copies of Drift on one PC (DRIFT_USERDATA apart), pressing the real buttons: =host or =guest, DRIFT_TESTCODE = a file both can reach.
    // The host presses Share with no hub yet (one is made), the guest joins the hub with its invite, sees the Join card, joins the video, and they chat.
    const role = process.env.DRIFT_TESTCHAT, codeFile = process.env.DRIFT_TESTCODE, wc = visWins[0].win.webContents, js = (c) => pageJs(wc, c);
    const hubs = () => chat.info().hubs, until = async (f, ms = 20000) => { for (let t = 0; t < ms && !f(); t += 250) await wait(250); return f(); };
    const dom = () => js(`JSON.stringify({ title: document.querySelector('#chTitle').textContent, sub: document.querySelector('#chSub').textContent, side: document.querySelector('#chHubs').innerText.replace(/\\n+/g, ' | '),
      lives: document.querySelector('#chLives').innerText.replace(/\\n+/g, ' | '), share: [document.querySelector('#shTitle').textContent, document.querySelector('#shGTitle').textContent].join(' / '),
      msgs: [...document.querySelectorAll('#chList .chMsg')].map((m) => m.innerText.replace(/\\n+/g, ' ')), imgs: document.querySelectorAll('#chList .chText img').length, faces: document.querySelectorAll('#chList .msgFace img').length, overlay: window.chatUI.overlay(), nomic: document.querySelectorAll('#chHubs .nomic').length, bold: document.querySelectorAll('#chList .chText b').length,
      links: [...document.querySelectorAll('#chList a')].map((a) => a.textContent), tabUnread: document.querySelector('.tabs button[data-tab=hub]').classList.contains('unread') })`);
    patch({ music: { source: 'off' }, share: { internet: false, wait: false, name: role === 'host' ? 'Hosty' : 'Guesty' } });
    wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(800);
    if (role === 'host') {
      if (process.env.DRIFT_TESTVIDEO) { setVideos([process.env.DRIFT_TESTVIDEO]); await wait(2500); }
      const pic = await js("(() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); g.fillStyle = '#e0457b'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#fff'; g.font = 'bold 80px sans-serif'; g.fillText('H', 34, 94); return c.toDataURL('image/webp', 0.8); })()");
      log.push('host: picture ' + JSON.stringify(chat.setAvatar(pic)));
      ipcMain.emit('cmd', { sender: wc }, { type: 'share-start', hub: '' });       // (the Together button is gone: this is what it did)
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
      const overlays = async () => (await Promise.all(visWins.map((v) => pageJs(v.win.webContents, 'window.chatUI.overlay()')))).flat();       // (on whichever screen has focus)
      log.push('guest: the message comes over the video ' + await (async () => { for (let t = 0; t < 15000; t += 250) { if ((await overlays()).length > 0) return true; await wait(250); } return false; })());
      log.push('guest: overlay ' + JSON.stringify(await overlays()));
      await snap('together-overlay');
      log.push('guest: answers over the video ' + await js("window.chatUI.compose('typed over the video')"));
      await wait(1500);
      wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(800);
      log.push('guest sees: ' + await dom());
      await js("window.chatUI.send('> quoted\\nhello back, `code` and ||secret||')");
      await wait(2500); log.push('guest after sending: ' + await dom()); await snap('together-guest');
      log.push('guest: the card goes when the host stops ' + await until(() => !hubs().some((h) => (h.lives || []).length), 30000));
      log.push('guest: session over ' + (p2p.role() === 'off'));
    }
  }
  if (process.env.DRIFT_TESTPICS) {     // emoji, pictures and reactions in the Hub tab, one copy of Drift hosting its own hub (scripts/test-chat-pics.js)
    const wc = visWins[0].win.webContents, res = {}, tl = (k, v) => { res[k] = v; log.push(`pics: ${k} ${JSON.stringify(v)}`); };
    const until = async (f, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await f()) return true; await wait(200); } return !!(await f()); };
    const done = () => fs.writeFileSync(path.join(SHOT_DIR, 'pics.json'), JSON.stringify(res, null, 1));
    patch({ music: { source: 'off' }, share: { internet: false, name: 'Hosty' }, gif: { key: '' } });
    wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(800);
    await pageRun(wc, () => document.querySelector('#chHost').click());
    tl('hub', await until(() => pageRun(wc, () => !document.querySelector('#chInput').disabled)));
    if (!res.hub) { done(); fs.writeFileSync(path.join(SHOT_DIR, 'log.txt'), log.join('\n')); quitting = true; app.quit(); return; }
    // the emoji picker: open it, search, Enter puts the first into the box
    tl('emojiPicker', await pageRun(wc, () => {
      document.querySelector('#chEmojiBtn').click();
      const box = document.querySelector('#chPick'), q = box.querySelector('.pickQ'), all = box.querySelectorAll('.emo').length;
      q.value = 'fire'; q.dispatchEvent(new Event('input'));
      const first = box.querySelector('.emo').textContent, focused = document.activeElement === q;
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return { all, first, focused, closed: box.hidden, input: document.querySelector('#chInput').value };
    }));
    await pageRun(wc, () => window.chatUI.send(document.querySelector('#chInput').value + ' hi'));
    // a picture pasted into the box: it waits over the box, and Enter sends it with the text
    tl('attached', await pageRun(wc, async () => {
      const c = document.createElement('canvas'); c.width = 300; c.height = 150;
      const g = c.getContext('2d'); g.fillStyle = '#2a8'; g.fillRect(0, 0, 300, 150);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
      const input = document.querySelector('#chInput');
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      for (let i = 0; i < 50 && !document.querySelector('#chAttach.on'); i++) await new Promise((r) => setTimeout(r, 100));
      return { on: !!document.querySelector('#chAttach.on'), text: document.querySelector('#chAttachText').textContent, preview: !!document.querySelector('#chAttachPic img') };
    }));
    await pageRun(wc, () => { const i = document.querySelector('#chInput'); i.value = 'a picture'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
    tl('pictureShows', await until(() => pageRun(wc, () => !!document.querySelector('#chList .chPic img'))));
    tl('list', await pageRun(wc, () => ({ msgs: [...document.querySelectorAll('#chList .chMsg')].map((m) => m.querySelector('.chText') ? m.querySelector('.chText').innerText : ''), pic: (() => { const p = document.querySelector('#chList .chPic'); return p && [p.style.width, p.style.height, p.querySelector('img') && p.querySelector('img').src.slice(0, 22)]; })(), attachGone: !document.querySelector('#chAttach.on') })));
    // a reaction from the message's tools, then taken back by clicking its chip
    await pageRun(wc, () => { const rows = document.querySelectorAll('#chList .chMsg'); [...rows[rows.length - 1].querySelectorAll('.chTools button')].find((b) => b.textContent === '👍').click(); });
    tl('reacted', await until(() => pageRun(wc, () => { const c = document.querySelector('#chList .chReact.on'); return !!c && c.innerText.replace(/\s+/g, '') === '👍1'; })));
    await pageRun(wc, () => document.querySelector('#chList .chReact.on').click());
    tl('unreacted', await until(() => pageRun(wc, () => !document.querySelector('#chList .chReact:not(.add)'))));
    // a reaction from the picker
    await pageRun(wc, () => { const rows = document.querySelectorAll('#chList .chMsg'); [...rows[0].querySelectorAll('.chTools button')].find((b) => b.textContent === 'React').click(); const q = document.querySelector('#chPick .pickQ'); q.value = 'party'; q.dispatchEvent(new Event('input')); q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
    const chips = () => pageRun(wc, () => [...document.querySelectorAll('#chList .chReact.on .e')].map((c) => c.textContent).join(','));
    await until(chips); tl('pickerReact', await chips());
    // GIF search is off for now (it needs a GIPHY key): no GIF button, no key in Options; the box's buttons sit level with one line of text
    tl('gifOff', await pageRun(wc, () => !document.querySelector('#chGifBtn').offsetWidth && !document.querySelector('#gifKey').offsetWidth));
    tl('composer', await pageRun(wc, () => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const i = r('#chInput'), b = r('#chEmojiBtn'), f = r('#chFileBtn'); return { input: [i.top, i.height], emoji: [b.top, b.height], file: [f.top, f.height] }; }));
    // the picture over a video (the chat overlay main.js sends a new message to while you watch something of this hub's)
    const hubId = chat.info().hubs.find((x) => x.mine).id, ch = chat.info().hubs.find((x) => x.mine).channels[0].id;
    const last = (await chat.history(hubId, ch, { limit: 10 })).msgs.find((m) => m.file);
    await pageRun(wc, () => document.querySelector('#panel').classList.remove('open'));       // (not while the channel is open right there)
    wc.send('chat', { type: 'notify', hub: hubId, msg: { ...last, text: '' }, overlay: true });
    tl('videoOverlay', await until(() => pageRun(wc, () => { const p = document.querySelector('#coList .coMsg .chPic img'); return !!p && p.closest('.chPic').style.width === '240px' && p.src.startsWith('data:image/webp'); })));
    // Enter: with the panel away, the quick box (here not watching anything: it says where the message went); with the Hub tab
    // open, its own box; never from a text box. A slider just used still lets it through (Enter does nothing to one). Over Surf,
    // with the page not holding the keys, the quick box too (a page holding them is asked: web.js "Enter").
    const enter = () => pageRun(wc, () => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); return { quick: document.activeElement === document.querySelector('#coInput'), main: document.activeElement === document.querySelector('#chInput'), where: document.querySelector('#coWhere').textContent }; });
    const quick = await enter();
    await pageRun(wc, () => { const c = document.querySelector('#coInput'); c.value = 'quick hello'; c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })); });
    const sentQuick = await until(async () => (await chat.history(hubId, ch, { limit: 5 })).msgs.some((m) => m.text === 'quick hello'));
    tl('enterQuick', { ...quick, sent: sentQuick, toast: await pageRun(wc, () => document.querySelector('#toast').textContent), closed: await pageRun(wc, () => !document.querySelector('#chatOverlay').classList.contains('typing')) });
    wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(600);
    tl('enterHubTab', await enter());
    tl('enterInTextBox', await pageRun(wc, () => { const t = document.querySelector('#chCode'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return document.activeElement === t; }));
    const fromControl = (sel) => pageRun(wc, (s) => {
      document.querySelector('.tabs [data-tab="scenes"]').click(); document.querySelector('#panel').classList.add('show', 'open');
      const el = document.querySelector(s); el.focus(); const had = document.activeElement === el;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const r = { had, quick: document.activeElement === document.querySelector('#coInput') };
      if (window.chatUI) window.chatUI.closeQuick();
      return r;
    }, sel);
    tl('enterFromSlider', { slider: await fromControl('#speed'), box: await fromControl('#cycleShuffle') });
    await pageRun(wc, () => { const p = document.querySelector('#panel'); p.classList.remove('open', 'show'); document.body.classList.add('surfing'); });
    tl('enterOverSurf', await enter());
    await pageRun(wc, () => { if (window.chatUI) window.chatUI.closeQuick(); });
    const btnLit = () => pageRun(wc, () => getComputedStyle(document.querySelector('#coBtn')).pointerEvents === 'auto');
    tl('surfButtonFades', { still: !(await btnLit()), moved: await (async () => { wc.send('cmd', { type: 'pointer-moved' }); await wait(200); return btnLit(); })(), after: await (async () => { await wait(2900); return !(await btnLit()); })() });
    tl('surfButton', await pageRun(wc, async () => {
      const b = document.querySelector('#coBtn'), box = document.querySelector('#coBox'), shown = getComputedStyle(b).display;
      document.querySelector('#coList').append(Object.assign(document.createElement('div'), { className: 'coMsg', textContent: 'x' }));       // (a message to line up)
      b.click();
      const lit = getComputedStyle(b).pointerEvents === 'auto', msgLeft = Math.round(document.querySelector('#coList .coMsg:last-child').getBoundingClientRect().left);
      const opens = document.activeElement === document.querySelector('#coInput'), bb = b.getBoundingClientRect(), xb = box.getBoundingClientRect();
      b.click(); await new Promise((r) => setTimeout(r, 200));
      const r = { shown, opens, lit, aligned: msgLeft === Math.round(xb.left), beside: Math.round(xb.left - bb.right), level: Math.abs((bb.top + bb.height / 2) - (xb.top + xb.height / 2)) < 2, closes: !document.querySelector('#chatOverlay').classList.contains('typing') };
      document.body.classList.remove('surfing');
      r.goneOffSurf = getComputedStyle(b).display === 'none';
      return r;
    }));
    // a share the hub keeps off its stream because someone online can't reach this PC (hub.js "reach"): it stops being shared,
    // plays here only, and the Media tab says why
    liveHub = hubId;
    await p2p.share({ port: 47850, internet: false, wait: false, name: 'Hosty', local: true });
    await until(() => p2p.info().role === 'host' && !!p2p.info().code);
    chat._fromHub(hubId, { t: 'live-no', why: 'reach', who: ['Ben'] });
    const stopped = await until(() => p2p.info().role === 'off' && !!publicState().mediaSolo);
    wc.send('cmd', { type: 'show-panel', tab: 'media' }); await wait(600);
    tl('mediaRefused', { stopped, note: await pageRun(wc, () => document.querySelector('#mShare').textContent), toast: await pageRun(wc, () => document.querySelector('#toast').textContent) });
    // Enter over the hub's Surf page, pressed on this PC (web.js "Enter"): the page's while a text box in it is selected, the quick
    // box once nothing is. (A member's goes the same way, over the stream: scripts/test-surf-stream.js.)
    {
      const hw = hubStart(), f = () => hw && hw.captureFrame();
      const ready = await until(() => !!f(), 20000);
      const quickOn = () => pageRun(wc, () => document.querySelector('#chatOverlay').classList.contains('typing'));
      const press = async () => { hw.input({ k: 'key', d: true, key: 'Enter', m: [] }, true, chat.myId(), wc); hw.input({ k: 'key', d: false, key: 'Enter', m: [] }, true, chat.myId(), wc); await wait(1000); return { page: ready ? await f().executeJavaScript('window.enters').catch((e) => e.message) : -1, quick: await quickOn() }; };
      if (ready) await f().executeJavaScript("window.enters = 0; addEventListener('keydown', (e) => { if (e.key === 'Enter') window.enters++; }, true); const i = document.createElement('input'); document.body.append(i); i.focus(); true");
      const inBox = await press();
      if (ready) await f().executeJavaScript('document.activeElement.blur(); true');
      const off = await press();
      await pageRun(wc, () => { if (window.chatUI) window.chatUI.closeQuick(); });
      tl('enterOverHubPage', { ready, inBox, off });
      // "Are you sure?" in the start page's own box (surf-home.html ask), where the browser's confirm() used to be: in the hub's
      // browser that one never showed (surf-hub-guard.js answers it "no"), so Reset never worked there
      tl('startPageAsk', ready ? await f().executeJavaScript(`(async () => {
        document.querySelector('#customize').click(); await new Promise((r) => setTimeout(r, 300));
        const reset = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Reset to defaults');
        if (!reset) return { reset: false };
        reset.click(); await new Promise((r) => setTimeout(r, 100));
        const box = document.querySelector('.ask'), r = { reset: true, shown: !!box, title: box ? box.querySelector('b').textContent : '', focused: !!box && document.activeElement === box.querySelector('button.danger') };
        if (box) [...box.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
        r.gone = !document.querySelector('.ask');
        return r;
      })()`).catch((e) => ({ err: e.message })) : null);
      // the start page's label: Drift's logo and "Drift · Surf", Surf in Drift's accent, which follows the palette picked in Scenes
      // (renderer/app.js setAccent → main → surf-home.js /api/accent) unless the page has one of its own picked
      const look = () => f().executeJavaScript(`(() => { const l = document.querySelector('.brand .logo'), r = l ? l.getBoundingClientRect() : null, sw = document.querySelector('.swatches button');
        return { logo: r ? [Math.round(r.width), Math.round(r.height)] : null, text: document.querySelector('.brand').innerText.replace(/\\s+/g, ' ').trim(),
          surf: getComputedStyle(document.querySelector('.brand .surf')).color, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
          hi: getComputedStyle(document.documentElement).getPropertyValue('--hi').trim(), firstSwatch: sw ? sw.className : '' }; })()`).catch((e) => ({ err: e.message }));
      const rgbOf = (x) => `rgb(${parseInt(x.slice(1, 3), 16)}, ${parseInt(x.slice(3, 5), 16)}, ${parseInt(x.slice(5, 7), 16)})`;
      const was = state.palette;
      const first = ready ? await look() : null, appFirst = { ...appAccent };
      patch({ palette: 'sunset' });
      const followed = ready && await until(async () => (await look()).accent === appAccent.a && appAccent.a !== appFirst.a, 8000);
      await wait(800);       // (the label's colour eases over .6 s)
      const after = ready ? await look() : null;
      tl('startPageLabel', { first, appFirst, followed, after, app: { ...appAccent }, surfIsAccent: !!after && after.surf === rgbOf(appAccent.a) });
      patch({ palette: was });
      // a list opened in the hub's browser (drawn offscreen: surf-select.js draws it) is in the page's own dark colours. Clicked as
      // anyone's mouse is, through web.js input(); the picture is kept for a look (select.png)
      if (ready) {
        await f().executeJavaScript("document.body.classList.remove('custom'); true");
        const at = await f().executeJavaScript('(() => { const r = document.querySelector("#engine").getBoundingClientRect(); return { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight }; })()');
        hw.input({ k: 'down', x: at.x, y: at.y, b: 0, n: 1 }, true, chat.myId(), wc); hw.input({ k: 'up', x: at.x, y: at.y, b: 0, n: 1 }, true, chat.myId(), wc);
        await wait(700);
        const opened = await f().executeJavaScript("[...document.body.children].some((e) => e.style.zIndex === '2147483647')");
        let shot = '';
        try { const pw = BrowserWindow.getAllWindows().find((w) => w.webContents.mainFrame === f()); if (pw) { const img = await pw.webContents.capturePage(); fs.writeFileSync(path.join(SHOT_DIR, 'select.png'), img.toPNG()); shot = img.getSize().width + 'x' + img.getSize().height; } } catch (e) { shot = 'no picture: ' + e.message; }
        tl('selectList', { opened, shot });
      }
      // the Surf tab showing the hub's stream: whose it is sits at the end of the bar's row of tabs, not floating over the page, and the
      // hint about the edges (shown the first few times, not in tests) never covers the bar
      if (ready) {
        hubShow((visWins.find((x) => x.win.webContents === wc) || {}).key);
        await until(() => pageRun(wc, () => document.querySelector('#ssLine').classList.contains('on')), 8000);
        await wait(400);
        tl('ssDocked', await pageRun(wc, () => {
          const el = document.querySelector('#ssLine'), bar = document.querySelector('#surfBar'), tabs = document.querySelector('#sbTabs').getBoundingClientRect();
          bar.style.transition = 'none'; bar.classList.add('show');
          const r = el.getBoundingClientRect(), t = document.querySelector('#sbTabs').getBoundingClientRect();
          return { on: el.classList.contains('on'), inBar: !!el.closest('#surfBar .sbTop'), docked: el.classList.contains('docked'), text: el.textContent, title: el.title,
            level: Math.abs((r.top + r.height / 2) - (t.top + t.height / 2)) < 2, after: r.left >= t.right - 1, rightEdge: Math.round(bar.getBoundingClientRect().right - r.right), had: Math.round(tabs.width) };
        }));
        await pageRun(wc, () => { const bar = document.querySelector('#surfBar'); bar.classList.remove('show'); bar.style.transition = ''; });
      }
    }
    // Drift's own "are you sure?" (ask() in app.js), in place of the system's confirm(): Delete asks first, Cancel keeps the
    // message; Enter answers with the button that has the keyboard (yes), Esc says no
    {
      wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(600);
      const count = () => pageRun(wc, () => document.querySelectorAll('#chList .chMsg').length);
      const n0 = await count();
      const del = await pageRun(wc, async () => {
        const b = [...document.querySelectorAll('#chList .chMsg .chTools button')].find((x) => x.textContent === 'Delete');
        if (!b) return { found: false };
        b.click(); await new Promise((r) => setTimeout(r, 100));
        const c = document.querySelector('#confirm'), r = { found: true, on: c.classList.contains('on'), title: document.querySelector('#confirmTitle').textContent, yes: document.querySelector('#confirmYes').textContent, red: document.querySelector('#confirmYes').classList.contains('danger'), focused: document.activeElement === document.querySelector('#confirmYes') };
        document.querySelector('#confirmNo').click();
        r.closed = !c.classList.contains('on');
        return r;
      });
      await wait(800);
      const keys = await pageRun(wc, async () => {
        const key = (k) => setTimeout(() => dispatchEvent(new KeyboardEvent('keydown', { key: k, cancelable: true })), 50);
        const shown = () => getComputedStyle(document.querySelector('#confirmDetail')).display;
        const p0 = window.driftAsk({ title: 'Zero?', detail: 'https://example.com/a' }); const withDetail = shown(); document.querySelector('#confirmNo').click(); await p0;
        const p1 = window.driftAsk({ title: 'One?', yes: 'Yes' }); const noDetail = shown(); key('Enter'); const enter = await p1;
        const p2 = window.driftAsk({ title: 'Two?', yes: 'Yes' }); key('Escape'); const esc = await p2;
        const p3 = window.driftAsk({ title: 'Three?', yes: 'Go', danger: false }); const plain = document.querySelector('#confirmYes').className;
        const p4 = window.driftAsk({ title: 'Four?' }); const replaced = await p3; document.querySelector('#confirmNo').click(); await p4;
        return { withDetail, noDetail, enter, esc, plain, replaced, closed: !document.querySelector('#confirm').classList.contains('on') };
      });
      // Settings' Reset everything asks first; Cancel leaves every setting as it was
      const before = JSON.stringify(state.share);
      state.share.name = 'Hosty kept'; const mark = JSON.stringify(state.share);
      const resetAsk = await pageRun(wc, () => { document.querySelector('#reset').click(); const r = { on: document.querySelector('#confirm').classList.contains('on'), title: document.querySelector('#confirmTitle').textContent, yes: document.querySelector('#confirmYes').textContent }; document.querySelector('#confirmNo').click(); return r; });
      await wait(600);
      resetAsk.untouched = JSON.stringify(state.share) === mark; state.share = JSON.parse(before);
      tl('askBox', { del, kept: (await count()) === n0, keys, resetAsk });
      // Settings' plain text box (Local addresses it may open) is styled like the others
      tl('textBox', await pageRun(wc, () => { const s = getComputedStyle(document.querySelector('#hsLan')); return { bg: s.backgroundColor, radius: s.borderRadius, color: s.color }; }));
    }
    // the picture over a game you broadcast: the overlay window, sent what bcOvSync sends it (the message, then its picture)
    const ov = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'bc-overlay-preload.js'), sandbox: true, contextIsolation: true } });
    await ov.loadFile(path.join(__dirname, 'renderer', 'bc-overlay.html'));
    const f = await chat.file(hubId, last.file.id), m1 = { id: String(last.id), from: last.from, name: 'Hosty', ch: '', text: 'look 🔥', pic: { id: last.file.id, w: last.file.w, h: last.file.h, gif: false }, at: Date.now() };
    ov.webContents.send('bc-overlay', { list: [], msgs: [m1], pics: {} });
    await wait(300);
    const before = await pageRun(ov.webContents, () => window.bcOverlayTest());
    ov.webContents.send('bc-overlay', { list: [], msgs: [m1], pics: { [last.file.id]: `data:${f.mime};base64,${f.data.toString('base64')}`, bad: 'data:image/svg+xml;base64,PHN2Zz4=' } });
    await wait(300);
    tl('gameOverlay', { before, after: await pageRun(ov.webContents, () => window.bcOverlayTest()), loaded: await pageRun(ov.webContents, () => { const i = document.querySelector('.pic img'); return !!i && i.complete && i.naturalWidth; }) });
    ov.destroy();
    await snap('pics');
    done();
  }
  if (process.env.DRIFT_TESTVOICE) {     // a hub's voice room with three copies of Drift on one PC (DRIFT_USERDATA apart): =host, =guest or =third. DRIFT_TESTCODE = a file
    // for the invite, DRIFT_TESTVOICE_OUT = a folder where each writes what it saw (<role>.json). The host's Drift runs the hub, so DRIFT_HUB_TAMPER
    // goes to the host. Opening the hub doesn't put you in voice: each presses Join voice in the hub bar, then Unmute (a test tone, not a microphone).
    const role = process.env.DRIFT_TESTVOICE, codeFile = process.env.DRIFT_TESTCODE, outDir = process.env.DRIFT_TESTVOICE_OUT;
    const name = { host: 'Hosty', guest: 'Guesty', third: 'Third' }[role] || role;
    const wc = visWins[0].win.webContents, js = (c) => pageJs(wc, c);
    const until = async (f, ms = 30000) => { for (let t = 0; t < ms && !f(); t += 250) await wait(250); return f(); };
    const vlog = (t) => log.push(`voice ${role}: ${t}`);
    const hubNow = () => chat.info().hubs.find((h) => h.status === 'connected');
    const vtest = () => (voiceWin ? pageJs(voiceWin.webContents, 'window.voiceTest()').catch((e) => ({ error: e.message })) : null);
    const barBtn = (label) => js(`(() => { const b = [...document.querySelectorAll('#callBar button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
    patch({ music: { source: 'off' }, share: { internet: false, name }, voice: { talk: false, deaf: false, ptt: false, direct: false, pin: '' } });
    wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(800);
    if (role === 'host') {
      await js("document.querySelector('#chHost').click()");
      vlog('hub up ' + await until(() => hubNow()));
      fs.writeFileSync(codeFile, (await chat.invite(hubNow().id)).code || '');
    } else {
      for (let i = 0; i < 120 && !(fs.existsSync(codeFile) && fs.readFileSync(codeFile, 'utf8')); i++) await wait(500);
      await js(`document.querySelector('#chCode').value = ${JSON.stringify(fs.readFileSync(codeFile, 'utf8'))}; document.querySelector('#chJoin').click()`);
      vlog('joined the hub ' + await until(() => hubNow()));
    }
    const everyone = () => { const h = hubNow(); return h ? h.members.length + h.suspect.length : 0; }, res0 = {};
    vlog('everyone is in the hub ' + await until(() => everyone() >= 3, 60000));
    await wait(2000);
    res0.notInVoiceAtFirst = !chat.info().call && !voiceLive && state.voice.deaf;
    vlog('not in voice before Join voice ' + res0.notInVoiceAtFirst);
    vlog('press Join voice ' + await barBtn('Join voice'));
    vlog('in the voice room ' + await until(() => !!chat.info().call && !!voiceLive, 30000));
    // Settled: all three listening, and every connection either verified, refused, or given up on.
    const settled = () => {
      const c = chat.info().call, h = hubNow();
      if (!c || !h || h.voice.filter((v) => v.listen).length < 3 || !voiceLive) return false;
      return c.peers.length === 2 && c.want.length === 2 && c.peers.every((id) => c.verdict[id] || c.refused[id] || c.told.includes(id) || voiceLive.peers[id] === 'failed');
    };
    vlog('settled, listening ' + await until(settled, 60000));
    await wait(1500);
    const before = await vtest();       // connected, but nobody has pressed Talk: no microphone was ever opened
    const res = { ...res0, role, name, me: chat.myId(), before, lightBefore: voiceLive && voiceLive.mic, trayBefore: !!micTray, barBefore: await js("document.querySelector('#callBar').innerText.replace(/\\n+/g, ' | ')") };
    vlog('press Unmute ' + await barBtn('Unmute'));
    vlog('everyone talking ' + await until(() => { const h = hubNow(); return h && h.voice.filter((v) => v.talk && v.mic).length === 3; }, 30000));
    await wait(4000);       // sound flowing for a while, and the panel drawn
    const h = hubNow(), names = Object.fromEntries([...h.members, ...h.suspect].map((m) => [m.id, m.name]));
    Object.assign(res, {
      names, call: chat.info().call, live: voiceLive, suspect: h.suspect, voice: h.voice, test: await vtest(),
      panel: JSON.parse(await js(`JSON.stringify({ warns: [...document.querySelectorAll('#chHubs .warn')].map((e) => e.textContent),
        locks: Object.fromEntries([...document.querySelectorAll('#chHubs .chWho')].map((r) => [r.querySelector('.nm').textContent, (r.querySelector('.lock') || {}).title || ''])),
        note: (document.querySelector('#chHubs .vcNote') || {}).textContent || '', bar: document.querySelector('#callBar').classList.contains('on') ? document.querySelector('#callBar').innerText.replace(/\\n+/g, ' | ') : '',
        hot: document.querySelector('#callBar').classList.contains('hot') })`)),
      heard: JSON.parse(await js(`JSON.stringify(Object.fromEntries(${JSON.stringify(h.voice.map((v) => v.id))}.map((id) => [id, window.chatUI.canBeHeard(${JSON.stringify(h.id)}, id)])))`)),
      relay: role === 'host' ? chat.relayStats() : null, lightTalking: voiceLive && voiceLive.mic,
    });
    await snap('voice-' + role);
    vlog('press Mute ' + await barBtn('Mute')); await wait(1500);       // the microphone closes, the hub hears of it, and the others stop counting you as heard
    res.closedReported = (hubNow().voice.find((v) => v.id === chat.myId()) || {}).talk === false;
    res.lightAfterMute = voiceLive && voiceLive.mic;
    res.afterMute = await vtest();
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, role + '.json'), JSON.stringify(res, null, 1));
    vlog('wrote what it saw');
    await until(() => ['host', 'guest', 'third'].every((r) => fs.existsSync(path.join(outDir, r + '.json'))), role === 'host' ? 90000 : 30000);       // the host keeps the hub up until everyone is done
    if (role !== 'host') {
      await barBtn('Leave hub');
      res.disconnected = await until(() => !voiceWin && !voiceLive && !micTray && (chat.info().hubs[0] || {}).status === 'away', 5000);
      vlog('disconnected: voice window closed ' + res.disconnected);
      fs.writeFileSync(path.join(outDir, role + '.json'), JSON.stringify(res, null, 1));
    }
    if (role === 'host') await wait(8000);       // while the others press Disconnect
  }
  if (process.env.DRIFT_TESTSTREAM) {     // a hub's media stream, two copies of Drift (scripts/test-stream.js): =host or =guest. DRIFT_TESTCODE = a file for
    // the invite, DRIFT_TESTSTREAM_DIR = a folder holding a.mp4 and b.mp4 (added to the library), DRIFT_TESTSTREAM_OUT = where each writes <role>.json.
    const role = process.env.DRIFT_TESTSTREAM, codeFile = process.env.DRIFT_TESTCODE, dir = process.env.DRIFT_TESTSTREAM_DIR, outDir = process.env.DRIFT_TESTSTREAM_OUT;
    const wc = visWins[0].win.webContents, js = (c) => pageJs(wc, c), other = role === 'host' ? 'guest' : 'host';
    const until = async (f, ms = 30000) => { for (let t = 0; t < ms && !f(); t += 250) await wait(250); return f(); };
    const hubNow = () => chat.info().hubs.find((h) => h.status === 'connected');
    const lives = () => (hubNow() || {}).lives || [];
    const play = (f) => ipcMain.emit('cmd', { sender: wc }, { type: 'play-videos', files: [path.join(dir, f)], key: visWins[0].key });       // as the Media tab does
    const step = (n) => fs.writeFileSync(path.join(outDir, role + '.step'), String(n)), stepOf = (r) => { try { return +fs.readFileSync(path.join(outDir, r + '.step'), 'utf8'); } catch { return 0; } };
    const res = { role, me: chat.myId() }, tl = (k, v) => { res[k] = v; log.push(`stream ${role}: ${k} ${JSON.stringify(v)}`); };
    fs.mkdirSync(outDir, { recursive: true });
    patch({ music: { source: 'off' }, share: { internet: false, wait: false, name: role === 'host' ? 'Hosty' : 'Guesty' }, video: { folders: [dir] } });
    wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(800);
    const song = () => ipcMain.emit('cmd', { sender: wc }, { type: 'play-tracks', files: [path.join(dir, 'c.wav')], index: 0 });
    const mineOn = () => p2p.role() === 'host' && lives().length === 1 && lives()[0].from === chat.myId();
    const theirsOn = () => p2p.connected() && lives().length === 1 && lives()[0].from !== chat.myId();
    const card = () => js('window.chatUI.vote()'), click = (label) => js(`window.chatUI.voteClick(${JSON.stringify(label)})`);
    const untilA = async (f, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await f()) return true; await wait(250); } return false; };
    const asked = () => untilA(async () => { const c = await card(); return !!c && c.btns.includes('Switch'); }, 30000);
    const surf = (d) => ipcMain.emit('cmd', { sender: wc }, { type: 'surf', do: d });       // as the Surf tab does
    tl('picking a video with no hub plays it here only', (play('a.mp4'), await wait(1500), p2p.role() === 'off'));
    if (role === 'host') {
      await js("document.querySelector('#chHost').click()");
      tl('hub up', await until(() => !!hubNow()));
      fs.writeFileSync(codeFile, (await chat.invite(hubNow().id)).code || '');
      play('a.mp4');
      tl('with nothing on, picking a video shares it straight away', await until(mineOn));
      tl('a friend coming online is pulled in', await until(() => p2p.count() === 1, 60000));
      step(1);
      tl('the friend picks something: a vote card comes over the video', await asked());
      tl('...naming them and what', /Guesty.*wants.*b/.test((await card()).text));
      await until(() => stepOf(other) >= 1.5, 15000);       // (once they've seen their own card)
      tl('pressing Keep', await click('Keep'));
      tl('...mine stays on', (await wait(3000), mineOn() && p2p.count() === 1));
      step(2);
      tl('they ask again', await asked());
      tl('pressing Switch', await click('Switch'));
      tl('...mine stops and I watch theirs', await until(() => theirsOn() && /b\.mp4/.test(String((remote && remote.file) || '')), 40000));
      tl('the card goes', !(await card()));
      step(3);
      song();
      tl('picking music asks them', await untilA(async () => { const c = await card(); return !!c && c.btns.includes('Cancel'); }, 15000));
      tl('...and I keep watching meanwhile', theirsOn());
      step(3.5);
      tl('they agree: my music goes on', await until(mineOn, 40000));
      tl('the card names the song', /c/.test((lives()[0] || {}).title || ''));
      tl('...and they follow', await until(() => p2p.count() === 1, 40000));
      step(4);
      tl('they disconnected: off the stream', await until(() => p2p.count() === 0, 40000));
      await wait(4000);
      tl('...and they stay off', p2p.count() === 0);
      ipcMain.emit('cmd', { sender: wc }, { type: 'share-stop' });
      await until(() => p2p.role() === 'off' && !lives().length, 10000);
      surf('home');
      tl('opening Surf opens the hub\'s Surf stream, not the media stream', await until(() => surfMode() === 'hub' && !!hubWeb && hubWeb.running() && surfView().open, 30000) && !web.info().has);
      tl('...and nothing is shared on the media stream', (await wait(1500), p2p.role() === 'off' && !lives().length));
      step(5);
    } else {
      surf('home');
      tl('Surf with no hub is just mine', await until(() => web.info().open, 15000) && p2p.role() === 'off');
      for (let i = 0; i < 120 && !(fs.existsSync(codeFile) && fs.readFileSync(codeFile, 'utf8')); i++) await wait(500);
      await js(`document.querySelector('#chCode').value = ${JSON.stringify(fs.readFileSync(codeFile, 'utf8'))}; document.querySelector('#chJoin').click()`);
      tl('joined the hub', await until(() => !!hubNow(), 60000));
      tl('pulled into what is on without pressing anything', await until(theirsOn, 60000));
      tl('my own Surf tabs are put away, kept', !web.info().has && !!surfKept && surfKept.urls.length === 1);
      await until(() => stepOf(other) >= 1, 40000); await wait(1500);
      play('b.mp4');
      tl('picking a video while theirs is on asks first (I see Cancel)', await untilA(async () => { const c = await card(); return !!c && c.btns.includes('Cancel'); }, 15000));
      tl('...and nothing switches yet', theirsOn());
      step(1.5);
      await until(() => stepOf(other) >= 2, 40000);
      tl('they said no: still watching theirs', theirsOn() && !(await card()));
      play('b.mp4');
      tl('they said yes: mine goes on', await until(mineOn, 40000));
      tl('...and they follow', await until(() => p2p.count() === 1, 40000));
      await until(() => stepOf(other) >= 3, 40000);
      tl('their music: a card asks me', await asked());
      await until(() => stepOf(other) >= 3.5, 15000);
      tl('pressing Switch', await click('Switch'));
      tl('I follow their music', await until(() => theirsOn() && !!(remote && remote.music), 60000));
      await until(() => stepOf(other) >= 4, 40000);
      await chat.disconnect(hubNow().id);
      tl('disconnecting leaves the stream', await until(() => p2p.role() === 'off', 10000));
      await wait(4000);
      tl('...and nothing pulls me back', p2p.role() === 'off');
      surf('show');
      tl('opening Surf again brings my tabs back', await until(() => web.info().open && web.info().has, 15000) && !surfKept);
      tl('...not shared: I\'m not online in the hub', (await wait(1500), p2p.role() === 'off'));
      step(5);
    }
    await until(() => stepOf(other) >= 5, 30000);
    fs.writeFileSync(path.join(outDir, role + '.json'), JSON.stringify(res, null, 1));
    if (role === 'host') await wait(3000);
  }
  if (process.env.DRIFT_TESTSS) {     // a hub's Surf stream, two copies of Drift (scripts/test-surf-stream.js): =host or =guest. DRIFT_TESTCODE = a file for
    // the invite, DRIFT_TESTSS_OUT = a folder for each step's marker, the downloads and what each saw (<role>.json),
    // DRIFT_TESTSS_CLIP = a video to put on the media stream meanwhile. The host serves the test pages itself, on this PC: the
    // hub's browser may open that one local address (Settings) and no other.
    const role = process.env.DRIFT_TESTSS, codeFile = process.env.DRIFT_TESTCODE, outDir = process.env.DRIFT_TESTSS_OUT, other = role === 'host' ? 'guest' : 'host';
    const name = role === 'host' ? 'Hosty' : 'Guesty', wc = visWins[0].win.webContents, js = (c) => pageJs(wc, c);
    // Failing fast: once something everything after it depends on fails (need), or either side crashes, an `abort` marker is
    // written and every wait on both sides gives up at once, instead of each running out its own timeout (minutes in all).
    const abortFile = path.join(outDir, 'abort'), aborted = () => fs.existsSync(abortFile);
    const abort = (why) => { try { fs.writeFileSync(abortFile, `${role}: ${why}`); } catch { /* fine */ } };
    const until = async (f, ms = 30000) => { for (let t = 0; t < ms && !aborted(); t += 250) { if (await f()) return true; await wait(250); } return !!(await f()); };
    const step = async (s, ms = 120000) => { fs.writeFileSync(path.join(outDir, `${role}-${s}`), ''); log.push(`surf ${role}: at ${s}`); return until(() => fs.existsSync(path.join(outDir, `${other}-${s}`)), ms); };
    const res = { role, name, me: chat.myId() }, tl = (k, v) => { res[k] = v; log.push(`surf ${role}: ${k} ${JSON.stringify(v)}`); };
    const need = (k, v) => { tl(k, v); if (!v) { abort(k); throw new Error('stopped early: ' + k); } };
    const hubNow = () => chat.info().hubs.find((h) => h.status === 'connected');
    const surf = (d, more) => ipcMain.emit('cmd', { sender: wc }, { type: 'surf', do: d, ...more });       // as the Surf tab and its bar do
    const input = (e) => ipcMain.emit('cmd', { sender: wc }, { type: 'web-input', e });       // as the mouse and keys over the picture do
    const click = (x, y) => { input({ k: 'down', x, y, b: 0, n: 1 }); input({ k: 'up', x, y, b: 0, n: 1 }); };
    fs.mkdirSync(outDir, { recursive: true });
    const dl = path.join(outDir, 'downloads-' + role); fs.mkdirSync(dl, { recursive: true }); app.setPath('downloads', dl);
    patch({ music: { source: 'off' }, share: { internet: false, name, wait: false, adblock: false }, voice: { talk: false, deaf: false, direct: false, pin: '' } });
    wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(800);
    try {
      if (role === 'host') {
        // the test pages: a moving picture with a tone, a link over the top left quarter, a box whose text becomes the title,
        // two downloads, a link that opens a window, and a page that tries a file picker and an alert
        const big = Buffer.alloc(200 * 1024, 7);
        let lanHits = 0;
        const srv = http.createServer((q, r) => {
          const page = (title, body) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(`<!DOCTYPE html><title>${title}</title><body style="margin:0;background:#123;color:#fff;font:40px sans-serif">${body}</body>`); };
          if (q.url === '/') page('Test one', `<canvas id=c width=640 height=360 style="position:fixed;right:0;bottom:0"></canvas><a href="/page2" style="position:fixed;left:0;top:0;width:50%;height:50%;background:#0a0;display:block">go</a><script>
            const g = c.getContext('2d'); let n = 0; (function f() { n++; g.fillStyle = 'hsl(' + n % 360 + ' 80% 50%)'; g.fillRect(0, 0, 640, 360); requestAnimationFrame(f); })();
            const a = new AudioContext(), o = a.createOscillator(), v = a.createGain(); v.gain.value = 0.3; o.connect(v).connect(a.destination); o.start();</script>`);
          else if (q.url === '/page2') page('page two', `<input id=i autofocus style="font-size:40px" oninput="document.title = 'typed:' + this.value" onkeydown="if (event.key === 'Enter') document.body.dataset.enters = (+document.body.dataset.enters || 0) + 1"><script>i.focus()</script>`);
          else if (q.url === '/pop') page('pop', `<button id=b style="position:fixed;inset:0;font-size:60px" onclick="window.open('/page2', 'x', 'width=300,height=300')">open a window</button>`);
          else if (q.url === '/pick') page('pick', `<input type=file id=f style="position:fixed;inset:0;width:100%;height:100%"><script>
            let n = 0; f.addEventListener('click', () => n++); alert('hello'); document.title = 'pick:' + (confirm('ok?') ? 'yes' : 'no');
            setTimeout(() => { f.click(); try { f.showPicker(); } catch (e) { document.title += ':' + e.name; } }, 100);</script>`);
          else if (q.url === '/dl' || q.url === '/dl2') { r.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': big.length, 'Content-Disposition': `attachment; filename="${q.url === '/dl' ? 'first' : 'second'}.bin"` }); r.end(big); }
          else { r.writeHead(404); r.end(); }
        });
        const lan = http.createServer((q, r) => { lanHits++; r.end('secret'); });       // another address on this PC, not allowed
        await new Promise((r) => srv.listen(0, '127.0.0.1', r)); await new Promise((r) => lan.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${srv.address().port}`;
        fs.writeFileSync(path.join(outDir, 'base.txt'), base + '\n' + `http://127.0.0.1:${lan.address().port}/`);
        patch({ hubSurf: { allowLan: `127.0.0.1:${srv.address().port}` } });
        surf('home');
        tl('before any hub, Surf is my own browser', await until(() => web.info().open, 15000) && surfMode() === 'own');
        await js("document.querySelector('#chHost').click()");
        need('hub up', await until(() => !!hubNow()));
        fs.writeFileSync(codeFile, (await chat.invite(hubNow().id)).code || '');
        tl('online in my own hub: my own browser is put away, its tabs kept', await until(() => surfMode() === 'hub' && !web.info().has && !!surfKept && surfKept.urls.length === 1, 15000));
        tl('...and the Surf tab is the hub\'s browser, drawn here offscreen', await until(() => !!hubWeb && hubWeb.running() && surfView().open && surfView().gpu && surfView().hub, 15000));
        ipcMain.emit('cmd', { sender: wc }, { type: 'surf', do: 'go', text: base + '/' });
        tl('it opens a page (the one local address allowed)', await until(() => hubWeb.info().title === 'Test one', 20000));
        tl('the hub lists it running, with its title', await until(() => (hubNow().surf || {}).on && hubNow().surf.title === 'Test one', 10000));
        const hubSes = session.fromPartition(`persist:hub-${hubWebId}`);
        await session.fromPartition('persist:web').cookies.set({ url: base, name: 'mine', value: 'secret' });
        tl('its own profile: none of my browser\'s cookies', !(await hubSes.cookies.get({ url: base })).some((c) => c.name === 'mine'));
        {       // the hub bar over the page: out of sight (it sat on sites' logos), back with Surf's own bar, in its place at the left
          const bar = () => pageRun(wc, () => {       // (runs in the page)
            const b = document.querySelector('#callBar'), s = document.querySelector('#surfBar');
            const r = (e) => { const x = e.getBoundingClientRect(); return { l: Math.round(x.left), t: Math.round(x.top), r: Math.round(x.right), b: Math.round(x.bottom) }; };
            return { on: b.classList.contains('on'), op: getComputedStyle(b).opacity, bar: r(b), surf: r(s), text: b.innerText.replace(/\n+/g, ' | ') };
          });
          wc.send('cmd', { type: 'hide-panel' }); await js("document.querySelector('#panel').classList.remove('show', 'open')"); await js("document.querySelector('#surfBar').classList.remove('show')"); await wait(600);
          await js("document.head.append(Object.assign(document.createElement('style'), { id: 'noAnim', textContent: '* { transition: none !important; animation: none !important; }' }))");       // (a hidden window never runs its transitions)
          const h0 = await bar(); log.push('surf host: hub bar hidden ' + JSON.stringify(h0));
          tl('over a Surf page the hub bar is out of sight, and says nothing of the Surf stream', h0.on && +h0.op === 0 && !/Surf|Test one/.test(h0.text));
          await js("document.querySelector('#surfEdge').dispatchEvent(new MouseEvent('mouseenter'))"); await wait(500);       // the mouse reaching the top edge
          const h1 = await bar(); log.push('surf host: hub bar shown ' + JSON.stringify(h1));
          tl('...and comes back with the Surf bar, at the left, level with it and clear of it', +h1.op === 1 && h1.bar.l === 18 && h1.bar.t === h1.surf.t && h1.bar.r + 16 <= h1.surf.l);
          await js("document.querySelector('#noAnim').remove()");
        }
        await step('ready');
        need('a member watching: the stream window opens', await until(() => !!ssWin && ssWatchers().length === 1, 60000));
        need('...and connects to them', await until(() => Object.values(ssPeers).includes('connected'), 40000));
        tl('...certificate checked', await until(() => Object.values(chat.info().ss.host.viewers).some((v) => v.verdict === 'verified'), 20000));
        let st = null;
        tl('...relayed through the hub, sending picture and sound', await until(async () => { st = ssWin && await pageJs(ssWin.webContents, 'window.surfStreamTest()').catch(() => null); return !!st && Object.values(st.peers).some((p) => /relay/.test(p.path || '') && p.framesOut > 10 && p.audioOut > 0); }, 20000));
        log.push('surf host: stream ' + JSON.stringify(st));
        const cpu0 = app.getAppMetrics(); await wait(3000);       // what it costs this PC: every process's processor use while streaming to one
        log.push('surf host: cpu ' + JSON.stringify(app.getAppMetrics().filter((x) => x.cpu.percentCPUUsage > 1).map((x) => `${x.type}:${x.cpu.percentCPUUsage.toFixed(0)}%`)));
        void cpu0;
        await step('watching');
        tl('the member clicks the link over the picture: the page goes there', await until(() => hubWeb.info().title === 'page two', 30000));
        tl('...and types into the box', await until(() => hubWeb.info().title === 'typed:hi', 30000));
        // Enter (web.js "Enter"): in the box it's the page's; with nothing in the page selected it opens their chat box instead
        const enters = async () => { const f = hubWeb.captureFrame(); return f ? +(await f.executeJavaScript('document.body.dataset.enters || 0').catch(() => 0)) : 0; };
        tl('...Enter in the box goes to the page', await until(async () => (await enters()) === 1, 20000));
        tl('...but not once nothing in the page is selected', await until(async () => !(await hubWeb.captureFrame().executeJavaScript('document.activeElement === document.querySelector("#i")')), 20000) && (await wait(1500), (await enters()) === 1));
        tl('...their pointer reaches me', await until(() => pointers.has(chat.info().ss.host.watchers[0]), 15000));
        {       // one page, one mouse: the hover is one person's at a time (web.js takeHover). (Over the empty right of page two.)
          // (the scroll is the member's own: the last to click or scroll is who a download is put down to, and theirs comes next)
          const mv = (who, y) => hubWeb.input({ k: 'move', x: 0.9, y, bt: 0, m: [] }, false, who), g = chat.info().ss.host.watchers[0];
          hubWeb.input({ k: 'wheel', x: 0.9, y: 0.8, dx: 0, dy: 0, m: [] }, false, g);
          tl('a scroll takes the hover at once', hubWeb.hover() === g);
          mv(g, 0.8); mv('testB', 0.85);
          tl('...and someone else\'s move doesn\'t take it while theirs is moving', hubWeb.hover() === g);
          await wait(900); mv('testB', 0.85);
          tl('...but does once theirs has been still a moment', hubWeb.hover() === 'testB');
        }
        await step('typed');
        tl('a flood of input from them is slowed', await until(() => ssDropped > 0, 15000));
        await step('flooded');
        tl('a download they start waits for me, naming them', await until(() => held.length === 1 && hubName(held[0].from) === 'Guesty' && held[0].d.name === 'first.bin', 30000));
        await wait(1500);       // (it has all arrived by now, in the holding folder)
        tl('...on my screen, as a card', await until(() => js("!document.querySelector('#heldCard').hidden && /Guesty wants to download/.test(document.querySelector('#heldCard').textContent)"), 5000));
        tl('...and nothing is in my Downloads folder yet', fs.readdirSync(dl).length === 0);
        await js("[...document.querySelectorAll('#heldCard button')].find((b) => b.textContent === 'Save').click()");
        tl('Save: it lands in my Downloads folder', await until(() => fs.existsSync(path.join(dl, 'first.bin')) && fs.statSync(path.join(dl, 'first.bin')).size === big.length, 15000));
        await step('saved');
        tl('their second download waits too', await until(() => held.length === 1 && held[0].d.name === 'second.bin', 30000));
        await wait(1500);
        await js("[...document.querySelectorAll('#heldCard button')].find((b) => b.textContent === 'Refuse').click()");
        await wait(1500);
        const holdDir = path.join(app.getPath('userData'), 'hub-downloads');
        tl('Refuse: nothing is kept, here or in Downloads', !fs.existsSync(path.join(dl, 'second.bin')) && (!fs.existsSync(holdDir) || fs.readdirSync(holdDir).length === 0));
        await step('refused');
        const tabs0 = hubWeb.info().tabs.length;
        tl('a link that opens a window opens a tab instead (no window on my screen)', await until(() => hubWeb.info().tabs.length === tabs0 + 1, 20000) && BrowserWindow.getAllWindows().every((w) => !w.getParentWindow()));
        await step('popped');
        tl('a file picker and page boxes don\'t open', await until(() => /^pick:no:NotAllowedError/.test(hubWeb.info().title), 20000));
        await step('picked');
        await wait(3000);
        tl('another local address isn\'t reached', lanHits === 0);
        // the media stream at the same time: a video on it, while the Surf stream carries on
        if (process.env.DRIFT_TESTSS_CLIP) {
          state.video.folders = [path.dirname(process.env.DRIFT_TESTSS_CLIP)];
          ipcMain.emit('cmd', { sender: wc }, { type: 'play-videos', files: [process.env.DRIFT_TESTSS_CLIP], key: visWins[0].key });
          tl('a video goes on the media stream meanwhile', await until(() => p2p.role() === 'host' && ((hubNow() || {}).lives || []).length === 1, 30000));
        }
        await step('media');
        // disconnecting from my own hub: my own browser back, the hub's still running for them
        chat.disconnect(hubNow() ? hubNow().id : chat.hostedHub());
        tl('disconnected: my own browser is back, with its tab', await until(() => surfMode() === 'own' && web.info().has && web.info().open, 15000));
        tl('...and the hub\'s browser still runs for everyone else', hubWeb.running() && Object.values(ssPeers).includes('connected'));
        await step('away');
        chat.reconnect(chat.hostedHub());
        tl('connecting again: the hub\'s browser is back where it was', await until(() => surfMode() === 'hub' && surfView().open && /^typed:hi|page two|pick/.test(hubWeb.info().title || ''), 20000));
        tl('...and my own is put away again', !web.info().has && !!surfKept);
        await step('back');
        srv.close(); lan.close();
      } else {
        need('the host\'s invite', await until(() => fs.existsSync(codeFile) && !!fs.readFileSync(codeFile, 'utf8'), 120000));
        await js(`document.querySelector('#chCode').value = ${JSON.stringify(fs.readFileSync(codeFile, 'utf8'))}; document.querySelector('#chJoin').click()`);
        need('joined the hub', await until(() => !!hubNow(), 60000));
        await step('ready');
        const [base, lanUrl] = fs.readFileSync(path.join(outDir, 'base.txt'), 'utf8').split('\n');
        surf('new');       // the Surf tab
        tl('the Surf tab is the hub\'s Surf stream', await until(() => surfMode() === 'stream' && surfView().stream && surfView().open, 15000));
        const t = () => js('window.ssTest()');
        need('picture and sound arrive, relayed', await until(async () => { const r = await t(); return r.framesIn > 10 && r.audioIn > 0 && /relay/.test(r.path || ''); }, 60000));
        const f0 = await t(); await wait(3000); const f1 = await t();
        log.push('surf guest: ' + JSON.stringify(f1) + ` · ${((f1.framesIn - f0.framesIn) / 3).toFixed(1)} frames a second, ${(((f1.bytesIn - f0.bytesIn) * 8) / 3e6).toFixed(2)} Mb/s`);
        tl('the host\'s certificate checked', await until(() => (chat.info().ss.watching || {}).verdict === 'verified', 40000));       // (room for one reconnect: see ssCert in renderer/app.js)
        tl('the Surf bar shows the host\'s page', await until(() => surfView().title === 'Test one' && surfView().tabs.length >= 1, 15000));
        tl('the Surf bar says whose stream it is', await until(() => js("document.querySelector('#ssLine').classList.contains('on') && !!document.querySelector('#ssLine').closest('#surfBar') && /Surf stream · .* · everyone can control/.test(document.querySelector('#ssLine').title)"), 10000));
        await step('watching');
        ipcMain.emit('cmd', { sender: wc }, { type: 'web-ptr', x: 0.6, y: 0.6 });
        click(0.25, 0.25);
        tl('clicking the link: my picture follows', await until(() => surfView().title === 'page two', 30000));
        tl('...and the pointer the page asks for (a hand, a bar over text) reaches me, on my picture', await until(async () => [...ssCurSeen].some((c) => c !== 'default') && /^[a-z-]+$/.test(await js("document.querySelector('#webStream').style.cursor")), 10000));
        log.push('surf guest: pointers from the host ' + JSON.stringify([...ssCurSeen]));
        await wait(800);
        for (const k of ['h', 'i']) { input({ k: 'key', d: true, key: k, m: [] }); input({ k: 'key', d: false, key: k, m: [] }); }
        tl('typing: my bar shows it', await until(() => surfView().title === 'typed:hi', 30000));
        const enter = () => { input({ k: 'key', d: true, key: 'Enter', m: [] }); input({ k: 'key', d: false, key: 'Enter', m: [] }); };
        const quickOpen = () => js("document.querySelector('#chatOverlay').classList.contains('typing')");
        enter();       // in the page's box: the page's (the host checks it got there)
        await wait(1500);
        tl('Enter in the page\'s text box: no chat box here', !(await quickOpen()));
        click(0.9, 0.8);       // (off the box: nothing in the page is selected)
        await wait(800);
        enter();
        tl('Enter with nothing in the page selected: the hub chat\'s quick box opens over the stream', await until(quickOpen, 15000));
        await js('window.chatUI.closeQuick()');
        for (let i = 0; i < 10; i++) ipcMain.emit('cmd', { sender: wc }, { type: 'web-ptr', x: 0.6, y: 0.6 + i / 100 });
        // Scenes chosen: the picture is put away, its sound plays on (decision §11.1); Surf again: the same connection, shown again
        surf('hide');
        const a0 = (await t()).audioIn; await wait(2500); const a1 = await t();
        tl('put away: its sound plays on, the picture hidden', a1.audioIn > a0 && a1.state === 'connected' && await js("document.querySelector('#webStream').classList.contains('parked')"));
        surf('show');
        tl('...and shown again on the same connection', (await wait(1500), (await t()).state === 'connected') && await js("!document.querySelector('#webStream').classList.contains('parked')"));
        await step('typed');
        for (let i = 0; i < 400; i++) input({ k: 'move', x: (i % 100) / 100, y: 0.5, bt: 0 });       // a flood
        await step('flooded');
        surf('go', { text: base + '/dl' });
        tl('my download waits for the host', await until(() => /Waiting for the host to allow first\.bin/.test(lastToast), 20000));
        await step('saved');
        tl('...and never lands here', !fs.existsSync(path.join(dl, 'first.bin')));
        surf('go', { text: base + '/dl2' });
        await step('refused');
        tl('refused: I\'m told', await until(() => /didn't allow second\.bin/.test(lastToast), 15000));
        surf('go', { text: base + '/pop' });
        await wait(2500);
        click(0.5, 0.5);
        await step('popped');
        surf('go', { text: base + '/pick' });
        await step('picked');
        surf('go', { text: lanUrl });
        await wait(2000);
        if (process.env.DRIFT_TESTSS_CLIP) tl('the media stream\'s video reaches me too', await until(() => p2p.connected(), 40000));
        await step('media');
        tl('the host disconnected: the stream carries on', (await wait(3000), (await t()).state === 'connected'));
        await step('away');
        await step('back');
        await chat.disconnect(hubNow().id);
        tl('disconnecting: my own browser is back', await until(() => surfMode() === 'own', 10000));
      }
    } catch (e) {
      if (!/^stopped early/.test(e && e.message)) { tl('failed: ' + (e && e.stack || e), false); abort('crashed'); }
      if (aborted()) res.stopped = fs.readFileSync(abortFile, 'utf8');       // (why: the test script prints it)
    }
    fs.writeFileSync(path.join(outDir, role + '.json'), JSON.stringify(res, null, 1));
    await step('end', 20000);
  }
  if (process.env.DRIFT_TESTBCUI) {     // the Share tab between two copies of Drift (DRIFT_USERDATA apart), pressing the real buttons: =host or =guest.
    // DRIFT_TESTCODE = a file for the invite, DRIFT_TESTBC_OUT = a folder for each step's marker and what each saw (<role>.json).
    const role = process.env.DRIFT_TESTBCUI, codeFile = process.env.DRIFT_TESTCODE, outDir = process.env.DRIFT_TESTBC_OUT, other = role === 'host' ? 'guest' : 'host';
    const name = role === 'host' ? 'Hosty' : 'Guesty', wc = visWins[0].win.webContents, js = (c) => pageJs(wc, c);
    const until = async (f, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await f()) return true; await wait(250); } return !!(await f()); };
    const step = async (s) => { fs.writeFileSync(path.join(outDir, `${role}-${s}`), ''); log.push(`bcui ${role}: at ${s}`); return until(() => fs.existsSync(path.join(outDir, `${other}-${s}`)), 90000); };
    const hubNow = () => chat.info().hubs.find((h) => h.status === 'connected');
    const read = () => js(`JSON.stringify({ tab: !document.querySelector('.tabs button[data-tab="broadcast"]').hidden, onair: document.querySelector('.tabs button[data-tab="broadcast"]').classList.contains('onair'),
      active: (document.querySelector('#content section.active') || { dataset: {} }).dataset.tab || '', open: document.querySelector('#panel').classList.contains('open'),
      cards: [...document.querySelectorAll('.bcTile')].map((c) => ({ text: c.querySelector('.bcTFoot').innerText.replace(/\\n+/g, ' | '), btns: [...c.querySelectorAll('.bcTFoot button')].map((b) => b.textContent + (b.disabled ? ' (off)' : '')) })),
      scene: document.body.classList.contains('bc'), full: document.body.classList.contains('bcfull'), pill: (document.querySelector('.tabGroup button.showing') || { dataset: {} }).dataset.tab || '',
      empty: document.querySelector('#bcEmpty').classList.contains('on') ? document.querySelector('#bcEmpty').innerText : '', go: getComputedStyle(document.querySelector('#bcGo')).display !== 'none', mine: getComputedStyle(document.querySelector('#bcMine')).display !== 'none',
      mineTitle: document.querySelector('#bcMineTitle').textContent, mineWho: document.querySelector('#bcMineWho').textContent, picked: document.querySelector('#bcPicked').textContent,
      start: !document.querySelector('#bcStart').disabled, screens: [...document.querySelectorAll('#bcScreens .bcSrc')].map((b) => b.dataset.src), apps: [...document.querySelectorAll('#bcApps .bcSrc')].map((b) => b.dataset.src),
      off: getComputedStyle(document.querySelector('#bcOff')).display !== 'none', toast: document.querySelector('#toast').textContent })`).then(JSON.parse);
    const click = (sel) => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (b) b.click(); return !!b; })()`);
    const cardBtn = (label, where = '.bcTile .bcTFoot button') => pageRun(wc, (sel, l) => { const b = [...document.querySelectorAll(sel)].find((x) => x.textContent === l); if (b) b.click(); return !!b; }, where, label);
    // A real click lands on whatever is drawn on top (b.click() doesn't care): is the panel's tab row what's under the pointer?
    const onTop = () => pageRun(wc, () => { const t = document.querySelector('#panel .tabs').getBoundingClientRect(); return document.querySelector('#panel').contains(document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)); });
    const res = { role, name, me: chat.myId(), seen: {} };
    const keep = async (k) => { res.seen[k] = await read(); };
    fs.mkdirSync(outDir, { recursive: true });
    patch({ music: { source: 'off' }, share: { internet: false, name }, voice: { talk: false, deaf: false, ptt: false, direct: false, pin: '' } });
    wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(1000);
    await keep('before');       // no hub yet: no Share tab
    if (role === 'host') {
      await js("document.querySelector('#chHost').click()");
      await until(() => hubNow() && hubNow().room.in);
      fs.writeFileSync(codeFile, (await chat.invite(hubNow().id)).code || '');
    } else {
      await until(() => fs.existsSync(codeFile) && fs.readFileSync(codeFile, 'utf8'), 60000);
      await js(`document.querySelector('#chCode').value = ${JSON.stringify(fs.readFileSync(codeFile, 'utf8'))}; document.querySelector('#chJoin').click()`);
      await until(() => hubNow() && hubNow().room.in);
    }
    await until(async () => (await read()).tab, 10000);
    await keep('connected');
    await step('joined');
    wc.send('cmd', { type: 'show-panel', tab: 'broadcast' }); await wait(500);
    if (role === 'host') {
      await until(() => js('window.broadcastUI.sources().screens.length > 0'), 15000);
      await wait(600);
      await keep('picker');
      res.own = BrowserWindow.getAllWindows().map((w) => { try { return w.getMediaSourceId(); } catch { return ''; } });
      await snap('bc-host-picker');
      await click('#bcScreens .bcSrc'); await wait(300);
      await keep('picked');
      await click('#bcStart');
      await until(() => !!chat.info().bc.mine);
      await wait(800);
      await keep('live');
      await snap('bc-host-live');
      await click('.tabs button[data-tab="broadcast"]');       // the tab again, page open: the page goes and the grid shows, with Hosty's own tile
      await until(async () => { const r = await read(); return r.scene && r.cards.length === 1; }, 10000);
      await keep('hostScene');
      const ownVid = () => pageRun(wc, () => { const v = document.querySelector('.bcTile.mine .bcVid'), s = v && v.srcObject; return { live: document.querySelector('.bcTile.mine').classList.contains('live'), w: v ? v.videoWidth : 0, t: v ? +v.currentTime.toFixed(2) : 0, audio: s ? s.getAudioTracks().length : -1, muted: !!(v && v.muted) }; });
      await cardBtn('Preview');       // what Hosty is sending, live and silent, in its own tile
      await until(async () => (await ownVid()).t > 1, 15000);
      res.seen.preview = { ...(await ownVid()), btns: (await read()).cards[0].btns };
      await cardBtn('Stop preview');
      await until(async () => !(await ownVid()).live, 5000);
      res.seen.previewOff = { ...(await ownVid()), btns: (await read()).cards[0].btns };
      await cardBtn('Manage');       // its page again, over the grid
      await until(async () => (await read()).open, 5000);
      await keep('manage'); res.seen.manage.onTop = await onTop();
      await step('live');
      await step('watching');
      await until(async () => /Guesty · watching/.test((await read()).mineWho), 15000);
      await keep('watched'); res.hubSaysWatching = (hubNow().bcs[0] || { viewers: [] }).viewers;
      await snap('bc-host-watched');
      await step('seen');
      await step('unwatched');
      await until(async () => /Nobody/.test((await read()).mineWho), 15000);
      await keep('unwatched');
      await click('#bcStop');
      await until(async () => { const r = await read(); return r.go && !r.mine && !chat.info().bc.mine; }, 15000);
      await keep('stopped');
      await step('stopped');
      await until(() => fs.existsSync(path.join(outDir, 'guest.json')), 60000);
    } else {
      await step('live');
      res.toast = (await read()).toast;
      await click('.tabs button[data-tab="broadcast"]');       // the grid, on this screen
      await until(async () => { const r = await read(); return r.scene && r.cards.length === 1; }, 15000);
      await keep('card');
      await snap('bc-guest-card');
      await cardBtn('Watch');
      await until(async () => chat.info().bc.watching.length === 1 && (await read()).full, 15000);
      await keep('watching');
      await step('watching');
      await step('seen');
      await cardBtn('Stop watching', '#bcBar button');
      await until(async () => { const r = await read(); return !chat.info().bc.watching.length && !r.full && r.cards[0].btns.includes('Watch'); }, 15000);
      await keep('unwatched');
      await step('unwatched');
      await step('stopped');
      await until(async () => !!(await read()).empty, 15000);
      await keep('ended');
      await cardBtn('Go live', '#bcEmpty button');       // the empty grid's Go live: the Share page opens over it, where it can be clicked
      await until(async () => (await read()).open, 5000);
      await keep('goLive'); res.seen.goLive.onTop = await onTop();
      await js(`(() => { const b = [...document.querySelectorAll('#callBar button')].find((x) => x.textContent === 'Leave hub'); if (b) b.click(); return !!b; })()`);       // on the Share tab: it goes, and the panel goes back to the Hub tab
      await until(async () => { const r = await read(); return !r.tab && r.active === 'hub' && !r.scene; }, 15000);
      await keep('disconnected');
    }
    fs.writeFileSync(path.join(outDir, role + '.json'), JSON.stringify(res, null, 1));
    log.push(`bcui ${role}: wrote what it saw`);
  }
  if (process.env.DRIFT_TESTBC) {     // a broadcast between three copies of Drift (scripts/test-broadcast.js): =host, =guest or =third, pressing the real buttons.
    // DRIFT_TESTCODE = a file for the invite, DRIFT_TESTBC_OUT = a folder for each step's marker and what each saw (<role>.json).
    // DRIFT_TESTBROADCAST makes the broadcast window send a moving test pattern in place of the screen it was given.
    const role = process.env.DRIFT_TESTBC, codeFile = process.env.DRIFT_TESTCODE, outDir = process.env.DRIFT_TESTBC_OUT;
    const name = { host: 'Hosty', guest: 'Guesty', third: 'Third' }[role], wc = visWins[0].win.webContents, js = (c) => pageJs(wc, c);
    const until = async (f, ms = 30000) => { for (let t = 0; t < ms; t += 250) { if (await f()) return true; await wait(250); } return !!(await f()); };
    const step = async (s, ms = 90000) => { fs.writeFileSync(path.join(outDir, `${role}-${s}`), ''); log.push(`bc ${role}: at ${s}`); return until(() => ['host', 'guest', 'third'].every((r) => fs.existsSync(path.join(outDir, `${r}-${s}`))), ms); };
    const hubNow = () => chat.info().hubs.find((h) => h.status === 'connected');
    const click = (sel) => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (b) b.click(); return !!b; })()`);
    const btnIn = (sel, label) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
    const view = (id) => pageRun(wc, (x) => window.bcTest(x), id || '').catch((e) => ({ error: e.message }));
    const sendTest = () => (bcWin ? pageJs(bcWin.webContents, 'window.bcSendTest()').catch((e) => ({ error: e.message })) : null);
    const bar = () => js("document.querySelector('#callBar').innerText.replace(/\\n+/g, ' | ')");
    const tiles = () => ((publicState().bcView || {}).tiles || []).filter((t) => !t.mine);       // the Broadcast scene's tiles (others')
    const tileOf = (who) => tiles().find((t) => t.who === who) || {};
    const tileClick = (who, label) => pageRun(wc, (id, l) => window.bcTestClick(id, l), tileOf(who).bc || '', label);
    const live = async (id) => { const v = await view(id); return v.on && v.state === 'connected' && v.framesIn > 20; };
    const res = { role, name, me: chat.myId(), steps: {} }, s0 = (r) => r.steps;
    const keep = (k, v) => { res.steps[k] = v; const t = `bc ${role}: ${k} ${String(JSON.stringify(v)).slice(0, 300)}`; log.push(t); try { fs.appendFileSync(path.join(outDir, role + '.log'), t + '\n'); } catch { /* fine */ } };       // (as it goes, so a stuck copy can be read)
    fs.mkdirSync(outDir, { recursive: true });
    for (const ev of ['unhandledRejection', 'uncaughtException']) process.on(ev, (e) => { try { fs.appendFileSync(path.join(outDir, role + '.log'), `ERROR ${ev}: ${e && e.stack || e}\n`); } catch { /* fine */ } });
    patch({ music: { source: 'off' }, share: { internet: false, name }, voice: { talk: false, deaf: false, ptt: false, direct: false, pin: '' }, broadcast: { pointers: true, quality: 'auto', sound: false } });
    wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(1000);
    if (role === 'host') {
      await js("document.querySelector('#chHost').click()");
      await until(() => hubNow() && hubNow().room.in);
      fs.writeFileSync(codeFile, (await chat.invite(hubNow().id)).code || '');
    } else {
      await until(() => fs.existsSync(codeFile) && fs.readFileSync(codeFile, 'utf8'), 60000);
      await js(`document.querySelector('#chCode').value = ${JSON.stringify(fs.readFileSync(codeFile, 'utf8'))}; document.querySelector('#chJoin').click()`);
      await until(() => hubNow() && hubNow().room.in);
    }
    await until(() => { const h = hubNow(); return h && h.members.length + h.suspect.length >= 3; }, 60000);
    await step('joined');
    wc.send('cmd', { type: 'show-panel', tab: 'broadcast' }); await wait(600);
    if (role === 'host') {
      await until(() => js('window.broadcastUI.sources().screens.length > 0'), 15000);
      await click('#bcScreens .bcSrc'); await wait(300);
      await js("document.querySelector('#bcSound button[data-v=\"on\"]').click()"); await wait(300);       // Sound on: a screen, so everything but Drift (the test's quiet tone plays from another program)
      keep('soundNote', await js("document.querySelector('#bcSoundNote').textContent"));
      await click('#bcStart');
      keep('live', await until(() => !!chat.info().bc.mine && !!bcWin, 15000));
      keep('soundLive', await until(() => (bcLiveInfo() || {}).sound === 'on', 15000) && { live: bcLiveInfo().sound, hub: !!chat.info().bc.mine.audio });
      keep('trayLive', !!micTray);
      await wait(1000);
      keep('barLive', await bar());
    }
    await step('live');
    if (role !== 'host') {       // the Share tab: this screen turns into the grid, Hosty's tile shows a still, and Watch fills the screen
      await click('.tabs button[data-tab="broadcast"]');
      await pageRun(wc, () => { const s = document.createElement('style'); s.textContent = '.bcTile { transition: none !important; }'; document.head.append(s); });       // (hidden windows don't run transitions: tiles are measured where they land)
      keep('scene', await until(() => tiles().length === 1 && (publicState().bcView || {}).key === visWins[0].key, 15000));
      keep('still', await until(async () => ((await view()).tiles || []).some((t) => t.still), 20000) && (await view()).tiles.map((t) => ({ who: t.who, stillW: t.stillW, btns: t.btns, rect: t.rect, text: t.text })));
      await tileClick('Hosty', 'Watch');
      keep('viewOn', await until(() => live(), 45000));
      await wait(3500);       // (longer than the bar stays out by itself)
      { const v = await view(); keep('hint', { hint: v.hint, nudge: v.nudge, barOut: v.barOut }); }
      const a = await view(); await wait(2000); const b = await view();
      keep('frames', { first: a.framesIn, later: b.framesIn, video: b.video, path: b.path, dtls: b.dtls, signed: b.signed, bar: b.bar, note: b.note });
      await until(() => tileOf('Hosty').verdict === 'verified', 10000);
      keep('verdict', tileOf('Hosty').verdict);
      keep('cardLock', await js("!!document.querySelector('#bcBar .lock.ok')"));
      keep('barWatch', await bar());
      keep('refusedWarn', await js("(document.querySelector('.bcTile .bcTNote.warn') || {}).textContent || ''"));
      if (s0(res).viewOn) {       // the sound: it arrives, it's the tone (not silence or noise), stereo, and its own volume works
        await until(async () => (await view()).audioIn > 2000, 15000);
        const t = await (async () => { let best = null; for (let i = 0; i < 12; i++) { const a = await js('window.bcTestTone(1000)'), b = await js('window.bcTestTone(700)'); if (a !== null && (!best || a - b > best.k1000 - best.k700)) best = { k1000: +a.toFixed(1), k700: +b.toFixed(1) }; await wait(250); } return best; })();
        const v1 = await view();
        keep('sound', { audioIn: v1.audioIn, level: v1.audioLevel, stereo: v1.stereo, muted: v1.muted, volume: v1.volume, avDelay: v1.avDelay, tone: t, card: (v1.tiles[0] || {}).text || '', slider: await js("!!document.querySelector('#bcBar .bcVol input')") });
        await js(`(() => { const r = document.querySelector('#bcBar .bcVol input'); r.value = 20; r.dispatchEvent(new Event('input')); })()`);
        await until(async () => Math.abs((await view()).volume - 0.2) < 0.01, 5000);
        keep('soundVol', { volume: (await view()).volume, saved: state.voice.volumes['bc:' + tileOf('Hosty').from] });
      }
      if (role === 'guest' && s0(res).viewOn) {       // Back: the grid again, Hosty still playing in its tile on the same connection; Watch fills the screen again
        const a = await view();
        await btnIn('#bcBar button', '← Back');
        await until(async () => !(await view()).full, 5000);
        await wait(2000);
        const b = await view(), tb = b.tiles[0] || {};
        keep('back', { full: b.full, live: tb.live, shown: tb.shown, rect: tb.rect, screen: [visWins[0].win.getContentBounds().width, visWins[0].win.getContentBounds().height], first: a.framesIn, later: b.framesIn, same: !!a.dtls && a.dtls === b.dtls, btns: tb.btns, barOut: b.barOut });
        await tileClick('Hosty', 'Watch');
        await until(async () => (await view()).full === tileOf('Hosty').bc, 5000);
        const c = await view();
        keep('watchAgain', { full: !!c.full, same: c.dtls === a.dtls, rect: (c.tiles[0] || {}).rect });
      }
    }
    await step('watching');
    // Cursors: off until you turn it on, for each broadcast
    if (role === 'guest') {
      for (let i = 0; i < 6; i++) { await js('window.bcTestPoint(0.25, 0.4)'); await wait(150); }
    }
    await step('pointed-off');
    if (role === 'host') keep('ptrsBeforeOptIn', (bcOvLast && bcOvLast.list.map((p) => p.id)) || []);
    await step('checked-off');
    if (role === 'guest') {
      await btnIn('#bcBar button', 'Share my cursor');
      await until(() => tileOf('Hosty').share, 5000);
      for (let i = 0; i < 20; i++) { await js('window.bcTestPoint(0.25, 0.4)'); await wait(100); }
      keep('shareOn', tileOf('Hosty').share);
      { const v = await view(); keep('hintGone', !v.hint && !v.nudge); }
      const h = chat.info().hubs.find((x) => x.status === 'connected');       // chat over what's being broadcast (games too): it reaches Hosty's overlay
      await chat.send(h.id, h.channels[0].id, 'hi over the game');
      const over = () => Promise.all(visWins.map((v) => pageJs(v.win.webContents, 'window.chatUI.overlay()'))).then((a) => a.flat());
      keep('chatOverBc', await until(async () => (await over()).some((t) => /over the broadcast/.test(t)), 15000));       // and Hosty's, over the broadcast here
    }
    if (role === 'host') {
      keep('chatOverGame', await until(() => !!(bcOvLast && (bcOvLast.msgs || []).some((x) => x.text === 'hi over the game' && x.name === 'Guesty')), 15000));
      keep('chatNotInWindows', (await Promise.all(visWins.map((v) => pageJs(v.win.webContents, 'window.chatUI.overlay()')))).flat().length === 0);
      { const h = chat.info().hubs.find((x) => x.status === 'connected'); await chat.send(h.id, h.channels[0].id, 'hi over the broadcast'); }
      const g = () => bcOvLast && bcOvLast.list.find((p) => p.name === 'Guesty');
      keep('overlayGot', await until(() => !!g(), 15000));
      keep('overlayAt', g() || null);
      keep('overlayRect', bcOvLast && bcOvLast.rect);
      keep('overlayProtected', !!(bcOv && !bcOv.isDestroyed()));
    }
    if (role === 'third') {
      keep('thirdSeesGuesty', await until(async () => (await view()).ptrs.length > 0, 15000));
    }
    await step('pointed');
    if (role === 'host') {       // how it's going: relayed, a cap on each viewer, the tab's live card
      const st = await sendTest();
      keep('send', st);
      keep('liveInfo', bcLiveInfo());
      keep('tab', await js("({ stats: document.querySelector('#bcMineStats').textContent, who: document.querySelector('#bcMineWho').innerText.replace(/\\n+/g, ' | ') })"));
      keep('trackBefore', st && st.track);
      await click('#bcSwitch');       // Switch source: pick a screen again (another one, if there is)
      await until(() => js('window.broadcastUI.sources().screens.length > 0'), 15000); await wait(500);
      await js("(() => { const t = [...document.querySelectorAll('#bcScreens .bcSrc')]; (t[1] || t[0]).click(); })()"); await wait(300);
      await click('#bcStart');
      await until(async () => { const s2 = await sendTest(); return s2 && s2.track && s2.track !== st.track; }, 15000);
      await wait(2500);
      keep('afterSwitch', await sendTest());
    } else await wait(1000);
    await step('switched', 60000);
    if (role !== 'host') {
      const a = await view(); await wait(2000); const b = await view();
      keep('afterSwitch', { state: b.state, first: a.framesIn, later: b.framesIn, dtls: b.dtls });
    }
    await step('checked-switch');
    if (role === 'host') {       // Sound off while live: the helper stops, nobody reconnects, and viewers' cards say so
      const before = await sendTest();
      await js("document.querySelector('#bcSoundLive button[data-v=\"off\"]').click()");
      await until(() => !bcSnd && !chat.info().bc.mine.audio, 8000);
      await wait(1500);
      const after = await sendTest();
      keep('soundOff', { helper: !!bcSnd, hub: chat.info().bc.mine.audio, live: (bcLiveInfo() || {}).sound, sending: after && after.sound, sameConn: !!after && !!before && Object.keys(before.peers).some((id) => before.peers[id].state === 'connected') && Object.keys(before.peers).filter((id) => before.peers[id].state === 'connected').every((id) => after.peers[id] && after.peers[id].state === 'connected') });
    }
    await step('sound-off');
    if (role !== 'host' && s0(res).viewOn) keep('soundOffView', await until(async () => (await view()).muted && !tileOf('Hosty').audio, 8000) && { card: ((await view()).tiles[0] || {}).text || '', avDelay: (await view()).avDelay });
    await step('checked-sound-off');
    if (role === 'host') { await click('#bcPause'); await wait(500); }
    await step('paused');
    if (role !== 'host') keep('pausedNote', await until(async () => /paused/.test((await view()).note), 10000) && (await view()).note);
    if (role === 'host') keep('barPaused', await bar());
    await step('checked-pause');
    if (role === 'host') { await click('#bcPause'); await wait(500); }
    if (role === 'third') {       // Stop watching from the full-screen view's own bar: back to the grid, Hosty's tile a still again
      await btnIn('#bcBar button', 'Stop watching');
      keep('thirdStopped', await until(async () => !tileOf('Hosty').live && !(await view()).on, 10000) && { full: (await view()).full, tiles: (await view()).tiles.map((t) => ({ who: t.who, live: t.live, btns: t.btns })) });
    }
    await step('third-left');
    if (role === 'guest') keep('guestStillWatching', (await view()).state === 'connected' && !!tileOf('Hosty').live);
    if (role === 'host') keep('hubViewersAfterThird', ((hubNow().bcs || [])[0] || { viewers: [] }).viewers.map((id) => memberName(hubNow().id, id)));
    await step('checked-third');
    // Two broadcasts at once: Guesty goes live too (still watching Hosty's), and Third plays both in the grid, side by side
    if (role === 'guest') {
      wc.send('cmd', { type: 'show-panel', tab: 'broadcast' }); await wait(600);
      await until(() => js('window.broadcastUI.sources().screens.length > 0'), 15000);
      await click('#bcScreens .bcSrc'); await wait(300);
      await click('#bcStart');
      keep('guestLive', await until(() => !!chat.info().bc.mine && !!bcWin, 15000));
      await pageRun(wc, () => document.querySelector('#panel').classList.remove('open'));
    }
    await step('guest-live');
    if (role === 'third' && s0(res).viewOn) {       // (when the hub tampers with Hosty's broadcast for Third, this part is skipped)
      await until(() => tiles().length === 2, 15000);
      const two = await view();
      keep('twoTiles', two.tiles.map((t) => ({ who: t.who, btns: t.btns, still: t.still })));
      await tileClick('Hosty', 'Preview'); await tileClick('Guesty', 'Preview');
      const both = async () => (await live(tileOf('Hosty').bc)) && (await live(tileOf('Guesty').bc));
      keep('twoPlaying', await until(both, 45000));
      const h1 = await view(tileOf('Hosty').bc), g1 = await view(tileOf('Guesty').bc); await wait(2000);
      const h2 = await view(tileOf('Hosty').bc), g2 = await view(tileOf('Guesty').bc);
      const r = h2.tiles.map((t) => t.rect), apart = r.length === 2 && (r[0][0] + r[0][2] <= r[1][0] || r[1][0] + r[1][2] <= r[0][0] || r[0][1] + r[0][3] <= r[1][1] || r[1][1] + r[1][3] <= r[0][1]);
      keep('twoInGrid', { full: h2.full, hosty: [h1.framesIn, h2.framesIn], guesty: [g1.framesIn, g2.framesIn], rects: r, apart, shown: h2.tiles.map((t) => t.shown), btns: h2.tiles.map((t) => t.btns), screen: [visWins[0].win.getContentBounds().width, visWins[0].win.getContentBounds().height] });
      await tileClick('Guesty', 'Watch');       // one of them full screen: the other is hidden and quiet, still connected
      await until(async () => (await view()).full === tileOf('Guesty').bc, 5000);
      const f = await view();
      keep('oneFull', { full: f.full === tileOf('Guesty').bc, shown: f.tiles.map((t) => [t.who, t.shown]), hostyMuted: (f.tiles.find((t) => t.who === 'Hosty') || {}).muted, hostyLive: await live(tileOf('Hosty').bc), bar: f.bar });
      await btnIn('#bcBar button', '← Back');
      keep('backToTwo', await until(async () => { const v = await view(); return !v.full && v.tiles.every((t) => t.shown && t.live); }, 5000));
    }
    await step('two-checked');
    if (role === 'guest') { await click('#bcStop'); keep('guestStopped', await until(() => !chat.info().bc.mine, 10000)); }
    await step('guest-stopped');
    if (role === 'third') keep('guestTileGone', await until(() => !tileOf('Guesty').bc && !!tileOf('Hosty').bc, 10000));
    await step('checked-guest-stopped');       // (before Hosty stops too)
    if (role === 'host') {
      await click('#bcStop');
      keep('stopped', await until(() => !bcWin && !chat.info().bc.mine, 10000));
      keep('trayAfter', micTray ? 'tray' : 'none');
      keep('overlayGone', !bcOv);
    }
    await step('stopped');
    if (role === 'guest') keep('guestViewGone', await until(async () => !tiles().length && !(await view()).on && (await view()).empty, 10000));
    fs.writeFileSync(path.join(outDir, role + '.json'), JSON.stringify(res, null, 1));
    log.push(`bc ${role}: wrote what it saw`);
    await step('end', 30000);
  }
  if (process.env.DRIFT_TESTSURF) {     // the README's Surf picture: a new tab on Drift's start page
    const wc = visWins[0].win.webContents;
    ipcMain.emit('cmd', { sender: wc }, { type: 'surf', do: 'new' }); await wait(5000);
    await pageJs(wc, "document.querySelector('#panel').classList.remove('open')"); await wait(800); await snap('surf-home');
  }
  if (process.env.DRIFT_TESTTUNE) {     // exercise listening to music together, the same way: =host or =guest, DRIFT_TESTCODE as above. The guest's own music is off, so any sound it reports came from the host
    const role = process.env.DRIFT_TESTTUNE, codeFile = process.env.DRIFT_TESTCODE, wc = visWins[0].win.webContents, cmd = (c) => ipcMain.emit('cmd', { sender: wc }, c);
    const heard = () => { const l = lastLevels || {}; lastLevels = null; return 'loudest band=' + Math.max(0, ...(l.s || [0])); };
    const ui = () => pageJs(wc, "JSON.stringify({ now: document.querySelector('#nowName').textContent, play: document.querySelector('#play').textContent, note: document.querySelector('#mShare').textContent.slice(0, 90) })").catch((e) => 'failed: ' + e.message);
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
        if (i === 8) { log.push('guest presses play'); await pageJs(wc, "document.querySelector('#play').click()"); }
      }
    }
  }
  if (process.env.DRIFT_TESTSHAREUI) {     // press the real buttons in the Hub tab and read back what it says
    const wc = visWins[0].win.webContents, js = (c) => pageJs(wc, c);
    const dump = async (tag) => log.push('shareui ' + tag + ': ' + await js("JSON.stringify({ off: getComputedStyle(document.querySelector('#shOff')).display, host: getComputedStyle(document.querySelector('#shHost')).display, title: document.querySelector('#shTitle').textContent, sub: document.querySelector('#shSub').textContent, note: document.querySelector('#shNote').textContent, lives: document.querySelector('#chLives').innerText, toast: document.querySelector('#toast').className + '|' + document.querySelector('#toast').textContent, tab: (document.querySelector('#content section.active') || {}).dataset && document.querySelector('#content section.active').dataset.tab })"));
    patch({ music: { source: 'off' } });
    wc.send('cmd', { type: 'show-panel', tab: 'hub' }); await wait(1000); await dump('before');
    ipcMain.emit('cmd', { sender: wc }, { type: 'share-start', hub: '' }); await wait(1500); await dump('clicked with no video');
    if (process.env.DRIFT_TESTVIDEO) { setVideos([process.env.DRIFT_TESTVIDEO]); await wait(2500); ipcMain.emit('cmd', { sender: wc }, { type: 'share-start', hub: '' }); await wait(1500); await dump('clicked with video'); await wait(15000); await dump('15 s later'); }
    await js("document.querySelector('#shStop').click()"); await wait(2500); await dump('stopped');
  }
  if (process.env.DRIFT_TESTQUIT) {     // exercise the "Close Drift?" question: Esc asks, Esc again stays, closing the window asks too
    const v = visWins[0], wc = v.win.webContents, up = () => pageJs(wc, "document.querySelector('#confirm').classList.contains('on')");
    const key = (keyCode) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); wc.sendInputEvent({ type: 'keyUp', keyCode }); };
    key('Escape'); await wait(2000); log.push('quit: after Esc, asking=' + await up() + ' note=' + await pageJs(wc, "document.querySelector('#confirmNote').textContent")); await snap('quit-ask');
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
      const js = (code) => pageJs(page, code);
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
    if (!gpuRun) { await press('l', ['control']); log.push('Ctrl+L: focus in ' + await pageJs(sw, 'document.activeElement.id')); }
    if (gpuRun) {
      const pw = front() && BrowserWindow.fromWebContents(front()), hb = visWins[0].win.getBounds();
      log.push(`offscreen window: onTop=${pw && pw.isAlwaysOnTop()} visible=${pw && pw.isVisible()} at ${pw && JSON.stringify(pw.getBounds())}, Surf monitor at ${JSON.stringify(hb)}`);
      patch({ surfGpu: false }); await wait(1000);
    }
    srv.close(); web.close(); await wait(800);
    } catch (e) { log.push('keys test failed: ' + (e && e.stack || e)); web.close(); }
  }
  if (process.env.DRIFT_TESTPARK) {       // Surf put away (Scenes) and shown again (Surf): its page is the same one, not loaded again (with DRIFT_TESTGPU=1, drawn offscreen)
    try {
    const gpuRun = !!process.env.DRIFT_TESTGPU;
    if (gpuRun) { patch({ surfGpu: true }); await wait(300); }
    let loads = 0;
    const srv = http.createServer((_q, r) => { loads++; r.writeHead(200, { 'Content-Type': 'text/html' }); r.end('<!DOCTYPE html><title>park</title><body>park</body>'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`, sw = visWins[0].win.webContents;
    const click = (t) => pageJs(sw, `document.querySelector('.tabs button[data-tab=${t}]').click()`);
    web.act({ do: 'go', text: url }, visWins[0].key); await wait(4000);
    const front = () => webContents.getAllWebContents().find((x) => !x.isDestroyed() && x.getURL() === url);
    const see = async () => { const pg = front(); return `info.open=${web.info().open} parked=${web.info().parked || '-'} marker=${pg ? await pageJs(pg, 'window.mark || "none"') : 'no page'} loads=${loads} ` + await pageJs(sw, "`body.web=${document.body.classList.contains('web')} views=${document.querySelectorAll('webview').length} shown=${document.querySelectorAll('webview.on').length} gpu=${!!document.querySelector('#webGpu')}`"); };
    for (let i = 0; i < 20 && !front(); i++) await wait(500);
    if (!front()) throw new Error('the page never loaded: ' + JSON.stringify(web.info()));
    await pageJs(front(), 'window.mark = "kept"');
    log.push(`park (${gpuRun ? 'gpu' : 'webview'}) open: ` + await see());
    await click('scenes'); await wait(1500); log.push('park after Scenes: ' + await see());
    await click('surf'); await wait(1500); log.push('park after Surf again: ' + await see());
    if (gpuRun) patch({ surfGpu: false });
    srv.close(); web.close(); await wait(800);
    } catch (e) { log.push('park test failed: ' + (e && e.stack || e)); web.close(); }
  }
  if (process.env.DRIFT_TESTMIX) {       // the volume mixer: Surf's level reaches a page's sound (and a frame's), the page still sees its own volume; and a picture of the mixer
    try {
    const PAGE = '<!DOCTYPE html><title>mix</title><audio id="a"></audio><script>a.volume = 0.8; window.n = new Audio(); n.volume = 0.5;</script><iframe src="/f"></iframe>';
    const srv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(q.url === '/f' ? '<!DOCTYPE html><audio id="b"></audio><script>b.volume = 0.6</script>' : PAGE); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/`, sw = visWins[0].win.webContents;
    web.act({ do: 'go', text: url }, visWins[0].key);
    const front = () => webContents.getAllWebContents().find((x) => !x.isDestroyed() && x.getURL() === url);
    for (let i = 0; i < 30 && !front(); i++) await wait(500);
    await wait(1000);
    const pg = front();
    if (!pg) throw new Error('the page never loaded');
    const raw = "Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume').get";       // read in a world of its own: what is really applied
    const see = async () => {
      const f = pg.mainFrame.frames[0];
      const said = await pageJs(pg, '[a.volume, n.volume].join("/")');
      const real = await pg.executeJavaScriptInIsolatedWorld(999, [{ code: `${raw}.call(document.getElementById('a')).toFixed(2)` }]).catch((e) => 'err ' + e.message);
      const fr = f ? (await pageJs(f, 'b.volume.toFixed(2)').catch(() => '?')) + ' applied '
        + await pg.executeJavaScriptInIsolatedWorld(999, [{ code: `${raw}.call(document.querySelector('iframe').contentDocument.getElementById('b')).toFixed(2)` }]).catch((e) => 'err ' + e.message) : 'no frame';
      return `page says ${said}, <audio> applied ${real}, frame says ${fr}`;
    };
    log.push('mix start: ' + await see());
    patch({ mixer: { surf: 0.5 } }); await wait(500); log.push('mix surf 50%: ' + await see());
    patch({ mixer: { master: 0.5 } }); await wait(500); log.push('mix + master 50%: ' + await see());
    await pageJs(pg, 'a.volume = 1'); log.push('mix page sets 1: ' + await see());
    patch({ mixer: { surfMute: true } }); await wait(500); log.push('mix surf muted: ' + await see());
    patch({ mixer: { surfMute: false } }); await wait(300);
    web.hide(); await wait(500);
    await pageJs(sw, "document.querySelector('.tabs button[data-tab=scenes]').click()"); await wait(800);
    await pageJs(sw, "document.querySelector('#panel').classList.remove('open'); document.body.dispatchEvent(new MouseEvent('mousemove', { screenX: 400, screenY: 400, bubbles: true })); document.body.dispatchEvent(new MouseEvent('mousemove', { screenX: 420, screenY: 420, bubbles: true })); document.querySelector('#mixBtn').click()"); await wait(700);
    log.push('mixer open: ' + await pageJs(sw, "(() => { const m = document.querySelector('#mixer'), r = m.getBoundingClientRect(); return m.className + ' ' + getComputedStyle(m).display + ' ' + JSON.stringify([r.x, r.y, r.width, r.height].map(Math.round)); })()"));
    await snap('mixer');
    log.push('mixer rows: ' + await pageJs(sw, "[...document.querySelectorAll('.mixRow')].filter((r) => r.style.display !== 'none').map((r) => r.dataset.id + '=' + r.querySelector('output').textContent + (r.classList.contains('off') ? '(muted)' : '')).join(' ')"));
    log.push('mixer over the panel: ' + await pageJs(sw, "(() => { const m = document.querySelector('#mixer').getBoundingClientRect(), b = document.querySelector('#mixBtn').getBoundingClientRect(), hit = document.elementFromPoint(m.left + 20, m.top + 20); return `panel ${document.querySelector('#panel').className} opacity ${getComputedStyle(document.querySelector('#panel')).opacity}; mixer bottom ${Math.round(m.bottom)} above speaker top ${Math.round(b.top)}: ${m.bottom <= b.top}, its parent ${document.querySelector('#mixer').parentElement.tagName}, on top: ${!!hit.closest('#mixer')}`; })()"));
    await pageJs(sw, "document.querySelector('.mixRow[data-id=ambient] .mixIco').click()"); await wait(500);
    log.push('ambient icon clicked: ambientMute=' + state.mixer.ambientMute);
    await pageJs(sw, "document.querySelector('.mixRow[data-id=media] .mixIco').click()"); await wait(500);
    log.push('media icon clicked: mediaMute=' + state.mixer.mediaMute);
    patch({ mixer: { master: 1, surf: 1, ambientMute: false, mediaMute: false } });
    srv.close(); web.close(); await wait(800);
    } catch (e) { log.push('mix test failed: ' + (e && e.stack || e)); web.close(); }
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
    const see = (wc) => pageJs(wc, `(() => { const v = document.querySelector('#webMirror') || document.querySelector('#webGpu'), bar = document.body.classList.contains('surfing'), views = document.querySelectorAll('webview').length;
      if (!v) return { shows: 'nothing', bar, views };
      const vw = v.videoWidth || +v.dataset.fw || 0, vh = v.videoHeight || +v.dataset.fh || 0, c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d');
      let px = null; if (vw) { if (v.tagName === 'VIDEO') g.drawImage(v, vw / 2, vh / 2, 1, 1, 0, 0, 1, 1); else g.drawImage(v, v.width / 2, v.height * 0.75, 1, 1, 0, 0, 1, 1); px = [...g.getImageData(0, 0, 1, 1).data].slice(0, 3); }
      return { shows: v.id, size: vw + 'x' + vh, px, bar, views, cursor: v.style.cursor || '' }; })()`);
    // a mouse or key event on the window's picture of the page, at page position (x, y) given as fractions
    const poke = (wc, js) => pageJs(wc, `(() => { const v = document.querySelector('#webMirror') || document.querySelector('#webGpu'); if (!v) return false;
      const r = v.getBoundingClientRect(), vw = v.videoWidth || +v.dataset.fw, vh = v.videoHeight || +v.dataset.fh, k = Math.min(r.width / vw, r.height / vh), pw = vw * k, ph = vh * k;
      const at = (x, y) => ({ clientX: r.left + (r.width - pw) / 2 + x * pw, clientY: r.top + (r.height - ph) / 2 + y * ph, button: 0, detail: 1, bubbles: true });
      const click = (x, y) => { v.dispatchEvent(new MouseEvent('mousedown', at(x, y))); v.dispatchEvent(new MouseEvent('mouseup', at(x, y))); };
      const move = (x, y) => v.dispatchEvent(new MouseEvent('mousemove', at(x, y)));
      const type = (s) => { for (const ch of s) { v.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true })); v.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true })); } };
      ${js}; return true; })()`);
    const pageSays = async () => { const p = page(); return p ? pageJs(p, "JSON.stringify({ title: document.title, typed: document.querySelector('#i').value, picked: document.querySelector('#s').value })") : 'no page'; };
    log.push(`mode=${gpuRun ? 'gpu' : 'webview'} info.gpu=${web.info().gpu}`);
    log.push('surf monitor: ' + JSON.stringify(await see(sw)) + ' mirror monitor (off): ' + JSON.stringify(await see(mw)));
    patch({ surfMirror: true }); await wait(4000);
    log.push('mirror on: ' + JSON.stringify(await see(mw)) + ' page=' + await pageSays());
    {       // the page's shape meets the other monitor's partway (pageSize); the Surf monitor shows it whole, at most a little smaller, and a real click there lands where it should
      const size = () => pageJs(page(), 'innerWidth + "x" + innerHeight + "@" + devicePixelRatio');
      const img = (await sw.capturePage()).toBitmap(), [W, H] = sw.getOwnerBrowserWindow().getContentSize(), px = (x, y) => { const i = (y * W + x) * 4; return [img[i + 2], img[i + 1], img[i]]; };
      log.push(`page size with mirroring: ${await size()} (monitors ${visWins.map((v) => v.win.getContentSize().join('x')).join(', ')}); surf monitor corner=${px(4, 4)} middle=${px(W >> 1, H >> 1)}`);
      const box = await pageJs(sw, `(() => { const v = document.querySelector('webview.on') || document.querySelector('#webGpu'); const r = v.getBoundingClientRect();
        const pw = v.tagName === 'CANVAS' ? +v.dataset.fw : r.width, ph = v.tagName === 'CANVAS' ? +v.dataset.fh : r.height, k = Math.min(r.width / pw, r.height / ph);
        return { l: r.left + (r.width - pw * k) / 2, t: r.top + (r.height - ph * k) / 2, w: pw * k, h: ph * k }; })()`);
      const [pw] = (await size()).split('x').map(parseFloat), k = box.w / pw, x = Math.round(box.l + 100 * k), y = Math.round(box.t + 35 * k);
      if (gpuRun) {       // (a click sent to a Drift window never reaches a <webview> in it, so this is checked with the page drawn offscreen only)
        await pageJs(page(), 'hits.length = 0');
        sw.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); sw.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await wait(800);
        log.push(`real click on the surf monitor at ${x},${y}: page saw ${await pageJs(page(), 'hits.join(" ")')}`);
      }
      patch({ surfMirror: false }); await wait(2000);
      log.push(`page size without mirroring: ${await size()}`);
      patch({ surfMirror: true }); await wait(3000);
    }
    await snap(gpuRun ? 'mirror-gpu' : 'mirror-on');
    await poke(mw, 'click(0.5, 0.75)'); await wait(1500);
    log.push('after a click on the mirror: ' + JSON.stringify(await see(mw)) + ' page=' + await pageSays());
    if (gpuRun) {       // the Surf monitor itself is a picture of the offscreen page too: typing, a dropdown, the pointer over a link
      const [W, H] = (await pageJs(page(), '[innerWidth, innerHeight]'));       // (positions below are fractions of the page)
      await poke(sw, `click(100 / ${W}, 35 / ${H}); type('hi!')`); await wait(800);
      await poke(sw, `click(100 / ${W}, 95 / ${H})`); await wait(800);
      const open = await pageJs(page(), "(() => { const h = document.body.lastElementChild; return !!h && h.tagName === 'DIV' && h.style.zIndex === '2147483647'; })()");
      await snap('mirror-gpu-select');
      await poke(sw, `click(100 / ${W}, (110 + 26 + 13) / ${H})`); await wait(800);       // the list's second row, under the box
      await poke(sw, `move(50 / ${W}, 155 / ${H})`); await wait(800);
      log.push(`surf monitor: dropdown list shown=${open} page=${await pageSays()} pointer over the link=${(await see(sw)).cursor}`);
      log.push('clicks the page saw: ' + await pageJs(page(), 'hits.join(" ")'));
    }
    ipcMain.emit('cmd', { sender: mw }, { type: 'surf', do: 'new' }); await wait(4000);       // a new tab, from the mirror's bar: it opens where the browser is, and the mirror follows it
    log.push('new tab from the mirror: browser on ' + web.info().key + ', tabs=' + web.info().tabs.length + ' ' + JSON.stringify(await see(mw)));
    { const f = web.frame(sw), pg = f && webContents.fromFrame(f); log.push('new tab (made while mirroring) size: ' + (pg ? await pageJs(pg, 'innerWidth + "x" + innerHeight') : 'no page')); }
    patch({ surfMirror: false }); await wait(1500);
    log.push('mirror stopped: ' + JSON.stringify(await see(mw)) + ' surf monitor: ' + JSON.stringify(await see(sw)));
    const layout = (v) => pageJs(mw, `document.querySelector('#mode [data-v=${v}]').click()`);       // Settings' Span / Mirror / Mix buttons
    await layout('mirror'); await wait(3000);
    log.push(`layout Mirror: surfMirror=${state.surfMirror} mirror monitor: ${JSON.stringify(await see(mw))}`);
    await layout('span'); await wait(1500);
    log.push(`layout Span: surfMirror=${state.surfMirror} mirror monitor: ${JSON.stringify(await see(mw))}`);
    if (gpuRun) { patch({ surfGpu: false }); await wait(3000); log.push('setting off again: info.gpu=' + web.info().gpu + ' surf monitor: ' + JSON.stringify(await see(sw))); }
    srv.close(); web.close(); await wait(800);
    } catch (e) { log.push('mirror test failed: ' + (e && e.stack || e)); web.close(); }
  }
  if (process.env.DRIFT_TESTREFOCUS && visWins.length > 1) {       // turning a monitor off and on: each screen keeps its tab, Surf included
    const tabs = () => Promise.all(visWins.map(async (v) => `${v.key}=${await pageJs(v.win.webContents, "document.querySelector('.tabs button.active').dataset.tab + (document.querySelectorAll('webview.web').length ? '+browser' : '')")}`));
    if (!process.env.DRIFT_REFOCUS_NOSURF) await pageJs(visWins[0].win.webContents, "document.querySelector('.tabs button[data-tab=surf]').click()");
    await pageJs(visWins[1].win.webContents, "document.querySelector('.tabs button[data-tab=settings]').click()");
    await wait(3000); log.push('refocus before: ' + (await tabs()).join(' '));
    patch({ displaysOff: [1] }); await wait(5000); log.push('refocus monitor 2 off: ' + (await tabs()).join(' '));
    patch({ displaysOff: [] }); await wait(5000); log.push('refocus monitor 2 on: ' + (await tabs()).join(' '));
    await snap('refocus');
    patch({ displaysOff: [0] }); await wait(5000); log.push('refocus monitor 1 off (browser moves): ' + (await tabs()).join(' ') + ' web=' + web.info().key);
    patch({ displaysOff: [] }); await wait(5000);
  }
  if (process.env.DRIFT_PANEL) {
    log.push('spotify: ' + JSON.stringify(publicState().spotify) + ' toolbar: ' + await pageJs(visWins[0].win.webContents, "document.querySelector('#ctxTag').textContent + ' | ' + document.querySelector('#nowName').textContent"));
    for (const tab of ['scenes', 'media', 'settings']) { visWins[0].win.webContents.send('cmd', { type: 'show-panel', tab }); await wait(tab === 'scenes' || tab === 'media' ? 6000 : 1500); await snap('panel-' + tab);
      if (tab === 'settings') log.push('updates: ' + await pageJs(visWins[0].win.webContents, "JSON.stringify({ shown: getComputedStyle(document.querySelector('#updRow')).display, button: document.querySelector('#updBtn').textContent, note: document.querySelector('#updNote').textContent, auto: document.querySelector('#autoUpdate').checked })"));
      if (tab === 'scenes') { await pageJs(visWins[0].win.webContents, "document.querySelector('#presets').scrollIntoView({ block: 'center' })"); await wait(1500); log.push('ambient: ' + await pageJs(visWins[0].win.webContents, "JSON.stringify({ top: document.querySelector('#content').scrollTop, presets: [...document.querySelectorAll('.preset')].map((b) => b.textContent + (b.classList.contains('active') ? '*' : '')) })")); await snap('panel-scenes-ambient'); } }
    await pageJs(visWins[0].win.webContents, "document.querySelector('.tabs button[data-tab=surf]').click()"); await wait(5000); await snap('panel-surf');       // Surf: the browser opens on Drift's start page
    log.push('surf: ' + JSON.stringify(web.info()));
    {       // Settings' "Forget Surf's sign-ins and history": it asks, and once that's answered a cookie set in Surf is gone, and so is the browser
      const ws = session.fromPartition('persist:web'), wc = visWins[0].win.webContents;
      await ws.cookies.set({ url: 'https://example.com', name: 'drifttest', value: '1', expirationDate: Date.now() / 1000 + 3600 });
      const before = (await ws.cookies.get({})).length;
      await pageJs(wc, "document.querySelector('.tabs button[data-tab=settings]').click(); document.querySelector('#content').scrollTop = 1e5"); await wait(800);
      await pageJs(wc, "document.querySelector('#forgetSurf').click()"); await wait(300);
      const asked = await pageJs(wc, "document.querySelector('#confirm').classList.contains('on') ? document.querySelector('#confirmTitle').textContent : 'not asked'");
      log.push('settings dom: ' + await pageJs(wc, "JSON.stringify({ active: document.querySelector('.tabs button.active').dataset.tab, open: document.querySelector('#panel').className, section: (document.querySelector('#content section.active') || {}).dataset, btnVisible: !!document.querySelector('#forgetSurf').offsetParent })"));
      await snap('forget-ask');
      await pageJs(wc, "document.querySelector('#confirmYes').click()"); await wait(1500);       // (Drift's own question box: ask() in app.js)
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
        tl(`block ${what}: ${p ? await pageJs(p, probe).catch((e) => e.message) : 'page not found'} (${Date.now() - t0}ms)`);
      };
      const exts = () => (ws.extensions || ws).getAllExtensions().map((e) => e.name).join(', ');
      tl(`block (${gpuRun ? 'gpu' : 'webview'}) start`);
      await visit('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube.com', 25000);       // (the first time, uBO is downloaded first)
      tl('block extensions: ' + exts());
      await visit('news', 'https://www.theverge.com/', 'theverge.com');
      const hu = `http://127.0.0.1:${srv.address().port}/hints`;
      web.act({ do: 'go', text: hu }); await wait(2500); web.act({ do: 'reload' }); await wait(2500);       // (the detailed ones come on the second visit)
      const hp = page('127.0.0.1');
      tl('block hints: ' + (hp ? await pageJs(hp, "document.querySelector('#h').textContent").catch((e) => e.message) : 'page not found'));
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
  if (process.env.DRIFT_TESTYT) {       // dev: YouTube playing in Surf, sampled each second (buffer ahead, stalls, dropped frames, its video requests) beside how late the main process runs and each process's CPU. DRIFT_TESTYT=<seconds per video>; DRIFT_TESTGPU=1 draws offscreen; DRIFT_TESTYT_OFF=1 with ad blocking off; DRIFT_TESTYT_IDS=<video ids, comma separated>
    const tl = (x) => { log.push(x); console.log('[yt] ' + x); };
    const secs = Math.max(20, +process.env.DRIFT_TESTYT || 60);
    const ids = (process.env.DRIFT_TESTYT_IDS || 'https://www.youtube.com/@LofiGirl/live,aqz-KE-bpKQ').split(',').filter(Boolean);       // a 24/7 live stream, and a long ordinary video (an id or a whole address)
    const out = { gpu: !!process.env.DRIFT_TESTGPU, adblock: !process.env.DRIFT_TESTYT_OFF, secs, runs: [] };
    const push0 = pushState;
    let pushes = 0, paints = 0;
    const { monitorEventLoopDelay } = require('perf_hooks');
    const eld = monitorEventLoopDelay({ resolution: 10 });
    const stalls = [];
    let tickAt = Date.now();
    const ticker = setInterval(() => { const n = Date.now(), late = n - tickAt - 20; if (late > 50) stalls.push(late); tickAt = n; }, 20);
    const gcs = [];       // the main process's garbage collections over 20 ms: [kind, ms] (kind 1 minor, 2 major, 4 incremental, 8 weak callbacks)
    const gcObs = new (require('perf_hooks').PerformanceObserver)((l) => { for (const e of l.getEntries()) if (e.duration > 20) gcs.push(`${(e.detail && e.detail.kind) || e.kind}:${Math.round(e.duration)}`); });
    gcObs.observe({ entryTypes: ['gc'] });
    try {
      patch({ surfGpu: out.gpu, share: { adblock: out.adblock } }); await wait(300);
      pushState = function () { pushes++; return push0.apply(this, arguments); };
      eld.enable();
      const ws = session.fromPartition('persist:web');
      const page = (host) => webContents.getAllWebContents().find((x) => !x.isDestroyed() && x.session === ws && x.getType() !== 'backgroundPage' && x.getURL().includes(host));
      // which process is which, for the CPU figures
      const who = () => {
        const m = new Map();
        for (const w of webContents.getAllWebContents()) {
          if (w.isDestroyed()) continue;
          const u = w.getURL(), name = /youtube\.com/.test(u) ? 'youtube' : w.getType() === 'backgroundPage' ? (/surf-net|setIdent/.test(u) ? 'surf-net' : 'ext:' + u.slice(19, 27)) : visWins.some((v) => v.win.webContents === w) ? 'drift-window' : 'other';
          try { m.set(w.getOSProcessId(), name); } catch { /* gone */ }
        }
        return m;
      };
      const cpu = () => {
        const names = who(), by = {};
        for (const p of app.getAppMetrics()) { const k = p.type === 'Browser' ? 'main' : p.type === 'GPU' ? 'gpu' : names.get(p.pid) || p.type.toLowerCase(); by[k] = +((by[k] || 0) + p.cpu.percentCPUUsage).toFixed(1); }
        return by;
      };
      // in the YouTube page: runs each second; the first time, it starts counting stalls and the video requests
      const probe = () => {
        const v = document.querySelector('video'), mp = document.querySelector('#movie_player');
        if (!window.__dy) {
          const d = window.__dy = { waiting: 0, stalled: 0, res: [] };
          for (const ev of ['waiting', 'stalled']) document.addEventListener(ev, () => { d[ev]++; }, true);
          new PerformanceObserver((l) => {
            for (const e of l.getEntries()) if (/googlevideo\.com\/videoplayback/.test(e.name)) d.res.push({ dur: Math.round(e.duration), send: e.requestStart ? Math.round(e.requestStart - e.startTime) : -1, first: e.responseStart ? Math.round(e.responseStart - e.startTime) : -1, kb: Math.round((e.transferSize || e.encodedBodySize || 0) / 1024) });
          }).observe({ type: 'resource', buffered: true });
        }
        const d = window.__dy, res = d.res.splice(0);
        let ahead = 0;
        if (v) for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.2 && v.buffered.end(i) >= v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
        const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
        let nerd = null;
        try { const s = mp && mp.getStatsForNerds && mp.getStatsForNerds(); if (s) nerd = { health: s.buffer_health_seconds, kbps: s.bandwidth_kbps, res: s.resolution, codecs: s.codecs }; } catch { /* not there */ }
        return { t: v ? +v.currentTime.toFixed(2) : null, ahead: +ahead.toFixed(1), rs: v ? v.readyState : null, paused: v ? v.paused : null, waiting: d.waiting, stalled: d.stalled,
          dropped: q.droppedVideoFrames || 0, frames: q.totalVideoFrames || 0, ad: !!(mp && mp.classList.contains('ad-showing')), vis: document.visibilityState, title: document.title.slice(0, 60), res, nerd };
      };
      const med = (xs) => { const s = xs.filter((x) => x >= 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
      const pct = (xs, p) => { const s = xs.filter((x) => x >= 0).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
      tl(`start: ${out.gpu ? 'gpu (offscreen)' : 'webview'}, ad blocking ${out.adblock ? 'on' : 'off'}, ${secs} s per video`);
      for (const id of ids) {
        const url = /^https:/.test(id) ? id : `https://www.youtube.com/watch?v=${id}`;
        web.act({ do: 'go', text: url }, visWins[0].key);
        let p = null;
        for (let i = 0; i < 80 && !(p = page('youtube.com/')); i++) await wait(500);
        if (!p) { tl(`${id}: page not found`); continue; }
        p.on('paint', () => { paints++; });
        await wait(10000);       // (the player starts; uBO, the first time, has its lists to load)
        const wi = web.info();
        tl(`${id}: surf gpu=${wi.gpu} key=${wi.key} url=${String(wi.url).slice(0, 60)} offscreen=${!!p.isOffscreen()} painting=${p.isOffscreen() ? p.isPainting() : 'n/a'} paints so far=${paints}`);
        tl(`${id}: player says ${await pageRun(p, () => {
          const pr = typeof ytInitialPlayerResponse === 'undefined' ? null : ytInitialPlayerResponse, ps = pr && pr.playabilityStatus;
          const err = document.querySelector('.ytp-error, yt-playability-error-supported-renderers');
          return JSON.stringify({ status: ps && ps.status, reason: ps && (ps.reason || (ps.errorScreen && JSON.stringify(ps.errorScreen).slice(0, 200))), live: !!(pr && pr.videoDetails && pr.videoDetails.isLive),
            error: err ? err.innerText.replace(/\s+/g, ' ').slice(0, 200) : '', video: !!document.querySelector('video'), src: (document.querySelector('video') || {}).src ? 'blob' : '', state: document.querySelector('#movie_player') && document.querySelector('#movie_player').getPlayerState ? document.querySelector('#movie_player').getPlayerState() : null });
        }).catch((e) => e.message)}`);
        try { fs.writeFileSync(path.join(SHOT_DIR, `yt-${id.replace(/\W+/g, '_').slice(-40)}.png`), (await p.capturePage()).toPNG()); } catch { /* no picture */ }
        await pageRun(p, () => { const v = document.querySelector('video'); if (v && v.paused) v.play().catch(() => {}); return !!v; });
        await pageRun(p, probe);       // (starts the counting)
        cpu();       // (the next call is the CPU since now)
        eld.reset(); stalls.length = 0; pushes = 0; paints = 0;
        const samples = [], cpus = [], t0 = Date.now();
        for (let s = 1; s <= secs; s++) {
          await wait(1000);
          const r = await pageRun(p, probe).catch((e) => ({ err: String(e.message).slice(0, 120) }));
          Object.assign(r, { s, pushes, paints, lag99: +(eld.percentile(99) / 1e6).toFixed(1), lagMax: +(eld.max / 1e6).toFixed(1), stalls: stalls.splice(0), gc: gcs.splice(0), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) });
          pushes = 0; paints = 0; eld.reset();
          samples.push(r);
          if (s % 5 === 0) { const c = cpu(); cpus.push(c); r.cpu = c; }
          const net = (r.res || []).map((x) => `${x.dur}/${x.send}/${x.kb}k`).join(' ');
          tl(`${id} s=${s} t=${r.t} ahead=${r.ahead} rs=${r.rs}${r.paused ? ' PAUSED' : ''}${r.ad ? ' AD' : ''} wait=${r.waiting} stall=${r.stalled} drop=${r.dropped}/${r.frames} push=${r.pushes} paint=${r.paints} lag99=${r.lag99} lagMax=${r.lagMax}${r.stalls.length ? ' STALLS=' + r.stalls.join(',') : ''}${r.gc.length ? ' GC=' + r.gc.join(',') : ''} heap=${r.heapMB}${r.nerd ? ` health=${r.nerd.health} kbps=${r.nerd.kbps} ${r.nerd.res} ${String(r.nerd.codecs || '').split(' ')[0]}` : ''}${net ? ' net(dur/send/kb)=' + net : ''}${r.cpu ? ' cpu=' + JSON.stringify(r.cpu) : ''}${r.err ? ' ERR ' + r.err : ''}`);
        }
        const ok = samples.filter((x) => !x.err), first = ok[0] || {}, last = ok[ok.length - 1] || {}, res = ok.flatMap((x) => x.res || []);
        const avgCpu = {};
        for (const c of cpus) for (const [k, v] of Object.entries(c)) avgCpu[k] = +((avgCpu[k] || 0) + v / cpus.length).toFixed(1);
        const sum = { id, title: last.title, vis: last.vis, wall: Math.round((Date.now() - t0) / 1000), played: last.t != null && first.t != null ? +(last.t - first.t).toFixed(1) : null,
          waitingEvents: (last.waiting || 0) - (first.waiting || 0), stalledEvents: (last.stalled || 0) - (first.stalled || 0), lowBufferSecs: ok.filter((x) => x.ahead < 1).length, pausedSecs: ok.filter((x) => x.paused).length, adSecs: ok.filter((x) => x.ad).length,
          minAhead: ok.length ? Math.min(...ok.map((x) => x.ahead)) : null, dropped: (last.dropped || 0) - (first.dropped || 0), frames: (last.frames || 0) - (first.frames || 0),
          requests: res.length, reqDurMedian: med(res.map((x) => x.dur)), reqDurP90: pct(res.map((x) => x.dur), 0.9), sendDelayMedian: med(res.map((x) => x.send)), sendDelayP90: pct(res.map((x) => x.send), 0.9),
          lagMax: Math.max(0, ...ok.map((x) => x.lagMax)), lag99Median: med(ok.map((x) => x.lag99)), mainStallsOver50ms: ok.reduce((n, x) => n + x.stalls.length, 0), pushesPerSec: +(ok.reduce((n, x) => n + x.pushes, 0) / Math.max(1, ok.length)).toFixed(1),
          paintsPerSec: +(ok.reduce((n, x) => n + x.paints, 0) / Math.max(1, ok.length)).toFixed(1), cpu: avgCpu, errors: samples.length - ok.length };
        out.runs.push(sum);
        tl(`SUMMARY ${JSON.stringify(sum)}`);
      }
      web.close(); await wait(800);
    } catch (e) { tl('yt test failed: ' + (e && e.stack || e)); try { web.close(); } catch { /* gone */ } }
    pushState = push0; clearInterval(ticker); eld.disable(); gcObs.disconnect();
    fs.writeFileSync(path.join(SHOT_DIR, 'yt.json'), JSON.stringify(out, null, 1));
  }
  fs.writeFileSync(path.join(SHOT_DIR, 'log.txt'), log.join('\n'));
  quitting = true; app.quit();
}
