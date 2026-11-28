#!/usr/bin/env node
// Roulette's rules (roulette.js), in plain Node with a fake clock and a chosen number: a second, no Electron.
//   node scripts/test-roulette-engine.js
const { createTable, BETS, pays, WHEEL, REDS } = require('../roulette.js');

let fails = 0, passes = 0;
const ok = (name, cond, extra) => { if (cond) passes++; else { fails++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

function table(opts = {}) {
  const clock = { t: 1000000 }, next = { n: 17 };
  const t = createTable({ now: () => clock.t, rand: (n) => (n === 37 ? next.n : 0), ...opts });
  t.clock = clock; t.next = next;
  t.wait = (ms) => { clock.t += ms; t.tick(); };
  t.me = (id = 'a') => { const v = t.view(id); return v.seats[v.you]; };
  t.spinTo = (n) => { next.n = n; for (const id of t.seated()) if (!t.view(id).seats[t.view(id).you].ready) t.move(id, { do: 'spin' }); t.tick(); for (let i = 0; i < 20 && t.phase !== 'done'; i++) t.wait(1000); };
  return t;
}

// the bets and their odds
ok('wheel has 37 pockets, each once', WHEEL.length === 37 && new Set(WHEEL).size === 37);
ok('18 reds', REDS.size === 18);
ok('straight up pays 35', pays('17') === 35);
ok('split pays 17', BETS.has('17-20') && BETS.has('16-17') && pays('17-20') === 17);
ok('no split across a street edge', !BETS.has('3-4') && !BETS.has('6-7'));
ok('street pays 11', BETS.has('1-2-3') && pays('1-2-3') === 11);
ok('corner pays 8', BETS.has('1-2-4-5') && pays('1-2-4-5') === 8 && !BETS.has('2-3-4-5'));
ok('six line pays 5', BETS.has('1-2-3-4-5-6') && pays('1-2-3-4-5-6') === 5);
ok('zero bets', BETS.has('0') && BETS.has('0-1') && BETS.has('0-2-3') && BETS.has('0-1-2-3') && pays('0-1-2-3') === 8);
ok('dozens and columns pay 2', pays('d2') === 2 && pays('c1') === 2 && BETS.get('c1').includes(34) && BETS.get('c3').includes(36));
ok('even money', pays('red') === 1 && pays('low') === 1 && !BETS.get('red').includes(0) && !BETS.get('even').includes(0));

{ // one player: betting, the spin, payouts
  const t = table(); t.sit('a', 'Ann');
  ok('sitting starts betting', t.phase === 'betting' && t.me().chips === 1000);
  ok('no clock before a bet', t.view('a').msLeft === 0);
  ok('a bet', !t.move('a', { do: 'bet', key: '17', amount: 10 }).error && t.me().chips === 990);
  ok('...the clock starts', t.view('a').msLeft === 25000);
  ok('a bet that isn\'t one', !!t.move('a', { do: 'bet', key: '3-4', amount: 10 }).error);
  ok('under the minimum', !!t.move('a', { do: 'bet', key: 'red', amount: 2 }).error);
  t.move('a', { do: 'bet', key: 'red', amount: 25 }); t.move('a', { do: 'bet', key: 'black', amount: 25 });
  ok('undo takes the last back', !t.move('a', { do: 'undo' }).error && t.me().chips === 965 && t.me().bets.length === 2);
  t.next.n = 17; t.move('a', { do: 'spin' }); t.tick();
  ok('alone, Spin spins', t.phase === 'spinning');
  ok('the number isn\'t sent while it spins', t.view('a').number === null);
  ok('no bets while it spins', !!t.move('a', { do: 'bet', key: 'red', amount: 5 }).error);
  t.wait(6000);
  ok('lands', t.phase === 'done' && t.view('a').number === 17);
  // 17 is black: 10 on 17 pays 35 (+350 and the 10 back), red loses 25
  ok('pays by the book', t.me().chips === 965 + 360 && t.me().net === 325, t.me());
  ok('history', t.view('a').history[0] === 17);
  t.wait(6000);
  ok('next round', t.phase === 'betting' && t.me().bets.length === 0 && t.me().again);
  ok('again: last spin\'s bets', !t.move('a', { do: 'again' }).error && t.me().staked === 35);
  ok('clear', !t.move('a', { do: 'clear' }).error && t.me().chips === 1325);
}
{ // two players: the ball waits for both, or for the clock
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo');
  t.move('a', { do: 'bet', key: 'even', amount: 100 }); t.move('a', { do: 'spin' }); t.tick();
  ok('waits for the other', t.phase === 'betting');
  t.wait(25000);
  ok('the clock spins it', t.phase === 'spinning');
  t.next.n = 0; t.wait(6000);
  ok('zero: even loses', t.me('a').chips === 900 && t.me('a').net === -100);
  ok('a player who didn\'t bet is untouched', t.me('b').chips === 1000 && t.me('b').net === 0);
}
{ // settle and records
  const got = [];
  const t = table({ onSettle: (l) => got.push(...l) }); t.sit('a', 'Ann');
  t.move('a', { do: 'bet', key: 'd1', amount: 50 }); t.spinTo(5);
  ok('settle reports net', got.length === 1 && got[0].net === 100 && got[0].score === 100, got);
}
{ // crapping out, and coming back
  const t = table(); t.sit('a', 'Ann', { chips: 20 });
  ok('kept chips', t.me().chips === 20);
  t.move('a', { do: 'bet', key: 'red', amount: 20 }); t.spinTo(2);       // 2 is black
  t.wait(6000);
  ok('out of chips', t.me().outMs === 20000 && t.me().chips === 0, t.me());
  ok('can\'t bet while out', !!t.move('a', { do: 'bet', key: 'red', amount: 5 }).error);
  t.leave('a'); t.sit('a', 'Ann');
  ok('standing up doesn\'t skip the wait', t.me().outMs > 0);
  t.wait(20000);
  ok('back with 500', t.me().chips === 500 && !t.me().outMs);
}
{ // leaving
  const t = table(); t.sit('a', 'Ann');
  t.move('a', { do: 'bet', key: 'red', amount: 100 });
  ok('mine gives back unspun bets', t.mine('a').chips === 1000);
  t.leave('a');
  ok('empty table goes idle', t.phase === 'idle');
  const u = table(); u.sit('a', 'Ann'); u.sit('b', 'Bo');
  u.move('a', { do: 'bet', key: 'red', amount: 100 }); u.move('a', { do: 'spin' }); u.move('b', { do: 'spin' }); u.tick();
  ok('spins when everyone is ready (one sitting out)', u.phase === 'spinning');
  u.leave('a');
  ok('leaving mid-spin keeps the place till it lands', u.view('b').seats.some((s) => s && s.id === 'a' && s.left));
  u.wait(6000); u.wait(6000);
  ok('...then it goes', !u.view('b').seats.some((s) => s && s.id === 'a'));
}
{ // full table: a line
  const t = table();
  for (let i = 0; i < 8; i++) t.sit('p' + i, 'P' + i);
  ok('ninth waits', t.sit('x', 'X').watching && t.view('x').watching === 0);
  t.leave('p3');
  ok('takes the free place', t.view('x').you >= 0);
}
{ // the spot limit
  const t = table(); t.sit('a', 'Ann');
  t.move('a', { do: 'bet', key: '5', amount: 500 }); t.move('a', { do: 'bet', key: '5', amount: 500 });
  ok('at most 1000 on one bet', !!t.move('a', { do: 'bet', key: '5', amount: 5 }).error);
}

console.log(fails ? `${fails} failed, ${passes} passed` : `all ${passes} passed`);
process.exit(fails ? 1 : 0);
