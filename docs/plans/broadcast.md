# Plan: one voice room per hub, Broadcast, and shared pointers

Status: design settled (§11), 2026-11-22. The spikes are done and measured (§10, "Spike results"). Phases 1–7 are
built and tested (§10, "as built"): one room per hub, the broadcast protocol, the broadcaster, the viewer's full-screen
Broadcast view, the indicators, shared pointers and sound. This is Phase 4 of
`voice-and-chat.md` ("sharing into voice") in more detail. It also changes Phase 3 (calls) as built.

Three parts, built in this order, each on top of the one before:

1. **Hubs and calls become one** (§1). Being online in a hub means you're in its voice room, listening. Talking is
   something you opt into: your microphone stays closed until you turn it on. There's no separate "call" to start,
   join or leave.
2. **Broadcast** (§2–§8). Anyone in the hub can pick **one of their monitors or one application window** and stream
   it, picture and (optionally) sound, to the others. It gets a new panel tab, **Share** (first called Broadcast). Viewers watch on
   whichever of their monitors they choose.
3. **Shared pointers** (§9). While you watch someone's broadcast, your mouse pointer shows **on their real screen**,
   drawn over their game or program by a transparent overlay, and on every other viewer's copy of the stream. It's
   the same idea as the pointers in a shared Surf page today.

Broadcast is **not** watch together. Watch together plays the host's *files* (and Surf pages) in step on everyone's
PC, at full quality, and friends can control them. Broadcast is a live picture of something running on your PC, like
Discord's Go Live. They sit side by side and share code where they can.

---

## 0. What already exists to build on

- **Calls** (`chat.js` "calls", `hub.js` `voice-*`, `turn.js`, `renderer/voice.js`): one call per hub, up to 8 people, a
  mesh, relayed through the hub's TURN server by default. Every SDP is signed (`drift-voice-v1 …`, `signSdp` /
  `verifySdp`), each call uses fresh `RTCCertificate`s, and the certificate actually used is checked against the
  signed one after connecting. The hub only passes setup messages along and is assumed hostile.
- **Page streaming** (`renderer/app.js` around line 915): `getDisplayMedia` routed through
  `setDisplayMediaRequestHandler` in `main.js`, one capture shared by every viewer's `RTCPeerConnection`, H.264 put
  first when the graphics card encodes it efficiently (`videoCodecs()`), an 8 Mb/s cap, and a viewer that asks again
  when the picture stops (`#webStream`).
- **Shared pointers on a Surf page** (`#ptrs` / `.ptr` in `renderer/app.js` around line 826, `web-ptr` in `main.js`):
  a labelled pointer for each friend, fading after 6 s without moving.
- **The push-to-talk helper** (`main.js` around line 1208): a PowerShell `Add-Type` script calling `user32.dll`. §9
  uses the same kind of helper to follow a window's position.
- **The call bar** (`#callBar`, `drawCall` in `renderer/chat.js`): on every screen during a call. It fades when idle
  and also shows the watch-together session.

## 1. Hubs and calls become one

Today a hub has text channels, and separately a call you start, join and leave. That's two ideas to learn, two lists
of who's here, and an extra step before anyone can talk or (with Broadcast) share a screen. The proposal is that they
become one.

### 1.1 The model

- **Online in a hub = in its voice room, listening.** You hear whoever is talking. There's no Join button.
- **Talking is opt-in.** Your microphone is **closed** (not just muted) until you press **Talk**. Pressing it opens the
  mic, and pressing it again closes it, so Windows' microphone indicator goes away too. Push-to-talk still works: it
  opens the mic once, then only sends while the key is held.
- **The mic starts closed every time Drift starts**, whatever it was last time, so nobody is ever live by surprise. A
  setting, "Keep my microphone on between sessions", is off by default.
- **Listening can be turned off** (today's Deafen, renamed **Don't listen**). You stay in the hub's chat but hear
  nothing and aren't connected to anyone's voice.
- **Several hubs**: you're in the voice room of **one hub at a time**, your *active* hub. That's the one open in
  the Hub tab, or one you pin. Your other hubs are text only until you switch. Hearing two rooms at once would be chaos,
  and two meshes cost twice as much.
- **Disconnect** (new): go offline from a hub without leaving it, to stop hearing it and stop being shown online. It
  reconnects when you click the hub again, or on the next start if "Connect on start" is on (today's behaviour). It's
  different from **Leave hub**, which needs a new invite to come back.

### 1.2 What changes underneath

- **Connections only where someone talks.** A voice connection between two people is only needed when at least one of
  them has their mic open (or is broadcasting). Two listeners don't need one. So the mesh is "talkers × everyone",
  not everyone × everyone. That lets the room be bigger than today's 8-person call: 16 people online with 3 talking is
  about 40 connections, each idle with DTX. When someone presses Talk, connections are set up to everyone listening.
  That takes about a second, so the first word may be clipped. Decision §11.1 is whether to pre-connect everyone
  instead while the room is small.
- **The voice window** lives while you're connected to your active hub, not just during a call. It still **never
  opens the microphone** until Talk. Connections it makes before then are receive-only.
- **The room id** replaces the call id in the signed text. The hub makes a fresh one whenever the room empties (no one
  online), and also whenever someone is removed, so an old signed offer can't be replayed into a later room (the
  voice plan's replay reasoning carries over unchanged). Each voice window still makes fresh certificates.
- **Hub protocol**: `voice-join` and `voice-leave` go. Being online implies the room. `voice-state` gains `talk`
  (mic open) and `listen`. `voice` (the roster) becomes the hub's member list with those flags. `voice-signal`
  stays as it is. The relay's `allowed(member)` becomes "online in this hub and listening".
- **Overlay chat** ("unheard" messages over the video) keeps working: `canBeHeard()` is now "online, talking, and not
  muted". Someone who hasn't pressed Talk is "unheard", so their typing shows over the video. That's the point of the
  setting.

### 1.3 In the UI

- **Hub**: the Voice section and its Start/Join/Leave buttons go. The People list shows who's talking (speaking
  ring, mic icon) and who isn't listening. Volume sliders stay, on each person.
- **The call bar becomes the hub bar.** On every screen while you're online in a hub: the hub's name, the faces of
  whoever is talking, **Talk** / **Mute**, **Listen** / **Don't listen**, and **Disconnect**. It fades when idle, as now.
  It is never fully hidden while your mic is open or you're live.
- **Tray**: grey = connected, mic closed. Red = mic open. Clicking it toggles Talk.

### 1.4 What this costs

- `scripts/test-calls.js` and `test-voice.js` are written around starting and joining a call. They move to Talk and
  "connections only where someone talks", and gain checks that the mic never opens before Talk, and that a pair of
  listeners never connects.
- Privacy: before, being in a call was a choice. Now everyone in a hub can see you're listening while you're online.
  That's the same thing the People list already shows, so it seems fine, but it's a change.

## 2. Broadcast: how it works, end to end

