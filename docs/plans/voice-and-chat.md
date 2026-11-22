# Plan: voice and chat in Drift (Discord-style)

Status: design settled (§11), 2026-11-21, branch `voip`. The four spikes are done and measured (§10.0). Phase 1 (hub
and text chat) is built and tested (§10, "Phase 1 as built"); attachments and voice come next.

The goal is a Discord-like space for a group of friends inside Drift:
- **Text channels** with history, replies, edits, reactions, mentions and **attachments** (images, video, files).
- **Voice channels** you drop into and out of. They have mute and deafen, push-to-talk, a "speaking" ring and a volume for each person.
- **Direct messages** between two members.
- **Screen and Surf sharing** into a voice channel. Drift can already share a page or video with friends; this lets a voice channel use it.
- **Moderation**: owner, moderators, kicks, bans, timeouts, deleting messages, invite control.

Safety and security are requirements here. Each feature below lists what it does to protect people.

---

## 0. What Drift already has (build on it, don't duplicate it)

- `p2p.js`: one PC hosts and friends join it with an **invite code**. The code holds the port, a 16-byte secret and
  addresses. Messages are newline-JSON over **TLS 1.2 with a PSK** (`ECDHE-PSK-CHACHA20-POLY1305`). It opens a router
  port with UPnP, checks whether the PC can be reached from the internet, and allows up to 8 peers. All networking is
  in the main process, and the renderer reaches it through IPC (`hooks.rtc`, `guestCmd`...).
- `renderer/app.js` (around line 844): WebRTC for sharing pages. Signalling travels over the p2p channel. STUN
  (`stun.l.google.com`) is only used for internet sessions. There is no TURN. H.264 is preferred when the graphics
  card can encode it.
- Electron 45 (castLabs), Chromium 156 and **Node 24.22, with `node:sqlite` built in** (checked). Drift has no
  runtime dependencies at all and should stay that way where it can.
- `contextIsolation` is on, and the preload bridge is in `preload.js`.

## 1. The big decision: where conversations live

Discord-like means history that is still there when you come back, and rooms that exist while nobody is online.
Drift's current model (one PC shares and the session ends when it stops) can't do that alone.

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| A. Pure P2P (extend today's sessions) | No one holds history; each PC keeps its own copy and they sync when they meet | No server at all | History has gaps, every PC must sync with every other, and the hardest part (reaching friends behind NAT) gets worse. Doesn't feel like Discord |
| **B. Drift Hub (recommended)** | One small server for each group, built into Drift. It runs **inside one member's Drift** (no setup, using today's UPnP and invite-code reachability), **or on its own** on a spare PC, Raspberry Pi or VPS (`electron hub.js`, or Node 24) | Fits Drift: invite codes, no accounts, no company in the middle, ~one file of code. Each community owns its data | When the hub is inside someone's Drift, the group goes quiet when that PC is off, so recommend the standalone hub for groups that want "always on" |
| C. A central service run by you | One Drift server for everyone | Always on, easiest for users | You pay for it and would be legally responsible as a platform (see §7). Not recommended |
| D. Adopt Matrix (+ LiveKit for voice) | Use an existing open protocol, `matrix-js-sdk`, a homeserver such as Conduit | Mature end-to-end encryption (Megolm), moderation and federation already solved | Large dependency, needs a homeserver, and it's someone else's model of accounts and rooms. Much less "Drift" |

**Recommendation: B.** `hub.js` is one module that can run either way. Clients talk to it over the same kind of
connection `p2p.js` already uses: TLS plus newline-JSON in the main process.

## 2. Identity, invites and the connection

No accounts and no passwords.

- **Identity**: on first use each install makes an **Ed25519 key pair** (`crypto.generateKeyPairSync('ed25519')`).
  The private key is stored encrypted with Electron's `safeStorage` (Windows DPAPI). A person *is* their public key.
  Their display name and avatar are just labels.
  - "Safety number": a short fingerprint of two people's keys that they can compare in person. It catches a hub
    that tries to pass someone off as someone else.
  - Moving to a new PC: export and import the key behind a passphrase (scrypt plus AES-GCM). Without that, it's a new identity.
- **Hub identity**: the hub makes its own long-term key and a self-signed TLS certificate. **Invite codes carry the
  hub's certificate fingerprint**, so clients pin it. This replaces today's shared PSK. With a PSK, anyone holding the
  code can pretend to be the host, and the invite can never be withdrawn.
