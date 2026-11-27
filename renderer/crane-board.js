/* Drift — the crane machine's box (docs/plans/crane.md §2): where the walls, the chute and the claw's rail are, and how big the
   prizes are. One file for both sides: crane.js (main.js alone, hub.js at a hub) runs the claw and the prizes in it, and
   renderer/crane.js draws it. Units: 600 across, 800 down, y down. `rev` changes whenever the layout does, so a screen can tell a
   hub's machine isn't its own.

     const B = driftCraneBoard   (in Node: require('./renderer/crane-board.js'))

   The claw hangs from a carriage on the rail at the top. It starts over the chute (front left), moves right over the pile of
   prizes, drops, closes, goes back up and home over the chute, and opens. A prize that falls through the chute's mouth is won. */
(function () {
  const W = 600, H = 800;
  const FLOOR = 720;       // the pile's floor
  const WALL = { l: 20, r: 580 };       // the box's sides (inside)
  const CHUTE = { x1: WALL.l, x2: 146, top: 588, out: 772 };       // the prize chute: open from the left wall to its guard (x2), from the guard's top down; a prize past `out` is won
  const RAIL = { y: 48, home: 83, min: 83, max: 540 };       // the claw's rail, where the claw waits (over the chute), and how far it goes
  // The claw: its head hangs `head` under the carriage at its highest, the prongs reach `reach` below the head's middle when
  // open, and spread `span` either side. It goes no lower than `low` (its tips just off the floor).
  const CLAW = { top: 96, head: 22, reach: 58, span: 30, low: FLOOR - 58 - 4, speed: 170, down: 230, up: 190 };
  // Once a try is in, the claw sweeps by itself: out from over the chute to the far end (x2), then back and forth over the pile
  // between x1 and x2, `speed` a second. Pressing Drop is the whole game: it comes down wherever it is then (sweepAt).
  const SWEEP = { x1: 175, x2: 540, speed: 240 };
  // The prizes: cat plushes (round, give a little) and the grand prize, a gift box (a heavy rectangle that never tips)
  const PLUSH = { r: 29, mass: 1 };
  const BOX = { hw: 44, hh: 34, mass: 2.6 };
  // The pile as it's set out (then shaken down by the physics): three rows of plushes and the box on top
  const PILE = [];
  for (let k = 0; k < 7; k++) PILE.push([0, 186 + k * 60, FLOOR - 30]);
  for (let k = 0; k < 6; k++) PILE.push([0, 216 + k * 60, FLOOR - 84]);
  for (let k = 0; k < 7; k++) PILE.push([0, 186 + k * 60, FLOOR - 138]);
  PILE.push([1, 360, FLOOR - 214]);
  // Where a new prize comes in from (over the pile, above everything)
  const DROP = { x1: 200, x2: 540, y: 150 };

  // the fixed walls: the floor (from the chute's guard to the right wall), the sides, the guard. All straight across or down.
  const segs = [
    [CHUTE.x2, FLOOR, WALL.r, FLOOR],
    [WALL.l, 0, WALL.l, H],
    [WALL.r, 0, WALL.r, FLOOR],
    [CHUTE.x2, CHUTE.top, CHUTE.x2, FLOOR],
  ];

  let h = 0;
  for (const s of segs) h = (h * 17 + Math.round(s[0] + s[1] * 3 + s[2] * 7 + s[3] * 11)) % 1000003;
  for (const o of [CHUTE, RAIL, CLAW, SWEEP, PLUSH, BOX]) for (const v of Object.values(o)) h = (h * 13 + Math.round(v * 10)) % 1000003;

  // Where the sweeping claw is `ms` after it set off: the same on the table and on every screen
  function sweepAt(ms) {
    const u = Math.max(0, ms) / 1000 * SWEEP.speed, first = SWEEP.x2 - RAIL.home, w = SWEEP.x2 - SWEEP.x1;
    if (u < first) return RAIL.home + u;
    const p = (u - first) % (2 * w);
    return p < w ? SWEEP.x2 - p : SWEEP.x1 + (p - w);
  }

  const B = { W, H, FLOOR, WALL, CHUTE, RAIL, CLAW, SWEEP, PLUSH, BOX, PILE, DROP, segs, sweepAt, rev: 'c' + h.toString(36) };
  if (typeof module !== 'undefined' && module.exports) module.exports = B; else window.driftCraneBoard = B;
})();
