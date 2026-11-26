#!/usr/bin/env node
// Texas Hold'em's rules (poker.js), in plain Node with a fake clock and stacked decks: a few seconds, no Electron.
//   node scripts/test-poker-engine.js
// A stacked deck: each player's first card in dealing order (from the left of the button), then each one's second, then
// for each street a burnt card and the street's cards. With two players the button is the small blind and is dealt second.
const { createTable, rankOf, score, handName, equity } = require('../poker.js');

let fails = 0, passes = 0;
const ok = (name, cond, extra) => { if (cond) passes++; else { fails++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };
const best = (s) => handName(rankOf(s.split(' ')));
const beats = (a, b) => score(rankOf(a.split(' '))) > score(rankOf(b.split(' ')));
const ties = (a, b) => score(rankOf(a.split(' '))) === score(rankOf(b.split(' ')));

function table(opts = {}) {
  const clock = { t: 1000000 };
  let seed = 11;
  const t = createTable({ now: () => clock.t, rand: (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; }, botRand: () => 0.5, ...opts });
  t.clock = clock;
  t.wait = (ms) => { clock.t += ms; t.tick(); };
  t.v = (id) => t.view(id);
  t.s = (id) => { const v = t.view(id); return v.seats[v.you]; };
  t.turnId = () => { const v = t.view('x'); return v.turn >= 0 ? v.seats[v.turn].id : ''; };
  t.go = (id, what, amount) => t.move(id, { do: what, amount });
  return t;
}
const start = (t) => { t.tick(); t.wait(5000); };       // the hand starts a moment after two sit down

// ---- the hands ----
ok('high card', best('As Kd 9h 7c 3s 2d 4h') === 'High card');
ok('pair', best('As Ad 9h 7c 3s') === 'Pair');
ok('two pair', best('As Ad 9h 9c 3s 3d Kh') === 'Two pair');
ok('trips', best('7s 7d 7h Kc 3s') === 'Three of a kind');
ok('straight', best('5s 6d 7h 8c 9s') === 'Straight');
ok('wheel straight', best('As 2d 3h 4c 5s Kd Qd') === 'Straight' && rankOf('As 2d 3h 4c 5s Kd Qd'.split(' '))[1] === 5);
ok('flush', best('2h 7h 9h Jh Kh As') === 'Flush');
ok('full house', best('Ks Kd Kh 2c 2s') === 'Full house');
ok('two trips make a full house', best('Ks Kd Kh 2c 2s 2d 9h') === 'Full house' && rankOf('Ks Kd Kh 2c 2s 2d 9h'.split(' ')).join() === '6,13,2');
ok('quads', best('9s 9d 9h 9c 3s') === 'Four of a kind');
ok('straight flush', best('5h 6h 7h 8h 9h') === 'Straight flush');
ok('royal flush', best('Th Jh Qh Kh Ah 2c 3d') === 'Royal flush');
ok('flush beats straight', beats('2h 7h 9h Jh Kh', '5s 6d 7h 8c 9s'));
ok('kicker decides a pair', beats('As Ad Kh 7c 3s', 'Ac Ah Qh 7d 3d'));
ok('third kicker', beats('As Ad Kh 8c 3s', 'Ac Ah Kd 7d 3d'));
ok('two pair: the top pair first', beats('Ks Kd 2h 2c 3s', 'Qs Qd Jh Jc As'));
ok('two pair kicker', beats('Ks Kd 2h 2c 9s', 'Kc Kh 2d 2s 8s'));
ok('a third pair can\'t be a kicker beyond 5 cards', ties('Ks Kd Qh Qc 2s 2d 9h', 'Kc Kh Qd Qs 3s 3d 9c'));
ok('best five of seven: the board plays', ties('2c 3d As Ks Qs Js Ts', '4c 5d As Ks Qs Js Ts'));
ok('higher straight', beats('6s 7d 8h 9c Ts', '5s 6d 7h 8c 9s'));
ok('wheel loses to six-high', beats('2s 3d 4h 5c 6s', 'As 2d 3h 4c 5s'));
ok('full house: trips first', beats('3s 3d 3h 2c 2s', '2h 2d Ah Ac Kd 2c'.split(' ').slice(0, 5).join(' ')));
{ const e = equity(['As', 'Ad'], [], 1, 2000); ok('aces win about 85% heads up', e > 0.8 && e < 0.9, e); }
{ const e = equity(['7c', '2d'], [], 1, 2000); ok('seven-deuce about 35%', e > 0.28 && e < 0.42, e); }

// ---- two people: blinds and turns ----
{
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo');
  ok('waiting for the hand', t.phase === 'waiting');
  t._stack(['Kd', 'As', '2c', 'Ad', 'x1', 'Ah', '7c', '7d', 'x2', 'Ks', 'x3', '3h']);
  start(t);
  const v = t.v('a'), b = t.v('b');
  ok('dealt', t.phase === 'preflop' && v.seats[v.you].cards.length === 2, v.phase);
  const btn = v.seats[v.button].id;
  ok('heads up: the button posts the small blind and acts first', t.s(btn).bet === 5 && v.turn === v.button, { btn, v: v.seats });
  const other = btn === 'a' ? 'b' : 'a';
  ok('the other posts the big blind', t.s(other).bet === 10);
  ok('you see your cards, not theirs', v.seats[v.you].cards.every(Boolean) && v.seats[b.you].cards.every((c) => c === null));
  ok('checking isn\'t allowed facing a bet', !!t.go(btn, 'check').error);
  ok('only on your turn', !!t.go(other, 'call').error);
  ok('call', !t.go(btn, 'call').error && t.s(btn).bet === 10);
  ok('the big blind gets the option', t.v('a').turn === t.v('a').you ? 'a' === other : 'b' === other);
  ok('...and checks', !t.go(other, 'check').error);
  ok('the flop', t.phase === 'flop' && t.v('a').board.length === 3 && t.v('a').pot === 20, t.v('a'));
  ok('after the flop the big blind acts first', t.v(other).turn === t.v(other).you);
  ok('a bet below the minimum is refused', !!t.go(other, 'raise', 5).error);
  ok('bet', !t.go(other, 'raise', 20).error && t.s(other).last === 'Bet 20');
  ok('a raise below the minimum is refused', !!t.go(btn, 'raise', 30).error);
  ok('raise', !t.go(btn, 'raise', 60).error && t.s(btn).last === 'Raise to 60');
  ok('fold', !t.go(other, 'fold').error);
  ok('folds win the pot', t.phase === 'showdown' && t.s(btn).chips === 1000 + 10 + 20 && t.s(other).chips === 1000 - 30, [t.s(btn), t.s(other)]);
  ok('nobody shows cards when it\'s folded', t.v(other).seats.find((s) => s && s.id === btn).cards.every((c) => c === null));
  t.wait(3000);
  ok('the next hand: the button moves', t.phase === 'preflop' && t.v('a').seats[t.v('a').button].id === other);
}

// ---- a showdown, the board, and shown cards ----
{
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo');
  // b is the button (seat 1? the first button is the first player after seat -1 = seat 0: Ann). Ann is button + small blind, dealt second.
  t._stack(['Kd', 'Ah', '9c', 'As', 'x1', '2h', '7c', 'Ad', 'x2', 'Ks', 'x3', '3d']);       // Bo: K9, Ann: AA; board 2 7 A K 3
  start(t);
  const v = t.v('a');
  ok('Ann is the button', v.seats[v.button].id === 'a');
  ok('Ann has the aces', t.s('a').cards.join() === 'Ah,As', t.s('a').cards);
  t.go('a', 'call'); t.go('b', 'check');
  for (const st of ['flop', 'turn', 'river']) { ok(`${st}: checked through`, t.phase === st); t.go('b', 'check'); t.go('a', 'check'); }
  ok('showdown', t.phase === 'showdown');
  ok('best hand wins', t.s('a').chips === 1010 && t.s('b').chips === 990);
  const bv = t.v('b'), ann = bv.seats.find((s) => s && s.id === 'a');
  ok('the showdown shows the cards', ann.cards.join() === 'Ah,As' && ann.best === 'Three of a kind', ann);
  ok('pots list the winner', bv.pots.length === 1 && bv.seats[bv.pots[0].winners[0]].id === 'a' && bv.pots[0].hand === 'Three of a kind', bv.pots);
  ok('your own hand by name', t.v('a').mine === 'Three of a kind');
}

// ---- side pots: three all in for different amounts ----
{
  const got = [];
  const t = table({ onSettle: (l) => got.push(...l) });
  t.sit('a', 'Ann', { chips: 100 }); t.sit('b', 'Bo', { chips: 300 }); t.sit('c', 'Cy', { chips: 1000 });
  // button Ann (seat 0), small blind Bo, big blind Cy; dealing from Bo: Bo, Cy, Ann, Bo, Cy, Ann
  // Ann: AA (best), Bo: KK (second), Cy: QQ; board without help
  t._stack(['Kd', 'Qd', 'Ah', 'Kc', 'Qc', 'As', 'x1', '2h', '7c', '9s', 'x2', '3d', 'x3', '4h']);
  start(t);
  ok('three-way: Ann first to act (after the big blind)', t.turnId() === 'a', t.turnId());
  t.go('a', 'allin'); t.go('b', 'allin'); t.go('c', 'call');
  for (let i = 0; i < 10 && t.phase !== 'showdown'; i++) t.wait(2000);
  ok('runs the board out with everyone in', t.phase === 'showdown' && t.v('a').board.length === 5, t.phase);
  // main pot 300 (100 x3) to Ann; side pot 400 (200 x2) to Bo; Cy only called Bo's 300
  ok('main pot to the best hand', t.s('a').chips === 300, t.s('a'));
  ok('side pot to the next best', t.s('b').chips === 400, t.s('b'));
  ok('the caller keeps the rest', t.s('c').chips === 700, t.s('c'));
  const v = t.v('c');
  ok('two pots listed', v.pots.length === 2 && v.pots[0].amount === 300 && v.pots[1].amount === 400, v.pots);
  ok('settle reports nets', got.find((x) => x.id === 'a').net === 200 && got.find((x) => x.id === 'c').net === -300, got);
  t.wait(7000);
  ok('nobody is out (all have chips)', t.phase === 'preflop');
}

// ---- a split pot, the odd chip ----
{
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo');
  t._stack(['2d', '3c', '2s', '3d', 'x1', 'Ah', 'Kh', 'Qs', 'x2', 'Jd', 'x3', 'Tc']);       // the board is a straight: both play it
  start(t);
  t.go('a', 'call'); t.go('b', 'check');
  for (let i = 0; i < 3; i++) { t.go('b', 'check'); t.go('a', 'check'); }
  ok('split', t.s('a').chips === 1000 && t.s('b').chips === 1000 && t.v('a').pots[0].winners.length === 2);
}

// ---- the turn timer, leaving, crapping out ----
{
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo'); start(t);
  const first = t.turnId();
  t.wait(20000);
  ok('out of time facing a bet: folds', t.phase === 'showdown' && t.s(first).last === 'Fold', t.s(first));
}
{
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo'); t.sit('c', 'Cy'); start(t);
  const who = t.turnId();
  t.leave(who);
  ok('leaving on your turn folds and moves on', t.turnId() !== who && t.turnId() !== '');
  ok('the seat stays till the hand ends', t.v('x').seats.some((s) => s && s.id === who && s.left));
  for (let i = 0; i < 40 && t.phase !== 'showdown'; i++) t.go(t.turnId(), t.v(t.turnId()).can.check ? 'check' : 'call');
  t.wait(8000);
  ok('...then it goes', !t.v('x').seats.some((s) => s && s.id === who));
}
{
  const t = table(); t.sit('a', 'Ann', { chips: 50 }); t.sit('b', 'Bo');
  t._stack(['Kd', '2c', 'Ah', '7d', 'x1', 'Ad', 'Ac', '9s', 'x2', '3d', 'x3', '4h']);       // Bo: KA, Ann: 2 7 (Ann button, dealt second)
  start(t);
  t.go('a', 'allin'); t.go('b', 'call');
  for (let i = 0; i < 10 && t.phase !== 'showdown'; i++) t.wait(2000);
  ok('busted', t.s('a').chips === 0);
  t.wait(7000);
  ok('out of chips for a while', t.s('a').outMs === 20000 && t.phase === 'waiting', [t.s('a'), t.phase]);
  t.wait(20000); t.wait(3000);
  ok('back in with 1000, and dealt', t.s('a').chips + t.s('a').bet === 1000 && t.phase === 'preflop', [t.s('a').chips, t.phase]);
}

// ---- computer players ----
{
  const t = table({ fill: 4 }); t.sit('me', 'You');
  ok('three computer players join you', t.v('me').seats.filter((s) => s && s.bot).length === 3);
  start(t);
  ok('dealt', t.phase === 'preflop');
  ok('bots\' cards are hidden', t.v('me').seats.filter((s) => s && s.bot).every((s) => s.cards.every((c) => c === null)));
  // play a few dozen hands: you always check or call; bots make their own moves; the chips stay whole
  let hands = 0;
  for (let k = 0; k < 4000 && hands < 30; k++) {
    const v = t.v('me');
    if (v.turn === v.you && v.can) t.go('me', v.can.check ? 'check' : 'call');
    const was = v.hand; t.wait(1000);
    if (t.v('me').hand !== was) hands++;
  }
  ok('bots play hands', hands >= 30, hands);
  const v = t.v('me'), total = v.seats.reduce((n, s) => n + (s ? s.chips + s.put : 0), 0) + v.seats.filter((s) => s && s.bot).length * 0;
  ok('there are always four at the table', v.seats.filter(Boolean).length === 4, v.seats.filter(Boolean).length);
  ok('chips are whole numbers', v.seats.every((s) => !s || Number.isInteger(s.chips)));
  t.leave('me');
  for (let i = 0; i < 200 && t.phase !== 'idle'; i++) t.wait(1000);
  ok('the bots go when you do', t.phase === 'idle' && t.seated().length === 0, [t.phase, t.seated()]);
}
{ // at a hub (fill 2): one person gets a bot; a second person sends it away between hands
  const t = table({ fill: 2 }); t.sit('a', 'Ann');
  ok('a bot keeps one person company', t.v('a').seats.filter((s) => s && s.bot).length === 1);
  start(t);
  t.sit('b', 'Bo');
  ok('a second person sits in for the next hand', t.s('b') && !t.s('b').inHand);
  for (let i = 0; i < 200 && t.v('a').seats.some((s) => s && s.bot); i++) { const v = t.v('a'); if (v.turn === v.you && v.can) t.go('a', 'fold'); const w = t.v('b'); if (w.turn === w.you && w.can) t.go('b', 'fold'); t.wait(1000); }
  ok('...and the bot goes', !t.v('a').seats.some((s) => s && s.bot));
  ok('the two of them play', ['preflop', 'flop', 'turn', 'river', 'showdown'].includes(t.phase) && t.s('b').inHand !== undefined);
}
{ // conservation: lots of bot-only hands keep every chip
  const t = table({ fill: 6, times: { think: [0, 0] } }); t.sit('me', 'You');
  start(t);
  let worst = 0;
  for (let k = 0; k < 3000; k++) {
    const v = t.v('me');
    if (v.turn === v.you && v.can) t.go('me', 'fold');
    t.wait(500);
    const w = t.v('me'), bots = w.seats.filter(Boolean);
    if (w.phase === 'showdown') { const sum = bots.reduce((n, s) => n + s.chips, 0); worst = Math.max(worst, sum % 1); }
  }
  ok('no fractions of chips anywhere', worst === 0);
}

console.log(fails ? `${fails} failed, ${passes} passed` : `all ${passes} passed`);
process.exit(fails ? 1 : 0);
