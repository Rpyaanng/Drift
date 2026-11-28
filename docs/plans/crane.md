# The crane machine (a Games room scene)

A claw machine in the Games room, in the Pachinko machine's carnival style: a tall glass box full of cat plushes (Drift's cat
in seven colours) with a gift box on top, the grand prize. Put in a try and the claw sweeps back and forth over the pile by itself: press Drop at the right moment, and whatever
it brings back over the chute and lets fall is yours. **One seat**: alone it's yours; at a hub one person plays at a time and
everyone else watches, in line for a go.

Status: **built**. Asked for: one seat, Pachinko's look, small cat plushes filling the box and a box-shaped grand prize, a
try 5,000 chips, a plush 5,000, the grand prize 20,000. Then asked for: the side to side a matter of timing, not steering. Left to us: the sweep (its speed, a 15 s clock), how
often the claw holds on, and how the seat is shared at a hub.

Built on the frame the other Games room tables share (docs/plans/games-room.md, "What was built"): a pure rules module, run by
main.js alone or by the hub's `games` service, views down, moves up, pointers shared, the room's lamp, sounds from view
changes, records in `game_records`, and the casino's one wallet (wallet.js).

## 1. Where it lives

- `crane.js` (rules and physics), `renderer/crane-board.js` (the box's layout: loaded by both, `require`d in Node and a
  script in the renderer), `renderer/crane.js` (drawing, `window.driftCrane`), `#crTable`, and the `#crTable` styles in
  style.css (sharing the tables' `:is(...)` rules).
- `'crane'` in main.js `SCENES`, `GAMES`, `GAME_RULES`, `GAME_SOLO`, `GAME_FAST`, `GAME_INK_KEEP`, `GM_SOUNDS`; hub.js
  `GAME_RULES`; the `where` lists (hub.js, chat.js); renderer `SCENES` (shaders.js, the Blackjack room as its backdrop),
  `GM`, `WB_GAMES`, `appUI.toTable`, chat.js's names and icons. Never in the rotation. Its tile picture is
  `renderer/games/crane.jpg` (scripts/game-pics.js).

## 2. The box (`renderer/crane-board.js`)

900 × 960 units, y down (asked for: a bigger machine; it was 600 × 800). The pile's floor at y 880, from the chute's guard
(x 150) to the right wall (880), flat. The chute is front left, from the left wall (20) to the guard, open from the guard's
top (600) down: a prize past y 932 there is won. The guard stands 280 above the floor (asked for: taller, so nothing falls
in by accident; it was 132), well above the pile. The claw's rail is at the top; it waits over the chute (x 85) and goes as
far right as 850. Half the plushes are big ones (asked for): 39 across instead of 29, 1.8 times as heavy. The pile starts
(asked for: a dip in the pile, the grand prize in it) as a row of 10 plushes right across the floor, small and big turn
about but the middle two both big (so the box on them starts level), with a pyramid of 5 more on each end (3, 2), so the pile dips in the middle (`VALLEY`), and the box sits in the dip
on the bottom row: 20 plushes (10 big) and the box, shaken down by the physics before anyone sees it (the upper rows are
set over the gaps a little above, and drop into the hollows). A new prize, plush or grand prize, comes in anywhere along
the top (`DROP`) and falls onto the pile; a plush won is replaced by one of its size, so half stay big. In the frames each
prize is id, kind (1 for the box, + 2 while held, + 4 for a big plush), x, y (half units), and its angle (hundredths of a
radian). `rev` is a hash of the layout. The cabinet on screen is
782 × 1000 to fit the glass's 900 × 960.

## 3. The rules and the physics (`crane.js`)

`createTable({ now, rand, times, rules, wallet, onSettle })` with `sit`, `leave`, `move`, `tick`, `view`, `mine`, `ink`.

- **Moves:** `play` (pays a try) and `drop`. Once a try is in, the claw sweeps by itself (`B.sweepAt`, the same on the table and
  every screen): out from over the chute to the far end, then back and forth over the pile (x 190 to 850), each leg eased
  like a cosine: still at the ends, 420 a second over the middle, about 2.5 s a pass. `drop` brakes it where it is; the clock
  (15 s) drops it if you don't.
- **The swing** (asked for: harder, more physics, a skill game). The head hangs on its cable as a pendulum from the carriage
  (`B.SWING`: swung from 60 above the rail, the cable reeled inside the carriage). The carriage speeding up and slowing down
  pushes it (`push`, 0.3 of a rigid hang), it dies away by `damp` (and much faster, `rest`, once the try is done), and it
  swings faster as the cable is reeled in. While it sweeps the head trails and overshoots at the ends by up to about 25.
  Drop brakes the carriage at 2,600 a second², so over the middle it slides on about 20, and the head swings on past it
  as it goes down: it lands 10 to 30 off where the carriage was pressed, the same for the same moment of the sweep, so it
  can be learned. Pressing near an end, where it's slow, swings least. Coming home it speeds up and slows at `accel` and
  opens once the swing over the chute has nearly died (1.5 s at most). The head knocks off the glass, never through.
  Each frame's claw is `[head x, y, open, carriage x]`; the screen draws the cable from the carriage and the claw tilted.
- **Timing is what you saw.** A screen draws the claw a little behind the table (and a press takes a moment to arrive), so
  `drop` carries `amount`: the table's time the screen was showing when you pressed (renderer/crane.js `shownT`). The claw
  (carriage and swing: the last half second of the sweep is kept, step by step) is put back as it was then, no further
  back than `late` (500 ms) and never ahead of now, and worked on from there with the brake on.
- **The try:** the claw goes down until its feet are on a prize (or near the floor), closes, goes up, goes home over the chute
  and opens. Whether it holds on is decided as it closes, by `rand` (crypto at a hub), from how far off the prize's middle it
  came down (`d` across; the prongs close on it at all within `REACH`: 30 for a plush, 38 for a big one, 40 for the box) and
  how fast it was still swinging across as its feet touched (`v`): 70% dead centre and still, for every kind (asked for:
  a dead-centre landing dropped too often, at 50% for a big plush and 26% for the box), `× (1 − (d / within)²)`, to
  nothing 18 off for a plush and only 5 off for the box (`boxWithin`: it's worth five tries, so dead centre on it is a much
  smaller target), `÷ (1 + v / swingGrip)` (halved at 120 a second), and a tipped box `× (1 − 0.6 · tipped)`. Precision
  decides it more than luck: a plush 9 off holds about half as often as dead centre. One that won't hold slips
  out just off the pile, part way up, or part way home (it sways more on the way, a tell); one that slips near the chute
  can still drop in. Nothing between the prongs: they push what's beside them.
- **Physics** run where the table is, every `tickMs` (50 ms), in 1/120 s steps: round plushes that roll, a box that tips,
  three passes a step. The walls have an inside: whatever pushes a prize, it's put back on its own side, never through (a prize
  in the claw shoves others like a wall, and once shoved one clean through). A prize in the claw pushes the others gently
  (3 units a pass at most, 260 a second). Something balanced on the guard's top is tipped off to the side its middle is on.
  A plush come to rest on top of the box slides off it (slippery gift wrap), so the box can't be buried. (Each of those
  nudges four times at most, until the claw next takes or drops something: one that's pinned stays put.)
