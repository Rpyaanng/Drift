// Drift — main process: one fullscreen window per monitor, shared state, hidden audio engine window.
const { app, BrowserWindow, ipcMain, screen, dialog, powerSaveBlocker, shell, session, desktopCapturer } = require('electron');
const { pathToFileURL } = require('url');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

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
  video: { files: [], index: 0, layout: 'each', fit: 'auto', paused: false, sound: true, volume: 0.8, folders: [], foldersInit: false },
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
let videoFails = 0;
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
    state.video.folders = (state.video.folders || []).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    state.music.playlist = (state.music.playlist || []).filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (state.music.source === 'files' && !state.music.playlist.length) state.music.source = 'generative';
    state.music.folders = (state.music.folders || []).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  } catch { /* first run */ }
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
    list = screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, primary: d.id === pid }));
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

// ---- video sound the built-in player can't decode (Dolby AC-3 / E-AC-3, DTS, TrueHD...) -------------
// ffmpeg converts just the audio on the fly and serves it to the leading monitor over a private local port.
const NATIVE_AUDIO = /^(aac|mp3|opus|vorbis|flac|pcm_|alac)/;
const audioToken = crypto.randomBytes(16).toString('hex');
let audioPort = 0, videoAudio = { mode: 'native', codec: '' }, probeSeq = 0;
const audioKids = new Set();
function ffmpegPath() {
  const cands = [process.env.DRIFT_FFMPEG, path.join(process.resourcesPath || '', 'ffmpeg.exe'), path.join(__dirname, 'ffmpeg.exe')].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}
function probeAudio() {
  const f = state.video.files[state.video.index], ff = ffmpegPath(), seq = ++probeSeq;
  videoAudio = { mode: 'native', codec: '' };
  if (!f || !ff) return;
  let err = '';
  const p = spawn(ff, ['-hide_banner', '-i', f], { windowsHide: true });
  p.stderr.on('data', (d) => { if (err.length < 200000) err += d; });
  p.on('error', () => {});
  p.on('close', () => {
    if (seq !== probeSeq) return;
    const m = /Stream #0:\d+[^\n]*?: Audio: ([a-z0-9_]+)/i.exec(err);
    if (!m) videoAudio = { mode: /Stream #0:\d+[^\n]*?: Video:/.test(err) ? 'none' : 'native', codec: '' };
    else videoAudio = { mode: NATIVE_AUDIO.test(m[1]) ? 'native' : 'transcode', codec: m[1] };
    pushState();
  });
}
function startAudioServer() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const f = state.video.files[+u.searchParams.get('i')], ff = ffmpegPath();
    if (u.searchParams.get('k') !== audioToken || !f || !ff) { res.writeHead(404); res.end(); return; }
    const t = Math.max(0, parseFloat(u.searchParams.get('t')) || 0);
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
let spotify = { status: process.platform === 'win32' ? 'closed' : 'unsupported', title: '' }, spotifyProc = null;
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
    if (next.status !== spotify.status || next.title !== spotify.title) { spotify = next; pushState(); }
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

function publicState() {
  const f = state.video.files[state.video.index];
  const showing = (key) => (state.mode === 'mix' ? (state.perDisplay[key] || state.scene) : state.scene) === 'video';
  const lead = visWins.find((v) => showing(v.key));
  return { ...state, time: clock, nowPlaying, vclock,
    videoUrl: f ? pathToFileURL(f).href : '', videoName: f ? path.basename(f) : '', videoPath: f || '', videoLeader: lead && f ? lead.key : '',
    spotify, videoAudio, audioBase: audioPort ? `http://127.0.0.1:${audioPort}/a?k=${audioToken}&i=${state.video.index}` : '' };
}
function broadcast(channel, payload, includeAudio = true) {
  for (const v of visWins) if (!v.win.isDestroyed()) v.win.webContents.send(channel, payload);
  if (includeAudio && audioWin && !audioWin.isDestroyed()) audioWin.webContents.send(channel, payload);
}
function pushState() { broadcast('state', publicState()); }

function initFor(wc) {
  const v = visWins.find((x) => x.win.webContents === wc);
  const act = activeDisplays();
  return {
    key: v ? v.key : 'd0', index: v ? v.index : 0,
    bounds: v ? v.bounds : act[0].bounds,
    union: unionOf(act),
    displays: allDisplays().map((d) => ({ index: d.index, key: d.key, width: d.bounds.width, height: d.bounds.height, primary: d.primary })),
    state: publicState(),
    testMode: !!SHOT_DIR, freeze: !!process.env.DRIFT_FREEZE,
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
    const entry = { win, key: d.key, index: d.index, bounds: d.bounds };
    visWins.push(entry);
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.setBounds(d.bounds);
      if (FAKE <= 1) win.setFullScreen(true);
      if (state.onTop) win.setAlwaysOnTop(true, 'screen-saver');
      win.show();
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
  if (!prev || prev.music.source !== state.music.source) spotifyWatch(state.music.source === 'spotify');
  // monitors on/off
  if (prev && JSON.stringify(prev.displaysOff) !== JSON.stringify(state.displaysOff)) rebuildSoon();
}

const SCENES = ['aurora', 'nebula', 'silk', 'water', 'stars', 'lava', 'ridges', 'ripples', 'mandala', 'bokeh', 'lines',
  'sierpinski', 'sorting', 'life', 'maze', 'julia', 'hilbert', 'voronoi'];
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
    if (k === 'video') state.video = { ...state.video, ...p.video };
    else if (k === 'music') {
      state.music = { ...state.music, ...p.music };
      if (p.music.nature) state.music.nature = { ...prev.music.nature, ...p.music.nature };
    } else if (k === 'perDisplay') state.perDisplay = { ...state.perDisplay, ...p.perDisplay };
    else if (k in DEFAULTS) state[k] = p[k];
  }
  if (allDisplays().every((d) => state.displaysOff.includes(d.index))) state.displaysOff = prev.displaysOff;
  applySideEffects(prev);
  pushState();
  saveSoon();
}

