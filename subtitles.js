// Drift — subtitles: reading subtitle files, guessing what a video is from its file name, and looking captions up online.
// Plain Node, no Electron, so it can be tested on its own.
const crypto = require('crypto');

// ---- languages -----------------------------------------------------------------------------------
// [two-letter code, name, other spellings: ISO 639-2 codes, OpenSubtitles codes, English names]
const LANGS = [
  ['en', 'English', 'eng english'], ['es', 'Spanish', 'spa spl spanish espanol castellano'], ['fr', 'French', 'fra fre french francais'],
  ['de', 'German', 'deu ger german deutsch'], ['it', 'Italian', 'ita italian italiano'], ['pt', 'Portuguese', 'por pob pt-br ptbr portuguese brazilian'],
  ['nl', 'Dutch', 'nld dut dutch'], ['ru', 'Russian', 'rus russian'], ['ja', 'Japanese', 'jpn japanese'], ['ko', 'Korean', 'kor korean'],
  ['zh', 'Chinese', 'zho chi zht zhe chs cht chinese'], ['ar', 'Arabic', 'ara arabic'], ['hi', 'Hindi', 'hin hindi'], ['tr', 'Turkish', 'tur turkish'],
  ['pl', 'Polish', 'pol polish'], ['sv', 'Swedish', 'swe swedish'], ['da', 'Danish', 'dan danish'], ['no', 'Norwegian', 'nor nob nno norwegian'],
  ['fi', 'Finnish', 'fin finnish'], ['cs', 'Czech', 'ces cze czech'], ['el', 'Greek', 'ell gre greek'], ['he', 'Hebrew', 'heb hebrew'],
  ['hu', 'Hungarian', 'hun hungarian'], ['ro', 'Romanian', 'ron rum romanian'], ['id', 'Indonesian', 'ind indonesian'], ['vi', 'Vietnamese', 'vie vietnamese'],
  ['th', 'Thai', 'tha thai'], ['uk', 'Ukrainian', 'ukr ukrainian'], ['bg', 'Bulgarian', 'bul bulgarian'], ['hr', 'Croatian', 'hrv croatian'],
  ['sr', 'Serbian', 'srp scc serbian'], ['sk', 'Slovak', 'slk slo slovak'], ['sl', 'Slovenian', 'slv slovenian'], ['et', 'Estonian', 'est estonian'],
  ['lv', 'Latvian', 'lav latvian'], ['lt', 'Lithuanian', 'lit lithuanian'], ['ms', 'Malay', 'msa may malay'], ['fa', 'Persian', 'fas per persian farsi'],
  ['is', 'Icelandic', 'isl ice icelandic'], ['mk', 'Macedonian', 'mkd mac macedonian'], ['mn', 'Mongolian', 'mon mongolian'], ['ca', 'Catalan', 'cat catalan'],
  ['bn', 'Bengali', 'ben bengali'], ['ta', 'Tamil', 'tam tamil'], ['te', 'Telugu', 'tel telugu'], ['ur', 'Urdu', 'urd urdu'], ['sq', 'Albanian', 'sqi alb albanian'],
  ['tl', 'Filipino', 'fil tgl filipino tagalog'],
];
const LANG_BY = new Map();
for (const [code, name, more] of LANGS) for (const k of [code, ...more.split(' ')]) LANG_BY.set(k, { code, name });
const langOf = (s) => LANG_BY.get(String(s || '').toLowerCase().trim()) || null;
const langName = (code) => (langOf(code) || { name: '' }).name;

