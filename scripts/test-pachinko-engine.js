#!/usr/bin/env node
// Pachinko's rules and balls (pachinko.js), and the casino's one wallet (wallet.js), in plain Node with a fake clock: a few
// seconds, no Electron.
//   node scripts/test-pachinko-engine.js
const { createTable, RULES, SYMBOLS } = require('../pachinko.js');
const B = require('../renderer/pachinko-board.js');
const { createWallet } = require('../wallet.js');
const roulette = require('../roulette.js');

let fails = 0, passes = 0;
const ok = (name, cond, extra) => { if (cond) passes++; else { fails++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

function machine(opts = {}) {
  const clock = { t: 1e6 };
  let r = opts.seed || 4242;
  const rand = opts.rand || ((n) => { r = (r * 1103515245 + 12345) % 2147483648; return r % n; });
  const t = createTable({ now: () => clock.t, rand, ...opts });
  t.clock = clock;
  t.run = (ms, each) => { for (let x = 0; x < ms; x += 50) { clock.t += 50; t.tick(); if (each) each(); } };
  t.me = (id = 'a') => { const v = t.view(id); return v.seats[v.you]; };
  return t;
}

// ---- the board ----
ok('the board has its pins', B.pins.length > 200, B.pins.length);
ok('every pin is on the board, off the lane', B.pins.every(([x, y]) => x > 8 && x < B.LANE.x - 6 && y > 30 && y < B.DRAIN.y));
ok('no pin over the window', B.pins.every(([x, y]) => !(x > B.WIN.x && x < B.WIN.x + B.WIN.w && y > B.WIN.y + 44 && y < B.WIN.y + B.WIN.h)));
ok('a ball fits between any two pins', (() => { for (let i = 0; i < B.pins.length; i++) for (let j = i + 1; j < B.pins.length; j++) { const d = Math.hypot(B.pins[i][0] - B.pins[j][0], B.pins[i][1] - B.pins[j][1]); if (d < 9 && d > 0) { const onRoad = B.roads.some(([a]) => Math.abs(B.pins[i][1] - B.pins[j][1]) < 12 && Math.abs(B.pins[i][0] - a[0]) < 120); if (!onRoad) return false; } } return true; })());
ok('the board has a version', /^b[0-9a-z]+$/.test(B.rev));

{ // ---- the handle: a ball every 0.6 s while held, a chip each ----
  const t = machine(); t.sit('a', 'Ann');
  ok('sitting: 1,000 chips, the machine running', t.me().chips === 1000 && t.phase === 'play');
  ok('hold', !t.move('a', { do: 'hold', amount: 60 }).error && t.me().holding);
  t.run(3000);
  const fired = t.me().fired;
  ok(`about one every 0.6 s (${fired} in 3 s)`, fired >= 4 && fired <= 6);
  ok(`${RULES.cost} chips each`, t.view('a').seats[0].chips <= 1000 - RULES.cost * fired + RULES.tulipPay * 2 && t.view('a').cost === RULES.cost);       // (one or two may already have paid)
  t.move('a', { do: 'let go' });
  t.run(1000); const f2 = t.me().fired; t.run(2000);
  ok('let go: no more', t.me().fired === f2 && !t.me().holding);
  ok('power is kept', t.me().power === 60 && !t.move('a', { do: 'power', amount: 140 }).error && t.me().power === 100);
  ok('not a move', !!t.move('a', { do: 'tilt' }).error);
  ok('only someone seated', !!t.move('zed', { do: 'hold', amount: 50 }).error);
}

{ // ---- every ball comes down: inside the board, in a pocket or the drain, within its life ----
  const t = machine(); t.sit('a', 'Ann'); t.sit('b', 'Ben');
  t.move('a', { do: 'hold', amount: 30 }); t.move('b', { do: 'hold', amount: 70 });
  let out = 0, longest = 0, seen = new Map();
  t.run(90000, () => {
    for (const b of t._balls()) {
      if (b.x < 0 || b.x > B.W || b.y < 0 || b.y > B.H + 10) out++;
      if (b.x > B.WIN.x + 2 && b.x < B.WIN.x + B.WIN.w - 2 && b.y > B.WIN.y + 46 && b.y < B.WIN.y + B.WIN.h - 2) out++;
      if (!seen.has(b.id)) seen.set(b.id, t.clock.t);
      longest = Math.max(longest, t.clock.t - seen.get(b.id));
    }
  });
  t.move('a', { do: 'let go' }); t.move('b', { do: 'let go' });
  t.run(20000);
  ok('no ball off the board or inside the window', out === 0, out);
  ok(`none stays up (longest ${Math.round(longest / 1000)} s)`, longest <= 16500 && t._balls().length === 0);
  const v = t.view('a');
  ok('two players: both fired', v.seats[0].fired > 100 && v.seats[1].fired > 100);
  ok('the frames: kept a second and a half, counted', t.ink(0).length <= 45 && t.inkLen > 1000 && t.ink(t.inkLen - 3).length === 3);
  const f = t.ink(0)[0];
  ok('a frame: when, and each ball as id, seat, x, y', Number.isFinite(f.t) && Array.isArray(f.b) && f.b.length % 4 === 0 && Array.isArray(f.e));
}

{ // ---- the trampoline: it slides from side to side, and throws balls back up ----
  const T0 = B.TRAMP, xs = [];
  for (let ms = 0; ms < T0.period; ms += 100) xs.push(B.trampAt(ms).x);
  ok('it covers its lane, end to end', Math.min(...xs) < T0.x - T0.amp * 0.98 && Math.max(...xs) > T0.x + T0.amp * 0.98);
  ok('no pin in its way', B.pins.every(([x, y]) => !(Math.abs(y - T0.y) < 18 && Math.abs(x - T0.x) < T0.amp + T0.half + 8)));
  const t = machine({ rules: { start: 1e7, feverOdds: 0 } }); t.sit('a', 'Ann'); t.move('a', { do: 'hold', amount: 60 });
  let bounces = 0, seq = 0, up = 0;
  const ids = new Set();
  t.run(180000, () => {
    for (const fr of t.ink(seq)) for (const e of fr.e) if (e[0] === 't') bounces++;
    seq = t.inkLen;
    for (const b of t._balls()) if (Math.abs(b.y - T0.y) < 12 && b.vy < -T0.kick * 0.9 && !ids.has(b.id)) { ids.add(b.id); up++; }
  });
  const ps = t.ink(0).map((fr) => fr.p);
  ok(`balls land on it and go back up (${bounces} in 3 minutes, about 300 balls)`, bounces >= 15 && up >= 15, { bounces, up });
  ok('each frame says where it is, and it moves', ps.every(Number.isFinite) && new Set(ps).size > 10);
}

{ // ---- the odds, measured: the start pocket and the tulips at a good aim and a poor one (the reels off) ----
  const rate = (power) => {
    const t = machine({ rules: { feverOdds: 0, reachOdds: 0, start: 1e7 }, seed: 99 + power });
    t.sit('a', 'A'); t.move('a', { do: 'hold', amount: power });
    const k = { s: 0, u: 0, n: 0 }; let seq = 0;
    while (k.n < 3000) { t.run(1000); for (const f of t.ink(seq)) for (const e of f.e) if (e[0] in k) k[e[0]]++; seq = t.inkLen; }
    return { start: k.s / k.n, tulip: k.u / k.n };
  };
  const good = rate(60), poor = rate(90);
  console.log(`  start pocket: ${(good.start * 100).toFixed(1)}% at power 60, ${(poor.start * 100).toFixed(1)}% at 90; tulips ${(good.tulip * 100).toFixed(1)}%, ${(poor.tulip * 100).toFixed(1)}%`);
  ok('beside the window, the start pocket about one in fifteen', good.start > 0.04 && good.start < 0.12, good);
  ok('far left, much less', poor.start < good.start / 2, poor);
  ok('the tulips, a few in a hundred', good.tulip > 0.02 && good.tulip < 0.14 && poor.tulip > 0.02 && poor.tulip < 0.16);
}

{ // ---- the reels: decided at the start, not shown till each stops; a fever opens the gate for everyone ----
  const settled = [];
  const t = machine({ rules: { feverOdds: 1, start: 1e6 }, onSettle: (list) => settled.push(...list) });
  t.sit('a', 'Ann'); t.sit('b', 'Ben');
  t.move('a', { do: 'hold', amount: 60 }); t.move('b', { do: 'hold', amount: 60 });
  let first = null, hidden = true, reach = false;
  t.run(240000, () => {
    const v = t.view('b');
    if (v.spin && !first) first = v.spin;
    if (v.spin && v.spin.spinning[2] && v.spin.reels[2] !== null) hidden = false;
    if (v.spin && v.spin.reach) reach = true;
    if (v.fever) t._rules.feverOdds = 0;
  });
  ok('a spin came', !!first);
  ok('a reel still turning shows nothing', hidden && first.reels.every((x) => x === null));
  ok('a fever is a reach first', reach);
  ok('the fever paid into the gate and went on the board, for whoever had balls in it', settled.length >= 1 && settled.every((x) => x.score > 0 && (x.id === 'a' || x.id === 'b')), settled);
}

{ // ---- a fever's rounds: the gate open, shut between, the hot spell after a big one ----
  const t = machine({ rules: { feverOdds: 1, start: 1e6 }, rand: (() => { let r = 1; return (n) => (n === SYMBOLS.length ? 6 : (r = (r * 48271) % 2147483647) % n); })() });       // (always the seven)
  t.sit('a', 'Ann'); t.move('a', { do: 'hold', amount: 60 });
  let opened = 0, wasOpen = false, big = false, hot = 0, over = false, full = 0, timedOut = 0, lastBalls = 0, filled = 0, need = 0, needs = new Set();
  t.run(400000, () => {
    const v = t.view('a');
    if (v.fever && !over) {
      t._rules.feverOdds = 0; t._rules.hotOdds = 0; big = big || v.fever.big; if (v.fever.open && !wasOpen) opened++;
      if (wasOpen && !v.fever.open) { if (v.fever.balls >= v.fever.roundBalls) full++; else timedOut++; }       // (a round over: filled, or time ran out)
      if (v.fever.open) needs.add(v.fever.roundBalls);
      wasOpen = v.fever.open; lastBalls = v.fever.balls; need = v.fever.roundBalls;
    }
    if (!v.fever && opened && !over) { over = true; hot = Math.max(hot, v.hot); if (wasOpen) { if (lastBalls >= need) full++; else timedOut++; } }
    filled = v.filled;
  });
  ok(`the gate opened for every round (${opened})`, opened === RULES.rounds);
  ok(`the rounds filled are counted for the scene tokens (${filled} of ${full} filled, ${timedOut} ran out of time)`, filled === full && full + timedOut === RULES.rounds);
  ok(`alone, a round needs ${RULES.roundBalls[0]} balls (${[...needs]})`, needs.size === 1 && needs.has(RULES.roundBalls[0]));
  ok('sevens: a big fever, and a hot spell after it', big && hot > 0 && hot <= RULES.hotSpins);
}

{ // ---- the balls a round needs, by how many are at the machine as it opens: 1 6, 2 10, 3 12, 4 15, and 15 for more ----
  const need = (n) => {
    const t = machine({ rules: { feverOdds: 1, start: 1e6 } }), ids = 'abcdef'.slice(0, n).split('');
    for (const id of ids) { t.sit(id, id); t.move(id, { do: 'hold', amount: 60 }); }
    let got = 0; t.run(120000, () => { const v = t.view('a'); if (v.fever) t._rules.feverOdds = 0; if (!got && v.fever && v.fever.open) got = v.fever.roundBalls; });
    return got;
  };
  const got = [1, 2, 3, 4, 6].map(need);
  ok(`by players, 1 2 3 4 6: ${got.join(' ')}`, got.join(' ') === '6 10 12 15 15');
}

{ // ---- a round filled (here, one ball fills it): counted, the same for everyone at the machine, and never twice ----
  const t = machine({ rules: { feverOdds: 1, start: 1e6, roundBalls: 1 } });
  t.sit('a', 'Ann'); t.sit('b', 'Ben');
  t.move('a', { do: 'hold', amount: 60 }); t.move('b', { do: 'hold', amount: 60 });
  let full = 0, wasOpen = false, down = false, same = true, prev = 0;
  t.run(400000, () => {
    const a = t.view('a'), b = t.view('b');
    if (a.fever) t._rules.feverOdds = 0;
    if (a.filled !== b.filled) same = false;
    if (a.filled < prev) down = true; prev = a.filled;
    const open = !!(a.fever && a.fever.open);
    if (wasOpen && !open && a.fever && a.fever.balls >= 1) full++;
    wasOpen = open;
  });
  ok(`rounds filled are counted (${prev} of ${full})`, full > 0 && prev === full);
  ok('the same count for everyone at the machine, and it only goes up', same && !down);
}

{ // ---- out of chips: nothing fires, a wait, then fresh chips ----
  const t = machine({ times: { out: 5000 } });
  t.sit('a', 'Ann', { chips: 3 * RULES.cost + 5 });
  t.move('a', { do: 'hold', amount: 60 });
  let wasOut = false, backIn = false;
  t.run(400000, () => {       // (holding on whenever there are chips for a ball, till it runs out: a few minutes, the tulips paying now and then)
    const s = t.me();
    if (s.outMs) wasOut = true; else if (wasOut && s.chips >= RULES.back - 100) backIn = true;
    if (s.chips >= RULES.cost && !s.outMs && !s.holding && !wasOut) t.move('a', { do: 'hold', amount: 90 });
  });
  ok('chips for three balls: three balls (and what they won)', t.me().fired >= 3);
  ok('out of chips at last: a wait, then back in with fresh ones', wasOut && backIn);
  const t2 = machine(); t2.sit('a', 'Ann', { chips: 3 * RULES.cost + 5 });
  t2.move('a', { do: 'hold', amount: 60 }); t2.run(1300);
  ok('...and the chips short of a ball aren\'t enough for one', t2.me().fired <= 3 && t2.me().chips >= 0);
  ok('holding while out is refused', !t.me().outMs || !!t.move('a', { do: 'hold', amount: 60 }).error);
}

{ // ---- leaving with balls up: they come down and pay, then the place goes ----
  const t = machine(); t.sit('a', 'Ann'); t.move('a', { do: 'hold', amount: 60 });
  t.run(2000);
  t.leave('a');
  ok('stood up with balls in the air: still at the machine', t.view('a').you === 0 && t.me().left);
  t.run(20000);
  ok('...gone once they\'re down', t.view('a').you === -1 && t.phase === 'idle');
}

{ // ---- the wallet: one set of chips across the tables ----
  const changes = [];
  const w = createWallet({ owns: (id) => !id.startsWith('bot:'), onChange: (id) => changes.push(id) });
  const clock = { t: 1e6 };
  const pa = createTable({ now: () => clock.t, rand: (n) => n - 1, wallet: w }), rl = roulette.createTable({ now: () => clock.t, rand: () => 17, wallet: w });
  pa.sit('a', 'Ann'); rl.sit('a', 'Ann');
  ok('the same chips at both, 500 to start', pa.view('a').seats[0].chips === 500 && rl.view('a').seats[0].chips === 500);
  rl.move('a', { do: 'bet', key: 'red', amount: 100 });
  ok('a bet at roulette is gone from the pachinko machine too', pa.view('a').seats[0].chips === 400 && w.peek('a').chips === 400);
  pa.move('a', { do: 'hold', amount: 60 });
  for (let x = 0; x < 3000; x += 50) { clock.t += 50; pa.tick(); }
  ok('balls at pachinko come off the roulette count', rl.view('a').seats[0].chips === pa.view('a').seats[0].chips && rl.view('a').seats[0].chips < 400);
  ok('each change is told', changes.length > 3 && changes.every((id) => id === 'a'));
  ok('someone it isn\'t theirs: their own chips', w.keep('bot:x') === null);
  const w2 = createWallet({ load: () => ({ chips: 333, outUntil: 0 }) });
  ok('a wallet loads what was kept', w2.peek('me').chips === 333);
}

console.log(fails ? `${fails} FAILED, ${passes} passed` : `all ${passes} passed`);
process.exit(fails ? 1 : 0);
