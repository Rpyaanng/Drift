// The voice window's only way out (renderer/voice.js): setup messages, what the microphone is doing, who is speaking.
// No keys and no hub come through here; main.js passes it SDPs that chat.js has already checked, and verdicts.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('voice', {
  send: (type, data) => ipcRenderer.send('voice', type, data),
  on: (fn) => ipcRenderer.on('voice', (_e, m) => fn(m)),
});