function setVideos(files, key, index = 0) {
  videoFails = 0;
  vclock = { startedAt: Date.now(), pos: 0 };
  const p = { video: { files, index, paused: false } };
  if (state.mode === 'mix' && key) p.perDisplay = { [key]: 'video' }; else p.scene = 'video';
  patch(p);
  probeAudio();
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
      if (!r.canceled && r.filePaths.length) setVideos(r.filePaths, c.key);
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
      if (files.length) setVideos(files, c.key, Math.max(0, Math.min(files.length - 1, c.index | 0)));
      break;
    }
    case 'stop-video':
      if (state.mode === 'mix') { const pd = { ...state.perDisplay }; pd[c.key] = state.prevScene || 'aurora'; state.perDisplay = pd; if (state.scene === 'video') state.scene = state.prevScene || 'aurora'; pushState(); saveSoon(); }
      else patch({ scene: state.prevScene && state.prevScene !== 'video' ? state.prevScene : 'aurora' });
      break;
    case 'video-next':   // sent by the leading monitor when a clip ends or fails
      if (c.index !== state.video.index || state.video.files.length < 2) break;
      if (c.failed) { if (++videoFails >= state.video.files.length) break; } else videoFails = 0;
      state.video.index = (state.video.index + 1) % state.video.files.length;
      vclock = { startedAt: Date.now(), pos: 0 };
      probeAudio(); pushState(); saveSoon();
      break;
    case 'video-step': {       // previous / next video in the list that is playing
      const n = state.video.files.length; if (!n) break;
      videoFails = 0;
      state.video.index = (state.video.index + (c.dir < 0 ? -1 : 1) + n) % n;
      state.video.paused = false;
      vclock = { startedAt: Date.now(), pos: 0, seq: (vclock.seq || 0) + 1 };
      probeAudio(); pushState(); saveSoon();
      break;
    }
    case 'video-jump':
      vclock = { startedAt: Date.now() - Math.max(0, c.pos) * 1000, pos: Math.max(0, c.pos), seq: (vclock.seq || 0) + 1 };
      if (c.play) state.video.paused = false;
      pushState();
      break;
    case 'clear-playlist':
      patch({ music: { playlist: [], source: state.music.source === 'files' ? 'generative' : state.music.source } });
      break;
    case 'reset': {
      const keep = state.music.playlist, folders = state.video.folders, mf = state.music.folders;
      state = JSON.parse(JSON.stringify(DEFAULTS)); state.music.playlist = keep; state.video.folders = folders; state.video.foldersInit = true; state.music.folders = mf; state.music.foldersInit = true;
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
    startAudioServer();
    // lets the audio engine listen to what the PC is playing (e.g. Spotify) so visuals can react to it; nothing is recorded
    session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((src) => cb({ video: src[0], audio: 'loopback' })).catch(() => cb({}));
    });
    if (state.video.files.length) probeAudio();
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
  app.on('before-quit', () => { quitting = true; spotifyWatch(false); for (const k of audioKids) { try { k.kill(); } catch { /* gone */ } } try { fs.writeFileSync(settingsFile, JSON.stringify(state, null, 1)); } catch { /* ignore */ } });
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
    for (const v of visWins) fs.writeFileSync(path.join(SHOT_DIR, `${name}-${v.key}.png`), (await v.win.webContents.capturePage()).toPNG());
  };
  await wait(5000);
  const only = (process.env.DRIFT_ONLY || '').split(',').filter(Boolean);
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
  if (process.env.DRIFT_PANEL) {
    for (const tab of ['scenes', 'video', 'music', 'settings']) { visWins[0].win.webContents.send('cmd', { type: 'show-panel', tab }); await wait(tab === 'scenes' || tab === 'video' ? 6000 : 1500); await snap('panel-' + tab); }
  }
  fs.writeFileSync(path.join(SHOT_DIR, 'log.txt'), log.join('\n'));
  quitting = true; app.quit();
}
