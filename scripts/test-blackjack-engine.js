#!/usr/bin/env node
// Blackjack's rules (blackjack.js), in plain Node with a fake clock and stacked cards: a few seconds, no Electron.
//   node scripts/test-blackjack-engine.js
// Cards are dealt one to each player in seat order, then the dealer's up card, then again (the dealer's second is the hole
// card), then whatever is hit. So for one player: player, dealer up, player, dealer hole, ...
const { createTable, total } = require('../blackjack.js');

let fails = 0, passes = 0;
const ok = (name, cond, extra) => { if (cond) passes++; else { fails++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

function table(opts = {}) {
  const clock = { t: 1000000 };
  let seed = 7;
  const t = createTable({ now: () => clock.t, rand: (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; }, ...opts });
  t.clock = clock;
  t.wait = (ms) => { clock.t += ms; t.tick(); };
  t.me = (id = 'a') => t.view(id).seats[t.view(id).you];
  return t;
}
// one player, a bet, these cards next: then it's dealt
function hand(cards, betAmt = 100, keep) {
  const t = table(); t.sit('a', 'Ann', keep); t._stack(cards); t.bet('a', betAmt); t.tick();
  return t;
}
const finish = (t) => { for (let i = 0; i < 40 && t.phase !== 'done'; i++) t.wait(1000); };

// totals
ok('total soft', total(['As', '6d']).n === 17 && total(['As', '6d']).soft);
ok('total hard', total(['As', '6d', 'Tc']).n === 17 && !total(['As', '6d', 'Tc']).soft);
ok('two aces', total(['As', 'Ad']).n === 12);

{ // a plain win: 20 against the dealer's 17
  const t = hand(['Ts', '7d', 'Qh', 'Tc']);
  ok('deals to turns', t.phase === 'turns', t.phase);
  ok('hole card hidden', t.view('a').dealer.cards[1] === null);
  ok('can surrender, double', t.me().can.includes('surrender') && t.me().can.includes('double'));
  t.act('a', 'stand'); finish(t);
  ok('win pays 1:1', t.me().chips === 1100 && t.me().hands[0].result === 'win', t.me());
}
{ // blackjack pays 3:2
  const t = hand(['As', '9d', 'Kh', '8c']);
  finish(t);
  ok('blackjack 3:2', t.me().chips === 1150 && t.me().hands[0].result === 'blackjack', t.me());
}
{ // a push
  const t = hand(['Ts', 'Td', '9h', '9c']); t.act('a', 'stand'); finish(t);
  ok('push', t.me().chips === 1000 && t.me().hands[0].result === 'push', t.me());
}
{ // the dealer stands on soft 17
  const t = hand(['Ts', '6d', '8h', 'Ac', '5s']);
  ok('no insurance on a 6', t.phase === 'turns');
  t.act('a', 'stand'); finish(t);
  ok('S17: dealer stands', t.view('a').dealer.cards.length === 2 && t.view('a').dealer.total === 17, t.view('a').dealer);
  ok('18 beats soft 17', t.me().hands[0].result === 'win');
}
{ // the dealer hits 16 and busts
  const t = hand(['Ts', 'Td', '8h', '6c', 'Kh']); t.act('a', 'stand'); finish(t);
  ok('dealer hits 16, busts', t.view('a').dealer.total === 26 && t.me().hands[0].result === 'win', t.view('a').dealer);
}
{ // a bust
  const t = hand(['Ts', '7d', '6h', 'Tc', '9s']); t.act('a', 'hit');
  ok('bust ends the turn', t.phase === 'dealer' || t.phase === 'done', t.phase);
  finish(t);
  ok('bust loses', t.me().chips === 900 && t.me().hands[0].result === 'bust');
  ok('dealer draws nothing when all bust', t.view('a').dealer.cards.length === 2);
}
{ // double down: one card, twice the bet
  const t = hand(['6s', 'Td', '5h', '7c', 'Ts']); t.act('a', 'double');
  ok('double ends the turn', t.phase !== 'turns');
  finish(t);
  ok('double pays twice', t.me().chips === 1200 && t.me().hands[0].bet === 200 && t.me().hands[0].cards.length === 3, t.me());
}
{ // split eights
  const t = hand(['8s', 'Td', '8h', '7c', '3d', 'Tc']);       // the split hands get 3 and T
  ok('can split', t.me().can.includes('split'));
  t.act('a', 'split');
  ok('two hands', t.me().hands.length === 2 && t.me().chips === 800, t.me());
  ok('no surrender after split', !t.me().can.includes('surrender'));
  ok('double after split', t.me().can.includes('double'));
  t.act('a', 'stand');       // 11
  ok('second hand next', t.view('a').turn.hand === 1, t.view('a').turn);
  t.act('a', 'stand');       // 18
  finish(t);
  const hs = t.me().hands;
  ok('split settles each hand', hs[0].result === 'lose' && hs[1].result === 'win' && t.me().chips === 1000, t.me());
}
{ // split aces: one card each, and 21 there isn't blackjack
  const t = hand(['As', '9d', 'Ah', '8c', 'Kd', '5c']);
  t.act('a', 'split');
  ok('split aces done at once', t.phase !== 'turns', t.phase);
  finish(t);
  const hs = t.me().hands;
  ok('split ace 21 pays 1:1', hs[0].result === 'win' && hs[0].n === 21 && hs[1].result === 'lose' && t.me().chips === 1000, t.me());
}
{ // surrender: half back
  const t = hand(['Ts', 'Td', '6h', '7c']); t.act('a', 'surrender'); finish(t);
  ok('surrender gives half back', t.me().chips === 950 && t.me().hands[0].result === 'surrender', t.me());
}
{ // no surrender after a hit
  const t = hand(['5s', 'Td', '4h', '7c', '2d']); t.act('a', 'hit');
  ok('no surrender after hit', !t.me().can.includes('surrender') && !t.me().can.includes('double'), t.me().can);
}
{ // insurance taken, dealer has blackjack
  const t = hand(['Ts', 'Ad', '9h', 'Kc']);
  ok('insurance offered on an ace', t.phase === 'insurance' && t.me().insure === 50, t.me());
  ok('no acting during insurance', t.act('a', 'stand').error);
  t.insure('a', true);
  ok('dealer blackjack shown', t.phase === 'done' && t.view('a').dealer.cards[1] === 'Kc', t.view('a'));
  ok('insurance pays 2:1', t.me().chips === 1000 && t.me().hands[0].result === 'lose', t.me());
}
{ // insurance taken, no dealer blackjack
  const t = hand(['Ts', 'Ad', '9h', '7c']); t.insure('a', true);
  ok('insurance lost, play goes on', t.phase === 'turns' && t.me().chips === 850, t.me());
  t.act('a', 'stand'); finish(t);
  ok('19 beats soft 18 after insurance', t.me().hands[0].result === 'win' && t.me().chips === 1050, t.me());
}
{ // insurance runs out of time: no
  const t = hand(['Ts', 'Ad', '9h', '7c']); t.wait(8001);
  ok('insurance timeout is no', t.phase === 'turns' && t.me().chips === 900 && t.me().insurance === 0, t.me());
}
{ // dealer blackjack under a ten, no insurance offered, player blackjack pushes
  const t = hand(['As', 'Kd', 'Kh', 'Ac']);
  ok('ten up: peek, push', t.phase === 'done' && t.me().hands[0].result === 'push' && t.me().chips === 1000, t.me());
}
{ // a turn runs out: stand
  const t = hand(['Ts', '7d', '6h', 'Tc']); t.wait(20001);
  ok('turn timeout stands', t.phase === 'dealer' || t.phase === 'done', t.phase);
}
{ // bets: limits
  const t = table(); t.sit('a', 'Ann');
  ok('below min refused', t.bet('a', 5).error);
  ok('no top limit', !t.bet('a', 1000).error);
  const u = table(); u.sit('a', 'Ann');
  ok('but not more than you have', u.bet('a', 1001).error);
  ok('no bet before sitting', t.bet('b', 100).error);
}
{ // crapping out: 20 s, then 1,000 again
  const t = hand(['Ts', 'Td', '6h', '7c'], 10, { chips: 10 }); t.act('a', 'stand'); finish(t);
  ok('lost the last chips', t.me().chips === 0);
  t.wait(5001);
  ok('crapped out', t.me().outMs > 19000 && t.phase === 'betting', t.me());
  ok('no bet while out', t.bet('a', 10).error);
  t.leave('a'); t.sit('a', 'Ann');
  ok('standing up does not skip it', t.me().outMs > 0 && t.me().chips === 0, t.me());
  t.wait(20000);
  ok('back in with 1,000', t.me().outMs === 0 && t.me().chips === 1000, t.me());
}
{ // two players: seat order, and only yours to play
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo');
  t._stack(['Ts', '5h', '7d', '7s', '9h', 'Tc']);       // a: T 7, b: 5 9 (hit gets... ), dealer 7 T
  t.bet('a', 100); t.tick();
  ok('waits for everyone', t.phase === 'betting');
  t.bet('b', 50); t.tick();
  ok('both bet: dealt', t.phase === 'turns' && t.view('a').turn.seat === 0, t.view('a').turn);
  ok('b cannot play on a\'s turn', t.act('b', 'hit').error && t.view('b').seats[1].can.length === 0);
  t.act('a', 'stand');
  ok('then b', t.view('a').turn.seat === 1);
  t.act('b', 'stand'); finish(t);
  ok('each against the dealer', t.view('a').seats[0].hands[0].result === 'push' && t.view('a').seats[1].hands[0].result === 'lose', t.view('a').seats);
}
{ // betting closes on time without a straggler
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo'); t.bet('a', 100); t.tick(); t.wait(10001);
  ok('deadline deals who bet', t.phase !== 'betting' && t.view('b').seats[1].hands.length === 0, t.phase);
}
{ // leaving on your turn moves it on; the seat goes after the hand
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo');
  t._stack(['Ts', '5h', '7d', '7s', '9h', 'Tc']); t.bet('a', 100); t.bet('b', 50); t.tick();
  t.leave('a');
  ok('leave moves the turn on', t.view('b').turn && t.view('b').turn.seat === 1, t.view('b').turn);
  t.act('b', 'stand'); finish(t); t.wait(5001);
  ok('seat freed after the hand', t.view('b').seats[0] === null);
}
{ // seven people: six seats, one watching who gets the next seat
  const t = table(); for (const id of 'abcdefg') t.sit(id, id);
  ok('seventh watches', t.view('g').you === -1 && t.view('g').watching === 0);
  t.leave('c');
  ok('watcher takes the seat', t.view('g').you === 2);
}
{ // standing up with a bet down that wasn't dealt yet: it comes back, and you can sit down again
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo'); t.bet('a', 100); t.tick();
  const k = t.mine('a'); t.leave('a');
  ok('stand up: bet comes back', k.chips === 1000 && t.view('a').you === -1 && t.view('a').seats[0] === null);
  t.sit('a', 'Ann', k);
  ok('sit back down', t.view('a').you >= 0 && t.me().chips === 1000);
}
{ // standing up once your hand is played: the seat stays till it settles, sitting back down keeps it
  const t = table(); t.sit('a', 'Ann'); t.sit('b', 'Bo');
  t._stack(['Ts', '5h', '7d', '7s', '9h', 'Tc']); t.bet('a', 100); t.bet('b', 50); t.tick();
  t.act('a', 'stand'); t.leave('a');
  ok('stood up mid-round: seat kept, marked', t.view('b').seats[0] && t.view('b').seats[0].left && t.view('b').turn.seat === 1);
  t.sit('a', 'Ann');
  ok('sat back down before it settled', t.view('a').you === 0 && !t.view('a').seats[0].left);
  t.act('b', 'stand'); finish(t); t.wait(1600); t.wait(5001);
  ok('...and keeps the seat after', t.view('a').you === 0 && t.view('a').seats[0].hands.length === 0);
}
{ // each settled round is reported (the hub's biggest pots): what every player's round won or lost
  const got = []; const clock = { t: 1e6 };
  const t = createTable({ now: () => clock.t, rand: () => 0, onSettle: (list) => got.push(...list) });
  t.sit('a', 'Ann'); t.sit('b', 'Bo');
  t._stack(['As', 'Ts', '7d', 'Kh', '5c', 'Tc']);       // a: A K (blackjack), b: T 5, dealer 7 T
  t.bet('a', 100); t.bet('b', 50); t.tick(); t.act('b', 'stand');
  for (let i = 0; i < 20 && t.phase !== 'done'; i++) { clock.t += 1000; t.tick(); }
  const a = got.find((x) => x.id === 'a'), b = got.find((x) => x.id === 'b');
  ok('settle reports each player', got.length === 2 && a && b, got);
  ok('...a blackjack: +150, marked', a.net === 150 && a.blackjack && a.name === 'Ann', a);
  ok('...a loss: -50', b.net === -50 && !b.blackjack, b);
}
{ // quitting mid-hand keeps your chips
  const t = hand(['Ts', '7d', '6h', 'Tc']);
  ok('mine refunds an unsettled bet', t.mine('a').chips === 1000, t.mine('a'));
}

console.log(fails ? `${fails} failed, ${passes} passed` : `all ${passes} passed`);
process.exit(fails ? 1 : 0);
