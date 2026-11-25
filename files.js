// Drift — files sent straight between members' PCs, the disk side (docs/plans/files.md). Plain Node, so it runs under the
// tests too; main.js gives it the folders and passes bytes between it and the transfer window (renderer/ft.js).
//
// A file is checked in pieces of PIECE bytes: each piece's SHA-256, and the offer's `root`, the SHA-256 of all of them one
// after another. The offer (in a chat message, through the hub) carries only the root; the list of pieces comes over the
// verified connection and must hash to it. So every piece is checked as it arrives, a bad one is fetched again alone, and a
// download that stops (a dropped connection, a PC that sleeps or closes) carries on later from the pieces it already has.
//
//   const files = createFiles({ dir, downloads: () => folder, log });
//   sending:   await files.prepare(path, onProgress) -> offer;  files.has(id);  files.head(id);  files.read(id, at, len);  files.forget(id)
//   receiving: await files.recvStart({ offer, hub, from, name, size, root, piece });  files.recvHashes(id, list);
//              await files.recvWrite(id, i, at, bytes);  await files.recvFinish(id);  files.recvDrop(id)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { cleanFileName } = require('./hub');

const PIECE = 16 * 1024 * 1024;
const MAX = 2 ** 40;       // the biggest a file may be (1 TB): a sanity limit, not a real one
const SPARE = 1024 * 1024 * 1024;       // a download needs this much more free space than the file, so the drive isn't filled
const OFFER_ID = /^[A-Za-z0-9_-]{16,64}$/;
const b64 = (b) => Buffer.from(b).toString('base64url');
const rootOf = (hashes) => b64(crypto.createHash('sha256').update(Buffer.concat(hashes)).digest());
const pieceCount = (size, piece) => Math.max(1, Math.ceil(size / piece));
const pieceLen = (size, piece, i) => Math.min(piece, size - i * piece);
// Files that run something when opened: the panel asks before opening one of these.
const RISKY = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|lnk|url|hta|cpl|jar|reg|inf|dll|sys|appx|msix|appref-ms|iso|img|vhd|vhdx|docm|xlsm|pptm)$/i;
const MIMES = { '.pdf': 'application/pdf', '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.txt': 'text/plain', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const mimeOf = (name) => MIMES[path.extname(name).toLowerCase()] || 'application/octet-stream';
// What Windows says when a file is too big for the drive's kind of file system (FAT32 keeps files under 4 GB).
const tooBigForDrive = (e, size) => size >= 2 ** 32 && ['EFBIG', 'EINVAL', 'ENOSPC', 'EPERM'].includes(e && e.code);

module.exports = function createFiles(opts) {
  const log = opts.log || (() => {});
  const offDir = path.join(opts.dir, 'offers'), inFile = path.join(opts.dir, 'downloads.json');
  fs.mkdirSync(offDir, { recursive: true });
  const offPath = (id) => path.join(offDir, id + '.json');

  // ================= sending =================
  // offer id -> { path, name, size, mtimeMs, piece, hashes: [Buffer], root }. Kept on disk too, so offers outlive a restart.
  const offers = new Map();
  for (const f of fs.readdirSync(offDir)) {
    const id = f.replace(/\.json$/, '');
    if (!OFFER_ID.test(id)) continue;
    try {
      const o = JSON.parse(fs.readFileSync(offPath(id), 'utf8'));
      offers.set(id, { ...o, hashes: o.hashes.map((h) => Buffer.from(h, 'base64url')) });
    } catch { try { fs.unlinkSync(offPath(id)); } catch { /* gone */ } }
  }
  // Read a file once and work out its pieces' hashes. onProgress(done, size) as it goes. Resolves the offer as a message carries it.
  async function prepare(file, onProgress = () => {}, piece = PIECE) {
    const st = await fsp.stat(file).catch(() => null);
    if (!st || !st.isFile()) throw new Error('That isn\'t a file Drift can read.');
    if (!st.size) throw new Error('That file is empty.');
    if (st.size > MAX) throw new Error('That file is too big to offer (1 TB at most).');
    const fh = await fsp.open(file, 'r');
    const hashes = [], buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    try {
      let at = 0, last = 0;
      while (at < st.size) {
        const h = crypto.createHash('sha256'), end = Math.min(st.size, at + piece);
        while (at < end) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - at), at);
          if (!bytesRead) throw new Error('The file got shorter while Drift was reading it.');
          h.update(buf.subarray(0, bytesRead)); at += bytesRead;
        }
        hashes.push(h.digest());
        if (Date.now() - last > 200) { last = Date.now(); onProgress(at, st.size); }
      }
    } finally { await fh.close(); }
    const now = await fsp.stat(file);
    if (now.size !== st.size || now.mtimeMs !== st.mtimeMs) throw new Error('The file changed while Drift was reading it. Try again when it\'s finished.');
    const id = crypto.randomBytes(18).toString('base64url'), name = cleanFileName(path.basename(file)) || 'file';
    const o = { path: file, name, size: st.size, mtimeMs: st.mtimeMs, piece, hashes, root: rootOf(hashes) };
    offers.set(id, o);
    fs.writeFileSync(offPath(id), JSON.stringify({ ...o, hashes: hashes.map(b64) }));
    onProgress(st.size, st.size);
    return { id, name, size: o.size, mime: mimeOf(name), root: o.root, piece };
  }
  // Is the offered file still here, as it was? (A file that changed can't be sent: its pieces wouldn't match.)
  function has(id) {
    const o = offers.get(id);
    if (!o) return false;
    try { const st = fs.statSync(o.path); return st.size === o.size && st.mtimeMs === o.mtimeMs; } catch { return false; }
  }
  function forget(id) { offers.delete(id); try { fs.unlinkSync(offPath(id)); } catch { /* gone */ } }
  const offerInfo = (id) => { const o = offers.get(id); return o ? { name: o.name, size: o.size, path: o.path } : null; };
  // What the receiver gets first, over the connection: the name, size and every piece's hash.
  function head(id) {
    const o = offers.get(id);
    if (!o || !has(id)) return null;
    return { name: o.name, size: o.size, mime: mimeOf(o.name), piece: o.piece, root: o.root, hashes: o.hashes.map(b64) };
  }
  // Up to `len` bytes from `at`, read fresh each time (with the file's size and time checked, so a file that changed stops).
  const handles = new Map();       // offer id -> { fh, at (last used) }
  async function read(id, at, len) {
    const o = offers.get(id);
    if (!o) throw new Error('That file isn\'t offered from this PC.');
    at = Math.max(0, Math.floor(at)); len = Math.max(0, Math.min(4 * 1024 * 1024, Math.floor(len), o.size - at));
    let h = handles.get(id);
    if (!h) { h = { fh: await fsp.open(o.path, 'r'), at: 0 }; handles.set(id, h); }
    h.at = Date.now();
    const st = await h.fh.stat();
    if (st.size !== o.size || st.mtimeMs !== o.mtimeMs) throw new Error(`${o.name} changed since it was offered.`);
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) { const { bytesRead } = await h.fh.read(buf, got, len - got, at + got); if (!bytesRead) break; got += bytesRead; }
    return buf.subarray(0, got);
  }
  setInterval(() => { for (const [id, h] of [...handles]) if (Date.now() - h.at > 60000) { handles.delete(id); h.fh.close().catch(() => {}); } }, 30000).unref();

  // ================= receiving =================
  // offer id -> { hub, from, name, size, root, piece, part (the .part file), done (pieces checked: a bitmap, base64), path (once finished), at }
  let downs = {};
  try { downs = JSON.parse(fs.readFileSync(inFile, 'utf8')) || {}; } catch { downs = {}; }
  let saveTimer = null;
  const save = (now) => {
    clearTimeout(saveTimer); saveTimer = null;
    const write = () => { try { fs.writeFileSync(inFile + '.tmp', JSON.stringify(downs)); fs.renameSync(inFile + '.tmp', inFile); } catch (e) { log('files: ' + e.message); } };
    if (now) write(); else saveTimer = setTimeout(write, 1000);
  };
  const live = new Map();       // offer id -> { fh, hashes: [Buffer] | null, cur: { i, h, got } | null, bits: Buffer }
  const bitsOf = (d) => { const n = pieceCount(d.size, d.piece), b = Buffer.alloc(Math.ceil(n / 8)); if (d.done) Buffer.from(d.done, 'base64').copy(b); return b; };
  const hasBit = (b, i) => !!(b[i >> 3] & (1 << (i & 7)));
  function uniqueName(dir, name) {
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    for (let n = 1; n < 1000; n++) {
      const p = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
      if (!fs.existsSync(p) && !fs.existsSync(p + '.drift-part')) return p;
    }
    return path.join(dir, `${stem} ${Date.now()}${ext}`);
  }
  // Get ready to receive (or carry on receiving) an offered file: room on the drive, and the .part file made at full size,
  // which also finds out at once if the drive can't hold a file that big. Resolves { have } (pieces already checked) or { error }.
  async function recvStart(o) {
    const size = Math.floor(+o.size), piece = Math.floor(+o.piece);
    if (!OFFER_ID.test(String(o.offer)) || !(size > 0 && size <= MAX) || !(piece >= 1 << 20 && piece <= 1 << 26)) return { error: 'That file can\'t be downloaded.' };
    let d = downs[o.offer];
    if (d && (d.size !== size || d.root !== o.root || d.piece !== piece)) { await recvDrop(o.offer); d = null; }       // a different file under the same id: start again
    if (!d) {       // the same file offered again (the same root, so the same bytes): carry on from what came of the last offer, or say it's here
      const [old, od] = Object.entries(downs).find(([k, x]) => k !== o.offer && x.root === o.root && x.size === size && x.piece === piece && !live.has(k) && (x.path ? fs.existsSync(x.path) : fs.existsSync(x.part))) || [];
      if (od && od.path) return { error: 'You already downloaded that file.', path: od.path };
      if (od) { delete downs[old]; d = downs[o.offer] = { ...od, hub: o.hub, from: o.from }; save(true); log(`files: ${od.name} was offered again; carrying on from what was downloaded`); }
    }
    if (d && d.path && fs.existsSync(d.path)) return { error: 'You already downloaded that file.', path: d.path };
    if (live.has(o.offer)) return { error: 'That file is already downloading.' };
    const dir = opts.downloads();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return { error: `Drift can't write to ${dir}. Pick another folder in Options.` }; }
    if (d && !fs.existsSync(d.part)) d = null;
    if (!d) {
      const final = uniqueName(dir, cleanFileName(o.name) || 'file');
      d = { hub: o.hub, from: o.from, name: path.basename(final), size, root: o.root, piece, part: final + '.drift-part', done: '', path: '', at: Date.now() };
    }
    d.paused = false; d.why = '';       // (starting it again: it may carry on by itself again)
    if (o.direct) d.direct = true;       // (you agreed to connect directly for this file: carrying on later does too)
    const need = size - bitsOf(d).reduce((n, byte) => n + popcount(byte), 0) * piece;
    try {
      const st = fs.statfsSync(dir);
      if (st.bavail * st.bsize < Math.max(0, need) + SPARE) return { error: `There isn't room for it on that drive: it needs ${gb(need + SPARE)} free and has ${gb(st.bavail * st.bsize)}.` };
    } catch { /* couldn't tell: try anyway */ }
    let fh = null;
    try {
      fh = await fsp.open(d.part, fs.existsSync(d.part) ? 'r+' : 'w+');
      if ((await fh.stat()).size !== size) await fh.truncate(size);
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      try { if (!d.done) fs.unlinkSync(d.part); } catch { /* not made */ }
      if (tooBigForDrive(e, size)) return { error: 'That drive can\'t hold files over 4 GB (it uses FAT32). Pick a folder on another drive in Options.' };
      return { error: `Drift couldn't make the file in ${dir}: ${e.message}` };
    }
    downs[o.offer] = d; save(true);
    live.set(o.offer, { fh, hashes: null, cur: null, bits: bitsOf(d) });
    const have = [];
    for (let i = 0; i < pieceCount(size, piece); i++) if (hasBit(live.get(o.offer).bits, i)) have.push(i);
    return { have: have.length, total: pieceCount(size, piece), name: d.name };
  }
  // The list of pieces' hashes, from the sender over the verified connection: it must hash to the offer's root. Resolves the
  // pieces still to fetch.
  function recvHashes(id, list) {
    const d = downs[id], L = live.get(id);
    if (!d || !L) return { error: 'That download isn\'t running.' };
    const n = pieceCount(d.size, d.piece);
    if (!Array.isArray(list) || list.length !== n) return { error: 'The sender\'s list of pieces doesn\'t match the file.' };
    const hashes = list.map((h) => Buffer.from(String(h), 'base64url'));
    if (hashes.some((h) => h.length !== 32) || rootOf(hashes) !== d.root) return { error: 'The sender\'s list of pieces doesn\'t match the file that was offered.' };
    L.hashes = hashes;
    const want = [];
    for (let i = 0; i < n; i++) if (!hasBit(L.bits, i)) want.push(i);
    return { want };
  }
  // Bytes of piece i, at `at` within it (in order). Resolves { piece: 'more' | 'ok' | 'bad', got (bytes of the file checked) }.
  async function recvWrite(id, i, at, bytes) {
    const d = downs[id], L = live.get(id);
    if (!d || !L || !L.hashes) throw new Error('That download isn\'t running.');
    const len = pieceLen(d.size, d.piece, i), b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);       // (a Uint8Array from the window)
    if (!(i >= 0 && i < L.hashes.length) || hasBit(L.bits, i)) return { piece: 'ok', got: doneBytes(d, L) };       // (already have it)
    if (!L.cur || L.cur.i !== i || at === 0) L.cur = { i, h: crypto.createHash('sha256'), got: 0 };
    if (at !== L.cur.got || L.cur.got + b.length > len) { L.cur = null; return { piece: 'bad', got: doneBytes(d, L) }; }
    await L.fh.write(b, 0, b.length, i * d.piece + at);
    L.cur.h.update(b); L.cur.got += b.length;
    if (L.cur.got < len) return { piece: 'more', got: doneBytes(d, L) + L.cur.got };
    const ok = L.cur.h.digest().equals(L.hashes[i]);
    L.cur = null;
    if (ok) { L.bits[i >> 3] |= 1 << (i & 7); d.done = L.bits.toString('base64'); save(); }
    return { piece: ok ? 'ok' : 'bad', got: doneBytes(d, L) };
  }
  const doneBytes = (d, L) => { let n = 0; for (let i = 0; i < pieceCount(d.size, d.piece); i++) if (hasBit(L.bits, i)) n += pieceLen(d.size, d.piece, i); return n; };
  // Every piece checked: the .part file becomes the file. Resolves { path } or { error }.
  async function recvFinish(id) {
    const d = downs[id], L = live.get(id);
    if (!d || !L) return { error: 'That download isn\'t running.' };
    for (let i = 0; i < pieceCount(d.size, d.piece); i++) if (!hasBit(L.bits, i)) return { error: 'Some of it is still missing.' };
    await L.fh.close().catch(() => {}); live.delete(id);
    const final = d.part.replace(/\.drift-part$/, ''), to = fs.existsSync(final) ? uniqueName(path.dirname(final), path.basename(final)) : final;
    try { fs.renameSync(d.part, to); } catch (e) { return { error: `Drift couldn't finish the file: ${e.message}` }; }
    d.path = to; d.name = path.basename(to); d.at = Date.now(); save(true);
    return { path: to };
  }
  // Stop for now: what's checked is kept, to carry on later.
  // (a pause still closing the file is waited for: Windows won't delete a file that's open)
  const closing = new Map();
  async function recvPause(id) {
    const L = live.get(id);
    if (L) { live.delete(id); closing.set(id, L.fh.close().catch(() => {}).finally(() => closing.delete(id))); save(true); }
    await closing.get(id);
  }
  // Throw it away: the .part file goes too.
  async function recvDrop(id) {
    await recvPause(id);
    const d = downs[id];
    if (!d) return;
    if (!d.path) try { fs.unlinkSync(d.part); } catch { /* gone */ }
    delete downs[id]; save(true);
  }
  // Stopped on purpose (Pause, or a check that failed): it waits for Resume instead of carrying on by itself. Kept across restarts.
  function setPaused(id, on, why = '') { const d = downs[id]; if (!d || d.path) return; d.paused = !!on; d.why = on ? String(why || '').slice(0, 200) : ''; save(true); }
  // What the panel shows for each download this PC has: finished, or stopped part of the way (and whether it carries on by itself).
  function downloads() {
    return Object.entries(downs).map(([offer, d]) => {
      const L = live.get(offer), bits = L ? L.bits : bitsOf(d);
      let got = 0; for (let i = 0; i < pieceCount(d.size, d.piece); i++) if (hasBit(bits, i)) got += pieceLen(d.size, d.piece, i);
      return { offer, hub: d.hub, from: d.from, name: d.name, size: d.size, root: d.root, piece: d.piece, got, path: d.path && fs.existsSync(d.path) ? d.path : '',
        partial: !d.path, running: !!L, paused: !!d.paused, why: d.why || '', direct: !!d.direct, risky: RISKY.test(d.name) };
    });
  }
  const download = (id) => downloads().find((x) => x.offer === id) || null;

  return { prepare, has, forget, offerInfo, head, read, recvStart, recvHashes, recvWrite, recvFinish, recvPause, recvDrop, setPaused, downloads, download, offers: () => [...offers.keys()] };
};
function popcount(b) { let n = 0; while (b) { n += b & 1; b >>= 1; } return n; }
function gb(n) { return n >= 1e9 ? (n / 1024 ** 3).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1024 ** 2)) + ' MB'; }
Object.assign(module.exports, { PIECE, RISKY, rootOf, pieceCount, pieceLen, mimeOf });
