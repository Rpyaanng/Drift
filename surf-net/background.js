// Drift — the Sec-CH-UA headers every Chrome sends, added to Surf's requests.
// Electron never sends them (it has no client hints at all), while the page's own navigator.userAgentData still answers.
// Sites' bot checks see the mismatch and ask for captcha after captcha, so the headers are added here, saying exactly what
// navigator.userAgentData says. The detailed ones (full version, platform version, architecture…) go only to a site that
// asked for them with Accept-CH, as Chrome does.
// This is an extension, not session.webRequest in web.js, because Electron gives a session's requests either to
// session.webRequest or to its extensions, never both: one listener there and the advert blocker (uBlock Origin, also an
// extension) would see nothing.

// What the browser says it is: navigator.userAgentData's high-entropy values, handed over by web.js (setIdent) as soon as it
// knows them. Until then, the basic headers say what web.js guessed, and the detailed ones aren't sent.
let ident = null;
self.setIdent = (v) => { if (v && Array.isArray(v.brands)) ident = v; };

const sfStr = (s) => `"${String(s == null ? '' : s).replace(/[\\"]/g, '\\$&')}"`;       // a structured-header string, as Chrome writes it
const sfList = (bs) => (Array.isArray(bs) ? bs : []).map((b) => `${sfStr(b.brand)};v=${sfStr(b.version)}`).join(', ');
const sfBool = (b) => (b ? '?1' : '?0');
// the detailed hints a site can ask for with Accept-CH: header → [navigator.userAgentData field, how it is written]
const HIGH = {
  'sec-ch-ua-full-version-list': ['fullVersionList', sfList],
  'sec-ch-ua-full-version': ['uaFullVersion', sfStr],
  'sec-ch-ua-platform-version': ['platformVersion', sfStr],
  'sec-ch-ua-arch': ['architecture', sfStr],
  'sec-ch-ua-bitness': ['bitness', sfStr],
  'sec-ch-ua-wow64': ['wow64', sfBool],
  'sec-ch-ua-model': ['model', sfStr],
  'sec-ch-ua-form-factors': ['formFactors', (f) => [].concat(f).map(sfStr).join(', ')],
};
const asked = new Map();       // origin → the detailed headers it asked for with Accept-CH

// The headers for one request: the three every Chrome sends, and those `want` (header names a site asked for) once known
function hints(want) {
  if (!ident) return {};
  const h = { 'sec-ch-ua': sfList(ident.brands), 'sec-ch-ua-mobile': sfBool(ident.mobile), 'sec-ch-ua-platform': sfStr(ident.platform) };
  if (ident.known && want) for (const k of want) { const [field, write] = HIGH[k] || []; if (field && ident[field] !== undefined) h[k] = write(ident[field]); }
  return h;
}
const URLS = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'];       // (Chrome sends them only to secure origins)
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };

chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  const h = d.requestHeaders, has = new Set(h.map((x) => x.name.toLowerCase()));       // (a page's own fetch() already carries the basic ones)
  for (const [name, value] of Object.entries(hints(asked.get(originOf(d.url))))) if (!has.has(name)) h.push({ name, value });
  return { requestHeaders: h };
}, { urls: URLS }, ['blocking', 'requestHeaders', 'extraHeaders']);

chrome.webRequest.onResponseStarted.addListener((d) => {
  if (d.type !== 'main_frame') return;       // as in Chrome: a page itself asks, for its own origin
  const v = (d.responseHeaders || []).find((x) => x.name.toLowerCase() === 'accept-ch');
  if (!v) return;
  const o = originOf(d.url);
  if (!o) return;
  const want = new Set(String(v.value || '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => HIGH[s]));
  asked.delete(o);
  if (want.size) { asked.set(o, want); if (asked.size > 500) asked.delete(asked.keys().next().value); }
}, { urls: URLS }, ['responseHeaders', 'extraHeaders']);
