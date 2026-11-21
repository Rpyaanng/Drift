// Drift — the Surf tab's browser: web pages (YouTube, or any other page) in tabs, shown on one monitor, inside Drift.
// While this PC is sharing, the picture and sound of the tab in front are streamed to friends' copies of Drift (renderer/app.js does that,
// over WebRTC), and what friends do with their mouse and keyboard over that picture is played back into the page here.
// Only this PC loads the pages: friends never open them themselves.
// Two ways to show a page (Settings → "Draw Surf on the graphics card"):
//   - normally, as a <webview> in the Drift window of the Surf monitor (renderer/app.js makes it). Other monitors mirroring it get a
//     WebRTC stream of it, as friends do.
//   - "gpu": in a hidden offscreen window made here. Each frame it draws is a texture on the graphics card, handed as it is to
//     every Drift window showing the page (the Surf monitor's and any mirroring it: see preload.js), with no video encoding. Their
//     mouse and keyboard are played back into it (input()). Chromium doesn't draw a <select>'s open list offscreen, so
//     surf-select.js stands in for it there.
const { app, session, ipcMain, webContents, BrowserWindow, sharedTexture } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const createOutside = require('./outside');
const ublock = require('./surf-ublock');
const surfKey = require('./renderer/surf-keys');       // the browser's keyboard shortcuts (Ctrl+T, Ctrl+W, Ctrl+Tab…)

const isWeb = (u) => /^https?:\/\//i.test(String(u || ''));
const isHome = (u) => /^drift:\/\/home\//i.test(String(u || ''));
const isPage = (u) => isWeb(u) || isHome(u);       // what a tab may show: web pages, and Drift's own start page
const unit = (n) => Math.max(0, Math.min(1, +n || 0));
const BUTTONS = ['left', 'middle', 'right'];
const HELD = ['leftButtonDown', 'rightButtonDown', 'middleButtonDown'];       // the bits of a mouse event's `buttons`
const MODS = ['shift', 'control', 'alt', 'meta'];
const KEYS = { ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };

// A new tab opens on Drift's own start page (renderer/surf-home.html), served inside the browser's session as drift://home/.
const HOME = 'drift://home/', MAX_TABS = 12;
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];       // Chrome's zoom steps
const HOME_FILE = path.join(__dirname, 'renderer', 'surf-home.html');
// Run in a page brought back from last time: pauses anything already playing, and anything that starts by itself before someone
// clicks or presses a key in the page (YouTube starts its video a moment after the page is in).
const HOLD = `(() => {
  let user = false; const until = Date.now() + 20000;
  const mark = (e) => { if (e.isTrusted) user = true; };
  addEventListener('pointerdown', mark, true); addEventListener('keydown', mark, true);
  document.addEventListener('play', (e) => { if (!user && Date.now() < until && e.target && e.target.pause) e.target.pause(); }, true);
  for (const m of document.querySelectorAll('video, audio')) m.pause();
})()`;
const site = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// ---- what the browser says it is, in the Sec-CH-UA headers (surf-net/background.js adds them to requests) ----
// navigator.userAgentData, read from a Drift window (its values are the same in every page): when the window loads, and again
// whenever a Surf page attaches to it (the window is surely loaded then, and the page hasn't loaded anything yet). Until it is known, the basic
// headers say what Chromium itself would ("Not:A-Brand" is Chromium's made-up brand, and can change between versions: hence
// reading it), and the detailed ones aren't sent.
const ID_FIELDS = ['brands', 'mobile', 'platform', 'fullVersionList', 'uaFullVersion', 'platformVersion', 'architecture', 'bitness', 'wow64', 'model', 'formFactors'];
let ident = { brands: [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: (process.versions.chrome || '').split('.')[0] }],
  mobile: false, platform: { win32: 'Windows', darwin: 'macOS' }[process.platform] || 'Linux', known: false };
// `then()` is called once it is known
function learnIdent(wc, then) {
  if (ident.known || !wc || wc.isDestroyed()) return;
  const read = () => {
    if (ident.known || wc.isDestroyed()) return;
    wc.executeJavaScript(`navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(${JSON.stringify(ID_FIELDS)}) : null`)
      .then((v) => { if (v && Array.isArray(v.brands) && v.brands.length && !ident.known) { ident = { ...v, known: true }; then(); } })
      .catch(() => {});
  };
  if (wc.isLoading()) wc.once('did-finish-load', read); else read();
}

