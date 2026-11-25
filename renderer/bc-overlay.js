/* Drift — viewers' pointers, and the hub's chat, over the broadcaster's real screen (docs/plans/broadcast.md §9.2). main.js keeps this
   window over what's being shown, click-through and out of the capture; this only draws. Names arrive as text and are
   set as text. A pointer that hasn't moved for 6 s fades away. */
(() => {
  const els = new Map();       // member id -> { el, x, y, at }
  // a person's colour comes from their name, as everywhere else in Drift (renderer/app.js ptrColor)
  let accent = '';       // Drift's accent, as main last sent it: colours follow the palette (cursors.js driftPtrColor)
  const color = (name) => window.driftPtrColor(name, accent);
  const NS = 'http://www.w3.org/2000/svg';
  let grads = 0;
  function arrow(el) {       // the arrow, lit from above in the person's colours (as app.js ptrShape)
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '24');
    const id = 'g' + (++grads), defs = document.createElementNS(NS, 'defs'), g = document.createElementNS(NS, 'linearGradient');
    g.setAttribute('id', id); g.setAttribute('x1', '0'); g.setAttribute('y1', '0'); g.setAttribute('x2', '.35'); g.setAttribute('y2', '1');
    for (const [o, v] of [['0', '--c-hi'], ['.55', '--c'], ['1', '--c-lo']]) { const s = document.createElementNS(NS, 'stop'); s.setAttribute('offset', o); s.setAttribute('style', `stop-color:var(${v})`); g.append(s); }
    defs.append(g);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M3.2 4Q3.2 2.4 4.5 3.4L16.6 13.2Q17.8 14.3 16.2 14.6L10.8 15.2Q9.6 15.3 8.8 16.2L5.2 20.4Q3.2 22.4 3.2 19.8Z');
    svg.append(defs, p);
    el.style.setProperty('--fill', `url(#${id})`);
    return svg;
  }
  const W = () => window.innerWidth, H = () => window.innerHeight;
  window.bcOverlay.on((m) => {
    const list = Array.isArray(m.list) ? m.list : [], now = Date.now();
    if (/^#[0-9a-f]{6}$/i.test(String(m.accent || ''))) accent = m.accent;
    for (const [id, q] of els) if (!list.some((x) => x.id === id)) { q.el.remove(); els.delete(id); }
    for (const x of list) {
      let q = els.get(x.id);
      if (!q) {
        const el = document.createElement('div'); el.className = 'ptr';
        const b = document.createElement('b');
        el.append(arrow(el), b);
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
  // Chat from the hub you're broadcasting into, down in the corner as over the video (renderer/chat.js overlayShow). main.js
  // picks which and drops each after a while; everything is set as text.
  const box = document.createElement('div'); box.id = 'msgs'; document.body.append(box);
  const rows = new Map();       // message id -> row
  // A message's picture or GIF: a box the size it will be (at most 240 × 160) straight away, filled once main.js has sent
  // the picture (a data: URL of a GIF, PNG, JPEG or WebP, checked again here).
  const pics = new Map(), PIC_OK = /^data:image\/(gif|png|jpeg|webp);base64,/;
  function picBox(p) {
    const s = Math.min(1, 240 / p.w, 160 / p.h), el = document.createElement('div');
    el.className = 'pic' + (p.gif ? ' gif' : ''); el.dataset.f = p.id;
    el.style.width = Math.max(40, Math.round(p.w * s)) + 'px'; el.style.height = Math.max(40, Math.round(p.h * s)) + 'px';
    return el;
  }
  function fillPics() {
    for (const el of document.querySelectorAll('.pic:not(.got)')) {
      const d = pics.get(el.dataset.f);
      if (!d) continue;
      const img = document.createElement('img'); img.src = d; img.alt = '';
      el.append(img); el.classList.add('got');
    }
  }
  function drawMsgs(msgs) {
    for (const [id, r] of rows) if (!msgs.some((x) => x.id === id)) { r.remove(); rows.delete(id); }
    for (const x of msgs) {
      let r = rows.get(x.id);
      if (!r) {
        r = document.createElement('div'); r.className = 'msg';
        const face = document.createElement('span'); face.className = 'face';
        face.style.setProperty('--hue', [...String(x.from)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7));
        face.textContent = (String(x.name).trim()[0] || '?').toUpperCase();
        const body = document.createElement('div'); body.className = 'body';
        const b = document.createElement('b'); b.textContent = x.name;
        body.append(b);
        if (x.ch) { const em = document.createElement('em'); em.textContent = '#' + x.ch; body.append(em); }
        if (x.text) body.append(document.createTextNode(x.text));
        if (x.pic && typeof x.pic.id === 'string') body.append(picBox({ id: x.pic.id, w: +x.pic.w || 1, h: +x.pic.h || 1, gif: !!x.pic.gif }));
        r.append(face, body); box.append(r); rows.set(x.id, r);
      }
      r.classList.toggle('old', !!x.old);
    }
    for (const id of [...pics.keys()]) if (!msgs.some((x) => x.pic && x.pic.id === id)) pics.delete(id);
  }
  window.bcOverlay.on((m) => {
    for (const [id, d] of Object.entries(m.pics && typeof m.pics === 'object' ? m.pics : {})) if (typeof d === 'string' && PIC_OK.test(d)) pics.set(id, d);
    drawMsgs(Array.isArray(m.msgs) ? m.msgs : []);
    fillPics();
  });
  window.bcOverlayTest = () => [...document.querySelectorAll('#msgs .msg')].map((r) => ({ text: r.querySelector('.body').innerText, pic: (() => { const p = r.querySelector('.pic'); return p && { w: p.style.width, h: p.style.height, img: !!p.querySelector('img'), gif: p.classList.contains('gif') }; })() }));       // (tests)
  setInterval(() => { for (const q of els.values()) q.el.classList.toggle('idle', Date.now() - q.at > 6000); }, 1000);
})();
