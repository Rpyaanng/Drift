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
  // drop as the sweeping claw passes x on its way out, and wait for the try to finish
  t.tryAt = (id, x) => {
    const e = t.move(id, { do: 'play' }); if (e.error) return e;
    let g = 0; while (t._claw().x < Math.min(x, B.SWEEP.x2) - 1 && g++ < 600) { clock.t += 10; t.tick(); }
    t.move(id, { do: 'drop' });
    g = 0; while (t._step() !== 'ready' && g++ < 600) t.run(50);
    return t.view(id).last[0];
  };
  return t;
}
const rich = () => createWallet({ start: 1000000 });

// ---- the box ----
ok('the box has a version', /^c[0-9a-z]+$/.test(B.rev));
ok('the chute fits the box and a plush', B.CHUTE.x2 - B.CHUTE.x1 > 2 * B.BOX.hw + 10 && B.CHUTE.x2 - B.CHUTE.x1 > 2 * B.PLUSH.r + 10);
ok('the claw waits over the chute', B.RAIL.home > B.CHUTE.x1 && B.RAIL.home < B.CHUTE.x2);

{ // ---- the pile: settled, inside the box, none in the chute ----
  const t = machine(), items = t._items();
  ok('20 plushes and the box', items.filter((q) => !q.kind).length === 20 && items.filter((q) => q.kind).length === 1);
  ok('all inside, on the pile side of the guard', items.every((q) => q.x > B.CHUTE.x2 && q.x < B.WALL.r && q.y < B.FLOOR), items.map((q) => [q.x | 0, q.y | 0]));
  const box = items.find((q) => q.kind);
  ok('the box is on top of the pile', items.every((q) => q.kind || q.y > box.y), box.y);
  ok('nobody at it: idle, and nothing moves', t.phase === 'idle' && !t.run(1000) && t.inkLen === 0);
}

{ // ---- the sweep: out over the pile, then back and forth between its ends ----
  ok('it sets off from over the chute', B.sweepAt(0) === B.RAIL.home);
  const xs = []; for (let ms = 0; ms < 12000; ms += 10) xs.push(B.sweepAt(ms));
  ok('it never leaves the rail', xs.every((x) => x >= B.RAIL.home && x <= B.SWEEP.x2));
  const later = xs.slice(xs.findIndex((x) => x >= B.SWEEP.x2));
  ok('once out, it stays over the pile', later.every((x) => x >= B.SWEEP.x1 - 0.01));
  let turns = 0; for (let i = 2; i < xs.length; i++) if ((xs[i] - xs[i - 1]) * (xs[i - 1] - xs[i - 2]) < 0) turns++;
  ok(`and turns at each end (${turns} turns in 12 s)`, turns >= 6 && turns <= 9);
  ok('its speed', Math.abs((B.sweepAt(1000) - B.sweepAt(0)) - B.SWEEP.speed) < 0.01);
}

{ // ---- a try: the price, the sweep, the clock, timing ----
  const w = rich(), t = machine({ wallet: w });
  t.sit('a', 'Ann');
  ok('sitting: the wallet\'s chips', t.me().chips === 1000000 && t.view('a').cost === RULES.cost && RULES.cost === 5000);
  ok('pays: a plush 5,000, the box 20,000', t.view('a').pays.plush === 5000 && t.view('a').pays.grand === 20000);
  ok('dropping before paying: no', !!t.move('a', { do: 'drop' }).error);
  ok('steering is gone', !!t.move('a', { do: 'hold', key: 'right' }).error);
  const t0 = t.clock.t;
  ok('play', !t.move('a', { do: 'play' }).error && t.view('a').step === 'move' && t.me().chips === 995000 && w.peek('a').chips === 995000);
  ok('not twice', !!t.move('a', { do: 'play' }).error);
  t.run(1000);
  ok(`the claw goes by itself (${t._claw().x | 0} after a second)`, Math.abs(t._claw().x - B.sweepAt(1000)) < 6);       // (a step behind at most)
  t.run(4000);
  ok('and comes back the other way', Math.abs(t._claw().x - B.sweepAt(5000)) < 6 && B.sweepAt(5000) < B.sweepAt(4900));
  ok('frames go out while it moves', t.inkLen > 20 && t.ink(0).every((f) => f.c.length === 3 && f.i.length % 4 === 0));
  ok('the clock counts down', t.view('a').play.msLeft <= 10100 && t.clock.t - t0 === 5000);
  t.run(11000);
  ok('when the clock runs out the claw drops by itself', t._step() !== 'move');
  let g = 0; while (t._step() !== 'ready' && g++ < 300) t.run(50);
  ok('the try finishes and the claw comes home', t._step() === 'ready' && Math.abs(t._claw().x - B.RAIL.home) < 1 && t.view('a').last.length === 1);
}

