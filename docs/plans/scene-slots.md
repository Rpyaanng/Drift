# Locked scenes, scene tokens and Scene Slots

Asked for: the scenes that aren't games locked, except the first in each section of the picker; a token for the crane
machine's grand prize or a fever in Pachinko; and a new Games room scene where you put in a token and a slot machine
unlocks a scene at random.

Status: **built**. Left to us: one token each, the free scenes, where tokens are kept, what happens at a hub, the machine's
look and sounds.

## 1. What's locked

- **Free:** the first scene in each of the picker's sections: Aurora, Mountain Lake, Sierpiński Zoom, Platonic Solids,
  Quasicrystal (main.js `FREE_SCENES`). Every game is open, and so is a video.
- **Locked:** the other 31. main.js is the only judge (`sceneOpen`, `lockedScenes`): `patch()` drops a locked `scene` or
  `perDisplay` entry however it was asked for (its tile, a number key, Next / Previous, the rotation, Mix), `stepScene`
  never picks one, and a locked scene saved from before falls back to Aurora on start. The screens get the list as
  `S.locked` (publicState) and draw it: dimmed under a padlock, no rotation tick, and a click or a number key says how to
  unlock it (renderer/app.js `isLocked`, `lockedSay`; style.css `.tile.locked`). The rotation note counts open scenes only.
- **Test runs** open everything (`LOCKS_OFF`: they visit scenes freely, the screenshot loop all of them), unless a test asks
  for the locks with `DRIFT_LOCKS`.
- **Migration:** none. Anyone who had every scene before starts with the five again (asked for).

## 2. Tokens

- `state.tokens` (0 to 999) and `state.unlocked` (ids), saved in settings.json. A screen's patch can't touch either
  (ipcMain 'patch' strips them); only `tokenWon` and `slotsSpin` change them.
- **Where they come from** (main.js `GM_TOKENS`, run in `gmShow` beside the tables' sounds, from what changed between two
  views of a table). Those views are the same alone and at a hub, so a token won at a friend's hub is yours, kept on your
  own Drift (the hub's chips aren't: they're the hub's).
  - The crane machine: one for each grand prize (`kinds` 1) won on a try of yours. Counted by try number across `play` and
    `last`, so a box rolling in after the try is over still counts, and nothing counts twice.
  - Pachinko: one for each fever round filled (its balls in the gate before the round's time is up: `roundBalls`, 6 with one
    at the machine as the round opens, 10 with two, 12 with three, 15 with four or more, asked for: easier per head the more
    there are, to bring friends; measured, holding at powers 40 to 80, 40%, 52%, 71% and 84% of rounds fill), to everyone with a
    seat at the machine then (stood up or watching: none), whoever's spin set the fever off. Counted by the machine's `filled`,
    which only goes up; a view without it (an older hub) gives none. (It was one for a fever your own spin set off: asked to
    change.)
  - Sketch & Guess: one for winning a game at a hub (asked for): the top score when it's over (`phase` turning `over`),
    ties all winning, more than nothing, against at least one other person. Never alone (the practice bots).
- On a token: "You won a scene token!" on the table, and `slToken`.

## 3. Scene Slots (`renderer/slots.js`, `#slTable`)

- A game scene (`slots`: main.js `SCENES`, `GAMES`; renderer `SCENES`, the Blackjack room's shader, `WB_GAMES`; tile
  picture `renderer/games/slots.jpg` from scripts/game-pics.js). Never a hub's: it doesn't go through the tables' machinery
  (`GAME_RULES`, `gm`); its holder is shown like theirs (`slHere`) and talks to main.js on its own `slots` command.
