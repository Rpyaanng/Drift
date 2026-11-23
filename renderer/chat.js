/* Drift — the panel's Together tab: hubs, their channels and messages, and who in them is sharing something to watch
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
  };
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
  const looking = () => $('#panel').classList.contains('open') && $('section[data-tab="share"]').classList.contains('active') && !$('#chat').classList.contains('opts') && !$('#chat').classList.contains('help');
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
  // A link says where it really goes before it opens (the host as the browser sees it, so look-alike letters show up).
  function link(url) {
    let u = null;
    try { u = new URL(url); } catch { return url; }
    return h('a', { href: '#', title: u.hostname, onclick: (e) => {
      e.preventDefault();
      if (!confirm(`Open this link in Surf?\n\nIt goes to:  ${u.hostname}\n\n${u.href}`)) return;
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
    const tabBtn = document.querySelector('.tabs button[data-tab="share"]'), any = [...unread.values()].some((n) => n);
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
        : item('Leave hub', 'You\'ll need a new invite to come back.', () => { if (confirm(`Leave ${x.name}? You'll need a new invite to come back.`)) call('leave', x.id).then(() => { sel = { hub: '', ch: 0 }; keep(); }); }, true));
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
  }
  function drawList(stick) {
    const list = $('#chList'), x = hubNow(), c = chanNow(), k = c && keyOf(x.id, c.id), got = k && cache.get(k);
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren();
    if (!got) return;
    if (got.more && got.msgs.length) list.append(h('button.btn.ghost.chMore', { onclick: () => older(x.id, c.id) }, got.loading ? 'Loading…' : 'Show older messages'));
    if (!got.msgs.length && !got.loading) list.append(h('p.note', {}, `This is the start of #${c.name}.`));
    let prev = null;
    for (const m of got.msgs) {
      const mine = m.from === info.me.id, head = !prev || prev.from !== m.from || m.at - prev.at > 5 * 60e3 || m.reply;
      const row = h('div.chMsg' + (head ? '.head' : '') + (mine ? '.mine' : ''), { 'data-id': m.id });
      if (m.reply) {
        const to = got.msgs.find((y) => y.id === m.reply);
        row.append(h('div.chRe', {}, '↪ ', to ? h('b', {}, nameOf(x, to.from)) : 'a deleted message', to ? ' ' + to.text.slice(0, 80) : ''));
      }
      if (head) row.append(face(x, m.from, '.msgFace'), h('div.chBy', {}, h('b', {}, nameOf(x, m.from)), h('time', { title: new Date(m.at).toLocaleString() }, when(m.at))));
      row.append(h('div.chText', {}, render(m.text), m.edited ? h('span.chEd', { title: 'Edited ' + new Date(m.edited).toLocaleString() }, ' (edited)') : null));
      const tools = h('div.chTools');
      tools.append(h('button.mini', { onclick: () => setMode('reply', m) }, 'Reply'));
      if (mine) tools.append(h('button.mini', { onclick: () => setMode('edit', m) }, 'Edit'));
      if (mine || x.host) tools.append(h('button.mini.danger', { onclick: () => { if (confirm('Delete this message for everyone?')) call('delete', x.id, m.id).then((r) => r.error && toast(r.error)); } }, 'Delete'));
      row.append(tools);
      list.append(row);
      prev = m;
    }
    if (stick || atEnd) list.scrollTop = list.scrollHeight;
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
  function joinLive(x, l) {
    if (p2p.role === 'host' && !confirm(`Stop sharing and join ${nameOf(x, l.from)}?`)) return;
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
  // ---- the hub bar over the scenes, on every screen while you're online in a hub's voice room or watching together ----
  // Join voice / Disconnect, Mute and Leave hub are always one click away. With no input it fades into the scene (style.css, body.idle),
  // but never while your microphone is open (.hot).
  function drawCall() {
    const bar = $('#callBar'), c = info.call, live = info.live, x = info.hubs.find((y) => y.id === activeHubId() && y.status === 'connected');
    const inRoom = !!(x && x.room && x.room.in), watching = p2p.role === 'host' || p2p.role === 'guest', surfing = !!(x && x.surf && x.surf.on);
    if (!inRoom && !watching && !surfing) { bar.classList.remove('on', 'hot'); bar.replaceChildren(); return; }
    const parts = [];
    if (inRoom) {
      const n = c && c.hub === x.id ? e2eNote(x) : { text: '' };
      const inVoice = (x.voice || []).filter((v) => v.listen);       // everyone in voice, a red ring and a slashed mic on whoever is muted
      const mic = !voiceSet.talk ? '' : live && live.mic === 'none' ? 'No microphone' : live && live.mic === 'open' ? `Hold ${KEY_NAMES[voiceSet.pttKey] || 'the key'} to talk` : '';
      parts.push(
        h('span.cbWhere', { title: n.text }, n.ok ? h('span.lock.ok', {}, '🔒') : null, x.name || 'Hub'),
        h('span.cbFaces', {}, inVoice.map((v) => {
          const id = v.id, l = id === info.me.id ? null : lockOf(x, id), muted = !(v.talk && v.mic);
          const who = id === info.me.id ? 'You' : nameOf(x, id);
          return h('span.cbFace' + (muted ? '.muted' : ''), { 'data-speak': id, title: `${who}${muted ? ' (muted)' : ''}${l ? ' · ' + l.text : ''}` },
            face(x, id, '.small'), l && l.kind === 'bad' ? h('i', {}, '!') : null, muted ? h('b.cbMuted', {}, icon('micOff')) : null);
        })),
        mic ? h('span.cbMic', {}, mic) : null,
        joinButton('cbBtn', x),
        voiceSet.deaf ? null : talkButton('cbBtn'),
        h('button.cbBtn.leave', { title: `Go offline from ${x.name}: stop hearing it and stop showing as online. Press Connect to come back.`, onclick: () => call('disconnect', x.id) }, icon('door'), 'Leave hub'));
    }
    if (inRoom) {       // broadcasts (docs/plans/broadcast.md §5, §12): yours always shows, with Stop one click away
      const mine = info.bc && info.bc.mine && info.bc.mine.hub === x.id ? info.bc.mine : null, others = (x.bcs || []).filter((b) => b.from !== info.me.id);
      if (mine) {
        const n = ((x.bcs || []).find((b) => b.id === mine.id) || { viewers: [] }).viewers.length;
        parts.push(h('span.cbSep'), h('span.cbWhere.cbLive', { title: n ? `${n} watching` : 'Nobody watching yet' }, h('span.spdot'), `Live · ${mine.title}${bcLiveS && bcLiveS.paused ? ' (paused)' : ''}`),
          h('button.cbBtn.leave', { title: 'Stop broadcasting', onclick: () => call('bcStop') }, 'Stop'));
      }
      if (bcViewS) parts.push(h('span.cbSep'), h('span.cbWhere', {}, `Watching ${bcViewS.who}`), h('button.cbBtn', { onclick: () => call('bcUnwatch', bcViewS.bc) }, 'Stop watching'));
      else if (others.length) {
        const b = others[0];
        parts.push(h('span.cbSep'), h('span.cbWhere', { title: others.map((o) => `${nameOf(x, o.from)} · ${o.title}`).join('\n') }, `${nameOf(x, b.from)} is live${others.length > 1 ? ` (+${others.length - 1})` : ''}`),
          h('button.cbBtn', { title: 'Watch it on this screen (pick another monitor in the Broadcast tab)', onclick: () => call('bcWatch', x.id, b.id, window.appUI && window.appUI.key).then((r) => { if (r && r.error) toast(r.error); }) }, 'Watch'));
      }
    }
    if (watching) {
      const host = p2p.role === 'host', n = (p2p.peers || []).length;
      const what = host ? (n ? `Sharing · ${n} watching` : 'Sharing') : `Watching with ${p2p.host || 'a friend'}`;
      if (inRoom) parts.push(h('span.cbSep'));
      parts.push(h('span.cbWhere.cbWatch', { title: host ? (p2p.peers || []).map((p) => p.name || p).join(', ') : '' }, h('span.spdot'), what),
        h('button.cbBtn.leave', { title: host ? 'Stop sharing with everyone' : 'Stop watching together', onclick: () => api.cmd({ type: 'share-stop' }) }, host ? 'Stop sharing' : 'Leave'));
    }
    if (surfing) {       // the hub's Surf stream (docs/plans/streams.md §9): its front tab, next to what's on the media stream
      const n = (x.surf.watchers || []).length;
      if (inRoom || watching) parts.push(h('span.cbSep'));
      parts.push(h('span.cbWhere.cbSurf', { title: `The Surf stream: one browser for everyone in ${x.name || 'the hub'}. ${n ? n + ' watching' : 'Nobody watching right now'}. Open Surf to join in.` }, 'Surf · ', x.surf.title || 'New tab'));
    }
    bar.replaceChildren(...parts.filter(Boolean));
    bar.classList.add('on');
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
  }
  $('#vcDirect').addEventListener('change', (e) => api.patch({ voice: { direct: e.target.checked } }));
  $('#vcPtt').addEventListener('change', (e) => api.patch({ voice: { ptt: e.target.checked } }));
  $('#vcKey').addEventListener('change', (e) => api.patch({ voice: { pttKey: e.target.value } }));
  $('#vcKeep').addEventListener('change', (e) => api.patch({ voice: { keepMic: e.target.checked } }));

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
    sel = { hub, ch }; keep(); mode = null; tellHub();
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
      const t = typing.get(k); if (t) t.delete(m.msg.from);
      const here = hub === sel.hub && m.msg.ch === sel.ch && looking();
      if (!here && m.msg.from !== info.me.id && !m.msg.edited) unread.set(k, (unread.get(k) || 0) + 1);
      if (hub === sel.hub && m.msg.ch === sel.ch) { drawList(m.msg.from === info.me.id); drawTyping(); }
      drawSide();
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
    if (over && overlaySetting !== 'off') {       // watching together in this hub: over the video, if it's for the overlay
      const x = info.hubs.find((y) => y.id === hub);
      if ((overlaySetting === 'all' || !canBeHeard(x, msg.from)) && !(hub === sel.hub && msg.ch === sel.ch && looking())) overlayShow(x, msg);
      return;
    }
    if (msg.from === info.me.id || (hub === sel.hub && msg.ch === sel.ch && looking())) return;
    const x = info.hubs.find((y) => y.id === hub), c = x && x.channels.find((y) => y.id === msg.ch);
    toast(`${nameOf(x, msg.from)} in #${c ? c.name : '?'}: ${msg.text.replace(/\s+/g, ' ').slice(0, 90)}`);
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
    if (e.key === 'Escape' && mode) { e.preventDefault(); setMode(null); return; }
    if (e.key === 'ArrowUp' && !input.value) {       // the last thing you said, to fix
      const got = cache.get(keyOf(sel.hub, sel.ch)), mine = got && [...got.msgs].reverse().find((m) => m.from === info.me.id);
      if (mine) { e.preventDefault(); setMode('edit', mine); }
      return;
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    const text = input.value.trim(), m = mode;
    if (!text) { if (m && m.kind === 'edit') setMode(null); return; }
    input.disabled = true;
    const r = m && m.kind === 'edit' ? await call('edit', sel.hub, m.msg.id, text) : await call('send', sel.hub, sel.ch, text, m && m.kind === 'reply' ? m.msg.id : undefined);
    input.disabled = false; input.focus();
    if (r.error) { toast(r.error); return; }
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
      if (others && !confirm(`Stop hosting? ${others === 1 ? 'The 1 person' : `The ${others} people`} here will be disconnected.`)) return;
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
    if (!confirm('Stop every invite code made so far from working? People already in the hub stay.')) return;
    const r = await call('withdrawInvites', x.id);
    toast(r.error || 'Every invite so far has stopped working.');
  }
  async function removePerson(x, p) {
    if (!confirm(`Remove ${p.name} from ${x.name}? They're disconnected now and can't come back, even with a new invite.`)) return;
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
  new MutationObserver(markRead).observe($('section[data-tab="share"]'), { attributes: true, attributeFilter: ['class'] });
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
    shareSet = s.share || {}; drawHelp();
    overlaySetting = (s.share && s.share.overlay) || 'unheard';
    const vs = JSON.stringify(s.voice || {});
    if (vs !== JSON.stringify(voiceSet)) { voiceSet = s.voice || {}; drawVoiceOpts(); drawSide(); drawCall(); }
    if (p2p.role !== 'guest') joined = '';
    if (p2p.role === 'off' && was !== 'off') { coList.replaceChildren(); closeCompose(); }       // the session is over: so is its chat over the video
    if (was !== p2p.role) drawLives();
    const pk = JSON.stringify([p2p.role, p2p.host, (p2p.peers || []).length]);
    if (pk !== p2pKey) { p2pKey = pk; drawCall(); }
    const bv = s.bcView ? { bc: s.bcView.bc, who: s.bcView.who } : null;
    if (JSON.stringify(bv) !== JSON.stringify(bcViewS)) { bcViewS = bv; drawCall(); }
  });
  let p2pKey = '';

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

  // ---- chat over the video, while watching together ----
  // Messages from the session's hub show in a corner of the screen main.js picks and fade after a while. Enter opens a
  // box to answer in, without opening the panel. Which messages: from people who can't be heard (the setting's default)
  // or all of them. Someone in the hub's voice room who pressed Talk and has a working microphone counts as heard, so what
  // they type stays in the tab (they can just say it). Someone who hasn't pressed Talk is "unheard".
  let overlaySetting = 'unheard', coTarget = null, coTyped = 0;
  const co = $('#chatOverlay'), coList = $('#coList'), coInput = $('#coInput');
  const canBeHeard = (x, id) => { const v = vEntry(x, id); return !!v && v.listen && v.talk && !!v.mic; };
  function overlayShow(x, msg) {
    const c = x && x.channels.find((y) => y.id === msg.ch);
    const row = h('div.coMsg', {}, face(x, msg.from, '.co'),
      h('div.coBody', {}, h('b.coName', {}, nameOf(x, msg.from)), x && x.channels.length > 1 && c ? h('em', {}, '#' + c.name) : null, h('span.coText', {}, render(msg.text))));
    coList.append(row);
    while (coList.children.length > 8) coList.firstChild.remove();
    setTimeout(() => row.classList.add('old'), 12000);
  }
  function openCompose() {
    const x = info.hubs.find((y) => y.id === p2p.chatHub);
    if (!x || x.status !== 'connected' || !x.channels.length) return false;
    const ch = sel.hub === x.id && x.channels.some((c) => c.id === sel.ch) ? sel.ch : x.channels[0].id;
    coTarget = { hub: x.id, ch };
    $('#coWhere').textContent = '#' + x.channels.find((c) => c.id === ch).name;
    coInput.placeholder = 'Say something · Enter sends, Esc closes';
    co.classList.add('typing'); coInput.focus();
    return true;
  }
  function closeCompose() { co.classList.remove('typing'); coTarget = null; if (document.activeElement === coInput) coInput.blur(); }
  addEventListener('keydown', (e) => {       // Enter while watching (and not typing anywhere else): answer over the video
    if (e.key !== 'Enter' || e.defaultPrevented || (document.activeElement && document.activeElement !== document.body) || $('#confirm').classList.contains('on')) return;
    if (p2p.role === 'off' || !p2p.chatHub) return;
    if (openCompose()) e.preventDefault();
  });
  coInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); coInput.value = ''; closeCompose(); return; }
    if (e.key !== 'Enter') { if (coTarget && Date.now() - coTyped > 2500) { coTyped = Date.now(); call('typing', coTarget.hub, coTarget.ch); } return; }
    e.preventDefault();
    const text = coInput.value.trim();
    if (!text || !coTarget) { closeCompose(); return; }
    const r = await call('send', coTarget.hub, coTarget.ch, text);
    if (r.error) { toast(r.error); return; }
    coInput.value = ''; closeCompose();
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
    else if (c.type === 'bclive') { const was = !!(bcLiveS && bcLiveS.paused); bcLiveS = c.live; if (was !== !!(c.live && c.live.paused)) drawCall(); }
  });
  refresh();
  window.chatUI = { hub: () => sel.hub,       // app.js shares into this hub
    overlay: () => [...coList.children].map((r) => r.innerText.replace(/\n+/g, ' ')), compose: (t) => { if (!openCompose()) return false; coInput.value = t; coInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; },
    info: () => info, sel: () => sel, pick, vote: () => (voteBox.hidden ? null : { text: voteBox.innerText.replace(/\n+/g, ' | '), btns: [...voteBox.querySelectorAll('button')].map((b) => b.textContent) }), voteClick: (label) => { const b = [...voteBox.querySelectorAll('button')].find((x) => x.textContent === label); if (b) b.click(); return !!b; }, activeHub: () => activeHubId(), face: (hub, id, cls) => face(info.hubs.find((y) => y.id === hub), id, cls), nameOf: (hub, id) => nameOf(info.hubs.find((y) => y.id === hub), id), toast: (t) => toast(t), canBeHeard: (hub, id) => canBeHeard(info.hubs.find((y) => y.id === hub), id), send: (t) => { input.value = t; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); } };       // (and main.js's checks)
})();
