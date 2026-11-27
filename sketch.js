// Drift — Sketch & Guess, the rules (docs/plans/games-room.md §2.3). A drawing game for a hub (it needs people: there's no
// playing it alone): each turn one player picks a word from three and draws it, everyone else types guesses. Guessing
// sooner scores more, and the drawer scores for each person who gets it. Everyone draws once a round, three rounds a game.
// Pure, like blackjack.js: no Electron, no DOM, no timers of its own. hub.js calls tick() a few times a second and after
// every move, sends view(id) to whoever is looking when version changes, and sends the drawing as it grows (ink(from),
// with inkRev and inkLen: a new turn starts a new drawing), apart from the views, since it changes many times a second.
//
//   const t = createTable({ now, rand, times });  t.sit(id, name)  t.move(id, { do: 'guess', text: 'cat' })  t.tick()
//
// The drawing is a list of operations on a 1600 x 1000 sheet (inkOp): a pen stroke's pieces as it's drawn, a paint-bucket
// fill (a point and a colour: each screen floods the area round it), an undo (the last stroke or fill goes) or a clear. The word never leaves here for anyone but the drawer,
// the people who have guessed it, and everyone once the turn is over.
const RULES = { players: 12, rounds: 3, start: 0 };
const TIMES = { start: 4000, choose: 15000, draw: 80000, reveal: 6000, over: 12000 };       // ms: before a game, picking a word, drawing, the word shown, the final scores
const W = 1600, H = 1000, COLORS = 15, INK_MAX = 6000;
const KINDS = new Set(['pen', 'fill', 'undo', 'clear']);
// Our own words: things anyone can draw, nothing unkind. Mostly a word or three: some everyday things (not the very
// simplest), words made of two (starfish, doorbell), and, the most of all, harder ones: ideas, goings-on, jobs, tricky
// things and a few sayings, that take some cleverness to draw (gravity, echo, once in a blue moon).
const WORDS = `pineapple,strawberry,watermelon,broccoli,mushroom,pumpkin,cupcake,ice cream,sandwich,hot dog,pancake,popcorn,
waffle,taco,noodles,sushi,lemonade,
octopus,flamingo,kangaroo,camel,penguin,parrot,dolphin,giraffe,elephant,zebra,panda,turtle,butterfly,spider,
dinosaur,dragon,unicorn,
castle,igloo,lighthouse,bridge,windmill,skyscraper,hospital,
bicycle,motorcycle,submarine,helicopter,tractor,skateboard,
snowman,rainbow,tornado,volcano,island,waterfall,cactus,palm tree,desert,cave,
ladder,umbrella,scissors,glasses,crown,scarf,backpack,suitcase,wallet,necklace,
keyboard,television,camera,robot,headphones,guitar,piano,trumpet,violin,microphone,
lollipop,teddy bear,yo-yo,puzzle,dice,shovel,toothbrush,mirror,bathtub,teapot,fridge,
anchor,compass,magnet,battery,lightbulb,
alien,pirate,wizard,witch,vampire,mermaid,superhero,knight,clown,astronaut,
fishing,swimming,sleeping,dancing,singing,cooking,painting,
snowflake,bubble,brain,skeleton,trophy,medal,treasure,cannon,
spaceship,comet,telescope,satellite,feather,nest,
snow globe,birthday,campfire,picnic,parachute,hot air balloon,roller coaster,ferris wheel,traffic light,
mailbox,swing,sandcastle,treehouse,doghouse,scarecrow,
zipper,needle,sock puppet,paintbrush,
starfish,jellyfish,swordfish,catfish,firefly,dragonfly,ladybug,grasshopper,earthworm,honeybee,beehive,rattlesnake,bulldog,seahorse,
seashell,seaweed,horseshoe,sunflower,sunglasses,sunrise,sunset,sunburn,moonlight,snowball,snowboard,raincoat,birdhouse,greenhouse,
houseboat,sailboat,fire truck,fireworks,fireplace,football,basketball,baseball,eyeball,eyebrow,earring,toothpaste,hairbrush,
handbag,headband,footprint,fingerprint,keyhole,doorbell,bookshelf,bookworm,notebook,cookbook,paperclip,pinwheel,wheelchair,
wheelbarrow,toolbox,lunchbox,teacup,surfboard,cowboy,railroad,airport,cheeseburger,milkshake,gingerbread,blueberry,peanut,
piggy bank,waterslide,sandstorm,
gravity,shadow,echo,reflection,invisible,nightmare,daydream,electricity,hibernation,evolution,photosynthesis,time machine,
black hole,solar eclipse,northern lights,quicksand,avalanche,earthquake,tsunami,mirage,fossil,blizzard,stampede,migration,
constellation,labyrinth,origami,chandelier,escalator,vending machine,conveyor belt,lawnmower,periscope,metronome,hourglass,
pendulum,kaleidoscope,tuxedo,mustache,goosebumps,brain freeze,hiccup,sneeze,yawn,sleepwalking,homesick,jet lag,traffic jam,
rush hour,deadline,password,recycling,global warming,cliffhanger,bucket list,karaoke,applause,autograph,blindfold,
archaeologist,dentist,plumber,lifeguard,magician,ventriloquist,hypnotist,juggler,tightrope,trampoline,
hide and seek,tug of war,musical chairs,procrastination,multitasking,
jealousy,nostalgia,curiosity,confusion,freedom,friendship,good luck,silence,balance,patience,teamwork,surprise party,
stage fright,brainstorm,comfort zone,
magnetism,static electricity,chain reaction,food chain,water cycle,metamorphosis,camouflage,erosion,sound wave,
rainforest,coral reef,microscope,atom,orbit,meteor shower,space station,zero gravity,wormhole,hologram,
virtual reality,solar panel,wind turbine,power outage,short circuit,
flat tire,power nap,sleepover,family reunion,garage sale,job interview,graduation,wedding,retirement,road trip,
fire drill,spelling bee,science fair,talent show,standing ovation,red carpet,encore,plot twist,happy ending,
haunted house,treasure hunt,scavenger hunt,pillow fight,snowball fight,staring contest,thumb war,high five,bear hug,
cat nap,couch potato,night owl,early bird,copycat,
raining cats and dogs,piece of cake,spill the beans,under the weather,once in a blue moon,elephant in the room,
astronomer,beekeeper,firefighter,zookeeper,blacksmith,lumberjack,referee,conductor,sculptor,surgeon,detective,
mime,puppeteer,scuba diver,stunt double,tailor,locksmith,
thermostat,smoke detector,stethoscope,sundial,abacus,typewriter,gramophone,jukebox,accordion,bagpipes,harp,
xylophone,tambourine,saxophone,binoculars,magnifying glass,crystal ball,treasure map,message in a bottle,
time capsule,snowplow,drawbridge,catapult,mummy,pyramid,sphinx,totem pole,observatory,wind chime,dreamcatcher,
lava lamp,disco ball,bubble wrap,duct tape,safety pin,mousetrap,revolving door,drive through,parking meter,
speed bump,roundabout,toll booth`.split(',').map((w) => w.trim()).filter(Boolean);
const WORD_LIST = [...new Set(WORDS)];
// The settings people can change (main.js keeps them; the table reads them between games): how long each drawing lasts,
// how many rounds (everyone draws once a round), whether letters are shown as the time runs out (hints), and the words,
// null for ours. Anything odd is put back in range; a list
// with fewer than three usable words is no list (ours is used).
const SETTINGS = { draw: 80, rounds: 3, hints: true, words: null };       // draw: seconds
function cleanSettings(s) {
  s = s && typeof s === 'object' ? s : {};
  const int = (v, lo, hi, d) => (Number.isFinite(+v) && v !== '' && v !== null ? Math.max(lo, Math.min(hi, Math.round(+v))) : d);
  let words = null;
  if (Array.isArray(s.words)) {
    const seen = new Set(); words = [];
    for (const w0 of s.words.slice(0, 5000)) {
      const w = String(w0 || '').replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30), n = norm(w);
      if (n && !seen.has(n)) { seen.add(n); words.push(w); }
      if (words.length >= 2000) break;
    }
    if (words.length < 3) words = null;
  }
  return { draw: int(s.draw, 15, 600, SETTINGS.draw), rounds: int(s.rounds, 1, 10, SETTINGS.rounds), hints: s.hints === undefined ? SETTINGS.hints : !!s.hints, words };
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function near(a, b) {       // one letter off (added, missing, changed or two swapped): "so close"
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n] <= 1;
}
// One drawing operation, cleaned: anything off the sheet, too long or of no known kind is refused (null)
function inkOp(o) {
  if (!o || typeof o !== 'object' || !KINDS.has(o.k)) return null;
  const q = Number.isInteger(o.q) && o.q >= 0 && o.q < 1e9 ? o.q : 0;
  if (o.k === 'undo' || o.k === 'clear') return { k: o.k, q };
  const int = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : lo);
  if (!Array.isArray(o.p)) return null;
  const pen = o.k === 'pen';
  if (pen ? o.p.length < 2 || o.p.length > 160 || o.p.length % 2 : o.p.length !== 2) return null;       // (a fill: the one point it pours from)
  const p = o.p.map((v, i) => int(v, 0, i % 2 ? H : W));
  if (!pen) return { k: 'fill', c: int(o.c, 0, COLORS - 1), s: int(o.s, 0, 1e9), p, q };
  const op = { k: o.k, c: int(o.c, 0, COLORS - 1), w: int(o.w, 0, 2), s: int(o.s, 0, 1e9), p, q };
  if (o.e) op.e = 1;
  return op;
}

