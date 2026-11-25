#!/usr/bin/env node
// The GitHub release's description for a version, made from its What's new notes (renderer/whats-new/<version>.md), so the
// notes are written once: the app shows them, and the release page says the same. Its pictures point at the tag's copy in
// the repo, so they show on GitHub too. The download section and the zip's SHA-256 (which the updater checks) go at the end.
//   node scripts/release-notes.js [version] --zip <Drift-Windows-x64.zip> > notes.md
//   gh release create v<version> <zip> --title "Drift <version>" --notes-file notes.md
// version: package.json's when left out. Without --zip it stops: a release without its checksum can't update anyone.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const N = require('../renderer/notes-md.js');

const REPO = 'Rpyaanng/Drift';
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2), zipAt = args.indexOf('--zip');
const zip = zipAt >= 0 ? args[zipAt + 1] : '';
const version = args.find((a, i) => !a.startsWith('--') && i !== zipAt + 1) || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const file = path.join(root, 'renderer', 'whats-new', version + '.md');
const fail = (why) => { console.error('release-notes: ' + why); process.exit(1); };

if (!fs.existsSync(file)) fail(`there are no notes for ${version}: write renderer/whats-new/${version}.md first (node scripts/check-notes.js says what's needed)`);
const text = fs.readFileSync(file, 'utf8');
const problems = N.check(text, version + '.md', (name) => fs.existsSync(path.join(root, 'renderer', 'whats-new', version, name)));
if (problems.length) fail(`the notes for ${version} aren't ready:\n  - ${problems.join('\n  - ')}`);
if (!zip) fail('say which zip this release is (--zip <path>): its SHA-256 goes in the notes, and the updater checks every download against it');
if (!fs.existsSync(zip)) fail(`${zip} isn't there`);
const sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');

const { meta } = N.parse(text);
const url = (name) => `https://raw.githubusercontent.com/${REPO}/v${version}/renderer/whats-new/${version}/${encodeURIComponent(name)}`;
const body = text.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  .replace(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/gm, (_m, alt, src, cap) => `![${alt}](${url(src)})${cap ? `\n<sub>${cap}</sub>` : ''}`);
const out = [
  meta.hero ? `![${meta['hero-alt'] || meta.title}](${url(meta.hero)})\n` : '',
  `**${meta.title}**\n`,
  body,
  '',
  '## Download',
  '',
  '**Drift-Windows-x64.zip** (Windows 10/11, 64-bit, ffmpeg included). Unzip it anywhere, then double-click `Drift.exe` inside the `Drift-win32-x64` folder. Keep it in that folder.',
  '',
  'On 1.5.0 or newer? Drift updates itself. Coming from 1.4.1 or older, download this one by hand and unzip it over your old copy.',
  '',
  'It isn\'t code-signed: if Windows shows "Windows protected your PC", click **More info** → **Run anyway**. Your settings carry over.',
  '',
  `SHA-256: \`${sha}\``,
  '',
].join('\n');
process.stdout.write(out);