- **A pull** (asked for, then: "a lot more epic, Asian gacha game hype"): Pull ×1 (or Space / Enter), or Pull ×N, up to
  ten, with that many tokens, sends `{ op: 'spin', n }`. main.js `slotsSpin` picks n scenes at random (crypto) among those
  still locked, none twice, spends the tokens, unlocks them and saves, all at once, then tells that screen `{ won: [ids],
  left }` (or `{ error }`: no token, or nothing left to unlock; nothing spent). Then the summon plays out to them.
  **As it is now** (last asked for: "commit to one angle; the machine hops up and down after the pull and settles, then
  shows the result; the camera zooms into the middle of the slots and fades into white, showing the preview"): the camera
  stays at one angle (three-quarters on, a little from above). The lever yanks, the drums whirl, and the machine hops (up,
  a thud and a squash, up again smaller, its shadow shrinking under it while it's up) and settles (1.7 s). The drums wind
  down onto the scene won one after another (2.05, 2.42, 2.8 s), the middle row lit in its rarity's colour, the WIN readout
  set, the rarity slammed on (SR, SSR) and its fanfare. At 3.5 s the camera zooms into the middle of the reels (`.cam-zoom`:
  in along the line of sight, the angle kept), at 3.95 the screen goes white, and at 4.5 the white lifts off the scene
  itself, drawn live, with its banner, which fades; then it sits there (a click: the cards; another: put away). The orb,
  burst and face-down cards below were the summon before this, and are gone from it.
  **Then** (asked for: "no roll or tilt, so it feels stiff; I don't like multi-pulls; better sounds"): the hop rocks (tipped
  about the middle of its base: it leaves the floor tipping one way and leaning back, lands on the other side with a squash,
  smaller each time, a wobble on its feet at the end; 1.9 s), and the zoom rolls a little as it goes in. One pull at a time:
  one Pull on the deck and the bar, and main.js unlocks one a pull whatever it's asked; at the end a click puts it away (no
  cards to see). And a slot machine's sounds: `slLever` (a ratchet down its teeth, the clunk), `slReels` (a motor's whir
  under three trains of clicks, each thinning out as its reel slows to its stop), `slReelStop` (the chunk of a reel locking,
  a ding), `slThud` (each landing of the hop, the coins in the tray jumping), `slR` / `slSR` / `slSSR` (the bells trilling
  and coins pouring, longer and bigger, the SSR with the horns), `slWhoosh` (the zoom), `slShine` (the white).
  **Then** (asked for): no Pull on the scene won (the bar says "Click to go back to the machine", with Go to it and the
  tokens), and a click or Space there dips to dark (0.35 s), lets the scene go and fades the dark off the machine (0.4 s:
  slots.js `back`). And the reels' pictures are drawn ahead, not live: `renderer/scenes/<id>.jpg` (256 × 144, about 8 KB
  each), made by scripts/game-pics.js in a new settings folder's palette, Aurora, and turned round the colour wheel to the
  palette that's on (`--slHue` on the reels, a CSS hue-rotate: the palette's hue, its colours bar the darkest averaged round
  the wheel weighted by saturation, less Aurora's: app.js `paletteHue`). Instant where drawing each scene took a while, and
  close, a palette being mostly a hue. Run game-pics again when a scene's look changes.
  **Then** (asked for): suspense, the drums stopping at 2.1, 3.0 and 4.4 s (the last crawling round, over `slTense`, a
  quickening heartbeat and a rising tone), each winning card glowing as its drum stops, and a moment on them before the
  zoom (5.3 s; the white 5.75, the scene 6.3). The winning cards are a fill of their glow's colour, the rarity's, in place
  of their picture, and once the last stops the whole middle row is a glowing panel of it (`.slLine` filled). The palette's
  hue turn is on the pictures, not the reels, so the glow keeps its colour. The lever also plays a power-up recording the
  user gave (`renderer/sounds/sl-power-up.mp3`, 8 s, under the whole spin: sfx.js `SAMPLES`, through an `<audio>` of its
  own into the same chain): the one recording among Drift's sounds, everything else made in sfx.js. The machine is lit from
  one light up to its right (a pool of light on the front, shade falling off to the left and under each standing part, the
  lit sides brighter), and the front and side panels are lacquered in the app's accent colour (`--bjAccent`); its top isn't
  drawn (the camera never sees it), and its corners are rounded no more than its sides can meet.
  **Kept light** (asked for: "a lag spike after pressing the button"): nothing animates a box-shadow or a background
  position any more. The winning card's breathing glow did, from the pull on, and so redrew its whole drum (twelve
  pictures, each with its hue filter) every frame; now the glow is drawn once and a halo over it breathes by opacity, on a
  layer of its own, and so does the shine's flash. The edge strips chase by moving (a transform), and the bulbs, ticker and
  sign each have a layer of their own. A pull no longer rebuilds the drums' 36 cards (it changes only the card that comes
  round to the scene won, `spinAll`) or forces a layout per drum (one for the three). And the scene won starts building at
  once (app.js `R.warm`, in the background where the graphics card allows), so the reveal doesn't stall on it either.
  What it was before:
  - **Rarity, for show only:** five showpieces are SSR ★★★★★ (Mandala, Canyon Night, Julia Set, Menger Sponge, Apollonian
    Gasket), eleven SR ★★★★, the rest R ★★★ (slots.js `SSR`, `SR`). The pick stays even; the side says so.
  - **The charge** (0 to 1.75 s): the room goes dark, the reels blur, an orb at the window's middle gathers particles on a
    spiral, blue, going purple at 0.65 s if an SR or better is coming and gold with rainbow rings at 1.25 s for an SSR (the
    tease), `slCharge` and a `slTier` chime at each step up.
  - **The stop and the burst:** the reels slam onto the best card won (`slStop`), the line lit in its colour; a white
    flash, a pillar of light (rainbow for SSR), rings and a shower of particles (`slBurst`); an SSR shakes the cabinet.
  - **The cards** come down face down (Drift's mark in their rarity's light) and turn over: one big card, or ten in two
    rows of five, one after another, a rare one glowing and shaking a moment before it turns. Stars ding in one by one
    (`slStars3/4/5`), then the rarity is stamped on with NEW, and the fanfare (`slR`, `slSR`, `slSSR`: for a pull of ten,
    the best one's). An SSR card has a holo shimmer, and sparkles drift up after.
  - **Then asked for:** "the particles make it really laggy, and the dopamine really isn't hitting". The lag: the light was
    a canvas at twice the screen's size, every dot a gradient circle drawn on its own, hundreds at once, and after an SSR
    sparkles that never stopped; under it a blurred full-height pillar and blurred reels (CSS blur, redone every frame)
    and a blend-mode holo. Now: one canvas at the screen's own size, dots stamped from a few glow sprites made once, at most
    260 at a time, the drawing stopping as soon as nothing moves, sparkles only during the showcase, and no CSS blur or
    blend mode. The hit, added: an SSR's beat of dark and silence between the stop and the burst; the rarity slammed
    across the screen huge ("SR!", "SSR!!") as a rare card's stamp lands; in a pull of ten each card turning a step higher
    up a scale (`slPip0`…`9`); and **the showcase**: after the cards, the dark lifts off the best scene won, drawn live and
    full screen behind the machine (app.js `scenePreview`, set at the burst so there's no peeking before), the machine and
    the cards step aside, and a banner sweeps in with its rarity, stars and name (2, 2.8 or 3.8 s by rarity). Then (asked
    for) it sits there: the banner fades away and it's just the scene, live, with the bar (Go to it, pull again). A click
    shows the cards (all ten of a pull of ten, each a click away from its scene); a click on the dark puts it away.
  - A click (or Space) skips to the end; once it's over, a click on a card goes to that scene, Go to the best
    one, and a click on the dark puts it away. All the beats are timed (they land in a hidden window too), the light is a
    canvas drawn while it can be; with the PC set to reduce motion it goes straight to the cards, face up.
- **In 3D, with a camera** (then asked for: "more epic, perhaps 3D and camera movement"). CSS 3D, not a 3D library: the
  graphics card composites it, so it costs next to nothing (the lag lesson). The room has a perspective; the machine is a
  box (the cabinet its front, sides, top and back 10vh deep) with a lever out to its right; it's held by a camera rig
  (`.slRig`, moved beat to beat by CSS transitions: `.cam-idle` a slow drift round it, `-lever` a glance at the lever as
  it's yanked, `-charge` swooping in low and close, `-slam` head on as the last drum stops, `-close` right up close for an
  SSR's dark beat, `-kick` thrown back with a roll at the burst) and a shaker inside that (`.slShake`: a rumble through the
  charge, harder when an SSR's coming, and a jolt at each drum's stop and the burst), so camera and shake never fight. The
  reels are drums: ten cards round each, turning about the axle in the window's own perspective, clipped by it; each winds
  down onto the scene won (7, 9, 11 turns, stopping 0.26 s apart, with a little overshoot), the card it's on put round the
  back so it can't be seen coming. While it charges the dark is a vignette, so the machine stays in sight.
- **Redesigned as a real slot machine** (then asked for: "it doesn't even look like a slot machine", "it looks like a playing
  card with a texture on it", "add the sides"). The face, top to bottom: a crown (an arch of chasing bulbs, the gold neon
  sign, a scrolling red LED jackpot ticker); the reel window in a chrome bezel (three drums of twelve pictures, three rows
  showing, no names on them, the middle row framed and pointed at by the payline's arrows, glass glare); LED readouts
  (TOKENS, WIN: the last pull's best rarity, SCENES); the paytable; a button deck with the coin slot and two big arcade
  buttons that pull (×1, ×N); a coin tray; chasing light strips down both edges; red lacquer and gold trim. The side panel
  beside it went: the machine shows it all. And depth: the cabinet is `--deep` (22vh) deep with lacquered sides and top;
  the crown, bezel, readouts, paytable, deck (5vh, the most) and tray stand out as blocks (lit tops, shaded sides and
  undersides: `.slBlock`, `.slB`), the reels sit in a well behind the bezel (`.slW`; no deeper than the bezel stands out,
  or it's behind the cabinet's own face), and at rest the camera sees it three-quarters on (24°, swaying 14 to 28) and a
  little from above, with its shadow on the floor.
- (Before the redesign, a panel beside it showed your scenes, tokens and the rarities.)
- Sounds (`sl…`, behind "Game table sounds"): `slToken`, `slCoin`, `slSpin`, `slStop`, `slCharge`, `slTier`, `slBurst`,
  `slFlip`, `slStars3/4/5`, `slR`, `slSR`, `slSSR`; main.js plays them for the screen (`{ op: 'sfx' }`, only `sl` names).
- At a hub, friends see you're "on Scene Slots" (the where lists); clicking you takes them to their Scenes tab, since the
  machine is yours.

## 4. Tests

- `timeout 130 node scripts/test-slots.js` (about 20 s): one copy, locks on. Only the free scenes open; the tiles locked;
  picking a locked scene, clicking its tile and Next all refused; a screen can't give itself tokens; the token rules from
  made-up views (a grand prize, a plush, someone else's, one rolling in late, counted once; a fever round filled while
  seated, a fever only set off, watching, stood up, an older hub); Scene Slots with no token, then with one: a locked scene unlocked, the reels stop on it, its tile
  opens, saved, Go takes you there, the summon's sounds; then with ten tokens, Pull ×10 unlocks ten different scenes and
  deals ten cards, turned over one by one.
