// The Surf start page's data (renderer/surf-home.html asks drift://home/api/…): its saved layout, stock quotes, the weather,
// headlines, and stats on this PC and on what has been browsed. Quotes, weather and news are fetched here, in the main process,
// because those sites don't let a page of another origin read them.
//
// GET  /api/settings          the page's layout and choices (null until first saved)
// PUT  /api/settings          saves them (a JSON body)
// GET  /api/quotes?s=A,B      [{ sym, name, price, change, pct, cur, spark: [..] }] (Yahoo Finance's chart data, a day in 5-minute steps)
// GET  /api/weather?q=city    { place, now: { t, code, wind, hum, feels }, days: [{ d, hi, lo, code }], unit } (Open-Meteo)
// GET  /api/news?src=hn       [{ title, url, by, score, n }] (Hacker News)
// GET  /api/stats             { system, browsing } (either null when not shown)
// GET  /api/mode              { hub, canEdit, specs, browsing }: on the hub's browser, what its host lets guests see, and
//                             whether the last click in it was the host's (only they may change its start page)
//
// Only the start page itself may use these. Chromium hands a custom scheme's handler no Origin or Referer, so the page is served
// with a token made fresh each run, and every request has to carry it (x-drift-home): a page of another origin can't read the
// start page to learn it.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const TOKEN = crypto.randomBytes(16).toString('hex');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const DAY = 86400000, KEEP_DAYS = 30;
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// a small cache, so a page opened in every new tab doesn't ask the same site again each time
const cache = new Map();
async function cached(key, ms, get) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ms) return c.v;
  const v = await get();
  cache.set(key, { at: Date.now(), v });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return v;
}
async function getJson(url) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// ---- quotes ----
async function quote(sym) {
  return cached('q:' + sym, 60000, async () => {
    const d = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m&includePrePost=false`);
    const r = d && d.chart && d.chart.result && d.chart.result[0];
    if (!r) return { sym, error: 'unknown' };
    const m = r.meta || {}, closes = ((r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || []).filter((x) => x != null);
    const price = m.regularMarketPrice != null ? m.regularMarketPrice : closes[closes.length - 1];
    const prev = m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose;
    const change = price != null && prev ? price - prev : 0;
    // thin the line to at most 60 points: plenty for a sparkline
    const step = Math.max(1, Math.ceil(closes.length / 60)), spark = closes.filter((_, i) => i % step === 0 || i === closes.length - 1);
    return { sym, name: m.shortName || m.longName || sym, price, change, pct: prev ? (change / prev) * 100 : 0, cur: m.currency || '', prev, spark,
      hi: m.regularMarketDayHigh, lo: m.regularMarketDayLow, state: m.marketState || '' };
  });
}

// ---- weather ----
async function weather(q, unit) {
  const f = unit === 'f';
  return cached(`w:${q}:${unit}`, 10 * 60000, async () => {
    const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(q)}`);
    const p = g && g.results && g.results[0];
    if (!p) return { error: 'place' };
    const w = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&timezone=auto&forecast_days=5`
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + (f ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : ''));
    const c = w.current || {}, d = w.daily || {};
    return {
      place: [p.name, p.admin1 && p.admin1 !== p.name ? p.admin1 : '', p.country_code].filter(Boolean).join(', '), unit: f ? 'F' : 'C', wunit: f ? 'mph' : 'km/h',
      now: { t: c.temperature_2m, feels: c.apparent_temperature, hum: c.relative_humidity_2m, wind: c.wind_speed_10m, code: c.weather_code, day: c.is_day !== 0 },
      days: (d.time || []).map((t, i) => ({ d: t, hi: d.temperature_2m_max[i], lo: d.temperature_2m_min[i], code: d.weather_code[i], rain: (d.precipitation_probability_max || [])[i] })),
    };
  });
}

// ---- news ----
async function news() {
  return cached('news:hn', 5 * 60000, async () => {
    const ids = (await getJson('https://hacker-news.firebaseio.com/v0/topstories.json')).slice(0, 8);
    const items = await Promise.all(ids.map((id) => getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null)));
    return items.filter(Boolean).map((i) => ({ title: i.title, url: i.url || `https://news.ycombinator.com/item?id=${i.id}`, by: i.by, score: i.score, n: i.descendants || 0,
      thread: `https://news.ycombinator.com/item?id=${i.id}`, site: host(i.url || '') }));
  });
}