// hooks (all supplied by the main process):
//   changed()      the browser changed: tell the windows and any friends
//   screen(key)    the monitor the browser is shown on: `key` if Drift has a window there, otherwise the main one
//   escape()       Esc was pressed in a page: bring Drift's own controls up
//   unfull(host)   a page left full screen (`host` is the Drift window it sits in)
//   blockAds()     should adverts be blocked in pages?
//   ublockDir()    the folder the advert blocker (uBlock Origin, downloaded the first time) is kept in
//   say(text)      show a message on screen
//   bounds(key)    where monitor `key`'s Drift window is, to open the outside browser over it
//   away(on)       a browser window of the PC's own is (on) or is no longer over the Surf monitor: Drift must not stay above it
//   profile()      the folder the outside browser keeps Drift's profile in
//   gpu()          should pages be drawn offscreen and handed to the windows as textures? (read each time the browser is put somewhere)
//   win(key)       monitor `key`'s Drift window, and display(key) its display (for the offscreen page's size, scale and frame rate)
//   pageSize(key)  { w, h }: the pixels to draw the page at, with the browser on monitor `key` (the widest monitor showing it)
module.exports = function createWeb(hooks) {
  let on = false, key = '';  // is the browser showing, and on which monitor
  let gen = 0;               // goes up each time the browser is put somewhere: the window makes new <webview>s for it
  let holder = null;         // the Drift window the pages are in
  const tabs = [];           // { id, wc, url, title, pending, full, ready, seq }: wc is the tab's page, a <webview> in that window (renderer/app.js makes it)
  let active = 0, nextId = 1;
  const closed = [];         // the addresses of the last tabs closed, newest last: Ctrl+Shift+T opens them again
  let sid = '';              // names the stream of the tab in front: friends ask for it again when it changes
  let out = null;            // { name, id, title, stop }: the page is open in the PC's own browser, whose window (`id`, a capture source) friends see instead
  let gpu = false;           // the pages are offscreen windows of ours, drawn into the Drift windows in `viewers` (see the top)
  const viewers = new Set(); // webContents of the Drift windows drawing the page in front (they say so: viewer())
  const outside = createOutside();
  let ses = null, made = 0;
  const fresh = new Map();   // pages the window has made that it hasn't yet said which tab they are for
  const run = crypto.randomBytes(4).toString('hex');
  const cur = () => tabs.find((t) => t.id === active) || null;
  const live = (t) => !!t && !!t.wc && !t.wc.isDestroyed();
  const alive = () => live(cur());
  const restream = () => { sid = (alive() && cur().ready) || (out && out.id) ? `${run}-${++made}` : ''; };       // a page still on its way in can't be captured yet

  function sess() {
    if (ses) return ses;
    ses = session.fromPartition('persist:web');       // its own cookies and sign-ins, kept between runs, apart from Drift's own windows
    widevine();       // fetched in the background if this is the first time
    // Sites turn away browsers they don't recognise, so it says what it is, a Chromium, the way Chrome says it: no app names, and
    // only the major version (Chrome has sent "Chrome/156.0.0.0" for years; the full number is a sign of an embedded browser)
    // Said twice: the session's is what a page's own frame says, but a frame from another site runs in a process of its own, which
    // says Electron's (app.userAgentFallback: "Drift/… Electron/…"), in navigator.userAgent and in every request its scripts make,
    // whatever the session or the page is told. Cloudflare's check always runs in such a frame: it passed, but its clearance was for
    // the Electron user agent, so the page that came next, saying Chrome, was challenged again, forever. (Drift's own windows say
    // Chrome too from then on, which nothing in them minds.)
    const ua = ses.getUserAgent().replace(/\s(?:Electron|Drift)\/\S+/gi, '').replace(/\bChrome\/(\d+)\.[\d.]+/, 'Chrome/$1.0.0.0');
    app.userAgentFallback = ua;
    ses.setUserAgent(ua);
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen'));       // no camera, microphone, location, notifications…
    ses.setPermissionCheckHandler((_wc, perm) => perm === 'fullscreen');                 // ...and pages are told so up front (otherwise they read "granted")
    // Nothing here may use ses.webRequest: Electron gives a session's requests either to session.webRequest or to its
    // extensions, never both, and the advert blocker is an extension. What Drift does to requests (the Sec-CH-UA headers
    // every Chrome sends, which sites' bot checks look for) is an extension too: surf-net/background.js.
    netReady().catch(() => {});
    // uBlock Origin's scriptlets, for a page or frame that is starting (see surf-scriptlets.js). Its preload waits for them.
    ipcMain.on('surf-scriptlets', (e, u) => {
      if (e.sender.session !== ses || !blocking || !loading) { e.returnValue = ''; return; }
      Promise.race([
        loading.then((x) => (x.bg.isDestroyed() ? '' : x.bg.executeJavaScript(`self.driftScriptlets ? self.driftScriptlets(${JSON.stringify(String(u))}) : ''`))),
        new Promise((r) => setTimeout(() => r(''), 3000)),       // (a page isn't held up for long)
      ]).then((c) => { e.returnValue = typeof c === 'string' ? c : ''; }, () => { e.returnValue = ''; });
    });
    ses.registerPreloadScript({ type: 'frame', id: 'drift-scriptlets', filePath: path.join(__dirname, 'surf-scriptlets.js') });
    // In every page and frame: password boxes can't be turned into plain text, so nobody watching can read a password (see surf-guard.js)
    ses.registerPreloadScript({ type: 'frame', id: 'drift-password-guard', filePath: path.join(__dirname, 'surf-guard.js') });
    ses.registerPreloadScript({ type: 'frame', id: 'drift-select', filePath: path.join(__dirname, 'surf-select.js') });       // (does nothing outside offscreen pages)
    // A download goes straight into this PC's Downloads folder, with no Save As box (it would open behind Drift's full-screen window).
    // Only this PC loads the pages, so a download started by a friend over the shared page lands here too, never on their PC.
    ses.on('will-download', (_e, item) => {
      let dir;
      try { dir = app.getPath('downloads'); } catch { dir = app.getPath('home'); }
      const name = path.basename(item.getFilename() || 'download'), ext = path.extname(name), stem = name.slice(0, name.length - ext.length) || 'download';
      let file = path.join(dir, name);
      for (let n = 1; fs.existsSync(file) && n < 1000; n++) file = path.join(dir, `${stem} (${n})${ext}`);       // never over a file already there
      item.setSavePath(file);
      hooks.say(`Downloading ${path.basename(file)} to your Downloads folder…`);
      item.once('done', (_d, state) => {
        if (state === 'completed') hooks.say(`Downloaded ${path.basename(file)} to your Downloads folder.`);
        else if (state === 'interrupted') hooks.say(`The download of ${path.basename(file)} failed.`);
      });
    });
    // The start page, and its search box: drift://home/go?q=… goes on to the address (or the Google search) it stands for,
    // replacing itself so Back returns to the start page.
    ses.protocol.handle('drift', async (req) => {
      const u = new URL(req.url);
      if (u.host !== 'home') return new Response('', { status: 404 });
      if (u.pathname === '/go') {
        const to = address(u.searchParams.get('q')) || HOME;
        return new Response(`<!DOCTYPE html><meta charset="utf-8"><script>location.replace(${JSON.stringify(to).replace(/</g, '\\u003c')})</script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      try { return new Response(await fs.promises.readFile(HOME_FILE), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }); } catch { return new Response('', { status: 404 }); }
    });
    return ses;
  }
  // Every Drift window may hold the browser. What a page is allowed is decided here, not by the window.
  function host(hostWc) {
    learnIdent(hostWc, tellIdent);
    hostWc.on('will-attach-webview', (e, prefs, params) => {
      if (!on || params.partition !== 'persist:web') { e.preventDefault(); return; }
      delete prefs.preloadURL; delete prefs.preload;
      // nodeIntegrationInSubFrames only lets the password guard run inside frames too (a sign-in box is often in one): pages still get no Node
      Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: true, contextIsolation: true, sandbox: true, backgroundThrottling: false });
      params.src = 'about:blank';
    });
    hostWc.on('did-attach-webview', (_e, page) => {
      learnIdent(hostWc, tellIdent);
      const id = page.id;
      fresh.set(id, { page, hostWc }); page.once('destroyed', () => fresh.delete(id));
      page.setWindowOpenHandler(() => ({ action: 'deny' }));
      page.on('will-navigate', (e, u) => { if (!isPage(u)) e.preventDefault(); });
    });
  }
  // The window says which tab a page it made is for.
  function attached(hostWc, tabId, wcId, tries = 10) {
    const f = fresh.get(wcId), t = tabs.find((x) => x.id === tabId);
    if (!on || !t) return;
    if (!f) { if (tries) setTimeout(() => attached(hostWc, tabId, wcId, tries - 1), 100); return; }       // main hasn't heard of the page yet
    if (f.hostWc !== hostWc) return;
    fresh.delete(wcId);
    bind(t, f.page, hostWc);
  }
  function bind(t, page, hostWc) {
    t.wc = page; t.full = false; t.ready = false; holder = hostWc;
    const mine = () => t.wc === page;
    if (process.env.DRIFT_MUTE) page.setAudioMuted(true);
    // a link that asks for a new tab gets one; a small window a page opens (sign in with Shop, Google, PayPal…) opens as one
    watchInput(page);
    page.setWindowOpenHandler((d) => opened(d, page, hostWc, mine));
    page.on('did-create-window', (w) => popup(w, page, hostWc, mine));
    const ready = () => { if (!mine() || t.ready || !isPage(page.getURL())) return; t.ready = true; if (t.id === active) restream(); };       // its first real page is in
    const moved = () => { if (!mine()) return; const u = page.getURL(); if (isPage(u)) t.url = u; ready(); hooks.changed(); };
    page.on('did-navigate', moved);
    page.on('did-stop-loading', () => { if (mine() && !t.ready) { ready(); hooks.changed(); } });
    page.on('did-navigate-in-page', (_e, _u, main) => { if (main) moved(); });
    page.on('page-title-updated', (_e, title) => { if (!mine()) return; t.title = String(title || '').slice(0, 200); hooks.changed(); });
    page.on('enter-html-full-screen', () => { if (mine()) t.full = true; });
    page.on('leave-html-full-screen', () => { if (mine()) t.full = false; hooks.unfull(hostWc); });
    page.on('audio-state-changed', () => { if (mine()) hooks.changed(); });       // the visuals listen to the PC's sound while a page plays some (see info().audible)
    page.on('zoom-changed', (_e, dir) => { if (mine() && t.id === active) zoom(dir === 'in' ? 1 : -1); });       // Ctrl + the mouse wheel
    // The browser's shortcuts. They have to be caught here: a key the page leaves alone goes on to the Drift window around it,
    // whose menu shortcuts would reload Drift itself (Ctrl+R), close it (Ctrl+W) or zoom Drift instead of the page.
    page.on('before-input-event', (e, k) => {
      if (k.type !== 'keyDown') return;
      if (k.key === 'Escape' && !t.full && !k.alt && !k.control) { e.preventDefault(); hooks.escape(); return; }       // Esc leaves the page's full screen first, then asks for Drift's controls
      const s = mine() && surfKey(k.key, MODS.filter((n) => k[n]));
      if (!s) return;
      e.preventDefault();
      if (s.do === 'url') toBar(hostWc); else act(s);
    });
    page.on('destroyed', () => {       // its tab was closed, or the monitors changed under it
      if (!mine()) return;
      t.wc = null; t.full = false; t.ready = false;
      if (!t.pending) t.pending = t.url;       // if it is still wanted, it loads again where it turns up next
      if (t.id === active) restream();
      hooks.changed();
    });
    // a tab brought back from last time: its page mustn't start playing by itself (it was paused when Drift closed, as far as anyone knows)
    page.on('dom-ready', () => { if (mine() && t.hold && isWeb(page.getURL())) { t.hold = false; page.executeJavaScript(HOLD).catch(() => {}); } });
    if (t.id === active) restream();
    go(t); hooks.changed();
  }
  // What a page (or one of its pop-ups) gets when it opens a window. Sign-in buttons open a small window and wait for it to
  // report back through window.opener: refused, the button just spins. Such a window opens over Drift, on this PC only (friends
  // don't see it, which also keeps what is typed in it to the host), and closes with the tab it came from.
  // Only right after someone clicked or pressed a key in the page: windows that open by themselves are pop-up adverts.
  const touched = new WeakMap();
  const watchInput = (wc) => wc.on('input-event', (_e, i) => { if (/^(mouseDown|mouseUp|keyDown|rawKeyDown|char|touchStart|gestureTap)$/.test(i.type)) touched.set(wc, Date.now()); });
  function opened({ url: u, disposition }, page, hostWc, mine) {
    if (!mine() || !isWeb(u)) return { action: 'deny' };
    if (disposition === 'foreground-tab' || disposition === 'background-tab') { setImmediate(() => newTab(u, disposition === 'background-tab')); return { action: 'deny' }; }
    if (disposition !== 'new-window' || !(Date.now() - (touched.get(page) || 0) < 5000)) return { action: 'deny' };
    const parent = BrowserWindow.fromWebContents(hostWc);
    return { action: 'allow', overrideBrowserWindowOptions: {
      parent: parent || undefined, autoHideMenuBar: true, backgroundColor: '#ffffff', show: true, minimizable: false,
      webPreferences: { nodeIntegration: false, nodeIntegrationInSubFrames: true, contextIsolation: true, sandbox: true, offscreen: false },       // as the page itself (the password guard runs in it too), but on screen
    } };
  }
  function popup(w, page, hostWc, mine) {
    const wc = w.webContents, parent = BrowserWindow.fromWebContents(hostWc);
    w.setMenuBarVisibility(false);
    if (parent && parent.isAlwaysOnTop()) w.setAlwaysOnTop(true, 'screen-saver');       // above Drift, when Drift stays above everything
    watchInput(wc);
    wc.setWindowOpenHandler((d) => opened(d, wc, hostWc, () => mine() && !wc.isDestroyed()));
    wc.on('did-create-window', (c) => popup(c, page, hostWc, mine));
    wc.on('will-navigate', (e, u) => { if (!isPage(u)) e.preventDefault(); });
    const gone = () => { if (!w.isDestroyed()) w.close(); };
    page.once('destroyed', gone);
    w.once('closed', () => { if (!page.isDestroyed()) page.removeListener('destroyed', gone); });
  }
  // Ctrl+L: the keys go to the Surf bar's address box, in the Drift window `hostWc` the page is in
  function toBar(hostWc) { if (!hostWc || hostWc.isDestroyed()) return; hostWc.focus(); hostWc.send('cmd', { type: 'web-url' }); }
  // Ctrl+plus, Ctrl+minus, Ctrl+0: the page in front a step bigger, smaller, or back to its own size. As in Chrome, it sticks to
  // the site (other tabs on it follow).
  function zoom(dir) {
    if (!alive()) return;
    const wc = cur().wc, f = wc.getZoomFactor();
    const to = !dir ? 1 : dir > 0 ? ZOOMS.find((z) => z > f + 0.01) || ZOOMS[ZOOMS.length - 1] : [...ZOOMS].reverse().find((z) => z < f - 0.01) || ZOOMS[0];
    wc.setZoomFactor(to);
    hooks.say(`Zoom ${Math.round(to * 100)}%`);
  }
  function nav(dir) { if (!alive()) return; const h = cur().wc.navigationHistory; if (dir < 0) { if (h.canGoBack()) h.goBack(); } else if (h.canGoForward()) h.goForward(); }

  // ---- Surf's extensions (in this window's session only) ----
  const exts = () => sess().extensions || sess();       // (session.extensions came in Electron 36; before, the session itself)
  const bgOf = (id) => webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().startsWith(`chrome-extension://${id}/`));
  // The background page of extension `id`, once `test` (run there) says it has started
  async function started(id, test) {
    for (let i = 0; i < 300; i++) {
      const bg = bgOf(id);
      if (bg && await bg.executeJavaScript(test).catch(() => false)) return bg;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`the extension ${id} didn't start`);
  }
  // Drift's own (surf-net/), which adds the Sec-CH-UA headers, saying what navigator.userAgentData says (see learnIdent())
  let netExt = null;
  function netReady() {
    if (!netExt) netExt = exts().loadExtension(path.join(__dirname, 'surf-net'))
      .then((e) => started(e.id, "typeof setIdent === 'function'"))
      .then((bg) => { tellIdent(bg); return bg; });
    return netExt;
  }
  function tellIdent(bg) {
    if (!bg) { if (netExt) netExt.then(tellIdent, () => {}); return; }
    if (!bg.isDestroyed()) bg.executeJavaScript(`setIdent(${JSON.stringify(ident)})`).catch(() => {});
  }

  // ---- advert blocking: uBlock Origin itself, as an extension (see surf-ublock.js) ----
  let loading = null, blocking = false;       // loading: resolves to { id, bg } once uBO is loaded and ready to filter
  function loadUbo() {
    if (!loading) loading = (async () => {
      const dir = await ublock.prepare(hooks.ublockDir());
      const e = exts().getAllExtensions().find((x) => path.resolve(x.path) === path.resolve(dir)) || await exts().loadExtension(dir);
      return { id: e.id, bg: await started(e.id, '!!(self.µBlock && self.µBlock.readyToFilter)') };
    })().catch((e) => { loading = null; throw e; });
    return loading;
  }
  // Turns blocking on or off to match the setting. Resolves once it is in place.
  // Once loaded, uBO stays loaded: Electron crashed closing an offscreen page after an extension had been taken out of the
  // session and put back. Off is uBO's own off switch instead: every page a "trusted site" (TRUST_ALL), only in memory, so
  // uBO's own settings are as they were. Nothing is blocked, hidden or run in a trusted page, and no scriptlets are handed out.
  const TRUST_ALL = '/^(?:https?|wss?):/';
  async function block() {
    const want = !!hooks.blockAds();
    blocking = want;
    if (!want && !loading) return;       // never loaded: nothing to switch off
    try {
      const { bg } = await loadUbo();
      if (blocking !== want) return;       // changed again meanwhile: that call sees to it
      await bg.executeJavaScript(`(() => {
        const t = self.µBlock.trustedSites, d = ${JSON.stringify(TRUST_ALL)}, rest = t.toLines().filter((x) => x !== d);
        t.fromLines(${want} ? rest : [...rest, d]);
        self.driftScriptletsReset();
      })()`);
    } catch (e) {
      if (!want || blocking !== want) return;
      blocking = false;
      console.error('advert blocker:', e && e.message);
      hooks.say('Adverts can\'t be blocked right now: the advert blocker couldn\'t be downloaded.');
    }
  }
  // ---- copy-protected video ----
  // Drift runs on castLabs' Electron, which can play video protected with Widevine (Netflix, Disney+, Prime Video, Spotify…).
  // Widevine itself is downloaded by Chromium the first time (a few MB, a second or two) and kept, and updated, after that.
  // On the stock Electron (`components` missing) protected video just doesn't play, as before.
  let wv = null;
  function widevine() {
    if (!wv) {
      const { components } = require('electron');
      wv = components && components.whenReady ? components.whenReady().then(() => true, () => false) : Promise.resolve(false);
    }
    return wv;
  }
  // Loads what a tab is waiting to show, once its page is there, the extensions and blocking are in place and Widevine is ready.
  function go(t) {
    if (!live(t) || !t.pending) return;
    const page = t.wc, my = ++t.seq;
    const ready = Promise.all([block(), widevine(), netReady().catch(() => {})]);
    Promise.race([ready, new Promise((r) => setTimeout(r, 15000))]).then(() => {       // (the first time, uBlock Origin is downloaded: ~6 MB)
      if (my !== t.seq || t.wc !== page || page.isDestroyed() || !t.pending) return;
      const u = t.pending; t.pending = '';
      page.loadURL(u).catch(() => {});
    });
  }
  // The setting changed: apply it and show the pages again.
  function blockChanged() {
    if (!!hooks.blockAds() === blocking || !ses) return;
    block().then(() => { for (const t of tabs) if (live(t) && isWeb(t.url)) t.wc.reload(); });       // (the start page has no adverts)
  }
  // Takes the pages off the screen. The tabs remember where they were, and load again when they are next shown.
  function unplace() {
    endOut(true);
    for (const t of tabs) { if (!t.pending) t.pending = t.url || HOME; drop(t); t.full = false; t.ready = false; }
    holder = null; sid = ''; fresh.clear(); gpu = false; frameOut = null;
    if (frameNext) { frameNext.release(); frameNext = null; }
  }
  // A tab lets go of its page. An offscreen page is ours to close; a <webview> goes when the window takes it away.
  function drop(t) {
    const wc = t.wc; t.wc = null;
    if (wc && !wc.isDestroyed() && wc.drift) {
      const w = BrowserWindow.fromWebContents(wc);
      if (!w || w.isDestroyed()) return;
      // The page goes first, then its window: Electron crashed destroying the window of a page still showing YouTube while
      // uBlock Origin was in the session (an offscreen window only; a <webview> was fine).
      const end = () => { if (!w.isDestroyed()) w.destroy(); };
      wc.loadURL('about:blank').then(() => setTimeout(end, 200), end);
      setTimeout(end, 2000);
    }
  }
  // Shows the browser on monitor `k` (or where it last was). On a different monitor from now, the pages load again there.
  function show(k) {
    if (!tabs.length) return;
    sess();
    const there = hooks.screen(k || key);
    if (on && there === hooks.screen(key)) return;
    unplace(); on = true; key = there; gen++;
    if (hooks.gpu() && hooks.win(key)) { gpu = true; for (const t of tabs) offscreen(t); }
    hooks.changed();
  }
  // The setting changed while the browser is up: put it up again the other way (its pages load again).
  function gpuChanged() { if (!on || gpu === !!hooks.gpu()) return; const k = key; on = false; show(k); }
  function hide() { if (!on) return; on = false; unplace(); hooks.changed(); }       // out of sight, tabs kept
  function close() { if (!on && !tabs.length) return; on = false; unplace(); tabs.length = 0; active = 0; hooks.changed(); }

  function newTab(u, behind) {
    if (tabs.length >= MAX_TABS) { hooks.say(`${MAX_TABS} tabs is the most Drift keeps open. Close one first.`); return; }
    const t = { id: nextId++, wc: null, url: '', title: '', pending: u || HOME, full: false, ready: false, seq: 0 };
    tabs.splice(tabs.indexOf(cur()) + 1 || tabs.length, 0, t);       // next to the one it came from
    if (!behind || !cur()) { active = t.id; sid = ''; }
    if (on && gpu) offscreen(t);
    painting(); hooks.changed();
  }
  // ---- kept between runs: the open tabs, the one in front and the monitor ----
  const saved = () => (on && tabs.length ? { urls: tabs.map((t) => t.url || t.pending || HOME).filter(isPage), active: Math.max(0, tabs.indexOf(cur())), key } : null);
  function restore(s) {
    const urls = (Array.isArray(s.urls) ? s.urls : []).map(String).filter(isPage).slice(0, MAX_TABS);
    if (!urls.length || tabs.length) return;
    for (const u of urls) tabs.push({ id: nextId++, wc: null, url: '', title: '', pending: u, full: false, ready: false, seq: 0, hold: isWeb(u) });
    active = (tabs[Math.min(Math.max(0, s.active | 0), tabs.length - 1)]).id;
    show(String(s.key || ''));
  }
  function select(id) { if (id === active || !tabs.some((t) => t.id === id)) return; active = id; restream(); painting(); hooks.changed(); }
  function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    if (tabs.length === 1) { close(); return; }       // the last tab takes the browser with it
    const t = tabs.splice(i, 1)[0]; drop(t);
    const u = t.url || t.pending;
    if (isPage(u)) { closed.push(u); if (closed.length > 20) closed.shift(); }
    if (id === active) { active = tabs[Math.min(i, tabs.length - 1)].id; restream(); painting(); }
    hooks.changed();
  }
  // What was typed, as an address: an address as it is, anything else as a Google search.
  function address(text) {
    let t = String(text || '').trim().slice(0, 2000);
    if (!t) return HOME;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = /^[^\s/]+\.[^\s/.]{2,}(\/\S*)?$/.test(t) || /^localhost(:\d+)?(\/\S*)?$/i.test(t) ? 'https://' + t : 'https://www.google.com/search?q=' + encodeURIComponent(t);
    try { const u = new URL(t); return isWeb(u.href) ? u.href : ''; } catch { return ''; }
  }
  // Something done with the browser's own controls or shortcuts, here or (m.do only) by a friend: go, new, tab, close, back, fwd,
  // reload, home, and (from the shortcuts) reopen, hard (reload, past the cache), step (`n` tabs along), nth (the `n`th tab) and zoom.
  // `k` is the monitor to show the browser on if it isn't showing.
  function act(m, k) {
    const t = cur();
    if (m.do === 'go' || m.do === 'home') {
      const u = m.do === 'home' ? HOME : address(m.text);
      if (!u) return { error: 'That doesn\'t look like a web address.' };
      if (!t) newTab(u); else { t.pending = u; go(t); }
      show(k);
    } else if (m.do === 'new') { newTab(HOME); show(k); }
    else if (m.do === 'tab') select(+m.id);
    else if (m.do === 'close') closeTab(+m.id || active);
    else if (m.do === 'back') nav(-1);
    else if (m.do === 'fwd') nav(1);
    else if (m.do === 'reload') { if (alive()) cur().wc.reload(); }
    else if (m.do === 'hard') { if (alive()) cur().wc.reloadIgnoringCache(); }
    else if (m.do === 'reopen') { const u = closed.pop(); if (u) { newTab(u); show(k); } }
    else if (m.do === 'step') { const i = tabs.indexOf(cur()), n = Math.sign(+m.n || 0); if (n && i >= 0) select(tabs[(i + n + tabs.length) % tabs.length].id); }
    else if (m.do === 'nth') { const n = +m.n | 0, x = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1]; if (x) select(x.id); }
    else if (m.do === 'zoom') zoom(Math.sign(+m.n || 0));
    return { ok: true };
  }

  // ---- sharing ----
  const label = (t) => t.title || (isHome(t.url || t.pending) ? 'New tab' : site(t.url || t.pending)) || 'New tab';
  const hist = (d) => { if (!alive()) return false; const h = cur().wc.navigationHistory; return d < 0 ? h.canGoBack() : h.canGoForward(); };
  const view = () => { const t = cur() || {}; return { sid, out: out ? out.name : '', url: out ? '' : t.url || t.pending || '', title: out ? out.title || out.name : t.title || '', tabs: tabs.map((x) => ({ id: x.id, title: label(x) })), active, back: hist(-1), fwd: hist(1) }; };
  // What friends are told about the browser. The picture and sound of the tab in front reach them as a stream, named by `sid`.
  const shared = () => (on && (alive() || (out && out.id)) && sid ? view() : null);
  // The frame whose picture and sound `hostWc` (the Drift window holding the browser) may capture to send to friends.
  const frame = (hostWc) => (!out && alive() && holder === hostWc ? cur().wc.mainFrame : null);
  // ...or, while the page is open in the PC's own browser, that browser's window (a desktop capture source id)
  const source = (hostWc) => (out && out.id && holder === hostWc ? out.id : null);
  // Plays back what a friend did over their picture of the page, or (local) what this PC did over a picture of it on one of its
  // monitors. Positions are fractions of the page's width and height.
  function input(e, local) {
    if (out || !alive() || !e || typeof e !== 'object' || !holder || holder.isDestroyed()) return;       // friends can't click in the PC's own browser
    const wc = cur().wc, win = BrowserWindow.fromWebContents(wc.drift ? wc : holder);
    if (!win) return;
    const [w, h] = wc.drift ? win.getContentSize() : pageDips();       // the page's own size, which may be bigger than its monitor (see pageSize)
    const x = Math.round(unit(e.x) * w), y = Math.round(unit(e.y) * h);
    const modifiers = (Array.isArray(e.m) ? e.m : []).filter((m) => MODS.includes(m));
    try {
      if (e.k === 'move') wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers: [...modifiers, ...HELD.filter((_n, i) => e.bt & (1 << i))] });       // held buttons make it a drag
      else if (e.k === 'down' || e.k === 'up') {
        if (e.b === 3 || e.b === 4) { if (e.k === 'down') nav(e.b === 3 ? -1 : 1); return; }       // the mouse's side buttons
        if (!BUTTONS[e.b]) return;
        wc.sendInputEvent({ type: e.k === 'down' ? 'mouseDown' : 'mouseUp', x, y, button: BUTTONS[e.b], clickCount: Math.max(1, Math.min(3, e.n | 0)), modifiers });
      } else if (e.k === 'wheel') {
        const lim = (n) => Math.max(-3000, Math.min(3000, Math.round(+n || 0)));
        wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -lim(e.dx), deltaY: -lim(e.dy), canScroll: true, modifiers });
      } else if (e.k === 'key') {
        const k = String(e.key || ''), ch = [...k].length === 1, code = KEYS[k] || (ch || /^F([1-9]|1[0-2])$/.test(k) ? k : '');
        const cmd = modifiers.includes('control') || modifiers.includes('meta');
        const s = surfKey(k, modifiers);       // the browser's shortcuts, for friends too (they can use the bar's buttons anyway)
        if (s) { if (e.d && s.do !== 'url') act(s); return; }       // (Ctrl+L is for the bar of the screen it was pressed on: the window sees to that)
        if (!code || k === 'Escape' || (!local && cmd && /^v$/i.test(k))) return;       // Esc is for Drift's controls; a friend pasting would hand over this PC's clipboard
        wc.sendInputEvent({ type: e.d ? 'keyDown' : 'keyUp', keyCode: code, modifiers });
        if (e.d && !cmd && !modifiers.includes('alt') && (ch || k === 'Enter')) wc.sendInputEvent({ type: 'char', keyCode: k === 'Enter' ? '\r' : k, modifiers });       // what the key types
      }
    } catch { /* not something the page can be sent */ }
  }

  // Forgets everything sites have kept in Surf: sign-ins, cookies, site storage, the cache and the tabs' history. The browser closes
  // first, so no open page writes any of it back.
  async function forget() {
    close();
    const s = sess();
    await Promise.all([s.clearStorageData(), s.clearCache(), s.clearAuthCache(), s.clearHostResolverCache()]);
    await s.cookies.flushStore().catch(() => {});
  }

  // ---- the page in the PC's own browser ----
  // Opens the page in front in this PC's default browser, over the Surf monitor. While that window is open, friends see it in
  // place of Surf's page (and hear the PC's sound), and Surf's own tab keeps quiet. Closing the window brings Surf back.
  async function goOutside() {
    if (!on || !alive()) return;
    if (out) { hooks.say(`The page is already open in ${out.name}. Close its window to come back to Surf.`); return; }
    const t = cur(), url = isWeb(t.url) ? t.url : '';
    const me = out = { name: outside.name() || 'your browser', id: '', title: '', stop: () => {} };
    hooks.changed();
    try {
      const o = await outside.open(url, hooks.bounds(key), hooks.profile(), (w) => {
        if (out !== me) return;
        if (!w) { if (!me.id) hooks.say(`${me.name} didn't open a window.`); endOut(); return; }
        const first = !me.id;
        me.id = w.id; me.title = w.title;
        if (first) {
          if (live(t)) t.wc.setAudioMuted(true);       // one soundtrack: the one in the browser
          hooks.away(true); restream();
          hooks.say(`Opened in ${me.name}. Friends see its window but can't click in it. Close it to come back to Surf.`);
        }
        hooks.changed();
      });
      me.name = o.name; me.stop = o.stop;
      if (out !== me) o.stop();
    } catch { if (out === me) { out = null; hooks.changed(); } hooks.say('No browser was found to open the page in.'); }
  }
  // Surf takes over again: the window was closed, or the browser left the screen (then the window is left as it is)
  function endOut(quiet) {
    if (!out) return;
    const was = out; out = null; was.stop();
    for (const t of tabs) if (live(t)) t.wc.setAudioMuted(!!process.env.DRIFT_MUTE);
    if (was.id) hooks.away(false);
    if (!quiet) { restream(); hooks.changed(); }
  }

  const info = () => ({ open: on, has: tabs.length > 0, key: on ? hooks.screen(key) : '', gen, gpu: on && gpu, page: on ? hooks.pageSize(hooks.screen(key)) : null, ext: outside.name(), audible: on && tabs.some((t) => live(t) && t.wc.isCurrentlyAudible()), ...view() });
  // The page's size in its own units (CSS pixels): drawn at pageSize's pixels, at the scale of the Surf monitor
  function dips(scale) { const px = hooks.pageSize(key); if (px) return [Math.round(px.w / scale), Math.round(px.h / scale)]; const hw = hooks.win(key); return hw ? hw.getContentSize() : [1280, 720]; }
  function pageDips() { const d = hooks.display(key) || {}; return dips(d.scaleFactor || 1); }
  // Mirroring started or stopped: an offscreen page takes its new size (a <webview> is sized by its window, from info().page)
  function resized() {
    if (!on || !gpu) { hooks.changed(); return; }
    const d = hooks.display(key) || {}, [w, h] = dips(d.scaleFactor || 1);
    for (const t of tabs) if (live(t) && t.wc.drift) { const pw = BrowserWindow.fromWebContents(t.wc); if (pw && !pw.isDestroyed()) pw.setContentSize(w, h); }
    painting(); hooks.changed();
  }
  outside.detect().then((b) => { if (b) hooks.changed(); });       // the Surf bar's button names it
  // ---- drawing offscreen (see the top) ----
  // A tab's page as a hidden offscreen window, the size of the Surf monitor's Drift window and drawn at its scale and refresh rate.
  function offscreen(t) {
    const hw = hooks.win(key);
    if (!hw || hw.isDestroyed() || live(t)) return;
    const d = hooks.display(key) || {}, [w, h] = dips(d.scaleFactor || 1), at = hw.getBounds();
    // Over the Surf monitor, and on top, though never shown: a box the page asks for (alert(), confirm(), "leave this site?") is
    // a window of its own over this one. Otherwise it came up behind Drift's window, which stays above everything, while the page
    // waited for it to be answered: nothing could be clicked or typed in the page again. Where the page opens a pop-up goes by
    // where it is, too.
    const win = new BrowserWindow({ show: false, x: at.x, y: at.y, width: w, height: h, useContentSize: true, frame: false, skipTaskbar: true,
      webPreferences: { partition: 'persist:web', offscreen: { useSharedTexture: true, deviceScaleFactor: d.scaleFactor || 1 },
        nodeIntegration: false, nodeIntegrationInSubFrames: true, contextIsolation: true, sandbox: true, backgroundThrottling: false,
        additionalArguments: ['--drift-offscreen'] } });       // (surf-select.js looks for it)
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setFullScreenable(false);       // a page going full screen fills its own picture, not a hidden window
    // Windows makes a new window as big as a whole monitor a little narrower than asked (1920 wide came out 1872), which put bars
    // beside the page on 16:9 monitors. Sized again once it exists, it takes the size asked for.
    const fit = () => { if (win.isDestroyed()) return; const [tw, th] = dips(d.scaleFactor || 1), [cw, ch] = win.getContentSize(); if (cw !== tw || ch !== th) win.setContentSize(tw, th); };
    fit(); win.webContents.once('did-finish-load', fit);
    const page = win.webContents;
    page.drift = true;
    page.setFrameRate(Math.max(30, Math.min(240, Math.round(d.displayFrequency) || 60)));
    page.on('will-navigate', (e, u) => { if (!isPage(u)) e.preventDefault(); });
    page.on('paint', (e) => { const tex = e.texture; if (tex) paint(t, page, tex); });
    page.on('cursor-changed', (_e, type) => { if (t.wc === page && t.id === active) cursor(type); });
    bind(t, page, hw.webContents);
    painting();
  }
  // Only the tab in front draws; showing it again draws it at once.
  function painting() {
    if (!gpu) return;
    for (const t of tabs) if (live(t) && t.wc.drift) { if (t.id === active) repaint(t.wc); else t.wc.stopPainting(); }
  }
  // A new frame now, even of a page that is standing still. (invalidate() isn't enough: on a still page its paint comes without a
  // texture. Stopping and starting painting again gives a whole new frame.)
  function repaint(page) { page.stopPainting(); page.startPainting(); }
  // Each frame goes to every window drawing the page, one at a time: a frame that comes while the last is still on its way waits,
  // and is replaced by any newer one.
  let frameOut = null, frameNext = null;
  function paint(t, page, tex) {
    if (t.wc !== page || t.id !== active || tex.textureInfo.widgetType !== 'frame' || !viewers.size) { tex.release(); return; }
    if (frameOut) { if (frameNext) frameNext.release(); frameNext = tex; return; }
    hand(tex);
  }
  function hand(tex) {
    let imp;
    try { imp = sharedTexture.importSharedTexture({ textureInfo: tex.textureInfo, allReferencesReleased: () => tex.release() }); } catch { tex.release(); return; }
    const mine = frameOut = Promise.all([...viewers].filter((v) => !v.isDestroyed()).map((v) => sharedTexture.sendSharedTexture({ frame: v.mainFrame, importedSharedTexture: imp }).catch(() => {})))
      .then(() => {
        imp.release();
        if (frameOut !== mine) return;
        frameOut = null;
        const n = frameNext; frameNext = null;
        if (n) hand(n);
      });
  }
  // A Drift window starts (or stops) drawing the page. It gets a frame straight away.
  function viewer(wc, yes) {
    if (!yes) { viewers.delete(wc); return; }
    if (!viewers.has(wc)) { viewers.add(wc); wc.once('destroyed', () => viewers.delete(wc)); }
    if (alive() && cur().wc.drift) repaint(cur().wc);
    if (lastCursor) wc.send('cmd', { type: 'web-cursor', c: lastCursor });
  }
  // The pointer the page wants (a hand over a link, a bar over text…), as CSS names it
  const CURSORS = { pointer: 'default', hand: 'pointer', nodrop: 'no-drop', 'm-panning': 'all-scroll', custom: 'default' };
  let lastCursor = '';
  function cursor(type) {
    const c = CURSORS[type] || (/^[a-z-]+$/.test(type) && !/panning/.test(type) ? type : 'default');
    if (c === lastCursor) return;
    lastCursor = c;
    for (const v of viewers) if (!v.isDestroyed()) v.send('cmd', { type: 'web-cursor', c });
  }

  return { host, attached, act, show, hide, close, nav, shared, frame, source, input, info, blockChanged, forget, outside: goOutside, saved, restore, viewer, gpuChanged, resized };
};
