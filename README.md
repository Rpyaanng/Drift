# Drift

Ambient visuals and soundscapes across all your monitors. Built with Electron.

## Features

- **Scenes**: shader scenes plus algorithm scenes (Sierpinski zoom, sorting algorithms, Game of Life,
  maze solver, Julia sets, Hilbert curve, Voronoi), with optional captions explaining what's happening.
- **3D geometry scenes**: Platonic Solids, Wire Globe, Hex Tunnel, Cube City, Lattice and Menger Sponge.
- **Mathematical geometry scenes**: Quasicrystal (crossing waves that never repeat), Hyperbolic Tiling
  ({7,3}, {5,4}, {8,3} and {4,5} tilings of the Poincaré disc), Apollonian Gasket, Phyllotaxis
  (golden-angle sunflower spirals), Rose Curves (r = cos kθ) and Chladni Plate (sand on a vibrating plate).
- **Landscape scenes**: Mountain Lake, Misty Forest, Desert Dunes, Ocean Sunset, Rolling Hills and
  Canyon Night. Like every scene they take the colours of the palette you pick.
- **Colour**: palette swatches, including a dim Dark palette for night, one that cycles through every
  colour at an adjustable speed, and your own colours.
- **React to sound**: scenes respond to the music, with an optional spectrum or waveform overlay.
- **Monitors**: one setting in **Settings → Across monitors** decides how scenes and videos fill your
  screens: **Span** (one picture across all of them), **Mirror** (the same on each) or **Mix** (each monitor
  picks its own). Close Drift on a single monitor from the exit prompt to keep that screen free.
- **Video**: play your own video folders, one after another or one at a time (**Autoplay**). A monitor
  that switches to the video already playing joins it where it is. Dolby / DTS audio tracks are converted
  on the fly with ffmpeg.
- **HDR and unusual formats**: HDR videos (HDR10, HLG, Dolby Vision) are converted to SDR on screens that
  aren't showing HDR, and formats the built-in player can't play (MPEG-2, Xvid, WMV, AVI...) are converted
  live. You choose the encoder (NVIDIA, Intel, AMD or the processor; H.264, H.265 or AV1), the look and the size.
- **Watch together**: share the video you're playing with friends. They paste an invite code and their
  Drift plays the same video in step with yours, straight from your PC, encrypted, with no server in between.
- **Subtitles**: shown automatically in your language when a video has them. Drift reads tracks stored
  inside the video, subtitle files beside it (`.srt`, `.vtt`, `.ass`, `.ssa`, also in a `Subs` folder),
  any file you load, and can look captions up online by film or show name. Size, colour, style, height
  and timing are adjustable; the track and timing you pick are remembered per video.
- **Music**: browse and search your own music folders, built-in soundscapes, or control the Spotify
  desktop app (play/pause, next, previous, now playing; no login needed).

## Controls

Move the mouse and a control panel appears at the bottom of the screen it's on. `Esc` quits, after asking whether you meant to (`Enter` closes, `Esc` again stays).

| Key | Action |
| --- | --- |
| `Tab` | Show/hide controls |
| `Space` | Play / pause |
| `Left` / `Right` | Previous / next |
| `Up` / `Down` | Volume |
| `1`–`9` | Pick a scene (Scenes tab) |
| `P` | Colour |
| `C` | Clock |
| `B` | Breathing guide |
| `S` | Subtitles on / off (during a video) |
| `V` | Next subtitle track |
| `Z` / `X` | Subtitles 0.1 s earlier / later |

### Watch together

Play a video, open the **Together** tab and press **Share what I'm watching**. Send the invite code to a
friend; they paste it into the same tab and press **Join**. Up to eight friends can join.

- Play, pause, seeking and moving to the next video stay in step on every PC (untick *Friends can play,
  pause and skip* to keep the controls to yourself). With *Pause for everyone while someone is loading*,
  the video waits for a friend who is still loading, for up to 20 seconds.
- The video is streamed from the sharing PC as it plays, so nothing has to be sent beforehand, and jumping
  around works. A friend who already has the same file (same name and size) in their video folders plays
  their own copy instead.
