const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

contextBridge.exposeInMainWorld('drift', {
  init: () => ipcRenderer.invoke('init'),
  patch: (p) => ipcRenderer.send('patch', p),
  cmd: (c) => ipcRenderer.send('cmd', c),
  levels: (l) => ipcRenderer.send('levels', l),
  now: (n) => ipcRenderer.send('now', n),
  listDir: (d, kind) => ipcRenderer.invoke('list-dir', d, kind),
  searchLib: (kind, root, q) => ipcRenderer.invoke('search-lib', kind, root, q),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  subCues: () => ipcRenderer.invoke('sub-cues'),
  subSearch: (q) => ipcRenderer.invoke('sub-search', q),
  subDownload: (item) => ipcRenderer.invoke('sub-download', item),
  on: (channel, fn) => {
    if (['state', 'levels', 'now', 'cmd'].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});

// A Surf page drawn offscreen (web.js, "Draw Surf on the graphics card") arrives here frame by frame as a texture on the graphics
// card. It is drawn into the page's canvas (#webGpu, made by app.js while this window shows the page), whole, with bars beside it if
// this monitor's shape differs. The frame's size goes on the canvas (data-fw, data-fh) so app.js can tell where on the page the mouse is.
if (sharedTexture && sharedTexture.setSharedTextureReceiver) {
  let g = null, gc = null, sized = '';
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture: tex }) => {
    try {
      const c = document.getElementById('webGpu');
      if (!c) return;
      const f = tex.getVideoFrame();
      try {
        const dpr = window.devicePixelRatio || 1, cw = Math.max(1, Math.round(c.clientWidth * dpr)), ch = Math.max(1, Math.round(c.clientHeight * dpr));
        const fw = f.displayWidth, fh = f.displayHeight;
        if (c !== gc) { gc = c; g = c.getContext('2d', { alpha: false, desynchronized: true }); sized = ''; }
        const now = `${cw}x${ch}/${fw}x${fh}`;
        if (now !== sized) {
          sized = now;
          if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
          c.dataset.fw = fw; c.dataset.fh = fh;
          g.fillStyle = '#000'; g.fillRect(0, 0, cw, ch);
          g.imageSmoothingQuality = 'high';
        }
        const k = Math.min(cw / fw, ch / fh), w = Math.round(fw * k), h = Math.round(fh * k);
        g.drawImage(f, Math.round((cw - w) / 2), Math.round((ch - h) / 2), w, h);
      } finally { f.close(); }
    } catch { /* a frame that couldn't be drawn: the next one will be */ } finally { tex.release(); }
  });
}
