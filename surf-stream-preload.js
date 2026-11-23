// The Surf stream window's only way out (renderer/surf-stream.js): setup messages, certificates, what watchers send over their
// data channels, and each connection's state. No keys and no hub come through here; main.js passes it SDPs chat.js has checked.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('surfStream', {
  send: (type, data) => ipcRenderer.send('surf-stream', type, data),
  on: (fn) => ipcRenderer.on('surf-stream', (_e, m) => fn(m)),
});
