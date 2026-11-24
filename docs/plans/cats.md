# Plan: cats drawn once, then only moved

Status: built, 2026-11-23 (steps 1–5; step 6 left until measured). `scripts/test-cats.js` checks it. What changed from the
plan while building it:

- The glow around the whole cat (the old CSS drop-shadow) can't be baked into each layer: the body's glow would then lie over
  the tail. Each piece's glow is its own image instead (`haloBang`, `haloTail`, `haloBody`), behind all of the cat, moving with
  its piece. Asleep nothing moves, so there the glow is baked into the picture.
- Asleep is one picture of the whole cat (fur faded to .22 as one piece), not layers, plus the three z's.
- Chromium blurs a CSS `drop-shadow` with its length as the standard deviation (a canvas `shadowBlur` is twice that), so the
  glow reaches ~48 px out: the images reach 56 px past the cat (`PAD` in `cats.js`).
- The paw line is a plain `overflow: hidden` box (`.catClip`), not a cut in the bitmaps, so the tail's swing can't show below it.
- Images are `data:` URLs (the page's CSP has no `blob:`).
- The test holds the stacked layers up against the whole cat drawn as one with CSS's own drop-shadow (`Cats.reference()`): they
  differ by ~0.13/255 on average, at most ~10/255. The blink now squashes the eyes' glow with them (it was outside the
  transform before); it lasts a fraction of a second.
- Not measured yet: the GPU process's CPU with 12 cats on each monitor (§4). Hidden test windows don't run animations.
- Step 6 is built after all: drawn once, awake cats still had YouTube in Surf stutter (every window is composited again each
  frame while anything in it moves). The cats sleep while a Surf page makes sound (`S.web.audible`) or a friend's live Surf
  stream shows. `DRIFT_CATCOST=1` (main.js, a normal visible run) measures the GPU process with the cats off, awake, asleep,
  and awake with the chat's blurred boxes unblurred, to decide whether to do more (moving in bursts, fewer moving parts).

The cats (Summon the cats) look the same and move the same, but each piece of a cat is drawn once into a small bitmap,
and the animations only move and fade those bitmaps. Today every awake cat is drawn again from scratch on every frame, in
every window, and with many cats that left no room in Chromium's GPU process for a 60 fps video in Surf.

## 1. Why: what was measured

Found by driving a live Drift (three monitors, Surf drawn on the graphics card, several cats on each screen) through its
inspector:

- YouTube in Surf kept going into "buffering" for about 20 s at a time **with 17–55 s of video already downloaded**, and
  dropped up to 81 of its first 89 frames. Only 60 fps video did this; 24 and 30 fps played cleanly.
- The same videos, at the same quality and codec (720p60 AV1), played perfectly in a hidden test copy of Drift at the
  same time. The network, YouTube, the ad blocker, the Drift window showing the page and Drift's main process were all
  ruled out by live A/B tests.
- **Drift's GPU process ran at 86% of one CPU core on average, peaking at 97%.** Chromium's GPU process does its work on
  one main thread, and every Drift window, the offscreen Surf page and the video's frames all go through it. The graphics
  card itself was only ~23% busy.
- GPU-process CPU over 10 s, toggling one thing at a time in the live windows:

  | Condition | GPU process |
  |---|---|
  | Baseline | 93–115% of a core |
  | Scenes slowed to 1 fps | 93% |
  | **Cat animations paused** | **58%** |
  | Surf bar hidden | 119% |

  The number of cats is what matters: the cost grows with every awake cat on every screen.

## 2. Why each cat is expensive now

Each cat is a full inline SVG (`renderer/index.html`, `#coCat`), copied up to 12 times per window (`renderer/app.js`,
`catEls`). Each one carries:

- radial and linear gradients (`catFur`, `catPaw`, `catTailFur`, `catRim`, `catEar`, `catGround`);
- a mask (`catLit`) and a clip path (`catBodyClip`);
- two Gaussian-blur glow filters (`filter="url(#catLight)"` on the glow and the face);
- a two-layer CSS `drop-shadow` on the whole cat (`.coCat` in `renderer/style.css`).

Four animations run on it (`style.css`, `catBreathe`, `catTail`, `catBlink`, `catBang`). Three of them move **parts of
the drawing** (the tail group, the eyes group, the glow group). Chromium can't move part of an SVG on its own layer, so
on every frame it redraws the whole cat, blurs and shadows included: 60 times a second, per awake cat, per monitor, all
in the one GPU process.

The cats already fall asleep (stop animating) while a video plays in Drift's own player (`app.js`, `asleep`: "with a 4K
video that left no room for its frames"). They don't for a video in Surf.

## 3. The rework

Split the cat into a few layers, draw each layer **once** into a small bitmap with the gradients, mask, blur and drop
shadow baked in, and animate only `transform` and `opacity` on those bitmaps. The compositor moves finished textures
without redrawing anything, so the per-frame cost is close to nothing, and the motion (same keyframes, same timings) is
unchanged.

### Layers, back to front

| Layer | From the SVG | Animation |
|---|---|---|
| glow ("bang") | `.catBang` | opacity 1 ↔ .35, 4.4 s (as now) |
| tail | `.catTail` | rotate −4° ↔ 6°, 2.8 s, pivot at 13% / 91% of the tail's box (as now) |
| body | ground glow, fur, ears, paws, shading, nose and mouth | none |
| eyes open | `.catEyes` | blink: scaleY(.08) at 95%, 5.2 s (as now) |
| eyes shut | `.catShut` | none; shown only asleep |
| z, Z, Z | the three `.catZ` paths | none; shown one at a time asleep (`data-z`, as now) |