- *Picture sent between PCs* makes the sharing PC send a smaller converted copy (1080p, 720p or 480p) when
  a connection can't keep up with the original. The sharing PC's upload speed is usually the limit.
- Subtitles on the sharing PC are offered to friends, and each person picks their own track, language and
  style. Sound and HDR conversion happen on each PC for its own screen; a friend without ffmpeg gets the
  sharing PC to convert for them.
- The invite code holds the sharing PC's addresses and a one-time secret. The connection is TLS keyed by
  that secret, so only people with the code can connect or see what is being watched. A new code is made
  every time sharing starts.

Reaching the sharing PC: on the same network it works as is. For friends elsewhere, Drift asks the
router (UPnP) to open one TCP port (47800 by default) while sharing and closes it afterwards; if the
router refuses, the Together tab says so, and forwarding that port by hand works too. In that case, and
when the router doesn't report its own address, Drift looks up this PC's public address at api.ipify.org.
Behind a provider that shares one address between homes (CGNAT), use a VPN such as Tailscale on both PCs.
Windows asks once whether to let Drift through its firewall: allow it.

### Video conversion

**Settings → Video conversion** needs ffmpeg (see below).

- *HDR videos*: convert to SDR only on screens that aren't showing HDR (the default — an HDR monitor next
  to an SDR one each get the right picture), always, or never.
- *Convert with*: Automatic uses the fastest encoder that actually works on this PC, tried in the order
  NVIDIA, Intel, AMD, then the processor. Every encoder this copy of ffmpeg has and this PC can run is
  listed. H.264 plays everywhere; if an H.265 or AV1 stream won't play, Drift goes back to Automatic.
- *Converted picture size*: Match my screen avoids converting more pixels than the screen has, which is
  what makes 4K HDR practical on an ordinary PC.

A video the built-in player can't open is converted the same way without asking. Converting HDR needs an
ffmpeg built with zscale (libzimg) or libplacebo; the common full builds have both.

### Online subtitle lookup

In the Video tab, **Find online…** fills in the film or show name guessed from the file name. Pressing
Search sends that name to [Cinemeta](https://v3-cinemeta.strem.io) to identify the title, then asks the
public OpenSubtitles mirror used by Stremio for its subtitles. Neither needs an account. Nothing is sent
until Search is pressed, and only the text in the search box goes out. Results whose release name matches
the video file are listed first and marked "Likely match". Downloads are kept in Drift's settings folder,
not beside your videos.

## Development

```sh
npm install
npm start
```

### Building

```sh
npm run dev-build
```

This writes an unpacked (no asar) Windows x64 copy to `dev-build/Drift-win32-x64/`, with a
`BUILD-INFO.txt` recording the commit it was built from. To rebuild automatically after every commit,
turn on the included hook:

```sh
git config core.hooksPath .githooks
```

The app isn't code-signed, so Windows SmartScreen will warn on first launch
("More info" → "Run anyway").

### ffmpeg (video sound, HDR, other formats and subtitles inside videos)

Converting Dolby / DTS audio, HDR and other video formats, and reading subtitle tracks stored inside a
video all need `ffmpeg.exe`.
It isn't in this repo (too large for GitHub). Put a copy at `vendor/ffmpeg.exe` (ignored by git), or set
`FFMPEG_EXE` to its path, and `dev-build` copies it into the build's `resources` folder. A build made
without it warns, and the app says so in the Video tab instead of playing in silence.

At runtime Drift looks for ffmpeg in this order:

1. the path in the `DRIFT_FFMPEG` environment variable
2. `resources/ffmpeg.exe` next to the packaged app
3. `ffmpeg.exe` in the project folder, then `vendor/ffmpeg.exe`
4. any `ffmpeg.exe` on the `PATH`

### Developer switches

Environment variables for trying things out: `DRIFT_USERDATA=<folder>` runs a second copy with its own
settings (two copies on one PC can share with each other), `DRIFT_SHARE_LOCAL=1` keeps sharing on this PC,
`DRIFT_FAKE_HDR=0|1` pretends the screens are SDR or HDR, `DRIFT_HIDDEN=1` and `DRIFT_MUTE=1` run without
windows or sound.

## License

MIT