{ // ---- timing: Drop comes down where the screen showed the claw when it was pressed (up to half a second back) ----
  const t = machine({ wallet: rich() });
  t.sit('a', 'Ann');
  const at = (late) => {       // a try, dropped 2 s in, saying it was pressed `late` ms ago (null: says nothing)
    let g = 0; while (t._step() !== 'ready' && g++ < 600) t.run(50);
    t.move('a', { do: 'play' }); const p = t.clock.t; t.run(2000);
    t.move('a', { do: 'drop', amount: late === null ? undefined : t.clock.t - late });
    return { x: t._claw().x, p };
  };
  let r = at(null);
  ok(`no time given: where it is now (${r.x | 0})`, Math.abs(r.x - B.sweepAt(2000)) < 3);
  r = at(300);
  ok(`pressed 300 ms ago: where it was then (${r.x | 0} vs ${B.sweepAt(1700) | 0})`, Math.abs(r.x - B.sweepAt(1700)) < 3);
  r = at(5000);
  ok('pressed 5 s ago: no further back than half a second', Math.abs(r.x - B.sweepAt(1500)) < 3);
  r = at(-4000);
  ok('pressed in the future: now', Math.abs(r.x - B.sweepAt(2000)) < 3);
  t.run(50);
  ok('it stays where it came down while it goes down', Math.abs(t._claw().x - r.x) < 0.01 && t._step() === 'down');
}

{ // ---- prizes are won and paid, and replaced; the wallet adds up ----
  const w = rich(), t = machine({ wallet: w });
  t.sit('a', 'Ann');
  let won = 0, tries = 0, plush = 0, grand = 0, slipped = 0, outside = 0;
  for (let k = 0; k < 120; k++) {
    const top = t._items().filter((q) => q.x > B.RAIL.min && q.x < B.RAIL.max).sort((p, q) => (p.y - (p.kind ? B.BOX.hh : B.PLUSH.r)) - (q.y - (q.kind ? B.BOX.hh : B.PLUSH.r)))[k % 3];
    const r = t.tryAt('a', top.x);
    if (!r.kinds) { ok('a try', false, { r, step: t._step(), k }); break; }
    tries++; won += r.won; plush += r.kinds.filter((x) => !x).length; grand += r.kinds.filter((x) => x).length; if (r.slipped) slipped++;
    for (const q of t._items()) if (q.x < B.WALL.l || q.x > B.WALL.r || (q.y > B.FLOOR + 1 && q.x > B.CHUTE.x2)) outside++;       // (below the floor is only ever in the chute)
  }
  ok(`plushes are won (${plush} in ${tries})`, plush >= 25 && plush <= 90);
  ok(`the grand prize is won now and then (${grand})`, grand >= 1 && grand <= 30);
  ok(`prizes slip out of the claw (${slipped})`, slipped > 10);
  ok('every win paid, every try paid for', w.peek('a').chips === 1000000 - tries * RULES.cost + won, { chips: w.peek('a').chips, tries, won });
  ok('won = 5,000 a plush and 20,000 the box', won === plush * RULES.plushPay + grand * RULES.grandPay);
  ok('every prize won was replaced', t._items().filter((q) => !q.kind).length === 20 && t._items().filter((q) => q.kind).length === 1);
  ok('nothing ever outside the box', outside === 0, outside);
  ok('the last tries are kept', t.view('a').last.length === 6 && t.view('a').last[0].n === tries);
}

{ // ---- a sure grip and none: the claw holds the box all the way, or never does ----
  const t = machine({ wallet: rich(), rules: { boxGrip: 1 } });
  t.sit('a', 'Ann');
  const box = t._items().find((q) => q.kind), r = t.tryAt('a', box.x);
  ok('the grand prize down the chute', r.kinds.includes(1) && r.won >= RULES.grandPay, r);
  ok('a new box comes in', t._items().filter((q) => q.kind).length === 1 && t._items().find((q) => q.kind).id !== box.id);
  const t2 = machine({ wallet: rich(), rules: { boxGrip: 0, plushGrip: 0 } });
  t2.sit('a', 'Ann');
  const b2 = t2._items().find((q) => q.kind), r2 = t2.tryAt('a', b2.x);
  ok('no grip: it slips out', r2.slipped && !r2.kinds.includes(1), r2);
}

{ // ---- short of a try: no try, and the wallet isn't touched ----
  const w = createWallet({ start: 3000 }), t = machine({ wallet: w });
  t.sit('a', 'Ann');
  ok('3,000 chips: not enough', !!t.move('a', { do: 'play' }).error && t.me().chips === 3000 && w.peek('a').chips === 3000);
  ok('not topped up either', t.view('a').seats[0].chips === 3000);
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
  const w = rich(), t = machine({ wallet: w, rules: { boxGrip: 1 } });
  t.sit('a', 'Ann'); t.sit('b', 'Ben');
  const box = t._items().find((q) => q.kind);
  t.move('a', { do: 'play' });
  let g = 0; while (t._claw().x < box.x - 1 && g++ < 600) { t.clock.t += 10; t.tick(); }
  t.leave('a');
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
  ok('a try comes out of the one wallet', after === 15000 + t.view('a').last[0].won);
  w.set('a', { chips: 50000, outUntil: 0 });
  ok('and a change elsewhere shows here', t.me().chips === 50000);
}

console.log(`${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
