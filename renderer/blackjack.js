/* Drift — the Blackjack scene's table (docs/plans/blackjack.md §2). It only draws: the rules are in blackjack.js, played in
   main.js alone or on the hub with friends, and what it gets is the table as you see it (view). Your moves go back through
   send({ op, ... }), which app.js passes on.
     const t = window.driftBJ(holder, send, { face })   t.view(v, mode)   t.note(text)   t.colors({ colorOf, self, vars })   t.box()
   Names come from the hub, so everything a person types is put in with textContent, never as markup. */
(() => {
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const RANK = { T: '10' };
  const CHIPS = [10, 25, 100, 500];
  // Where each seat's name tag sits (its cards grow up from it), in % of the felt: on a curve just inside the table's edge (the
  // felt's lower half is an ellipse round its top middle, half as wide as it and as tall), left to right as you look at it
  const SEAT_AT = [0, 1, 2, 3, 4, 5].map((i) => {
    const a = Math.PI * (0.8 - 0.12 * i);
    return [50 + 43 * Math.cos(a), 86 * Math.sin(a)];
  });
  // Seated, you're drawn in the middle: the same curve cut into seven places so there is one, yours the fourth. The seats after
  // yours go to your right and the ones before it to your left, as poker turns its table, and the far right place stays bare.
  const MID_AT = [0, 1, 2, 3, 4, 5, 6].map((i) => {
    const a = Math.PI * (0.8 - 0.1 * i);
    return [50 + 43 * Math.cos(a), 86 * Math.sin(a)];
  });
  const placeOf = (i, you) => {
    if (you < 0) return SEAT_AT[i];
    const d = (i - you + 6) % 6;
    return MID_AT[d === 0 ? 3 : d <= 2 ? 3 + d : d - 3];
  };
  const RESULT = { win: 'Win', blackjack: 'Blackjack', push: 'Push', lose: 'Lose', bust: 'Bust', surrender: 'Surrendered' };
  const ACT = [['hit', 'Hit'], ['stand', 'Stand'], ['double', 'Double'], ['split', 'Split'], ['surrender', 'Surrender']];
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const fmt = (n) => Math.round(n).toLocaleString();
  const roll = window.driftRoll;       // (roll.js: chip counts and winnings counting up)

  // ---------- the house's look: Drift's mark, and what's printed on the felt ----------
  // Drift's mark: the two waves of its icon (icon.svg, the same four shapes), flat: the teal one in the accent, the lilac one in
  // the palette's lightest colour, each with its lower half a shade dimmer, as the icon has them
  const WAVES = [
    'M16.0 293.2 C26.0 284.3 56.0 256.6 76.0 240.1 C96.0 223.7 116.0 206.2 136.0 194.6 C156.0 183.1 176.0 173.2 196.0 170.9 C216.0 168.5 236.0 173.1 256.0 180.7 C276.0 188.3 296.0 204.8 316.0 216.4 C336.0 228.0 356.0 244.7 376.0 250.4 C396.0 256.2 416.0 257.2 436.0 251.0 C456.0 244.9 486.0 219.7 496.0 213.4 C486.0 220.4 456.0 246.5 436.0 255.4 C416.0 264.3 396.0 268.6 376.0 266.9 C356.0 265.1 336.0 254.3 316.0 245.0 C296.0 235.7 276.0 219.5 256.0 210.9 C236.0 202.3 216.0 194.0 196.0 193.5 C176.0 193.0 156.0 199.2 136.0 207.7 C116.0 216.2 96.0 230.4 76.0 244.7 C56.0 258.9 26.0 285.1 16.0 293.2 Z',
    'M16.0 293.2 C26.0 285.1 56.0 258.9 76.0 244.7 C96.0 230.4 116.0 216.2 136.0 207.7 C156.0 199.2 176.0 193.0 196.0 193.5 C216.0 194.0 236.0 202.3 256.0 210.9 C276.0 219.5 296.0 235.7 316.0 245.0 C336.0 254.3 356.0 265.1 376.0 266.9 C396.0 268.6 416.0 264.3 436.0 255.4 C456.0 246.5 486.0 220.4 496.0 213.4 C486.0 221.5 456.0 250.2 436.0 261.7 C416.0 273.2 396.0 280.6 376.0 282.5 C356.0 284.4 336.0 279.8 316.0 273.0 C296.0 266.3 276.0 251.4 256.0 242.1 C236.0 232.8 216.0 220.6 196.0 217.2 C176.0 213.8 156.0 215.7 136.0 221.5 C116.0 227.4 96.0 240.5 76.0 252.4 C56.0 264.3 26.0 286.4 16.0 293.2 Z',
    'M16.0 340.5 C25.2 332.2 52.6 305.5 70.9 290.6 C89.2 275.6 107.5 259.5 125.9 250.9 C144.2 242.3 162.5 238.0 180.8 238.9 C199.1 239.9 217.4 248.6 235.7 256.7 C254.0 264.7 272.3 279.0 290.6 287.4 C309.0 295.8 327.3 304.9 345.6 306.9 C363.9 308.9 382.2 305.4 400.5 299.5 C418.8 293.6 446.3 276.2 455.4 271.5 C446.3 277.1 418.8 296.4 400.5 304.8 C382.2 313.3 363.9 320.8 345.6 322.3 C327.3 323.7 309.0 319.5 290.6 313.4 C272.3 307.3 254.0 294.1 235.7 285.7 C217.4 277.2 199.1 266.1 180.8 262.7 C162.5 259.4 144.2 260.1 125.9 265.5 C107.5 271.0 89.2 283.0 70.9 295.5 C52.6 308.0 25.2 333.0 16.0 340.5 Z',
    'M16.0 340.5 C25.2 333.0 52.6 308.0 70.9 295.5 C89.2 283.0 107.5 271.0 125.9 265.5 C144.2 260.1 162.5 259.4 180.8 262.7 C199.1 266.1 217.4 277.2 235.7 285.7 C254.0 294.1 272.3 307.3 290.6 313.4 C309.0 319.5 327.3 323.7 345.6 322.3 C363.9 320.8 382.2 313.3 400.5 304.8 C418.8 296.4 446.3 277.1 455.4 271.5 C446.3 278.2 418.8 300.6 400.5 311.4 C382.2 322.2 363.9 332.0 345.6 336.5 C327.3 341.1 309.0 342.1 290.6 338.7 C272.3 335.4 254.0 324.8 235.7 316.5 C217.4 308.2 199.1 294.9 180.8 289.1 C162.5 283.3 144.2 279.4 125.9 281.8 C107.5 284.2 89.2 293.8 70.9 303.6 C52.6 313.4 25.2 334.4 16.0 340.5 Z',
  ];
  const MARK_BODY = `<path class="w1" d="${WAVES[0]}"/><path class="w1 lo" d="${WAVES[1]}"/><path class="w2" d="${WAVES[2]}"/><path class="w2 lo" d="${WAVES[3]}"/>`;
  const MARK_BOX = '10 160 492 190';       // (where the waves are in the icon)
  const MARK = `<svg class="bjMark" viewBox="${MARK_BOX}" aria-hidden="true">${MARK_BODY}</svg>`;
  window.driftMark = MARK;       // (the other tables' card backs and felts wear it too: renderer/poker.js, renderer/roulette.js)
  // The felt's printing, drawn on a 200 x 100 box (the felt is twice as wide as it's tall): its lower half is a circle round
  // the top middle, radius 100, so every curve here is a part of a circle round (100, 0), the way a real layout follows the
  // table's edge. From the dealer outwards: the mark and the name, "Blackjack pays 3 to 2", the dealer's rule, and the
  // insurance band. The seats' cards start past it (the middle two seats' only just: it ends at 50.3, their cards begin near 52).
  const at = (r, deg) => `${(100 + r * Math.cos(deg * Math.PI / 180)).toFixed(2)} ${(r * Math.sin(deg * Math.PI / 180)).toFixed(2)}`;
  const arc = (r, a1, a2) => `M${at(r, a1)} A${r} ${r} 0 0 0 ${at(r, a2)}`;       // left to right along the bottom, so text on it reads upright
  const band = (r1, r2, a1, a2) => `M${at(r2, a1)} A${r2} ${r2} 0 0 0 ${at(r2, a2)} L${at(r1, a2)} A${r1} ${r1} 0 0 1 ${at(r1, a1)} Z`;
  const ART = `<svg class="bjArt" viewBox="0 0 200 100" aria-hidden="true">
    <defs><path id="bjArc1" d="${arc(37.4, 150, 30)}"/><path id="bjArc2" d="${arc(41, 146, 34)}"/><path id="bjArc3" d="${arc(48.4, 125, 55)}"/></defs>
    <g class="brand"><svg x="84" y="6" width="32" height="12.36" viewBox="${MARK_BOX}">${MARK_BODY}</svg><text x="100" y="23.2" class="word">DRIFT</text></g>
    <path class="band" d="${band(44.5, 50.3, 125, 55)}"/>
    <text class="t1"><textPath href="#bjArc1" startOffset="50%">BLACKJACK PAYS 3 TO 2</textPath></text>
    <text class="t2"><textPath href="#bjArc2" startOffset="50%">DEALER MUST DRAW TO 16 AND STAND ON ALL 17s</textPath></text>
    <text class="t3"><textPath href="#bjArc3" startOffset="50%">INSURANCE PAYS 2 TO 1</textPath></text>
  </svg>`;

  // opts.face(id): a hub member's picture for their seat (null alone)
  window.driftBJ = (holder, send, opts = {}) => {
    holder.innerHTML = '';
    const lampEl = el('div', 'bjLamp'), felt = el('div', 'bjFelt'), status = el('div', 'bjStatus'), bar = el('div', 'bjBar'), noteEl = el('div', 'bjNote'), boardEl = el('div', 'bjBoard');
    holder.append(lampEl, felt, bar, noteEl, boardEl);
    felt.insertAdjacentHTML('beforeend', ART);       // (fixed markup: nothing in it comes from anyone)
    felt.append(el('div', 'bjRail'));
    // the dealer's side, along the straight edge: the discard holder (filling as the shoe empties), the chip rack, the
    // dealer's cards, the table's sign (whose table, and its limits), and the shoe
    const discard = el('div', 'bjDiscard'); discard.append(el('i'));
    const tray = el('div', 'bjTray');
    for (const c of [500, 500, 100, 100, 25, 25, 10, 10]) tray.append(el('i', 't' + c));
    const sign = el('div', 'bjSign'), limits = el('div', 'bjLimits');
    sign.append(el('div', 'bjMode'), limits);
    const dealerEl = el('div', 'bjDealer'), dCards = el('div', 'bjCards'), dTotal = el('div', 'bjTotal');
    dealerEl.append(dCards, dTotal);
    const shoe = el('div', 'bjShoe'); shoe.append(el('i'), el('b'));
    felt.append(discard, tray, sign, dealerEl, shoe, status);
    const seatEls = SEAT_AT.map(([x, y], i) => {
      const s = el('div', 'bjSeat empty'); s.style.left = x + '%'; s.style.top = y + '%'; s.dataset.i = i;
      s.append(el('div', 'bjSpot'), el('div', 'bjHands'), el('div', 'bjStake'), el('div', 'bjTag'));
      felt.append(s);
      return s;
    });
    let v = null, mode = '', got = 0, stake = 0, lastBet = 0, seen = new Set(), noteTimer = 0, flashTimer = 0, lastRound = -1, shownRound = -1;
    let colorOf = (name) => '#9fe3c8', selfColor = '#22c08a';

    // ---------- cards ----------
    function card(c, key, delay) {
      const d = el('div', 'bjCard' + (c ? (c[1] === 'h' || c[1] === 'd' ? ' red' : '') : ' back'));
      if (c) {
        const r = RANK[c[0]] || c[0], s = SUIT[c[1]];
        const tl = el('span', 'cTl'); tl.append(el('b', '', r), el('i', '', s));
        const br = el('span', 'cBr'); br.append(el('b', '', r), el('i', '', s));
        d.append(tl, el('span', 'cMid', s), br);
      } else d.innerHTML = MARK;       // the back: Drift's mark in a frame
      if (key && !seen.has(key)) { seen.add(key); d.classList.add('deal'); d.style.animationDelay = (delay || 0) + 'ms'; }
      return d;
    }
    function cards(box, list, keyBase) {
      box.replaceChildren(...list.map((c, i) => card(c, `${keyBase}:${i}:${c || 'x'}`, i < 2 ? i * 90 : 0)));
    }
    const left = () => (v ? Math.max(0, v.msLeft - (Date.now() - got)) : 0);
    const secs = () => Math.ceil(left() / 1000);

    // ---------- the table ----------
    function draw() {
      if (!v) { holder.classList.remove('live'); return; }
      holder.classList.add('live');
      if (v.round !== lastRound) { lastRound = v.round; seen = new Set([...seen].filter((k) => k.startsWith(v.round + ':'))); }
      felt.querySelector('.bjMode').textContent = mode === 'hub' ? 'Hub table' : 'Just you';
      limits.textContent = `Min ${fmt(v.min)} · No limit`;
      discard.firstChild.style.height = Math.round(100 * (1 - v.shoe.left / v.shoe.size)) + '%';
      cards(dCards, v.dealer.cards, `${v.round}:d`);
      dTotal.textContent = v.dealer.cards.length ? (v.dealer.cards.includes(null) ? `Showing ${v.dealer.total}` : (v.dealer.soft && v.dealer.total < 21 ? `Soft ${v.dealer.total}` : String(v.dealer.total))) : '';
      dTotal.classList.toggle('bust', v.dealer.total > 21);
      shoe.lastChild.textContent = '';
      shoe.firstChild.style.height = Math.round(30 + 70 * (v.shoe.left / v.shoe.size)) + '%';
      v.seats.forEach((s, i) => seat(seatEls[i], s, i));
      board();
      holder.classList.toggle('myTurn', !!(v.turn && v.turn.seat === v.you));
      controls();
      tickTimers();
      if (v.phase === 'done' && shownRound !== v.round) { shownRound = v.round; flash(); }
    }
    function seat(box, s, i) {
      const [spot, hands, stakeEl, tag] = box.children, [x, y] = placeOf(i, v.you);
      box.style.left = x + '%'; box.style.top = y + '%';
      box.className = 'bjSeat' + (s ? '' : ' empty') + (s && i === v.you ? ' me' : '') + (v.turn && v.turn.seat === i ? ' turn' : '') + (s && s.outMs ? ' out' : '') + (s && s.left ? ' gone' : '');
      if (!s) { hands.replaceChildren(); stakeEl.replaceChildren(); tag.replaceChildren(); box.style.removeProperty('--c'); return; }
      box.style.setProperty('--c', i === v.you ? selfColor : colorOf(s.name));
      hands.replaceChildren(...s.hands.map((h, k) => {
        const hd = el('div', 'bjHand' + (v.turn && v.turn.seat === i && v.turn.hand === k ? ' now' : '') + (h.result ? ' r-' + h.result : ''));
        const cs = el('div', 'bjCards'); cards(cs, h.cards, `${v.round}:${i}:${k}`);
        const tot = el('div', 'bjTotal', h.soft && h.n < 21 ? `Soft ${h.n}` : String(h.n));
        if (h.n > 21) tot.classList.add('bust');
        hd.append(cs, tot);
        if (h.result) hd.append(el('div', 'bjResult', RESULT[h.result] || ''));
        if (s.hands.length > 1 || h.doubled) hd.append(el('div', 'bjHandBet', fmt(h.bet)));
        return hd;
      }));
      const bet = s.hands.length ? s.hands.reduce((n, h) => n + h.bet, 0) : s.bet;
      stakeEl.replaceChildren(chipStack(bet), ...(s.insurance ? [el('span', 'bjIns', `Insured ${fmt(s.insurance)}`)] : []));       // (the betting circle, empty till a bet's in it)
      const nm = el('span', 'nm', i === v.you ? 'You' : s.name), ch = s.outMs ? el('span', 'ch', 'Out of chips') : roll.num('bj:ch:' + s.id, s.chips, fmt, { cls: 'ch' });
      const ring = el('i', 'bjRing');       // their turn's (or their wait's) time, filling round; at a hub, round their picture
      const f = mode === 'hub' && !s.blocked && opts.face ? opts.face(s.id) : null;
      if (f) { ring.classList.add('av'); ring.append(f); }
      tag.replaceChildren(ring, nm, ch);
    }
    // The hub's biggest pots (hub.js bjBoard): the five best single rounds, one each, kept by the hub. A hub's table only.
    function board() {
      const list = mode === 'hub' && Array.isArray(v.board) ? v.board : null;
      boardEl.classList.toggle('on', !!list);
      if (!list) return;
      const me = opts.me ? opts.me() : '';
      const rows = list.map((x, i) => {
        const row = el('div', 'bjBRow' + (x.id === me ? ' me' : '') + (x.ago < 8000 ? ' fresh' : ''));       // (fresh: just set, it lights up)
        const f = !x.blocked && opts.face ? opts.face(x.id) : null;
        row.append(el('b', 'rk', String(i + 1)), f || el('i', 'nf'), el('span', 'nm', x.id === me ? 'You' : x.name), ...(x.bj ? [el('em', 'bjB', 'BJ')] : []), el('span', 'amt', '+' + fmt(x.win)));
        return row;
      });
      boardEl.replaceChildren(el('div', 'bjBHead', 'Biggest pots'), ...(rows.length ? rows : [el('div', 'bjBNone', 'None yet. Win a hand to get on the board.')]));
    }
    function chipStack(n) {       // a seat's betting circle: the bet in it as a few chips stacked, biggest at the bottom, and the amount
      const st = el('div', 'bjChips' + (n ? '' : ' empty')); let left = n, k = 0;
      for (const c of [...CHIPS].reverse()) while (left >= c && k < 6) { const x = el('i', 'chip c' + c); x.style.setProperty('--k', k++); st.append(x); left -= c; }
      if (n) st.append(el('b', '', fmt(n)));
      return st;
    }

    // ---------- what you can do ----------
    function controls() {
      const me = v.you >= 0 ? v.seats[v.you] : null, kids = [];
      const btn = (label, cls, fn) => { const b = el('button', 'bjBtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.onclick = fn; return b; };
      let line = '';
      if (!me && v.watching >= 0) {       // the table is full: in line for the next seat
        line = `The table is full. You're next for a seat${v.watching ? ` (${v.watching + 1} in line)` : ''}.`;
        kids.push(btn('Leave the line', 'ghost', () => send({ op: 'stand' })));
      } else if (!me) {       // stood up: looking on
        line = v.seats.every(Boolean) ? 'You\'re standing. The table is full.' : 'You\'re standing, watching the table.';
        kids.push(btn(v.seats.every(Boolean) ? 'Get in line' : 'Sit down', 'primary', () => send({ op: 'sit' })));
      } else if (me.left) {       // stood up in the middle of a hand: the seat stays till it's settled
        line = 'You\'ve stood up. Your hand still settles.';
        kids.push(btn('Sit back down', 'primary', () => send({ op: 'sit' })));
      } else if (me.outMs) { line = `Out of chips. Back in with ${fmt(v.start)} in `; kids.push(el('b', 'bjCount out', String(Math.ceil(me.outMs / 1000)))); }
      else if (v.phase === 'betting' && !me.bet) {
        stake = Math.min(stake, me.chips);
        for (const c of CHIPS) {
          const b = el('button', 'chip c' + c, String(c)); b.type = 'button'; b.title = `Add ${c}`;
          b.disabled = stake + c > me.chips;
          b.onclick = () => { stake += c; send({ op: 'tap' }); controls(); };
          kids.push(b);
        }
        const all = el('button', 'bjBtn ghost', 'All in'); all.type = 'button'; all.title = `Bet all ${fmt(me.chips)}`;       // (no top limit, so a big stack needn't be clicked in 500 at a time)
        all.disabled = stake === me.chips || me.chips < v.min; all.onclick = () => { stake = me.chips; send({ op: 'tap' }); controls(); };
        kids.push(all);
        const amt = el('span', 'bjAmt', stake ? fmt(stake) : 'Pick your bet');
        const clear = el('button', 'bjBtn ghost', 'Clear'); clear.type = 'button'; clear.disabled = !stake; clear.onclick = () => { stake = 0; controls(); };
        const go = el('button', 'bjBtn primary', stake ? `Bet ${fmt(stake)}` : lastBet && lastBet <= me.chips ? `Bet ${fmt(lastBet)} again` : 'Bet'); go.type = 'button';
        go.disabled = !(stake >= v.min) && !(lastBet && lastBet <= me.chips);
        go.onclick = () => { const n = stake >= v.min ? stake : lastBet; lastBet = n; stake = 0; send({ op: 'bet', amount: n }); };
        kids.push(amt, clear, go);
        if (stake && stake < v.min) amt.textContent = `${fmt(stake)} (at least ${v.min})`;
      } else if (v.phase === 'betting') line = 'Waiting for the others to bet';
      else if (v.phase === 'insurance' && me.insure) {
        line = `The dealer shows an ace. Insurance costs ${fmt(me.insure)}.`;
        const y = el('button', 'bjBtn primary', 'Insure'); y.type = 'button'; y.disabled = me.insure > me.chips; y.onclick = () => send({ op: 'insure', yes: true });
        const n = el('button', 'bjBtn', 'No thanks'); n.type = 'button'; n.onclick = () => send({ op: 'insure', yes: false });
        kids.push(y, n);
      } else if (me.can.length) {
        for (const [id, name] of ACT) if (me.can.includes(id)) { const b = el('button', 'bjBtn' + (id === 'hit' || id === 'stand' ? ' primary' : ''), name); b.type = 'button'; b.dataset.do = id; b.onclick = () => send({ op: 'act', do: id }); kids.push(b); }
      } else if (v.phase === 'done') line = summary(me);
      else if (!me.hands.length && v.phase !== 'idle') line = 'Sitting this hand out. Bet on the next one.';
      else if (v.phase === 'insurance') line = 'Waiting for the others to decide on insurance';
      else if (v.phase === 'turns' && v.turn) line = `Waiting for ${(v.seats[v.turn.seat] || {}).name || 'the others'}`;
      else if (v.phase === 'dealer') line = 'The dealer plays';
      // Stand up: whenever you've no hand still to play (a bet not dealt yet comes back; a hand that's played out still settles)
      if (me && !me.left && !me.hands.some((h) => !h.done) && !(v.phase === 'insurance' && me.insure)) kids.push(btn('Stand up', 'ghost', () => { stake = 0; send({ op: 'stand' }); }));
      bar.replaceChildren(...(line ? [typeof line === 'string' ? el('span', 'bjLine', line) : line] : []), ...kids);       // (a win's line comes with its number rolling)
      bar.dataset.phase = v.phase;
      status.replaceChildren(...statusLine());
    }
    function summary(me) {
      if (!me.hands.length) return 'Next hand in a moment';
      const n = me.net;
      const won = () => roll.num(`bj:won:${v.round}`, n, fmt, { cls: 'bjWon', from0: true });       // (counting up from nothing)
      if (me.hands.some((h) => h.result === 'blackjack')) return roll.line('bjLine', 'Blackjack! +', won());
      return n > 0 ? roll.line('bjLine', 'You win ', won()) : n < 0 ? `You lose ${fmt(-n)}` : 'Push: your bet comes back';
    }
    function statusLine() {
      const out = [];
      const turnName = v.turn ? (v.turn.seat === v.you ? 'Your turn' : `${(v.seats[v.turn.seat] || {}).name || 'Someone'}'s turn`) : '';
      const text = { idle: 'Take a seat', betting: 'Place your bets', insurance: 'Insurance?', turns: turnName, dealer: 'Dealer draws', done: v.last && v.last.blackjack ? 'Dealer has blackjack' : v.dealer.total > 21 ? 'Dealer busts' : `Dealer has ${v.dealer.total}` }[v.phase] || '';
      out.push(el('span', '', text));
      if (v.msLeft && v.phase !== 'dealer' && v.phase !== 'done') out.push(el('b', 'bjCount', String(secs())));
      return out;
    }
    function tickTimers() {       // the countdowns, between views
      if (!v) return;
      const c = status.querySelector('.bjCount'); if (c) c.textContent = String(secs());
      const me = v.you >= 0 ? v.seats[v.you] : null;
      if (me && me.outMs) { const o = bar.querySelector('.bjCount.out'), ms = Math.max(0, me.outMs - (Date.now() - got)); if (o) o.textContent = String(Math.ceil(ms / 1000)); }
      const total = { turns: v.turnMs || 20000, insurance: 8000, betting: 10000 }[v.phase] || 0;
      v.seats.forEach((s, i) => {
        const r = seatEls[i].querySelector('.bjRing'); if (!r || !s) return;
        let f = 0;
        if (s.outMs) f = Math.max(0, s.outMs - (Date.now() - got)) / 20000;
        else if (v.turn && v.turn.seat === i && total) f = left() / total;
        r.style.setProperty('--f', Math.max(0, Math.min(1, f)).toFixed(3));
        r.classList.toggle('on', f > 0);
      });
    }
    setInterval(tickTimers, 100);
    function flash() {       // the lamp answers how your hand went
      const me = v.you >= 0 ? v.seats[v.you] : null; if (!me || !me.hands.length) return;
      const k = me.hands.some((h) => h.result === 'blackjack') ? 'fBj' : me.net > 0 ? 'fWin' : me.net < 0 ? 'fLose' : '';
      holder.classList.remove('fBj', 'fWin', 'fLose');
      if (!k) return;
      void holder.offsetWidth;       // (so the same one plays again)
      holder.classList.add(k);
      clearTimeout(flashTimer); flashTimer = setTimeout(() => holder.classList.remove(k), 2600);
    }

    return {
      view(nv, m) {
        if (nv && v && nv.round !== v.round) stake = 0;
        if (nv && nv.phase === 'turns' && v && (v.phase !== 'turns' || !v.turn || !nv.turn || v.turn.seat !== nv.turn.seat || v.turn.hand !== nv.turn.hand)) nv.turnMs = nv.msLeft;       // (a turn's whole length, for its ring)
        else if (nv && v && nv.phase === 'turns') nv.turnMs = v.turnMs;
        v = nv; mode = m || ''; got = Date.now(); draw();
      },
      note(text) {
        noteEl.textContent = text; noteEl.classList.add('on');
        clearTimeout(noteTimer); noteTimer = setTimeout(() => noteEl.classList.remove('on'), 3200);
      },
      colors(c) {       // the palette, as the room's light: app.js on every accent change
        colorOf = c.colorOf || colorOf; selfColor = c.self || selfColor;
        for (const [k, val] of Object.entries(c.vars || {})) holder.style.setProperty(k, val);
        if (v) draw();
      },
      box() { const r = felt.getBoundingClientRect(); return r.width ? { l: r.left, t: r.top, w: r.width, h: r.height } : null; },
      felt,
      state: () => v,
    };
  };
})();
