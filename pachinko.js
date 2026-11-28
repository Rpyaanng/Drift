// Drift — pachinko, the rules and the balls (docs/plans/pachinko.md). One shared machine: everyone at it fires into the same
// pins, each ball in its owner's colour, and they knock into each other. Pure, like roulette.js: no Electron, no DOM, no
// timers of its own. Whoever runs it (main.js alone, hub.js for a hub) calls tick() often (every 50 ms): the balls are worked
// out up to now, and each 1/30 s of them is kept as a frame for the screens (ink(from), as Sketch & Guess's drawing goes out).
//
//   const t = createTable({ now, rand, times, wallet });  t.sit(id, name)  t.move(id, { do: 'hold', amount: 60 })  t.tick()
//
// Each ball costs `cost` chips (the casino's wallet: wallet.js), enough that a session of holding the handle shows in the
// wallet: about 95% comes back over a long run, so 10 a ball loses some 50 a minute, with big swings. Pockets pay: the start pocket a few and a spin of the reels, a
// tulip more, the gate (open only in a fever) the most. Three of a kind on the reels is a fever, for everyone at the machine:
// the gate opens for a number of rounds, and whoever gets balls in it is paid. Sevens or the cat is a big fever, and the next
// spins are much likelier to hit again. The reels are decided when they start, and not shown till each stops.
const B = require('./renderer/pachinko-board.js');

const RULES = {
  start: 1000, back: 500, seats: 8, every: 600, inFlight: 14,       // (start: a new player's chips; back: out of chips, what you're back in with)       // ms between balls while you hold the handle; most of your balls in the air at once
  cost: 25, startPay: 100, tulipPay: 110, gatePay: 500,       // chips: a ball, and what each pocket pays
  feverOdds: 1 / 130, hotOdds: 1 / 25, hotSpins: 20, reachOdds: 1 / 9,       // a spin's chance of a fever (in a hot spell after a big one), of a reach that misses
  rounds: 6, roundBalls: [6, 10, 12, 15], queue: 8,       // a fever's rounds; the balls that close a round, by how many are at the machine as it opens (1, 2, 3, 4 or more: asked for, easier per head the more there are, to bring friends); spins waiting
};
const TIMES = { stop: [1400, 2200, 3200], reach: 6800, show: 1200, feverIn: 2500, round: 15000, between: 1600, out: 20000 };
// The reels' symbols. 0 the cat and 6 the seven are the big ones.
const SYMBOLS = ['cat', 'moon', 'wave', 'star', 'note', 'bell', 'seven'];
const BIG = new Set([0, 6]);
const PHYS = { g: 1000, dt: 1 / 240, vMin: 1190, vMax: 1450, pinE: 0.42, pinF: 0.94, wallE: 0.3, wallF: 0.9985, ballE: 0.55, life: 16000, frame: 1000 / 30, keep: 45 };

