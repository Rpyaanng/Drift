// Drift — one wallet across the casino tables (Blackjack, Roulette, Hold'em, Pachinko, the crane machine): chips won at one are played at
// another. Pure: no Electron, no timers. Whoever runs the tables makes one (main.js for this PC alone, kept in the settings;
// hub.js for a hub, kept while the hub runs) and hands it to each table as opts.wallet.
//
//   const w = createWallet({ start: 1000, owns: (id) => ..., load: (id) => ({ chips, outUntil }), onChange: (id) => ... })
//
// A table seats someone as it always has, then calls w.bind(seat): from then on the seat's `chips` and `outUntil` read and
// write the wallet's, so the rules don't change at all (s.chips -= bet). Crapping out is the wallet's too: out of chips at one
// table is out at all of them for the wait, and back in with fresh chips at all of them. Computer players aren't the
// wallet's (owns says no): their chips stay their own.
function createWallet(opts = {}) {
  const start = opts.start || 1000;
  const owns = opts.owns || (() => true);
  const all = new Map();       // id -> { chips, outUntil }
  let rev = 0;
  const clean = (q) => ({ chips: Math.max(0, Math.floor(+(q && q.chips)) || 0), outUntil: Math.max(0, +(q && q.outUntil) || 0) });
  function get(id) {
    id = String(id);
    let w = all.get(id);
    if (!w) {
      const q = opts.load ? opts.load(id) : null;
      w = q ? clean(q) : { chips: start, outUntil: 0 };
      all.set(id, w);
    }
    return w;
  }
  const changed = (id) => { rev++; if (opts.onChange) try { opts.onChange(id); } catch { /* theirs to get right */ } };
  function bind(s) {
    if (!s || !owns(s.id)) return false;
    const w = get(s.id), id = s.id;
    // the seat as the table made it is the truth once: a table that refilled a short wallet, or started a wait, says so
    if (s.chips !== w.chips || s.outUntil !== w.outUntil) { w.chips = Math.max(0, Math.floor(+s.chips) || 0); w.outUntil = +s.outUntil || 0; changed(id); }
    Object.defineProperty(s, 'chips', { configurable: true, enumerable: true, get: () => w.chips, set: (v) => { v = Math.max(0, Math.floor(+v) || 0); if (v !== w.chips) { w.chips = v; changed(id); } } });
    Object.defineProperty(s, 'outUntil', { configurable: true, enumerable: true, get: () => w.outUntil, set: (v) => { v = +v || 0; if (v !== w.outUntil) { w.outUntil = v; changed(id); } } });
    return true;
  }
  // What a table seats someone with: the wallet's chips and wait (for sit's `keep`), or null for someone it isn't theirs
  const keep = (id) => (owns(String(id)) ? { ...get(id) } : null);
  return {
    bind, keep, owns: (id) => owns(String(id)),
    peek: (id) => ({ ...get(id) }),
    set(id, q) { const w = get(id), c = clean(q); if (c.chips !== w.chips || c.outUntil !== w.outUntil) { Object.assign(w, c); changed(String(id)); } },
    get rev() { return rev; },
  };
}

module.exports = { createWallet };
