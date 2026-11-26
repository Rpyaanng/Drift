# Blackjack table (a Games room scene)

A blackjack table you can sit at alone or with everyone in your hub, side by side, each playing their own hand against
one dealer. It's a scene, so it gets Drift's lighting and palette, but it's never picked by the automatic scene changes.

Status: **built** (1.10.0). This describes what's there.

## 1. Where it lives

- **The `games` group**, shown as **Games room** under the scene tiles. Blackjack is its first tile:
  `{ id: 'blackjack', name: 'Blackjack', group: 'games', game: true }` in `renderer/shaders.js` `SCENES`, and in main.js
  `SCENES` and `GAMES`.
- **Never in the rotation.** `stepScene` leaves games out of the automatic changes *and* Next / Previous, and an automatic
  change never moves you off a game (as with your video). The tile has no rotation tick, `#rotNote` counts only the other
  scenes, and `cycleSkip` never stores a game. In Mix, the renderer's own stepping skips games too (`CYCLED`).
- **Which screen.** In Span the table is on the middle screen (`isCenter`); in Mirror and Mix on every screen showing the
  scene. The others have the room's light without a table.

## 2. How it looks

The table is a DOM layer (`renderer/blackjack.js`, `#bjTable`) over the `blackjack` backdrop shader in `shaders.js`.

- **Room:** the palette's darkest colour, a low lamp in the accent (warmed so cards read true), its cone through slow
  haze, a soft dark edge. The music swells the lamp a touch.
- **Felt:** the palette's second colour pulled a little toward green; its rail lit by a thin line of the accent. app.js
  sets `--bjAccent`, `--bjFelt`, `--bjFeltDeep`, `--bjHi`, `--bjDark`, `--bjLamp` from the palette (`bjColors`), again on
  every change.
- **Printed on the felt** (an SVG on a 200 × 100 box; the felt's lower half is a circle round its top middle, so every
  curve follows the edge): Drift's wave mark (the icon's four shapes, flat, in the accent and the light colour) and name in
  front of the dealer, "Blackjack pays 3 to 2" and the dealer's rule on arcs, the insurance band, a betting circle at each
  seat. The dealer's side has a discard holder (filling as the shoe empties), a chip rack, a sign with whose table it is
  and the limits, and the shoe. Card backs carry the mark.
- **Seats:** six along a curve inside the edge, each name tag anchored there with the cards growing up from it. A spot of
  the player's pointer colour (`driftPtrColor`; yours `driftSelfColor`). At a hub, the tag shows their picture from the hub
  (`chatUI.face`; their initial without one), the turn timer filling round it.
- **Light that answers:** a win warms the lamp, a loss dims it, a blackjack shimmers the rail.
- Positions were checked by the numbers at 1920 × 1080 (the in-app test logs `bj: layout`): seats inside the felt, the
  printing clear of the cards, the bar between the felt and Drift's own toolbar.

## 3. The rules (`blackjack.js`, one engine for both)

A pure module (no Electron, no DOM, no timers): `createTable({ now, rand, times, onSettle })`, ticked by its owner.

- 6 decks, `crypto.randomInt` Fisher–Yates, reshuffled past 75%. Only dealt cards leave it; the hole card is null till turned.
- Dealer hits 16, stands on all 17s, peeks under an ace or a ten. Hit, stand, double on two cards, split once (aces get
  one card each), **insurance** (half the bet, pays 2:1, offered to everyone at once when the dealer shows an ace) and
  **late surrender** (first two cards, half back). Blackjack 3:2, win 1:1, push returns the bet.
- Chips start at 1,000; bets 10 to 500. **Crapping out** (chips under 10): 20 s out, then 1,000 again. The wait is kept
  by the table across standing up and sitting down.
- Rounds: betting (ends when all seated have bet, or 10 s after the first bet), deal, insurance (8 s), turns in seat order
  (20 s each, then stand), the dealer, settle, 5 s to look. `onSettle` reports each player's net for the round.

## 4. Alone

main.js runs the engine (`bjLocal`), chips and the wait kept in `state.blackjack` (an unsettled bet counts as yours if
Drift closes mid-hand).

## 5. At a hub

The hub runs one table (hub.js), authoritative: members send moves, it decides, everyone at the table gets the table as
they see it.

- Up: `bj-sit` (a seat, or the line for one), `bj-watch` (look on), `bj-stand` (give up the seat, keep looking on),
  `bj-leave`, `bj-bet`, `bj-insure`, `bj-act`, `bj-ptr`. Each limited (`slow(s, 'bj', 40)`; pointers 30 a second).
- Down: `bj-view` (the table as that member sees it, deadlines as ms left, and the board) and `bj-ptrs` (everyone else's
  pointer over the table, at most 25 a second, as fractions of the felt).
- Chips don't carry over: 1,000 each time you sit. The **biggest pots** do: each member's best round is kept in the hub's
  SQLite (`bj_pots`), and the top five go out with every view (`board`, with how long ago each was set). They survive the
  hub restarting.
- `where: 'blackjack'` puts "At the Blackjack table" in friends' hub bars; clicking them takes you to the table
  (`appUI.toTable`).
- Going offline, switching scene or closing Drift leaves; a hand in play stands and settles. After a reconnect you sit
  down again, or look on if you'd stood up. Someone you've blocked plays on, as "Someone", without their picture or pointer.
- The host plays through their ordinary connection to their own hub, like everyone.

## 6. Sounds

Made in `renderer/sfx.js` like the hub's (Web Audio, on C and G, levels measured against the others): a card, the deal,
chips, your turn, win, blackjack, push, lose, bust, out of chips, back in. main.js picks them from the change between two
views (`bjSounds`). Their own switch, **Blackjack table sounds** (`sfx.table`), so they play with the hub's sounds off.

## 7. Tests

- `node scripts/test-blackjack-engine.js`: every rule, with stacked cards and a fake clock.
- `node scripts/test-chat.js`: the hub's table through real hubs, played till someone wins; the board, and it surviving
  a restart.
- `timeout 240 node scripts/test-blackjack.js` (`DRIFT_TESTBJ`, `DRIFT_BJ_FAST`): two copies. Alone: the rotation, a hand
  with the real buttons, insurance and surrender, crapping out, standing up, the sounds and their switch. At a hub: both
  seated with fresh chips and pictures, pointers, the hub bar, turns in order and only yours to play, the board, standing
  up and sitting down, leaving.
