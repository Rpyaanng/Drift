// Drift — in every Surf page and frame (registered by web.js): the volume mixer's Surf level. Electron can mute a page but
// has no volume for one, so the page's own <video> and <audio> elements are turned down from the inside. The page still
// sees and sets the volume it asked for (a site's own volume slider works as before); what plays is that, times the level.
// Sound a page makes with Web Audio alone (some games) isn't reached.
const { ipcRenderer, webFrame } = require('electron');

const K = '__drift' + Math.random().toString(36).slice(2);       // where the page half keeps its setter: a name the page can't guess
let g0 = 1;
try { const g = ipcRenderer.sendSync('surf-gain'); if (typeof g === 'number' && isFinite(g)) g0 = g; } catch { /* no answer: full volume */ }

// the page half: runs in the page's own world, before its scripts
const PAGE = `((K, g) => {
  const P = HTMLMediaElement.prototype, d = Object.getOwnPropertyDescriptor(P, 'volume');
  if (!d || !d.get || !d.set) return;
  const want = new WeakMap(), refs = new Set();       // the volume the page asked for, by element; the elements seen
  const put = (el) => { try { d.set.call(el, Math.max(0, Math.min(1, want.get(el) * g))); } catch {} };
  const track = (el) => {
    if (!(el instanceof HTMLMediaElement) || want.has(el)) return;
    want.set(el, d.get.call(el)); refs.add(new WeakRef(el)); put(el);
  };
  Object.defineProperty(P, 'volume', { configurable: true, enumerable: d.enumerable,
    get() { return want.has(this) ? want.get(this) : d.get.call(this); },
    set(v) {
      if (!(+v >= 0 && +v <= 1)) { d.set.call(this, v); return; }       // the browser's own error for a bad value
      if (!want.has(this)) refs.add(new WeakRef(this));
      want.set(this, +v); put(this);
    } });
  const play = P.play;
  P.play = function () { track(this); return play.apply(this, arguments); };
  for (const ev of ['play', 'loadstart', 'playing']) addEventListener(ev, (e) => track(e.target), true);       // elements that start by themselves
  Object.defineProperty(window, K, { value: (n) => {
    g = n;
    for (const r of refs) { const el = r.deref(); if (el) put(el); else refs.delete(r); }
  } });
})(${JSON.stringify(K)}, ${g0})`;

webFrame.executeJavaScript(PAGE).catch(() => {});
ipcRenderer.on('surf-gain', (_e, g) => {
  if (typeof g === 'number' && isFinite(g)) webFrame.executeJavaScript(`window[${JSON.stringify(K)}] && window[${JSON.stringify(K)}](${g})`).catch(() => {});
});
