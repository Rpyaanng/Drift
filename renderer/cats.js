// The cats (Summon the cats), drawn once, then only moved.
//
// The drawing is the SVG in index.html (#coCat). It's never shown: each piece of it (the glow, the tail, the body, the eyes,
// and asleep the whole cat and each "z") is drawn once into a small bitmap, gradients, mask, blur and glow baked in, and
// the cats are stacks of <img>s that CSS only moves and fades (style.css). Drawn live, every awake cat had every window
// draw it again 60 times a second, all in Chromium's one GPU process, and with many cats that left no room for a 60 fps
// video in Surf (docs/plans/cats.md).
//
// The bitmaps are drawn again when what they depend on changes: the theme's accent (their colours are mixed from it), the
// window's devicePixelRatio, or the cat's size (--cat-w follows the window's width).
(() => {
  const VB = { x: 150, y: 90, w: 1360, h: 820 };       // the drawing's viewBox
  const PAD = 56;          // CSS px of room around the cat for its glow (its wider blur fades out ~48 px out; the old clip-path left 60)
  const HEAD = 1.1;        // drawn a little larger than shown, so it stays sharp at the top of a breath
  const CUT = .063;        // the paws end 6.3% above the drawing's bottom: nothing below is shown
  // the glow around the whole cat (it was a CSS drop-shadow on it): two blurs, in CSS px, awake and asleep. Their colours are
  // --cat-glow1 and --cat-glow2 in style.css
  const GLOW = { awake: [2, 8], asleep: [2, 6] };
  const COLOURS = ['base', 'mid', 'hi', 'rim', 'lo', 'shade', 'deep', 'dark', 'glow1', 'glow2', 'z'];
  // the layers, back to front. Awake, the glows sit behind everything (as the drop-shadow did), each moving with its piece
  const AWAKE = ['haloBang', 'haloTail', 'haloBody', 'bang', 'tail', 'body', 'eyes'];
  const ASLEEP = ['sleep', 'z1', 'z2', 'z3'];
  const POLL = 250, GAP = 1500;       // how often to look for a change, and the least time between two drawings (a cycling palette changes all the time)

  let tpl = null, pivots = null, drawnKey = '', lastDraw = 0, busy = false;
  const urls = {}, probes = {};

  const probe = (cls) => {
    const d = document.createElement('div'); d.className = cls;
    d.style.cssText = 'position:fixed;left:-9999px;top:0;height:1px;width:var(--cat-w);visibility:hidden;pointer-events:none';
    document.body.append(d); return d;
  };
  const colour = (el, v) => { el.style.color = v; return getComputedStyle(el).color; };
  const keyNow = () => [colour(probes.awake, 'var(--accent)'), devicePixelRatio || 1, probes.awake.getBoundingClientRect().width].join('|');

  // the template, cut down to some of its pieces: keepOnly keeps those (with their parents, for their fill and filter, and
  // the <defs>); drop removes some
  const keepOnly = (svg, sel) => {
    const keep = [...svg.querySelectorAll(sel)];
    const walk = (el) => {
      for (const ch of [...el.children]) {
        if (ch.tagName === 'defs' || keep.includes(ch)) continue;
        if (keep.some((k) => ch.contains(k))) walk(ch); else ch.remove();
      }
    };
    walk(svg); return svg;
  };
  const drop = (svg, sel) => { svg.querySelectorAll(sel).forEach((e) => e.remove()); return svg; };
  const set = (svg, sel, attrs) => { svg.querySelectorAll(sel).forEach((e) => { for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, v); }); return svg; };
  const PIECES = {
    bang: (s) => keepOnly(s, '.catBang'),
    tail: (s) => keepOnly(s, '.catTail'),
    body: (s) => drop(s, '.catBang, .catTail, .catEyes, .catShut, .catZ'),
    eyes: (s) => keepOnly(s, '.catEyes'),
    // asleep it's a ghost: its fur faded right down as one piece (so no overlaps show through), the face clearer, eyes shut
    // (the face drawn light, as the ink mouth would be lost on a video)
    sleep: (s) => set(set(set(drop(s, '.catBang, .catEyes, .catZ'), '.catFur', { opacity: .22 }), '.catFace', { opacity: .6 }), '.catShut, .catMouth', { stroke: '#b8c2b8' }),
    z: (n, z) => (s) => set(keepOnly(s, `.catZ > path:nth-child(${n})`), '.catZ', { stroke: z }),
  };

  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  async function render(piece, g, col) {
    const svg = piece(tpl.cloneNode(true));
    svg.removeAttribute('id'); svg.removeAttribute('aria-hidden'); svg.removeAttribute('style');
    svg.setAttribute('viewBox', `${g.x0} ${g.y0} ${g.vw} ${g.vh}`); svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('width', g.cw); svg.setAttribute('height', g.chFull);
    // a stand-alone SVG image can't see CSS variables: each is swapped for its colour
    const text = new XMLSerializer().serializeToString(svg).replace(/var\(--cat-(\w+)\)/g, (m, n) => col[n] || m);
    const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    await img.decode();
    const c = canvas(g.cw, g.chFull); c.getContext('2d').drawImage(img, 0, 0, g.cw, g.chFull); return c;
  }
  // just the glow around a piece (none of the piece): drop-shadow(r1 glow1) then drop-shadow(r2 glow2), as CSS did it (the
  // second blurs the piece with the first glow). The piece is drawn far off the canvas, and only its shadow lands on it
  const OFF = 20000;
  const shadowOnly = (dst, src, color, blur) => {
    const x = dst.getContext('2d'); x.save(); x.shadowColor = color; x.shadowBlur = blur; x.shadowOffsetX = OFF; x.drawImage(src, -OFF, 0); x.restore();
  };
  function halo(c, col, radii, k) {
    // (Chromium blurs a CSS drop-shadow with its length as the standard deviation; a canvas shadowBlur is twice that)
    const [r1, r2] = radii.map((r) => 2 * r * k);
    const lit = canvas(c.width, c.height), lx = lit.getContext('2d');
    lx.shadowColor = col.glow1; lx.shadowBlur = r1; lx.drawImage(c, 0, 0);       // the piece with its first glow
    const out = canvas(c.width, c.height);
    shadowOnly(out, lit, col.glow2, r2); shadowOnly(out, c, col.glow1, r1);
    return out;
  }
  const finish = (c, g) => { const o = canvas(g.cw, g.ch); o.getContext('2d').drawImage(c, 0, 0); return o.toDataURL('image/png'); };       // cut at the paw line

  // the size and colours to draw at now
  function geometry() {
    const key = keyNow(), W = probes.awake.getBoundingClientRect().width || 33, k = (devicePixelRatio || 1) * HEAD;
    const u = VB.w / W, H = W * VB.h / VB.w, bw = W + 2 * PAD, bh = H * (1 - CUT) + PAD;
    // the canvas covers the cat and PAD around it, to the paw line; drawn PAD further down, so what's below the line still
    // casts its glow up, as it did before it was cut off
    const cw = Math.ceil(bw * k), ch = Math.ceil(bh * k), chFull = Math.ceil((bh + PAD) * k);
    const g = { cw, ch, chFull, x0: VB.x - PAD * u, y0: VB.y - PAD * u, vw: cw / k * u, vh: chFull / k * u };
    const cols = {};
    for (const s of ['awake', 'asleep']) cols[s] = Object.fromEntries(COLOURS.map((n) => [n, colour(probes[s], `var(--cat-${n})`)]));
    return { key, k, u, g, cols };
  }

  async function draw() {
    busy = true;
    try {
      const { key, k, u, g, cols } = geometry(), { cw, ch } = g;
      const out = {}, a = cols.awake, z = cols.asleep;
      for (const p of ['bang', 'tail', 'body']) {
        const c = await render(PIECES[p], g, a);
        out[p] = finish(c, g); out['halo' + p[0].toUpperCase() + p.slice(1)] = finish(halo(c, a, GLOW.awake, k), g);
      }
      out.eyes = finish(await render(PIECES.eyes, g, a), g);
      // asleep nothing moves, so the glow is baked into each picture
      const still = async (piece) => { const c = await render(piece, g, z), o = halo(c, z, GLOW.asleep, k); o.getContext('2d').drawImage(c, 0, 0); return finish(o, g); };
      out.sleep = await still(PIECES.sleep);
      for (let n = 1; n <= 3; n++) out['z' + n] = await still(PIECES.z(n, z.z));
      Object.assign(urls, out);
      // where the images sit, and the pivots, in CSS px of the image (the tail and eyes turn about the same points as before)
      const st = document.documentElement.style, at = (x, y) => `${((x - g.x0) / u).toFixed(2)}px ${((y - g.y0) / u).toFixed(2)}px`;
      st.setProperty('--cat-pad', PAD + 'px'); st.setProperty('--cat-iw', (cw / k).toFixed(2) + 'px'); st.setProperty('--cat-ih', (ch / k).toFixed(2) + 'px');
      st.setProperty('--cat-tail-o', at(...pivots.tail)); st.setProperty('--cat-eyes-o', at(...pivots.eyes));
      document.querySelectorAll('.coCat img[data-l]').forEach((i) => { i.src = urls[i.dataset.l]; });
      drawnKey = key; lastDraw = performance.now();
    } catch (e) { console.warn('cats: drawing failed', e); lastDraw = performance.now(); }
    busy = false;
  }

  function tick() {
    if (busy || performance.now() - lastDraw < GAP) return;
    if (drawnKey && !document.querySelector('.coCat.here')) return;       // none showing: draw when one is
    if (keyNow() !== drawnKey) draw();
  }

  window.Cats = {
    // tpl: the drawing (#coCat), already taken out of the page
    start(t) {
      tpl = t;
      probes.awake = probe('catPaint'); probes.asleep = probe('catPaint asleep');
      // the pivots, from the drawing's own boxes (what transform-box: fill-box used): the tail at 13% / 91% of its box, the
      // eyes about their middle. getBBox needs it laid out, so it's put in the page, hidden, for a moment
      const hold = document.createElement('div');
      hold.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px;height:120px;visibility:hidden;pointer-events:none';
      const s = tpl.cloneNode(true); s.removeAttribute('id'); s.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
      s.style.cssText = 'width:200px;height:120px'; hold.append(s); document.body.append(hold);
      const tb = s.querySelector('.catTail').getBBox(), eb = s.querySelector('.catEyes').getBBox();
      hold.remove();
      pivots = { tail: [tb.x + tb.width * .13, tb.y + tb.height * .91], eyes: [eb.x + eb.width / 2, eb.y + eb.height / 2] };
      draw(); setInterval(tick, POLL);
    },
    // one cat: a box the size of the drawing, holding the layers (clipped at the paw line)
    make() {
      const c = document.createElement('div'), clip = document.createElement('div');
      c.className = 'coCat'; clip.className = 'catClip'; c.append(clip);
      for (const l of [...AWAKE, ...ASLEEP]) {
        const i = document.createElement('img');
        i.alt = ''; i.draggable = false; i.dataset.l = l; i.className = `cl-${l} ${AWAKE.includes(l) ? 'catAwake' : 'catAsleep'}`;
        if (urls[l]) i.src = urls[l];
        clip.append(i);
      }
      return c;
    },
    // for the test (DRIFT_TESTCATS): the whole cat awake at rest drawn as one piece, its glow by CSS's own drop-shadow, the way
    // it was shown before, to hold the stacked layers up against
    async reference() {
      const { k, g, cols: { awake: a } } = geometry(), c = await render((s) => drop(s, '.catShut, .catZ'), g, a);
      const o = canvas(g.cw, g.chFull), x = o.getContext('2d');
      x.filter = `drop-shadow(0 0 ${GLOW.awake[0] * k}px ${a.glow1}) drop-shadow(0 0 ${GLOW.awake[1] * k}px ${a.glow2})`; x.drawImage(c, 0, 0);
      return finish(o, g);
    },
  };
})();
