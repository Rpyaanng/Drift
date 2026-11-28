#!/usr/bin/env node
// The crane machine's payback, measured (crane.js): many tries with a fake clock, each aimed at a prize the way a player would.
// Slow-ish (a minute or so for 2,000 tries); not part of the engine test.
//   node scripts/crane-measure.js [tries] [aim: top | box | corner (the box, at its top corner when it lies tipped)] [player: naive | skilled] [jitter ms]
// naive: presses as the carriage passes over the prize (the claw then slides on and swings: crane-board.js SWING).
// skilled: has learned the swing. Before measuring, it plays a few hundred tries at every moment of the sweep and keeps where
// the claw came down for each; then it presses at the moment (in the next pass or two) that came down nearest the prize.
// jitter: how far off the press is, either way, at most (a hand: 40 ms is good, 100 ms sloppy).
const { createTable, RULES } = require('../crane.js');
const B = require('../renderer/crane-board.js');
const { createWallet } = require('../wallet.js');

const N = +process.argv[2] || 2000, AIM = process.argv[3] || 'top', WHO = process.argv[4] || 'skilled', JIT = process.argv[5] !== undefined ? +process.argv[5] : 40;
const clock = { t: 1e6 };
let r = 99;
const rand = (n) => { r = (r * 1103515245 + 12345) % 2147483648; return Math.floor((r / 2147483648) * n); };
const wallet = createWallet({ start: 1e9 });
const t = createTable({ now: () => clock.t, rand, wallet });
t.sit('a', 'Ann');
const run = (ms) => { for (let x = 0; x < ms; x += 50) { clock.t += 50; t.tick(); } };
const S = B.SWEEP, OUT = (S.x2 - B.RAIL.home) * Math.PI / (2 * S.speed) * 1000, PERIOD = 2 * (S.x2 - S.x1) * Math.PI / (2 * S.speed) * 1000, BIN = 20;

// one try: pressed `ms` after it was put in; where the claw came down, and what it won
function tryAt(ms) {
  if (t.move('a', { do: 'play' }).error) throw new Error('could not play ' + t._step());
  for (let x = 0; x < ms; x += 10) { clock.t += 10; t.tick(); }
  t.move('a', { do: 'drop' });
  let land = null, g = 0;
  while (t._step() !== 'ready' && g++ < 4000) { clock.t += 10; t.tick(); if (land === null && t._step() === 'grab') land = t._claw().x; }
  if (g >= 4000) throw new Error('stuck in ' + t._step());
  return { land, res: t.view('a').last[0] };
}

// the skilled player's notebook: for each moment of the sweep (after the way out, in BIN ms), where the claw came down
const book = [];
if (WHO === 'skilled') {
  const n = Math.ceil(PERIOD / BIN), sum = new Array(n).fill(0), cnt = new Array(n).fill(0);
  for (let k = 0; k < 4 * n; k++) { const b = k % n, { land } = tryAt(OUT + PERIOD + b * BIN); if (land !== null) { sum[b] += land; cnt[b]++; } }
  for (let b = 0; b < n; b++) book.push(cnt[b] ? sum[b] / cnt[b] : null);
}

let paid = 0, back = 0, plush = 0, bigs = 0, grand = 0, none = 0, slips = 0, slipWins = 0, escaped = 0, miss = 0, boxTries = 0, boxOut = 0;
for (let k = 0; k < N; k++) {
  const items = t._items().filter((q) => !q.held);
  const tops = items.map((q) => ({ q, top: q.y - (q.kind ? B.BOX.hh : q.big ? B.PLUSH.big : B.PLUSH.r) })).filter((o) => o.q.x > S.x1 - 20 && o.q.x < S.x2 + 20);
  let pick;
  if (AIM === 'box' || AIM === 'corner') pick = tops.find((o) => o.q.kind) || tops.sort((a, b) => a.top - b.top)[0];
  else pick = tops.sort((a, b) => a.top - b.top)[Math.floor(rand(3))] || tops[0];
  let target = pick.q.x;
  if (AIM === 'corner' && pick.q.kind) {       // (lying tipped, more than 10°: aim at its top corner, which is sticky)
    const q = pick.q, cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [q.x + sx * B.BOX.hw * Math.cos(q.a) - sy * B.BOX.hh * Math.sin(q.a), q.y + sx * B.BOX.hw * Math.sin(q.a) + sy * B.BOX.hh * Math.cos(q.a)]);
    const tilt = Math.abs(Math.atan2(Math.sin(4 * q.a), Math.cos(4 * q.a)) / 4);
    if (tilt > 0.17) target = cs.reduce((p, c) => (c[1] < p[1] ? c : p))[0];
  }
  if (pick.q.kind) { boxTries++; if (target < S.x1 - 5 || target > S.x2 + 5) boxOut++; }
  let ms;
  if (WHO === 'skilled') {       // the moment in the next two passes that came down nearest
    let best = Infinity; for (let b = 0; b < book.length; b++) if (book[b] !== null && Math.abs(book[b] - target) < best) { best = Math.abs(book[b] - target); ms = OUT + PERIOD + b * BIN; }
  } else {       // the first moment the carriage is over it (after the way out)
    ms = OUT; while (Math.abs(B.sweepAt(ms) - target) > 3 && ms < OUT + 2 * PERIOD) ms += 5;
  }
  ms += (rand(2001) - 1000) / 1000 * JIT;
  const before = wallet.peek('a').chips;
  paid += RULES.cost;
  const { land, res } = tryAt(ms);
  if (land !== null) miss += Math.abs(land - target);
  back += res.won; plush += res.kinds.filter((x) => x !== 1).length; bigs += res.kinds.filter((x) => x === 2).length; grand += res.kinds.filter((x) => x === 1).length;
  if (res.missed) none++;
  if (res.slipped) { slips++; if (res.won) slipWins++; }
  if (wallet.peek('a').chips !== before - RULES.cost + res.won) console.log('wallet out', before, wallet.peek('a').chips, res);
  for (const q of t._items()) if (q.x < B.WALL.l - 2 || q.x > B.WALL.r + 2 || (q.y > B.FLOOR + 2 && q.x > B.CHUTE.x2)) escaped++;       // (below the floor is only ever in the chute)
}
const n = t._items();
console.log(`${N} tries, ${WHO} going for "${AIM}" (±${JIT} ms): payback ${(back / paid * 100).toFixed(1)}%  plush ${plush} (${(plush / N * 100).toFixed(1)}%, ${bigs} big)  grand ${grand} (${(grand / N * 100).toFixed(2)}%)  came down ${(miss / N).toFixed(1)} off  closed on nothing ${none}  slipped ${slips} (won anyway ${slipWins})  outside ${escaped}`);
console.log(`prizes now: ${n.filter((q) => !q.kind).length} plushes, ${n.filter((q) => q.kind).length} box (at ${n.filter((q) => q.kind).map((q) => Math.round(q.x) + ',' + Math.round(q.y))}); aimed at the box ${boxTries} times, ${boxOut} of them beyond the sweep`);
