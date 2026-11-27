// The Games room tiles' pictures (renderer/games/<scene>.jpg), from one real copy of Drift on this PC, hidden, with its own
// settings folder (DRIFT_GAMEPICS in main.js runShots): Blackjack with a bet down, Roulette with chips on the layout, Hold'em
// at the river, and Sketch & Guess with a drawing going. Run it again when a table's look changes.
//   timeout 200 node scripts/game-pics.js [OUT]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');

const ROOT = path.resolve(__dirname, '..');

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-gamepics-'));
  const out = path.resolve(process.argv[2] || path.join(ROOT, 'renderer', 'games'));
  const env = { ...process.env, DRIFT_USERDATA: path.join(work, 'user'), DRIFT_SHOTS: path.join(work, 'shots'), DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300',
    DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_BJ_FAST: '1', DRIFT_GAMEPICS: out };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve) => {
    const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 180000);
    p.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  console.log(`Drift exited (${code}); pictures in ${out}`);
  try { console.log(fs.readFileSync(path.join(work, 'shots', 'log.txt'), 'utf8').split('\n').filter((l) => /gamepics/.test(l)).join('\n')); } catch { console.log('no log in ' + work); }
})();
