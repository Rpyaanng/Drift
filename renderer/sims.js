/* Drift — algorithm simulations that feed the Sorting, Game of Life and Maze shaders.
   Everything is a pure function of the shared scene clock (and a seed derived from it), so every
   monitor computes exactly the same picture without talking to the others. */
(() => {
  const rng = (seed) => {
    let s = (seed * 2654435761) >>> 0 || 1;
    return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (n) => n.toLocaleString();

  // ------------------------------------------------------------------ sorting
  function recorder(a) {
    const ops = [];
    return {
      a, ops,
      less(i, j) { ops.push(0, i, j); return a[i] < a[j]; },
      look(i, j) { ops.push(0, i, j); },
      swap(i, j) { if (i === j) return; ops.push(1, i, j); const t = a[i]; a[i] = a[j]; a[j] = t; },
      set(i, v) { ops.push(2, i, v); a[i] = v; },
    };
  }
  const ALGOS = [
    ['Quick sort', (r) => {
      const qs = (lo, hi) => {
        while (lo < hi) {
          r.swap((lo + hi) >> 1, hi);
          let p = lo;
          for (let i = lo; i < hi; i++) if (r.less(i, hi)) { r.swap(i, p); p++; }
          r.swap(p, hi);
          if (p - lo < hi - p) { qs(lo, p - 1); lo = p + 1; } else { qs(p + 1, hi); hi = p - 1; }
        }
      };
      qs(0, r.a.length - 1);
    }],
    ['Merge sort', (r) => {
      const a = r.a;
      const ms = (lo, hi) => {
        if (hi <= lo) return;
        const m = (lo + hi) >> 1; ms(lo, m); ms(m + 1, hi);
        const L = a.slice(lo, m + 1), R = a.slice(m + 1, hi + 1);
        let i = 0, j = 0, k = lo;
        while (i < L.length && j < R.length) { r.look(k, m + 1 + j); r.set(k++, L[i] <= R[j] ? L[i++] : R[j++]); }
        while (i < L.length) r.set(k++, L[i++]);
        while (j < R.length) r.set(k++, R[j++]);
      };
      ms(0, a.length - 1);
    }],
    ['Heap sort', (r) => {
      const n = r.a.length;
      const sift = (i, size) => {
        for (;;) {
          const l = 2 * i + 1; let m = i;
          if (l < size && r.less(m, l)) m = l;
          if (l + 1 < size && r.less(m, l + 1)) m = l + 1;
          if (m === i) return;
          r.swap(i, m); i = m;
        }
      };
      for (let i = (n >> 1) - 1; i >= 0; i--) sift(i, n);
      for (let e = n - 1; e > 0; e--) { r.swap(0, e); sift(0, e); }
    }],
    ['Shell sort', (r) => {
      const n = r.a.length;
      for (const gap of [701, 301, 132, 57, 23, 10, 4, 1].filter((g) => g < n)) {
        for (let i = gap; i < n; i++) for (let j = i; j >= gap && r.less(j, j - gap); j -= gap) r.swap(j, j - gap);
      }
    }],
    ['Insertion sort', (r) => {
      for (let i = 1; i < r.a.length; i++) for (let j = i; j > 0 && r.less(j, j - 1); j--) r.swap(j, j - 1);
    }],
    ['Radix sort (base 4)', (r) => {
      const a = r.a, n = a.length;
      for (let shift = 1; shift < n; shift *= 4) {
        const buckets = [[], [], [], []];
        for (let i = 0; i < n; i++) { r.look(i, i); buckets[Math.floor(a[i] / shift) % 4].push(a[i]); }
        let k = 0;
        for (const b of buckets) for (const v of b) r.set(k++, v);
      }
    }],
    ['Cocktail shaker sort', (r) => {
      let lo = 0, hi = r.a.length - 1, swapped = true;
      while (swapped && lo < hi) {
        swapped = false;
        for (let i = lo; i < hi; i++) if (r.less(i + 1, i)) { r.swap(i, i + 1); swapped = true; }
        hi--;
        for (let i = hi; i > lo; i--) if (r.less(i, i - 1)) { r.swap(i, i - 1); swapped = true; }
        lo++;
      }
    }],
    ['Selection sort', (r) => {
      const n = r.a.length;
      for (let i = 0; i < n - 1; i++) { let m = i; for (let j = i + 1; j < n; j++) if (r.less(j, m)) m = j; r.swap(i, m); }
    }],
  ];
  const S_SHUF = 2, S_SORT = 28, S_CHECK = 1.6, S_EPOCH = 34;

  class Sorting {
    constructor(aspect) {
      this.n = clamp(Math.round(48 * aspect), 48, 256);
      this.w = this.n; this.h = 1; this.data = new Uint8Array(this.n * 4); this.version = 0;
      this.epoch = -1; this.text = '';
    }
    build(k) {
      const n = this.n, rand = rng(k * 7919 + 13);
      this.algo = ALGOS[((k % ALGOS.length) + ALGOS.length) % ALGOS.length];
      const sorted = Array.from({ length: n }, (_, i) => i);
      const shuf = recorder(sorted.slice());
      for (let i = n - 1; i > 0; i--) shuf.swap(i, Math.floor(rand() * (i + 1)));
      const run = recorder(shuf.a.slice());
      this.algo[1](run);
      this.nShuf = shuf.ops.length / 3;
      this.ops = Int32Array.from(shuf.ops.concat(run.ops));
      this.total = this.ops.length / 3;
      this.epoch = k; this.reset();
    }
    reset() {
      this.arr = Int32Array.from({ length: this.n }, (_, i) => i);
      this.touched = new Float64Array(this.n).fill(-1e9);
      this.applied = 0; this.cmp = 0; this.swaps = 0; this.writes = 0;
    }
    update(t) {
      const k = Math.floor(t / S_EPOCH);
      if (k !== this.epoch) this.build(k);
      const lt = t - k * S_EPOCH, ns = this.nShuf, nr = this.total - ns;
      let target, rate;
      if (lt < S_SHUF) { target = Math.floor((lt / S_SHUF) * ns); rate = ns / S_SHUF; }
      else if (lt < S_SHUF + S_SORT) { target = ns + Math.floor(((lt - S_SHUF) / S_SORT) * nr); rate = nr / S_SORT; }
      else { target = this.total; rate = 1; }
      if (target < this.applied) this.reset();
      const o = this.ops;
      for (let q = this.applied; q < target; q++) {
        const ty = o[q * 3], i = o[q * 3 + 1], j = o[q * 3 + 2], sorting = q >= ns;
        if (ty === 0) { if (sorting) this.cmp++; this.touched[i] = q; this.touched[j] = q; }
        else if (ty === 1) { const tmp = this.arr[i]; this.arr[i] = this.arr[j]; this.arr[j] = tmp; if (sorting) this.swaps++; this.touched[i] = q; this.touched[j] = q; }
        else { this.arr[i] = j; if (sorting) this.writes++; this.touched[i] = q; }
      }
      this.applied = target;
      const win = Math.max(3, rate * 0.18), n = this.n, d = this.data;
      const sweep = lt > S_SHUF + S_SORT ? ((lt - S_SHUF - S_SORT) / S_CHECK) * n : -1;
      for (let i = 0; i < n; i++) {
        const age = target - this.touched[i];
        d[i * 4] = Math.round((this.arr[i] / (n - 1)) * 255);
        d[i * 4 + 1] = target < this.total && age < win ? Math.round(255 * (1 - age / win)) : 0;
        d[i * 4 + 2] = sweep > i ? Math.round(255 * clamp(1 - (sweep - i) / (n * 0.6), 0.25, 1)) : 0;
        d[i * 4 + 3] = 255;
      }
      this.version++;
      const name = this.algo[0], moves = name.startsWith('Radix') ? `${fmt(this.writes)} writes` : name.startsWith('Merge') ? `${fmt(this.writes)} writes` : `${fmt(this.swaps)} swaps`;
      this.text = lt < S_SHUF ? `${name} — shuffling ${n} values`
        : target < this.total ? `${name} — ${fmt(this.cmp)} ${name.startsWith('Radix') ? 'digit reads' : 'comparisons'} · ${moves}`
        : `${name} — sorted ✓  ${fmt(this.cmp)} ${name.startsWith('Radix') ? 'digit reads' : 'comparisons'} · ${moves}`;
    }
    label() { return this.text; }
  }

  // ------------------------------------------------------------------ Conway's Game of Life
  const L_EPOCH = 80, L_RATE = 7;
  class Life {
    constructor(aspect) {
      this.h = 72; this.w = clamp(Math.round(72 * aspect), 24, 512);
      this.data = new Uint8Array(this.w * this.h * 4); this.version = 0; this.epoch = -1; this.gen = 0; this.pop = 0;
    }
    seed(k) {
      const W = this.w, H = this.h, rand = rng(k * 104729 + 7);
      this.cur = new Uint8Array(W * H); this.nxt = new Uint8Array(W * H);
      this.trail = new Uint8Array(W * H); this.age = new Uint16Array(W * H);
      for (let i = 0; i < W * H; i++) this.cur[i] = rand() < 0.3 ? 1 : 0;
      this.epoch = k; this.gen = 0;
    }
    inject(rand) {           // drop a glider or an R-pentomino somewhere so the board never goes quiet
      const W = this.w, H = this.h, x0 = Math.floor(rand() * W), y0 = Math.floor(rand() * H);
      const shapes = [[[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]], [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]], [[0, 0], [1, 0], [2, 0], [2, 1], [1, 2]]];
      for (const [dx, dy] of shapes[Math.floor(rand() * shapes.length)]) this.cur[((y0 + dy) % H) * W + ((x0 + dx) % W)] = 1;
    }
    step() {
      const W = this.w, H = this.h, c = this.cur, nx = this.nxt;
      let pop = 0;
      for (let y = 0; y < H; y++) {
        const ym = ((y + H - 1) % H) * W, y0 = y * W, yp = ((y + 1) % H) * W;
        for (let x = 0; x < W; x++) {
          const xm = (x + W - 1) % W, xp = (x + 1) % W;
          const nb = c[ym + xm] + c[ym + x] + c[ym + xp] + c[y0 + xm] + c[y0 + xp] + c[yp + xm] + c[yp + x] + c[yp + xp];
          const i = y0 + x, alive = nb === 3 || (nb === 2 && c[i]) ? 1 : 0;
          nx[i] = alive; pop += alive;
          if (alive) { this.trail[i] = 255; if (this.age[i] < 65535) this.age[i]++; }
          else { this.trail[i] = this.trail[i] > 20 ? this.trail[i] - 20 : 0; this.age[i] = 0; }
        }
      }
      this.cur = nx; this.nxt = c; this.gen++; this.pop = pop;
      if (this.gen % 40 === 0) { const r = rng(this.epoch * 1000 + this.gen); this.inject(r); this.inject(r); }
    }
    update(t) {
      const k = Math.floor(t / L_EPOCH), g = Math.floor((t - k * L_EPOCH) * L_RATE);
      if (k !== this.epoch || g < this.gen) this.seed(k);
      if (g === this.gen && this.version) return;
      let budget = 900;                                        // never stall a frame catching up
      while (this.gen < g && budget-- > 0) this.step();
      const d = this.data, N = this.w * this.h;
      for (let i = 0; i < N; i++) {
        d[i * 4] = this.cur[i] ? 255 : 0; d[i * 4 + 1] = this.trail[i];
        d[i * 4 + 2] = Math.min(255, this.age[i] * 6); d[i * 4 + 3] = 255;
      }
      this.version++;
    }
    label() { return `Conway's Game of Life — generation ${fmt(this.gen)} · ${fmt(this.pop)} alive`; }
  }

  // ------------------------------------------------------------------ maze: depth-first carve, breadth-first solve
  const M_CARVE = 34, M_FLOOD = 14, M_PATH = 3, M_EPOCH = 58;
  class Maze {
    constructor(aspect) {
      this.ch = 22; this.cw = clamp(Math.round(22 * aspect), 8, 200);
      this.w = 2 * this.cw + 1; this.h = 2 * this.ch + 1;
      this.data = new Uint8Array(this.w * this.h * 4); this.version = 0; this.epoch = -1; this.key = ''; this.text = '';
    }
    build(k) {
      const W = this.cw, H = this.ch, N = W * H, rand = rng(k * 31337 + 3);
      const parent = new Int32Array(N).fill(-1), carveAt = new Int32Array(N).fill(1 << 30), heads = [];
      const seen = new Uint8Array(N), stack = [0];
      seen[0] = 1; carveAt[0] = 0; heads.push(0);
      const nbrs = (c) => { const x = c % W, y = (c / W) | 0, r = []; if (x > 0) r.push(c - 1); if (x < W - 1) r.push(c + 1); if (y > 0) r.push(c - W); if (y < H - 1) r.push(c + W); return r; };
      const adj = Array.from({ length: N }, () => []);
      while (stack.length) {
        const cur = stack[stack.length - 1], open = nbrs(cur).filter((c) => !seen[c]);
        if (open.length) {
          const nx = open[Math.floor(rand() * open.length)];
          seen[nx] = 1; parent[nx] = cur; carveAt[nx] = heads.length; adj[cur].push(nx); adj[nx].push(cur);
          stack.push(nx);
        } else stack.pop();
        heads.push(stack.length ? stack[stack.length - 1] : 0);
      }
      const dist = new Int32Array(N).fill(-1), from = new Int32Array(N).fill(-1), q = [0];
      dist[0] = 0;
      for (let h = 0; h < q.length; h++) for (const nb of adj[q[h]]) if (dist[nb] < 0) { dist[nb] = dist[q[h]] + 1; from[nb] = q[h]; q.push(nb); }
      let maxD = 0; for (let i = 0; i < N; i++) maxD = Math.max(maxD, dist[i]);
      const path = []; for (let c = N - 1; c >= 0; c = from[c]) { path.push(c); if (c === 0) break; }
      path.reverse();
      Object.assign(this, { parent, carveAt, heads, dist, maxD, path, epoch: k });
    }
    update(t) {
      const k = Math.floor(t / M_EPOCH);
      if (k !== this.epoch) this.build(k);
      const lt = t - k * M_EPOCH, steps = this.heads.length;
      const s = lt < M_CARVE ? Math.floor((lt / M_CARVE) * steps) : steps;
      const L = lt < M_CARVE ? -1 : lt < M_CARVE + M_FLOOD ? Math.floor(((lt - M_CARVE) / M_FLOOD) * this.maxD) : this.maxD;
      const P = lt < M_CARVE + M_FLOOD ? 0 : Math.min(this.path.length, Math.floor(((lt - M_CARVE - M_FLOOD) / M_PATH) * this.path.length));
      const key = `${k}|${s}|${L}|${P}`;
      if (key === this.key) return;
      this.key = key;
      const W = this.cw, TW = this.w, d = this.data, N = W * this.ch;
      d.fill(0);
      const px = (c) => ((2 * ((c / W) | 0) + 1) * TW + 2 * (c % W) + 1) * 4;
      const link = (a, b) => (px(a) + px(b)) / 2;      // the wall slot between two neighbouring cells
      let carved = 0;
      for (let c = 0; c < N; c++) {
        if (this.carveAt[c] > s) continue;
        carved++;
        const g = L >= 0 && this.dist[c] <= L ? 1 + Math.round((this.dist[c] / Math.max(1, this.maxD)) * 254) : 0;
        const rec = lt < M_CARVE ? Math.round(150 + 105 * Math.max(0, 1 - (s - this.carveAt[c]) / (steps * 0.08))) : 200;   // newly carved cells glow
        const a = px(c); d[a] = rec; d[a + 1] = g;
        if (this.parent[c] >= 0) { const b = link(c, this.parent[c]); d[b] = rec; d[b + 1] = g; }
      }
      for (let i = 0; i < P; i++) { const c = this.path[i]; d[px(c) + 2] = 255; if (i > 0) d[link(c, this.path[i - 1]) + 2] = 255; }
      if (lt < M_CARVE) d[px(this.heads[Math.min(s, steps - 1)]) + 3] = 255;
      this.version++;
      this.text = lt < M_CARVE ? `Maze — carving with depth-first search · ${fmt(carved)} / ${fmt(N)} cells`
        : lt < M_CARVE + M_FLOOD ? `Solving — breadth-first search · ${fmt(Math.max(0, L))} steps out`
        : `Shortest path found — ${fmt(this.path.length - 1)} steps`;
    }
    label() { return this.text; }
  }

  window.SIMS = { sorting: Sorting, life: Life, maze: Maze };

  // captions for the shader-only algorithm scenes
  window.ALGO_LABELS = {
    sierpinski: (t) => `Sierpiński triangle — ${fmt(Math.floor(t * 0.03 * 3))} levels deep`,
    julia: (t) => { const a = t * 0.035, k = 0.985, re = k * (Math.cos(a) / 2 - Math.cos(2 * a) / 4), im = k * (Math.sin(a) / 2 - Math.sin(2 * a) / 4); return `Julia set — c = ${re.toFixed(3)} ${im < 0 ? '−' : '+'} ${Math.abs(im).toFixed(3)}i`; },
    hilbert: (t) => { const ph = (((t * 0.02) % 1) + 1) % 1; return `Hilbert curve — order 6 · ${Math.round(Math.min(ph / 0.8, 1) * 100)}% drawn`; },
    voronoi: () => 'Voronoi diagram — each region is closest to one moving point',
  };
})();
