# Tour dates (set aside)

A third Media scene, left of the song, listing where the artist plays next from Ticketmaster's Discovery API with the
user's own free key (developer.ticketmaster.com, My Apps, Consumer Key). Set aside before it was tried with a real key.

Still in place: main.js `artistShows` and the `artist-shows` IPC, `state.concerts.key` (cleaned like the GIPHY key),
preload `artistShows`. Taken out, kept below: the scene's markup, styles and app.js code, and the Settings card.
To bring it back, the Media scenes would need a fourth position (or the numbers scene to move).

## app.js

```js
  // Where they play next, from Ticketmaster (main.js artistShows), with the user's own key: without one (or with one it turned
  // down) the scene asks for it; with no dates coming up, or Ticketmaster out of reach, there's no arrow to it.
  let mbShowsFor = null, mbShowsNow = null, mbShowsArtist = '';
  const showsWanted = () => !!mbShowsArtist && !!mbShowsNow && (mbShowsNow.error === 'nokey' || mbShowsNow.error === 'badkey' || !!(mbShowsNow.shows && mbShowsNow.shows.length));
  function mbShows(artist) {
    const key = (S.concerts && S.concerts.key) || '', k = artist ? artist + '\n' + key : '';
    if (k === mbShowsFor) return;
    mbShowsFor = k; mbShowsArtist = artist; mbShowsNow = null;
    if (artist && !key) mbShowsNow = { error: 'nokey' };
    else if (artist) api.artistShows(artist).then((r) => { if (mbShowsFor === k) { mbShowsNow = r || null; drawShows(); } }).catch(() => {});
    drawShows();
  }
  const MB_FLAGS = { cancelled: 'Cancelled', postponed: 'Postponed', rescheduled: 'Rescheduled', offsale: 'Not on sale' };
  function drawShows() {
    const r = mbShowsNow || {}, list = mbShowsEl.querySelector('.mbShowsList'), shows = r.shows || [], el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text || '' });
    mbShowsEl.querySelector('.mbShowsName').textContent = r.name || mbShowsArtist;
    const tm = mbShowsEl.querySelector('.mbTm');
    tm.hidden = !r.page;
    if (r.error === 'nokey' || r.error === 'badkey') {
      mbShowsEl.querySelector('.mbShowsSub').textContent = 'Where they play next';
      const box = el('div', 'mbShowsEmpty'), input = el('input');
      Object.assign(input, { type: 'password', placeholder: 'Paste your Consumer Key and press Enter', spellcheck: false, autocomplete: 'off' });
      input.setAttribute('aria-label', 'Ticketmaster API key');
      input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && input.value.trim()) api.patch({ concerts: { key: input.value.trim() } }); else if (e.key === 'Escape') input.blur(); });
      const get = el('a', 'mbWiki', ''); get.href = '#';
      get.append(el('span', '', 'Get a free key'));
      get.addEventListener('click', (e) => { e.preventDefault(); surf('go', { text: 'https://developer.ticketmaster.com/' }); });
      box.append(...(r.error === 'badkey' ? [el('div', 'bad', 'Ticketmaster didn\'t accept that key. Check it is the Consumer Key from My Apps.')] : []),
        el('div', '', 'Tour dates come from Ticketmaster, with your own free key: sign up at developer.ticketmaster.com, open My Apps, and copy the Consumer Key. You can change it later in Settings.'), input, get);
      list.replaceChildren(box);
    } else {
      const n = shows.length;
      mbShowsEl.querySelector('.mbShowsSub').textContent = n ? `${n} upcoming ${n === 1 ? 'show' : 'shows'} · from Ticketmaster` : '';
      const year = new Date().getFullYear();
      list.replaceChildren(...shows.map((s) => {
        const [y, m, d] = s.date.split('-').map(Number), at = new Date(y, m - 1, d), row = el('div', 'mbShow'), day = el('div', 'mbDay'), where = el('div', 'mbWhere');
        day.append(el('small', '', at.toLocaleDateString(undefined, { month: 'short' })), el('b', '', String(d)));
        const when = [at.toLocaleDateString(undefined, { weekday: 'short' }) + (y !== year ? ` ${y}` : ''), s.time && new Date(2000, 0, 1, ...s.time.split(':').map(Number)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' ');
        where.append(el('b', '', [s.city, s.region || s.country].filter(Boolean).join(', ') || s.venue), el('span', '', [s.venue, s.tba ? 'Date to be confirmed' : when].filter(Boolean).join(' · ')));
        let end;
        if (MB_FLAGS[s.status]) end = el('span', 'mbFlag', MB_FLAGS[s.status]);
        else { end = el('a', 'mbWiki'); end.href = '#'; end.append(el('span', '', 'Tickets')); end.addEventListener('click', (e) => { e.preventDefault(); surf('go', { text: s.url }); }); }
        row.append(day, where, end);
        return row;
      }));
    }
    mbPan(mbScene);       // (the arrows: there may be dates now, or none)
  }
  mbShowsEl.querySelector('.mbTm').addEventListener('click', (e) => { e.preventDefault(); if (mbShowsNow && mbShowsNow.page) surf('go', { text: mbShowsNow.page }); });
  $('#tmKey').addEventListener('change', (e) => api.patch({ concerts: { key: e.target.value.trim() } }));
  $('#tmKey').addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
```

