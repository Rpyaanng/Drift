/* Drift — the crane machine scene (docs/plans/crane.md). It only draws: the rules, the claw and the prizes are in crane.js, run
   in main.js alone or on the hub with friends. What it gets is the machine as you see it (view) and the claw and the prizes as
   frames (ink: every 1/30 s that something moved, each prize's place and the claw's). Your moves go back through
   send({ op, ... }), which app.js passes on.
     const t = window.driftCrane(holder, send, { face, me })   t.view(v, mode)   t.ink({ rev, from, list })   t.note(text)   t.colors(...)   t.box()
   The cabinet is in the middle: a glass box of cat plushes with the grand prize (a gift box) on top, the claw on its rail, the
   chute front left. Put in a try, and the claw sweeps back and forth by itself: Drop (or Space) as it passes over what you want. One seat: at a hub everyone else
   watches, in line for a go. Names come from the hub, so they're put in with textContent, never as markup. */
(() => {
  const B = window.driftCraneBoard;
  const LAG = 110;       // ms the claw and the prizes are drawn behind the newest frame, so a late one doesn't make them stutter
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const fmt = (n) => Math.round(n).toLocaleString();
  const roll = window.driftRoll;
  // The plushes are Drift's cat (its outline: #coCat's body in renderer/index.html), round and soft, in a few colours. The
  // first is the cat's own green.
  const CAT = new Path2D('M345 355C340 250 380 150 440 125C510 105 590 160 645 225C710 205 790 205 845 225C900 160 980 105 1050 125C1110 150 1145 250 1140 355C1220 430 1260 560 1245 660C1230 760 1170 820 1080 835C900 860 600 860 420 835C320 820 250 740 240 620C235 520 270 420 345 355Z');
  const CAT_MID = [742, 486], CAT_W = 1005;
  const FURS = [['#22c08a', '#128a62'], ['#ff9a3c', '#c2611a'], ['#ff8fc0', '#c9548a'], ['#b98cff', '#7451c4'], ['#f6e7b0', '#c4a964'], ['#8fb6e0', '#55779e'], ['#4a4458', '#25212f']];
  const INK = '#1a1230';

  window.driftCrane = (holder, send, opts = {}) => {
    holder.innerHTML = '';
    const lampEl = el('div', 'bjLamp'), cab = el('div', 'crCab'), bar = el('div', 'bjBar'), noteEl = el('div', 'bjNote'), boardEl = el('div', 'bjBoard');
    const side = el('div', 'crSide'), players = el('div', 'crPlayers');
    holder.append(lampEl, cab, side, players, bar, noteEl, boardEl);
    const trim = el('div', 'crTrim'), marquee = el('div', 'crMarquee'), glass = el('div', 'crGlass'), canvas = el('canvas', 'crCanvas'), base = el('div', 'crBase'), door = el('div', 'crDoor');
    marquee.innerHTML = window.driftMark || ''; marquee.append(el('span', '', 'DRIFT CRANE'));       // (fixed markup: Drift's mark, from renderer/blackjack.js)
    door.append(el('span', '', 'PRIZE'));
    const clock = el('div', 'crClock');
    glass.append(canvas, clock);
    base.append(door);
    cab.append(trim, marquee, glass, base);
    const sign = el('div', 'bjSign crSign'); sign.append(el('div', 'bjMode'), el('div', 'bjLimits'));
    const payList = el('div', 'crPays'), histEl = el('div', 'crHist');
    side.append(sign, payList, histEl);

    let v = null, mode = '', got = 0, noteTimer = 0, colorOf = () => '#9fe3c8', selfColor = '#22c08a', look = {};
    const me = () => (v && v.you >= 0 ? v.seats[v.you] : null);
    const myGo = () => !!(v && v.play && v.play.mine);
    const sweeping = () => myGo() && v.step === 'move';

    // ---------- timing: the claw sweeps by itself; Drop (or Space, or a press on the glass) brings it down ----------
    // What goes with it is the moment on the table's clock this screen was showing (shownT), so the claw comes down where you
    // saw it, not where it had got to by the time the press arrived (crane.js allows half a second of that).
    // (worked out at the press, from the frames' clock, not kept from the last picture drawn: a window in the background draws
    // seldom, and an old value would put the claw half a second back)
    const shownT = () => (frames.length && off !== null ? Math.min(performance.now() + off - LAG, frames[frames.length - 1].t) : 0);
    let dropped = -1;
    function drop() {
      if (!sweeping() || dropped === v.play.n) return;
      dropped = v.play.n;
      send({ op: 'move', m: { do: 'drop', amount: Math.round(shownT()) } });
      holder.classList.add('dropping'); setTimeout(() => holder.classList.remove('dropping'), 300);
      controls();
    }
    glass.addEventListener('pointerdown', (e) => { if (e.button === 0 && sweeping()) { e.preventDefault(); drop(); } });
    // The keys are the machine's while the claw is sweeping for you (otherwise they do what they always do)
    const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    addEventListener('keydown', (e) => {
      if (!holder.classList.contains('on') || !sweeping() || typing(e.target) || document.querySelector('#panel.open.show')) return;
      if (e.key === ' ' || e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) drop(); }
    }, true);

    // ---------- the canvas ----------
    const ctx = canvas.getContext('2d');
    let back = null, front = null, scale = 1;
    function size() {
      const r = glass.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      if (!r.width) return false;
      const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; back = null; sprites.clear(); }
      scale = w / B.W;
      return true;
    }
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;       // (no turning, shaking or showers)
    function layer() { const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; const x = c.getContext('2d'); x.setTransform(scale, 0, 0, scale, 0, 0); return [c, x]; }
    const FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui';
    // The look: the carnival of the Pachinko machine next door. Two pictures drawn once (the back wall behind; the chute's
    // acrylic, the chrome and the glass's shine in front), and each frame between and over them: sunburst rays turning behind
    // the pile, a spotlight from the claw down to where it'll land, the claw on its rail, the plushes (their eyes follow the
    // claw; the one it's holding beams), the gift box glittering, confetti and "+1,000"s at the chute, chasing bulbs round the
    // top, and "GRAND PRIZE!!" right across the glass.
    function paintStill() {
      const acc = look['--bjAccent'] || '#22c08a', hi = look['--bjHi'] || '#f6e7b0', dark = look['--bjDark'] || '#101018';
      let c;
      // ---- behind: the back wall, deep and bright at once ----
      [back, c] = layer();
      const g = c.createLinearGradient(0, 0, 0, B.H);
      g.addColorStop(0, mix(mix(dark, '#5a2a8a', 0.55), '#ffffff', 0.06)); g.addColorStop(0.6, mix(dark, '#1a3a6a', 0.5)); g.addColorStop(1, mix(dark, '#000000', 0.3));
      c.fillStyle = g; c.fillRect(0, 0, B.W, B.H);
      const SX = B.W / 600, SY = B.H / 800;       // (the decorations were laid out on a 600 × 800 box)
      const glow = c.createRadialGradient(B.VALLEY, B.FLOOR - 160, 30, B.VALLEY, B.FLOOR - 160, 420 * SX); glow.addColorStop(0, hexA(hi, 0.3)); glow.addColorStop(0.45, hexA(acc, 0.12)); glow.addColorStop(1, hexA(acc, 0));
      c.fillStyle = glow; c.fillRect(0, 0, B.W, B.H);
      for (let y = 20, r = 0; y < B.H; y += 30, r++) for (let x = r % 2 ? 15 : 30; x < B.W; x += 30) { c.fillStyle = hexA(r % 3 ? hi : acc, 0.06); c.beginPath(); c.arc(x, y, 3.2, 0, 7); c.fill(); }       // polka dots
      const star = (x, y, rr, col) => { c.fillStyle = col; c.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? rr * 0.45 : rr; c.lineTo(x + q * Math.cos(a), y + q * Math.sin(a)); } c.closePath(); c.fill(); };
      for (const [x, y, rr, col] of [[90, 240, 14, '#ffd84a'], [520, 200, 11, '#ff6fb5'], [210, 380, 9, '#6fe8ff'], [470, 340, 13, '#b98cff'], [300, 150, 10, '#ff6fb5'], [80, 470, 12, '#ffd84a'], [560, 450, 9, '#6fe8ff']]) star(x * SX, y * SY, rr * SX, hexA(col, 0.22));
      // the floor under the pile: a glittery mat
      const fl = c.createLinearGradient(0, B.FLOOR - 20, 0, B.H); fl.addColorStop(0, mix(dark, '#ff4f8b', 0.25)); fl.addColorStop(1, mix(dark, '#000000', 0.4));
      c.fillStyle = fl; c.fillRect(B.CHUTE.x2, B.FLOOR, B.WALL.r - B.CHUTE.x2, B.H - B.FLOOR);
      for (let i = 0; i < 120; i++) { const x = B.CHUTE.x2 + ((i * 97) % (B.WALL.r - B.CHUTE.x2)), y = B.FLOOR + 4 + ((i * 53) % (B.H - B.FLOOR - 8)); c.fillStyle = hexA(i % 2 ? hi : '#ffffff', 0.25); c.fillRect(x, y, 1.6, 1.6); }
      // the chute's inside: a dark well going down to the door
      const cw = c.createLinearGradient(0, B.CHUTE.top, 0, B.H); cw.addColorStop(0, 'rgba(0,0,0,.15)'); cw.addColorStop(1, 'rgba(0,0,0,.75)');
      c.fillStyle = cw; c.fillRect(B.CHUTE.x1, B.CHUTE.top, B.CHUTE.x2 - B.CHUTE.x1, B.H - B.CHUTE.top);
      // the rail across the top
      c.fillStyle = 'rgba(0,0,0,.5)'; c.fillRect(0, B.RAIL.y - 9, B.W, 20);
      const rg = c.createLinearGradient(0, B.RAIL.y - 8, 0, B.RAIL.y + 8); rg.addColorStop(0, '#f2f4f8'); rg.addColorStop(0.5, '#8a93a6'); rg.addColorStop(1, '#d4d8e2');
      c.fillStyle = rg; c.fillRect(0, B.RAIL.y - 7, B.W, 14);
      // ---- in front: the chute's acrylic guard and its sign, the glass's frame and shine ----
      [front, c] = layer();
      const G = B.CHUTE;
      c.fillStyle = 'rgba(190,230,255,.13)'; c.fillRect(G.x1, G.top, G.x2 - G.x1, B.H - G.top);       // the acrylic
      c.strokeStyle = 'rgba(220,245,255,.55)'; c.lineWidth = 2; c.strokeRect(G.x1 + 1, G.top, G.x2 - G.x1 - 2, B.H - G.top);
      c.save(); c.beginPath(); c.rect(G.x1, G.top - 10, G.x2 - G.x1 + 6, 12); c.clip();       // the guard's striped lip
      for (let i = -2; i < 20; i++) { c.fillStyle = i % 2 ? '#ff4f8b' : '#fff3d6'; c.beginPath(); c.moveTo(G.x1 + i * 10, G.top - 10); c.lineTo(G.x1 + i * 10 + 10, G.top - 10); c.lineTo(G.x1 + i * 10, G.top + 2); c.lineTo(G.x1 + i * 10 - 10, G.top + 2); c.fill(); }
      c.restore();
      c.fillStyle = '#c9d0dc'; c.fillRect(G.x2 - 3, G.top - 10, 6, B.FLOOR - G.top + 10);       // the guard's post
      c.save(); c.translate((G.x1 + G.x2) / 2, G.top + 60); c.rotate(-0.05);       // the sign
      c.fillStyle = '#ff4f8b'; c.strokeStyle = '#fff3d6'; c.lineWidth = 2; c.beginPath(); c.roundRect(-40, -15, 80, 30, 7); c.fill(); c.stroke();
      c.fillStyle = '#fff'; c.font = `900 15px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('PRIZE', 0, 1);
      c.beginPath(); c.moveTo(-8, 22); c.lineTo(8, 22); c.lineTo(0, 34); c.closePath(); c.fillStyle = '#ffd84a'; c.fill();
      c.restore();
      // the glass: two long streaks of shine and a darker edge
      c.save(); c.globalCompositeOperation = 'lighter';
      for (const [x0, w, a] of [[120, 46, 0.06], [190, 14, 0.07], [430, 30, 0.035]]) { const x = x0 * SX; c.fillStyle = `rgba(255,255,255,${a})`; c.beginPath(); c.moveTo(x, 0); c.lineTo(x + w, 0); c.lineTo(x + w - 260, B.H); c.lineTo(x - 260, B.H); c.closePath(); c.fill(); }
      c.restore();
      const edge = c.createLinearGradient(0, 0, B.W, 0); edge.addColorStop(0, 'rgba(0,0,0,.35)'); edge.addColorStop(0.06, 'rgba(0,0,0,0)'); edge.addColorStop(0.94, 'rgba(0,0,0,0)'); edge.addColorStop(1, 'rgba(0,0,0,.35)');
      c.fillStyle = edge; c.fillRect(0, 0, B.W, B.H);
    }
    // A plush in its colour, drawn once at this size (no face: the face goes on each frame, looking at the claw); r: its
    // radius (half the plushes are big ones: crane-board.js PLUSH.big)
    const sprites = new Map();
    function plushSprite(k, r) {
      let s = sprites.get(k + ':' + r); if (s) return s;
      const [fur, deep] = FURS[k % FURS.length], sc = (r * 2.25 / CAT_W) * scale, w = Math.ceil(CAT_W * sc + 10), h = Math.ceil(800 * sc + 10);
      s = document.createElement('canvas'); s.width = w; s.height = h;
      const c = s.getContext('2d');
      c.translate(w / 2, h / 2); c.scale(sc, sc); c.translate(-CAT_MID[0], -CAT_MID[1]);
      const g = c.createRadialGradient(620, 330, 40, 742, 486, 640); g.addColorStop(0, mix(fur, '#ffffff', 0.35)); g.addColorStop(0.55, fur); g.addColorStop(1, mix(fur, deep, 0.7));
      c.fillStyle = g; c.fill(CAT);
      c.fillStyle = hexA(deep, 0.85);       // the ears' insides
      for (const sx of [1, -1]) { c.save(); if (sx < 0) { c.translate(1485, 0); c.scale(-1, 1); } c.beginPath(); c.moveTo(450, 190); c.quadraticCurveTo(470, 150, 520, 180); c.lineTo(590, 245); c.quadraticCurveTo(500, 260, 460, 310); c.closePath(); c.fill(); c.restore(); }
      c.fillStyle = hexA(mix(fur, '#ffffff', 0.55), 0.7); c.beginPath(); c.ellipse(742, 700, 250, 130, 0, 0, 7); c.fill();       // the tummy
      c.strokeStyle = hexA(deep, 0.6); c.lineWidth = 14; c.setLineDash([26, 22]); c.beginPath(); c.moveTo(742, 230); c.lineTo(742, 330); c.stroke(); c.setLineDash([]);       // a seam
      c.strokeStyle = INK; c.lineWidth = 34; c.stroke(CAT);
      c.fillStyle = '#ff4f8b'; c.beginPath(); c.moveTo(1150, 740); c.lineTo(1220, 760); c.lineTo(1190, 830); c.lineTo(1130, 815); c.closePath(); c.fill();       // the little tag
      sprites.set(k + ':' + r, s);
      return s;
    }
    // the face on top: eyes that follow the claw (happy arcs when it's got them), a nose, a mouth, whiskers, cheeks
    function face(x, y, k, held, look2) {
      const sc = B.PLUSH.r * 2.25 / CAT_W, X = (px) => x + (px - CAT_MID[0]) * sc, Y = (py) => y + (py - CAT_MID[1]) * sc;
      const ink = k % FURS.length === 6 ? '#ffe08a' : INK;       // (the black cat's face is gold)
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const ex of [585, 900]) {
        const cx = X(ex), cy = Y(520);
        if (held) { ctx.strokeStyle = ink; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(cx, cy + 2, 4.2, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); continue; }
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx, cy, 5.4, 0, 7); ctx.fill();
        const a = Math.atan2(look2[1] - cy, look2[0] - cx), d = 2.1;
        ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 3.3, 0, 7); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d - 1.1, cy + Math.sin(a) * d - 1.2, 1, 0, 7); ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,111,181,.55)'; for (const ex of [520, 965]) { ctx.beginPath(); ctx.ellipse(X(ex), Y(620), 5, 3, 0, 0, 7); ctx.fill(); }
      ctx.fillStyle = '#ff6fb5'; ctx.beginPath(); ctx.moveTo(X(715), Y(585)); ctx.lineTo(X(770), Y(585)); ctx.lineTo(X(742), Y(612)); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(742), Y(612)); ctx.quadraticCurveTo(X(722), Y(650), X(700), Y(628)); ctx.moveTo(X(742), Y(612)); ctx.quadraticCurveTo(X(762), Y(650), X(784), Y(628)); ctx.stroke();
      ctx.strokeStyle = hexA(ink, 0.6); ctx.lineWidth = 1;
      for (const sx of [-1, 1]) for (const dy of [-6, 4]) { ctx.beginPath(); ctx.moveTo(X(742 + sx * 150), Y(610 + dy * 4)); ctx.lineTo(X(742 + sx * 330), Y(600 + dy * 9)); ctx.stroke(); }
    }
    // the grand prize: a gift box, gold with a pink ribbon and a bow, a "GRAND PRIZE" tag, twinkling
    function giftBox(x, y, now, held) {
      const w = B.BOX.hw, h = B.BOX.hh;
      const halo = ctx.createRadialGradient(x, y, 10, x, y, 90); halo.addColorStop(0, `rgba(255,216,74,${0.32 + 0.1 * Math.sin(now / 300)})`); halo.addColorStop(1, 'rgba(255,216,74,0)');
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, 90, 0, 7); ctx.fill();
      const g = ctx.createLinearGradient(x - w, y - h, x + w, y + h); g.addColorStop(0, '#fff1a8'); g.addColorStop(0.4, '#ffcf3a'); g.addColorStop(1, '#c98a10');
      ctx.fillStyle = g; ctx.strokeStyle = INK; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.roundRect(x - w, y - h + 12, w * 2, h * 2 - 12, 4); ctx.fill(); ctx.stroke();       // the box
      ctx.beginPath(); ctx.roundRect(x - w - 4, y - h, w * 2 + 8, 16, 4); ctx.fill(); ctx.stroke();       // the lid
      ctx.fillStyle = '#ff4f8b';       // the ribbon, both ways
      ctx.fillRect(x - 7, y - h + 1, 14, h * 2 - 2); ctx.fillRect(x - w + 1, y + 6, w * 2 - 2, 11);
      ctx.strokeStyle = '#9c1d55'; ctx.lineWidth = 1.2; ctx.strokeRect(x - 7, y - h + 1, 14, h * 2 - 2);
      // the bow
      ctx.fillStyle = '#ff6fa5'; ctx.strokeStyle = INK; ctx.lineWidth = 2;
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x, y - h); ctx.bezierCurveTo(x + sx * 10, y - h - 26, x + sx * 34, y - h - 18, x + sx * 26, y - h - 2); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      ctx.beginPath(); ctx.arc(x, y - h - 2, 5, 0, 7); ctx.fill(); ctx.stroke();
      // the tag
      ctx.save(); ctx.translate(x - w * 0.52, y - 3); ctx.rotate(-0.12);
      ctx.fillStyle = '#fff3d6'; ctx.strokeStyle = INK; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.roundRect(-16, -8, 32, 16, 3); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#c3313f'; ctx.font = `900 5.6px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('GRAND', 0, -2.6); ctx.fillText('PRIZE', 0, 3.6);
      ctx.restore();
      // twinkles
      if (!calm || held) for (let i = 0; i < 4; i++) {
        const t = (now / 900 + i * 0.27) % 1, a = Math.sin(t * Math.PI), px = x + Math.cos(i * 2.3 + 1) * (w + 8), py = y + Math.sin(i * 1.7 + 2) * (h + 6), r = 5 * a;
        ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.beginPath(); ctx.moveTo(px, py - r); ctx.lineTo(px + r * 0.25, py - r * 0.25); ctx.lineTo(px + r, py); ctx.lineTo(px + r * 0.25, py + r * 0.25); ctx.lineTo(px, py + r); ctx.lineTo(px - r * 0.25, py + r * 0.25); ctx.lineTo(px - r, py); ctx.lineTo(px - r * 0.25, py - r * 0.25); ctx.closePath(); ctx.fill();
      }
    }
    // The claw's head at (x, y) hanging from the carriage at cx, its prongs open by `o` (0 shut, 1 wide): the carriage on the
    // rail, the cable, the chrome head, and the arms, the head tilted with the swing (crane-board.js SWING). Drawn in two
    // goes: the arm behind before the prizes, the two in front after, so it holds what it holds.
    const tilt = (x, y, cx) => Math.asin(Math.max(-1, Math.min(1, (x - cx) / (y - B.RAIL.y + B.SWING.pivot))));
    function tilted(x, y, cx, draw) { const a = tilt(x, y, cx); ctx.save(); ctx.translate(x, y); ctx.rotate(-a); ctx.translate(-x, -y); draw(); ctx.restore(); }
    function clawBack(x, y, o, cx) {
      const C = B.CLAW, a = tilt(x, y, cx), ux = Math.sin(a), uy = Math.cos(a), hx = x - ux * 10, hy = y - uy * 10;       // (the cable meets the head's top)
      ctx.strokeStyle = '#2a2633'; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(cx - 2, B.RAIL.y + 12); ctx.lineTo(hx - 2 * uy, hy + 2 * ux); ctx.moveTo(cx + 2, B.RAIL.y + 12); ctx.lineTo(hx + 2 * uy, hy - 2 * ux); ctx.stroke();       // the cable
      const cg = ctx.createLinearGradient(0, B.RAIL.y - 12, 0, B.RAIL.y + 14); cg.addColorStop(0, '#ff6fa5'); cg.addColorStop(1, '#a8225e');
      ctx.fillStyle = cg; ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(cx - 24, B.RAIL.y - 12, 48, 26, 6); ctx.fill(); ctx.stroke();       // the carriage
      ctx.fillStyle = '#ffd84a'; for (const dx of [-14, 0, 14]) { ctx.beginPath(); ctx.arc(cx + dx, B.RAIL.y + 1, 2.6, 0, 7); ctx.fill(); }
      tilted(x, y, cx, () => arm(x, y, o, 0, C.reach * 0.86));       // the middle arm, behind
    }
    function clawFront(x, y, o, cx) {
      const C = B.CLAW;
      tilted(x, y, cx, () => {
        arm(x, y, o, -1, C.reach); arm(x, y, o, 1, C.reach);
        const hg = ctx.createRadialGradient(x - 6, y - 8, 2, x, y, 22); hg.addColorStop(0, '#ffffff'); hg.addColorStop(0.45, '#c4cad6'); hg.addColorStop(1, '#5a6070');
        ctx.fillStyle = hg; ctx.strokeStyle = INK; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(x - 18, y + 8); ctx.quadraticCurveTo(x - 20, y - 14, x, y - 15); ctx.quadraticCurveTo(x + 20, y - 14, x + 18, y + 8); ctx.closePath(); ctx.fill(); ctx.stroke();       // the head
        ctx.fillStyle = '#ff4f8b'; ctx.beginPath(); ctx.arc(x, y - 2, 4, 0, 7); ctx.fill();       // its light
      });
    }
    function arm(x, y, o, side, reach) {
      const spread = side ? 1 : 0.35;       // (open wide, the tips are a little wider than the box: crane.js holds it at 0.9)
      const ex = x + side * (12 + o * 34 * spread), ey = y + reach * 0.48, tx = x + side * (5 + o * 46 * spread), ty = y + reach;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const [w, col] of [[8, INK], [5, side ? '#d9dee8' : '#8e95a5'], [1.6, side ? '#ffffff' : '#b9bfcc']]) {
        ctx.strokeStyle = col; ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(x + side * 8, y + 4); ctx.lineTo(ex, ey); ctx.quadraticCurveTo(tx + side * 4, ty - 8, tx, ty); ctx.lineTo(tx - side * 7, ty - 3); ctx.stroke();       // (its tip hooks in)
      }
    }

    // confetti, sparks and "+1,000"s, in board units
    let bits = [], pops = [], fxT = 0, shoutAt = 0, shoutText = '', shoutBig = false;
    const PARTY = ['#ff4f8b', '#ffd84a', '#6fe8ff', '#b98cff', '#7dff9a', '#ff9a3c'];
    function burst(x, y, n, speed, kind) {
      if (calm) n = Math.ceil(n / 4);
      for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, s0 = speed * (0.4 + Math.random() * 0.8); bits.push({ x, y, vx: Math.cos(a) * s0, vy: Math.sin(a) * s0 - speed * 0.5, life: 0, max: 700 + Math.random() * 900, col: PARTY[i % PARTY.length], spin: Math.random() * 6, kind }); }
      if (bits.length > 600) bits.splice(0, bits.length - 600);
    }
    function pop(x, y, text, col) { pops.push({ x, y, text, col, life: 0 }); if (pops.length > 12) pops.shift(); }
    function shout(text, big) { shoutText = text; shoutBig = big; shoutAt = performance.now(); }

    // ---------- the frames: drawn LAG behind the newest, each prize between the two around now ----------
    let frames = [], off = null, raf = 0, lastTs = 0;
    function ink(m) {
      if (!m || !Array.isArray(m.list)) return;
      if (!m.list.length && m.from === 0) { frames = []; return; }
      for (const f of m.list) if (f && Number.isFinite(f.t) && Array.isArray(f.i) && Array.isArray(f.c) && (!frames.length || f.t > frames[frames.length - 1].t)) frames.push(f);
      const newest = frames.length ? frames[frames.length - 1].t : 0, cand = newest - performance.now();
      if (off === null || cand > off || cand < off - 2000) off = cand;
      if (frames.length > 90) frames.splice(0, frames.length - 90);
      run();
    }
    function frame(ts) {
      raf = 0;
      if (!holder.classList.contains('on') || !v) return;
      if (!size()) { raf = requestAnimationFrame(frame); return; }
      if (!back) paintStill();
      if (lastTs && off !== null) off -= (ts - lastTs) * 0.01;
      const dt = Math.min(100, lastTs ? ts - lastTs : 16);
      lastTs = ts;
      const now = performance.now();
      // where everything is: between the two frames around (now - LAG)
      let claw = { x: B.RAIL.home, y: B.CLAW.top, o: 0.55, cx: B.RAIL.home }, prizes = [];
      if (frames.length) {
        const T = off === null ? Infinity : now + off - LAG;        let i = frames.length - 1;
        while (i > 0 && frames[i].t > T) i--;
        const a = frames[i], b = frames[Math.min(frames.length - 1, i + 1)], u = b.t > a.t ? Math.max(0, Math.min(1, (T - a.t) / (b.t - a.t))) : 0;
        const lerp = (p, q) => p + (q - p) * u;
        claw = { x: lerp(a.c[0], b.c[0]) / 2, y: lerp(a.c[1], b.c[1]) / 2, o: lerp(a.c[2], b.c[2]) / 100 };
        claw.cx = a.c.length > 3 && b.c.length > 3 ? lerp(a.c[3], b.c[3]) / 2 : claw.x;       // (the carriage: an older machine has none apart from the head)
        // each prize: id, kind (1 the box, + 2 held, + 4 a big plush), x and y in half units, its angle in hundredths of a radian
        const S = 5, turn = (p, q) => p + (Math.atan2(Math.sin(q - p), Math.cos(q - p))) * u;       // (the short way round)
        const next = new Map(); for (let k = 0; k < b.i.length; k += S) next.set(b.i[k], k);
        for (let k = 0; k < a.i.length; k += S) {
          let x = a.i[k + 2] / 2, y = a.i[k + 3] / 2, ang = a.i[k + 4] / 100; const j = next.get(a.i[k]);
          if (j !== undefined && u > 0) { x = lerp(x, b.i[j + 2] / 2); y = lerp(y, b.i[j + 3] / 2); ang = turn(ang, b.i[j + 4] / 100); }
          const f = a.i[k + 1];
          prizes.push({ id: a.i[k], kind: f & 1, held: (f & 2) > 0, big: (f & 4) > 0, x, y, a: ang || 0 });
        }
        // what happened since the last frame drawn
        for (const f of frames) {
          if (f.t <= fxT || f.t > T) continue;
          for (const e of f.e || []) {
            if (e[0] === 'w') {
              const big = e[1] === 1, bigPlush = e[1] === 2, who = v.play ? v.play : v.last[0];       // (1 the box, 2 a big plush)
              burst((B.CHUTE.x1 + B.CHUTE.x2) / 2, B.CHUTE.top + 20, big ? 160 : bigPlush ? 100 : 60, big ? 560 : bigPlush ? 460 : 380, 'c');
              pop((B.CHUTE.x1 + B.CHUTE.x2) / 2 + 20, B.CHUTE.top - 30, `+${fmt(big ? v.pays.grand : bigPlush ? v.pays.big || v.pays.plush : v.pays.plush)}`, who && who.mine ? selfColor : '#ffd84a');
              shout(big ? 'GRAND PRIZE!!' : bigPlush ? (who && who.mine ? 'A BIG ONE!' : 'BIG ONE!') : who && who.mine ? 'YOU GOT ONE!' : 'GOT ONE!', big);
              holder.classList.remove('fWin', 'shake'); void holder.offsetWidth; holder.classList.add('fWin'); if (big && !calm) holder.classList.add('shake');
              clearTimeout(fxTimer); fxTimer = setTimeout(() => holder.classList.remove('fWin', 'shake'), 2600);
            } else if (e[0] === 's') { burst(e[2], e[3], 10, 140, 's'); shout('SO CLOSE!', false); }
            else if (e[0] === 'c') burst(e[1], e[2], 6, 90, 's');
            else if (e[0] === 'k') { burst(e[1], e[2], 18, 160, 's'); shout('HOOKED IT!', false); }       // (a prong caught on a tipped box's corner)
          }
        }
        fxT = Math.max(fxT, T);
        if (frames.length > 2 && frames[1].t < T - 1500) frames.shift();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(back, 0, 0);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      rays(now);
      beam(claw);
      clawBack(claw.x, claw.y, claw.o, claw.cx);
      const tip = [claw.x, claw.y + B.CLAW.reach];
      prizes.sort((p, q) => (p.held - q.held) || (p.y - q.y));       // (the lower in front; the one in the claw over the rest)
      for (const p of prizes) {
        if (p.kind) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.translate(-p.x, -p.y); giftBox(p.x, p.y, now, p.held); ctx.restore(); continue; }       // (at its angle: it tips)
        const r = p.big ? B.PLUSH.big : B.PLUSH.r, s = plushSprite(p.id, r), f = r / B.PLUSH.r;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const rot = p.a + (p.held && !calm ? Math.sin(now / 90 + p.id) * 0.06 : 0);       // (it rolls; in the claw it wobbles a little too)
        ctx.translate(p.x * scale, p.y * scale); ctx.rotate(rot); ctx.drawImage(s, -s.width / 2, -s.height / 2);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.translate(p.x, p.y); ctx.rotate(rot); ctx.scale(f, f); ctx.translate(-p.x, -p.y);       // (the face drawn at a plush's size, grown for a big one, turned with it)
        const c = Math.cos(-rot), sn = Math.sin(-rot), dx = (tip[0] - p.x) / f, dy = (tip[1] - p.y) / f;       // (the claw, as the turned face sees it)
        face(p.x, p.y, p.id, p.held, [p.x + dx * c - dy * sn, p.y + dx * sn + dy * c]);
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
      }
      clawFront(claw.x, claw.y, claw.o, claw.cx);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(front, 0, 0);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      confetti(dt);
      bulbs(now);
      shoutDraw(now);
      raf = requestAnimationFrame(frame);
    }
    // sunburst rays from behind the pile, turning slowly (fast and in every colour just after a grand prize)
    function rays(now) {
      const acc = look['--bjAccent'] || '#22c08a', hi = look['--bjHi'] || '#f6e7b0', n = 16, party = shoutBig && now - shoutAt < 3000;
      const turn = calm ? 0 : now / (party ? 900 : 12000);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const a0 = turn + (i / n) * Math.PI * 2, a1 = a0 + Math.PI / n;
        ctx.fillStyle = party ? `hsla(${(i * 40 + now / 8) % 360}, 90%, 60%, .14)` : hexA(i % 2 ? acc : hi, 0.06);
        ctx.beginPath(); ctx.moveTo(B.VALLEY, B.FLOOR - 120); ctx.arc(B.VALLEY, B.FLOOR - 120, 1200, a0, a1); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    // a spotlight from the claw down to the pile while it sweeps: where it'll come down
    function beam(c) {
      if (!v || v.step !== 'move') return;
      const g = ctx.createLinearGradient(0, c.y, 0, B.FLOOR);
      g.addColorStop(0, hexA(v.play && v.play.mine ? selfColor : '#fff3d6', 0.26)); g.addColorStop(1, hexA(v.play && v.play.mine ? selfColor : '#fff3d6', 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(c.x - 12, c.y + 10); ctx.lineTo(c.x + 12, c.y + 10); ctx.lineTo(c.x + 40, B.FLOOR); ctx.lineTo(c.x - 40, B.FLOOR); ctx.closePath(); ctx.fill();
    }
    function confetti(dt) {
      const s = dt / 1000;
      for (const q of bits) {
        q.life += dt; q.vy += 520 * s; q.vx *= 0.985; q.x += q.vx * s; q.y += q.vy * s; q.spin += s * 9;
        const f = 1 - q.life / q.max; if (f <= 0) continue;
        ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.spin); ctx.globalAlpha = Math.min(1, f * 1.6); ctx.fillStyle = q.col;
        if (q.kind === 's') { ctx.fillRect(-1, -3, 2, 6); ctx.fillRect(-3, -1, 6, 2); } else ctx.fillRect(-3.5, -1.8, 7, 3.6);
        ctx.restore();
      }
      bits = bits.filter((q) => q.life < q.max);
      for (const p of pops) {
        p.life += dt; const f = p.life / 1400; if (f >= 1) continue;
        const y = p.y - 50 * f, sc = 1 + 0.5 * Math.sin(Math.min(1, f * 4) * Math.PI);
        ctx.save(); ctx.translate(p.x + Math.sin(p.life / 60) * 2, y); ctx.scale(sc, sc); ctx.globalAlpha = f > 0.7 ? (1 - f) / 0.3 : 1;
        ctx.font = `900 24px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 5; ctx.strokeStyle = INK; ctx.strokeText(p.text, 0, 0); ctx.fillStyle = p.col; ctx.fillText(p.text, 0, 0);
        ctx.restore();
      }
      pops = pops.filter((p) => p.life < 1400);
    }
    // chasing bulbs along the top of the glass and down its sides (every colour, strobing, while the claw sweeps)
    function bulbs(now) {
      const busy = v && v.play, step = Math.floor(now / (busy ? 110 : 260));
      const pts = [];
      for (let i = 0; i <= 22; i++) pts.push([10 + i * (B.W - 20) / 22, 10]);
      for (let i = 1; i <= Math.floor((B.FLOOR - 40) / 48); i++) { pts.push([10, 10 + i * 48]); pts.push([B.W - 10, 10 + i * 48]); }
      pts.forEach(([x, y], i) => {
        const on = (i + step) % 3 === 0, col = busy && v.step === 'move' ? `hsl(${(i * 25 + now / 5) % 360},100%,65%)` : i % 2 ? '#ffd84a' : '#ff6fb5';
        if (on) { ctx.globalAlpha = 0.35; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
        ctx.fillStyle = on ? col : 'rgba(255,255,255,.2)'; ctx.beginPath(); ctx.arc(x, y, 2.8, 0, 7); ctx.fill();
      });
    }
    function shoutDraw(now) {
      const len = shoutBig ? 3000 : 1700, t = shoutAt && now - shoutAt < len ? (now - shoutAt) / len : -1;
      if (t < 0) return;
      const inn = Math.min(1, t * 5), bounce = 1 + Math.sin(inn * Math.PI) * 0.35, out = t > 0.8 ? (1 - t) / 0.2 : 1, size = shoutBig ? 70 : shoutText === 'SO CLOSE!' ? 48 : 58;
      ctx.save(); ctx.translate(B.W / 2, B.H * 0.41); ctx.rotate(-0.1 + Math.sin(now / 120) * 0.03); ctx.scale(inn * bounce, inn * bounce); ctx.globalAlpha = out;
      ctx.font = `900 ${size}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 11; ctx.strokeStyle = INK; ctx.strokeText(shoutText, 0, 0);
      const cols = shoutBig ? PARTY.map((c, i) => `hsl(${(i * 60 + now / 3) % 360},100%,62%)`) : shoutText === 'SO CLOSE!' ? ['#6fe8ff', '#b98cff', '#6fe8ff'] : ['#ffd84a', '#ff6fb5', '#ffd84a'];
      const g = ctx.createLinearGradient(-220, 0, 220, 0); cols.forEach((c, i) => g.addColorStop(i / (cols.length - 1), c));
      ctx.fillStyle = g; ctx.fillText(shoutText, 0, 0);
      ctx.restore();
    }
    const run = () => { if (!raf) raf = requestAnimationFrame(frame); };

    // ---------- the machine's state ----------
    function draw() {
      if (!v) { holder.classList.remove('live'); return; }
      holder.classList.add('live');
      if (v.board && v.board !== B.rev) note('This machine is from a different Drift: its prizes may not sit where you see them. Update Drift to play it properly.');
      sign.firstChild.textContent = mode === 'hub' ? 'Hub machine' : 'Just you';
      sign.lastChild.textContent = `${fmt(v.cost)} chips a try · one seat`;
      payList.replaceChildren(el('div', 'crHead', 'Prizes'), row('Cat plush', `+${fmt(v.pays.plush)}`), ...(v.pays.big ? [row('Big cat plush', `+${fmt(v.pays.big)}`)] : []), row('Grand prize box', `+${fmt(v.pays.grand)} and a token`),
        el('div', 'crSmall', 'The claw sweeps back and forth by itself: press Drop (or Space, or the glass) to stop it and bring it down. It hangs on a cable, so it slides on a little and swings as it goes down: learn the swing. Come down over the middle of a prize, and steady: the claw holds on best then (slow near the ends swings least). A gift box lying tipped is hard to hold, but its top corner is sticky: come down right on it and the claw hooks it. Whatever falls down the chute is yours.'));
      histDraw();
      playersDraw();
      board();
      controls();
      clockDraw();
      holder.classList.toggle('busy', !!v.play);
      run();
    }
    const row = (a, b) => { const r = el('div', 'crRow'); r.append(el('span', '', a), el('b', '', b)); return r; };
    function histDraw() {
      const what = (r) => (r.kinds.includes(1) ? (r.kinds.length > 1 ? 'the grand prize and more' : 'the grand prize') : r.kinds.length > 1 ? `${r.kinds.length} plushes` : r.kinds.length ? (r.kinds[0] === 2 ? 'a big plush' : 'a plush') : r.slipped ? 'it slipped' : r.missed ? 'nothing' : 'nothing');
      const rows = v.last.slice(0, 5).map((r) => { const d = el('div', 'crRow' + (r.won ? ' won' : '')); d.append(el('span', '', `${r.mine ? 'You' : r.name}: ${what(r)}`), el('b', '', r.won ? `+${fmt(r.won)}` : '')); return d; });
      histEl.classList.toggle('on', rows.length > 0);
      histEl.replaceChildren(el('div', 'crHead', 'Last tries'), ...rows);
    }
    function playersDraw() {
      const tags = v.seats.map((s, i) => {
        if (!s) return null;
        const t = el('div', 'bjTag crTag' + (i === v.you ? ' me' : '') + (s.left ? ' gone' : '') + (v.play ? ' playing' : ''));
        t.style.setProperty('--c', i === v.you ? selfColor : colorOf(s.name || ''));
        const ring = el('i', 'bjRing'), f = mode === 'hub' && !s.blocked && opts.face ? opts.face(s.id) : null;
        if (f) { ring.classList.add('av'); ring.append(f); }
        t.append(ring, el('span', 'nm', i === v.you ? 'You' : s.name), roll.num('cr:ch:' + s.id, s.chips, fmt, { cls: 'ch' }), ...(v.play ? [el('span', 'ex', '●')] : []));
        return t;
      }).filter(Boolean);
      const line = (v.line || []).map((x, i) => el('div', 'crLine' + (i === v.watching ? ' me' : ''), `${i + 1}. ${i === v.watching ? 'You' : x.name}`));
      players.replaceChildren(el('div', 'crHead', 'At the claw'), ...(tags.length ? tags : [el('div', 'crSmall', 'Nobody. Sit down and have a go.')]),
        ...(line.length ? [el('div', 'crHead crHead2', 'In line'), ...line] : []));
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
      boardEl.replaceChildren(el('div', 'bjBHead', 'Best prizes'), ...(rows.length ? rows : [el('div', 'bjBNone', 'None yet. Win a prize to get on the board.')]));
    }
    // the time left to drop it, big on the glass
    function clockDraw() {
      const p = v && v.play, on = !!(p && v.step === 'move');
      clock.classList.toggle('on', on);
      if (on) { const s = Math.max(0, Math.ceil((p.msLeft - (Date.now() - got)) / 1000)); clock.textContent = String(s); clock.classList.toggle('low', s <= 5); }
    }

    // ---------- what you can do ----------
    // your scene tokens, beside your chips: kept on your own Drift, not the table's (app.js passes them in: tokens())
    const tokEl = el('span', 'bjAmt bjTok ico-tok', '0 tokens');
    tokEl.title = 'Your scene tokens: spend them at Scene Slots to unlock a scene';
    function tokens(n) { const t = `${fmt(n)} token${n === 1 ? '' : 's'}`; if (tokEl.textContent !== t) tokEl.textContent = t; }
    function controls() {
      const m = me(), kids = [];
      const btn = (label, cls, fn, off) => { const b = el('button', 'bjBtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.onclick = fn; b.disabled = !!off; return b; };
      let line = '', key = '';
      const playing = v.play && !v.play.mine ? v.play.name : '';
      if (!m && v.watching >= 0) { line = v.watching === 0 ? 'You\'re next for the claw.' : `You're in line for the claw (${v.watching + 1} in line).`; kids.push(btn('Leave the line', 'ghost', () => send({ op: 'stand' }))); }
      else if (!m) { const full = v.seats.every(Boolean); line = full ? `${playing || 'Someone'} has the claw. You're watching.` : 'You\'re watching the machine.'; kids.push(btn(full ? 'Get in line' : 'Sit down', 'primary', () => send({ op: 'sit' }))); }
      else if (m.left) { line = 'You\'ve stood up. What the claw wins is still yours.'; kids.push(btn('Sit back down', 'primary', () => send({ op: 'sit' }))); }
      else if (sweeping() && dropped !== v.play.n) {
        key = 'sweep';
        const d = btn('Drop!', 'primary crDrop', null);       // (on the press, not the click: a click comes when the button's let go, and timing is everything)
        d.onpointerdown = (e) => { if (e.button === 0) drop(); };
        d.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop(); } };
        kids.push(el('span', 'bjLine', 'Wait for it…'), d, el('span', 'bjAmt ico-chip', `${fmt(m.chips)} chips`), tokEl);
      } else if (myGo()) { line = v.step === 'down' || v.step === 'move' ? 'Down it goes…' : v.step === 'grab' ? 'Grab!' : v.step === 'settle' ? 'And…' : 'Bringing it home…'; key = 'go'; kids.push(el('span', 'bjAmt ico-chip', `${fmt(m.chips)} chips`), tokEl); }
      else {
        const short = m.chips < v.cost;
        key = 'ready' + (short ? 's' : '') + (v.idleMs ? 'i' : '');
        if (short) line = `A try is ${fmt(v.cost)} chips: win a few more at the other tables.`;
        kids.push(btn(`Play · ${fmt(v.cost)}`, 'primary crPlay', () => send({ op: 'move', m: { do: 'play' } }), short || !!v.play || v.step !== 'ready'), el('span', 'bjAmt ico-chip', `${fmt(m.chips)} chips`), tokEl);
        if (v.idleMs) kids.push(el('span', 'bjLine crPass', `Your go passes on in ${Math.ceil(v.idleMs / 1000)}`));
        kids.push(btn('Stand up', 'ghost', () => send({ op: 'stand' })));
      }
      // The views come often while the claw is busy: rebuilding the bar each time would drop the button you're holding. So it's
      // only rebuilt when what's in it changes; otherwise the counts are brought up to date.
      key = (line ? 'l:' + line.replace(/\d[\d,]*/g, '#') : '') + key + (v.play || v.step !== 'ready' ? '1' : '0');
      if (key === bar.dataset.key) {
        const a = bar.querySelector('.bjAmt'); if (a && m) a.textContent = `${fmt(m.chips)} chips`;
        const p = bar.querySelector('.crPass'); if (p) p.textContent = `Your go passes on in ${Math.ceil(v.idleMs / 1000)}`;
        return;
      }
      bar.dataset.key = key;
      bar.replaceChildren(...(line ? [el('span', 'bjLine', line)] : []), ...kids);
    }
    setInterval(() => { if (v && holder.classList.contains('on')) clockDraw(); }, 200);
    function note(text) {
      noteEl.textContent = text; noteEl.classList.add('on');
      clearTimeout(noteTimer); noteTimer = setTimeout(() => noteEl.classList.remove('on'), 3200);
    }

    // colour helpers
    function hexRgb(h) { h = String(h || '#000').replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const n = parseInt(h.slice(0, 6), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    function mix(a, b, t) { const x = hexRgb(a), y = hexRgb(b); return '#' + x.map((v0, i) => Math.round(v0 + (y[i] - v0) * t).toString(16).padStart(2, '0')).join(''); }
    function hexA(h, a) { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; }
    addEventListener('resize', () => { back = null; sprites.clear(); });

    let fxTimer = 0;
    return {
      view(nv, m) {
        const was = v;
        // (the view comes LAG ahead of the claw you see: shown when it is, so "Grab!" comes as it closes)
        const show = () => {
          v = nv; mode = m || ''; got = Date.now();
          if (!v) { frames = []; off = null; holder.classList.remove('live', 'busy'); return; }
          draw();
        };
        if (!nv || !was) show(); else setTimeout(show, LAG);
      },
      ink, note, tokens,
      colors(c) {
        colorOf = c.colorOf || colorOf; selfColor = c.self || selfColor;
        for (const [k, val] of Object.entries(c.vars || {})) { holder.style.setProperty(k, val); look[k] = val; }
        back = null; sprites.clear();
        if (v) draw();
      },
      box() { const r = cab.getBoundingClientRect(); return r.width ? { l: r.left, t: r.top, w: r.width, h: r.height } : null; },
      felt: cab,
      state: () => v,
      _frames: () => frames, _drop: drop,       // (tests)
    };
  };
})();
