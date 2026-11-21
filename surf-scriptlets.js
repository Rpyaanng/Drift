// Drift — in every Surf page and frame, before any script of the page's own: uBlock Origin's scriptlets for it (the small
// scripts that take adverts out of a page from the inside). web.js asks uBO for them; nothing comes back while adverts
// aren't being blocked. See surf-ublock.js for why they come this way.
const { ipcRenderer, webFrame } = require('electron');

let url = location.href;
if (!/^https?:/i.test(url)) { try { url = window.parent.location.href; } catch { url = ''; } }       // about:blank frames go by their page's
if (/^https?:/i.test(url)) {
  let code = '';
  try { code = ipcRenderer.sendSync('surf-scriptlets', url); } catch { /* no answer: the page runs without */ }
  if (typeof code === 'string' && code) {
    self.driftMainWorld = (c) => { webFrame.executeJavaScript(c).catch(() => {}); };       // their page half (see the patches in surf-ublock.js)
    try { (0, eval)(code); } catch { /* one that fails is not the page's problem */ }
  }
}