```
Broadcaster                         Hub (hostile)                     Viewer
-----------                         -------------                     ------
Share tab → pick source
broadcast window captures it
chat.js: bc-start {id,title,kind} ─▶ checks: online, ≤ limits
                                     roster `bc` to the hub ─────────▶ card: "Sam is broadcasting Screen 2"
                                                                       Watch → pick a monitor
                         ◀────────── bc-signal (want, signed) ◀─────── chat.js signs `want`
chat.js verifies, signs offer ─────▶ passes on unchanged ────────────▶ chat.js verifies → screen window
       ◀══════ DTLS-SRTP video (+ sound) + pointer data channel, relayed by turn.js, end-to-end encrypted ══════▶
```

- **One `RTCPeerConnection` per viewer**, all fed by a single capture (as page streaming does today). It is a mesh,
  so there's no server decoding anything, and it stays end-to-end encrypted like voice. Each connection also carries
  a data channel for pointers (§9).
- **Signed the same way as voice**, with its own domain so a voice SDP can't pass as a broadcast one or the other
  way round: `drift-broadcast-v1 \n hub pin \n room id \n broadcast id \n from \n to \n nonce \n fingerprints`. The
  same `verifySdp`, nonce checks, refusal on failure, and certificate check after connecting. The viewer's padlock
  appears on the broadcast card exactly as it does on people in voice.
- **Relayed through the hub by default** (`iceTransportPolicy: 'relay'`), direct when "Connect directly" is on. This
  hides IP addresses, as in voice.
- With §1 in place, **anyone online in the hub can broadcast and watch**. Watching doesn't open your mic.

## 3. The processes

- **Capture: a hidden broadcast window** (`renderer/broadcast.html` + `broadcast.js`, sandboxed preload like
  `voice-preload.js`). It is made when you start broadcasting and destroyed when you stop, so the capture can't
  outlive the broadcast. It never sees a key or the hub. It holds the capture, the per-viewer connections and their
  certificates, and it reports stats (frame rate, bitrate, each viewer's state and `remoteCertificateId`). It is not
  the visible screen windows, because those are rebuilt whenever the monitors change.
- **Picking the source: `main.js`**. `desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize,
  fetchWindowIcon: true })` fills the picker. The chosen source id is held in `main.js`, and the
  `setDisplayMediaRequestHandler` branch for the broadcast window hands over exactly that source and nothing else. A
  page can never choose its own.
- **Watching: the screen window on the monitor the viewer picked.** It gets a `<video id="bcView">` over the scene
  (like `#webStream`). Its connection is set up from SDP that `chat.js` has already verified. When the monitors change,
  the window is rebuilt and asks again, the same "no picture for 6 s → ask again" logic `#webStream` uses.
- **Pointers on the broadcaster's screen: overlay windows** (§9), made while live, only if anyone's pointer is shared.
- **Signalling: `chat.js`** signs and verifies, keeps the roster of broadcasts and enforces the limits.

## 4. Hub protocol for broadcasts (`hub.js`)

| Message | From → to | What the hub does |
| --- | --- | --- |
| `bc-start {id, title, kind, audio}` | broadcaster → hub | Accepts only if the sender is online and under the limits (§11). `title` is the source's name, cut to 80 characters (the broadcaster can rename it). |
| `bc-stop {id}` | broadcaster → hub | Removes it. Also automatic on disconnect or removal. |
| `bc {list}` | hub → everyone in the hub | Who is broadcasting what, and who is watching. |
| `bc-signal {to, d}` | either → hub → other | Passed on unchanged, counted against the existing 200 per 10 s `signals` limit. |
| `bc-watch {id, on}` | viewer → hub | So the roster can show viewers, and so the relay lets in a viewer who has turned listening off. |
| `bc-thumb {id, img, sig}` | broadcaster → hub → everyone | A still for the Broadcast grid (added 2026-11-23): a JPEG of at most 200000 characters (up to 1600 px wide), every 10 s; a hub's `hello` says how large it takes (`still`), and for a hub that doesn't say (an older one, whose 16 KB line limit would hang up on more) a 14000-character one goes instead, signed by the broadcaster (`drift-broadcast-still-v1`, hub pin, broadcast id, sender, SHA-256 of the image). The hub passes it on at most every 4 s, keeps the latest for people who come online, and drops it with the broadcast. Viewers drop any still that isn't signed by the member the roster names. |

- **Relay access**: `allowed(member)` becomes "online and listening, **or** watching a live broadcast". Allocation
  limits: one viewer is about 2 allocations, and 2 broadcasts with 7 viewers each add about 28 on top of voice.
  `perMember: 24` and `maxAllocations: 128` may need raising for bigger rooms (§1.2). The tests should check it.
- A hostile hub can lie about the roster (hide a broadcast, invent one, say the wrong title). It can't put a picture
  on anyone's screen: the viewer only accepts an offer signed by the member the card names, for the broadcast id they
  asked for. The title on the card comes from the hub, so say it's "what they called it", not proof. Pointers travel
  in the end-to-end data channel, so the hub never sees them.

## 5. The Share tab

**Changed 2026-11-23**: Broadcast is a scene, like Scenes, Media and Surf. Picking its tab turns that screen into the
**Broadcast grid**: a black screen with a tile for each broadcast in the hub (yours too), showing a still of it (`bc-thumb`,
§4) until it's watched. Picking Scenes, Media or Surf on that screen puts the grid away and stops whatever was playing in
it; Hub and Settings leave it be. The tiles are all 16:9 and as large as fit (every split into rows and columns is
tried, and the largest wins), with the name and buttons over each tile so no room goes on labels (as glass pills along its top: along the bottom,
Drift's bar came up over them; on a tile that's playing they fade with the hub bar when the mouse rests). The page
described below (Go live, and while live, how it's going) opens over the grid from its **Go live** button, a tile's
**Manage**, or by picking the tab again. **Live now** and the monitor picker are gone: you watch on the screen you picked
the tab on (picking it on another monitor moves the grid there, streams and all). Your own tile has **Preview**: what
you're sending, live and silent, in the tile. The screen window captures the same source a second time (main.js lets that
window have exactly that source, picture only, once); nothing goes through the hub, and a Switch source starts it again on
the new one.

A sixth tab between Hub and Settings: `Share`, with a red dot on the tab button while you're live.

**Layout (2026-11-23)**: the page is two columns. Going live: the screens and applications on the left, and on the right a
column that stays in view as the left one scrolls, with a large picture of what's picked, **Go live**, then Quality, Sound
and Viewers' pointers. So Go live is always on screen, however many windows are open (it used to sit under every tile and
setting). While live: the picture, the stats and Switch source / Pause / Stop on the left; Watching (with a count), Sound and
pointers on the right. **Switch source** puts the picker in place of the live page until Switch or Cancel.

**Not online in a hub**: one line, "Connect to a hub in the Hub tab to share your screen".

**Live now** (top): a card for each broadcast in your active hub. It shows the face, "Sam · Screen 2" or "Sam ·
Elden Ring", sound on/off, viewers, the padlock, and **Watch** (with a monitor picker: "This screen", or Monitor
1/2/3) or **Stop watching**. Your own card shows a small live preview instead.

