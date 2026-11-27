/* Drift — numbers that roll up, for the card tables' winnings (blackjack.js, roulette.js, poker.js): a chip count counting
   up to its new total when chips come in, and a "+250" or "You win 250" counting up from nothing, like a game show's
   tally. The tables redraw their seats from scratch at every view, so what's rolling is kept here by a name (key), not by
   element: each draw asks for a fresh element, and it carries on from where the number had got to.
     driftRoll.num(key, value, show, { cls, from0 })   an element showing show(n), n rolling to value when it rises
     driftRoll.line(cls, ...parts)                     an element of text and such numbers, e.g. a bar's "You win 250!"
   A number going down (a bet put out) just changes. In a hidden window (Drift's tests) the end is shown at once. */
(() => {
  const reg = new Map();       // key -> { from, to, start, dur, show, seen }
  const ease = (x) => 1 - Math.pow(1 - x, 3);       // quick, then slowing into the total
  const at = (r, t) => (r.dur ? Math.round(r.from + (r.to - r.from) * ease(Math.min(1, (t - r.start) / r.dur))) : r.to);
  const rolling = (r, t) => r.dur > 0 && t - r.start < r.dur;
  let timer = 0;
  function run() {       // ~30 times a second while anything rolls (a timer, not animation frames: it keeps time in the background too)
    if (timer) return;
    timer = setInterval(() => {
      const t = performance.now();
      let any = false;
      for (const e of document.querySelectorAll('[data-roll]')) {
        const r = reg.get(e.dataset.roll); if (!r) continue;
        const on = rolling(r, t); any = any || on;
        const text = r.show(at(r, t)); if (e.textContent !== text) e.textContent = text;
        e.classList.toggle('rolling', on);
      }
      if (!any && ![...reg.values()].some((r) => rolling(r, t))) { clearInterval(timer); timer = 0; }
    }, 33);
  }
  function num(key, value, show, { cls = '', from0 = false } = {}) {
    const t = performance.now(), hidden = document.hidden;
    value = Math.round(+value || 0);
    let r = reg.get(key);
    if (!r) { const start = from0 ? 0 : value; r = { from: start, to: start, start: t, dur: 0 }; reg.set(key, r); }       // (first seen: as it is, or from nothing)
    if (value !== r.to) {
      const now = at(r, t);
      if (value > now && !hidden) Object.assign(r, { from: now, to: value, start: t, dur: Math.min(1700, 650 + 260 * Math.log10(1 + value - now)) });
      else Object.assign(r, { from: value, to: value, dur: 0 });
    }
    r.show = show; r.seen = t;
    const e = document.createElement('span');
    if (cls) e.className = cls;
    e.dataset.roll = key; e.textContent = show(at(r, t));
    if (rolling(r, t)) { e.classList.add('rolling'); run(); }
    if (reg.size > 300) for (const [k, x] of reg) if (t - x.seen > 120000) reg.delete(k);       // (old rounds' badges)
    return e;
  }
  function line(cls, ...parts) {
    const e = document.createElement('span'); e.className = cls;
    e.append(...parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : p)));
    return e;
  }
  window.driftRoll = { num, line };
})();
