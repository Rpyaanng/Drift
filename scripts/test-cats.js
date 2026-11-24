// The cats as images drawn once (renderer/cats.js, docs/plans/cats.md), in one hidden copy of Drift: every layer is drawn
// and shared by all the cats, the stacked layers look like the one drawing did (held up against it drawn whole with CSS's
// own drop-shadow), the moving pieces animate about their pivots, asleep shows the right pictures, and a palette change
// draws them again. The pictures are left in the folder (cats-layers-*.png next to cats-reference-*.png).
//   node scripts/test-cats.js            (KEEP=1 keeps the folder)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-cats-'));
  const shots = path.join(dir, 'shots');
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, 'host'), DRIFT_SHOTS: shots, DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300', DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_TESTCATS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve) => {
    const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 90000);
    p.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  let R = {};
  try { R = JSON.parse(fs.readFileSync(path.join(shots, 'cats.json'), 'utf8')); } catch { ok(false, `Drift wrote what it saw (exit ${code})`); }
  ok(R.catsShow, 'the cats show');
  ok(R.drawn, 'every layer of every cat is drawn');
  for (const pal of ['aurora', 'mono']) {
    const r = R[pal]; if (!r) { ok(false, `${pal}: looked at the cats`); continue; }
    const L = r.layers || {};
    ok(r.shared, `${pal}: all ${r.cats} cats share the same images`);
    ok(Object.values(L).every((l) => l.w > 0 && l.h > 0 && l.lit > 0), `${pal}: every layer has something in it (${Object.entries(L).map(([k, l]) => `${k} ${l.w}x${l.h} ${l.lit}`).join(', ')})`);
    ok(['haloBang', 'haloTail', 'haloBody', 'bang', 'tail', 'body', 'eyes'].every((k) => L[k] && L[k].shown) && ['sleep', 'z1', 'z2', 'z3'].every((k) => L[k] && !L[k].shown), `${pal}: awake, the awake layers show and the asleep ones don't`);
    ok(L.tail && L.tail.anim === 'catTail' && L.haloTail.anim === 'catTail' && L.eyes.anim === 'catBlink' && L.bang.anim === 'catBang' && L.body.anim === 'none',
      `${pal}: the tail swings, the eyes blink, the glow pulses, the body stays still (${['tail', 'haloTail', 'eyes', 'bang', 'body'].map((k) => k + ' ' + (L[k] || {}).anim).join(', ')})`);
    ok(L.tail && L.tail.origin === L.haloTail.origin && !/^50%|center/.test(L.tail.origin), `${pal}: the tail and its glow turn about the same pivot (${L.tail && L.tail.origin}; eyes ${L.eyes && L.eyes.origin}; ${JSON.stringify(r.vars)})`);
    const w = r.wrapper || {};
    ok(w.filter === 'none' && w.clip === 'none', `${pal}: the cat itself has no filter or clip-path any more (${w.filter} / ${w.clip})`);
    ok(w.anim && w.anim.includes('catBreathe'), `${pal}: the cat breathes (${w.anim})`);
    ok(w.imgBox && w.box && Math.abs(w.imgBox[2] - (w.box[2] + 112)) < 2, `${pal}: the images reach 56 px past the cat (cat ${JSON.stringify(w.box)}, clip ${JSON.stringify(w.clipBox)}, image ${JSON.stringify(w.imgBox)})`);
    const d = r.diff || {};
    ok(d.mean < 2 && d.big / (d.px * 4) < .01, `${pal}: stacked, the layers look like the whole drawing (mean difference ${d.mean}/255, ${d.big} of ${d.px} channel values off by more than 40, max ${d.max})`);
    const a = r.asleep || {};
    ok(String(a[0]) === 'sleep' && String(a[1]) === 'sleep,z1' && String(a[3]) === 'sleep,z1,z2,z3', `${pal}: asleep, the sleeping cat and its z's one at a time (${JSON.stringify(a)})`);
  }
  ok(R.redrawnForPalette, 'a palette change draws them again');
  console.log(`\npictures in ${shots}`);
  if (!process.env.KEEP && !failed) fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall ok');
  process.exit(failed ? 1 : 0);
})();
