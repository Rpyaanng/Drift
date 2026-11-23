// The Surf stream's guard against the host's own network (surf-lan.js), in plain Node: which addresses count as local, and
// the proxy refusing a name that resolves to one (DNS rebinding), a literal local address and a .local name, over plain HTTP
// and CONNECT, while letting through a local address the host allowed.
//   node scripts/test-surf-lan.js
const createLanGuard = require('../surf-lan');
const { isLocal } = createLanGuard;
const http = require('http'), net = require('net');
const cases = { '127.0.0.1': 1, '10.1.2.3': 1, '192.168.0.1': 1, '172.16.5.5': 1, '172.32.0.1': 0, '169.254.1.1': 1, '100.64.0.1': 1, '8.8.8.8': 0, '::1': 1, 'fe80::1': 1, 'fd00::1': 1, '2606:4700::1111': 0, '::ffff:192.168.1.1': 1, '::ffff:c0a8:0101': 1, '0.0.0.0': 1, '224.0.0.1': 1 };
let bad = 0;
for (const [ip, want] of Object.entries(cases)) if (isLocal(ip) !== !!want) { bad++; console.log('wrong', ip); }
(async () => {
  // a fake "rebinding" name: lookup says a public-looking name resolves to 127.0.0.1
  const target = http.createServer((q, r) => r.end('secret')).listen(0, '127.0.0.1');
  await new Promise((r) => target.once('listening', r));
  const tp = target.address().port;
  const g = createLanGuard({ lookup: (h, o, cb) => cb(null, h === 'evil.example' ? [{ address: '127.0.0.1' }] : [{ address: '93.184.216.34' }]), allowed: () => [`allowed.example:${tp}`] });
  const port = await g.port;
  const get = (url) => new Promise((done) => http.get({ host: '127.0.0.1', port, path: url, headers: { host: new URL(url).host } }, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => done(r.statusCode + ' ' + b.slice(0, 20))); }).on('error', (e) => done('err ' + e.message)));
  const conn = (hp) => new Promise((done) => { const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${hp} HTTP/1.1\r\nHost: ${hp}\r\n\r\n`)); s.once('data', (d) => { done(String(d).split('\r\n')[0]); s.destroy(); }); s.on('error', (e) => done('err ' + e.message)); });
  const r1 = await get(`http://evil.example:${tp}/`), r2 = await get(`http://127.0.0.1:${tp}/`), r3 = await conn(`evil.example:${tp}`), r4 = await conn(`router.local:443`);
  console.log('rebinding name over http:', r1); console.log('literal 127.0.0.1:', r2); console.log('CONNECT rebinding:', r3); console.log('CONNECT .local:', r4);
  if (!/^403/.test(r1) || !/^403/.test(r2) || !/403/.test(r3) || !/403/.test(r4)) bad++;
  // allowed by name+port (resolves locally in the fake lookup? use literal via allowed host mapping)
  const g2 = createLanGuard({ lookup: (h, o, cb) => cb(null, [{ address: '127.0.0.1' }]), allowed: () => [`127.0.0.1:${tp}`] });
  const p2 = await g2.port;
  const r5 = await new Promise((done) => http.get({ host: '127.0.0.1', port: p2, path: `http://127.0.0.1:${tp}/` }, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => done(r.statusCode + ' ' + b)); }));
  console.log('allowed local address:', r5); if (!/^200 secret/.test(r5)) bad++;
  console.log(bad ? `${bad} wrong` : 'all right');
  process.exit(bad ? 1 : 0);
})();