**Go live** (when you're not broadcasting):
- **Screens**: a thumbnail for each monitor, "Drift is showing here" on any monitor Drift covers (broadcasting that one
  shows your scene, which is allowed but probably not what was meant).
- **Applications**: window thumbnails with app icons, refreshed every few seconds while the tab is open, nothing
  captured until you press Go live. Drift's own windows are left out.
- **Quality**: *Auto* (default), *Text and detail* (up to source resolution, 15–30 fps, `contentHint: 'detail'`),
  *Smooth* (720p60 / 1080p60, `contentHint: 'motion'`). Hints and a per-viewer bitrate (§7) do the rest.
- **Sound**: Off / On (see §8; built in Phase 7).
- **Viewers' pointers**: Show on my screen / Don't show (§9). Default: show.
- **Go live** button.

**While live**: what you're sending (preview), who's watching (each with a "hide their pointer" toggle), **Switch
source** (re-open the picker, then `replaceTrack`, with no renegotiation so viewers don't drop), **Pause** (track
disabled; viewers see "Paused"), and **Stop sharing**.

## 6. Watching

**Changed 2026-11-23**: from the grid (§5). **Watch** on a tile fills the screen with that broadcast, with the slim bar
along the top: **← Back**, who and what, the padlock, the volume, **Share my cursor**, and **Stop watching** (the "Also
live" switches are gone: Back is how you get to the others). **Back** (or Esc) returns to the grid, where it goes on
playing in its tile on the same connection. With more than one broadcast up, each tile also has **Preview** (an eye; then
**Stop preview**, a crossed-out eye: named "Play in grid" and "Stop" until 2026-11-23), so several can play side by side. Each one watched is its own connection in the screen's window. While one fills
the screen the others stay connected but hidden and quiet; in the grid, everything playing is heard. Pointers and cursor
sharing are for the full-screen view only.

**Changed 2026-11-22**: watching is its own full-screen **Broadcast view**, and sharing your cursor is **opt-in for each
broadcast** (it was on by default, §11.7). The Share tab is where you choose whose broadcast to watch, on which
monitor, and whether they see your cursor. The view has a slim bar along the top (it shows when the mouse moves):
who and what, the padlock, **Share my cursor**, the other live broadcasts to switch to, and **Stop watching**.


- The stream fills the chosen monitor over the scene, letterboxed (`object-fit: contain`). The chat overlay, cats and
  hub bar stay on top. Esc or the hub bar's **Stop watching** ends it.
- If the monitor is already playing a watch-together video, ask "Watch Sam's broadcast on this monitor instead?".
  Drift won't play two things on one screen.
- There's a volume for the broadcast's sound, separate from the person's voice volume (`voice.volumes` gets a
  `bc:<member>` key).
- **Your pointer is shared while you watch** (§9), with "Share my pointer" in the hub bar to turn it off.
- It never starts by itself. A new broadcast shows as a toast ("Sam started broadcasting · open Share to watch")
  and a card. Nothing opens on anyone's screen unasked.

## 7. Quality and bandwidth: the real constraint

In a mesh, the broadcaster encodes and uploads a separate stream for **every** viewer. With relay on, the hub's PC
carries all of it, twice (in and out).

| | per viewer | 3 viewers | 7 viewers |
| --- | --- | --- | --- |
| 1080p30, *Auto* | ~3.5 Mb/s | 10.5 Mb/s up | 24.5 Mb/s up |
| 1080p60, *Smooth* | ~6 Mb/s | 18 Mb/s | 42 Mb/s |

So:
- **The bitrate per viewer is set by the broadcaster's upload**, not a fixed cap. On going live, a cap is worked out
  as `min(quality cap, upload budget / viewers)` and set with `setParameters` each time someone joins or leaves. The
  upload budget is measured from the first few seconds of `availableOutgoingBitrate` (and remembered). Below about
  1 Mb/s per viewer, the resolution steps down (`scaleResolutionDownBy`) rather than turning to mush.
- **Hardware encoders**: `videoCodecs()` puts H.264 first. Each viewer is a separate encode, so NVENC/QuickSync/AMF
  session limits matter (older consumer NVIDIA drivers allowed 3–5 at once). When an encode fails, that viewer falls
  back to VP8 on the processor, and the Share tab says so if the processor is struggling (frame rate dropping).
- **Viewers per broadcast: up to 7** at first, even if the room (§1) is bigger. A bigger room makes this limit easier
  to hit, so the card says "Full (7 watching)".
- **The hub owner is shown** what voice and broadcasts cost them ("Voice and broadcasts are using 26 Mb/s through
  this PC"). This is decision 2 of the voice plan, carried on.
- An SFU (encode once, the hub forwards) is the real fix for big audiences. It's out of scope here, as in the voice
  plan, because it would break end-to-end encryption without SFrame.

## 8. Sound: the hard part

What people expect: the game's or app's sound, without the voice room echoing back.

- `desktopCapturer` offers `audio: 'loopback'`, the **whole PC's** output. That includes voice, so viewers would hear
  themselves (and everyone else twice) a moment late. Chromium's echo canceller doesn't help, because this is a
  separate track.
- What can work:
  1. **Per-application sound** (Windows 10 2004+ process loopback, `AUDIOCLIENT_PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`):
     capture only the chosen window's process. This is the right answer for "stream an application". Does Electron 45 /
     Chromium 156 expose it? If not, a small native helper (like the push-to-talk key-state helper) that pipes PCM
     into the broadcast window through a `MediaStreamTrackGenerator`.
  2. **Whole PC minus Drift** (`EXCLUDE_TARGET_PROCESS_TREE` on Drift's own process): for broadcasting a monitor.
     Voice is Drift's sound, so it drops out. Spotify and games stay.
- **Spike first** (§10, spike A). Until it lands, ship with **sound off**, and with "PC sound (others will hear
  themselves)" as a clearly labelled option only if the spike fails. (It didn't fail: both 1 and 2 are built, Phase 7.)

## 9. Shared pointers over the broadcaster's screen

While you watch Sam's broadcast, moving your mouse over it puts a labelled pointer, in your colour, **on Sam's actual
screen**, over whatever Sam is running, so you can point at things ("that one, top left"). Every other viewer sees it
on their copy too. It works like the pointers in a shared Surf page, except the page is Sam's real desktop.

### 9.1 Where pointers travel

- **Viewer → broadcaster**: on the broadcast connection's data channel (`ordered: false, maxRetransmits: 0`), so it's
  end-to-end encrypted and the hub never sees it. The viewer sends `{x, y}` as fractions (0–1) of the **video
  frame**, not of their monitor, with the letterboxing worked out. It sends at most 30 a second, only while the mouse
  moves over `#bcView`, and `{gone}` when it leaves.
- **Broadcaster → every other viewer**: the broadcaster's broadcast window passes each pointer on to the other
  viewers, tagged with whose it is, on their data channels. Viewers draw them over `#bcView` with today's `.ptr`
  styles (name, colour from their face hue, fading after 6 s without moving).
- **Ping**: a click over the stream sends a "look here" ripple at that spot, at most one a second per person. It is
  **only a picture**: nothing is ever clicked, typed or moved on the broadcaster's PC. Pointers can't control anything.
  Remote control would be a separate, much riskier feature, and isn't planned.

### 9.2 The overlay on the broadcaster's PC

- **One transparent window per monitor the source is on**: `transparent: true`, `frame: false`, `focusable: false`,
  `skipTaskbar`, `setIgnoreMouseEvents(true)` (every click goes straight through to the game), and
  `setAlwaysOnTop(true, 'screen-saver')` so it sits over other topmost windows. It only draws pointers and pings,
  with CSS transforms, so it repaints only when one moves. It's hidden whenever no pointer is showing.
- **It is kept out of the capture**: `setContentProtection(true)`, which on Windows 10 2004+ should be
  `WDA_EXCLUDEFROMCAPTURE`. Without that, the pointers would be baked into the stream as well. Viewers would see each
  pointer twice, the drawn one and the streamed one a moment behind, and couldn't hide them. Spike E checks Electron 45
  really uses `EXCLUDEFROMCAPTURE` and not the older `WDA_MONITOR`, which shows a black box instead.
- **Mapping a pointer to the screen**:
  - *A monitor*: the fractions × that display's `bounds` (Electron's DIPs, so Windows' scaling is already handled).
  - *An application window*: the source id `window:<HWND>:0` gives the window. A small helper, the same kind as
    push-to-talk (PowerShell `Add-Type`, `user32`/`dwmapi`), reports its frame
    (`DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`, which leaves out the invisible resize border that
    `GetWindowRect` includes) about 10 times a second, plus whether it's minimised. The overlay follows it, turned
    from physical pixels to DIPs with `screen.screenToDipRect`. When the window is minimised, or another window covers
    it (`IsWindowVisible`, plus a check of which window is at that point), pointers hide rather than float over the
    wrong program.
- **Exclusive fullscreen games**: nothing can draw over them without hooking into the game (as Discord's and Steam's
  overlays do), which Drift won't do: it's fragile and anti-cheat software flags it. The Share tab says "To see
  pointers over a game, set it to borderless or windowed". Borderless is what most games default to now. Drift's
  overlay is an ordinary window and never touches the game's process.

### 9.3 Controls

- **Broadcaster**: "Viewers' pointers: Show on my screen / Don't show" (on going live, and while live), and hide one
  person's pointer from the viewer list. When it's off, viewers still see each other's pointers on the stream, and the
  Watch card says "Sam isn't showing pointers".
- **Viewer**: "Share my pointer" in the hub bar while watching, default on. "Hide other pointers" for your own view.
- **Blocked members**: their pointer isn't drawn for you. As with chat, they aren't told.

## 10. Phases

0. **Spikes**, each a small script under `spikes/broadcast/`, measured:
   - **A. Sound**: process loopback, include and exclude, from Electron 45 (built-in, or through a helper). Measure
     the delay against the picture.
   - **B. Encoder cost**: one 1080p30 capture sent to 1, 3 and 7 local peer connections. Measure processor/GPU use and
     when H.264 sessions run out, on the NVIDIA PC and on integrated graphics.
   - **C. Relay throughput**: `turn.js` is JavaScript handing UDP packets across in memory. Measure 7 × 3.5 Mb/s through
     it (about 2,300 packets/s each way): the hub's processor use, and dropped packets.
   - **D. Capture quirks**: exclusive-fullscreen games (Windows Graphics Capture may show black; borderless works),
     the yellow capture border on Windows 10, minimised windows (no frames), DRM video (black, as expected), and a
     window closing mid-broadcast (`track.onended`).
   - **E. The pointer overlay**: a click-through, topmost, content-protected window over a borderless game and over a
     normal app. Check it stays out of a `getDisplayMedia` capture of that monitor and window, that clicks reach the
     game, that it stays on top, and that the window-following helper keeps up when the window is dragged, across
     monitors with different scaling.

   **Spike results (2026-11-22)**, measured on the RTX 4070 SUPER PC (20 threads, Windows 11 build 26200, three
   monitors, all at 100% scaling), Electron 45.2.1:

   - **A. Sound**: **Electron can't do it alone, but a PowerShell helper can, and cleanly.**
     - `spikes/broadcast/sound.js`: Electron 45 only offers `audio: 'loopback'` (the whole PC). Chromium accepts
       `restrictOwnAudio: true` and even reports it as on in `getSettings()`, but Drift's own sound is still in the
       capture at the same level (−47.6 dBFS against −47.4 without it). `suppressLocalAudioPlayback` doesn't help either.
     - `spikes/broadcast/loopback.ps1` + `loopback-test.js`: a C# helper compiled by `Add-Type` (the same kind as
       push-to-talk, no native module to ship) calls `ActivateAudioInterfaceAsync("VAD\\Process_Loopback")` and writes
       48 kHz stereo PCM to stdout. With two programs playing tones at about −21 dBFS:
       - *include the game's process*: the game at −20.9 dBFS, the other at −107.7 (silence);
       - *exclude "Drift"'s process*: the game at −20.8, Drift at −98.8;
       - *exclude a real Electron app's main process*: its tone (played from Chromium's separate audio-service
         process) drops to −96.6, while the include control has it at −20.0. So excluding Drift's main process tree
         takes out voice, as §8.2 needs.
     - It starts in about 270 ms and delivers 10 ms packets (480 frames), with no gaps.
     - **Done in Phase 7**: feeding the PCM into the broadcast window (`MediaStreamTrackGenerator` with
       `kind: 'audio'`, `gen-check.js`) and measuring the delay against the picture (`av-sync.js`, below).
   - **B. Encoder cost** (`spikes/broadcast/encode.js`, `run-encode.sh`; a window drawing a busy 1080p30 pattern,
     captured through Windows Graphics Capture, 3.5 Mb/s cap per viewer, `maintain-resolution`):

     | viewers | encoder | fps each | sent | broadcaster's renderer | GPU process | NVENC use |
     | --- | --- | --- | --- | --- | --- | --- |
     | 1 | NVIDIA H.264 (Media Foundation) | 29.1 | 3.6 Mb/s | 2% of a core | 12% | 8% |
     | 3 | same | 29.1 | 10.6 Mb/s | 5% | 40% | 25% |
     | 7 | same | 28.8–29.2 | 24.8 Mb/s | 9–12% | 108–112% | 39% |
     | 10 | same | 17.8–29.2 | 29.2 Mb/s | 13% | 202% | 39% |
     | 3, VP8 (software) | libvpx | **19.7** | 10.7 Mb/s | **98%** | 13% | 0 |
     | 3, VP9 (software) | libvpx | **1** | 0 | — | — | 0 |
     | 3, AV1 (software) | libaom | 28.3 | 10.8 Mb/s | **444%** | 10% | 0 |

     - **No session limit was hit**: 10 hardware encodes ran at once. What grows is the GPU *process*'s processor
       use, about 16% of a core per viewer (copying and converting each frame for Media Foundation), so 7 viewers is
       just over one core and 10 starts dropping frames. **7 viewers per broadcast (§7) is about right.**
     - The **software fallback can't keep 1080p30 for 3 viewers** (VP8 at 19.7 fps with a full core; VP9 stalls;
       AV1 needs 4.4 cores). So when H.264 isn't hardware, step the resolution down to 720p (or less) before adding
       viewers, rather than only telling the broadcaster. Chromium didn't use the card's AV1 encoder.
     - Not done: integrated graphics (this PC has none enabled).
     - `encoderImplementation` is only reported for a real capture (`getDisplayMedia`), not a canvas, so the
       Share tab can show "hardware" / "processor" while live.
   - **C. Relay throughput** (`spikes/broadcast/turn-video.js`; the real `turn.js`, fake members in another process,
     1,200-byte packets in bursts at 30 fps):
     - The relay's own processor use is small: **7–11% of one core** for one broadcast to 7 viewers at 3.5–6 Mb/s, and
       about the same for **two broadcasts to 7 viewers each at 6 Mb/s (80 Mb/s each way, 8,300 packets/s)**. The event
       loop never fell behind.
     - **But packets were dropped**: 1.75% at 7 × 3.5 Mb/s, 21% at 7 × 6 Mb/s, 37% at 2 × 7 × 6 Mb/s, all before
       `turn.js` read them. Windows' default UDP receive buffer (64 KB) overflows on a video frame's burst. With a 4 MB
       buffer every case lost **nothing**. **Fixed in `turn.js`** (it now sets 4 MB receive and send buffers);
       `scripts/test-voice.js` still passes.
     - Not measured: a real internet link. The hub owner's upload is the real limit (§7), not the relay code.
   - **D. Capture quirks** (`spikes/broadcast/quirks.js`, `resize-native.js`):
     - Covered by another window: **full frame rate** (WGC captures the window, not the screen). Half off the
       screen: full frame rate. Minimised: **no frames**, but the track stays `live` and doesn't mute, so the
       broadcaster's side has to notice (no frames for 1 s) and show viewers "Minimised", not a frozen picture.
     - Window closed: `track.onended` fires within **5–20 ms**.
     - **A window that is resized drops to 1 fps and stays there**, though it keeps painting at 30. This happens
       with an ordinary WinForms window too, not just Electron. Asking for the window again doesn't fix it, and nor do
       different constraints or turning off Chromium's `AllowWgc*ZeroHz` / `WebRtcAllowWgcWindowCapturer` features.
       (It also explains two runs in spike B that came out at 1 fps: Windows had shrunk the test window to fit right
       after it opened.) **This is an open problem for Phase 3.** Ideas to try: a fresh `desktopCapturer` source id,
       capturing the monitor and cropping to the window, a newer Electron. Until then the Share tab should notice
       the frame rate collapse after a size change and say "Resizing the window stopped the picture: pick it again".
     - Not tested here (needs a person and a game): exclusive fullscreen, the yellow border on Windows 10 (Windows 11
       showed none), DRM video.
   - **E. The pointer overlay** (`spikes/broadcast/overlay.js`), all as hoped:
     - `setContentProtection(true)` gives **`WDA_EXCLUDEFROMCAPTURE` (0x11)**, not `WDA_MONITOR`. A capture of the
       monitor shows the window underneath where the overlay is (and shows the overlay, as a control, with protection
       off).
     - A real mouse click on the overlay **reaches the window underneath**. With `'screen-saver'` level it sits
       **above another always-on-top window**.
     - The window-following helper (PowerShell, `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` at 10 Hz,
       per-monitor DPI aware) reported every ~110 ms. Turned into DIPs with `screen.screenToDipRect` it was **2 DIPs
       off** (median and 90th percentile) while the window was dragged across all three monitors. Lag: **31 ms median,
       62 ms at the 90th percentile**, 390 ms at worst (one PowerShell hiccup). It sees minimising (`IsIconic`).
     - Not tested: monitors with **different scaling** (all three here are 100%), and a real borderless game.
