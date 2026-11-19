# Plan: Widevine and captchas in Surf

Status: draft, 2026-11-18. Nothing here is implemented yet. Each plan starts with a short spike, because
a couple of the deciding facts can only be settled by measuring on a real build.

---

## 1. Widevine (Netflix, Disney+, Prime Video, Spotify web, etc.)

### Why it fails today
Stock Electron ships without the Widevine CDM, so `navigator.requestMediaKeySystemAccess('com.widevine.alpha')`
rejects and DRM sites show an error. Even with a CDM, two parts of `web.js` would still block it:
`setPermissionRequestHandler` / `setPermissionCheckHandler` only allow `fullscreen`, so the `mediaKeySystem`
permission would be refused.

### The only practical route: castLabs Electron for Content Security (ECS)
- ECS (`github.com/castlabs/electron-releases`) is a drop-in fork of Electron that follows upstream
  releases (tags like `v45.x.y+wvcus`) and installs Widevine through Chromium's component updater.
- Production services (Netflix in particular) also need **VMP (Verified Media Path) signing**, done with
  castLabs' free EVS service (`pip install castlabs-evs`, create an account, then `python -m castlabs_evs.vmp sign-pkg <app dir>`).
  Without VMP, Widevine loads but the big services refuse licences or cap quality badly.
- Licensing: ECS and EVS are free, but check Widevine's distribution terms (castLabs' README points at
  them) before shipping to the public.

### The hard question: can the stream reach friends at all?
Surf shares a page by capturing the tab (`getDisplayMedia` + `web.frame()` in `main.js:1477`). Chromium
may hand back **black frames for EME-protected video**, depending on whether decoding is hardware-protected.
Whether ECS + software Widevine (L3) on Windows is capturable is **unknown until measured**. It decides
the design:

| Spike result | Design |
| --- | --- |
| Protected video captures fine | Restream like any other page (works today's way). Still see the ToS note below. |
| Captures black (likely for some services) | **Watch-in-sync mode**: each friend loads the same page in *their own* Surf, signed in to *their own* account, and Drift only syncs play / pause / seek / which title over the existing P2P channel (the same sync used for local videos and "join a playing video"). |

Watch-in-sync is the better long-term design either way: it is how Teleparty-style apps stay within
streaming services' terms (restreaming one account's video to other households generally isn't allowed),
it uses no upload bandwidth, and every friend gets full quality.

### Spike results (2026-11-18, branch `widevine`, castLabs `v45.2.1+wvcus`)
- Widevine CDM 4.10.3112.0 downloads in about 2 s on first run. `requestMediaKeySystemAccess('com.widevine.alpha')` succeeds
  (software decode, L3).
- Google's Widevine test stream (Shaka "Angel One", cwip-shaka-proxy licence) plays in a Surf tab through `web.js`.
- **The sharing capture is not black.** `getDisplayMedia` on the tab's frame (the same path as `main.js`) shows the
  protected picture, as do `capturePage` and runs with hardware acceleration on and off. Friends can be streamed DRM pages as
  they are today, so watch-in-sync isn't needed for it to work (it may still be wanted for services' terms).
- The `mediaKeySystem` permission doesn't gate Widevine on Windows: it plays with Surf's fullscreen-only handlers, so
  those were left alone.
- castLabs has no 45.3.1 build, so the branch pins 45.2.1. `package.json` gets a `postinstall` because the castLabs package
  doesn't download its binary by itself. `dev-build` downloads castLabs' zip via a mirror and runs EVS `sign-pkg` when installed.
- Not yet tested: Netflix itself. It needs a VMP signature from EVS (a castLabs account) plus a Netflix sign-in.