- **Invites**: `drift:` codes as today (addresses, port, certificate fingerprint and a random invite token). Each
  invite can **expire** (default 7 days), have a **use limit**, and be **revoked**. Joining with one ties your public
  key to the hub. After that you reconnect with your key, not the invite.
- **Logging in**: TLS (with the pinned certificate), then the hub sends a random challenge, the client signs it, and
  the hub checks it against the member list. Banned keys are refused before anything else happens.
- **Reachability**: reuse `p2p.js`'s UPnP mapping, public-address check and messages ("your internet provider shares
  one address..."). Pull those parts out of `p2p.js` into a shared module instead of copying them.

## 3. Text chat

- **Storage**: `node:sqlite` on the hub: `members, channels, messages, reactions, attachments, invites, bans, audit`.
  Clients keep a local cache of recent messages, encrypted at rest with a key held by `safeStorage`.
- **Protocol**: newline-JSON frames, each with a type, a client-chosen id (so retries are idempotent) and a size cap.
  `wire()` in `p2p.js` already caps a line at 2 MB; chat frames should be much smaller (e.g. 16 KB, at most 4,000
  characters of text). Older history is fetched a page at a time.
- **Rendering (where chat apps get hacked)**: message text is **never** inserted as HTML. A small Markdown subset
  (bold, italic, code, spoilers, quotes, links) is parsed into DOM nodes with `textContent`. Chat gets a CSP with no
  inline script. Mentions are resolved by member id, never by a name typed in the text.
- **Links**: they open in Surf, or in the system browser after a "this goes to example.com" confirmation, showing the
  real host (punycode shown) so look-alike domains stand out. **No automatic link previews** fetched by the client,
  because each preview would tell that site your IP address. If wanted later, the hub can fetch previews with a size cap and a timeout.
- **Rate limits** on the hub for each member (messages, edits and reactions per 10 s), plus an optional slow mode per channel.
- **Deleting really deletes**: the row, its edits and its attachments, on the hub and in every connected client's cache.
  Each channel has a retention setting (keep forever, or 30/90/365 days).

## 4. Attachments

- **Limits**: 25 MB per file by default (the hub owner can change it), a total quota per hub, and a rate limit per member.
- **Upload**: the file goes to the hub in chunks over its own connection, not the chat connection, so chat stays
  responsive. It is stored by SHA-256 under the hub's data folder **with a random name**: never the user's file name,
  so nothing can break out of the folder. The original name is only kept as text, cleaned up.
- **Download**: only members of that channel can fetch it, with a short-lived token from the hub.
- **Images**: the **sender's** Drift re-encodes them before upload, by drawing them to a canvas and exporting
  WebP/JPEG. That **strips EXIF data such as GPS location**, which is on by default with an opt-out for "send
  original". Thumbnails are made the same way. Image decoding happens in a sandboxed renderer, never in the main process.
- **Video and audio** play in Drift's own player in a sandboxed view, never through an outside program.
- **Other files are never opened automatically.** Saving one writes Windows' **Mark of the Web** (a `Zone.Identifier`
  stream, `ZoneId=3`), so SmartScreen and Office's Protected View treat it as something from the internet. Types that
  run (`.exe .msi .bat .cmd .ps1 .vbs .js .jse .wsf .hta .scr .com .lnk .url .reg .jar .appx .iso .img`, and others)
  get a clear warning and can only be saved, never opened from Drift.
- **SVG and HTML** are treated as files, never shown inline, because they can carry script.

## 5. Voice

- **Media**: WebRTC with Opus, plus Chromium's `echoCancellation`, `noiseSuppression` and `autoGainControl`.
  Push-to-talk works through a global shortcut. A visible "mic live" indicator and a tray icon state show whenever
  the microphone is open. The microphone is only opened on joining voice and released on leaving.
- **Topology**: **a mesh** (everyone sends to everyone) for voice channels of up to ~8 people. Opus at about 40 kb/s
  means 7 outgoing streams is under 300 kb/s, so a mesh is fine for voice. Video and screen sharing use the existing
  "one sender, many viewers" path. An SFU (one server that forwards every stream, as Discord does) is only worth it
  for bigger channels. It would be the standalone hub's job later (e.g. mediasoup), not Phase 1.
- **End-to-end encrypted even if the hub is hostile**: WebRTC's media is already encrypted (DTLS-SRTP) between the
  two PCs. The hub only passes along the setup messages, and a malicious hub could swap the DTLS fingerprints in
  them. So **each client signs its SDP fingerprint with its identity key**, and the other side checks the signature
  before accepting. A hub can't listen in without it showing.
