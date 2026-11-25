// Drift's pointers, drawn the way the others' pointers are: soft, rounded shapes in a person's colour with a white edge and
// a soft shadow (style.css .ptr). One for each pointer a page can ask for, by its CSS name (web.js 'web-cursor').
// window.driftCursor(name) gives { svg, hx, hy, lx, ly }: the shape, where its hotspot is in it (the point that's "where the
// mouse is"), and where the name tag goes, both from the hotspot. Fixed strings: nothing here is built from what a page sends.
(() => {
  // the plain arrow (as before: viewBox 20x24, its point at 3,3)
  const ARROW = 'M3.2 4Q3.2 2.4 4.5 3.4L16.6 13.2Q17.8 14.3 16.2 14.6L10.8 15.2Q9.6 15.3 8.8 16.2L5.2 20.4Q3.2 22.4 3.2 19.8Z';
  const P = (d, cls) => `<path${cls ? ` class="${cls}"` : ''} d="${d}"/>`;
  const ring = (cx, cy, r, w) => `M${cx} ${cy - r}A${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r}ZM${cx} ${cy - r + w}A${r - w} ${r - w} 0 1 0 ${cx + 0.01} ${cy - r + w}Z`;
  const disc = (cx, cy, r) => `M${cx} ${cy - r}A${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r}Z`;
  const rot = (deg, body) => `<g transform="rotate(${deg} 12 12)">${body}</g>`;

  // shapes on a 24x24 grid unless they say otherwise
  const HAND = 'M8 3.4Q8 1.9 9.4 1.9Q10.8 1.9 10.8 3.4V9.6Q10.8 8.4 12.1 8.4Q13.4 8.4 13.4 9.7V10.5Q13.4 9.3 14.7 9.3Q16 9.3 16 10.6V11.4Q16 10.2 17.3 10.2Q18.6 10.2 18.6 11.5V15.6Q18.6 21.4 13.4 21.4H12.2Q9.7 21.4 8.3 19.6L4.7 14.9Q3.9 13.7 4.9 13Q5.9 12.3 6.9 13.2L8 14.4Z';
  const OPEN = 'M7.2 11.6V6.1Q7.2 4.8 8.4 4.8Q9.6 4.8 9.6 6.1V4.5Q9.6 3.2 10.8 3.2Q12 3.2 12 4.5V5Q12 3.7 13.2 3.7Q14.4 3.7 14.4 5V6.7Q14.4 5.4 15.6 5.4Q16.8 5.4 16.8 6.7V15Q16.8 21 11.6 21H11Q8.6 21 7.2 19.2L4.3 15.3Q3.5 14.1 4.5 13.4Q5.5 12.7 6.4 13.5L7.2 14.3Z';
  const OPEN_GAPS = 'M9.6 6.1V10.6M12 5V10.4M14.4 6.7V10.8';       // the cracks between the fingers
  const FIST = 'M6.8 10.4Q6.8 8.7 8.3 8.7Q9.3 8.7 9.6 9.5Q9.9 8.1 11.2 8.1Q12.4 8.1 12.7 9.2Q13.1 8.3 14.2 8.3Q15.4 8.3 15.6 9.5Q16 8.9 16.8 8.9Q18.2 8.9 18.2 10.5V14.7Q18.2 20.1 13 20.1H11.6Q6.8 20.1 6.8 15.1Z';
  const FIST_GAPS = 'M9.6 9.5V11.6M12.7 9.2V11.6M15.6 9.5V11.6';
  const IBEAM = 'M8 3.5Q8 2.5 9 2.5H10.6Q12 2.5 12 3.8Q12 2.5 13.4 2.5H15Q16 2.5 16 3.5Q16 4.5 15 4.5H13.6Q13 4.5 13 5.2V18.8Q13 19.5 13.6 19.5H15Q16 19.5 16 20.5Q16 21.5 15 21.5H13.4Q12 21.5 12 20.2Q12 21.5 10.6 21.5H9Q8 21.5 8 20.5Q8 19.5 9 19.5H10.4Q11 19.5 11 18.8V5.2Q11 4.5 10.4 4.5H9Q8 4.5 8 3.5Z';
  const MOVE = 'M12 1.8L15.6 5.6H13.3V10.7H18.4V8.4L22.2 12L18.4 15.6V13.3H13.3V18.4H15.6L12 22.2L8.4 18.4H10.7V13.3H5.6V15.6L1.8 12L5.6 8.4V10.7H10.7V5.6H8.4Z';
  const BOTH = 'M1.8 12L6.4 7.6V10.6H17.6V7.6L22.2 12L17.6 16.4V13.4H6.4V16.4Z';       // a double arrow, left and right
  const SPLIT = 'M1.8 12L5.8 8V10.7H9.3V12V13.3H5.8V16ZM22.2 12L18.2 8V10.7H14.7V13.3H18.2V16Z';       // two arrows pulling apart, for the bar between them
  const BAR = 'M10.6 3.6Q10.6 2.8 11.4 2.8H12.6Q13.4 2.8 13.4 3.6V20.4Q13.4 21.2 12.6 21.2H11.4Q10.6 21.2 10.6 20.4Z';
  const CROSS = 'M10.8 2.6H13.2V9.4H10.8ZM10.8 14.6H13.2V21.4H10.8ZM2.6 10.8H9.4V13.2H2.6ZM14.6 10.8H21.4V13.2H14.6Z';
  const PLUS = 'M9.6 4.2H14.4V9.6H19.8V14.4H14.4V19.8H9.6V14.4H4.2V9.6H9.6Z';
  const HANDLE = 'M14.7 16.6L16.6 14.7L21.4 19.5Q22.1 20.5 21.3 21.3Q20.5 22.1 19.5 21.4Z';
  const NO_BAR = 'M6.3 15.6L15.6 6.3L17.7 8.4L8.4 17.7Z';
  const QMARK = 'M14.9 15.7Q14.9 14.1 16.6 14.1Q18.3 14.1 18.3 15.6Q18.3 16.6 16.9 17.1Q16.6 17.2 16.6 17.6V18';

  // a badge at the arrow's lower right: a small disc with a white sign on it
  const badge = (sign) => P(disc(16.4, 17.6, 5)) + sign;
  const S = {
    default: { vb: '0 0 20 24', w: 20, h: 24, hx: 3, hy: 3, body: P(ARROW) },
    pointer: { hx: 9.4, hy: 2.2, lx: 9, ly: 19, body: P(HAND) },
    grab: { hx: 12, hy: 12, lx: 8, ly: 10, body: P(OPEN) + P(OPEN_GAPS, 'cut') },
    grabbing: { hx: 12, hy: 12, lx: 8, ly: 10, body: P(FIST) + P(FIST_GAPS, 'cut') },
    text: { hx: 12, hy: 12, lx: 7, ly: 11, body: P(IBEAM) },
    'vertical-text': { hx: 12, hy: 12, lx: 10, ly: 7, body: rot(90, P(IBEAM)) },
    wait: { hx: 12, hy: 12, lx: 9, ly: 9, body: P(ring(12, 12, 8.6, 3.4)) + `<g class="spin">${P('M12 5.1A6.9 6.9 0 0 1 18.9 12', 'line')}</g>` },
    progress: { vb: '0 0 24 26', w: 24, h: 26, hx: 3, hy: 3, lx: 11, ly: 21,
      body: P(ARROW) + P(ring(16.6, 19, 5.2, 2.4)) + `<g class="spin" style="transform-origin:16.6px 19px">${P('M16.6 15.1A3.9 3.9 0 0 1 20.5 19', 'line thin')}</g>` },
    help: { vb: '0 0 24 24', hx: 3, hy: 3, lx: 13, ly: 21, body: P(ARROW) + badge(P(QMARK, 'line thin') + P(disc(16.6, 20.1, 0.75), 'dot')) },
    copy: { vb: '0 0 24 24', hx: 3, hy: 3, lx: 13, ly: 21, body: P(ARROW) + badge(P('M16.4 15.2V20M14 17.6H18.8', 'line thin')) },
    alias: { vb: '0 0 24 24', hx: 3, hy: 3, lx: 13, ly: 21, body: P(ARROW) + badge(P('M14.6 19.4L18 16M15.6 15.9H18.1V18.4', 'line thin')) },
    'context-menu': { vb: '0 0 24 24', hx: 3, hy: 3, lx: 13, ly: 21, body: P(ARROW) + badge(P('M14.2 16H18.6M14.2 17.7H18.6M14.2 19.4H18.6', 'line thin')) },
    'not-allowed': { hx: 12, hy: 12, lx: 9, ly: 9, body: P(ring(12, 12, 8.6, 3) + NO_BAR) },       // (one path: the bar and the ring share one white edge)
    crosshair: { hx: 12, hy: 12, lx: 9, ly: 9, body: P(CROSS) },
    cell: { hx: 12, hy: 12, lx: 9, ly: 9, body: P(PLUS) },
    move: { hx: 12, hy: 12, lx: 9, ly: 10, body: P(MOVE) },
    'ew-resize': { hx: 12, hy: 12, lx: 6, ly: 7, body: P(BOTH) },
    'ns-resize': { hx: 12, hy: 12, lx: 7, ly: 10, body: rot(90, P(BOTH)) },
    'nesw-resize': { hx: 12, hy: 12, lx: 7, ly: 9, body: rot(-45, P(BOTH)) },
    'nwse-resize': { hx: 12, hy: 12, lx: 7, ly: 9, body: rot(45, P(BOTH)) },
    'col-resize': { hx: 12, hy: 12, lx: 6, ly: 10, body: P(SPLIT) + P(BAR) },
    'row-resize': { hx: 12, hy: 12, lx: 9, ly: 9, body: rot(90, P(SPLIT) + P(BAR)) },
    'zoom-in': { hx: 9.6, hy: 9.6, lx: 9, ly: 11, body: P(HANDLE) + P(disc(9.6, 9.6, 7.2)) + P('M9.6 6.6V12.6M6.6 9.6H12.6', 'line') },
    'zoom-out': { hx: 9.6, hy: 9.6, lx: 9, ly: 11, body: P(HANDLE) + P(disc(9.6, 9.6, 7.2)) + P('M6.6 9.6H12.6', 'line') },
  };
  const SAME = { auto: 'default', '': 'default', 'no-drop': 'not-allowed', 'all-scroll': 'move', 'e-resize': 'ew-resize', 'w-resize': 'ew-resize',
    'n-resize': 'ns-resize', 's-resize': 'ns-resize', 'ne-resize': 'nesw-resize', 'sw-resize': 'nesw-resize', 'nw-resize': 'nwse-resize', 'se-resize': 'nwse-resize' };
  const made = new Map();
  window.driftCursor = (name) => {
    const k = S[name] ? name : S[SAME[name]] ? SAME[name] : 'default';
    if (made.has(k)) return made.get(k);
    const s = S[k], w = s.w || 24, h = s.h || 24;
    const out = { name: k, hx: s.hx, hy: s.hy, lx: s.lx !== undefined ? s.lx : 11, ly: s.ly !== undefined ? s.ly : 17,
      svg: `<svg viewBox="${s.vb || '0 0 24 24'}" width="${w}" height="${h}" style="left:${-s.hx}px;top:${-s.hy}px">${s.body}</svg>` };
    made.set(k, out);
    return out;
  };
  window.driftCursor.names = [...Object.keys(S), ...Object.keys(SAME).filter(Boolean)];

  // A person's colour. Their hue comes from their name, so it's the same on every PC: one of ten picked to sit apart from each
  // other. How light and how strong it is follows Drift's accent (the palette's main colour), so pointers fit the scene: soft
  // with a muted palette, bright with a vivid one. Kept light enough for the dark ink on the tag, and never grey.
  const HUES = [[0.74, 0.16, 25], [0.79, 0.15, 55], [0.86, 0.15, 88], [0.87, 0.18, 128], [0.8, 0.17, 155], [0.8, 0.12, 192], [0.79, 0.12, 232], [0.71, 0.15, 266], [0.72, 0.17, 298], [0.75, 0.17, 345]];
  function oklchOf(hex) {       // '#rrggbb' -> [l, c, h] (OKLab, Björn Ottosson's)
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return null;
    const lin = [0, 2, 4].map((i) => { const v = parseInt(m[1].slice(i, i + 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const [r, g, b] = lin;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s, A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
    return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  window.driftPtrColor = (name, accent) => {
    let h = 7; for (const ch of String(name)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
    const [l0, c0, hue] = HUES[h % HUES.length], a = oklchOf(accent);
    if (!a) return `oklch(${l0} ${c0} ${hue})`;
    const l = clamp(l0 * 0.6 + a[0] * 0.4, 0.68, 0.9);       // partway to the accent's lightness
    const c = clamp(c0 * clamp(a[1] / 0.13, 0.45, 1.25), 0.05, 0.21);       // as strong as the accent is, give or take (0.13: a middling one)
    const turn = ((a[2] - hue + 540) % 360) - 180;       // the short way round to the accent's hue
    const h2 = (hue + clamp(turn * 0.15, -15, 15) * clamp(a[1] / 0.1, 0, 1) + 360) % 360;       // a nudge toward it (none for a grey accent): related, still apart
    return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h2.toFixed(1)})`;
  };
  // Your own pointer, on your own screen: the accent itself, only lifted into the same light range as everyone's (for the tag's ink)
  window.driftSelfColor = (accent) => {
    const a = oklchOf(accent);
    if (!a) return 'oklch(0.8 0.15 155)';
    return `oklch(${clamp(a[0], 0.72, 0.9).toFixed(3)} ${clamp(a[1], 0.05, 0.21).toFixed(3)} ${a[2].toFixed(1)})`;
  };
})();
