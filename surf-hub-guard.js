// Drift — in every page and frame of a hub's Surf stream browser only (registered by web.js for that session). The browser
// runs on the host's PC, but everyone in the hub drives it: a file picker, an alert box or a print dialog would open on the
// host's screen, where nobody else can see or answer it (and a file picker would hand the host's files to whoever clicked).
// So none of them open (docs/plans/streams.md §5, §8). Also, the first time someone types into a password box, main.js is told,
// so it can say once that whatever is signed into here is signed in for everyone in the hub.
const { ipcRenderer, webFrame, contextBridge } = require('electron');

// In this isolated world: a click that would open a file picker goes no further. (Events are shared between the worlds, so this
// sees the page's own clicks, and labels pointing at file inputs, before the page does.)
const isFile = (el) => !!el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'file';
addEventListener('click', (e) => {
  const path = e.composedPath ? e.composedPath() : [e.target];
  for (const n of path) {
    if (isFile(n) || (n && n.tagName === 'LABEL' && isFile(n.control))) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  }
}, true);
addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && isFile(e.composedPath ? e.composedPath()[0] : e.target)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);       // (nothing of the host's can be dragged in, but just in case)
let told = false;
addEventListener('focusin', (e) => {
  const el = e.composedPath ? e.composedPath()[0] : e.target;
  if (!told && el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password') { told = true; ipcRenderer.send('surf-hub-note', 'password'); }
}, true);

// In the page's own world, before its scripts: what a script can call directly. (executeInMainWorld runs it there at once, before
// the page's first script; webFrame.executeJavaScript, on an Electron without it, may come a moment later.)
function mainWorld() {
  const I = HTMLInputElement.prototype, file = (el) => String(el.type).toLowerCase() === 'file';
  const click = I.click, pick = I.showPicker;
  I.click = function () { if (file(this)) return undefined; return click.apply(this, arguments); };
  if (pick) I.showPicker = function () { if (file(this)) throw new DOMException('File pickers are off on the Surf stream', 'NotAllowedError'); return pick.apply(this, arguments); };
  for (const k of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) if (window[k]) window[k] = () => Promise.reject(new DOMException('File pickers are off on the Surf stream', 'AbortError'));
  window.alert = () => {};
  window.confirm = () => false;
  window.prompt = () => null;
  window.print = () => {};
}
try {
  if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: mainWorld });
  else webFrame.executeJavaScript(`(${mainWorld.toString()})()`).catch(() => {});
} catch { webFrame.executeJavaScript(`(${mainWorld.toString()})()`).catch(() => {}); }
