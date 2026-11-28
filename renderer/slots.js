/* Drift — Scene Slots (docs/plans/scene-slots.md), the Games room's scene machine, played like a gacha summon. Always your own,
   never a hub's: put in scene tokens (won with the crane machine's grand prize or a Pachinko fever round filled: main.js
   tokenWon), one pull or up to ten, and the summon plays out to the scenes main.js has already picked and unlocked
   (slotsSpin): the reels blur while an orb gathers light, its colour climbing to the best rarity coming (blue, purple, gold),
   the reels slam to a stop (an SSR: a beat of dark and silence first), a burst and a pillar of light, the cards come down face
   down and flip, stars dinging in, a rarity stamp, a slam across the screen and a fanfare; then the showcase: the dark lifts
   off the best scene won, drawn live behind the machine (preview), under a banner with its name. A click (or Space) skips.
     const t = window.driftSlots(holder, send, { thumb, thumbs, go, names, preview })   t.view({ tokens, locked, unlocked, total })   t.result(m)   t.colors(look)
   send({ op: 'spin', n }) asks for n scenes; send({ op: 'sfx', name }) plays one of its sounds. thumb(id) is a scene's picture
   (the picker's tile, as a CSS url()), go(id) switches to a scene, names maps the scenes' ids to their names, preview(id)
   draws a scene behind the machine for now ('' stops).
   Rarity is only for show (the pick is even among the scenes still locked): a few showpieces are SSR, the next few SR.
   The light is cheap on purpose: one canvas at the screen's own size (not twice it), particles stamped from a few glow
   sprites made once, a cap on how many, and the drawing stops when nothing's moving. (Drawn circle by circle at twice the
   size, with sparkles that never stopped, it made the whole PC lag.) */
