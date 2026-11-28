// Drift — roulette, the rules (docs/plans/games-room.md §2.1). One European wheel (a single zero), up to eight players
// betting on the same layout at once. Pure, like blackjack.js: no Electron, no DOM, no timers of its own. Whoever runs the
// table (main.js alone, hub.js for a hub) calls tick() a few times a second and after every move, and sends view(id) to
// whoever is looking when version changes.
//
//   const t = createTable({ now, rand, times });  t.sit(id, name)  t.move(id, { do: 'bet', key: 'red', amount: 25 })  t.tick()
//
// A bet is a key: a number ('17'), the numbers it covers joined by '-' smallest first ('17-20' a split, '13-14-16-17' a
// corner, '1-2-3' a street, '1-2-3-4-5-6' a six line, '0-1-2' a trio, '0-1-2-3' the first four), or an outside bet ('red',
// 'black', 'odd', 'even', 'low', 'high', 'd1'..'d3' the dozens, 'c1'..'c3' the columns). Every bet pays 36 / (numbers it
// covers) - 1 to 1, the book's odds. The number is picked when the ball is spun and kept here until it lands.
const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const RULES = { start: 1000, back: 500, min: 5, spot: 1000, seats: 8 };       // start: a new player's chips; back: out of chips, what you're back in with; min: the smallest bet; spot: the most on any one bet
const TIMES = { bet: 25000, spin: 6000, done: 6000, out: 20000 };       // ms: betting once someone has bet, the ball going round, looking at the result, crapped out

const BETS = (() => {
  const B = new Map(), set = (nums) => { const s = [...nums].sort((a, b) => a - b); B.set(s.join('-'), s); };
  const at = (c, r) => 3 * c + 3 - r;       // the layout's column 0..11 and row 0..2 (from the top: 3, 2, 1)
  for (let n = 0; n <= 36; n++) set([n]);
  for (let c = 0; c < 12; c++) {
    for (let r = 0; r < 3; r++) {
      const n = at(c, r);
      if (c < 11) set([n, n + 3]);
      if (r < 2) set([n, n - 1]);
      if (c < 11 && r < 2) set([n, n - 1, n + 3, n + 2]);
    }
    set([3 * c + 1, 3 * c + 2, 3 * c + 3]);
    if (c < 11) set([3 * c + 1, 3 * c + 2, 3 * c + 3, 3 * c + 4, 3 * c + 5, 3 * c + 6]);
  }
  for (const s of [[0, 1], [0, 2], [0, 3], [0, 1, 2], [0, 2, 3], [0, 1, 2, 3]]) set(s);
  const all = (f) => { const o = []; for (let n = 1; n <= 36; n++) if (f(n)) o.push(n); return o; };
  B.set('red', all((n) => REDS.has(n))); B.set('black', all((n) => !REDS.has(n)));
  B.set('odd', all((n) => n % 2 === 1)); B.set('even', all((n) => n % 2 === 0));
  B.set('low', all((n) => n <= 18)); B.set('high', all((n) => n >= 19));
  for (let k = 1; k <= 3; k++) { B.set('d' + k, all((n) => n > 12 * (k - 1) && n <= 12 * k)); B.set('c' + k, all((n) => n % 3 === k % 3)); }
  return B;
})();
const pays = (key) => 36 / BETS.get(key).length - 1;

