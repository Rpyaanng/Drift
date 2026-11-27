# Pachinko (a Games room scene), and one wallet for the casino

A pachinko machine in the Games room: a tall board of brass pins, you hold the handle and steel balls fly up the lane, round
the top and down through the pins. A ball in the start pocket spins the reels in the machine's window, and three of a kind
is a fever. Alone it's your machine. At a hub it's **one machine for everyone**: all of you fire into the same pins, each
ball in its owner's colour, and they knock into each other.

Status: **built** (1.12.0). This describes what's there. Decided with the user: one shared board at a hub (not a row of
machines), and one wallet across the casino tables. The payback (about 95%) and the handle (hold to fire, power on a dial
that stays where it's set) were left to us.

Built on the frame Roulette, Hold'em and Sketch & Guess share (docs/plans/games-room.md, "What was built"): a pure rules
module, run by main.js alone or by the hub's `games` service, views down, moves up, pointers shared, the room's lamp, sounds
from view changes, records in `game_records`.

## 1. Where it lives

- `pachinko.js` (rules and physics), `renderer/pachinko-board.js` (the board's layout: loaded by both, `require`d in Node and
  a script in the renderer, so the pins the balls bounce off are the pins drawn), `renderer/pachinko.js` (drawing,
  `window.driftPachinko`), `#paTable`, and the `#paTable` styles in style.css (sharing the tables' `:is(...)` rules).
- `'pachinko'` in main.js `SCENES`, `GAMES`, `GAME_RULES`, `GAME_SOLO`; hub.js `GAME_RULES`; every `where` list; renderer
  `SCENES` (shaders.js, with the Blackjack room as its backdrop), `GM`, `WB_GAMES`, `appUI.toTable`, chat.js's names and icons.
  Never in the rotation. Its tile picture is `renderer/games/pachinko.jpg` (scripts/game-pics.js).

## 2. The machine (`renderer/pachinko-board.js`)

600 × 900 units, y down. `rev` is a hash of the layout: a view carries it, and a screen whose board differs says so.

- **The frame:** a launch lane up the right (inner wall at x 568), a round top (radius 292), the walls, a floor sloping to
  the drain. A ball that falls back into the lane is a **foul** and its chips come back.
- **The pins:** staggered rows 28 apart (a ball always fits through), off the window, the pockets and the lane, plus two
  **roads**: close rows of pins from under each side of the window down towards the start pocket. Balls dropped just beside
  the window roll along them, so aim matters.
- **Nowhere for a ball to wedge.** Every pin is at least 21 from the left wall, 15 from the lane, 28 from a tulip's middle:
  wider than a ball, so none rests between a pin and a wall. (Every other row used to have a pin 10 from the left wall, and
  balls sat between it and the wall.) Short **kickers** out from the left wall, every other row, send a ball sliding down
  it back onto the pins. Each road starts so a ball coming down the window's side lands between two of its pins, not
  balanced on top of one. Measured: over about 3,900 balls at every power, none rests anywhere longer than a moment.
- **The window:** the reels, a roof the balls roll off, pointed a little at the top (a round arch is flat at its peak,
  and balls balanced there). Nothing gets inside it (pachinko.js pushes a ball out if a crowd ever shoves one in).
- **Pockets:** the start pocket under the window, two tulips (open wider after a catch, shut after the next), the gate at
  the bottom (nothing there while shut, only faint dashed doors: balls go on to the drain; open in a fever).
- **The trampoline** (`TRAMP`, `trampAt(t)`): a mat 60 wide sliding across the lower board (y 716, 110 to 490, once every
  5.6 s), in a lane kept clear of pins. A ball landing on it goes back up at least 560 fast, with some of the mat's sideways
  speed; its ends are hard like pins. It replaced the shut gate's roof, which did nothing. About 12 in 100 balls land on it.
  Its position goes out in every frame (`p`), so the screens draw it where the table had it, the mat dipping as a ball lands.

## 3. The rules and the physics (`pachinko.js`)

`createTable({ now, rand, times, rules, wallet, onSettle })` with `sit`, `leave`, `move`, `tick`, `view`, `mine`, `ink`.

- **Moves:** `hold` (with `amount`, the power 0–100), `let go`, `power`. While held, a ball every 0.6 s (at most 14 of
  yours in the air), 25 chips each. So no message per ball, and a slow connection doesn't fire in bursts.
- **Physics run where the table is** (main.js alone, the hub at a hub), every `tickMs` (50 ms), in fixed 1/240 s steps up to
  now: gravity, balls against pins and walls (in a grid), and against each other (not on the rail, where they'd only jam),
  a ball's own jitter off a pin from a quick generator seeded by `rand` (crypto at a hub). A ball that rests too long is
  nudged; one still up after 16 s drains (the test checks none get there).
- **Pays:** start pocket 100 and a spin (up to 8 wait, shown as lights), tulip 110, gate 500 in a fever. A ball costs 25
  (`cost`): high stakes, asked for. At 1 a ball the machine's edge never showed in a wallet of 1,000; at 10 it ran out in
  about 4 minutes at the median; at 25 (40 balls) in about 1.2 minutes (0.8 to 1.9 for most sessions, and 1 in 150 still
  going after 3 hours, on a run of fevers). The pays went up with the cost, the tulip a little less (110, not 125), to make
  room for the more frequent fevers below.
- **The reels** (shared: a spin belongs to whoever's ball hit, everyone watches) are decided when they start, by `rand`,
  and each is in the view only once it stops. A fever is always a reach first; 1 in 9 spins is a reach that misses by one.
  Seven symbols of our own (cat, moon, wave, star, note, bell, seven).
- **Fever:** 1 in 130 spins. The gate opens for 6 rounds of 15 s or 10 balls, for **everyone**: whoever gets balls in it
  is paid. Sevens or the cat is big: the next 20 spins hit 1 in 25. `onSettle` reports each person's fever winnings: the
  hub's board is **biggest fevers**.
- **The odds were measured, then set:** 4 to 6% of balls find the start pocket at most powers (about the same wherever you
  aim, from 35 to 80), about 9% a tulip. Over 300,000 balls the machine pays back about 79–96% depending on aim (93–96% at
  powers 60 and 80; 75% at 40 before the tulip went from 100 to 110, which adds about 3.6 points everywhere). Fevers went
  from 1 in 160 to 1 in 180 with the trampoline, to 1 in 170 once the wedges were gone, and to 1 in 130 (asked for) with
  the tulip paying a little under the others to keep the edge. Any change to where the pins are moves these: measure again. The engine test checks
  the pocket rates; the long run is too slow for it.
- **Out of chips:** nothing left and nothing in the air: 20 s out, then 1,000 (the wallet's).

## 4. Sending the balls

The balls go apart from the views, on Sketch & Guess's `ink` path: `ink(from)` is the kept **frames** (every 1/30 s: the
time, and each ball as id, seat, x, y in half units; with what happened in it: launches, pins, pockets), the last 45 kept.
The hub's `gameInk` sends each session what it hasn't had; main.js keeps the last 45 too (`GAME_INK_KEEP`, `gmInkTake`)
for a screen that comes later. Each screen draws the balls 160 ms behind the newest frame (`LAG`), each between the two
frames around then, and shows each view as late, so a pocket's pay lands with its ball. A row of eight costs about 15 KB/s.

## 5. One wallet (`wallet.js`)

Blackjack, Roulette, Hold'em and Pachinko play from the same chips. A table seats someone as it always did, then
`wallet.bind(seat)` turns the seat's `chips` and `outUntil` into the wallet's, so no rule changed. Computer players aren't
the wallet's. Crapping out is the wallet's: out at one table is out at all for the wait.

- **Alone:** `localWallet` in main.js, kept in `state.wallet` (it replaced `state.blackjack`, `.roulette` and `.poker`; the
  biggest of them became the wallet). What's saved counts bets still riding as yours; a table closing gives them back
  (`walletGiveBack`). Every table here shows a change at once (`walletChanged`).
- **At a hub:** one wallet per hub, 1,000 at a member's first table, kept while the hub runs. A change reaches every table
  the member is at (`walletNews`, batched).

## 5b. The look (`renderer/pachinko.js`)

Over the top on purpose, a carnival, all drawn on the board's canvas by us. Two pictures drawn once (`paintStill`: the
painted face behind, polka dots and stars; the chrome rails, the striped window frame, the start pocket's sign, the tulips'
pots and the brass pins in front), and each frame between and over them: sunburst rays turning from the window (fast and
rainbow in a fever), a black hole swirling at the drain, pins near a ball lighting up and fading (the renderer's own grid
of pins), tulips whose petals swing open, the gate as a mouth (asleep with a "z" when shut, wide and chomping with teeth
in a fever), a striped trampoline on coiled springs with speed lines, a trail behind each ball, confetti, petals and
sparks with a "+40" where a pocket paid (its frame's events carry where: `[kind, seat, x, y]`), chasing bulbs round the
rim and the window's arch, googly eyes that follow your newest ball and blink, and "REACH!" or "FEVER!!" right across the
glass. A fever also blasts confetti, shakes the cabinet and turns it rainbow (CSS: `shake`, `paHue`). With the PC set to
reduce motion, nothing turns, shakes or showers. `DRIFT_GAMEPICS_EXTRA=1 node scripts/game-pics.js OUT` saves the machine
full size, in a reach, in a fever and with the gate open, to look at.

## 6. Sounds (`pa`, behind "Game table sounds")

Your own balls only (paBallSounds, timed to what you see): `paLaunch`, `paPin` (a few a second at most), `paBounce` (the trampoline), `paStart`,
`paTulip`, `paCatch`. From the views (`GM_SOUNDS.pachinko`), heard by everyone at the machine: `paSpin`, `paReach`,
`paMiss`, `paFever`, `paGate`, and `paPay` for your winnings when a fever ends. Their levels are set beside their
neighbours, not yet measured like the others'.

## 7. Tests

- `node scripts/test-pachinko-engine.js` (a few seconds): the board, the handle, every ball coming down inside the board,
  the frames, the pocket rates, the reels hidden till they stop, a fever's rounds and the hot spell, out of chips, leaving
  with balls up, and the wallet across two tables.
- `timeout 340 node scripts/test-games.js`: alone, the wallet carried from the wheel to Hold'em to Pachinko, the machine
  drawn and laid out (`pa: layout`), held with the real button, a ball each 0.6 s, the sounds; at a hub, the wallet carried
  between its tables, one machine with both people's balls on it.

## 8. Still open

- A hub's wallet starts over when the hub restarts. Keeping it in the hub's SQLite is easy if that's wanted.
- Windmills (spinners on the board) were in the first plan and aren't built.