1. **One room per hub** (§1): the model, protocol, room id, Talk / Don't listen / Disconnect, connections only where
   someone talks, the hub bar, the tray, and the voice tests rewritten. It's useful on its own and can ship first.

   **Phase 1 as built (2026-11-22):**
   - `hub.js`: `voice-join` / `voice-leave` are gone. One message, `voice-state {on, listen, talk, mic}`, puts a
     session in the room, changes how it's there, or takes it out (`on: false`). The reply carries the room id, the
     roster, and relay credentials while listening. The roster (`voice`) is `{id, listen, talk, mic, since}` plus the
     room id. The hub makes the room id: fresh when the room fills from empty, and again when the host removes someone
     (the roster says so, and everyone signs with the new id from then on). Limits: 16 in the room, 8 talking
     (`LIMITS.voice`, `LIMITS.talkers`); past them the reply is an error with `full` or `talkers`. The relay's
     `allowed()` is "in the room and listening", and turning listening off drops that member's allocations at once.
     The signed text is unchanged (`drift-voice-v1`, with the room id where the call id was).
   - `chat.js`: `setVoice({hub, listen, talk, mic})` replaces `voiceJoin`/`voiceLeave`/`voiceState`. It keeps this PC
     in the active hub's room, and out of every other hub's, re-sending only what changed (and again after a reconnect).
     It works out which connections to have from the roster: everyone listening while 8 or fewer are (`preconnect`,
     an option so the tests can make a small room count as big), otherwise only pairs where at least one is talking.
     The lower member id makes each offer, so there's no glare. An answer may still carry the room id from just before
     a change, because it answers our own fresh nonce. Offers can't. `disconnect(hub)` / `reconnect(hub)` go offline
     from a hub for this session, without leaving it. A reply to `voice-state` can arrive after a newer roster that came
     in the same data chunk, so its roster is only used when none has arrived since. This was a real bug the tests
     caught.
   - `renderer/voice.js`: the window exists while you listen, and never opens the microphone before Talk. Every
     connection has one sendrecv audio transceiver with no track. Talk puts the microphone's track on every sender with
     `replaceTrack`, so nothing is renegotiated. Mute stops the track, so Windows' microphone light goes out. The
     answerer takes the transceiver the offer brings (`setRemoteDescription` doesn't reuse one made with
     `addTransceiver`).
   - `main.js`: `state.voice` is now `talk` (closed at every start unless `keepMic`), `deaf` ("Don't listen"), `pin`
     (keep voice in one hub), `keepMic`, plus `direct`, `ptt`, `pttKey` and `volumes` as before; `muted` is gone. The
     active hub is the pinned one, or the one open in the Hub tab (`voiceHub` from the panel). The tray light shows while
     you're in a room, grey or red, and clicking it toggles Talk. Its menu has Talk/Mute, Don't listen and Disconnect.
     Hold-to-talk only watches the key while Talk is on.
   - Panel: the Voice section of an open hub shows how many are listening and talking, with Talk / Don't listen /
     Keep voice here (or "Move voice here" when your voice is in another hub). The People list shows 🎙 for whoever
     is talking, "not listening", and the lock and volume for each connection. The hub bar (your watch-together part
     kept beside it) has the hub, the faces of whoever talks, Talk/Mute, Don't listen and Disconnect, and doesn't fade
     while your microphone is open (`#callBar.hot`). Options → Voice gains "Keep my microphone on between sessions".
     Clicking a disconnected hub connects it again.
   - Tests: `scripts/test-voice.js` (78 checks) adds:
     - nobody is in a room until it's their active hub;
     - the lower id offers;
     - Talk reaches the hub;
     - Don't listen ends the relay allocations and refuses the credentials;
     - above the pre-connect size two listeners never connect, and connections come and go with Talk;
     - the 17th person is told the room is full, and the 9th talker is refused;
     - removing someone changes the room id, and an offer signed before it is refused;
     - Disconnect and reconnect.

     `scripts/test-calls.js` checks:
     - three copies are in the room just by opening the hub;
     - every pair connects while only listening and sends no sound;
     - nobody's microphone opened before Talk;
     - Talk opens it once and the light goes red;
     - sound flows through the relay, verified;
     - Mute closes it again and the hub hears of it;
     - Disconnect closes the window and tray light.

     All of it runs honestly and against each hostile-hub mode.
