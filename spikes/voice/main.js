// Spike 1 of docs/plans/voice-and-chat.md (throwaway): voice between Drift-like windows over WebRTC, hold-to-talk that
// works while another program has the keyboard, and the "mic live" light. Each window is its own renderer process and
// they form a full mesh, exactly as a voice channel would; only the signalling is a shortcut (IPC instead of the hub).
//
//   electron spikes/voice/main.js                     two windows; window 0 sends a test tone. Nothing is heard (muted).
//   VOICE_SRC=mic electron spikes/voice/main.js       window 0 sends your microphone and window 1 plays it: wear
//                                                     headphones and talk to hear your own voice after the call's delay.
//                                                     Hold ` (backquote) to talk; VOICE_PTT_VK=0 keeps the mic on.
//   VOICE_AUTO=out.json electron spikes/voice/main.js measure: delay, bitrate with and without sound, hold-to-talk
//                                                     delay, processor use. Writes the numbers and quits.
//   VOICE_PEERS=8                                     the size of the mesh (2 to 8)
const { app, BrowserWindow, ipcMain, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const N = Math.max(2, Math.min(8, +process.env.VOICE_PEERS || 2));
const SRC = process.env.VOICE_SRC === 'mic' ? 'mic' : 'beep';
const AUTO = process.env.VOICE_AUTO || '';
// The hold-to-talk key, as a Windows virtual-key code. The measuring run presses F13 itself, which types nothing.
const VK = process.env.VOICE_PTT_VK !== undefined ? parseInt(process.env.VOICE_PTT_VK, 16) || 0 : AUTO ? 0x7c : 0xc0;
const now = () => performance.timeOrigin + performance.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', path.join(os.tmpdir(), 'drift-voice-spike'));
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const wins = [];
const heard = [];       // { to, from, at }: a window heard a sound start in another window's stream
const ptts = [];        // { down, at }: the key-state helper saw the key go down or up
let tray = null;

// ---- the "mic live" light: grey while the microphone is open, red while it is sending ----
function dot(r, g, b) {
  const s = 16, buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5), a = Math.max(0, Math.min(1, 6.5 - d)), i = (y * s + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = Math.round(a * 255);
  }
  return nativeImage.createFromBitmap(buf, { width: s, height: s });
}
const LIGHT = { off: null, open: dot(140, 140, 140), live: dot(230, 40, 40) };
function light(state) {
  if (state === 'off') { if (tray) { tray.destroy(); tray = null; } return; }
  if (!tray) tray = new Tray(LIGHT[state]); else tray.setImage(LIGHT[state]);
  tray.setToolTip(state === 'live' ? 'Drift: your microphone is on and people can hear you' : 'Drift: in a call, your microphone is muted');
}

// ---- hold-to-talk: Electron's globalShortcut only reports presses, never releases, so a small helper watches the key ----
const KEYS = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class K {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
}
'@
[K]::timeBeginPeriod(1) | Out-Null
$down = $false
[Console]::Out.WriteLine('R')
while ($true) {
  $now = ([K]::GetAsyncKeyState(${VK}) -band 0x8000) -ne 0
  if ($now -ne $down) { $down = $now; if ($down) { [Console]::Out.WriteLine('D') } else { [Console]::Out.WriteLine('U') } }
  Start-Sleep -Milliseconds 5
}`;
const ps = (script, opts) => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, ...opts });
let keys = null, keysReady = null;
function watchKeys(onChange) {
  let buf = '';
  keys = ps(KEYS, { stdio: ['ignore', 'pipe', 'ignore'] });
  keysReady = new Promise((ok) => {
    keys.stdout.setEncoding('utf8');
    keys.stdout.on('data', (d) => {
      buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop();
      for (const l of lines) { if (l === 'R') ok(true); else if (l === 'D' || l === 'U') onChange(l === 'D'); }
    });
    keys.on('close', () => ok(false));
  });
}
// The measuring run presses the key the way a person would, through Windows' own keyboard input.
const press = (down) => ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class P { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra); }'; [P]::keybd_event(${VK}, 0, ${down ? 0 : 2}, [UIntPtr]::Zero)`, { stdio: 'ignore' });