### Steps
**Phase 0: spike (1 to 2 days)**
1. On a branch, swap `"electron": "^45.3.1"` for the matching castLabs tag in `package.json`.
2. In `main.js`, await `components.whenReady()` (ECS's API) before Surf first loads a page; log
   `components.status()`.
3. Allow `mediaKeySystem` in both permission handlers in `web.js` (lines 67 and 68).
4. Test on `bitmovin.com/demos/drm` (no VMP needed), then on Netflix with an unsigned build (expect a refusal), then
   VMP-sign the dev build and try Netflix, Disney+, Prime Video and Spotify.
5. Share a playing DRM tab with a second PC. Record whether the friend sees video or black, with
   hardware acceleration on and with it off.

**Phase 1: ship Widevine for the host**
- `scripts/dev-build.js`: point `@electron/packager` at castLabs' builds (its `download.mirrorOptions`
  mirror, or `electronZipDir`), then run the EVS `sign-pkg` step after packaging. On Windows, VMP signing goes
  **after** any Authenticode signing.
- Release zip: the `.sig` files EVS writes must be in `Drift-Windows-x64.zip`. `updater.js` copies the whole folder, so
  existing installs pick up the ECS binary and signature on their next update. Test one update from 1.5.x, because
  it replaces `Drift.exe` itself.
- First run: Widevine downloads in the background (a few MB). Show "Getting ready to play protected video…"
  if a DRM page loads before it's ready, instead of the site's cryptic error.
- Unsigned dev builds (post-commit hook) keep working. Only DRM playback on the big services needs signing.
- README: replace "Drift's browser has no Widevine" with what now works and the expected quality (these
  services usually cap Chromium-based browsers at 720p or 1080p).

**Phase 2: sharing DRM pages** (depends on the Phase 0 result)
- If capture is black: detect it (the page created a `MediaKeys` session, which can be seen from the guard preload in its isolated world,
  or from known service hosts) and, instead of streaming black, tell friends: "Netflix can't be streamed.
  Open it on your side to watch in sync."
- Watch-in-sync: the host's Surf reports `{ url, currentTime, paused, rate }` of the main `<video>`. The friend's
  Surf opens the same URL, and a small isolated-world script nudges their `<video>` to match, using the
  same drift tolerance as the local-video sync. Each side signs in for themselves. Nothing is restreamed.

**Risks**
- castLabs lags upstream by days to weeks. Electron upgrades wait for it.
- Services can tighten their checks at any time (Disney+ has been strict with non-Chrome Chromium builds).
- EVS signing adds an account and a Python step to the release process.

---

## 2. Captchas (endless Cloudflare / reCAPTCHA / hCaptcha loops)

### Why it's probably failing
Bot checks score how *consistent* a browser is, not only whether it is Chrome. Surf currently gives off
several inconsistencies:

1. **Unreduced UA.** Electron's UA carries the full `Chrome/1xx.0.NNNN.NN`, but real Chrome has sent
   `Chrome/1xx.0.0.0` since UA reduction. `web.js:66` strips `Electron/` and `Drift/` but leaves the full version.
2. **Hand-written client hints.** `web.js:72-80` builds `sec-ch-ua` itself. The GREASE brand
   (`"Not:A-Brand";v="8"`) is hard-coded and changes between Chromium versions, so it may not match
   `navigator.userAgentData.brands`. High-entropy hints that sites ask for with `Accept-CH`
   (`Sec-CH-UA-Full-Version-List`, `-Platform-Version`, `-Arch`, ...) are never sent, while
   `getHighEntropyValues()` in JS still answers. That is a header vs JS mismatch, which is exactly what these checks look for.
3. **The ad blocker.** The ads-and-tracking lists can block or cosmetically hide parts of challenge
   scripts and iframes (`challenges.cloudflare.com`, `www.google.com/recaptcha`, `www.recaptcha.net`, `hcaptcha.com`).
4. **A brand-new, isolated profile.** `persist:web` has no history with Google, so reCAPTCHA v3 / Enterprise
   scores start low. Some of this is expected for any fresh profile and can't be fixed.
5. **Google sign-in** refuses embedded browsers on purpose. That's policy, not a captcha. `outside.js` already handles
   it correctly by sending you to the real browser, so leave it.

The goal is to make Surf an honest, self-consistent Chromium browser, not to disguise it or defeat
bot detection. Don't add fingerprint spoofing, stealth patches or solver services.

### Findings so far (2026-11-18, Electron 45.3.1 / Chromium 156)
- **Done in `web.js`:** UA reduced to `Chrome/156.0.0.0`. The `Sec-CH-UA` headers are now built from the real
  `navigator.userAgentData` (read from a Drift window) instead of hard-coded. Sites that ask with `Accept-CH` get the
  detailed hints, on their own page loads and `fetch` calls, as Chrome does. Checked against a local https echo server:
  the headers match what JS reports.
