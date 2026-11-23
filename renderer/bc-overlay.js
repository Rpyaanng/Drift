/* Drift — viewers' pointers over the broadcaster's real screen (docs/plans/broadcast.md §9.2). main.js keeps this
   window over what's being shown, click-through and out of the capture; this only draws. Names arrive as text and are
   set as text. A pointer that hasn't moved for 6 s fades away. */
(() => {
  const els = new Map();       // member id -> { el, x, y, at }
  // a person's colour comes from their name, as everywhere else in Drift (renderer/app.js ptrColor)
  const color = (name) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 90% 62%)`; };
  const NS = 'http://www.w3.org/2000/svg';
  function arrow() {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '24');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M3.2 4Q3.2 2.4 4.5 3.4L16.6 13.2Q17.8 14.3 16.2 14.6L10.8 15.2Q9.6 15.3 8.8 16.2L5.2 20.4Q3.2 22.4 3.2 19.8Z');
    svg.append(p);
    return svg;
  }
  const W = () => window.innerWidth, H = () => window.innerHeight;
  window.bcOverlay.on((m) => {
    const list = Array.isArray(m.list) ? m.list : [], now = Date.now();
    for (const [id, q] of els) if (!list.some((x) => x.id === id)) { q.el.remove(); els.delete(id); }
    for (const x of list) {
      let q = els.get(x.id);
      if (!q) {
        const el = document.createElement('div'); el.className = 'ptr';
        const b = document.createElement('b');
        el.append(arrow(), b);
        document.body.append(el);
        els.set(x.id, q = { el, x: -1, y: -1, at: now });
      }
      q.el.style.setProperty('--c', color(x.name));
      q.el.lastChild.textContent = String(x.name || '');
      if (q.x !== x.x || q.y !== x.y) { q.x = x.x; q.y = x.y; q.at = now; }
      q.el.style.transform = `translate(${(x.x * W()).toFixed(1)}px, ${(x.y * H()).toFixed(1)}px)`;
      q.el.classList.toggle('idle', now - q.at > 6000);       // only its own movement wakes it, not someone else's
    }
    if (m.ping) {       // "look here": a ripple, only a picture
      const r = document.createElement('div'); r.className = 'ping';
      r.style.setProperty('--c', color(m.ping.name));
      r.style.left = (m.ping.x * W()).toFixed(1) + 'px'; r.style.top = (m.ping.y * H()).toFixed(1) + 'px';
      document.body.append(r);
      setTimeout(() => r.remove(), 1200);
    }
  });
  setInterval(() => { for (const q of els.values()) q.el.classList.toggle('idle', Date.now() - q.at > 6000); }, 1000);
})();
