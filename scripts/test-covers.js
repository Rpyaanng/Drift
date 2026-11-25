// Songs' own covers, titles and artists (tags.js, main.js song-tags), in one real copy of Drift: first tags.js alone on a song
// of each kind (ID3v2.3 and 2.4 MP3, FLAC, M4A, Opus and Vorbis with a cover big enough to run over several Ogg pages, WAV),
// then in the app: the Media tab's tiles show each cover with the song's title and artist, a song with no cover takes the
// folder's Folder.jpg, playing a song puts its title and artist in what's playing and its cover on the record sleeve, and
// the sleeve leans toward the pointer as the record does. The songs are made with ffmpeg (on PATH, or DRIFT_FFMPEG).
//   node scripts/test-covers.js            (KEEP=1 keeps the folder)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const electron = require('electron');
const { readTags } = require('../tags');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const TITLE = 'Tëst Sóng', ARTIST = 'The Ärtist', ALBUM = 'Some Album';

(async () => {
  const FF = process.env.DRIFT_FFMPEG || 'ffmpeg';
  if (spawnSync(FF, ['-version']).status !== 0) { console.log('skipped: no ffmpeg to make the test songs with'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-covers-')), lib = path.join(dir, 'music');
  fs.mkdirSync(path.join(lib, 'folder'), { recursive: true });
  const ff = (...a) => { const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...a], { cwd: lib }); if (r.status !== 0) throw new Error(`ffmpeg ${a.join(' ')}: ${r.stderr}`); };
  const meta = ['-metadata', `title=${TITLE}`, '-metadata', `artist=${ARTIST}`, '-metadata', `album=${ALBUM}`];
  ff('-f', 'lavfi', '-i', 'testsrc2=s=600x600', '-frames:v', '1', 'cover.jpg');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=600x600', '-frames:v', '1', 'cover.png');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=1600x1600', '-frames:v', '1', '-q:v', '2', 'big.jpg');
  ff('-f', 'lavfi', '-i', 'sine=f=440:d=4', 'a.wav');
  const pic = (img) => ['-i', img, '-map', '0', '-map', '1', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-metadata:s:v', 'comment=Cover (front)'];
  ff('-i', 'a.wav', ...pic('cover.jpg'), '-c:a', 'libmp3lame', '-id3v2_version', '3', ...meta, 'v23.mp3');
  ff('-i', 'a.wav', ...pic('cover.png'), '-c:a', 'libmp3lame', '-id3v2_version', '4', ...meta, 'v24.mp3');
  ff('-i', 'a.wav', ...pic('cover.jpg'), '-c:a', 'flac', ...meta, 's.flac');
  ff('-i', 'a.wav', ...pic('cover.jpg'), '-c:a', 'aac', ...meta, 's.m4a');
  ff('-i', 'a.wav', '-c:a', 'pcm_s16le', ...meta, 's.wav');
  // Ogg: ffmpeg won't put a picture in, so the cover goes in as a METADATA_BLOCK_PICTURE comment (an ffmetadata file: it's too long for a command line)
  const img = fs.readFileSync(path.join(lib, 'big.jpg')), u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const block = Buffer.concat([u32(3), u32(10), Buffer.from('image/jpeg'), u32(0), u32(1600), u32(1600), u32(24), u32(0), u32(img.length), img]);
  fs.writeFileSync(path.join(dir, 'ogg.txt'), `;FFMETADATA1\ntitle=${TITLE}\nartist=${ARTIST}\nalbum=${ALBUM}\nMETADATA_BLOCK_PICTURE=${block.toString('base64')}\n`);
  ff('-i', 'a.wav', '-i', path.join(dir, 'ogg.txt'), '-map', '0:a', '-map_metadata', '1', '-c:a', 'libopus', 's.opus');
  ff('-i', 'a.wav', '-i', path.join(dir, 'ogg.txt'), '-map', '0:a', '-map_metadata', '1', '-c:a', 'libvorbis', 's.ogg');
  ff('-i', 'a.wav', '-c:a', 'libmp3lame', path.join('folder', 'plain.mp3'));
  fs.copyFileSync(path.join(lib, 'cover.jpg'), path.join(lib, 'folder', 'Folder.jpg'));
  for (const f of ['a.wav', 'cover.jpg', 'cover.png', 'big.jpg']) fs.unlinkSync(path.join(lib, f));

  // tags.js on its own
  const want = { 'v23.mp3': ['image/jpeg', 'jpg'], 'v24.mp3': ['image/png', 'png'], 's.flac': ['image/jpeg', 'jpg'], 's.m4a': ['image/jpeg', 'jpg'], 's.opus': ['image/jpeg', img.length], 's.ogg': ['image/jpeg', img.length], 's.wav': [null] };
  const jpg = fs.statSync(path.join(lib, 'folder', 'Folder.jpg')).size;
  for (const [f, [mime, n]] of Object.entries(want)) {
    const t = await readTags(path.join(lib, f)), p = t.pic;
    const len = n === 'jpg' ? jpg : n;
    ok(t.title === TITLE && t.artist === ARTIST && t.album === ALBUM && (mime ? p && p.mime === mime && (n === 'png' || p.data.length === len) : !p),
      `${f}: title, artist and album${mime ? `, and its cover (${mime})` : ', no cover'} (${JSON.stringify({ title: t.title, artist: t.artist, album: t.album, pic: p && [p.mime, p.data.length] })})`);
  }
  const none = await readTags(path.join(lib, 'folder', 'plain.mp3'));
  ok(!none.title && !none.pic, 'a song with no tags reads as empty');

  // in the app
  const shots = path.join(dir, 'shots');
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, 'host'), DRIFT_SHOTS: shots, DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300', DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_TESTCOVERS: lib };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve) => {
    const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 120000);
    p.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  let R = {};
  try { R = JSON.parse(fs.readFileSync(path.join(shots, 'covers.json'), 'utf8')); } catch { ok(false, `Drift wrote what it saw (exit ${code})`); }
  if (R.error) ok(false, 'no error in the app: ' + R.error);
  const m = R.mp3 || {};
  ok(m.title === TITLE && m.artist === ARTIST && m.album === ALBUM && m.art === 'data:image/jpeg;base64,', `song-tags gives the title, artist, album and cover (${JSON.stringify(m)})`);
  ok((R.flacSmall || {}).artLen > 1000 && (R.flacSmall || {}).artLen < m.artLen, `...a smaller cover for a tile than for the sleeve (${(R.flacSmall || {}).artLen} < ${m.artLen})`);
  const fo = R.folder || {};
  ok(fo.art === 'data:image/jpeg;base64,' && !fo.title, `a song with no cover of its own takes the folder's Folder.jpg (${JSON.stringify(fo)})`);
  ok(R.outside === null, 'a song outside the library and the playlist isn\'t read');
  ok(R.tilesArt, 'each song with a cover shows it on its tile in the Media tab (all but the WAV)');
  const tiles = R.tiles || [], tagged = tiles.filter((t) => t.nm === TITLE), arted = tiles.filter((t) => t.art);
  ok(tiles.length === 7 && tagged.length === 7 && tagged.every((t) => t.sz.startsWith(ARTIST + ' · ')), `...every tile has the song's own title, and its artist by the size (${JSON.stringify(tiles.map((t) => [t.nm, t.sz]))})`);
  ok(arted.length === 6 && arted.every((t) => t.after.startsWith('url("data:image/') && t.fit === 'contain'), `...each cover whole in its tile (${JSON.stringify(tiles[0])})`);
  ok(R.nowTagged, 'what\'s playing takes the song\'s title and artist from its tags');
  ok(R.sleeveArt, 'the record sleeve shows the song\'s cover');
  const s = R.sleeve || {};
  ok(s.title === TITLE && s.artist === ARTIST, `...with its title and artist beside it (${JSON.stringify([s.title, s.artist])})`);
  const axis = (r) => (r || '').split(' ').map(parseFloat);
  const [sx, sy, , sd] = axis(s.rotate), [dx, dy, , dd] = axis(s.disc);
  ok(sd > 1 && dd > 1 && Math.sign(sx) === Math.sign(dx) && Math.sign(sy) === Math.sign(dy) && +s.gx > 0, `the sleeve leans toward the pointer the way the record does, its glint with it (sleeve ${s.rotate}, record ${s.disc}, --gx ${s.gx})`);
  ok(R.nowUntagged && R.folderSleeve, `a song with no tags shows its file's name, no artist, and its folder's cover (${JSON.stringify(R.sleeveAfter)})`);
  if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true }); else console.log('kept: ' + dir);
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
