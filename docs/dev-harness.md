# Dev harness

Drift has a built-in test and screenshot runner, `runShots()` in `main.js`. It is switched on by environment
variables, so it runs the real app with the real UI and needs no test framework. Setting `DRIFT_SHOTS` starts it.
It saves one PNG per monitor window for each step (`<name>-d0.png`, `<name>-d1.png`, …), writes what it saw
to `log.txt` in the same folder, and then quits by itself.

## Quick start

Build first (`npm run dev-build`, Node 22.12 or newer), then:

```sh
DRIFT_USERDATA=/tmp/drift-ud DRIFT_SHOTS=/tmp/drift-shots \
DRIFT_HIDDEN=1 DRIFT_MUTE=1 DRIFT_ONLY=aurora,hyperbolic,lake \
  dev-build/Drift-linux-x64/Drift          # or dev-build\Drift-win32-x64\Drift.exe
```

Leave out `DRIFT_ONLY` to go through every scene. `npm start` (`electron .`) works too, instead of a build.

## Several monitors on one screen

`DRIFT_FAKE_DISPLAYS=N` splits the main screen into N fake monitors side by side, and `DRIFT_FAKE_WIDTHS` gives
their relative widths. Uneven widths are the best check that Span lines a picture up across monitors of different sizes.

There's no variable for **Span / Mirror / Mix**. Write a `settings.json` into the throwaway profile instead, before starting:

```sh
mkdir -p /tmp/drift-ud
echo '{"mode":"mix","perDisplay":{"d0":"pines","d1":"hyperbolic","d2":"lake"}}' > /tmp/drift-ud/settings.json
DRIFT_USERDATA=/tmp/drift-ud DRIFT_SHOTS=/tmp/drift-shots DRIFT_FAKE_DISPLAYS=3 DRIFT_FAKE_WIDTHS=1,2,1 \
DRIFT_HIDDEN=1 DRIFT_MUTE=1 DRIFT_ONLY=seaside DRIFT_SHOTWAIT=9000 \
  dev-build/Drift-linux-x64/Drift
```

`mode` is `span`, `mirror` or `mix`. `perDisplay` is only used by Mix.

## Things that catch you out

- **Heavy scenes need longer.** The landscapes (seaside, canyon, dunes…) are built in the background. With the default
  `DRIFT_SHOTWAIT` of 2.6 s the picture still shows the scene before. Use about `9000`.
- **Always use a throwaway `DRIFT_USERDATA`.** Otherwise a run changes your real settings, and two copies can't run at once.
- **Scene names** come from `SCENES` in `main.js`. A name that isn't in the list is ignored, and the last scene stays up.
- **Linux, started from another Electron app** (an AppImage editor or terminal such as T3 Code or VS Code): it may pass its
  own `LD_LIBRARY_PATH` down, and Drift then dies at start with "Failed to receive hello message from zygote" or "GPU
  process isn't usable". Start it with `env -u LD_LIBRARY_PATH …`. That error isn't the Chromium sandbox, so `--no-sandbox` doesn't fix it.
- `DRIFT_HIDDEN` windows aren't shown, but they still draw and `capturePage` still works. A test that clicks into a
  `<webview>` needs the windows on screen.

## Variables

### The run itself
| Variable | What it does |
| --- | --- |
| `DRIFT_SHOTS=<dir>` | Starts the harness. Screenshots and `log.txt` go here. |
| `DRIFT_ONLY=a,b,…` | Only these scenes (default: all of `SCENES`). |
| `DRIFT_SHOTWAIT=<ms>` | How long each scene runs before its screenshot (default 2600). |
| `DRIFT_USERDATA=<dir>` | A separate profile: settings, caches, Surf's sign-ins. |
| `DRIFT_HIDDEN=1` | Puts nothing on the screen. |
| `DRIFT_MUTE=1` | No sound from Drift's windows or Surf. |
| `DRIFT_FREEZE=1` | Scenes stop at a fixed moment (t = 47 s), so screenshots can be compared from run to run. |
| `DRIFT_PALETTE=<name>` | Colour palette for the run. |

