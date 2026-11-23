/* Drift — the panel's Broadcast tab (docs/plans/broadcast.md §5). Its button only shows while you're in a hub's voice
   room (connected, with that hub as your active hub), because that's where broadcasts happen. It lists who in that hub is
   live: Watch picks a monitor, and that monitor turns into the full-screen Broadcast view (renderer/app.js #bcView).
   Your cursor is shared with a broadcast only once you turn "Share my cursor" on for it. It also lets you pick a monitor
   or an application window and go live, and while you're live shows how it's going, who's watching, Switch source and
   Pause. main.js lists the sources and keeps the one picked; this page only ever passes back one of the ids it was given.
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
  const MAX_VIEWERS = 7;
  const QNOTE = {
    auto: 'Drift picks, from what you show and how fast your upload is.',
    detail: 'Sharp text and fine detail, up to the full size of what you show, at 15–30 frames a second.',
    motion: 'Up to 60 frames a second, for games and video. Text may be softer.',
  };

  let S = {}, live = null, sources = { screens: [], apps: [] }, picked = '', busy = false, fetched = 0, fetching = false;
  let switching = false, pickFor = '', screens = [];       // pickFor: the broadcast whose Watch is asking which monitor
  const tabBtn = $('.tabs button[data-tab="broadcast"]'), section = $('section[data-tab="broadcast"]');
  const info = () => (ui() ? ui().info() : { hubs: [], me: {} });
  // The hub you broadcast in: your active hub, while you're in its voice room
  const hubNow = () => { const I = info(), id = ui() ? ui().activeHub() : ''; return (I.hubs || []).find((x) => x.id === id && x.status === 'connected' && x.room && x.room.in) || null; };
  const showing = () => section.classList.contains('active') && $('#panel').classList.contains('open');
  const mineNow = () => (info().bc && info().bc.mine) || null;
  const screenName = (key) => { const s = screens.find((x) => x.key === key); return !s ? 'a monitor' : key === (window.appUI && window.appUI.key) ? 'this screen' : s.label; };

  function draw() {
    const x = hubNow(), I = info(), mine = mineNow();
    tabBtn.hidden = !x;
    tabBtn.classList.toggle('onair', !!mine);
    $('#bcOff').style.display = x ? 'none' : '';
    $('#bcOn').style.display = x ? '' : 'none';
    if (!x) {       // not connected any more: the tab goes, and whoever was on it is taken back to Together
      if (window.appUI && window.appUI.tab() === 'broadcast') window.appUI.setTab('share');
      return;
    }
    if (!mine) switching = false;
    $('#bcHub').textContent = '· ' + x.name;
    drawLive(x, I, mine);
    $('#bcMine').style.display = mine ? '' : 'none';
    $('#bcGo').style.display = !mine || switching ? '' : 'none';
    $('#bcGoHead').textContent = switching ? 'Switch to' : 'Go live';
    $('#bcStart').textContent = switching ? 'Switch' : 'Go live';
    $('#bcSwitchCancel').style.display = switching ? '' : 'none';
    for (const el of section.querySelectorAll('#bcGo .optRow')) el.style.display = switching ? 'none' : '';
    if (mine) drawMine(x, mine);
    if (!mine || switching) drawGo();
  }

  // ---- Live now: a card for each broadcast in the hub ----
  function drawLive(x, I, mine) {
    const box = $('#bcLive'), list = x.bcs || [], v = S.bcView;
    box.replaceChildren();
    if (!list.length) { box.append(h('p.bcEmpty', {}, 'Nobody is broadcasting right now.')); return; }
    for (const b of list) {
      const me = b.from === I.me.id, watching = !!(v && v.bc === b.id), w = ((I.bc && I.bc.watching) || []).find((y) => y.id === b.id);
      const who = me ? 'You' : ui().nameOf(x.id, b.from), n = b.viewers.length, full = n >= MAX_VIEWERS;
      const bad = w && (w.refused || w.verdict === 'mismatch' || w.told);
      const sub = [b.kind === 'window' ? 'An application' : 'A whole screen', b.audio ? 'with sound' : 'no sound',
        n ? `${n} watching${full ? ' (full)' : ''}` : 'nobody watching yet'];
      if (watching) sub.push(`on ${screenName(v.key)}`);
      const lock = watching && v.verdict === 'verified' ? h('span.lock.ok', { title: `End-to-end encrypted, and checked that it's really from ${who}` }, '🔒') : null;
      let btns;
      if (me) btns = [h('button.btn.ghost', { onclick: stop }, 'Stop broadcasting')];
      else if (watching) btns = [
        h('button.btn.ghost' + (v.share ? '.on' : ''), { 'aria-pressed': v.share ? 'true' : 'false', title: v.share ? `${who} and everyone watching see your cursor over the picture. Click to stop` : `Let ${who} and everyone watching see where your cursor is over the picture. It's only a picture: you can't click or type anything on their PC`, onclick: () => call('bcCursor', b.id, !v.share) }, v.share ? 'Sharing my cursor' : 'Share my cursor'),
        h('button.btn.ghost', { onclick: () => unwatch(b.id) }, 'Stop watching')];
      else if (full) btns = [h('button.btn', { disabled: true, title: `${MAX_VIEWERS} people are already watching` }, 'Full')];
      else btns = [h('button.btn', { onclick: () => askWhere(x, b) }, v ? 'Watch instead' : 'Watch')];
      const hostStop = x.host && !me ? h('button.btn.ghost', { title: 'As the host, you can stop anyone\'s broadcast', onclick: () => hostStop(x, b, who) }, 'Stop it') : null;
      const card = h('div.bcCard' + (me ? '.mine' : watching ? '.on' : ''), { 'data-bc': b.id },
        ui().face(x.id, b.from, '.small'),
        h('div', {},
          h('b', { title: 'What they called it. The hub passes the name on and can\'t vouch for it.' }, lock, who, h('span', {}, ' · ' + (b.title || (b.kind === 'window' ? 'A window' : 'A screen')))),
          h('span', {}, sub.join(' · ')),
          bad ? h('p.warn', {}, `Couldn't check that this broadcast is really from ${who}. The hub may be interfering.`) : null),
        hostStop, ...btns);
      box.append(card);
      if (pickFor === b.id && !me && !watching) {       // which monitor to watch on
        box.append(h('div.bcWhere', { 'data-for': b.id }, h('span', {}, 'Watch on:'),
          ...screens.map((s) => h('button.btn' + (s.key === (window.appUI && window.appUI.key) ? '.primary' : ''), { 'data-key': s.key, onclick: () => watch(x, b, s) }, s.key === (window.appUI && window.appUI.key) ? `This screen (${s.label})` : s.label)),
          h('button.btn.ghost', { onclick: () => { pickFor = ''; draw(); } }, 'Cancel')));
      }
    }
  }
  async function askWhere(x, b) {
    const r = await call('bcScreens');
    screens = r.screens || [];
    if (screens.length <= 1) { watch(x, b, screens[0] || { key: window.appUI && window.appUI.key }); return; }
    pickFor = b.id; draw();
  }
  async function watch(x, b, s) {
    pickFor = '';
    if (s.video && !confirm(`A video is playing on ${s.label || 'that monitor'}. Watch ${ui().nameOf(x.id, b.from)}'s broadcast on it instead?`)) { draw(); return; }       // one thing on a screen at a time
    const r = await call('bcWatch', x.id, b.id, s.key);
    if (r.error) toast(r.error);
    draw();
  }
  async function unwatch(id) { const r = await call('bcUnwatch', id); if (r.error) toast(r.error); }
  async function hostStop(x, b, who) {
    if (!confirm(`Stop ${who}'s broadcast for everyone?`)) return;
    const r = await call('bcHostStop', x.id, b.id);
    if (r.error) toast(r.error);
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
    const k = (x) => JSON.stringify([x.broadcast, x.voice && x.voice.pin, x.bcView]), was = k(S);
    S = s;
    if (k(s) !== was) { if (s.bcView && !screens.some((y) => y.key === s.bcView.key)) call('bcScreens').then((r) => { screens = r.screens || []; draw(); }); draw(); }
  });
  call('bcLive').then((r) => { live = r && Object.keys(r).length ? r : null; draw(); });
  draw();
  window.broadcastUI = { sources: () => sources, picked: () => picked, refresh: refreshSources, live: () => live };       // (main.js's checks)
})();