2. **Broadcast protocol and signing**: `bc-*` in `hub.js`, `chat.js` signing with `drift-broadcast-v1`, roster,
   limits, relay `allowed()`. Add **checks to `scripts/test-voice.js`**: domain separation (a voice SDP is refused as
   broadcast and vice versa), wrong broadcast id, an offer from someone who isn't the broadcaster, limits, the
   broadcast ending on disconnect or removal, and each `DRIFT_HUB_TAMPER` mode applied to `bc-signal`.

   **Phase 2 as built (2026-11-22):**
   - **Who can broadcast and watch**: anyone **in the hub's voice room** (it's their active hub), listening or not.
     That's narrower than "online" in §4, so the room id always exists to sign with. Leaving the room (moving voice to
     another hub, Disconnect, closing Drift, being removed, or the same person joining from another PC) ends your
     broadcast and stops you watching.
   - **Signing** (`bcText` / `signBc` / `verifyBc` in `chat.js`): `drift-broadcast-v1 \n type \n pin \n room \n bc
     \n from \n to \n nonce \n fingerprints`. The **type** (`want`, `offer`, `answer`) is signed too, which §2 didn't
     have, so nothing signed as one kind can pass as another. The flow is three messages:
     1. The viewer sends a signed **`want`** (no SDP, so no fingerprints) with a fresh nonce.
     2. The broadcaster's **offer** must carry that nonce.
     3. The viewer's **answer** carries it again.

     The broadcaster always offers and the viewer always answers. Each nonce is used once. A viewer can ask again (a new
     `want`, as after a monitor change). An offer for an earlier request of its own is dropped quietly, not refused.
     Offers and answers signed with the room id from just before it changed are taken, because they're bound to a fresh
     nonce. A `want` must be for the current room. When the room changes, a viewer whose request hasn't been answered
     yet asks again by itself.
   - **Refusals** work as in voice. A bad message refuses that person for that broadcast, both sides are told
     (`bc-refused` / `bc-told`), and a certificate that doesn't match the signed one closes it (`bcCert`).
   - **`hub.js`**:
     - `bc-start {id, title, kind, audio}`: the same id again renames it or changes its sound.
     - `bc-stop {id}`: the broadcaster's own, or any of them for the host (decision §11.6), and the broadcaster is told
       why with `bc-ended`.
     - `bc-watch {id, on}`, and the `bc` roster (also in the sign-in reply as `bcs`).
     - `bc-signal {bc, to, d}`: only passed between a broadcaster and someone watching that broadcast, counted against
       `signals`.
     - Limits (`LIMITS.broadcasts` 2, raised to 4 on 2026-11-23, `viewers` 7, `bcTitle` 80). The broadcaster makes the id (16–64 base64url
       characters, fresh each time).
     - Broadcast actions have their own rate-limit bucket (`bc`), so flipping Watch on and off can't use up the one that
       voice-state and invites share. The tests ran into exactly that.
     - The relay's `allowed()` is "in the room and listening, broadcasting, or watching". Credentials come with the
       `bc-start` / `bc-watch` replies too. Stopping (while not listening) drops your allocations at once.
     - The relay now allows 512 allocations, 48 per member (it was 128 / 24). Allocations are only bookkeeping.
     - The `DRIFT_HUB_TAMPER` modes apply to `bc-signal` as to `voice-signal`.
   - **`chat.js`**:
     - `bcStart(hub, {title, kind, audio})` → `{id, iceServers}`. Also `bcUpdate`, `bcStop`, and `bcHostStop(hub, id)`.
     - `bcWatch(hub, id)` → `{from, iceServers}` (again to ask again), and `bcUnwatch(id)`.
     - From the windows: `bcSignal(bc, peer, d)` and `bcCert(bc, peer, alg, fp)`.
     - Events for main.js: `bc-viewer` (a verified request: make them an offer), `bc-viewer-left`, `bc-off`,
       `bc-watch-off`, `bc-sdp`, `bc-candidate`, `bc-refused`, `bc-told`, `bc-verdict`.
     - `info()` gains each hub's `bcs` (with blocked members' broadcasts left out) and `bc: {mine, watching}`.
     - Nothing in `main.js` or the renderer uses any of this yet. That's Phases 3 and 4.
   - **Tests**: `scripts/test-voice.js` (129 checks, from 78; it also passes under Electron's Node, and
     `test-calls.js` still passes in every mode) adds:
     - domain, type, broadcast-id and room separation in the helpers;
     - going live, renaming (cut to 80), and watching through a real hub, exactly as signed and verified;
     - no offer without a fresh request, and asking again;
     - forged offers handed to a viewer, each refused while a correct one is taken: a voice signature, another
       broadcast id, another nonce, someone else's key, unsigned, and a broadcast SDP passed to voice;
     - a forged request to watch, and a certificate mismatch;
     - the two-per-hub and seven-viewer limits;
     - a viewer with listening off using the relay only while watching;
     - endings: host stop with the reason, non-hosts can't stop others', disconnect, moving voice away, and removal,
       which changes the room id and makes a pending request get asked again and then answered;
     - each `DRIFT_HUB_TAMPER` mode on what a broadcaster sends one viewer, while the other still watches.
   - Not tested directly: the hub's own "one broadcast each" check. `chat.js` never sends a second `bc-start`, so it
     would need a hand-made client.