// ---- reading subtitle files ------------------------------------------------------------------------
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not UTF-8: an older Windows-encoded file */ }
  return new TextDecoder('windows-1252').decode(buf);
}
// Cue text becomes safe HTML: everything is escaped, then only italic / bold / underline are allowed back in.
function cleanText(raw) {
  let top = false;
  let t = String(raw).replace(/\{\\[^}]*\}/g, (m) => { if (/\\an?[789]\b/.test(m) || /\\a(5|6|7)\b/.test(m)) top = true; return ''; });
  t = t.replace(/\\N/gi, '\n').replace(/\\h/g, ' ');
  t = t.replace(/<\/?(?:font|c|v|lang|ruby|rt|span)\b[^>]*>/gi, '').replace(/<\d+:\d+(?::\d+)?[.,]\d+>/g, '');
  t = t.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_m, e) => ({ amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '', rlm: '' }[e]));
  t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&lt;(\/?)([ibu])&gt;/gi, (_m, s, g) => `<${s}${g.toLowerCase()}>`);
  t = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');
  for (const g of ['i', 'b', 'u']) {      // close anything left open so one cue can't restyle the next
    const open = (t.match(new RegExp(`<${g}>`, 'g')) || []).length, close = (t.match(new RegExp(`</${g}>`, 'g')) || []).length;
    if (open > close) t += `</${g}>`.repeat(open - close); else if (close > open) t = `<${g}>`.repeat(close - open) + t;
  }
  return { t, top };
}
const TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})(.*)$/;
const secs = (h, m, s, f) => (+h || 0) * 3600 + +m * 60 + +s + +String(f).padEnd(3, '0') / 1000;
function parseSrtVtt(text) {
  const cues = [], lines = text.split(/\r?\n/);
  let cur = null, skip = false;
  const flush = () => { if (cur && cur.lines.length) { const c = cleanText(cur.lines.join('\n')); if (c.t) cues.push({ s: cur.s, e: cur.e, t: c.t, top: c.top || cur.top }); } cur = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); skip = false; continue; }
    if (skip) continue;
    const m = !cur && TIME.exec(line.trim());
    if (m) {
      const pos = /\bline:(-?[\d.]+)(%?)/.exec(m[9] || '');
      cur = { s: secs(m[1], m[2], m[3], m[4]), e: secs(m[5], m[6], m[7], m[8]), lines: [], top: !!pos && (pos[2] ? +pos[1] < 50 : +pos[1] >= 0 && +pos[1] < 6) };
    } else if (cur) cur.lines.push(line);
    else if (/^(NOTE|STYLE|REGION)\b/.test(line)) skip = true;
  }
  flush();
  return cues;
}
function parseAss(text) {
  const cues = [];
  let fmt = null, inEvents = false;
  const t = (s) => { const m = /(\d+):(\d+):(\d+)[.,](\d+)/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0').slice(0, 3) / 1000 : NaN; };
  for (const line of text.split(/\r?\n/)) {
    if (/^\[.*\]\s*$/.test(line)) { inEvents = /^\[events\]/i.test(line); continue; }
    if (!inEvents) continue;
    if (/^format:/i.test(line)) { fmt = line.slice(7).split(',').map((x) => x.trim().toLowerCase()); continue; }
    if (!/^dialogue:/i.test(line) || !fmt) continue;
    const parts = line.slice(9).split(','), n = fmt.length;
    const f = parts.slice(0, n - 1); f.push(parts.slice(n - 1).join(','));
    const get = (k) => f[fmt.indexOf(k)] || '';
    const s = t(get('start')), e = t(get('end')), raw = get('text');
    if (!(e > s) || /\{[^}]*\\p[1-9]/.test(raw)) continue;      // skip vector drawings
    const c = cleanText(raw);
    if (c.t) cues.push({ s, e, t: c.t, top: c.top });
  }
  return cues;
}
function parseSubtitle(buf, ext) {
  const text = Buffer.isBuffer(buf) ? decodeText(buf) : String(buf);
  const kind = String(ext || '').toLowerCase().replace(/^\./, '');
  let cues = kind === 'ass' || kind === 'ssa' || /^\[script info\]/im.test(text.slice(0, 400)) ? parseAss(text) : parseSrtVtt(text);
  cues = cues.filter((c) => c.e > c.s && isFinite(c.s)).sort((a, b) => a.s - b.s);
  const out = [];
  for (const c of cues) {       // the same line repeated back to back (common in converted files) becomes one cue
    const p = out[out.length - 1];
    if (p && p.t === c.t && p.top === c.top && c.s <= p.e + 0.05) p.e = Math.max(p.e, c.e); else out.push(c);
  }
  return out;
}

// ---- what is this video? ---------------------------------------------------------------------------
const CUT = /^(480p|540p|576p|720p|1080p|1080i|2160p|4k|uhd|hdr10|webrip|web-dl|webdl|bluray|blu-ray|brrip|bdrip|dvdrip|hdtv|hdrip|remux|x264|x265|h264|h265|hevc|xvid|10bit|8bit)$/i;
const JUNK = /^(480p|540p|576p|720p|1080p|1080i|2160p|4k|uhd|hdr|hdr10|dv|web|webrip|web-dl|webdl|dl|bluray|blu-ray|brrip|bdrip|dvdrip|hdtv|hdrip|remux|x264|x265|h264|h265|264|265|hevc|avc|av1|xvid|aac|ac3|eac3|ddp\d*|dd\d*|dts|atmos|truehd|10bit|8bit|proper|repack|extended|unrated|remastered|internal|limited|multi|dual|amzn|nf|dsnp|hmax|max|atvp|hulu|complete|\d)$/i;
function parseName(file) {
  let n = String(file).replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,4}$/i, '');
  n = n.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ').replace(/^www\.[^\s]+\s+-\s+/i, '');
  let season = 0, episode = 0, cut = n.length;
  const se = /\bs(\d{1,2})[ ._-]*e(\d{1,3})/i.exec(n) || /\b(\d{1,2})x(\d{2,3})\b/i.exec(n) || /\bseason[ ._-]*(\d{1,2})[ ._-]*episode[ ._-]*(\d{1,3})\b/i.exec(n);
  if (se) { season = +se[1]; episode = +se[2]; cut = se.index; }
  let words = n.slice(0, cut).split(/[._\s]+|(?<=\w)-(?=\w)/).map((w) => w.replace(/[()]/g, '')).filter(Boolean);
  const junkAt = words.findIndex((w, i) => i > 0 && CUT.test(w));
  if (junkAt > 0) words = words.slice(0, junkAt);
  let year = 0;
  for (let i = words.length - 1; i > 0; i--) if (/^(19|20)\d\d$/.test(words[i])) { year = +words[i]; words = words.slice(0, i); break; }   // the last year in the name is the release year
  const title = words.join(' ').replace(/\s+/g, ' ').replace(/^[\s-]+|[\s-]+$/g, '');
  return { title: title || n.trim(), year, season, episode };
}
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
// How well a subtitle's release name matches the video file: the same release group and source usually means the same timing.
function matchScore(videoName, releaseName, title) {
  const skip = new Set(tokens(title)), v = tokens(String(videoName).replace(/\.[a-z0-9]{2,4}$/i, '')).filter((w) => !skip.has(w) && !/^s\d+e\d+$/.test(w));
  const r = new Set(tokens(releaseName));
  let score = 0;
  for (const w of v) if (r.has(w)) score += JUNK.test(w) ? 1 : 3;     // a shared release-group name counts for more than "1080p"
  return score;
}

