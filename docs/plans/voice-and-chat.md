# Plan: voice and chat in Drift (Discord-style)

Status: design draft, 2026-11-21, branch `voip`. Nothing is implemented yet. Spikes come first: a few of the
choices below depend on facts that can only be found by measuring a real build.

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
  - This needs a small TURN server inside `hub.js` (UDP Allocate, Permission, ChannelBind and Send/Data, about 500
    lines). Building it is spike 3. If it's too much, a standalone hub can run coturn beside it instead.
  - The STUN server (Google's today) also sees your IP. With relay on, STUN isn't needed.
- **Per-person controls**: volume, local mute (only you stop hearing them), and moderator server-mute/deafen. A
  "speaking" ring is driven by the audio level of each incoming track.
- **Watch together plus voice**: echo cancellation should remove the video's sound that Drift itself plays (Chromium's
  echo canceller uses Chromium's own audio output as its reference). This must be measured in spike 2, because Drift
  plays some audio outside Chromium (ffmpeg conversions).

## 6. Moderation and safety features

- **Roles**: owner (holds the hub key), moderators and members. Permissions are set for each channel (read, send, attach, speak, share screen).
- **Tools**: kick, **ban by key** (so a new name doesn't get them back in), timeout (can't send or speak for N
  minutes), delete any message, purge a member's recent messages, slow mode, lock a channel, and revoke all invites.
- **Audit log**: every moderator action with who, what and when, visible to moderators.
- **Block (for each user, on your side)**: you don't see their messages or hear their voice, and they can't DM you.
  The other person isn't told.
- **DMs**: only from people who share a hub with you, with a setting for "only from people I've accepted".
- **Report to moderators**: sends the message (and attachment) to the hub's moderators. If DMs are ever end-to-end
  encrypted (see §8), the reporter's client sends the plaintext, because the hub can't read it.
- **New members**: an optional "wait N minutes before posting links or attachments" rule reduces spam and raids.
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
   2. Echo: play a video in Drift while in a call, with speakers. Does the other side hear it? Check both Chromium
      playback and ffmpeg-converted audio.
   3. A minimal TURN server inside Node. Does Chromium accept it with `iceTransportPolicy: 'relay'`? What does it cost
      the hub's processor for 8 people?
   4. Signed DTLS fingerprints: sign `a=fingerprint` with Ed25519 and check it before `setRemoteDescription`.
1. **Hub and text**: identity, invites, a hub inside Drift, text channels, history, edits and deletion, rate limits,
   safe rendering, roles, kick and ban, block, audit log.
2. **Attachments**: chunked upload, re-encoding images and stripping EXIF, sandboxed viewing, Mark of the Web, the
   warning for files that run, quotas.
3. **Voice**: mesh and relay, signed fingerprints, push-to-talk, per-person volume, moderator mute, the speaking ring, the voice bar.
4. **Sharing into voice**: the existing page and screen sharing, started from a voice channel.
5. **Standalone hub**: `electron hub.js` / Node 24, a guide for running it on a Pi or VPS, and backups of the SQLite file.
6. Later: end-to-end encrypted DMs, an SFU for big channels, and mobile? (out of scope).

## 11. Open decisions

1. Option **B (Drift Hub)**, or D (Matrix)? Everything above assumes B.
2. Voice IP privacy: **relay through the hub by default** (recommended), or direct by default?
3. Should text start transport-encrypted only (Phase 1 as written), or is end-to-end encryption for DMs a must-have for the first release?
4. Biggest group to plan for: 8 (mesh is enough) or 25+ (needs an SFU sooner)?
5. Attachment size limit default: 25 MB?

## 12. For the next session

Start here: read this plan, then `p2p.js` (the connection, the invite codes and `wire()`), then
`renderer/app.js` around line 844 (WebRTC signalling over the p2p channel), then `main.js`'s `runShots` (how the
`DRIFT_TEST*` checks work). Begin with the spikes in §10.0, in order.