- **Turning** (asked for: rotation, the box too; it cost about nothing to run). Every prize has an angle and a spin. Each
  contact is worked out at the point where the two touch: apart along the normal, a small bounce, and friction along the
  surface up to `PHYS.mu` (0.6) of the push. That friction at the point is what turns things: plushes roll, and the box, a
  rectangle at its angle (touching at its corners, and the guard's top a point it can tip over), tips off an edge it hangs
  over and comes to rest at whatever angle it lands, wedged among the plushes. The claw straightens what it holds (the box
  onto its nearest side, a plush the right way up). A tipped box is harder to hold: `boxGrip` falls by up to 60% as it
  goes from square to balanced on a corner. The claw's feet find the box by what it covers as it lies.
- **Sticky corners** (asked for: the box sticky at its corners, but only when the claw gets it slanted). A box tipped more
  than about 7° (`tipped` 0.15) has a top corner sticking up, and if the claw comes down within `cornerReach` (12) across
  of it, a prong hooks it ("HOOKED IT!", event `k`, `play.hooked`): that's what the claw closes on, and it holds by
  `cornerGrip` (0.35) × how tipped it is (all of it from halfway to a corner up) × how near the claw came, ÷ the swing as
  for any grip, in place of the tipped box's poor ordinary grip. A box lying square has no corner up, so nothing hooks.
  First tried at 0.7 and 18: going for the box then paid back 101 to 124%, a machine that pays you, so toned down.
  **Then made easier** (asked for: "spent 100k and haven't won once; hooking it should have an 80% win rate, and a bit more
  leniency for dead centre"): a hook holds by `cornerGrip` 0.8, flat (however tipped, however near, swinging or not),
  within `cornerReach` 14; the grip falls to nothing 22 off a plush's middle (was 18) and 8 off the box's (was 5), 70% dead
  centre as before. Measured (600 tries each): going for the box, a skilled hand gets 179% back (the box 36% of tries),
  aiming at a tipped one's corner 219%, a naive one 119 to 131% (24 to 26%); picking plushes off the top, skilled 84%,
  sloppy 57%, naive 63%. Going for the box now pays you back more than it costs (to rein in, if wanted: `grandPay`,
  `boxWithin` or `cornerGrip`).
- **Asleep:** a prize that's barely moved for 0.4 s (by where it got to, not its speed) stops: no gravity, no moving, and
  it holds like the floor. That's what lets a pile of round, turning things come to rest and send nothing; without it, a
  plush sitting on two others jittered for ever. It wakes on a hard knock (120 a second along the contact), a deep shove
  (6), or the claw's prize pushing into it; and everything wakes when the claw takes, drops or lets go of something, or a
  prize comes in (whatever rested on it has to fall). Asleep prizes skip the physics, so it runs at about 0.4 ms of CPU a
  second of play, half what it did before. Measured: after a try the pile is still within 3 to 5 s nearly every time.
- **Pays:** a try 1,000; a plush 1,000 (what a try costs: a win is your try back), a big plush 2,000, the box 3,000.
  (Asked for, with wallets starting at 500: everything a fifth of what it was, a try 5,000, a plush 5,000, a big one
  10,000, the box 15,000, so the odds and the payback are unchanged. Before that the box was 20,000, then 25,000: the
  measured payback figures below are from those), and with the box a scene token, alone or at a hub (docs/plans/scene-slots.md: main.js `GM_TOKENS`). A try's `kinds` lists what it won: 0 a plush, 1 the box, 2 a big plush. Every prize won is replaced by a new
  one dropped in over the pile once the try is over (or at once, for one still rolling in after it).
- **The odds were measured, then set** (`node scripts/crane-measure.js 1000 <top|box> <naive|skilled> <jitter ms>`):
  plushGrip 0.62, boxGrip 0.26, swingGrip 120 at first (now 0.7 each: see the try, above). A naive player presses as the carriage passes over the prize; a skilled one
  has learned where each moment of the sweep comes down. Before the swing it paid back 73 to 86%; now about 45 to 50%
  for anyone picking off the top (a skilled hand, ±40 ms, comes down about 7 off and wins a plush 30 to 42% of tries; a
  naive one 15 to 30 off, a plush 22 to 25%). The box is the skill shot: aimed at, a skilled player gets it about 1 try in 6
  (about 70% back on those tries), a naive one 1 in 20 (about 20%). Measured again in the bigger box with the pile dipping
  in the middle: about the same (picking off the top, skilled, 45%, naive 38%; the box aimed at, skilled, 1 try in 6, 68%). And with half the plushes
  big: picking off the top, skilled, 48%, naive 37%; the box, skilled, 1 try in 6.5, 63%. Then with a big plush paying 10,000 and the box 25,000: picking
  off the top, skilled, 78%, naive 68% (the big ones sit on top, and are most of what's won there); the box, skilled, 78%. With turning: picking off the top,
  skilled, 75%, naive 48%; the box, skilled, 68% (1 try in 7.5: it often lies tipped). With sticky
  corners and the box starting level: picking off the top, skilled, 73%, naive 67%; the box, skilled, aimed at its middle
  90%, at its top corner when tipped 81% (`node scripts/crane-measure.js 800 corner skilled 40`). With 70% dead
  centre: picking off the top, skilled (±40 ms), 74%, sloppy (±100 ms) 52%, naive 66%; the box, skilled, 82% at its
  middle, 70% at its corner (with the box's dead centre as forgiving as a plush's, 18 off, it paid back 143%). It's noisy: where the box ends up (against a wall, on
  the guard) moves it. Any change to the box's layout, the pile, the sweep or the swing moves these: measure again.
- **Not topped up:** a wallet short of a try is left alone (3,000 stays 3,000 for the other tables). Play says it's short.
- **The seat at a hub:** one seat and a line (`watchers`). With anyone waiting, the seat passes on after each try, to the
  back of the line, and after 25 s of not playing. Leaving mid-try drops the claw where it is; what it wins is still yours.
- `onSettle` reports each try's winnings: the hub's board is **best prizes**.

## 4. Sending the claw and the prizes

The same path as Pachinko's balls: `ink(from)` is the kept frames (the last 45), each 1/30 s **that anything moved** (a pile at
rest sends nothing): the time, the claw as `c: [head x, y, open, carriage x]` (half units, open 0–100), each prize as id, kind (1 the box, +2
while held, +4 a big plush), x, y in half units and its angle in hundredths of a radian, and what happened (`c` the claw closing, `s` a slip, `w` a prize down the chute, `r` let go). Each screen
draws them 110 ms behind the newest frame, each between the two around then, and shows each view as late.

## 5. The look (`renderer/crane.js`)

The Pachinko machine's carnival: the back wall drawn once (deep purple, polka dots, stars, a glitter mat under the pile, the
rail), the chute's acrylic and the glass's shine in front; each frame between them sunburst rays behind the pile, a
spotlight from the claw down while it sweeps, the claw (a pink carriage, chrome head and arms, one behind the prizes and
two in front so it holds what it holds), the plushes (the cat's outline, sprites in seven colours; their eyes follow the
claw, the one it's holding beams), the gift box (gold, a pink ribbon and bow, a "GRAND PRIZE" tag, twinkling), confetti and
"+5,000" at the chute, chasing bulbs round the glass, and "YOU GOT ONE!", "SO CLOSE!" or "GRAND PRIZE!!" across it. A win
warms the room's lamp; the grand prize shakes the cabinet. The clock is on the glass. With the PC set to reduce
motion, nothing turns, shakes or showers. Drop! goes on the press, not the click (a click is when it's let go). Space, Enter and ↓ drop, and so does a press on
the glass, while the claw sweeps for you (only then: otherwise the keys do what they always do).

## 6. Sounds (`cr`, behind "Game table sounds")

From the views (`GM_SOUNDS.crane`), heard by everyone at the machine: `crCoin` (a try), `crDrop`, `crGrab`, `crSlip`,
`crWin` (a plush down the chute), `crGrand`, `crMiss`; and `bjTurn` when your go comes after waiting. Levels set beside
their neighbours, not yet measured.

## 7. Tests

- `node scripts/test-crane-engine.js` (a few seconds): the box, the pile, the sweep (its ends, its speed), the swing (the
  head under the carriage, the brake's slide, home and still), tries aimed the way a player who's learned the swing would, a try (the price, the claw going by itself, the
  clock dropping it), 120 tries won, paid and replaced with nothing outside the box, a sure grip and none, short of a try,
  the line and the seat passing on, leaving mid-try, the wallet across tables.
- `timeout 370 node scripts/test-games.js`: alone, short of a try it says so; with chips, a try with the real buttons
  (Play, the claw sweeping by itself, Drop! on the press, coming down where it was shown), paid into the wallet and the settings, the sounds.

## 8. Still open

- Not tried at a hub in the end-to-end test (the engine test covers the line and the seat); a hub section in test-games.js
  like Pachinko's would.
- A new wallet holds 1,000 chips, so a first try needs some winning at the other tables first.
