# Files sent straight between PCs

Before this, a hub could carry pictures and GIFs only: up to 4 MB each, kept in the host's SQLite (300 MB for the whole hub)
and wiped when the host's Drift closed. Now any file of any size can be sent, and **the hub never carries or keeps it**. A
file is *offered* in a chat message and stays on the sender's PC. Whoever wants it downloads it from there, over a WebRTC
data channel. The hub only passes along the offer and the signed setup messages, the same way it does for voice,
broadcasts and the Surf stream. Pictures and GIFs up to 4 MB still go on the hub as before, so they show inline even
while their sender is offline.

## 1. How a file moves

1. **Offer.** The sender presses **+**, pastes or drops a file and presses Enter. `files.js` reads it once and hashes it in
   16 MB pieces. The offer is a message's `offer`: `{ id, name, size, mime, root, piece }`, where `root` is the SHA-256 of
   all the pieces' hashes one after another. The hub keeps it in `offers` (a row per message, deleted with it) and remembers
   which session has the file (`holders`).
2. **Ask.** The receiver presses **Download**. Their `chat.js` makes a transfer id and a nonce and signs a `want`
   (`drift-file-v1`, see §3). The hub checks the limits, registers the transfer (`xfers`), passes the request to the
   holder's session, and gives each end relay credentials *for this transfer only* (`…:memberId:f.<id>`).
3. **Connect.** The holder checks the signature, and its transfer window (`renderer/ft.js`) makes an offer with one ordered
   data channel. The receiver answers. Each SDP is signed with the want's nonce and checked before the window sees it. Once
   connected, each end reports the certificate the other really used, and `chat.js` compares it with the signed fingerprint.
   **Nothing about the file goes over the channel before both ends are verified.**
4. **Pieces.** The sender sends `head` (name, size, piece, root) and every piece's hash. The receiver checks that the list
   hashes to the offer's root, then asks for missing pieces, up to 4 at a time (`get`). Each piece is written straight into
   the `.drift-part` file and hashed as it arrives. A bad piece is asked for again, up to 3 times. When every piece checks
   out, the `.drift-part` file is renamed to the file and the receiver sends `done`.

## 2. Big files

- **No size limit in practice.** The offer may say up to 1 TB, a sanity limit. The file is never held in memory: it's read
  1 MB at a time on the sending side and written as it arrives on the receiving side.
- **Resume.** `downloads.json` (in the chat folder) keeps a bitmap of the pieces checked for each download. Pause, a dropped
  connection, the sender going offline or either Drift closing all keep it, and fetching again gets only what's missing.
  This works across restarts.
- **Carrying on by itself** (`ftAuto` in main.js). A download that stopped because a connection dropped tries again once the
  hub is back and the sender is online: at once, then 5 s, 10 s, 20 s and so on, up to 5 minutes apart, counting again from
  the start once it connects. One you paused, or one that failed a check (`fatal`: a damaged piece three times, a file that
  isn't the one offered, a disk error, the sender's file changed), waits for **Resume**. Both stay that way across a
  restart (`paused` in `downloads.json`).
- **The hub dropping.** A relayed transfer stops with it, because its bytes go through the host's PC, and then carries on
  by itself. A direct one that's already verified doesn't need the hub any more, so it carries on: `chat.js` keeps it, and
  the hub tells the other end only with `soft`, which a verified direct transfer ignores. One still connecting stops.
- **Offered again.** Resume state goes by the file's root, not only the offer. If the same file is offered again (a new
  message, maybe after the host's Drift restarted and wiped the old one), its card shows what's already downloaded and
  carries on from there. A file already downloaded says so, with Open.
- **Room on the drive.** A download needs the file's size plus 1 GB free. The `.drift-part` file is made at full size
  before anything arrives, so a drive that can't hold a file that big (FAT32 and files over 4 GB) fails at once with a
  clear message.