// ---- the windows ----
function open(i) {
  const w = new BrowserWindow({
    width: 360, height: 260, x: 40 + (i % 4) * 380, y: 40 + Math.floor(i / 4) * 300, show: !AUTO, title: `Voice spike: window ${i}${i ? '' : ' (you)'}`,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  w.webContents.session.setPermissionRequestHandler((_wc, perm, cb, d) => cb(perm === 'media' && (d.mediaTypes || []).every((t) => t === 'audio')));
  w.webContents.session.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  w.loadFile(path.join(__dirname, 'voice.html'), { query: { me: String(i), n: String(N), src: i === 0 ? SRC : 'beep', ptt: VK && i === 0 ? '1' : '', mute: AUTO || i === 0 ? '1' : '', nodtx: process.env.VOICE_NODTX ? '1' : '' } });
  w.webContents.on('console-message', (e) => { if (AUTO) console.log(`[${i}] ${e.message}`); });
  return w;
}
const index = (wc) => wins.findIndex((w) => w.webContents === wc);
ipcMain.on('sig', (e, to, d) => { const from = index(e.sender); if (wins[to] && from >= 0) wins[to].webContents.send('sig', from, d); });
ipcMain.on('heard', (e, from, at) => heard.push({ to: index(e.sender), from, at }));
ipcMain.on('mic', (e, state) => { if (index(e.sender) === 0) light(state); });
const js = (i, code) => wins[i].webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  for (let i = 0; i < N; i++) wins.push(open(i));
  if (VK) watchKeys((down) => { ptts.push({ down, at: now() }); js(0, `setPtt(${down})`).catch(() => {}); });
  if (AUTO) measure().catch((e) => { fs.writeFileSync(AUTO, JSON.stringify({ error: String(e && e.stack || e) }, null, 2)); app.quit(); });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { if (keys) try { keys.kill(); } catch { /* gone */ } });

// ---- the measuring run ----
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return s.length ? { n: s.length, min: +s[0].toFixed(1), median: +q(0.5).toFixed(1), p90: +q(0.9).toFixed(1), max: +s[s.length - 1].toFixed(1) } : { n: 0 }; };
// For each sound window 0 started, when did each other window hear it start? (The first onset within 500 ms.)
function delays(sent, from = 0) {
  const out = {};
  for (let r = 0; r < N; r++) if (r !== from) {
    const got = heard.filter((h) => h.to === r && h.from === from);
    out[r] = stats(sent.map((s) => { const h = got.find((x) => x.at > s && x.at - s < 500); return h ? h.at - s : null; }).filter((x) => x !== null));
    out[r].missed = sent.length - out[r].n;
  }
  return out;
}
async function measure() {
  const res = { peers: N, when: new Date().toISOString(), electron: process.versions.electron, chrome: process.versions.chrome };
  for (let t = 0; ; t++) {       // wait until every window is talking to every other
    const up = await Promise.all(wins.map((_w, i) => js(i, 'connected()')));
    if (up.every((n) => n === N - 1)) break;
    if (t > 60) throw new Error('the windows never all connected: ' + JSON.stringify(up));
    await wait(250);
  }
  await wait(1500);
  const cpu0 = new Map(app.getAppMetrics().map((m) => [m.pid, m.cpu.cumulativeCPUUsage])), t0 = now();       // processor seconds so far, per process

  // 1. Delay: window 0 beeps; the others note when the beep starts in what they receive
  const sent = [];
  await js(0, 'setPtt(true)');       // talking (hold-to-talk is measured in part 3)
  for (let k = 0; k < 20; k++) { sent.push(await js(0, 'beep(80)')); await wait(600); }
  await wait(600);
  res.delayMs = delays(sent);
  const cpu = {}, secs = (now() - t0) / 1000;
  for (const m of app.getAppMetrics()) cpu[m.type] = +((cpu[m.type] || 0) + (100 * (m.cpu.cumulativeCPUUsage - (cpu0.get(m.pid) || 0))) / secs).toFixed(1);
  res.cpuPercentOfOneCore = cpu;       // all windows together, by kind of process

  // 2. What a sender uses, to each peer: while silent (DTX should send almost nothing) and while making sound
  const rate = async (ms) => { const a = await js(0, 'bytesOut()'); await wait(ms); const b = await js(0, 'bytesOut()'); return Object.fromEntries(Object.keys(b).map((k) => [k, +(((b[k] - (a[k] || 0)) * 8) / ms).toFixed(1)])); };
  res.kbpsToEachPeer = { silent: await rate(3000) };
  await js(0, 'tone(true)'); await wait(500);
  res.kbpsToEachPeer.sound = await rate(3000);
  await js(0, 'tone(false)'); await wait(800);

  // 3. Hold-to-talk: the key goes down, and how long until the others hear it? (from the helper seeing the key)
  if (VK && await keysReady) {
    await js(0, 'tone(true); setPtt(false)'); await wait(1000);
    const downs = [], seen = [];
    for (let k = 0; k < 6; k++) {
      const t0 = now(), n0 = ptts.length;
      press(true);
      for (let w = 0; w < 400 && ptts.length === n0; w++) await wait(5);
      if (ptts.length > n0) { downs.push(ptts[n0].at); seen.push(ptts[n0].at - t0); }
      await wait(800);
      press(false);
      for (let w = 0; w < 400 && ptts.length && ptts[ptts.length - 1].down; w++) await wait(5);
      await wait(900);
    }
    await js(0, 'tone(false)');
    res.pttMs = { keyToHeard: delays(downs), keyPresses: 6, keyPressesSeen: downs.length, note: 'from the helper seeing the key, so add up to ~6 ms for its polling' };
  } else res.pttMs = 'the key helper did not start';

  // 4. What the receivers report about the call
  res.receivers = {};
  for (let r = 1; r < N; r++) res.receivers[r] = await js(r, 'report()');
  fs.writeFileSync(AUTO, JSON.stringify(res, null, 2));
  app.quit();
}
