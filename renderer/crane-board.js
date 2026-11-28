/* Drift — the crane machine's box (docs/plans/crane.md §2): where the walls, the chute and the claw's rail are, and how big the
   prizes are. One file for both sides: crane.js (main.js alone, hub.js at a hub) runs the claw and the prizes in it, and
   renderer/crane.js draws it. Units: 900 across, 960 down, y down. `rev` changes whenever the layout does, so a screen can tell a
   hub's machine isn't its own.

     const B = driftCraneBoard   (in Node: require('./renderer/crane-board.js'))

   The claw hangs from a carriage on the rail at the top. It starts over the chute (front left), moves right over the pile of
   prizes, drops, closes, goes back up and home over the chute, and opens. A prize that falls through the chute's mouth is won. */
(function () {
  const W = 900, H = 960;
  const FLOOR = 880;       // the pile's floor
  const WALL = { l: 20, r: 880 };       // the box's sides (inside)
  // the prize chute: open from the left wall to its guard (x2), from the guard's top down; a prize past `out` is won. The guard
  // stands well above the pile, so nothing spills in by itself: a prize goes in from the claw.
  const CHUTE = { x1: WALL.l, x2: 150, top: 600, out: 932 };
  const RAIL = { y: 48, home: 85, min: 85, max: 850 };       // the claw's rail, where the claw waits (over the chute), and how far it goes
  // The claw: its head hangs `head` under the carriage at its highest, the prongs reach `reach` below the head's middle when
  // open, and spread `span` either side. It goes no lower than `low` (its tips just off the floor).
  const CLAW = { top: 96, head: 22, reach: 58, span: 30, low: FLOOR - 58 - 4, speed: 190, down: 270, up: 220 };
  // Once a try is in, the claw sweeps by itself: out from over the chute to the far end (x2), then back and forth over the pile
  // between x1 and x2, easing into each end and fastest over the middle (`speed` a second at most). Pressing Drop brakes the
  // carriage where it is then (sweepAt) and the claw comes down.
  const SWEEP = { x1: 190, x2: 850, speed: 420 };
  // The claw's head hangs on its cable like a pendulum from the carriage (swung from `pivot` above the rail, the cable reeled
  // inside it): the carriage speeding up or braking swings it, `push` of what a rigid hang would get, and it dies away by
  // `damp` (much faster once the try is over). Drop brakes the carriage at `brake` a second², so it slides on a little, and the
  // head swings on past it as it goes down. Coming home it speeds up and slows at `accel`.
  const SWING = { pivot: 60, push: 0.3, damp: 0.6, rest: 3, brake: 2600, accel: 520 };
  // The prizes: cat plushes (round, give a little) and the grand prize, a gift box (a heavy rectangle that never tips)
  // (half of them big ones: `big` across instead of `r`, and heavier)
  const PLUSH = { r: 29, mass: 1, big: 39, bigMass: 1.8 };
  const BOX = { hw: 44, hh: 34, mass: 2.6 };
  // The pile as it's set out (then shaken down by the physics): a row of plushes right across the floor, small and big turn
  // about (but two big ones in the middle), and on it a pyramid of plushes at each end, each sitting in the hollow between the two under it. Between the two
  // pyramids the pile dips, and the grand prize sits in the dip, on the bottom row. Each is [kind, x, y, big]: half are big.
  const PILE = [];
  const rad = (big) => (big ? PLUSH.big : PLUSH.r);
  // (the bottom row, small and big turn about either side, and the middle two, which carry the box, both big: so it starts
  // level, and a level box has no corner up to catch on the claw)
  const ROW = [0, 1, 0, 1, 1, 1, 1, 0, 1, 0], ACROSS = ROW.length, SIDE = 4;       // (each pyramid's foot: SIDE)
  const base = []; let x = 0;
  for (const big of ROW) { const r = rad(big); base.push([x + r, r, big]); x += 2 * r + 1; }
  const shift = (CHUTE.x2 + WALL.r) / 2 - (x - 1) / 2;
  const bottom = base.map(([bx, r, big]) => [bx + shift, FLOOR - r - 1, r, big]);
  // (each row above goes over the gaps in the one under it, held clear of it: the shake-down drops it into the hollows.
  // A row never has two big ones side by side, so it fits over the gaps.)
  for (const p of bottom) PILE.push([0, p[0], p[1], p[3]]);
  for (const [from, sizes] of [[0, [[1, 0, 1], [0, 0]]], [ACROSS - SIDE, [[1, 0, 1], [0, 0]]]]) {       // (10 big of 20)
    let row = bottom.slice(from, from + SIDE);
    for (const want of sizes) {
      const top = Math.min(...row.map((p) => p[1] - p[2]));
      row = want.map((big, k) => [(row[k][0] + row[k + 1][0]) / 2, top - rad(big) - 4, rad(big), big]);
      for (const p of row) PILE.push([0, p[0], p[1], p[3]]);
    }
  }
  const VALLEY = (bottom[ACROSS / 2 - 1][0] + bottom[ACROSS / 2][0]) / 2;       // the dip's middle
  PILE.push([1, VALLEY, FLOOR - 2 * PLUSH.big - BOX.hh - 2, 0]);
  // Where a new prize (a plush or the grand prize) comes in from: anywhere along the top, falling onto the pile
  const DROP = { x1: 200, x2: 850, y: 150 };

  // the fixed walls: the floor (from the chute's guard to the right wall), the sides, the guard. All straight across or down.
  const segs = [
    [CHUTE.x2, FLOOR, WALL.r, FLOOR],
    [WALL.l, 0, WALL.l, H],
    [WALL.r, 0, WALL.r, FLOOR],
    [CHUTE.x2, CHUTE.top, CHUTE.x2, FLOOR],
  ];

  let h = 0;
  for (const s of segs) h = (h * 17 + Math.round(s[0] + s[1] * 3 + s[2] * 7 + s[3] * 11)) % 1000003;
  h = (h * 13 + W * 7 + H) % 1000003;
  for (const o of [CHUTE, RAIL, CLAW, SWEEP, SWING, PLUSH, BOX]) for (const v of Object.values(o)) h = (h * 13 + Math.round(v * 10)) % 1000003;

  // Where the sweeping claw is `ms` after it set off: the same on the table and on every screen
  // (each leg eased like a cosine: still at its ends, `speed` over its middle)
  const LEG = (d) => d * Math.PI / (2 * SWEEP.speed);       // how long a leg of length d takes, in seconds
  function sweepAt(ms) {
    const t = Math.max(0, ms) / 1000, first = SWEEP.x2 - RAIL.home, w = SWEEP.x2 - SWEEP.x1, out = LEG(first), pass = LEG(w);
    if (t < out) return RAIL.home + first * (1 - Math.cos(Math.PI * t / out)) / 2;
    const p = (t - out) % (2 * pass), e = (1 - Math.cos(Math.PI * (p < pass ? p : p - pass) / pass)) / 2;
    return p < pass ? SWEEP.x2 - w * e : SWEEP.x1 + w * e;
  }

  const B = { W, H, FLOOR, WALL, CHUTE, VALLEY, RAIL, CLAW, SWEEP, SWING, PLUSH, BOX, PILE, DROP, segs, sweepAt, rev: 'c' + h.toString(36) };
  if (typeof module !== 'undefined' && module.exports) module.exports = B; else window.driftCraneBoard = B;
})();
