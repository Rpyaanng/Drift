/* Drift — the Pachinko scene's machine (docs/plans/pachinko.md). It only draws: the rules and the balls are in pachinko.js,
   run in main.js alone or on the hub with friends. What it gets is the machine as you see it (view) and the balls as frames
   (ink: every 1/30 s, each ball's place). Your moves go back through send({ op, ... }), which app.js passes on.
     const t = window.driftPachinko(holder, send, { face, me })   t.view(v, mode)   t.ink({ rev, from, list })   t.note(text)   t.colors(...)   t.box()
   The cabinet is in the middle: the board on a canvas (pins, rails, pockets, the balls), the reels in its window over it.
   Hold the mouse down on the machine (or Hold in the bar) to send balls up the lane; the dial sets how hard, and so where
   they drop: just beside the window is where the start pocket is likeliest. Everyone at the machine fires into the same pins,
   each ball in its owner's colour. Names come from the hub, so they're put in with textContent, never as markup. */
(() => {
  const B = window.driftPachinkoBoard;
  const LAG = 160;       // ms the balls are drawn behind the newest frame, so a late one doesn't make them stutter (main.js PA_LAG)
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const fmt = (n) => Math.round(n).toLocaleString();
  const roll = window.driftRoll;
  // The reels' symbols (pachinko.js SYMBOLS), drawn flat on a 40 × 40 box. The cat and the seven are the big ones.
  const SYM = {
    cat: '<path d="M8 33c0-9 4-15 12-15s12 6 12 15z" class="f"/><path d="M9 21l2-13 8 8zM31 21l-2-13-8 8z" class="f"/><circle cx="15.5" cy="25" r="1.8" class="i"/><circle cx="24.5" cy="25" r="1.8" class="i"/><path d="M18.6 28.6h2.8L20 30.2z" class="i"/>',
    moon: '<path d="M26 7a13 13 0 1 0 7 21A11 11 0 0 1 26 7z" class="f"/>',
    wave: '<path d="M5 25c5-8 10-8 15 0s10 8 15 0" class="s"/><path d="M5 16c5-8 10-8 15 0s10 8 15 0" class="s o"/>',
    star: '<path d="M20 5l4.4 9.6 10.4 1.2-7.8 7 2.2 10.3L20 27.9l-9.2 5.2L13 22.8l-7.8-7 10.4-1.2z" class="f"/>',
    note: '<path d="M16 9l14-3v19" class="s"/><path d="M16 9v20" class="s"/><ellipse cx="12.5" cy="29.5" rx="4.5" ry="3.6" class="f"/><ellipse cx="26.5" cy="25.5" rx="4.5" ry="3.6" class="f"/>',
    bell: '<path d="M20 6c-6 0-9 5-9 11v7l-3 4h24l-3-4v-7c0-6-3-11-9-11z" class="f"/><circle cx="20" cy="31.5" r="3" class="f"/>',
    seven: '<path d="M9 8h22l-11 25" class="s b"/><path d="M14 20h12" class="s"/>',
  };
  const NAMES = ['cat', 'moon', 'wave', 'star', 'note', 'bell', 'seven'];
  const symSvg = (k) => `<svg viewBox="0 0 40 40" class="paSym ${NAMES[k] || ''}" aria-hidden="true">${SYM[NAMES[k]] || ''}</svg>`;

  window.driftPachinko = (holder, send, opts = {}) => {
    holder.innerHTML = '';
    const lampEl = el('div', 'bjLamp'), cab = el('div', 'paCab'), bar = el('div', 'bjBar'), noteEl = el('div', 'bjNote'), boardEl = el('div', 'bjBoard');
    const side = el('div', 'paSide'), players = el('div', 'paPlayers');
    holder.append(lampEl, cab, side, players, bar, noteEl, boardEl);
    const glass = el('div', 'paGlass'), canvas = el('canvas', 'paCanvas');
    const win = el('div', 'paWin'), reelsEl = el('div', 'paReels'), winLine = el('div', 'paWinLine'), lights = el('div', 'paLights');
    const reelEls = [0, 1, 2].map(() => { const r = el('div', 'paReel'); r.append(el('div', 'paStrip')); reelsEl.append(r); return r; });
    win.append(reelsEl, winLine);
    const pct = (v, of) => (v / of * 100) + '%';
    Object.assign(win.style, { left: pct(B.WIN.x + 12, B.W), top: pct(B.WIN.y + 40, B.H), width: pct(B.WIN.w - 24, B.W), height: pct(B.WIN.h - 56, B.H) });
    Object.assign(lights.style, { left: pct(B.WIN.x, B.W), top: pct(B.WIN.y + B.WIN.h + 4, B.H), width: pct(B.WIN.w, B.W) });
    for (let i = 0; i < 8; i++) lights.append(el('i'));
    const trim = el('div', 'paTrim'), brand = el('div', 'paBrand');
    brand.innerHTML = window.driftMark || ''; brand.append(el('span', '', 'DRIFT PACHINKO'));       // (fixed markup: Drift's mark, from renderer/blackjack.js)
    glass.append(canvas, win, lights);
    cab.append(trim, brand, glass);
    const sign = el('div', 'bjSign paSign'); sign.append(el('div', 'bjMode'), el('div', 'bjLimits'));
    const payList = el('div', 'paPays'), hotEl = el('div', 'paHot'), histEl = el('div', 'paHist'), feverEl = el('div', 'paFever');
    side.append(sign, feverEl, payList, hotEl, histEl);

    let v = null, mode = '', got = 0, noteTimer = 0, colorOf = () => '#9fe3c8', selfColor = '#22c08a', look = {};
    let power = 60, holding = false, powerSent = 60;
    const me = () => (v && v.you >= 0 ? v.seats[v.you] : null);
    const canPlay = () => { const m = me(); return !!(m && !m.outMs && !m.left && m.chips >= (v.cost || 1)); };
    const colorFor = (i) => (v && i === v.you ? selfColor : colorOf((v && v.seats[i] || {}).name || ''));

    // ---------- the handle: hold to send balls, the dial for how hard ----------
    function hold(on) {
      if (on && !canPlay()) { if (me() && me().outMs) note('Out of chips for a moment'); return; }
      if (on === holding) return;
      holding = on;
      send({ op: 'move', m: on ? { do: 'hold', amount: power } : { do: 'let go' } });
      powerSent = power;
      holder.classList.toggle('holding', holding);
      controls();
    }
    function setPower(p) {
      power = Math.max(0, Math.min(100, Math.round(p)));
      const dial = bar.querySelector('.paDial input'); if (dial) { if (+dial.value !== power) dial.value = String(power); dial.style.setProperty('--fill', power + '%'); }
      const lab = bar.querySelector('.paDial b'); if (lab) lab.textContent = String(power);
      aimDraw();
      clearTimeout(setPower.t);
      setPower.t = setTimeout(() => { if (power !== powerSent && me()) { powerSent = power; send({ op: 'move', m: { do: 'power', amount: power } }); } }, 250);       // (when it's settled: the hub counts moves)
    }
    const capture = (node, e) => { try { node.setPointerCapture(e.pointerId); } catch { /* (no such pointer: held without it) */ } };
    glass.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; capture(glass, e); hold(true); });
    const up = () => hold(false);
    glass.addEventListener('pointerup', up); glass.addEventListener('pointercancel', up); glass.addEventListener('lostpointercapture', up);
    cab.addEventListener('wheel', (e) => { if (!me()) return; e.preventDefault(); setPower(power + (e.deltaY < 0 ? 2 : -2)); }, { passive: false });
    addEventListener('blur', up);

    // ---------- the board, drawn once (pins, rails, pockets) and again when the colours or the size change ----------
    const ctx = canvas.getContext('2d');
    let still = null, scale = 1, aim = null;
    function size() {
      const r = glass.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      if (!r.width) return false;
      const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; still = null; }
      scale = w / B.W;
      return true;
    }
    // The look: a carnival. The board is two pictures drawn once (the painted face behind, and the chrome, brass and pockets in
    // front), with what moves drawn between and over them each frame: sunburst rays turning behind the pins, a black hole
    // swirling at the drain, pins lighting up as balls hit them, tulips that bloom, a mouth for the gate that chomps in a
    // fever, a striped trampoline on springs, trails behind the balls, confetti and "+40"s where pockets pay, chasing bulbs
    // round the rim, googly eyes over the reels that watch your ball, and a "FEVER!!" right across the glass.
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;       // (no turning, shaking or showers)
    const boardPath = (c) => { c.beginPath(); c.moveTo(B.ARC.x - B.ARC.r, B.ARC.y); c.arc(B.ARC.x, B.ARC.y, B.ARC.r, Math.PI, 0); c.lineTo(B.LANE.out, B.H); c.lineTo(B.ARC.x - B.ARC.r, B.H); c.closePath(); };
    const roofY = B.roofY;       // (the window's roof, as the board has it)
    let back = null;
    function layer() { const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; const x = c.getContext('2d'); x.setTransform(scale, 0, 0, scale, 0, 0); return [c, x]; }
    function paintStill() {
      const acc = look['--bjAccent'] || '#22c08a', hi = look['--bjHi'] || '#f6e7b0', dark = look['--bjDark'] || '#101018';
      // ---- behind: the painted face, deep and bright at once ----
      let c;
      [back, c] = layer();
      const g = c.createLinearGradient(0, 0, 0, B.H);
      g.addColorStop(0, mix(mix(dark, '#5a2a8a', 0.55), '#ffffff', 0.06)); g.addColorStop(0.55, mix(dark, '#1a3a6a', 0.5)); g.addColorStop(1, mix(dark, '#000000', 0.35));
      c.fillStyle = g; boardPath(c); c.fill();
      c.save(); boardPath(c); c.clip();
      const glow = c.createRadialGradient(300, 330, 40, 300, 330, 380); glow.addColorStop(0, hexA(hi, 0.28)); glow.addColorStop(0.4, hexA(acc, 0.12)); glow.addColorStop(1, hexA(acc, 0));
      c.fillStyle = glow; c.fillRect(0, 0, B.W, B.H);
      for (let y = 20, r = 0; y < B.H; y += 30, r++) for (let x = r % 2 ? 15 : 30; x < B.W; x += 30) { c.fillStyle = hexA(r % 3 ? hi : acc, 0.06); c.beginPath(); c.arc(x, y, 3.2, 0, 7); c.fill(); }       // polka dots
      const star = (x, y, rr, col) => { c.fillStyle = col; c.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? rr * 0.45 : rr; c.lineTo(x + q * Math.cos(a), y + q * Math.sin(a)); } c.closePath(); c.fill(); };
      for (const [x, y, rr, col] of [[70, 420, 14, '#ffd84a'], [528, 470, 11, '#ff6fb5'], [96, 610, 9, '#6fe8ff'], [512, 640, 13, '#b98cff'], [150, 250, 10, '#ff6fb5'], [452, 240, 12, '#ffd84a'], [60, 790, 10, '#6fe8ff'], [540, 800, 9, '#ffd84a']]) star(x, y, rr, hexA(col, 0.22));
      c.restore();
      // ---- in front: chrome rails, the window's frame, the pockets, brass pins ----
      [still, c] = layer();
      c.lineCap = 'round'; c.lineJoin = 'round';
      for (const [w, col] of [[6, 'rgba(0,0,0,.55)'], [4, '#9aa3b5'], [1.6, '#ffffff']]) { c.strokeStyle = col; c.lineWidth = w; for (const q of B.segs) { c.beginPath(); c.moveTo(q[0], q[1]); c.lineTo(q[2], q[3]); c.stroke(); } }
      // the window: a thick frame, striped like a circus tent, round its arch
      c.beginPath(); c.moveTo(B.WIN.x - 7, B.WIN.y + B.WIN.h + 5);
      for (let i = 0; i <= 24; i++) { const f = i / 24; c.lineTo(B.WIN.x - 7 + f * (B.WIN.w + 14), roofY(f) - 7); }
      c.lineTo(B.WIN.x + B.WIN.w + 7, B.WIN.y + B.WIN.h + 5); c.closePath();
      c.fillStyle = mix(dark, '#000000', 0.5); c.fill();
      c.save(); c.clip();
      for (let i = -12; i < 30; i++) { c.fillStyle = i % 2 ? hexA('#ff4f8b', 0.85) : hexA('#fff3d6', 0.9); c.beginPath(); c.moveTo(B.WIN.x - 20 + i * 16, B.WIN.roof - 30); c.lineTo(B.WIN.x - 4 + i * 16, B.WIN.roof - 30); c.lineTo(B.WIN.x - 44 + i * 16, B.WIN.y + B.WIN.h + 30); c.lineTo(B.WIN.x - 60 + i * 16, B.WIN.y + B.WIN.h + 30); c.fill(); }
      c.restore();
      c.beginPath(); c.moveTo(B.WIN.x, B.WIN.y + B.WIN.h);
      for (let i = 0; i <= 24; i++) { const f = i / 24; c.lineTo(B.WIN.x + f * B.WIN.w, roofY(f)); }
      c.lineTo(B.WIN.x + B.WIN.w, B.WIN.y + B.WIN.h); c.closePath();
      c.fillStyle = '#07060c'; c.fill(); c.strokeStyle = hi; c.lineWidth = 2; c.stroke();
      // the start pocket: a little striped awning over a gold cup, its sign
      const S0 = B.START;
      c.fillStyle = '#ffcf3a'; c.strokeStyle = '#7a4b00'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(S0.x - S0.half - 2, S0.y - 4); c.lineTo(S0.x - S0.half + 2, S0.y + 13); c.lineTo(S0.x + S0.half - 2, S0.y + 13); c.lineTo(S0.x + S0.half + 2, S0.y - 4); c.closePath(); c.fill(); c.stroke();
      c.fillStyle = '#1a1230'; c.fillRect(S0.x - S0.half + 2, S0.y - 2, (S0.half - 2) * 2, 4);
      c.save(); c.translate(S0.x, S0.y + 24); c.rotate(-0.06);
      c.fillStyle = '#ff4f8b'; c.strokeStyle = '#fff3d6'; c.lineWidth = 1.5; c.beginPath(); c.roundRect(-20, -7, 40, 14, 4); c.fill(); c.stroke();
      c.fillStyle = '#fff'; c.font = '900 9px "Segoe UI Variable Display", "Segoe UI", system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('START!', 0, 0.5);
      c.restore();
      // the tulips' pots
      for (const t of B.TULIPS) { c.fillStyle = '#3fbf6a'; c.strokeStyle = '#124a26'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(t.x - t.half - 1, t.y + 2); c.lineTo(t.x - t.half + 2, t.y + 13); c.lineTo(t.x + t.half - 2, t.y + 13); c.lineTo(t.x + t.half + 1, t.y + 2); c.closePath(); c.fill(); c.stroke(); }
      // the pins: brass
      for (const p of B.pins) {
        c.fillStyle = 'rgba(0,0,0,.5)'; c.beginPath(); c.arc(p[0] + 0.9, p[1] + 1.3, B.PIN, 0, 7); c.fill();
        const pg = c.createRadialGradient(p[0] - 0.8, p[1] - 0.8, 0.2, p[0], p[1], B.PIN); pg.addColorStop(0, '#fff8de'); pg.addColorStop(0.45, '#e5bd5c'); pg.addColorStop(1, '#7c5a1c');
        c.fillStyle = pg; c.beginPath(); c.arc(p[0], p[1], B.PIN, 0, 7); c.fill();
      }
    }
    const sprites = new Map();       // a ball in each colour, drawn once: chrome, its owner's colour round it, a hard highlight
    function ballSprite(col) {
      let s = sprites.get(col); if (s) return s;
      const r = B.BALL * scale, n = Math.ceil(r * 2 + 8);
      s = document.createElement('canvas'); s.width = s.height = n;
      const c = s.getContext('2d'), m = n / 2;
      const halo = c.createRadialGradient(m, m, r * 0.8, m, m, r + 4); halo.addColorStop(0, hexA(col, 0.8)); halo.addColorStop(1, hexA(col, 0));
      c.fillStyle = halo; c.beginPath(); c.arc(m, m, r + 4, 0, 7); c.fill();
      const g = c.createRadialGradient(m - r * 0.35, m - r * 0.4, r * 0.05, m, m, r);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, mix('#eef1f6', col, 0.15)); g.addColorStop(0.8, mix('#a3abbb', col, 0.3)); g.addColorStop(1, mix('#4a505c', col, 0.35));
      c.fillStyle = g; c.beginPath(); c.arc(m, m, r, 0, 7); c.fill();
      c.fillStyle = 'rgba(255,255,255,.9)'; c.beginPath(); c.ellipse(m - r * 0.35, m - r * 0.42, r * 0.28, r * 0.17, -0.6, 0, 7); c.fill();
      sprites.set(col, s);
      return s;
    }
    // pins near a ball light up and fade (found through a grid of the pins, as the table finds them)
    const PG = new Map(), pgKey = (x, y) => Math.floor(x / 20) + ',' + Math.floor(y / 20);
    B.pins.forEach((p, i) => { const k = pgKey(p[0], p[1]); if (!PG.has(k)) PG.set(k, []); PG.get(k).push(i); });
    const lit = new Map();       // pin -> brightness 0..1
    function touch(x, y) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of PG.get(pgKey(x + dx * 20, y + dy * 20)) || []) {
        const p = B.pins[i]; if ((p[0] - x) ** 2 + (p[1] - y) ** 2 < 100) lit.set(i, 1);
      }
    }
    // confetti, sparks and "+40"s, in board units
    let bits = [], pops = [], fxT = 0, feverAt = 0, reachAt = 0;
    const PARTY = ['#ff4f8b', '#ffd84a', '#6fe8ff', '#b98cff', '#7dff9a', '#ff9a3c'];
    function burst(x, y, n, speed, kind) {
      if (calm) n = Math.ceil(n / 4);
      for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, s0 = speed * (0.4 + Math.random() * 0.8); bits.push({ x, y, vx: Math.cos(a) * s0, vy: Math.sin(a) * s0 - speed * 0.5, life: 0, max: 700 + Math.random() * 700, col: PARTY[i % PARTY.length], spin: Math.random() * 6, kind }); }
      if (bits.length > 600) bits.splice(0, bits.length - 600);
    }
    function pop(x, y, text, col) { pops.push({ x, y, text, col, life: 0 }); if (pops.length > 30) pops.shift(); }

    // ---------- the balls: frames from the table, drawn LAG behind the newest, each ball between the two around now ----------
    let frames = [], off = null, raf = 0, lastTs = 0;
    function ink(m) {
      if (!m || !Array.isArray(m.list)) return;
      if (!m.list.length && m.from === 0) { frames = []; return; }
      for (const f of m.list) if (f && Number.isFinite(f.t) && Array.isArray(f.b) && (!frames.length || f.t > frames[frames.length - 1].t)) frames.push(f);
      const newest = frames.length ? frames[frames.length - 1].t : 0, cand = newest - performance.now();
      if (off === null || cand > off || cand < off - 2000) off = cand;
      if (frames.length > 90) frames.splice(0, frames.length - 90);
      run();
    }
    function frame(ts) {
      raf = 0;
      if (!holder.classList.contains('on') || !v) return;
      if (!size()) { raf = requestAnimationFrame(frame); return; }
      if (!still) paintStill();
      if (lastTs && off !== null) off -= (ts - lastTs) * 0.01;       // (drifting back a touch, so a fresh frame sets it again)
      const dt = Math.min(100, lastTs ? ts - lastTs : 16);
      lastTs = ts;
      const now = performance.now(), fever = !!(v && v.fever);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(back, 0, 0);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      rays(now, fever);
      blackHole(now);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(still, 0, 0);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      pinGlow(dt);
      dynamic(now);
      let balls = [];
      if (off !== null && frames.length) {
        const T = now + off - LAG;
        let i = frames.length - 1;
        while (i > 0 && frames[i].t > T) i--;
        const a = frames[i], b = frames[Math.min(frames.length - 1, i + 1)], u = b.t > a.t ? Math.max(0, Math.min(1, (T - a.t) / (b.t - a.t))) : 0;
        const next = new Map();
        for (let k = 0; k < b.b.length; k += 4) next.set(b.b[k], k);
        // the trampoline where the table had it then, the mat dipping just after something lands on it
        const px = Number.isFinite(a.p) ? (a.p + ((Number.isFinite(b.p) ? b.p : a.p) - a.p) * u) / 2 : B.trampAt(T).x;
        let dip = 0;
        for (let k = frames.length - 1; k >= 0 && frames[k].t > T - 160; k--) if (frames[k].t <= T && frames[k].e && frames[k].e.some((e) => e[0] === 't')) { dip = 1 - (T - frames[k].t) / 160; break; }
        trampoline(px, dip, now);
        // what happened since the last frame drawn: bursts and "+40"s where the pockets paid
        for (const f of frames) {
          if (f.t <= fxT || f.t > T) continue;
          for (const e of f.e || []) {
            const x = Number.isFinite(e[2]) ? e[2] : null, y = Number.isFinite(e[3]) ? e[3] : null, col = colorFor(e[1]);
            if (e[0] === 's') { burst(x ?? B.START.x, y ?? B.START.y, 26, 260, 'c'); pop(x ?? B.START.x, (y ?? B.START.y) - 14, `+${v.pays.start}`, col); }
            else if (e[0] === 'u') { burst(x ?? 300, y ?? 650, 16, 200, 'p'); pop(x ?? 300, (y ?? 650) - 14, `+${v.pays.tulip}`, col); }
            else if (e[0] === 'g') { burst(x ?? 300, y ?? B.GATE.y, 30, 320, 'c'); pop(x ?? 300, (y ?? B.GATE.y) - 18, `+${v.pays.gate}`, col); }
            else if (e[0] === 't' && x !== null) burst(x, y + 4, 6, 120, 's');
          }
        }
        fxT = Math.max(fxT, T);
        for (let k = 0; k < a.b.length; k += 4) {
          let x = a.b[k + 2] / 2, y = a.b[k + 3] / 2;
          const j = next.get(a.b[k]);
          if (j !== undefined && u > 0) { const x2 = b.b[j + 2] / 2, y2 = b.b[j + 3] / 2; if (Math.abs(x2 - x) + Math.abs(y2 - y) < 60) { x += (x2 - x) * u; y += (y2 - y) * u; } }
          balls.push({ id: a.b[k], seat: a.b[k + 1], x, y });
          touch(x, y);
        }
        if (frames.length > 2 && frames[1].t < T - 1500) frames.shift();
      }
      trails(balls);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const q of balls) { const s = ballSprite(colorFor(q.seat)); ctx.drawImage(s, q.x * scale - s.width / 2, q.y * scale - s.height / 2); }
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      confetti(dt);
      bulbs(now, fever);
      eyes(now, balls, fever);
      shout(now);
      raf = requestAnimationFrame(frame);
    }
    // sunburst rays from the window, turning (fast and in every colour in a fever)
    function rays(now, fever) {
      const acc = look['--bjAccent'] || '#22c08a', hi = look['--bjHi'] || '#f6e7b0', n = 18;
      const turn = calm ? 0 : now / (fever ? 900 : 9000);
      ctx.save(); boardPath(ctx); ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const a0 = turn + (i / n) * Math.PI * 2, a1 = a0 + Math.PI / n;
        ctx.fillStyle = fever ? `hsla(${(i * 40 + now / 8) % 360}, 90%, 60%, .16)` : hexA(i % 2 ? acc : hi, 0.07);
        ctx.beginPath(); ctx.moveTo(300, 330); ctx.arc(300, 330, 900, a0, a1); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    // the drain: a black hole, swirling
    function blackHole(now) {
      const x = 300, y = B.DRAIN.y + 4, t = calm ? 0 : now / 700;
      const g = ctx.createRadialGradient(x, y, 2, x, y, 46); g.addColorStop(0, '#000'); g.addColorStop(0.6, 'rgba(40,0,70,.85)'); g.addColorStop(1, 'rgba(120,40,200,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y, 46, 16, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(190,140,255,.5)'; ctx.lineWidth = 1.5;
      for (let k = 0; k < 3; k++) { ctx.beginPath(); for (let s = 0; s < 1; s += 0.05) { const a = t + k * 2.1 + s * 5, r = 40 * (1 - s); ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.34); } ctx.stroke(); }
    }
    function pinGlow(dt) {
      if (!lit.size) return;
      const hi = look['--bjHi'] || '#f6e7b0', k = Math.exp(-dt / 260);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (const [i, b] of lit) {
        const p = B.pins[i];
        ctx.fillStyle = hexA(hi, 0.55 * b); ctx.beginPath(); ctx.arc(p[0], p[1], B.PIN + 5 * b, 0, 7); ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${0.9 * b})`; ctx.beginPath(); ctx.arc(p[0], p[1], B.PIN * 0.8, 0, 7); ctx.fill();
        if (b * k < 0.04) lit.delete(i); else lit.set(i, b * k);
      }
      ctx.restore();
    }
    const tracks = new Map();       // ball id -> its last places, for a trail
    function trails(balls) {
      const seen = new Set();
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
      for (const q of balls) {
        seen.add(q.id);
        const tr = tracks.get(q.id) || []; tr.push([q.x, q.y]); if (tr.length > 9) tr.shift(); tracks.set(q.id, tr);
        const col = colorFor(q.seat);
        for (let i = 1; i < tr.length; i++) { if (Math.abs(tr[i][0] - tr[i - 1][0]) + Math.abs(tr[i][1] - tr[i - 1][1]) > 40) continue; ctx.strokeStyle = hexA(col, (i / tr.length) * 0.5); ctx.lineWidth = B.BALL * 1.6 * (i / tr.length); ctx.beginPath(); ctx.moveTo(tr[i - 1][0], tr[i - 1][1]); ctx.lineTo(tr[i][0], tr[i][1]); ctx.stroke(); }
      }
      ctx.restore();
      for (const id of [...tracks.keys()]) if (!seen.has(id)) tracks.delete(id);
    }
    function confetti(dt) {
      const s = dt / 1000;
      for (const q of bits) {
        q.life += dt; q.vy += 520 * s; q.vx *= 0.985; q.x += q.vx * s; q.y += q.vy * s; q.spin += s * 9;
        const f = 1 - q.life / q.max; if (f <= 0) continue;
        ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.spin); ctx.globalAlpha = Math.min(1, f * 1.6); ctx.fillStyle = q.col;
        if (q.kind === 'p') { ctx.beginPath(); ctx.ellipse(0, 0, 4, 2, 0, 0, 7); ctx.fill(); }       // petals
        else if (q.kind === 's') { ctx.fillRect(-1, -3, 2, 6); ctx.fillRect(-3, -1, 6, 2); }       // sparks
        else ctx.fillRect(-3, -1.5, 6, 3);       // confetti
        ctx.restore();
      }
      bits = bits.filter((q) => q.life < q.max);
      for (const p of pops) {
        p.life += dt; const f = p.life / 1100; if (f >= 1) continue;
        const y = p.y - 46 * f, sc = 1 + 0.5 * Math.sin(Math.min(1, f * 4) * Math.PI);
        ctx.save(); ctx.translate(p.x + Math.sin(p.life / 60) * 2, y); ctx.scale(sc, sc); ctx.globalAlpha = f > 0.7 ? (1 - f) / 0.3 : 1;
        ctx.font = '900 17px "Segoe UI Variable Display", "Segoe UI", system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 4; ctx.strokeStyle = '#1a1230'; ctx.strokeText(p.text, 0, 0); ctx.fillStyle = p.col; ctx.fillText(p.text, 0, 0);
        ctx.restore();
      }
      pops = pops.filter((p) => p.life < 1100);
    }
    // chasing bulbs round the rim and the window's arch (in a fever: every colour, strobing)
    function bulbs(now, fever) {
      const step = Math.floor(now / (fever ? 70 : 220)), n = 46;
      for (let i = 0; i <= n; i++) {
        const a = Math.PI + (i / n) * Math.PI, x = B.ARC.x + (B.ARC.r - 10) * Math.cos(a), y = B.ARC.y + (B.ARC.r - 10) * Math.sin(a);
        bulb(x, y, (i + step) % 3 === 0, fever ? `hsl(${(i * 25 + now / 5) % 360},100%,65%)` : i % 2 ? '#ffd84a' : '#ff6fb5');
      }
      for (let i = 0; i <= 14; i++) { const f = i / 14; bulb(B.WIN.x + f * B.WIN.w, roofY(f) - 4, (i + step) % 2 === 0, fever ? `hsl(${(i * 40 + now / 4) % 360},100%,65%)` : '#fff3d6'); }
    }
    function bulb(x, y, on, col) {
      if (on) { ctx.globalAlpha = 0.35; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
      ctx.fillStyle = on ? col : 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 7); ctx.fill();
    }
    // googly eyes in the window's arch: they follow your newest ball (anyone's, if you have none), blink now and then, and
    // spin round in a fever
    let blinkAt = 0;
    function eyes(now, balls, fever) {
      const mineB = balls.filter((q) => q.seat === (v ? v.you : -1)), target = (mineB.length ? mineB : balls).reduce((a, q) => (!a || q.id > a.id ? q : a), null);
      if (now > blinkAt + 4200) blinkAt = now + Math.random() * 2000;
      const blink = now > blinkAt && now < blinkAt + 140;
      for (const ex of [266, 334]) {
        const ey = 214, r = 15;
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#1a1230'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(ex, ey, r, 0, 7); ctx.fill(); ctx.stroke();
        if (blink) { ctx.fillStyle = '#ff6fb5'; ctx.beginPath(); ctx.arc(ex, ey, r, 0, 7); ctx.fill(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(ex - r + 2, ey); ctx.lineTo(ex + r - 2, ey); ctx.stroke(); continue; }
        let a, d = r - 7;
        if (fever && !calm) a = now / 90 + (ex > 300 ? Math.PI : 0);
        else if (target) a = Math.atan2(target.y - ey, target.x - ex);
        else { a = Math.PI / 2; d = 3; }
        const jig = calm ? 0 : Math.sin(now / 37 + ex) * 0.6;
        ctx.fillStyle = '#1a1230'; ctx.beginPath(); ctx.arc(ex + Math.cos(a) * d + jig, ey + Math.sin(a) * d, 6.5, 0, 7); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(ex + Math.cos(a) * d - 2, ey + Math.sin(a) * d - 2, 1.8, 0, 7); ctx.fill();
      }
    }
    // "REACH!" and "FEVER!!" right across the glass, bouncing in
    function shout(now) {
      const f = feverAt && now - feverAt < 2600 ? (now - feverAt) / 2600 : -1, r = reachAt && now - reachAt < 1600 ? (now - reachAt) / 1600 : -1;
      const one = (text, t, size, cols, y) => {
        const inn = Math.min(1, t * 5), bounce = 1 + Math.sin(inn * Math.PI) * 0.35, out = t > 0.8 ? (1 - t) / 0.2 : 1;
        ctx.save(); ctx.translate(300, y); ctx.rotate(-0.12 + Math.sin(now / 120) * 0.03); ctx.scale(inn * bounce, inn * bounce); ctx.globalAlpha = out;
        ctx.font = `900 ${size}px "Segoe UI Variable Display", "Segoe UI", system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 12; ctx.strokeStyle = '#1a1230'; ctx.strokeText(text, 0, 0);
        const g = ctx.createLinearGradient(-200, 0, 200, 0); cols.forEach((c, i) => g.addColorStop(i / (cols.length - 1), c));
        ctx.fillStyle = g; ctx.fillText(text, 0, 0);
        ctx.restore();
      };
      if (f >= 0) one('FEVER!!', f, 92, PARTY.map((c, i) => `hsl(${(i * 60 + now / 3) % 360},100%,62%)`), 560);
      else if (r >= 0) one('REACH!', r, 70, ['#ffd84a', '#ff6fb5', '#ffd84a'], 520);
    }
    const run = () => { if (!raf) raf = requestAnimationFrame(frame); };
    // what moves on the board itself: the tulips blooming, the gate's mouth, where your shot will drop
    const tulipOpen = [0, 0];       // 0..1, easing to what the table says
    function dynamic(now) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      (v.tulips || []).forEach((open, k) => {
        const t = B.TULIPS[k], o = tulipOpen[k] += ((open ? 1 : 0) - tulipOpen[k]) * 0.2, sway = calm ? 0 : Math.sin(now / 400 + k) * 0.06;
        for (const side of [-1, 1]) {       // two petals, swinging out as it opens (where the table's petals are)
          ctx.save(); ctx.translate(t.x + side * t.half, t.y - 2); ctx.rotate(side * (0.15 + o * 0.75) + sway);
          const pg = ctx.createLinearGradient(0, -20, 0, 0); pg.addColorStop(0, '#ff9ccc'); pg.addColorStop(1, '#e0246e');
          ctx.fillStyle = pg; ctx.strokeStyle = '#6a0d34'; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.bezierCurveTo(side * 9, -6, side * 7, -18, 0, -21); ctx.bezierCurveTo(-side * 4, -14, -side * 3, -5, 0, 0); ctx.fill(); ctx.stroke();
          ctx.restore();
        }
        if (o > 0.5) { ctx.fillStyle = hexA('#ffd84a', (o - 0.5) * 1.6); ctx.beginPath(); ctx.arc(t.x, t.y - 1, 3, 0, 7); ctx.fill(); }       // (the middle showing)
      });
      mouth(now, !!(v.fever && v.fever.open));
      if (!frames.length) trampoline(B.trampAt(Date.now()).x, 0, now);       // (before any balls: still there)
      if (aim !== null && me()) {       // a mark on the rail: about where this power sends a ball over
        const a = Math.PI * (2 - aim), pulse = calm ? 1 : 0.7 + 0.3 * Math.sin(now / 160);
        ctx.strokeStyle = hexA(selfColor, 0.9 * pulse); ctx.lineWidth = 6;
        ctx.beginPath(); ctx.arc(B.ARC.x, B.ARC.y, B.ARC.r - 8, a - 0.06, a + 0.06); ctx.stroke();
      }
    }
    // The gate is a big cartoon mouth. Shut, it's asleep: a lazy smile, with a "z" now and then (balls go straight past).
    // Open in a fever, it's wide, with teeth and a tongue, chomping.
    function mouth(now, open) {
      const G = B.GATE, cx = (G.x1 + G.x2) / 2, w = (G.x2 - G.x1) / 2, y = G.y + 4;
      if (!open) {
        ctx.strokeStyle = 'rgba(255,111,181,.55)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(cx - w * 0.7, y); ctx.quadraticCurveTo(cx, y + 10, cx + w * 0.7, y); ctx.stroke();
        if (!calm) { const z = (now % 3000) / 3000; ctx.globalAlpha = Math.sin(z * Math.PI) * 0.6; ctx.fillStyle = '#fff3d6'; ctx.font = '900 12px "Segoe UI Variable Display", "Segoe UI", system-ui'; ctx.fillText('z', cx + w * 0.75 + z * 12, y - 6 - z * 22); ctx.globalAlpha = 1; }
        return;
      }
      const chomp = calm ? 1 : 0.75 + 0.25 * Math.sin(now / 110), hgt = 22 * chomp;
      ctx.fillStyle = '#3a0018'; ctx.strokeStyle = '#ff4f8b'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.ellipse(cx, y, w + 4, hgt, 0, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ff7aa8'; ctx.beginPath(); ctx.ellipse(cx, y + hgt * 0.55, w * 0.55, hgt * 0.4, 0, 0, 7); ctx.fill();       // the tongue
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 6; i++) { const x = cx - w * 0.75 + i * (w * 1.5 / 5); ctx.beginPath(); ctx.moveTo(x - 6, y - hgt + 3); ctx.lineTo(x + 6, y - hgt + 3); ctx.lineTo(x, y - hgt + 12); ctx.fill(); }       // teeth
      ctx.strokeStyle = 'rgba(255,216,74,.6)'; ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) { const r = w + 10 + ((now / 8 + i * 14) % 42); ctx.globalAlpha = 1 - (r - w - 10) / 42; ctx.beginPath(); ctx.ellipse(cx, y, r, r * 0.45, 0, Math.PI, 0); ctx.stroke(); }       // "over here!"
      ctx.globalAlpha = 1;
    }
    // The trampoline at x: two coiled springs, a striped mat between hard ends (dip 0..1: just landed on)
    function trampoline(x, dip, now) {
      const T0 = B.TRAMP, y = T0.y, h = T0.half;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#c8ccd6'; ctx.lineWidth = 1.6;       // the springs, squashed as it takes a ball
      for (const sx of [x - h + 7, x + h - 7]) { ctx.beginPath(); for (let i = 0; i <= 8; i++) ctx.lineTo(sx + (i % 2 ? 4 : -4), y + 2 + dip * 3 + i * (12 - dip * 3) / 8); ctx.stroke(); }
      ctx.save();
      ctx.beginPath(); ctx.moveTo(x - h, y - 2.5); ctx.quadraticCurveTo(x, y - 2.5 + 10 * dip, x + h, y - 2.5); ctx.lineTo(x + h, y + 2.5); ctx.quadraticCurveTo(x, y + 2.5 + 10 * dip, x - h, y + 2.5); ctx.closePath();
      ctx.clip();
      for (let i = -2; i < 12; i++) { ctx.fillStyle = i % 2 ? '#ff4f8b' : '#fff3d6'; ctx.fillRect(x - h + i * 6 - ((now / 30) % 12), y - 6, 6, 22); }
      ctx.restore();
      ctx.fillStyle = '#ffd84a'; ctx.strokeStyle = '#7a4b00'; ctx.lineWidth = 1;
      for (const ex of [x - h, x + h]) { ctx.beginPath(); ctx.arc(ex, y, 3.4, 0, 7); ctx.fill(); ctx.stroke(); }
    }
    // where on the arc a ball at power p leaves it (measured from pachinko.js: soft ones drop beside the lane, hard ones far left)
    function aimDraw() { const p = power / 100; aim = Math.max(0.02, Math.min(0.98, p < 0.4 ? 0.05 + p / 0.4 * 0.25 : 0.3 + (p - 0.4) / 0.6 * 0.7)); }
    aimDraw();

    // ---------- the machine's state ----------
    function draw() {
      if (!v) { holder.classList.remove('live'); return; }
      holder.classList.add('live');
      if (v.board && v.board !== B.rev) note('This machine is from a different Drift: the balls may not match its pins. Update Drift to play it properly.');
      sign.firstChild.textContent = mode === 'hub' ? 'Hub machine' : 'Just you';
      const n = v.seats.filter(Boolean).length;
      sign.lastChild.textContent = `${fmt(v.cost || 1)} chips a ball · ${n} at it`;
      reels();
      [...lights.children].forEach((d, i) => d.classList.toggle('on', i < v.spins));
      lights.title = v.spins ? `${v.spins} spin${v.spins === 1 ? '' : 's'} waiting` : '';
      payList.replaceChildren(el('div', 'paHead', 'Pays'), row('Start pocket', `+${v.pays.start} and a spin`), row('Tulip', `+${v.pays.tulip}`), row('Gate (in a fever)', `+${v.pays.gate}`),
        el('div', 'paSmall', 'Three of a kind is a fever for everyone at the machine. Sevens or the cat: the next spins hit more often.'));
      hotEl.classList.toggle('on', v.hot > 0); hotEl.textContent = v.hot > 0 ? `Hot! ${v.hot} lucky spin${v.hot === 1 ? '' : 's'} left` : '';
      feverDraw();
      playersDraw();
      board();
      controls();
      holder.classList.toggle('fever', !!v.fever);
      holder.classList.toggle('big', !!(v.fever && v.fever.big));
      run();
    }
    const row = (a, b) => { const r = el('div', 'paRow'); r.append(el('span', '', a), el('b', '', b)); return r; };
    let shownSpin = -1;
    function reels() {
      const s = v.spin, list = s ? s.reels : v.reels || [6, 0, 6];       // (before the first spin: seven, cat, seven)
      reelEls.forEach((r, i) => {
        const spinning = !!(s && s.spinning[i]);
        r.classList.toggle('spin', spinning);
        r.classList.toggle('reach', !!(s && s.reach && i === 2 && spinning));
        const k = list ? list[i] : null, strip = r.firstChild, key = spinning ? 'spin' : String(k);
        if (strip.dataset.k !== key) { strip.dataset.k = key; strip.innerHTML = spinning ? NAMES.map((_, j) => symSvg(j)).join('') + symSvg(0) : k === null || k === undefined ? '' : symSvg(k); }
      });
      win.classList.toggle('reach', !!(s && s.reach && s.spinning[2]));
      win.classList.toggle('won', !!(s && s.won) || !!v.fever);
      if (s && s.n !== shownSpin && !s.spinning[2]) shownSpin = s.n;
      winLine.textContent = v.fever ? (v.fever.open ? `ROUND ${v.fever.round}/${v.fever.rounds} · ${v.fever.balls}/${v.fever.roundBalls}` : v.fever.round ? 'Next round…' : 'FEVER!')
        : s ? (s.reach && s.spinning[2] ? 'REACH!' : s.mine ? 'Your spin' : `${s.name}'s spin`) : v.spins ? '' : '';
    }
    function feverDraw() {
      const f = v.fever;
      feverEl.classList.toggle('on', !!f);
      if (!f) { feverEl.replaceChildren(); return; }
      const who = f.mine ? 'Your' : `${f.name}'s`;
      feverEl.replaceChildren(el('b', '', f.big ? 'BIG FEVER' : 'FEVER'), el('span', '', `${who} spin opened the gate for everyone.`),
        ...(f.gained ? [roll.num('pa:fv:' + f.name + f.round, f.gained, (n) => `You've won +${fmt(n)}`, { cls: 'paGain' })] : [el('span', 'paGain dim', 'Aim for the gate at the bottom')]));
    }
    function playersDraw() {
      const tags = v.seats.map((s, i) => {
        if (!s) return null;
        const t = el('div', 'bjTag paTag' + (i === v.you ? ' me' : '') + (s.outMs ? ' out' : '') + (s.left ? ' gone' : '') + (s.holding ? ' playing' : ''));
        t.style.setProperty('--c', colorFor(i));
        const ring = el('i', 'bjRing'), f = mode === 'hub' && !s.blocked && opts.face ? opts.face(s.id) : null;
        if (f) { ring.classList.add('av'); ring.append(f); }
        t.append(ring, el('span', 'nm', i === v.you ? 'You' : s.name), roll.num('pa:ch:' + s.id, s.chips, fmt, { cls: 'ch' }), ...(s.outMs ? [el('span', 'ex', 'Out of chips')] : s.holding ? [el('span', 'ex', '●')] : []));
        return t;
      }).filter(Boolean);
      players.replaceChildren(el('div', 'paHead', 'At the machine'), ...tags);
    }
    function board() {
      const list = mode === 'hub' && Array.isArray(v.records) ? v.records : null;
      boardEl.classList.toggle('on', !!list);
      if (!list) return;
      const mine = opts.me ? opts.me() : '';
      const rows = list.map((x, i) => {
        const r = el('div', 'bjBRow' + (x.id === mine ? ' me' : '') + (x.ago < 8000 ? ' fresh' : ''));
        const f = !x.blocked && opts.face ? opts.face(x.id) : null;
        r.append(el('b', 'rk', String(i + 1)), f || el('i', 'nf'), el('span', 'nm', x.id === mine ? 'You' : x.name), el('span', 'amt', '+' + fmt(x.win)));
        return r;
      });
      boardEl.replaceChildren(el('div', 'bjBHead', 'Biggest fevers'), ...(rows.length ? rows : [el('div', 'bjBNone', 'None yet. Win in a fever to get on the board.')]));
    }

    // ---------- what you can do ----------
    function controls() {
      const m = me(), kids = [];
      const btn = (label, cls, fn, off) => { const b = el('button', 'bjBtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.onclick = fn; b.disabled = !!off; return b; };
      let line = '';
      if (!m && v.watching >= 0) { line = `The machine is full. You're next for a place${v.watching ? ` (${v.watching + 1} in line)` : ''}.`; kids.push(btn('Leave the line', 'ghost', () => send({ op: 'stand' }))); }
      else if (!m) { const full = v.seats.every(Boolean); line = full ? 'You\'re watching. The machine is full.' : 'You\'re watching the machine.'; kids.push(btn(full ? 'Get in line' : 'Sit down', 'primary', () => send({ op: 'sit' }))); }
      else if (m.left) { line = 'You\'ve stood up. Your balls still in the air still pay.'; kids.push(btn('Sit back down', 'primary', () => send({ op: 'sit' }))); }
      else if (m.outMs) { line = `Out of chips. Back in with ${fmt(v.start)} in `; kids.push(el('b', 'bjCount out', String(Math.ceil(m.outMs / 1000)))); }
      else {
        const dial = el('label', 'paDial'), input = el('input'), lab = el('b', '', String(power));
        input.type = 'range'; input.min = '0'; input.max = '100'; input.value = String(power); input.title = 'How hard: softer drops on the right, harder carries round to the left (or the mouse wheel over the machine)';
        input.oninput = () => setPower(+input.value);
        input.style.setProperty('--fill', power + '%');
        dial.append(el('span', '', 'Power'), input, lab);
        const h = btn(holding ? 'Playing…' : 'Hold to play', 'paHold' + (holding ? '' : ' primary'), null);
        h.onpointerdown = (e) => { if (e.button === 0) { capture(h, e); hold(true); } };
        h.onpointerup = up; h.onpointercancel = up; h.onlostpointercapture = up;
        h.title = `Hold to send balls (${fmt(v.cost || 1)} chips each), or hold the mouse down on the machine`;
        kids.push(dial, h, el('span', 'bjAmt', `${fmt(m.chips)} chips`));
        kids.push(btn('Stand up', 'ghost', () => { hold(false); send({ op: 'stand' }); }));
      }
      // The views come many times a second: rebuilding the bar each time would drop the dial you're dragging or the button
      // you're holding. So it's only rebuilt when what's in it changes; otherwise the count is brought up to date.
      const key = line ? 'l:' + line.replace(/\d+/g, '#') : 'play';
      if (key === bar.dataset.key) {
        const a = bar.querySelector('.bjAmt'); if (a && m) a.textContent = `${fmt(m.chips)} chips`;
        const h = bar.querySelector('.paHold'); if (h) { h.textContent = holding ? 'Playing…' : 'Hold to play'; h.classList.toggle('primary', !holding); }
        return;
      }
      bar.dataset.key = key;
      bar.replaceChildren(...(line ? [el('span', 'bjLine', line)] : []), ...kids);
    }
    function tickTimers() {
      if (!v) return;
      const m = me();
      if (m && m.outMs) { const o = bar.querySelector('.bjCount.out'), ms = Math.max(0, m.outMs - (Date.now() - got)); if (o) o.textContent = String(Math.ceil(ms / 1000)); }
    }
    setInterval(tickTimers, 200);
    function note(text) {
      noteEl.textContent = text; noteEl.classList.add('on');
      clearTimeout(noteTimer); noteTimer = setTimeout(() => noteEl.classList.remove('on'), 3200);
    }

    // colour helpers
    function hexRgb(h) { h = String(h || '#000').replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const n = parseInt(h.slice(0, 6), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    function mix(a, b, t) { const x = hexRgb(a), y = hexRgb(b); return '#' + x.map((v0, i) => Math.round(v0 + (y[i] - v0) * t).toString(16).padStart(2, '0')).join(''); }
    function hexA(h, a) { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; }
    addEventListener('resize', () => { still = null; sprites.clear(); });

    let fxTimer = 0;
    return {
      view(nv, m) {
        const was = v;
        // (the view comes LAG ahead of the balls you see: shown when they are, so a pocket's pay lands with its ball)
        const show = () => {
          v = nv; mode = m || ''; got = Date.now();
          if (!v) { frames = []; off = null; if (holding) { holding = false; holder.classList.remove('holding'); } holder.classList.remove('live', 'fever', 'big'); return; }
          if (was && !was.fever && v.fever) {       // a fever: the lamp, the banner, a blast of confetti, and the cabinet jumps
            feverAt = performance.now(); burst(300, 330, 140, 560, 'c'); burst(300, 600, 60, 420, 's');
            holder.classList.remove('fWin', 'shake'); void holder.offsetWidth; holder.classList.add('fWin'); if (!calm) holder.classList.add('shake');
            clearTimeout(fxTimer); fxTimer = setTimeout(() => holder.classList.remove('fWin', 'shake'), 2600);
          }
          if (v.spin && v.spin.reach && !(was && was.spin && was.spin.n === v.spin.n && was.spin.reach)) reachAt = performance.now();
          if (holding && !canPlay()) { holding = false; holder.classList.remove('holding'); }
          draw();
        };
        if (!nv || !was) show(); else setTimeout(show, LAG);
      },
      ink, note,
      colors(c) {
        colorOf = c.colorOf || colorOf; selfColor = c.self || selfColor;
        for (const [k, val] of Object.entries(c.vars || {})) { holder.style.setProperty(k, val); look[k] = val; }
        still = null; sprites.clear();
        if (v) draw();
      },
      box() { const r = cab.getBoundingClientRect(); return r.width ? { l: r.left, t: r.top, w: r.width, h: r.height } : null; },
      felt: cab,
      state: () => v,
      _frames: () => frames, _power: () => power, _hold: hold,       // (tests)
    };
  };
})();
