// Drift — the Surf tab's browser: web pages (YouTube, or any other page) in tabs, shown on one monitor, inside Drift.
// While this PC is sharing, the picture and sound of the tab in front are streamed to friends' copies of Drift (renderer/app.js does that,
// over WebRTC), and what friends do with their mouse and keyboard over that picture is played back into the page here.
// Only this PC loads the pages: friends never open them themselves.
const { session, net, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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
const site = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// hooks (all supplied by the main process):
//   changed()      the browser changed: tell the windows and any friends
//   screen(key)    the monitor the browser is shown on: `key` if Drift has a window there, otherwise the main one
//   escape()       Esc was pressed in a page: bring Drift's own controls up
//   unfull(host)   a page left full screen (`host` is the Drift window it sits in)
//   blockAds()     should adverts be blocked in pages?
//   listsFile()    where the advert-blocking lists are kept between runs
//   say(text)      show a message on screen
module.exports = function createWeb(hooks) {
  let on = false, key = '';  // is the browser showing, and on which monitor
  let gen = 0;               // goes up each time the browser is put somewhere: the window makes new <webview>s for it
  let holder = null;         // the Drift window the pages are in
  const tabs = [];           // { id, wc, url, title, pending, full, ready, seq }: wc is the tab's page, a <webview> in that window (renderer/app.js makes it)
  let active = 0, nextId = 1;
  let sid = '';              // names the stream of the tab in front: friends ask for it again when it changes
  let ses = null, made = 0;
  const fresh = new Map();   // pages the window has made that it hasn't yet said which tab they are for
  const run = crypto.randomBytes(4).toString('hex');
  const cur = () => tabs.find((t) => t.id === active) || null;
  const live = (t) => !!t && !!t.wc && !t.wc.isDestroyed();
  const alive = () => live(cur());
  const restream = () => { sid = alive() && cur().ready ? `${run}-${++made}` : ''; };       // a page still on its way in can't be captured yet

  function sess() {
    if (ses) return ses;
    ses = session.fromPartition('persist:web');       // its own cookies and sign-ins, kept between runs, apart from Drift's own windows
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|Drift)\/\S+/gi, ''));     // sites turn away browsers they don't recognise
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen'));       // no camera, microphone, location, notifications…
    // In every page and frame: password boxes can't be turned into plain text, so nobody watching can read a password (see surf-guard.js)
    ses.registerPreloadScript({ type: 'frame', id: 'drift-password-guard', filePath: path.join(__dirname, 'surf-guard.js') });
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
    hostWc.on('will-attach-webview', (e, prefs, params) => {
      if (!on || params.partition !== 'persist:web') { e.preventDefault(); return; }
      delete prefs.preloadURL; delete prefs.preload;
      // nodeIntegrationInSubFrames only lets the password guard run inside frames too (a sign-in box is often in one): pages still get no Node
      Object.assign(prefs, { nodeIntegration: false, nodeIntegrationInSubFrames: true, contextIsolation: true, sandbox: true, backgroundThrottling: false });
      params.src = 'about:blank';
    });
    hostWc.on('did-attach-webview', (_e, page) => {
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
    // a link that asks for a new tab gets one; windows a page opens by itself (pop-ups) don't
    page.setWindowOpenHandler(({ url: u, disposition }) => {
      if (mine() && isWeb(u) && (disposition === 'foreground-tab' || disposition === 'background-tab')) setImmediate(() => newTab(u, disposition === 'background-tab'));
      return { action: 'deny' };
    });
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
    if (t.id === active) restream();
    go(t); hooks.changed();
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
      const inject = e.onInjectCosmeticFilters;
      e.onInjectCosmeticFilters = (event, u, msg) => inject({ frameId: event.frameId, processId: event.processId, sender: {
        insertCSS: (css, o) => event.sender.insertCSS(css, o).catch(() => {}),       // (a page closing as it arrives)
        executeJavaScript: (code, gesture) => { event.sender.executeJavaScript(code, gesture).catch(() => {}); },
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
  // Loads what a tab is waiting to show, once its page is there and blocking is in place.
  function go(t) {
    if (!live(t) || !t.pending) return;
    const page = t.wc, my = ++t.seq;
    Promise.race([block(), new Promise((r) => setTimeout(r, 6000))]).then(() => {       // don't wait long for the lists
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
  const view = () => { const t = cur() || {}; return { sid, url: t.url || t.pending || '', title: t.title || '', tabs: tabs.map((x) => ({ id: x.id, title: label(x) })), active, back: hist(-1), fwd: hist(1) }; };
  // What friends are told about the browser. The picture and sound of the tab in front reach them as a stream, named by `sid`.
  const shared = () => (on && alive() && sid ? view() : null);
  // The frame whose picture and sound `hostWc` (the Drift window holding the browser) may capture to send to friends.
  const frame = (hostWc) => (alive() && holder === hostWc ? cur().wc.mainFrame : null);
  // Plays back what a friend did over their picture of the page. Positions are fractions of the page's width and height.
  function input(e) {
    if (!alive() || !e || typeof e !== 'object' || !holder || holder.isDestroyed()) return;
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

  const info = () => ({ open: on, has: tabs.length > 0, key: on ? hooks.screen(key) : '', gen, ...view() });
  return { host, attached, act, show, hide, close, nav, shared, frame, input, info, blockChanged, forget };
};
