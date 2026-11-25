// Reads a song's own tags: its title, artist, album and the cover picture stored in the file. Only the bytes the tags sit in
// are read, never the whole song. Formats: ID3v2 (MP3, AAC, and in front of some FLACs), FLAC, MP4 / M4A, Ogg (Vorbis,
// Opus) and WAV (an "id3 " chunk, or LIST INFO). Anything else, or a file with no picture, returns what it found.
// The result: { title, artist, album, pic: { mime, data: Buffer } | null }. Never throws: a broken tag gives empty fields.
const fs = require('fs');

const MAX_TAG = 32 * 1024 * 1024;       // a tag bigger than this is broken, not a big picture

async function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fd.read(b, 0, len, pos);
  return bytesRead < len ? b.subarray(0, bytesRead) : b;
}

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
function unsync(b) {       // ID3's unsynchronisation: every FF 00 was FF in the original
  const out = Buffer.alloc(b.length); let n = 0;
  for (let i = 0; i < b.length; i++) { out[n++] = b[i]; if (b[i] === 0xff && b[i + 1] === 0x00) i++; }
  return out.subarray(0, n);
}

// ---- ID3v2 ----
function id3Text(b, enc) {       // (enc: 0 Latin-1, 1 UTF-16 with a BOM, 2 UTF-16BE, 3 UTF-8)
  let s;
  if (enc === 0) s = b.toString('latin1');
  else if (enc === 3) s = b.toString('utf8');
  else {
    let le = enc === 1, o = 0;
    if (b[0] === 0xff && b[1] === 0xfe) { le = true; o = 2; } else if (b[0] === 0xfe && b[1] === 0xff) { le = false; o = 2; }
    const u = Buffer.from(b.subarray(o, o + ((b.length - o) & ~1)));
    if (!le) u.swap16();
    s = u.toString('utf16le');
  }
  return s.split('\0').filter(Boolean)[0] || '';       // (v2.4 may hold several values, split by NULs: the first)
}
function id3End(b, o, enc) {       // where a NUL-ended string starting at o ends (one or two NUL bytes, by its encoding)
  if (enc === 1 || enc === 2) { for (let i = o; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i; return b.length; }
  const i = b.indexOf(0, o); return i < 0 ? b.length : i;
}
function parseId3(tag, out) {       // tag: the whole tag, header included
  const ver = tag[3], flags = tag[5];
  let body = tag.subarray(10);
  if (ver < 4 && flags & 0x80) body = unsync(body);
  let o = 0;
  if (flags & 0x40) o = ver === 3 ? 4 + body.readUInt32BE(0) : syncsafe(body, 0);       // an extended header
  const idLen = ver === 2 ? 3 : 4, hLen = ver === 2 ? 6 : 10;
  while (o + hLen <= body.length) {
    const id = body.toString('latin1', o, o + idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;       // padding
    const size = ver === 2 ? body.readUIntBE(o + 3, 3) : ver === 4 ? syncsafe(body, o + 4) : body.readUInt32BE(o + 4);
    const fflags = ver === 2 ? 0 : body.readUInt16BE(o + 8);
    let d = body.subarray(o + hLen, o + hLen + size);
    o += hLen + size;
    if (ver === 4) { if (fflags & 0x0001) d = d.subarray(4); if (fflags & 0x0002) d = unsync(d); }       // a data length first; this frame unsynchronised
    if ((ver === 3 && fflags & 0x00c0) || (ver === 4 && fflags & 0x000c) || !d.length) continue;       // compressed or encrypted: skipped
    const enc = d[0];
    if (id === 'TIT2' || id === 'TT2') out.title = out.title || id3Text(d.subarray(1), enc);
    else if (id === 'TPE1' || id === 'TP1') out.artist = out.artist || id3Text(d.subarray(1), enc);
    else if ((id === 'TPE2' || id === 'TP2') && !out.artist) out.artist2 = out.artist2 || id3Text(d.subarray(1), enc);       // the album artist, if there's no artist
    else if (id === 'TALB' || id === 'TAL') out.album = out.album || id3Text(d.subarray(1), enc);
    else if (id === 'APIC' || id === 'PIC') {
      let p = 1, mime;
      if (id === 'PIC') { const f = d.toString('latin1', 1, 4).toLowerCase(); mime = f === 'png' ? 'image/png' : 'image/jpeg'; p = 4; }
      else { const e = d.indexOf(0, 1); if (e < 0) continue; mime = d.toString('latin1', 1, e).toLowerCase(); p = e + 1; }
      const type = d[p]; p = id3End(d, p + 1, enc) + (enc === 1 || enc === 2 ? 2 : 1);
      if (p < d.length) offerPic(out, type, mime, d.subarray(p));
    }
  }
}
async function id3At(fd, pos, out) {       // an ID3v2 tag at pos, if there is one: returns its length (0 if none)
  const h = await readAt(fd, pos, 10);
  if (h.length < 10 || h.toString('latin1', 0, 3) !== 'ID3' || h[3] < 2 || h[3] > 4) return 0;
  const size = syncsafe(h, 6), len = 10 + size + (h[5] & 0x10 ? 10 : 0);
  if (size > MAX_TAG) return len;
  parseId3(await readAt(fd, pos, 10 + size), out);
  return len;
}

// ---- Vorbis comments (FLAC, Ogg) ----
function vorbisComments(b, o, out) {
  const vlen = b.readUInt32LE(o); o += 4 + vlen;
  const n = b.readUInt32LE(o); o += 4;
  for (let i = 0; i < n && o + 4 <= b.length; i++) {
    const len = b.readUInt32LE(o); o += 4;
    const s = b.toString('utf8', o, o + len); o += len;
    const eq = s.indexOf('='); if (eq < 0) continue;
    const k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1);
    if (k === 'TITLE') out.title = out.title || v;
    else if (k === 'ARTIST') out.artist = out.artist || v;
    else if (k === 'ALBUMARTIST') out.artist2 = out.artist2 || v;
    else if (k === 'ALBUM') out.album = out.album || v;
    else if (k === 'METADATA_BLOCK_PICTURE' && out.picRank < 2) { try { flacPicture(Buffer.from(v, 'base64'), out); } catch { /* a broken picture */ } }
  }
}
function flacPicture(b, out) {       // a FLAC PICTURE block (also what Ogg's METADATA_BLOCK_PICTURE holds, in base64)
  const type = b.readUInt32BE(0), ml = b.readUInt32BE(4), mime = b.toString('latin1', 8, 8 + ml).toLowerCase();
  let o = 8 + ml; const dl = b.readUInt32BE(o); o += 4 + dl + 16;
  const len = b.readUInt32BE(o); o += 4;
  offerPic(out, type, mime, b.subarray(o, o + len));
}
async function parseFlac(fd, pos, out) {
  let last = false;
  for (let i = 0; i < 64 && !last; i++) {
    const h = await readAt(fd, pos, 4); if (h.length < 4) return;
    last = !!(h[0] & 0x80); const type = h[0] & 0x7f, len = h.readUIntBE(1, 3);
    if ((type === 4 || (type === 6 && out.picRank < 2)) && len < MAX_TAG) {
      const b = await readAt(fd, pos + 4, len);
      if (type === 4) vorbisComments(b, 0, out); else flacPicture(b, out);
    }
    pos += 4 + len;
  }
}
async function parseOgg(fd, out) {       // the second packet holds the comments (Vorbis: 03 "vorbis", Opus: "OpusTags"); it may run over many pages
  let pos = 0, packets = 0, cur = [], size = 0;
  for (let page = 0; page < 4000 && packets < 2; page++) {
    const h = await readAt(fd, pos, 27); if (h.length < 27 || h.toString('latin1', 0, 4) !== 'OggS') return;
    const ns = h[26], lace = await readAt(fd, pos + 27, ns);
    let o = pos + 27 + ns; pos = o + lace.reduce((a, x) => a + x, 0);
    let seg = 0;
    for (let i = 0; i < ns; i++) {
      seg += lace[i];
      if (lace[i] === 255 && i < ns - 1) continue;
      if (packets === 1) { cur.push(await readAt(fd, o, seg)); size += seg; if (size > MAX_TAG) return; }
      o += seg;
      if (lace[i] < 255) { packets++; if (packets === 2) break; }       // (a 255 at the page's end: the packet carries on into the next page)
      seg = 0;
    }
  }
  const b = Buffer.concat(cur);
  if (b.toString('latin1', 0, 8) === 'OpusTags') vorbisComments(b, 8, out);
  else if (b[0] === 3 && b.toString('latin1', 1, 7) === 'vorbis') vorbisComments(b, 7, out);
}

// ---- MP4 / M4A ----
async function boxes(fd, start, end, fn) {       // each box in [start, end): fn(type, bodyStart, bodyEnd)
  let p = start;
  while (p + 8 <= end) {
    const h = await readAt(fd, p, 16); if (h.length < 8) return;
    let size = h.readUInt32BE(0), hl = 8; const type = h.toString('latin1', 4, 8);
    if (size === 1) { size = Number(h.readBigUInt64BE(8)); hl = 16; } else if (size === 0) size = end - p;
    if (size < hl) return;
    if (await fn(type, p + hl, Math.min(end, p + size)) === false) return;
    p += size;
  }
}
function mp4Items(b, out) {       // the ilst box's body
  let o = 0;
  while (o + 8 <= b.length) {
    const size = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8);
    if (size < 8) return;
    const item = b.subarray(o + 8, o + size); o += size;
    let p = 0;
    while (p + 16 <= item.length) {       // its "data" boxes
      const ds = item.readUInt32BE(p);
      if (ds < 16) break;
      if (item.toString('latin1', p + 4, p + 8) === 'data') {
        const kind = item.readUInt32BE(p + 8) & 0xffffff, d = item.subarray(p + 16, p + ds);
        const k = type.replace(/^\xa9/, '@');
        if (k === '@nam') out.title = out.title || d.toString('utf8');
        else if (k === '@ART') out.artist = out.artist || d.toString('utf8');
        else if (k === 'aART') out.artist2 = out.artist2 || d.toString('utf8');
        else if (k === '@alb') out.album = out.album || d.toString('utf8');
        else if (k === 'covr') offerPic(out, 3, kind === 14 ? 'image/png' : 'image/jpeg', d);       // (MP4 doesn't say which picture it is: the first is the cover)
      }
      p += ds;
    }
  }
}
async function parseMp4(fd, fileSize, out) {
  await boxes(fd, 0, fileSize, async (t, s, e) => {
    if (t !== 'moov') return true;
    await boxes(fd, s, e, async (t2, s2, e2) => {
      if (t2 !== 'udta') return true;
      await boxes(fd, s2, e2, async (t3, s3, e3) => {
        if (t3 !== 'meta') return true;
        const vf = await readAt(fd, s3, 8);       // a full box (4 bytes of version and flags), except in some old files
        const at = vf.toString('latin1', 4, 8) === 'hdlr' ? s3 : s3 + 4;
        await boxes(fd, at, e3, async (t4, s4, e4) => { if (t4 === 'ilst' && e4 - s4 < MAX_TAG) mp4Items(await readAt(fd, s4, e4 - s4), out); return true; });
        return false;
      });
      return false;
    });
    return false;
  });
}

