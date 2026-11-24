# Plan: a hub's two streams (Media and Surf)

Status: built, 2026-11-22. The media stream (§1) and the Surf stream (§2–§9) are built and tested. The spikes are
measured (§10, "Spike results"), and where the build differs from the plan it's said in §10, "As built". The decisions
in §11 were taken as recommended.

A hub has two streams that everyone online in it watches together:

- **The media stream**: a video or music. It belongs to whoever put it on, and changing it takes a vote.
- **The Surf stream**: one web browser for the whole hub, running on the hub host's PC in a profile of its own. It has no
  owner and no vote. Anyone online can change it (open a page, click, scroll, type, open and close tabs) and everyone
  sees the same thing.

They run side by side. Ana's video can be on the media stream while Ben scrolls a page on the Surf stream. Neither touches the
other. Being online in a hub means being on both. Disconnecting from the hub takes you off both and puts your own
browser back.

Words used below: the **host** runs the hub (their Drift *is* the hub). A **member** is anyone in it, the host included.
**Online** means connected to the hub after clicking it; Drift no longer connects to hubs when it starts.

---

## 1. The media stream (as built)

- Picking a video or music in Media while online in a hub shares it there (`mediaPlay` / `mediaShare` in `main.js`). With
  nothing on, it starts straight away.
- One share per hub. While someone else's is on, the hub refuses a new one (`live-no`) unless its sender just won a vote
  (`media-ask`, `media-vote`, `media-cancel` in `hub.js`, "the media stream"). It passes when more than half of the people online when it
  was asked agree within 30 s. The asker counts as a yes. People who go offline drop out of the count, and if what's on
  stops meanwhile, the asker wins.
- The vote is a one-row card over the video on every screen (`#coVote`, `drawVote` in `renderer/chat.js`).
- Everyone online in the hub is pulled into what's on (`mediaCheck`). **Leave** skips the share that's on; the next one
  pulls you in again. Disconnecting is how you opt out.
- Tests: `scripts/test-chat.js` (the hub's counting) and `scripts/test-stream.js` (two copies of Drift, real clicks).

**What changed in it (Phase 4, done):** Surf left the media stream. A media stream share used to carry its owner's Surf
page (watch together streamed the page as part of the session), and opening Surf while online shared your own browser
or started a vote (`surfOpened`, the Surf branches of the `surf` command). All of that is gone. The media stream
is video and music only.

## 2. The Surf stream: how it works, end to end

```
Host's PC                                     Hub (relay only)                Member's PC
---------                                     ----------------                -----------
hub browser (persist:hub-<id>, offscreen)
   │ frames + sound
stream window: capture ─▶ one RTCPeerConnection per member ══ relayed (TURN) ══▶ screen window <video id="surfStream">
            ◀── data channel: input, Surf bar commands, pointers ◀══════════ mouse/keys over the picture, the Surf bar
main.js: plays input into the hub browser (web.input / web.act), checks limits
chat.js: signs and checks every setup message (drift-surf-stream-v1), as voice does
```

- **The browser lives on the host's PC only.** Members never load the pages themselves; they get a picture and sound,
  as friends do with a shared Surf page today. One page, one player, so a YouTube or Twitch stream is the same for
  everyone at the same moment.
- **Its own profile**: `persist:hub-<hub id>`, apart from the host's own Surf (`persist:web`). It starts signed out
  of everything and has none of the host's cookies, history or sign-ins. A member can't reach the host's email by
  clicking around.
- **Over the hub, not the watch-together session.** The media stream's session can belong to someone else at the same
  time, and a PC can only be a guest of one session. So the Surf stream gets its own connections, set up through the hub
  connection like voice and broadcasts: signed SDP with its own domain (`drift-surf-stream-v1 \n hub pin \n room id \n
  from \n to \n nonce \n fingerprints`), `verifySdp`, fresh certificates, and the certificate checked after
  connecting. Relayed through the hub's TURN server by default (`iceTransportPolicy: 'relay'`), so addresses stay
  hidden. End to end encrypted; the hub only passes messages on.
- **A mesh from the host**: one connection per member watching, all fed by one capture (as page streaming does today,
  `rtcHost` in `renderer/app.js`). H.264 first when the graphics card encodes it efficiently (`videoCodecs()`), 8 Mb/s
  cap. Up to 7 members watching at once (decision §11.4). It's the host's upload that limits it.
- **This is close to Broadcast** (`docs/plans/broadcast.md`): the same signing, relay, viewer window and pointer data
  channel (its §9). The Surf stream's sender captures a page rather than a screen. Whichever is built first, the other
  reuses its connection code. Broadcast Phase 3 (the broadcaster) isn't built yet either.

## 3. On the host's PC: a second browser

Today `web.js` is one browser, made once, with one session, and its pages live in whichever Drift window shows them.
The Surf stream needs a second one that runs whether or not the host is looking at it.

- **`createWeb({ partition, headless })`**: `web.js` becomes something that can be made twice: the host's own browser
  (`persist:web`, as now) and the hub's (`persist:hub-<id>`, headless). What is per-browser today but written as if
  there were one moves into the instance:
  - `ipcMain.on('surf-scriptlets')` and `ipcMain.on('surf-gain')` are registered once, at module level, and route by
    `e.sender.session` to the right instance. Two instances each registering would answer each other's pages (a sync
    `returnValue`, last one wins).
  - `host()`'s `will-attach-webview` check accepts the instance's own partition.
  - `app.userAgentFallback` is set once.
  - The extensions (`surf-net`, uBlock Origin) load into each session. That's two copies in memory, which is the
    price of keeping the profiles apart.
