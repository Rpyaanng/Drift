# Drift

Ambient visuals and soundscapes across all your monitors. Built with Electron.

## Features

- **Scenes**: shader scenes plus algorithm scenes (Sierpinski zoom, sorting algorithms, Game of Life,
  maze solver, Julia sets, Hilbert curve, Voronoi), with optional captions explaining what's happening.
- **Colour**: palette swatches, including one that cycles through every colour at an adjustable speed.
- **React to sound**: scenes respond to the music, with an optional spectrum or waveform overlay.
- **Video**: play your own video folders, mirrored or spanned across monitors. Dolby / DTS audio tracks
  are converted on the fly with ffmpeg.
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

## Development

```sh
npm install
npm start
```

### Video sound (ffmpeg)

Converting Dolby / DTS audio needs `ffmpeg.exe`. It isn't in this repo (too large for GitHub).
Drift looks for it in this order:

1. the path in the `DRIFT_FFMPEG` environment variable
2. `resources/ffmpeg.exe` next to the packaged app
3. `ffmpeg.exe` in the project folder

### Building

```sh
npm run package
```

This writes `dist/Drift-win32-x64/`. Copy `ffmpeg.exe` into its `resources` folder before you share it.
The app isn't code-signed, so Windows SmartScreen will warn on first launch
("More info" → "Run anyway").

## License

MIT
