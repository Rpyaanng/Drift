# Surf stream spikes

Throwaway measurements for `docs/plans/streams.md` §10, phase 0. The results are written up in the plan.

| Spike | Run | What it shows |
| --- | --- | --- |
| S1. Capture | `electron spikes/surf-stream/capture.js` | an offscreen page captured from its own frame, picture and sound, with no window showing it |
| S2. Two browsers | (same run) | two sessions, one module-level sync IPC handler answering each page by its session |
| S3. File pickers | (same run) | a preload in one session only stops clicks on `<input type=file>` and `showPicker()` |
| S4. Held downloads | (same run) | what pausing in `will-download` really does, and whether a cancelled one leaves anything |

`electron` here is `./node_modules/.bin/electron`. Electron's output doesn't reach a Windows terminal, so the results go
to the JSON file named by `SPIKE_OUT` (default: `surf-stream-spike.json` in the temp folder). It plays a quiet tone for a moment
(muted where the run says so).