- **Headless: always offscreen.** The hub browser draws in hidden offscreen windows (the "gpu" path, `offscreen()`),
  never as a `<webview>` in a Drift window. It keeps drawing at the members' size when no window of the host's shows it.
- **Capturing it.** Today a page is captured with `getDisplayMedia` from the Drift window holding the `<webview>`,
  which `main.js` answers through `setDisplayMediaRequestHandler`. An offscreen page has no window to capture, so the
  capture comes from the page itself: picture and sound, at 30 frames a second, without the host's screen being
  involved. **Spike S1** finds the way that works (§10).
- **The stream window**: a hidden window (`renderer/surf-stream.html`, sandboxed preload like `voice-preload.js`) made while
  anyone is watching and closed when nobody is. It holds the capture and the connections and never sees a key or the
  hub. It's the same shape as the broadcast window (`docs/plans/broadcast.md` §3).
- **The host sees it locally.** While the host is online in their own hub, their Surf tab shows the hub browser,
  drawn straight from the offscreen texture (as Surf on the graphics card does today). There's no stream for the
  host. Disconnecting from their own hub puts their own browser back in the Surf tab; the hub browser keeps running for
  everyone else.
- **Its tabs are kept**, like the host's own: while the hub runs, and across the host restarting Drift (saved with the
  hub, not with `state.surf`).

## 4. On a member's PC

- **The Surf tab is the Surf stream while you're online in a hub.** It shows the stream (`<video id="surfStream">`, like
  `#webStream` today, with the same "no picture for 6 s → ask again" logic) and the Surf bar (tabs, address, back,
  reload) drawn from the browser's state, which the host sends with the stream.
- **Your own browser is put away** while you're online, and comes back when you disconnect, with its tabs. This is the
  `surfKept` saving that's already built, moved to "online in a hub" instead of "watching someone's session".
- **Watching starts when you open the Surf tab**, not the moment you come online, so nobody pays for a stream they
  aren't looking at. Sound is decision §11.1.
- **The host isn't special here** except that their copy is local, not streamed.

## 5. Control: one state, anyone can change it

- **Everything goes to the host's PC** over the data channel, and `main.js` plays it into the hub browser:
  - mouse and keyboard over the picture: `web.input(e)`, as friends' input on a shared page is played back today
    (`web-input`);
  - the Surf bar: go to an address, new tab, close tab, back, forward, reload, switch tab, zoom: `web.act(...)`, the
    same commands as `SURF` in `main.js`;
  - pointers: where each member's mouse is, shown on everyone's picture as a coloured arrow with their name (as
    `#ptrs` does on a shared page today), fading after 6 s.
- **No owner, no lock.** Two people typing at once interleave, as two people at one keyboard would. That's the deal of a
  shared browser; pointers make it visible who's doing what.
