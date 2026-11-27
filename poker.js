// Drift — Texas Hold'em, the rules (docs/plans/games-room.md §2.4). One no-limit table: up to six seats, players against
// each other (the house only deals), blinds, four betting rounds, side pots when someone is all in, and the showdown with
// the best five of seven. Pure, like blackjack.js: no Electron, no DOM, no timers of its own. Whoever runs the table
// (main.js alone, hub.js for a hub) calls tick() a few times a second and after every move, and sends view(id) to whoever
// is looking when version changes.
//
//   const t = createTable({ now, rand, times, fill });  t.sit(id, name)  t.move(id, { do: 'raise', amount: 60 })  t.tick()
//
// Computer players: with fill, the table keeps that many players by seating computer players (bots) when there aren't
// enough people, and lets them go between hands as people come. They decide from what any player could see: their own two
// cards and the board, against random hands for everyone still in (a few hundred deals each time), and the price to call.
//
// Cards are two-letter strings, rank then suit ('As', 'Td'). Nobody's cards are in anyone else's view until the showdown.
const RANKS = '23456789TJQKA', SUITS = 'shdc';
const RULES = { start: 1000, small: 5, big: 10, seats: 6 };
const TIMES = { turn: 20000, think: [900, 2400], street: 1100, show: 6500, fold: 2600, out: 20000, start: 2000 };       // ms: a turn, a computer player thinking, each card run out with everyone all in, the showdown, a hand won by folds, crapped out, a hand starting
const HANDS = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
const BOTS = ['Ada', 'Basil', 'Clover', 'Dot', 'Ember', 'Fig', 'Juniper', 'Moss', 'Pip', 'Wren'];
const STREETS = ['preflop', 'flop', 'turn', 'river'];

// The best five of 5 to 7 cards, as [category, ...what breaks a tie], compared left to right (score() makes it one number)
function rankOf(cards) {
  const rs = cards.map((c) => RANKS.indexOf(c[0]) + 2);
  const count = new Map(), suits = new Map();
  cards.forEach((c, i) => { count.set(rs[i], (count.get(rs[i]) || 0) + 1); if (!suits.has(c[1])) suits.set(c[1], []); suits.get(c[1]).push(rs[i]); });
  const high = (list) => {       // the top of the best straight in these ranks (the ace plays low too), or 0
    const u = new Set(list); if (u.has(14)) u.add(1);
    for (let h = 14; h >= 5; h--) { let k = 0; while (k < 5 && u.has(h - k)) k++; if (k === 5) return h; }
    return 0;
  };
  let flush = null;
  for (const l of suits.values()) if (l.length >= 5) flush = l.slice().sort((a, b) => b - a);
  if (flush) { const sf = high(flush); if (sf) return [8, sf]; }
  const groups = [...count].sort((a, b) => b[1] - a[1] || b[0] - a[0]);       // [rank, how many], the biggest group first
  const kick = (skip, n) => [...new Set(rs)].filter((r) => !skip.includes(r)).sort((a, b) => b - a).slice(0, n);
  const [g0, g1] = groups;
  if (g0[1] === 4) return [7, g0[0], ...kick([g0[0]], 1)];
  if (g0[1] === 3 && g1 && g1[1] >= 2) return [6, g0[0], g1[0]];
  if (flush) return [5, ...flush.slice(0, 5)];
  const st = high(rs); if (st) return [4, st];
  if (g0[1] === 3) return [3, g0[0], ...kick([g0[0]], 2)];
  if (g0[1] === 2 && g1 && g1[1] === 2) return [2, g0[0], g1[0], ...kick([g0[0], g1[0]], 1)];
  if (g0[1] === 2) return [1, g0[0], ...kick([g0[0]], 3)];
  return [0, ...kick([], 5)];
}
const score = (r) => { let n = 0; for (let i = 0; i < 6; i++) n = n * 15 + (r[i] || 0); return n; };
const handName = (r) => (r[0] === 8 && r[1] === 14 ? 'Royal flush' : HANDS[r[0]]);
const fullDeck = () => { const d = []; for (const s of SUITS) for (const r of RANKS) d.push(r + s); return d; };

