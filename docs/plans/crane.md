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

600 × 800 units, y down. The pile's floor at y 720, from the chute's guard (x 146) to the right wall (580). The chute is
front left, from the left wall (20) to the guard, open from the guard's top (588) down: a prize past y 772 there is won.
The claw's rail is at the top; it waits over the chute (x 83) and goes as far right as 540. The pile starts as three rows of
plushes (7, 6, 7) with the box on top, shaken down by the physics before anyone sees it. `rev` is a hash of the layout.

## 3. The rules and the physics (`crane.js`)

`createTable({ now, rand, times, rules, wallet, onSettle })` with `sit`, `leave`, `move`, `tick`, `view`, `mine`, `ink`.

- **Moves:** `play` (pays a try) and `drop`. Once a try is in, the claw sweeps by itself (`B.sweepAt`, the same on the table and
  every screen): out from over the chute to the far end, then back and forth over the pile (x 175 to 540) at 240 a second,
  about a second and a half a pass. `drop` brings it down where it is; the clock (15 s) drops it if you don't.
- **Timing is what you saw.** A screen draws the claw a little behind the table (and a press takes a moment to arrive), so
  `drop` carries `amount`: the table's time the screen was showing when you pressed (renderer/crane.js `shownT`). The claw
  comes down where it was then, no further back than `late` (500 ms) and never ahead of now. That is no more choice than
  steering gave: within half a second of the sweep, not anywhere.
- **The try:** the claw goes down until its feet are on a prize (or near the floor), closes, goes up, goes home over the chute
  and opens. Whether it holds on is decided as it closes, by `rand` (crypto at a hub), from how far off the prize's middle it
  came down: `plushGrip · (1 − 0.75·off²)` for a plush, `boxGrip · (1 − 0.85·off²)` for the box. One that won't hold slips
  out just off the pile, part way up, or part way home (it sways more on the way, a tell); one that slips near the chute
  can still drop in. Nothing between the prongs: they push what's beside them.
- **Physics** run where the table is, every `tickMs` (50 ms), in 1/120 s steps: round plushes, a box that never tips, three
  passes a step. The walls have an inside: whatever pushes a prize, it's put back on its own side, never through (a prize
  in the claw shoves others like a wall, and once shoved one clean through). A prize in the claw pushes the others gently
  (3 units a pass at most, 260 a second). Something balanced on the guard's top is tipped off to the side its middle is on.
- **Pays:** a plush 5,000 (what a try costs: a win is your try back), the box 20,000. Every prize won is replaced by a new
  one dropped in over the pile once the try is over (or at once, for one still rolling in after it).
- **The odds were measured, then set** (`node scripts/crane-measure.js 2000 <aim>`): plushGrip 0.74, boxGrip 0.2. Going for
  the box every time, pressed within about 50 ms, pays back about 86% (the grand prize about 1 try in 5, most of them via a
  sure grip, some slipping in near the chute); picking plushes off the top as well about 73% (a plush 45% of tries, the box
  now and then); pressing up to about 170 ms out about 60%. Measured again with the sweep: the same as steering gave. Any
  change to the box's layout, the pile or the sweep's speed moves these: measure again.
- **Not topped up:** a wallet short of a try is left alone (3,000 stays 3,000 for the other tables). Play says it's short.
- **The seat at a hub:** one seat and a line (`watchers`). With anyone waiting, the seat passes on after each try, to the
  back of the line, and after 25 s of not playing. Leaving mid-try drops the claw where it is; what it wins is still yours.
- `onSettle` reports each try's winnings: the hub's board is **best prizes**.

## 4. Sending the claw and the prizes

The same path as Pachinko's balls: `ink(from)` is the kept frames (the last 45), each 1/30 s **that anything moved** (a pile at
rest sends nothing): the time, the claw as `c: [x, y, open]` (half units, open 0–100), each prize as id, kind (+2 while held),
x, y in half units, and what happened (`c` the claw closing, `s` a slip, `w` a prize down the chute, `r` let go). Each screen
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

- `node scripts/test-crane-engine.js` (a few seconds): the box, the pile, the sweep (its ends, its speed), a try (the price, the claw going by itself, the
  clock dropping it), 120 tries won, paid and replaced with nothing outside the box, a sure grip and none, short of a try,
  the line and the seat passing on, leaving mid-try, the wallet across tables.
- `timeout 370 node scripts/test-games.js`: alone, short of a try it says so; with chips, a try with the real buttons
  (Play, the claw sweeping by itself, Drop! on the press, coming down where it was shown), paid into the wallet and the settings, the sounds.

## 8. Still open

- Not tried at a hub in the end-to-end test (the engine test covers the line and the seat); a hub section in test-games.js
  like Pachinko's would.
- A new wallet holds 1,000 chips, so a first try needs some winning at the other tables first.