// ---- this PC ----
// the load since the last sample, taken at most once a second (two asks in a row would otherwise measure nothing)
let lastCpu = null, cpuPct = null;
function cpuLoad() {
  if (lastCpu && Date.now() - lastCpu.at < 1000) return cpuPct;
  const t = os.cpus().reduce((a, c) => { const s = Object.values(c.times).reduce((x, y) => x + y, 0); a.total += s; a.idle += c.times.idle; return a; }, { total: 0, idle: 0, at: Date.now() });
  const prev = lastCpu; lastCpu = t;
  if (prev && t.total > prev.total) cpuPct = Math.round(100 * (1 - (t.idle - prev.idle) / (t.total - prev.total)));
  return cpuPct;
}
setInterval(cpuLoad, 5000).unref();       // keeps a recent sample, so the first reading isn't since boot
cpuLoad();
// The graphics card's name, from Chromium's GPU info: on Windows its renderer string reads
// "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)". Asked once; the card doesn't change.
let gpuName = null;
async function gpu() {
  if (gpuName !== null) return gpuName;
  try {
    const g = await app.getGPUInfo('complete'), r = String((g.auxAttributes && g.auxAttributes.glRenderer) || '');
    const m = /^ANGLE \([^,]+,\s*(.+?)(?:\s*\(0x[0-9a-f]+\))?\s+(?:Direct3D|OpenGL|Vulkan|Metal)/i.exec(r);
    const dev = (g.gpuDevice || []).find((d) => d.active) || (g.gpuDevice || [])[0] || {};
    gpuName = (m ? m[1] : r || dev.deviceString || '').trim();
  } catch { gpuName = ''; }
  return gpuName;
}
// `shared`: friends will see it, so nothing that names the PC (its hostname)
async function system(shared) {
  const { screen } = require('electron');
  const displays = screen.getAllDisplays().map((d) => ({ w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor), hz: Math.round(d.displayFrequency || 0) }));
  const osName = (typeof os.version === 'function' && os.version()) || `${os.type()} ${os.release()}`;
  return { cpu: cpuLoad(), cores: os.cpus().length, cpuName: ((os.cpus()[0] || {}).model || '').replace(/\s+/g, ' ').trim(), gpu: await gpu(),
    mem: { total: os.totalmem(), free: os.freemem() }, os: osName, arch: os.arch(), displays, drift: app.getVersion(),
    uptime: os.uptime(), appUptime: process.uptime(), host: shared ? '' : os.hostname() };
}

