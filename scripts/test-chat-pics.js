// Emoji, pictures and reactions in the Hub tab, in one real copy of Drift that hosts its own hub, pressing the real
// buttons: the emoji picker (search, Enter), a picture pasted into the message box and sent with text, a reaction from
// a message's tools and taken back from its chip, one from the picker, and the GIF button with no GIPHY key.
// (scripts/test-chat.js checks the hub's side: parts, limits, what counts as one emoji.)
//   node scripts/test-chat-pics.js            (KEEP=1 keeps the folder)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-pics-'));
  const shots = path.join(dir, 'shots');
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, 'host'), DRIFT_SHOTS: shots, DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300', DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_TESTPICS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve) => {
    const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 120000);
    p.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  let R = {};
  try { R = JSON.parse(fs.readFileSync(path.join(shots, 'pics.json'), 'utf8')); } catch { ok(false, `Drift wrote what it saw (exit ${code})`); }
  ok(R.hub, 'Host: the hub is up and the message box is on');
  const e = R.emojiPicker || {};
  ok(e.all > 300 && e.focused, `the emoji picker opens with its search focused (${e.all} emoji)`);
  ok(e.first === '🔥' && e.closed && e.input === '🔥', `"fire" finds 🔥 first, and Enter puts it in the box and closes the picker (${JSON.stringify(e)})`);
  const a = R.attached || {};
  ok(a.on && a.preview && /Picture/.test(a.text), `a pasted picture waits over the box with a preview ("${a.text}")`);
  ok(R.pictureShows, 'Enter sends it: the picture shows in the channel');
  const l = R.list || { msgs: [] };
  ok(l.msgs.includes('🔥 hi') && l.msgs.includes('a picture'), `both messages are there (${JSON.stringify(l.msgs)})`);
  ok(l.pic && l.pic[0] === '300px' && l.pic[1] === '150px' && l.pic[2] === 'data:image/webp;base64', `the picture is sized from its own measurements and was sent as WebP (${JSON.stringify(l.pic)})`);
  ok(l.attachGone, 'the waiting picture goes once it\'s sent');
  ok(R.reacted, 'a 👍 from the message\'s tools shows as a lit chip: 👍 1');
  ok(R.unreacted, 'clicking the chip takes it back');
  ok(R.pickerReact === '🥳' || R.pickerReact === '🎉', `React → "party" → Enter reacts with it (${R.pickerReact})`);
  ok(R.videoOverlay, 'over a video, a picture message shows the picture (240 px wide), not "(a picture)"');
  const g = R.gameOverlay || {}, b0 = (g.before || [])[0] || {}, a0 = (g.after || [])[0] || {};
  ok(b0.pic && !b0.pic.img && b0.pic.w === '240px' && b0.pic.h === '120px' && /look 🔥/.test(b0.text), `over a game, the message shows at once with room for its picture, emoji and all (${JSON.stringify(b0)})`);
  ok(a0.pic && a0.pic.img && g.loaded === 300, `...and the picture fills it once it arrives (${JSON.stringify({ a0, loaded: g.loaded })})`);
  const q = R.enterQuick || {};
  ok(q.quick && q.where === '#general', `Enter with the panel away opens the quick box for #general, though nothing is being watched (${JSON.stringify(q)})`);
  ok(q.sent && q.closed && q.toast === 'Sent in #general', `...Enter sends it, the box closes, and a note says where it went ("${q.toast}")`);
  ok(R.enterHubTab && R.enterHubTab.main && !R.enterHubTab.quick, 'with the Hub tab open, Enter goes to its own message box');
  ok(R.enterInTextBox, 'Enter in another text box stays there');
  const fs2 = R.enterFromSlider || {}, sl = fs2.slider || {}, bx = fs2.box || {};
  ok(sl.had && sl.quick && bx.had && bx.quick, `Enter still opens the quick box after a slider or a tick box was used (${JSON.stringify(fs2)})`);
  ok(R.enterOverSurf && R.enterOverSurf.quick && !R.enterOverSurf.main, 'over Surf, with the page not holding the keys, Enter opens the quick box too');
  const sb = R.surfButton || {};
  ok(sb.shown === 'grid' && sb.opens && sb.closes, `over Surf, a chat button in the overlay's corner opens the quick box, and closes it pressed again (${JSON.stringify(sb)})`);
  ok(sb.beside === 6 && sb.level, 'it sits just left of the box, level with it');
  ok(sb.aligned, 'messages over Surf line up with the box, not with the button');
  const fb = R.surfButtonFades || {};
  ok(fb.still && fb.moved && fb.after, `the button is faded while the mouse is still, shows when it moves, and fades again after 2.5 s (${JSON.stringify(fb)})`);
  ok(sb.lit, 'it stays lit while the box is open');
  ok(sb.goneOffSurf, 'and it isn\'t there off Surf (Enter does it)');
  const mr = R.mediaRefused || {};
  ok(mr.stopped && /^Not shared to the hub: Ben isn't on your network/.test(mr.note || '') && /router|Options|provider/.test(mr.note || ''), `a share someone online can't reach stops, and the Media tab says why ("${mr.note}")`);
  ok(/Playing for you only: Ben/.test(mr.toast || ''), `...with a note on screen ("${mr.toast}")`);
  const eh = R.enterOverHubPage || {}, ib = eh.inBox || {}, of = eh.off || {};
  ok(eh.ready && ib.page === 1 && !ib.quick, `over the hub's Surf page, Enter in its text box goes to the page (${JSON.stringify(eh)})`);
  ok(of.page === 1 && of.quick, '...and with nothing in the page selected, it opens the quick box instead');
  ok(R.gifOff, 'GIF search is off: no GIF button, no GIPHY key in Options');
  const c = R.composer || {}, mid = (x) => x && x[0] + x[1] / 2;
  ok(c.input && Math.abs(mid(c.input) - mid(c.emoji)) < 1 && Math.abs(mid(c.input) - mid(c.file)) < 1 && c.input[1] === c.emoji[1], `one line of text sits level with the box's buttons (${JSON.stringify(c)})`);
  if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true }); else console.log('kept: ' + dir);
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