- **Limits, checked in `main.js`** (the data channel is end to end, so the hub can't check them): per member, at most
  so many input events a second (mouse moves coalesced), addresses only `http(s)://` and the start page, the same
  `MAX_TABS` (12).
- **What a member can't do**, because it would happen on the host's PC, not theirs: open a pop-up window, pick a file
  to upload, grant a permission, see a password as text, or download without the host agreeing (§6, §8).

## 6. Downloads: allowed, but only the host accepts them

A download in the hub browser would save a file onto the host's PC that someone else chose. So:

1. The download starts **held**: `will-download` sets a save path in a holding folder (`<userData>/hub-downloads/`)
   and pauses it at once. Nothing is written to the host's Downloads folder.
2. **The host gets a card**, on every screen, whether or not they're online in the hub, as the vote card is drawn:
   *"Ben wants to download **setup.zip** (12 MB) from **example.com** · Save / Refuse"*. Who asked is whoever's input
   last touched that page in the 5 s before it started; otherwise "Someone".
3. Members see *"Waiting for the host to allow setup.zip"* on the Surf stream. Only the host's Drift can answer, because the
   question only ever goes to the host's own windows. It is never sent over the hub.
4. **Save**: it resumes, and once it's complete it moves into the host's Downloads folder, never over a file already
   there (as Surf does now). **Refuse**, or no answer in 60 s: it's cancelled and the partial file deleted.
5. The file stays on the host's PC. Members never receive it; nothing sends files between PCs. Drift never opens a
   download.
6. At most one held at a time per member, and a few in all. More are refused straight away ("Too many downloads
   waiting").

Spike S4 checks that a download can be held like this: pausing inside `will-download`, resuming later, and that a
cancelled one leaves nothing behind.

## 7. The hub protocol (`hub.js`)

Small, because the picture and the control travel end to end:

| Message | From → to | What the hub does |
| --- | --- | --- |
| `surf-stream {on, title, tabs}` | host's Drift → hub | Lists the Surf stream as running, with the front tab's title for the hub bar. Only the host may send it. |
| `surf-signal {to, data}` | member ↔ host | Passes setup messages on unchanged (signed by the sender, checked by the receiver). Only between the host and members who are online. |

The hub's existing `allowed(member)` for relaying becomes "online in this hub", as for voice.

## 8. Safety

The Surf stream is a browser on the host's PC that every member can drive. Everything below applies to the hub browser's
profile only; the host's own Surf is unchanged.

- **Its own profile** (§2): none of the host's sign-ins, cookies or history. The host has *Clear the hub's browser*
  (closes its tabs and forgets its sign-ins), in Settings.
- **Anything signed into on the Surf stream is signed in for everyone.** Saying so once, the first time someone types into a
  password box there: *"Everyone in the hub can use what you sign in to here."* Password boxes still can't be turned
  into plain text (`surf-guard.js`), but what's on the page after signing in is visible to all.
- **Pages load from the host's connection.** Sites see the host's IP address, and anything a member does there
  happens from the host's internet connection. The host is told this the first time the Surf stream starts in their hub.
- **Downloads only with the host's yes** (§6).
- **No pop-up windows.** Sign-in pop-ups open on the host's screen only, where nobody else can see or use them, so the
  hub browser refuses them (`setWindowOpenHandler` → deny; links asking for a new tab still get one).
- **No file pickers.** `<input type=file>` would open a file dialog on the host's screen. Refused in the hub profile
  (Spike S3 finds the reliable way).
- **No permissions**: camera, microphone, location, notifications, as Surf today (`setPermissionRequestHandler`).
- **No local addresses.** Members can't use the host's browser to reach the host's own network: addresses on
  `localhost`, `127.*`, `10.*`, `192.168.*`, `172.16–31.*`, `169.254.*` and `*.local` are refused in the hub browser.
  That includes the router's admin page, other PCs, and Drift's own hub and watch-together ports. The check is on the
  address a name actually resolves to, at request time, not on what was typed: otherwise a public name that resolves to
  a local address (DNS rebinding) gets through. The host can allow specific local addresses in Settings (a Plex server,
  say) if they want them on the Surf stream.
- **Blocking** (`chat.block`) hides someone's pointer from you. Their input still reaches the page: it's one shared
  state, and refusing it would tell them they're blocked. The host can remove someone from the hub, as now.

## 9. The UI

- **Surf tab**: while online in a hub, a small line at the top says *"Surf stream · Hosty hub · everyone can control"* with
  the faces of whoever is watching. Disconnected, it's your own browser, as now.
- **Hub bar** (`#callBar`): gains the Surf stream's front tab title next to what's on the media stream.
- **Download card** on the host's screens (§6): the same one-row style as the vote card.
- **Hub**: nothing new. The "Share what I'm watching" button is already gone.

## 10. Phases

Each phase ends with a two-copy test (`scripts/test-surf-stream.js`, like `test-stream.js`) before the next starts.

0. **Spikes** (in `spikes/surf-stream/`, measured and written up here before Phase 1):
   - **S1, capturing an offscreen page with its sound** at 1080p, 30 frames a second, and what it costs the host's
     processor and graphics card. Candidates: `setDisplayMediaRequestHandler` answering with the page's own frame
     (`{ video: page.mainFrame, audio: page.mainFrame }`); drawing the offscreen frames into a canvas in the stream window
     and `captureStream()`, with the sound captured separately. Needs to work while no Drift window shows the page.
   - **S2, two `web.js` browsers at once**, two sessions, both with extensions, without either answering the other's
     pages.
   - **S3, refusing file pickers** in one session only.
   - **S4, holding a download** (§6).
1. **The hub browser on the host's PC, local only.** `createWeb({ partition, headless })`, the module-level handlers,
   the hub profile with §8's rules, the host's Surf tab showing it while online in their own hub and their own browser
   otherwise, its tabs saved with the hub, the download card. Test: the host opens pages in it, disconnects (own
   browser back, hub browser still running), reconnects (hub browser back where it was); a download waits for the
   card, Save puts it in Downloads, Refuse leaves nothing; pop-ups and local addresses refused.
2. **Streaming it to members, watch only.** The stream window, the `surf-signal` messages, signing, the relay, the member's
   `<video id="surfStream">`, asking again after 6 s without a picture. Test: picture and sound arrive at the member,
   through the relay, certificate checked; a tampered signature is refused, as in `test-calls.js`.
3. **Control.** The data channel, `web.input` / `web.act` from members, the Surf bar from the browser's state, pointers,
   the limits. Test: a member opens a page, clicks a link and types into a box, and the host's copy shows it; the
   other member's picture shows it too; floods are slowed.
4. **Members' Surf tab, and undoing Surf on the media stream.** Online → the Surf tab is the Surf stream, own tabs put away;
   disconnect → own browser back. Remove `surfOpened`, `surfAsked`, the Surf branches of the `surf` command and Surf
   pages from media stream shares. README. Test: the whole round trip, with the media stream playing a video at the same time.

### Spike results (phase 0)

Run with `electron spikes/surf-stream/capture.js` (see `spikes/surf-stream/README.md`), Electron 45 (castLabs), Windows 11.

- **S1, capturing an offscreen page.** The first candidate works: `setDisplayMediaRequestHandler` answering a hidden
  window's `getDisplayMedia` with `{ video: page.mainFrame, audio: page.mainFrame }` captured a 1080p offscreen page at
  30 frames a second with its sound, with no window showing it. The canvas path wasn't needed. Two findings shaped the build:
  - **`setAudioMuted(true)` on the page doesn't silence the capture** (sound level the same, 0.141 against 0.141), so
    the host's PC can stay quiet while members still hear it. The hub browser is muted on the host's PC except while the
    host is online in their own hub.
  - **The capture pulls frames by itself**: with `stopPainting()` it still got 30 frames a second. So the hub browser
    only paints for the host's own windows, and with nobody watching and no window showing it, it draws nothing (§11.3).
  - Windows made the 1920-wide offscreen window 1872 wide, as web.js already knew: the hub browser's windows are sized
    again once made (`fit()`), so the stream is 1920×1080.
- **S2, two sessions.** One module-level sync handler, answering by `e.sender.session`, gave each session's pages their
  own answer. web.js now registers `surf-scriptlets`, `surf-gain` and `surf-hub-note` once, at module level. Also: the
  same extension loaded into two sessions has the **same id**, so finding an extension's background page by URL could
  find the other session's; web.js now also matches the session.
- **S3, file pickers.** A capture-phase click listener in a preload registered for one session only stops clicks on file
  inputs and labels pointing at them (events are shared between the isolated and main worlds). Scripts calling
  `input.click()` or `showPicker()` directly need the main world patched too: `surf-hub-guard.js` uses
  `contextBridge.executeInMainWorld`, which runs before the page's first script.
- **S4, holding a download.** **Pausing in `will-download` doesn't stop the bytes arriving**: the 3 MB test file finished
  while "paused". So "held" means held in a holding folder (`<userData>/hub-downloads/`), never the Downloads folder;
  Save moves it there once complete, Refuse cancels it or deletes what arrived. A cancelled download left nothing behind.

### As built

Tests: `node scripts/test-chat.js` (the hub and the signing, in plain Node, including a forged offer),
`node scripts/test-surf-lan.js` (the local-network guard) and `node scripts/test-surf-stream.js` (two copies of Drift,
phases 1–4 together). In the two-copy test the guest got the host's page at 1920×1080, about 30 frames a second, with its
sound, relay to relay, certificate checked. (On a flat test page, so the bitrate it measured says nothing about real pages.)

Where it differs from the plan above:

- **The host's Drift talks to its own hub in-process** (`hub.service()`), not over its own connection. The plan has the
  hub browser carry on while the host is disconnected from their own hub, and a disconnected host has no connection to
  send the stream's setup messages over. The service line also gives the host each watcher's key and name, to check
  their signed messages. It never counts as the host being online.
- **`surf-watch {on}`** is a third hub message, beside the two in §7: the hub needs to know who watches, for the limit
  of 7 and for the relay. Watching while the stream isn't running sends the host's Drift `surf-wake`, and the hub
  browser starts (§11.3). A watcher may use the relay while waiting for it to start.
- **The stream's room id** is its own, new each time it starts and whenever someone is removed. The voice room's can't
  be used: someone can be online and watching without being in the voice room.
- **Pop-ups**: a window a page opens just after someone clicked opens as a tab instead (with no `window.opener`, so
  sign-in pop-ups still don't work there). Windows a page opens by itself are refused, as before.
- **Page dialogs** (`alert`, `confirm`, `prompt`, `print`, "leave this site?") don't open either: they'd be boxes on the
  host's screen. `confirm` answers no.
- **Local addresses** are refused by a small proxy in the host's Drift (`surf-lan.js`) that the hub browser's session
  sends every request through, including localhost (`<-loopback>`). It looks each name up itself and connects to the
  address it checked, so DNS rebinding can't get through. WebRTC in the hub's pages goes through it too
  (`disable_non_proxied_udp`). (`session.webRequest` can't be used: the advert blocker takes the session's requests.)
- **The host's sound**: the hub browser is muted on the host's PC unless they're online in their own hub (or the mixer's
  Surf level is at zero); its in-page level is always full, so each member's own mixer sets what they hear.
- **A connection whose certificate can't be checked isn't kept.** Now and then (about one run in five of the two-copy
  test), the member's connection came up over the relay but Chromium's stats never showed the certificate the host used.
  After 10 s without it, the member's screen drops the connection and asks again; the fresh one has shown it every time.
- **Watching the host's own stream, as the host**: not possible; their copy is local, as the plan says.
- **Sharing a Surf page over watch together is gone** (§11.2), with its test switch `DRIFT_TESTWEB`. *Friends can control
  playback* is about the media stream only.

## 11. Decisions

All six were taken as recommended.

1. **Surf stream sound when you're not on the Surf tab.** Recommend: it **keeps playing**, at the mixer's Surf level, so
   the Surf stream can be the hub's radio while scenes or the media stream are on screen. The media stream and Surf stream can then
   both be heard; the mixer sets each. (The alternative is muting it unless Surf is on screen.)
2. **Sharing a Surf page outside a hub** (a watch-together invite code with no hub). Recommend: **drop it**. Surf is
   shared only through a hub's Surf stream.
3. **When the hub browser runs.** Recommend: it starts the first time anyone opens Surf while online, then keeps its
   tabs while the hub runs and across restarts, until the host clears it. With nobody watching and no sound playing,
   it stops drawing.
4. **How many members watching at once.** Recommend: **7**, as for broadcasts. It's a mesh from the host's upload.
5. **Downloads.** As asked: allowed, host must accept each one. Recommend the 60 s timeout, and a Settings switch for
   the host, *Refuse all downloads on the Surf stream*, off by default.
6. **Local addresses** (§8). Recommend refusing them. It closes off the host's router and network, at the cost of not
   being able to show a page served on the host's own PC.
