#!/usr/bin/env node
// Builds an unpacked Windows x64 dev copy of Drift into dev-build/Drift-win32-x64/.
// Unpacked (no asar) so every source file can be inspected directly.
// Run manually with `npm run dev-build`, or automatically by the git post-commit hook.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { packager } = require('@electron/packager');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const outDir = path.join(root, 'dev-build');
const ffmpegExe = process.env.FFMPEG_EXE || '/home/claude/ff/ffmpeg.exe';

function gitInfo() {
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== '';
    return hash + (dirty ? ' (uncommitted changes)' : '');
  } catch {
    return 'not a git checkout';
  }
}

(async () => {
  const started = Date.now();
  const extraResource = fs.existsSync(ffmpegExe) ? [ffmpegExe] : [];
  if (!extraResource.length) {
    console.warn(`warning: ffmpeg.exe not found at ${ffmpegExe}; video audio conversion will be unavailable in this build`);
  }

  const paths = await packager({
    dir: root,
    name: 'Drift',
    platform: 'win32',
    arch: 'x64',
    out: outDir,
    overwrite: true,
    prune: true,
    asar: false,
    icon: path.join(root, 'icon.ico'),
    appVersion: pkg.version,
    extraResource,
    ignore: [
      /^\/dev-build(\/|$)/,
      /^\/scripts(\/|$)/,
      /^\/\.githooks(\/|$)/,
      /^\/\.git(\/|$)/,
    ],
    quiet: true,
  });

  const appDir = paths[0];
  fs.writeFileSync(
    path.join(appDir, 'BUILD-INFO.txt'),
    `Drift dev build\nbuilt: ${new Date().toISOString()}\ncommit: ${gitInfo()}\n`
  );
  console.log(`dev build ready in ${((Date.now() - started) / 1000).toFixed(1)}s: ${appDir}`);
})().catch((err) => {
  console.error('dev build failed:', err.message || err);
  process.exit(1);
});
