/* Drift — Hub sounds: joining and leaving a hub and its voice room, muting, going live, friends coming and going,
   and new messages. They're made here with Web Audio, nothing is a recording, and they play in the hidden audio window
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
     the same air as the ambient music. */
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
  };
  // How loud each is against the others (measured, then by ear): your own actions peak around -7 dBFS at full volume, other
  // people's news a few dB under, the clinks lowest because they sit where the ear is keenest, and a dropped connection a
  // little over, so it isn't missed. Peaks at volume 1 in the comments.
  const LEVEL = { join: 0.85 /* .43 */, leave: 0.85 /* .40 */, connect: 0.9 /* .42 */, disconnect: 1.05 /* .37 */, shareOn: 1.1 /* .37 */, shareOff: 1.2 /* .34 */,
    mute: 1.15 /* .27 */, unmute: 1.15 /* .27 */, peerJoin: 1.1 /* .25 */, peerLeave: 1.15 /* .23 */, lost: 1.25 /* .33 */,
    liveOn: 1.2 /* .40 */, liveOff: 2 /* .28 */, viewerJoin: 1.8 /* .15 */, viewerLeave: 2 /* .12 */, bcStart: 1.3 /* .30 */, message: 1.1 /* .27 */ };

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