// How often these two cards win against `opp` random hands, with the board so far and the rest dealt at random
function equity(cards, board, opp, n = 200, rnd = Math.random) {
  const known = new Set([...cards, ...board]), rest = fullDeck().filter((c) => !known.has(c));
  const more = 5 - board.length, need = more + 2 * opp;
  let won = 0;
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < need; j++) { const x = j + Math.floor(rnd() * (rest.length - j)); const c = rest[j]; rest[j] = rest[x]; rest[x] = c; }
    const b = board.concat(rest.slice(0, more)), mine = score(rankOf(cards.concat(b)));
    let best = true, ties = 0;
    for (let o = 0; o < opp; o++) {
      const s = score(rankOf([rest[more + 2 * o], rest[more + 2 * o + 1], ...b]));
      if (s > mine) { best = false; break; }
      if (s === mine) ties++;
    }
    if (best) won += 1 / (ties + 1);
  }
  return won / n;
}

function createTable(opts = {}) {
  const now = opts.now || (() => Date.now());
  const rand = opts.rand || ((n) => require('crypto').randomInt(n));
  const rnd = opts.botRand || Math.random;       // (the computer players' own whims: nothing about the cards)
  const T = { ...TIMES, ...(opts.times || {}) }, R = { ...RULES, ...(opts.rules || {}) }, fill = Math.max(0, Math.min(R.seats, opts.fill || 0));
  const N = R.seats, seats = new Array(N).fill(null);
  const watchers = [];       // [{ id, name }] waiting for a seat, in order
  const outs = new Map();       // id -> until: crapped out, remembered across standing up and sitting down again
  let phase = 'idle', deadline = 0, hand = 0, version = 0, deck = [], pos = 0, board = [], button = -1, turn = -1, current = 0, minRaise = 0, pots = null, botAt = 0, stacked = null;

  const changed = () => { version++; };
  const seatOf = (id) => seats.findIndex((s) => s && s.id === id);
  const betting = () => STREETS.includes(phase);
  const live = (s) => s && s.inHand && !s.folded;
  const canAct = (s) => live(s) && !s.allin;
  const eligible = (s) => s && !s.left && !s.outUntil && s.chips > 0;
  const contenders = () => seats.filter(live);
  const next = (i, f) => { for (let k = 1; k <= N; k++) { const j = (((i + k) % N) + N) % N; if (f(seats[j])) return j; } return -1; };
  const draw = () => deck[pos++];
  const fresh = (s) => Object.assign(s, { cards: [], bet: 0, put: 0, folded: false, allin: false, acted: false, raises: 0, inHand: false, last: '', won: 0, net: 0, best: '', shown: false });

  // ------------------------------------------------------------------ seats, and the computer players
  function seatIn(i, id, name, keep, bot) {
    if (!bot && opts.wallet && opts.wallet.owns(id)) keep = opts.wallet.keep(id);       // (the casino's one wallet: wallet.js)
    const out = bot ? 0 : Math.max(outs.get(id) || 0, keep && +keep.outUntil || 0);
    const s = fresh({ id, name, bot: !!bot, chips: keep && Number.isFinite(+keep.chips) ? Math.max(0, Math.floor(+keep.chips)) : R.start, outUntil: out > now() ? out : 0, left: false });
    if (s.outUntil) s.chips = 0;
    else if (s.chips < R.big) s.chips = R.start;
    if (!bot && opts.wallet) opts.wallet.bind(s);
    seats[i] = s;
    return s;
  }
  function sit(id, name, keep) {       // keep: { chips, outUntil } for a single-player table that carries over; a hub's starts fresh
    id = String(id); name = String(name || '').slice(0, 24);
    const at = seatOf(id);
    if (at >= 0) { const s = seats[at]; s.name = name; if (s.left) { s.left = false; changed(); } return { seat: at }; }
    let free = seats.indexOf(null);
    if (free < 0 && !betting() && phase !== 'showdown') { free = seats.findIndex((s) => s && s.bot); if (free >= 0) seats[free] = null; }       // a computer player makes room
    if (free < 0) { if (!watchers.some((w) => w.id === id)) { watchers.push({ id, name }); changed(); } return { watching: true }; }
    seatIn(free, id, name, keep, false);
    if (!betting() && phase !== 'showdown') { bots(); if (phase === 'idle') { phase = 'waiting'; deadline = 0; } }
    changed();
    return { seat: free };
  }
  function bots() {       // between hands: as many computer players as it takes to make `fill`, none once the people have gone
    if (!fill) return;
    const people = seats.filter((s) => s && !s.bot).length + watchers.length;
    const want = people ? Math.max(0, fill - people) : 0;
    let have = seats.filter((s) => s && s.bot);
    while (have.length > want) { const b = have.pop(); seats[seatOf(b.id)] = null; }
    while (have.length < want) {
      const free = seats.indexOf(null); if (free < 0) break;
      const used = new Set(seats.filter(Boolean).map((s) => s.name)), names = BOTS.filter((n) => !used.has(n));
      const name = names.length ? names[Math.floor(rnd() * names.length)] : 'Bot';
      have.push(seatIn(free, 'bot:' + name.toLowerCase() + ':' + hand, name, null, true));
    }
  }
  function leave(id) {
    id = String(id);
    const w = watchers.findIndex((x) => x.id === id);
    if (w >= 0) { watchers.splice(w, 1); changed(); }
    const at = seatOf(id); if (at < 0) return;
    const s = seats[at];
    if (s.outUntil) outs.set(id, s.outUntil);
    if (betting() && s.inHand) {       // in a hand: their cards are folded, and the seat goes when it's over
      s.left = true;
      if (!s.folded) { s.folded = true; s.last = 'Fold'; }
      changed();
      if (turn === at) advance(at);
      else if (contenders().length < 2) closeStreet();
      return;
    }
    if (phase === 'showdown' && s.inHand) { s.left = true; changed(); return; }
    seats[at] = null;
    if (!betting() && phase !== 'showdown') { seatWatchers(); bots(); }
    if (!seats.some(Boolean)) { phase = 'idle'; deadline = 0; }
    changed();
  }
  function seatWatchers() {
    while (watchers.length) {
      let free = seats.indexOf(null);
      if (free < 0) { free = seats.findIndex((s) => s && s.bot); if (free < 0) return; seats[free] = null; }
      const w = watchers.shift();
      seatIn(free, w.id, w.name, null, false);
    }
  }

  // ------------------------------------------------------------------ a hand
  function deal() {
    const players = seats.filter(eligible);
    if (players.length < 2) { phase = seats.some(Boolean) ? 'waiting' : 'idle'; deadline = 0; changed(); return; }
    hand++; board = []; pots = null; current = R.big; minRaise = R.big;
    deck = fullDeck();
    for (let i = deck.length - 1; i > 0; i--) { const j = rand(i + 1); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    if (stacked) { deck = stacked.concat(deck.filter((c) => !stacked.includes(c))); stacked = null; }
    pos = 0;
    for (const s of seats) if (s) { fresh(s); s.inHand = eligible(s); }
    const inH = (s) => s && s.inHand;
    button = next(button, inH);
    const sb = players.length === 2 ? button : next(button, inH), bb = next(sb, inH);       // two players: the button posts the small blind
    pay(seats[sb], R.small); seats[sb].last = 'Small blind';
    pay(seats[bb], R.big); seats[bb].last = 'Big blind';
    for (let k = 0; k < 2; k++) for (let j = next(button, inH), n = 0; n < players.length; j = next(j, inH), n++) seats[j].cards.push(draw());
    phase = 'preflop'; changed();
    startBetting(bb);
  }
  function pay(s, x) {
    x = Math.max(0, Math.min(x, s.chips));
    s.chips -= x; s.bet += x; s.put += x;
    if (s.chips === 0) s.allin = true;
  }
  function startBetting(after) {       // the first to act is the next one after `after` who still can
    const actors = seats.filter(canAct);
    if (actors.length === 0 || (actors.length === 1 && actors[0].bet >= current)) {       // nobody left to bet against: the cards just come
      turn = -1; deadline = now() + T.street; changed(); return;
    }
    setTurn(next(after, canAct));
  }
  function setTurn(j) {
    turn = j; deadline = now() + T.turn;
    if (seats[j].bot) botAt = now() + T.think[0] + rnd() * (T.think[1] - T.think[0]);
    changed();
  }
  function advance(i) {       // after the seat at i acted (or left)
    if (contenders().length < 2) return closeStreet();
    const j = next(i, (s) => canAct(s) && (!s.acted || s.bet < current));
    if (j < 0) closeStreet(); else setTurn(j);
  }
  function closeStreet() {
    for (const s of seats) if (s) { s.bet = 0; s.acted = false; s.raises = 0; }
    turn = -1;
    if (contenders().length < 2 || phase === 'river') return finish();
    pos++;       // (a card burnt)
    if (phase === 'preflop') board.push(draw(), draw(), draw()); else board.push(draw());
    phase = STREETS[STREETS.indexOf(phase) + 1]; current = 0; minRaise = R.big;
    changed();
    startBetting(button);
  }
  function finish() {
    turn = -1;
    const alive = contenders(), total = seats.reduce((n, s) => n + (s ? s.put : 0), 0);
    pots = [];
    const order = (list) => list.slice().sort((a, b) => ((seatOf(a.id) - button - 1 + N) % N) - ((seatOf(b.id) - button - 1 + N) % N));       // the odd chip goes to the first left of the button
    if (alive.length === 1) { const w = alive[0]; w.chips += total; w.won = total; pots.push({ amount: total, winners: [seatOf(w.id)], hand: '', uncalled: false }); }
    else {
      for (const s of alive) { s.rank = rankOf([...s.cards, ...board]); s.best = handName(s.rank); s.shown = true; }
      const levels = [...new Set(seats.filter((s) => s && s.put > 0).map((s) => s.put))].sort((a, b) => a - b);
      let prev = 0, lastKey = '';
      for (const lv of levels) {
        let amount = 0;
        for (const s of seats) if (s && s.put > prev) amount += Math.min(s.put, lv) - prev;
        let elig = alive.filter((s) => s.put >= lv);
        if (!elig.length) { const top = Math.max(...alive.map((s) => s.put)); elig = alive.filter((s) => s.put === top); }       // (chips from someone who folded, past everyone left in)
        prev = lv;
        if (!amount) continue;
        const best = Math.max(...elig.map((s) => score(s.rank))), win = order(elig.filter((s) => score(s.rank) === best));
        const share = Math.floor(amount / win.length); let odd = amount - share * win.length;
        for (const s of win) { const x = share + (odd > 0 ? 1 : 0); odd -= x - share; s.chips += x; s.won += x; }
        const key = elig.map((s) => s.id).join(',');
        if (key === lastKey) pots[pots.length - 1].amount += amount;
        else pots.push({ amount, winners: win.map((s) => seatOf(s.id)), hand: handName(win[0].rank), uncalled: elig.length === 1 });
        lastKey = key;
      }
    }
    for (const s of seats) if (s && s.inHand) s.net = s.won - s.put;
    phase = 'showdown'; deadline = now() + (alive.length > 1 ? T.show : T.fold);
    changed();
    // how the hand went, for whoever keeps records (hub.js: the biggest pots won)
    if (opts.onSettle) try { opts.onSettle(seats.filter((s) => s && s.inHand).map((s) => ({ id: s.id, name: s.name, bot: s.bot, net: s.net, score: s.won }))); } catch { /* theirs to get right */ }
  }
  function nextHand() {
    for (let i = 0; i < N; i++) {
      const s = seats[i]; if (!s) continue;
      if (s.left || (s.bot && s.chips === 0)) { seats[i] = null; continue; }
      if (s.chips === 0 && !s.outUntil) { s.outUntil = now() + T.out; outs.set(s.id, s.outUntil); }       // crapped out
    }
    for (const s of seats) if (s) fresh(s);
    seatWatchers(); bots();
    board = []; pots = null; turn = -1;
    if (seats.filter(eligible).length >= 2) deal();
    else { phase = seats.some(Boolean) ? 'waiting' : 'idle'; deadline = 0; changed(); }
  }

  // ------------------------------------------------------------------ moves
  function act(i, what, amount) {
    const s = seats[i], owe = current - s.bet, max = s.bet + s.chips;
    if (what === 'allin') what = max > current ? 'raise' : 'call';
    if (what === 'fold') { s.folded = true; s.last = 'Fold'; }
    else if (what === 'check') { if (owe > 0) return { error: 'You can\'t check: call or fold' }; s.last = 'Check'; }
    else if (what === 'call') {
      if (owe <= 0) s.last = 'Check';
      else { const x = Math.min(owe, s.chips); pay(s, x); s.last = s.allin ? 'All in' : `Call ${x}`; }
    } else if (what === 'raise') {
      let to = amount === Infinity ? max : Math.floor(+amount);
      if (to > max) to = max;
      if (!(to > current)) return { error: `Raise to more than ${current}` };
      if (to < current + minRaise && to < max) return { error: `Raise to at least ${current + minRaise}` };
      const was = current, inc = to - current;
      pay(s, to - s.bet);
      if (inc >= minRaise) { minRaise = inc; for (const o of seats) if (o && o !== s && canAct(o)) o.acted = false; }       // a full raise opens the betting again
      current = to; s.raises++;
      s.last = s.allin ? 'All in' : was ? `Raise to ${to}` : `Bet ${to}`;
    } else return { error: 'Not a move' };
    s.acted = true;
    changed();
    advance(i);
    return { ok: true };
  }
  function move(id, m) {
    m = m && typeof m === 'object' ? m : {};
    const i = seatOf(String(id)), s = seats[i];
    if (!s) return { error: 'Sit down first' };
    if (!betting() || turn !== i) return { error: 'Not your turn' };
    const what = String(m.do || '');
    return act(i, what, what === 'allin' ? Infinity : m.amount);
  }
  function botMove(i) {
    const s = seats[i], owe = current - s.bet, pot = seats.reduce((n, x) => n + (x ? x.put : 0), 0);
    const opp = Math.min(4, contenders().length - 1);
    const e = equity(s.cards, board, opp, 160, rnd), odds = owe / (pot + owe);
    const strong = Math.min(0.8, 1.4 / (opp + 1)), r = rnd();
    const raiseTo = (frac) => Math.max(current + minRaise, Math.round((current + pot * frac) / R.small) * R.small);
    let what = 'fold', to = 0;
    if (owe <= 0) {
      if ((e > strong && r < 0.8) || r < 0.06) { what = 'raise'; to = raiseTo(0.45 + rnd() * 0.4); } else what = 'check';
    } else if (e > strong + 0.1 && r < 0.65 && s.raises < 2) { what = 'raise'; to = raiseTo(0.6 + rnd() * 0.5); }
    else if (e > odds + (owe > s.chips * 0.4 ? 0.12 : 0.03) || (owe <= R.big && e > 0.22)) what = 'call';
    if (what === 'raise' && to >= s.bet + s.chips) what = 'allin';
    const r2 = act(i, what, what === 'allin' ? Infinity : to);
    if (r2.error) act(i, owe > 0 ? 'call' : 'check');
  }

  // ------------------------------------------------------------------ time
  function tick() {
    const t = now(), v0 = version;
    for (const s of seats) if (s && s.outUntil && t >= s.outUntil) { s.outUntil = 0; s.chips = R.start; outs.delete(s.id); changed(); }       // back in with fresh chips
    for (const [id, until] of outs) if (t >= until) outs.delete(id);
    if (phase === 'waiting') {
      if (seats.filter(eligible).length >= 2) { if (!deadline) { deadline = t + T.start; changed(); } else if (t >= deadline) deal(); }
      else if (deadline) { deadline = 0; changed(); }
    } else if (betting()) {
      if (turn < 0) { if (deadline && t >= deadline) closeStreet(); }
      else if (seats[turn].bot) { if (t >= botAt) botMove(turn); }
      else if (t >= deadline) { const s = seats[turn]; act(turn, s.bet < current ? 'fold' : 'check'); }       // out of time: checks if it can, folds if not
    } else if (phase === 'showdown' && t >= deadline) nextHand();
    return version !== v0;
  }

  // ------------------------------------------------------------------ what someone sees
  function view(id) {
    const t = now(), me = seatOf(String(id)), s0 = seats[me];
    const pot = seats.reduce((n, s) => n + (s ? s.put - s.bet : 0), 0);
    let can = null;
    if (s0 && betting() && turn === me) {
      const owe = current - s0.bet, max = s0.bet + s0.chips;
      can = { fold: true, check: owe <= 0, call: owe > 0 ? Math.min(owe, s0.chips) : 0, raise: max > current ? { min: Math.min(current + minRaise, max), max } : null };
    }
    return {
      phase, hand, small: R.small, big: R.big, start: R.start,
      msLeft: deadline ? Math.max(0, deadline - t) : 0, turnMs: T.turn,
      you: me, watching: watchers.findIndex((w) => w.id === String(id)), watchers: watchers.length,
      button, turn, board: board.slice(), pot, current, can,
      mine: s0 && live(s0) && s0.cards.length && board.length >= 3 ? handName(rankOf([...s0.cards, ...board])) : '',
      pots: pots ? pots.map((p) => ({ ...p, winners: p.winners.slice() })) : null,
      seats: seats.map((s, i) => s && {
        id: s.id, name: s.name, bot: s.bot, chips: s.chips, bet: s.bet, put: s.put, folded: s.folded, allin: s.allin, inHand: s.inHand, left: s.left,
        last: s.last, won: phase === 'showdown' ? s.won : 0, net: phase === 'showdown' ? s.net : 0, best: s.shown ? s.best : '',
        outMs: s.outUntil ? Math.max(0, s.outUntil - t) : 0,
        cards: i === me || s.shown ? s.cards.slice() : live(s) ? s.cards.map(() => null) : [],
      }),
    };
  }
  // What to keep for a single-player table between runs: the chips, with what's in a pot not decided yet given back
  // (quitting mid-hand neither wins nor loses it; a folded hand's chips are gone)
  function mine(id) {
    const s = seats[seatOf(String(id))]; if (!s) return null;
    return { chips: s.chips + (betting() && live(s) ? s.put : 0), outUntil: s.outUntil };
  }

  return {
    sit, leave, move, tick, view, mine,
    get version() { return version; }, get phase() { return phase; },
    seated: () => seats.filter(Boolean).map((s) => s.id),
    _stack(cards) { stacked = cards.slice(); },       // tests: the next hand's deck starts with these (the hole cards in dealing order, first card each then second, then a burn before each street)
  };
}

module.exports = { createTable, rankOf, score, handName, equity, RULES, TIMES };
