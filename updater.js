'use strict';
// Keeps Drift up to date from its GitHub releases.
// It asks GitHub for the latest release now and then. When that is newer than this copy it says so (Settings shows it), and
// downloads the release's zip when asked, or by itself with automatic updates on. The zip is checked against the SHA-256
// written in the release notes and unpacked. The new files are copied over this
// copy once Drift has closed (by a small PowerShell script started as Drift quits), and Drift is started again if asked to.
// Only for the packaged Windows app: a copy run from the source (npm start) is left alone.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const REPO = 'Rpyaanng/Drift';
const ASSET = 'Drift-Windows-x64.zip';
const FIRST_CHECK = 20 * 1000, EVERY = 12 * 3600 * 1000;

const parse = (v) => String(v || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
function newer(a, b) {       // is version a newer than b?
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

module.exports = function createUpdater({ app, net, version, enabled, auto, onChange, onReadyDev = () => {}, log = () => {} }) {
  const dir = path.join(app.getPath('userData'), 'update');
  const appDir = path.dirname(process.execPath);
  // idle | checking | latest | available (newer, not downloaded yet) | downloading | ready | manual (newer, but this copy can't update itself) | error
  let info = { status: 'idle', version: '', notes: '', page: `https://github.com/${REPO}/releases/latest`, progress: 0, error: '', checked: 0 };
  let timer = null, busy = false, staged = '', release = null;       // release: the newer one found, { url, size, sha, v }
  const supported = process.platform === 'win32' && (app.isPackaged || !!process.env.DRIFT_FAKE_VERSION);
  const set = (p) => { info = { ...info, ...p }; onChange(info); };

  // left over from last time: what the copy script said, then the old download is tidied away
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    if (r.ok && !newer(r.version, version)) log(`update: now on ${version}`);
    else if (!r.ok) info.error = `The update to ${r.version} couldn't be copied in. Download it from the releases page instead.`;
  } catch { /* nothing happened last time */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use: tried again next start */ }

  // can this copy's folder be written to? (not when it lives somewhere like Program Files)
  function writable() {
    const probe = path.join(appDir, `.drift-update-${process.pid}`);
    try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe); return true; } catch { return false; }
  }

  async function check(byHand) {
    if (!supported || busy || ['ready', 'downloading'].includes(info.status)) return;
    busy = true;
    set({ status: 'checking', error: '' });
    try {
      const r = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Drift-updater' } });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const rel = await r.json();
      const v = String(rel.tag_name || '').replace(/^v/i, ''), asset = (rel.assets || []).find((a) => a.name === ASSET);
      const notes = String(rel.body || ''), sha = (/SHA-256:\s*`?([0-9a-f]{64})/i.exec(notes) || [])[1];
      const page = rel.html_url || info.page;
      if (!newer(v, version)) { set({ status: 'latest', version: v, page, checked: Date.now() }); return; }
      log(`update: ${v} is out (this is ${version})`);
      if (!asset || !sha || !writable()) { set({ status: 'manual', version: v, page, notes, checked: Date.now() }); return; }
      release = { url: asset.browser_download_url, size: asset.size, sha: sha.toLowerCase(), v };
      set({ status: 'available', version: v, page, notes, progress: 0, checked: Date.now() });
    } catch (e) {
      log('update: ' + e.message);
      set({ status: byHand ? 'error' : 'idle', error: byHand ? 'Couldn\'t check for updates: ' + e.message : '' });
    } finally { busy = false; }
    if (info.status === 'available' && auto()) download();
  }

  // fetches the newer release check() found
  async function download() {
    if (busy || info.status !== 'available' || !release) return;
    busy = true;
    set({ status: 'downloading', progress: 0, error: '' });
    try {
      staged = await fetchAndUnpack(release.url, release.size, release.sha, release.v);
      set({ status: 'ready', progress: 1 });
      if (process.env.DRIFT_UPDATE_AUTOINSTALL) onReadyDev();       // dev: try the whole round trip
    } catch (e) {
      log('update: ' + e.message);
      set({ status: 'available', error: 'Couldn\'t download the update: ' + e.message });
    } finally { busy = false; }
  }

  async function fetchAndUnpack(url, size, sha, v) {
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, ASSET), out = path.join(dir, 'new');
    const r = await net.fetch(url, { headers: { 'User-Agent': 'Drift-updater' } });
    if (!r.ok || !r.body) throw new Error(`the download failed (${r.status})`);
    const hash = crypto.createHash('sha256'), file = fs.createWriteStream(zip), reader = r.body.getReader();
    let got = 0, told = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value); got += value.length;
        if (!file.write(value)) await new Promise((ok) => file.once('drain', ok));
        if (size && Date.now() - told > 500) { told = Date.now(); set({ progress: Math.min(0.99, got / size) }); }
      }
    } finally { await new Promise((ok) => file.end(ok)); }
    if (hash.digest('hex') !== sha) throw new Error('the download didn\'t match its checksum');
    fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
    // Windows 10 and 11 come with tar, which unpacks zips
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    await new Promise((ok, no) => {
      const k = spawn(tar, ['-xf', zip, '-C', out], { windowsHide: true, stdio: 'ignore' });
      k.on('error', no); k.on('exit', (c) => (c === 0 ? ok() : no(new Error('the download couldn\'t be unpacked'))));
    });
    fs.rmSync(zip, { force: true });
    // the zip holds a Drift-win32-x64 folder; find the one with Drift.exe in it
    const exe = path.basename(process.execPath);
    const found = [out, ...fs.readdirSync(out).map((n) => path.join(out, n))].find((d) => fs.existsSync(path.join(d, exe)) && fs.existsSync(path.join(d, 'resources', 'app', 'package.json')));
    if (!found) throw new Error('the download doesn\'t look like Drift');
    const pv = JSON.parse(fs.readFileSync(path.join(found, 'resources', 'app', 'package.json'), 'utf8')).version;
    if (pv !== v) throw new Error(`the download says it is ${pv}, not ${v}`);
    return found;
  }

  // copy the new files in once this Drift has closed; then start it again if asked. Quitting is up to the caller
  let launched = false;
  function install(restart) {
    if (info.status !== 'ready' || !staged || launched) return false;
    launched = true;
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const ps = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `Wait-Process -Id ${process.pid} -Timeout 60`,
      'Start-Sleep -Seconds 2',       // Drift's helper processes go a moment after it
      `robocopy ${q(staged)} ${q(appDir)} /E /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null; $a = $LASTEXITCODE`,
      // the app's own files exactly as released: anything a newer version dropped goes too
      `robocopy ${q(path.join(staged, 'resources', 'app'))} ${q(path.join(appDir, 'resources', 'app'))} /MIR /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null; $b = $LASTEXITCODE`,
      `$ok = ($a -lt 8) -and ($b -lt 8)`,
      `@{ ok = $ok; version = ${q(info.version)} } | ConvertTo-Json | Set-Content -Encoding UTF8 ${q(path.join(dir, 'result.json'))}`,
      // started by Windows, the script doesn't have Drift's environment: carry over the dev switches (a second copy's own settings folder and so on)
      ...(restart ? Object.keys(process.env).filter((k) => /^DRIFT_/.test(k) && !/^DRIFT_(FAKE_VERSION|UPDATE_AUTOINSTALL)$/.test(k)).map((k) => `$env:${k} = ${q(process.env[k])}`) : []),
      restart ? `Start-Process -FilePath ${q(process.execPath)}` : '',
    ].join('\r\n');
    const script = path.join(dir, 'apply.ps1');
    fs.writeFileSync(script, ps);
    // Drift's child processes are closed along with it, so the script is started by Windows (WMI) instead, outside Drift's own group
    const line = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${q(line)} }; exit $r.ReturnValue`], { windowsHide: true, timeout: 20000 });
    if (r.status !== 0) {
      log('update: WMI could not start the copy script (' + (r.error ? r.error.message : r.status) + '), trying directly');
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    }
    log(`update: installing ${info.version}${restart ? ' and starting again' : ' after Drift closes'}`);
    return true;
  }

  function schedule() {
    clearTimeout(timer); clearInterval(timer);
    if (!supported || !enabled()) return;
    if (info.status === 'available' && auto()) download();       // automatic updates just turned on, with one waiting
    timer = setTimeout(() => { check(false); timer = setInterval(() => check(false), EVERY); }, FIRST_CHECK);
  }

  return {
    info: () => ({ ...info, supported, current: version }),
    check: () => check(true),
    download,
    install,
    settingChanged: schedule,
    start: schedule,
  };
};
module.exports.newer = newer;
