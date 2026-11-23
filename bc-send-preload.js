// The broadcast window's only way out (renderer/bc-send.js): setup messages, certificates, pointers from viewers, and
// how the broadcast is doing. No keys and no hub come through here; main.js passes it SDPs that chat.js has checked.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bcSend', {
  send: (type, data) => ipcRenderer.send('bc-send', type, data),
  on: (fn) => ipcRenderer.on('bc-send', (_e, m) => fn(m)),
});
