// p2p.js's dry run (probe), in plain Node (no Electron): what it says, and that it never gets in a share's way.
// DRIFT_REACH tells lookOut what to find, so nothing here asks the router or the internet.
//   node scripts/test-reach.js
const net = require('net');
const createP2P = require('../p2p');

let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };
const hooks = {
  snapshot: () => ({}), fileAt: () => '', cues: async () => [], convert: (_q, res) => res.end(), ptr() {}, ptrs() {}, guestCmd() {}, rtc() {},
  playing: () => false, hold() {}, remote() {}, publicIp: async () => '', say() {}, changed() {}, unreached: () => '',
};
const free = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const until = async (pred, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

(async () => {
  const port = 47870;
  for (const want of ['internet', 'lan', 'manual']) {
    process.env.DRIFT_REACH = want;
    const p2p = createP2P(hooks);
    const r = await p2p.probe({ port, local: true });
    ok(r.reach === want && r.port === port, `a dry run finds what lookOut does: ${want} (${JSON.stringify(r)})`);
    ok(await free(port), `and lets the port go again (${want})`);
  }
  process.env.DRIFT_REACH = 'lan';
  const p2p = createP2P(hooks);
  ok((await p2p.probe({ port, internet: false, local: true })).reach === 'lan', 'with sharing over the internet off, it\'s this network only, untried');
  const a = p2p.probe({ port, local: true }), b = p2p.probe({ port, local: true });
  ok(a === b, 'two asks at once share one try');
  const sharing = p2p.share({ port, internet: true, name: 'T', local: true });       // (while the dry run holds the port)
  await a; await sharing;
  ok(p2p.info().role === 'host' && p2p.info().port === port, `a share started during a dry run still gets its port (${p2p.info().port})`);
  ok(await until(() => p2p.info().reach === 'lan' && !p2p.info().settling), 'the share finds the same as the dry run');
  ok(/shares one address/.test(p2p.info().note), 'and the Hub tab says why');
  ok((await p2p.probe({ port, local: true })).reach === 'lan', 'a dry run while sharing is what the share found');
  await p2p.stop();
  ok(await free(port), 'stopping lets the port go');
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
