/* Drift — the Texas Hold'em scene's table (docs/plans/games-room.md §2.4). It only draws: the rules are in poker.js, played in
   main.js alone (against three computer players) or on the hub with friends, and what it gets is the table as you see it
   (view: your own two cards, everyone else's face down until a showdown). Your moves go back through send({ op, ... }),
   which app.js passes on.
     const t = window.driftPoker(holder, send, { face, me })   t.view(v, mode)   t.note(text)   t.colors({ colorOf, self, vars })   t.box()
   An oval table with six seats round it, turned so your seat is always at the bottom; the board and the pot in the middle.
   Names come from the hub, so everything a person types is put in with textContent, never as markup. */
(() => {
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const RANK = { T: '10' };
  // where each seat's tag sits, in % of the felt, counting round from the bottom middle (you, when you're sat)
  const AT = [[50, 97], [13, 83], [13, 17], [50, 3], [87, 17], [87, 83]];
  const BET_AT = [[50, 64], [27, 67], [27, 34], [50, 29], [73, 34], [73, 67]];       // and their bets, in front of them towards the middle
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const fmt = (n) => Math.round(n).toLocaleString();
  const roll = window.driftRoll;       // (roll.js: chip counts and winnings counting up)
  const MARK = window.driftMark || '';       // Drift's mark (renderer/blackjack.js): the card backs, and the felt's print

  window.driftPoker = (holder, send, opts = {}) => {
    holder.innerHTML = '';
    const lampEl = el('div', 'bjLamp'), felt = el('div', 'pkFelt'), bar = el('div', 'bjBar'), noteEl = el('div', 'bjNote'), boardEl = el('div', 'bjBoard');
    holder.append(lampEl, felt, bar, noteEl, boardEl);
    felt.append(el('div', 'pkRail'), el('div', 'pkLine'));
    const brand = el('div', 'pkBrand'); brand.innerHTML = MARK; brand.append(el('span', '', 'DRIFT HOLD’EM'));       // (fixed markup: nothing in it comes from anyone)
    const sign = el('div', 'bjSign pkSign'); sign.append(el('div', 'bjMode'), el('div', 'bjLimits'));
    const middle = el('div', 'pkMiddle'), boardCards = el('div', 'pkBoard'), potEl = el('div', 'pkPot'), status = el('div', 'bjStatus pkStatus');
    middle.append(status, boardCards, potEl);
    const btnChip = el('div', 'pkButton', 'D');
    felt.append(brand, sign, middle, btnChip);
    const seatEls = AT.map(() => {
      const s = el('div', 'pkSeat empty');
      s.append(el('div', 'pkCards'), el('div', 'pkAct'), el('div', 'bjTag'));
      const bet = el('div', 'pkBet');
      felt.append(s, bet);
      s.bet = bet;
      return s;
    });
    let v = null, mode = '', got = 0, noteTimer = 0, flashTimer = 0, shownHand = -1, seen = new Set(), raise = 0, raiseFor = '', colorOf = () => '#9fe3c8', selfColor = '#22c08a';
    const left = () => (v ? Math.max(0, v.msLeft - (Date.now() - got)) : 0);
    const secs = () => Math.ceil(left() / 1000);
    const me = () => (v && v.you >= 0 ? v.seats[v.you] : null);
    const spot = (i) => (v.you >= 0 ? (i - v.you + 6) % 6 : i);       // where seat i is drawn: yours at the bottom

    function card(c, key, delay) {
      const d = el('div', 'bjCard' + (c ? (c[1] === 'h' || c[1] === 'd' ? ' red' : '') : ' back'));
      if (c) {
        const r = RANK[c[0]] || c[0], s = SUIT[c[1]];
        const tl = el('span', 'cTl'); tl.append(el('b', '', r), el('i', '', s));
        d.append(tl, el('span', 'cMid', s));
      } else d.innerHTML = MARK;
      if (key && !seen.has(key)) { seen.add(key); d.classList.add('deal'); d.style.animationDelay = (delay || 0) + 'ms'; }
      return d;
    }
    const chipStack = (n) => {
      const st = el('div', 'bjChips pkChips'); let rest = n, k = 0;
      for (const c of [500, 100, 25, 10]) while (rest >= c && k < 5) { const x = el('i', 'chip c' + c); x.style.setProperty('--k', k++); st.append(x); rest -= c; }
      if (!k && n) { const x = el('i', 'chip c10'); x.style.setProperty('--k', 0); st.append(x); }
      st.append(el('b', '', fmt(n)));
      return st;
    };

    function draw() {
      if (!v) { holder.classList.remove('live'); return; }
      holder.classList.add('live');
      if (v.hand !== shownHand && v.phase === 'preflop') seen = new Set([...seen].filter((k) => k.startsWith(v.hand + ':')));
      sign.firstChild.textContent = mode === 'hub' ? 'Hub table' : 'Just you';
      sign.lastChild.textContent = `Blinds ${v.small} / ${v.big} · No limit`;
      boardCards.replaceChildren(...[0, 1, 2, 3, 4].map((k) => (v.board[k] ? card(v.board[k], `${v.hand}:b:${k}:${v.board[k]}`, k < 3 ? k * 90 : 0) : el('div', 'pkSlot'))));
      const winners = new Set((v.pots || []).flatMap((p) => p.winners));
      potEl.replaceChildren(...potLine());
      v.seats.forEach((s, i) => seat(seatEls[spot(i)], s, i, winners));
      const b = v.button >= 0 && v.seats[v.button] ? BET_AT[spot(v.button)] : null;       // the dealer's button, beside that seat's bet
      btnChip.classList.toggle('on', !!b && v.phase !== 'waiting' && v.phase !== 'idle');
      if (b) Object.assign(btnChip.style, { left: (b[0] - 4) + '%', top: b[1] + '%' });
      board();
      holder.classList.toggle('myTurn', !!(v.can));
      controls();
      tickTimers();
      if (v.phase === 'showdown' && shownHand !== v.hand) { shownHand = v.hand; flash(); }
    }
    function potLine() {
      if (v.pots && v.phase === 'showdown') {
        return v.pots.filter((p) => !p.uncalled).map((p, k) => {
          const names = p.winners.map((i) => (i === v.you ? 'You' : (v.seats[i] || {}).name || 'Someone'));
          return el('div', 'pkPotWin', `${k ? 'Side pot' : v.pots.length > 1 ? 'Main pot' : 'Pot'} ${fmt(p.amount)} · ${names.join(' & ')}${p.hand ? ' · ' + p.hand : ''}`);
        });
      }
      return v.pot ? [el('b', '', `Pot ${fmt(v.pot)}`)] : [];
    }
    function seat(box, s, i, winners) {
      const [cardsEl, actEl, tag] = box.children, d = spot(i), [x, y] = AT[d], top = y < 50;
      box.className = 'pkSeat' + (s ? '' : ' empty') + (top ? ' top' : '') + (s && i === v.you ? ' me' : '') + (s && v.turn === i ? ' turn' : '') + (s && s.folded ? ' folded' : '') + (s && (s.outMs || s.left) ? ' out' : '') + (s && winners.has(i) && v.phase === 'showdown' ? ' won' : '');
      Object.assign(box.style, { left: x + '%', top: y + '%' });
      const bet = box.bet;
      if (!s) { cardsEl.replaceChildren(); actEl.replaceChildren(); tag.replaceChildren(el('span', 'nm', 'Open seat')); bet.replaceChildren(); bet.className = 'pkBet'; box.style.removeProperty('--c'); return; }
      const c = i === v.you ? selfColor : s.bot ? 'rgba(220,226,240,.7)' : colorOf(s.name);
      box.style.setProperty('--c', c); bet.style.setProperty('--c', c);
      cardsEl.replaceChildren(...s.cards.map((cd, k) => card(cd, `${v.hand}:${i}:${k}:${cd ? 'up' : 'x'}`, k * 90 + i * 30)));
      const act = v.phase === 'showdown' ? (s.won ? '' : s.best || '') : s.allin ? 'All in' : s.last;
      actEl.replaceChildren(...(v.phase === 'showdown' && s.won ? [roll.line('', roll.num(`pk:won:${v.hand}:${s.id}`, s.won, (n) => '+' + fmt(n), { cls: 'pkWonN', from0: true }), s.best ? ' · ' + s.best : '')]       // (the pot counting up)
        : act ? [el('span', '', act)] : []));
      actEl.className = 'pkAct' + (v.phase === 'showdown' && s.won ? ' win' : '') + (s.last === 'Fold' ? ' fold' : '');
      const ring = el('i', 'bjRing'), f = mode === 'hub' && !s.blocked && !s.bot && opts.face ? opts.face(s.id) : null;
      if (f) { ring.classList.add('av'); ring.append(f); }
      tag.replaceChildren(ring, el('span', 'nm', i === v.you ? 'You' : s.name), ...(s.bot ? [el('em', 'bot', 'computer')] : []), s.outMs ? el('span', 'ch', 'Out of chips') : roll.num('pk:ch:' + s.id, s.chips, fmt, { cls: 'ch' }));
      bet.className = 'pkBet' + (s.bet ? ' on' : '');
      bet.replaceChildren(...(s.bet ? [chipStack(s.bet)] : []));
      Object.assign(bet.style, { left: BET_AT[d][0] + '%', top: BET_AT[d][1] + '%' });
    }
    function board() {       // the hub's biggest pots won (hub.js gameBoard): a hub's table only
      const list = mode === 'hub' && Array.isArray(v.records) ? v.records : null;
      boardEl.classList.toggle('on', !!list);
      if (!list) return;
      const mine = opts.me ? opts.me() : '';
      const rows = list.map((x, i) => {
        const row = el('div', 'bjBRow' + (x.id === mine ? ' me' : '') + (x.ago < 8000 ? ' fresh' : ''));
        const f = !x.blocked && opts.face ? opts.face(x.id) : null;
        row.append(el('b', 'rk', String(i + 1)), f || el('i', 'nf'), el('span', 'nm', x.id === mine ? 'You' : x.name), el('span', 'amt', fmt(x.win)));
        return row;
      });
      boardEl.replaceChildren(el('div', 'bjBHead', 'Biggest pots'), ...(rows.length ? rows : [el('div', 'bjBNone', 'None yet. Win a pot to get on the board.')]));
    }

    // ---------- what you can do ----------
    function controls() {
      const m = me(), kids = [];
      const btn = (label, cls, fn, off) => { const b = el('button', 'bjBtn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.onclick = fn; b.disabled = !!off; return b; };
      const act = (what, amount) => () => send({ op: 'move', m: { do: what, amount } });
      let line = '';
      if (!m && v.watching >= 0) { line = `The table is full. You're next for a seat${v.watching ? ` (${v.watching + 1} in line)` : ''}.`; kids.push(btn('Leave the line', 'ghost', () => send({ op: 'stand' }))); }
      else if (!m) { const full = v.seats.every((s) => s && !s.bot); line = full ? 'You\'re standing. The table is full.' : 'You\'re standing, watching the table.'; kids.push(btn(full ? 'Get in line' : 'Sit down', 'primary', () => send({ op: 'sit' }))); }
      else if (m.left) { line = 'You\'ve stood up. You\'re out after this hand.'; kids.push(btn('Sit back down', 'primary', () => send({ op: 'sit' }))); }
      else if (m.outMs) { line = `Out of chips. Back in with ${fmt(v.start)} in `; kids.push(el('b', 'bjCount out', String(Math.ceil(m.outMs / 1000)))); }
      else if (v.can) {
        const c = v.can;
        kids.push(btn('Fold', '', act('fold')));
        const stay = c.check ? 'Check' : c.call >= m.chips ? `Call ${fmt(c.call)} (all in)` : `Call ${fmt(c.call)}`;
        if (!c.raise) kids.push(btn(stay, 'primary', act(c.check ? 'check' : 'call')));
        else {
          // one button: the slider's left end (raise 0) checks or calls, each step right of it bets or raises one small blind more, the far right is all in
          const key = `${v.hand}:${v.phase}:${c.raise.min}`;
          if (raiseFor !== key) { raiseFor = key; raise = 0; }
          if (raise) raise = Math.max(c.raise.min, Math.min(c.raise.max, raise));
          const word = v.current ? 'Raise to' : 'Bet';
          const steps = 1 + Math.ceil((c.raise.max - c.raise.min) / v.small);
          const amountAt = (k) => k <= 0 ? 0 : Math.min(c.raise.max, c.raise.min + (k - 1) * v.small);
          const stepOf = (amt) => amt ? Math.min(steps, 1 + Math.round((amt - c.raise.min) / v.small)) : 0;
          const label = () => !raise ? stay : raise >= c.raise.max ? 'All in' : `${word} ${fmt(raise)}`;
          const go = btn(label(), 'primary', () => send({ op: 'move', m: !raise ? { do: c.check ? 'check' : 'call' } : raise >= c.raise.max ? { do: 'allin' } : { do: 'raise', amount: raise } }));
          const r = el('input', 'pkRange'); Object.assign(r, { type: 'range', min: 0, max: steps, step: 1, value: stepOf(raise) });
          const fill = () => r.style.setProperty('--fill', stepOf(raise) / steps * 100 + '%');
          fill();
          r.oninput = () => { raise = amountAt(+r.value); fill(); go.textContent = label(); };
          const pot = v.pot + v.seats.reduce((n, s) => n + (s ? s.bet : 0), 0);
          const preset = (label, to) => btn(label, 'ghost mini', () => { raise = Math.max(c.raise.min, Math.min(c.raise.max, Math.round(to / v.small) * v.small)); controls(); });
          kids.push(r, preset('½ pot', v.current + (pot + (v.current - m.bet)) / 2), preset('Pot', v.current + pot + (v.current - m.bet)), go);
        }
      } else if (v.phase === 'waiting') line = v.seats.filter((s) => s && !s.outMs).length >= 2 ? 'The next hand is about to start' : 'Waiting for someone to play against';
      else if (v.phase === 'showdown') line = summary(m);
      else if (!m.inHand) line = 'You\'re in from the next hand.';
      else if (m.folded) line = 'You folded. Watching the rest of the hand.';
      else if (m.allin) line = 'You\'re all in.';
      else if (v.turn >= 0) line = `Waiting for ${(v.seats[v.turn] || {}).name || 'the others'}`;
      if (v.mine && m && !m.folded) kids.unshift(el('span', 'pkMine', v.mine));
      if (m && !m.left && !v.can && (!m.inHand || m.folded || v.phase === 'showdown' || v.phase === 'waiting')) kids.push(btn('Stand up', 'ghost', () => send({ op: 'stand' })));
      bar.replaceChildren(...(line ? [typeof line === 'string' ? el('span', 'bjLine', line) : line] : []), ...kids);       // (a win's line comes with its number rolling)
      bar.dataset.phase = v.phase;
      status.replaceChildren(...statusLine());
    }
    function summary(m) {
      if (!m.inHand) return 'You\'re in from the next hand.';
      if (m.won && m.net > 0) return roll.line('bjLine', 'You win ', roll.num(`pk:me:${v.hand}`, m.won, fmt, { cls: 'bjWon', from0: true }), `${m.best ? ' with ' + m.best.toLowerCase() : ''}!`);
      if (m.won) return `You get ${fmt(m.won)} back.`;
      return m.folded ? 'You folded this one.' : `You lose${m.best ? ' with ' + m.best.toLowerCase() : ''}.`;
    }
    function statusLine() {
      const turnName = v.turn >= 0 ? (v.turn === v.you ? 'Your turn' : `${(v.seats[v.turn] || {}).name || 'Someone'}’s turn`) : '';
      const text = { idle: 'Take a seat', waiting: 'Waiting for players', showdown: v.pots && v.pots.some((p) => p.hand) ? 'Showdown' : '' }[v.phase] ?? turnName;
      const out = [el('span', '', text)];
      if (v.turn >= 0 && v.msLeft && !(v.seats[v.turn] || {}).bot) out.push(el('b', 'bjCount', String(secs())));
      return out;
    }
    function tickTimers() {
      if (!v) return;
      const c = status.querySelector('.bjCount'); if (c) c.textContent = String(secs());
      const m = me();
      if (m && m.outMs) { const o = bar.querySelector('.bjCount.out'), ms = Math.max(0, m.outMs - (Date.now() - got)); if (o) o.textContent = String(Math.ceil(ms / 1000)); }
      v.seats.forEach((s, i) => {
        const r = seatEls[spot(i)].querySelector('.bjRing'); if (!r || !s) return;
        let f = 0;
        if (s.outMs) f = Math.max(0, s.outMs - (Date.now() - got)) / 20000;
        else if (v.turn === i && !s.bot) f = left() / (v.turnMs || 20000);
        r.style.setProperty('--f', Math.max(0, Math.min(1, f)).toFixed(3));
        r.classList.toggle('on', f > 0);
      });
    }
    setInterval(tickTimers, 100);
    function flash() {
      const m = me(); if (!m || !m.inHand) return;
      const k = m.net > 0 ? (m.won >= 1000 ? 'fBj' : 'fWin') : m.net < 0 && !m.folded ? 'fLose' : '';
      holder.classList.remove('fBj', 'fWin', 'fLose');
      if (!k) return;
      void holder.offsetWidth;
      holder.classList.add(k);
      clearTimeout(flashTimer); flashTimer = setTimeout(() => holder.classList.remove(k), 2600);
    }

    return {
      view(nv, m) { v = nv; mode = m || ''; got = Date.now(); draw(); },
      note(text) {
        noteEl.textContent = text; noteEl.classList.add('on');
        clearTimeout(noteTimer); noteTimer = setTimeout(() => noteEl.classList.remove('on'), 3200);
      },
      colors(c) {
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
