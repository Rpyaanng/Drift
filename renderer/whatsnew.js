/* Drift — What's new: a big window over everything, with what changed in each version. It opens by itself the first time a
   new version starts (main.js notesCheck, on the main monitor only), and from Settings → Updates → What's new.
   Each version's notes are renderer/whats-new/<version>.md, read by notes-md.js (the same reader scripts/check-notes.js
   checks them with) and drawn here as elements, text always as text. The rail lists every version; the ones newer than
   what you last saw are marked New. ← and → go to an older or newer version, Esc closes (a picture first, if one is open). */
(() => {
  const api = window.drift, N = window.DriftNotes;
  if (!api || !N) return;
  const ICON = {
    new: '<path d="M12 3.5l1.9 5.2 5.3 1.9-5.3 1.9L12 17.7l-1.9-5.2-5.3-1.9 5.3-1.9z"/><path d="M18.5 15.5l.8 2.1 2.2.8-2.2.8-.8 2.2-.8-2.2-2.1-.8 2.1-.8z"/>',
    fixed: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    improved: '<path d="M12 19V6M6.5 11.5L12 6l5.5 5.5"/><path d="M5 20h14"/>',
    changed: '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>',
    other: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16h.01"/>',
    note: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
    out: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    zoom: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3M11 8v6M8 11h6"/>',
    logo: '<path d="M3 15c3-5 6-5 9 0s6 5 9 0" /><path d="M3 9c3-5 6-5 9 0s6 5 9 0" opacity=".55"/>',
  };
  const SECTION = { new: 'New', fixed: 'Fixed', improved: 'Improved', changed: 'Changed', other: '' };
  // Drift's cat (#coCat in index.html), flat green as in the notes' own pictures, for the art of a version with no picture. It
  // peeks in from behind the card's left edge (whatsnew.css .wnHeroCat), so it has no tail: that's round the corner with it
  const CAT = '<svg viewBox="225 105 1035 770" aria-hidden="true"><g stroke="#1a1230" stroke-linejoin="round" stroke-linecap="round">'
    + '<path d="M345 355C340 250 380 150 440 125C510 105 590 160 645 225C710 205 790 205 845 225C900 160 980 105 1050 125C1110 150 1145 250 1140 355C1220 430 1260 560 1245 660C1230 760 1170 820 1080 835C900 860 600 860 420 835C320 820 250 740 240 620C235 520 270 420 345 355Z" fill="#22c08a" stroke-width="34"/>'
    + '<path d="M425 335C425 262 445 205 468 198C508 194 552 224 580 258C524 274 474 300 425 335ZM1059 335C1059 262 1039 205 1016 198C976 194 932 224 904 258C960 274 1010 300 1059 335Z" fill="#128a62" stroke="none"/>'
    + '<path d="M408 820C400 760 450 722 512 722C576 722 620 762 618 812C616 850 560 858 510 858C450 858 412 852 408 820ZM918 820C910 760 960 722 1022 722C1086 722 1130 762 1128 812C1126 850 1070 858 1020 858C960 858 922 852 918 820Z" fill="#22c08a" stroke-width="30"/>'
    + '<path d="M478 790v40M548 790v40M988 790v40M1058 790v40" fill="none" stroke-width="12" opacity=".7"/>'
    + '<path d="M690 552C690 594 738 596 750 562C762 596 810 594 810 552" fill="none" stroke-width="22"/>'
    + '<circle cx="545" cy="530" r="70" fill="#f4fff4" stroke-width="26"/><circle cx="950" cy="530" r="70" fill="#f4fff4" stroke-width="26"/></g>'
    + '<g fill="#1b1030"><circle cx="553" cy="536" r="32"/><circle cx="958" cy="536" r="32"/></g><g fill="#fff"><circle cx="541" cy="522" r="10"/><circle cx="946" cy="522" r="10"/></g>'
    + '<g fill="#ff8fb8" opacity=".45"><ellipse cx="470" cy="630" rx="58" ry="30"/><ellipse cx="1025" cy="630" rx="58" ry="30"/></g></svg>';
  function h(spec, props, ...kids) {
    const [tag, ...cls] = spec.split('.');
    const el = document.createElement(tag || 'div');
    if (cls.length) el.className = cls.join(' ');
    for (const [k, v] of Object.entries(props || {})) { if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v); }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }
  function icon(name, size = 16) {       // (fixed strings above, never anything from a notes file)
    const el = h('span.wnIco');
    el.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
    return el;
  }
  // inline runs from notes-md.js, as elements
  function runs(c) {
    return c.map((n) => {
      if (n.t === 'text') return document.createTextNode(n.v);
      if (n.t === 'b') return h('strong', {}, runs(n.c));
      if (n.t === 'i') return h('em', {}, runs(n.c));
      if (n.t === 'code') return h('code', {}, n.v);
      if (n.t === 'a') return h('a', { href: '#', title: n.href, onclick: (e) => { e.preventDefault(); api.cmd({ type: 'notes-link', url: n.href }); } }, runs(n.c), icon('out', 12));
      return null;
    });
  }
  const dateText = (d) => { const t = Date.parse(d + 'T12:00:00'); return isNaN(t) ? '' : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); };
  const shortDate = (d) => { const t = Date.parse(d + 'T12:00:00'); return isNaN(t) ? '' : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
  const picSrc = (v, name) => (N.IMG.test(String(name || '')) ? `whats-new/${v}/${encodeURIComponent(name)}` : '');

  let root = null, data = null, at = 0, since = '', lastFocus = null, light = null;
  // data.list: newest first, each { version, text, parsed }
  function open(opts = {}) {
    return api.notes().then((r) => {
      if (!r || !Array.isArray(r.list) || !r.list.length) return false;
      data = { current: r.current, list: r.list.map((x) => ({ ...x, parsed: N.parse(x.text) })) };
      since = opts.since !== undefined ? String(opts.since || '') : '';
      const want = String(opts.version || r.current);
      at = Math.max(0, data.list.findIndex((x) => x.version === want));
      build(!!opts.auto);
      return true;
    });
  }
  const fresh = (v) => !!since && N.newer(v, since) && !N.newer(v, data.current);
  function build(auto) {
    close(true);
    lastFocus = document.activeElement;
    const n = data.list.filter((x) => fresh(x.version)).length;
    root = h('div.wn' + (auto ? '.auto' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wnTitle', tabindex: '-1' });
    const rail = h('nav.wnList', { 'aria-label': 'Versions' });
    data.list.forEach((x, i) => {
      const m = x.parsed.meta, here = x.version === data.current, ahead = N.newer(x.version, data.current);
      rail.append(h('button.wnVer' + (fresh(x.version) ? '.fresh' : '') + (here ? '.here' : ''), { 'data-i': i, 'data-v': x.version, onclick: () => show(i) },
        h('span.wnDot'),
        h('span.wnVerTop', {}, h('b', {}, x.version), here ? h('span.wnBadge.here', {}, 'Installed') : fresh(x.version) ? h('span.wnBadge', {}, 'New') : ahead ? h('span.wnBadge.soon', {}, 'Coming') : null, h('time', {}, shortDate(m.date))),
        h('span.wnVerTitle', {}, m.title || '')));
    });
    root.append(
      h('div.wnBack', { onclick: () => close() }),
      h('div.wnCard', {},
        h('div.wnAura', { 'aria-hidden': 'true' }),
        h('aside.wnRail', {},
          h('div.wnBrand', {}, h('span.wnLogo', {}, icon('logo', 22)), h('div', {}, h('b', {}, 'What\'s new'), h('span', {}, 'in Drift'))),
          n ? h('div.wnSince', {}, auto ? `${n === 1 ? 'One update' : `${n} updates`} since you last looked` : `${n} new since you last looked`) : null,
          rail),
        h('main.wnMain', {},
          h('button.wnX', { title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => close() }, icon('close', 18)),
          h('div.wnScroll', {}),
          h('footer.wnFoot', {},
            h('button.wnNav.older', { title: 'An older version (←)', onclick: () => show(at + 1) }, icon('left', 16), h('span', {}, 'Older')),
            h('span.wnPager', {}),
            h('button.wnNav.newer', { title: 'A newer version (→)', onclick: () => show(at - 1) }, h('span', {}, 'Newer'), icon('right', 16)),
            h('span.wnGap'),
            h('button.wnGh', { title: 'This version on GitHub', onclick: () => api.cmd({ type: 'notes-link', url: `https://github.com/Rpyaanng/Drift/releases/tag/v${data.list[at].version}` }) }, h('span', {}, 'On GitHub'), icon('out', 13)),
            h('button.wnOk', { onclick: () => close() }, auto ? 'Got it' : 'Close')))));
    document.body.append(root);
    document.body.classList.add('wnOpen');
    root.addEventListener('keydown', onKey);
    show(at, true);
    const el = root, enter = () => { if (root !== el || el.classList.contains('in')) return; el.classList.add('in'); el.querySelector('.wnOk').focus({ preventScroll: true }); };
    requestAnimationFrame(enter); setTimeout(enter, 60);       // (a hidden window may never draw a frame)
  }
  function show(i, first = false) {
    if (!root || i < 0 || i >= data.list.length) return;
    const dir = i < at ? 'up' : 'down';
    at = i;
    const x = data.list[i], v = x.version, m = x.parsed.meta;
    for (const b of root.querySelectorAll('.wnVer')) { const on = +b.dataset.i === i; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'true' : 'false'); }
    const cur = root.querySelector(`.wnVer[data-i="${i}"]`);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    const scroll = root.querySelector('.wnScroll');
    const page = h('article.wnPage' + (first ? '' : '.' + dir), { 'data-v': v }, hero(x), body(x));
    scroll.replaceChildren(page);
    scroll.scrollTop = 0;
    root.querySelector('.wnPager').textContent = `${i + 1} of ${data.list.length}`;
    root.querySelector('.wnNav.older').disabled = i >= data.list.length - 1;
    root.querySelector('.wnNav.newer').disabled = i <= 0;
    root.querySelector('.wnGh').hidden = N.newer(v, data.current);       // (not released yet: no page for it)
    root.style.setProperty('--wnHue', m.hero ? '0' : String(((parseInt(v.replace(/\D/g, ''), 10) * 37) % 81) - 40));       // (a version with no picture gets art of its own shade, near the palette's)
  }
  function hero(x) {
    const m = x.parsed.meta, v = x.version, src = m.hero ? picSrc(v, m.hero) : '';
    const art = src
      ? h('img.wnHeroImg', { src, alt: m['hero-alt'] || '', draggable: 'false', onerror: (e) => e.currentTarget.closest('.wnHero').classList.add('noimg') })
      : h('div.wnHeroArt', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('span.wnHeroNum', {}, v));
    return h('header.wnHero' + (src ? '' : '.noimg'), {},
      art,
      h('div.wnHeroShade'),
      src ? null : catEl(),       // (over the shade, so it stays its own green)
      h('div.wnHeroText', {},
        h('span.wnEyebrow', {}, `Drift ${v}`, m.date ? h('span', {}, ' · ' + dateText(m.date)) : null, v === data.current ? h('span.wnPill', {}, 'You have this') : fresh(v) ? h('span.wnPill.new', {}, 'New for you') : null),
        h('h1', { id: 'wnTitle' }, m.title || `Drift ${v}`)));
  }
  function catEl() { const el = h('span.wnHeroCat'); el.innerHTML = CAT; return el; }       // (a fixed string above, never anything from a notes file)
  function body(x) {
    const v = x.version, out = h('div.wnBody');
    let sec = out, n = 0;
    for (const b of x.parsed.blocks) {
      if (b.t === 'h' && b.level === 2) {
        sec = h('section.wnSec.' + b.kind, {}, h('h2', {}, h('span.wnChip', {}, icon(b.kind, 15)), b.kind === 'other' ? b.text : SECTION[b.kind] || b.text));
        out.append(sec);
        continue;
      }
      if (b.t === 'h') { sec.append(h('h3', {}, b.text)); continue; }
      if (b.t === 'p') { sec.append(h('p', {}, runs(b.c))); continue; }
      if (b.t === 'note') { sec.append(h('div.wnNote', {}, icon('note', 16), h('p', {}, runs(b.c)))); continue; }
      if (b.t === 'img') { const s = picSrc(v, b.src); if (s) sec.append(figure(s, b.alt, b.caption)); continue; }
      if (b.t === 'list') {
        const leads = b.items.filter((it) => it.lead).length;
        if (leads * 2 >= b.items.length) {       // mostly "**Title.** text": cards
          const grid = h('div.wnItems');
          for (const it of b.items) {
            grid.append(h('div.wnItem', { style: `--d:${Math.min(12, n++) * 45}ms` },
              it.lead ? h('h4', {}, runs(it.lead)) : null,
              it.c.length ? h('p', {}, runs(it.c)) : null,
              it.sub.length ? h('ul', {}, it.sub.map((s) => h('li', {}, s.lead ? h('strong', {}, runs(s.lead)) : null, s.lead ? ' ' : null, runs(s.c)))) : null));
          }
          sec.append(grid);
        } else {       // plain lines
          sec.append(h('ul.wnPlain', {}, b.items.map((it) => h('li', { style: `--d:${Math.min(12, n++) * 45}ms` }, it.lead ? h('strong', {}, runs(it.lead)) : null, it.lead ? ' ' : null, runs(it.c),
            it.sub.length ? h('ul', {}, it.sub.map((s) => h('li', {}, s.lead ? h('strong', {}, runs(s.lead)) : null, s.lead ? ' ' : null, runs(s.c)))) : null))));
        }
      }
    }
    return out;
  }
  function figure(src, alt, caption) {
    const img = h('img', { src, alt, loading: 'lazy', draggable: 'false' });
    return h('figure.wnFig', {},
      h('button.wnFigBtn', { title: 'See it bigger', 'aria-label': `See it bigger: ${alt}`, onclick: () => zoom(src, alt, caption) }, img, h('span.wnZoom', {}, icon('zoom', 16))),
      caption ? h('figcaption', {}, caption) : null);
  }
  function zoom(src, alt, caption) {
    if (!root) return;
    unzoom();
    light = h('div.wnLight', { onclick: unzoom, title: 'Click or press Esc to close' }, h('img', { src, alt }), caption ? h('p', {}, caption) : null);
    root.append(light);
    const l = light;
    requestAnimationFrame(() => l.classList.add('in')); setTimeout(() => l.classList.add('in'), 60);
  }
  function unzoom() { if (light) { light.remove(); light = null; } }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (light) unzoom(); else close(); return; }
    if (light) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); show(at + 1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); show(at - 1); return; }
    if (e.key === 'Tab') {       // (keep the keyboard inside the window)
      const f = [...root.querySelectorAll('button:not([disabled]):not([hidden]), a[href]')].filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
    e.stopPropagation();       // (the scene's own keys wait while this is open)
  }
  function close(now = false) {
    if (!root) return;
    const el = root;
    root = null; light = null;
    document.body.classList.remove('wnOpen');
    el.removeEventListener('keydown', onKey);
    if (now || matchMedia('(prefers-reduced-motion: reduce)').matches) el.remove();
    else { el.classList.remove('in'); el.classList.add('out'); setTimeout(() => el.remove(), 380); }
    if (lastFocus && lastFocus.focus) try { lastFocus.focus({ preventScroll: true }); } catch { /* gone */ }
  }
  // (window-wide: Esc reaches it even when focus wandered off the window)
  addEventListener('keydown', (e) => { if (root && !root.contains(document.activeElement)) onKey(e); }, true);

  api.on('cmd', (c) => {
    if (c.type !== 'whats-new') return;
    open({ auto: !!c.auto, since: c.since, version: c.version }).then((ok) => { if (ok && c.auto) api.cmd({ type: 'notes-seen' }); });
  });
  window.whatsNew = {
    open, close: () => close(true), isOpen: () => !!root,
    // (tests: what the window shows)
    state: () => (root ? { version: data.list[at].version, title: root.querySelector('#wnTitle').textContent, versions: [...root.querySelectorAll('.wnVer')].map((b) => b.dataset.v),
      fresh: [...root.querySelectorAll('.wnVer.fresh')].map((b) => b.dataset.v), sections: [...root.querySelectorAll('.wnSec h2')].map((x) => x.textContent), cards: root.querySelectorAll('.wnItem').length,
      pics: [...root.querySelectorAll('.wnPage img')].map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth, done: i.complete })), since: (root.querySelector('.wnSince') || {}).textContent || '',
      pager: root.querySelector('.wnPager').textContent, auto: root.classList.contains('auto') } : null),
  };
})();
