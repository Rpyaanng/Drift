// Drift — in every page and frame of the PC's own Surf (registered by web.js): says when a video in it is playing, and when its
// frames come late. Every Drift window draws through Chromium's one GPU process, a page's video included, so a busy screen on
// another monitor can keep it waiting for its frames. While one plays the cats nap (app.js tickOverlays), and while its frames
// come late the other screens' scenes draw fewer frames a second (main.js sceneFps), as for a video of Drift's own (app.js onVideoFrame). Late is a frame skipped or shown late, or none at all for two seconds while there's
// plenty downloaded to show (the video starved outright: then there are no frames to find late).
// It runs in the frame's isolated world, so the page's own scripts can't see or change it.
(() => {
  const { ipcRenderer } = require('electron');
  const seen = new WeakSet(), vids = new Set();       // { ref: a WeakRef to one of the page's videos, n: its frames shown since the last look }
  let late = 0, cleanAt = performance.now();
  function watch(v) {
    if (seen.has(v) || typeof v.requestVideoFrameCallback !== 'function') return;
    const rec = { ref: new WeakRef(v), n: 0 };
    seen.add(v); vids.add(rec);
    let prev = null, dur = 1;
    for (const ev of ['pause', 'play', 'seeking', 'seeked', 'emptied', 'ratechange']) v.addEventListener(ev, () => { prev = null; });
    const on = (now, md) => {
      v.requestVideoFrameCallback(on);
      rec.n++;
      if (!prev) { prev = { t: now, m: md.mediaTime }; return; }
      const media = md.mediaTime - prev.m, wall = (now - prev.t) / 1000;
      prev = { t: now, m: md.mediaTime };
      if (!(media > 0) || media > 0.5 || wall > 1) return;         // a jump, a loop or a stall that isn't the GPU's doing
      dur = Math.min(dur * 1.01, media);                           // about one frame of this video
      if (media > dur * 1.6 || wall * (v.playbackRate || 1) > media * 1.8 + 0.02) late++;
    };
    v.requestVideoFrameCallback(on);
  }
  const ahead = (v) => { for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.2 && v.buffered.end(i) >= v.currentTime) return v.buffered.end(i) - v.currentTime; return 0; };
  setInterval(() => {
    for (const v of document.querySelectorAll('video')) watch(v);
    let playing = false;
    for (const rec of vids) {
      const v = rec.ref.deref();
      if (!v || !v.isConnected) { vids.delete(rec); continue; }
      const frames = rec.n; rec.n = 0;
      if (v.paused || v.ended || !v.videoWidth || !v.getClientRects().length) continue;       // (a sound on its own, or not on the page)
      playing = true;
      if (!frames && ahead(v) > 1) late += 3;       // meant to be playing, plenty downloaded, and not a frame shown
    }
    if (!playing) { late = 0; cleanAt = performance.now(); return; }
    const now = performance.now(), n = late; late = 0;
    let more;
    if (n >= 3) { more = true; cleanAt = now; } else if (n) cleanAt = now;
    else if (now - cleanAt > 10000) { more = false; cleanAt = now; }       // smooth for a while: the others can try more
    try { ipcRenderer.send('surf-video', { playing: true, more }); } catch { /* the page is on its way out */ }
  }, 2000);
})();