### Pretending
| Variable | What it does |
| --- | --- |
| `DRIFT_FAKE_DISPLAYS=N` | Splits the main screen into N monitors. |
| `DRIFT_FAKE_WIDTHS=1,2,1` | Their relative widths. |
| `DRIFT_FAKE_HDR=0` / `1` | Acts as if the screen is or isn't showing HDR. |
| `DRIFT_FAKE_VERSION=<v>` | Acts like an older version, to try updates (Windows). Also lets a copy run from source check for updates. |
| `DRIFT_UPDATE_AUTOINSTALL=1` | Installs a downloaded update straight away (the whole round trip). |
| `DRIFT_NO_FFMPEG=1` | Acts like a copy that shipped without ffmpeg. |
| `DRIFT_FFMPEG=<path>` | Uses this ffmpeg. |
| `DRIFT_SHARE_LOCAL=1` | Watch together stays on this PC (no UPnP or internet address). |
| `DRIFT_WAYLAND=1` | Linux: runs on Wayland itself instead of through X11. Monitor placement breaks there. |

### Feature tests (each adds its own steps and log lines)
| Variable | What it exercises |
| --- | --- |
| `DRIFT_OVERLAY=1` | The bars and wave overlays, and the colour cycle. |
| `DRIFT_TESTWAV=<file>` | Beat detection on a music file. |
| `DRIFT_TESTMUSIC=<dir>` | The music library. |
| `DRIFT_TESTVIDEO=<file>` | Videos in Span and Mirror, and the sound format found. |
| `DRIFT_TESTSUBS=<secs>` | Subtitles: auto-pick, style, timing, on and off (needs `DRIFT_TESTVIDEO`). Add `DRIFT_TESTSUBS_ONLINE=<title>` for the online search. |
| `DRIFT_TESTXC=<file>` | Live conversion: HDR to SDR, jumping, pausing, settings. `DRIFT_TESTENC=<encoder>` picks the encoder; `DRIFT_FAKE_HDR` picks the screen. |
| `DRIFT_TESTAUTO=<dir>` | Autoplay on and off at the end of a clip (a folder of short clips). |
| `DRIFT_TESTJOIN=<dir>` | A second monitor joins a playing video, then is closed from the exit prompt (clips 15 s or longer, 2 monitors). |
| `DRIFT_CTX=1` | The toolbar following the open tab. |
| `DRIFT_CUSTOM=1` | The custom colour picker, through the real UI. |
| `DRIFT_PANEL=1` | Panel screenshots: Scenes, Media, Settings, Surf, and "Forget Surf's sign-ins". |
| `DRIFT_TESTQUIT=1` | The "Close Drift?" question. |
| `DRIFT_TESTREFOCUS=1` | Turning a monitor off and on again keeps every screen's tab (2+ monitors). `DRIFT_REFOCUS_NOSURF=1` leaves Surf closed. |
| `DRIFT_TESTSURF=1` | Surf's start page (the README picture). |
| `DRIFT_TESTGUARD=1` | Surf's password guard. |
| `DRIFT_TESTMIRROR=1` | Surf mirrored onto the other monitors (needs `DRIFT_FAKE_DISPLAYS=2`+). With `DRIFT_TESTGPU=1`, pages drawn offscreen. |
| `DRIFT_TESTSHAREUI=1` | The Together tab's buttons. |

### Two copies on one PC (watch together)
Start two copies with different `DRIFT_USERDATA`, one `=host` and one `=guest`. `DRIFT_TESTCODE` is a file both can
reach, which the host writes its invite code to.

| Variable | What it exercises |
| --- | --- |
| `DRIFT_TESTSHARE=host` / `guest` | Watching a video together. |
| `DRIFT_TESTTUNE=host` / `guest` | Listening to music together. |
| `DRIFT_TESTWEB=host` / `guest` | A Surf page streamed to the guest, whose mouse and keys go back. `DRIFT_TESTURL` is the page. `DRIFT_TESTCTRL=off` and `DRIFT_TESTADS=off` turn off guest control and the ad blocker; `DRIFT_TESTNAME` sets the name. |
