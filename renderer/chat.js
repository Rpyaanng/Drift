/* Drift — the panel's Hub tab: hubs, their channels and messages, and who in them is sharing something to watch
   (watch together itself is app.js's #sh… controls; this draws the Join cards). Everything a person typed is put on the page as text
   (textContent), never as HTML: a small set of Markdown (bold, italic, code, spoilers, quotes, links) is turned into
   elements here, one by one. chat.js in the main process does the talking; this only asks it, through window.drift.chat. */
(() => {
  const api = window.drift;
  const $ = (s) => document.querySelector(s);
  const call = (op, ...a) => api.chat(op, ...a).then((r) => r || {}, (e) => ({ error: String(e && e.message || e) }));
  // h('div.cls', { onclick }, child, 'text', ...): an element, with text children always as text
  function h(spec, props, ...kids) {
    const [tag, ...cls] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (cls.length) el.className = cls.join(' ');
    for (const [k, v] of Object.entries(props || {})) { if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v); }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }
  // Small line icons for the voice buttons (fixed strings, never built from anything a hub sends).
  const ICONS = {
    join: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
    hangup: '<path d="M3 15.5c5.5-5 12.5-5 18 0l-2.5 2.5-3-1.5v-2.5a10 10 0 0 0-7 0v2.5l-3 1.5z"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    micOff: '<path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16"/>',
    play: '<path d="M7 5l12 7-12 7z" fill="currentColor"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
    door: '<path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    cursor: '<path d="M5 3l14 7.5-6.2 1.7L10 19 5 3Z"/>',
    cursorOff: '<path d="M5 3l14 7.5-6.2 1.7L10 19 5 3Z"/><path d="M3 21L21 3"/>',
    screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    sparkle: '<path d="M10 3.5l1.6 4.6 4.6 1.6-4.6 1.6L10 15.9l-1.6-4.6L3.8 9.7l4.6-1.6z"/><path d="M17.5 13.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',  };
  function icon(name) {
    const el = h('span.ico');
    el.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return el;
  }

  let info = { me: {}, hubs: [], hosting: null, blocked: [] };
  let sel = { hub: '', ch: 0 };
  try { sel = { ...sel, ...JSON.parse(localStorage.getItem('chatSel') || '{}') }; } catch { /* first time, or storage is off */ }
  const keep = () => { try { localStorage.setItem('chatSel', JSON.stringify(sel)); } catch { /* fine */ } };
  const cache = new Map();        // "hub:ch" -> { msgs: [], more: true, loading: false }
  const unread = new Map();       // "hub:ch" -> count
  const typing = new Map();       // "hub:ch" -> Map(member -> until)
  let mode = null;                // { kind: 'reply' | 'edit', msg }
  const keyOf = (hub, ch) => `${hub}:${ch}`;
  const hubNow = () => info.hubs.find((x) => x.id === sel.hub);
  const chanNow = () => { const x = hubNow(); return x && x.channels.find((c) => c.id === sel.ch); };
  const nameOf = (x, id) => {
    const m = x && x.members.find((y) => y.id === id);
    if (m) return m.name;
    const s = x && (x.suspect || []).find((y) => y.id === id);       // someone the hub sent a bad key for: still named, so the warning makes sense
    return s ? s.name : id === info.me.id ? (info.me.name || 'You') : 'Someone who left';
  };
  const looking = () => $('#panel').classList.contains('open') && $('section[data-tab="hub"]').classList.contains('active') && !$('#chat').classList.contains('opts') && !$('#chat').classList.contains('help');
  let p2p = { role: 'off' }, joined = '';       // watch together as main.js reports it; joined: the code of the share we joined from a card

  // ---- faces: a member's picture, or their initial on a colour of their own until it arrives ----
  const faceData = new Map();       // picture id -> data: URL ('' when it couldn't be had, so it isn't asked for again)
  function face(x, id, cls = '') {
    const m = (x && x.members.find((y) => y.id === id)) || (id === info.me.id ? { name: info.me.name || 'You', av: info.me.av } : null);
    const name = m ? m.name : '?', av = m && m.av;
    const el = h('span.face' + cls, { 'data-av': av || undefined, 'aria-hidden': 'true' });
    el.style.setProperty('--hue', [...String(id)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7));
    const d = av && faceData.get(av);
    el.append(d ? h('img', { src: d, alt: '' }) : (name.trim()[0] || '?').toUpperCase());
    if (av && !faceData.has(av)) {
      faceData.set(av, '');
      call('avatar', x ? x.id : '', id, av).then((r) => {
        if (!r.data || !/^data:image\/(webp|jpeg|png);base64,/.test(r.data)) return;
        faceData.set(av, r.data);
        for (const e of document.querySelectorAll(`.face[data-av="${CSS.escape(av)}"]`)) e.replaceChildren(h('img', { src: r.data, alt: '' }));
      });
    }
    return el;
  }

  // ---- text to elements: the Markdown Drift understands ----
  const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\|\|[^|\n]+\|\|)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;
  function inline(text) {
    const out = [];
    let at = 0;
    for (const m of text.matchAll(INLINE)) {
      if (m.index > at) out.push(text.slice(at, m.index));
      const t = m[0];
      if (m[1]) out.push(h('code', {}, t.slice(1, -1)));
      else if (m[2]) out.push(h('b', {}, t.slice(2, -2)));
      else if (m[3]) out.push(h('span.spoiler', { title: 'Spoiler: click to show', onclick: (e) => e.currentTarget.classList.add('shown') }, t.slice(2, -2)));
      else if (m[4]) out.push(h('i', {}, t.slice(1, -1)));
      else out.push(link(t));
      at = m.index + t.length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }
  // "Are you sure?" in Drift's own box (ask() in renderer/app.js), not the system's
  const ask = (o) => (window.driftAsk ? window.driftAsk(o) : Promise.resolve(false));
  // A link says where it really goes before it opens (the host as the browser sees it, so look-alike letters show up).
  function link(url) {
    let u = null;
    try { u = new URL(url); } catch { return url; }
    return h('a', { href: '#', title: u.hostname, onclick: async (e) => {
      e.preventDefault();
      if (!(await ask({ title: 'Open this link in Surf?', note: `It goes to ${u.hostname}`, detail: u.href, yes: 'Open it', danger: false }))) return;
      api.cmd({ type: 'surf', do: 'new' }); api.cmd({ type: 'surf', do: 'go', text: u.href });
    } }, url);
  }
  function render(text) {
    const out = [], parts = text.split(/```/);
    parts.forEach((p, i) => {
      if (i % 2) { out.push(h('pre', {}, p.replace(/^\w*\n/, '').replace(/\n$/, ''))); return; }       // ```code```
      const lines = p.split('\n');
      let quote = null;
      lines.forEach((ln, j) => {
        if (/^> ?/.test(ln)) { if (!quote) out.push(quote = h('blockquote')); else quote.append('\n'); quote.append(...inline(ln.replace(/^> ?/, ''))); return; }
        quote = null;
        out.push(...inline(ln));
        if (j < lines.length - 1) out.push('\n');
      });
    });
    return out;
  }
  const when = (at) => {
    const d = new Date(at), now = new Date(), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return t;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    return (d.toDateString() === y.toDateString() ? 'Yesterday ' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ') + t;
  };

  // ---- the side: hubs, channels, people ----
  function drawSide() {
    const box = $('#chHubs');
    const typing = newChan && document.activeElement === newChan.input, at = typing && newChan.input.selectionStart;
    box.replaceChildren();
    for (const x of info.hubs) {
      const open = x.id === sel.hub, n = x.channels.reduce((a, c) => a + (unread.get(keyOf(x.id, c.id)) || 0), 0);
      box.append(h('div.chHubRow', {}, h('button.chHub' + (open ? '.on' : ''), { title: x.note || '', onclick: () => pick(x.id, open ? sel.ch : (x.channels[0] || {}).id || 0) },
        h('span.dot.' + x.status), h('b', {}, x.name || 'Hub'), x.mine ? h('em', {}, 'yours') : null, (x.lives || []).length ? h('span.liveTag', { title: 'Someone here is sharing something to watch' }, '▶') : null,
        !open && n ? h('span.badge', {}, n > 99 ? '99+' : n) : null),
        open ? h('button.chMenuBtn' + (menuHub === x.id ? '.on' : ''), { title: 'More for this hub', onclick: (e) => { e.stopPropagation(); menuHub = menuHub === x.id ? '' : x.id; drawSide(); } }, '⋯') : null));
      if (!open) continue;
      if (menuHub === x.id) box.append(hubMenu(x));
      if (x.status === 'away' && !(x.mine && info.canHost)) box.append(h('button.btn.join.chConnect', { title: `Go online in ${x.name || 'this hub'}`, onclick: () => call('reconnect', x.id) }, icon('plug'), 'Connect'));
      else if (x.status === 'gone' || (x.status !== 'connected' && x.status !== 'away' && x.note)) box.append(h('p.note.chNote', {}, x.note));
      if (x.status === 'connected') {       // what the hub said about people that didn't check out
        for (const w of x.suspect || []) box.append(h('p.warn', {}, `⚠ The hub sent a key for ${w.name} that doesn't belong to them, so Drift is ignoring it. The hub may be interfering.`));
        for (const w of x.lookalikes || []) box.append(h('p.warn', {}, `⚠ This ${w.name} has a different key from the ${w.name} you met here before. It may be a new PC, or the hub pretending. Click their name in People and compare safety numbers.`));
      }
      x.channels.forEach((c, i) => {
        const u = unread.get(keyOf(x.id, c.id)) || 0;
        box.append(h('button.chChan' + (i ? '' : '.first') + (c.id === sel.ch ? '.on' : '') + (u ? '.new' : ''), { onclick: () => pick(x.id, c.id) }, '# ' + c.name, u ? h('span.badge', {}, u > 99 ? '99+' : u) : null));
      });
      if (x.status === 'connected') {
        box.append(newChan && newChan.hub === x.id ? newChan.input : h('button.chChan.add', { title: 'Make a channel', onclick: () => makeChannel(x) }, '+ New channel'));
        drawVoice(box, x);
        const people = x.members.filter((p) => p.online).sort((a, b) => a.name.localeCompare(b.name));       // only who's here now
        box.append(h('h3.sub', {}, `People · ${people.length} here`));
        for (const p of people) {
          const isMe = p.id === info.me.id, blocked = info.blocked.includes(p.id);
          box.append(h('div.chWho' + (p.online ? '.on' : ''), {},
            h('span.faceWrap', { 'data-speak': p.id }, face(x, p.id, '.small'), h('span.dot')),
            h('span.nm' + (isMe ? '' : '.link'), { title: isMe ? undefined : 'Their profile and safety number', onclick: isMe ? undefined : () => { profile = profile === p.id ? '' : p.id; drawSide(); } }, p.name + (isMe ? ' (you)' : '')),
            p.verified ? h('span.ver', { title: 'You compared safety numbers with them' }, '✓') : null, p.host ? h('em', {}, 'host') : null,
            p.online && p.mic === false ? h('span.nomic', { title: 'No microphone: they can only type, so their messages go over the video' }, 'no mic') : null,
            ...voiceBits(x, p),
            !isMe ? h('button.mini', { title: blocked ? 'Show their messages again' : 'Hide their messages from you. They aren\'t told.', onclick: () => call('block', p.id, !blocked).then(() => reload()) }, blocked ? 'Unblock' : 'Block') : null,
            !isMe && x.host && !p.host ? h('button.mini.danger', { title: 'Remove them from this hub for good', onclick: () => removePerson(x, p) }, 'Remove') : null));
          if (profile === p.id && !isMe) box.append(drawProfile(x, p));
        }
        box.append(h('button.chChan.add', { title: 'Copies a code friends paste into their Drift. It works for 7 days.', onclick: () => invite(x) }, '+ Copy an invite'));
      }
    }
    drawHostBtn();
    if (typing) { newChan.input.focus(); newChan.input.setSelectionRange(at, at); }       // drawn again while typing: carry on where you were
    const tabBtn = document.querySelector('.tabs button[data-tab="hub"]'), any = [...unread.values()].some((n) => n);
    if (tabBtn) tabBtn.classList.toggle('unread', any);
  }

  // The ⋯ next to the open hub: everything you do to the hub itself, out of the way of the chat.
  let menuHub = '';
  function hubMenu(x) {
    const item = (label, title, fn, danger) => h('button.chMenuItem' + (danger ? '.danger' : ''), { title, onclick: () => { menuHub = ''; drawSide(); fn(); } }, label);
    const pinnedHere = voiceSet.pin === x.id, on = x.status === 'connected';
    return h('div.chMenu', {},
      on && x.host ? item('Withdraw invites', 'Every invite code made so far stops working. People already here stay.', () => withdraw(x)) : null,
      on && activeHubId() === x.id ? item(pinnedHere ? 'Let voice follow the open hub' : 'Keep voice in this hub', pinnedHere ? 'Voice follows whichever hub is open here again' : 'Stay in this hub\'s voice room when you open another hub', () => api.patch({ voice: { pin: pinnedHere ? '' : x.id } })) : null,
      on ? item('Disconnect', 'Go offline from this hub without leaving it. Press Connect to come back.', () => call('disconnect', x.id)) : null,
      x.mine ? null       // (Host / Stop hosting is the button at the bottom)
        : item('Leave hub', 'You\'ll need a new invite to come back.', async () => { if (await ask({ title: `Leave ${x.name}?`, note: 'You\'ll need a new invite to come back.', yes: 'Leave hub' })) call('leave', x.id).then(() => { sel = { hub: '', ch: 0 }; keep(); }); }, true));
  }
  document.addEventListener('click', (e) => { if (menuHub && !e.target.closest('.chMenu, .chMenuBtn')) { menuHub = ''; drawSide(); } });
  document.addEventListener('keydown', (e) => { if (menuHub && e.key === 'Escape') { menuHub = ''; drawSide(); } });

  // ---- the middle: one channel's messages ----
  function drawHead() {
    const x = hubNow(), c = chanNow();
    $('#chTitle').textContent = c ? '# ' + c.name : x ? x.name : 'Chat';
    $('#chSub').textContent = !x ? 'Join a friend\'s hub with their invite code, or host one of your own.'
      : x.mine && info.canHost ? 'Not hosting. Press Host to start it.'
      : x.status !== 'connected' ? (x.note || 'Connecting…')
      : x.mine ? 'Messages are kept on this PC until Drift closes.' : `Messages are kept on the host's PC (${(x.members.find((m) => m.host) || {}).name || 'the host'}) until their Drift closes, not encrypted from them.`;
    const input = $('#chInput');
    input.disabled = !c || !x || x.status !== 'connected';
    input.placeholder = c ? `Message #${c.name}` : '';
    for (const b of ['#chFileBtn', '#chGifBtn', '#chEmojiBtn']) $(b).disabled = input.disabled;
    if (input.disabled && pickOpen) closePick();
  }
  function drawList(stick) {
    const list = $('#chList'), x = hubNow(), c = chanNow(), k = c && keyOf(x.id, c.id), got = k && cache.get(k);
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren();
    if (!x || x.status !== 'connected') { list.append(drawIntro(x)); return; }       // not online in a hub: say what one is
    if (!got) return;
    if (got.more && got.msgs.length) list.append(h('button.btn.ghost.chMore', { onclick: () => older(x.id, c.id) }, got.loading ? 'Loading…' : 'Show older messages'));
    if (!got.msgs.length && !got.loading) list.append(h('p.note', {}, `This is the start of #${c.name}.`));
    let prev = null;
    for (const m of got.msgs) {
      const mine = m.from === info.me.id, head = !prev || prev.from !== m.from || m.at - prev.at > 5 * 60e3 || m.reply;
      const row = h('div.chMsg' + (head ? '.head' : '') + (mine ? '.mine' : ''), { 'data-id': m.id });
      if (m.reply) {
        const to = got.msgs.find((y) => y.id === m.reply);
        row.append(h('div.chRe', {}, '↪ ', to ? h('b', {}, nameOf(x, to.from)) : 'a deleted message', to ? ' ' + (to.text || picWord(to)).slice(0, 80) : ''));
      }
      if (head) row.append(face(x, m.from, '.msgFace'), h('div.chBy', {}, h('b', {}, nameOf(x, m.from)), h('time', { title: new Date(m.at).toLocaleString() }, when(m.at))));
      if (m.text || m.edited) row.append(h('div.chText', {}, render(m.text), m.edited ? h('span.chEd', { title: 'Edited ' + new Date(m.edited).toLocaleString() }, ' (edited)') : null));
      if (m.file) row.append(pic(x, m.file));
      else if (m.offer) row.append(fileCard(x, m));
      else if (!m.text) row.append(h('div.chText.chGone', {}, 'This picture isn\'t kept on the hub any more.'));
      if (m.reacts && m.reacts.length) row.append(reactRow(x, m));
      const tools = h('div.chTools');
      for (const e of ['👍', '❤️', '😂']) tools.append(h('button.mini.emoMini', { title: `React with ${e}`, onclick: () => toggleReact(x, m, e) }, e));
      tools.append(h('button.mini', { title: 'React with any emoji', onclick: (ev) => openPick('emoji', m, ev.currentTarget) }, 'React'));
      tools.append(h('button.mini', { onclick: () => setMode('reply', m) }, 'Reply'));
      if (mine) tools.append(h('button.mini', { onclick: () => setMode('edit', m) }, 'Edit'));
      if (mine || x.host) tools.append(h('button.mini.danger', { onclick: async () => { if (await ask({ title: 'Delete this message?', note: 'It\'s deleted for everyone in the hub.', yes: 'Delete' })) call('delete', x.id, m.id).then((r) => r.error && toast(r.error)); } }, 'Delete'));
      row.append(tools);
      list.append(row);
      prev = m;
    }
    if (stick || atEnd) list.scrollTop = list.scrollHeight;
  }
  const picWord = (m) => (m.file ? (m.file.mime === 'image/gif' ? '(a GIF)' : '(a picture)') : m.offer ? `(a file: ${m.offer.name})` : '');

  // ---- files offered from someone's PC (docs/plans/files.md): a card saying what it is, how its download is doing, and what
  // you can do with it. main.js sends how every transfer is doing (ft); the cards are filled again from that as it changes. ----
  let ft = { runs: [], preps: [], downloads: [], notes: {}, sent: {}, folder: '', awake: false };
  const RELAY_MAX = 500 * 1024 * 1024;       // bigger files connect directly (hub.js LIMITS.relayMax)
  const sizeText = (n) => (n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : n < 1024 ** 3 ? (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB' : (n / 1024 ** 3).toFixed(1) + ' GB');
  const timeLeft = (s) => (s < 90 ? `about ${Math.max(1, Math.round(s))} s left` : s < 5400 ? `about ${Math.round(s / 60)} min left` : `about ${(s / 3600).toFixed(1)} h left`);
  const pct = (a, b) => `${Math.floor((100 * a) / Math.max(1, b))}%`;
  function fileCard(x, m) {
    const box = h('div.chFile', { 'data-offer': m.offer.id });
    box.msg = m; box.hubId = x.id;
    fillCard(box);
    return box;
  }
  function fillCard(box) {
    const x = info.hubs.find((y) => y.id === box.hubId), m = box.msg, o = m.offer;
    if (!x) return;
    const here = (info.offers || []).includes(o.id), mine = m.from === info.me.id, who = nameOf(x, m.from);
    const run = ft.runs.find((r) => r.offer === o.id && r.role === 'recv'), sends = ft.runs.filter((r) => r.offer === o.id && r.role === 'send');
    // (the same file offered again, under a new message: what came of the last offer counts, as files.js carries on from it)
    const dl = ft.downloads.find((d) => d.offer === o.id) || ft.downloads.find((d) => d.root === o.root && d.size === o.size && (d.path || (d.partial && !ft.runs.some((r) => r.offer === d.offer))));
    const note = ft.notes[o.id] || (dl && dl.offer === o.id && dl.why), owner = x.members.find((y) => y.id === m.from), online = !!(owner && owner.online);
    const lines = [], btns = [];
    let bar = null;
    const btn = (label, fn, cls = '') => h('button.mini' + cls, { onclick: fn }, label);
    if (dl && dl.path) {
      lines.push('Downloaded');
      btns.push(btn('Open', () => call('ftOpen', dl.offer).then((r) => r.error && toast(r.error))), btn('Show in folder', () => call('ftShow', dl.offer).then((r) => r.error && toast(r.error))));
    } else if (run) {
      bar = run.got / Math.max(1, o.size);
      const moving = run.state === 'verified';
      lines.push(moving ? `${sizeText(run.got)} of ${sizeText(o.size)}${run.rate > 1024 ? ` · ${sizeText(run.rate)}/s · ${timeLeft((o.size - run.got) / run.rate)}` : ''}` : run.got ? `Connecting to ${who} to carry on (${pct(run.got, o.size)})…` : `Connecting to ${who}…`);
      if (run.direct) lines.push('Directly between your PCs');
      btns.push(btn('Pause', () => call('ftStop', o.id, false)), btn('Cancel', () => stopDownload(o), '.danger'));
    } else if (here) {
      lines.push(o.gone ? 'No longer offered' : 'Offered from this PC: it stays here, and friends download it from you');
      for (const r of sends) lines.push(`Sending to ${r.peerName}${r.state === 'verified' ? ` · ${pct(r.got, o.size)}` : '…'}`);
      if ((ft.sent[o.id] || []).length) lines.push('Downloaded by ' + ft.sent[o.id].join(', '));
      if (!o.gone && o.size > RELAY_MAX) lines.push('Over 500 MB, so whoever downloads it connects to your PC directly');
      if (!o.gone) btns.push(btn('Stop offering', () => call('offerDrop', x.id, o.id).then((r) => r.error && toast(r.error))));
    } else if (o.gone) {
      lines.push('No longer offered');
      if (dl && dl.partial) {
        lines.push(`${pct(dl.got, o.size)} was downloaded: if ${who} offers it again, it carries on from there`);
        btns.push(btn('Discard what was downloaded', () => call('ftStop', dl.offer, true)));
      }
    } else if (mine) {
      lines.push('Offered from your other PC');
    } else if (dl && dl.partial) {
      bar = dl.got / Math.max(1, o.size);
      const at = `${pct(dl.got, o.size)} (${sizeText(dl.got)} of ${sizeText(o.size)})`;
      if (dl.paused) {       // you paused it, or it failed a check: it waits for you
        lines.push(`Stopped at ${at}${online ? '' : ` · ${who} is offline`}`);
        btns.push(btn('Resume', () => download(x, m)), btn('Discard', () => stopDownload(o, dl.offer), '.danger'));
        if (!online) btns[0].disabled = true;
      } else {       // it dropped (the hub, or their PC): it carries on by itself
        lines.push(online ? `Carrying on from ${at}…` : `Paused at ${at} · it carries on by itself when ${who} is back online`);
        btns.push(btn('Pause', () => call('ftStop', dl.offer, false)), btn('Discard', () => stopDownload(o, dl.offer), '.danger'));
      }
    } else {
      const b = btn(o.size > RELAY_MAX ? 'Download (direct)' : 'Download', () => download(x, m));
      b.title = online ? `Saves to ${ft.folder || 'Downloads\\Drift'}` : `${who} is offline: the file is on their PC`;
      if (!online) { b.disabled = true; lines.push(`${who} is offline`); }
      btns.push(b);
    }
    if (note && !run && !(dl && dl.path)) lines.push(h('span.chFileErr', {}, note));
    box.classList.toggle('gone', !!o.gone && !(dl && dl.path));
    box.replaceChildren(
      h('div.chFileIco', {}, (o.name.match(/\.([A-Za-z0-9]{1,5})$/) || ['', 'file'])[1].toUpperCase()),
      h('div.chFileBody', {}, h('b.chFileName', { title: o.name }, o.name), h('span.chFileSize', {}, sizeText(o.size)),
        bar !== null ? h('div.chFileBar', {}, h('i', { style: `width:${Math.min(100, Math.max(0, bar * 100)).toFixed(1)}%` })) : null,
        lines.map((l) => h('div.chFileLine', {}, l)), btns.length ? h('div.chFileBtns', {}, btns) : null));
  }
  async function download(x, m) {
    const o = m.offer, who = nameOf(x, m.from);
    const direct = () => ask({ title: `Connect directly to ${who}?`, note: `Files over 500 MB go straight between your PCs, not through the hub, so ${who}'s PC and yours see each other's IP address.`, yes: 'Download', danger: false });
    let d = false;
    if (o.size > RELAY_MAX) { if (!(await direct())) return; d = true; }
    let r = await call('ftGet', x.id, o, m.from, d);
    if (r.error && r.direct && !d) { if (!(await direct())) return; r = await call('ftGet', x.id, o, m.from, true); }
    if (r.error) toast(r.error);
  }
  async function stopDownload(o, id = o.id) {       // (id: the download's own, when it came of an earlier offer of the same file)
    if (await ask({ title: `Throw away ${o.name}?`, note: 'What was downloaded so far is deleted. Pause keeps it, to carry on later.', yes: 'Throw it away' })) call('ftStop', id, true);
  }
  const folderBtn = $('#ftFolderBtn');
  if (folderBtn) folderBtn.addEventListener('click', () => call('ftFolder').then((r) => { if (r.folder) $('#ftFolderText').textContent = r.folder; }));
  function onFt(next) {
    ft = next || ft;
    if ($('#ftFolderText') && ft.folder) $('#ftFolderText').textContent = ft.folder;
    for (const el of document.querySelectorAll('.chFile')) fillCard(el);
    if (attach && attach.file && attach.sending) {
      const p = ft.preps.find((y) => y.name === attach.name);
      if (p) $('#chAttachText').textContent = `Reading ${attach.name} to make its check… ${pct(p.done, p.size)}`;
    }
  }

  // ---- pictures and GIFs in messages: fetched from the hub through chat.js once, kept here as data: URLs ----
  // The box is sized from what the sender said the picture measures, so the list doesn't jump when it arrives.
  const picData = new Map(), picWant = new Set();       // file id -> data: URL ('' when it couldn't be had)
  const PIC_OK = /^data:image\/(gif|png|jpeg|webp);base64,/;
  // (maxW × maxH: in the channel 360 × 260; over the video, smaller)
  function pic(x, f, maxW = 360, maxH = 260) {
    const s = Math.min(1, maxW / f.w, maxH / f.h), box = h('div.chPic' + (f.mime === 'image/gif' ? '.gif' : ''), { 'data-f': f.id });
    box.style.width = Math.max(40, Math.round(f.w * s)) + 'px'; box.style.height = Math.max(40, Math.round(f.h * s)) + 'px';
    fillPic(box);
    if (!picData.has(f.id) && !picWant.has(f.id)) {
      picWant.add(f.id);
      call('file', x.id, f.id).then((r) => {
        picWant.delete(f.id);
        picData.set(f.id, r.data && PIC_OK.test(r.data) ? r.data : '');
        while (picData.size > 80) picData.delete(picData.keys().next().value);
        for (const el of document.querySelectorAll(`.chPic[data-f="${CSS.escape(f.id)}"]`)) fillPic(el);       // in the channel and over the video alike
      });
    }
    return box;
  }
  function fillPic(box) {
    const d = picData.get(box.dataset.f);
    box.classList.toggle('loading', d === undefined);
    if (d === undefined || box.classList.contains('got') || box.classList.contains('bad')) return;
    if (!d) { box.classList.add('bad'); box.textContent = 'Couldn\'t load it'; return; }
    box.classList.add('got'); box.title = 'Click to see it bigger';
    box.replaceChildren(h('img', { src: d, alt: '' }));
    box.addEventListener('click', () => bigPic(d));
  }
  function bigPic(d) {
    const el = h('div.chLight', { title: 'Click or press Esc to close' }, h('img', { src: d, alt: '' }));
    const close = () => { el.remove(); removeEventListener('keydown', esc, true); };
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    el.addEventListener('click', close); addEventListener('keydown', esc, true);
    document.body.append(el);
  }

  // ---- reactions: one chip per emoji under a message; yours are lit, and clicking one adds or takes back yours ----
  function reactRow(x, m) {
    return h('div.chReacts', {}, m.reacts.map((r) => {
      const mine = r.who.includes(info.me.id);
      return h('button.chReact' + (mine ? '.on' : ''), { title: `${r.who.map((id) => (id === info.me.id ? 'You' : nameOf(x, id))).join(', ')} reacted with ${r.e}`, onclick: () => toggleReact(x, m, r.e) }, h('span.e', {}, r.e), h('span.n', {}, r.who.length));
    }), h('button.chReact.add', { title: 'Add a reaction', onclick: (ev) => openPick('emoji', m, ev.currentTarget) }, '+'));
  }
  function toggleReact(x, m, e) {
    const on = !(m.reacts || []).some((r) => r.e === e && r.who.includes(info.me.id));
    if (on) useEmoji(e);
    call('react', x.id, m.id, e, on).then((r) => r.error && toast(r.error));
  }

  // ---- the picker over the message box: emoji (into what you're writing, or as a reaction) or a GIF search ----
  const EMO = (window.DRIFT_EMOJI || []).map(([name, tab, list]) => ({ name, tab, items: list.split(';').map((s) => { const i = s.indexOf(' '); return { e: s.slice(0, i), words: s.slice(i + 1) }; }) }));
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem('emojiRecent') || '[]').filter((e) => typeof e === 'string').slice(0, 24); } catch { /* none yet */ }
  function useEmoji(e) { recent = [e, ...recent.filter((y) => y !== e)].slice(0, 24); try { localStorage.setItem('emojiRecent', JSON.stringify(recent)); } catch { /* fine */ } }
  let pickOpen = null, gifKey = '', gifSeq = 0, gifTimer = 0;       // pickOpen: { kind: 'emoji' | 'gif', react: the message reacted to, or null }
  const pickBox = $('#chPick');
  function openPick(kind, react, from) {
    if (pickOpen && pickOpen.kind === kind && pickOpen.react === react) { closePick(); return; }
    pickOpen = { kind, react: react || null };
    pickBox.hidden = false; pickBox.className = kind;
    // a reaction's picker sits by the message; the others over the message box
    const main = $('#chMain').getBoundingClientRect(), at = from && react ? from.getBoundingClientRect() : null;
    pickBox.style.bottom = at ? Math.max(8, Math.min(main.bottom - at.top + 6, main.height - 380)) + 'px' : '';
    const q = kind === 'emoji' ? drawEmoji() : drawGif();
    if (q) q.focus();
  }
  function closePick() { pickOpen = null; pickBox.hidden = true; pickBox.replaceChildren(); clearTimeout(gifTimer); gifSeq++; }
  document.addEventListener('mousedown', (e) => { if (pickOpen && !e.target.closest('#chPick, #chEmojiBtn, #chGifBtn, .chTools, .chReact.add')) closePick(); });
  $('#chEmojiBtn').addEventListener('click', () => openPick('emoji'));
  $('#chGifBtn').addEventListener('click', () => openPick('gif'));
  const pickKeys = (q, first) => q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePick(); input.focus(); }
    else if (e.key === 'Enter') { const b = first(); if (b) { e.preventDefault(); b.click(); } }
  });
  function drawEmoji() {
    const q = h('input.pickQ', { type: 'search', placeholder: pickOpen.react ? 'React with…' : 'Find an emoji', spellcheck: 'false', autocomplete: 'off' });
    const grid = h('div.emoGrid'), cell = (it) => h('button.emo', { title: it.words, onclick: () => pickEmoji(it.e) }, it.e);
    const fill = () => {
      const t = q.value.trim().toLowerCase();
      grid.replaceChildren(); grid.scrollTop = 0;
      if (t) {
        const hits = EMO.flatMap((g) => g.items).filter((it) => it.words.split(' ').some((w) => w.startsWith(t)) || (t.length > 2 && it.words.includes(t)));
        grid.append(hits.length ? h('div.emoRow', {}, hits.slice(0, 200).map(cell)) : h('p.note', {}, 'No emoji found.'));
        return;
      }
      if (recent.length) grid.append(h('h4', {}, 'Recently used'), h('div.emoRow', {}, recent.map((e) => cell({ e, words: e }))));
      for (const g of EMO) grid.append(h('h4', { 'data-g': g.name }, g.name), h('div.emoRow', {}, g.items.map(cell)));
    };
    const tabs = h('div.emoTabs', {}, EMO.map((g) => h('button', { title: g.name, onclick: () => { if (q.value) { q.value = ''; fill(); } const hd = grid.querySelector(`h4[data-g="${g.name}"]`); if (hd) grid.scrollTop = hd.offsetTop; } }, g.tab)));
    q.addEventListener('input', fill);
    pickKeys(q, () => grid.querySelector('.emo'));
    fill();
    pickBox.replaceChildren(q, tabs, grid);
    return q;
  }
  function pickEmoji(e) {
    const m = pickOpen && pickOpen.react;
    closePick();
    if (m) { const x = hubNow(); if (x && !(m.reacts || []).some((r) => r.e === e && r.who.includes(info.me.id))) toggleReact(x, m, e); return; }
    useEmoji(e);
    if (input.disabled) return;
    const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? a;
    input.setRangeText(e, a, b, 'end'); fit(); input.focus();
  }
  const GIF_OK = /^https:\/\/[a-z0-9]+\.giphy\.com\//;
  function drawGif() {
    if (!gifKey) {
      const k = h('input.pickQ', { type: 'password', placeholder: 'Paste a GIPHY API key', spellcheck: 'false', autocomplete: 'off' });
      k.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closePick(); input.focus(); } else if (e.key === 'Enter' && k.value.trim()) { e.preventDefault(); api.patch({ gif: { key: k.value.trim() } }); } });
      pickBox.replaceChildren(h('div.gifNone', {}, h('b', {}, 'GIF search uses GIPHY, with a key of your own'),
        h('p', {}, 'It\'s free: sign in at developers.giphy.com, press Create an API key, choose API, and paste the key here (or in Options).'),
        h('p', {}, 'Only your PC talks to GIPHY. The GIF you pick is sent through the hub like a picture, so friends\' PCs never reach GIPHY.'), k,
        h('p.note', {}, 'You can always send your own: paste or drop a GIF or picture here, or press +.')));
      return k;
    }
    const q = h('input.pickQ', { type: 'search', placeholder: 'Search GIPHY', spellcheck: 'false', autocomplete: 'off' });
    const grid = h('div.gifGrid');
    const run = async () => {
      const my = ++gifSeq;
      if (!grid.children.length) grid.append(h('p.note', {}, 'Looking…'));
      const r = await call('gifSearch', q.value.trim());
      if (my !== gifSeq) return;
      if (r.error) { grid.replaceChildren(h('p.note', {}, r.error === 'nokey' ? 'Add a GIPHY key in Options.' : r.error)); return; }
      const gifs = (r.gifs || []).filter((g) => GIF_OK.test(g.preview) && GIF_OK.test(g.url));
      grid.replaceChildren(...(gifs.length ? gifs.map((g) => h('button.gif', { title: g.title || 'GIF', onclick: () => sendGif(g) }, h('img', { src: g.preview, alt: g.title || 'GIF', loading: 'lazy' })))
        : [h('p.note', {}, 'No GIFs found.')]));
      grid.scrollTop = 0;
    };
    q.addEventListener('input', () => { clearTimeout(gifTimer); gifTimer = setTimeout(run, 350); });
    pickKeys(q, () => grid.querySelector('.gif'));
    pickBox.replaceChildren(q, grid, h('div.gifFoot', {}, q.value ? '' : 'Trending · ', 'Powered by GIPHY'));
    run();
    return q;
  }
  async function sendGif(g) {
    const m = mode && mode.kind === 'reply' ? mode.msg : null, hub = sel.hub, ch = sel.ch;
    closePick();
    toast('Sending the GIF…');
    const r = await call('gifSend', hub, ch, g.url, g.w, g.h, m ? m.id : undefined);
    if (r.error) toast(r.error); else { $('#toast').classList.remove('on'); if (m && mode && mode.msg === m) setMode(null); }
  }
  $('#gifKey').addEventListener('change', (e) => api.patch({ gif: { key: e.target.value.trim() } }));

  // ---- sending a picture or GIF of your own: + , paste, or drop it on the chat. It waits over the box until Enter ----
  // Photos are drawn again as WebP (at most 2560 px on a side): that drops where they were taken and the rest of what the
  // file carried, and keeps them small. GIFs and animated WebPs are sent as they are, so they still move.
  // Anything else (and a picture still over 4 MB) is offered instead: it stays on this PC and friends download it from here
  // (docs/plans/files.md). Enter reads it once to make its check, then sends the message that offers it.
  let attach = null;       // a picture: { bytes: Uint8Array, w, h, gif }; a file: { file: true, path, name, size, sending }
  function prepFile(f) {
    const x = hubNow();
    if (!f || !x || x.status !== 'connected' || !chanNow()) return;
    const p = api.pathOf ? api.pathOf(f) : '';
    if (!p) { toast('Drift couldn\'t tell where that file is. Drop it from a folder, or press + to pick it.'); return; }
    attach = { file: true, path: p, name: f.name, size: f.size, sending: false };
    $('#chAttachPic').replaceChildren(h('span.chFileIco', {}, (f.name.match(/\.([A-Za-z0-9]{1,5})$/) || ['', 'file'])[1].toUpperCase()));
    $('#chAttachText').textContent = `${f.name} · ${sizeText(f.size)} · Enter offers it: it stays on this PC and friends download it from you${f.size > RELAY_MAX ? ' (directly, so whoever downloads it sees your IP address)' : ''}`;
    $('#chAttach').classList.add('on');
    input.focus();
  }
  async function prepPicture(f) {
    const x = hubNow();
    if (!f || !x || x.status !== 'connected' || !chanNow()) return;
    if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type) || f.size > 64 * 1024 * 1024) { prepFile(f); return; }
    let bmp = null;
    try { bmp = await createImageBitmap(f); } catch { toast('That picture couldn\'t be opened.'); return; }
    let bytes = new Uint8Array(await f.arrayBuffer()), w = bmp.width, hh = bmp.height;
    const moving = f.type === 'image/gif' || (f.type === 'image/webp' && bytes.length > 21 && String.fromCharCode(...bytes.subarray(12, 16)) === 'VP8X' && (bytes[20] & 2));
    if (!moving) {
      for (const [side, q] of [[2560, 0.9], [1920, 0.8], [1280, 0.75]]) {
        const s = Math.min(1, side / Math.max(bmp.width, bmp.height)), cv = document.createElement('canvas');
        cv.width = w = Math.max(1, Math.round(bmp.width * s)); cv.height = hh = Math.max(1, Math.round(bmp.height * s));
        const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, hh);
        const blob = await new Promise((r) => cv.toBlob(r, 'image/webp', q));
        if (!blob) break;
        bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length <= 4 * 1024 * 1024) break;
      }
    }
    bmp.close();
    if (bytes.length > 4 * 1024 * 1024) { prepFile(f); return; }       // (a big GIF: offered from this PC instead of kept on the hub)
    let b64 = '';
    for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const kind = moving ? f.type : 'image/webp';
    attach = { bytes, w, h: hh, gif: f.type === 'image/gif' };
    $('#chAttachPic').replaceChildren(h('img', { src: `data:${kind};base64,${btoa(b64)}`, alt: '' }));
    $('#chAttachText').textContent = `${attach.gif ? 'GIF' : 'Picture'} · ${bytes.length < 1024 * 1024 ? Math.max(1, Math.round(bytes.length / 1024)) + ' KB' : (bytes.length / 1024 / 1024).toFixed(1) + ' MB'} · Enter sends it, with anything you write`;
    $('#chAttach').classList.add('on');
    input.focus();
  }
  function dropAttach() { attach = null; $('#chAttach').classList.remove('on'); $('#chAttachPic').replaceChildren(); }
  $('#chAttachX').addEventListener('click', () => { dropAttach(); input.focus(); });
  $('#chFileBtn').addEventListener('click', () => $('#chFile').click());
  $('#chFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; prepPicture(f); });
  $('#chInput').addEventListener('paste', (e) => {
    const all = [...(e.clipboardData ? e.clipboardData.files : [])], f = all.find((y) => y.type.startsWith('image/')) || all[0];
    if (f) { e.preventDefault(); prepPicture(f); }
  });
  // (anywhere in the window: a file dropped on it would otherwise open in its place)
  addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('#chMain').classList.toggle('dropping', !!e.target.closest && !!e.target.closest('#chMain')); } });
  addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('#chMain').classList.remove('dropping'); });
  addEventListener('drop', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault(); $('#chMain').classList.remove('dropping');
    if (!e.target.closest || !e.target.closest('#chMain')) return;
    const f = e.dataTransfer.files[0];
    if (e.dataTransfer.files.length > 1) toast('One at a time: drop the others after this one is sent.');
    if (f) prepPicture(f);
  });
  // What fills the middle while you aren't online in a hub: what a hub is, and the next step to get into one.
  function drawIntro(x) {
    const item = (ico, title, text) => h('div.chIntroItem', {}, icon(ico), h('div', {}, h('b', {}, title), h('span', {}, text)));
    const next = !x ? 'Paste a friend\'s invite code on the left and press Join, or host a hub of your own.'
      : x.mine && info.canHost ? 'Press Host to open your hub, then Copy an invite and send the code to your friends. It works for 7 days.'
      : x.status === 'away' ? `Press Connect to go online in ${x.name || 'this hub'}.`
      : x.status === 'gone' ? (x.note || 'This hub is gone. Ask a friend for a new invite.')
      : x.status === 'offline' ? (x.note || `Can't reach ${x.name || 'the hub'} right now. The host may be offline.`)
      : `Drift is reaching ${x.name || 'the hub'}. If it takes a while, the host may be offline.`;
    return h('div.chIntro', {},
      h('h2', {}, 'A hub is a place for your friends'),
      h('p.lead', {}, 'It runs in the host\'s Drift, with no server or accounts. Once you\'re online in one:'),
      h('div.chIntroGrid', {},
        item('chat', 'Chat', 'Channels anyone can make, with replies, edits and history kept on the host\'s PC.'),
        item('mic', 'Voice room', 'You\'re in it as soon as you\'re online, listening. Press Talk to be heard.'),
        item('film', 'Watch together', 'Play a video or music in Media and everyone online sees it in step.'),
        item('globe', 'Surf together', 'The Surf tab becomes one browser the whole hub shares and can click in.')),
      h('p.chIntroSafe', {}, icon('lock'), 'Voice is end-to-end encrypted, and streams go straight from PC to PC.'),
      h('p.chIntroNext', {}, next));
  }
  function drawTyping() {
    const k = keyOf(sel.hub, sel.ch), t = typing.get(k), x = hubNow(), now = Date.now();
    const who = t ? [...t].filter(([, until]) => until > now).map(([id]) => nameOf(x, id)) : [];
    $('#chTyping').textContent = !who.length ? '' : who.length === 1 ? `${who[0]} is typing…` : who.length === 2 ? `${who[0]} and ${who[1]} are typing…` : 'Several people are typing…';
  }
  // ---- who is sharing in this hub: a card each, with Join ----
  function drawLives() {
    const box = $('#chLives'), x = hubNow(), lives = (x && x.lives) || [];
    box.replaceChildren();
    // When this PC's own session has a card here, the card's button and watcher list stand in for the ones in the side.
    $('#chat').classList.toggle('carded', lives.some((l) => (l.from === info.me.id && p2p.role === 'host') || (p2p.role === 'guest' && joined === l.code)));
    for (const l of lives) {
      const mine = l.from === info.me.id, watching = !mine && p2p.role === 'guest' && joined === l.code;
      const who = mine ? 'You\'re sharing' : `${nameOf(x, l.from)} is sharing`;
      const sub = l.watching.length ? `Watching: ${l.watching.join(', ')}` : mine ? 'Nobody has joined yet' : 'Nobody is watching yet';
      box.append(h('div.liveCard' + (watching || mine ? '.on' : ''), {},
        h('span.spdot'), h('div', {}, h('b', {}, who, l.title ? h('span', {}, ' · ' + l.title) : null), h('span', {}, sub)),
        mine ? h('button.btn.ghost', { onclick: () => api.cmd({ type: 'share-stop' }) }, 'Stop sharing')
          : watching ? h('button.btn.ghost', { onclick: () => api.cmd({ type: 'share-stop' }) }, 'Leave')
          : h('button.btn', { onclick: () => joinLive(x, l) }, 'Join')));
    }
  }
  async function joinLive(x, l) {
    if (p2p.role === 'host' && !(await ask({ title: `Join ${nameOf(x, l.from)}?`, note: 'What you\'re sharing stops first.', yes: 'Stop sharing and join', danger: false }))) return;
    joined = l.code;
    api.cmd({ type: 'share-join', code: l.code });
  }
  function drawAll(stick) { drawSide(); drawLives(); drawHead(); drawList(stick); drawTyping(); drawMode(); drawCall(); }

  // ---- voice: the hub's voice room, and how far each connection can be trusted ----
  let profile = '';                 // the member whose profile is open in People
  const safetyCodes = new Map();    // "hub:member" -> their safety number with you
  const vEntry = (x, id) => (x && (x.voice || []).find((v) => v.id === id)) || null;
  const inRoomHere = (x) => !!info.call && !!x && info.call.hub === x.id;
  // A lock for each person you're connected to in the room. Only a connection whose signed SDP checked out and whose
  // certificate matches the signed one counts as end-to-end encrypted; anything else says what went wrong.
  function lockOf(x, id) {
    const c = info.call, live = info.live || { peers: {} }, name = nameOf(x, id);
    if (!c || id === info.me.id || !x || c.hub !== x.id || !(c.want || []).includes(id)) return null;
    if (c.verdict[id] === 'mismatch') return { kind: 'bad', text: `The connection to ${name} didn't use the certificate they signed, so Drift closed it. The hub may be interfering.` };
    if (c.refused[id]) return { kind: 'bad', text: `Couldn't verify ${name}. The hub may be interfering.` };
    if (c.told.includes(id)) return { kind: 'bad', text: `${name} couldn't verify your connection. The hub may be interfering.` };
    if (c.verdict[id] === 'verified' && live.peers[id] === 'connected') return { kind: 'ok', text: `Verified: ${name}'s Drift signed this connection and it uses the certificate they signed. End-to-end encrypted: the hub passes the sound on but can't hear it.` };
    if (live.peers[id] === 'failed') return { kind: 'bad', text: `Couldn't connect to ${name}.` };
    return { kind: 'wait', text: `Connecting to ${name}…` };
  }
  function e2eNote(x) {
    const ids = ((info.call && info.call.want) || []).filter((id) => id !== info.me.id);
    if (!ids.length) return { text: (x.voice || []).filter((v) => v.listen).length > 1 ? 'Connections are made when someone talks.' : 'Nobody else is listening yet.' };
    const kinds = ids.map((id) => (lockOf(x, id) || { kind: 'wait' }).kind);
    if (kinds.every((k) => k === 'ok')) return { ok: true, text: '🔒 End-to-end encrypted. The hub passes the sound on but can\'t hear it.' };
    if (kinds.some((k) => k === 'ok')) return { text: 'Connections with a 🔒 are end-to-end encrypted. The others aren\'t verified.' };
    return { text: kinds.some((k) => k === 'bad') ? 'No voice connection is verified.' : 'Checking each connection…' };
  }
  const activeHubId = () => (voiceSet.pin && info.hubs.some((y) => y.id === voiceSet.pin) ? voiceSet.pin : info.voiceHub || sel.hub);
  // The Voice part of an open hub: who's listening and talking, Talk and Listen, keeping voice in this hub.
  function drawVoice(box, x) {
    const list = x.voice || [], listening = list.filter((v) => v.listen).length, talking = list.filter((v) => v.talk).length;
    const here = activeHubId() === x.id, pinnedHere = voiceSet.pin === x.id, live = inRoomHere(x);
    box.append(h('h3.sub', {}, 'Voice' + (list.length ? ` · ${listening} listening${talking ? ` · ${talking} talking` : ''}` : '')));
    if (!here) {
      const other = info.hubs.find((y) => y.id === activeHubId());
      box.append(h('p.note.vcNote', {}, `You're in ${other ? other.name : 'another hub'}'s voice room${voiceSet.pin ? ' (kept there)' : ''}. Only one at a time.`),
        h('div.row.chActs', {}, h('button.btn', { onclick: () => api.patch({ voice: { pin: x.id } }) }, 'Move voice here')));
      return;
    }
    if (x.room && x.room.note) box.append(h('p.warn', {}, x.room.note));
    if (info.voiceNote) box.append(h('p.warn', {}, info.voiceNote));
    if (voiceSet.deaf) box.append(h('p.note.vcNote', {}, 'You\'re not in voice. Join to hear and talk; you stay in the chat either way.'));
    else if (live) {
      const n = e2eNote(x);
      box.append(h('p.vcNote' + (n.ok ? '.ok' : ''), {}, n.text));
      for (const id of info.call.want || []) { const l = lockOf(x, id); if (l && l.kind === 'bad') box.append(h('p.warn', {}, l.text)); }       // said in words, not only as a ⚠ in People
    }
    box.append(h('div.row.chActs.vcActs', {},
      joinButton('btn', x),
      voiceSet.deaf ? null : talkButton('btn'),
      pinnedHere ? h('span.vcPin', { title: 'Voice stays in this hub when you open another. Change it in the ⋯ menu.' }, 'Kept here') : null));
  }
  // Join voice / Disconnect: in or out of the hub's voice room. Out of it you're still online in the hub and its chat.
  function joinButton(cls, x) {
    const out = !!voiceSet.deaf;
    return h(`button.${cls}.vcJoin${out ? '.join' : '.hang'}`, { title: out ? `Join ${x.name || 'the hub'}'s voice: hear everyone in it. Your microphone stays muted until you unmute it.` : 'Leave voice: hear nobody and close your microphone. You stay in the hub and its chat.',
      onclick: () => api.patch({ voice: { deaf: !out } }) }, icon(out ? 'join' : 'hangup'), out ? 'Join voice' : 'Leave voice');
  }
  // Mute / Unmute: your microphone, while you're in voice.
  function talkButton(cls) {
    const on = !!voiceSet.talk;
    return h(`button.${cls}.vcMute${on ? '.open' : '.muted'}`, { title: on ? 'Mute: close your microphone' : `Unmute: open your microphone${voiceSet.ptt ? `, then hold ${KEY_NAMES[voiceSet.pttKey] || 'the key'} to talk` : ''}`, onclick: () => api.patch({ voice: { talk: !on } }) },
      icon(on ? 'mic' : 'micOff'), on ? 'Mute' : 'Unmute');
  }
  // What a person's row in People says about voice: talking, not listening, a lock and a volume.
  function voiceBits(x, p) {
    const v = vEntry(x, p.id), isMe = p.id === info.me.id;
    if (!p.online) return [];
    if (!v || !v.listen) return [h('span.vcTag', { title: v ? 'They turned listening off' : 'Not in this hub\'s voice room (their voice is in another hub, or off)' }, 'not listening')];
    const lock = inRoomHere(x) && !isMe ? lockOf(x, p.id) : null, vol = (voiceSet.volumes || {})[p.id];
    return [
      v.talk ? h('span.vcMic' + (v.mic ? '' : '.none'), { title: v.mic ? 'Their microphone is open' : 'They pressed Talk, but have no working microphone' }, '🎙') : null,
      lock ? h('span.lock.' + lock.kind, { title: lock.text }, lock.kind === 'ok' ? '🔒' : lock.kind === 'bad' ? '⚠' : '…') : null,
      lock && lock.kind !== 'bad' ? h('input.vcVol', { type: 'range', min: '0', max: '100', value: String(Math.round((vol ?? 1) * 100)), title: `${p.name}'s volume, for you only`,
        oninput: (e) => api.patch({ voice: { volumes: { [p.id]: +e.target.value / 100 } } }) }) : null,
    ];
  }
  function drawProfile(x, p) {
    const k = `${x.id}:${p.id}`, code = safetyCodes.get(k);
    if (!safetyCodes.has(k)) {
      safetyCodes.set(k, '');
      call('safety', x.id, p.id).then((r) => { safetyCodes.set(k, r.code || r.error || ''); if (profile === p.id) drawSide(); });
    }
    return h('div.chProfile', {},
      'Safety number with you', h('b.safety', {}, code || '…'),
      h('p.note', {}, `Compare it with ${p.name} in person or on the phone. If yours match, nobody (not even the hub) can pretend to be either of you in voice.`),
      h('button.mini', { onclick: () => call('verify', x.id, p.id, !p.verified).then((r) => r.error && toast(r.error)) }, p.verified ? 'Not verified any more' : 'They match: mark as verified'));
  }
  // ---- who's online in a hub, for the hub bar: in voice or not, what they share, and what they're looking at ----
  // share: their broadcast, or their watch-together. sees: someone's broadcast or watch-together they're watching, else the
  // screen their Drift shows (hub.js 'where': Scenes, Media, Surf, which in a hub is its shared browser, or Share).
  const SCREEN_NAMES = { scenes: 'Scenes', media: 'Media', surf: 'Surf', broadcast: 'Share' };
  function presence(x) {
    const bcs = x.bcs || [], lives = x.lives || [];
    return x.members.filter((m) => m.online).map((m) => {
      const id = m.id, isMe = id === info.me.id, who = isMe ? 'You' : nameOf(x, id), v = vEntry(x, id);
      const voice = v && v.listen ? v : null, myBc = bcs.find((b) => b.from === id), myLv = lives.find((l) => l.from === id);
      const share = myBc ? { kind: 'bc', b: myBc } : myLv ? { kind: 'live', l: myLv } : null;
      const inBc = bcs.find((b) => b.from !== id && b.viewers.includes(id)), inLv = lives.find((l) => l.from !== id && l.watching.includes(m.name));
      const sees = inBc ? { kind: 'bc', b: inBc } : inLv ? { kind: 'live', l: inLv } : SCREEN_NAMES[m.at] ? { kind: 'tab', at: m.at } : null;
      return { id, isMe, who, voice, muted: !!voice && !(voice.talk && voice.mic), lock: voice && !isMe ? lockOf(x, id) : null, share, sees };
    });
  }
  function presenceText(x, p) {
    const bits = [p.who + (p.voice ? (p.muted ? ' · in voice, muted' : ' · in voice') : '')];
    if (p.share) bits.push(p.share.kind === 'bc' ? `Live: ${p.share.b.title || 'a broadcast'}` : `Sharing to watch together${p.share.l.title ? ': ' + p.share.l.title : ''}`);
    if (p.sees && !p.share) bits.push(p.sees.kind === 'bc' ? `Watching ${p.sees.b.from === info.me.id ? 'your' : nameOf(x, p.sees.b.from) + '\'s'} broadcast` : p.sees.kind === 'live' ? `Watching with ${nameOf(x, p.sees.l.from)}` : `On ${SCREEN_NAMES[p.sees.at]}`);
    if (p.lock) bits.push(p.lock.text);
    if (!p.isMe && (p.share || p.sees)) bits.push('Click to go there');
    return bits.join('\n');
  }
  // One face in the hub bar: a headset badge while they're in voice (a red slashed mic, and a red ring, while they're muted),
  // and an outer ring, with a screen badge, while they're sharing. A click takes you to what they share, or what they see.
  function personFace(x, p) {
    const tag = p.share ? (p.share.kind === 'bc' ? '.bc' : '.lv') : '';
    return h('button.cbFace' + (p.voice ? '.inCall' : '.away') + (p.muted ? '.muted' : '') + (p.share ? '.sharing' + tag : '') + (p.isMe ? '.me' : ''),
      { 'data-speak': p.id, 'data-member': p.id, title: presenceText(x, p), 'aria-label': presenceText(x, p).replace(/\n/g, '. '), onclick: () => jumpTo(x, p) },
      face(x, p.id, '.small'),
      p.lock && p.lock.kind === 'bad' ? h('i', {}, '!') : null,
      p.share ? h('b.cbShare', {}, icon(p.share.kind === 'bc' ? 'screen' : 'film')) : null,
      p.voice ? h('b.cbCall', {}, icon('join')) : null,
      p.muted ? h('b.cbMuted', {}, icon('micOff')) : p.sees && SEES_ICON(p.sees) ? h('b.cbWhere', {}, icon(SEES_ICON(p.sees))) : null);
  }
  // the little icon in the corner the mute badge takes (muted wins): the tab they're on, or what they're watching
  const TAB_ICONS = { scenes: 'sparkle', media: 'film', surf: 'globe', broadcast: 'screen' };
  const SEES_ICON = (s) => (s.kind === 'bc' ? 'screen' : s.kind === 'live' ? 'film' : TAB_ICONS[s.at]);
  async function jumpTo(x, p) {
    if (p.isMe) return;
    const t = p.share || p.sees, ui = window.appUI;
    if (!t) return toast(`${p.who} isn't sharing anything, and their Drift doesn't say what it shows.`);
    if (t.kind === 'bc') {
      if (t.b.from === info.me.id) return toast(`${p.who} is watching your broadcast.`);
      const r = await call('bcWatch', x.id, t.b.id, ui && ui.key, true);
      if (r && r.error) toast(r.error);
    } else if (t.kind === 'live') {
      if (t.l.from === info.me.id) return toast(`${p.who} is watching what you share.`);
      if (p2p.role === 'guest' && joined === t.l.code) { if (ui) ui.setTab('media'); return; }       // (already watching it with them)
      joinLive(x, t.l);
    } else if (ui) ui.setTab(t.at);       // Scenes, Media, Share, or Surf (the hub's shared browser)
  }
  // ---- the hub bar over the scenes, on every screen while you're online in a hub's voice room or watching together ----
  // Join voice / Disconnect, Mute and Leave hub are always one click away. With no input it fades into the scene (style.css, body.idle),
  // but never while your microphone is open (.hot).
  function drawCall() {
    const bar = $('#callBar'), c = info.call, live = info.live, x = info.hubs.find((y) => y.id === activeHubId() && y.status === 'connected');
    const inRoom = !!(x && x.room && x.room.in), watching = p2p.role === 'host' || p2p.role === 'guest';
    if (!inRoom && !watching) { bar.classList.remove('on', 'hot'); bar.replaceChildren(); document.documentElement.style.setProperty('--cbw', '0px'); return; }
    // A rail down the left edge (style.css #callBar): the hub's monogram, who's in voice, then the buttons (icons; each one's
    // title says what it does), then what's being shared. Hovering it opens a card beside it that says it all in words.
    let head;
    const fly = [], acts = [], tail = [];
    const ptrOn = shareSet.cursor !== false;       // (on by default: main.js state.share.cursor)
    // named for what a click does, and red while it's off, as Mute / Unmute is
    const cursorBtn = h('button.cbBtn.cbCursor' + (ptrOn ? '' : '.muted'), {
      title: ptrOn ? 'Hide cursor: others see your cursor over broadcasts you watch full screen and over a paused shared video' : 'Show cursor: it\'s hidden from everyone now. Let others see where you point over broadcasts and a paused shared video',
      'aria-pressed': ptrOn ? 'true' : 'false', onclick: () => api.patch({ share: { cursor: !ptrOn } }),
    }, icon(ptrOn ? 'cursor' : 'cursorOff'), ptrOn ? 'Hide cursor' : 'Show cursor');
    if (inRoom) {
      const n = c && c.hub === x.id ? e2eNote(x) : { text: '' };
      const inVoice = (x.voice || []).filter((v) => v.listen);       // everyone in voice, a red ring and a slashed mic on whoever is muted
      const mic = !voiceSet.talk ? '' : live && live.mic === 'none' ? 'No microphone' : live && live.mic === 'open' ? `Hold ${KEY_NAMES[voiceSet.pttKey] || 'the key'} to talk` : '';
      // everyone online in the hub, in voice or not: sharing first, then those in voice, then the rest (blocked people left out)
      const people = presence(x).filter((p) => !info.blocked.includes(p.id)), rank = (p) => (p.share ? 0 : p.voice ? 1 : 2);
      people.sort((a, b) => rank(a) - rank(b) || (a.id === info.me.id) - (b.id === info.me.id));
      const many = people.length > 6, shown = many ? people.slice(0, 5) : people;       // (a big hub: five faces and "+N")
      head = h('span.cbHead', { title: n.text || x.name || 'Hub' }, [...(x.name || 'Hub').trim()][0].toUpperCase());
      fly.push(h('b.cbName', {}, n.ok ? h('span.lock.ok', {}, '🔒') : null, x.name || 'Hub'),
        h('span.cbLine', {}, `${people.length} online · ${inVoice.length ? `${inVoice.length} in voice${n.ok ? ' · encrypted' : ''}` : 'nobody in voice'}`),
        mic ? h('span.cbLine.cbMic', {}, mic) : null);
      if (people.length) acts.push(h('span.cbFaces', {}, shown.map((p) => personFace(x, p)),
        many ? h('span.cbMore', { title: people.slice(5).map((p) => p.who).join('\n') }, '+' + (people.length - 5)) : null), h('span.cbSep'));
      acts.push(joinButton('cbBtn', x),
        voiceSet.deaf ? null : talkButton('cbBtn'),
        cursorBtn,
        h('button.cbBtn.leave', { title: `Go offline from ${x.name}: stop hearing it and stop showing as online. Press Connect to come back.`, onclick: () => call('disconnect', x.id) }, icon('door'), 'Leave hub'));
    } else head = h('span.cbHead.cbHeadIco', { title: 'Watching together' }, icon('film'));
    if (inRoom) {       // broadcasts (docs/plans/broadcast.md §5, §12): yours always shows, with Stop one click away
      const mine = info.bc && info.bc.mine && info.bc.mine.hub === x.id ? info.bc.mine : null, others = (x.bcs || []).filter((b) => b.from !== info.me.id);
      if (mine) {
        const n = ((x.bcs || []).find((b) => b.id === mine.id) || { viewers: [] }).viewers.length;
        const what = `Live · ${mine.title}${bcLiveS && bcLiveS.paused ? ' (paused)' : ''}`;
        fly.push(h('span.cbLine.cbLive', {}, h('i.cbPip'), what, h('em', {}, n ? ` · ${n} watching` : ' · nobody watching yet')));
        tail.push(h('button.cbBtn.leave.cbRec', { title: `Stop your broadcast (${what})`, onclick: () => call('bcStop') }, icon('stop'), 'Stop'));
      }
      if (bcViewS) {
        fly.push(h('span.cbLine', {}, `Watching ${bcViewS.who.join(' and ')}`));
        tail.push(h('button.cbBtn', { title: `Stop watching ${bcViewS.who.join(' and ')}`, onclick: () => bcViewS.ids.forEach((id) => call('bcUnwatch', id)) }, icon('stop'), 'Stop watching'));
      } else if (others.length) {
        const b = others[0], who = `${nameOf(x, b.from)} is live${others.length > 1 ? ` (+${others.length - 1})` : ''}`;
        fly.push(h('span.cbLine', { title: others.map((o) => `${nameOf(x, o.from)} · ${o.title}`).join('\n') }, h('i.cbPip'), who));
        tail.push(h('button.cbBtn.cbWatchBc', { title: `${who}: watch it on this screen (the Share tab shows everyone who's live)`, onclick: () => call('bcWatch', x.id, b.id, window.appUI && window.appUI.key, true).then((r) => { if (r && r.error) toast(r.error); }) }, icon('play'), 'Watch'));
      }
    }
    if (watching) {
      const host = p2p.role === 'host', n = (p2p.peers || []).length;
      const what = host ? (n ? `Sharing · ${n} watching` : 'Sharing') : `Watching with ${p2p.host || 'a friend'}`;
      if (!inRoom) fly.push(h('b.cbName', {}, 'Watching together'));
      fly.push(h('span.cbLine.cbWatch', { title: host ? (p2p.peers || []).map((p) => p.name || p).join(', ') : '' }, h('i.cbPip.green'), what));
      if (!inRoom) acts.push(cursorBtn);       // (in the hub's room it's already beside Mute)
      tail.push(h('button.cbBtn.leave' + (host ? '.cbRec' : ''), { title: host ? `Stop sharing with everyone (${what})` : 'Stop watching together', 'data-n': host && n ? String(n) : undefined, onclick: () => api.cmd({ type: 'share-stop' }) },
        icon(host ? 'stop' : 'door'), host ? 'Stop sharing' : 'Leave'));       // (data-n: how many are watching, a badge on it)
    }
    bar.replaceChildren(...[head, h('div.cbFly', {}, ...fly.filter(Boolean)), ...acts, tail.length ? h('span.cbSep') : null, ...tail].filter(Boolean));       // (a null here would show as the word "null")
    bar.classList.add('on');
    document.documentElement.style.setProperty('--cbw', bar.offsetWidth + 'px');       // Surf's bar leaves room for it beside them (style.css)
    if (!bar.cbwWatch) (bar.cbwWatch = new ResizeObserver(() => { if (bar.classList.contains('on')) document.documentElement.style.setProperty('--cbw', bar.offsetWidth + 'px'); })).observe(bar);       // (and again whenever it changes size)
    bar.classList.toggle('hot', inRoom && (!!voiceSet.talk || !!(info.bc && info.bc.mine)));       // never faded while your mic is open or you're live
    speaking();
  }
  const KEY_NAMES = { backquote: '`', rctrl: 'Right Ctrl', mouse4: 'the mouse\'s back button', mouse5: 'the mouse\'s forward button' };
  // The speaking rings change many times a second: set in place, without drawing anything again.
  function speaking() {
    const on = new Set((info.live && info.live.speaking) || []);
    for (const el of document.querySelectorAll('[data-speak]')) el.classList.toggle('speaking', on.has(el.dataset.speak));
  }
  let liveKey = '';
  function onVoice(live) {
    info.live = live;
    const key = JSON.stringify(live && { mic: live.mic, peers: live.peers });
    if (key !== liveKey) { liveKey = key; drawSide(); drawCall(); }
    speaking();
  }
  let voiceSet = {}, bcViewS = null, bcLiveS = null;       // the broadcast you're watching (main.js state), and yours (for Paused)
  function drawVoiceOpts() {
    $('#vcDirect').checked = !!voiceSet.direct; $('#vcPtt').checked = !!voiceSet.ptt; $('#vcKey').value = voiceSet.pttKey || 'backquote'; $('#vcKeep').checked = !!voiceSet.keepMic;
    $('#vcKey').disabled = !voiceSet.ptt;
    $('#vcNs').value = voiceSet.ns || 'strong';
    fillDevices($('#vcMic'), 'audioinput', voiceSet.mic, 'Microphone');
    fillDevices($('#vcOut'), 'audiooutput', voiceSet.out, 'Speakers');
    if (mt && mt.key !== micKey()) micTest(true);       // a new microphone or suppression: test that instead
  }

  // ---- Options' microphone test: opens the microphone as the voice room would (mic.js: the device and the suppression
  // chosen above) and shows its level: faint, what the microphone picks up; green, what the others would hear. Nothing is
  // sent. It closes when you press Stop, when the Voice card goes out of sight, or after two minutes. ----
  let mt = null;       // { key, ctx, mic, raf, timer }
  const micKey = () => JSON.stringify([voiceSet.mic || {}, voiceSet.ns || 'strong']);
  const meter = $('#vcMeter'), testBtn = $('#vcTest'), testNote = $('#vcTestNote');
  const TEST_IDLE = 'See what the others would hear. Nothing is sent.';
  function drawMicTest(note) {
    testBtn.textContent = mt ? 'Stop' : 'Test';
    meter.classList.toggle('on', !!(mt && mt.mic));
    meter.querySelector('.raw').hidden = !(mt && mt.mic && mt.mic.ns === 'strong');
    testNote.textContent = note || (!mt ? TEST_IDLE : !mt.mic ? 'Opening your microphone…'
      : mt.mic.ns === 'strong' ? 'Faint: what your microphone picks up. Green: what the others hear.' : 'Green: what the others hear.');
  }
  async function micTest(on) {
    if (mt) {
      const x = mt; mt = null;
      cancelAnimationFrame(x.raf); clearTimeout(x.timer);
      if (x.mic) x.mic.close();
      x.ctx.close().catch(() => {});
    }
    drawMicTest();
    if (!on) return;
    const x = mt = { key: micKey(), ctx: new AudioContext({ sampleRate: 48000 }), mic: null };       // (RNNoise's rate)
    let mic;
    try { mic = await window.driftMic.open(x.ctx, { mic: voiceSet.mic, ns: voiceSet.ns || 'strong' }); } catch (e) {
      if (mt === x) { mt = null; x.ctx.close().catch(() => {}); drawMicTest(/NotFound|Overconstrained/.test(e.name) ? 'No microphone found.' : 'Couldn\'t open your microphone: ' + e.message); }
      return;
    }
    if (mt !== x) { mic.close(); return; }       // stopped while it opened
    x.mic = mic;
    x.timer = setTimeout(() => { if (mt === x) micTest(false); }, 120000);
    const tap = (node) => { const a = x.ctx.createAnalyser(); a.fftSize = 1024; node.connect(a); return a; };
    const aRaw = tap(mic.src), aOut = tap(mic.out), buf = new Float32Array(1024), shown = { raw: 0, out: 0 };
    x.levels = () => ({ raw: level(aRaw), out: level(aOut) });       // (for main.js's checks: hidden windows draw no frames)
    const bars = { raw: meter.querySelector('.raw'), out: meter.querySelector('.out') };
    const level = (a) => {       // 0..1 across -60..0 dB
      a.getFloatTimeDomainData(buf);
      let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      return Math.max(0, Math.min(1, 1 + (10 * Math.log10(s / buf.length + 1e-12)) / 60));
    };
    const frame = () => {
      if (mt !== x) return;
      for (const [k, a] of [['raw', aRaw], ['out', aOut]]) {
        shown[k] = Math.max(level(a), shown[k] - 0.025);       // rises at once, falls gently
        bars[k].style.transform = `scaleX(${shown[k].toFixed(3)})`;
      }
      x.raf = requestAnimationFrame(frame);
    };
    drawMicTest();
    frame();
  }
  testBtn.addEventListener('click', () => micTest(!mt));
  new IntersectionObserver((es) => { if (mt && !es.some((e) => e.isIntersecting)) micTest(false); }).observe(meter);
  // The microphones and speakers Windows has, for the Voice card's lists. Kept by id and name: the voice window
  // (renderer/voice.js) finds the device again by its name if the id changes. A chosen one that's unplugged stays listed.
  let devs = [];
  async function listDevices() {
    try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { devs = []; }
    drawVoiceOpts();
  }
  function fillDevices(sel, kind, want, noun) {
    want = want || {};
    const list = devs.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${noun} ${i + 1}` }));
    const hit = list.find((d) => want.id && d.id === want.id) || list.find((d) => want.label && d.label === want.label);
    const gone = !hit && (want.id || want.label) ? want.id || 'gone' : '';
    if (gone) list.push({ id: gone, label: `${want.label || noun} (not connected)` });
    const key = JSON.stringify(list);
    if (sel.dataset.key !== key) {       // (rebuilt only when the list changes, so an open list isn't closed under you)
      sel.dataset.key = key;
      sel.replaceChildren(h('option', { value: '' }, 'Windows default'), ...list.map((d) => h('option', { value: d.id }, d.label)));
    }
    sel.value = hit ? hit.id : gone;
  }
  const pickDevice = (sel, field) => {
    const d = devs.find((x) => x.deviceId && x.deviceId === sel.value);
    api.patch({ voice: { [field]: !sel.value ? { id: '', label: '' } : d ? { id: d.deviceId, label: d.label } : voiceSet[field] } });
  };
  $('#vcMic').addEventListener('change', (e) => pickDevice(e.target, 'mic'));
  $('#vcOut').addEventListener('change', (e) => pickDevice(e.target, 'out'));
  $('#vcNs').addEventListener('change', (e) => api.patch({ voice: { ns: e.target.value } }));
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', listDevices);
  listDevices();
  $('#vcDirect').addEventListener('change', (e) => api.patch({ voice: { direct: e.target.checked } }));
  $('#vcPtt').addEventListener('change', (e) => api.patch({ voice: { ptt: e.target.checked } }));
  $('#vcKey').addEventListener('change', (e) => api.patch({ voice: { pttKey: e.target.value } }));
  $('#vcKeep').addEventListener('change', (e) => api.patch({ voice: { keepMic: e.target.checked } }));

  // ---- Hub sounds (renderer/sfx.js plays them; main.js decides when) ----
  let sfxSet = { on: true, volume: 0.7 };
  const SFX_TRY = [['connect', 'Online'], ['disconnect', 'Offline'], ['lost', 'Dropped'], ['join', 'Join voice'], ['leave', 'Leave voice'],
    ['peerJoin', 'Friend joins'], ['peerLeave', 'Friend leaves'], ['mute', 'Mute'], ['unmute', 'Unmute'], ['liveOn', 'Go live'], ['liveOff', 'Stop live'],
    ['viewerJoin', 'Viewer joins'], ['viewerLeave', 'Viewer leaves'], ['bcStart', 'Friend goes live'], ['shareOn', 'Watch together'], ['shareOff', 'Stop watching'], ['message', 'Message']];
  $('#sfxTry').replaceChildren(...SFX_TRY.map(([name, label]) => h('button.mini', { title: 'Play this sound', onclick: () => api.cmd({ type: 'sfx', name, preview: true }) }, '▶ ' + label)));
  function drawSfxOpts() {
    const r = $('#sfxVol');
    $('#sfxOn').checked = sfxSet.on !== false;
    if (document.activeElement !== r) r.value = sfxSet.volume;
    r.style.setProperty('--fill', sfxSet.volume * 100 + '%');
    $('#o-sfxVol').textContent = Math.round(sfxSet.volume * 100) + '%';
  }
  $('#sfxOn').addEventListener('change', (e) => api.patch({ sfx: { on: e.target.checked } }));
  $('#sfxVol').addEventListener('input', (e) => api.patch({ sfx: { volume: +e.target.value } }));
  $('#sfxVol').addEventListener('change', () => api.cmd({ type: 'sfx', name: 'join', preview: true }));       // let go: hear how loud that is

  // ---- loading and keeping up ----
  async function load(hub, ch) {
    const k = keyOf(hub, ch);
    if (!ch || (cache.get(k) || {}).loading) return;
    const got = cache.get(k) || { msgs: [], more: true, loading: false };
    got.loading = true; cache.set(k, got);
    const r = await call('history', hub, ch, { limit: 50 });
    got.loading = false;
    if (r.error) { drawList(); return; }
    got.msgs = r.msgs; got.more = r.msgs.length >= 50;
    if (sel.hub === hub && sel.ch === ch) drawList(true);
  }
  async function older(hub, ch) {
    const got = cache.get(keyOf(hub, ch));
    if (!got || got.loading || !got.msgs.length) return;
    got.loading = true; drawList();
    const list = $('#chList'), from = list.scrollHeight - list.scrollTop;
    const r = await call('history', hub, ch, { before: got.msgs[0].id, limit: 50 });
    got.loading = false;
    if (!r.error) { got.msgs = [...r.msgs, ...got.msgs]; got.more = r.msgs.length >= 50; }
    drawList(); list.scrollTop = list.scrollHeight - from;
  }
  let toldHub = null;
  const tellHub = () => { if (sel.hub !== toldHub) { toldHub = sel.hub; call('voiceHub', sel.hub); } };       // the hub open here is your active hub (unless one is kept)
  function pick(hub, ch) {
    sel = { hub, ch }; keep(); mode = null; tellHub(); noteCh(hub, ch);
    if (attach) dropAttach();
    if (pickOpen) closePick();
    unread.delete(keyOf(hub, ch));
    drawAll(true);
    if (ch && !cache.has(keyOf(hub, ch))) load(hub, ch);
  }
  function reload() { cache.clear(); refresh().then(() => { if (sel.ch) load(sel.hub, sel.ch); }); }
  async function refresh() {
    const r = await call('info');
    if (!r.error && r.hubs) onInfo(r);
  }
  function onInfo(next) {
    info = next;
    document.body.classList.toggle('inHub', info.hubs.some((y) => y.status === 'connected'));       // (Surf's bar shows its chat button)
    drawHelp();
    if (!hubNow() && info.hubs.length) sel = { hub: info.hubs[0].id, ch: 0 };
    const x = hubNow();
    if (x && !x.channels.some((c) => c.id === sel.ch)) sel.ch = (x.channels[0] || {}).id || 0;
    liveKey = JSON.stringify(info.live && { mic: info.live.mic, peers: info.live.peers });
    keep(); tellHub(); drawSide(); drawLives(); drawHead(); drawTyping(); drawMe(); drawCall(); drawVote();
    if (x && sel.ch && !cache.has(keyOf(x.id, sel.ch)) && x.status === 'connected') load(x.id, sel.ch);
    else drawList();
  }
  function onEvent(hub, m) {
    if (m.t === 'ready') {       // (re)connected: whatever is cached may be out of date
      for (const k of [...cache.keys()]) if (k.startsWith(hub + ':')) cache.delete(k);
      if (hub === sel.hub && sel.ch) load(hub, sel.ch);
      return;
    }
    if (m.t === 'msg') {
      const k = keyOf(hub, m.msg.ch), got = cache.get(k);
      if (got) {
        const i = got.msgs.findIndex((y) => y.id === m.msg.id);
        if (i >= 0) got.msgs[i] = m.msg; else if (!got.msgs.length || m.msg.id > got.msgs[got.msgs.length - 1].id) got.msgs.push(m.msg);
      }
      const t = typing.get(k); if (t && !m.again) t.delete(m.msg.from);
      const here = hub === sel.hub && m.msg.ch === sel.ch && looking();
      if (!here && m.msg.from !== info.me.id && !m.msg.edited && !m.again) unread.set(k, (unread.get(k) || 0) + 1);
      if (hub === sel.hub && m.msg.ch === sel.ch) { drawList(m.msg.from === info.me.id); drawTyping(); }
      drawSide();
      return;
    }
    if (m.t === 'react') {
      const got = cache.get(keyOf(hub, m.ch)), msg = got && got.msgs.find((y) => y.id === m.id);
      if (msg) msg.reacts = Array.isArray(m.reacts) ? m.reacts : [];
      if (msg && hub === sel.hub && m.ch === sel.ch) drawList();
      return;
    }
    if (m.t === 'gone') {
      const got = cache.get(keyOf(hub, m.ch));
      if (got) got.msgs = got.msgs.filter((y) => y.id !== m.id);
      if (mode && mode.msg.id === m.id) setMode(null);
      if (hub === sel.hub && m.ch === sel.ch) drawList();
      return;
    }
    if (m.t === 'typing') {
      const k = keyOf(hub, m.ch);
      if (!typing.has(k)) typing.set(k, new Map());
      typing.get(k).set(m.from, Date.now() + 4000);
      drawTyping(); setTimeout(drawTyping, 4100);
    }
  }
  // A new message, on the one screen main.js picked: a note at the top unless this channel is open right here.
  let toastTimer = null;
  function toast(text) { const t = $('#toast'); t.textContent = text; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3500); }
  function onNotify(hub, msg, over) {
    if (over && overlaySetting !== 'off') {       // watching something of this hub's: over it, if it's for the overlay
      const x = info.hubs.find((y) => y.id === hub);
      if ((overlaySetting === 'all' || !canBeHeard(x, msg.from)) && !(hub === sel.hub && msg.ch === sel.ch && looking())) { overlayShow(x, msg); if (msg.from !== info.me.id) api.cmd({ type: 'sfx', name: 'message' }); }
      return;
    }
    if (msg.from === info.me.id || (hub === sel.hub && msg.ch === sel.ch && looking())) return;
    if (coLogOn(hub, msg.ch)) { overlayShow(info.hubs.find((y) => y.id === hub), msg, COLOG_MS); api.cmd({ type: 'sfx', name: 'message' }); return; }       // its log is up: it joins it
    const x = info.hubs.find((y) => y.id === hub), c = x && x.channels.find((y) => y.id === msg.ch);
    toast(`${nameOf(x, msg.from)} in #${c ? c.name : '?'}: ${(msg.text || picWord(msg)).replace(/\s+/g, ' ').slice(0, 90)}`);
    api.cmd({ type: 'sfx', name: 'message' });       // (main.js sends a new message to one screen only, so it's heard once)
  }

  // ---- writing ----
  const input = $('#chInput');
  function setMode(kind, msg) {
    mode = kind ? { kind, msg } : null;
    if (kind === 'edit') input.value = msg.text;
    else if (!kind && input.dataset.editing) input.value = '';
    input.dataset.editing = kind === 'edit' ? '1' : '';
    drawMode(); fit(); input.focus();
  }
  function drawMode() {
    const bar = $('#chBar');
    bar.classList.toggle('on', !!mode);
    if (mode) $('#chBarText').textContent = mode.kind === 'edit' ? 'Editing your message · Enter saves, Esc cancels' : `Replying to ${nameOf(hubNow(), mode.msg.from)} · Esc cancels`;
  }
  const fit = () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; };
  let lastTyped = 0;
  input.addEventListener('input', () => {
    fit();
    if (Date.now() - lastTyped > 2500 && input.value.trim() && !mode?.kind?.startsWith('edit')) { lastTyped = Date.now(); call('typing', sel.hub, sel.ch); }
  });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape' && attach) { e.preventDefault(); dropAttach(); return; }
    if (e.key === 'Escape' && mode) { e.preventDefault(); setMode(null); return; }
    if (e.key === 'ArrowUp' && !input.value) {       // the last thing you said, to fix
      const got = cache.get(keyOf(sel.hub, sel.ch)), mine = got && [...got.msgs].reverse().find((m) => m.from === info.me.id);
      if (mine) { e.preventDefault(); setMode('edit', mine); }
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    const text = input.value.trim(), m = mode, a = m && m.kind === 'edit' ? null : attach;
    if (!text && !a) { if (m && m.kind === 'edit') setMode(null); return; }
    input.disabled = true;
    if (a) { $('#chAttachText').textContent = a.file ? `Reading ${a.name} to make its check…` : 'Sending…'; a.sending = true; }
    const r = m && m.kind === 'edit' ? await call('edit', sel.hub, m.msg.id, text)
      : a && a.file ? await call('offerFile', sel.hub, sel.ch, a.path, text, m && m.kind === 'reply' ? m.msg.id : undefined)
      : a ? await call('sendFile', sel.hub, sel.ch, a.bytes, a.w, a.h, text, m && m.kind === 'reply' ? m.msg.id : undefined)
      : await call('send', sel.hub, sel.ch, text, m && m.kind === 'reply' ? m.msg.id : undefined);
    input.disabled = false; input.focus();
    if (a) a.sending = false;
    if (r.error) { toast(r.error); if (a && attach === a) $('#chAttachText').textContent = 'Not sent · Enter tries again, Esc drops it'; return; }
    if (a && attach === a) dropAttach();
    input.value = ''; mode = null; input.dataset.editing = ''; fit(); drawMode();
  });
  $('#chBarX').addEventListener('click', () => setMode(null));

  // ---- hubs: joining, hosting, inviting ----
  async function join() {
    const code = $('#chCode').value.trim();
    if (!code) { $('#chCode').focus(); return; }
    const r = await call('join', code);
    if (r.error) { toast(r.error); return; }
    $('#chCode').value = '';
    if (r.watching) return;       // an old watch-together code: joined their video, no hub
    sel = { hub: r.id, ch: 0 }; keep(); refresh();
  }
  $('#chJoin').addEventListener('click', join);
  $('#chCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  // Host / Stop hosting, at the bottom: starts this PC's hub and goes online in it (making one the first time).
  function drawHostBtn() {
    const b = $('#chHost'), start = !!info.canHost;
    b.className = 'btn hostBtn ' + (start ? 'start' : 'stop');
    b.title = start ? (info.hostName ? `Start ${info.hostName} and go online in it. Friends can join while it runs.` : 'Make a hub of your own: channels to chat in and a place to watch together. It runs in your Drift.')
      : 'Stop your hub for everyone. Its invites still work when you host again.';
    b.replaceChildren(icon(start ? 'play' : 'stop'), start ? 'Host' : 'Stop hosting');
  }
  $('#chHost').addEventListener('click', async () => {
    if (!info.canHost) {
      const mine = info.hubs.find((y) => y.mine), others = mine ? mine.members.filter((p) => p.online && p.id !== info.me.id).length : 0;
      if (others && !(await ask({ title: 'Stop hosting?', note: `${others === 1 ? 'The 1 person' : `The ${others} people`} here will be disconnected.`, yes: 'Stop hosting' }))) return;
      const r = await call('unhost'); if (r.error) toast(r.error);
      refresh(); return;
    }
    const r = await call('host', '');
    if (r.error) { toast(r.error); return; }
    if (r.hosting) { sel = { hub: r.hosting.id, ch: 0 }; keep(); }
    refresh();
  });
  async function invite(x) {
    const r = await call('invite', x.id);
    toast(r.error || 'Invite copied. Friends paste it into Drift\'s Chat tab. It works for 7 days.');
  }
  async function withdraw(x) {
    if (!(await ask({ title: 'Withdraw every invite?', note: 'Every invite code made so far stops working. People already in the hub stay.', yes: 'Withdraw invites' }))) return;
    const r = await call('withdrawInvites', x.id);
    toast(r.error || 'Every invite so far has stopped working.');
  }
  async function removePerson(x, p) {
    if (!(await ask({ title: `Remove ${p.name} from ${x.name}?`, note: 'They\'re disconnected now and can\'t come back, even with a new invite.', yes: 'Remove' }))) return;
    const r = await call('removeMember', x.id, p.id);
    if (r.error) toast(r.error);
  }
  // + New channel turns into a box for the name, in its place. Enter makes it; Escape or clicking away turns it back.
  // The box is kept across drawSide (which draws the list again whenever anything changes) so typing isn't lost.
  let newChan = null;       // { hub, input }
  function makeChannel(x) {
    const input = h('input.chNew', { type: 'search', placeholder: 'channel-name', maxlength: '32', spellcheck: 'false' });
    const done = () => { if (newChan && newChan.input === input) { newChan = null; drawSide(); } };
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(); return; }
      if (e.key !== 'Enter' || !input.value.trim()) return;
      const r = await call('channel', x.id, input.value);
      if (r.error) { toast(r.error); return; }
      done(); pick(x.id, r.ch);
    });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) done(); }, 0));       // (not when drawSide put it back)
    newChan = { hub: x.id, input };
    drawSide(); input.focus();
  }

  // ---- seeing the tab: what's showing counts as read ----
  const markRead = () => { if (looking() && sel.ch && unread.delete(keyOf(sel.hub, sel.ch))) drawSide(); };
  new MutationObserver(markRead).observe($('section[data-tab="hub"]'), { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(markRead).observe($('#panel'), { attributes: true, attributeFilter: ['class'] });

  // ---- options (name, control, quality...) take the chat's place while open ----
  // Help (forwarding ports for friends elsewhere) takes it the same way, filled in with this PC's own address and ports
  const opts = (on) => { $('#chat').classList.toggle('opts', on); if (on) $('#chat').classList.remove('help'); if (!on) markRead(); };
  $('#shOptsBtn').addEventListener('click', () => opts(!$('#chat').classList.contains('opts')));
  $('#shOptsDone').addEventListener('click', () => opts(false));
  let shareSet = {};
  const helpVals = () => {
    const ip = p2p.lan || '', hub = (info.hosting && info.hosting.port) || 47900;
    return { ip, router: /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.replace(/\.\d+$/, '.1') : '192.168.1.1', share: (p2p.role === 'host' && p2p.port) || shareSet.port || 47800,
      hub, voice: (info.hosting && info.hosting.voicePort) || hub };
  };
  const drawHelp = () => {
    if (!$('#chat').classList.contains('help')) return;
    const v = helpVals();
    document.querySelectorAll('.hlIp').forEach((e) => { e.textContent = v.ip || "this PC's address (see Settings → Network & internet in Windows)"; });
    $('.hlRouter').textContent = v.router; $('.hlShare').textContent = v.share; $('.hlHub').textContent = v.hub; $('.hlVoice').textContent = v.voice;
    document.querySelectorAll('.hlCopy').forEach((b) => { b.hidden = !v.ip; });
  };
  const help = (on) => { $('#chat').classList.toggle('help', on); if (on) { $('#chat').classList.remove('opts'); drawHelp(); $('#shHelp').scrollTop = 0; } else markRead(); };
  $('#shHelpBtn').addEventListener('click', () => help(!$('#chat').classList.contains('help')));
  $('#shHelpDone').addEventListener('click', () => help(false));
  document.querySelectorAll('.hlCopy').forEach((b) => b.addEventListener('click', () => {
    navigator.clipboard.writeText(helpVals().ip).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); }, () => {});
  }));
  api.on('state', (s) => {
    const was = p2p.role;
    p2p = s.p2p || { role: 'off' };
    const curWas = shareSet.cursor;
    shareSet = s.share || {}; drawHelp();
    if (shareSet.cursor !== curWas) drawCall();
    overlaySetting = (s.share && s.share.overlay) || 'all';
    const vs = JSON.stringify(s.voice || {});
    if (vs !== JSON.stringify(voiceSet)) { voiceSet = s.voice || {}; drawVoiceOpts(); drawSide(); drawCall(); }
    if (s.sfx && JSON.stringify(s.sfx) !== JSON.stringify(sfxSet)) { sfxSet = s.sfx; drawSfxOpts(); }
    const gk = (s.gif && s.gif.key) || '';
    if (gk !== gifKey) { gifKey = gk; if (document.activeElement !== $('#gifKey')) $('#gifKey').value = gk; if (pickOpen && pickOpen.kind === 'gif') drawGif().focus(); }
    if (p2p.role !== 'guest') joined = '';
    if (p2p.role === 'off' && was !== 'off') { coList.replaceChildren(); closeCompose(); }       // the session is over: so is its chat over the video
    if (was !== p2p.role) drawLives();
    const pk = JSON.stringify([p2p.role, p2p.host, (p2p.peers || []).length]);
    if (pk !== p2pKey) { p2pKey = pk; drawCall(); }
    bcViewHub = s.bcView ? s.bcView.hub : '';
    const on = s.bcView ? s.bcView.tiles.filter((t) => t.live) : [];       // the broadcasts playing in the Broadcast scene
    const bv = on.length ? { ids: on.map((t) => t.bc), who: on.map((t) => t.who) } : null;
    if (JSON.stringify(bv) !== JSON.stringify(bcViewS)) { bcViewS = bv; drawCall(); }
  });
  let p2pKey = '', bcViewHub = '';

  // ---- your picture (Options) ----
  function drawMe() {
    $('#meFace').replaceChildren(face(null, info.me.id, '.big'));
    $('#meFaceDrop').style.display = info.me.av ? '' : 'none';
  }
  $('#meFacePick').addEventListener('click', () => $('#meFaceFile').click());
  $('#meFaceDrop').addEventListener('click', () => call('setAvatar', '').then((r) => r.error && toast(r.error)));
  // The picture is made here: cut to a square, drawn small and saved again as WebP. That drops everything else the file
  // carried (where a photo was taken, the camera...), and keeps it small enough for every hub to hold.
  $('#meFaceFile').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let bmp = null;
    try { bmp = await createImageBitmap(f); } catch { toast('That picture couldn\'t be opened. Try a PNG or JPEG.'); return; }
    const side = Math.min(bmp.width, bmp.height), cv = document.createElement('canvas'), g = cv.getContext('2d');
    let data = '';
    for (const [px, q] of [[128, 0.85], [128, 0.7], [96, 0.7], [96, 0.5], [64, 0.6]]) {
      cv.width = cv.height = px;
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, px, px);
      data = cv.toDataURL('image/webp', q);
      if (data.length <= 13500) break;
    }
    bmp.close();
    const r = await call('setAvatar', data);
    toast(r.error || 'Your picture is set. Friends see it in every hub you\'re in.');
  });

  // ---- does this PC have a microphone? Hubs show who hasn't, and their messages go over the video ----
  async function checkMic() { try { const d = await navigator.mediaDevices.enumerateDevices(); call('mic', d.some((x) => x.kind === 'audioinput')); } catch { /* can't tell */ } }
  checkMic();
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', checkMic);

  // ---- chat over what you're watching: a video together, the hub's Surf stream, or a broadcast ----
  // Messages from that hub show in a corner of the screen main.js picks (the one showing it) and fade after a while. Enter
  // opens a box to answer in, without opening the panel. Which messages: all of them (the setting's default), or only from
  // people you can't hear: someone counts as heard only while you're connected to them in the hub's voice room and they
  // pressed Talk with a working microphone, so what they type stays in the tab (they can just say it).
  let overlaySetting = 'all', coTarget = null, coTyped = 0;
  const co = $('#chatOverlay'), coList = $('#coList'), coInput = $('#coInput');
  const canBeHeard = (x, id) => { const v = vEntry(x, id), c = info.call; return !!v && v.listen && v.talk && !!v.mic && !!c && !!x && c.hub === x.id && (c.peers || []).includes(id); };
  const coFade = (row, ms) => { clearTimeout(row.fadeT); row.classList.remove('old'); row.fadeT = setTimeout(() => row.classList.add('old'), ms); };
  function overlayShow(x, msg, ms = 12000) {
    if (msg.id && [...coList.children].some((r) => r.dataset.id === String(msg.id))) return;       // (already in the log)
    const c = x && x.channels.find((y) => y.id === msg.ch);
    const row = h('div.coMsg', { 'data-id': msg.id || '' }, face(x, msg.from, '.co'),
      h('div.coBody', {}, h('b.coName', {}, nameOf(x, msg.from)), x && x.channels.length > 1 && c ? h('em', {}, '#' + c.name) : null, msg.text ? h('span.coText', {}, render(msg.text)) : null, msg.file && x ? pic(x, msg.file, 240, 160) : msg.offer ? h('span.coText', {}, `📄 ${msg.offer.name}`) : null));
    coList.append(row);
    while (coList.children.length > 8) coList.firstChild.remove();
    coFade(row, ms);
  }
  // The quick box written in while not watching anything of that hub's: the channel's last few messages show above it while
  // it's open, and for a while after sending (with what comes into that channel meanwhile), then fade like the rest.
  let coLog = null;       // { hub, ch, until }: the channel whose log is up over the screen
  const COLOG_MS = 10000;
  const coLogOn = (hub, ch) => !!coLog && coLog.hub === hub && coLog.ch === ch && (co.classList.contains('typing') || Date.now() < coLog.until);
  async function coLogFill(hub, ch) {
    coLog = { hub, ch, until: 0 };
    coList.replaceChildren();
    const x = info.hubs.find((y) => y.id === hub), got = cache.get(keyOf(hub, ch));
    const msgs = got && got.msgs.length ? got.msgs : ((await call('history', hub, ch, { limit: 8 })).msgs || []);
    if (!coLogOn(hub, ch)) return;       // (closed, or moved on, while it loaded)
    for (const m of msgs.slice(-8)) overlayShow(x, m, COLOG_MS);
  }
  function coLinger() {       // after sending: the log stays up a while, then fades
    if (coLog) coLog.until = Date.now() + COLOG_MS;
    for (const r of coList.children) coFade(r, COLOG_MS);
  }
  // The hub the quick box writes to: that of what you're watching (a video together, a broadcast), else your active hub (the
  // one whose voice room you're in, or that's open in the Hub tab), else any hub you're online in. '' when you're in none.
  const upHub = (id) => !!id && info.hubs.some((y) => y.id === id && y.status === 'connected' && y.channels.length);
  const watchHub = () => [p2p.chatHub, document.body.classList.contains('bc') && bcViewHub].find(upHub) || '';
  const composeHub = () => watchHub() || [activeHubId(), sel.hub].find(upHub) || (info.hubs.find((y) => upHub(y.id)) || {}).id || '';
  // the channel last open in each hub, so the box writes where you were (the hub open in the tab: its open channel)
  let lastCh = {};
  try { lastCh = JSON.parse(localStorage.getItem('chatLastCh') || '{}') || {}; } catch { /* first time */ }
  const noteCh = (hub, ch) => { if (!hub || !ch || lastCh[hub] === ch) return; lastCh[hub] = ch; try { localStorage.setItem('chatLastCh', JSON.stringify(lastCh)); } catch { /* fine */ } };
  function openCompose() {
    const x = info.hubs.find((y) => y.id === composeHub());
    if (!x || x.status !== 'connected' || !x.channels.length) return false;
    const has = (id) => x.channels.some((c) => c.id === id);
    const ch = sel.hub === x.id && has(sel.ch) ? sel.ch : has(lastCh[x.id]) ? lastCh[x.id] : x.channels[0].id;
    coTarget = { hub: x.id, ch, over: !!watchHub() };
    const several = info.hubs.filter((y) => upHub(y.id)).length > 1;
    $('#coWhere').textContent = (several ? (x.name || 'Hub') + ' · ' : '') + '#' + x.channels.find((c) => c.id === ch).name;
    coInput.placeholder = 'Say something · Enter sends, Esc closes';
    co.classList.add('typing'); coInput.focus();
    if (coTarget.over) coLog = null;
    else if (!coLogOn(x.id, ch)) coLogFill(x.id, ch);
    return true;
  }
  function closeCompose() { co.classList.remove('typing'); coTarget = null; if (document.activeElement === coInput) coInput.blur(); }
  // Enter, while online in a hub and nothing else is using the key: Drift's window has the keyboard, and it's not in a text box,
  // a list or a web page (a button only counts while it's been reached with the keyboard: one just clicked doesn't, nor does a
  // slider, a tick box or a list of choices just used with the mouse, since Enter does nothing to them). With the Hub tab open
  // that's its own message box; anywhere else, the quick box over the screen. Over a Surf page the page is asked first (web.js
  // "Enter"): it keeps Enter while it has a text box selected, and otherwise main.js opens the box with 'chat-quick' (app.js).
  // The chat button over Surf shows while the mouse moves and for 2.5 s after. Over a web page this window doesn't see the mouse,
  // so main.js says when it moves (pointer-moved).
  let coWakeT = 0;
  const coWake = () => { document.body.classList.add('coAwake'); clearTimeout(coWakeT); coWakeT = setTimeout(() => document.body.classList.remove('coAwake'), 2500); };
  addEventListener('mousemove', coWake);
  api.on('cmd', (c) => { if (c && c.type === 'pointer-moved') coWake(); });
  const enterFree = () => {
    const a = document.activeElement;
    if (!a || a === document.body || a.classList.contains('bcVid')) return true;
    if (a.closest('#chPick')) return false;
    if (a.closest('#panel') && !$('#panel').classList.contains('show')) return true;       // left in the panel as it went away: nobody can see it
    if (a.tagName === 'INPUT' && /^(range|checkbox|radio)$/.test(a.type)) return true;       // (Enter does nothing to these, however they were reached)
    return ['BUTTON', 'A', 'SELECT'].includes(a.tagName) && !a.matches(':focus-visible');
  };
  addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.repeat || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!enterFree() || $('#confirm').classList.contains('on') || document.querySelector('.chLight')) return;
    if (looking() && !input.disabled) { e.preventDefault(); input.focus(); return; }
    if (openCompose()) e.preventDefault();
  });
  coInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); coInput.value = ''; closeCompose(); return; }
    if (e.key !== 'Enter') { if (coTarget && Date.now() - coTyped > 2500) { coTyped = Date.now(); call('typing', coTarget.hub, coTarget.ch); } return; }
    e.preventDefault();
    const text = coInput.value.trim();
    if (!text || !coTarget) { closeCompose(); return; }
    const t = coTarget, r = await call('send', t.hub, t.ch, text);
    if (r.error) { toast(r.error); return; }
    coInput.value = ''; closeCompose();
    if (!t.over && r.msg) overlayShow(info.hubs.find((y) => y.id === t.hub), r.msg);       // (not over anything of that hub's, main.js doesn't send it back here)
    coLinger();
  });
  // A vote to change what's on (main.js "media stream"; the hub counts it): a card over the video on every screen, for
  // everyone online in the hub, until they vote or it's decided. The asker sees how it's going and can call it off.
  let voteTick = 0;
  const voteBox = $('#coVote');
  function drawVote() {
    clearTimeout(voteTick);
    const x = info.hubs.find((y) => y.status === 'connected' && y.vote), v = x && x.vote, me = info.me.id;
    if (!v) { voteBox.hidden = true; voteBox.replaceChildren(); return; }
    const self = v.from === me, said = v.yes.includes(me) ? 'yes' : v.no.includes(me) ? 'no' : '', need = Math.floor(v.voters.length / 2) + 1;
    const left = Math.max(0, Math.ceil((v.at + v.ms - Date.now()) / 1000));
    const vote = (yes) => call('mediaVote', x.id, v.id, yes).then((r) => r.error && toast(r.error));
    voteBox.hidden = false;
    // One row: who wants what, the tally and time left, and the buttons; a thin line along the bottom fills with yes votes.
    voteBox.replaceChildren(...[face(x, v.from, '.co.small'),
      h('div.coVoteText', { title: `${self ? 'You' : nameOf(x, v.from)} asked to put on ${v.title || 'something else'}. ${v.yes.length} of ${need} needed to switch.` },
        self ? 'You asked for ' : [h('b', {}, nameOf(x, v.from)), ' wants '], h('b', {}, v.title || 'something else')),
      h('span.coVoteCount', {}, `${v.yes.length}/${need} · ${left}s`),
      self ? h('button.btn.ghost', { onclick: () => call('mediaCancel', x.id, v.id) }, 'Cancel')
        : !v.voters.includes(me) ? null
        : [true, false].map((yes) => {       // both stay, so a vote can be changed; the one picked is lit (before voting, Switch is)
          const lit = said ? said === (yes ? 'yes' : 'no') : yes;
          return h(`button.btn.${lit ? 'primary' : 'ghost'}`, { title: yes ? 'Switch to it' : 'Keep watching what\'s on', onclick: () => vote(yes) }, (yes ? 'Switch' : 'Keep') + (said && lit ? ' ✓' : ''));
        }),
      h('div.coVoteBar', {}, h('i', { style: `width: ${Math.min(100, Math.round((v.yes.length / need) * 100))}%` }))].flat().filter(Boolean));       // (replaceChildren doesn't flatten, as h() does)
    if (left > 0) voteTick = setTimeout(drawVote, 1000);
  }
  coInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== coInput) co.classList.remove('typing'); }, 100));
  // The overlay (chat and the cat) always shows, sitting on the UI: on top of the panel (or its bar) while that shows,
  // at its left end; otherwise down in the corner. Moving, it fades out and back in, and the cat lands somewhere new
  // along that edge (the chat stays at the left). (Measured from the panel's size, not where it is drawn: it slides in.)
  const panelEl = $('#panel');
  let coAt = '', coMove = 0, coPanel = '';
  const lift = () => {
    const on = panelEl.classList.contains('show');
    const at = on ? `${28 + panelEl.offsetHeight}px|${Math.round(innerWidth / 2 - panelEl.offsetWidth / 2 + 22)}px` : '|';
    if (at === coAt) return;
    coAt = at; co.classList.add('moving'); clearTimeout(coMove);
    const pState = on + '/' + panelEl.classList.contains('open');
    if (pState !== coPanel) { coPanel = pState; co.dispatchEvent(new Event('catshoo')); }       // the panel under the cats opened or closed, not just resized (app.js)
    coMove = setTimeout(() => {
      [co.style.bottom, co.style.left] = coAt.split('|');
      co.dispatchEvent(new Event('catmove'));       // the cats land somewhere new along this edge (scatterCats in app.js)
      co.classList.remove('moving');
    }, 220);
  };
  new MutationObserver(lift).observe(panelEl, { attributes: true, attributeFilter: ['class'] });
  new ResizeObserver(lift).observe(panelEl);
  addEventListener('resize', lift);

  api.on('chat', (c) => {
    if (c.type === 'info') onInfo(c.info);
    else if (c.type === 'event') onEvent(c.hub, c.m);
    else if (c.type === 'notify') onNotify(c.hub, c.msg, !!c.overlay);
    else if (c.type === 'voice') onVoice(c.live);
    else if (c.type === 'ft') onFt(c.ft);
    else if (c.type === 'bclive') { const was = !!(bcLiveS && bcLiveS.paused); bcLiveS = c.live; if (was !== !!(c.live && c.live.paused)) drawCall(); }
  });
  refresh();
  call('ftState').then((r) => { if (r && Array.isArray(r.runs)) onFt(r); });
  window.chatUI = { hub: () => sel.hub,       // app.js shares into this hub
    quick: () => openCompose(), closeQuick: () => closeCompose(),       // over Surf (app.js): the chat button, and Enter the page didn't want
    overlay: () => [...coList.children].map((r) => r.innerText.replace(/\n+/g, ' ')), compose: (t) => { if (!openCompose()) return false; coInput.value = t; coInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; },
    info: () => info, sel: () => sel, pick, micTest: () => mt && { ns: mt.mic ? mt.mic.ns : '', ...(mt.levels ? mt.levels() : {}), btn: testBtn.textContent, note: testNote.textContent }, vote: () => (voteBox.hidden ? null : { text: voteBox.innerText.replace(/\n+/g, ' | '), btns: [...voteBox.querySelectorAll('button')].map((b) => b.textContent) }), voteClick: (label) => { const b = [...voteBox.querySelectorAll('button')].find((x) => x.textContent === label); if (b) b.click(); return !!b; }, activeHub: () => activeHubId(), face: (hub, id, cls) => face(info.hubs.find((y) => y.id === hub), id, cls), nameOf: (hub, id) => nameOf(info.hubs.find((y) => y.id === hub), id), toast: (t) => toast(t), canBeHeard: (hub, id) => canBeHeard(info.hubs.find((y) => y.id === hub), id), send: (t) => { input.value = t; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); } };       // (and main.js's checks)
})();