Each cat becomes a wrapper `div.coCat` holding one `<img>` per layer. The wrapper keeps today's breathe (scale
1.035 / .97, 3.6 s, origin at the bottom middle), pop-in (`catIn`) and fade-out (`catOut`). Those are transforms and
opacity on one composited layer, so they cost nothing either.

### Steps

1. **Draw the layers, once per window** (a new `renderer/cats.js`).
   - The drawing stays in `index.html` as a hidden template. It is never shown.
   - For each layer, clone the SVG and keep only that layer's group (with the `<defs>` it uses).
   - Replace each `var(--cat-…)` with its real colour, read once with `getComputedStyle` from an element carrying the
     `.coCat` variables. A stand-alone SVG image can't see CSS variables.
   - Turn the clone into an image (a `Blob` of the SVG text) and draw it into a canvas at the cat's on-screen size ×
     `devicePixelRatio` × about 1.1. The 1.1 is headroom for the breathe, so it stays sharp at its largest.
   - Bake the drop shadow into the canvas there: `ctx.filter = 'drop-shadow(...)'` with the values from `.coCat` today.
   - Cut each bitmap at the paw line (6.3% above the bottom of the drawing), which replaces the `clip-path` on `.coCat`.
   - Keep each layer as an object URL (`canvas.toBlob`). A cat is at most 37 px wide, so all the layers come to a few KB.
   - Read the pivots from the SVG's own boxes (`getBBox()` of `.catTail` and `.catEyes` in the hidden template) and turn
     them into `transform-origin` values for the tail and eyes images. That reproduces today's `transform-box: fill-box`
     pivots exactly.

2. **Build the cats from those images.**
   - Replace the 12 cloned SVGs (`app.js`, `catEls`) with 12 `div.coCat` wrappers of `<img>` tags.
   - Every cat in a window uses the same object URLs, so each image is decoded once.
   - Keep what the rest of the code and the tests use: the `.coCat`, `.here` and `.leaving` classes, `--cat-x`,
     `data-name`, `role="img"` with `aria-label`, the hover name tag (`#coCatTag`) and the out-of-step breathing
     (`animationDelay` per cat).

3. **Animations** (`style.css`).
   - Move each `@keyframes` onto its layer's image, with `will-change: transform` (or `opacity` for the glow) so each
     image is its own layer.
   - Remove the CSS `filter: drop-shadow(...)` and the `clip-path` from `.coCat`: both are baked into the bitmaps.
   - Keep `prefers-reduced-motion` turning every animation off.

4. **Asleep.** Asleep, a cat uses darker colours, its fur faded to .22 (as one piece), its face at .6, a dimmer glow,
   shut eyes and the z's.
   - Draw a second set of layers with the asleep colours and opacities, and switch sets with `.asleep` on
     `#chatOverlay`. Only the image sources change; nothing is drawn again.
   - The z's stay stepped by `data-z` from `app.js`: three small images shown one after another.

5. **Drawing again.** The bitmaps depend on things that change rarely. Draw them again (debounced) and swap the sources
   when any of these changes:
   - the theme's accent (a palette switch: the cats' colours are mixed from it);
   - the window's `devicePixelRatio`;
   - the cat's size (`--cat-w` is `clamp(23px, 2vw, 37px)`, so it follows the window's width).

6. **Optional safety net:** the cats also fall asleep while a Surf page plays video (one more condition beside
   `S.videoLeader` in `app.js`'s `asleep`). After the rework this shouldn't be needed. Measure first (§4), and only add
   it if the numbers say so.

## 4. How to check it

- **It looks the same.** Close-ups of one cat, old and new, side by side, in each pose: awake, mid-blink, tail at each
  end, mid-breath, asleep with each z. On two palettes (a dark accent and a light one). The cat tests already take close-ups
  (`DRIFT_TESTCATS`, `DRIFT_CATNAP` in `main.js`): run them on both versions and compare. They should differ only in
  antialiasing. (Turn transitions off first: hidden test windows don't run them.)
- **It costs less.** 12 cats on each of three monitors, awake. The GPU process's CPU, measured as in §1, should be close
  to the "cat animations paused" figure (58% of a core in that session), not the 93–115% of today.
- **YouTube plays.** A 60 fps video in Surf with the cats awake: no "buffering" while video is buffered ahead, and few
  dropped frames (YouTube's own count, `getVideoPlaybackQuality()`).
- **Nothing else breaks.** `scripts/test-chat.js` and the `DRIFT_TESTCATS` run (names, hover tag, asleep, z's, cats
  moving between screens) pass unchanged, since the classes and attributes are kept.

## 5. Risks

- **The glow and shadow are drawn at one size.** Scaled up they would blur, so a change in the cat's size or the
  screen's scale draws them again (step 5) rather than stretching them.
- **Colours are fixed when drawn.** `color-mix(in oklab, …)` is resolved to plain colours at draw time, so a palette
  change must draw the cats again (step 5). It is easy to miss, so the close-ups in §4 cover two palettes.
- **The tail's pivot.** Today it uses the SVG's `fill-box`. Taking the same box from `getBBox()` reproduces it, but it's
  the one thing to check by eye in the close-ups.
- **Clip at the paw line.** Cut into the bitmaps, the tail's swing could show a sliver below the line that the old
  `clip-path` hid. If it does, keep a `clip-path` on the wrapper: it isn't redrawn per frame when nothing inside it is
  redrawn.

## 6. Files

- `renderer/cats.js` (new): drawing the layers from the template, the colours, pivots, and drawing again on changes.
- `renderer/index.html`: the template stays; it is hidden and loads `cats.js`.
- `renderer/app.js`: `catEls` builds wrappers of images instead of cloning the SVG; the asleep switch picks the image set.
- `renderer/style.css`: the keyframes move onto the layer images; `.coCat` loses its `filter` and `clip-path`.
