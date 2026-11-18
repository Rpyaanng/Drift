// Drift — opens the Surf tab's page in this PC's own default browser (Edge, Chrome, Brave, Firefox…), in a window of its own.
// Some sites only work in a real browser: Google won't sign in inside a browser built into an app, which Surf is. That
// browser is left alone, never remote-controlled (a remote-controlled browser is turned away by those sites too), so
// friends can watch its window (main.js streams it) but not click in it.
// It runs with Drift's own profile, apart from the everyday one, so what friends see is never the host's own browser,
// with its accounts, history and open tabs.
const { desktopCapturer } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const KINDS = [       // what each browser is called, and whether it takes Chromium's switches or Firefox's
  [/msedge\.exe$/i, 'Edge', 'chromium'], [/chrome\.exe$/i, 'Chrome', 'chromium'], [/brave\.exe$/i, 'Brave', 'chromium'],
  [/vivaldi\.exe$/i, 'Vivaldi', 'chromium'], [/chromium\.exe$/i, 'Chromium', 'chromium'], [/firefox\.exe$/i, 'Firefox', 'firefox'],
];
// A window of one of those browsers, by its title (Edge puts an invisible space inside "Microsoft Edge")
const BROWSER_TITLE = /(Microsoft ?Edge|Google Chrome|Brave|Vivaldi|Chromium|Mozilla Firefox)\s*$/i;

const reg = (key, value) => new Promise((ok) => {
  execFile('reg', ['query', key, ...(value ? ['/v', value] : ['/ve'])], { windowsHide: true, timeout: 4000 }, (err, out) => {
    const m = !err && /REG_\w+\s+(.+?)\s*$/m.exec(String(out));
    ok(m ? m[1] : '');
  });
});
const exeOf = (cmd) => { const m = /^\s*"([^"]+)"|^\s*(\S+)/.exec(cmd || ''); return m ? m[1] || m[2] : ''; };

module.exports = function createOutside() {
  let found = null;       // { exe, name, kind } once known; null while looking or if there is none
  let looking = null;
  // This PC's default browser for web addresses, if it is one Drift knows how to open. Otherwise Edge, which every Windows 11 PC has.
  function detect() {
    if (process.platform !== 'win32') return Promise.resolve(null);
    if (!looking) looking = (async () => {
      const prog = await reg('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', 'ProgId');
      const tries = [];
      if (prog) tries.push(exeOf(await reg(`HKCR\\${prog}\\shell\\open\\command`)));
      for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) if (base) tries.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      for (const exe of tries) {
        const k = exe && KINDS.find(([re]) => re.test(exe));
        if (k && fs.existsSync(exe)) return (found = { exe, name: k[1], kind: k[2] });
      }
      return null;
    })().catch(() => null);
    return looking;
  }
  detect();

  const windows = () => desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }).catch(() => []);
  // Opens `url` (or the browser's own new tab page) in a new window over `bounds` (the Surf monitor), then calls back with that
  // window: onWindow({ id, title }) once it is there, and again whenever its title changes; onWindow(null) once it is closed
  // (or never turned up).
  async function open(url, bounds, profile, onWindow) {
    const b = await detect();
    if (!b) throw new Error('no browser');
    const before = new Set((await windows()).map((s) => s.id));
    fs.mkdirSync(profile, { recursive: true });
    const args = b.kind === 'firefox'
      ? ['-profile', profile, '-new-window', ...(url ? [url] : [])]
      : [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',       // no signing the profile into the PC's Microsoft or Google account and pulling in its extensions and tabs
        `--window-position=${bounds.x},${bounds.y}`, `--window-size=${bounds.width},${bounds.height}`, '--start-maximized', '--new-window', ...(url ? [url] : [])];
    const child = spawn(b.exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();       // it goes on after Drift closes; it is the person's browser now
    let id = '', title = '', stopped = false;
    const t0 = Date.now();
    const tick = async () => {
      if (stopped) return;
      const list = await windows();
      if (!id) {       // the new window: one that wasn't there before, of a browser
        const w = list.find((s) => !before.has(s.id) && BROWSER_TITLE.test(s.name.replace(/​/g, '')));
        if (w) { id = w.id; title = w.name; onWindow({ id, title: clean(title) }); }
        else if (Date.now() - t0 > 20000) { stopped = true; onWindow(null); return; }
      } else {
        const w = list.find((s) => s.id === id);
        if (!w) { stopped = true; onWindow(null); return; }
        if (w.name !== title) { title = w.name; onWindow({ id, title: clean(title) }); }
      }
      setTimeout(tick, id ? 2000 : 500);
    };
    setTimeout(tick, 500);
    return { name: b.name, stop: () => { stopped = true; } };
  }
  // The page's own title, without " - Microsoft Edge" and the like
  const clean = (t) => String(t || '').replace(/​/g, '').replace(/\s*[-—–]\s*(Microsoft ?Edge|Google Chrome|Brave|Vivaldi|Chromium|Mozilla Firefox)\s*$/i, '').replace(/\s+-\s+(Personal|Profile \d+|Person \d+)\s*$/i, '')       /* the profile's name, which some browsers add */.slice(0, 200);

  return { detect, open, name: () => (found ? found.name : '') };
};
