# Drift

Ambient visuals and soundscapes across all your monitors. Built with Electron.

## Features

- **Scenes**: shader scenes plus algorithm scenes (Sierpinski zoom, sorting algorithms, Game of Life,
  maze solver, Julia sets, Hilbert curve, Voronoi), with optional captions explaining what's happening.
- **3D geometry scenes**: Platonic Solids, Wire Globe, Hex Tunnel, Cube City, Lattice and Menger Sponge.
- **Mathematical geometry scenes**: Quasicrystal (crossing waves that never repeat), Hyperbolic Tiling
  ({7,3}, {5,4}, {8,3} and {4,5} tilings of the Poincaré disc), Apollonian Gasket, Phyllotaxis
  (golden-angle sunflower spirals), Rose Curves (r = cos kθ) and Chladni Plate (sand on a vibrating plate).
- **Colour**: palette swatches, including one that cycles through every colour at an adjustable speed.
- **React to sound**: scenes respond to the music, with an optional spectrum or waveform overlay.
- **Video**: play your own video folders, mirrored or spanned across monitors. Dolby / DTS audio tracks
  are converted on the fly with ffmpeg.
- **Subtitles**: shown automatically in your language when a video has them. Drift reads tracks stored
  inside the video, subtitle files beside it (`.srt`, `.vtt`, `.ass`, `.ssa`, also in a `Subs` folder),
  any file you load, and can look captions up online by film or show name. Size, colour, style, height
  and timing are adjustable; the track and timing you pick are remembered per video.
- **Music**: browse and search your own music folders, built-in soundscapes, or control the Spotify
  desktop app (play/pause, next, previous, now playing; no login needed).

## Controls

Move the mouse and a control panel appears at the bottom of the screen it's on. `Esc` quits.

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

### ffmpeg (video sound and subtitles inside videos)

Converting Dolby / DTS audio and reading subtitle tracks stored inside a video both need `ffmpeg.exe`.
It isn't in this repo (too large for GitHub). Put a copy at `vendor/ffmpeg.exe` (ignored by git), or set
`FFMPEG_EXE` to its path, and `dev-build` copies it into the build's `resources` folder. A build made
without it warns, and the app says so in the Video tab instead of playing in silence.

At runtime Drift looks for ffmpeg in this order:

1. the path in the `DRIFT_FFMPEG` environment variable
2. `resources/ffmpeg.exe` next to the packaged app
3. `ffmpeg.exe` in the project folder, then `vendor/ffmpeg.exe`
4. any `ffmpeg.exe` on the `PATH`

## License

MIT