- **The file changing.** The sender checks the file's size and modification time before every read, so an offer of a
  file that changed stops at once. After a reconnect, `offer-here` re-announces only files still unchanged on disk; the
  others are marked *No longer offered*.
- **Awake.** While anything moves, `powerSaveBlocker('prevent-app-suspension')` is on.

## 3. Relay or direct, and what's signed

Drift's default is that nobody learns anyone's IP address. So files **up to 500 MB go through the hub's relay**
(`iceTransportPolicy: 'relay'` on both ends). **Bigger files connect directly**: the card says *Download (direct)* and asks
first, because each of you then sees the other's address. The sender's attach note says the same when offering one.

The signed text is `drift-file-v1`, then type, mode (`relay` or `direct`), hub pin, transfer id, offer id, from, to, nonce
and the SDP's fingerprints. Signing the mode means a hub can't quietly switch a relayed download to a direct one to learn
someone's address. Signing the offer and transfer ids means a signature can't be moved to another file or replayed into
another transfer. A request nonce is accepted once.

## 4. Limits

| Limit | Value | Enforced by |
| --- | --- | --- |
| Biggest file | 1 TB (sanity) | hub (the offer), receiver (`files.js`) |
| Biggest file through the relay | 500 MB | hub (`ft-want`), relay (bytes per transfer) |
| Relay speed for files | 2 MB/s per transfer, 4 MB/s for all | `turn.js` token buckets on allocations tagged `f.…` |
| Relay traffic for files | 5 GB a day | `turn.js` |
| Offers open | 50 per member; 20 per 10 s | hub |
| Transfers at once | 3 sending and 3 receiving per member; 8 relayed per hub | hub |
| Download requests | 10 per 10 s per member | hub |
| Free space | file + 1 GB | receiver |
| Name | 200 characters, no folders or reserved Windows names | hub, and again on the receiver |

Over the relay's speed, packets are dropped and the data channel's own congestion control slows down. Voice, broadcasts and
the Surf stream use untagged allocations and are never limited by this. The host can override the relay's file limits with
`createHub({ files: { rate, rateAll, max, day } })`, though there's no Options control for it yet.

## 5. Safety

- Received files are never opened by themselves. **Open** asks first for anything that runs (programs, scripts, shortcuts,
  installers, disk images, Office files with macros: `files.js` `RISKY`).
- The name comes from the sender over the verified connection, and is cleaned: no folders, no characters Windows refuses,
  no reserved names. A clash gets ` (2)`.
- The transfer window is sandboxed and never sees a path. It reads and writes only through main.js, which allows only the
  file that belongs to that transfer.
- The hub can refuse to pass messages on, which only stops a transfer. It can't read a file, swap it, or link one person's
  request to another transfer.

## 6. Where the code is

| Piece | File |
| --- | --- |
| Offers, `ft-want` / `ft-signal` / `ft-end`, limits, relay credentials per transfer | `hub.js` (files section) |
| File limits on the relay | `turn.js` (`fileOk`) |
| Signing and checking, `offer-here` after reconnecting | `chat.js` (`ftText`, `ftGet`, `onFtWant`, …) |
| Hashing, reading, receiving, resume state, folders and names | `files.js` |
| The data channels | `renderer/ft.js`, `ft-preload.js` |
| Glue: the window, IPC, keeping the PC awake, panel state (`ftState`) | `main.js` (files section) |
| File cards, attach for any file, download folder in Options | `renderer/chat.js`, `style.css`, `index.html` |
| Tests | `scripts/test-files.js` (plain Node), `scripts/test-file-transfer.js` (two copies) |

## 7. Not done yet

- A list of every transfer in one place: each one shows only on its message's card. A download whose offer's message is
  gone (and not offered again) has no card, though it's kept on disk.
- Sending a folder (zip it first) or several files in one message.
- Options controls for the host's relay limits.
- Keeping small files on the hub, so they can be had while the sender is offline.
