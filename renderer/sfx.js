/* Drift — Hub sounds: joining and leaving a hub and its voice room, muting, going live, friends coming and going,
   and new messages; and the game tables' (cards, chips, the roulette ball, your turn, how your hand went). They're made here with Web Audio, nothing is a recording, and they play in the hidden audio window
   (renderer/audio.html), so a sound never doubles across monitors. They have their own AudioContext: they stay out of the
   visuals' analyser and out of the music sent to friends, and a broadcast never carries them (bc-sound.js leaves out
   Drift's own process). main.js decides when, from what changed in the Hub tab (sfxTick), and sends the names here.

   How they're made, so new ones fit in:
   - Every sound is built on C and G. Those are the only two notes that all four Ambient presets share (pads, space, bells,
     dawn), so a chime never fights the music under it. D and E come in only as passing colour.
   - Rising means in or on (joined, unmuted, live), falling means out or off.
   - What you did yourself gets a mallet: a warm sine with a quick wooden overtone, with some body. Other people get
     lighter, higher and quieter sounds (a glide, a glass clink), because they're news, not a confirmation of your click.
   - Muting is a filter closing (a cap going on the microphone), unmuting is the filter opening.
   - Short (most under a third of a second), soft at the start (no clicks), and through a small dark room so they sit in
     the same air as the ambient music.
   - Except Sketch & Guess, which is a game show and sounds like one: brass, drums, a buzzer and a studio audience. */
