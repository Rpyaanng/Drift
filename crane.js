// Drift — the crane machine, the rules and the prizes (docs/plans/crane.md). A glass box full of cat plushes with a gift box on
// top (the grand prize), one claw, one seat. Pure, like pachinko.js: no Electron, no DOM, no timers of its own. Whoever runs it
// (main.js alone, hub.js for a hub) calls tick() often (every 50 ms): the claw and the prizes are worked out up to now, and each
// 1/30 s that anything moved is kept as a frame for the screens (ink(from), as Pachinko's balls go out).
//
//   const t = createTable({ now, rand, times, wallet });  t.sit(id, name)  t.move(id, { do: 'play' })  t.tick()
//
// A try costs `cost` chips (the casino's wallet: wallet.js). The claw sweeps back and forth over the pile by itself, and the
// game is timing: press Drop as it passes over what you want (or the clock drops it for you). The head hangs on a cable and
// swings (B.SWING): the carriage brakes and slides on a little, the head swings on past it as it goes down, and it closes on
// whatever it landed on, goes up, back over the chute and opens. Whatever falls down the
// chute is yours: a plush pays `plushPay`, a big one `bigPay`, the box `grandPay`. (In a try's `kinds`: 0 a plush, 1 the box,
// 2 a big plush.) Whether the claw holds on is decided as it closes, by `rand`
// (crypto at a hub), and is likelier the nearer the middle of the prize it came down: a prize that won't hold slips out on
// the way, and if it slips near the chute it can still drop in. A prize won is replaced by a new one dropped in from the top.
// At a hub it's one machine: one player at a time, everyone else watching, in line for a go. With anyone waiting, the seat
// passes on after each try (or after a while of not playing).
const B = require('./renderer/crane-board.js');