function createTable(opts = {}) {
  const now = opts.now || (() => Date.now());
  const rand = opts.rand || ((n) => require('crypto').randomInt(n));
  const T = { ...TIMES, ...(opts.times || {}) }, R = { ...RULES, ...(opts.rules || {}) };
  const seats = new Array(R.seats).fill(null);
  const watchers = [];
  const outs = new Map();
  let version = 0, phase = 'idle';
  const changed = () => { version++; };
  const seatOf = (id) => seats.findIndex((s) => s && s.id === id);

  // the balls' own random numbers: quick, seeded from `rand` (crypto at a hub), so a nudge off a pin isn't a crypto call
  let seed = (rand(2147483646) + 1) >>> 0;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

  // ------------------------------------------------------------------ the board, in a grid for finding what's near
  const CELL = 24, GW = Math.ceil(B.W / CELL) + 1, GH = Math.ceil(B.H / CELL) + 1;
  const grid = Array.from({ length: GW * GH }, () => ({ pins: [], segs: [] }));
  const cellAt = (x, y) => grid[Math.max(0, Math.min(GH - 1, Math.floor(y / CELL))) * GW + Math.max(0, Math.min(GW - 1, Math.floor(x / CELL)))];
  B.pins.forEach((p, i) => { for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const c = cellAt(p[0] + dx * CELL * 0.5, p[1] + dy * CELL * 0.5); if (!c.pins.includes(i)) c.pins.push(i); } });
  const SEGS = B.segs.slice();
  SEGS.forEach((s, i) => {
    const pad = B.BALL + 2, x0 = Math.min(s[0], s[2]) - pad, x1 = Math.max(s[0], s[2]) + pad, y0 = Math.min(s[1], s[3]) - pad, y1 = Math.max(s[1], s[3]) + pad;
    for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++) for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) {
      const c = grid[Math.max(0, Math.min(GH - 1, y)) * GW + Math.max(0, Math.min(GW - 1, x))]; if (!c.segs.includes(i)) c.segs.push(i);
    }
  });
  const PETALS = B.TULIPS.map((t) => B.petals(t));

  // ------------------------------------------------------------------ the machine's state
  let balls = [], nextBall = 1, simT = now(), frameAt = simT, frames = [], seq = 0, flying = new Map();       // flying: seat -> balls in the air
  let events = [];       // this frame's happenings, for the screens' sounds: [kind, seat] ('n' a launch, 'p' a pin, 's' start, 'u' tulip, 'g' gate, 'f' foul)
  const tulips = B.TULIPS.map(() => ({ open: false }));
  let spins = [], spin = null, fever = null, hot = 0, history = [], lastPays = [], spinN = 0, filled = 0;       // (filled: fever rounds the gate's taken all its balls in, ever)
  // spins: [{ seat id }] waiting; spin: { id, name, reels, reach, fever, big, at }; fever: { id, name, big, round, open, balls, until, gains: Map }

  // ------------------------------------------------------------------ places
  function sit(id, name, keep) {
    id = String(id); name = String(name || '').slice(0, 24);
    const at = seatOf(id);
    if (at >= 0) { const s = seats[at]; s.name = name; if (s.left) { s.left = false; changed(); } return { seat: at }; }
    const free = seats.indexOf(null);
    if (free < 0) { if (!watchers.some((w) => w.id === id)) { watchers.push({ id, name }); changed(); } return { watching: true }; }
    if (opts.wallet && opts.wallet.owns(id)) keep = opts.wallet.keep(id);       // (the casino's one wallet: wallet.js)
    const out = Math.max(outs.get(id) || 0, keep && +keep.outUntil || 0);
    const s = { id, name, chips: keep && Number.isFinite(+keep.chips) ? Math.max(0, Math.floor(+keep.chips)) : R.start, outUntil: out > now() ? out : 0, left: false,
      holding: false, power: 60, nextAt: 0, fired: 0, won: 0 };
    if (s.outUntil) s.chips = 0;
    else if (s.chips < R.cost) s.chips = R.back;
    if (opts.wallet) opts.wallet.bind(s);
    seats[free] = s;
    if (phase === 'idle') { phase = 'play'; simT = now(); frameAt = simT; }
    changed();
    return { seat: free };
  }
  function leave(id) {
    id = String(id);
    const w = watchers.findIndex((x) => x.id === id);
    if (w >= 0) { watchers.splice(w, 1); changed(); }
    const at = seatOf(id); if (at < 0) return;
    const s = seats[at];
    if (s.outUntil) outs.set(id, s.outUntil);
    s.holding = false;
    if (flying.get(at)) { s.left = true; changed(); }       // their balls still in the air come down and pay; the place goes after
    else free(at);
  }
  function free(at) {
    seats[at] = null;
    const w = watchers.shift();
    if (w) sit(w.id, w.name);
    if (!seats.some(Boolean) && !balls.length && !spin && !fever) { phase = 'idle'; }
    changed();
  }

  // ------------------------------------------------------------------ moves: the handle
  function move(id, m) {
    m = m && typeof m === 'object' ? m : {};
    const s = seats[seatOf(String(id))];
    if (!s) return { error: 'Sit down first' };
    if (s.left) return { error: 'Sit back down first' };
    const what = String(m.do || '');
    if (what === 'hold' || what === 'power') {
      const p = Math.max(0, Math.min(100, Math.round(+m.amount)));
      if (Number.isFinite(p)) s.power = p;
      if (what === 'hold') {
        if (s.outUntil) return { error: 'Out of chips for a moment' };
        if (s.chips < R.cost) return { error: `A ball is ${R.cost} chips` };
        if (!s.holding) { s.holding = true; s.nextAt = Math.max(s.nextAt, simT); }
      }
    } else if (what === 'let go') s.holding = false;
    else return { error: 'Not a move' };
    changed();
    return { ok: true };
  }

  // ------------------------------------------------------------------ the balls
  function launch(at, s) {
    s.chips -= R.cost; s.fired++;
    const v = PHYS.vMin + (PHYS.vMax - PHYS.vMin) * (s.power / 100) * (1 + (rnd() - 0.5) * 0.012);
    balls.push({ id: nextBall++, at, x: (B.LANE.x + B.LANE.out) / 2, y: 872, vx: 0, vy: -v, born: simT, rail: true, still: 0 });
    nextBall %= 60000;
    flying.set(at, (flying.get(at) || 0) + 1);
    events.push(['n', at]);
  }
  function pay(at, n, kind) {
    const s = seats[at]; if (!s) return;
    s.chips += n; s.won += n;
    if (fever && fever.gains) fever.gains.set(s.id, (fever.gains.get(s.id) || 0) + n);
    lastPays.unshift({ seat: at, n, kind, at: simT }); lastPays = lastPays.slice(0, 6);
    changed();
  }
  function done(b, kind) {
    b.gone = true;
    const n = (flying.get(b.at) || 1) - 1;
    if (n > 0) flying.set(b.at, n); else flying.delete(b.at);
    events.push([kind, b.at, Math.round(b.x), Math.round(b.y)]);       // (where: the screens' bursts and "+40"s)
    if (kind === 's') { pay(b.at, R.startPay, 'start'); const s = seats[b.at]; if (s && spins.length < R.queue) { spins.push({ id: s.id, name: s.name }); changed(); } }
    else if (kind === 'u') { pay(b.at, R.tulipPay, 'tulip'); }
    else if (kind === 'g') { pay(b.at, R.gatePay, 'gate'); if (fever && fever.open) { fever.balls++; changed(); } }
    else if (kind === 'f') { const s = seats[b.at]; if (s) { s.chips += R.cost; changed(); } }       // a foul: the ball comes back
  }
  function hitPin(b, px, py) {
    const dx = b.x - px, dy = b.y - py, d2 = dx * dx + dy * dy, r = B.BALL + B.PIN;
    if (d2 >= r * r || d2 === 0) return false;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    b.x = px + nx * r; b.y = py + ny * r;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      const tx = -ny, ty = nx, vt = (b.vx * tx + b.vy * ty) * PHYS.pinF, out = -vn * PHYS.pinE + (rnd() - 0.5) * 18;       // (a pin is never quite round)
      b.vx = tx * vt + nx * out; b.vy = ty * vt + ny * out;
      return -vn > 40;
    }
    return false;
  }
  function hitSeg(b, s) {
    const ex = s[2] - s[0], ey = s[3] - s[1], l2 = ex * ex + ey * ey;
    let u = l2 ? ((b.x - s[0]) * ex + (b.y - s[1]) * ey) / l2 : 0; u = Math.max(0, Math.min(1, u));
    const cx = s[0] + ex * u, cy = s[1] + ey * u, dx = b.x - cx, dy = b.y - cy, d2 = dx * dx + dy * dy;
    if (d2 >= B.BALL * B.BALL || d2 === 0) return;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    b.x = cx + nx * B.BALL; b.y = cy + ny * B.BALL;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) { const tx = -ny, ty = nx, vt = (b.vx * tx + b.vy * ty) * PHYS.wallF; b.vx = tx * vt - nx * vn * PHYS.wallE; b.vy = ty * vt - ny * vn * PHYS.wallE; }
  }
  // The trampoline (renderer/pachinko-board.js TRAMP): a mat sliding side to side. Landing on it from above springs a ball back
  // up at least TR.kick fast (harder the harder it fell), with some of the mat's sideways speed, and further sideways the
  // nearer its edge it lands; its two ends are hard, like pins; from below it's just the frame.
  const TR = B.TRAMP;
  let tramp = B.trampAt(0);
  function bounce(b) {
    const dx = b.x - tramp.x;
    for (const ex of [tramp.x - TR.half, tramp.x + TR.half]) if (hitPin(b, ex, TR.y)) b.pinged = true;
    if (Math.abs(dx) > TR.half) return;
    const before = b.y - b.vy * PHYS.dt;
    if (b.vy > 0 && b.y > TR.y - B.BALL && before <= TR.y - B.BALL + 2) {
      b.y = TR.y - B.BALL;
      b.vy = -Math.max(b.vy * 0.85, TR.kick);
      b.vx = b.vx * 0.6 + tramp.v * 0.35 + (dx / TR.half) * 90;
      events.push(['t', b.at, Math.round(b.x), Math.round(b.y)]);
    } else if (b.vy < 0 && b.y < TR.y + B.BALL + 4 && before >= TR.y + B.BALL + 2) { b.y = TR.y + B.BALL + 4; b.vy = -b.vy * 0.3; }
  }
  function step() {
    const dt = PHYS.dt, g = PHYS.g;
    const gateOpen = !!(fever && fever.open);
    tramp = B.trampAt(simT);
    for (const b of balls) {
      b.vy += g * dt; b.x += b.vx * dt; b.y += b.vy * dt;
      const sp = Math.hypot(b.vx, b.vy); if (sp > 2400) { b.vx *= 2400 / sp; b.vy *= 2400 / sp; }
    }
    // balls knock into each other first (not on the rail: there they'd only jam), so the walls and pins have the last word
    const free = balls.filter((b) => !b.rail), D = 2 * B.BALL;
    for (let i = 0; i < free.length; i++) {
      const a = free[i];
      for (let j = i + 1; j < free.length; j++) {
        const b = free[j], dx = b.x - a.x, dy = b.y - a.y;
        if (dx > D || dx < -D || dy > D || dy < -D) continue;
        const d2 = dx * dx + dy * dy; if (d2 >= D * D || d2 === 0) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, push = (D - d) / 2;
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rv < 0) { const j2 = -(1 + PHYS.ballE) * rv / 2; a.vx -= j2 * nx; a.vy -= j2 * ny; b.vx += j2 * nx; b.vy += j2 * ny; }
      }
    }
    const W0 = B.WIN;
    for (const b of balls) {
      if (b.gone) continue;
      if (b.x > W0.x && b.x < W0.x + W0.w && b.y > W0.y + 44 && b.y < W0.y + W0.h) { b.x = b.x < W0.x + W0.w / 2 ? W0.x - B.BALL : W0.x + W0.w + B.BALL; b.vx = 0; }       // (never inside the window)
      const c = cellAt(b.x, b.y);
      for (const i of c.pins) if (hitPin(b, B.pins[i][0], B.pins[i][1])) b.pinged = true;
      for (const i of c.segs) hitSeg(b, SEGS[i]);
      if (Math.abs(b.y - TR.y) < B.BALL + 8 && Math.abs(b.x - tramp.x) < TR.half + B.BALL + 4) bounce(b);
      tulips.forEach((t, k) => { if (t.open && Math.abs(b.x - B.TULIPS[k].x) < 34 && Math.abs(b.y - B.TULIPS[k].y) < 30) for (const s of PETALS[k]) hitSeg(b, s); });
      if (b.rail && b.x < B.LANE.x - 6 && b.vy > 0) b.rail = false;       // off the rail and onto the pins: from now it knocks into other balls
      // where it ends up
      if (Math.abs(b.x - B.START.x) < B.START.half - 1 && b.y > B.START.y + 2 && b.y < B.START.y + 14) { done(b, 's'); continue; }
      let caught = false;
      B.TULIPS.forEach((t, k) => { if (!caught && Math.abs(b.x - t.x) < t.half - 1 && b.y > t.y + 2 && b.y < t.y + 14) { caught = true; tulips[k].open = !tulips[k].open; changed(); } });
      if (caught) { done(b, 'u'); continue; }
      if (gateOpen && b.x > B.GATE.x1 && b.x < B.GATE.x2 && b.y > B.GATE.y - 2 && b.y < B.GATE.y + 14) { done(b, 'g'); continue; }
      if (b.y > B.DRAIN.y) { done(b, 'o'); continue; }
      if (b.x > B.LANE.x && b.y > 860 && b.vy >= 0 && !b.rail) { done(b, 'f'); continue; }
      if (b.x > B.LANE.x && b.y > 860 && b.vy >= 0 && b.rail && simT - b.born > 120) { done(b, 'f'); continue; }       // (sent too softly to clear the lane)
      if (Math.abs(b.vx) + Math.abs(b.vy) < 12) { if (++b.still > 240) { b.vx += (rnd() - 0.5) * 120; b.vy -= 40; b.still = 0; } } else b.still = 0;       // (resting somewhere: a nudge)
      if (simT - b.born > PHYS.life) done(b, 'o');
    }
    for (const b of balls) if (b.pinged) { b.pinged = false; if (!events.some((e) => e[0] === 'p' && e[1] === b.at)) events.push(['p', b.at]); }
    if (balls.some((b) => b.gone)) balls = balls.filter((b) => !b.gone);
  }
  function frame() {
    const list = [];
    for (const b of balls) list.push(b.id, b.at, Math.round(b.x * 2), Math.round(b.y * 2));       // (half units: smooth enough, small)
    frames.push({ t: Math.round(simT), b: list, e: events, p: Math.round(B.trampAt(simT).x * 2) });       // p: the trampoline's middle (half units)
    events = [];
    seq++;
    if (frames.length > PHYS.keep) frames.splice(0, frames.length - PHYS.keep);
  }

  // ------------------------------------------------------------------ the reels and the fever
  const pick = (n) => rand(n);
  function startSpin() {
    const q = spins.shift(); if (!q) return;
    const odds = hot > 0 ? R.hotOdds : R.feverOdds;
    const win = pick(1000000) < odds * 1000000;
    let reels, reach = false;
    if (win) { const k = pick(SYMBOLS.length); reels = [k, k, k]; reach = true; }
    else if (pick(1000000) < R.reachOdds * 1000000) { const k = pick(SYMBOLS.length); reels = [k, k, (k + (pick(2) ? 1 : SYMBOLS.length - 1)) % SYMBOLS.length]; reach = true; }       // (one off: so close)
    else { const a = pick(SYMBOLS.length); let b = pick(SYMBOLS.length - 1); if (b >= a) b++; reels = [a, b, pick(SYMBOLS.length)]; }
    if (hot > 0) hot--;
    const at = simT, stops = [at + T.stop[0], at + T.stop[1], at + (reach ? T.reach : T.stop[2])];
    spin = { n: ++spinN, id: q.id, name: q.name, reels, reach, win, big: win && BIG.has(reels[0]), at, stops, end: stops[2] + T.show };
    changed();
  }
  function spinsAndFever() {
    if (spin && simT >= spin.end) {
      const s = spin; spin = null;
      history.unshift(s.reels.slice()); history = history.slice(0, 8);
      if (s.win) fever = { id: s.id, name: s.name, big: s.big, round: 0, open: false, balls: 0, until: simT + T.feverIn, gains: new Map() };
      changed();
    }
    if (fever && simT >= fever.until) {
      if (fever.open) { fever.open = false; fever.until = simT + T.between; }
      else if (fever.round < R.rounds) { fever.round++; fever.open = true; fever.balls = 0; fever.need = roundNeed(); fever.until = simT + T.round; }
      else endFever();
      changed();
    }
    if (fever && fever.open && fever.balls >= fever.need) { fever.open = false; fever.until = simT + T.between; filled++; changed(); }       // (a round filled: a scene token for everyone at the machine, main.js GM_TOKENS)
    if (!spin && !fever && spins.length) startSpin();
  }
  // the balls a round needs, by how many have a seat (and haven't stood up) as it opens: fixed for that round, so someone sitting
  // down halfway doesn't move it
  function roundNeed() {
    const list = [].concat(R.roundBalls), n = seats.filter((s) => s && !s.left).length;
    return list[Math.min(list.length, Math.max(1, n)) - 1];
  }
  function endFever() {
    const f = fever; fever = null;
    if (f.big) hot = R.hotSpins;
    const list = [...f.gains].map(([id, n]) => { const s = seats[seatOf(id)]; return { id, name: s ? s.name : '', net: n, score: n }; }).filter((x) => x.net > 0);
    if (opts.onSettle) try { opts.onSettle(list); } catch { /* theirs to get right */ }
  }

  // ------------------------------------------------------------------ time
  function tick() {
    const t = now(), v0 = version;
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i]; if (!s) continue;
      if (s.outUntil && t >= s.outUntil) { s.outUntil = 0; s.chips = R.back; outs.delete(s.id); changed(); }       // back in with fresh chips
      if (s.left && !flying.get(i)) free(i);
    }
    for (const [id, until] of outs) if (t >= until) outs.delete(id);
    if (phase === 'idle') { simT = t; frameAt = t; return version !== v0; }
    if (t - simT > 1500) { simT = t - 1500; frameAt = simT; }       // (a long pause: don't work out a minute in one go)
    while (simT + PHYS.dt * 1000 <= t) {
      for (let i = 0; i < seats.length; i++) {       // the handles: one ball every R.every while held, while there are chips
        const s = seats[i];
        if (!s || !s.holding || s.left) continue;
        if (s.outUntil || s.chips < R.cost) { s.holding = false; changed(); continue; }
        if (simT >= s.nextAt && (flying.get(i) || 0) < R.inFlight) { launch(i, s); s.nextAt = simT + R.every; }
      }
      step();
      simT += PHYS.dt * 1000;
      spinsAndFever();
      if (simT >= frameAt) { frame(); frameAt += PHYS.frame; }
    }
    for (let i = 0; i < seats.length; i++) {       // crapped out: no chips, nothing in the air, nothing coming
      const s = seats[i];
      if (s && !s.left && !s.outUntil && s.chips < R.cost && !flying.get(i)) { s.outUntil = t + T.out; outs.set(s.id, s.outUntil); s.holding = false; changed(); }
    }
    if (!seats.some(Boolean) && !balls.length && !spin && !fever && phase !== 'idle') { phase = 'idle'; changed(); }
    return version !== v0;
  }

  // ------------------------------------------------------------------ what someone sees
  function view(id) {
    const t = now(), me = seatOf(String(id));
    const reels = spin ? spin.reels.map((k, i) => (simT >= spin.stops[i] ? k : null)) : history.length ? history[0] : null;
    return {
      phase, board: B.rev, you: me, watching: watchers.findIndex((w) => w.id === String(id)), watchers: watchers.length, start: R.start, back: R.back,
      cost: R.cost, pays: { start: R.startPay, tulip: R.tulipPay, gate: R.gatePay },
      spins: spins.length, queue: R.queue, hot, filled,
      spin: spin ? { n: spin.n, name: spin.name, mine: spin.id === String(id), reels, reach: !!spin.reach && simT >= spin.stops[1], spinning: reels.map((k) => k === null),
        msLeft: Math.max(0, spin.stops[2] - simT), won: spin.win && simT >= spin.stops[2] } : null,
      reels,
      fever: fever ? { name: fever.name, mine: fever.id === String(id), big: fever.big, round: fever.round, rounds: R.rounds, open: fever.open, balls: fever.balls, roundBalls: fever.need || roundNeed(),
        msLeft: Math.max(0, fever.until - simT), gained: fever.gains.get(String(id)) || 0 } : null,
      tulips: tulips.map((x) => x.open),
      paid: lastPays.map((p) => ({ seat: p.seat, n: p.n, kind: p.kind, ago: Math.max(0, Math.round(simT - p.at)) })),
      seats: seats.map((s, i) => s && {
        id: s.id, name: s.name, chips: s.chips, holding: s.holding, power: s.power, left: s.left, won: s.won, fired: s.fired, flying: flying.get(i) || 0,
        outMs: s.outUntil ? Math.max(0, s.outUntil - t) : 0,
      }),
    };
  }
  const mine = (id) => { const s = seats[seatOf(String(id))]; return s ? { chips: s.chips, outUntil: s.outUntil } : null; };

  return {
    sit, leave, move, tick, view, mine,
    // the balls, as frames: ink(from) is every kept frame from number `from` on (all kept, from 0); inkLen counts every frame
    // made, inkRev changes only when the machine starts over. (The hub and main.js send them on as Sketch & Guess's ink.)
    ink: (from) => { const first = seq - frames.length; return frames.slice(Math.max(0, (from || 0) - first)); },
    get inkRev() { return 1; }, get inkLen() { return seq; },
    get version() { return version; }, get phase() { return phase; }, tickMs: 50,
    seated: () => seats.filter(Boolean).map((s) => s.id),
    _balls: () => balls, _rules: R,       // (tests)
  };
}

module.exports = { createTable, RULES, TIMES, SYMBOLS, PHYS, BOARD: B };
