// What's new, in plain Node (no Electron): the notes reader (renderer/notes-md.js), the checker CI runs (scripts/check-notes.js)
// catching each kind of mistake in a copy of the repo made up here, and the GitHub release's description (scripts/release-notes.js).
//   node scripts/test-notes.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const N = require('../renderer/notes-md.js');

let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const ROOT = path.resolve(__dirname, '..');

// ---- the reader ----
const good = `---
version: 2.0.0
date: 2026-12-01
title: A test
hero: hero.png
hero-alt: A hero
---

Intro with **bold**, *italic*, \`code\` and [a link](https://example.com).

## New

- **A labelled item.** Its text.
  It goes on here.
  - **Sub one.** More.
  - Sub two
- **Scenes**: with a colon
- **Not a label** because it runs on

![A picture](pic.webp "Its caption")

> A note.

## Fixed

- Plain fix
`;
const p = N.parse(good);
ok(!p.errors.length && p.meta.version === '2.0.0' && p.meta.title === 'A test' && p.meta.hero === 'hero.png', 'front matter is read');
const intro = p.blocks[0];
ok(intro.t === 'p' && intro.c.map((n) => n.t).join() === 'text,b,text,i,text,code,text,a,text' && intro.c[7].href === 'https://example.com', 'bold, italic, code and links inside text');
const sec = p.blocks[1], list = p.blocks[2];
ok(sec.t === 'h' && sec.kind === 'new' && p.blocks.find((b) => b.t === 'h' && b.text === 'Fixed').kind === 'fixed', 'sections know what kind they are');
ok(N.plain(list.items[0].lead) === 'A labelled item.' && N.plain(list.items[0].c) === 'Its text. It goes on here.', 'a bold start ending a sentence is the item\'s title, and lines carry on');
ok(list.items[0].sub.length === 2 && N.plain(list.items[0].sub[0].lead) === 'Sub one.' && N.plain(list.items[0].sub[1].c) === 'Sub two', 'indented items belong to the one above');
ok(N.plain(list.items[1].lead) === 'Scenes' && N.plain(list.items[1].c) === 'with a colon', '"**Scenes**: ..." is a title too');
ok(list.items[2].lead === null && list.items[2].c[0].t === 'b', 'bold that runs on into the sentence stays in the text');
const img = p.blocks.find((b) => b.t === 'img');
ok(img && img.src === 'pic.webp' && img.alt === 'A picture' && img.caption === 'Its caption', 'a picture on its own line, with what it shows and a caption');
ok(p.blocks.some((b) => b.t === 'note' && N.plain(b.c) === 'A note.'), 'a callout');
ok(N.inline('[x](javascript:alert(1))').every((n) => n.t === 'text'), 'only https links are links');
ok(N.inline('a \\*not italic\\*').length === 1, 'a backslash keeps a * as it is');
ok(N.newer('1.10.0', '1.9.9') && !N.newer('1.9.0', '1.9.0') && N.newer('2.0.0', ''), 'versions compare as numbers');
const has = (n) => ['hero.png', 'pic.webp'].includes(n);
ok(N.check(good, '2.0.0.md', has).length === 0, 'a good file has no problems');
const probs = (t, f = '2.0.0.md', h = has) => N.check(t, f, h);
ok(probs(good, '2.0.1.md').some((x) => /version/.test(x)), 'a file named for another version is caught');
ok(probs(good.replace('date: 2026-12-01', 'date: soon')).some((x) => /date/.test(x)), 'a bad date is caught');
ok(probs(good.replace('title: A test', 'title: ' + 'x'.repeat(81))).some((x) => /80/.test(x)), 'a title over 80 characters is caught');
ok(probs(good, '2.0.0.md', () => false).filter((x) => /isn't in/.test(x)).length === 2, 'a missing hero or picture is caught');
ok(probs(good.replace('![A picture]', '![]')).some((x) => /what it shows/.test(x)), 'a picture that doesn\'t say what it shows is caught');
ok(probs(good.replace('(pic.webp', '(https://x.com/p.webp')).some((x) => /web addresses/.test(x)), 'a picture from the web is caught');
ok(probs('## New\n- x\n').some((x) => /front matter/.test(x)), 'a file with no front matter is caught');
ok(probs(good.replace('hero-alt: A hero\n', '')).some((x) => /hero-alt/.test(x)), 'a hero with no description is caught');
ok(probs(good.replace('title: A test', 'title: A test\nauthor: me')).some((x) => /unknown/.test(x)), 'an unknown front matter key is caught');

// ---- the checker CI runs, on a copy made up here ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-notes-check-'));
const wn = path.join(tmp, 'renderer', 'whats-new');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ea0000000049454e44ae426082', 'hex');
const fresh = (version = '2.0.0') => {
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(path.join(wn, '2.0.0'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(wn, '2.0.0.md'), good);
  fs.writeFileSync(path.join(wn, '2.0.0', 'hero.png'), PNG);
  fs.copyFileSync(path.join(ROOT, 'renderer', 'whats-new', '1.9.1', 'hero.svg'), path.join(wn, '2.0.0', 'pic.webp.svg'));
  fs.writeFileSync(path.join(wn, '2.0.0.md'), good.replace('pic.webp', 'pic.webp.svg'));
};
const check = () => { const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-notes.js')], { env: { ...process.env, DRIFT_NOTES_ROOT: tmp }, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
fresh();
let r = check();
ok(r.code === 0, 'the checker passes a good copy' + (r.code ? `\n${r.out}` : ''));
fresh('2.1.0');
r = check();
ok(r.code === 1 && /no notes for it/.test(r.out), 'a version in package.json with no notes fails CI (the point of it all)');
fresh(); fs.writeFileSync(path.join(wn, '2.0.0', 'stray.png'), PNG);
ok(/isn't used/.test(check().out), 'a picture no notes use fails');
fresh(); fs.writeFileSync(path.join(wn, '2.0.0', 'hero.png'), Buffer.from('not a png'));
ok(/isn't really a png/.test(check().out), 'a picture that isn\'t what its name says fails');
fresh(); fs.writeFileSync(path.join(wn, '2.0.0', 'hero.png'), Buffer.concat([PNG, Buffer.alloc(1.6 * 1024 * 1024)]));
ok(/under 1.5 MB/.test(check().out), 'a picture over 1.5 MB fails');
for (const [bad, what] of [['<script>alert(1)</script>', 'a script'], ['<rect onload="x()"/>', 'an event handler'], ['<image href="https://evil.example/x.png"/>', 'an outside link']]) {
  fresh(); const f = path.join(wn, '2.0.0', 'pic.webp.svg'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('</svg>', bad + '</svg>'));
  ok(check().code === 1, `an svg with ${what} in it fails`);
}
fresh(); fs.writeFileSync(path.join(wn, '1.0.0.md'), good.replace('2.0.0', '1.0.0').replace('2026-12-01', '2027-01-01').replace(/hero.*\n/g, '').replace(/!\[.*\n/, ''));
ok(/before/.test(check().out), 'an older version dated after a newer one fails');
fresh(); fs.mkdirSync(path.join(wn, 'misc'));
ok(/named after its version/.test(check().out), 'a stray folder fails');
fs.rmSync(tmp, { recursive: true, force: true });

// ---- the real notes, and the release's description ----
r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-notes.js')], { encoding: 'utf8' });
ok(r.status === 0, 'this repo\'s own notes pass' + (r.status ? `\n${r.stdout}${r.stderr}` : ''));
const zip = path.join(os.tmpdir(), `drift-notes-zip-${process.pid}.zip`);
fs.writeFileSync(zip, 'pretend zip');
const rel = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release-notes.js'), '1.9.1', '--zip', zip], { encoding: 'utf8' });
const sha = require('crypto').createHash('sha256').update('pretend zip').digest('hex');
ok(rel.status === 0 && (/SHA-256:\s*`?([0-9a-f]{64})/i.exec(rel.stdout) || [])[1] === sha, 'the release description ends with the zip\'s SHA-256, read the way the updater reads it');
ok(/raw\.githubusercontent\.com\/Rpyaanng\/Drift\/v1\.9\.1\/renderer\/whats-new\/1\.9\.1\/hero\.svg/.test(rel.stdout) && !/^---$/m.test(rel.stdout.split('## Download')[0]), 'its pictures point at the tag\'s copy, and the front matter is gone');
ok(/## Download/.test(rel.stdout) && /\*\*Send files of any size, straight from your PC\*\*/.test(rel.stdout), 'with the title at the top and the download section at the end');
ok(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release-notes.js'), '1.9.1'], { encoding: 'utf8' }).status === 1, 'without the zip it refuses (no checksum, no update)');
ok(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release-notes.js'), '9.9.9', '--zip', zip], { encoding: 'utf8' }).status === 1, 'for a version with no notes it refuses');
fs.rmSync(zip, { force: true });

console.log(failed ? `\n${failed} failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
