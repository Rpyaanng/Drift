/* Drift — the Roulette scene's table (docs/plans/games-room.md §2.1). It only draws: the rules are in roulette.js, played in
   main.js alone or on the hub with friends, and what it gets is the table as you see it (view). Your moves go back through
   send({ op, ... }), which app.js passes on.
     const t = window.driftRoulette(holder, send, { face, me })   t.view(v, mode)   t.note(text)   t.colors({ colorOf, self, vars })   t.box()
   On the felt: the wheel on the left, the layout on the right (you bet by clicking it: on a number, on a line between two
   for a split, on a corner for four, on the outside edge for a street or a six line), and everyone at the table along
   the bottom, each with their chips on the layout in their own colour. Names come from the hub, so everything a person
   types is put in with textContent, never as markup. */
(() => {
  const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const CHIPS = [5, 25, 100, 500];
  const STEP = 360 / 37;
  const colorName = (n) => (n === 0 ? 'Green' : REDS.has(n) ? 'Red' : 'Black');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const fmt = (n) => Math.round(n).toLocaleString();
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };

  // ---------- the layout, in units: 14 across (the zero, twelve columns of numbers, the column bets), 5 down (three rows of
  // numbers, the dozens, the even-money bets) ----------
  const cellOf = (n) => ({ x: 1 + Math.floor((n - 1) / 3), y: 2 - ((n - 1) % 3) });       // a number's square (top row 3, 6, 9 ...)
  const OUTSIDE = [
    ['c3', 13, 0, 1, 1, '2 to 1'], ['c2', 13, 1, 1, 1, '2 to 1'], ['c1', 13, 2, 1, 1, '2 to 1'],
    ['d1', 1, 3, 4, 1, '1st 12'], ['d2', 5, 3, 4, 1, '2nd 12'], ['d3', 9, 3, 4, 1, '3rd 12'],
    ['low', 1, 4, 2, 1, '1 to 18'], ['even', 3, 4, 2, 1, 'Even'], ['red', 5, 4, 2, 1, ''], ['black', 7, 4, 2, 1, ''], ['odd', 9, 4, 2, 1, 'Odd'], ['high', 11, 4, 2, 1, '19 to 36'],
  ];
  const OUT = Object.fromEntries(OUTSIDE.map(([k, x, y, w, h]) => [k, { x, y, w, h }]));
  const COVERS = { red: [...REDS], black: [], odd: [], even: [], low: [], high: [], d1: [], d2: [], d3: [], c1: [], c2: [], c3: [] };
  for (let n = 1; n <= 36; n++) {
    if (!REDS.has(n)) COVERS.black.push(n);
    COVERS[n % 2 ? 'odd' : 'even'].push(n); COVERS[n <= 18 ? 'low' : 'high'].push(n);
    COVERS['d' + Math.ceil(n / 12)].push(n); COVERS['c' + (((n - 1) % 3) + 1)].push(n);
  }
  const numsOf = (key) => (COVERS[key] || key.split('-').map(Number));
  const keyOf = (nums) => [...new Set(nums)].sort((a, b) => a - b).join('-');
  // Which bet the pointer is on, at (ux, uy) units over the numbers: near a line between two numbers it's a split, near a
  // corner of four it's a corner, on the outside (bottom) edge it's a street, or a six line where two streets meet
  function insideKey(ux, uy) {
    const c = Math.max(0, Math.min(11, Math.floor(ux - 1))), r = Math.max(0, Math.min(2, Math.floor(uy)));
    const fx = ux - 1 - c, fy = uy - r, E = 0.26, n = 3 * c + 3 - r;
    const L = fx < E, Rt = fx > 1 - E, T = fy < E, B = fy > 1 - E;
    const street = (k) => [3 * k + 1, 3 * k + 2, 3 * k + 3];
    if (r === 2 && B) {
      if (Rt && c < 11) return keyOf([...street(c), ...street(c + 1)]);
      if (L && c > 0) return keyOf([...street(c - 1), ...street(c)]);
      if (L) return '0-1-2-3';
      return keyOf(street(c));
    }
    const h = Rt && c < 11 ? n + 3 : L && c > 0 ? n - 3 : null, v = T && r > 0 ? n + 1 : B && r < 2 ? n - 1 : null;
    if (L && c === 0) return keyOf(v !== null ? [0, n, v] : [0, n]);
    if (h !== null && v !== null) return keyOf([n, h, v, v + (h - n)]);
    if (h !== null) return keyOf([n, h]);
    if (v !== null) return keyOf([n, v]);
    return String(n);
  }
  function keyAt(ux, uy) {
    if (ux < 0 || uy < 0 || ux > 14 || uy > 5) return '';
    if (uy < 3 && ux < 1) return '0';
    if (uy < 3 && ux < 13) return insideKey(ux, uy);
    for (const [k, x, y, w, h] of OUTSIDE) if (ux >= x && ux < x + w && uy >= y && uy < y + h) return k;
    return '';
  }
  // Where a bet's chips sit, in units: in its square, on its line, on its corner, or on the edge for streets and six lines
  function posOf(key) {
    const o = OUT[key]; if (o) return [o.x + o.w / 2, o.y + o.h / 2];
    const nums = key.split('-').map(Number), mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    if (nums.includes(0)) {
      if (nums.length === 1) return [0.5, 1.5];
      if (nums.length === 4) return [1, 3];
      return [1, mean(nums.filter(Boolean).map((n) => cellOf(n).y + 0.5))];
    }
    const cs = nums.map(cellOf);
    return [mean(cs.map((q) => q.x)) + 0.5, nums.length === 3 || nums.length === 6 ? 3 : mean(cs.map((q) => q.y)) + 0.5];
  }

  // ---------- the wheel (SVG, -100..100): the wood, the ball's track, the pockets turning, the cone in the middle ----------
  function wheelSvg() {
    const root = svg('svg', { viewBox: '-100 -100 200 200', class: 'rlWheelSvg', 'aria-hidden': 'true' });
    root.append(svg('circle', { r: 99, class: 'rim' }), svg('circle', { r: 91, class: 'track' }), svg('circle', { r: 79.5, class: 'trackIn' }));
    const rotor = svg('g', { class: 'rotor' });
    const pt = (r, deg) => { const a = (deg * Math.PI) / 180; return `${(r * Math.sin(a)).toFixed(3)} ${(-r * Math.cos(a)).toFixed(3)}`; };
    WHEEL.forEach((n, i) => {
      const a1 = (i - 0.5) * STEP, a2 = (i + 0.5) * STEP;
      rotor.append(svg('path', { d: `M${pt(78, a1)} A78 78 0 0 1 ${pt(78, a2)} L${pt(56, a2)} A56 56 0 0 0 ${pt(56, a1)} Z`, class: 'pk ' + (n === 0 ? 'z' : REDS.has(n) ? 'r' : 'b') }));
      const t = svg('text', { class: 'num', transform: `rotate(${(i * STEP).toFixed(3)}) translate(0 -70)` }); t.textContent = String(n);
      rotor.append(t);
      rotor.append(svg('line', { x1: 0, y1: -56, x2: 0, y2: -64, transform: `rotate(${(a1).toFixed(3)})`, class: 'fret' }));
    });
    rotor.append(svg('circle', { r: 64, class: 'pocketRing' }), svg('circle', { r: 55, class: 'cone' }), svg('circle', { r: 40, class: 'coneIn' }));
    for (let k = 0; k < 4; k++) rotor.append(svg('rect', { x: -2.4, y: -30, width: 4.8, height: 60, rx: 2.4, class: 'turret', transform: `rotate(${k * 45})` }));
    rotor.append(svg('circle', { r: 9, class: 'hub' }));
    root.append(rotor);
    const ball = svg('circle', { r: 4.1, class: 'ball' });
    root.append(ball);
    return { root, rotor, ball };
  }

  window.driftRoulette = (holder, send, opts = {}) => {
    holder.innerHTML = '';
    const lampEl = el('div', 'bjLamp'), felt = el('div', 'rlFelt'), bar = el('div', 'bjBar'), noteEl = el('div', 'bjNote'), boardEl = el('div', 'bjBoard');
    holder.append(lampEl, felt, bar, noteEl, boardEl);
    felt.append(el('div', 'rlRail'));
    const wheelBox = el('div', 'rlWheel'), W = wheelSvg();
    wheelBox.append(W.root);
    const sign = el('div', 'bjSign rlSign'); sign.append(el('div', 'bjMode'), el('div', 'bjLimits'));
    const status = el('div', 'bjStatus rlStatus'), hist = el('div', 'rlHist');
    const layout = el('div', 'rlLayout'), cells = new Map(), chipsEl = el('div', 'rlChips'), ghost = el('div', 'rlGhost');
    const place = (box, x, y, w, h) => Object.assign(box.style, { left: (x / 14 * 100) + '%', top: (y / 5 * 100) + '%', width: (w / 14 * 100) + '%', height: (h / 5 * 100) + '%' });
    const zero = el('div', 'rlCell z', '0'); place(zero, 0, 0, 1, 3); layout.append(zero); cells.set(0, zero);
    for (let n = 1; n <= 36; n++) { const c = cellOf(n), d = el('div', 'rlCell ' + (REDS.has(n) ? 'r' : 'b')); d.append(el('span', '', String(n))); place(d, c.x, c.y, 1, 1); layout.append(d); cells.set(n, d); }
    const outEls = new Map();
    for (const [k, x, y, w, h, label] of OUTSIDE) {
      const d = el('div', 'rlCell out o-' + k, label); place(d, x, y, w, h);
      if (k === 'red' || k === 'black') d.append(el('i', 'dia'));
      layout.append(d); outEls.set(k, d);
    }
    layout.append(chipsEl, ghost);
    const players = el('div', 'rlPlayers');
    felt.append(wheelBox, sign, hist, status, layout, players);
    const brand = el('div', 'rlBrand'); brand.innerHTML = window.driftMark || ''; brand.append(el('span', '', 'DRIFT ROULETTE')); felt.append(brand);       // (fixed markup: Drift's mark, from renderer/blackjack.js)

    let v = null, mode = '', got = 0, chip = 25, hoverKey = '', noteTimer = 0, flashTimer = 0, shownRound = -1, colorOf = () => '#9fe3c8', selfColor = '#22c08a';
    const left = () => (v ? Math.max(0, v.msLeft - (Date.now() - got)) : 0);
    const secs = () => Math.ceil(left() / 1000);
    const me = () => (v && v.you >= 0 ? v.seats[v.you] : null);
    const canBet = () => { const m = me(); return !!(v && m && v.phase === 'betting' && !m.outMs && !m.left); };
    const colorFor = (i) => (i === v.you ? selfColor : colorOf((v.seats[i] || {}).name || ''));

    // ---------- betting with the mouse ----------
    function unitsAt(e) { const r = layout.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * 14, (e.clientY - r.top) / r.height * 5]; }
    function hover(key) {
      if (key === hoverKey) return;
      hoverKey = key;
      for (const c of cells.values()) c.classList.remove('hl');
      for (const c of outEls.values()) c.classList.remove('hl');
      ghost.classList.toggle('on', !!key && canBet());
      if (!key || !canBet()) return;
      for (const n of numsOf(key)) { const c = cells.get(n); if (c) c.classList.add('hl'); }
      if (outEls.has(key)) outEls.get(key).classList.add('hl');
      const [x, y] = posOf(key);
      Object.assign(ghost.style, { left: (x / 14 * 100) + '%', top: (y / 5 * 100) + '%' });
      ghost.className = 'rlGhost on chip c' + chip;
      ghost.textContent = String(chip);
    }
    layout.addEventListener('mousemove', (e) => { const [x, y] = unitsAt(e); hover(keyAt(x, y)); });
    layout.addEventListener('mouseleave', () => hover(''));
    layout.addEventListener('click', (e) => {
      if (!canBet()) return;
      const [x, y] = unitsAt(e), key = keyAt(x, y);
      if (!key) return;
      if (chip > me().chips) { note('Not enough chips for that one: pick a smaller chip'); return; }
      send({ op: 'tap' }); send({ op: 'move', m: { do: 'bet', key, amount: chip } });
    });
    layout.addEventListener('contextmenu', (e) => { e.preventDefault(); if (canBet() && me().staked) send({ op: 'move', m: { do: 'undo' } }); });       // (right-click: take the last chip back)

    // ---------- the wheel turning, and the ball ----------
    let wheelA = 0, wheelV = 10, ballA = 0, ballV = 0, ballR = 0, ballMode = 'none', landFrom = null, raf = 0, lastT = 0;
    const pocketOf = (n) => WHEEL.indexOf(n) * STEP;
    function frame(ts) {
      raf = 0;
      if (!holder.classList.contains('on') || !v) return;
      const dt = Math.min(0.05, lastT ? (ts - lastT) / 1000 : 0); lastT = ts;
      wheelA = (wheelA + wheelV * dt) % 360;
      if (ballMode === 'spin') {
        ballV = Math.min(-170, ballV * Math.pow(0.82, dt)); ballA += ballV * dt;
        ballR = 85.5 - Math.max(0, (left() < 1200 ? (1200 - left()) / 1200 : 0)) * 6;       // drifting in off the track as it slows
      } else if (ballMode === 'land') {
        const p = Math.min(1, (ts - landFrom.t) / 1400), e = 1 - Math.pow(1 - p, 3);
        const rel = landFrom.rel + landFrom.d * e;
        ballA = wheelA + rel;
        ballR = 79 - 10 * e + Math.sin(p * Math.PI * 3) * (1 - p) * 4;       // bouncing over the frets into the pocket
        if (p >= 1) ballMode = 'rest';
      }
      if (ballMode === 'rest') { ballA = wheelA + pocketOf(landFrom ? landFrom.n : 0); ballR = 69; }
      W.rotor.setAttribute('transform', `rotate(${wheelA.toFixed(2)})`);
      const a = (ballA * Math.PI) / 180;
      W.ball.setAttribute('cx', (ballR * Math.sin(a)).toFixed(2)); W.ball.setAttribute('cy', (-ballR * Math.cos(a)).toFixed(2));
      W.ball.style.opacity = ballMode === 'none' ? 0 : 1;
      raf = requestAnimationFrame(frame);
    }
    const run = () => { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } };
    function wheelFor(nv, was) {
      if (nv.phase === 'spinning' && (!was || was.phase !== 'spinning')) { ballMode = 'spin'; ballV = -620; ballR = 85.5; wheelV = 48; ballA = wheelA + 180; }
      else if (nv.phase === 'done' && nv.number !== null) {
        if (was && was.phase === 'spinning') {
          const rel0 = (((ballA - wheelA) % 360) + 360) % 360, target = pocketOf(nv.number);
          let d = -((((rel0 - target) % 360) + 360) % 360); if (d > -200) d -= 360;
          landFrom = { t: performance.now(), rel: rel0, d, n: nv.number }; ballMode = 'land';
        } else if (ballMode !== 'land') { landFrom = { n: nv.number }; ballMode = 'rest'; }
        wheelV = 26;
      } else if (nv.phase === 'betting' || nv.phase === 'idle') {
        wheelV = 10;
        if (ballMode === 'land') ballMode = 'rest';
        if (ballMode === 'none' && nv.history.length) { landFrom = { n: nv.history[0] }; ballMode = 'rest'; }
      }
      run();
    }

    // ---------- the table ----------
    function draw() {
      if (!v) { holder.classList.remove('live'); return; }
      holder.classList.add('live');
      sign.firstChild.textContent = mode === 'hub' ? 'Hub table' : 'Just you';
      sign.lastChild.textContent = `Min ${v.min} · Max ${fmt(v.spot)} a bet`;
      hist.replaceChildren(...v.history.map((n, i) => el('b', 'h ' + colorName(n).toLowerCase() + (i === 0 ? ' last' : ''), String(n))));
      hist.classList.toggle('empty', !v.history.length);
      const win = v.phase === 'done' ? v.number : null;
      for (const [n, c] of cells) c.classList.toggle('win', n === win);
      for (const [k, c] of outEls) c.classList.toggle('win', win !== null && win !== 0 && COVERS[k].includes(win));
      chipsDraw(win);
      playersDraw();
      board();
      controls();
      holder.classList.toggle('myTurn', canBet() && !me().ready);
      if (v.phase === 'done' && shownRound !== v.round) { shownRound = v.round; flash(); }
      if (!canBet()) hover('');
    }
    function chipsDraw(win) {
      const out = [];
      v.seats.forEach((s, i) => {
        if (!s || !s.bets.length) return;
        const k = out.length;
        for (const [key, amt] of s.bets) {
          const [x, y] = posOf(key), c = el('div', 'rlChip chip c' + (amt >= 500 ? 500 : amt >= 100 ? 100 : amt >= 25 ? 25 : 10));
          c.style.left = `calc(${x / 14 * 100}% + ${(k % 4) * 0.35}cqw)`; c.style.top = `calc(${y / 5 * 100}% - ${(k % 4) * 0.35}cqw)`;
          c.style.setProperty('--c', colorFor(i));
          if (win !== null) c.classList.add(numsOf(key).includes(win) ? 'won' : 'lost');
          c.append(el('b', '', amt >= 1000 ? (amt / 1000).toFixed(amt % 1000 ? 1 : 0) + 'k' : String(amt)));
          out.push(c);
        }
      });
      chipsEl.replaceChildren(...out);
    }
    function playersDraw() {
      const tags = v.seats.map((s, i) => {
        if (!s) return null;
        const t = el('div', 'bjTag rlTag' + (i === v.you ? ' me' : '') + (s.outMs ? ' out' : '') + (s.left ? ' gone' : '') + (s.ready && v.phase === 'betting' ? ' ready' : ''));
        t.style.setProperty('--c', colorFor(i));
        const ring = el('i', 'bjRing'), f = mode === 'hub' && !s.blocked && opts.face ? opts.face(s.id) : null;
        if (f) { ring.classList.add('av'); ring.append(f); }
        const extra = s.outMs ? 'Out of chips' : v.phase === 'done' && s.played ? (s.net > 0 ? `+${fmt(s.net)}` : s.net < 0 ? `−${fmt(-s.net)}` : 'Even') : s.staked ? `${fmt(s.staked)} on` : '';
        t.append(ring, el('span', 'nm', i === v.you ? 'You' : s.name), el('span', 'ch', fmt(s.chips)), ...(extra ? [el('span', 'ex' + (v.phase === 'done' && s.net > 0 ? ' up' : ''), extra)] : []), ...(s.ready && v.phase === 'betting' ? [el('span', 'rd', '✓')] : []));
        return t;
      }).filter(Boolean);
      players.replaceChildren(...tags);
    }
    function board() {       // the hub's biggest wins on one spin (hub.js gameBoard): a hub's table only
      const list = mode === 'hub' && Array.isArray(v.board) ? v.board : null;
      boardEl.classList.toggle('on', !!list);
      if (!list) return;
      const mine = opts.me ? opts.me() : '';
      const rows = list.map((x, i) => {
        const row = el('div', 'bjBRow' + (x.id === mine ? ' me' : '') + (x.ago < 8000 ? ' fresh' : ''));
        const f = !x.blocked && opts.face ? opts.face(x.id) : null;
        row.append(el('b', 'rk', String(i + 1)), f || el('i', 'nf'), el('span', 'nm', x.id === mine ? 'You' : x.name), el('span', 'amt', '+' + fmt(x.win)));
        return row;
      });
      boardEl.replaceChildren(el('div', 'bjBHead', 'Biggest wins'), ...(rows.length ? rows : [el('div', 'bjBNone', 'None yet. Win a spin to get on the board.')]));
    }

    // ---------- what you can do ----------
    function controls() {
      const m = me(), kids = [];
      const btn = (label, cls, fn, off) => { const b = el('button', 'bjBtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.onclick = fn; b.disabled = !!off; return b; };
      const mv = (what) => () => send({ op: 'move', m: { do: what } });
      let line = '';
      if (!m && v.watching >= 0) { line = `The table is full. You're next for a place${v.watching ? ` (${v.watching + 1} in line)` : ''}.`; kids.push(btn('Leave the line', 'ghost', () => send({ op: 'stand' }))); }
      else if (!m) { const full = v.seats.every(Boolean); line = full ? 'You\'re standing. The table is full.' : 'You\'re standing, watching the wheel.'; kids.push(btn(full ? 'Get in line' : 'Sit down', 'primary', () => send({ op: 'sit' }))); }
      else if (m.left) { line = 'You\'ve stood up. Your bets still ride.'; kids.push(btn('Sit back down', 'primary', () => send({ op: 'sit' }))); }
      else if (m.outMs) { line = `Out of chips. Back in with ${fmt(v.start)} in `; kids.push(el('b', 'bjCount out', String(Math.ceil(m.outMs / 1000)))); }
      else if (v.phase === 'betting') {
        for (const c of CHIPS) {
          const b = el('button', 'chip c' + c + (c === chip ? ' sel' : ''), String(c)); b.type = 'button'; b.title = `Bet ${c} a click`;
          b.disabled = c > m.chips;
          b.onclick = () => { chip = c; send({ op: 'tap' }); controls(); };
          kids.push(b);
        }
        kids.push(el('span', 'bjAmt', m.staked ? `${fmt(m.staked)} on` : 'Click the layout'));
        kids.push(btn('Undo', 'ghost', mv('undo'), !m.staked), btn('Clear', 'ghost', mv('clear'), !m.staked));
        if (!m.staked && m.again) kids.push(btn('Same again', '', mv('again')));
        const others = v.seats.some((s, i) => s && i !== v.you && !s.outMs && !s.left);
        kids.push(btn(m.ready ? (others ? 'Waiting…' : 'Spinning…') : m.staked ? 'Spin' : others ? 'Skip this spin' : 'Spin', m.ready ? '' : 'primary', mv('spin'), !m.staked && !others));
      } else if (v.phase === 'spinning') line = m.played ? 'No more bets. Round it goes…' : 'No more bets. You\'re sitting this one out.';
      else if (v.phase === 'done') {
        const n = v.number;
        line = `${n} ${colorName(n)}. ` + (!m.played ? 'You sat this one out.' : m.net > 0 ? `You win ${fmt(m.net)}!` : m.net < 0 ? `You lose ${fmt(-m.net)}.` : 'You break even.');
      }
      if (m && !m.left && (v.phase === 'done' || (v.phase === 'betting' && !m.staked))) kids.push(btn('Stand up', 'ghost', () => send({ op: 'stand' })));
      bar.replaceChildren(...(line ? [el('span', 'bjLine', line)] : []), ...kids);
      bar.dataset.phase = v.phase;
      status.replaceChildren(...statusLine());
    }
    function statusLine() {
      const out = [];
      if (v.phase === 'done') { const n = v.number; const b = el('b', 'rlBig ' + colorName(n).toLowerCase(), String(n)); out.push(b, el('span', '', colorName(n))); return out; }
      out.push(el('span', '', { idle: 'Take a place', betting: 'Place your bets', spinning: 'No more bets' }[v.phase] || ''));
      if (v.msLeft && v.phase === 'betting') out.push(el('b', 'bjCount', String(secs())));
      return out;
    }
    function tickTimers() {
      if (!v) return;
      const c = status.querySelector('.bjCount'); if (c) c.textContent = String(secs());
      const m = me();
      if (m && m.outMs) { const o = bar.querySelector('.bjCount.out'), ms = Math.max(0, m.outMs - (Date.now() - got)); if (o) o.textContent = String(Math.ceil(ms / 1000)); }
    }
    setInterval(tickTimers, 200);
    function flash() {       // the lamp answers how your spin went
      const m = me(); if (!m || !m.played) return;
      const k = m.net > 0 ? (m.net >= 500 ? 'fBj' : 'fWin') : m.net < 0 ? 'fLose' : '';
      holder.classList.remove('fBj', 'fWin', 'fLose');
      if (!k) return;
      void holder.offsetWidth;
      holder.classList.add(k);
      clearTimeout(flashTimer); flashTimer = setTimeout(() => holder.classList.remove(k), 2600);
    }
    function note(text) {
      noteEl.textContent = text; noteEl.classList.add('on');
      clearTimeout(noteTimer); noteTimer = setTimeout(() => noteEl.classList.remove('on'), 3200);
    }

    return {
      view(nv, m) {
        const was = v;
        v = nv; mode = m || ''; got = Date.now();
        if (!v) { ballMode = 'none'; landFrom = null; }
        else wheelFor(v, was && was.round <= v.round ? was : null);
        draw();
      },
      note,
      colors(c) {
        colorOf = c.colorOf || colorOf; selfColor = c.self || selfColor;
        for (const [k, val] of Object.entries(c.vars || {})) holder.style.setProperty(k, val);
        if (v) draw();
      },
      box() { const r = felt.getBoundingClientRect(); return r.width ? { l: r.left, t: r.top, w: r.width, h: r.height } : null; },
      felt,
      state: () => v,
      _keyAt: keyAt, _posOf: posOf,       // (tests)
    };
  };
})();
