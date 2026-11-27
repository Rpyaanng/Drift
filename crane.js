// Drift — the crane machine, the rules and the prizes (docs/plans/crane.md). A glass box full of cat plushes with a gift box on
// top (the grand prize), one claw, one seat. Pure, like pachinko.js: no Electron, no DOM, no timers of its own. Whoever runs it
// (main.js alone, hub.js for a hub) calls tick() often (every 50 ms): the claw and the prizes are worked out up to now, and each
// 1/30 s that anything moved is kept as a frame for the screens (ink(from), as Pachinko's balls go out).
//
//   const t = createTable({ now, rand, times, wallet });  t.sit(id, name)  t.move(id, { do: 'play' })  t.tick()
//
// A try costs `cost` chips (the casino's wallet: wallet.js). The claw sweeps back and forth over the pile by itself, and the
// game is timing: press Drop as it passes over what you want (or the clock drops it for you), and it closes on whatever it landed on, goes up, back over the chute and opens. Whatever falls down the
// chute is yours: a plush pays `plushPay`, the box `grandPay`. Whether the claw holds on is decided as it closes, by `rand`
// (crypto at a hub), and is likelier the nearer the middle of the prize it came down: a prize that won't hold slips out on
// the way, and if it slips near the chute it can still drop in. A prize won is replaced by a new one dropped in from the top.
// At a hub it's one machine: one player at a time, everyone else watching, in line for a go. With anyone waiting, the seat
// passes on after each try (or after a while of not playing).
const B = require('./renderer/crane-board.js');

const RULES = {
  start: 1000, cost: 5000, plushPay: 5000, grandPay: 20000,       // chips: a try, and what each prize pays
  plushGrip: 0.74, boxGrip: 0.2,     // the chance the claw holds a prize it came down on dead centre (less towards its edge: grip())
};
const TIMES = { move: 15000, late: 500, close: 650, hold: 250, release: 450, settleMin: 900, settleMax: 3500, idle: 25000 };
const PHYS = { g: 1500, dt: 1 / 120, e: 0.12, frame: 1000 / 30, keep: 45, iters: 3 };

