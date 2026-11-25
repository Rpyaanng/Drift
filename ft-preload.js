// The transfer window's only way out (renderer/ft.js): setup messages, certificates, how each transfer is doing, and the
// file's bytes, a block at a time, through main.js to files.js. No keys, no hub and no paths come through here: main.js
// passes it SDPs that chat.js has checked, and reads or writes only the file that belongs to each transfer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ft', {
  send: (type, data) => ipcRenderer.send('ft', type, data),
  call: (op, x, ...args) => ipcRenderer.invoke('ft', op, x, ...args),
  on: (fn) => ipcRenderer.on('ft', (_e, m) => fn(m)),
});
