// Drift — uBlock Origin, the advert blocker Surf uses (see web.js), made ready to load into Surf's session as an extension.
// It isn't kept in Drift itself (it is 28 MB, most of it filter lists, and has a licence of its own, the GPL): the first time
// adverts are to be blocked, one exact release of it is downloaded from its GitHub page, checked against the SHA-256 below,
// unpacked into Drift's user-data folder and changed in a few places so it runs in Electron (see PATCHES). After that it
// keeps its filter lists up to date by itself, as in Chrome. A new release of uBO means a new VERSION and SHA256 here, and
// checking that every patch still applies (prepare() refuses a copy where one doesn't, and says which).
//
// What Electron lacks, and how it is made up for:
//   - chrome.browserAction, contextMenus, privacy, windows, webNavigation, tabs.insertCSS/removeCSS don't exist in Electron.
//     surf-ublock-shim.js stands in for them, in uBO's background page only; webNavigation is made from webRequest.
//   - uBO's "scriptlets" (the small scripts it runs in pages to take adverts out of them from the inside: on YouTube, the
//     advert list in the video's details) are sent from its background page once the page has started, and in Electron
//     that is too late: the page's own scripts have already run. Instead each page's preload asks for them as it starts
//     (surf-scriptlets.js, through web.js) and runs them before anything of the page's own.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { net } = require('electron');

const VERSION = '1.76.6';
const SHA256 = '8831cad49eac3ac3d85d2c32d48a328c63e152ea890cdb2223c77f5b7c0e7837';
const URL = `https://github.com/gorhill/uBlock/releases/download/${VERSION}/uBlock0_${VERSION}.chromium.zip`;
const TOP = 'uBlock0.chromium/';       // everything in the zip is in this folder
const SHIM = path.join(__dirname, 'surf-ublock-shim.js');
const REV = 1;                          // goes up when the patches or the shim change, so an old patched copy is made again

// [file, what is there, what it becomes]. A string must be found exactly once; a regular expression at least once.
const toDrift = [/\bchrome\.([a-zA-Z])/g, 'driftChrome.$1'];       // the background's chrome.* calls go through the shim
const PATCHES = [
  ['background.html', '<script src="lib/lz4/lz4-block-codec-any.js"></script>', '<script src="js/drift-shim.js"></script>\n<script src="lib/lz4/lz4-block-codec-any.js"></script>'],
  ['js/webext.js', ...toDrift],
  ['js/vapi-background.js', ...toDrift],
  ['js/vapi-background-ext.js', ...toDrift],
  // The main-world half of the scriptlets goes in through Drift's preload when it is there (webFrame: no <script> element
  // the page's Content-Security-Policy or Trusted Types could stop)...
  ['js/vapi-scripting.js', `    if ( mainCode ) {
        const doc = document;`, `    if ( mainCode && typeof self.driftMainWorld === 'function' ) {
        self.driftMainWorld(mainCode);
    } else if ( mainCode ) {
        const doc = document;`],
  // ...uBO doesn't send them itself as well (they would run twice)...
  ['js/vapi-scripting.js', `    if ( Boolean(entry?.code) === false ) { return; }
    webext.tabs.executeScript(tabId, {`, `    if ( Boolean(entry?.code) === false ) { return; }
    if ( self.driftPreloadScriptlets ) { return; }
    webext.tabs.executeScript(tabId, {`],
  // ...and they are handed out on request, as one script, from uBO's own cache of them.
  ['js/vapi-scripting.js', 'export function reset() {', `// Drift: the scriptlets for a page that is starting, for its preload to run (see surf-ublock.js)
self.driftScriptlets = function(url) {
    if ( getContentScripts === undefined || reIsHTTP.test(url) === false ) { return ''; }
    const hostname = hostnameFromURI(url);
    if ( hostname === '' ) { return ''; }
    registerContentScript(url);
    return contentScriptDict.get(hostname)?.code ?? '';
};
// ...and forgotten when the trusted sites change (Drift's off switch: see web.js), as they are part of the code
self.driftScriptletsReset = function() { contentScriptDict.clear(); };

export function reset() {`],
];

// The files of a zip, as { name: Buffer }. (Only what GitHub's zips use: stored or deflated, no zip64.)
function unzip(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10), out = {};
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip file');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), noteLen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + noteLen;
    if (name.endsWith('/')) continue;
    const data = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28), raw = buf.subarray(data, data + size);
    out[name] = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!out[name]) throw new Error(`zip entry ${name}: unknown compression`);
  }
  return out;
}

function patch(files) {
  for (const [file, from, to] of PATCHES) {
    const key = TOP + file;
    if (!files[key]) throw new Error(`uBlock Origin ${VERSION}: ${file} is missing`);
    const s = files[key].toString('utf8');
    const n = typeof from === 'string' ? s.split(from).length - 1 : (s.match(from) || []).length;
    if (typeof from === 'string' ? n !== 1 : n < 1) throw new Error(`uBlock Origin ${VERSION}: a patch to ${file} no longer applies`);
    files[key] = Buffer.from(s.replace(from, to), 'utf8');
  }
  files[TOP + 'js/drift-shim.js'] = fs.readFileSync(SHIM);
}

// The folder uBlock Origin is ready to load from, inside `root` (made the first time: downloads ~6 MB).
let making = null;
function prepare(root) {
  const dir = path.join(root, `${VERSION}-${REV}`), done = path.join(dir, '.drift-ready');
  if (fs.existsSync(done)) return Promise.resolve(dir);
  if (!making) making = (async () => {
    const res = await net.fetch(URL);
    if (!res.ok) throw new Error(`downloading uBlock Origin: HTTP ${res.status}`);
    const zip = Buffer.from(await res.arrayBuffer());
    if (crypto.createHash('sha256').update(zip).digest('hex') !== SHA256) throw new Error('the uBlock Origin download isn\'t the expected file');
    const files = unzip(zip);
    patch(files);
    const tmp = `${dir}.tmp-${process.pid}`;
    await fs.promises.rm(tmp, { recursive: true, force: true });
    for (const [name, data] of Object.entries(files)) {
      if (!name.startsWith(TOP)) continue;
      const rel = name.slice(TOP.length), to = path.resolve(tmp, rel);
      if (!rel || !to.startsWith(path.resolve(tmp) + path.sep)) throw new Error(`zip entry ${name}: outside its folder`);
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.writeFile(to, data);
    }
    await fs.promises.writeFile(path.join(tmp, '.drift-ready'), `uBlock Origin ${VERSION}, patched for Drift (rev ${REV})\n`);
    await fs.promises.rm(dir, { recursive: true, force: true });
    await fs.promises.rename(tmp, dir);
    // older copies go
    for (const old of await fs.promises.readdir(root).catch(() => [])) if (old !== path.basename(dir)) fs.promises.rm(path.join(root, old), { recursive: true, force: true }).catch(() => {});
    return dir;
  })().finally(() => { making = null; });
  return making;
}

module.exports = { prepare, VERSION };
