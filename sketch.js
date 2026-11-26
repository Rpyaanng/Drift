// Drift — Sketch & Guess, the rules (docs/plans/games-room.md §2.3). A drawing game for a hub (it needs people: there's no
// playing it alone): each turn one player picks a word from three and draws it, everyone else types guesses. Guessing
// sooner scores more, and the drawer scores for each person who gets it. Everyone draws once a round, three rounds a game.
// Pure, like blackjack.js: no Electron, no DOM, no timers of its own. hub.js calls tick() a few times a second and after
// every move, sends view(id) to whoever is looking when version changes, and sends the drawing as it grows (ink(from),
// with inkRev and inkLen: a new turn starts a new drawing), apart from the views, since it changes many times a second.
//
//   const t = createTable({ now, rand, times });  t.sit(id, name)  t.move(id, { do: 'guess', text: 'cat' })  t.tick()
//
// The drawing is a list of operations on a 1600 x 1000 sheet (inkOp): a pen stroke's pieces as it's drawn, a finished line,
// arrow or shape, an undo (the last stroke or shape goes) or a clear. The word never leaves here for anyone but the drawer,
// the people who have guessed it, and everyone once the turn is over.
const RULES = { players: 12, rounds: 3, start: 0 };
const TIMES = { start: 4000, choose: 15000, draw: 80000, reveal: 6000, over: 12000 };       // ms: before a game, picking a word, drawing, the word shown, the final scores
const W = 1600, H = 1000, COLORS = 15, INK_MAX = 6000;
const KINDS = new Set(['pen', 'line', 'arrow', 'rect', 'ellipse', 'diamond', 'triangle', 'undo', 'clear']);
// Our own words: things anyone can draw, nothing unkind. One or two words each.
const WORDS = `apple,banana,cherry,grapes,lemon,pear,pineapple,strawberry,watermelon,carrot,corn,mushroom,pumpkin,potato,broccoli,
bread,cake,cookie,cupcake,donut,ice cream,pizza,sandwich,hot dog,pancake,cheese,egg,popcorn,candy,soup,
cat,dog,horse,cow,pig,sheep,chicken,duck,rabbit,mouse,frog,snake,turtle,fish,shark,whale,dolphin,octopus,crab,
snail,butterfly,bee,spider,ant,owl,penguin,parrot,flamingo,giraffe,elephant,lion,tiger,zebra,monkey,bear,panda,
kangaroo,camel,fox,wolf,deer,bat,dinosaur,dragon,unicorn,
house,castle,tent,igloo,lighthouse,bridge,tower,church,barn,windmill,skyscraper,school,hospital,
car,bus,truck,train,bicycle,motorcycle,boat,ship,submarine,airplane,helicopter,rocket,tractor,skateboard,
sun,moon,star,cloud,rain,snowman,rainbow,lightning,tornado,volcano,mountain,island,beach,river,waterfall,
tree,flower,cactus,leaf,mushroom,palm tree,forest,desert,cave,
chair,table,bed,lamp,clock,door,window,ladder,umbrella,key,lock,book,pencil,scissors,glasses,hat,crown,
shoe,boot,sock,shirt,dress,glove,scarf,backpack,suitcase,wallet,ring,necklace,
phone,computer,keyboard,television,camera,robot,headphones,guitar,piano,drum,trumpet,violin,microphone,
ball,kite,balloon,gift,candle,lollipop,teddy bear,yo-yo,puzzle,dice,
hammer,saw,shovel,bucket,broom,toothbrush,comb,mirror,soap,bathtub,toilet,
fork,spoon,knife,cup,mug,teapot,bottle,pan,oven,fridge,
heart,arrow,anchor,flag,map,compass,magnet,battery,lightbulb,bomb,
ghost,alien,pirate,wizard,witch,vampire,mermaid,superhero,king,queen,knight,clown,astronaut,
fishing,swimming,sleeping,running,dancing,singing,reading,cooking,painting,jumping,
snowflake,fire,ice,bubble,smile,eye,nose,ear,hand,foot,tooth,brain,skeleton,
trophy,medal,money,treasure,sword,shield,bow,cannon,
spaceship,planet,comet,telescope,satellite,
nest,egg,feather,web,shell,bone,paw,tail,
snow globe,birthday,campfire,picnic,parachute,hot air balloon,roller coaster,ferris wheel,traffic light,
mailbox,fence,well,swing,slide,sandcastle,treehouse,doghouse,scarecrow,
toast,waffle,burger,taco,noodles,sushi,pie,lemonade,milk,
zipper,button,needle,yarn,sock puppet,glue,paintbrush,crayon,eraser,ruler`.split(',').map((w) => w.trim()).filter(Boolean);
const WORD_LIST = [...new Set(WORDS)];

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
  if (pen ? o.p.length < 2 || o.p.length > 160 || o.p.length % 2 : o.p.length !== 4) return null;
  const p = o.p.map((v, i) => int(v, 0, i % 2 ? H : W));
  const op = { k: o.k, c: int(o.c, 0, COLORS - 1), w: int(o.w, 0, 2), s: int(o.s, 0, 1e9), p, q };
  if (pen) { if (o.e) op.e = 1; } else op.f = int(o.f, 0, 2);
  return op;
}

function createTable(opts = {}) {
  const now = opts.now || (() => Date.now());
  const rand = opts.rand || ((n) => require('crypto').randomInt(n));
  const T = { ...TIMES, ...(opts.times || {}) }, R = { ...RULES, ...(opts.rules || {}) };
  const words = opts.words || WORD_LIST;
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
    players.push({ id, name, score: 0, gained: 0, guessed: false, at: 0, drew: phase === 'idle' || phase === 'waiting' || phase === 'over' ? 0 : -1 });
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
    round = 1; used = new Set(); standings = null;
    for (const p of players) { p.score = 0; p.gained = 0; p.drew = 0; }
    say('sys', 'A new game: three rounds, everyone draws once a round');
    nextTurn();
  }
  function nextTurn() {
    for (const p of players) { p.guessed = false; p.gained = 0; p.at = 0; }
    let d = players.find((p) => p.drew < round && p.drew !== -1) || null;
    if (!d) {       // everyone has drawn this round
      for (const p of players) if (p.drew === -1) p.drew = 0;       // (came in partway: in from the next round)
      if (round >= R.rounds) { endGame(false); return; }
      round++;
      d = players.find((p) => p.drew < round) || null;
      if (!d) { endGame(false); return; }
    }
    drawer = d; drawer.drew = round;
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
  // A hint now and then: a letter shown at half time and again at three quarters (never the last ones)
  function hints(t) {
    if (phase !== 'drawing' || !word) return;
    const frac = (t - turnAt) / T.draw, hidden = hint.map((c, i) => (c === null ? i : -1)).filter((i) => i >= 0);
    const want = (frac >= 0.75 ? 2 : frac >= 0.5 ? 1 : 0) - hint.filter((c, i) => c !== null && word[i] !== ' ' && word[i] !== '-').length;
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
    ink: (from = 0) => ink.slice(from),
    get inkRev() { return inkRev; }, get inkLen() { return ink.length; },
    get version() { return version; }, get phase() { return phase; },
    seated: () => players.map((x) => x.id),
    _word: () => word,       // (tests)
  };
}

module.exports = { createTable, inkOp, norm, near, WORD_LIST, RULES, TIMES, W, H, COLORS };