## index.html

```html
  <div class="mbShows" aria-hidden="true">
    <div class="mbShowsHead">
      <div class="mbKicker"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9a2 2 0 0 0 0 4v4h16v-4a2 2 0 0 0 0-4V5H4z"/><path d="M14 5v2M14 11v2M14 16v1"/></svg><span>On tour</span></div>
      <div class="mbShowsName"></div><div class="mbShowsSub"></div>
      <a class="mbWiki mbTm" href="#" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg><span>All dates on Ticketmaster</span></a>
    </div>
    <div class="mbShowsList"></div>
  </div>
  <div class="mbBio" aria-hidden="true">
          <div class="optCard">
            <h3>Tour dates</h3>
            <div class="optRow">
              <div class="optText"><b>Ticketmaster API key</b><em>Media's tour dates, left of the song, come from Ticketmaster with your own free key (developer.ticketmaster.com → My Apps → Consumer Key). Only the artist's name is sent.</em></div>
              <input type="password" id="tmKey" placeholder="Paste a key" spellcheck="false" autocomplete="off" aria-label="Ticketmaster API key">
            </div>
          </div>
          <div class="optCard">
```

## style.css

```css
#mediaBack.shows .mbWorld { transform: translateX(100%); }       /* (the tour dates are to the left of the song) */
#mediaBack.shows .mbOrb.a { margin-left: 22vw; }
#mediaBack.shows .mbOrb.b { margin-left: 14vw; }
#mediaBack .mbShows { position: absolute; left: -50%; top: 46%; transform: translate(-50%, -50%) scale(var(--mbScale, 1)); width: min(1080px, 84vw);
body:has(#panel.open.show) #mediaBack .mbShows { top: 25%; --mbScale: .6; }
#mediaBack .mbShowsHead { flex: 0 0 34%; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
#mediaBack .mbShowsHead .mbKicker svg { width: 15px; height: 15px; }
#mediaBack .mbShowsName { font: 700 clamp(30px, 4.4vw, 64px)/1.02 "Segoe UI Variable Display", "Segoe UI", system-ui; letter-spacing: -.035em; text-wrap: balance; overflow-wrap: anywhere; text-shadow: 0 4px 40px rgba(0,0,0,.35); }
#mediaBack .mbShowsSub { font: 15px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui; color: rgba(238,241,246,.6); }
#mediaBack .mbShowsList { flex: 1; min-width: 0; max-height: min(58vh, 560px); overflow-y: auto; padding-right: 6px; display: flex; flex-direction: column; gap: 6px;
body:has(#panel.open.show) #mediaBack .mbShowsList { max-height: 30vh; }
#mediaBack .mbShow { display: grid; grid-template-columns: 58px 1fr auto; align-items: center; gap: 18px; padding: 12px 14px 12px 12px; border-radius: 14px;
#mediaBack .mbShow:hover { background: rgba(255,255,255,.08); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
#mediaBack .mbShow:last-child { margin-bottom: 30px; }       /* (clear of the fade at the foot) */
#mediaBack .mbDay { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 0; border-radius: 10px; background: color-mix(in srgb, var(--mb2, #22c08a) 16%, rgba(0,0,0,.25)); }
#mediaBack .mbDay small { font: 700 10.5px/1 "Segoe UI Variable Text", "Segoe UI", system-ui; letter-spacing: .16em; text-transform: uppercase; color: color-mix(in srgb, var(--mb2, #22c08a) 70%, #fff); }
#mediaBack .mbDay b { font: 700 22px/1 "Segoe UI Variable Display", "Segoe UI", system-ui; font-variant-numeric: tabular-nums; }
#mediaBack .mbWhere { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
#mediaBack .mbWhere b { font: 600 16px/1.25 "Segoe UI Variable Text", "Segoe UI", system-ui; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#mediaBack .mbWhere span { font: 13px/1.3 "Segoe UI Variable Text", "Segoe UI", system-ui; color: rgba(238,241,246,.6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#mediaBack .mbShow .mbWiki { margin: 0; align-self: center; }
#mediaBack .mbFlag { font: 700 10.5px/1 "Segoe UI Variable Text", "Segoe UI", system-ui; letter-spacing: .14em; text-transform: uppercase; padding: 7px 10px; border-radius: 999px; color: #ffb4a8; background: rgba(255,90,70,.14); }
#mediaBack .mbShowsEmpty { font: 15px/1.6 "Segoe UI Variable Text", "Segoe UI", system-ui; color: rgba(238,241,246,.72); max-width: 52ch; display: flex; flex-direction: column; gap: 14px; align-items: flex-start; }
#mediaBack .mbShowsEmpty input { width: min(360px, 100%); padding: 10px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.18); background: rgba(0,0,0,.3); color: #fff; font: 14px "Segoe UI Variable Text", "Segoe UI", system-ui; outline: none; }
#mediaBack .mbShowsEmpty input:focus { border-color: var(--accent); }
#mediaBack .mbShowsEmpty .bad { color: #ffb4a8; }
  #mediaBack .mbShows { flex-direction: column; text-align: center; gap: 20px; }
  #mediaBack .mbShowsHead { flex: none; align-items: center; }
  #mediaBack .mbShowsList { width: 100%; text-align: left; max-height: 44vh; }
```
