/* Drift — the pachinko machine's board (docs/plans/pachinko.md §2): where the pins, the rails and the pockets are. One file for
   both sides: pachinko.js (main.js alone, hub.js at a hub) runs the balls over it, renderer/pachinko.js draws it. Units: 600
   across, 900 down, y down. `rev` changes whenever the layout does, so a screen can tell a hub's board isn't its own.

     const B = driftPachinkoBoard   (in Node: require('./renderer/pachinko-board.js'))
     B.pins [[x, y]]   B.segs [[x1, y1, x2, y2]] (fixed walls)   B.gate / B.tulips / B.start (the pockets)   B.window (the reels)

   The ball goes up the lane on the right (between B.lane.x and the outer wall), round the arc at the top, and drops onto the
   pins further left the harder it was sent. A ball that falls back into the lane is a foul and comes back to you. */
(function () {
  const W = 600, H = 900, BALL = 5.5, PIN = 2.4;
  const ARC = { x: 300, y: 330, r: 292 };       // the outer rail's round top
  const LANE = { x: 568, out: 592, top: 352 };       // the launch lane: its inner wall, the outer wall, where the inner wall stops
  const WIN = { x: 188, y: 196, w: 224, h: 262, roof: 172 };       // the reels' window (its arched top peaks at y = roof)
  const START = { x: 300, y: 604, half: 9 };       // the start pocket under the window: a cup (posts at x ± half)
  const TULIPS = [{ x: 128, y: 652, half: 9 }, { x: 472, y: 652, half: 9 }];
  const GATE = { x1: 248, x2: 352, y: 758 };       // the big gate: open only in a fever (shut, there's nothing there: balls go on down to the drain)
  const DRAIN = { y: 880 };
  // The trampoline: a springy mat that slides from side to side over the lower board (x = x ± amp, once every `period` ms,
  // pachinko.js trampAt), bouncing what lands on it back up at least `kick` fast. Nothing else is in its lane.
  const TRAMP = { x: 300, y: 716, half: 30, amp: 190, period: 5600, kick: 560 };

  const segs = [], pins = [];
  const seg = (x1, y1, x2, y2) => segs.push([x1, y1, x2, y2]);
  const poly = (pts) => { for (let i = 1; i < pts.length; i++) seg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); };

  // ---- the frame: the arc over the top, the walls, the floor sloping to the drain, the lane ----
  const arc = [];
  for (let i = 0; i <= 60; i++) { const a = Math.PI + (i / 60) * Math.PI; arc.push([ARC.x + ARC.r * Math.cos(a), ARC.y + ARC.r * Math.sin(a)]); }
  poly(arc);
  seg(ARC.x - ARC.r, ARC.y, ARC.x - ARC.r, 836);       // left wall
  seg(LANE.out, ARC.y, LANE.out, 892);       // outer wall (the lane's right side)
  seg(LANE.x, 892, LANE.x, LANE.top);       // the lane's inner wall
  seg(LANE.x, 892, LANE.out, 892);       // the lane's floor, where fouls come back to
  seg(ARC.x - ARC.r, 836, 258, DRAIN.y - 2);       // the floor, both sides down to the drain (steep enough that nothing dawdles)
  seg(LANE.x, 836, 342, DRAIN.y - 2);

  // ---- the window: straight sides, an arched roof the balls roll off. Pointed a little at the top (part gable, part
  // curve): a round arch is flat at its peak, and a ball could balance there ----
  const roofY = (f) => WIN.y + 44 - (WIN.y + 44 - WIN.roof) * (0.6 * (1 - Math.abs(2 * f - 1)) + 0.4 * Math.sin(f * Math.PI));
  const roof = [];
  for (let i = 0; i <= 12; i++) { const f = i / 12; roof.push([WIN.x + f * WIN.w, roofY(f)]); }
  poly([[WIN.x, WIN.y + WIN.h], ...roof, [WIN.x + WIN.w, WIN.y + WIN.h]]);
  seg(WIN.x, WIN.y + WIN.h, WIN.x + WIN.w, WIN.y + WIN.h);

  // ---- the pockets' posts ----
  const cup = (p, depth) => { seg(p.x - p.half, p.y - 4, p.x - p.half, p.y + depth); seg(p.x + p.half, p.y - 4, p.x + p.half, p.y + depth); seg(p.x - p.half, p.y + depth, p.x + p.half, p.y + depth); };
  cup(START, 12);
  for (const t of TULIPS) cup(t, 12);

  // ---- the pins: staggered rows, kept off the window, the pockets' mouths, the gate and the lane; guards beside each pocket ----
  const near = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 < r * r;
  // the roads: a close row of pins from under each side of the window down towards the start pocket, that a ball rolls along.
  // A ball sent to drop just beside the window has the best chance at the reels (the aim the handle is for)
  // (each starts so a ball sliding down the window's side lands between two of its pins, not balanced on top of one)
  const ROADS = [[[WIN.x - 16, WIN.y + WIN.h + 10], [START.x - 84, START.y - 96]], [[WIN.x + WIN.w + 16, WIN.y + WIN.h + 10], [START.x + 84, START.y - 96]]];
  const offRoad = (x, y) => ROADS.every(([a, b]) => {
    const ex = b[0] - a[0], ey = b[1] - a[1], u = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / (ex * ex + ey * ey)));
    return Math.hypot(x - a[0] - ex * u, y - a[1] - ey * u) > 15;
  });
  // (every row's pins at least 21 from the wall and 15 from the lane: a ball fits past them all, so none can wedge there.
  // The pin 10 from the wall that every other row had is gone: balls rested between it and the wall)
  for (let row = 0, y = 118; y < 828; row++, y += 25) {
    for (let x = row % 2 ? 32 : 46; x < LANE.x - 10; x += 28) {
      if (Math.hypot(x - ARC.x, y - ARC.y) > ARC.r - 14 && y < ARC.y + 4) continue;       // (outside the arc)
      if (x > WIN.x - 14 && x < WIN.x + WIN.w + 14 && y > WIN.roof - 16 && y < WIN.y + WIN.h + 14) continue;
      if (near(x, y, START.x, START.y, 26) || TULIPS.some((t) => near(x, y, t.x, t.y, 28))) continue;       // (wide enough that no pin wedges a ball against a post)
      if (x > GATE.x1 - 12 && x < GATE.x2 + 12 && y > GATE.y - 24 && y < GATE.y + 20) continue;
      if (y > TRAMP.y - 26 && y < TRAMP.y + 26 && x > TRAMP.x - TRAMP.amp - TRAMP.half - 14 && x < TRAMP.x + TRAMP.amp + TRAMP.half + 14) continue;       // (the trampoline's lane)
      if (y > 806 && x > 236 && x < 364) continue;       // (an open way down to the drain)
      if (!offRoad(x, y)) continue;
      pins.push([x, y]);
    }
  }
  // kickers: short ledges out from the left wall, sloping down and in, every other row. A ball sliding down the wall (a hard
  // shot, all the way round) hits one and is sent back onto the pins; the gaps round them are all wider than a ball, so
  // nothing wedges. (The lane's side has a clear way down instead: kickers there sent too many to the start pocket.)
  for (let row = 0, y = 118; y < 800; row += 2, y += 50) if (y >= ARC.y + 20) seg(ARC.x - ARC.r, y + 8, ARC.x - ARC.r + 11, y + 17);
  for (const [a, b] of ROADS) { const n = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 10); for (let k = 0; k <= n; k++) pins.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); }
  // guards: two over each pocket's mouth, so a ball has to come down between them
  pins.push([START.x - 17, START.y - 12], [START.x + 17, START.y - 12]);
  for (const t of TULIPS) pins.push([t.x - 13, t.y - 10], [t.x + 13, t.y - 10]);

  let h = 0;
  for (const p of pins) h = (h * 31 + Math.round(p[0]) * 7 + Math.round(p[1])) % 1000003;
  for (const s of segs) h = (h * 17 + Math.round(s[0] + s[1] + s[2] + s[3])) % 1000003;
  for (const v of Object.values(TRAMP)) h = (h * 13 + v) % 1000003;

  const B = { W, H, BALL, PIN, ARC, LANE, WIN, START, TULIPS, GATE, DRAIN, TRAMP, pins, segs, roofY, rev: 'b' + h.toString(36),
    // where the trampoline's middle is at time t (ms), and how fast it's going (units a second): the same on every PC
    trampAt: (t) => { const a = (2 * Math.PI * (t % TRAMP.period)) / TRAMP.period; return { x: TRAMP.x + TRAMP.amp * Math.sin(a), v: TRAMP.amp * Math.cos(a) * 2 * Math.PI * 1000 / TRAMP.period }; },
    // a tulip that has caught a ball opens its petals: two more walls, leaning out, that steer the next one in
    petals: (t) => [[t.x - t.half, t.y - 4, t.x - t.half - 10, t.y - 16], [t.x + t.half, t.y - 4, t.x + t.half + 10, t.y - 16]],
    roads: ROADS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = B; else window.driftPachinkoBoard = B;
})();
