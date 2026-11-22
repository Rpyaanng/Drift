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
  const nameOf = (x, id) => { const m = x && x.members.find((y) => y.id === id); return m ? m.name : 'Someone who left'; };
  const looking = () => $('#panel').classList.contains('open') && $('section[data-tab="share"]').classList.contains('active') && !$('#chat').classList.contains('opts');
  let p2p = { role: 'off' }, joined = '';       // watch together as main.js reports it; joined: the code of the share we joined from a card

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
    box.replaceChildren();
    for (const x of info.hubs) {
      const open = x.id === sel.hub, n = x.channels.reduce((a, c) => a + (unread.get(keyOf(x.id, c.id)) || 0), 0);
      box.append(h('button.chHub' + (open ? '.on' : ''), { title: x.note || '', onclick: () => pick(x.id, open ? sel.ch : (x.channels[0] || {}).id || 0) },
        h('span.dot.' + x.status), h('b', {}, x.name || 'Hub'), x.mine ? h('em', {}, 'yours') : null, (x.lives || []).length ? h('span.liveTag', { title: 'Someone here is sharing something to watch' }, '▶') : null,
        !open && n ? h('span.badge', {}, n > 99 ? '99+' : n) : null));
      if (!open) continue;
      if (x.status === 'gone' || (x.status !== 'connected' && x.note)) box.append(h('p.note.chNote', {}, x.note));
      for (const c of x.channels) {
        const u = unread.get(keyOf(x.id, c.id)) || 0;
        box.append(h('button.chChan' + (c.id === sel.ch ? '.on' : '') + (u ? '.new' : ''), { onclick: () => pick(x.id, c.id) }, '# ' + c.name, u ? h('span.badge', {}, u > 99 ? '99+' : u) : null));
      }
      if (x.status === 'connected') {
        box.append(h('button.chChan.add', { title: 'Make a channel', onclick: () => makeChannel(x) }, '+ New channel'));
        const people = [...x.members].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
        box.append(h('h3.sub', {}, `People · ${people.filter((p) => p.online).length} here`));
        for (const p of people) {
          const isMe = p.id === info.me.id, blocked = info.blocked.includes(p.id);
          box.append(h('div.chWho' + (p.online ? '.on' : ''), {},
            h('span.dot'), h('span.nm', {}, p.name + (isMe ? ' (you)' : '')), p.host ? h('em', {}, 'host') : null,
            !isMe ? h('button.mini', { title: blocked ? 'Show their messages again' : 'Hide their messages from you. They aren\'t told.', onclick: () => call('block', p.id, !blocked).then(() => reload()) }, blocked ? 'Unblock' : 'Block') : null,
            !isMe && x.host && !p.host ? h('button.mini.danger', { title: 'Remove them from this hub for good', onclick: () => removePerson(x, p) }, 'Remove') : null));
        }
        const acts = h('div.row.chActs');
        acts.append(h('button.btn', { title: 'Copies a code friends paste into their Drift. It works for 7 days.', onclick: () => invite(x) }, 'Copy an invite'));
        if (x.host) acts.append(h('button.btn.ghost', { title: 'Every invite code made so far stops working. People already here stay.', onclick: () => withdraw(x) }, 'Withdraw invites'));
        box.append(acts);
      }
      box.append(h('div.row.chActs', {}, x.mine
        ? h('button.btn.ghost', { onclick: () => { if (confirm('Stop hosting this hub? Friends can\'t chat until you host it again. The messages stay on this PC.')) call('unhost'); } }, 'Stop hosting')
        : h('button.btn.ghost', { onclick: () => { if (confirm(`Leave ${x.name}? You'll need a new invite to come back.`)) call('leave', x.id).then(() => { sel = { hub: '', ch: 0 }; keep(); }); } }, 'Leave hub')));
    }
    $('#chHostBox').style.display = info.hosting ? 'none' : '';
    const tabBtn = document.querySelector('.tabs button[data-tab="share"]'), any = [...unread.values()].some((n) => n);
    if (tabBtn) tabBtn.classList.toggle('unread', any);
  }

  // ---- the middle: one channel's messages ----
  function drawHead() {
    const x = hubNow(), c = chanNow();
    $('#chTitle').textContent = c ? '# ' + c.name : x ? x.name : 'Chat';
    $('#chSub').textContent = !x ? 'Join a friend\'s hub with their invite code, or host one of your own.'
      : x.status !== 'connected' ? (x.note || 'Connecting…')
      : x.mine ? 'Messages are kept on this PC, by your Drift.' : `Messages are kept on the host's PC (${(x.members.find((m) => m.host) || {}).name || 'the host'}), not encrypted from them.`;
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
      if (head) row.append(h('div.chBy', {}, h('b', {}, nameOf(x, m.from)), h('time', { title: new Date(m.at).toLocaleString() }, when(m.at))));
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
  function drawAll(stick) { drawSide(); drawLives(); drawHead(); drawList(stick); drawTyping(); drawMode(); }

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
  function pick(hub, ch) {
    sel = { hub, ch }; keep(); mode = null;
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
    if (!hubNow() && info.hubs.length) sel = { hub: info.hubs[0].id, ch: 0 };
    const x = hubNow();
    if (x && !x.channels.some((c) => c.id === sel.ch)) sel.ch = (x.channels[0] || {}).id || 0;
    keep(); drawSide(); drawLives(); drawHead(); drawTyping();
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
  function onNotify(hub, msg) {
    if (hub === sel.hub && msg.ch === sel.ch && looking()) return;
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
  $('#chHost').addEventListener('click', async () => {
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
  async function makeChannel(x) {
    const box = h('input', { type: 'search', placeholder: 'channel-name', maxlength: '32', spellcheck: 'false' });
    const row = h('div.row.chNew', {}, box);
    const done = () => row.remove();
    box.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(); return; }
      if (e.key !== 'Enter') return;
      const r = await call('channel', x.id, box.value);
      if (r.error) { toast(r.error); return; }
      done(); pick(x.id, r.ch);
    });
    box.addEventListener('blur', () => setTimeout(done, 150));
    $('#chHubs').after(row); box.focus();       // (outside the list, which is drawn again whenever something changes)
  }

  // ---- seeing the tab: what's showing counts as read ----
  const markRead = () => { if (looking() && sel.ch && unread.delete(keyOf(sel.hub, sel.ch))) drawSide(); };
  new MutationObserver(markRead).observe($('section[data-tab="share"]'), { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(markRead).observe($('#panel'), { attributes: true, attributeFilter: ['class'] });

  // ---- options (name, control, quality...) take the chat's place while open ----
  const opts = (on) => { $('#chat').classList.toggle('opts', on); if (!on) markRead(); };
  $('#shOptsBtn').addEventListener('click', () => opts(!$('#chat').classList.contains('opts')));
  $('#shOptsDone').addEventListener('click', () => opts(false));
  api.on('state', (s) => {
    const was = p2p.role;
    p2p = s.p2p || { role: 'off' };
    if (p2p.role !== 'guest') joined = '';
    if (was !== p2p.role) drawLives();
  });

  api.on('chat', (c) => {
    if (c.type === 'info') onInfo(c.info);
    else if (c.type === 'event') onEvent(c.hub, c.m);
    else if (c.type === 'notify') onNotify(c.hub, c.msg);
  });
  refresh();
  window.chatUI = { hub: () => sel.hub,       // app.js shares into this hub
    info: () => info, sel: () => sel, pick, send: (t) => { input.value = t; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); } };       // (and main.js's checks)
})();
