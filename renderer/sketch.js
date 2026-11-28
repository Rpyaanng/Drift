/* Drift — the Sketch & Guess scene (docs/plans/games-room.md §2.3): a drawing board for a hub, laid out like a diagram
   editor. Tools down the left (pen, paint bucket, eraser, undo, clear), the format bar along the top (colour, width), the sheet in the middle on a light grid, and the players and their guesses on the
   right. It only draws: the rules are in sketch.js, on the hub; what it gets is the game as you see it (view) and the
   drawing as it grows (ink). Your moves go back through send({ op, ... }), which app.js passes on.
     const t = window.driftSketch(holder, send, { face, me })   t.view(v, mode)   t.ink({ rev, from, list })   t.note(text)   t.colors(...)   t.box()
   The sheet is 1600 x 1000 units whatever its size on screen. Names and guesses come from other people, so everything they
   type is put in with textContent, never as markup. */
(() => {
  const SW = 1600, SH = 1000;
  const COLORS = ['#1f1f1f', '#6b6b6b', '#b0b0b0', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#7cb342', '#2e7d32', '#00897b', '#29b6f6', '#1e63d6', '#8e24aa', '#ec407a', '#8d6e63'];
  const WIDTHS = [4, 9, 18], ERASE = [18, 40, 80];
  const ICON = {       // (fixed markup: the tools' pictures)
    pen: '<path d="M4 20l1.2-4.6L15.6 5a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8z"/><path d="M13.5 7l3.5 3.5"/>',
    fill: '<path d="M4.6 11.4L11 5l7 7-6.4 6.4a2 2 0 0 1-2.8 0l-4.2-4.2a2 2 0 0 1 0-2.8z"/><path d="M4 12.5h14"/><path d="M8.5 7.5L6 5"/><path d="M20.5 15.5s1.6 2 1.6 3a1.6 1.6 0 0 1-3.2 0c0-1 1.6-3 1.6-3z"/>',
    eraser: '<path d="M8.5 19.5L3.8 14.8a1.8 1.8 0 0 1 0-2.6l8.4-8.4a1.8 1.8 0 0 1 2.6 0l5.4 5.4a1.8 1.8 0 0 1 0 2.6l-8.1 8.1z"/><path d="M8.5 19.5H20M7.5 8.5l8 8"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    clear: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
    pencil: '<path d="M4 20l1-5L16 4l4 4L9 19z"/>',
    minus: '<path d="M6 12h12"/>',
    plus: '<path d="M6 12h12M12 6v12"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  };
  const TOOLS = [['pen', 'Pen', 'P'], ['fill', 'Paint bucket', 'B'], ['eraser', 'Eraser', 'E']];
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  // a winner's crown: gold, three points with a jewel on each, a band across the bottom
  const CROWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8.5l4.2 3.6L12 5l4.8 7.1L21 8.5l-1.8 9.5H4.8z" fill="#f7c948" stroke="#a8690a" stroke-width="1.2" stroke-linejoin="round"/><rect x="4.6" y="17.2" width="14.8" height="2.6" rx=".8" fill="#e0a526" stroke="#a8690a" stroke-width="1"/><circle cx="12" cy="4.6" r="1.5" fill="#ff6fb5"/><circle cx="3" cy="8.2" r="1.3" fill="#6fd3ff"/><circle cx="21" cy="8.2" r="1.3" fill="#6fd3ff"/></svg>';
  const svg = (name, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
  const btn = (cls, title, html, fn) => { const b = el('button', cls); b.type = 'button'; b.title = title; b.innerHTML = html; b.onclick = fn; return b; };

  // ---------- the paint bucket: flood the area round a point with a colour ----------
  // Colours are compared as they look on the (light) paper, so blank sheet and white ink are one area, and a pen line's soft
  // edge stops the flood; the fill then grows a pixel or two under that edge so no pale ring is left between it and the line.
  function flood(ctx, sx, sy, col) {
    const W = ctx.canvas.width, H = ctx.canvas.height; if (!W || !H) return;
    sx = Math.max(0, Math.min(W - 1, Math.floor(sx))); sy = Math.max(0, Math.min(H - 1, Math.floor(sy)));
    const img = ctx.getImageData(0, 0, W, H), d = img.data, n = W * H;
    const pr = new Uint8Array(n), pg = new Uint8Array(n), pb = new Uint8Array(n);       // each pixel as it looks on the paper
    for (let i = 0, j = 0; i < n; i++, j += 4) { const a = d[j + 3] / 255, w = 255 * (1 - a); pr[i] = d[j] * a + w; pg[i] = d[j + 1] * a + w; pb[i] = d[j + 2] * a + w; }
    const fr = parseInt(col.slice(1, 3), 16), fg = parseInt(col.slice(3, 5), 16), fb = parseInt(col.slice(5, 7), 16);
    const s0 = sy * W + sx, tr = pr[s0], tg = pg[s0], tb = pb[s0], TOL = 90;
    if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 6 && d[s0 * 4 + 3] === 255) return;       // (already that colour)
    const like = (i) => Math.abs(pr[i] - tr) + Math.abs(pg[i] - tg) + Math.abs(pb[i] - tb) <= TOL;
    const mask = new Uint8Array(n), stack = [sx, sy];
    while (stack.length) {       // scanlines: a run left and right, then the rows above and below it
      const y = stack.pop(), x = stack.pop(), row = y * W;
      if (mask[row + x]) continue;
      let l = x, r = x;
      while (l > 0 && !mask[row + l - 1] && like(row + l - 1)) l--;
      while (r < W - 1 && !mask[row + r + 1] && like(row + r + 1)) r++;
      for (let i = l; i <= r; i++) mask[row + i] = 1;
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= H) continue;
        let run = false; const nrow = ny * W;
        for (let i = l; i <= r; i++) { if (!mask[nrow + i] && like(nrow + i)) { if (!run) { stack.push(i, ny); run = true; } } else run = false; }
      }
    }
    {       // a pixel further, under the lines' soft edges
      const was = mask.slice();
      for (let y = 0; y < H; y++) for (let x = 0, i = y * W; x < W; x++, i++) {
        if (was[i]) continue;
        if ((x > 0 && was[i - 1]) || (x < W - 1 && was[i + 1]) || (y > 0 && was[i - W]) || (y < H - 1 && was[i + W])) mask[i] = 1;
      }
    }
    for (let i = 0, j = 0; i < n; i++, j += 4) if (mask[i]) { d[j] = fr; d[j + 1] = fg; d[j + 2] = fb; d[j + 3] = 255; }
    ctx.putImageData(img, 0, 0);
  }

  // ---------- drawing one operation (also used for the preview while you drag) ----------
  function drawOp(ctx, op, k, from, preview) {       // k: screen pixels per sheet unit; from: where this stroke's last piece ended
    ctx.save();
    const col = COLORS[op.c] || COLORS[0];
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (op.k === 'fill') { if (!preview) flood(ctx, op.p[0] * k, op.p[1] * k, col); }
    else if (op.k === 'pen') {
      const w = (op.e ? ERASE : WIDTHS)[op.w] * k;
      if (op.e) { if (preview) ctx.strokeStyle = ctx.fillStyle = '#ffffff'; else { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = ctx.fillStyle = '#000'; } }
      else ctx.strokeStyle = ctx.fillStyle = col;
      ctx.lineWidth = w;
      const p = from ? [from[0], from[1], ...op.p] : op.p;
      if (p.length === 2) { ctx.beginPath(); ctx.arc(p[0] * k, p[1] * k, w / 2, 0, Math.PI * 2); ctx.fill(); }
      else {
        ctx.beginPath(); ctx.moveTo(p[0] * k, p[1] * k);
        for (let i = 2; i < p.length - 2; i += 2) { const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2; ctx.quadraticCurveTo(p[i] * k, p[i + 1] * k, mx * k, my * k); }
        ctx.lineTo(p[p.length - 2] * k, p[p.length - 1] * k);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  // The drawing so far, as strokes and fills (undo takes the last one away, clear takes them all)
  function groupsOf(ops) {
    let gs = [];
    for (const op of ops) {
      if (op.k === 'undo') gs.pop();
      else if (op.k === 'clear') gs = [];
      else { const last = gs[gs.length - 1]; if (last && op.k === 'pen' && last.ops[0].k === 'pen' && last.s === op.s) last.ops.push(op); else gs.push({ s: op.s, ops: [op] }); }
    }
    return gs;
  }

  window.driftSketch = (holder, send, opts = {}) => {
    holder.innerHTML = '';
    const lampEl = el('div', 'bjLamp'), felt = el('div', 'skFelt'), bar = el('div', 'bjBar'), noteEl = el('div', 'bjNote'), boardEl = el('div', 'bjBoard');
    holder.append(lampEl, felt, bar, noteEl, boardEl);
    // the left: the tools
    const tools = el('div', 'skTools'), toolEls = {};
    for (const [id, name, key] of TOOLS) { const b = btn('skTool', `${name} (${key})`, svg(id), () => pick(id)); b.dataset.tool = id; toolEls[id] = b; tools.append(b); }
    tools.append(el('i', 'skSep'));
    const undoB = btn('skTool', 'Undo (Ctrl+Z)', svg('undo'), () => sendOp({ k: 'undo' }));
    const clearB = btn('skTool', 'Clear the sheet', svg('clear'), () => sendOp({ k: 'clear' }));
    const setB = btn('skTool skGear', 'Game settings: time, rounds, words', svg('gear'), () => (setEl.classList.contains('on') ? closeSettings() : openSettings()));
    setB.disabled = true;       // (until main.js sends the settings)
    tools.append(undoB, clearB, el('i', 'skGrow'), setB);
    // the top: the word (or its blanks), the format bar while you draw, the round and the clock
    const top = el('div', 'skTop'), roundEl = el('div', 'skRound'), wordEl = el('div', 'skWord'), fmt = el('div', 'skFormat'), clock = el('div', 'skClock');
    const swatches = COLORS.map((c, i) => { const b = btn('skSwatch', ['Black', 'Grey', 'Light grey', 'White', 'Red', 'Orange', 'Yellow', 'Lime', 'Green', 'Teal', 'Sky', 'Blue', 'Purple', 'Pink', 'Brown'][i], '', () => { color = i; tidy(); }); b.style.setProperty('--sw', c); return b; });
    const widthEls = WIDTHS.map((w, i) => { const b = btn('skWidth', ['Thin', 'Medium', 'Thick'][i] + ` (${i + 1})`, `<i style="--d:${[4, 7, 11][i]}px"></i>`, () => { width = i; tidy(); }); return b; });
    const grp = (cls, kids) => { const g = el('div', 'skGrp ' + cls); g.append(...kids); return g; };
    fmt.append(grp('skColors', swatches), el('i', 'skSep v'), grp('skWidths', widthEls));
    top.append(roundEl, wordEl, fmt, clock);
    // the middle: the sheet (what's drawn, and on top of it what you're drawing right now), and a card for between turns
    const paper = el('div', 'skPaper'), base = el('canvas', 'skBase'), live = el('canvas', 'skLive'), card = el('div', 'skCard'), setEl = el('div', 'skSet');
    paper.append(base, live, card, setEl);
    // the right: the players, and the guesses
    const side = el('div', 'skSide'), list = el('div', 'skPlayers'), feedEl = el('div', 'skFeed'), form = el('form', 'skGuess'), input = el('input', 'skInput');
    Object.assign(input, { type: 'search', maxLength: 60, autocomplete: 'off', spellcheck: false, placeholder: 'Type your guess…' });       // (search: Drift's own keys leave it alone)
    form.append(input);
    side.append(list, feedEl, form);
    felt.append(tools, top, paper, side);

    let v = null, mode = '', got = 0, noteTimer = 0, flashTimer = 0, tool = 'pen', color = 0, width = 1, colorOf = () => '#9fe3c8', selfColor = '#22c08a';
    let rev = -1, ops = [], pending = [], q = 0, sid = Math.floor(Math.random() * 1e8), stroke = null, flushT = 0, lastFeed = 0, shownOver = -1;
    const left = () => (v ? Math.max(0, v.msLeft - (Date.now() - got)) : 0);
    const me = () => (v && v.you >= 0 ? v.players[v.you] : null);
    const drawing = () => !!(v && v.phase === 'drawing' && v.you >= 0 && v.drawer === v.you);

    // ---------- the sheet ----------
    let k = 1;
    function size() {       // the canvases at the screen's own pixels
      const r = paper.getBoundingClientRect(); if (!r.width) return false;
      const dpr = window.devicePixelRatio || 1, w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
      if (base.width !== w || base.height !== h) { base.width = live.width = w; base.height = live.height = h; k = w / SW; return true; }
      k = w / SW; return false;
    }
    function redraw() {
      size();
      const c = base.getContext('2d'); c.clearRect(0, 0, base.width, base.height);
      for (const g of groupsOf(ops)) { let from = null; for (const op of g.ops) { drawOp(c, op, k, from); from = op.p.slice(-2); } }
      drawLive();
    }
    function drawLive() {       // what you're drawing, and what you've sent that hasn't come back yet
      const c = live.getContext('2d'); c.clearRect(0, 0, live.width, live.height);
      const all = [...pending];
      if (stroke && stroke.pts.length) all.push({ k: 'pen', c: stroke.c, w: stroke.w, e: stroke.e, s: stroke.s, p: stroke.pts });
      for (const op of all) {
        if (op.k !== 'pen') continue;       // (a fill shows when it comes back: it needs the drawing under it)
        if (stroke && op.s === stroke.s && op !== all[all.length - 1]) continue;       // (the stroke being drawn is drawn whole, below)
        drawOp(c, op, k, null, true);
      }
    }
    new ResizeObserver(() => { if (size()) redraw(); }).observe(paper);
    function sendOp(o) {
      if (!drawing()) return;
      const op = { ...o, q: ++q };
      if (op.k !== 'undo' && op.k !== 'clear') pending.push(op);
      send({ op: 'ink', o: op });
      drawLive();
    }
    const at = (e) => { const r = live.getBoundingClientRect(); return [Math.max(0, Math.min(SW, Math.round((e.clientX - r.left) / r.width * SW))), Math.max(0, Math.min(SH, Math.round((e.clientY - r.top) / r.height * SH)))]; };
    function flush() {       // a pen stroke goes out in pieces as it's drawn, so everyone watches it appear
      if (!stroke) return;
      while (stroke.pts.length > stroke.sent) {
        const piece = stroke.pts.slice(stroke.sent, stroke.sent + 120);
        stroke.sent += piece.length;
        sendOp({ k: 'pen', c: stroke.c, w: stroke.w, s: stroke.s, p: piece, ...(stroke.e ? { e: 1 } : {}) });
      }
    }
    live.addEventListener('pointerdown', (e) => {
      if (!drawing() || e.button !== 0) return;
      const p = at(e);
      if (tool === 'fill') { sendOp({ k: 'fill', c: color, s: ++sid, p }); return; }
      try { live.setPointerCapture(e.pointerId); } catch { /* (not a live pointer: a test's) */ }
      stroke = { s: ++sid, c: color, w: width, e: tool === 'eraser', pts: [...p], sent: 0 };
      clearInterval(flushT); flushT = setInterval(flush, 60);
      drawLive();
    });
    live.addEventListener('pointermove', (e) => {
      if (stroke) {
        for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) {
          const p = at(ev), n = stroke.pts.length;
          if (Math.hypot(p[0] - stroke.pts[n - 2], p[1] - stroke.pts[n - 1]) >= 2.5) stroke.pts.push(...p);
        }
        drawLive();
      }
    });
    const up = () => {
      if (stroke) { clearInterval(flushT); flush(); stroke = null; }
      drawLive();
    };
    live.addEventListener('pointerup', up); live.addEventListener('pointercancel', up);
    function pick(id) { tool = id; tidy(); }
    // keys while you draw (before Drift's own: P is the palette, H the panel, and so on, everywhere else)
    addEventListener('keydown', (e) => {
      if (!holder.classList.contains('on') || !drawing() || e.target === input || e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const key = e.key.toLowerCase();
      let used = true;
      if ((e.ctrlKey || e.metaKey) && key === 'z') sendOp({ k: 'undo' });
      else if (e.ctrlKey || e.metaKey || e.altKey) used = false;
      else if (TOOLS.some(([, , kk]) => kk.toLowerCase() === key)) pick(TOOLS.find(([, , kk]) => kk.toLowerCase() === key)[0]);
      else if (['1', '2', '3'].includes(key)) { width = +key - 1; tidy(); }
      else used = false;
      if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim(); if (!text) return;
      input.value = '';
      send({ op: 'move', m: { do: 'guess', text } });
    });

    // ---------- the settings (main.js keeps them: state.sketch): time to draw, rounds, the words ----------
    let cfg = null;       // { draw, rounds, words (null: Drift's), defaults, where }
    const lines = (s) => s.split(/[\r\n,]+/).map((w) => w.trim()).filter(Boolean);
    function openSettings() {
      if (!cfg) return;
      const nums = new Map();       // the input inside each stepper
      const num = (val, lo, hi, step) => {       // a number between − and + (hold one to keep going), typed in too
        const box = el('div', 'skStep'), i = el('input', 'skNum');
        Object.assign(i, { type: 'number', min: lo, max: hi, step, value: val, inputMode: 'numeric' });
        const fix = () => { const n = Math.round(+i.value); i.value = String(Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : val); };
        i.addEventListener('change', fix);
        const bump = (dir) => { fix(); i.value = String(Math.max(lo, Math.min(hi, +i.value + dir * step))); };
        const side = (dir, label) => {
          const b = btn('skStepB', label, svg(dir < 0 ? 'minus' : 'plus', 16), () => {});
          let rep = 0;
          const stop = () => { clearTimeout(rep); clearInterval(rep); rep = 0; };
          b.addEventListener('pointerdown', (e) => { if (e.button) return; e.preventDefault(); bump(dir); rep = setTimeout(() => { rep = setInterval(() => bump(dir), 70); }, 380); });
          for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, stop);
          b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bump(dir); } });
          return b;
        };
        box.append(side(-1, 'Less'), i, side(1, 'More'));
        nums.set(box, i);
        return box;
      };
      const row = (label, ...kids) => { const r = el('div', 'skSetRow'); r.append(el('span', 'lbl', label), ...kids); return r; };
      const drawBox = num(cfg.draw, 15, 600, 5), roundsBox = num(cfg.rounds, 1, 10, 1), drawIn = nums.get(drawBox), roundsIn = nums.get(roundsBox);
      const hintsIn = el('input', 'skCheck'); Object.assign(hintsIn, { type: 'checkbox', checked: cfg.hints !== false });
      const words = el('textarea', 'skWords'); Object.assign(words, { spellcheck: false, value: (cfg.words || cfg.defaults).join('\n') });
      const count = el('span', 'skCount'), own = el('span', 'skOwn');
      const recount = () => {
        const w = lines(words.value), same = w.join('\n') === cfg.defaults.join('\n');
        count.textContent = `${w.length} word${w.length === 1 ? '' : 's'}`;
        own.textContent = same ? 'Drift\'s words' : w.length < 3 ? 'Too few: Drift\'s words will be used' : 'Your own words';
        reset.disabled = same;
      };
      const reset = el('button', 'bjBtn ghost skReset', 'Reset to Drift\'s words'); reset.type = 'button';
      reset.onclick = () => { words.value = cfg.defaults.join('\n'); recount(); words.scrollTop = 0; };
      words.addEventListener('input', recount);
      const cancel = el('button', 'bjBtn ghost', 'Cancel'), save = el('button', 'bjBtn primary', 'Save');
      cancel.type = save.type = 'button';
      cancel.onclick = closeSettings;
      save.onclick = () => {
        const w = lines(words.value), same = w.join('\n') === cfg.defaults.join('\n');
        send({ op: 'settings', s: { draw: +drawIn.value, rounds: +roundsIn.value, hints: hintsIn.checked, words: same ? null : w } });
        closeSettings();
      };
      const wordsHead = el('div', 'skSetRow'); wordsHead.append(el('span', 'lbl', 'Words'), count, own, el('i', 'skGrow'), reset);
      const foot = el('div', 'skSetFoot'); foot.append(el('p', 'skWhere', cfg.where), el('i', 'skGrow'), cancel, save);
      setEl.replaceChildren(el('h3', '', 'Game settings'),
        row('Time to draw', drawBox, el('span', 'unit', 'seconds (15 to 600)')),
        row('Rounds', roundsBox, el('span', 'unit', 'everyone draws once a round')),
        (() => { const l = el('label', 'skSetRow skSwitch'); l.append(el('span', 'lbl', 'Hints'), hintsIn, el('i'), el('span', 'unit', 'show up to 3 letters as the time runs out (at 60%, 40% and 20% left)')); return l; })(),       // (a switch like Drift's settings; a label, so the words flip it too)
        wordsHead, words, el('p', 'skHint', 'One word or phrase per line. Things anyone can draw work best.'), foot);
      recount();
      setEl.classList.add('on'); setB.classList.add('on');
      drawIn.focus({ preventScroll: true });
    }
    function closeSettings() { setEl.classList.remove('on'); setB.classList.remove('on'); setEl.replaceChildren(); }
    setEl.addEventListener('keydown', (e) => {       // its keys are its own: typing a word mustn't open Drift's panel or change the scene
      if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
      e.stopPropagation();
    });
    setEl.addEventListener('pointerdown', (e) => e.stopPropagation());

    // ---------- the drawing coming in ----------
    function ink(m) {
      if (!m || !Array.isArray(m.list)) return;
      if (m.rev !== rev) { rev = m.rev; ops = []; pending = []; stroke = null; clearInterval(flushT); if (m.from) return; }
      if (m.from === 0) ops = [];
      else if (m.from !== ops.length) return;
      const was = groupsOf(ops).length, adds = m.list;
      ops.push(...adds);
      if (pending.length) { const back = new Set(adds.map((o) => o.q)); pending = pending.filter((p) => !back.has(p.q)); }
      if (m.from === 0 || !was || adds.some((o) => o.k === 'undo' || o.k === 'clear')) { redraw(); return; }
      size();       // just the new pieces, on top of what's there
      const c = base.getContext('2d'), gs = groupsOf(ops);
      for (const op of adds) {
        const g = gs.find((x) => x.ops.includes(op)), i = g ? g.ops.indexOf(op) : 0;
        drawOp(c, op, k, i > 0 ? g.ops[i - 1].p.slice(-2) : null);
      }
      drawLive();
    }

    // ---------- the game ----------
    function draw() {
      holder.classList.toggle('live', !!v || mode === 'alone');
      holder.classList.toggle('drawer', drawing());
      if (!v) { cardFor(); side.classList.add('off'); wordEl.replaceChildren(); roundEl.textContent = ''; clock.replaceChildren(); bar.replaceChildren(); tidy(); return; }
      side.classList.remove('off');
      roundEl.textContent = v.round ? `Round ${v.round} of ${v.rounds}` : 'Sketch & Guess';
      word();
      players();
      feed();
      board();
      cardFor();
      controls();
      tidy();
      tickClock();
      if (v.phase === 'over' && shownOver !== v.round) { shownOver = v.round; flash(); }
    }
    function word() {
      const kids = [];
      const spelled = (chars) => {       // the word on its lines, letter by letter (blanks for what you don't know yet), and its lengths
        const letters = el('div', 'skBlanks');
        for (const ch of chars) letters.append(ch === ' ' ? el('i', 'gap') : el('b', ch === null ? 'blank' : '', ch === null ? '' : ch));
        const lens = []; let n = 0;
        for (const ch of chars) { if (ch === ' ') { lens.push(n); n = 0; } else n++; }
        lens.push(n);
        kids.push(letters, el('span', 'len', `(${lens.join(' ')})`));
      };
      if (drawing()) spelled([...v.word]);
      else if (v.word && v.phase === 'drawing') { kids.push(el('span', 'lbl', 'You got it')); spelled([...v.word]); }
      else if (v.phase === 'drawing' || v.phase === 'reveal') spelled(v.hint);
      else if (v.phase === 'choosing') kids.push(el('span', 'lbl', v.drawer === v.you ? 'Pick a word to draw' : `${(v.players[v.drawer] || {}).name || 'Someone'} is picking a word`));
      wordEl.replaceChildren(...kids);
    }
    function players() {
      const ranked = v.players.map((p, i) => ({ ...p, i })).sort((a, b) => b.score - a.score);
      const rank = new Map(ranked.map((p, n) => [p.i, n + 1])), won = winners().ids;
      list.replaceChildren(el('div', 'skHead', `Players · ${v.players.length}`), ...v.players.map((p, i) => {
        const row = el('div', 'skP' + (i === v.you ? ' me' : '') + (p.drawing ? ' drawing' : '') + (p.guessed ? ' got' : ''));
        row.style.setProperty('--c', i === v.you ? selfColor : colorOf(p.name));
        const f = (mode === 'hub' && !p.blocked && opts.face ? opts.face(p.id) : null) || el('i', 'nf');
        row.append(el('b', 'rk', '#' + rank.get(i)), won.has(p.id) ? crowned(f) : f, el('span', 'nm', i === v.you ? 'You' : p.name));
        if (p.drawing) { const pen = el('span', 'pen'); pen.innerHTML = svg('pencil', 14); row.append(pen); }
        row.append(el('span', 'sc', String(p.score)), ...(p.gained ? [el('span', 'gain', '+' + p.gained)] : []));
        return row;
      }));
    }
    function feed() {
      const atBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 30;
      feedEl.replaceChildren(...v.feed.map((e) => {
        const row = el('div', 'skF k-' + e.kind);
        if (e.kind === 'guess' || e.kind === 'chat') row.append(el('b', '', (e.pid === (me() || {}).id ? 'You' : e.who) + ' '), document.createTextNode(e.text));
        else row.textContent = e.kind === 'right' && e.pid === (me() || {}).id ? 'You guessed it!' : e.text;
        if (e.to === 'solvers') row.classList.add('solvers');
        return row;
      }));
      const n = v.feed.length ? v.feed[v.feed.length - 1].n : 0;
      if (atBottom || n !== lastFeed) feedEl.scrollTop = feedEl.scrollHeight;
      lastFeed = n;
    }
    function board() {       // the hub's best scores in a game (hub.js gameBoard)
      const rows = mode === 'hub' && Array.isArray(v.records) ? v.records : null;
      boardEl.classList.toggle('on', !!rows);
      if (!rows) return;
      const mine = opts.me ? opts.me() : '';
      boardEl.replaceChildren(el('div', 'bjBHead', 'Best scores'), ...(rows.length ? rows.map((x, i) => {
        const row = el('div', 'bjBRow' + (x.id === mine ? ' me' : '') + (x.ago < 8000 ? ' fresh' : ''));
        const f = !x.blocked && opts.face ? opts.face(x.id) : null;
        row.append(el('b', 'rk', String(i + 1)), f || el('i', 'nf'), el('span', 'nm', x.id === mine ? 'You' : x.name), el('span', 'amt', String(x.win)));
        return row;
      }) : [el('div', 'bjBNone', 'None yet. Finish a game to get on the board.')]));
    }
    // The game's winners, crowned: the top score when it's over (ties all win), more than nothing. At a hub against someone
    // else (not the practice bots) each winner gets a scene token, the same rule main.js GM_TOKENS.sketch gives it by.
    function winners() {
      if (!v || v.phase !== 'over' || !Array.isArray(v.standings)) return { ids: new Set(), token: false };
      const top = Math.max(0, ...v.standings.map((s) => +s.score || 0));
      const ids = new Set(top > 0 ? v.standings.filter((s) => (+s.score || 0) === top).map((s) => s.id) : []);
      return { ids, token: ids.size > 0 && mode === 'hub' && v.standings.filter((s) => !/-bot$/.test(String(s.id))).length >= 2 };
    }
    const crown = () => { const c = el('i', 'skCrown'); c.innerHTML = CROWN; c.title = 'Winner'; return c; };
    // a player's picture (at a hub; else their initial on their colour), and with the crown sitting on it for a winner
    const faceOf = (p, mine) => (mode === 'hub' && p && !p.blocked && opts.face ? opts.face(p.id) : null) || (() => { const n = el('i', 'nf', String((p && p.name) || '?').trim().charAt(0).toUpperCase()); n.style.setProperty('--c', mine ? selfColor : colorOf((p && p.name) || '')); return n; })();
    const crowned = (pic) => { const w = el('span', 'skCrowned'); w.append(pic, crown()); return w; };
    // your scene tokens, in the bar: kept on your own Drift, not the game's (app.js passes them in: tokens())
    const tokEl = el('span', 'bjAmt bjTok ico-tok', '0 tokens');
    tokEl.title = 'Your scene tokens: spend them at Scene Slots to unlock a scene';
    function tokens(n) { const t = `${Number(n).toLocaleString('en-US')} token${n === 1 ? '' : 's'}`; if (tokEl.textContent !== t) tokEl.textContent = t; }
    function cardFor() {       // over the sheet between turns: waiting, picking a word, the word shown, the final scores
      const kids = [];
      if (!v && mode === 'alone') kids.push(el('h3', '', 'Sketch & Guess is for friends'), el('p', '', 'Go online in a hub (the Hub tab), and everyone there who opens Sketch & Guess plays together: one draws, the others guess.'));
      else if (!v) { /* (nothing yet) */ }
      else if (v.you < 0) kids.push(el('h3', '', v.watching >= 0 ? 'The game is full' : 'You\'re watching'), el('p', '', v.watching >= 0 ? `You're next to join${v.watching ? ` (${v.watching + 1} in line)` : ''}.` : 'Join in from the bar below.'));
      else if (v.phase === 'waiting') kids.push(el('h3', '', v.players.length >= 2 ? 'Starting…' : 'Waiting for players'), el('p', '', v.players.length >= 2 ? 'A new game is about to begin.' : 'It takes two or more. Tell your friends at the hub to open Sketch & Guess.'));
      else if (v.phase === 'choosing' && v.drawer === v.you) {
        kids.push(el('h3', '', 'Pick a word to draw'));
        const row = el('div', 'skChoices');
        v.choices.forEach((w, i) => { const b = el('button', 'bjBtn primary', w); b.type = 'button'; b.onclick = () => send({ op: 'move', m: { do: 'pick', key: String(i) } }); row.append(b); });
        kids.push(row, el('p', '', 'No letters or numbers in the drawing: just pictures.'));
      } else if (v.phase === 'choosing') kids.push(el('h3', '', `${(v.players[v.drawer] || {}).name || 'Someone'} is picking a word`), el('p', '', 'Get ready to guess.'));
      else if (v.phase === 'reveal') {
        kids.push(el('h3', '', v.word ? `The word was “${v.word}”` : 'Turn over'));
        const gains = v.players.filter((p) => p.gained).sort((a, b) => b.gained - a.gained);
        kids.push(gains.length ? (() => { const l = el('div', 'skGains'); for (const p of gains) l.append(el('span', '', `${p.id === (me() || {}).id ? 'You' : p.name} +${p.gained}`)); return l; })() : el('p', '', 'Nobody got it this time.'));
      } else if (v.phase === 'over' && v.standings) {
        const myId = (me() || {}).id, w = winners(), names = v.standings.filter((s) => w.ids.has(s.id)).map((s) => (s.id === myId ? 'You' : s.name || 'Someone'));
        const both = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
        const mine = w.ids.has(myId);
        if (w.ids.size) {       // the winners' pictures, crowned (up to four: a big tie just shows the first)
          const row = el('div', 'skWinners');
          for (const s of v.standings.filter((x) => w.ids.has(x.id)).slice(0, 4)) {
            const p = v.players.find((x) => x.id === s.id) || s, pic = crowned(faceOf(p, s.id === myId));
            pic.title = s.id === myId ? 'You' : s.name || ''; row.append(pic);
          }
          kids.push(row);
        }
        kids.push(el('h3', '', !w.ids.size ? 'Nobody scored' : mine && names.length === 1 ? 'You win!' : names.length > 1 ? `${both} tie for the win!` : `${both} wins!`));
        if (w.token) {
          const say = el('p', 'skTokWin');
          say.append(el('i', 'coin'), document.createTextNode(names.length > 1 ? `${both} each win a scene token!` : mine ? 'You win a scene token!' : `${both} wins a scene token!`));
          kids.push(say);
        }
        const l = el('ol', 'skStand');
        for (const s of v.standings.slice(0, 6)) { const li = el('li', (s.id === myId ? 'me' : '') + (w.ids.has(s.id) ? ' won' : '')); li.append(el('span', '', s.id === myId ? 'You' : s.name), ...(w.ids.has(s.id) ? [crown()] : []), el('b', '', String(s.score))); l.append(li); }
        kids.push(l, el('p', '', 'A new game starts in a moment.'));
      }
      card.replaceChildren(...kids);
      card.classList.toggle('on', kids.length > 0);
    }
    function controls() {
      const kids = [];
      const b = (label, cls, fn) => { const x = el('button', 'bjBtn' + (cls ? ' ' + cls : ''), label); x.type = 'button'; x.onclick = fn; return x; };
      let line = '';
      if (v.you < 0 && v.watching < 0) { line = 'You\'re watching.'; kids.push(b('Join in', 'primary', () => send({ op: 'sit' }))); }
      else if (v.you < 0) { line = 'The game is full: you\'re in line.'; kids.push(b('Leave the line', 'ghost', () => send({ op: 'stand' }))); }
      else {
        if (drawing()) line = 'Your turn: draw it! Pen (P), paint bucket (B), eraser (E); 1 to 3 for the width.';
        else if (v.phase === 'drawing') line = me().guessed ? 'You got it! Watch the others guess.' : `${(v.players[v.drawer] || {}).name || 'Someone'} is drawing: type your guesses on the right.`;
        kids.push(tokEl, b('Stand up', 'ghost', () => send({ op: 'stand' })));
      }
      bar.replaceChildren(...(line ? [el('span', 'bjLine', line)] : []), ...kids);
      input.disabled = !v || v.you < 0 || drawing();
      input.placeholder = drawing() ? 'You\'re drawing' : v && v.phase === 'drawing' && me() && me().guessed ? 'Chat with those who know…' : v && v.phase === 'drawing' ? 'Type your guess…' : 'Say something…';
      if (v.phase === 'drawing' && !drawing() && me() && !me().guessed && document.activeElement === document.body) input.focus({ preventScroll: true });
    }
    function tidy() {       // which tool, colour and width are picked; the tools only while you draw
      for (const [id, x] of Object.entries(toolEls)) { x.classList.toggle('on', id === tool); x.disabled = !drawing(); }
      undoB.disabled = clearB.disabled = !drawing();
      swatches.forEach((x, i) => x.classList.toggle('on', i === color));
      widthEls.forEach((x, i) => { x.classList.toggle('on', i === width); x.disabled = tool === 'fill'; });
      fmt.classList.toggle('on', drawing());
      live.style.cursor = drawing() ? (tool === 'eraser' ? 'cell' : 'crosshair') : 'default';
    }
    function tickClock() {
      if (!v || !(v.phase === 'drawing' || v.phase === 'choosing')) { clock.replaceChildren(); return; }
      const total = v.phase === 'drawing' ? v.drawMs : v.chooseMs, f = Math.max(0, Math.min(1, left() / total));
      const ring = el('i', 'ring'); ring.style.setProperty('--f', f.toFixed(3));
      clock.replaceChildren(ring, el('b', left() < 10000 && v.phase === 'drawing' ? 'low' : '', String(Math.ceil(left() / 1000))));
    }
    setInterval(() => { if (v) tickClock(); }, 250);
    function flash() {
      const m = me(); if (!m || !v.standings) return;
      const k2 = winners().ids.has(m.id) ? 'fBj' : 'fWin';
      holder.classList.remove('fBj', 'fWin', 'fLose'); void holder.offsetWidth; holder.classList.add(k2);
      clearTimeout(flashTimer); flashTimer = setTimeout(() => holder.classList.remove(k2), 2600);
    }

    return {
      view(nv, m) {
        const wasDrawing = drawing();
        v = nv; mode = m || ''; got = Date.now();
        if (wasDrawing && !drawing()) { stroke = null; clearInterval(flushT); pending = []; drawLive(); }
        draw();
      },
      ink, tokens,
      settings(s) {       // from main.js: what's saved, Drift's own words, and where they're used
        cfg = s && typeof s === 'object' ? { ...s, defaults: Array.isArray(s.defaults) ? s.defaults : [], words: Array.isArray(s.words) ? s.words : null } : null;
        setB.disabled = !cfg;
        const where = setEl.querySelector('.skWhere'); if (where && cfg) where.textContent = cfg.where;
      },
      note(text) { noteEl.textContent = text; noteEl.classList.add('on'); clearTimeout(noteTimer); noteTimer = setTimeout(() => noteEl.classList.remove('on'), 3200); },
      colors(c) {
        colorOf = c.colorOf || colorOf; selfColor = c.self || selfColor;
        for (const [kk, val] of Object.entries(c.vars || {})) holder.style.setProperty(kk, val);
        if (v) draw();
      },
      box() { const r = felt.getBoundingClientRect(); return r.width ? { l: r.left, t: r.top, w: r.width, h: r.height } : null; },
      felt,
      state: () => v,
      _ops: () => ({ ops: ops.length, pending: pending.length, groups: groupsOf(ops).length, rev }),       // (tests)
    };
  };
})();
