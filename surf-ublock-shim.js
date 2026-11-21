// Drift — runs first in uBlock Origin's background page (copied into it as js/drift-shim.js by surf-ublock.js).
// Electron's extensions lack some chrome.* APIs uBO uses. uBO's background scripts are patched to call `driftChrome` instead
// of `chrome`: the real APIs, with stand-ins for what is missing. (Electron makes `chrome` again on every read, so things
// can't simply be added to it.)
//   browserAction, contextMenus   uBO's toolbar button and menu: there are none, so they do nothing
//   privacy                       settings uBO can change in Chrome: left as they are
//   windows                       nothing to report
//   webNavigation                 made from webRequest: a frame's document arriving is its navigation committing, which is how
//                                 uBO keeps track of which page each tab is showing
//   tabs.insertCSS / removeCSS    uBO's element hiding: the CSS goes into the frame as a stylesheet of the document's own
//                                 (adoptedStyleSheets), which no element of the page can see or take away
{
  const real = self.chrome;
  const event = () => {
    const fns = new Set();
    return {
      addListener: (f) => fns.add(f), removeListener: (f) => fns.delete(f), hasListener: (f) => fns.has(f),
      fire: (...a) => { for (const f of fns) try { f(...a); } catch (e) { console.error(e); } },
    };
  };
  const noop = (...a) => { const cb = a.find((x) => typeof x === 'function'); if (cb) cb(); return Promise.resolve(); };
  // an API none of whose calls do anything, and whose events never fire
  const stub = (base = {}) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : typeof k !== 'string' ? undefined : /^on[A-Z]/.test(k) ? (t[k] = event()) : noop) });
  const setting = () => ({ get: (_d, cb) => cb && cb({ value: true, levelOfControl: 'not_controllable' }), set: noop, clear: noop, onChange: event() });

  // ---- webNavigation ----
  const frames = new Map();       // tabId → Map(frameId → { frameId, parentFrameId, url })
  const nav = stub({
    getFrame: (d, cb) => { const f = frames.get(d.tabId)?.get(d.frameId) || null; if (cb) cb(f); return Promise.resolve(f); },
    getAllFrames: (d, cb) => { const m = frames.get(d.tabId), a = m ? [...m.values()] : []; if (cb) cb(a); return Promise.resolve(a); },
  });
  const FRAMES = { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] };
  real.webRequest.onBeforeRequest.addListener((d) => {
    if (d.tabId < 0) return;
    nav.onBeforeNavigate.fire({ tabId: d.tabId, frameId: d.frameId, parentFrameId: d.parentFrameId, url: d.url, timeStamp: d.timeStamp || Date.now() });
  }, FRAMES);
  real.webRequest.onResponseStarted.addListener((d) => {
    if (d.tabId < 0) return;
    let m = frames.get(d.tabId);
    if (!m || d.type === 'main_frame') frames.set(d.tabId, (m = new Map()));       // a new page: its old frames are gone
    m.set(d.frameId, { frameId: d.frameId, parentFrameId: d.parentFrameId, url: d.url, errorOccurred: false });
    const c = { tabId: d.tabId, frameId: d.frameId, parentFrameId: d.parentFrameId, url: d.url, timeStamp: d.timeStamp || Date.now(), transitionType: 'link', transitionQualifiers: [] };
    nav.onCommitted.fire(c);
    setTimeout(() => { nav.onDOMContentLoaded.fire(c); nav.onCompleted.fire(c); }, 0);
  }, FRAMES);
  if (real.tabs.onRemoved) real.tabs.onRemoved.addListener((id) => frames.delete(id));

  // ---- tabs.insertCSS / removeCSS ----
  const sheet = (css, on) => {
    const m = self.__driftSheets || (self.__driftSheets = new Map()), had = m.get(css);
    if (on && !had) { const s = new CSSStyleSheet(); s.replaceSync(css); m.set(css, s); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]; }
    else if (!on && had) { m.delete(css); document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== had); }
  };
  const css = (on) => (tabId, d, cb) => {
    const o = { code: `(${sheet})(${JSON.stringify(String(d.code || ''))}, ${on})`, runAt: 'document_start', matchAboutBlank: !!d.matchAboutBlank };
    if (d.allFrames) o.allFrames = true; else if (typeof d.frameId === 'number') o.frameId = d.frameId;
    return real.tabs.executeScript(tabId, o, () => { void real.runtime.lastError; if (cb) cb(); });
  };
  const tabsMore = { insertCSS: css(true), removeCSS: css(false) };

  const missing = {
    browserAction: stub(), contextMenus: stub(), webNavigation: nav,
    windows: stub({ get: (_i, o, cb) => (typeof o === 'function' ? o : cb || (() => {}))(null), create: (_o, cb) => cb && cb(null), update: (_i, _o, cb) => cb && cb(null), WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1 }),
    privacy: { network: { networkPredictionEnabled: setting(), webRTCIPHandlingPolicy: setting() }, websites: { hyperlinkAuditingEnabled: setting() } },
  };
  // the APIs Electron does have, with any call or event they lack filled in (runtime, storage and webRequest as they are)
  const filled = new Map();
  self.driftChrome = new Proxy({}, { get: (_t, k) => {
    const v = real[k];
    if (v === undefined) return missing[k];
    if (typeof v !== 'object' || v === null || k === 'runtime' || k === 'storage' || k === 'webRequest') return v;
    if (!filled.has(k)) {
      const more = k === 'tabs' ? tabsMore : {};
      filled.set(k, new Proxy(v, { get: (t, m) => (more[m] || (t[m] !== undefined ? t[m] : typeof m !== 'string' ? undefined : /^on[A-Z]/.test(m) ? event() : noop)) }));
    }
    return filled.get(k);
  } });
  self.driftPreloadScriptlets = true;       // Drift's preload runs the scriptlets (see surf-ublock.js)
}
var browser = self.driftChrome;       // eslint-disable-line no-var -- a global uBO's scripts read as `browser`
