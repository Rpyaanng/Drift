// Drift — blackjack, the rules (docs/plans/blackjack.md §3). One table: up to six seats, one dealer, everyone playing the
// dealer. Pure: no Electron, no DOM, no timers of its own. Whoever runs the table (main.js alone, hub.js for a hub) calls
// tick() a few times a second and after every action, and sends view(id) to whoever is looking when version changes.
//
//   const t = createTable({ now, rand, times });  t.sit(id, name)  t.bet(id, 100)  t.act(id, 'hit')  t.tick()  t.view(id)
//
// Cards are two-letter strings, rank then suit: 'As', 'Td', '9h', 'Qc'. The shoe never leaves here: a view has the cards
// dealt so far and the dealer's hole card as null until it's turned over.
const RANKS = 'A23456789TJQK', SUITS = 'shdc';
const RULES = { decks: 6, cut: 0.75, start: 1000, back: 500, min: 10, max: 10000, seats: 6 };       // (start: a new player's chips; back: out of chips, what you're back in with; min and max: a bet's limits)
const TIMES = { bet: 10000, insure: 8000, turn: 20000, dealer: 700, done: 5000, out: 20000 };       // ms: betting once someone has bet, insurance, a turn, each dealer card, looking at the result, crapped out

const value = (c) => { const r = c[0]; return r === 'A' ? 1 : 'TJQK'.includes(r) ? 10 : +r; };
function total(cards) {       // { n, soft }: the best total, and whether an ace is counted as 11 in it
  let n = 0, aces = 0;
  for (const c of cards) { if (!c) continue; n += value(c); if (c[0] === 'A') aces++; }
  const soft = aces > 0 && n + 10 <= 21;
  return { n: soft ? n + 10 : n, soft };
}
const isBlackjack = (cards) => cards.length === 2 && total(cards).n === 21;

