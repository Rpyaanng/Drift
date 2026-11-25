/* Drift — what's new: one version's notes (renderer/whats-new/<version>.md), read into a small tree. The What's new window
   (whatsnew.js) draws the tree, and scripts/check-notes.js checks every file with this same reader, so CI and the app never
   disagree about what a file says. Nothing here makes HTML: the window builds elements from the tree, text as text.

   A file is front matter, then Markdown (a small, fixed set of it):
     ---
     version: 1.9.1
     date: 2026-11-25
     title: Send files of any size          (up to 80 characters: the big line at the top)
     hero: hero.svg                         (optional: a picture in whats-new/1.9.1/, shown across the top)
     hero-alt: Two PCs passing a file       (required with hero)
     ---
     ## New | Fixed | Changed | Improved    (sections; any other name is drawn plainly)
     - **A bold start.** The rest.          (a list item; a bold start becomes the item's title)
     ![What it shows](card.png "Caption")   (a picture on its own line, from whats-new/1.9.1/)
     > A note.                              (a callout)
     **bold**, *italic*, `code`, [a link](https://...) inside any text

   parse(text) -> { meta, blocks, errors }. blocks: { t: 'h', level, text, kind } | { t: 'p', c } | { t: 'list', items: [{ lead, c }] }
   | { t: 'img', src, alt, caption } | { t: 'note', c }, where c / lead are inline runs: { t: 'text', v } | { t: 'b' | 'i', c }
   | { t: 'code', v } | { t: 'a', href, c }. */
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.DriftNotes = make();
})(typeof self !== 'undefined' ? self : this, () => {
  const META = ['version', 'date', 'title', 'hero', 'hero-alt'];
  const IMG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(png|jpe?g|webp|gif|svg)$/i;
  const VERSION = /^\d+\.\d+\.\d+$/;

  function inline(s) {
    const out = [];
    let buf = '', i = 0;
    const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length && /[*`[\]\\_]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      if (ch === '`') { const j = s.indexOf('`', i + 1); if (j > i + 1) { flush(); out.push({ t: 'code', v: s.slice(i + 1, j) }); i = j + 1; continue; } }
      if (s.startsWith('**', i)) { const j = s.indexOf('**', i + 2); if (j > i + 2) { flush(); out.push({ t: 'b', c: inline(s.slice(i + 2, j)) }); i = j + 2; continue; } }
      if (ch === '*' && s[i + 1] && s[i + 1] !== ' ' && s[i + 1] !== '*') {
        let j = i + 1;
        while ((j = s.indexOf('*', j)) > 0 && (s[j - 1] === ' ' || s[j + 1] === '*')) j++;
        if (j > i + 1) { flush(); out.push({ t: 'i', c: inline(s.slice(i + 1, j)) }); i = j + 1; continue; }
      }
      if (ch === '[') {
        const m = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/.exec(s.slice(i));
        if (m) { flush(); out.push({ t: 'a', href: m[2], c: inline(m[1]) }); i += m[0].length; continue; }
      }
      buf += ch; i++;
    }
    flush();
    return out;
  }
  const plain = (c) => c.map((n) => (n.v !== undefined ? n.v : plain(n.c || []))).join('');
  const kindOf = (h) => (/^new\b/i.test(h) ? 'new' : /^fix/i.test(h) ? 'fixed' : /^chang/i.test(h) ? 'changed' : /^improv/i.test(h) ? 'improved' : 'other');
  // A list item that starts in bold ("**Send files.** Press +...") gets that as its title.
  // (sub: the item's own list, from lines indented under it with "- ")
  function item(text, sub = []) {
    const c = inline(text), subs = sub.map((s) => item(s));
    // (only a whole label counts: "**Send files.** ..." or "**Scenes**: ...", not "**The bar** runs down ...")
    const label = c[0] && c[0].t === 'b' && c.length > 1 && (/[.:!?]$/.test(plain(c[0].c).trim()) || (c[1].t === 'text' && /^\s*[:—–-]\s/.test(c[1].v)));
    if (label) {
      const rest = c.slice(1);
      if (rest[0].t === 'text') rest[0] = { t: 'text', v: rest[0].v.replace(/^\s*[:—–-]?\s*/, '') };
      return { lead: c[0].c, c: rest.filter((n) => n.t !== 'text' || n.v), sub: subs };
    }
    return { lead: null, c, sub: subs };
  }

  function parse(text) {
    const errors = [], meta = {};
    let lines = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    if (lines[0] === '---') {
      const end = lines.indexOf('---', 1);
      if (end < 0) errors.push('the front matter (between --- lines) never ends');
      for (const l of lines.slice(1, end < 0 ? 1 : end)) {
        const m = /^([a-z-]+):\s*(.*)$/.exec(l);
        if (!m) { if (l.trim()) errors.push(`front matter line "${l}" isn't "key: value"`); continue; }
        if (!META.includes(m[1])) errors.push(`unknown front matter key "${m[1]}" (known: ${META.join(', ')})`);
        meta[m[1]] = m[2].trim();
      }
      lines = lines.slice(end < 0 ? 1 : end + 1);
    } else errors.push('no front matter: the file must start with a --- line');
    const blocks = [];
    let para = null, list = null, note = null, cur = null;       // cur: the list item being read, { text: [lines], sub: [lines of each sub-item] }
    const endItem = () => { if (cur) list.items.push(item(cur.text.join(' '), cur.sub.map((s) => s.join(' ')))); cur = null; };
    const close = () => {
      if (para) blocks.push({ t: 'p', c: inline(para.join(' ')) });
      if (list) { endItem(); blocks.push(list); }
      if (note) blocks.push({ t: 'note', c: inline(note.join(' ')) });
      para = list = note = cur = null;
    };
    for (const raw of lines) {
      const l = raw.replace(/\s+$/, '');
      if (!l.trim()) { close(); continue; }
      let m;
      if ((m = /^(#{2,3})\s+(.+)$/.exec(l))) { close(); blocks.push({ t: 'h', level: m[1].length, text: m[2].trim(), kind: kindOf(m[2].trim()) }); continue; }
      if (/^#\s/.test(l)) { close(); errors.push(`"${l}": use ## for sections (the title is in the front matter)`); continue; }
      if ((m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(l.trim()))) { close(); blocks.push({ t: 'img', alt: m[1].trim(), src: m[2], caption: (m[3] || '').trim() }); continue; }
      if ((m = /^>\s?(.*)$/.exec(l))) { if (!note) { close(); note = []; } note.push(m[1]); continue; }
      if ((m = /^[-*]\s+(.+)$/.exec(l))) {
        if (!list) { close(); list = { t: 'list', items: [] }; }
        endItem();
        cur = { text: [m[1]], sub: [] };
        continue;
      }
      if (cur && (m = /^\s{2,}[-*]\s+(.+)$/.exec(l))) { cur.sub.push([m[1]]); continue; }       // (an item of the item's own)
      if (cur && /^\s{2,}\S/.test(raw)) { (cur.sub.length ? cur.sub[cur.sub.length - 1] : cur.text).push(l.trim()); continue; }       // (an item going on over more lines)
      if (list || note) close();
      (para = para || []).push(l.trim());
    }
    close();
    return { meta, blocks, errors };
  }

  // Everything wrong with one file, as a list of sentences (empty when it's fine). `file` is its name (1.9.1.md); has(name)
  // says whether a picture of that name is in its folder.
  function check(text, file, has = () => true) {
    const { meta, blocks, errors } = parse(text);
    const out = [...errors], v = String(file || '').replace(/\.md$/, '');
    if (!VERSION.test(v)) out.push(`the file name should be the version, like 1.9.1.md`);
    if (meta.version !== v) out.push(`version: says "${meta.version || ''}", but the file is ${file}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date || '') || isNaN(Date.parse(meta.date))) out.push('date: should be the release day, like 2026-11-25');
    if (!meta.title) out.push('title: missing (one line, what this version is about)');
    else if (meta.title.length > 80) out.push(`title: ${meta.title.length} characters, keep it to 80`);
    if (meta.hero !== undefined) {
      if (!IMG.test(meta.hero)) out.push(`hero: "${meta.hero}" isn't a picture name (png, jpg, webp, gif or svg, no folders)`);
      else if (!has(meta.hero)) out.push(`hero: ${meta.hero} isn't in whats-new/${v}/`);
      if (!meta['hero-alt']) out.push('hero-alt: say what the hero picture shows (for people who can\'t see it)');
    }
    if (!blocks.some((b) => b.t === 'list' || b.t === 'p')) out.push('there\'s nothing in it: write at least one line or list');
    for (const b of blocks) {
      if (b.t !== 'img') continue;
      if (!IMG.test(b.src)) out.push(`picture "${b.src}": only a file name in whats-new/${v}/ (png, jpg, webp, gif or svg), no folders or web addresses`);
      else if (!has(b.src)) out.push(`picture ${b.src} isn't in whats-new/${v}/`);
      if (!b.alt) out.push(`picture ${b.src}: say what it shows in the [ ] (for people who can't see it)`);
    }
    return out;
  }
  // Is version a newer than b? (Only the three numbers count.)
  function newer(a, b) {
    const x = String(a || '').split('.').map((n) => parseInt(n, 10) || 0), y = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  }
  return { parse, inline, plain, check, newer, IMG, VERSION };
});