- **IP privacy (an important safety point)**: in a mesh every member of a call learns every other member's IP
  address. Discord hides them by relaying everything through its servers. So:
  - **Default: relay voice through the hub (TURN)**, with `iceTransportPolicy: 'relay'`, so members only see the hub's address.
  - A setting "Connect directly in calls (lower delay; others in the call can see your IP address)" for groups of
    people who trust each other.
  - Push-to-talk uses a key-state helper, not `globalShortcut` (which never reports releases; spike 1).
  - This needs a small TURN server inside `hub.js`. Spike 3 built one (`spikes/voice/turn.js`, about 250 lines) and
    Chromium uses it. It **only relays between its own allocations**: in a relayed call both ends are relay addresses
    on the same hub, so packets are handed across in memory. Only the hub's one UDP port needs forwarding on the
    router, and the hub can't be used to send UDP to anywhere else (an open relay is a known way to attack other hosts).
  - The STUN server (Google's today) also sees your IP. With relay on, STUN isn't needed.
- **Per-person controls**: volume, local mute (only you stop hearing them), and moderator server-mute/deafen. A
  "speaking" ring is driven by the audio level of each incoming track.
- **Watch together plus voice**: Chromium's echo canceller removes the video's sound that Drift plays, from any of
  Drift's windows and including ffmpeg's converted sound, **as long as it plays on Windows' default output** (spike
  2). So voice and video must both use the default device. Sending either to another device (`setSinkId`, for
  example a future "voice output" picker) lets the video leak into the call. Sound from other programs (the Spotify
  app) isn't Chromium's, so it won't be removed. Not tested, but follows from the same result.

## 6. Moderation and safety features

**Settled 2026-11-21 (§11.6): no roles.** Hubs are for a group of friends, so everyone is equal: anyone can invite,
make channels and post. The **host** (the person whose Drift runs the hub) is the only exception, and has just enough
to deal with a falling-out:
- **Remove someone**, which is a **ban by key**, so a new name doesn't get them back in, and their sessions end at
  once. **Delete any message.** **Withdraw all invites** at once.
- Everything below (block, rate limits, no directory) still applies. Moderators, per-channel permissions, timeouts,
  slow mode, purges and the audit log are dropped. They can come back if a hub ever grows past friends.

- **Block (for each user, on your side)**: you don't see their messages or hear their voice, and they can't DM you.
  The other person isn't told.
- **DMs**: only from people who share a hub with you, with a setting for "only from people I've accepted".
- **Age**: Discord's minimum age is 13. Drift's README should say who it's for. Private, invite-only hubs keep
  strangers out by design: there is **no public directory and no search for hubs or people**, and there shouldn't be.

## 7. Legal and responsibility note (not legal advice)

With option B the person running each hub is responsible for it, as with a self-hosted Mumble or Matrix server, and
Drift is just software. If a **public, central** service (option C) ever happens, it brings platform duties:
illegal-content reporting (e.g. US NCMEC reporting for CSAM), the UK Online Safety Act's risk assessments, the EU
DSA's notice-and-action, and data-protection rules (GDPR) for message storage and deletion. That's a main reason
option C isn't recommended. Drift's licence text should also say the software is provided as-is.

## 8. End-to-end encrypted text: later, and deliberately

- Phase 1: chat is encrypted in transit (TLS with a pinned certificate) and stored on the hub, which is run by
  someone in the group. That is the same trust model as Discord, where the operator can read messages, but the
  operator is your friend instead of a company. **The UI must say so plainly** ("messages are stored on <hub owner>'s PC").
- Voice is end-to-end encrypted from Phase 1 (§5).
- Later, **DMs** could be made end-to-end encrypted with X25519 plus a double ratchet, and **group channels** with
  MLS (RFC 9420). There's a real trade-off here: end-to-end encryption means moderators can only act on what members
  report, and new members can't read old history unless keys are shared with them. Keep message ids, signatures and
  the storage layout ready for it (store an opaque `body` blob and a `v` version field), but don't build it in Phase 1.

## 9. Where it goes in Drift

- `hub.js`: the server, with storage, auth, the chat protocol, attachment storage, voice signalling and later TURN.
  It can run inside Drift's main process or on its own.
- `chat.js` (main process): the client side. It holds the connection to one or more hubs, the identity key, the
  local cache, and attachment upload and download. It talks to the renderer through IPC, as `p2p.js` does.
