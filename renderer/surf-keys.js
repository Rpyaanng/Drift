// Drift — the Surf browser's keyboard shortcuts: the ones every browser has. One table for both places a key can be pressed:
// web.js, for keys pressed in a page itself, and renderer/app.js, for keys pressed over a picture of a page (drawn offscreen,
// mirrored, or a friend's) and in the Surf bar's address box.
// surfKey(key, mods): what the key does, as one of the browser's actions ({ do, n }: see act() in web.js), or null when it is
// just a key for the page. `key` is a KeyboardEvent's key; `mods` lists any of 'shift', 'control', 'alt', 'meta'.
(function (root) {
  function surfKey(key, mods) {
    const k = String(key || ''), m = Array.isArray(mods) ? mods : [];
    const ctrl = m.includes('control') || m.includes('meta'), shift = m.includes('shift'), alt = m.includes('alt');
    const l = k.length === 1 ? k.toLowerCase() : k;
    if (alt && !ctrl) {       // (Ctrl+Alt is AltGr on many keyboards: those keys type characters)
      if (l === 'ArrowLeft') return { do: 'back' };
      if (l === 'ArrowRight') return { do: 'fwd' };
      if (l === 'Home') return { do: 'home' };
      if (l === 'd') return { do: 'url' };
      return null;
    }
    if (ctrl && !alt) {
      if (l === 't') return { do: shift ? 'reopen' : 'new' };
      if ((l === 'w' || l === 'F4') && !shift) return { do: 'close' };
      if (l === 'Tab') return { do: 'step', n: shift ? -1 : 1 };
      if ((l === 'PageDown' || l === 'PageUp') && !shift) return { do: 'step', n: l === 'PageDown' ? 1 : -1 };
      if (/^[1-9]$/.test(l) && !shift) return { do: 'nth', n: +l };       // 9 is always the last tab
      if (l === 'r') return { do: shift ? 'hard' : 'reload' };
      if (l === 'F5') return { do: 'hard' };
      if (l === 'l') return { do: 'url' };
      if (l === '=' || l === '+') return { do: 'zoom', n: 1 };
      if (l === '-' || l === '_') return { do: 'zoom', n: -1 };
      if (l === '0' && !shift) return { do: 'zoom', n: 0 };
      return null;
    }
    if (!ctrl && !alt) {
      if (l === 'F5') return { do: shift ? 'hard' : 'reload' };
      if (l === 'F6') return { do: 'url' };
    }
    return null;
  }
  if (typeof module === 'object' && module.exports) module.exports = surfKey; else root.surfKey = surfKey;
})(this);
