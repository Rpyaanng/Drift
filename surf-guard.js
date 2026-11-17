// Drift — runs in every page and frame of the Surf tab's browser (registered by web.js), in its own isolated world, so the
// page's scripts can't see or undo it. While friends are watching a page together, anyone could press a site's
// "show password" button and read what someone typed. So a password box stays a password box: if anything turns one
// into a plain text box, it is turned straight back. The page and its passwords are otherwise left alone.
(() => {
  const secret = new WeakSet();            // every input that has been a password box
  const watched = new WeakSet();
  const isInput = (n) => n && n.nodeType === 1 && n.tagName === 'INPUT';
  const fix = (el) => { if (secret.has(el) && String(el.getAttribute('type') || '').toLowerCase() !== 'password') el.setAttribute('type', 'password'); };
  // one observer per box: it also covers boxes inside shadow roots, which a document-wide observer can't see
  const boxObserver = new MutationObserver((list) => { for (const m of list) fix(m.target); });
  function track(el) {
    if (!isInput(el) || watched.has(el)) return;
    if (String(el.getAttribute('type') || '').toLowerCase() !== 'password' && !secret.has(el)) return;
    secret.add(el); watched.add(el);
    boxObserver.observe(el, { attributes: true, attributeFilter: ['type'] });
  }
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (isInput(root)) track(root);
    for (const el of root.querySelectorAll('input[type="password" i]')) track(el);
  }
  // new password boxes, and boxes made into password boxes later
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') { if (isInput(m.target) && String(m.target.getAttribute('type') || '').toLowerCase() === 'password') track(m.target); }
      else for (const n of m.addedNodes) scan(n);
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['type'] });
  // A box inside a shadow root is found when someone uses it, or clicks anything in the same shadow root (its eye button,
  // say): these events cross shadow boundaries, and their path names the shadow roots they came through.
  const touch = (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    if (isInput(path[0])) { track(path[0]); fix(path[0]); }
    for (const n of path) if (n && n.nodeType === 11 && n.host) scan(n);
  };
  for (const ev of ['focusin', 'keydown', 'input', 'pointerdown']) addEventListener(ev, touch, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan(document)); else scan(document);
})();
