/* Drift — the Sketch & Guess scene (docs/plans/games-room.md §2.3): a drawing board for a hub, laid out like a diagram
   editor. Tools down the left (pen, line, arrow, rectangle, ellipse, diamond, triangle, eraser, undo, clear), the format bar
   along the top (colour, width, fill), the sheet in the middle on a light grid, and the players and their guesses on the
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
    line: '<path d="M5 19L19 5"/>',
    arrow: '<path d="M5 19L18 6"/><path d="M10 5.5h8.5V14"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
    diamond: '<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/>',
    triangle: '<path d="M12 4.5l8.5 15h-17z"/>',
    eraser: '<path d="M8.5 19.5L3.8 14.8a1.8 1.8 0 0 1 0-2.6l8.4-8.4a1.8 1.8 0 0 1 2.6 0l5.4 5.4a1.8 1.8 0 0 1 0 2.6l-8.1 8.1z"/><path d="M8.5 19.5H20M7.5 8.5l8 8"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    clear: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
    none: '<rect x="4.5" y="4.5" width="15" height="15" rx="2"/><path d="M5 19L19 5"/>',
    tint: '<rect x="4.5" y="4.5" width="15" height="15" rx="2" fill="currentColor" fill-opacity=".3"/>',
    solid: '<rect x="4.5" y="4.5" width="15" height="15" rx="2" fill="currentColor"/>',
    pencil: '<path d="M4 20l1-5L16 4l4 4L9 19z"/>',
  };
  const TOOLS = [['pen', 'Pen', 'P'], ['line', 'Line', 'L'], ['arrow', 'Arrow', 'A'], ['rect', 'Rectangle', 'R'], ['ellipse', 'Ellipse', 'O'], ['diamond', 'Diamond', 'D'], ['triangle', 'Triangle', 'T'], ['eraser', 'Eraser', 'E']];
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const svg = (name, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
  const btn = (cls, title, html, fn) => { const b = el('button', cls); b.type = 'button'; b.title = title; b.innerHTML = html; b.onclick = fn; return b; };

  // ---------- drawing one operation (also used for the preview while you drag) ----------
  function drawOp(ctx, op, k, from, preview) {       // k: screen pixels per sheet unit; from: where this stroke's last piece ended
    ctx.save();
    const col = COLORS[op.c] || COLORS[0];
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (op.k === 'pen') {
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
    } else {
      const [x1, y1, x2, y2] = op.p.map((v) => v * k), w = WIDTHS[op.w] * k;
      ctx.strokeStyle = col; ctx.lineWidth = w;
      if (op.k === 'line' || op.k === 'arrow') {
        const a = Math.atan2(y2 - y1, x2 - x1), head = Math.max(14 * k, w * 3.2);
        const ex = op.k === 'arrow' ? x2 - Math.cos(a) * head * 0.6 : x2, ey = op.k === 'arrow' ? y2 - Math.sin(a) * head * 0.6 : y2;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex, ey); ctx.stroke();
        if (op.k === 'arrow') {       // a filled head, as a diagram's arrows have
          ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - Math.cos(a - 0.42) * head, y2 - Math.sin(a - 0.42) * head); ctx.lineTo(x2 - Math.cos(a + 0.42) * head, y2 - Math.sin(a + 0.42) * head);
          ctx.closePath(); ctx.fill();
        }
      } else {
        const l = Math.min(x1, x2), t = Math.min(y1, y2), r = Math.max(x1, x2), b = Math.max(y1, y2), cx = (l + r) / 2, cy = (t + b) / 2;
        ctx.beginPath();
        if (op.k === 'rect') ctx.rect(l, t, r - l, b - t);
        else if (op.k === 'ellipse') ctx.ellipse(cx, cy, (r - l) / 2, (b - t) / 2, 0, 0, Math.PI * 2);
        else if (op.k === 'diamond') { ctx.moveTo(cx, t); ctx.lineTo(r, cy); ctx.lineTo(cx, b); ctx.lineTo(l, cy); ctx.closePath(); }
        else if (op.k === 'triangle') { ctx.moveTo(cx, t); ctx.lineTo(r, b); ctx.lineTo(l, b); ctx.closePath(); }
        if (op.f) { ctx.fillStyle = col; ctx.globalAlpha = op.f === 1 ? 0.28 : 1; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  // The drawing so far, as strokes and shapes (undo takes the last one away, clear takes them all)
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
    tools.append(undoB, clearB);
    // the top: the word (or its blanks), the format bar while you draw, the round and the clock
    const top = el('div', 'skTop'), roundEl = el('div', 'skRound'), wordEl = el('div', 'skWord'), fmt = el('div', 'skFormat'), clock = el('div', 'skClock');
    const swatches = COLORS.map((c, i) => { const b = btn('skSwatch', ['Black', 'Grey', 'Light grey', 'White', 'Red', 'Orange', 'Yellow', 'Lime', 'Green', 'Teal', 'Sky', 'Blue', 'Purple', 'Pink', 'Brown'][i], '', () => { color = i; tidy(); }); b.style.setProperty('--sw', c); return b; });
    const widthEls = WIDTHS.map((w, i) => { const b = btn('skWidth', ['Thin', 'Medium', 'Thick'][i] + ` (${i + 1})`, `<i style="--d:${[4, 7, 11][i]}px"></i>`, () => { width = i; tidy(); }); return b; });
    const fillEls = ['none', 'tint', 'solid'].map((f, i) => btn('skFill', ['No fill', 'Light fill', 'Solid fill'][i], svg(f, 18), () => { fill = i; tidy(); }));
    const grp = (cls, kids) => { const g = el('div', 'skGrp ' + cls); g.append(...kids); return g; };
    fmt.append(grp('skColors', swatches), el('i', 'skSep v'), grp('skWidths', widthEls), el('i', 'skSep v'), grp('skFills', fillEls));
    top.append(roundEl, wordEl, fmt, clock);
    // the middle: the sheet (what's drawn, and on top of it what you're drawing right now), and a card for between turns
    const paper = el('div', 'skPaper'), base = el('canvas', 'skBase'), live = el('canvas', 'skLive'), card = el('div', 'skCard');
    paper.append(base, live, card);
    // the right: the players, and the guesses
    const side = el('div', 'skSide'), list = el('div', 'skPlayers'), feedEl = el('div', 'skFeed'), form = el('form', 'skGuess'), input = el('input', 'skInput');
    Object.assign(input, { type: 'search', maxLength: 60, autocomplete: 'off', spellcheck: false, placeholder: 'Type your guess…' });       // (search: Drift's own keys leave it alone)
    form.append(input);
    side.append(list, feedEl, form);
    felt.append(tools, top, paper, side);

    let v = null, mode = '', got = 0, noteTimer = 0, flashTimer = 0, tool = 'pen', color = 0, width = 1, fill = 0, colorOf = () => '#9fe3c8', selfColor = '#22c08a';
    let rev = -1, ops = [], pending = [], q = 0, sid = Math.floor(Math.random() * 1e8), stroke = null, shape = null, flushT = 0, lastFeed = 0, shownOver = -1;
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
      if (shape && shape.end) all.push(shapeOp());
      for (const op of all) {
        if (op.k === 'undo' || op.k === 'clear') continue;
        if (op.k === 'pen' && stroke && op.s === stroke.s && op !== all[all.length - 1] && !shape) continue;       // (the stroke being drawn is drawn whole, below)
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
    function shapeOp() {
      let [x1, y1] = shape.start, [x2, y2] = shape.end;
      if (shape.shift) {       // Shift: squares and circles, lines at 45°
        const dx = x2 - x1, dy = y2 - y1;
        if (shape.k === 'line' || shape.k === 'arrow') { const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(dx, dy); x2 = Math.round(x1 + Math.cos(a) * d); y2 = Math.round(y1 + Math.sin(a) * d); }
        else { const d = Math.max(Math.abs(dx), Math.abs(dy)); x2 = x1 + Math.sign(dx || 1) * d; y2 = y1 + Math.sign(dy || 1) * d; }
      }
      const cl = (n, m) => Math.max(0, Math.min(m, n));
      return { k: shape.k, c: color, w: width, f: fill, s: shape.s, p: [x1, y1, cl(x2, SW), cl(y2, SH)] };
    }
    live.addEventListener('pointerdown', (e) => {
      if (!drawing() || e.button !== 0) return;
      try { live.setPointerCapture(e.pointerId); } catch { /* (not a live pointer: a test's) */ }
      const p = at(e);
      if (tool === 'pen' || tool === 'eraser') {
        stroke = { s: ++sid, c: color, w: width, e: tool === 'eraser', pts: [...p], sent: 0 };
        clearInterval(flushT); flushT = setInterval(flush, 60);
      } else shape = { k: tool, s: ++sid, start: p, end: null, shift: e.shiftKey };
      drawLive();
    });
    live.addEventListener('pointermove', (e) => {
      if (stroke) {
        for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) {
          const p = at(ev), n = stroke.pts.length;
          if (Math.hypot(p[0] - stroke.pts[n - 2], p[1] - stroke.pts[n - 1]) >= 2.5) stroke.pts.push(...p);
        }
        drawLive();
      } else if (shape) { shape.end = at(e); shape.shift = e.shiftKey; drawLive(); }
    });
    const up = () => {
      if (stroke) { clearInterval(flushT); flush(); stroke = null; }
      if (shape) { if (shape.end && Math.hypot(shape.end[0] - shape.start[0], shape.end[1] - shape.start[1]) > 6) { const op = shapeOp(); shape = null; sendOp(op); } else shape = null; }
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

    // ---------- the drawing coming in ----------
    function ink(m) {
      if (!m || !Array.isArray(m.list)) return;
      if (m.rev !== rev) { rev = m.rev; ops = []; pending = []; stroke = null; shape = null; clearInterval(flushT); if (m.from) return; }
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
      if (drawing() || (v.word && v.phase === 'drawing')) kids.push(el('span', 'lbl', drawing() ? 'Draw' : 'You got it'), el('b', 'skTheWord', v.word));
      else if (v.phase === 'drawing' || v.phase === 'reveal') {
        const letters = el('div', 'skBlanks');
        for (const ch of v.hint) letters.append(ch === ' ' ? el('i', 'gap') : el('b', ch === null ? 'blank' : '', ch === null ? '' : ch));
        const lens = []; let n = 0;
        for (const ch of v.hint) { if (ch === ' ') { lens.push(n); n = 0; } else n++; }
        lens.push(n);
        kids.push(letters, el('span', 'len', `(${lens.join(' ')})`));
      } else if (v.phase === 'choosing') kids.push(el('span', 'lbl', v.drawer === v.you ? 'Pick a word to draw' : `${(v.players[v.drawer] || {}).name || 'Someone'} is picking a word`));
      wordEl.replaceChildren(...kids);
    }
    function players() {
      const ranked = v.players.map((p, i) => ({ ...p, i })).sort((a, b) => b.score - a.score);
      const rank = new Map(ranked.map((p, n) => [p.i, n + 1]));
      list.replaceChildren(el('div', 'skHead', `Players · ${v.players.length}`), ...v.players.map((p, i) => {
        const row = el('div', 'skP' + (i === v.you ? ' me' : '') + (p.drawing ? ' drawing' : '') + (p.guessed ? ' got' : ''));
        row.style.setProperty('--c', i === v.you ? selfColor : colorOf(p.name));
        const f = mode === 'hub' && !p.blocked && opts.face ? opts.face(p.id) : null;
        row.append(el('b', 'rk', '#' + rank.get(i)), f || el('i', 'nf'), el('span', 'nm', i === v.you ? 'You' : p.name));
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
      const rows = mode === 'hub' && Array.isArray(v.board) ? v.board : null;
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
        kids.push(el('h3', '', v.standings[0] && v.standings[0].id === (me() || {}).id ? 'You win!' : `${(v.standings[0] || {}).name || 'Someone'} wins!`));
        const l = el('ol', 'skStand');
        for (const s of v.standings.slice(0, 6)) { const li = el('li', s.id === (me() || {}).id ? 'me' : ''); li.append(el('span', '', s.id === (me() || {}).id ? 'You' : s.name), el('b', '', String(s.score))); l.append(li); }
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
        if (drawing()) line = 'Your turn: draw it! Each tool shows its key. Shift draws straight lines, squares and circles.';
        else if (v.phase === 'drawing') line = me().guessed ? 'You got it! Watch the others guess.' : `${(v.players[v.drawer] || {}).name || 'Someone'} is drawing: type your guesses on the right.`;
        kids.push(b('Stand up', 'ghost', () => send({ op: 'stand' })));
      }
      bar.replaceChildren(...(line ? [el('span', 'bjLine', line)] : []), ...kids);
      input.disabled = !v || v.you < 0 || drawing();
      input.placeholder = drawing() ? 'You\'re drawing' : v && v.phase === 'drawing' && me() && me().guessed ? 'Chat with those who know…' : v && v.phase === 'drawing' ? 'Type your guess…' : 'Say something…';
      if (v.phase === 'drawing' && !drawing() && me() && !me().guessed && document.activeElement === document.body) input.focus({ preventScroll: true });
    }
    function tidy() {       // which tool, colour, width and fill are picked; the tools only while you draw
      for (const [id, x] of Object.entries(toolEls)) { x.classList.toggle('on', id === tool); x.disabled = !drawing(); }
      undoB.disabled = clearB.disabled = !drawing();
      swatches.forEach((x, i) => x.classList.toggle('on', i === color));
      widthEls.forEach((x, i) => x.classList.toggle('on', i === width));
      fillEls.forEach((x, i) => { x.classList.toggle('on', i === fill); x.disabled = tool === 'pen' || tool === 'eraser' || tool === 'line' || tool === 'arrow'; });
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
      const k2 = v.standings[0] && v.standings[0].id === m.id ? 'fBj' : 'fWin';
      holder.classList.remove('fBj', 'fWin', 'fLose'); void holder.offsetWidth; holder.classList.add(k2);
      clearTimeout(flashTimer); flashTimer = setTimeout(() => holder.classList.remove(k2), 2600);
    }

    return {
      view(nv, m) {
        const wasDrawing = drawing();
        v = nv; mode = m || ''; got = Date.now();
        if (wasDrawing && !drawing()) { stroke = null; shape = null; clearInterval(flushT); pending = []; drawLive(); }
        draw();
      },
      ink,
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