function createTable(opts = {}) {
  const now = opts.now || (() => Date.now());
  const rand = opts.rand || ((n) => require('crypto').randomInt(n));
  const T = { ...TIMES, ...(opts.times || {}) }, R = { ...RULES, ...(opts.rules || {}) };
  const seats = new Array(R.seats).fill(null);
  const watchers = [];       // [{ id, name }] waiting for a place, in order
  const outs = new Map();       // id -> until: crapped out, remembered across standing up and sitting down again
  let phase = 'idle', deadline = 0, round = 0, version = 0, number = null, history = [];

  const changed = () => { version++; };
  const seatOf = (id) => seats.findIndex((s) => s && s.id === id);
  const staked = (s) => { let n = 0; for (const v of s.bets.values()) n += v; return n; };
  const able = (s) => s && !s.left && !s.outUntil;

  // ------------------------------------------------------------------ places
  function sit(id, name, keep) {       // keep: { chips, outUntil } for a single-player table that carries over; a hub's starts fresh
    id = String(id); name = String(name || '').slice(0, 24);
    const at = seatOf(id);
    if (at >= 0) { const s = seats[at]; s.name = name; if (s.left) { s.left = false; changed(); } return { seat: at }; }
    const free = seats.indexOf(null);
    if (free < 0) { if (!watchers.some((w) => w.id === id)) { watchers.push({ id, name }); changed(); } return { watching: true }; }
    if (opts.wallet && opts.wallet.owns(id)) keep = opts.wallet.keep(id);       // (the casino's one wallet: wallet.js)
    const out = Math.max(outs.get(id) || 0, keep && +keep.outUntil || 0);
    const s = { id, name, chips: keep && Number.isFinite(+keep.chips) ? Math.max(0, Math.floor(+keep.chips)) : R.start, bets: new Map(), order: [], last: [], ready: false,
      net: 0, won: 0, played: false, outUntil: out > now() ? out : 0, left: false };
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
    if (phase === 'betting' || phase === 'idle' || !s.bets.size) { s.chips += staked(s); free(at); }       // bets not spun yet come back
    else { s.left = true; changed(); }       // the ball's going round: they settle, and the place goes after
    if (phase === 'betting' && seats.some(Boolean) && !seats.some((x) => x && x.bets.size)) deadline = 0;
  }
  function free(at) {
    seats[at] = null;
    const w = watchers.shift();
    if (w) sit(w.id, w.name);
    if (!seats.some(Boolean)) { phase = 'idle'; deadline = 0; }
    changed();
  }

  // ------------------------------------------------------------------ betting
  function place(s, key, amount) {
    if (!BETS.has(key)) return { error: 'That isn\'t a bet' };
    amount = Math.floor(+amount);
    if (!(amount >= R.min)) return { error: `Bets start at ${R.min}` };
    if ((s.bets.get(key) || 0) + amount > R.spot) return { error: `At most ${R.spot} on one bet` };
    if (amount > s.chips) return { error: 'Not enough chips' };
    s.chips -= amount; s.bets.set(key, (s.bets.get(key) || 0) + amount); s.order.push([key, amount]);
    return { ok: true };
  }
  function move(id, m) {
    m = m && typeof m === 'object' ? m : {};
    const s = seats[seatOf(String(id))];
    if (!s) return { error: 'Sit down first' };
    if (phase !== 'betting') return { error: 'No more bets' };
    if (s.outUntil) return { error: 'Out of chips for a moment' };
    if (s.left) return { error: 'Sit back down first' };
    const what = String(m.do || '');
    let r = { ok: true };
    if (what === 'bet') r = place(s, String(m.key || ''), m.amount);
    else if (what === 'undo') { const b = s.order.pop(); if (!b) return { error: 'No bets to take back' }; s.chips += b[1]; const v = s.bets.get(b[0]) - b[1]; if (v > 0) s.bets.set(b[0], v); else s.bets.delete(b[0]); }
    else if (what === 'clear') { if (!s.bets.size) return { error: 'No bets to take back' }; s.chips += staked(s); s.bets.clear(); s.order = []; }
    else if (what === 'again') {       // last spin's bets, all of them, if they're affordable
      if (!s.last.length) return { error: 'No bets from the last spin' };
      const need = s.last.reduce((n, [, v]) => n + v, 0);
      if (need > s.chips) return { error: 'Not enough chips for last spin\'s bets' };
      for (const [k, v] of s.last) { const x = place(s, k, v); if (x.error) return x; }
    } else if (what === 'spin') { s.ready = !s.ready; changed(); return { ok: true }; }       // done betting (or not betting this spin): the ball goes when everyone is
    else return { error: 'Not a move' };
    if (r.error) return r;
    s.ready = false;
    if (!deadline && seats.some((x) => x && x.bets.size)) deadline = now() + T.bet;
    if (!seats.some((x) => x && x.bets.size)) deadline = 0;
    changed();
    return { ok: true };
  }
  function spin() {
    round++; number = rand(37); phase = 'spinning'; deadline = now() + T.spin;
    for (const s of seats) if (s) { s.played = s.bets.size > 0; s.ready = false; }
    changed();
  }
  function land() {
    const list = [];
    for (const s of seats) {
      if (!s || !s.played) continue;
      let won = 0, stake = 0;
      for (const [k, v] of s.bets) { stake += v; if (BETS.get(k).includes(number)) won += v * (pays(k) + 1); }
      s.chips += won; s.won = won; s.net = won - stake; s.last = [...s.bets];
      list.push({ id: s.id, name: s.name, net: s.net, score: s.net });
    }
    history.unshift(number); history = history.slice(0, 12);
    phase = 'done'; deadline = now() + T.done;
    changed();
    if (opts.onSettle) try { opts.onSettle(list); } catch { /* theirs to get right */ }
  }
  function nextRound() {
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i]; if (!s) continue;
      if (s.left) { free(i); continue; }
      s.bets.clear(); s.order = []; s.ready = false; s.played = false; s.net = 0; s.won = 0;
      if (s.chips < R.min && !s.outUntil) { s.outUntil = now() + T.out; outs.set(s.id, s.outUntil); s.chips = 0; }       // crapped out
    }
    number = null;
    phase = seats.some(Boolean) ? 'betting' : 'idle'; deadline = 0;
    changed();
  }

  // ------------------------------------------------------------------ time
  function tick() {
    const t = now(), v0 = version;
    for (const s of seats) if (s && s.outUntil && t >= s.outUntil) { s.outUntil = 0; s.chips = R.back; outs.delete(s.id); changed(); }       // back in with fresh chips
    for (const [id, until] of outs) if (t >= until) outs.delete(id);
    if (phase === 'betting') {
      const bets = seats.some((s) => s && s.bets.size), everyone = seats.filter(able).every((s) => s.ready);
      if (bets && (everyone || (deadline && t >= deadline))) spin();
    } else if (deadline && t >= deadline) {
      if (phase === 'spinning') land();
      else if (phase === 'done') nextRound();
    }
    return version !== v0;
  }

  // ------------------------------------------------------------------ what someone sees
  function view(id) {
    const t = now(), me = seatOf(String(id));
    return {
      phase, round, min: R.min, spot: R.spot, start: R.start, back: R.back, spinMs: T.spin,
      msLeft: deadline ? Math.max(0, deadline - t) : 0,
      number: phase === 'done' ? number : null,       // (never before the ball lands)
      history: history.slice(),
      you: me, watching: watchers.findIndex((w) => w.id === String(id)), watchers: watchers.length,
      seats: seats.map((s) => s && {
        id: s.id, name: s.name, chips: s.chips, bets: [...s.bets], staked: staked(s), ready: s.ready, left: s.left,
        net: phase === 'done' ? s.net : 0, won: phase === 'done' ? s.won : 0, played: s.played, again: s.last.length > 0,
        outMs: s.outUntil ? Math.max(0, s.outUntil - t) : 0,
      }),
    };
  }
  // What to keep for a single-player table between runs: the chips, with bets not settled yet given back
  function mine(id) {
    const s = seats[seatOf(String(id))]; if (!s) return null;
    return { chips: s.chips + (phase === 'done' ? 0 : staked(s)), outUntil: s.outUntil };
  }

  return {
    sit, leave, move, tick, view, mine,
    get version() { return version; }, get phase() { return phase; },
    seated: () => seats.filter(Boolean).map((s) => s.id),
  };
}

module.exports = { createTable, BETS, WHEEL, REDS, pays, RULES, TIMES };