// ---- WAV ----
async function parseWav(fd, fileSize, out) {
  await boxesLE(fd, 12, fileSize, async (id, s, e) => {
    const lid = id.toLowerCase();
    if (lid === 'id3 ') await id3At(fd, s, out);
    else if (id === 'LIST' && e - s < MAX_TAG) {
      const b = await readAt(fd, s, e - s);
      if (b.toString('latin1', 0, 4) !== 'INFO') return;
      for (let o = 4; o + 8 <= b.length;) {
        const k = b.toString('latin1', o, o + 4), n = b.readUInt32LE(o + 4), v = b.toString('utf8', o + 8, o + 8 + n).replace(/\0+$/, '');
        if (k === 'INAM') out.title = out.title || v; else if (k === 'IART') out.artist = out.artist || v; else if (k === 'IPRD') out.album = out.album || v;
        o += 8 + n + (n & 1);
      }
    }
  });
}
async function boxesLE(fd, p, end, fn) {       // RIFF chunks
  while (p + 8 <= end) {
    const h = await readAt(fd, p, 8); if (h.length < 8) return;
    const id = h.toString('latin1', 0, 4), size = h.readUInt32LE(4);
    await fn(id, p + 8, Math.min(end, p + 8 + size));
    p += 8 + size + (size & 1);
  }
}

