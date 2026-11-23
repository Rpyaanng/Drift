// Drift — the Surf stream's browser can't reach the host's own network (docs/plans/streams.md §8). Everyone in a hub can
// drive that browser, and it runs on the host's PC: without this, a member could open the host's router's admin page, other
// PCs at the host's home, or Drift's own hub and watch-together ports.
//
// The hub browser's session sends every request through this small proxy, listening on 127.0.0.1 (web.js sets it, with
// "<-loopback>" so that localhost goes through it too). For each request it looks the name up itself, refuses it if any
// address the name resolves to is local, and otherwise connects to the address it checked. That is what stops a public name
// that resolves to a local address (DNS rebinding): the check is on the address actually connected to, at request time,
// never on what was typed. Plain HTTP is forwarded; HTTPS and WebSockets come as CONNECT tunnels, so their contents are
// never seen here.
//
// Local: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 198.18/15, multicast and reserved; IPv6 loopback,
// unspecified, link-local (fe80::/10), unique local (fc00::/7), and IPv4-mapped forms of the IPv4 ones. Names ending in
// .local, .localhost, .lan, .home, .internal or .home.arpa are refused before any lookup. The host can allow particular
// addresses (allowed(): "192.168.1.20", "192.168.1.20:32400", "nas.local:5000").
//
//   const guard = createLanGuard({ allowed: () => [...], refused: (host) => {} });  await guard.port;  guard.close()
const http = require('http');
const net = require('net');
const dns = require('dns');

const LOCAL_NAME = /(^|\.)(local|localhost|lan|home|internal|home\.arpa|localdomain)\.?$/i;
function v4Local(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !(n >= 0 && n <= 255))) return true;       // (anything odd counts as local)
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && p[2] === 0);
}
function isLocal(ip) {
  ip = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(ip)) return v4Local(ip);
  if (!net.isIPv6(ip)) return true;
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) || /^::(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return v4Local(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(ip)) {       // the mapped form written in hex
    const [hi, lo] = ip.split(':').slice(-2).map((x) => parseInt(x, 16));
    return v4Local([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
  }
  if (ip === '::' || ip === '::1') return true;
  const first = parseInt(ip.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;       // unique local, link-local, multicast
}
// "host:port" from a CONNECT line or a URL; IPv6 in brackets
function split(hostport, defPort) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostport) || /^([^:]+)(?::(\d+))?$/.exec(hostport);
  if (!m) return null;
  const port = m[2] ? +m[2] : defPort;
  return port > 0 && port < 65536 ? { host: m[1].toLowerCase(), port } : null;
}

module.exports = function createLanGuard({ allowed = () => [], refused = () => {}, lookup = dns.lookup } = {}) {
  const ok = (host, port, ip) => {
    for (const a of allowed() || []) {
      const s = split(String(a).trim(), 0);
      if (!s) continue;
      if ((s.host === host || s.host === ip) && (!s.port || s.port === port)) return true;
    }
    return false;
  };
  let told = 0;
  const no = (host) => { if (Date.now() - told > 5000) { told = Date.now(); refused(host); } };
  // Resolves to the address to connect to, or null when the name is (or resolves to anything) local and not allowed.
  function resolve(host, port) {
    return new Promise((done) => {
      const pick = (ips) => {
        if (!ips.length) return done(null);
        const bad = ips.filter((ip) => isLocal(ip) && !ok(host, port, ip));
        if (bad.length) { no(host); return done(null); }       // any local answer at all: refused (a mixed answer can't be used to sneak in)
        done(ips[0]);
      };
      if (net.isIP(host)) { pick([host]); return; }
      if (LOCAL_NAME.test(host) && !ok(host, port, '')) { no(host); done(null); return; }
      lookup(host, { all: true, verbatim: true }, (e, list) => pick(e ? [] : (list || []).map((x) => x.address)));
    });
  }
  const server = http.createServer(async (req, res) => {       // plain HTTP, as an absolute URL
    let u = null;
    try { u = new URL(req.url); } catch { /* not a proxy request */ }
    if (!u || u.protocol !== 'http:') { res.writeHead(400); res.end(); return; }
    const hp = split(u.host, 80), ip = hp && await resolve(hp.host, hp.port);
    if (!ip) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Drift: the Surf stream can\'t open addresses on the host\'s own network.'); return; }
    const headers = { ...req.headers, host: u.host };
    delete headers['proxy-connection']; delete headers['proxy-authorization'];
    const up = http.request({ host: ip, port: hp.port, method: req.method, path: u.pathname + u.search, headers, setHost: false }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('connect', async (req, sock, head) => {       // HTTPS and WebSockets: a tunnel to the checked address
    sock.on('error', () => {});
    const hp = split(String(req.url || ''), 443), ip = hp && await resolve(hp.host, hp.port);
    if (!ip) { sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
    const up = net.connect(hp.port, ip, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
  });
  server.on('clientError', (_e, sock) => sock.destroy());
  const port = new Promise((resolveP, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveP(server.address().port));
  });
  return { port, close: () => { try { server.close(); } catch { /* closed */ } } };
};
Object.assign(module.exports, { isLocal, split });