// per browser (its partition): where the page's settings and the browsing stats are kept
module.exports = function createHome(part, opts = {}) {
  const tag = String(part || 'web').replace(/[^a-z0-9_-]+/gi, '_');
  const dir = () => app.getPath('userData');
  const settingsFile = () => path.join(dir(), `surf-home-${tag}.json`);
  const statsFile = () => path.join(dir(), `surf-stats-${tag}.json`);

  // stats: { days: { 'YYYY-MM-DD': { visits: { site: n }, secs: { site: s } } } }
  let stats = null, dirty = false;
  const load = () => {
    if (stats) return stats;
    try { stats = JSON.parse(fs.readFileSync(statsFile(), 'utf8')); } catch { stats = null; }
    if (!stats || typeof stats.days !== 'object') stats = { days: {} };
    return stats;
  };
  const today = () => { const s = load(), k = dayKey(); return s.days[k] || (s.days[k] = { visits: {}, secs: {} }); };
  const save = () => {
    if (!dirty) return; dirty = false;
    const s = load(), cut = dayKey(Date.now() - KEEP_DAYS * DAY);
    for (const k of Object.keys(s.days)) if (k < cut) delete s.days[k];
    fs.promises.writeFile(statsFile(), JSON.stringify(s)).catch(() => {});
  };
  setInterval(save, 30000).unref();
  app.on('before-quit', save);

  // a page was gone to (the tab's main frame)
  function visit(u) {
    const h = /^https?:/i.test(String(u || '')) ? host(u) : '';
    if (!h) return;
    const d = today(); d.visits[h] = (d.visits[h] || 0) + 1; dirty = true;
  }
  // every 15 seconds the page in front gets the time, if the browser is showing it
  const TICK = 15;
  if (opts.front) setInterval(() => {
    const u = opts.front(), h = /^https?:/i.test(String(u || '')) ? host(u) : '';
    if (!h) return;
    const d = today(); d.secs[h] = (d.secs[h] || 0) + TICK; dirty = true;
  }, TICK * 1000).unref();

  function browsing() {
    const s = load(), now = Date.now(), week = {}, days = [];
    for (let i = 6; i >= 0; i--) {
      const k = dayKey(now - i * DAY), d = s.days[k] || { visits: {}, secs: {} };
      const secs = Object.values(d.secs).reduce((a, b) => a + b, 0), visits = Object.values(d.visits).reduce((a, b) => a + b, 0);
      days.push({ d: k, secs, visits });
      for (const [h, n] of Object.entries(d.visits)) (week[h] || (week[h] = { site: h, visits: 0, secs: 0 })).visits += n;
      for (const [h, n] of Object.entries(d.secs)) (week[h] || (week[h] = { site: h, visits: 0, secs: 0 })).secs += n;
    }
    const t = s.days[dayKey()] || { visits: {}, secs: {} };
    const top = Object.values(week).sort((a, b) => b.secs - a.secs || b.visits - a.visits).slice(0, 6);
    return { today: { secs: days[6].secs, visits: days[6].visits, sites: Object.keys(t.visits).length }, days, top, tabs: opts.tabs ? opts.tabs() : 0 };
  }

  // the protocol handler hands over a request for drift://home/api/…
  async function api(req) {
    const u = new URL(req.url), what = u.pathname.replace(/^\/api\//, '');
    if (req.headers.get('x-drift-home') !== TOKEN) return json({ error: 'forbidden' }, 403);
    try {
      // The hub's browser (`hub`): everyone in the hub uses its pages, so its start page can only be changed by the host (the last
      // click or key in it came from this PC), and shows the host's specs and browsing only if they've chosen to in Settings.
      const hub = !!opts.private, show = hub && opts.showcase ? opts.showcase() || {} : {};
      const canEdit = !hub || !!(opts.hostTouched && opts.hostTouched());
      if (what === 'mode') return json({ hub, canEdit, specs: !hub || !!show.specs, browsing: !hub || !!show.browsing });
      if (what === 'settings') {
        if (req.method === 'PUT' || req.method === 'POST') {
          if (!canEdit) return json({ error: 'host' }, 403);
          const body = await req.text();
          if (body.length > 200000) return json({ error: 'too big' }, 413);
          JSON.parse(body);       // (only JSON is kept)
          await fs.promises.writeFile(settingsFile(), body);
          return json({ ok: true });
        }
        try { return json(JSON.parse(await fs.promises.readFile(settingsFile(), 'utf8'))); } catch { return json(null); }
      }
      if (what === 'quotes') {
        const syms = String(u.searchParams.get('s') || '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z0-9^.=\-]{1,15}$/.test(x)).slice(0, 12);
        return json(await Promise.all(syms.map((s) => quote(s).catch(() => ({ sym: s, error: 'failed' })))));
      }
      if (what === 'weather') {
        const q = String(u.searchParams.get('q') || '').trim().slice(0, 80);
        if (!q) return json({ error: 'place' });
        return json(await weather(q, u.searchParams.get('unit') === 'f' ? 'f' : 'c'));
      }
      if (what === 'news') return json(await news());
      if (what === 'stats') {
        if (!hub) return json({ system: await system(false), browsing: browsing() });
        // on the hub's page, the host's own Surf browsing (their usual browser), not the hub browser's
        const owner = opts.owner && opts.owner();
        return json({ system: show.specs ? await system(true) : null, browsing: show.browsing && owner ? owner.browsing() : null });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  }
  function forget() { stats = { days: {} }; dirty = true; save(); }
  // the page itself, with the token its requests must carry
  async function page(file) {
    const html = (await fs.promises.readFile(file, 'utf8')).replace('__DRIFT_HOME_TOKEN__', TOKEN);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  return { api, page, visit, forget, browsing };
};
