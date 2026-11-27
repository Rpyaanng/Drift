#!/usr/bin/env node
// The crane machine's payback, measured (crane.js): many tries, each aimed at a prize the way a player would (over its middle,
// or a little off), with a fake clock. Slow-ish (a minute or so for the default 3,000 tries); not part of the engine test.
//   node scripts/crane-measure.js [tries] [aim: centre | near | any | box]
const { createTable, RULES } = require('../crane.js');
const B = require('../renderer/crane-board.js');
const { createWallet } = require('../wallet.js');

const N = +process.argv[2] || 3000, AIM = process.argv[3] || 'near';
const clock = { t: 1e6 };
let r = 99;
const rand = (n) => { r = (r * 1103515245 + 12345) % 2147483648; return Math.floor((r / 2147483648) * n); };
const wallet = createWallet({ start: 1e9 });
const t = createTable({ now: () => clock.t, rand, wallet });
t.sit('a', 'Ann');
let paid = 0, back = 0, plush = 0, grand = 0, none = 0, slips = 0, slipWins = 0, escaped = 0, stuck = 0;
const run = (ms) => { for (let x = 0; x < ms; x += 50) { clock.t += 50; t.tick(); } };
for (let k = 0; k < N; k++) {
  const items = t._items().filter((q) => !q.held);
  // the top of the pile under each place the claw can go: aim for what's on top
  const tops = items.map((q) => ({ q, top: q.y - (q.kind ? B.BOX.hh : B.PLUSH.r) })).filter((o) => o.q.x > B.RAIL.min + 10 && o.q.x < B.RAIL.max);
  let pick;
  if (AIM === 'box') pick = tops.find((o) => o.q.kind) || tops.sort((a, b) => a.top - b.top)[0];
  else pick = tops.sort((a, b) => a.top - b.top)[Math.floor(rand(3))] || tops[0];
  const off = AIM === 'centre' ? 0 : AIM === 'near' ? (rand(2001) - 1000) / 1000 * 12 : (rand(2001) - 1000) / 1000 * 40;
  // (the claw sweeps at B.SWEEP.speed: 12 off is a press about 50 ms early or late, 40 about 170 ms)
  const target = Math.max(B.SWEEP.x1, Math.min(B.SWEEP.x2, pick.q.x + off));
  const before = wallet.peek('a').chips;
  if (t.move('a', { do: 'play' }).error) { console.log('could not play', t._step()); break; }
  paid += RULES.cost;
  let guard = 0;
  while (t._claw().x < target - 1 && guard++ < 400) { clock.t += 10; t.tick(); }
  t.move('a', { do: 'drop' });
  guard = 0;
  while (t._step() !== 'ready' && guard++ < 1000) run(50);
  if (guard >= 1000) { stuck++; console.log('stuck in', t._step()); break; }
  const v = t.view('a'), res = v.last[0];
  back += res.won; plush += res.kinds.filter((x) => !x).length; grand += res.kinds.filter((x) => x).length;
  if (res.missed) none++;
  if (res.slipped) { slips++; if (res.won) slipWins++; }
  if (wallet.peek('a').chips !== before - RULES.cost + res.won) console.log('wallet out', before, wallet.peek('a').chips, res);
  for (const q of t._items()) if (q.x < B.WALL.l - 2 || q.x > B.WALL.r + 2 || (q.y > B.FLOOR + 2 && q.x > B.CHUTE.x2)) escaped++;       // (below the floor is only ever in the chute)
}
const n = t._items();
console.log(`${N} tries aimed "${AIM}": payback ${(back / paid * 100).toFixed(1)}%  plush ${plush} (${(plush / N * 100).toFixed(1)}%)  grand ${grand} (${(grand / N * 100).toFixed(2)}%)  closed on nothing ${none}  slipped ${slips} (won anyway ${slipWins})  outside ${escaped}  stuck ${stuck}`);
console.log(`prizes now: ${n.filter((q) => !q.kind).length} plushes, ${n.filter((q) => q.kind).length} box`);
