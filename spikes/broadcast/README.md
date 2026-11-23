# Broadcast spikes

Throwaway measurements for `docs/plans/broadcast.md` §10, phase 0. The results are written up in the plan.

| Spike | Run | What it shows |
| --- | --- | --- |
| A. Sound | `electron spikes/broadcast/sound.js` | Electron's loopback can't leave out Drift's own sound |
| A. Sound | `node spikes/broadcast/loopback-test.js` | `loopback.ps1` (process loopback through PowerShell) captures one app, or all but one |
| A. Sound | `electron spikes/broadcast/gen-check.js` | PCM written as `AudioData` to a `MediaStreamTrackGenerator` arrives over WebRTC |
| A. Sound | `node spikes/broadcast/bc-sound-check.js` | the real helper (`bc-sound.js`): include a process, exclude one, a bad window |
| A. Sound | `electron spikes/broadcast/av-sync.js` | how far sound trails the picture (`AV_VIDEO_DELAY=100` holds the picture back) |
| B. Encoder | `sh spikes/broadcast/run-encode.sh` | hardware or software encoder, frame rate, and processor use for 1–10 viewers |
| C. Relay | `node spikes/broadcast/turn-video.js 7 3.5 10 1` | `turn.js` carrying broadcasts: processor use and packet loss |
| D. Capture | `electron spikes/broadcast/quirks.js`, `resize-native.js` | covered, minimised, off-screen, resized and closed windows |
| E. Overlay | `electron spikes/broadcast/overlay.js` | the pointer overlay stays out of captures, lets clicks through, follows a window |

`electron` here is `./node_modules/.bin/electron`. Electron's output doesn't reach a Windows terminal, so the Electron
spikes also write their JSON to the file named by `BC_OUT`, `SOUND_OUT`, `QUIRKS_OUT` or `OVERLAY_OUT`. Several open
windows on the main monitor, play quiet tones, or (overlay.js) move the mouse for a moment.
