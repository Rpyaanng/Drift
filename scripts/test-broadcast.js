// A broadcast with three real copies of Drift on this PC (each with its own DRIFT_USERDATA), pressing the real buttons
// (docs/plans/broadcast.md §10, Phase 8). Hosty hosts a hub and goes live from the Share tab (DRIFT_TESTBROADCAST:
// a moving test pattern stands in for the screen picked); Guesty and Third pick the Share tab, their screen turns into the
// grid with Hosty's still on a tile, and Watch fills the screen with it. Guesty presses Back (the grid again, still playing
// on the same connection) and Watch again. Guesty's cursor goes nowhere until Guesty turns "Share my cursor" on for that
// broadcast; then it reaches Hosty's pointer overlay and Third's view. Hosty switches source (nobody drops), pauses and
// resumes; Third presses Stop watching in the view's bar (back to the grid). Guesty goes live too, and Third plays both in
// the grid side by side, fills the screen with one and goes Back. Hosty stops, and Guesty's tile goes. Sound (§8): Hosty goes live with Sound on while a
// quiet 1 kHz tone plays from another program (about -50 dBFS, so barely audible), and the viewers get that tone, in
// stereo, with its own volume; Hosty turns Sound off while live and nobody reconnects. Run once honestly, then for ways a hostile hub can
// interfere (DRIFT_HUB_TAMPER on what Hosty sends Third): Third refuses the broadcast and says so, Guesty still watches.
//   node scripts/test-broadcast.js [modes...]        (modes: honest fingerprint unsigned; honest and fingerprint by default)
//   KEEP=1 keeps the folders, with each copy's log.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');       // (in plain Node this is the path to Electron itself)

const ROOT = path.resolve(__dirname, '..');
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : ['honest', 'fingerprint'];
const ROLES = ['host', 'guest', 'third'];
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

function runDrift(dir, role, mode) {
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, role), DRIFT_SHOTS: path.join(dir, 'shots-' + role), DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300',
    DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_TESTBC: role, DRIFT_TESTBROADCAST: '1', DRIFT_TESTCODE: path.join(dir, 'code.txt'), DRIFT_TESTBC_OUT: path.join(dir, 'out') };
  delete env.ELECTRON_RUN_AS_NODE;
  if (role === 'host' && mode !== 'honest') Object.assign(env, { DRIFT_HUB_TAMPER: mode, DRIFT_HUB_TAMPER_PAIR: 'Hosty>Third' });
  const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 300000);
    p.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

// A quiet 1 kHz tone from another program, for the broadcast's sound to carry (a whole screen: everything but Drift)
function tone(dir) {
  const f = path.join(dir, 'tone1000.wav'), rate = 48000, n = rate * 20, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 1000 * i) / rate) * 100), 44 + i * 2);
  fs.writeFileSync(f, b);
  return spawn('powershell.exe', ['-NoProfile', '-Command', `$p = New-Object System.Media.SoundPlayer '${f}'; $p.PlayLooping(); Start-Sleep 600`], { windowsHide: true, stdio: 'ignore' });
}

