// The pointer overlay's only way in (renderer/bc-overlay.js): the pointers and chat messages to draw. Nothing goes out.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bcOverlay', {
  on: (fn) => ipcRenderer.on('bc-overlay', (_e, m) => fn(m)),
});