// A picture found in the tags is kept if it ranks above the one so far: the front cover (type 3), then "other" (0), then anything.
function offerPic(out, type, mime, d) {
  const rank = type === 3 ? 2 : type === 0 ? 1 : 0;
  if (!d.length || rank <= out.picRank) return;
  out.picRank = rank; out.pic = { mime: fixMime(mime, d), data: Buffer.from(d) };
}
// the picture's real format, from its first bytes (taggers write "image/jpg", "jpeg", or nothing)
function fixMime(mime, d) {
  if (d[0] === 0xff && d[1] === 0xd8) return 'image/jpeg';
  if (d[0] === 0x89 && d[1] === 0x50) return 'image/png';
  if (d[0] === 0x47 && d[1] === 0x49) return 'image/gif';
  if (d.toString('latin1', 0, 4) === 'RIFF' && d.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (d[0] === 0x42 && d[1] === 0x4d) return 'image/bmp';
  return /^image\//.test(mime) ? mime : 'image/jpeg';
}

async function readTags(file) {
  const out = { title: '', artist: '', album: '', pic: null, picRank: -1 };
  let fd;
  try {
    fd = await fs.promises.open(file, 'r');
    const size = (await fd.stat()).size;
    const id3 = await id3At(fd, 0, out);
    const head = await readAt(fd, id3, 12), magic = head.toString('latin1', 0, 4);
    if (magic === 'fLaC') await parseFlac(fd, id3 + 4, out);
    else if (magic === 'OggS') await parseOgg(fd, out);
    else if (magic === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') await parseWav(fd, size, out);
    else if (head.toString('latin1', 4, 8) === 'ftyp') await parseMp4(fd, size, out);
  } catch { /* a broken or unreadable file: whatever was found so far */ } finally { if (fd) await fd.close().catch(() => {}); }
  const clean = (s) => String(s || '').replace(/[\0-\x1f]+/g, ' ').trim().slice(0, 200);
  return { title: clean(out.title), artist: clean(out.artist || out.artist2), album: clean(out.album), pic: out.pic && out.pic.data.length ? out.pic : null };
}

module.exports = { readTags };