3. **Broadcaster**: picker in `main.js`, the broadcast window, the tab's Go live / live controls, Switch source, Pause,
   the per-viewer bitrate.

   **The tab, built ahead of the rest (2026-11-22):**
   - The **Share** tab sits between Hub and Settings. Its button only shows while you're in your active hub's
     voice room. If you're on it when that ends (Disconnect, say), the panel goes back to the Hub tab, and a closed panel
     stays closed.
   - **Live now** has a card for each broadcast: the face, "Name · title" (the title's tooltip says it's what they called
     it), screen or application, sound, how many are watching ("Full" at 7), and Watch / Stop watching. Your own card
     has Stop sharing. The host gets "Stop it" on everyone else's.
   - **Go live** lists Screens and Applications with thumbnails from `desktopCapturer`. It's only fetched while the tab
     is open, every 4 s, and nothing is captured. Monitors Drift is showing on are marked "Drift is here". This copy of
     Drift's own windows are left out. Quality (Auto / Text and detail / Smooth) and Viewers' pointers are saved as
     `state.broadcast`. Sound shows Off, with On greyed out.
   - **Go live** passes one of the listed ids back: `main.js` keeps the list and the one picked (`bcSource`), and asks
     `chat.js` to start. **You're live** shows the thumbnail, who's watching, and Stop sharing. The tab gets a red dot.
   - A toast says when someone in your active hub starts broadcasting. One that ends with a reason (the host stopped it)
     says that too.
   - **Not yet**:
     - (all built since: see "Phases 3–6 as built" below.)
   - **Test**: `scripts/test-broadcast-ui.js`, two real copies pressing the real buttons (23 checks).