function createTable(opts = {}) {
  const now = opts.now || (() => Date.now());
  const rand = opts.rand || ((n) => require('crypto').randomInt(n));
  const T = { ...TIMES, ...(opts.times || {}) }, R = { ...RULES, ...(opts.rules || {}) };
  const seats = new Array(R.seats).fill(null);
  const watchers = [];       // [{ id, name }] waiting for a seat, in order
  const outs = new Map();       // id -> until: crapped out, remembered across standing up and sitting down again
  let shoe = [], pos = 0, phase = 'idle', deadline = 0, dealer = [], hole = true, turn = null, round = 0, version = 0, last = null;

  const changed = () => { version++; };
  function shuffle() {
    shoe = [];
    for (let d = 0; d < R.decks; d++) for (const s of SUITS) for (const r of RANKS) shoe.push(r + s);
    for (let i = shoe.length - 1; i > 0; i--) { const j = rand(i + 1); [shoe[i], shoe[j]] = [shoe[j], shoe[i]]; }
    pos = 0;
  }
  shuffle();
  const draw = () => { if (pos >= shoe.length) shuffle(); return shoe[pos++]; };
  const seatOf = (id) => seats.findIndex((s) => s && s.id === id);
  const playing = () => seats.filter((s) => s && s.bet > 0 && s.hands.length);
  const canBet = (s) => s && !s.left && !s.outUntil && s.chips >= R.min;

  // ------------------------------------------------------------------ seats
  function sit(id, name, keep) {       // keep: { chips, outUntil } for a single-player table that carries over; a hub's starts fresh
    id = String(id); name = String(name || '').slice(0, 24);
    const at = seatOf(id);
    if (at >= 0) { const s = seats[at]; s.name = name; if (s.left) { s.left = false; changed(); } return { seat: at }; }
    const free = seats.indexOf(null);
    if (free < 0) { if (!watchers.some((w) => w.id === id)) { watchers.push({ id, name }); changed(); } return { watching: true }; }
    if (opts.wallet && opts.wallet.owns(id)) keep = opts.wallet.keep(id);       // (the casino's one wallet: wallet.js)
    const out = Math.max(outs.get(id) || 0, keep && +keep.outUntil || 0);
    const s = { id, name, chips: keep && Number.isFinite(+keep.chips) ? Math.max(0, Math.floor(+keep.chips)) : R.start, bet: 0, insurance: null, hands: [], outUntil: out > now() ? out : 0, left: false, net: 0 };
    if (s.outUntil) s.chips = 0;
    else if (s.chips < R.min) s.chips = R.back;
    if (opts.wallet) opts.wallet.bind(s);
    seats[free] = s;
    if (phase === 'idle') { phase = 'betting'; deadline = 0; }
    changed();
    return { seat: free };
  }
  function leave(id) {
    id = String(id);
    const w = watchers.findIndex((x) => x.id === id);
    if (w >= 0) { watchers.splice(w, 1); changed(); }
    const at = seatOf(id); if (at < 0) return;
    const s = seats[at];
    if (s.outUntil) outs.set(id, s.outUntil);
    if (phase === 'betting' || phase === 'idle' || !s.hands.length) { s.chips += s.bet; free(at); }       // a bet not dealt yet comes back
    else {       // in a round: their hands stand, and the seat goes when it's settled
      s.left = true;
      for (const h of s.hands) h.done = true;
      if (phase === 'insurance' && s.insurance === null) s.insurance = 0;
      changed();
      if (phase === 'turns' && turn && turn.seat === at) nextTurn();
      else if (phase === 'insurance' && playing().every((x) => x.insurance !== null)) peek();
      return;
    }
    changed();
  }
  function free(at) {
    seats[at] = null;
    const w = watchers.shift();
    if (w) sit(w.id, w.name);
    if (!seats.some(Boolean)) { phase = 'idle'; deadline = 0; turn = null; dealer = []; hole = true; }
  }

  // ------------------------------------------------------------------ betting
  function bet(id, amount) {
    const s = seats[seatOf(id)];
    if (!s) return { error: 'Sit down first' };
    if (phase !== 'betting') return { error: 'Wait for the next hand' };
    if (s.outUntil) return { error: 'Out of chips for a moment' };
    if (s.bet) return { error: 'Your bet is in' };
    amount = Math.floor(+amount);
    if (!(amount >= R.min)) return { error: `Bets start at ${R.min}` };
    if (amount > R.max) return { error: `Bets go up to ${R.max.toLocaleString('en-US')}` };
    if (amount > s.chips) return { error: 'Not enough chips' };
    s.chips -= amount; s.bet = amount;
    if (!deadline) deadline = now() + T.bet;
    changed();
    return { ok: true };
  }
  function deal() {
    if (pos > shoe.length * R.cut) shuffle();       // the cut card came out last round
    round++; dealer = []; hole = true; turn = null; last = null;
    const ps = seats.filter((s) => s && s.bet > 0);
    for (const s of seats) if (s) s.net = 0;
    for (const s of ps) s.hands = [{ cards: [], bet: s.bet, done: false, doubled: false, split: false, result: '' }];
    for (let k = 0; k < 2; k++) { for (const s of ps) s.hands[0].cards.push(draw()); dealer.push(draw()); }
    for (const s of ps) if (isBlackjack(s.hands[0].cards)) s.hands[0].done = true;
    if (dealer[0][0] === 'A') {
      for (const s of ps) s.insurance = s.left ? 0 : null;
      phase = 'insurance'; deadline = now() + T.insure;
      if (ps.every((s) => s.insurance !== null)) peek();
    } else peek();
  }

  // ------------------------------------------------------------------ insurance and the peek
  function insure(id, yes) {
    const s = seats[seatOf(id)];
    if (!s || phase !== 'insurance' || !s.hands.length || s.insurance !== null) return { error: 'No insurance now' };
    const cost = Math.floor(s.bet / 2);
    if (yes && cost > s.chips) return { error: 'Not enough chips' };
    if (yes) { s.chips -= cost; s.insurance = cost; } else s.insurance = 0;
    changed();
    if (playing().every((x) => x.insurance !== null)) peek();
    return { ok: true };
  }
  function peek() {
    const up = dealer[0][0];
    if ((up === 'A' || 'TJQK'.includes(up)) && isBlackjack(dealer)) {
      hole = false;
      for (const s of playing()) if (s.insurance) s.chips += s.insurance * 3;       // its stake back and 2:1
      settle();
      return;
    }
    for (const s of playing()) if (s.insurance) s.net -= s.insurance;       // lost (it was taken from their chips already)
    phase = 'turns';
    nextTurn();
  }

  // ------------------------------------------------------------------ turns
  function nextTurn() {
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i]; if (!s || !s.hands.length) continue;
      const h = s.hands.findIndex((x) => !x.done);
      if (h >= 0) { turn = { seat: i, hand: h }; deadline = now() + T.turn; changed(); return; }
    }
    turn = null; phase = 'dealer'; hole = false; deadline = now() + T.dealer; changed();
  }
  function actions(s, i) {       // what the seat at i may do right now
    if (phase !== 'turns' || !turn || turn.seat !== i || s.left) return [];
    const h = s.hands[turn.hand], two = h.cards.length === 2, first = s.hands.length === 1 && two;
    const out = ['hit', 'stand'];
    if (two && !(h.split && h.cards[0][0] === 'A') && s.chips >= h.bet) out.push('double');
    if (first && value(h.cards[0]) === value(h.cards[1]) && s.chips >= h.bet) out.push('split');
    if (first) out.push('surrender');
    return out;
  }
  function act(id, what) {
    const i = seatOf(id), s = seats[i];
    if (!s || !actions(s, i).includes(what)) return { error: 'Not now' };
    const h = s.hands[turn.hand];
    if (what === 'hit') { h.cards.push(draw()); if (total(h.cards).n >= 21) h.done = true; }
    else if (what === 'stand') h.done = true;
    else if (what === 'double') { s.chips -= h.bet; h.bet *= 2; h.doubled = true; h.cards.push(draw()); h.done = true; }
    else if (what === 'surrender') { s.chips += Math.floor(h.bet / 2); h.result = 'surrender'; h.done = true; }
    else if (what === 'split') {
      s.chips -= h.bet;
      const b = { cards: [h.cards.pop()], bet: h.bet, done: false, doubled: false, split: true, result: '' };
      h.split = true; s.hands.push(b);
      h.cards.push(draw()); b.cards.push(draw());
      if (h.cards[0][0] === 'A') { h.done = b.done = true; }       // split aces: one card each
      else for (const x of s.hands) if (total(x.cards).n === 21) x.done = true;
    }
    changed();
    if (h.done || s.hands.every((x) => x.done)) nextTurn(); else deadline = now() + T.turn;
    return { ok: true };
  }

  // ------------------------------------------------------------------ the dealer, and paying out
  function dealerStep() {
    const live = playing().some((s) => s.hands.some((h) => !h.result && total(h.cards).n <= 21 && !(isBlackjack(h.cards) && !h.split)));
    const t = total(dealer);
    if (live && t.n < 17) { dealer.push(draw()); deadline = now() + T.dealer; changed(); return; }       // stands on every 17, soft ones too
    settle();
  }
  function settle() {
    const d = total(dealer).n, dbj = isBlackjack(dealer);
    for (const s of playing()) {
      for (const h of s.hands) {
        const p = total(h.cards).n, bj = isBlackjack(h.cards) && !h.split;
        if (h.result === 'surrender') { s.net -= h.bet - Math.floor(h.bet / 2); continue; }
        if (bj && !dbj) { h.result = 'blackjack'; const win = Math.floor(h.bet * 3 / 2); s.chips += h.bet + win; s.net += win; }
        else if (bj && dbj) { h.result = 'push'; s.chips += h.bet; }
        else if (p > 21) { h.result = 'bust'; s.net -= h.bet; }
        else if (dbj) { h.result = 'lose'; s.net -= h.bet; }
        else if (d > 21 || p > d) { h.result = 'win'; s.chips += h.bet * 2; s.net += h.bet; }
        else if (p === d) { h.result = 'push'; s.chips += h.bet; }
        else { h.result = 'lose'; s.net -= h.bet; }
      }
      if (s.insurance && dbj) s.net += s.insurance * 2;
    }
    hole = false; turn = null; phase = 'done'; deadline = now() + T.done;
    last = { dealer: total(dealer).n, blackjack: dbj };
    changed();
    // how each hand went, for whoever keeps records (hub.js: the biggest pots): net is what the round won or lost them
    if (opts.onSettle) try { opts.onSettle(playing().map((s) => ({ id: s.id, name: s.name, net: s.net, blackjack: s.hands.some((h) => h.result === 'blackjack') }))); } catch { /* theirs to get right */ }
  }
  function nextRound() {
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i]; if (!s) continue;
      if (s.left) { free(i); continue; }
      s.bet = 0; s.hands = []; s.insurance = null;
      if (s.chips < R.min && !s.outUntil) { s.outUntil = now() + T.out; outs.set(s.id, s.outUntil); }       // crapped out
    }
    dealer = []; hole = true; turn = null;
    phase = seats.some(Boolean) ? 'betting' : 'idle'; deadline = 0;
    changed();
  }

  // ------------------------------------------------------------------ time
  function tick() {
    const t = now(), v0 = version;
    for (const s of seats) if (s && s.outUntil && t >= s.outUntil) { s.outUntil = 0; s.chips = R.back; outs.delete(s.id); changed(); }       // back in with fresh chips
    for (const [id, until] of outs) if (t >= until) outs.delete(id);
    if (phase === 'betting') {
      const able = seats.filter(canBet), bets = seats.filter((s) => s && s.bet > 0).length;
      const all = able.every((s) => s.bet > 0);
      if (bets && (all || (deadline && t >= deadline))) deal();
    } else if (deadline && t >= deadline) {
      if (phase === 'insurance') { for (const s of playing()) if (s.insurance === null) s.insurance = 0; peek(); }
      else if (phase === 'turns') { const s = seats[turn.seat]; s.hands[turn.hand].done = true; changed(); nextTurn(); }       // out of time: stands
      else if (phase === 'dealer') dealerStep();
      else if (phase === 'done') nextRound();
    }
    return version !== v0;
  }

  // ------------------------------------------------------------------ what someone sees
  function view(id) {
    const t = now(), me = seatOf(String(id));
    return {
      phase, round, min: R.min, max: R.max, start: R.start, back: R.back,
      msLeft: deadline ? Math.max(0, deadline - t) : 0,
      turn: turn ? { ...turn } : null,
      you: me, watching: watchers.findIndex((w) => w.id === String(id)), watchers: watchers.length,
      dealer: { cards: dealer.map((c, i) => (i === 1 && hole ? null : c)), total: hole ? total(dealer.slice(0, 1)).n : total(dealer).n, soft: !hole && total(dealer).soft },
      last,
      shoe: { left: shoe.length - pos, size: shoe.length },
      seats: seats.map((s, i) => s && {
        id: s.id, name: s.name, chips: s.chips, bet: s.bet, insurance: s.insurance, left: s.left, net: s.net,
        outMs: s.outUntil ? Math.max(0, s.outUntil - t) : 0,
        hands: s.hands.map((h) => ({ cards: h.cards.slice(), bet: h.bet, done: h.done, doubled: h.doubled, result: h.result, ...total(h.cards) })),
        can: actions(s, i),
        insure: phase === 'insurance' && s.hands.length > 0 && s.insurance === null && !s.left ? Math.floor(s.bet / 2) : 0,
      }),
    };
  }
  // What to keep for a single-player table between runs: the chips, with anything still riding on an unsettled hand given
  // back (quitting mid-hand neither wins nor loses it), and when a crapped-out seat is back in.
  function mine(id) {
    const s = seats[seatOf(String(id))]; if (!s) return null;
    let chips = s.chips;
    if (phase !== 'done') {
      if (!s.hands.length) chips += s.bet;
      else { chips += s.insurance || 0; for (const h of s.hands) if (h.result !== 'surrender') chips += h.bet; }
    }
    return { chips, outUntil: s.outUntil };
  }

  return {
    sit, leave, bet, insure, act, tick, view, mine,
    get version() { return version; }, get phase() { return phase; },
    seated: () => seats.filter(Boolean).map((s) => s.id),
    _stack(cards) { shoe.splice(pos, 0, ...cards); },       // tests: these cards come next
  };
}

module.exports = { createTable, total, isBlackjack, RULES, TIMES };