// ---- online lookup ---------------------------------------------------------------------------------
// Titles come from Cinemeta and captions from the public OpenSubtitles mirror that Stremio uses; neither needs an account.
const META = 'https://v3-cinemeta.strem.io', SUBS = 'https://opensubtitles-v3.strem.io';
const okHost = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && (x.hostname === 'strem.io' || x.hostname.endsWith('.strem.io')); } catch { return false; } };
async function getJson(fetchFn, url) {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function searchTitles(fetchFn, text, type) {
  const j = await getJson(fetchFn, `${META}/catalog/${type}/top/search=${encodeURIComponent(text)}.json`);
  return (j.metas || []).filter((m) => /^tt\d+$/.test(m.id || '')).slice(0, 8)
    .map((m) => ({ id: m.id, type, name: String(m.name || ''), year: parseInt(m.releaseInfo, 10) || 0 }));
}
function pickTitle(list, text, year) {
  const want = norm(text);
  const rank = (m) => (norm(m.name) === want ? 4 : norm(m.name).startsWith(want) ? 1 : 0) + (year && m.year === year ? 3 : year && Math.abs(m.year - year) === 1 ? 1 : 0);
  return list.map((m, i) => ({ m, r: rank(m) - i * 0.01 })).sort((a, b) => b.r - a.r).map((x) => x.m)[0] || null;
}
async function listSubs(fetchFn, type, id, season, episode) {
  const key = type === 'series' ? `${id}:${season || 1}:${episode || 1}` : id;
  const j = await getJson(fetchFn, `${SUBS}/subtitles/${type}/${key}.json`);
  return (j.subtitles || []).filter((s) => s && okHost(s.url)).map((s) => ({
    id: String(s.id), url: s.url, lang: (langOf(s.lang) || { code: String(s.lang || '') }).code, langName: langName(s.lang) || String(s.lang || '').toUpperCase(),
    name: String(s.movieReleaseName || s.subtitleFileName || 'Subtitle ' + s.id).replace(/\.(srt|ass|ssa|vtt|sub)$/i, ''),
  }));
}
// q: { text, season, episode, year, lang ('' = any), id, type (to use a specific title), videoName }
async function searchOnline(fetchFn, q) {
  let text = String(q.text || '').trim(), titles = [], picked = null;
  if (!text && !q.id) return { titles: [], picked: null, subs: [] };
  const direct = /^tt\d{5,}$/i.exec(text);
  const first = q.season && q.episode ? 'series' : 'movie', second = first === 'series' ? 'movie' : 'series';
  if (direct) picked = { id: text.toLowerCase(), type: first, name: text, year: 0 };
  else {
    titles = await searchTitles(fetchFn, text, first);
    if (!titles.length) titles = await searchTitles(fetchFn, text, second);
    picked = (q.id && (titles.find((t) => t.id === q.id) || { id: q.id, type: q.type || first, name: text, year: 0 })) || pickTitle(titles, text, q.year);
  }
  if (!picked) return { titles, picked: null, subs: [] };
  let subs = await listSubs(fetchFn, picked.type, picked.id, q.season, q.episode);
  const langs = new Set(subs.map((s) => s.lang));
  if (q.lang) subs = subs.filter((s) => s.lang === q.lang);
  for (const s of subs) s.score = matchScore(q.videoName || '', s.name, picked.name);
  subs.sort((a, b) => b.score - a.score);
  return { titles, picked, subs: subs.slice(0, 60), langs: [...langs] };
}
async function downloadSub(fetchFn, url) {
  if (!okHost(url)) throw new Error('That address is not a subtitle server Drift knows.');
  const r = await fetchFn(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) throw new Error('That subtitle file is too large.');
  if (!parseSubtitle(buf, 'srt').length) throw new Error('That file had no readable subtitles in it.');
  return buf;
}
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

module.exports = { LANGS, langOf, langName, decodeText, cleanText, parseSubtitle, parseName, matchScore, searchOnline, downloadSub, okHost, hash };