function check(mode, R) {
  const H = R.host.steps, G = R.guest.steps, T = R.third.steps, tampered = mode !== 'honest';
  ok(H.live && H.trayLive, `${mode}: Hosty goes live from the Share tab, and the tray light shows`);
  ok(/Live · Screen \d/.test(H.barLive || '') && /Stop/.test(H.barLive || ''), `${mode}: Hosty's hub bar says "Live · Screen" with Stop ("${H.barLive}")`);
  ok(/everything your PC plays, except Drift/.test(H.soundNote || ''), `${mode}: with a screen picked, Sound on says what friends hear ("${H.soundNote}")`);
  ok(H.soundLive && H.soundLive.live === 'on' && H.soundLive.hub, `${mode}: Hosty goes live with sound: the helper captures, and the hub lists it with sound (${JSON.stringify(H.soundLive)})`);
  const viewers = tampered ? [['Guesty', G]] : [['Guesty', G], ['Third', T]];
  for (const [who, s] of [['Guesty', G], ['Third', T]]) {
    ok(s.scene, `${mode}: ${who} picks the Share tab: their screen shows the grid, with a tile for Hosty`);
    const st = Array.isArray(s.still) ? s.still[0] || {} : {};
    ok(st.stillW >= 1024 && (st.btns || []).includes('Watch') && !(st.btns || []).includes('Preview'), `${mode}: ${who}'s tile shows Hosty's still (${st.stillW} px wide), with Watch and no "Preview" while only one is up (${JSON.stringify(st.btns)})`);
  }
  for (const [who, s] of viewers) {
    const f = s.frames || {};
    ok(s.viewOn, `${mode}: ${who} presses Watch: the broadcast fills the screen and frames arrive`);
    ok(f.later > f.first && f.first > 0, `${mode}: ${who}'s picture keeps changing (${f.first} → ${f.later} frames)`);
    ok(/^1280x720$/.test(f.video || ''), `${mode}: ${who} gets the whole picture (${f.video})`);
    ok(f.path === 'relay -> relay', `${mode}: ${who}'s broadcast goes through the hub's relay (${f.path})`);
    ok(!!f.dtls && (f.signed || '').split('\n').includes(f.dtls), `${mode}: ${who}: the certificate Hosty used is the one Hosty signed`);
    ok(s.verdict === 'verified' && s.cardLock, `${mode}: ${who}'s card shows the padlock (verified)`);
    ok(/Watching Hosty/.test(f.bar || '') || /Hosty · Screen/.test(f.bar || ''), `${mode}: ${who}'s view has its bar ("${f.bar}")`);
    ok(/Watching Hosty/.test(s.barWatch || ''), `${mode}: ${who}'s hub bar says "Watching Hosty" ("${s.barWatch}")`);
    const a = s.afterSwitch || {};
    ok(a.state === 'connected' && a.later > a.first && a.dtls === f.dtls, `${mode}: ${who} kept the same connection through Switch source, and the picture still moves`);
    ok(/paused/.test(s.pausedNote || ''), `${mode}: ${who} sees "${s.pausedNote}" while Hosty pauses`);
    const snd = s.sound || {}, t = snd.tone || {};
    ok(snd.audioIn > 2000 && snd.muted === false && /with sound/.test(snd.card || ''), `${mode}: ${who} hears the broadcast (${snd.audioIn} bytes, view ${snd.muted ? 'muted' : 'playing'}, card "${(snd.card || '').replace(/\n+/g, ' | ')}")`);
    ok(t.k1000 > -90 && t.k1000 - t.k700 > 20, `${mode}: ${who}: it's the tone playing on Hosty's PC (1 kHz at ${t.k1000} dB, 700 Hz at ${t.k700})`);
    ok(snd.stereo === true, `${mode}: ${who} asked for stereo Opus`);
    ok(snd.avDelay === 100 && s.soundOffView && s.soundOffView.avDelay === null, `${mode}: ${who} holds the picture back 100 ms to match the sound, and not once it has none (${snd.avDelay}, then ${s.soundOffView && s.soundOffView.avDelay})`);
    ok(snd.slider && s.soundVol && Math.abs(s.soundVol.volume - 0.2) < 0.01 && Math.abs(s.soundVol.saved - 0.2) < 0.01, `${mode}: ${who}'s broadcast volume slider works and is kept apart from voice (${JSON.stringify(s.soundVol)})`);
    ok(s.soundOffView && /no sound/.test(s.soundOffView.card || ''), `${mode}: ${who}: when Hosty turns Sound off, the view goes quiet and the card says "no sound"`);
  }
  const bk = G.back || {}, scr = bk.screen || [0, 0], r = bk.rect || [0, 0, 0, 0];
  ok(bk.full === '' && bk.live && bk.shown && !bk.barOut, `${mode}: Guesty presses Back: the grid again, Hosty still playing in the tile (${JSON.stringify({ full: bk.full, live: bk.live, shown: bk.shown })})`);
  ok((r[2] >= (scr[0] - 32) * 0.95 || r[3] >= (scr[1] - 76) * 0.95) && r[2] < scr[0] && r[1] >= 50, `${mode}: ...one tile as big as fits below the hub bar (${JSON.stringify(r)} on ${scr.join('x')})`);
  ok(bk.later > bk.first && bk.same, `${mode}: ...on the same connection, the picture still moving (${bk.first} → ${bk.later})`);
  ok((bk.btns || []).includes('Watch'), `${mode}: ...and its tile has Watch (${JSON.stringify(bk.btns)})`);
  ok(G.watchAgain && G.watchAgain.full && G.watchAgain.same, `${mode}: Watch fills the screen again, without reconnecting (${JSON.stringify(G.watchAgain)})`);
  ok(G.guestLive && G.guestStopped, `${mode}: Guesty goes live as well, while watching Hosty's, and stops`);
  if (!tampered) {
    const two = T.twoTiles || [], tg = T.twoInGrid || {};
    ok(two.length === 2 && two.every((t) => t.btns.includes('Watch') && t.btns.includes('Preview')), `${mode}: with two up, Third's tiles each have Watch and "Preview" (${JSON.stringify(two.map((t) => t.btns))})`);
    ok(T.twoPlaying, `${mode}: Third plays both in the grid: both connect and frames arrive`);
    ok(tg.full === '' && tg.apart && (tg.shown || []).every(Boolean) && tg.hosty[1] > tg.hosty[0] && tg.guesty[1] > tg.guesty[0], `${mode}: ...side by side, both pictures moving (${JSON.stringify(tg)})`);
    ok((tg.btns || []).every((b) => b.includes('Watch') && b.includes('Stop preview')), `${mode}: ...each with Watch and Stop preview (${JSON.stringify(tg.btns)})`);
    const w = (tg.rects || [])[0] || [0, 0, 0, 0], [sw, sh] = tg.screen || [0, 0];
    ok(w[2] * 2 + 10 >= (sw - 32) * 0.95 || w[3] * 2 + 10 >= (sh - 76) * 0.95, `${mode}: ...the two tiles as big as fit (${w[2]}x${w[3]} each on ${sw}x${sh})`);
    const of = T.oneFull || {};
    ok(of.full && of.hostyLive && of.hostyMuted && (of.shown || []).every(([who, sh]) => (who === 'Guesty') === sh), `${mode}: Watch on Guesty's fills the screen; Hosty's stays connected, hidden and quiet (${JSON.stringify(of)})`);
    ok(T.backToTwo, `${mode}: Back: both playing in the grid again`);
    ok(T.guestTileGone, `${mode}: Guesty stops, and their tile goes from Third's grid`);
  }
  const so = H.soundOff || {};
  ok(so.helper === false && so.hub === false && so.live === 'off' && so.sending === false, `${mode}: Hosty turns Sound off while live: the helper stops, and the hub hears of it (${JSON.stringify(so)})`);
  ok(so.sameConn, `${mode}: ...without anyone watching reconnecting`);
  ok(Array.isArray(H.ptrsBeforeOptIn) && H.ptrsBeforeOptIn.length === 0, `${mode}: before Guesty turns "Share my cursor" on, no pointer reaches Hosty`);
  const hi = G.hint || {};
  ok(/Share my cursor/.test(hi.hint || '') && /Hosty/.test(hi.hint) && hi.nudge && hi.barOut, `${mode}: once the picture arrives, Guesty's bar stays out with a note pointing at "Share my cursor" (${JSON.stringify(hi)})`);
  ok(G.hintGone, `${mode}: ...and it goes as soon as Guesty turns sharing on`);
  ok(G.shareOn && H.overlayGot, `${mode}: Guesty turns it on, and Guesty's pointer reaches Hosty's overlay`);
  const at = H.overlayAt || {};
  ok(Math.abs(at.x - 0.25) < 0.02 && Math.abs(at.y - 0.4) < 0.02, `${mode}: ...at the right spot (${at.x}, ${at.y})`);
  ok(!!H.overlayRect && H.overlayRect.width > 0 && H.overlayProtected, `${mode}: the overlay sits over the screen being shown (${JSON.stringify(H.overlayRect)})`);
  ok(H.chatOverGame && H.chatNotInWindows, `${mode}: Guesty's message goes over what Hosty broadcasts (the overlay above games), not into Drift's windows`);
  ok(G.chatOverBc, `${mode}: ...and Hosty's message goes over the broadcast on Guesty's screen`);
  if (!tampered) ok(T.thirdSeesGuesty, `${mode}: Third sees Guesty's pointer over the picture`);
  const send = H.send || { peers: {} }, ps = Object.values(send.peers);
  ok(ps.length === (tampered ? 1 : 2) || (tampered && ps.length <= 2), `${mode}: Hosty's broadcast window has a connection per viewer (${ps.length})`);
  ok(ps.filter((p) => p.state === 'connected').every((p) => p.path === 'relay -> relay' && p.maxBitrate > 0 && p.maxBitrate <= 4e6), `${mode}: each is relayed, with a bitrate cap (${ps.map((p) => p.maxBitrate).join(', ')})`);
  ok(/frames a second|Ready/.test((H.tab || {}).stats || ''), `${mode}: the tab shows how it's going ("${(H.tab || {}).stats}")`);
  ok(/Guesty/.test((H.tab || {}).who || '') && /pointing/.test((H.tab || {}).who || ''), `${mode}: ...and who's watching, Guesty pointing ("${(H.tab || {}).who}")`);
  ok(H.afterSwitch && H.afterSwitch.track !== H.trackBefore && Object.values(H.afterSwitch.peers).some((p) => p.state === 'connected'), `${mode}: Switch source swaps the capture without dropping anyone`);
  ok(/paused/.test(H.barPaused || ''), `${mode}: Hosty's hub bar says paused ("${H.barPaused}")`);
  if (!tampered) {
    ok(T.thirdStopped && T.thirdStopped.full === '', `${mode}: Third presses Stop watching in the view's bar: back to the grid, Hosty's tile a still (${JSON.stringify(T.thirdStopped)})`);
    ok(G.guestStillWatching, `${mode}: ...and Guesty keeps watching`);
    ok(JSON.stringify(H.hubViewersAfterThird) === JSON.stringify(['Guesty']), `${mode}: the hub lists only Guesty watching (${JSON.stringify(H.hubViewersAfterThird)})`);
  }
  ok(H.stopped && H.overlayGone, `${mode}: Hosty presses Stop sharing: the broadcast window and the overlay go`);
  ok(G.guestViewGone, `${mode}: ...and Guesty's tile goes, leaving the empty grid`);
  if (tampered) {
    ok(!T.viewOn || !(T.frames && T.frames.later > 0), `${mode}: Third never shows the tampered broadcast`);
    ok(T.verdict !== 'verified', `${mode}: Third never shows it as verified`);
    ok(/Couldn't check that this broadcast is really from Hosty/.test(T.refusedWarn || ''), `${mode}: Third's card says it couldn't check it's from Hosty ("${T.refusedWarn}")`);
  }
}

(async () => {
  for (const mode of MODES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `drift-bc-${mode}-`));
    console.log(`\n-- ${mode} (${dir})`);
    const t = tone(dir);
    const exits = await Promise.all(ROLES.map((r) => runDrift(dir, r, mode)));
    try { t.kill(); } catch { /* gone */ }
    const R = {};
    for (const r of ROLES) { try { R[r] = JSON.parse(fs.readFileSync(path.join(dir, 'out', r + '.json'), 'utf8')); } catch { R[r] = null; } }
    if (ROLES.some((r) => !R[r])) {
      ok(false, `${mode}: every copy reported (exits: ${exits.join(', ')}; missing: ${ROLES.filter((r) => !R[r]).join(', ')})`);
      for (const r of ROLES) { try { console.log(`  ${r} log:\n` + fs.readFileSync(path.join(dir, 'shots-' + r, 'log.txt'), 'utf8').split('\n').filter((l) => /^bc |broadcast|error/i.test(l)).slice(-30).join('\n')); } catch { /* no log */ } }
      continue;
    }
    check(mode, R);
    if (process.env.VERBOSE) console.log(JSON.stringify(R, null, 1));
    if (!process.env.KEEP && !failed) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