function createTable(opts = {}) {
  const now = opts.now || (() => Date.now());
  const rand = opts.rand || ((n) => require('crypto').randomInt(n));
  const T = { ...TIMES, ...(opts.times || {}) }, R = { ...RULES, ...(opts.rules || {}) };
  let words = opts.words || WORD_LIST, setRev, useHints = SETTINGS.hints;
  function settle() {       // opts.settings(): { draw, rounds, words, rev }, taken up between games (never in the middle of one)
    const s = opts.settings ? opts.settings() : null;
    if (!s || s.rev === setRev) return;
    setRev = s.rev;
    const c = cleanSettings(s);
    T.draw = c.draw * 1000; R.rounds = c.rounds; words = c.words || opts.words || WORD_LIST; useHints = c.hints;
    changed();
  }
  const players = [];       // { id, name, score, gained, guessed, at (when they guessed), drew (the round they last drew in) }, in the order they came
  const watchers = [];       // [{ id, name }] waiting for a place
  let phase = 'idle', deadline = 0, round = 0, version = 0, drawer = null, word = '', choices = [], hint = [], used = new Set(), feed = [], feedN = 0;
  let ink = [], inkRev = 0, turnAt = 0, lastNote = '', standings = null;

  const changed = () => { version++; };
  const at = (id) => players.findIndex((p) => p.id === id);
  const guessers = () => players.filter((p) => p !== drawer);
  const say = (kind, text, extra = {}) => { feed.push({ n: ++feedN, kind, text: String(text).slice(0, 120), to: 'all', ...extra }); if (feed.length > 80) feed.shift(); changed(); };

  // ------------------------------------------------------------------ places
  function sit(id, name) {
    id = String(id); name = String(name || '').slice(0, 24);
    const i = at(id);
    if (i >= 0) { players[i].name = name; return { seat: i }; }
    if (players.length >= R.players) { if (!watchers.some((w) => w.id === id)) { watchers.push({ id, name }); changed(); } return { watching: true }; }
    players.push({ id, name, score: 0, gained: 0, guessed: false, at: 0, drew: 0 });       // (partway through: they guess from now, and take a turn drawing before this round ends)
    say('join', `${name} joined`);
    if (phase === 'idle') { phase = 'waiting'; deadline = 0; }
    return { seat: players.length - 1 };
  }
  function leave(id) {
    id = String(id);
    const w = watchers.findIndex((x) => x.id === id);
    if (w >= 0) { watchers.splice(w, 1); changed(); }
    const i = at(id); if (i < 0) return;
    const p = players[i];
    players.splice(i, 1);
    say('leave', `${p.name} left`);
    const nw = watchers.shift(); if (nw) sit(nw.id, nw.name);
    if (!players.length) { phase = 'idle'; deadline = 0; drawer = null; ink = []; inkRev++; changed(); return; }
    if (players.length < 2 && phase !== 'waiting') { endGame(true); return; }
    if (p === drawer && (phase === 'choosing' || phase === 'drawing')) { lastNote = `${p.name} left`; reveal(); }
    else if (phase === 'drawing' && guessers().length && guessers().every((g) => g.guessed)) reveal();
  }

  // ------------------------------------------------------------------ the game and its turns
  function startGame() {
    settle();
    round = 1; used = new Set(); standings = null;
    for (const p of players) { p.score = 0; p.gained = 0; p.drew = 0; }
    say('sys', opts.solo ? `Practice: ${R.rounds === 1 ? 'one drawing' : `${R.rounds} drawings`}` : `A new game: ${R.rounds === 1 ? 'one round' : `${R.rounds} rounds`}, everyone draws once a round`);
    nextTurn();
  }
  function nextTurn() {
    for (const p of players) { p.guessed = false; p.gained = 0; p.at = 0; }
    const who = opts.solo ? players.filter((p) => p.id === opts.solo) : players;       // (solo practice: only you draw, once a round)
    let d = who.find((p) => p.drew < round) || null;
    if (!d) {       // everyone has drawn this round (those who came in partway too: they're last in line)
      if (round >= R.rounds) { endGame(false); return; }
      round++;
      d = who.find((p) => p.drew < round) || null;
      if (!d) { endGame(false); return; }
    }
    drawer = d; drawer.drew = round;
    if (words.filter((w) => !used.has(w)).length < 3) used = new Set();       // (a short list of words comes round again)
    const pool = words.filter((w) => !used.has(w)), pick = [];
    while (pick.length < 3 && pool.length) pick.push(pool.splice(rand(pool.length), 1)[0]);
    choices = pick; word = ''; hint = []; lastNote = '';
    ink = []; inkRev++;
    phase = 'choosing'; deadline = now() + T.choose;
    changed();
  }
  function choose(k) {
    word = choices[k]; used.add(word); choices = [];
    hint = [...word].map((ch) => (ch === ' ' || ch === '-' ? ch : null));
    phase = 'drawing'; turnAt = now(); deadline = turnAt + T.draw;
    say('sys', `${drawer.name} is drawing`);
  }
  function reveal() {
    phase = 'reveal'; deadline = now() + T.reveal;
    if (word) say('reveal', `The word was "${word}"`);
    else say('sys', lastNote || 'Nobody drew this turn');
    changed();
  }
  function endGame(early) {
    drawer = null; word = ''; choices = []; ink = []; inkRev++;
    if (early) { say('sys', 'Not enough players: the game stops'); phase = 'waiting'; deadline = 0; standings = null; round = 0; return; }
    standings = players.map((p) => ({ id: p.id, name: p.name, score: p.score })).sort((a, b) => b.score - a.score);
    phase = 'over'; deadline = now() + T.over;
    if (standings.length) say('sys', `${standings[0].name} wins with ${standings[0].score}`);
    changed();
    if (opts.onSettle) try { opts.onSettle(standings.map((s) => ({ id: s.id, name: s.name, score: s.score, net: s.score }))); } catch { /* theirs to get right */ }
  }
  // Hints (a setting, on unless turned off): a letter in a random spot when 60%, 40% and 20% of the time is left, three at
  // most, and never the last two hidden ones, so a short word isn't given away
  function hints(t) {
    if (phase !== 'drawing' || !word || !useHints) return;
    const frac = (t - turnAt) / T.draw, hidden = hint.map((c, i) => (c === null ? i : -1)).filter((i) => i >= 0);
    const want = (frac >= 0.8 ? 3 : frac >= 0.6 ? 2 : frac >= 0.4 ? 1 : 0) - hint.filter((c, i) => c !== null && word[i] !== ' ' && word[i] !== '-').length;
    if (want > 0 && hidden.length > 2) { const i = hidden[rand(hidden.length)]; hint[i] = word[i]; changed(); }
  }

  // ------------------------------------------------------------------ moves
  function guess(p, text) {
    text = String(text || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 60);
    if (!text) return { error: 'Type a guess' };
    if (phase !== 'drawing') { say('chat', text, { who: p.name, pid: p.id }); return { ok: true }; }
    if (p === drawer) return { error: 'You\'re drawing: no clues in words!' };
    if (p.guessed) { say('chat', text, { who: p.name, pid: p.id, to: 'solvers' }); return { ok: true }; }       // (only the drawer and those who know it see these)
    const g = norm(text), w = norm(word);
    if (g === w || g.replace(/ /g, '') === w.replace(/ /g, '')) {
      const left = Math.max(0, deadline - now()) / T.draw, first = !guessers().some((x) => x.guessed);
      const pts = 50 + Math.round(50 * left) + (first ? 10 : 0);
      p.guessed = true; p.at = now(); p.score += pts; p.gained = pts;
      drawer.score += 25; drawer.gained += 25;
      say('right', `${p.name} guessed it!`, { who: p.name, pid: p.id });
      if (guessers().every((x) => x.guessed)) reveal();
      return { ok: true, right: true };
    }
    say('guess', text, { who: p.name, pid: p.id });
    if (w.length >= 4 && near(g, w)) say('close', `"${text}" is very close!`, { to: p.id });
    return { ok: true };
  }
  function move(id, m) {
    m = m && typeof m === 'object' ? m : {};
    const p = players[at(String(id))];
    if (!p) return { error: 'Join the game first' };
    const what = String(m.do || '');
    if (what === 'guess') return guess(p, m.text);
    if (what === 'pick') {
      if (phase !== 'choosing' || p !== drawer) return { error: 'Not your turn to pick' };
      const k = Math.floor(+m.key); if (!(k >= 0 && k < choices.length)) return { error: 'Pick one of the words' };
      choose(k); return { ok: true };
    }
    if (what === 'ink') {       // (the drawing grows: no new version, the hub sends it apart from the views)
      if (phase !== 'drawing' || p !== drawer) return { error: 'Not your turn to draw' };
      const op = inkOp(m.op); if (!op) return { error: 'That isn\'t a drawing' };
      if (ink.length >= INK_MAX) return { error: 'The drawing is full: clear some of it' };
      ink.push(op);
      return { ok: true };
    }
    return { error: 'Not a move' };
  }

  // ------------------------------------------------------------------ time
  function tick() {
    const t = now(), v0 = version;
    if (phase === 'idle' || phase === 'waiting') settle();       // (so the waiting screen already shows the new settings)
    if (phase === 'waiting') {
      if (players.length >= 2) { if (!deadline) { deadline = t + T.start; changed(); } else if (t >= deadline) startGame(); }
      else if (deadline) { deadline = 0; changed(); }
    } else if (deadline && t >= deadline) {
      if (phase === 'choosing') choose(rand(choices.length));       // out of time: one is picked for them
      else if (phase === 'drawing') reveal();
      else if (phase === 'reveal') nextTurn();
      else if (phase === 'over') { phase = 'waiting'; deadline = 0; standings = null; round = 0; for (const p of players) { p.drew = 0; p.gained = 0; } changed(); }
    }
    hints(t);
    return version !== v0;
  }

  // ------------------------------------------------------------------ what someone sees
  function view(id) {
    id = String(id);
    const t = now(), me = at(id), p = players[me], isDrawer = !!p && p === drawer;
    const knows = isDrawer || (p && p.guessed) || phase === 'reveal' || phase === 'over';
    const sees = (e) => e.to === 'all' || e.to === id || (e.to === 'solvers' && knows);
    return {
      phase, round, rounds: R.rounds, msLeft: deadline ? Math.max(0, deadline - t) : 0, drawMs: T.draw, chooseMs: T.choose,
      you: me, watching: watchers.findIndex((w) => w.id === id), watchers: watchers.length,
      drawer: drawer ? at(drawer.id) : -1,
      choices: isDrawer && phase === 'choosing' ? choices.slice() : [],
      word: knows && word ? word : '',
      hint: phase === 'drawing' || phase === 'reveal' ? (knows ? [...word] : hint.slice()) : [],
      players: players.map((x) => ({ id: x.id, name: x.name, score: x.score, gained: x.gained, guessed: x.guessed, drawing: x === drawer })),
      feed: feed.filter(sees).slice(-40),
      standings: standings ? standings.map((s) => ({ ...s })) : null,
      inkRev,
    };
  }

  return {
    sit, leave, move, tick, view, mine: () => null,
    tell: (id, text) => say('sys', text, { to: String(id) }),       // a line in one person's feed only (practice: the word, for whoever's testing)
    ink: (from = 0) => ink.slice(from),
    get inkRev() { return inkRev; }, get inkLen() { return ink.length; },
    get version() { return version; }, get phase() { return phase; },
    seated: () => players.map((x) => x.id),
    _word: () => word,       // (tests)
  };
}

module.exports = { createTable, inkOp, norm, near, cleanSettings, SETTINGS, WORD_LIST, RULES, TIMES, W, H, COLORS };