4. **Viewer**: Watch with a monitor picker, `#bcView`, ask again on failure or monitor change, volume, the watch-together
   clash prompt.
5. **Indicators**: the hub bar gets "● Live · Screen 2" with Stop for the broadcaster, and "Sam is live · Watch / Stop
   watching" for others. The tray goes red while live. The tab gets a dot.
6. **Shared pointers** (§9): the data channel, drawing on viewers, the overlay windows, the window-following helper,
   pings and the controls.
   **Phases 3–6 as built (2026-11-22):**
   - **The broadcast window** (`renderer/bc-send.html` + `bc-send.js`, `bc-send-preload.js`): hidden, sandboxed, made on
     Go live and destroyed on Stop (or when the broadcast ends any other way), so the capture can't outlive it. It never
     sees a key or the hub. `setDisplayMediaRequestHandler` answers it with exactly `bcSource` (looked up again by id
     through `desktopCapturer`), and nothing for any other source. One capture feeds one `RTCPeerConnection` per viewer,
     relayed unless "Connect directly" is on (Go live refuses, as voice does, when the hub's relay isn't running), H.264
     first when the card encodes it efficiently, each with an unordered `ptr` data channel. Fresh certificate per broadcast;
     the viewer's real certificate goes to `chat.bcCert`.
   - **Bitrate** (§7): each viewer gets `min(quality cap, budget / viewers)` (caps: Auto 4, Text and detail 5, Smooth
     6 Mb/s), set with `setParameters` on every join and leave. The budget is 80% of the most `availableOutgoingBitrate`
     seen in the first 15 s (20 Mb/s until then). Below 1 Mb/s each the picture is halved; on the processor's encoder with
     more than one viewer it's scaled to 720p (spike B). `degradationPreference` follows the quality.
   - **Live controls** in the tab: what's being sent (thumbnail), frames a second, bitrate, size and graphics card /
     processor encoding, who's watching (each with their state, "pointing", and Hide pointer), **Switch source** (the
     picker again, then `replaceTrack` on every connection: nobody drops, tested), **Pause** / Resume (track disabled;
     viewers see "Sam paused the broadcast") and **Stop sharing**. Switch source may change a screen to a window:
     `bc-start` with the same id now takes a new `kind` too.
   - **Stalls** (spike D): no frames for 1.5 s while live → viewers see "Sam's picture stopped (the window may be
     minimised)", and the tab says so. A window's frame rate collapsing under 3 fps (the resize problem) → a toast and
     the tab say "press Switch source and pick it again". The resize problem itself isn't fixed. A closed window
     (`track.onended`) stops the broadcast with a toast.
   - **The viewer** (`#bcView` in `renderer/app.js`): Watch in the tab asks which monitor when there's more than one
     ("This screen" first), and asks first if a watch-together video plays there. The view fills that monitor
     (`object-fit: contain`) under the chat overlay, hub bar and panel. Esc or the bar's Stop watching ends it. No picture
     for 6 s → it asks again (a fresh signed `want`), which also covers the monitors changing. Choosing another
     broadcast from the bar or the tab switches to it (one at a time).
   - **Two bugs found and fixed on the way**, both worth knowing for the Surf stream too (`renderer/app.js` `ssRtc` has the
     same shape and isn't changed yet):
     1. Candidates that arrived while the viewer was still generating its certificate were dropped, so the first
        connection (relay only: one candidate) never started. They're now held until `setRemoteDescription`.
     2. Over the relay, Chromium's stats sometimes never list the remote certificate, so a good connection was thrown
        away after 10 s. Both ends now fall back to `RTCDtlsTransport.getRemoteCertificates()`, hashed with SHA-256.
   - **Pointers** (§9): only once the viewer turns **Share my cursor** on for that broadcast (in the tab's card or the
     view's bar; forgotten when it ends). Then `{x, y}` fractions of the video frame at most 30 a second, `gone` on
     leaving, and a click is a "look here" ripple (one a second). The broadcast window rate-limits, passes each on to the
     other viewers, and to `main.js`, which names them (blocked members left out) for the viewers' `#bcPtrs` and the
     overlay. **The overlay** is one transparent, click-through, `'screen-saver'`-level, content-protected window over
     the source: the display's bounds for a screen, or a PowerShell helper following the window
     (`DWMWA_EXTENDED_FRAME_BOUNDS` at 10 Hz, `screenToDipRect`), hidden while minimised or when nobody points. "Viewers'
     pointers: Don't show" hides it; viewers still see each other's.
   - **Indicators**: the hub bar shows "● Live · Screen 2 · Stop" (and "(paused)"), "Watching Sam · Stop watching", or
     "Sam is live · Watch" (on this screen), and stays bright while you're live. The tray light is red while live, its
     menu has Stop sharing, and it exists while live even out of voice. The tab has its red dot.
   - **Not done yet**: hiding pointers when another window covers a followed window (only minimised is handled); one
     overlay per monitor for a window spanning monitors with different scaling (it's one window over the whole rect);
     remembering the upload budget between broadcasts; the hardware session limit fallback beyond what Chromium does by
     itself.
   - **Test**: `scripts/test-broadcast.js`, three real copies pressing the real buttons, honestly and with the hub
     tampering with what Hosty sends Third (`fingerprint`, `unsigned`). It checks frames arrive and keep changing, the
     relay path, the signed certificate and padlock, the hub bar, cursor sharing off until opted in and then landing at the
     right spot on Hosty's overlay and Third's view, the bitrate caps, the live card, Switch source without a drop,
     Pause, Stop watching from the view's bar, and Stop ending it for everyone. Under tampering Third refuses and says
     so, and Guesty still watches.
7. **Sound**, from spike A.

   **Phase 7 as built (2026-11-22):**
   - **The helper** (`bc-sound.js`): spike A's process-loopback C#, compiled by `Add-Type` and run through PowerShell
     like push-to-talk, writing 48 kHz stereo 16-bit PCM to stdout. For an **application** it includes the process
     tree of the window's owner (`GetWindowThreadProcessId` on the HWND in `window:<HWND>:0`); for a **screen** it
     excludes Drift's own main process tree, so voice, music and watch-together videos stay out (§8.2). It exits when
     its stdin closes, so it can't outlive Drift. It starts in 300–400 ms. A bad window fails as `window`, an old
     Windows (no `VAD\Process_Loopback`) as `unsupported`; either way the broadcast carries on with picture only, the
     hub is told it has no sound, and a toast says why. It isn't retried for that source until Sound is turned off
     and on again, or the source switches.
   - **main.js** runs the helper only while live with Sound on, restarts it when Switch source changes what to listen
     to (a window ↔ a screen, or another window), and stops it on Stop, Sound off, or the broadcast ending any other
     way. PCM goes to the broadcast window in 20 ms pieces over its IPC channel. `state.broadcast.sound` (off by
     default) is the tab's Sound switch, both for Go live and while live; the tab says what friends will hear ("only
     this application", "everything your PC plays, except Drift").
   - **The broadcast window** turns the PCM into `AudioData` for one `MediaStreamTrackGenerator`, timed by its own
     clock (restarted after a gap). **Every connection has an audio sender from the start**, with no track while
     sound is off, so turning sound on or off while live is a `replaceTrack` and nobody reconnects (tested). It sends
     up to 128 kb/s.
   - **The viewer** asks for stereo Opus at a music bitrate (`stereo=1; sprop-stereo=1; maxaveragebitrate=128000` on
     the answer's Opus line, set before `setLocalDescription`, so the answer chat.js signs is the one used). The view's
     `<video>` is unmuted only while the broadcast has sound. Its volume is `voice.volumes['bc:<member>']` (apart from
     that person's voice) times Drift's master volume, with a slider in the view's bar.
   - **Picture and sound in step** (`spikes/broadcast/av-sync.js`: a window flashes and beeps together, captured as
     a broadcast is, sent over a local connection, onsets compared at the far end). The sound arrived **113–146 ms
     (median 121–144) after the picture**. The flashing page's own audio output latency is 52 ms, so the broadcast path
     adds about 70–90 ms: the helper's 20 ms buffer, the IPC, and an audio jitter buffer of 30–60 ms against 2–3 ms
     for video. Chromium doesn't line the generator's track up with the capture by itself. With the viewer's video
     receiver held back 100 ms (`jitterBufferTarget`), sound trailed by a **median 52 ms**, the source's own offset.
     So the viewer holds the picture back 100 ms **only while the broadcast has sound**.
   - **Not done**: a UWP app's window belongs to `ApplicationFrameHost`, not the app, so its sound isn't captured (it
     would need the app's process, found another way). A program whose sound comes from a process outside its window
     owner's tree (some launchers and games) is silent the same way. The A/V offset is fixed at 100 ms, not measured
     per broadcast. Not tried on Windows 10.
   - **Tests**: `scripts/test-broadcast.js` plays a quiet 1 kHz tone (about −50 dBFS) from another program while Hosty
     broadcasts a screen with Sound on. Both viewers get it, at 1 kHz about −64 dB against a 700 Hz floor of −145.
     They ask for stereo and hold the picture back 100 ms. The volume slider sets `bc:<member>` and the view's volume.
     When Hosty turns Sound off while live, the helper stops, the hub is told, the viewers' views mute and their cards
     say "no sound", and nobody reconnects. It passes honestly and under `fingerprint` / `unsigned` (128 checks).
8. **Tests** (built as `scripts/test-broadcast.js`, see above, sound included):
   - Hosty broadcasts a test pattern (`DRIFT_TESTBROADCAST`, a canvas `captureStream` with a moving square stands in
     for the screen), and Guesty and Third watch.
   - Check frames arrive and the picture changes, the certificate is the signed one, it's relayed, the padlock shows,
     Switch source keeps the connection, and Stop ends it for both.
   - Guesty's pointer reaches Hosty's overlay and Third's view at the right spot, and doesn't appear in the frames
     Hosty sends.
   - Each tamper mode is refused with the warning.

## 11. Decisions (settled 2026-11-22: each recommendation below was taken)

1. **Pre-connect or connect on Talk?** Connecting only when someone talks scales to bigger rooms but may clip the first
   word. Recommend **pre-connecting everyone while 8 or fewer are online**, as today's calls do, and connecting on
   Talk above that. Also: how big may a room be? Recommend 16 online in voice and 8 talking at once to start.
2. **The active hub**: follow whichever hub is open in the Hub tab, or only change when you pick "Make this my voice
   hub"? Recommend following the Hub tab, with a pin to keep one.
3. **How many broadcasts at once?** Recommend **one per person, two per hub at a time**. Each viewer watching both
   doubles everyone's bandwidth. *Raised to four (2026-11-23), with the Broadcast grid: a broadcast nobody watches
   costs only its still, so the real cost is per stream watched, already capped at 7 viewers each. The hub host's
   connection, with relay on, is the ceiling when many watch many.*
4. **Tab or section?** A **Share tab** as asked, or a section inside the Hub tab. Recommend the tab (the picker needs
   the room), with the Hub tab linking to it.
5. **Sound on day one?** Recommend shipping picture only if spike A needs a native helper, rather than blocking on it.
6. **Should the host be able to stop someone's broadcast?** It fits §11.6 of the voice plan (the host can remove
   people and delete messages). Recommend yes: a "Stop this broadcast" on the card, host only.
7. **Pointers on by default?** Recommend on for both sides (it's the point of the feature), with the switches in §9.3.
   **Changed 2026-11-22**: for viewers it's opt-in, per broadcast ("Share my cursor"). The broadcaster's "Show on my
   screen" stays on by default.

## 12. Safety notes

- Broadcasting a whole monitor shows notifications, other windows and anything typed in plain sight. The Screens
  picker says so in one line, and suggests Applications.
- Something always shows that you're live, on every screen: the hub bar (never fully hidden while live or while your
  mic is open, even when idle), the tray light, and the tab dot. Stop is always one click away.
- The microphone is never open unless you pressed Talk in this session (or turned on "Keep my microphone on").
- Pointers are pictures only. Nothing a viewer does can click, type or move anything on the broadcaster's PC, and the
  overlay never touches another program's process.
- Nothing is recorded, by the broadcaster, the hub or viewers. Drift has no record button. (Viewers can still
  screenshot, as anywhere.)
- Blocking (`chat.block`) hides their broadcasts and pointers from you. It doesn't stop them watching yours, because
  refusing them would tell them they're blocked, and today they aren't told.