function createTable(opts = {}) {
  const now = opts.now || (() => Date.now());
  const rand = opts.rand || ((n) => require('crypto').randomInt(n));
  const T = { ...TIMES, ...(opts.times || {}) }, R = { ...RULES, ...(opts.rules || {}) };
  const seats = [null];       // one seat
  const watchers = [];       // the line for it (and anyone just looking on is at the table without being in either)
  let version = 0, phase = 'idle', idleSince = now();
  const changed = () => { version++; };
  const seatOf = (id) => seats.findIndex((s) => s && s.id === id);

  // the prizes' own random numbers (where a new one comes in, a little shake): quick, seeded from `rand`
  let seed = (rand(2147483646) + 1) >>> 0;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

  // ------------------------------------------------------------------ the prizes
  // { id, kind: 0 a plush, 1 the box, x, y, vx, vy, held, gone }
  let items = [], nextId = 1;
  const half = (it) => (it.kind ? { w: B.BOX.hw, h: B.BOX.hh } : { w: B.PLUSH.r, h: B.PLUSH.r });
  const massOf = (it) => (it.held ? Infinity : it.kind ? B.BOX.mass : B.PLUSH.mass);
  function add(kind, x, y) { items.push({ id: nextId++, kind, x, y, vx: 0, vy: 0, held: false, gone: false, still: 0 }); nextId %= 60000; }
  for (const [kind, x, y] of B.PILE) add(kind, x + (rnd() - 0.5) * 8, y);

  // ------------------------------------------------------------------ the claw
  // step: 'ready' (waiting for a try), 'move' (sweeping, till Drop), 'down', 'grab' (closing), 'up', 'home', 'release', 'settle'
  const claw = { x: B.RAIL.home, y: B.CLAW.top, open: 0.55 };
  let step = 'ready', stepAt = 0, simT = now(), frameAt = simT, frames = [], seq = 0, events = [], lastSent = null, tries = 0, last = [];
  let go = null;       // the try going on: { n, id, name, at (when the sweep began), until (the clock while it sweeps), plan, item, slipAt, won, kinds, slipped, done }

  // ------------------------------------------------------------------ places
  function sit(id, name, keep) {
    id = String(id); name = String(name || '').slice(0, 24);
    const at = seatOf(id);
    if (at >= 0) { const s = seats[at]; s.name = name; if (s.left) { s.left = false; changed(); } return { seat: at }; }
    if (seats[0]) { if (!watchers.some((w) => w.id === id)) { watchers.push({ id, name }); changed(); } return { watching: true }; }
    const w = watchers.findIndex((x) => x.id === id); if (w >= 0) watchers.splice(w, 1);
    if (opts.wallet && opts.wallet.owns(id)) keep = opts.wallet.keep(id);       // (the casino's one wallet: wallet.js)
    // Not refilled here when it's short of a try: a wallet of 3,000 is still 3,000 at the other tables
    const s = { id, name, chips: keep && Number.isFinite(+keep.chips) ? Math.max(0, Math.floor(+keep.chips)) : R.start, outUntil: keep && +keep.outUntil > now() ? +keep.outUntil : 0,
      left: false, tries: 0, won: 0, since: now() };
    if (opts.wallet) opts.wallet.bind(s);
    seats[0] = s;
    if (phase === 'idle') { phase = step; simT = now(); frameAt = simT; lastSent = null; }
    changed();
    return { seat: 0 };
  }
  function leave(id) {
    id = String(id);
    const w = watchers.findIndex((x) => x.id === id);
    if (w >= 0) { watchers.splice(w, 1); changed(); }
    const at = seatOf(id); if (at < 0) return;
    const s = seats[at];
    if (go && go.id === id && !go.done) { s.left = true; if (step === 'move') to('down'); changed(); }       // the claw goes down where it is, and what it wins is still theirs
    else free();
  }
  function free() {
    seats[0] = null;
    const w = watchers.shift();
    if (w) sit(w.id, w.name);
    changed();
  }
  // With someone waiting, the seat passes on: to the back of the line with you (still at the machine, still in line)
  function passOn() {
    const s = seats[0]; if (!s || !watchers.length) return;
    seats[0] = null;
    const next = watchers.shift();
    if (!s.left) watchers.push({ id: s.id, name: s.name });
    sit(next.id, next.name);
  }

  // ------------------------------------------------------------------ moves
  function move(id, m) {
    m = m && typeof m === 'object' ? m : {};
    const s = seats[seatOf(String(id))];
    if (!s) return { error: watchers.some((w) => w.id === String(id)) ? 'Wait for your go' : 'Sit down first' };
    if (s.left) return { error: 'Sit back down first' };
    const what = String(m.do || '');
    if (what === 'play') {
      if (step !== 'ready' || go) return { error: 'The claw is busy' };
      if (s.chips < R.cost) return { error: `A try is ${R.cost.toLocaleString('en-US')} chips` };
      s.chips -= R.cost; s.tries++; s.since = now();
      go = { n: ++tries, id: s.id, name: s.name, at: simT, until: simT + T.move, plan: null, item: null, won: 0, kinds: [], slipped: false, done: false };
      to('move');
      return { ok: true };
    }
    if (!go || go.id !== s.id || go.done) return { error: 'Put in a try first' };
    if (what === 'drop') {
      if (step !== 'move') return { error: 'The claw is on its way' };
      // `amount`: the moment the screen was showing when you pressed (the table's clock), so your timing is what you saw, not
      // what the claw had got to by the time the press arrived. No earlier than `late` ago, and never in the future.
      const saw = Number.isFinite(+m.amount) && +m.amount > 0 ? Math.max(simT - T.late, Math.min(simT, +m.amount)) : simT;
      claw.x = B.sweepAt(saw - go.at);
      to('down'); return { ok: true };
    }
    return { error: 'Not a move' };
  }
  function to(st) { step = st; stepAt = simT; if (phase !== 'idle') phase = st; changed(); }

  // ------------------------------------------------------------------ the physics: round plushes, a box that never tips, the walls
  function push(a, b, nx, ny, over) {       // a and b overlap by `over` along the normal (from a to b): apart, and their speeds along it
    const ia = 1 / massOf(a), ib = b ? 1 / massOf(b) : 0, sum = ia + ib; if (!sum) return;
    const shove = a.held || (b && b.held);       // (a prize in the claw moves the others gently: they're pushed aside, not thrown)
    if (shove) over = Math.min(over, 3);
    a.x -= nx * over * ia / sum; a.y -= ny * over * ia / sum;
    if (b) { b.x += nx * over * ib / sum; b.y += ny * over * ib / sum; }
    const rv = ((b ? b.vx : 0) - a.vx) * nx + ((b ? b.vy : 0) - a.vy) * ny;
    if (rv < 0) {
      const j = -(1 + PHYS.e) * rv / sum;
      a.vx -= j * ia * nx; a.vy -= j * ia * ny;
      if (b) { b.vx += j * ib * nx; b.vy += j * ib * ny; }
      // plush is grippy: some of the sliding goes too
      const tx = -ny, ty = nx, rt = ((b ? b.vx : 0) - a.vx) * tx + ((b ? b.vy : 0) - a.vy) * ty, f = rt * 0.25 / sum;
      a.vx += f * ia * tx; a.vy += f * ia * ty;
      if (b) { b.vx -= f * ib * tx; b.vy -= f * ib * ty; }
    }
    if (shove) for (const q of [a, b]) { if (!q || q.held) continue; const sp = Math.hypot(q.vx, q.vy); if (sp > 260) { q.vx *= 260 / sp; q.vy *= 260 / sp; } }
    if (ny < -0.5 && !a.held) a.rest = true;       // a is sitting on something
    if (ny > 0.5 && b && !b.held) b.rest = true;
  }
  function pair(a, b) {
    if (!a.kind && !b.kind) {
      const dx = b.x - a.x, dy = b.y - a.y, r = 2 * B.PLUSH.r, d2 = dx * dx + dy * dy;
      if (d2 >= r * r) return;
      const d = Math.sqrt(d2) || 0.01;
      push(a, b, dx / d || 0, d2 ? dy / d : 1, r - d);
      return;
    }
    if (a.kind && b.kind) {
      const ha = half(a), hb = half(b), ox = ha.w + hb.w - Math.abs(b.x - a.x), oy = ha.h + hb.h - Math.abs(b.y - a.y);
      if (ox <= 0 || oy <= 0) return;
      if (ox < oy) push(a, b, Math.sign(b.x - a.x) || 1, 0, ox); else push(a, b, 0, Math.sign(b.y - a.y) || 1, oy);
      return;
    }
    const box = a.kind ? a : b, c = a.kind ? b : a, h = half(box);       // a plush and the box
    const qx = Math.max(box.x - h.w, Math.min(box.x + h.w, c.x)), qy = Math.max(box.y - h.h, Math.min(box.y + h.h, c.y));
    let dx = c.x - qx, dy = c.y - qy, d2 = dx * dx + dy * dy, nx, ny, over;
    if (d2 >= B.PLUSH.r * B.PLUSH.r) return;
    if (d2 > 0.0001) { const d = Math.sqrt(d2); nx = dx / d; ny = dy / d; over = B.PLUSH.r - d; }
    else {       // its middle inside the box: out the nearest side
      const px = h.w - Math.abs(c.x - box.x), py = h.h - Math.abs(c.y - box.y);
      if (px < py) { nx = Math.sign(c.x - box.x) || 1; ny = 0; over = px + B.PLUSH.r; } else { nx = 0; ny = Math.sign(c.y - box.y) || -1; over = py + B.PLUSH.r; }
    }
    push(box, c, nx, ny, over);
  }
  // The walls, each with an inside: however hard something is shoved (a prize the claw is lifting pushes like a wall itself),
  // it's put back on its own side, never through. The sides and the floor are whole planes; the chute's guard keeps each
  // prize on the side it was on, and its top is a corner things can roll off.
  function walls(it) {
    const h = half(it), G = B.CHUTE, e = PHYS.e;
    if (it.x < B.WALL.l + h.w) { it.x = B.WALL.l + h.w; if (it.vx < 0) it.vx = -it.vx * e; }
    if (it.x > B.WALL.r - h.w) { it.x = B.WALL.r - h.w; if (it.vx > 0) it.vx = -it.vx * e; }
    const side = (it.px === undefined ? it.x : it.px) < G.x2 ? -1 : 1;       // (which side of the guard it was on before this step)
    if (side > 0 && it.y > B.FLOOR - h.h) { it.y = B.FLOOR - h.h; if (it.vy > 0) it.vy = -it.vy * e; it.vx *= 0.9; it.rest = true; }
    const bottom = it.y + h.h;
    if (bottom <= G.top) return;
    if (it.y >= G.top) {       // beside the guard: kept on its side
      if (side < 0 && it.x > G.x2 - h.w) { it.x = G.x2 - h.w; if (it.vx > 0) it.vx = -it.vx * e; }
      if (side > 0 && it.x < G.x2 + h.w) { it.x = G.x2 + h.w; if (it.vx < 0) it.vx = -it.vx * e; }
      return;
    }
    // its middle above the guard's top, its bottom below: on the corner
    if (it.kind) {
      if (Math.abs(it.x - G.x2) >= h.w) return;
      const ox = h.w - Math.abs(it.x - G.x2), oy = bottom - G.top;
      if (oy <= ox) push(it, null, 0, 1, oy); else push(it, null, it.x < G.x2 ? 1 : -1, 0, ox);
      return;
    }
    const dx = it.x - G.x2, dy = it.y - G.top, d2 = dx * dx + dy * dy;
    if (d2 >= h.w * h.w) return;
    const d = Math.sqrt(d2) || 0.01;
    push(it, null, -(dx / d), -(d2 ? dy / d : -1), h.w - d);
  }
  function physics() {
    const dt = PHYS.dt;
    for (const it of items) {
      if (it.held) continue;
      it.px = it.x; it.vy += PHYS.g * dt; it.x += it.vx * dt; it.y += it.vy * dt; it.rest = false;
    }
    for (let k = 0; k < PHYS.iters; k++) {
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (Math.abs(a.x - b.x) > 100 || Math.abs(a.y - b.y) > 100) continue;
        pair(a, b);
      }
      for (const it of items) if (!it.held) walls(it);
    }
    for (const it of items) {
      if (it.held) continue;
      if (it.rest) { it.vx *= 0.9; if (Math.hypot(it.vx, it.vy) < 6) { it.vx = 0; it.vy = Math.min(it.vy, 0); } }       // (at rest it stays at rest: no creeping)
      const sp = Math.hypot(it.vx, it.vy); if (sp > 1600) { it.vx *= 1600 / sp; it.vy *= 1600 / sp; }
      // balanced on the chute's guard: tipped off it, to whichever side its middle is on
      if (Math.abs(it.x - B.CHUTE.x2) < half(it).w && it.y < B.CHUTE.top && sp < 20) { if (++it.still > 40) { it.vx += (it.x < B.CHUTE.x2 ? -1 : 1) * 60; it.still = 0; } } else it.still = 0;
      if (it.y > B.CHUTE.out && it.x < B.CHUTE.x2) win(it);
      else if (it.y > B.H + 60 || it.x < 0 || it.x > B.W) { it.gone = true; add(it.kind, B.DROP.x1 + rnd() * (B.DROP.x2 - B.DROP.x1), B.DROP.y); }       // (never happens: but if it did, it comes back in)
    }
    if (items.some((it) => it.gone)) items = items.filter((it) => !it.gone);
  }
  function win(it) {
    it.gone = true;
    const pay = it.kind ? R.grandPay : R.plushPay;
    events.push(['w', it.kind, Math.round(it.x), Math.round(it.y)]);
    const who = go || last[0];       // (whoever's try it was: a prize can still be rolling in as the next one starts)
    if (who) {
      const s = seats[seatOf(who.id)];
      if (s) { s.chips += pay; s.won += pay; } else if (opts.wallet && opts.wallet.owns(who.id)) { const w = opts.wallet.peek(who.id); opts.wallet.set(who.id, { chips: w.chips + pay, outUntil: w.outUntil }); }
      if (go) { go.won += pay; go.kinds.push(it.kind); }       // (replaced when the try's over: finish)
      else { who.won += pay; who.kinds.push(it.kind); }       // the last try's, still rolling in after it ended: its record, and a new one now
    }
    if (!go) add(it.kind, B.DROP.x1 + rnd() * (B.DROP.x2 - B.DROP.x1), B.DROP.y - (it.kind ? 40 : 0));
    changed();
  }

  // ------------------------------------------------------------------ the claw at work
  const tipY = () => claw.y + B.CLAW.reach;
  // the prize the claw's feet are on, if any: a plush whose round top is under the feet, the box under them
  function touching() {
    const y = tipY(), s = B.CLAW.span;
    let best = null;
    for (const it of items) {
      if (it.held) continue;
      let hit;
      if (it.kind) hit = Math.abs(it.x - claw.x) < B.BOX.hw + s * 0.6 && y >= it.y - B.BOX.hh;
      else { const dx = Math.max(0, Math.abs(it.x - claw.x) - s * 0.6); hit = dx < B.PLUSH.r && y >= it.y - Math.sqrt(B.PLUSH.r * B.PLUSH.r - dx * dx); }
      if (hit && (!best || it.y - half(it).h < best.y - half(best).h)) best = it;
    }
    return best;
  }
  // How likely the claw is to hold a prize it closes on, by how far from its middle it came down (0 dead centre, 1 its edge)
  const grip = (kind, off) => (kind ? R.boxGrip * (1 - 0.85 * off * off) : R.plushGrip * (1 - 0.75 * off * off));
  const REACH = [34, 50];       // how far off a prize's middle the claw can be and still get its prongs round it (plush, box)
  function close() {
    const y = tipY();
    let it = null, off = 1;
    for (const q of items) {
      if (q.held) continue;
      const h = half(q), o = Math.abs(q.x - claw.x) / REACH[q.kind];
      if (o < 1 && q.y - h.h <= y + 8 && q.y + h.h >= y - 6 && o < off) { it = q; off = o; }
    }
    events.push(['c', Math.round(claw.x), Math.round(y)]);
    if (!it) {       // nothing between the prongs: they push what's beside them as they close
      for (const q of items) if (!q.held && Math.abs(q.x - claw.x) < B.CLAW.span + half(q).w + 6 && Math.abs(q.y - y) < half(q).h + 20) q.vx += (q.x < claw.x ? 1 : -1) * 70;
      go.plan = 'none';
      return;
    }
    const holds = rand(1000000) < grip(it.kind, off) * 1000000;
    if (holds) go.plan = 'hold';
    else { const r = rand(100); go.plan = r < 45 ? 'slide' : r < 85 ? 'lift' : 'carry'; }
    // where it lets go, if it does: just off the pile, part way up, or part way home
    const climb = claw.y - B.CLAW.top;
    go.slipAt = go.plan === 'slide' ? claw.y - (12 + rnd() * 30) : go.plan === 'lift' ? claw.y - climb * (0.3 + rnd() * 0.65) : go.plan === 'carry' ? claw.x - (claw.x - B.RAIL.home) * (0.15 + rnd() * 0.75) : 0;
    go.item = it.id; go.dx = (it.x - claw.x) * 0.5; go.kind = it.kind; go.off = Math.round(off * 100) / 100;
    it.held = true; it.vx = 0; it.vy = 0;
  }
  function slip() {
    const it = items.find((q) => q.id === go.item); go.item = null;
    if (!it) return;
    it.held = false; it.vx = (rnd() - 0.5) * 40; it.vy = 20;
    go.slipped = true;
    events.push(['s', it.kind, Math.round(it.x), Math.round(it.y)]);
    changed();
  }
  function carry(dt) {       // the held prize goes where the claw goes (a doomed one sways a little more)
    const it = go && go.item ? items.find((q) => q.id === go.item) : null; if (!it) return;
    const sway = Math.sin(simT / 70) * (go.plan === 'hold' ? 0.6 : 2.2) * (step === 'grab' ? 0 : 1);
    const nx = claw.x + go.dx + sway, ny = tipY() - half(it).h * (it.kind ? 0.25 : 0.5);       // (the prongs under its middle: the box held low, clear of the claw's head)
    it.vx = (nx - it.x) / dt; it.vy = (ny - it.y) / dt; it.x = nx; it.y = ny;
  }
  function clawStep() {
    const dt = PHYS.dt, C = B.CLAW;
    const sinceStep = simT - stepAt;
    if (step === 'move') {
      claw.x = B.sweepAt(simT - go.at);
      if (simT >= go.until) to('down');
      claw.open += (1 - claw.open) * 0.08;
    } else if (step === 'down') {
      claw.open += (1 - claw.open) * 0.2;
      if (touching() || claw.y >= C.low) { if (!go.sink) go.sink = claw.y; if (claw.y - go.sink >= 6 || claw.y >= C.low) { go.sink = 0; to('grab'); close(); } else claw.y += C.down * 0.4 * dt; }
      else claw.y = Math.min(C.low, claw.y + C.down * dt);
    } else if (step === 'grab') {
      const it = go.item ? items.find((q) => q.id === go.item) : null;
      const want = it ? (it.kind ? 0.9 : 0.42) : 0;       // (round its sides: renderer/crane.js arm)
      claw.open += (want - claw.open) * 0.09;
      if (go.plan === 'slide' && sinceStep > T.close * 0.8 && it) { /* (it lets go once it's lifted a little: in 'up') */ }
      if (sinceStep >= T.close + T.hold) to('up');
    } else if (step === 'up') {
      claw.y = Math.max(C.top, claw.y - C.up * dt);
      if (go.item && (go.plan === 'slide' || go.plan === 'lift') && claw.y <= go.slipAt) slip();
      if (claw.y <= C.top) to('home');
    } else if (step === 'home') {
      claw.x = Math.max(B.RAIL.home, claw.x - C.speed * dt);
      if (go.item && go.plan === 'carry' && claw.x <= go.slipAt) slip();
      if (claw.x <= B.RAIL.home) to('release');
    } else if (step === 'release') {
      claw.open += (1 - claw.open) * 0.12;
      if (go.item && claw.open > 0.6) { const it = items.find((q) => q.id === go.item); if (it) { it.held = false; it.vx = 0; it.vy = 40; } go.item = null; events.push(['r']); }
      if (sinceStep >= T.release) to('settle');
    } else if (step === 'settle') {
      claw.open += (0.55 - claw.open) * 0.05;
      const moving = items.some((q) => Math.hypot(q.vx, q.vy) > 14);
      if (sinceStep >= T.settleMax || (sinceStep >= T.settleMin && !moving)) finish();
    }
    carry(dt);
  }
  function finish() {
    const g = go; go = null;
    g.done = true;
    last.unshift({ n: g.n, id: g.id, name: g.name, won: g.won, kinds: g.kinds.slice(), slipped: g.slipped, missed: g.plan === 'none' });
    last = last.slice(0, 6);
    if (g.won > 0 && opts.onSettle) try { opts.onSettle([{ id: g.id, name: g.name, net: g.won, score: g.won }]); } catch { /* theirs to get right */ }
    // a new prize for each one won, dropped in over the pile
    for (const k of g.kinds) add(k, B.DROP.x1 + rnd() * (B.DROP.x2 - B.DROP.x1), B.DROP.y - (k ? 40 : 0));
    to('ready');
    const s = seats[0];
    if (s && s.id === g.id) { s.since = now(); if (s.left) free(); else if (watchers.length) passOn(); }
  }

  function frame() {
    const list = [];
    for (const it of items) list.push(it.id, it.kind + (it.held ? 2 : 0), Math.round(it.x * 2), Math.round(it.y * 2));       // (half units)
    frames.push({ t: Math.round(simT), c: [Math.round(claw.x * 2), Math.round(claw.y * 2), Math.round(claw.open * 100)], i: list, e: events });
    events = [];
    seq++;
    if (frames.length > PHYS.keep) frames.splice(0, frames.length - PHYS.keep);
  }
  // only when something's moved (a pile at rest sends nothing)
  function moved() {
    const k = [Math.round(claw.x * 2), Math.round(claw.y * 2), Math.round(claw.open * 100)];
    for (const it of items) k.push(it.id, it.held ? 1 : 0, Math.round(it.x * 2), Math.round(it.y * 2));
    const key = k.join(',');
    if (key === lastSent && !events.length) return false;
    lastSent = key; return true;
  }

  // the pile shaken down before anyone sees it
  for (let i = 0; i < 480; i++) physics();
  for (const it of items) { it.vx = 0; it.vy = 0; }
  events = [];

  // ------------------------------------------------------------------ time
  function tick() {
    const t = now(), v0 = version;
    if (phase === 'idle') { simT = t; frameAt = t; return version !== v0; }
    if (t - simT > 1500) { simT = t - 1500; frameAt = simT; }       // (a long pause: don't work out a minute in one go)
    while (simT + PHYS.dt * 1000 <= t) {
      clawStep();
      physics();
      simT += PHYS.dt * 1000;
      if (simT >= frameAt) { if (moved()) frame(); frameAt += PHYS.frame; }
    }
    if (go && step === 'move') { const left = Math.ceil((go.until - simT) / 1000); if (left !== go.shown) { go.shown = left; changed(); } }       // (the clock, a second at a time)
    const s = seats[0];
    if (s && !go && watchers.length && step === 'ready' && t - s.since > T.idle) passOn();       // someone's waiting, and you're not playing
    if (!seats[0] && !go && step === 'ready' && !items.some((q) => Math.hypot(q.vx, q.vy) > 14)) { if (phase !== 'idle') { phase = 'idle'; idleSince = t; changed(); } }
    return version !== v0;
  }

  // ------------------------------------------------------------------ what someone sees
  function view(id) {
    id = String(id);
    const me = seatOf(id), s = seats[0];
    const cut = (r) => ({ n: r.n, name: r.name, mine: r.id === id, won: r.won, kinds: r.kinds, slipped: r.slipped, missed: r.missed });
    return {
      phase, step, board: B.rev, you: me, watching: watchers.findIndex((w) => w.id === id), watchers: watchers.length, line: watchers.slice(0, 8).map((w) => ({ id: w.id, name: w.name })),
      start: R.start, cost: R.cost, pays: { plush: R.plushPay, grand: R.grandPay },
      play: go ? { n: go.n, name: go.name, mine: go.id === id, msLeft: step === 'move' ? Math.max(0, go.until - simT) : 0, holding: go.item ? go.kind : -1,
        slipped: go.slipped, won: go.won, kinds: go.kinds.slice(), missed: go.plan === 'none' } : null,
      last: last.map(cut),
      prizes: { plush: items.filter((q) => !q.kind).length, grand: items.filter((q) => q.kind).length },
      idleMs: s && !go && watchers.length && step === 'ready' ? Math.max(0, T.idle - (now() - s.since)) : 0,
      seats: seats.map((x) => x && { id: x.id, name: x.name, chips: x.chips, left: x.left, tries: x.tries, won: x.won, outMs: 0 }),
    };
  }
  const mine = (id) => { const s = seats[seatOf(String(id))]; return s ? { chips: s.chips, outUntil: s.outUntil } : null; };

  return {
    sit, leave, move, tick, view, mine,
    // the claw and the prizes, as frames: ink(from) is every kept frame from number `from` on (all kept, from 0)
    ink: (from) => { const first = seq - frames.length; return frames.slice(Math.max(0, (from || 0) - first)); },
    get inkRev() { return 1; }, get inkLen() { return seq; },
    get version() { return version; }, get phase() { return phase; }, tickMs: 50,
    seated: () => seats.filter(Boolean).map((x) => x.id),
    _items: () => items, _claw: () => claw, _rules: R, _step: () => step,       // (tests)
  };
}

module.exports = { createTable, RULES, TIMES, PHYS, BOARD: B };