(() => {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const SSR = ['mandala', 'canyon', 'julia', 'menger', 'apollonian'];
  const SR = ['water', 'lava', 'ridges', 'dunes', 'seaside', 'voronoi', 'life', 'tunnel', 'lattice', 'hyperbolic', 'chladni'];
  const rarity = (id) => (SSR.includes(id) ? 2 : SR.includes(id) ? 1 : 0);       // 0 R, 1 SR, 2 SSR
  const TIER = [{ tag: 'R', stars: 3, col: '#6fb6ff', show: 2000 }, { tag: 'SR', stars: 4, col: '#c27bff', show: 2800 }, { tag: 'SSR', stars: 5, col: '#ffd84a', show: 3800 }];
  const RAINBOW = ['#ff4f8b', '#ffb03a', '#ffd84a', '#7dff9a', '#6fe8ff', '#b98cff'];
  // the summon's beats, in ms from the pull (an SSR's dark beat pushes everything after the stop on by `dark`)
  const T = { tier1: 650, tier2: 1250, stop: 1750, dark: 500, burst: 1950, cards: 2350, flip: 2850, gap: 240, rare: 550 };
  const MAX = 260;       // particles alive at once, at most

  window.driftSlots = (holder, send, opts = {}) => {
    holder.innerHTML = '';
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const names = opts.names || {}, preview = opts.preview || (() => {});
    const lamp = el('div', 'bjLamp'), cab = el('div', 'slCab'), bar = el('div', 'bjBar'), noteEl = el('div', 'bjNote');
    const stage = el('div', 'slStage'), fx = el('canvas', 'slFx'), flash = el('div', 'slFlash'), pillar = el('div', 'slPillar'), prize = el('div', 'slPrize'), skipEl = el('div', 'slSkip', 'Click to skip');
    const slam = el('div', 'slSlam'), banner = el('div', 'slBanner');
    stage.append(fx, pillar, flash, prize, slam, banner, skipEl);
    // The machine is a box in 3D (CSS: composited by the graphics card, so it costs next to nothing): its front (the cabinet),
    // its sides and top, a lever on its right side. It's held by a camera rig (slRig: where the camera is, moved from beat to
    // beat by CSS transitions) and a shaker inside that (slShake: the rumble and the jolts), so the two never fight.
    const rig = el('div', 'slRig cam-idle'), shake = el('div', 'slShake');
    const sideL = el('div', 'slFace3 slSideL'), sideR = el('div', 'slFace3 slSideR'), back3 = el('div', 'slFace3 slBack');       // (no top: the camera never sees it)
    const lever = el('div', 'slLever'); lever.append(el('i', 'slLeverArm'), el('b', 'slLeverKnob'));
    shake.append(back3, sideL, sideR, cab, lever); rig.append(shake);
    holder.append(lamp, rig, bar, noteEl, stage);
    // The cabinet's face, top to bottom, like a casino's: the crown (an arch of chasing bulbs, the neon sign, a scrolling LED
    // jackpot ticker); the reel window in its chrome frame (three drums, the middle row framed and pointed at by the payline's
    // arrows, glass over it all); the LED readouts (tokens, the last win, scenes); the paytable; the button deck (the coin slot
    // and the two big buttons, which really pull); the coin tray. Chasing light strips down both edges.
    const crown = el('div', 'slCrown'), sign = el('div', 'slSign'), ticker = el('div', 'slTicker'), tickerText = el('span', '', '★ SSR JACKPOT ★ FIVE SHOWPIECE SCENES ★ ONE TOKEN · ONE SCENE ★ UP TO TEN AT ONCE ');
    sign.innerHTML = window.driftMark || ''; sign.append(el('span', '', 'SCENE SLOTS'));       // (fixed markup: Drift's mark)
    tickerText.textContent += tickerText.textContent; ticker.append(tickerText);
    const arch = el('div', 'slArch');
    for (let i = 0; i < 17; i++) { const u = i / 16, b = el('i'); b.style.left = `${4 + u * 92}%`; b.style.top = `${(1 - Math.sqrt(1 - Math.pow(u * 2 - 1, 2))) * 62}%`; b.style.animationDelay = `${(i % 3) * 0.16}s`; arch.append(b); }
    crown.append(arch, sign, ticker);
    // The reels are drums: FACES pictures round each, turning about its axle (seen through the window, in its own perspective)
    const FACES = 12, STEP = 360 / FACES;
    const frame = el('div', 'slFrame'), win = el('div', 'slWindow'), line = el('div', 'slLine'), glass = el('div', 'slGlass');
    const reels = [0, 1, 2].map(() => { const r = el('div', 'slReel'), drum = el('div', 'slDrum'); r.append(drum); win.append(r); return { r, drum }; });
    win.append(line, glass, el('i', 'slArrow l'), el('i', 'slArrow r'));
    frame.append(win);
    const led = (label) => { const box = el('div', 'slLed'), val = el('b', 'slLedVal', '0'); box.append(el('span', 'slLedLabel', label), val); return [box, val]; };
    const [ledTok, ledTokV] = led('Tokens'), [ledWin, ledWinV] = led('Win'), [ledSc, ledScV] = led('Scenes'), leds = el('div', 'slLeds');
    leds.append(ledTok, ledWin, ledSc); ledWinV.textContent = '—';
    const pay = el('div', 'slPay');
    for (const [i, t] of TIER.map((t, i) => [i, t]).reverse()) { const row = el('div', 'slPayRow r' + i); row.append(el('b', 'slTagMini r' + i, t.tag), el('span', '', '★'.repeat(t.stars))); pay.append(row); }
    const deck = el('div', 'slDeck'), slot = el('div', 'slCoinSlot');
    const deckBtn = (cls, fn) => { const b = el('button', 'slBtn ' + cls); b.append(el('span', '', '')); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
    const btn1 = deckBtn('slDeck1', () => pull());       // (one pull at a time: asked for)
    deck.append(slot, btn1);
    const tray = el('div', 'slTray');
    cab.append(el('div', 'slTrim'), el('i', 'slStrip l'), el('i', 'slStrip r'), crown, frame, leds, pay, deck, tray);
    // Depth on the face: the crown, the chrome bezel, the readouts, the paytable, the deck and the tray stand out from the
    // cabinet as blocks (`d` deep: a top lit from above, shaded sides and underside, in `col`), and the reel window is sunk
    // into the bezel, with walls going back to it. (Planes in CSS 3D, so the camera sees round them.)
    const block = (elm, d, col) => { elm.classList.add('slBlock'); elm.style.setProperty('--d', d); elm.style.setProperty('--bs', col); for (const s of ['t', 'b', 'l', 'r']) elm.append(el('i', 'slB ' + s)); };
    block(crown, '2.6vh', 'color-mix(in srgb, var(--bjAccent, #22c08a) 50%, #000)'); block(frame, '3vh', '#9aa1b0'); block(leds, '1.2vh', 'color-mix(in srgb, var(--bjAccent, #22c08a) 30%, #000)'); block(pay, '.8vh', 'color-mix(in srgb, var(--bjAccent, #22c08a) 36%, #000)'); block(deck, '5vh', '#221d2a'); block(tray, '2.4vh', '#7a8090');
    for (const s of ['t', 'b', 'l', 'r']) frame.append(el('i', 'slW ' + s), el('i', 'slBez ' + s));       // (the walls of the window's well, and the chrome bezel round it: a ring, open in the middle, so the well shows)
    holder.insertBefore(el('div', 'slFloor'), rig);       // (the machine's shadow on the floor)
    const cam = (name) => { if (!calm) rig.className = 'slRig cam-' + name; };       // (where the camera goes next: style.css .cam-…)
    const jolt = () => { if (calm) return; shake.classList.remove('jolt'); void shake.offsetWidth; shake.classList.add('jolt'); clearTimeout(jolt.t); jolt.t = setTimeout(() => shake.classList.remove('jolt'), 380); };       // (then the rumble, if it's on, carries on)

    let v = { tokens: 0, locked: [], unlocked: [], total: 0 }, key = '', spinning = false, shown = [], timers = [], finish = null, ended = false, backing = false;       // (ended: on the scene won, after a pull)
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    const sfx = (name) => send({ op: 'sfx', name });
    function note(text) { noteEl.textContent = text; noteEl.classList.add('on'); clearTimeout(note.t); note.t = setTimeout(() => noteEl.classList.remove('on'), 4600); }

    function card(id) {       // a card: the scene's picture (the picker's own, drawn live) and its name (on the reels, only the picture shows)
      const c = el('div', 'slCard'), pic = el('div', 'slPic'), bg = opts.thumb ? opts.thumb(id) : '';
      if (bg) pic.style.backgroundImage = bg; else pic.classList.add('none');
      c.append(pic, el('span', '', names[id] || id));
      c.dataset.id = id;
      return c;
    }
    function gcard(id, i) {       // a summon card: face down (Drift's mark in its rarity's light); on its front the scene, its stars, its rarity, NEW
      const r = rarity(id), t = TIER[r], g = el('div', `slG r${r}`), inner = el('div', 'slGIn'), back = el('div', 'slGBack'), front = el('div', 'slGFront');
      back.innerHTML = window.driftMark || '';
      const pic = el('div', 'slPic'), bg = opts.thumb ? opts.thumb(id) : '';
      if (bg) pic.style.backgroundImage = bg; else pic.classList.add('none');
      const stars = el('div', 'slStars'); for (let k = 0; k < t.stars; k++) { const s = el('i', '', '★'); s.style.animationDelay = `${k * 180}ms`; stars.append(s); }
      front.append(pic, stars, el('span', 'slName', names[id] || id), el('b', 'slTag', t.tag), el('i', 'slNew', 'NEW'));
      front.dataset.id = id;
      inner.append(back, front); g.append(inner);
      g.style.setProperty('--i', i); g.style.setProperty('--rc', t.col);
      g.addEventListener('click', (e) => { if (!spinning && g.classList.contains('flip')) { e.stopPropagation(); opts.go && opts.go(id); } });
      return g;
    }
    const pool = () => Object.keys(names);
    const any = () => { const p = pool(); return p[Math.floor(Math.random() * p.length)]; };
    // a drum's cards (FACES of them, `at` face carrying `id`), and its turn (to `deg`, over `ms`, or at once)
    function fill(x, id, at) {
      x.drum.replaceChildren(...Array.from({ length: FACES }, (_, i) => { const f = card(i === at ? id : any()); f.classList.add('slFace'); f.style.transform = `rotateX(${i * STEP}deg) translateZ(var(--rr))`; return f; }));
    }
    function turn(x, deg, ms, ease) {
      x.drum.style.transition = 'none'; if (!ms) { x.drum.style.transform = `rotateX(${deg}deg)`; return; }
      void x.drum.offsetWidth; x.drum.style.transition = `transform ${ms}ms ${ease}`; x.drum.style.transform = `rotateX(${deg}deg)`;
    }
    function rest(ids) { reels.forEach((x, i) => { fill(x, ids[i % ids.length], 0); turn(x, 0, 0); }); }       // (at rest: each drum's front card)
    rest([any(), any(), any()]);
    // The pull's start, kept light (it hitched): the drums' cards are made once and reused, only the one card that comes round
    // to the scene won changed (its picture, its glow); then one layout for all three, and all three set turning.
    function setCard(f, id, win) {
      f.dataset.id = id; f.classList.toggle('win', !!win);
      const pic = f.firstChild, bg = opts.thumb ? opts.thumb(id) : '';
      if (pic && pic.style.backgroundImage !== bg) pic.style.backgroundImage = bg;
    }
    function spinAll(lead, col, stops) {
      reels.forEach((x) => {
        if (x.drum.children.length !== FACES) fill(x, any(), 0);
        [...x.drum.children].forEach((f, i) => { if (i === 5) { f.style.setProperty('--rc', col); setCard(f, lead, true); } else if (f.classList.contains('win')) setCard(f, any(), false); });
        x.drum.style.transition = 'none'; x.drum.style.transform = 'rotateX(0deg)';
      });
      void reels[0].drum.offsetWidth;       // (one layout, for the three)
      reels.forEach((x, i) => { x.drum.style.transition = `transform ${stops[i]}ms ${i === 2 ? 'cubic-bezier(.2,.12,.05,1.01)' : 'cubic-bezier(.25,.1,.1,1.02)'}`; x.drum.style.transform = `rotateX(${-((9 + i * 3) * 360 + 5 * STEP)}deg)`; });
    }

    // ---------- the light ----------
    const ctx = fx.getContext('2d');
    const sprites = new Map();
    function sprite(col) {       // a soft dot of light in a colour, made once (stamped with drawImage: far cheaper than drawing a gradient circle)
      let s = sprites.get(col); if (s) return s;
      s = document.createElement('canvas'); s.width = s.height = 32;
      const c = s.getContext('2d'), g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, col); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(0, 0, 32, 32);
      sprites.set(col, s); return s;
    }
    let parts = [], rings = [], orb = null, fxCol = TIER[0].col, rainbow = false, sparkleUntil = 0, raf = 0, cx = 0, cy = 0, W = 0, H = 0;
    function measure() {
      W = holder.clientWidth; H = holder.clientHeight;
      if (fx.width !== W || fx.height !== H) { fx.width = W; fx.height = H; }       // (the screen's own size: soft dots don't need more)
      const b = win.getBoundingClientRect(), h = holder.getBoundingClientRect();
      [cx, cy] = b.width ? [b.left - h.left + b.width / 2, b.top - h.top + b.height / 2] : [W / 2, H / 2];
    }
    const colOf = (k) => (rainbow ? RAINBOW[k % RAINBOW.length] : fxCol);
    let last = 0;
    function draw(now) {
      raf = 0;
      if (!stage.classList.contains('on')) { ctx.clearRect(0, 0, W, H); return; }
      const dt = Math.min(50, last ? now - last : 16); last = now;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      if (orb) {       // gathering: dots drawn in on a spiral, the orb swelling
        const age = (now - orb.t0) / 1000, R = 22 + Math.min(1, age / 1.6) * 50 + Math.sin(now / 60) * 4;
        for (let k = 0; k < 3 && parts.length < MAX; k++) { const a = Math.random() * 6.283, d = 240 + Math.random() * 360; parts.push({ in: true, a, d, life: 0, max: 850, s: 10 + Math.random() * 12, k }); }
        const o = sprite(colOf(Math.floor(now / 90)));
        ctx.globalAlpha = 0.9; ctx.drawImage(o, cx - R * 3, cy - R * 3, R * 6, R * 6);
        ctx.globalAlpha = 1; ctx.drawImage(sprite('#ffffff'), cx - R, cy - R, R * 2, R * 2);
        if (rainbow) for (let k = 0; k < 3; k++) { ctx.strokeStyle = RAINBOW[(k * 2 + Math.floor(now / 120)) % 6]; ctx.globalAlpha = 0.7; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, R * (1.4 + k * 0.35) + Math.sin(now / 120 + k) * 4, 0, 6.283); ctx.stroke(); }
        ctx.globalAlpha = 1;
      }
      if (now < sparkleUntil && parts.length < 60 && Math.random() < 0.35) parts.push({ x: Math.random() * W, y: H + 10, vx: (Math.random() - 0.5) * 20, vy: -70 - Math.random() * 90, life: 0, max: 3500, s: 8 + Math.random() * 10, drift: true, k: Math.floor(Math.random() * 6) });
      let n = 0;
      for (const p of parts) {
        if ((p.life += dt) >= p.max) continue;
        parts[n++] = p;
        const f = 1 - p.life / p.max;
        if (p.in) { const k = p.life / p.max, r = p.d * (1 - k); p.x = cx + Math.cos(p.a + k * 2.4) * r; p.y = cy + Math.sin(p.a + k * 2.4) * r; ctx.globalAlpha = 0.35 + k * 0.65; }
        else { p.x += p.vx * dt / 1000; p.y += p.vy * dt / 1000; if (!p.drift) { p.vx *= 0.985; p.vy = p.vy * 0.985 + 60 * dt / 1000; } ctx.globalAlpha = f; }
        const s = p.s * (p.in ? 1 : 0.6 + f * 0.6);
        ctx.drawImage(sprite(colOf(p.k)), p.x - s / 2, p.y - s / 2, s, s);
      }
      parts.length = n;
      ctx.globalAlpha = 1;
      rings = rings.filter((r) => (r.life += dt) < r.max);
      for (const r of rings) { if (r.life < 0) continue; const k = r.life / r.max; ctx.strokeStyle = colOf(r.k); ctx.globalAlpha = 1 - k; ctx.lineWidth = 6 * (1 - k) + 1; ctx.beginPath(); ctx.arc(cx, cy, 40 + k * r.to, 0, 6.283); ctx.stroke(); }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      if (orb || parts.length || rings.length || now < sparkleUntil) raf = requestAnimationFrame(draw);       // (nothing moving: stop drawing)
      else { ctx.clearRect(0, 0, W, H); last = 0; }
    }
    const fxOn = () => { if (!raf && !calm) { last = 0; raf = requestAnimationFrame(draw); } };
    function burst(best) {
      orb = null;
      const n = [90, 150, 220][best];
      for (let k = 0; k < n && parts.length < MAX + 120; k++) { const a = Math.random() * 6.283, s = 220 + Math.random() * 900; parts.push({ x: cx, y: cy, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 800 + Math.random() * 1100, s: 10 + Math.random() * 14, k }); }
      for (let k = 0; k < [2, 3, 4][best]; k++) rings.push({ life: -k * 110, max: 1000, to: 700 + k * 160, k });
      fxOn();
    }

    // ---------- the readouts, the deck's buttons and the bar ----------
    function info0() {       // the LEDs: your tokens and your scenes (the last win is set by the summon)
      ledTokV.textContent = String(v.tokens).padStart(2, '0');
      ledScV.textContent = `${v.total - v.locked.length}/${v.total}`;
    }
    function controls() {
      const k = [v.tokens, v.locked.length, spinning, ended].join(',');
      if (k === bar.dataset.k) return;
      bar.dataset.k = k;
      // the deck's Pull, lit when it would pull
      const can = !spinning && v.tokens > 0 && v.locked.length > 0;
      btn1.firstChild.textContent = 'Pull'; btn1.disabled = !can;
      deck.classList.toggle('ready', can);
      // (on the scene won, nothing at all: it's there to look at, and a click goes back to the machine. Asked for: no way to
      // switch to the scene from here; it's in the Scenes tab now, like the rest)
      if (ended) { bar.replaceChildren(); return; }
      const kids = [];
      const btn = (text, cls, fn, off) => { const b = el('button', 'bjBtn ' + cls, text); b.disabled = !!off; b.addEventListener('click', fn); return b; };
      if (spinning) kids.push(el('span', 'bjLine', 'Summoning… (click to skip)'));
      else if (!v.locked.length) kids.push(el('span', 'bjLine', 'Every scene is unlocked. Nothing left to summon.'));
      else if (!v.tokens) kids.push(el('span', 'bjLine', 'No scene tokens. Win one at the crane machine, Pachinko or Sketch & Guess.'));
      else kids.push(btn('Pull', 'primary slPull', () => pull()));
      kids.push(el('span', 'bjAmt ico-tok', `${v.tokens} token${v.tokens === 1 ? '' : 's'}`));
      bar.replaceChildren(...kids);
    }

    // ---------- the pull ----------
    function clear() { timers.forEach(clearTimeout); timers = []; }
    function reset() {
      clear(); parts = []; rings = []; orb = null; rainbow = false; sparkleUntil = 0; finish = null; preview(''); ended = false;
      stage.className = 'slStage'; prize.className = 'slPrize'; prize.replaceChildren(); slam.className = 'slSlam'; banner.className = 'slBanner';
      holder.classList.remove('busy', 'fWin', 'hopping');
      shake.classList.remove('rumble1', 'rumble2', 'jolt', 'hop'); cam('idle');
    }
    function pull() {
      if (spinning || !v.tokens || !v.locked.length) return;
      reset(); spinning = true; shown = []; holder.classList.add('busy');
      sfx('slCoin'); sfx('slLever'); sfx('slPower'); slot.classList.add('in');       // (slPower: the power-up recording, asked for) setTimeout(() => slot.classList.remove('in'), 600);
      lever.classList.remove('pull'); void lever.offsetWidth; lever.classList.add('pull');       // (the lever yanked down)
      send({ op: 'spin', n: 1 });
      later(() => { if (spinning && !finish) { spinning = false; holder.classList.remove('busy'); controls(); note('The machine didn\'t answer. Try again.'); } }, 5000);
      controls();
    }
    function result(m) {       // main.js's answer: the scenes won (the summon plays out to them), or why not
      if (!m) return;
      if (m.error) { spinning = false; holder.classList.remove('busy'); note(m.error); controls(); return; }
      const ids = (Array.isArray(m.won) ? m.won : [m.won]).map(String).filter(Boolean); if (!ids.length) return;
      summon(ids);
    }
    function slamIt(r) {       // the rarity, huge, slammed across the screen
      slam.textContent = r === 2 ? 'SSR!!' : r === 1 ? 'SR!' : 'R';
      slam.className = 'slSlam'; void slam.offsetWidth; slam.className = 'slSlam on r' + r;
    }
    function summon(ids) {
      reset(); spinning = true; holder.classList.add('busy'); measure();
      const best = Math.max(...ids.map(rarity)), lead = ids.slice().sort((a, b) => rarity(b) - rarity(a))[0], d = best === 2 ? T.dark : 0;
      const cards = ids.map(gcard);
      let fanfare = false, showing = false;
      const fan = (r) => { if (fanfare) return; fanfare = true; sfx(['slR', 'slSR', 'slSSR'][r]); };
      // the showcase: the dark lifts off the best scene won, drawn live, under a banner with its name; and it stays there
      const showcase = () => {
        if (showing) return; showing = true;
        const r = rarity(lead), t = TIER[r];
        banner.replaceChildren(el('b', 'slBTag', t.tag), el('span', 'slBStars', '★'.repeat(t.stars)), el('div', 'slBName', names[lead] || lead), el('div', 'slBSub', ids.length > 1 ? `UNLOCKED · and ${ids.length - 1} more` : 'NEW SCENE UNLOCKED'));
        banner.className = 'slBanner on r' + r; stage.classList.add('show');
        if (r === 2) { sparkleUntil = performance.now() + t.show; fxOn(); }
        later(() => finish && finish(), t.show);
      };
      finish = () => {       // the end (or skipped to it): it sits on the scene won, drawn live, the banner fading away; the cards turned, for later
        const early = !showing;       // (skipped before the showcase: the banner still gets its moment before it fades)
        clear(); orb = null; showcase(); clear();
        preview(lead);
        stage.classList.remove('charge', 'black', 'burst', 'white', 'clear'); stage.classList.add('end'); slam.className = 'slSlam';
        shake.classList.remove('hop', 'jolt'); holder.classList.remove('hopping');
        later(() => banner.classList.add('fade'), early ? 1600 : 0);
        prize.classList.add('on', ids.length > 1 ? 'many' : 'one');
        if (!prize.children.length) prize.append(...cards);
        cards.forEach((g) => g.classList.add('in', 'flip', 'stamp'));
        fan(best);
        rest([lead, lead, lead]); shake.classList.remove('rumble1', 'rumble2'); cam('idle');
        ledWinV.textContent = TIER[best].tag; ledWin.className = 'slLed won r' + best;
        spinning = false; shown = ids; ended = true; holder.classList.remove('busy');
        holder.classList.remove('fWin'); void holder.offsetWidth; holder.classList.add('fWin');
        later(() => holder.classList.remove('fWin'), 2600);
        note(ids.length > 1 ? `${ids.length} scenes unlocked. Click to see them all.` : `${names[ids[0]] || ids[0]} is unlocked. It's in the Scenes tab now.`);
        controls();
      };
      stage.classList.add('on', 'clear', 'r' + best);       // (clear: the machine in plain sight, the camera fixed on it)
      if (calm) { finish(); banner.classList.add('fade'); return; }
      // The pull, all from the one angle: the drums whirl and the machine hops (up, a thud, up again, smaller, each landing
      // squashing it a little and its shadow shrinking under it while it's up), then settles. Then the drums wind down onto
      // the scene won, one after another (the card it's on put round the back, so it isn't seen coming), the middle row lit
      // in its rarity's colour, the rarity slammed on and its fanfare. Then the camera zooms into the middle of the reels, the
      // screen goes white, and out of the white comes the scene itself, drawn live, with its banner.
      // (the stops spaced out for suspense: the second a beat after the first, the last crawling round to it a long moment
      // later over a quickening heartbeat; each winning card lights up as its drum stops; then a moment on the three of them
      // glowing before the zoom. The sounds are timed to these: sfx.js slReels, slTense)
      const S = { hop: 1900, stop: [2100, 3000, 4400], zoom: 5300, white: 5750, show: 6300 };
      const glow = (x) => { const f = x.drum.children[5]; if (f) { f.style.setProperty('--rc', TIER[best].col); f.classList.add('win'); } };       // (the card it stopped on: the scene won)
      spinAll(lead, TIER[best].col, S.stop);       // (the winning card glowing as it rolls, asked for: a flash of its colour each time it comes round)
      if (opts.warm) opts.warm(lead);       // (the scene won starts building now, in the background, so the reveal doesn't stall on it)
      sfx('slReels');
      shake.classList.add('hop'); holder.classList.add('hopping');       // (reset() took 'hop' off: no layout forced to restart it)
      [570, 970, 1310].forEach((ms) => later(() => sfx('slThud'), ms));       // (each landing: a thud, as style.css slHop lands it: 30%, 51%, 69% of 1.9 s)
      later(() => { shake.classList.remove('hop'); holder.classList.remove('hopping'); }, S.hop);
      S.stop.slice(0, 2).forEach((ms, i) => later(() => { sfx('slReelStop'); jolt(); glow(reels[i]); }, ms));
      later(() => sfx('slTense'), S.stop[1] + 150);       // (two down, one to go)
      later(() => {       // the last drum stops: the result
        glow(reels[2]);
        line.style.setProperty('--rc', TIER[best].col); stage.classList.add('stop'); sfx('slReelStop'); jolt();
        ledWinV.textContent = TIER[best].tag; ledWin.className = 'slLed won r' + best;       // (the WIN readout: the best that came)
        if (best) slamIt(best); fan(best);
        holder.classList.remove('fWin'); void holder.offsetWidth; holder.classList.add('fWin');
      }, S.stop[2]);
      later(() => { cam('zoom'); sfx('slWhoosh'); }, S.zoom);       // (into the middle of the reels)
      later(() => { stage.classList.add('white'); sfx('slShine'); }, S.white);
      later(() => { preview(lead); showcase(); cam('idle'); stage.classList.remove('white'); }, S.show);       // (the scene behind the white, then the white lifting off it)
    }
    // A click on the stage (or Space) skips the summon to its end, the scene won; there, a click puts it away (the machine again).
    function back() {       // from the scene won to the machine: down to dark (0.35 s), the scene let go, the dark fading off the machine (0.4 s)
      if (backing) return; backing = true;
      stage.classList.add('out');
      setTimeout(() => { preview(''); banner.className = 'slBanner'; stage.classList.remove('show', 'end', 'on'); ended = false; controls(); setTimeout(() => { reset(); controls(); backing = false; }, 450); }, 380);
    }
    stage.addEventListener('click', () => {
      if (spinning && finish) finish();
      else if (!spinning && stage.classList.contains('on')) back();
    });

    function view(n) {
      if (!n) { reset(); spinning = false; shown = []; cancelAnimationFrame(raf); raf = 0; return; }
      v = n;
      const k = [v.tokens, v.locked.length, v.total].join(',');
      if (k !== key) { key = k; info0(); }
      controls();
      if (opts.thumb) {       // (the scenes' pictures are drawn a few at a time and can come after the cards were made: put them in as they do)
        for (const pic of holder.querySelectorAll('.slPic.none')) { const bg = opts.thumb(pic.parentNode.dataset.id); if (bg) { pic.style.backgroundImage = bg; pic.classList.remove('none'); } }
      }
    }
    function colors(look) { for (const [k, val] of Object.entries((look && look.vars) || {})) holder.style.setProperty(k, val); }
    addEventListener('resize', () => { if (stage.classList.contains('on')) measure(); });
    // Space or Enter pulls once while the machine is up (and skips a summon that's playing)
    addEventListener('keydown', (e) => {
      if (!holder.classList.contains('on') || e.repeat || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || document.querySelector('#panel.open.show')) return;
      if (e.key !== ' ' && e.key !== 'Enter') return;
      if (spinning && finish) { e.preventDefault(); e.stopImmediatePropagation(); finish(); }
      else if (ended) { e.preventDefault(); e.stopImmediatePropagation(); back(); }       // (on the scene won: back to the machine, not another pull)
      else if (!spinning && v.tokens && v.locked.length) { e.preventDefault(); e.stopImmediatePropagation(); pull(); }
    }, true);
    return { view, result, colors, pull, state: () => ({ spinning, shown }) };
  };
})();
