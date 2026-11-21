const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voice', {
  signal: (to, d) => ipcRenderer.send('sig', to, d),
  onSignal: (cb) => ipcRenderer.on('sig', (_e, from, d) => cb(from, d)),
  heard: (from, at) => ipcRenderer.send('heard', from, at),
  mic: (state) => ipcRenderer.send('mic', state),
});
