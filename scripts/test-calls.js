// Calls between three real copies of Drift on this PC (each with its own DRIFT_USERDATA), pressing the real buttons:
// the host's Drift runs the hub, the host starts a call, the guest joins, the third joins last. Each sends a steady
// test tone instead of a microphone. Run once honestly, then once for each way a hostile hub can interfere
// (DRIFT_HUB_TAMPER, aimed at what Third sends Guesty), and check what every copy saw:
//   honest:   every pair connects through the hub's relay (relay -> relay), sound arrives, and the DTLS certificate each
//             side really used is the one its signed SDP promised. Every lock says verified.
//   tampered: Guesty refuses Third and says "Couldn't verify Third. The hub may be interfering.", Third is told, and the
//             other two pairs still connect, verified.
//   node scripts/test-calls.js [modes...]          (modes: honest fingerprint unsigned replay swapkey; all by default)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');       // (in plain Node this is the path to Electron itself)

const ROOT = path.resolve(__dirname, '..');
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : ['honest', 'fingerprint', 'unsigned', 'replay', 'swapkey'];
const ROLES = ['host', 'guest', 'third'];
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

function runDrift(dir, role, mode) {
  const env = { ...process.env, DRIFT_USERDATA: path.join(dir, role), DRIFT_SHOTS: path.join(dir, 'shots-' + role), DRIFT_ONLY: 'aurora', DRIFT_SHOTWAIT: '300',
    DRIFT_HIDDEN: '1', DRIFT_MUTE: '1', DRIFT_TESTVOICE: role, DRIFT_TESTCODE: path.join(dir, 'code.txt'), DRIFT_TESTVOICE_OUT: path.join(dir, 'out') };
  delete env.ELECTRON_RUN_AS_NODE;
  if (role === 'host' && mode !== 'honest') Object.assign(env, { DRIFT_HUB_TAMPER: mode, DRIFT_HUB_TAMPER_PAIR: 'Third>Guesty' });
  const p = spawn(electron, [ROOT], { env, stdio: 'ignore' });
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve('timed out'); }, 240000);
    p.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

function check(mode, R) {
  const id = Object.fromEntries(ROLES.map((r) => [r, R[r].me]));
  const label = (r) => R[r].name;
  const target = mode !== 'honest' ? ['third', 'guest'] : null;       // Third's messages to Guesty are tampered with
  const isTarget = (a, b) => !!target && ((a === target[0] && b === target[1]) || (a === target[1] && b === target[0]));
  for (const a of ROLES) for (const b of ROLES) {
    if (a === b) continue;
    const me = R[a], other = id[b], t = (me.test && me.test.peers && me.test.peers[other]) || {};
    const pair = `${label(a)} -> ${label(b)}`;
    if (isTarget(a, b)) {
      ok(t.state !== 'connected', `${mode}: ${pair} doesn't connect`);
      ok(me.call.verdict[other] !== 'verified', `${mode}: ${pair} is never shown as verified`);
      continue;
    }
    ok(me.call.verdict[other] === 'verified', `${mode}: ${pair} verified (signature checked, certificate matches)`);
    ok(t.state === 'connected', `${mode}: ${pair} connected`);
    ok(t.path === 'relay -> relay', `${mode}: ${pair} goes through the hub's relay (${t.path})`);
    ok(!!t.dtls && (t.signed || '').split('\n').includes(t.dtls), `${mode}: ${pair} the DTLS certificate is the signed one`);
    ok(t.bytesIn > 2000 && t.level > 0.05, `${mode}: ${pair} sound arrives (${t.bytesIn} bytes, level ${t.level})`);
    ok(/^Verified/.test(me.panel.locks[R[b].name] || ''), `${mode}: ${label(a)}'s panel shows a lock on ${label(b)}`);
  }
  if (target) {
    const g = R.guest, th = R.third;
    ok(!!g.call.refused[id.third], `${mode}: Guesty's Drift refused what came as Third's (${g.call.refused[id.third]})`);
    ok(g.panel.warns.includes('Couldn\'t verify Third. The hub may be interfering.'), `${mode}: Guesty sees "Couldn't verify Third. The hub may be interfering."`);
    ok(th.call.told.includes(id.guest), `${mode}: Third's Drift is told Guesty couldn't verify it`);
    ok(th.panel.warns.some((w) => /Guesty couldn't verify your connection/.test(w)), `${mode}: Third sees that Guesty couldn't verify it`);
    ok(!/^🔒 End-to-end encrypted/.test(g.panel.note) && !/^🔒 End-to-end encrypted/.test(th.panel.note), `${mode}: neither says the whole call is end-to-end encrypted ("${g.panel.note}")`);
    ok(/^🔒 End-to-end encrypted in calls of up to 8/.test(R.host.panel.note), `${mode}: the host, whose connections are all verified, does`);
    if (mode === 'swapkey') ok(g.suspect.some((s) => s.id === id.third) && g.panel.warns.some((w) => /sent a key for Third/.test(w)), `${mode}: Guesty is told the hub sent a key for Third that isn't theirs`);
  } else {
    for (const r of ROLES) ok(/^🔒 End-to-end encrypted in calls of up to 8/.test(R[r].panel.note), `${mode}: ${label(r)}'s panel says "${R[r].panel.note}"`);
    for (const r of ROLES) ok(/🔒/.test(R[r].panel.bar) && /Leave/.test(R[r].panel.bar), `${mode}: ${label(r)} has the call bar, with a lock ("${R[r].panel.bar}")`);
    for (const r of ROLES) ok(Object.values(R[r].heard).every(Boolean), `${mode}: ${label(r)} counts everyone talking in the call as heard (so their typing stays out of the overlay)`);
    for (const r of ROLES) ok(R[r].mutedReported && R[r].lightAfterMute === 'open', `${mode}: ${label(r)} mutes: the hub hears of it and the light goes grey`);
    const relay = R.host.relay;
    ok(relay && relay.allocations >= 6 && relay.packetsIn > 100 && relay.dropped === 0, `${mode}: the hub's relay carried the call (${relay && relay.allocations} allocations, ${relay && relay.packetsIn} packets, ${relay && relay.dropped} dropped)`);
  }
}

(async () => {
  for (const mode of MODES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `drift-calls-${mode}-`));
    console.log(`\n-- ${mode} (${dir})`);
    const exits = await Promise.all(ROLES.map((r) => runDrift(dir, r, mode)));
    const R = {};
    for (const r of ROLES) { try { R[r] = JSON.parse(fs.readFileSync(path.join(dir, 'out', r + '.json'), 'utf8')); } catch { R[r] = null; } }
    if (ROLES.some((r) => !R[r])) {
      ok(false, `${mode}: every copy reported (exits: ${exits.join(', ')}; missing: ${ROLES.filter((r) => !R[r]).join(', ')})`);
      for (const r of ROLES) { try { console.log(`  ${r} log:\n` + fs.readFileSync(path.join(dir, 'shots-' + r, 'log.txt'), 'utf8').split('\n').filter((l) => /voice|error/i.test(l)).slice(-20).join('\n')); } catch { /* no log */ } }
      continue;
    }
    check(mode, R);
    if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
