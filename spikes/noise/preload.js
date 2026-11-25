const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('spike', { wasm: () => ipcRenderer.invoke('wasm'), out: (r) => ipcRenderer.send('out', r) });
