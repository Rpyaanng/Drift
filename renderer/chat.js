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
  const nameOf = (x, id) => {
    const m = x && x.members.find((y) => y.id === id);
    if (m) return m.name;
    const s = x && (x.suspect || []).find((y) => y.id === id);       // someone the hub sent a bad key for: still named, so the warning makes sense
    return s ? s.name : id === info.me.id ? (info.me.name || 'You') : 'Someone who left';
  };
  const looking = () => $('#panel').classList.contains('open') && $('section[data-tab="share"]').classList.contains('active') && !$('#chat').classList.contains('opts');
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
    box.replaceChildren();
    for (const x of info.hubs) {
      const open = x.id === sel.hub, n = x.channels.reduce((a, c) => a + (unread.get(keyOf(x.id, c.id)) || 0), 0);
      box.append(h('button.chHub' + (open ? '.on' : ''), { title: x.note || '', onclick: () => pick(x.id, open ? sel.ch : (x.channels[0] || {}).id || 0) },
        h('span.dot.' + x.status), h('b', {}, x.name || 'Hub'), x.mine ? h('em', {}, 'yours') : null, (x.lives || []).length ? h('span.liveTag', { title: 'Someone here is sharing something to watch' }, '▶') : null,
        !open && n ? h('span.badge', {}, n > 99 ? '99+' : n) : null));
      if (!open) continue;
      if (x.status === 'gone' || (x.status !== 'connected' && x.note)) box.append(h('p.note.chNote', {}, x.note));
      if (x.status === 'connected') {       // what the hub said about people that didn't check out
        for (const w of x.suspect || []) box.append(h('p.warn', {}, `⚠ The hub sent a key for ${w.name} that doesn't belong to them, so Drift is ignoring it. The hub may be interfering.`));
        for (const w of x.lookalikes || []) box.append(h('p.warn', {}, `⚠ This ${w.name} has a different key from the ${w.name} you met here before. It may be a new PC, or the hub pretending. Click their name in People and compare safety numbers.`));
      }
      for (const c of x.channels) {
        const u = unread.get(keyOf(x.id, c.id)) || 0;
        box.append(h('button.chChan' + (c.id === sel.ch ? '.on' : '') + (u ? '.new' : ''), { onclick: () => pick(x.id, c.id) }, '# ' + c.name, u ? h('span.badge', {}, u > 99 ? '99+' : u) : null));
      }
      if (x.status === 'connected') {
        box.append(h('button.chChan.add', { title: 'Make a channel', onclick: () => makeChannel(x) }, '+ New channel'));
        drawVoice(box, x);
        const people = [...x.members].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
        box.append(h('h3.sub', {}, `People · ${people.filter((p) => p.online).length} here`));
        for (const p of people) {
          const isMe = p.id === info.me.id, blocked = info.blocked.includes(p.id);
          box.append(h('div.chWho' + (p.online ? '.on' : ''), {},
            h('span.faceWrap', {}, face(x, p.id, '.small'), h('span.dot')),
            h('span.nm' + (isMe ? '' : '.link'), { title: isMe ? undefined : 'Their profile and safety number', onclick: isMe ? undefined : () => { profile = profile === p.id ? '' : p.id; drawSide(); } }, p.name + (isMe ? ' (you)' : '')),
            p.verified ? h('span.ver', { title: 'You compared safety numbers with them' }, '✓') : null, p.host ? h('em', {}, 'host') : null,
            p.online && p.mic === false ? h('span.nomic', { title: 'No microphone: they can only type, so their messages go over the video' }, 'no mic') : null,
            !isMe ? h('button.mini', { title: blocked ? 'Show their messages again' : 'Hide their messages from you. They aren\'t told.', onclick: () => call('block', p.id, !blocked).then(() => reload()) }, blocked ? 'Unblock' : 'Block') : null,
            !isMe && x.host && !p.host ? h('button.mini.danger', { title: 'Remove them from this hub for good', onclick: () => removePerson(x, p) }, 'Remove') : null));
          if (profile === p.id && !isMe) box.append(drawProfile(x, p));
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

  // ---- voice: who is in the hub's call, and how far each connection can be trusted ----
  let profile = '';                 // the member whose profile is open in People
  const safetyCodes = new Map();    // "hub:member" -> their safety number with you
  // A lock for each person in the call with you. Only a connection whose signed SDP checked out and whose certificate
  // matches the signed one counts as end-to-end encrypted; anything else says what went wrong.
  function lockOf(x, id) {
    const c = info.call, live = info.live || { peers: {} }, name = nameOf(x, id);
    if (!c || id === info.me.id || !x || c.hub !== x.id) return null;
    if (c.verdict[id] === 'mismatch') return { kind: 'bad', text: `The connection to ${name} didn't use the certificate they signed, so Drift closed it. The hub may be interfering.` };
    if (c.refused[id]) return { kind: 'bad', text: `Couldn't verify ${name}. The hub may be interfering.` };
    if (c.told.includes(id)) return { kind: 'bad', text: `${name} couldn't verify your connection. The hub may be interfering.` };
    if (c.verdict[id] === 'verified' && live.peers[id] === 'connected') return { kind: 'ok', text: `Verified: ${name}'s Drift signed this connection and it uses the certificate they signed. End-to-end encrypted in calls of up to 8: the hub passes the sound on but can't hear it.` };
    if (live.peers[id] === 'failed') return { kind: 'bad', text: `Couldn't connect to ${name}.` };
    return { kind: 'wait', text: `Connecting to ${name}…` };
  }
  function e2eNote(x) {
    const ids = (x.voice || []).map((v) => v.id).filter((id) => id !== info.me.id);
    if (!ids.length) return { text: 'Nobody else is in the call yet.' };
    const kinds = ids.map((id) => lockOf(x, id).kind);
    if (kinds.every((k) => k === 'ok')) return { ok: true, text: '🔒 End-to-end encrypted in calls of up to 8. The hub passes the sound on but can\'t hear it.' };
    if (kinds.some((k) => k === 'ok')) return { text: 'Connections with a 🔒 are end-to-end encrypted (in calls of up to 8). The others aren\'t verified.' };
    return { text: kinds.some((k) => k === 'bad') ? 'No connection in this call is verified.' : 'Checking each connection…' };
  }
  function drawVoice(box, x) {
    const list = x.voice || [], inCall = !!info.call && info.call.hub === x.id;
    box.append(h('h3.sub', {}, list.length ? `Voice · ${list.length} in the call` : 'Voice'));
    for (const v of list) {
      const isMe = v.id === info.me.id, lock = inCall ? lockOf(x, v.id) : null, vol = (voiceSet.volumes || {})[v.id];
      box.append(h('div.vcWho', {},
        h('span.faceWrap', { 'data-speak': v.id }, face(x, v.id, '.small')), h('span.nm', {}, nameOf(x, v.id) + (isMe ? ' (you)' : '')),
        lock ? h('span.lock.' + lock.kind, { title: lock.text }, lock.kind === 'ok' ? '🔒' : lock.kind === 'bad' ? '⚠' : '…') : null,
        v.deaf ? h('span.vcTag', {}, 'deafened') : v.muted ? h('span.vcTag', {}, 'muted') : !v.mic ? h('span.vcTag', {}, 'no mic') : null,
        inCall && !isMe && lock.kind !== 'bad' ? h('input.vcVol', { type: 'range', min: '0', max: '100', value: String(Math.round((vol ?? 1) * 100)), title: `${nameOf(x, v.id)}'s volume, for you only`,
          oninput: (e) => api.patch({ voice: { volumes: { [v.id]: +e.target.value / 100 } } }) }) : null));
      if (lock && lock.kind === 'bad') box.append(h('p.warn', {}, lock.text));
    }
    if (inCall) { const n = e2eNote(x); box.append(h('p.vcNote' + (n.ok ? '.ok' : ''), {}, n.text)); }
    const full = !inCall && list.length >= 8;
    box.append(h('div.row.chActs', {}, inCall
      ? h('button.btn.ghost', { onclick: () => call('voiceLeave') }, 'Leave the call')
      : h('button.btn', { disabled: full, title: full ? 'Up to 8 people can be in a call at once' : 'Talk with whoever is in this hub\'s call', onclick: () => joinVoice(x) }, full ? 'The call is full' : list.length ? 'Join the call' : 'Start a call')));
  }
  async function joinVoice(x) {
    const r = await call('voiceJoin', x.id);
    if (r.error) toast(r.error);
  }
  function drawProfile(x, p) {
    const k = `${x.id}:${p.id}`, code = safetyCodes.get(k);
    if (!safetyCodes.has(k)) {
      safetyCodes.set(k, '');
      call('safety', x.id, p.id).then((r) => { safetyCodes.set(k, r.code || r.error || ''); if (profile === p.id) drawSide(); });
    }
    return h('div.chProfile', {},
      'Safety number with you', h('b.safety', {}, code || '…'),
      h('p.note', {}, `Compare it with ${p.name} in person or on the phone. If yours match, nobody (not even the hub) can pretend to be either of you in calls.`),
      h('button.mini', { onclick: () => call('verify', x.id, p.id, !p.verified).then((r) => r.error && toast(r.error)) }, p.verified ? 'Not verified any more' : 'They match: mark as verified'));
  }
  // ---- the call bar over the scenes, on every screen while you're in a call ----
  function drawCall() {
    const bar = $('#callBar'), c = info.call, live = info.live;
    if (!c || !live) { bar.classList.remove('on'); bar.replaceChildren(); return; }
    const x = info.hubs.find((y) => y.id === c.hub), n = x ? e2eNote(x) : { text: '' };
    const ids = [info.me.id, ...c.peers.filter((id) => !x || (x.voice || []).some((v) => v.id === id))];
    const mic = live.mic === 'off' ? 'No microphone' : live.mic === 'live' ? 'Mic on' : voiceSet.ptt && !voiceSet.muted && !voiceSet.deaf ? `Hold ${KEY_NAMES[voiceSet.pttKey] || 'the key'} to talk` : 'Muted';
    bar.replaceChildren(
      h('span.cbWhere', { title: n.text }, n.ok ? h('span.lock.ok', {}, '🔒') : null, x ? x.name : 'Call'),
      h('span.cbFaces', {}, ids.map((id) => {
        const l = x && lockOf(x, id);
        return h('span.cbFace', { 'data-speak': id, title: id === info.me.id ? 'You' : `${nameOf(x, id)}${l ? ' · ' + l.text : ''}` }, face(x, id, '.small'), l && l.kind === 'bad' ? h('i', {}, '!') : null);
      })),
      h('span.cbMic' + (live.mic === 'live' ? '.live' : ''), {}, mic),
      h('button.cbBtn' + (voiceSet.muted ? '.off' : ''), { title: 'Your microphone (or click the light in the tray)', onclick: () => api.patch({ voice: { muted: !voiceSet.muted } }) }, voiceSet.muted ? 'Unmute' : 'Mute'),
      h('button.cbBtn' + (voiceSet.deaf ? '.off' : ''), { title: 'Hear nobody, and nobody hears you', onclick: () => api.patch({ voice: { deaf: !voiceSet.deaf } }) }, voiceSet.deaf ? 'Undeafen' : 'Deafen'),
      h('button.cbBtn.leave', { onclick: () => call('voiceLeave') }, 'Leave'));
    bar.classList.add('on');
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
  let voiceSet = {};
  function drawVoiceOpts() {
    $('#vcDirect').checked = !!voiceSet.direct; $('#vcPtt').checked = !!voiceSet.ptt; $('#vcKey').value = voiceSet.pttKey || 'backquote';
    $('#vcKey').disabled = !voiceSet.ptt;
  }
  $('#vcDirect').addEventListener('change', (e) => api.patch({ voice: { direct: e.target.checked } }));
  $('#vcPtt').addEventListener('change', (e) => api.patch({ voice: { ptt: e.target.checked } }));
  $('#vcKey').addEventListener('change', (e) => api.patch({ voice: { pttKey: e.target.value } }));

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
    liveKey = JSON.stringify(info.live && { mic: info.live.mic, peers: info.live.peers });
    keep(); drawSide(); drawLives(); drawHead(); drawTyping(); drawMe(); drawCall();
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
    overlaySetting = (s.share && s.share.overlay) || 'unheard';
    const vs = JSON.stringify(s.voice || {});
    if (vs !== JSON.stringify(voiceSet)) { voiceSet = s.voice || {}; drawVoiceOpts(); drawCall(); }
    if (p2p.role !== 'guest') joined = '';
    if (p2p.role === 'off' && was !== 'off') { coList.replaceChildren(); closeCompose(); }       // the session is over: so is its chat over the video
    if (was !== p2p.role) drawLives();
  });

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
  // or all of them. Someone in the hub's call with a working, unmuted microphone counts as heard, so what they type stays
  // in the tab (they can just say it).
  let overlaySetting = 'unheard', coTarget = null, coTyped = 0;
  const co = $('#chatOverlay'), coList = $('#coList'), coInput = $('#coInput');
  const canBeHeard = (x, id) => { const v = x && (x.voice || []).find((y) => y.id === id); return !!v && !!v.mic && !v.muted && !v.deaf; };
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
  coInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== coInput) co.classList.remove('typing'); }, 100));
  new MutationObserver(() => co.classList.toggle('under', $('#panel').classList.contains('open'))).observe($('#panel'), { attributes: true, attributeFilter: ['class'] });

  api.on('chat', (c) => {
    if (c.type === 'info') onInfo(c.info);
    else if (c.type === 'event') onEvent(c.hub, c.m);
    else if (c.type === 'notify') onNotify(c.hub, c.msg, !!c.overlay);
    else if (c.type === 'voice') onVoice(c.live);
  });
  refresh();
  window.chatUI = { hub: () => sel.hub,       // app.js shares into this hub
    overlay: () => [...coList.children].map((r) => r.innerText.replace(/\n+/g, ' ')), compose: (t) => { if (!openCompose()) return false; coInput.value = t; coInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return true; },
    info: () => info, sel: () => sel, pick, canBeHeard: (hub, id) => canBeHeard(info.hubs.find((y) => y.id === hub), id), send: (t) => { input.value = t; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); } };       // (and main.js's checks)
})();
