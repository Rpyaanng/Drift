# More games for the Games room

Blackjack (docs/plans/blackjack.md) proved the shape: a pure rules module, dealt by main.js alone or by the hub for
everyone, views sent down, moves sent up, pointers shared, lit by the palette, sounds from view changes, a board kept by
the hub. This plan adds five games on that shape, after first pulling the shared parts out of Blackjack so each new game
is mostly its rules and its drawing.

Status: **Roulette (§2.1) and Texas Hold'em (§2.4) are built**, alone and at a hub, and **Sketch & Guess (§2.3)**, at a
hub only; the rest is still a plan. Open questions are in §5.

Sketch & Guess, as built: `sketch.js` (the rules: turns, three words to pick from, guesses with "very close", hints at half
and three quarters time, scores, what each player may see) on the same `games` frame, plus one addition to it: a game's
drawing goes out apart from its views (`game-ink` up, at most 40 a second with no answer; `game-ink { rev, from, list }`
down, only what each session hasn't had), since it changes many times a second. main.js keeps the drawing for a screen
that comes to it later; alone, the screen says to go online (`GAME_SOLO`). The board (`renderer/sketch.js`) is laid out
like a diagram editor: tools on the left, colour, width and fill on top, a white sheet on a grid. The word list is our own
(§5 question 3, a host's own words, is still open). Tests: `scripts/test-sketch-engine.js`, and a turn played between the
two copies in `scripts/test-games.js`.

What was built, and how it differs from the plan:

- **The frame, for the new games.** Roulette and Hold'em share one general service: `roulette.js` and `poker.js` (the
  rules, at the top level next to `blackjack.js`, each `createTable({ now, rand, times, fill, onSettle })` with `sit`,
  `leave`, `move(id, m)`, `tick`, `view(id)`, `mine(id)`), hub.js `games` (messages `game-sit / game-watch / game-stand /
  game-leave / game-move / game-ptr` up and `game-view / game-ptrs` down, each naming its game `g`), main.js `gm` (one
  runner per game: alone or at the active hub's table), app.js `GM` (one holder per table, sharing `#gmPtrs`), and the hub's
  SQLite `game_records (game, member, value, at)` for each game's board. Blackjack stays on its own plumbing for now: it
  works and is tested, and moving it is a refactor with nothing new for people. The new games' drawing reuses its look
  (style.css: the lamp, cards, chips, bar, board and tags are shared by all three tables).
- **Chips are one wallet** (1.12.0, `wallet.js`): Blackjack, Roulette, Hold'em and Pachinko play the same chips, alone and at
  a hub (docs/plans/pachinko.md §5). §5 question 2 is answered.
- **Pachinko** (not in the list below) is built too: docs/plans/pachinko.md.
- **Hold'em has computer players**, not "hub only": alone you play three, and at a hub one sits in while only one person is
  there (`fill`), leaving between hands as people come. They decide from their own cards and the board only: a few hundred
  random deals against everyone still in, the price to call, and a little chance.
- **Roulette** spins when everyone at it has pressed Spin (or Skip this spin), or 25 s after the first bet.
- Sounds: `rlSpin`, `rlDrop`, `rlWin`, `pkCheck`, `pkFold`, with Blackjack's cards and chips, behind the switch now called
  "Game table sounds".
- Tests: `scripts/test-roulette-engine.js`, `scripts/test-poker-engine.js` (plain Node), and `scripts/test-games.js`
  (two copies: alone, then at a hub's Hold'em table and roulette wheel).

## 1. First: one frame for every game

Blackjack's plumbing is written for Blackjack (about 390 `bj` lines across hub.js, main.js, chat.js and app.js). Before
the second game, make it general, and move Blackjack onto it with its tests still passing:

- **`games/` folder.** Each game is `games/<id>.js` (rules: `createGame({ now, rand, times, onSettle })` with `join`,
  `leave`, `move(id, m)`, `tick`, `view(id)`) and `renderer/games/<id>.js` (drawing: `mount(holder, send, opts)`,
  `view(v)`). `blackjack.js` moves to `games/blackjack.js`.
- **One hub service** (hub.js `games`): a table per game per hub, made when first sat at. Messages become
  `game-sit / game-watch / game-stand / game-leave / game-move / game-ptr` with a `g` (the game's id), and
  `game-view / game-ptrs` down. The rate limits, the pointer batching, the "came from another PC" hand-over and the
  session clean-up are written once.
- **One table runner in main.js** (`bjAt`, `bjLocal`, `bjScreens`, `bjSync` become `gameAt`, `gameLocal`, ...), keyed by
  the scene's game. `where` becomes `game:<id>` so the hub bar says which table.
- **One board table** in the hub's SQLite: `game_records (game, member, kind, value, at)`, so each game can keep its own
  records ("biggest pot", "fastest guess", "most wins") without a new table each.
- **Shared room look:** the lamp, the felt colours from the palette and the self/others pointer drawing move to
  `renderer/games/room.js`. Each game picks its surface (felt, wood, ice, paper).
- **Chips across the casino:** one session wallet per hub for the casino games (Blackjack, Roulette, Hold'em), so
  chips won at one table can be played at another. Still fresh each time you sit down at a hub, still kept when alone.

The tests move with it: `test-blackjack.js` keeps passing unchanged in what it checks.

## 2. The games, in the order to build them

### 2.1 Roulette (casino; easiest second game, shows off everyone's pointers)

- One wheel (European, single zero), any number of players, everyone betting at once on the same layout: numbers,
  splits, streets, corners, red/black, odd/even, dozens, columns. Payouts by the book (35:1 down to 1:1).
- Chips are **placed with the mouse on the layout**, so everyone sees everyone's pointer and chips land under it, in
  their colour. That's the multi-cursor feature at its best.
- Rounds: 25 s to bet, "no more bets", the spin (the hub decides the number with `crypto.randomInt` *before* the ball
  is drawn; the view only gets it when the ball lands), payout, the last 12 numbers shown.
- Board: biggest single win. Sounds: chip clicks, the ball rattling (filtered noise slowing down), the drop.
- Alone: the same table, dealt in main.js.

### 2.2 Air hockey (real-time; the pointers *are* the game)

- Two players (others watch and queue, winner stays on). Your mallet follows your mouse over your half.
- Physics on the hub at 60 steps a second, sent at 30 a second (positions as fractions, a few bytes each). Each screen
  draws the puck where it should be now, between the last two states, so it moves smoothly over a real connection.
  Your own mallet is drawn at your mouse at once (not waiting for the hub), and the hub moves it there fast but limited
  in speed, so nobody teleports through the puck.
- First to 7. Board: most wins, and the fastest goal. Alone: against a simple computer player, in main.js.
- This is the one game that needs a fast hub. Plan for the relay and measure: if the round trip is over ~120 ms,
  say so on the table ("laggy connection") rather than feel broken.

### 2.3 Sketch & guess (party; up to 12)

- Our own drawing game: each round one person draws a word they picked from three, the rest type guesses. Guessing
  sooner scores more, and the drawer scores when people guess. Three rounds of everyone drawing.
- The drawing is strokes (points, colour, width) sent through the hub and drawn on everyone's canvas as they arrive.
  Guesses go through the table, not the hub's chat channels, and a correct guess is never shown to the others.
- The word list is ours, plain and family-friendly, in a file the hub's host can add to. Hub only (needs people).
- Board: most points in a game. Sounds: pen down, a correct guess, the round's end.

### 2.4 Texas Hold'em (casino; the biggest piece of work)

- Players against each other, not the house: 2 to 6, blinds, the four betting rounds, side pots when someone is all in,
  the showdown with the best five of seven. Every player's hole cards go only to them; the hub never puts them in
  anyone else's view until the showdown.
- Its rules module gets the most tests: hand ranking (all categories and kickers), side pots with three all-ins,
  heads-up blinds, someone leaving mid-hand (folds), the turn timer.
- Hub only (no computer players in the first version). Board: biggest pot won.

### 2.5 Chess (two players and anyone watching)

- Full rules (castling, en passant, promotion, check, mate, stalemate, the 50-move rule and threefold repetition), with
  a clock (5 or 10 minutes). Watchers see the board live, and the move list.
- Pieces drawn by us, flat, in the palette. Board: most wins at the hub. Alone: two people on one PC, or a puzzle a day
  later.

## 3. Across all of them

- **Never in the rotation**, as Blackjack: `GAMES` lists them all.
- **The hub bar:** "At Roulette", "Playing air hockey", and a click sits you down there (or puts you in line).
- **Fairness:** everything random is decided on the hub with `crypto.randomInt` and never sent before it's shown. No
  game trusts a member's PC with the outcome.
- **Sounds:** each game's go into `renderer/sfx.js` under its own prefix, measured against the others, behind the same
  "game sounds" switch (renamed from "Blackjack table sounds").
- **Lighting:** each answers its big moments through the room (a jackpot on Roulette warms the lamp, a goal flashes the
  rink's edge in the scorer's colour).
- **Release notes** per game, each with its picture and a cat.

## 4. Order of work and rough size

1. The frame (§1), with Blackjack moved onto it. Medium. Nothing new for people, so released with Roulette.
2. Roulette. Small to medium. Release.
3. Air hockey. Medium; the work is the smooth puck and testing over the relay.
4. Sketch & guess. Medium.
5. Hold'em. Large: the rules and their tests.
6. Chess. Medium.

Each game: rules module and its plain-Node test first, then the hub service, then the drawing, then a two-copy in-app
test like `test-blackjack.js` (the `until` / `need` / `abort` pattern, `tw()` for the window the game is on).

## 5. Open questions

1. **Which games?** These five, or swap any out (checkers, Connect-four style drop game, trivia, solitaire alone)?
2. ~~**One wallet across the casino games**, or separate chips per table?~~ One wallet (1.12.0).
3. **Sketch & guess words:** our own list only, or let a hub's host add their own?
4. **Air hockey alone:** worth a computer player, or hub only?
