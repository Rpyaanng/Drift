/* Drift — the panel's Share page (docs/plans/broadcast.md §5). The Share tab's button only shows while you're in a
   hub's voice room (connected, with that hub as your active hub), because that's where broadcasts happen. Picking it shows
   the Broadcast scene on that screen (renderer/app.js #bcView: a grid of who's live, to watch); this page opens over it, from
   the grid's Go live or Manage, or by picking the tab again. Here you pick a monitor or an application window and go live,
   and while you're live see how it's going, who's watching, Switch source and Pause. main.js lists the sources and keeps the
   one picked; this page only ever passes back one of the ids it was given.
   Everything a person named (a broadcast's title, a window's name) goes on the page as text, never as HTML. chat.js
   (renderer) draws faces and names and knows which hub is active; window.chatUI is how this reaches it. */
(() => {
  const api = window.drift;
  const $ = (s) => document.querySelector(s);
  const call = (op, ...a) => api.chat(op, ...a).then((r) => r || {}, (e) => ({ error: String(e && e.message || e) }));
  function h(spec, props, ...kids) {       // as in chat.js: text children always as text
    const [tag, ...cls] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (cls.length) el.className = cls.join(' ');
    for (const [k, v] of Object.entries(props || {})) { if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v); }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }
  const ui = () => window.chatUI;
  const toast = (t) => { if (ui()) ui().toast(t); };
  const QNOTE = {
    auto: 'Drift picks, from what you show and how fast your upload is.',
    detail: 'Sharp text and fine detail, up to the full size of what you show, at 15–30 frames a second.',
    motion: 'Up to 60 frames a second, for games and video. Text may be softer.',
  };

  let S = {}, live = null, sources = { screens: [], apps: [] }, picked = '', busy = false, fetched = 0, fetching = false;
  let switching = false;
  const tabBtn = $('.tabs button[data-tab="broadcast"]'), section = $('section[data-tab="broadcast"]');
  const info = () => (ui() ? ui().info() : { hubs: [], me: {} });
  // The hub you broadcast in: your active hub, while you're in its voice room
  const hubNow = () => { const I = info(), id = ui() ? ui().activeHub() : ''; return (I.hubs || []).find((x) => x.id === id && x.status === 'connected' && x.room && x.room.in) || null; };
  const showing = () => section.classList.contains('active') && $('#panel').classList.contains('open');
  const mineNow = () => (info().bc && info().bc.mine) || null;

  function draw() {
    const x = hubNow(), I = info(), mine = mineNow();
    tabBtn.hidden = !x;
    tabBtn.classList.toggle('onair', !!mine);
    $('#bcOff').style.display = x ? 'none' : '';
    $('#bcOn').style.display = x ? '' : 'none';
    if (!x) {       // not connected any more: the tab goes, and whoever was on it is taken back to the Hub tab
      if (window.appUI && window.appUI.tab() === 'broadcast') window.appUI.setTab('hub');
      return;
    }
    if (!mine) switching = false;
    $('#bcMine').style.display = mine && !switching ? '' : 'none';       // (Switch source puts the picker in its place, until Switch or Cancel)
    $('#bcGo').style.display = !mine || switching ? '' : 'none';
    $('#bcGoHead').textContent = switching ? 'Switch to' : 'Pick what to show';
    $('#bcStart').textContent = switching ? 'Switch' : 'Go live';
    $('#bcSwitchCancel').style.display = switching ? '' : 'none';
    $('#bcGo .bcOpts').style.display = switching ? 'none' : '';       // (while live, Sound and pointers are on the live page)
    if (mine) drawMine(x, mine);
    if (!mine || switching) drawGo();
  }

  // ---- You're live: what you're sending, how it's going, who's watching ----
  function drawMine(x, mine) {
    const img = $('#bcMineThumb'), L = live || {}, st = L.stats || null;
    if (L.thumb) { img.src = L.thumb; img.style.display = ''; } else img.style.display = 'none';
    $('#bcMineHead').textContent = L.paused ? 'You\'re live (paused)' : 'You\'re live';
    $('#bcMineTitle').textContent = mine.title;
    $('#bcMineStats').textContent = !st ? 'Starting…' : !st.viewers ? 'Ready: sending as soon as someone watches' :
      [`${st.fps} frames a second`, st.kbps >= 1000 ? `${(st.kbps / 1000).toFixed(1)} Mb/s` : `${st.kbps} kb/s`, st.size, st.hardware === true ? 'graphics card encoding' : st.hardware === false ? 'processor encoding' : ''].filter(Boolean).join(' · ');
    const warn = L.paused ? 'Paused: viewers see "Paused" until you resume.' : st && st.stalled ? 'No picture is being sent: the window may be minimised. Viewers are told.'
      : st && st.slow ? 'The picture nearly stopped (this happens when a window is resized). Press Switch source and pick it again.'
      : st && st.hardware === false && st.viewers > 1 ? 'Your graphics card isn\'t encoding, so the picture is sent smaller to keep it smooth.' : '';
    $('#bcMineWarn').textContent = warn;
    $('#bcMineWarn').style.display = warn ? '' : 'none';
    $('#bcPause').textContent = L.paused ? 'Resume' : 'Pause';
    $('#bcSwitch').disabled = switching;
    const b = (x.bcs || []).find((y) => y.id === mine.id), ids = b ? b.viewers : [], hidden = new Set(L.hidden || []), pointing = new Set(L.ptrs || []);
    $('#bcMineCount').textContent = ids.length ? String(ids.length) : '';
    const box = $('#bcMineWho');
    box.replaceChildren(...(ids.length ? ids.map((id) => {
      const p = mine.viewers && mine.viewers[id], state = (L.peers || {})[id];
      const lock = p && p.verdict === 'verified' ? h('span.lock.ok', { title: 'End-to-end encrypted, and checked' }, '🔒') : null;
      const what = p && (p.refused || p.verdict === 'mismatch') ? 'couldn\'t be verified' : state === 'connected' ? (pointing.has(id) ? 'watching · pointing' : 'watching') : 'connecting…';
      return h('div.bcViewer', { 'data-id': id }, ui().face(x.id, id, '.small'), h('span', {}, lock, ui().nameOf(x.id, id), h('em', {}, ' · ' + what)),
        h('button.btn.ghost', { title: hidden.has(id) ? 'Show their pointer on your screen again' : 'Don\'t show their pointer on your screen', onclick: () => call('bcHide', id, !hidden.has(id)) }, hidden.has(id) ? 'Show pointer' : 'Hide pointer'));
    }) : [h('p.bcEmpty', {}, 'Nobody is watching yet')]));
    for (const el of document.querySelectorAll('#bcPtrsLive button')) el.classList.toggle('active', el.dataset.v === ((S.broadcast || {}).pointers !== false ? 'show' : 'hide'));
    const snd = L.sound || 'off';
    for (const el of document.querySelectorAll('#bcSoundLive button')) el.classList.toggle('active', el.dataset.v === ((S.broadcast || {}).sound ? 'on' : 'off'));
    $('#bcSoundLiveNote').textContent = snd === 'on' ? `Friends hear ${mine.kind === 'window' ? 'this application' : 'everything your PC plays, except Drift'}.`
      : snd === 'starting' ? 'Starting…' : snd === 'failed' ? 'Drift couldn\'t capture the sound, so friends see the picture only.' : 'Friends see the picture only.';
    $('#bcSoundLiveNote').classList.toggle('warn', snd === 'failed');
  }
  async function stop() {
    switching = false;
    const r = await call('bcStop');
    if (r.error) toast(r.error);
  }
  $('#bcStop').addEventListener('click', stop);
  $('#bcPause').addEventListener('click', async () => { const r = await call('bcPause', !(live && live.paused)); if (r.error) toast(r.error); });
  $('#bcSwitch').addEventListener('click', () => { switching = true; picked = ''; srcKey = ''; fetched = 0; draw(); refreshSources(); });
  $('#bcSwitchCancel').addEventListener('click', () => { switching = false; draw(); });
  $('#bcSoundLive').addEventListener('click', (e) => { const v = e.target.closest('button'); if (v) api.patch({ broadcast: { sound: v.dataset.v === 'on' } }); });
  $('#bcPtrsLive').addEventListener('click', (e) => { const v = e.target.closest('button'); if (v) api.patch({ broadcast: { pointers: v.dataset.v === 'show' } }); });

  // ---- Go live (or Switch to): what to show, and how ----
  let srcKey = '';
  function drawGo() {
    const all = [...sources.screens, ...sources.apps];
    if (picked && !all.some((s) => s.id === picked)) picked = '';       // that window closed
    const key = JSON.stringify([picked, all.map((s) => [s.id, s.title, s.thumb.length, s.drift])]);
    if (key !== srcKey) {
      srcKey = key;
      const tile = (s) => h('button.bcSrc' + (s.id === picked ? '.on' : ''), { 'data-src': s.id, title: s.title, onclick: () => { picked = s.id; drawGo(); } },
        h('img.thumb', { src: s.thumb, alt: '' }),
        h('span', {}, s.icon ? h('img', { src: s.icon, alt: '' }) : null, h('b', {}, s.title), s.drift ? h('em', { title: 'Broadcasting this monitor shows your Drift scene' }, 'Drift is here') : null));
      $('#bcScreens').replaceChildren(...(sources.screens.length ? sources.screens.map(tile) : [h('p.bcEmpty', {}, fetched ? 'No monitors found.' : 'Looking…')]));
      $('#bcApps').replaceChildren(...(sources.apps.length ? sources.apps.map(tile) : [h('p.bcEmpty', {}, fetched ? 'No other application windows are open (minimised ones can\'t be shown).' : 'Looking…')]));
    }
    const p = all.find((s) => s.id === picked);
    $('#bcPicked').textContent = p ? `Showing: ${p.title}` : 'Pick a screen or an application.';
    $('#bcPicked').classList.toggle('none', !p);
    $('#bcPicked').title = p ? p.title : '';
    $('#bcSel').classList.toggle('on', !!p);
    if (p && $('#bcSelThumb').getAttribute('src') !== p.thumb) $('#bcSelThumb').src = p.thumb;
    $('#bcStart').disabled = !p || busy;
    drawOpts();
  }
  function drawOpts() {
    const b = S.broadcast || { quality: 'auto', pointers: true, sound: false };
    for (const el of document.querySelectorAll('#bcQuality button')) el.classList.toggle('active', el.dataset.v === b.quality);
    for (const el of document.querySelectorAll('#bcPtrsGo button')) el.classList.toggle('active', el.dataset.v === (b.pointers ? 'show' : 'hide'));
    for (const el of document.querySelectorAll('#bcSound button')) el.classList.toggle('active', el.dataset.v === (b.sound ? 'on' : 'off'));
    const p = [...sources.screens, ...sources.apps].find((s) => s.id === picked), app = p ? sources.apps.includes(p) : null;
    $('#bcSoundNote').textContent = !b.sound ? 'Friends see the picture only.'
      : app === true ? 'Friends hear only this application.' : app === false ? 'Friends hear everything your PC plays, except Drift (so nobody hears the voice room twice).'
        : 'For an application, only its sound. For a whole screen, everything your PC plays except Drift.';
    $('#bcQNote').textContent = QNOTE[b.quality] || QNOTE.auto;
  }
  $('#bcQuality').addEventListener('click', (e) => { const v = e.target.closest('button'); if (v) api.patch({ broadcast: { quality: v.dataset.v } }); });
  $('#bcSound').addEventListener('click', (e) => { const v = e.target.closest('button'); if (v) api.patch({ broadcast: { sound: v.dataset.v === 'on' } }); });
  $('#bcPtrsGo').addEventListener('click', (e) => { const v = e.target.closest('button'); if (v) api.patch({ broadcast: { pointers: v.dataset.v === 'show' } }); });
  $('#bcStart').addEventListener('click', async () => {
    const p = [...sources.screens, ...sources.apps].find((s) => s.id === picked);
    if (!p || busy) return;
    busy = true; drawGo();
    const r = await call(switching ? 'bcSwitch' : 'bcStart', p.id);
    busy = false;
    if (r.error) { toast(r.error); drawGo(); return; }
    picked = ''; switching = false;
    draw();
  });

  // Thumbnails are fetched only while the tab is open and the picker shows, every few seconds (nothing is captured).
  async function refreshSources() {
    if (fetching) return;
    fetching = true;
    const r = await call('bcSources');
    fetching = false; fetched = Date.now();
    if (!r.error) sources = { screens: r.screens || [], apps: r.apps || [] };
    if (!mineNow() || switching) drawGo();
  }
  let wasShowing = false;
  setInterval(() => {
    const on = showing() && !!hubNow() && (!mineNow() || switching);
    if (on && (!wasShowing || Date.now() - fetched > 4000)) refreshSources();
    wasShowing = on;
  }, 500);

  api.on('chat', (c) => {
    if (c.type === 'info') { if (c.info && 'bcLive' in c.info) live = c.info.bcLive; draw(); }
    else if (c.type === 'bclive') { live = c.live; if (mineNow()) drawMine(hubNow() || { bcs: [] }, mineNow()); tabBtn.classList.toggle('onair', !!mineNow()); }
  });
  api.on('state', (s) => {
    const k = (x) => JSON.stringify([x.broadcast, x.voice && x.voice.pin]), was = k(S);
    S = s;
    if (k(s) !== was) draw();
  });
  call('bcLive').then((r) => { live = r && Object.keys(r).length ? r : null; draw(); });
  draw();
  window.broadcastUI = { sources: () => sources, picked: () => picked, refresh: refreshSources, live: () => live,       // (main.js's checks)
    hub: () => (hubNow() || {}).id || '' };       // (app.js: the hub whose broadcasts the Broadcast scene shows)
})();
