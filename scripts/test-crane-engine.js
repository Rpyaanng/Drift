#!/usr/bin/env node
// The crane machine's rules, claw and prizes (crane.js), with the casino's one wallet (wallet.js), in plain Node with a fake
// clock: a few seconds, no Electron. (The long payback run is scripts/crane-measure.js.)
//   node scripts/test-crane-engine.js
const { createTable, RULES } = require('../crane.js');
const B = require('../renderer/crane-board.js');
const { createWallet } = require('../wallet.js');

let fails = 0, passes = 0;
const ok = (name, cond, extra) => { if (cond) passes++; else { fails++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

function machine(opts = {}) {
  const clock = { t: 1e6 };
  let r = opts.seed || 4242;
  const rand = opts.rand || ((n) => { r = (r * 1103515245 + 12345) % 2147483648; return Math.floor((r / 2147483648) * n); });
  const t = createTable({ now: () => clock.t, rand, ...opts });
  t.clock = clock;
  t.run = (ms, each) => { for (let x = 0; x < ms; x += 50) { clock.t += 50; t.tick(); if (each) each(); } };
  t.me = (id = 'a') => { const v = t.view(id); return v.seats[v.you]; };
  // drop so the claw comes down over x, the way a player who's learned the swing would (book()), and wait for the try to finish
  t.tryAt = (id, x) => {
    const e = t.move(id, { do: 'play' }); if (e.error) return e;
    const ms = aim(x);
    for (let d = 0; d < ms; d += 10) { clock.t += 10; t.tick(); }
    t.move(id, { do: 'drop' });
    let g;
    g = 0; while (t._step() !== 'ready' && g++ < 600) t.run(50);
    return t.view(id).last[0];
  };
  return t;
}
const rich = () => createWallet({ start: 1000000 });
const PLUSHES = B.PILE.filter((p) => !p[0]).length;
// Where the claw comes down for each moment of the sweep's second time round (10 ms apart), found once on a machine of its own;
// aim(x): the moment that came down nearest x
const OUT = (B.SWEEP.x2 - B.RAIL.home) * Math.PI / (2 * B.SWEEP.speed) * 1000, PERIOD = (B.SWEEP.x2 - B.SWEEP.x1) * Math.PI / B.SWEEP.speed * 1000;
let book = null;
function aim(x) {
  if (!book) {
    book = [];
    const t = machine({ wallet: createWallet({ start: 1e9 }), rules: { plushGrip: 0, boxGrip: 0 } });       // (200-odd tries: never short of chips, whatever the prizes pay)
    t.sit('z', 'Zed');
    for (let ms = OUT + PERIOD; ms < OUT + 2 * PERIOD; ms += 10) {
      t.move('z', { do: 'play' });
      for (let d = 0; d < ms; d += 10) { t.clock.t += 10; t.tick(); }
      t.move('z', { do: 'drop' });
      let land = null, g = 0;
      while (t._step() !== 'ready' && g++ < 2000) { t.clock.t += 10; t.tick(); if (land === null && t._step() === 'grab') land = t._claw().x; }
      if (land !== null) book.push([ms, land]);
    }
  }
  let best = book[0]; for (const b of book) if (Math.abs(b[1] - x) < Math.abs(best[1] - x)) best = b;
  return best[0];
}

// ---- the box ----
ok('the box has a version', /^c[0-9a-z]+$/.test(B.rev));
ok('the chute fits the box and a plush', B.CHUTE.x2 - B.CHUTE.x1 > 2 * B.BOX.hw + 10 && B.CHUTE.x2 - B.CHUTE.x1 > 2 * B.PLUSH.r + 10);
ok('the claw waits over the chute', B.RAIL.home > B.CHUTE.x1 && B.RAIL.home < B.CHUTE.x2);

{ // ---- the pile: settled, inside the box, none in the chute ----
  const t = machine(), items = t._items();
  ok(`${PLUSHES} plushes and the box`, PLUSHES >= 18 && items.filter((q) => !q.kind).length === PLUSHES && items.filter((q) => q.kind).length === 1);
  ok('all inside, on the pile side of the guard', items.every((q) => q.x > B.CHUTE.x2 && q.x < B.WALL.r && q.y < B.FLOOR), items.map((q) => [q.x | 0, q.y | 0]));
  const box = items.find((q) => q.kind), peak = (side) => Math.min(...items.filter((q) => !q.kind && Math.sign(q.x - box.x) === side).map((q) => q.y - (q.big ? B.PLUSH.big : B.PLUSH.r)));
  ok(`the box sits in the dip in the pile's middle (${box.x | 0}, ${box.y | 0}), lower than the plushes either side, nothing on it`, Math.abs(box.x - B.VALLEY) < 30
    && box.y - B.BOX.hh > peak(-1) + 20 && box.y - B.BOX.hh > peak(1) + 20
    && items.every((q) => q.kind || Math.abs(q.x - box.x) > B.BOX.hw || q.y > box.y));
  ok(`half the plushes are big (${items.filter((q) => q.big).length} of ${PLUSHES})`, items.filter((q) => q.big).length === PLUSHES / 2 && items.every((q) => !q.kind || !q.big));
  ok('the chute\'s guard stands above the pile', items.every((q) => q.y - (q.kind ? B.BOX.hh : B.PLUSH.r) > B.CHUTE.top + 60));
  ok('nobody at it: idle, and nothing moves', t.phase === 'idle' && !t.run(1000) && t.inkLen === 0);
}

{ // ---- the sweep: out over the pile, then back and forth between its ends ----
  ok('it sets off from over the chute', B.sweepAt(0) === B.RAIL.home);
  const xs = []; for (let ms = 0; ms < 12000; ms += 10) xs.push(B.sweepAt(ms));
  ok('it never leaves the rail', xs.every((x) => x >= B.RAIL.home && x <= B.SWEEP.x2));
  const later = xs.slice(xs.findIndex((x) => x >= B.SWEEP.x2));
  ok('once out, it stays over the pile', later.every((x) => x >= B.SWEEP.x1 - 0.01));
  let turns = 0; for (let i = 2; i < xs.length; i++) if ((xs[i] - xs[i - 1]) * (xs[i - 1] - xs[i - 2]) < 0) turns++;
  const TURNS = 1 + Math.floor((12000 - OUT) / (PERIOD / 2));       // (out, then each pass)
  ok(`and turns at each end (${turns} turns in 12 s)`, turns === TURNS);
  let top = 0, endSlow = Infinity; for (let ms = 3000; ms < 12000; ms += 5) { const v = Math.abs(B.sweepAt(ms + 5) - B.sweepAt(ms)) * 200; top = Math.max(top, v); if (Math.abs(B.sweepAt(ms) - B.SWEEP.x1) < 2) endSlow = Math.min(endSlow, v); }
  ok(`its top speed over the middle (${top | 0}), slow at the ends (${endSlow | 0})`, Math.abs(top - B.SWEEP.speed) < 2 && endSlow < 40);
}

{ // ---- the swing: the head hangs on its cable, and Drop brakes the carriage ----
  const t = machine({ wallet: rich() });
  t.sit('a', 'Ann');
  t.move('a', { do: 'play' });
  let most = 0; for (let k = 0; k < 120; k++) { t.run(50); most = Math.max(most, Math.abs(t._claw().x - t._claw().cx)); }
  ok(`the head swings under the carriage as it sweeps (${most | 0} at most)`, most > 4 && most < 45);
  let g = 0; while (Math.abs(t._claw().cv) < B.SWEEP.speed * 0.9 && g++ < 400) { t.clock.t += 10; t.tick(); }       // (over the middle, fast)
  const cx = t._claw().cx, v = t._claw().cv;
  t.move('a', { do: 'drop' });
  t.run(600);
  const c = t._claw(), slide = c.cx - cx;
  ok(`the carriage slides on as it brakes (${slide | 0}), then stops`, Math.sign(slide) === Math.sign(v) && Math.abs(slide) <= v * v / (2 * B.SWING.brake) + 6 && Math.abs(slide) > 5 && c.cv === 0);
  ok(`and the head swings on past it (${(c.x - c.cx) | 0})`, Math.abs(c.x - c.cx) > 5);
  g = 0; while (t._step() !== 'ready' && g++ < 600) t.run(50);
  ok('home again and still', Math.abs(t._claw().cx - B.RAIL.home) < 0.01 && Math.abs(t._claw().x - B.RAIL.home) < 4);
}

{ // ---- a try: the price, the sweep, the clock, timing ----
  const w = rich(), t = machine({ wallet: w });
  t.sit('a', 'Ann');
  ok('sitting: the wallet\'s chips', t.me().chips === 1000000 && t.view('a').cost === RULES.cost && RULES.cost === 1000);
  ok('pays: a plush 1,000, a big one 2,000, the box 3,000', t.view('a').pays.plush === 1000 && t.view('a').pays.big === 2000 && t.view('a').pays.grand === 3000);
  ok('dropping before paying: no', !!t.move('a', { do: 'drop' }).error);
  ok('steering is gone', !!t.move('a', { do: 'hold', key: 'right' }).error);
  const t0 = t.clock.t;
  ok('play', !t.move('a', { do: 'play' }).error && t.view('a').step === 'move' && t.me().chips === 999000 && w.peek('a').chips === 999000);
  ok('not twice', !!t.move('a', { do: 'play' }).error);
  t.run(1000);
  ok(`the claw goes by itself (${t._claw().cx | 0} after a second)`, Math.abs(t._claw().cx - B.sweepAt(1000)) < 6);       // (a step ahead at most)
  t.run(2000);
  ok('and comes back the other way', Math.abs(t._claw().cx - B.sweepAt(3000)) < 6 && B.sweepAt(3000) < B.sweepAt(2900));
  ok('frames go out while it moves (the head and the carriage; each prize with its angle)', t.inkLen > 20 && t.ink(0).every((f) => f.c.length === 4 && f.i.length % 5 === 0 && f.i.length / 5 === t._items().length));
  ok('the clock counts down', t.view('a').play.msLeft <= 12100 && t.clock.t - t0 === 3000);
  t.run(13000);
  ok('when the clock runs out the claw drops by itself', t._step() !== 'move');
  let g = 0; while (t._step() !== 'ready' && g++ < 300) t.run(50);
  ok('the try finishes and the claw comes home', t._step() === 'ready' && Math.abs(t._claw().cx - B.RAIL.home) < 1 && t.view('a').last.length === 1);
}

{ // ---- timing: Drop comes down where the screen showed the claw when it was pressed (up to half a second back) ----
  const t = machine({ wallet: rich() });
  t.sit('a', 'Ann');
  const at = (late) => {       // a try, dropped 2 s in, saying it was pressed `late` ms ago (null: says nothing)
    let g = 0; while (t._step() !== 'ready' && g++ < 600) t.run(50);
    t.move('a', { do: 'play' }); const p = t.clock.t; t.run(2000);
    t.move('a', { do: 'drop', amount: late === null ? undefined : t.clock.t - late });
    return { x: t._claw().pressX, p };       // (where the carriage was as it was pressed: it brakes from there)
  };
  const STEP = B.SWEEP.speed / 60 + 1.5;       // (within two physics steps of it at full speed: the table's clock runs in whole steps)
  let r = at(null);
  ok(`no time given: where it is now (${r.x | 0})`, Math.abs(r.x - B.sweepAt(2000)) < STEP);
  r = at(300);
  ok(`pressed 300 ms ago: where it was then (${r.x | 0} vs ${B.sweepAt(1700) | 0})`, Math.abs(r.x - B.sweepAt(1700)) < STEP);
  r = at(5000);
  ok('pressed 5 s ago: no further back than half a second', Math.abs(r.x - B.sweepAt(1500)) < STEP);
  r = at(-4000);
  ok('pressed in the future: now', Math.abs(r.x - B.sweepAt(2000)) < STEP);
  t.run(50);
  ok('it goes down', t._step() === 'down');
}

{ // ---- prizes are won and paid, and replaced; the wallet adds up ----
  const w = rich(), t = machine({ wallet: w });
  t.sit('a', 'Ann');
  let won = 0, tries = 0, plush = 0, bigs = 0, grand = 0, slipped = 0, outside = 0;
  for (let k = 0; k < 120; k++) {
    const top = t._items().filter((q) => q.x > B.RAIL.min && q.x < B.RAIL.max).sort((p, q) => (p.y - (p.kind ? B.BOX.hh : B.PLUSH.r)) - (q.y - (q.kind ? B.BOX.hh : B.PLUSH.r)))[k % 3];
    const target = k % 4 === 3 ? t._items().find((q) => q.kind) : top;       // (and the box in its dip, now and then)
    const r = t.tryAt('a', target.x);
    if (!r.kinds) { ok('a try', false, { r, step: t._step(), k }); break; }
    tries++; won += r.won; plush += r.kinds.filter((x) => x === 0).length; bigs += r.kinds.filter((x) => x === 2).length; grand += r.kinds.filter((x) => x === 1).length; if (r.slipped) slipped++;
    for (const q of t._items()) if (q.x < B.WALL.l || q.x > B.WALL.r || (q.y > B.FLOOR + 1 && q.x > B.CHUTE.x2)) outside++;       // (below the floor is only ever in the chute)
  }
  ok(`plushes are won, small (${plush}) and big (${bigs}), in ${tries}`, plush + bigs >= 20 && plush + bigs <= 80 && plush > 0 && bigs > 0);
  ok(`the grand prize is won now and then (${grand})`, grand >= 1 && grand <= 30);
  ok(`prizes slip out of the claw (${slipped})`, slipped > 10);
  ok('every win paid, every try paid for', w.peek('a').chips === 1000000 - tries * RULES.cost + won, { chips: w.peek('a').chips, tries, won });
  ok('won = 1,000 a plush, 2,000 a big one and 3,000 the box', won === plush * RULES.plushPay + bigs * RULES.bigPay + grand * RULES.grandPay);
  ok('every prize won was replaced, each the size it was', t._items().filter((q) => !q.kind).length === PLUSHES && t._items().filter((q) => q.big).length === PLUSHES / 2 && t._items().filter((q) => q.kind).length === 1);
  ok('nothing ever outside the box', outside === 0, outside);
  const turned = t._items().filter((q) => !q.kind && Math.abs(q.a) > 0.2).length;
  ok(`the plushes roll: ${turned} of ${PLUSHES} lie turned`, turned >= PLUSHES / 4);
  let quiet = 0;
  for (let k = 0; k < 10; k++) { t.tryAt('a', 500); t.run(4000); const n0 = t.inkLen; t.run(2000); if (t.inkLen === n0) quiet++; }
  ok(`and the pile comes to rest after a try (still, sending nothing, 4 s on: ${quiet} of 10)`, quiet >= 8);
  ok('the last tries are kept', t.view('a').last.length === 6 && t.view('a').last[0].n === tries + 10);
}

{ // ---- a sure grip and none: the claw holds the box all the way, or never does ----
  const t = machine({ wallet: rich(), rules: { boxGrip: 1e6, boxWithin: 1e6 } });       // (sure anywhere on it, swinging or not: grip() is a chance)
  t.sit('a', 'Ann');
  const box = t._items().find((q) => q.kind), r = t.tryAt('a', box.x);
  ok('the grand prize down the chute', r.kinds.includes(1) && r.won >= RULES.grandPay, r);
  ok('a new box comes in', t._items().filter((q) => q.kind).length === 1 && t._items().find((q) => q.kind).id !== box.id);
  const t2 = machine({ wallet: rich(), rules: { boxGrip: 0, plushGrip: 0 } });
  t2.sit('a', 'Ann');
  const b2 = t2._items().find((q) => q.kind), r2 = t2.tryAt('a', b2.x);
  ok('no grip: it slips out', r2.slipped && !r2.kinds.includes(1), r2);
}

{ // ---- the grip: dead centre and steady, 70% (asked for); off its middle or swinging, less ----
  const t = machine(), g = (...a) => Math.round(t._grip(...a) * 1000) / 1000;
  ok(`dead centre and still: 70% for a plush, a big one and the box (${g(0, false, 0, 0)}, ${g(0, true, 0, 0)}, ${g(1, false, 0, 0)})`, g(0, false, 0, 0) === 0.7 && g(0, true, 0, 0) === 0.7 && g(1, false, 0, 0) === 0.7);
  ok(`a plush 11 off: about three-quarters of that (${g(0, false, 11, 0)}); 22 off: nothing`, Math.abs(g(0, false, 11, 0) - 0.525) < 0.01 && g(0, false, 22, 0) === 0);
  ok(`the box needs it nearer: 8 off is nothing (${g(1, false, 8, 0)})`, g(1, false, 8, 0) === 0 && g(1, false, 4, 0) > 0.5);
  ok(`swinging across at 120 a second halves it (${g(0, false, 0, 120)})`, g(0, false, 0, 120) === 0.35);
  ok(`a tipped box holds worse (${g(1, false, 0, 0, 0.6)})`, g(1, false, 0, 0, 0.6) < 0.5);
}

{ // ---- a tipped box's top corner is sticky; a level box has none ----
  const top = (q) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [q.x + sx * B.BOX.hw * Math.cos(q.a) - sy * B.BOX.hh * Math.sin(q.a), q.y + sx * B.BOX.hw * Math.sin(q.a) + sy * B.BOX.hh * Math.cos(q.a)]).reduce((p, c) => (c[1] < p[1] ? c : p));
  const tipped = (q) => { const a = Math.abs(Math.atan2(Math.sin(2 * q.a), Math.cos(2 * q.a)) / 2); return Math.min(a, Math.PI / 2 - a) / (Math.PI / 4); };       // (crane.js's: 0 square, 1 on its corner)
  const tries = (t, n) => {       // up to n tries at the box's top corner: did one hook it, what came of that one, and how tipped it was then
    for (let k = 0; k < n; k++) {
      const box = t._items().find((q) => q.kind); if (!box) return null;
      t.move('a', { do: 'play' });
      const ms = aim(top(box)[0]); for (let d = 0; d < ms; d += 10) { t.clock.t += 10; t.tick(); }
      t.move('a', { do: 'drop' });
      let hooked = false, tip = 0, g = 0; while (t._step() !== 'ready' && g++ < 2000) { t.clock.t += 10; t.tick(); if (!hooked && t._step() === 'grab' && t.view('a').play.hooked) { hooked = true; tip = tipped(box); } }
      if (hooked) return { ...t.view('a').last[0], tip };
    }
    return null;
  };
  // only a hook can hold here (boxGrip 0), and a hook always does
  const t = machine({ wallet: rich(), rules: { boxGrip: 0, cornerGrip: 1e6 } });
  t.sit('a', 'Ann');
  const box = t._items().find((q) => q.kind); box.x = 760; box.y = 300; for (const q of t._items()) q.sleep = false;
  t.run(4000);
  const tilt = Math.abs(Math.atan2(Math.sin(4 * box.a), Math.cos(4 * box.a)) / 4);
  ok(`dropped on the pyramid, the box lies tipped (${Math.round(tilt * 180 / Math.PI)}°)`, tilt > 0.2);
  const r = tries(t, 12);
  ok('coming down on its top corner hooks it, and up it comes', !!r && r.kinds.includes(1), r);
  const t2 = machine({ wallet: rich(), rules: { boxGrip: 0, cornerGrip: 1e6 } });
  t2.sit('a', 'Ann');
  // (a miss can knock it over, and then its corner's fair game: what counts is that it was tipped when it was hooked)
  const r2 = tries(t2, 6);
  ok('a box lying level has no corner to catch', !r2 || r2.tip >= 0.15, r2);
}

{ // ---- short of a try: no try, and the wallet isn't touched ----
  const w = createWallet({ start: 600 }), t = machine({ wallet: w });
  t.sit('a', 'Ann');
  ok('600 chips: not enough', !!t.move('a', { do: 'play' }).error && t.me().chips === 600 && w.peek('a').chips === 600);
  ok('not topped up either', t.view('a').seats[0].chips === 600);
}

{ // ---- one seat: a line, the seat passing on after each try, and after a while of not playing ----
  const w = rich(), t = machine({ wallet: w, times: { idle: 5000 } });
  t.sit('a', 'Ann');
  ok('a second person: in line', t.sit('b', 'Ben').watching && t.view('b').watching === 0 && t.view('b').you === -1 && t.view('a').line[0].name === 'Ben' && t.view('a').line[0].id === 'b');
  ok('in line: no moves', !!t.move('b', { do: 'play' }).error);
  t.tryAt('a', 300);
  ok('after Ann\'s try it\'s Ben\'s go, and Ann is in line', t.view('b').you === 0 && t.view('a').watching === 0);
  t.run(3000);
  ok('Ben has a while to put in a try', t.view('b').you === 0 && t.view('b').idleMs > 0);
  t.run(2500);
  ok('then it passes back to Ann', t.view('a').you === 0 && t.view('b').watching === 0);
  t.leave('b');
  ok('leaving the line', t.view('a').watchers === 0);
  t.tryAt('a', 300); t.run(10000);
  ok('nobody waiting: the seat stays', t.view('a').you === 0);
}

{ // ---- leaving mid-try: the claw drops, and the prize is still yours ----
  const w = rich(), t = machine({ wallet: w, rules: { boxGrip: 1e6, boxWithin: 1e6 } });
  t.sit('a', 'Ann'); t.sit('b', 'Ben');
  const box = t._items().find((q) => q.kind);
  t.move('a', { do: 'play' });
  const ms = aim(box.x); for (let d = 0; d < ms; d += 10) { t.clock.t += 10; t.tick(); }
  t.leave('a');
  let g;
  ok('it drops at once', t._step() === 'down');
  g = 0; while (t._step() !== 'ready' && g++ < 600) t.run(50);
  ok('what it won is Ann\'s', w.peek('a').chips === 1000000 - RULES.cost + RULES.grandPay, w.peek('a'));
  ok('and the seat goes to Ben', t.view('b').you === 0);
}

{ // ---- the wallet across tables: the crane's chips are the others' ----
  const w = createWallet({ start: 20000 }), t = machine({ wallet: w });
  t.sit('a', 'Ann');
  t.tryAt('a', 300);
  const after = w.peek('a').chips;
  ok('a try comes out of the one wallet', after === 20000 - RULES.cost + t.view('a').last[0].won);
  w.set('a', { chips: 50000, outUntil: 0 });
  ok('and a change elsewhere shows here', t.me().chips === 50000);
}

console.log(`${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
