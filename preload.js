const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('drift', {
  init: () => ipcRenderer.invoke('init'),
  patch: (p) => ipcRenderer.send('patch', p),
  cmd: (c) => ipcRenderer.send('cmd', c),
  levels: (l) => ipcRenderer.send('levels', l),
  now: (n) => ipcRenderer.send('now', n),
  listDir: (d, kind) => ipcRenderer.invoke('list-dir', d, kind),
  searchLib: (kind, root, q) => ipcRenderer.invoke('search-lib', kind, root, q),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  on: (channel, fn) => {
    if (['state', 'levels', 'now', 'cmd'].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