- Electron sends **no** client hints of its own, untouched and even when asked with `Accept-CH`. So `app.userAgentFallback`
  (option a) can't help. `Emulation.setUserAgentOverride` (option b) only adds the basic hints to subresources, never to
  page loads, so it doesn't fix the mismatch either. Header injection is the right tool.
- **The ad blocker doesn't touch captchas.** Against the real cached lists, no Cloudflare, reCAPTCHA, hCaptcha or Arkose request is
  blocked, and the blocker's cosmetic preload only runs in top frames, so challenge iframes get no scripts or CSS.
  Phase 2 isn't needed.

### Steps
**Phase 0: measure (half a day)**
- Load the same pages in Surf and in Chrome on the same PC: a client-hints echo page, `navigator.userAgentData` +
  `getHighEntropyValues()` in DevTools, and a few challenge pages (Cloudflare's Turnstile demo,
  Google's reCAPTCHA demo, hCaptcha's demo, plus whichever real sites loop).
- Run each with the blocker on and off, and once with `nodeIntegrationInSubFrames` and the guard preload disabled, to
  rule them out. Write down which variable ends each loop.

**Phase 1: consistent identity (most likely the biggest win)**
- Reduce the UA: `Chrome/${major}.0.0.0`, with no app tokens.
- Remove the hand-written `onBeforeSendHeaders` hints. Have Chromium produce hints from one source of truth instead.
  Try these in order:
  a. Set `app.userAgentFallback` at startup instead of `ses.setUserAgent`. If Chromium then keeps sending its own
     native client hints (check with the echo page), that's the simplest fix.
  b. Otherwise, per tab, `wc.debugger.attach()` and send `Emulation.setUserAgentOverride` with both `userAgent` **and**
     `userAgentMetadata` (brands copied from `navigator.userAgentData` itself, full version list, platform,
     platformVersion, arch). Chromium then generates matching low- and high-entropy headers and honours `Accept-CH`.
     Only use the `Emulation` domain: don't enable `Runtime`, because sites can detect that.
- Add a dev self-check (the `DRIFT_DEBUG`-style test harness already in `main.js`) that loads an echo page and fails
  if any header differs from what JS reports.

**Phase 2: keep the blocker off challenges**
- Add exception filters for challenge hosts (`@@||challenges.cloudflare.com^`, `@@||google.com/recaptcha^`,
  `@@||recaptcha.net^`, `@@||gstatic.com/recaptcha^`, `@@||hcaptcha.com^`) to the engine after it loads in
  `loadEngine()`, with no cosmetic filters on those frames.

**Phase 3: a graceful way out when it still loops**
- Recognise a challenge in the front tab: a Cloudflare interstitial title ("Just a moment..."), or a challenge iframe
  that's still there after N seconds or N reloads.
- Show a small bar on the host's screen only: "This site keeps asking you to prove you're human. Open it in Edge instead?",
  which calls the existing `goOutside()`. Friends keep watching the window there.
- Captchas are for the host to solve. If a friend is driving the page, show them "Waiting for <host> to finish a check",
  since synthetic remote input makes challenges harder for everyone.

**Phase 4: smaller consistency items, only if Phase 0 shows they matter**
- The permission check handler answers "denied" for everything. Fresh Chrome answers "prompt", which a few checks read.
  Electron's check handler is boolean-only, so this may not be fixable cleanly. Measure before trying.

**Risks**
- Bot vendors change their checks without notice, so expect recurring maintenance. The Phase 1 self-check catches
  regressions after Electron upgrades.
- If ECS is adopted (plan 1), redo Phase 0 on it, since its UA and brands are the same code path.

---

## Suggested order
1. Captcha Phases 0 to 2: small, low risk, and likely to fix most loops.
2. Widevine Phase 0 spike: decides whether sharing DRM pages means restreaming or watch-in-sync.
3. Widevine Phase 1 (host playback), then captcha Phase 3, then Widevine Phase 2.
