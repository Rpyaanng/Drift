#!/usr/bin/env node
// What's new: every version's notes are there and right (renderer/whats-new/, read by renderer/notes-md.js, the same reader
// the app uses). Run by CI on every push and pull request (.github/workflows/notes.yml) and by the pre-push hook, so a release
// can't go out without its notes. Plain Node, no packages.
//   node scripts/check-notes.js          exit 1 and say what's wrong, or say it's fine
//
// It checks:
//   - the version in package.json has notes (this is the one that stops a release without them)
//   - every release tag (vX.Y.Z) has notes too, so the history in the app has no gaps
//   - each file: its front matter (version, date, title, hero), something in it, every picture it names is in its folder
//     and says what it shows; dates go forward with the versions
//   - each picture: png, jpg, webp, gif or svg that really is one, not too big (1.5 MB; an svg 250 KB), named by a notes file
//     (no strays), and an svg can't run anything or fetch anything (no scripts, event handlers or outside links)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const N = require('../renderer/notes-md.js');

const root = process.env.DRIFT_NOTES_ROOT || path.resolve(__dirname, '..'), dir = path.join(root, 'renderer', 'whats-new');       // (DRIFT_NOTES_ROOT: another copy to check, for scripts/test-notes.js)
const RASTER_MAX = 1.5 * 1024 * 1024, SVG_MAX = 250 * 1024;
const problems = [], notes = [];
const bad = (where, what) => problems.push(`${where}: ${what}`);

const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
for (const f of files) {
  const full = path.join(dir, f);
  if (fs.statSync(full).isDirectory()) {
    if (!N.VERSION.test(f)) bad(`whats-new/${f}/`, 'a folder of pictures must be named after its version, like 1.9.1/');
    else if (!files.includes(f + '.md')) bad(`whats-new/${f}/`, `pictures for ${f}, but there's no ${f}.md`);
    continue;
  }
  if (!/\.md$/.test(f)) { bad(`whats-new/${f}`, 'only <version>.md files and <version>/ folders of pictures go here'); continue; }
  const v = f.replace(/\.md$/, ''), pics = path.join(dir, v);
  const text = fs.readFileSync(full, 'utf8');
  for (const p of N.check(text, f, (name) => fs.existsSync(path.join(pics, name)))) bad(`whats-new/${f}`, p);
  const { meta, blocks } = N.parse(text);
  notes.push({ v, date: meta.date || '' });
  // the pictures: what's named, and what's in the folder
  const named = new Set([meta.hero, ...blocks.filter((b) => b.t === 'img').map((b) => b.src)].filter(Boolean));
  for (const name of fs.existsSync(pics) ? fs.readdirSync(pics) : []) {
    const where = `whats-new/${v}/${name}`, p = path.join(pics, name);
    if (!named.has(name)) { bad(where, `isn't used in ${f}: use it or delete it`); continue; }
    if (!N.IMG.test(name)) { bad(where, 'not a picture Drift shows (png, jpg, webp, gif or svg)'); continue; }
    const buf = fs.readFileSync(p), ext = path.extname(name).toLowerCase();
    if (ext === '.svg') {
      if (buf.length > SVG_MAX) bad(where, `${Math.round(buf.length / 1024)} KB: keep an svg under ${SVG_MAX / 1024} KB`);
      const s = buf.toString('utf8');
      if (!/<svg[\s>]/.test(s)) bad(where, 'doesn\'t look like an svg');
      if (/<script|<foreignObject|<iframe|<embed|<object/i.test(s)) bad(where, 'has a script or embedded page in it: pictures in notes can\'t run anything');
      if (/\son[a-z]+\s*=/i.test(s)) bad(where, 'has an event handler (onload= and the like): pictures in notes can\'t run anything');
      if (/(?:href|src)\s*=\s*["']\s*(?!#)[a-z][a-z0-9+.-]*:/i.test(s) || /url\(\s*["']?\s*(?!#)[a-z][a-z0-9+.-]*:/i.test(s)) bad(where, 'links to something outside itself: everything it shows must be in the file');
    } else {
      if (buf.length > RASTER_MAX) bad(where, `${(buf.length / 1048576).toFixed(1)} MB: keep a picture under 1.5 MB (save it as jpg or webp, about 1600 px wide)`);
      const is = { '.png': buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '.jpg': buf[0] === 0xff && buf[1] === 0xd8, '.jpeg': buf[0] === 0xff && buf[1] === 0xd8,
        '.gif': buf.subarray(0, 4).toString('latin1') === 'GIF8', '.webp': buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP' }[ext];
      if (!is) bad(where, `isn't really a ${ext.slice(1)} file`);
    }
  }
}

// dates go forward with the versions
notes.sort((a, b) => (N.newer(a.v, b.v) ? 1 : N.newer(b.v, a.v) ? -1 : 0));
for (let i = 1; i < notes.length; i++) if (notes[i].date && notes[i - 1].date && notes[i].date < notes[i - 1].date) bad(`whats-new/${notes[i].v}.md`, `dated ${notes[i].date}, before ${notes[i - 1].v} (${notes[i - 1].date})`);

// the version about to go out, and every one already out
const have = new Set(notes.map((n) => n.v));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!have.has(version)) bad('package.json', `the version is ${version}, but there are no notes for it: write renderer/whats-new/${version}.md (copy the last one to start)`);
let tags = [];
try { tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\s+/).filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map((t) => t.slice(1)); } catch { /* no git here: the tags aren't checked */ }
for (const t of tags) if (!have.has(t)) bad(`tag v${t}`, `released without notes: write renderer/whats-new/${t}.md`);
const ahead = notes.filter((n) => N.newer(n.v, version)).map((n) => n.v);

if (problems.length) {
  console.error(`What's new: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n` + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log(`What's new: notes for ${notes.length} versions are fine (${version} included${tags.length ? `, and every tag` : ''})${ahead.length ? `; ${ahead.join(', ')} not released yet` : ''}.`);