(() => {
  const N = { D4: 293.66, G4: 392.0, C4: 261.63, C5: 523.25, D5: 587.33, G5: 783.99, C6: 1046.5, G6: 1567.98, C7: 2093.0 };

  // ---- the instruments: each schedules one note at time t on (a, dst) and is done by itself ----
  function voice(a, dst, t, o) {
    const { f, f2 = 0, glide = 0, dur, atk = 0.004, level, type = 'sine', partials = [], cut = 9000, cut2 = 0, vib = 0 } = o;
    const env = a.createGain(), lp = a.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 0.7; lp.frequency.setValueAtTime(cut, t);
    if (cut2) lp.frequency.exponentialRampToValueAtTime(cut2, t + Math.max(glide, dur * 0.5));
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(level, t + atk); env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    env.connect(lp).connect(dst);
    const end = t + dur + 0.05;
    const osc = (ratio, lvl, decay, kind) => {
      const o2 = a.createOscillator(), g = a.createGain();
      o2.type = kind;
      o2.frequency.setValueAtTime(f * ratio, t);
      if (f2) o2.frequency.exponentialRampToValueAtTime(f2 * ratio, t + glide);
      if (vib) {       // a slow wobble that grows: the line going slack
        const lfo = a.createOscillator(), amt = a.createGain(); lfo.frequency.value = 6;
        amt.gain.setValueAtTime(0, t); amt.gain.linearRampToValueAtTime(f * ratio * vib, t + dur);
        lfo.connect(amt).connect(o2.frequency); lfo.start(t); lfo.stop(end);
      }
      g.gain.setValueAtTime(lvl, t);
      if (decay < 1) g.gain.exponentialRampToValueAtTime(Math.max(0.0001, lvl * 0.001), t + dur * decay);
      o2.connect(g).connect(env); o2.start(t); o2.stop(end);
    };
    osc(1, 1, 1, type);
    for (const [ratio, lvl, decay] of partials) osc(ratio, lvl, decay, 'sine');
  }
  // warm sine with a wooden 4th harmonic that dies fast (a soft marimba)
  const mallet = (a, d, t, f, level, dur = 0.5, cut = 6000) => voice(a, d, t, { f, dur, level, cut, partials: [[2, 0.18, 0.35], [4, 0.1, 0.12]] });
  // inharmonic overtones (a small bell or a glass)
  const bell = (a, d, t, f, level, dur = 1, cut = 9000) => voice(a, d, t, { f, dur, level, cut, atk: 0.002, partials: [[2.76, 0.28, 0.4], [5.4, 0.1, 0.18], [8.93, 0.04, 0.08]] });
  // one note that slides, with a little of the mallet's wood
  const glide = (a, d, t, f, f2, level, dur, cut = 7000) => voice(a, d, t, { f, f2, glide: dur * 0.35, dur, level, cut, partials: [[2, 0.12, 0.3]] });
  // a short burst of noise through a band (a card landing on felt, a chip's click): no pitch, so it fights nothing
  let noiseBuf = null;
  function noiseOf(a) {       // 2.5 s of white noise, made once (played looped from a random spot, so it never repeats audibly)
    if (!noiseBuf || noiseBuf.sampleRate !== a.sampleRate) {
      noiseBuf = a.createBuffer(1, Math.floor(a.sampleRate * 2.5), a.sampleRate);
      const x = noiseBuf.getChannelData(0); for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }
  function noise(a, dst, t, { f, q = 1, dur, level, atk = 0.002 }) {
    const src = a.createBufferSource(), bp = a.createBiquadFilter(), env = a.createGain();
    src.buffer = noiseOf(a); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(level, t + atk); env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.loop = true;       // (a long one, like the ball rolling, goes round the buffer)
    src.connect(bp).connect(env).connect(dst); src.start(t, Math.random() * 2.4); src.stop(t + dur + 0.02);
  }

  // ---- Sketch & Guess's game-show band: bigger and brassier than the rest of Drift's sounds, on purpose ----
  // a brass note: two sawtooths a little apart, through a filter that blares open and settles (vib: a wobble near the end)
  function brass(a, dst, t, f, dur, level, { bright = 3400, vib = 0 } = {}) {
    const env = a.createGain(), lp = a.createBiquadFilter(), end = t + dur + 0.1;
    lp.type = 'lowpass'; lp.Q.value = 1.4;
    lp.frequency.setValueAtTime(f * 1.5, t); lp.frequency.exponentialRampToValueAtTime(bright, t + 0.05); lp.frequency.exponentialRampToValueAtTime(Math.max(f * 2.5, bright * 0.5), t + dur);
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(level, t + 0.022); env.gain.linearRampToValueAtTime(level * 0.72, t + Math.max(0.03, dur * 0.75));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    env.connect(lp).connect(dst);
    for (const cents of [-8, 8]) {
      const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = cents;
      if (vib) { const lfo = a.createOscillator(), amt = a.createGain(); lfo.frequency.value = 5.5; amt.gain.setValueAtTime(0, t); amt.gain.linearRampToValueAtTime(f * vib, t + dur); lfo.connect(amt).connect(o.frequency); lfo.start(t); lfo.stop(end); }
      o.connect(env); o.start(t); o.stop(end);
    }
  }
  const chord = (a, d, t, fs, dur, level, o) => fs.forEach((f) => brass(a, d, t, f, dur, level, o));
  // the wrong-answer buzzer: two low squares beating against each other, held, then cut
  function buzzer(a, dst, t, dur, level) {
    const env = a.createGain(), lp = a.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2200;
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(level, t + 0.012); env.gain.setValueAtTime(level, t + dur - 0.05); env.gain.linearRampToValueAtTime(0, t + dur);
    env.connect(lp).connect(dst);
    for (const f of [98, 104]) { const o = a.createOscillator(); o.type = 'square'; o.frequency.value = f; o.connect(env); o.start(t); o.stop(t + dur + 0.02); }
  }
  // the drums: a snare hit, a roll that swells, a cymbal crash
  const snare = (a, d, t, level) => { noise(a, d, t, { f: 1900, q: 0.7, dur: 0.14, level }); voice(a, d, t, { f: 190, f2: 150, glide: 0.06, dur: 0.1, level: level * 0.5, atk: 0.001 }); };
  const roll = (a, d, t, len, level) => { for (let x = 0; x < len; x += 0.034) noise(a, d, t + x, { f: 1900 + Math.random() * 300, q: 0.8, dur: 0.05, level: level * (0.3 + 0.7 * x / len) }); };
  const crash = (a, d, t, level, dur = 1.5) => { noise(a, d, t, { f: 7000, q: 0.35, dur, level, atk: 0.003 }); noise(a, d, t, { f: 3800, q: 0.6, dur: dur * 0.6, level: level * 0.5, atk: 0.003 }); };
  // a studio audience: a wash of crowd and a few hundred hands, swelling in and dying away
  // One clap: two palms meeting aren't one click but a few, a few milliseconds apart (the fingers, then the heels of the
  // hands), and then a short ring of the air cupped between them: a burst of noise, bright then a body (f: that person's
  // hands, cupped lower or flatter higher)
  function clap(a, dst, t, f, level) {
    const src = a.createBufferSource(), hp = a.createBiquadFilter(), bp = a.createBiquadFilter(), env = a.createGain();
    src.buffer = noiseOf(a); src.loop = true;
    hp.type = 'highpass'; hp.frequency.value = 500; bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 1.1;
    const g = env.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(level * 0.7, t + 0.0008); g.linearRampToValueAtTime(level * 0.15, t + 0.004);       // the fingers
    g.linearRampToValueAtTime(level, t + 0.0075); g.linearRampToValueAtTime(level * 0.25, t + 0.011);       // the palms
    g.linearRampToValueAtTime(level * 0.55, t + 0.014); g.exponentialRampToValueAtTime(0.0001, t + 0.07 + Math.random() * 0.04);       // the ring
    src.connect(hp).connect(bp).connect(env).connect(dst); src.start(t, Math.random() * 2.4); src.stop(t + 0.13);
  }
  // A studio audience: some two dozen people, each clapping at their own steady pace (three to five a second, never quite
  // even) with their own hands; most join in over the first moments and drop out one by one at the end, under a soft wash
  function applause(a, d, t, len, level) {
    noise(a, d, t, { f: 1800, q: 0.4, dur: len, level: level * 0.12, atk: len * 0.2 });       // (too many hands to tell apart)
    const people = Math.round(16 + len * 5);
    for (let p = 0; p < people; p++) {
      const rate = 3 + Math.random() * 2.5, f = 900 + Math.random() * 1700, loud = level * (0.35 + 0.65 * Math.random()) * 2.2 / Math.sqrt(people);
      const from = Math.random() * len * 0.25, to = len * (0.55 + 0.45 * Math.random());
      for (let x = from; x < to; x += (1 / rate) * (0.92 + Math.random() * 0.16)) {
        const edge = Math.min(1, (x - from) / 0.3, (to - x) / 0.4);       // (eases in and out, not on and off)
        clap(a, d, t + x, f * (0.96 + Math.random() * 0.08), loud * Math.max(0.2, edge) * (0.8 + 0.4 * Math.random()));
      }
    }
  }
  // The ball on the wheel: a steady roll round the wooden track, with a pulse each time it goes round and a hiss from the
  // spin, getting slower, quieter and darker as it loses speed; then it falls off the track, clatters over the metal
  // diamonds, and (at the result) drops into a pocket (rlDrop)
  function ballRoll(a, dst, t, len, level) {
    const end = t + len;
    const src = a.createBufferSource(), bp = a.createBiquadFilter(), lo = a.createBiquadFilter(), am = a.createGain(), env = a.createGain(), lfo = a.createOscillator(), depth = a.createGain();
    src.buffer = noiseOf(a); src.loop = true;
    bp.type = 'bandpass'; bp.Q.value = 2.2; bp.frequency.setValueAtTime(3200, t); bp.frequency.exponentialRampToValueAtTime(1300, end);       // the roll: bright, then darker as it slows
    lo.type = 'lowpass'; lo.frequency.value = 6000;
    lfo.frequency.setValueAtTime(3.4, t); lfo.frequency.exponentialRampToValueAtTime(1.1, end);       // once a lap, slowing
    depth.gain.value = 0.35; am.gain.value = 0.65; lfo.connect(depth).connect(am.gain);
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(level, t + 0.25); env.gain.linearRampToValueAtTime(level * 0.55, t + len * 0.8); env.gain.exponentialRampToValueAtTime(0.0001, end);
    src.connect(bp).connect(lo).connect(am).connect(env).connect(dst);
    src.start(t); lfo.start(t); src.stop(end + 0.05); lfo.stop(end + 0.05);
    const rumble = a.createBufferSource(), rb = a.createBiquadFilter(), re = a.createGain();       // the wheel's wooden body under it
    rumble.buffer = noiseOf(a); rumble.loop = true; rb.type = 'lowpass'; rb.frequency.value = 320;
    re.gain.setValueAtTime(0, t); re.gain.linearRampToValueAtTime(level * 0.9, t + 0.3); re.gain.exponentialRampToValueAtTime(0.0001, end);
    rumble.connect(rb).connect(re).connect(dst); rumble.start(t, 0.7); rumble.stop(end + 0.05);
    for (const [dt, l] of [[len - 0.55, 1], [len - 0.38, 0.7], [len - 0.2, 0.45]]) {       // off the track: over the diamonds, clack, clack, clack
      noise(a, dst, t + dt, { f: 4200, q: 6, dur: 0.03, level: level * 1.6 * l });
      voice(a, dst, t + dt, { f: 2900 + Math.random() * 300, dur: 0.05, level: level * 0.25 * l, atk: 0.001, partials: [[2.3, 0.4, 0.4]] });
    }
  }
  // a woodblock (the clock's last seconds)
  const block = (a, d, t, f, level) => { voice(a, d, t, { f, dur: 0.07, level, atk: 0.001, partials: [[2.7, 0.3, 0.3]] }); noise(a, d, t, { f: f * 2, q: 5, dur: 0.025, level: level * 0.6 }); };
  const E4 = 329.63, E5 = 659.25, G3 = 196.0;

  // ---- the card tables' moods: Blackjack, Roulette and Hold'em played like a spectator sport ----
  // Not a crowd's voices (synthesised ones come out eerie) but the feeling a crowd would give, in music: a win is bright and
  // climbing, a loss deflates, a big moment swells, and a wait has a heartbeat under it. The claps stay: hands, not voices.
  // a win: a brass stab, a sparkle running up over it, and hands
  const celebrate = (a, d, t, len, level) => {
    chord(a, d, t, [N.C4, N.G4, N.C5, E5], 0.4, level * 0.09);
    [N.C5, E5, N.G5, N.C6, 1318.5, N.G6].forEach((f, i) => bell(a, d, t + 0.08 + i * 0.05, f, level * (0.35 - i * 0.03), 0.7));
    noise(a, d, t + 0.1, { f: 8000, q: 0.6, dur: 0.9, level: level * 0.12, atk: 0.2 });       // (a shimmer over it)
    applause(a, d, t + 0.15, len, level * 0.7);
  };
  // a loss: a soft muted horn, "wah-wahh", sliding down and sagging (gentle: a shrug of bad luck, not a joke at you)
  const deflate = (a, d, t, len, level) => {
    voice(a, d, t, { f: N.G4 / 2, dur: 0.26, level: level * 0.55, atk: 0.03, type: 'sawtooth', cut: 1100, partials: [[2, 0.1, 0.4]] });       // (low: an octave under the win's notes)
    voice(a, d, t + 0.28, { f: E4 / 2, f2: N.C4 / 2 * 0.94, glide: len * 0.55, dur: len - 0.28, level: level * 0.6, atk: 0.04, type: 'sawtooth', cut: 900, cut2: 350, vib: 0.02 });
  };
  // a big moment (all in, a bust): a held chord swelling and climbing, then let go
  const rise = (a, d, t, len, level) => {
    for (const f of [N.C4, 349.23, N.G4, N.C5]) voice(a, d, t, { f, f2: f * 1.12, glide: len, dur: len, atk: len * 0.7, level: level * 0.22, type: 'triangle', vib: 0.008, cut: 3000 });
    noise(a, d, t, { f: 3000, q: 0.5, dur: len, level: level * 0.25, atk: len * 0.85 });       // (rushing up with it)
  };
  // a wait (the wheel going round, the river coming): a low heartbeat, quickening, under a quiet held pad
  const suspense = (a, d, t, len, level) => {
    for (let x = 0.1, gap = 0.85; x < len - 0.2; x += gap, gap = Math.max(0.42, gap * 0.9)) {
      for (const [dt, l] of [[0, 1], [0.16, 0.7]]) voice(a, d, t + x + dt, { f: 70, f2: 48, glide: 0.1, dur: 0.16, level: level * l, atk: 0.004 });       // lub-dub
    }
    for (const f of [N.C4 / 2, N.G4 / 2, N.D4]) voice(a, d, t, { f, f2: f * 1.03, glide: len, dur: len, atk: len * 0.5, level: level * 0.12, type: 'triangle', cut: 1200 });
  };
  // the winnings counting up on the table (renderer/roll.js): a tick for each step, on the same easing (quick, then slowing
  // into the total), climbing as it goes, and a ding when it lands
  function tally(a, d, t, dur, level) {
    level *= 2;       // (to come through the celebration over it)
    for (let i = 1, n = 22; i <= n; i++) {
      const x = 1 - Math.pow(1 - i / n, 1 / 3);       // (when the number's i/n of the way there: roll.js eases 1 - (1 - x)^3)
      voice(a, d, t + x * dur, { f: 1500 + i * 45, dur: 0.035, level: level * (0.5 + 0.5 * i / n), atk: 0.001, partials: [[2.4, 0.3, 0.3]] });
    }
    bell(a, d, t + dur + 0.02, N.C7, level * 0.9, 0.6);
  }
  // a stadium air horn: three blasts' worth of brass in one, held
  function horn(a, dst, t, dur, level) {
    const env = a.createGain(), lp = a.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 2;
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(level, t + 0.02); env.gain.setValueAtTime(level, t + dur - 0.06); env.gain.linearRampToValueAtTime(0, t + dur);
    env.connect(lp).connect(dst);
    for (const [f, c] of [[233, -6], [233, 6], [466, 0], [349, 3]]) { const o = a.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = c; o.connect(env); o.start(t); o.stop(t + dur + 0.02); }
  }
  // chips: one clay chip on another (a little different each time), a stack of them dropped, a stack pushed over the felt
  const chipAt = (a, d, t, level, f) => { voice(a, d, t, { f, dur: 0.05, level: 0.16 * level, atk: 0.001, partials: [[1.47, 0.6, 0.6]] }); noise(a, d, t, { f: f * 1.33, q: 3, dur: 0.03, level: 0.35 * level }); };
  const chips = (a, d, t, n, level) => { for (let i = 0; i < n; i++) chipAt(a, d, t + i * (0.035 + Math.random() * 0.025), level * (1 - i * 0.04), 2700 + Math.random() * 900); };
  const slide = (a, d, t, level) => { noise(a, d, t, { f: 900, q: 0.6, dur: 0.38, level: level * 0.4, atk: 0.14 }); chips(a, d, t + 0.3, 4, level * 0.8); };
  // a riffle shuffle: the two halves flicking together (quick, then quicker), the bridge falling back, squared up with two taps
  function riffle(a, d, t, level) {
    for (let i = 0, n = 44; i < n; i++) noise(a, d, t + 0.75 * Math.pow(i / n, 0.8), { f: 2800 + Math.random() * 1400, q: 2, dur: 0.012, level: level * (0.5 + 0.5 * Math.random()) });
    noise(a, d, t, { f: 2200, q: 0.6, dur: 0.75, level: level * 0.15, atk: 0.05 });
    noise(a, d, t + 0.8, { f: 1600, q: 0.4, dur: 0.32, level: level * 0.5, atk: 0.22 });
    for (const dt of [1.15, 1.27]) noise(a, d, t + dt, { f: 480, q: 1.2, dur: 0.05, level: level * 0.8 });
  }
  // a card sliding off the shoe and landing on the felt (the chips are with the tables' crowd, below)
  const card = (a, d, t, level = 1) => { noise(a, d, t, { f: 2400, q: 0.8, dur: 0.06, level: 0.5 * level, atk: 0.012 }); noise(a, d, t + 0.05, { f: 900, q: 1.2, dur: 0.05, level: 0.7 * level }); };

  // ---- the sounds ----
  const SOUNDS = {
    // you: into the hub's voice room, out of it
    join: (a, d, t) => { mallet(a, d, t, N.G4, 0.7); mallet(a, d, t + 0.085, N.C5, 0.8, 0.6); bell(a, d, t + 0.085, N.C6, 0.08, 0.6); },
    leave: (a, d, t) => { mallet(a, d, t, N.C5, 0.7, 0.4, 4500); mallet(a, d, t + 0.1, N.G4, 0.75, 0.45, 2800); },
    // someone else came into the voice room you're in, or left it (also: a friend joined or left what you're sharing)
    peerJoin: (a, d, t) => glide(a, d, t, N.G5, N.C6, 0.42, 0.28),
    peerLeave: (a, d, t) => glide(a, d, t, N.C6, N.G5, 0.36, 0.3, 3500),
    // your microphone: a cap going on, coming off
    mute: (a, d, t) => voice(a, d, t, { f: N.G5, f2: N.C5, glide: 0.07, dur: 0.14, level: 0.5, type: 'triangle', cut: 5000, cut2: 600 }),
    unmute: (a, d, t) => voice(a, d, t, { f: N.C5, f2: N.G5, glide: 0.06, dur: 0.14, level: 0.5, type: 'triangle', cut: 900, cut2: 6500 }),
    // you: online in a hub (an open chord blooming: C G C D), offline by choice, and dropped without asking
    connect: (a, d, t) => { mallet(a, d, t, N.C4, 0.55, 1.0); mallet(a, d, t + 0.06, N.G4, 0.5, 1.0); mallet(a, d, t + 0.12, N.C5, 0.5, 1.1); bell(a, d, t + 0.18, N.D5, 0.12, 1.2); },
    disconnect: (a, d, t) => { mallet(a, d, t, N.C5, 0.45, 0.6, 4000); mallet(a, d, t + 0.09, N.G4, 0.45, 0.6, 3000); mallet(a, d, t + 0.18, N.C4, 0.5, 0.8, 2000); },
    lost: (a, d, t) => { voice(a, d, t, { f: N.G4, f2: N.D4, glide: 0.32, dur: 0.5, level: 0.5, vib: 0.03, cut: 3000, partials: [[2, 0.1, 0.4]] });
      voice(a, d, t + 0.24, { f: N.G4 / 2, f2: N.D4 / 2, glide: 0.32, dur: 0.55, level: 0.35, vib: 0.03, cut: 1800 }); },
    // you went live, and stopped (bright, quick and upward: on air)
    liveOn: (a, d, t) => { mallet(a, d, t, N.C4, 0.4, 0.8); [N.G4, N.C5, N.G5, N.C6].forEach((f, i) => bell(a, d, t + i * 0.055, f, 0.18 + i * 0.03, 0.85, 4500)); },       // (topped at C6, overtones rounded off: bright without being shrill)
    liveOff: (a, d, t) => { [N.C6, N.G5, N.C5].forEach((f, i) => bell(a, d, t + i * 0.07, f, 0.18, 0.6)); },
    // someone started or stopped watching your broadcast (a glass clink, small enough not to interrupt you)
    viewerJoin: (a, d, t) => { bell(a, d, t, N.G6, 0.12, 0.4); bell(a, d, t + 0.045, N.C7, 0.07, 0.35); },
    viewerLeave: (a, d, t) => voice(a, d, t, { f: N.C7, f2: N.G6, glide: 0.06, dur: 0.3, level: 0.1, cut: 4000, partials: [[2.76, 0.15, 0.3]] }),
    // someone else in your hub went live (a two-note doorbell: worth looking up for)
    bcStart: (a, d, t) => { bell(a, d, t, N.C6, 0.28, 1.1); bell(a, d, t + 0.18, N.G5, 0.3, 1.4); },
    // you started watching together, or it ended
    shareOn: (a, d, t) => { [N.G4, N.C5, N.G5].forEach((f, i) => mallet(a, d, t + i * 0.07, f, 0.5, 0.5)); },
    shareOff: (a, d, t) => { [N.G5, N.C5, N.G4].forEach((f, i) => mallet(a, d, t + i * 0.07, f, 0.45, 0.45, 4000)); },
    // a new message you aren't looking at: a water drop, and its echo a fifth up (low and round, a "bloop" rather than a ping)
    message: (a, d, t) => { voice(a, d, t, { f: N.C5, f2: N.G5, glide: 0.03, dur: 0.2, level: 0.45, cut: 4000, partials: [[2, 0.15, 0.3]] });
      voice(a, d, t + 0.09, { f: N.G5, f2: N.C6, glide: 0.025, dur: 0.16, level: 0.16, cut: 4000 }); },
    // ---- the Blackjack table (main.js bjSounds picks them from what changed on it) ----
    // a card dealt; the opening deal (two each round the table, a few quick ones); a bet going down
    // Blackjack, Roulette and Hold'em are played like a spectator sport: the moods a crowd would give (a celebration, a
    // deflating horn, a swell, a heartbeat), an air horn for the big wins, and real-sounding chips and cards (main.js
    // bjSounds and GM_SOUNDS pick them)
    bjCard: (a, d, t) => card(a, d, t),
    bjDeal: (a, d, t) => { for (let i = 0; i < 4; i++) card(a, d, t + i * 0.12, 0.85 + 0.15 * (i % 2)); },
    // the shoe running low: shuffled (a riffle, the bridge, squared up), then the deal
    bjShuffle: (a, d, t) => { riffle(a, d, t, 0.55); for (let i = 0; i < 4; i++) card(a, d, t + 1.45 + i * 0.12, 0.85 + 0.15 * (i % 2)); },
    // a bet down: a few chips onto the felt
    bjChip: (a, d, t) => chips(a, d, t, 3, 1),
    // your turn, or the dealer asking about insurance: two soft notes up, a nudge rather than an alarm
    bjTurn: (a, d, t) => { mallet(a, d, t, N.G4, 0.45, 0.35, 4000); mallet(a, d, t + 0.08, N.C5, 0.5, 0.45, 4500); },
    // how your hand went: a win, a bright stab, a sparkle and hands, and the chips come over; blackjack, the air horn too; a
    // push, two even notes (a shrug); a loss, a horn's soft "wah-wahh"; a bust, a thud and a falling "bwoop"
    bjWin: (a, d, t) => { celebrate(a, d, t, 1.6, 0.5); slide(a, d, t + 0.2, 0.9); tally(a, d, t + 0.05, 1.3, 0.1); },       // (tally: the winnings counting up)
    bjBlackjack: (a, d, t) => { horn(a, d, t, 0.7, 0.12); celebrate(a, d, t + 0.1, 2.2, 0.65); chips(a, d, t + 0.5, 8, 0.9); tally(a, d, t + 0.05, 1.4, 0.1); },
    bjPush: (a, d, t) => { mallet(a, d, t, N.C5, 0.45, 0.35, 4000); mallet(a, d, t + 0.16, N.C5, 0.4, 0.45, 3500); },
    bjLose: (a, d, t) => deflate(a, d, t, 1.1, 0.55),
    bjBust: (a, d, t) => { noise(a, d, t, { f: 180, q: 0.9, dur: 0.12, level: 0.6 }); voice(a, d, t + 0.05, { f: 700, f2: 160, glide: 0.4, dur: 0.45, level: 0.35, cut: 2500, partials: [[2, 0.15, 0.4]] }); },
    // out of chips (a longer sag, the line dropping) and back in with a fresh stack (chips stacked, a small celebration)
    bjOut: (a, d, t) => { deflate(a, d, t, 1.5, 0.6); voice(a, d, t + 0.5, { f: N.C4 / 4, f2: N.C4 * 0.235, glide: 0.5, dur: 0.9, level: 0.3, vib: 0.02, cut: 600 }); },       // (the sag an octave under the horn's)
    bjBack: (a, d, t) => { chips(a, d, t, 6, 0.9); celebrate(a, d, t + 0.2, 1, 0.35); },
    // ---- Roulette and Hold'em (main.js GM_SOUNDS; they share the cards, chips and moods above) ----
    // the ball sent round: flicked onto the track, rolling round it slower and slower, over the diamonds at the end, with
    // a heartbeat under it (the spin is 6 s; it lands with rlDrop)
    rlSpin: (a, d, t) => { noise(a, d, t, { f: 2500, q: 3, dur: 0.04, level: 0.4 }); ballRoll(a, d, t + 0.02, 5.4, 0.3); suspense(a, d, t + 0.4, 4.8, 0.13); },
    // the ball dropping into a pocket: a few bounces off the frets, quicker and quieter, and a soft settle
    rlDrop: (a, d, t) => { [0, 0.13, 0.22, 0.28, 0.32].forEach((dt, i) => { noise(a, d, t + dt, { f: 3600, q: 5, dur: 0.025, level: 0.42 - i * 0.07 }); voice(a, d, t + dt, { f: 2400 + i * 90, dur: 0.04, level: 0.06 - i * 0.008, atk: 0.001 }); }); noise(a, d, t + 0.36, { f: 900, q: 1, dur: 0.08, level: 0.2 }); },
    // a win on the wheel: the celebration and chips pushed over; a big one (ten times what you bet or more): the air horn too
    rlWin: (a, d, t) => { celebrate(a, d, t, 1.6, 0.5); slide(a, d, t + 0.25, 0.9); tally(a, d, t + 0.05, 1.3, 0.1); },
    rlBig: (a, d, t) => { horn(a, d, t, 0.9, 0.12); celebrate(a, d, t + 0.1, 2.6, 0.7); chips(a, d, t + 0.4, 12, 0.9); tally(a, d, t + 0.05, 1.6, 0.1); },
    // a check: two knuckles on the table's wood; a fold: cards slid back face down
    pkCheck: (a, d, t) => { for (const dt of [0, 0.11]) { noise(a, d, t + dt, { f: 260, q: 1.6, dur: 0.07, level: 0.7 }); voice(a, d, t + dt, { f: 140, dur: 0.08, level: 0.22, atk: 0.002 }); } },
    pkFold: (a, d, t) => { noise(a, d, t, { f: 1800, q: 0.7, dur: 0.16, level: 0.32, atk: 0.04 }); noise(a, d, t + 0.1, { f: 1100, q: 1, dur: 0.07, level: 0.3 }); },
    // a new hand: the deck shuffled, then two cards round the table
    pkShuffle: (a, d, t) => { riffle(a, d, t, 0.55); for (let i = 0; i < 6; i++) card(a, d, t + 1.45 + i * 0.1, 0.8 + 0.2 * (i % 2)); },
    // a raise (a stack of chips, then pushed in); all in (everything shoved in, and a chord swelling up)
    pkRaise: (a, d, t) => { chips(a, d, t, 6, 1); noise(a, d, t + 0.25, { f: 900, q: 0.6, dur: 0.22, level: 0.3, atk: 0.08 }); },
    pkAllIn: (a, d, t) => { slide(a, d, t, 1); chips(a, d, t + 0.1, 8, 0.8); rise(a, d, t + 0.25, 1.4, 0.55); },
    // the river, the last card: dealt, with a heartbeat under it
    pkRiver: (a, d, t) => { card(a, d, t); suspense(a, d, t + 0.05, 1.6, 0.3); },
    // the pot pushed to someone else (a slide and polite applause); a big pot of yours, someone all in: the horn and the celebration
    pkPot: (a, d, t) => { slide(a, d, t, 0.8); applause(a, d, t + 0.2, 1.2, 0.25); },
    pkBig: (a, d, t) => { horn(a, d, t, 0.7, 0.12); celebrate(a, d, t + 0.1, 2.2, 0.65); slide(a, d, t + 0.3, 1); chips(a, d, t + 0.6, 8, 0.8); tally(a, d, t + 0.05, 1.6, 0.1); },
    // ---- Sketch & Guess (main.js GM_SOUNDS): a game show, so loud and proud, with brass, drums and a studio audience ----
    // a new game: a drumroll into a brass chord and a cymbal
    skStart: (a, d, t) => { roll(a, d, t, 0.6, 0.35); chord(a, d, t + 0.62, [N.C4, E4, N.G4, N.C5], 0.9, 0.05); crash(a, d, t + 0.62, 0.3); snare(a, d, t + 0.62, 0.4); },
    // a new round (the second, the third...): a short snare roll, "da-DUM" and a cymbal
    skRound: (a, d, t) => { roll(a, d, t, 0.32, 0.3); chord(a, d, t + 0.34, [N.G4, N.D5], 0.14, 0.055); chord(a, d, t + 0.52, [N.C4, N.C5, N.G5], 0.6, 0.05); snare(a, d, t + 0.52, 0.4); crash(a, d, t + 0.52, 0.22, 1.1); },
    // the drawer picked the word, so the drawing starts: lock it in (a quick rise into a bright stab and a ding)
    skPick: (a, d, t) => { voice(a, d, t, { f: 300, f2: 900, glide: 0.16, dur: 0.18, level: 0.3, atk: 0.02, cut: 4000 }); noise(a, d, t, { f: 3000, q: 0.5, dur: 0.18, level: 0.15, atk: 0.15 });
      chord(a, d, t + 0.17, [N.G4, N.C5, E5], 0.28, 0.055); bell(a, d, t + 0.17, N.C6, 0.2, 0.6); },
    // your turn to draw: "ta-DAA!"
    skTurn: (a, d, t) => { chord(a, d, t, [N.G4, N.D5], 0.12, 0.06); chord(a, d, t + 0.15, [N.C5, E5, N.G5], 0.55, 0.055); snare(a, d, t + 0.15, 0.35); },
    // you guessed it: ding-ding-DING, a brass hit and a burst of applause
    skRight: (a, d, t) => { bell(a, d, t, N.C6, 0.3, 0.5); bell(a, d, t + 0.1, N.C6, 0.3, 0.5); bell(a, d, t + 0.2, N.G6, 0.25, 0.9);
      chord(a, d, t + 0.3, [N.C5, E5, N.G5], 0.45, 0.05); applause(a, d, t + 0.35, 1.3, 0.35); },
    // someone else guessed it: ding-ding
    skOther: (a, d, t) => { bell(a, d, t, N.G5, 0.25, 0.45); bell(a, d, t + 0.09, N.C6, 0.25, 0.7); },
    // so close: a slide whistle going up ("ooh!")
    skClose: (a, d, t) => voice(a, d, t, { f: 520, f2: 1250, glide: 0.32, dur: 0.42, level: 0.35, atk: 0.03, vib: 0.015, cut: 5000, partials: [[2, 0.08, 0.5]] }),
    // a letter shown (a hint): a quick pop and a sparkle
    skHint: (a, d, t) => { voice(a, d, t, { f: 700, f2: 1500, glide: 0.06, dur: 0.1, level: 0.35, atk: 0.003 }); bell(a, d, t + 0.06, N.C7, 0.12, 0.4); },
    // the clock's last ten seconds (the last one higher)
    skTick: (a, d, t) => block(a, d, t, 1200, 0.45),
    skTick1: (a, d, t) => block(a, d, t, 1800, 0.5),
    // time's up: the buzzer
    skEnd: (a, d, t) => buzzer(a, d, t, 0.75, 0.22),
    // everyone got it before the time ran out: a brass hit, a cymbal and the audience
    skAll: (a, d, t) => { chord(a, d, t, [N.C4, N.G4, N.C5, E5], 0.7, 0.05); crash(a, d, t, 0.3); snare(a, d, t, 0.4); applause(a, d, t + 0.1, 1.8, 0.4); },
    // the end of a game. You won: a fanfare (da-da-da DAAA), a cymbal and a standing ovation; somewhere in the middle: a
    // round of applause; last: the sad trombone (wah, wah, wah, waaah)
    skWin: (a, d, t) => { [0, 0.13, 0.26].forEach((dt) => chord(a, d, t + dt, [N.G4, N.D5], 0.1, 0.055)); chord(a, d, t + 0.4, [N.C4, N.G4, N.C5, E5, N.G5], 1.3, 0.045, { vib: 0.006 });
      crash(a, d, t + 0.4, 0.32, 1.8); snare(a, d, t + 0.4, 0.4); applause(a, d, t + 0.5, 2.6, 0.45); },
    skApplause: (a, d, t) => { chord(a, d, t, [N.C5, E5, N.G5], 0.4, 0.045); applause(a, d, t + 0.05, 2, 0.4); },
    skLose: (a, d, t) => { [G3, 185.0, 174.61].forEach((f, i) => brass(a, d, t + i * 0.42, f, 0.36, 0.11, { bright: 1300 })); brass(a, d, t + 1.26, 164.81, 1.2, 0.11, { bright: 1300, vib: 0.025 }); },
    // ---- Pachinko (main.js GM_SOUNDS for the reels and the fever; paBallSounds for your own balls, timed to what you see) ----
    // a ball away: the spring's flick and a small thunk; a pin: the tiniest steel tick, a little different each time
    paLaunch: (a, d, t) => { noise(a, d, t, { f: 3200, q: 2, dur: 0.03, level: 0.3 }); voice(a, d, t, { f: 190, f2: 95, glide: 0.05, dur: 0.08, level: 0.14, atk: 0.002 }); },
    paPin: (a, d, t) => { noise(a, d, t, { f: 5200 + Math.random() * 1200, q: 6, dur: 0.014, level: 0.25 }); voice(a, d, t, { f: 3000 + Math.random() * 600, dur: 0.03, level: 0.025, atk: 0.001 }); },
    // the trampoline throwing a ball back up: a springy "boing" (a rising note that wobbles as the mat settles)
    paBounce: (a, d, t) => { voice(a, d, t, { f: 180, f2: 420, glide: 0.09, dur: 0.26, level: 0.3, atk: 0.004, vib: 0.06, cut: 2600, partials: [[2, 0.12, 0.4]] }); noise(a, d, t, { f: 700, q: 1.2, dur: 0.04, level: 0.18 }); },
    // into the start pocket (a bright chime, the reels' cue), a tulip (two notes up), the gate in a fever (a ding and a few chips)
    paStart: (a, d, t) => { bell(a, d, t, N.C6, 0.25, 0.5); bell(a, d, t + 0.06, N.G6, 0.18, 0.6); },
    paTulip: (a, d, t) => { mallet(a, d, t, N.G5, 0.4, 0.3, 5000); mallet(a, d, t + 0.07, N.C6, 0.4, 0.4, 5000); },
    paCatch: (a, d, t) => { bell(a, d, t, N.G5, 0.22, 0.4); chips(a, d, t + 0.04, 2, 0.8); },
    // the reels going round: a whirr of clicks, quick and slowing
    paSpin: (a, d, t) => { let x = 0; for (let i = 0; i < 16; i++) { noise(a, d, t + x, { f: 2400, q: 3, dur: 0.02, level: 0.2 - i * 0.008 }); x += 0.05 + i * 0.006; } },
    // a reach: two alike, the third slowing: a rise with the heartbeat under it. It missed: the sag; it hit: the fever
    paReach: (a, d, t) => { rise(a, d, t, 2.6, 0.5); suspense(a, d, t, 2.6, 0.22); },
    paMiss: (a, d, t) => deflate(a, d, t, 0.9, 0.42),
    paFever: (a, d, t) => { horn(a, d, t, 0.8, 0.12); celebrate(a, d, t + 0.1, 2.4, 0.65); [N.C6, N.G6, N.C7].forEach((f, i) => bell(a, d, t + 0.15 + i * 0.09, f, 0.16, 0.7)); },
    // the gate swinging open for a round (a clank and three notes up)
    paGate: (a, d, t) => { noise(a, d, t, { f: 420, q: 1.2, dur: 0.1, level: 0.5 }); [N.C5, N.G5, N.C6].forEach((f, i) => mallet(a, d, t + 0.05 + i * 0.07, f, 0.4, 0.4, 5000)); },
    // the fever over, your winnings in the tray: balls pouring down, and the count running up
    paPay: (a, d, t) => { for (let i = 0; i < 26; i++) noise(a, d, t + i * 0.045 + Math.random() * 0.02, { f: 4200 + Math.random() * 1800, q: 5, dur: 0.02, level: 0.22 }); tally(a, d, t, 1.3, 0.1); celebrate(a, d, t + 0.2, 1.2, 0.4); },
  };
  // How loud each is against the others (measured, then by ear): your own actions peak around -7 dBFS at full volume, other
  // people's news a few dB under, the clinks lowest because they sit where the ear is keenest, and a dropped connection a
  // little over, so it isn't missed. Peaks at volume 1 in the comments.
  const LEVEL = { join: 0.85 /* .43 */, leave: 0.85 /* .40 */, connect: 0.9 /* .42 */, disconnect: 1.05 /* .37 */, shareOn: 1.1 /* .37 */, shareOff: 1.2 /* .34 */,
    mute: 1.15 /* .27 */, unmute: 1.15 /* .27 */, peerJoin: 1.1 /* .25 */, peerLeave: 1.15 /* .23 */, lost: 1.25 /* .33 */,
    liveOn: 1.2 /* .40 */, liveOff: 2 /* .28 */, viewerJoin: 1.8 /* .15 */, viewerLeave: 2 /* .12 */, bcStart: 1.3 /* .30 */, message: 1.1 /* .27 */,
    // the tables (a spectator sport): cards, chips and shuffles low, a texture (~.2); your turn a nudge like a friend arriving;
    // how a hand went as loud as your own actions or a little over: a win ~.40, the big ones (blackjack, ten times your
    // bet, a big pot) ~.47, a loss or a bust ~.35, a push lower
    bjCard: 1.15 /* .2 (noise: each a little different) */, bjDeal: 1.1 /* .2 */, bjShuffle: 1.53 /* .22 */, bjChip: 1.26 /* .2 */, bjTurn: 0.77 /* .25 */,
    bjWin: 1.86 /* .40 */, bjBlackjack: 1.43 /* .47 */, bjPush: 0.94 /* .25 */, bjLose: 2.23 /* .35 */, bjBust: 1.75 /* .35 */, bjOut: 2.2 /* .38 */, bjBack: 2.13 /* .33 */,
    rlSpin: 2.03 /* .21-.25 (the roll, the diamonds' clacks, the heartbeat under them) */, rlDrop: 2.9 /* .2 */, rlWin: 1.91 /* .40 */, rlBig: 1.31 /* .47 */,
    pkCheck: 1.3 /* .15 */, pkFold: 1.4 /* .15 */, pkShuffle: 1.24 /* .22 */, pkRaise: 1.32 /* .22 */, pkAllIn: 1.68 /* .40 */, pkRiver: 1.11 /* .22 */, pkPot: 2.74 /* .25 */, pkBig: 1.3 /* .47 */,
    // Sketch & Guess: a game show, so the big moments (a game starting, your right guess, everyone getting it, winning) a
    // little over your own actions, the end of a game and the buzzer with them, someone else's guess, hints and the clock lower
    skStart: 1.5 /* .45 */, skRound: 1.6 /* .42 */, skPick: 2.25 /* .38 */, skTurn: 2.7 /* .38 */, skRight: 2.3 /* .45 */, skOther: 1.7 /* .26 */, skClose: 1.75 /* .32 */, skHint: 1.45 /* .25 */,
    skTick: 0.83 /* .22 */, skTick1: 0.92 /* .26 */, skEnd: 1.3 /* .35 */, skAll: 1.55 /* .45 */, skWin: 1.5 /* .48 */, skApplause: 4 /* .38 */, skLose: 3.5 /* .38 */,
    // Pachinko: your balls' launches and pins a quiet texture under everything (they come often), a pocket like a chip, the
    // reels and the gate like your turn, a reach, the fever and its payout with the tables' wins. (Set to sit with their
    // neighbours here; not yet measured like the others.)
    paLaunch: 0.9, paPin: 0.8, paBounce: 1.1, paStart: 1.5, paTulip: 1.1, paCatch: 1.3, paSpin: 1.6, paReach: 1.5, paMiss: 1.9, paFever: 1.4, paGate: 1.5, paPay: 1.6 };

  // The way out: a small dark room (1.4 s, low in the mix). No compressor: Chromium's blunts the first few milliseconds of
  // a short sound (it took 60% off the mute click's peak), and the levels here are set by hand to stay well under full scale.
  function chain(a) {
    const dry = a.createGain(), rev = a.createConvolver(), wet = a.createGain(), dark = a.createBiquadFilter();
    const len = Math.floor(a.sampleRate * 1.4), ir = a.createBuffer(2, len, a.sampleRate);
    for (let c = 0; c < 2; c++) { const x = ir.getChannelData(c); for (let i = 0; i < len; i++) x[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4); }
    rev.buffer = ir; wet.gain.value = 0.16; dark.type = 'lowpass'; dark.frequency.value = 3200;
    dry.connect(a.destination); dry.connect(wet); wet.connect(rev).connect(dark).connect(a.destination);
    return dry;
  }
  // play(a, dst, name, at, vol): for main use and for checks with an OfflineAudioContext
  function play(a, dst, name, at, vol) {
    if (!SOUNDS[name] || !(vol > 0)) return;
    const g = a.createGain(); g.gain.value = Math.min(1, vol) * 0.5 * LEVEL[name]; g.connect(dst);
    SOUNDS[name](a, g, at);
  }
  window.driftSfx = { play, chain, names: Object.keys(SOUNDS) };

  const api = window.drift;
  if (!api) return;       // (loaded for a check, without Drift around it)
  let ctx = null, out = null;
  const last = {};
  api.on('cmd', (c) => {
    if (c.type !== 'sfx' || !Array.isArray(c.names)) return;
    if (!ctx) { ctx = new AudioContext({ latencyHint: 'interactive' }); out = chain(ctx); }
    if (ctx.state === 'suspended') ctx.resume();
    const now = performance.now();
    c.names.filter((n) => SOUNDS[n] && !(now - (last[n] || 0) < 150)).slice(0, 2).forEach((n, i) => {       // never the same one twice at once, at most two together
      last[n] = now;
      play(ctx, out, n, ctx.currentTime + 0.01 + i * 0.16, +c.vol);
    });
  });
})();
