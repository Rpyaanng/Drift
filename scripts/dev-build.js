#!/usr/bin/env node
// Builds an unpacked x64 dev copy of Drift into dev-build/Drift-<platform>-x64/, for the platform it runs on
// (or the one given: `npm run dev-build -- --platform linux` / `win32`).
// Unpacked (no asar) so every source file can be inspected directly.
// Run manually with `npm run dev-build`, or automatically by the git post-commit hook.

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { packager } = require('@electron/packager');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const outDir = path.join(root, 'dev-build');
const argAt = process.argv.indexOf('--platform');
const platform = argAt > 0 ? process.argv[argAt + 1] : process.platform === 'win32' ? 'win32' : 'linux';
if (!['win32', 'linux'].includes(platform)) { console.error(`dev build: unsupported platform "${platform}" (win32 or linux)`); process.exit(1); }
const ffName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
// ffmpeg is too big for git: keep a copy in vendor/ (ignored), or point FFMPEG_EXE at one. A Linux build without one
// falls back to the system's ffmpeg on the PATH at run time (see ffmpegPath() in main.js).
const ffmpegExe = [process.env.FFMPEG_EXE, path.join(root, 'vendor', ffName), platform === 'win32' && '/home/claude/ff/ffmpeg.exe']
  .filter(Boolean).find((f) => fs.existsSync(f)) || path.join(root, 'vendor', ffName);

function gitInfo() {
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
    return hash + (dirty ? ' (uncommitted changes)' : '');
  } catch {
    return 'not a git checkout';
  }
}

// Netflix and some other services only send their video to a browser whose files carry a VMP signature, made by castLabs'
// free EVS service (one-time setup: `pip install --upgrade castlabs-evs`, then `python -m castlabs_evs.account signup`).
// It must come after any other signing of the files. Without EVS the build still works, and still plays most protected
// video; those services just refuse it. stdin is closed so an expired sign-in fails rather than waiting for a password.
function vmpSign(appDir) {
  const py = process.env.PYTHON || 'python';
  const r = spawnSync(py, ['-m', 'castlabs_evs.vmp', 'sign-pkg', appDir], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, encoding: 'utf8' });
  if (r.status === 0) { console.log('VMP-signed with castLabs EVS'); return; }
  const why = /No module named/.test(r.stderr || '') || r.error ? 'castLabs EVS isn\'t installed' : (r.stderr || r.stdout || '').trim().split('\n').pop();
  console.warn(`warning: not VMP-signed (${why}); Netflix and the like won't play in this build. See vmpSign() in scripts/dev-build.js.`);
}

(async () => {
  const started = Date.now();
  const extraResource = fs.existsSync(ffmpegExe) ? [ffmpegExe] : [];
  if (!extraResource.length) {
    console.warn(`warning: ${ffName} not found at ${ffmpegExe}; ` + (platform === 'win32' ? 'video audio conversion will be unavailable in this build' : 'this build will use the system ffmpeg if there is one'));
  }

  const paths = await packager({
    dir: root,
    name: 'Drift',
    platform,
    arch: 'x64',
    out: outDir,
    overwrite: true,
    prune: true,
    asar: false,
    icon: path.join(root, platform === 'win32' ? 'icon.ico' : 'icon.png'),
    // castLabs' Electron (with Widevine, for copy-protected video in Surf): its builds come from castLabs, not from Electron's own releases
    download: { mirrorOptions: { mirror: 'https://github.com/castlabs/electron-releases/releases/download/' } },
    appVersion: pkg.version,
    extraResource,
    ignore: [
      /^\/dev-build(\/|$)/,
      /^\/scripts(\/|$)/,
      /^\/\.githooks(\/|$)/,
      /^\/\.git(\/|$)/,
      /^\/vendor(\/|$)/,
    ],
    quiet: true,
  });

  const appDir = paths[0];
  fs.writeFileSync(
    path.join(appDir, 'BUILD-INFO.txt'),
    `Drift dev build\nbuilt: ${new Date().toISOString()}\ncommit: ${gitInfo()}\n`
  );
  if (platform === 'win32') vmpSign(appDir);       // VMP signing is for Windows and macOS only
  console.log(`dev build ready in ${((Date.now() - started) / 1000).toFixed(1)}s: ${appDir}`);
})().catch((err) => {
  console.error('dev build failed:', err.message || err);
  process.exit(1);
});