- `renderer/chat.js`, `renderer/voice.js`: the UI and the WebRTC calls. A new panel tab, **Chat** (added to `TABS` in
  `p2p.js` so "who's looking at which tab" keeps working), and a small voice bar visible over the scenes while you
  are in a call.
- `p2p.js`: its reachability parts (UPnP, public IP, invite encoding) move into a shared `reach.js` used by both.
- Tests in the style of the existing ones (`DRIFT_TEST*` switches in `main.js`'s `runShots`), plus a `DRIFT_HUB=…`
  switch to run two Drift copies against a local hub.

## 10. Phases

0. **Spikes** (each a throwaway branch or file, with a measurement written back into this plan):
   1. Two Drift copies on one PC (separate `userData`): mesh voice through `RTCPeerConnection`, an audio-only
      track with Opus, push-to-talk via `globalShortcut`, and the "mic live" indicator. Measure the delay.
      **Done 2026-11-21** (`spikes/voice/`, run `VOICE_AUTO=out.json electron spikes/voice/main.js`). The windows are
      separate renderer processes in a full mesh over loopback, with IPC standing in for the hub's signalling:
      - **Delay** from a sound entering the sender's track to it reaching the receiver's audio graph: median **42–55 ms**
        with 2 people, **52–69 ms** (p90 up to 82) with 8 windows sharing one PC. The jitter buffer holds 20–30 ms of that.
        Windows then adds **42 ms of output latency** (`AudioContext.outputLatency`, shared-mode audio), plus about
        10 ms of capture. So about **110 ms from mouth to ear on one PC**, before the internet's own delay. Opus at 10 ms
        frames (`minptime=10` is already offered) could save about 10 ms if it ever matters.
      - **DTX has to be asked for.** Chromium doesn't turn it on by itself. Adding `usedtx=1` to the remote SDP's Opus
        `fmtp` line takes a silent stream from **12.5 kb/s to 1.1 kb/s**. While sounding it's **44.5 kb/s** with
        RTP headers. Because most people are quiet most of the time, a relayed 8-person call with one or two people
        talking is about **0.75 Mb/s** at the hub, not the 3.4 Mb/s estimated in §11.
      - **Processor**: about **3%** of one core for each member with 1 other person in the call, and about **13%**
        with 7 others (8 windows used 103% between them). That's fine for a mesh of 8.
      - **Hold-to-talk**: `globalShortcut` reports presses but never releases, so it can't do hold-to-talk. A small
        PowerShell+C# helper that polls `GetAsyncKeyState` every 5 ms works (the same approach as the Spotify volume
        helper in `main.js`). It saw 6 of 6 key presses from Windows' keyboard input, and switching the track on adds
        **no delay** beyond the call's own (53–70 ms). It works for mouse side buttons too (`VK_XBUTTON1/2`). The mic
        stays open for the whole call and hold-to-talk only sets `track.enabled`, as Discord does. Not yet checked:
        whether it still sees the key while a game runs as administrator.
      - **"Mic live" light**: a tray icon, grey for "in a call, muted" and red for "people can hear you", plus a
        badge in the window. Remote voices only reach Web Audio (for the speaking ring) while an `<audio>` element
        plays the stream, even a muted one.
      - Still to try by ear: `VOICE_SRC=mic electron spikes/voice/main.js` with headphones (you hear yourself through
        the call, delayed).
   2. Echo: play a video in Drift while in a call, with speakers. Does the other side hear it? Check both Chromium
      playback and ffmpeg-converted audio.
      **Done 2026-11-21** (`spikes/voice/echo.js`; `ECHO_DEFAULT=1 ECHO_OUT=Realtek ECHO_MIC=Snowball electron
      spikes/voice/echo.js` plays about a minute of noise through the speakers). It plays speech-like noise in the call's
      own window, in another window (a separate renderer, as Drift's scene windows are), and as ffmpeg's MP3 stream
      over a local port (as Drift's `/a` route does), and measures the microphone with echo cancelling off and on:
      - **On the default output, the echo is removed in all three cases.** The loudest case, the ffmpeg MP3 from
        another window, was 16 dB above the room's own noise with cancelling off (−61 dBFS against −77) and back at
        the room's level with it on (−73 to −79 against −80). The others were quieter but went the same way.
      - **On a device that isn't the default, it isn't removed.** With headphones as the default and the sound sent to
        the speakers through `setSinkId`, the microphone still heard it 15–23 dB above the room with cancelling on.
      - Caveat: this PC's speakers are quiet next to its microphone, so the margins are small and one trial in each run
        was spoiled by a noise in the room. A by-ear check with loud speakers is still worth doing. The run switches
        Windows' default output to the speakers with `default-output.ps1` and puts it back afterwards.
   3. A minimal TURN server inside Node. Does Chromium accept it with `iceTransportPolicy: 'relay'`? What does it cost
      the hub's processor for 8 people?
      **Done 2026-11-21** (`spikes/voice/turn.js`; `VOICE_RELAY=1 VOICE_AUTO=out.json electron spikes/voice/main.js`,
      and `node spikes/voice/turn-load.js 8 10` for the load test):
      - **Chromium accepts it.** It does Allocate with the long-term credential challenge, CreatePermission and
        ChannelBind, then sends media as ChannelData. Credentials are the "TURN REST" kind (`expiry:member` and an
        HMAC of it), so the hub hands out short-lived ones and stores nothing. Every pair ends up `relay -> relay`.
      - **It needs a real network address, not 127.0.0.1.** Chromium sends from sockets on the real network
        interfaces, and Windows won't route those to loopback, so a hub inside Drift has to advertise its LAN address
        to members on the same network.
      - **Chromium makes one allocation for each connection**, so an 8-person mesh is 56 allocations. Hence
        relaying in memory (§5): with a socket for each, the hub would need 56 router ports.
      - **No measurable delay on one PC**: median 53–58 ms relayed against 52–58 ms direct (2 and 8 people), jitter
        buffer still 20 ms, nothing lost. DTX's silent stream grows from 1.1 to 1.7 kb/s (TURN keeps the allocations
        and permissions alive).
      - **Processor**: in the Electron run (8 people, one talking) the main process, which holds the server, used
        3.7% of a core. In the load test with **all 8 talking at once** (2,743 packets/s in and out, 2.9 Mb/s each
        way) it was **6.6% of a core**, including the fake members in the same process. 16 people all talking: 24%.
      - The load test also checks that a wrong password and expired credentials are refused, and that relaying to an
        address outside the hub is dropped.
   4. Signed DTLS fingerprints: sign `a=fingerprint` with Ed25519 and check it before `setRemoteDescription`.
      **Done 2026-11-21** (in `spikes/voice/main.js`; `VOICE_TAMPER=fingerprint|unsigned|replay VOICE_PEERS=3
      VOICE_AUTO=out.json electron spikes/voice/main.js`). The sender's main process signs
      `drift-voice-v1, call id, from, to, the sorted a=fingerprint lines` with its identity key. The receiver's main
      process checks it before the SDP reaches the renderer. The renderer never handles keys, which suits `chat.js`.
      - Checking takes about 0.1 ms, and an 8-person call checks 56.
      - A hub that **swaps the fingerprint**, **drops the signature** or **replays** one member's offer to another member
        is refused every time, and only that pair fails. The rest of the call connects.
      - **Chromium enforces the fingerprint itself.** With the check turned off (`VOICE_NOVERIFY=1`), a swapped
        fingerprint makes that pair's connection fail. With honest signalling, the certificate the other side really
        used (`getStats`, `remoteCertificateId`) equals the signed one. So signing the fingerprint is enough: a hub can't
        sit in the middle without its own certificate, and it can't sign that as a member.
      - ICE candidates don't need signing. A hub that changes them can only stop the call, not listen to it.
1. **Hub and text**: identity, invites, a hub inside Drift, text channels, history, edits and deletion, rate limits,
   safe rendering, the host's remove and delete, block.
   **Phase 1 as built (2026-11-21):**
   - `hub.js` is the server: SQLite (`node:sqlite`) in `userData/chat/hub/hub.db`, TLS 1.3, newline-JSON lines capped at
     16 KB. Members, channels, messages (stored as `body` + `v`), invites. Anyone can invite, make channels and post. A
     channel can be deleted by the host or whoever made it. The host can remove (ban by key), delete any message and
     withdraw all invites. Each member gets 10 messages and 10 other actions per 10 s. Messages are up to 4,000 characters.
   - **The hub's certificate is ECDSA P-256, not Ed25519.** Electron's BoringSSL ends the handshake with an Ed25519
     certificate (alert 40), though Node's OpenSSL accepts one. Node can't make certificates, so `hub.js` writes the
     X.509 by hand (about 15 lines of DER). Members' identity keys are still Ed25519. The login is a challenge signed with
     that key and bound to the hub's certificate pin.
   - Invites are `drift:` codes with version byte 2 (Together's are 1): port, the certificate's SHA-256 pin, a 16-byte
     token and the addresses. They expire after 7 days or 25 uses. The hub keeps its port (47900 first) across
     restarts so codes keep working, and it sends members its current addresses each time they log in.
   - `chat.js` is this PC's side: the identity key (sealed with `safeStorage`), the saved hubs, reconnecting with
     backoff, hosting (with UPnP when "Let friends join from outside my home network" is on), and blocking, which is
     local only. The chat name is the Together tab's name.
   - **No local message cache yet.** Each window asks the hub for the latest 50 messages when it opens a channel and
     after every reconnect, then pages back with "Show older messages". That also makes deletion simple.
   - `renderer/chat.js` is the Chat tab: hubs, channels, people (block, and remove for the host), invite, leave or
     stop hosting, messages with reply, edit (↑ edits your last one), delete, typing, unread badges, and a toast
     for new messages on the focused screen. The Markdown subset is built element by element with `textContent`.
     Links open in Surf after a confirmation that names the real host.
   - Checks: `node scripts/test-chat.js` (also under Electron's Node: `ELECTRON_RUN_AS_NODE=1 electron
     scripts/test-chat.js`), 34 checks in all. Also two copies of Drift pressing the real buttons:
     `DRIFT_TESTCHAT=host|guest` with `DRIFT_USERDATA`, `DRIFT_SHOTS`, `DRIFT_ONLY=aurora` and `DRIFT_TESTCODE` as
     for `DRIFT_TESTSHARE`.
   - Not yet: DMs, mentions, the per-channel retention setting, safety numbers in the UI, an encrypted local cache,
     moving `p2p.js`'s reachability into `reach.js` (for now `p2p.js` exports `wire`, `upnpMap` and the address helpers).
2. **Attachments**: chunked upload, re-encoding images and stripping EXIF, sandboxed viewing, Mark of the Web, the
   warning for files that run, quotas.
3. **Voice**: mesh and relay, signed fingerprints, push-to-talk, per-person volume, moderator mute, the speaking ring, the voice bar.
4. **Sharing into voice**: the existing page and screen sharing, started from a voice channel.
5. **Standalone hub**: `electron hub.js` / Node 24, a guide for running it on a Pi or VPS, and backups of the SQLite file.
6. Later: end-to-end encrypted DMs, an SFU for big channels, and mobile? (out of scope).

## 11. Decisions (settled 2026-11-21)

1. **B, the Drift Hub.** Not Matrix: it would tie Drift to someone else's protocol, servers and account model, and it
   needs a domain and HTTPS, so it can't run inside a friend's Drift. Moving to Matrix later would mean rewriting
   the protocol and hub layers. The UI could mostly stay, as long as `renderer/chat.js` only talks to `chat.js` over IPC.
2. **Voice is relayed through the hub by default**, with the "Connect directly" setting for trusting groups. With DTX
   on (which has to be asked for in the SDP, see spike 1), an 8-person call through the hub is about 0.75 Mb/s each
   way while one or two people talk. Without DTX it would be 3.4 Mb/s. Show the hub owner how much bandwidth calls use.
3. **DMs are transport-encrypted only in the first release**, like channels. The UI says so. DMs are stored as an
   opaque `body` plus a `v` version field from day one, so a sealed box per message (X25519 + AES-GCM, `node:crypto`)
   can follow soon after without a migration. A full double ratchet is not planned for now.
4. **Up to 8 people in a voice channel at once; no limit on members.** Voice uses a mesh. An SFU for bigger calls
   comes later. It would decrypt media on the server unless SFrame is added, so don't promise "voice is always
   end-to-end encrypted" in a way that rules that out. Say "end-to-end encrypted in calls of up to 8".
5. **25 MB per file by default**, changeable by the hub owner, with a total quota for each hub. Later: offer to
   shrink an oversized video with Drift's ffmpeg before sending it.
6. **No roles: everyone is equal except the host** (§6). The host can remove (ban) a member, delete any message and
   withdraw invites. Everyone else can invite, make channels, post, and edit or delete their own messages.

## 12. For the next session

Start here: read this plan (the decisions in §11 are settled), then `p2p.js` (the connection, the invite codes and `wire()`), then
`renderer/app.js` around line 844 (WebRTC signalling over the p2p channel), then `main.js`'s `runShots` (how the
`DRIFT_TEST*` checks work). The spikes and Phase 1 are done; read `hub.js` and `chat.js`, then begin Phase 2
(attachments) or Phase 3 (voice, starting from `spikes/voice/turn.js` and the signing in `spikes/voice/main.js`).