const RULES = {
  start: 1000, cost: 1000, plushPay: 1000, bigPay: 2000, grandPay: 3000,       // chips: a try, and what each prize pays (a plush, a big one, the box; the box a scene token too: main.js GM_TOKENS)
  // the chance the claw holds a prize it came down on dead centre and still (asked for: 70%), each kind (a big plush: bigGrip
  // of a small one's); less the further off its middle, to nothing `within` across off it (grip())
  // (the box, worth five tries, needs coming down much nearer its middle: `boxWithin`)
  plushGrip: 0.7, boxGrip: 0.7, bigGrip: 1, within: 22, boxWithin: 8,       // (then asked for: a little more forgiving off dead centre; it was 18 and 5)
  swingGrip: 120,       // and less if it was still swinging as it landed: halved at this speed across
  cornerGrip: 0.8, cornerReach: 14,       // (asked for: a hook holds 80% of the time, however it's tipped or swinging; it was 0.35 at best, and 12 across)       // a tipped box's top corner catching on the prongs: how well it holds, and how near the claw must come (cornerCatch)
};
const TIMES = { move: 15000, late: 500, close: 650, hold: 250, release: 450, settleMin: 900, settleMax: 3500, idle: 25000 };
const PHYS = { g: 1500, dt: 1 / 120, e: 0.12, mu: 0.6, frame: 1000 / 30, keep: 45, iters: 3 };       // (mu: how grippy, at a contact)

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
  // { id, kind: 0 a plush, 1 the box, big (a big plush), x, y, vx, vy, a (its angle), w (its spin), held, gone }
  let items = [], nextId = 1, refill = [];       // (refill: the prizes won this try, [kind, big], replaced when it's over)
  const rOf = (it) => (it.big ? B.PLUSH.big : B.PLUSH.r);       // a plush's radius
  // how far a prize reaches either way, across and down (the box at its angle: what it covers, tipped)
  const half = (it) => { if (!it.kind) return { w: rOf(it), h: rOf(it) }; const c = Math.abs(Math.cos(it.a)), s = Math.abs(Math.sin(it.a)); return { w: c * B.BOX.hw + s * B.BOX.hh, h: s * B.BOX.hw + c * B.BOX.hh }; };
  function add(kind, x, y, big) { for (const q of items) { q.sleep = false; q.calm = 0; } items.push({ id: nextId++, kind, big: !kind && !!big, x, y, vx: 0, vy: 0, a: 0, w: 0, held: false, sleep: false, calm: 0, gone: false, still: 0 }); nextId %= 60000; }
  // a new prize (a plush, big or small, or the grand prize), dropped in from the top anywhere along it, onto the pile
  const anew = (kind, big) => add(kind, B.DROP.x1 + rnd() * (B.DROP.x2 - B.DROP.x1), B.DROP.y - (kind ? 40 : big ? 10 : 0), big);
  for (const [kind, x, y, big] of B.PILE) add(kind, x + (kind ? 0 : (rnd() - 0.5) * 4), y, big);

  // ------------------------------------------------------------------ the claw
  // step: 'ready' (waiting for a try), 'move' (sweeping, till Drop), 'down', 'grab' (closing), 'up', 'home', 'release', 'settle'
  // x, y: the head (where the prongs are); cx, cv: the carriage on the rail and its speed; th, om: the cable's swing from
  // straight down (radians, + to the right) and how fast it's swinging; vx: the head's speed across
  const claw = { x: B.RAIL.home, y: B.CLAW.top, open: 0.55, cx: B.RAIL.home, cv: 0, th: 0, om: 0, vx: 0, L: 0 };
  let hist = [];       // the claw during the sweep, step by step, for the last half second: Drop comes down from where you saw it
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
      hist = [];
      to('move');
      return { ok: true };
    }
    if (!go || go.id !== s.id || go.done) return { error: 'Put in a try first' };
    if (what === 'drop') {
      if (step !== 'move') return { error: 'The claw is on its way' };
      // `amount`: the moment the screen was showing when you pressed (the table's clock), so your timing is what you saw, not
      // what the claw had got to by the time the press arrived. No earlier than `late` ago, and never in the future.
      // The claw is put back as it was then (the carriage, the swing) and worked on from there with the brake on.
      const saw = Number.isFinite(+m.amount) && +m.amount > 0 ? Math.max(simT - T.late, Math.min(simT, +m.amount)) : simT;
      let h = null; for (let i = hist.length - 1; i >= 0; i--) if (hist[i].t <= saw + 0.01) { h = hist[i]; break; }
      const upTo = simT;
      if (h) { Object.assign(claw, h.c); simT = h.t; }
      claw.pressX = claw.cx;
      to('down');
      while (simT + PHYS.dt * 500 < upTo) { clawStep(); simT += PHYS.dt * 1000; }       // (high above the pile: nothing to hit)
      simT = upTo; hist = [];
      return { ok: true };
    }
    return { error: 'Not a move' };
  }
  function to(st) { step = st; stepAt = simT; if (phase !== 'idle') phase = st; changed(); }

  // ------------------------------------------------------------------ the physics: round plushes that roll, a box that tips, the walls
  // Every prize has an angle `a` and a spin `w` as well as a place and a speed. Each contact is worked out at the point where
  // the two touch: they're put apart along the normal, bounced a little, and slowed along the surface (plush is grippy, up to
  // PHYS.mu of the push). That friction at the point is what turns things: a plush rolls, the box tips off an edge it's hanging
  // over. The box is a rectangle at its angle; the plushes are circles.
  // Asleep: a prize that's been still a little while stops moving at all, and holds like the floor (nothing jitters, and a pile
  // at rest sends nothing), until something hits it hard, the claw's prize pushes into it, or the claw takes or lets go of
  // something (wakeAll: whatever was resting on that has to fall).
  const wake = (it) => { it.sleep = false; it.calm = 0; };
  const wakeAll = () => { for (const it of items) { wake(it); it.nudges = 0; } };
  const invM = (it) => (it.held || it.sleep ? 0 : 1 / (it.kind ? B.BOX.mass : it.big ? B.PLUSH.bigMass : B.PLUSH.mass));
  const BOX_I = B.BOX.mass * (4 * B.BOX.hw * B.BOX.hw + 4 * B.BOX.hh * B.BOX.hh) / 12;
  const invI = (it) => (it.held || it.sleep ? 0 : it.kind ? 1 / BOX_I : 1 / (0.5 * (it.big ? B.PLUSH.bigMass : B.PLUSH.mass) * rOf(it) * rOf(it)));
  const norm = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));       // (an angle, -π to π)
  // a and b (b: null for a wall) touch at (px, py), overlapping by `over` along the normal n (from a to b)
  function contact(a, b, px, py, nx, ny, over) {
    if (b && a.sleep !== b.sleep) {       // one asleep: woken by a hard knock, a deep shove, or the claw's prize
      const z = a.sleep ? a : b, o = z === a ? b : a;
      if (o.held || over > 6 || Math.abs((o.vx - z.vx) * nx + (o.vy - z.vy) * ny) > 120) wake(z);
    }
    const ia = invM(a), ib = b ? invM(b) : 0, sum = ia + ib; if (!sum) return;
    const shove = a.held || (b && b.held);       // (a prize in the claw moves the others gently: they're pushed aside, not thrown)
    if (shove) over = Math.min(over, 3);
    a.x -= nx * over * ia / sum; a.y -= ny * over * ia / sum;
    if (b) { b.x += nx * over * ib / sum; b.y += ny * over * ib / sum; }
    const Ia = invI(a), Ib = b ? invI(b) : 0;
    const rax = px - a.x, ray = py - a.y, rbx = b ? px - b.x : 0, rby = b ? py - b.y : 0;
    const rel = () => [(b ? b.vx - b.w * rby : 0) - (a.vx - a.w * ray), (b ? b.vy + b.w * rbx : 0) - (a.vy + a.w * rax)];
    const kick = (Px, Py) => {       // the impulse P on b, and -P on a, at the point
      a.vx -= Px * ia; a.vy -= Py * ia; a.w -= Ia * (rax * Py - ray * Px);
      if (b) { b.vx += Px * ib; b.vy += Py * ib; b.w += Ib * (rbx * Py - rby * Px); }
    };
    let [rvx, rvy] = rel();
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      const ran = rax * ny - ray * nx, rbn = rbx * ny - rby * nx;
      const j = -(1 + PHYS.e) * vn / (sum + ran * ran * Ia + rbn * rbn * Ib);
      kick(j * nx, j * ny);
      [rvx, rvy] = rel();
      const tx = -ny, ty = nx, vt = rvx * tx + rvy * ty, rat = rax * ty - ray * tx, rbt = rbx * ty - rby * tx;
      let jt = -vt / (sum + rat * rat * Ia + rbt * rbt * Ib);
      jt = Math.max(-PHYS.mu * j, Math.min(PHYS.mu * j, jt));
      kick(jt * tx, jt * ty);
    }
    if (shove) for (const q of [a, b]) { if (!q || q.held) continue; const sp = Math.hypot(q.vx, q.vy); if (sp > 260) { q.vx *= 260 / sp; q.vy *= 260 / sp; } q.w = Math.max(-8, Math.min(8, q.w)); }
    if (Math.abs(ny) > 0.5) { if (!a.held) a.rest = true; if (b && !b.held) b.rest = true; }       // one sitting on the other (or on the floor)
  }
  // the box in its own frame: (lx, ly) for a point, and back
  const toBox = (box, x, y) => { const c = Math.cos(box.a), s = Math.sin(box.a), dx = x - box.x, dy = y - box.y; return [dx * c + dy * s, -dx * s + dy * c]; };
  const fromBox = (box, lx, ly) => { const c = Math.cos(box.a), s = Math.sin(box.a); return [box.x + lx * c - ly * s, box.y + lx * s + ly * c]; };
  const corners = (box) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => fromBox(box, sx * B.BOX.hw, sy * B.BOX.hh));
  // a fixed point (the chute guard's top) inside the box: the box pushed off it, the shorter way out
  function boxOffPoint(box, px, py) {
    const [lx, ly] = toBox(box, px, py), ox = B.BOX.hw - Math.abs(lx), oy = B.BOX.hh - Math.abs(ly);
    if (ox <= 0 || oy <= 0) return;
    const c = Math.cos(box.a), s = Math.sin(box.a);
    const [nx, ny] = ox < oy ? [Math.sign(lx) * c, Math.sign(lx) * s] : [-Math.sign(ly) * s, Math.sign(ly) * c];       // (from the box towards the point)
    contact(box, null, px, py, nx, ny, Math.min(ox, oy));
  }
  function pair(a, b) {
    if (!a.kind && !b.kind) {
      const dx = b.x - a.x, dy = b.y - a.y, ra = rOf(a), r = ra + rOf(b), d2 = dx * dx + dy * dy;
      if (d2 >= r * r) return;
      const d = Math.sqrt(d2) || 0.01, nx = d2 ? dx / d : 0, ny = d2 ? dy / d : 1, over = r - d;
      contact(a, b, a.x + nx * (ra - over / 2), a.y + ny * (ra - over / 2), nx, ny, over);
      return;
    }
    if (a.kind && b.kind) return;       // (there's only ever one box)
    const box = a.kind ? a : b, c = a.kind ? b : a, cr = rOf(c), H = B.BOX;       // a plush and the box
    const [lx, ly] = toBox(box, c.x, c.y), qx = Math.max(-H.hw, Math.min(H.hw, lx)), qy = Math.max(-H.hh, Math.min(H.hh, ly));
    const dx = lx - qx, dy = ly - qy, d2 = dx * dx + dy * dy;
    let nlx, nly, over, plx = qx, ply = qy;
    if (d2 > 0.0001) { if (d2 >= cr * cr) return; const d = Math.sqrt(d2); nlx = dx / d; nly = dy / d; over = cr - d; }
    else {       // its middle inside the box: out the nearest side
      const px = H.hw - Math.abs(lx), py = H.hh - Math.abs(ly);
      if (px < py) { nlx = Math.sign(lx) || 1; nly = 0; over = px + cr; plx = nlx * H.hw; } else { nlx = 0; nly = Math.sign(ly) || -1; over = py + cr; ply = nly * H.hh; }
    }
    const co = Math.cos(box.a), si = Math.sin(box.a), [px, py] = fromBox(box, plx, ply);
    contact(box, c, px, py, nlx * co - nly * si, nlx * si + nly * co, over);
  }
  // The walls, each with an inside: however hard something is shoved (a prize the claw is lifting pushes like a wall itself),
  // it's put back on its own side, never through. The sides and the floor are whole planes; the chute's guard keeps each
  // prize on the side it was on, and its top is a corner things can roll (or tip) off. A plush touches them at one point;
  // the box at each corner that's through.
  function walls(it) {
    const G = B.CHUTE, side = (it.px === undefined ? it.x : it.px) < G.x2 ? -1 : 1;       // (which side of the guard it was on before this step)
    if (it.kind) {
      for (const [cx, cy] of corners(it)) {
        if (cx < B.WALL.l) contact(it, null, cx, cy, -1, 0, B.WALL.l - cx);
        if (cx > B.WALL.r) contact(it, null, cx, cy, 1, 0, cx - B.WALL.r);
        if (side > 0 && cy > B.FLOOR) contact(it, null, cx, cy, 0, 1, cy - B.FLOOR);
        if (it.y >= G.top && cy > G.top) {       // beside the guard: kept on its side
          if (side < 0 && cx > G.x2) contact(it, null, cx, cy, 1, 0, cx - G.x2);
          if (side > 0 && cx < G.x2) contact(it, null, cx, cy, -1, 0, G.x2 - cx);
        }
      }
      if (it.y < G.top) boxOffPoint(it, G.x2, G.top);       // over the guard: its top a corner
      return;
    }
    const r = rOf(it);
    if (it.x < B.WALL.l + r) contact(it, null, B.WALL.l, it.y, -1, 0, B.WALL.l + r - it.x);
    if (it.x > B.WALL.r - r) contact(it, null, B.WALL.r, it.y, 1, 0, it.x + r - B.WALL.r);
    if (side > 0 && it.y > B.FLOOR - r) contact(it, null, it.x, B.FLOOR, 0, 1, it.y + r - B.FLOOR);
    if (it.y + r <= G.top) return;
    if (it.y >= G.top) {       // beside the guard: kept on its side
      if (side < 0 && it.x > G.x2 - r) contact(it, null, G.x2, it.y, 1, 0, it.x + r - G.x2);
      if (side > 0 && it.x < G.x2 + r) contact(it, null, G.x2, it.y, -1, 0, G.x2 + r - it.x);
      return;
    }
    const dx = it.x - G.x2, dy = it.y - G.top, d2 = dx * dx + dy * dy;       // its middle above the guard's top, its bottom below: on the corner
    if (d2 >= r * r) return;
    const d = Math.sqrt(d2) || 0.01;
    contact(it, null, G.x2, G.top, -(dx / d), -(d2 ? dy / d : -1), r - d);
  }
  function physics() {
    const dt = PHYS.dt;
    for (const it of items) {
      if (it.held || it.sleep) continue;
      it.px = it.x; it.py = it.y; it.vy += PHYS.g * dt; it.x += it.vx * dt; it.y += it.vy * dt; it.a = norm(it.a + it.w * dt); it.rest = false;
    }
    for (let k = 0; k < PHYS.iters; k++) {
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if ((a.sleep && b.sleep) || Math.abs(a.x - b.x) > 100 || Math.abs(a.y - b.y) > 100) continue;
        pair(a, b);
      }
      for (const it of items) if (!it.held && !it.sleep) walls(it);
    }
    for (const it of items) {
      if (it.held || it.sleep) continue;
      // at rest it stays at rest, no creeping: slowed while it touches something (a plush rolls a little and stops), and still
      // once it's barely moving (a box tipping over an edge is spinning faster than that, so it goes on over)
      if (it.rest) { it.vx *= 0.9; it.w *= it.kind ? 0.9 : 0.88; if (Math.hypot(it.vx, it.vy) < 6 && Math.abs(it.w) < (it.kind ? 0.05 : 0.4)) { it.vx = 0; it.vy = Math.min(it.vy, 0); it.w = 0; } }
      const sp = Math.hypot(it.vx, it.vy); if (sp > 1600) { it.vx *= 1600 / sp; it.vy *= 1600 / sp; }
      it.w = Math.max(-25, Math.min(25, it.w));
      // still (by where it actually got to this step, not its speed) for 0.4 s: asleep. (Only something held up can be that
      // still that long: falling, it gains 12.5 a second every step.)
      if (Math.hypot(it.x - it.px, it.y - it.py) / dt < 8 && Math.abs(it.w) < 0.6) { if (++it.calm >= 48) { it.sleep = true; it.vx = 0; it.vy = 0; it.w = 0; } } else it.calm = 0;
      // balanced on the chute's guard: tipped off it, to whichever side its middle is on
      // (each of these nudges a few times at most, until the claw next takes or drops something: one that's pinned where it
      // is stays there, and falls asleep, rather than being nudged for ever)
      if (Math.abs(it.x - B.CHUTE.x2) < half(it).w && it.y < B.CHUTE.top && sp < 20 && (it.nudges || 0) < 4) { if (++it.still > 40) { it.vx += (it.x < B.CHUTE.x2 ? -1 : 1) * 60; it.still = 0; it.nudges = (it.nudges || 0) + 1; } }
      // a plush come to rest on top of the box: the gift wrap is slippery, it slides off (so the box can't be buried)
      else if (!it.kind && sp < 20 && (it.nudges || 0) < 4 && items.some((b) => b.kind && !b.held && Math.abs(it.x - b.x) < half(b).w + 6 && it.y < b.y - half(b).h)) {
        if (++it.still > 30) { const b = items.find((q) => q.kind); it.vx += (it.x < b.x ? -1 : 1) * 70; it.still = 0; it.nudges = (it.nudges || 0) + 1; }
      } else it.still = 0;
      if (it.y > B.CHUTE.out && it.x < B.CHUTE.x2) win(it);
      else if (it.y > B.H + 60 || it.x < 0 || it.x > B.W) { it.gone = true; anew(it.kind, it.big); }       // (never happens: but if it did, it comes back in)
    }
    if (items.some((it) => it.gone)) items = items.filter((it) => !it.gone);
  }
  function win(it) {
    it.gone = true;
    const pay = it.kind ? R.grandPay : it.big ? R.bigPay : R.plushPay, won = it.kind ? 1 : it.big ? 2 : 0;
    events.push(['w', won, Math.round(it.x), Math.round(it.y)]);
    const who = go || last[0];       // (whoever's try it was: a prize can still be rolling in as the next one starts)
    if (who) {
      const s = seats[seatOf(who.id)];
      if (s) { s.chips += pay; s.won += pay; } else if (opts.wallet && opts.wallet.owns(who.id)) { const w = opts.wallet.peek(who.id); opts.wallet.set(who.id, { chips: w.chips + pay, outUntil: w.outUntil }); }
      if (go) { go.won += pay; go.kinds.push(won); refill.push([it.kind, it.big]); }       // (replaced when the try's over: finish)
      else { who.won += pay; who.kinds.push(won); }       // the last try's, still rolling in after it ended: its record, and a new one now
    }
    if (!go) anew(it.kind, it.big);
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
      if (it.kind) { const h = half(it); hit = Math.abs(it.x - claw.x) < h.w + s * 0.6 && y >= it.y - h.h; }       // (the box as it lies, tipped or not)
      else { const r = rOf(it), dx = Math.max(0, Math.abs(it.x - claw.x) - s * 0.6); hit = dx < r && y >= it.y - Math.sqrt(r * r - dx * dx); }
      if (hit && (!best || it.y - half(it).h < best.y - half(best).h)) best = it;
    }
    return best;
  }
  // How likely the claw is to hold a prize it closes on: its kind's chance dead centre, less by how far from its middle it
  // came down (`d` across: to nothing at R.within), and by how fast the head was still swinging across as it landed (a claw
  // that comes down swinging drags, and holds worse). A tipped box holds worse again (but see cornerCatch). Precision
  // decides it: dead centre and steady, it's held more often than not; a little off, much less.
  const grip = (it, d, vx) => (it.kind ? R.boxGrip * (1 - 0.6 * tipped(it)) : R.plushGrip * (it.big ? R.bigGrip : 1)) * Math.max(0, 1 - (d / (it.kind ? R.boxWithin : R.within)) ** 2) / (1 + Math.abs(vx || 0) / R.swingGrip);
  // (how far the box is tipped from lying square on a side: 0 square, 1 balanced on a corner)
  const tipped = (box) => { const q = Math.abs(norm(box.a * 2) / 2); return Math.min(q, Math.PI / 2 - q) / (Math.PI / 4); };
  const REACH = [30, 40, 38];       // how far off a prize's middle the claw can be and still get its prongs round it (plush, box, big plush)
  const reachOf = (it) => REACH[it.big ? 2 : it.kind];
  // A tipped box's corners are sticky: its top corner, the one sticking up, catches on the prongs if the claw comes down right
  // on it (within cornerReach across), and then holds by cornerGrip (80%), however tipped it is or the claw's swinging. Only
  // tipped: a box lying square has no corner up to catch.
  function cornerCatch(y) {
    const box = items.find((q) => q.kind && !q.held), tip = box ? tipped(box) : 0;
    if (!box || tip < 0.15) return 0;
    const [cx, cy] = corners(box).reduce((p, q) => (q[1] < p[1] ? q : p)), d = Math.abs(cx - claw.x);
    if (d >= R.cornerReach || cy > y + 8 || cy < y - 30) return 0;
    return R.cornerGrip;       // (a hook is a hook: it holds by cornerGrip, flat)
  }
  function close() {
    const y = tipY();
    let it = null, off = 1;
    for (const q of items) {
      if (q.held) continue;
      const h = half(q), o = Math.abs(q.x - claw.x) / reachOf(q);
      if (o < 1 && q.y - h.h <= y + 8 && q.y + h.h >= y - 6 && o < off) { it = q; off = o; }
    }
    const hook = cornerCatch(y);       // (on a tipped box's top corner: that's what it closes on)
    if (hook) { it = items.find((q) => q.kind && !q.held); off = 0; }
    events.push(['c', Math.round(claw.x), Math.round(y)]);
    if (hook) events.push(['k', Math.round(claw.x), Math.round(y)]);
    if (!it) {       // nothing between the prongs: they push what's beside them as they close
      for (const q of items) if (!q.held && Math.abs(q.x - claw.x) < B.CLAW.span + half(q).w + 6 && Math.abs(q.y - y) < half(q).h + 20) { q.sleep = false; q.calm = 0; q.vx += (q.x < claw.x ? 1 : -1) * 70; }
      go.plan = 'none';
      return;
    }
    const holds = rand(1000000) < (hook ? hook : grip(it, off * reachOf(it), go.vx)) * 1000000;
    go.hooked = !!hook;
    if (holds) go.plan = 'hold';
    else { const r = rand(100); go.plan = r < 45 ? 'slide' : r < 85 ? 'lift' : 'carry'; }
    // where it lets go, if it does: just off the pile, part way up, or part way home
    const climb = claw.y - B.CLAW.top;
    go.slipAt = go.plan === 'slide' ? claw.y - (12 + rnd() * 30) : go.plan === 'lift' ? claw.y - climb * (0.3 + rnd() * 0.65) : go.plan === 'carry' ? claw.x - (claw.x - B.RAIL.home) * (0.15 + rnd() * 0.75) : 0;
    go.item = it.id; go.dx = (it.x - claw.x) * 0.5; go.kind = it.kind; go.off = Math.round(off * 100) / 100; go.drag = Math.round(Math.abs(go.vx || 0));
    it.held = true; it.vx = 0; it.vy = 0; it.w = 0; wakeAll();
  }
  function slip() {
    const it = items.find((q) => q.id === go.item); go.item = null;
    if (!it) return;
    it.held = false; it.vx = (rnd() - 0.5) * 40; it.vy = 20; it.w = (rnd() - 0.5) * 3; wakeAll();
    go.slipped = true;
    events.push(['s', it.kind, Math.round(it.x), Math.round(it.y)]);
    changed();
  }
  function carry(dt) {       // the held prize goes where the claw goes, swinging with it (a doomed one jiggles in the prongs, a tell)
    const it = go && go.item ? items.find((q) => q.id === go.item) : null; if (!it) return;
    const sway = go.plan === 'hold' || step === 'grab' ? 0 : Math.sin(simT / 70) * 1.8;
    const nx = claw.x + go.dx + sway, ny = tipY() - half(it).h * (it.kind ? 0.25 : 0.5);       // (the prongs under its middle: the box held low, clear of the claw's head)
    it.vx = (nx - it.x) / dt; it.vy = (ny - it.y) / dt; it.x = nx; it.y = ny;
    // the prongs straighten it as they close and lift: the box onto its nearest side, a plush the right way up
    const want = it.kind ? Math.round(it.a / (Math.PI / 2)) * (Math.PI / 2) : 0;
    it.a = norm(it.a + norm(want - it.a) * (step === 'grab' ? 0.03 : 0.06)); it.w = 0;
  }
  // The carriage, and the head swinging under it: a pendulum from SWING.pivot above the rail, pushed by the carriage's
  // speeding up and slowing down (`a`), damped, and swinging faster as the cable is reeled in (slower let out).
  function swing(dt, a, damp) {
    const S = B.SWING, L = claw.y - B.RAIL.y + S.pivot, dL = claw.L ? (L - claw.L) / dt : 0, x0 = claw.x;
    claw.L = L;
    claw.om += (-(PHYS.g / L) * Math.sin(claw.th) - S.push * (a / L) * Math.cos(claw.th) - 2 * (dL / L) * claw.om - damp * claw.om) * dt;
    claw.th += claw.om * dt;
    claw.x = claw.cx + L * Math.sin(claw.th);
    const lo = B.WALL.l + B.CLAW.span, hi = B.WALL.r - B.CLAW.span;       // (the glass: it knocks off the side, it doesn't go through)
    if (claw.x < lo || claw.x > hi) { claw.x = Math.max(lo, Math.min(hi, claw.x)); claw.th = Math.asin(Math.max(-1, Math.min(1, (claw.x - claw.cx) / L))); claw.om *= -0.3; }
    claw.vx = (claw.x - x0) / dt;
  }
  function brake(dt) {       // the carriage stopping (Drop): it slides on till the brake has it
    const S = B.SWING, v0 = claw.cv, v = Math.sign(v0) * Math.max(0, Math.abs(v0) - S.brake * dt);
    claw.cx = Math.max(B.RAIL.min, Math.min(B.RAIL.max, claw.cx + v * dt)); claw.cv = v;
    return (v - v0) / dt;
  }
  function clawStep() {
    const dt = PHYS.dt, C = B.CLAW, S = B.SWING;
    const sinceStep = simT - stepAt;
    let a = 0, damp = S.damp;
    if (step === 'move') {
      hist.push({ t: simT, c: { cx: claw.cx, cv: claw.cv, th: claw.th, om: claw.om, x: claw.x, vx: claw.vx, y: claw.y, L: claw.L } });
      if (hist.length > 70) hist.shift();
      const nx = B.sweepAt(simT + dt * 1000 - go.at), v = (nx - claw.cx) / dt;
      a = (v - claw.cv) / dt; claw.cx = nx; claw.cv = v;
      if (simT >= go.until) to('down');
      claw.open += (1 - claw.open) * 0.08;
    } else if (step === 'down') {
      a = brake(dt);
      claw.open += (1 - claw.open) * 0.2;
      if (touching() || claw.y >= C.low) {       // its feet on something: it sinks in a little, and the prize steadies it
        if (!go.sink) { go.sink = claw.y; go.vx = claw.vx; }
        claw.om *= 0.9;
        if (claw.y - go.sink >= 6 || claw.y >= C.low) { go.sink = 0; to('grab'); close(); } else claw.y += C.down * 0.4 * dt;
      } else claw.y = Math.min(C.low, claw.y + C.down * dt);
    } else if (step === 'grab') {
      // (closing on something: the head stays where it came down, the cable as it was)
      claw.om = 0; claw.cv = 0; claw.vx = 0; claw.L = claw.y - B.RAIL.y + S.pivot;
      const it = go.item ? items.find((q) => q.id === go.item) : null;
      const want = it ? (it.kind ? 0.9 : 0.42) : 0;       // (round its sides: renderer/crane.js arm)
      claw.open += (want - claw.open) * 0.09;
      if (sinceStep >= T.close + T.hold) to('up');
      carry(dt);
      return;
    } else if (step === 'up') {       // (from wherever it came down: if the cable was slanted, it swings back under the carriage)
      claw.y = Math.max(C.top, claw.y - C.up * dt);
      if (go.item && (go.plan === 'slide' || go.plan === 'lift') && claw.y <= go.slipAt) slip();
      if (claw.y <= C.top) to('home');
    } else if (step === 'home') {       // speeding up, and slowing to a stop over the chute: it opens once the swing has (nearly) died
      const left = claw.cx - B.RAIL.home, want = -Math.min(C.speed, Math.sqrt(2 * S.accel * Math.max(0, left)));
      const v0 = claw.cv; claw.cv += Math.max(-S.accel * dt, Math.min(S.accel * dt, want - v0));
      claw.cx = Math.max(B.RAIL.home, claw.cx + claw.cv * dt); a = (claw.cv - v0) / dt;
      if (claw.cx <= B.RAIL.home + 0.5) { claw.cx = B.RAIL.home; claw.cv = 0; if (!go.homeAt) go.homeAt = simT; }
      if (go.item && go.plan === 'carry' && claw.cx <= go.slipAt) slip();
      if (go.homeAt) { damp = S.rest; if (Math.abs(claw.x - B.RAIL.home) < 16 || simT - go.homeAt > 1500) to('release'); }
    } else if (step === 'release') {
      claw.open += (1 - claw.open) * 0.12;
      if (go.item && claw.open > 0.6) { const it = items.find((q) => q.id === go.item); if (it) { it.held = false; it.vx = claw.vx * 0.5; it.vy = 40; wakeAll(); } go.item = null; events.push(['r']); }
      if (sinceStep >= T.release) to('settle');
    } else if (step === 'settle') {
      claw.open += (0.55 - claw.open) * 0.05; damp = S.rest;
      const moving = items.some((q) => Math.hypot(q.vx, q.vy) > 14);
      if (sinceStep >= T.settleMax || (sinceStep >= T.settleMin && !moving)) finish();
    } else damp = S.rest;       // ('ready': still)
    swing(dt, a, damp);
    if (step === 'ready' && Math.abs(claw.om) < 0.002 && Math.abs(claw.th) < 0.0005) { claw.om = 0; claw.th = 0; claw.x = claw.cx; claw.vx = 0; }
    carry(dt);
  }
  function finish() {
    const g = go; go = null;
    g.done = true;
    last.unshift({ n: g.n, id: g.id, name: g.name, won: g.won, kinds: g.kinds.slice(), slipped: g.slipped, missed: g.plan === 'none' });
    last = last.slice(0, 6);
    if (g.won > 0 && opts.onSettle) try { opts.onSettle([{ id: g.id, name: g.name, net: g.won, score: g.won }]); } catch { /* theirs to get right */ }
    // a new prize for each one won, dropped in over the pile
    for (const [k, big] of refill) anew(k, big);       // (each the size it was: half the plushes stay big)
    refill = [];
    to('ready');
    const s = seats[0];
    if (s && s.id === g.id) { s.since = now(); if (s.left) free(); else if (watchers.length) passOn(); }
  }

  function frame() {
    const list = [];
    for (const it of items) list.push(it.id, it.kind + (it.held ? 2 : 0) + (it.big ? 4 : 0), Math.round(it.x * 2), Math.round(it.y * 2), Math.round(norm(it.a) * 100));       // (half units; 1 the box, 2 held, 4 a big plush; the angle in hundredths)
    frames.push({ t: Math.round(simT), c: [Math.round(claw.x * 2), Math.round(claw.y * 2), Math.round(claw.open * 100), Math.round(claw.cx * 2)], i: list, e: events });
    events = [];
    seq++;
    if (frames.length > PHYS.keep) frames.splice(0, frames.length - PHYS.keep);
  }
  // only when something's moved (a pile at rest sends nothing)
  function moved() {
    const k = [Math.round(claw.x * 2), Math.round(claw.y * 2), Math.round(claw.open * 100), Math.round(claw.cx * 2)];
    for (const it of items) k.push(it.id, it.held ? 1 : 0, Math.round(it.x * 2), Math.round(it.y * 2), Math.round(norm(it.a) * 100));
    const key = k.join(',');
    if (key === lastSent && !events.length) return false;
    lastSent = key; return true;
  }

  // the pile shaken down before anyone sees it
  for (let i = 0; i < 480; i++) physics();
  for (const it of items) { it.vx = 0; it.vy = 0; it.w = 0; }
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
      start: R.start, cost: R.cost, pays: { plush: R.plushPay, big: R.bigPay, grand: R.grandPay },
      play: go ? { n: go.n, name: go.name, mine: go.id === id, msLeft: step === 'move' ? Math.max(0, go.until - simT) : 0, holding: go.item ? go.kind : -1,
        slipped: go.slipped, won: go.won, kinds: go.kinds.slice(), missed: go.plan === 'none', hooked: !!go.hooked } : null,
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
    get inkRev() { return 2; }, get inkLen() { return seq; },
    get version() { return version; }, get phase() { return phase; }, tickMs: 50,
    seated: () => seats.filter(Boolean).map((x) => x.id),
    _items: () => items, _claw: () => claw, _rules: R, _step: () => step,       // (tests)
    _grip: (kind, big, d, vx, a) => grip({ kind, big, a: a || 0 }, d, vx),       // (tests: the chance of a hold, `d` across off its middle)
  };
}

module.exports = { createTable, RULES, TIMES, PHYS, BOARD: B };
