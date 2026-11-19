// Drift — runs in every Surf page and frame (see web.js), but only does anything in a page drawn offscreen ("Draw Surf on the
// graphics card"). Chromium doesn't draw a <select>'s open list there, so clicking one would seem to do nothing. Instead its options
// open as a plain list in the page itself, under the box; picking one sets the box as choosing it would (input and change events
// included). The keyboard on a focused box works as usual.
// It runs in the frame's isolated world, so the page's own scripts can't see or change it.
(() => {
  if (!(typeof process !== 'undefined' && Array.isArray(process.argv) && process.argv.includes('--drift-offscreen'))) return;
  let open = null;       // { host, sel }
  const close = () => { if (open) { open.host.remove(); open = null; } };
  function show(sel) {
    close();
    const r = sel.getBoundingClientRect();
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    const below = innerHeight - r.bottom, up = below < 160 && r.top > below;
    const room = Math.max(80, (up ? r.top : below) - 8);
    root.innerHTML = `<style>
      .list { position: fixed; left: ${Math.max(0, Math.min(r.left, innerWidth - Math.max(r.width, 120)))}px; ${up ? `bottom: ${innerHeight - r.top}px` : `top: ${r.bottom}px`};
        min-width: ${Math.max(r.width, 120)}px; max-width: 90vw; max-height: ${Math.min(room, innerHeight * 0.6)}px; overflow: auto; box-sizing: border-box;
        background: #fff; color: #111; border: 1px solid #8a8a8a; box-shadow: 0 4px 14px rgba(0,0,0,.25); font: 14px/1.2 system-ui, sans-serif; color-scheme: light; }
      .o { padding: 5px 10px; white-space: nowrap; cursor: default; }
      .o.on { background: #1a73e8; color: #fff; }
      .o.off { color: #999; }
      .g { padding: 5px 8px 3px; font-weight: 600; color: #444; }
      .g ~ .o { padding-left: 20px; }
    </style><div class="list"></div>`;
    const list = root.querySelector('.list');
    let i = 0;
    for (const el of sel.children) {
      const opts = el.tagName === 'OPTGROUP' ? [...el.children] : [el];
      if (el.tagName === 'OPTGROUP') { const g = document.createElement('div'); g.className = 'g'; g.textContent = el.label; list.append(g); }
      for (const o of opts) {
        if (o.tagName !== 'OPTION') continue;
        const row = document.createElement('div'), idx = i++;
        row.className = 'o' + (o.disabled || (el.disabled && el !== o) ? ' off' : '') + (idx === sel.selectedIndex ? ' on' : '');
        row.textContent = o.label || o.text;
        row.pick = () => {
          close();
          if (sel.selectedIndex !== idx) {
            sel.selectedIndex = idx;
            sel.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          sel.focus();
        };
        list.append(row);
      }
    }
    (document.body || document.documentElement).append(host);
    const on = list.querySelector('.o.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    open = { host, root, sel };
  }
  // The list's own mouse events are handled here, before any of the page's listeners (this runs first), and go no further: the page
  // sees nothing of them, as with a native list. A click on a row picks it; a click anywhere else closes the list.
  const row = (e) => { const el = open && open.root.elementFromPoint(e.clientX, e.clientY); return el && el.closest('.o'); };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'pointermove', 'mousemove']) {
    addEventListener(type, (e) => {
      if (!open || e.target !== open.host) return;
      e.stopImmediatePropagation();
      if (type !== 'pointermove' && type !== 'mousemove') e.preventDefault();
      const r = row(e);
      if (type === 'mousemove') { for (const x of open.root.querySelectorAll('.o.on')) if (x !== r) x.classList.remove('on'); if (r && !r.classList.contains('off')) r.classList.add('on'); }
      else if (type === 'click') { if (!r) close(); else if (!r.classList.contains('off')) r.pick(); }
    }, true);
  }
  // A click on a box opens its list once the button comes up, so the box gets the whole click, as it would natively
  let armed = null;
  addEventListener('mousedown', (e) => {
    armed = null;
    if (e.button !== 0) return;
    const sel = e.composedPath().find((n) => n && n.tagName === 'SELECT');
    if (!sel || sel.multiple || sel.size > 1 || sel.disabled) return;
    e.preventDefault();       // no native list (it wouldn't show)
    sel.focus(); armed = sel;
  }, true);
  addEventListener('mouseup', (e) => {
    const sel = armed; armed = null;
    if (sel && e.button === 0 && e.composedPath().includes(sel)) setTimeout(() => show(sel));       // (after the click, which still lands on the box)
  }, true);
  addEventListener('keydown', (e) => { if (open && (e.key === 'Escape' || e.key === 'Tab')) close(); }, true);
  addEventListener('scroll', (e) => { if (open && !open.host.contains(e.target)) close(); }, true);
  addEventListener('resize', close);
})();
