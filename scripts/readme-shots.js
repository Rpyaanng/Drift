// The README's pictures, from one real copy of Drift on this PC's own monitors (DRIFT_README in main.js runShots): Span, Mix,
// the panel's Scenes and Media tabs, Media's own screen with a song playing, a paused video, and the Hub. It makes a small
// library first (songs with covers and short videos, from the scene pictures in docs/images, with ffmpeg) and runs with its
// own settings folder, so yours aren't touched. The pictures land in OUT (default: a temp folder), one per monitor.
//   node scripts/readme-shots.js [OUT]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const electron = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FF = process.env.DRIFT_FFMPEG || (fs.existsSync(path.join(ROOT, 'vendor', 'ffmpeg.exe')) ? path.join(ROOT, 'vendor', 'ffmpeg.exe') : 'ffmpeg');
const IMG = path.join(ROOT, 'docs', 'images');

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-readme-'));
  const out = path.resolve(process.argv[2] || path.join(work, 'shots'));
  const lib = path.join(work, 'Library');
  fs.mkdirSync(lib, { recursive: true });
  const ff = (...a) => { const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { cwd: lib }); if (r.status !== 0) throw new Error(`ffmpeg ${a.join(' ')}: ${r.stderr}`); };
  const songs = [
    ['01 Low Tide.mp3', 'Low Tide', 'Harbour Lights', 'scene-seaside.jpg', 220],
    ['02 Northern Static.mp3', 'Northern Static', 'Harbour Lights', 'scene-aurora.jpg', 330],
    ['03 Pine Smoke.mp3', 'Pine Smoke', 'Fieldnotes', 'scene-pines.jpg', 262],
    ['04 Glass Garden.mp3', 'Glass Garden', 'Fieldnotes', 'scene-mandala.jpg', 392],
  ];
  for (const [file, title, artist, pic, hz] of songs) {
    ff('-i', path.join(IMG, pic), '-vf', 'crop=ih:ih,scale=600:600', '-frames:v', '1', 'cover.jpg');
    ff('-f', 'lavfi', '-i', `sine=f=${hz}:d=90`, '-f', 'lavfi', '-i', `sine=f=${hz * 1.5}:d=90`, '-i', 'cover.jpg',
      '-filter_complex', '[0][1]amix=inputs=2,volume=0.4[a]', '-map', '[a]', '-map', '2', '-c:v', 'copy', '-disposition:v', 'attached_pic',
      '-id3v2_version', '3', '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', 'album=Drift Sessions', file);
  }
  fs.rmSync(path.join(lib, 'cover.jpg'));
  fs.mkdirSync(path.join(lib, 'Films'));       // (in a folder of their own, so the library's first page is the songs and their covers)
  for (const [file, pic] of [['Films/Northern.Lights.2024.1080p.mp4', 'scene-aurora.jpg'], ['Films/Mountain Lake - Morning.mp4', 'scene-lake.jpg']]) {
    ff('-loop', '1', '-i', path.join(IMG, pic), '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '40', '-vf', "scale=1920:-2,zoompan=z='1+0.0005*on':d=1200:s=1920x1080:fps=30", '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file);
  }
  console.log('library:', lib);
  const env = { ...process.env, DRIFT_USERDATA: path.join(work, 'user'), DRIFT_SHOTS: out, DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '500', DRIFT_README: lib };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve) => {
    const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 180000);
    p.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  console.log(`Drift exited (${code}); pictures in ${out}`);
  try { console.log(fs.readFileSync(path.join(out, 'log.txt'), 'utf8').split('\n').filter((l) => /readme/.test(l)).join('\n')); } catch { console.log('no log'); }
})();
