// Drift — the Surf tab's browser: web pages (YouTube, or any other page) in tabs, shown on one monitor, inside Drift.
// While this PC is sharing, the picture and sound of the tab in front are streamed to friends' copies of Drift (renderer/app.js does that,
// over WebRTC), and what friends do with their mouse and keyboard over that picture is played back into the page here.
// Only this PC loads the pages: friends never open them themselves.
const { app, session, net, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const createOutside = require('./outside');

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

// ---- what the browser says it is, in the Sec-CH-UA headers (see sess()) ----
// navigator.userAgentData, read from a Drift window (its values are the same in every page): when the window loads, and again
// whenever a Surf page attaches to it (the window is surely loaded then, and the page hasn't loaded anything yet). Until it is known, the basic
// headers say what Chromium itself would ("Not:A-Brand" is Chromium's made-up brand, and can change between versions: hence
// reading it), and the detailed ones aren't sent.
const ID_FIELDS = ['brands', 'mobile', 'platform', 'fullVersionList', 'uaFullVersion', 'platformVersion', 'architecture', 'bitness', 'wow64', 'model', 'formFactors'];
let ident = { brands: [{ brand: 'Not:A-Brand', version: '8' }, { brand: 'Chromium', version: (process.versions.chrome || '').split('.')[0] }],
  mobile: false, platform: { win32: 'Windows', darwin: 'macOS' }[process.platform] || 'Linux', known: false };
const sfStr = (s) => `"${String(s == null ? '' : s).replace(/[\\"]/g, '\\$&')}"`;       // a structured-header string, as Chrome writes it
const sfList = (bs) => (Array.isArray(bs) ? bs : []).map((b) => `${sfStr(b.brand)};v=${sfStr(b.version)}`).join(', ');
const sfBool = (b) => (b ? '?1' : '?0');
// the detailed hints a site can ask for with Accept-CH: header → [navigator.userAgentData field, how it is written]
const HIGH = {
  'sec-ch-ua-full-version-list': ['fullVersionList', sfList],
  'sec-ch-ua-full-version': ['uaFullVersion', sfStr],
  'sec-ch-ua-platform-version': ['platformVersion', sfStr],
  'sec-ch-ua-arch': ['architecture', sfStr],
  'sec-ch-ua-bitness': ['bitness', sfStr],
  'sec-ch-ua-wow64': ['wow64', sfBool],
  'sec-ch-ua-model': ['model', sfStr],
  'sec-ch-ua-form-factors': ['formFactors', (f) => [].concat(f).map(sfStr).join(', ')],
};
// The headers for one request: the three every Chrome sends, and those of `want` (header names a site asked for) once known
function hints(want) {
  const h = { 'sec-ch-ua': sfList(ident.brands), 'sec-ch-ua-mobile': sfBool(ident.mobile), 'sec-ch-ua-platform': sfStr(ident.platform) };
  if (ident.known && want) for (const k of want) { const [field, write] = HIGH[k] || []; if (field && ident[field] !== undefined) h[k] = write(ident[field]); }
  return h;
}
function learnIdent(wc) {
  if (ident.known || !wc || wc.isDestroyed()) return;
  const read = () => {
    if (ident.known || wc.isDestroyed()) return;
    wc.executeJavaScript(`navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(${JSON.stringify(ID_FIELDS)}) : null`)
      .then((v) => { if (v && Array.isArray(v.brands) && v.brands.length && !ident.known) ident = { ...v, known: true }; })
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
//   listsFile()    where the advert-blocking lists are kept between runs
//   say(text)      show a message on screen
//   bounds(key)    where monitor `key`'s Drift window is, to open the outside browser over it
//   away(on)       a browser window of the PC's own is (on) or is no longer over the Surf monitor: Drift must not stay above it
//   profile()      the folder the outside browser keeps Drift's profile in
module.exports = function createWeb(hooks) {
  let on = false, key = '';  // is the browser showing, and on which monitor
  let gen = 0;               // goes up each time the browser is put somewhere: the window makes new <webview>s for it
  let holder = null;         // the Drift window the pages are in
  const tabs = [];           // { id, wc, url, title, pending, full, ready, seq }: wc is the tab's page, a <webview> in that window (renderer/app.js makes it)
  let active = 0, nextId = 1;
  let sid = '';              // names the stream of the tab in front: friends ask for it again when it changes
  let out = null;            // { name, id, title, stop }: the page is open in the PC's own browser, whose window (`id`, a capture source) friends see instead
  const outside = createOutside();
  let ses = null, made = 0;
  const asked = new Map();   // origin → the detailed Sec-CH-UA headers it asked for with Accept-CH (see sess())
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
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|Drift)\/\S+/gi, '').replace(/\bChrome\/(\d+)\.[\d.]+/, 'Chrome/$1.0.0.0'));
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen'));       // no camera, microphone, location, notifications…
    ses.setPermissionCheckHandler((_wc, perm) => perm === 'fullscreen');                 // ...and pages are told so up front (otherwise they read "granted")
    // Electron never sends the Sec-CH-UA headers every Chrome sends (it has no client hints at all), while the page's own
    // navigator.userAgentData still answers. Sites' bot checks see the mismatch and ask for captcha after captcha, so the
    // headers are added here, saying exactly what navigator.userAgentData says (see hints()). The detailed ones (full version,
    // platform version, architecture…) go only to a site that asked for them with Accept-CH, as Chrome does.
    ses.webRequest.onBeforeSendHeaders((d, cb) => {
      const h = d.requestHeaders;
      if (/^https:|^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(d.url)) {
        let o = ''; try { o = new URL(d.url).origin; } catch { /* keeps the basic ones */ }
        const has = new Set(Object.keys(h).map((k) => k.toLowerCase()));       // (a page's own fetch() already carries the basic ones)
        for (const [k, v] of Object.entries(hints(asked.get(o)))) if (!has.has(k)) h[k] = v;
      }
      cb({ requestHeaders: h });
    });
    // (onHeadersReceived belongs to the advert blocker: Electron allows one listener per event, but this one is free)
    ses.webRequest.onResponseStarted({ urls: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'] }, (d) => {
      if (d.resourceType !== 'mainFrame') return;       // as in Chrome: a page itself asks, for its own origin
      const v = Object.entries(d.responseHeaders || {}).find(([k]) => k.toLowerCase() === 'accept-ch');
      if (!v) return;
      let o; try { o = new URL(d.url).origin; } catch { return; }
      const want = new Set([].concat(v[1]).join(',').split(',').map((s) => s.trim().toLowerCase()).filter((s) => HIGH[s]));
      asked.delete(o);
      if (want.size) { asked.set(o, want); if (asked.size > 500) asked.delete(asked.keys().next().value); }
    });
    // In every page and frame: password boxes can't be turned into plain text, so nobody watching can read a password (see surf-guard.js)
    ses.registerPreloadScript({ type: 'frame', id: 'drift-password-guard', filePath: path.join(__dirname, 'surf-guard.js') });
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
    // The start page, and its search box: drift://home/go?q=… goes on to the address (or the YouTube search) it stands for,
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
    learnIdent(hostWc);
    hostWc.on('will-attach-webview', (e, prefs, params) => {
      if (!on || params.partition !== 'persist:web') { e.preventDefault(); return; }
      delete prefs.preloadURL; delete prefs.preload;
      // nodeIntegrationInSubFrames only lets the password guard run inside frames too (a sign-in box is often in one): pages still get no Node
      Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: true, contextIsolation: true, sandbox: true, backgroundThrottling: false });
      params.src = 'about:blank';
    });
    hostWc.on('did-attach-webview', (_e, page) => {
      learnIdent(hostWc);
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
    page.on('before-input-event', (e, k) => {
      if (k.type !== 'keyDown') return;
      if (k.key === 'Escape' && !t.full && !k.alt && !k.control) { e.preventDefault(); hooks.escape(); }       // Esc leaves the page's full screen first, then asks for Drift's controls
      else if (k.alt && !k.control && k.key === 'ArrowLeft') { e.preventDefault(); nav(-1); }                 // Alt+Left / Alt+Right: back and forward
      else if (k.alt && !k.control && k.key === 'ArrowRight') { e.preventDefault(); nav(1); }
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
      webPreferences: { nodeIntegration: false, nodeIntegrationInSubFrames: true, contextIsolation: true, sandbox: true },       // as the page itself (the password guard runs in it too)
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
  function nav(dir) { if (!alive()) return; const h = cur().wc.navigationHistory; if (dir < 0) { if (h.canGoBack()) h.goBack(); } else if (h.canGoForward()) h.goForward(); }

  // ---- advert blocking (@ghostery/adblocker-electron, with the lists uBlock Origin uses), in this window only ----
  let engine = null, loading = null, blocking = false;
  function loadEngine() {
    if (!loading) loading = (async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const file = hooks.listsFile();
      const fresh = async () => { const e = await ElectronBlocker.fromPrebuiltAdsAndTracking((u, o) => net.fetch(u, o)); fs.promises.writeFile(file, e.serialize()).catch(() => {}); return e; };
      const kept = async () => ElectronBlocker.deserialize(await fs.promises.readFile(file));
      let age = Infinity;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* first time */ }
      const e = await (age > 86400000 ? fresh().catch(kept) : kept().catch(fresh));       // new lists once a day; yesterday's if the download fails
      // The library doesn't look at whether the fixes it runs in a page worked; one that fails is not worth a warning.
      // Each fix (a uBlock Origin "scriptlet") is run in a scope of its own. The library runs them one after another straight
      // into the page, where each one declares the same helpers again at the top level: `class JSONPath` can't be declared
      // twice, so some never ran, and a later copy of `safeSelf` took the fetch and JSON.parse the earlier fixes had already
      // wrapped for the real ones, so they called themselves until the stack ran out. On YouTube that broke the page's own
      // navigation: a video clicked on the first visit didn't show until the page was reloaded.
      const inject = e.onInjectCosmeticFilters;
      e.onInjectCosmeticFilters = (event, u, msg) => inject({ frameId: event.frameId, processId: event.processId, sender: {
        insertCSS: (css, o) => event.sender.insertCSS(css, o).catch(() => {}),       // (a page closing as it arrives)
        executeJavaScript: (code, gesture) => { event.sender.executeJavaScript(`(function () {\n${code}\n})();`, gesture).catch(() => {}); },
      } }, u, msg);
      return e;
    })().catch((e) => { loading = null; throw e; });
    return loading;
  }
  // Turns blocking on or off to match the setting. Resolves once it is in place.
  async function block() {
    const want = !!hooks.blockAds();
    if (want === blocking) { if (want) await loadEngine().catch(() => {}); return; }
    blocking = want;
    if (!want) { if (engine && engine.isBlockingEnabled(sess())) engine.disableBlockingInSession(sess()); return; }
    try {
      engine = await loadEngine();
      if (blocking && !engine.isBlockingEnabled(sess())) engine.enableBlockingInSession(sess());
    } catch { blocking = false; hooks.say('Adverts can\'t be blocked right now: the blocking lists couldn\'t be downloaded.'); }
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
  // Loads what a tab is waiting to show, once its page is there, blocking is in place and Widevine is ready.
  function go(t) {
    if (!live(t) || !t.pending) return;
    const page = t.wc, my = ++t.seq;
    Promise.race([Promise.all([block(), widevine()]), new Promise((r) => setTimeout(r, 6000))]).then(() => {       // don't wait long for either
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
    for (const t of tabs) { if (!t.pending) t.pending = t.url || HOME; t.wc = null; t.full = false; t.ready = false; }
    holder = null; sid = ''; fresh.clear();
  }
  // Shows the browser on monitor `k` (or where it last was). On a different monitor from now, the pages load again there.
  function show(k) {
    if (!tabs.length) return;
    sess();
    const there = hooks.screen(k || key);
    if (on && there === hooks.screen(key)) return;
    unplace(); on = true; key = there; gen++; hooks.changed();
  }
  function hide() { if (!on) return; on = false; unplace(); hooks.changed(); }       // out of sight, tabs kept
  function close() { if (!on && !tabs.length) return; on = false; unplace(); tabs.length = 0; active = 0; hooks.changed(); }

  function newTab(u, behind) {
    if (tabs.length >= MAX_TABS) { hooks.say(`${MAX_TABS} tabs is the most Drift keeps open. Close one first.`); return; }
    const t = { id: nextId++, wc: null, url: '', title: '', pending: u || HOME, full: false, ready: false, seq: 0 };
    tabs.splice(tabs.indexOf(cur()) + 1 || tabs.length, 0, t);       // next to the one it came from
    if (!behind || !cur()) { active = t.id; sid = ''; }
    hooks.changed();
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
  function select(id) { if (id === active || !tabs.some((t) => t.id === id)) return; active = id; restream(); hooks.changed(); }
  function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    if (tabs.length === 1) { close(); return; }       // the last tab takes the browser with it
    const t = tabs.splice(i, 1)[0]; t.wc = null;
    if (id === active) { active = tabs[Math.min(i, tabs.length - 1)].id; restream(); }
    hooks.changed();
  }
  // What was typed, as an address: an address as it is, anything else as a YouTube search.
  function address(text) {
    let t = String(text || '').trim().slice(0, 2000);
    if (!t) return HOME;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = /^[^\s/]+\.[^\s/.]{2,}(\/\S*)?$/.test(t) || /^localhost(:\d+)?(\/\S*)?$/i.test(t) ? 'https://' + t : 'https://www.youtube.com/results?search_query=' + encodeURIComponent(t);
    try { const u = new URL(t); return isWeb(u.href) ? u.href : ''; } catch { return ''; }
  }
  // Something done with the browser's own controls, here or (m.do only) by a friend: go, new, tab, close, back, fwd, reload, home.
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
  // Plays back what a friend did over their picture of the page. Positions are fractions of the page's width and height.
  function input(e) {
    if (out || !alive() || !e || typeof e !== 'object' || !holder || holder.isDestroyed()) return;       // friends can't click in the PC's own browser
    const wc = cur().wc, win = BrowserWindow.fromWebContents(holder);
    if (!win) return;
    const [w, h] = win.getContentSize();       // the page fills its Drift window
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
        if (!code || k === 'Escape' || (cmd && /^v$/i.test(k))) return;       // Esc is for Drift's controls; pasting would hand over this PC's clipboard
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

  const info = () => ({ open: on, has: tabs.length > 0, key: on ? hooks.screen(key) : '', gen, ext: outside.name(), ...view() });
  outside.detect().then((b) => { if (b) hooks.changed(); });       // the Surf bar's button names it
  return { host, attached, act, show, hide, close, nav, shared, frame, source, input, info, blockChanged, forget, outside: goOutside, saved, restore };
};
