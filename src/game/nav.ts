// Navigation grid + A* for the AI.

import type { V2 } from '../core/math';
import { type GameMap, solidAt } from './map';

export class NavGrid {
  cell = 2.5;
  n: number;
  blocked: Uint8Array;
  cost: Float32Array;
  constructor(map: GameMap) {
    this.n = Math.ceil(map.size / this.cell);
    const N = this.n * this.n;
    this.blocked = new Uint8Array(N);
    this.cost = new Float32Array(N).fill(1);
    for (let y = 0; y < this.n; y++) {
      for (let x = 0; x < this.n; x++) {
        const p = { x: (x + 0.5) * this.cell, y: (y + 0.5) * this.cell };
        const i = y * this.n + x;
        if (p.x < 4 || p.y < 4 || p.x > map.size - 4 || p.y > map.size - 4 || solidAt(map, p, 2.6)) this.blocked[i] = 1;
      }
    }
    for (const t of map.trees) {
      if (!t.alive) continue;
      const cx = Math.floor(t.x / this.cell);
      const cy = Math.floor(t.y / this.cell);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= this.n || y >= this.n) continue;
          this.cost[y * this.n + x] = Math.max(this.cost[y * this.n + x], t.shrub ? 1.6 : 3.5);
        }
    }
    for (const r of map.roads) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i];
        const b = r.pts[i + 1];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        for (let d = 0; d <= L; d += this.cell) {
          const x = Math.floor((a.x + ((b.x - a.x) * d) / (L || 1)) / this.cell);
          const y = Math.floor((a.y + ((b.y - a.y) * d) / (L || 1)) / this.cell);
          if (x < 0 || y < 0 || x >= this.n || y >= this.n) continue;
          const i2 = y * this.n + x;
          if (this.cost[i2] <= 1) this.cost[i2] = 0.85;
        }
      }
    }
  }

  idx(p: V2): number {
    const x = Math.min(this.n - 1, Math.max(0, Math.floor(p.x / this.cell)));
    const y = Math.min(this.n - 1, Math.max(0, Math.floor(p.y / this.cell)));
    return y * this.n + x;
  }
  center(i: number): V2 {
    return { x: ((i % this.n) + 0.5) * this.cell, y: (Math.floor(i / this.n) + 0.5) * this.cell };
  }
  free(p: V2): boolean {
    return !this.blocked[this.idx(p)];
  }
  nearestFree(i: number): number {
    if (!this.blocked[i]) return i;
    const cx = i % this.n;
    const cy = Math.floor(i / this.n);
    for (let r = 1; r < 20; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= this.n || y >= this.n) continue;
          const j = y * this.n + x;
          if (!this.blocked[j]) return j;
        }
    }
    return i;
  }

  /** Straight walkable line on the grid? */
  walkable(a: V2, b: V2): boolean {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(L / (this.cell * 0.5));
    for (let s = 0; s <= steps; s++) {
      const t = s / Math.max(1, steps);
      const i = this.idx({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      if (this.blocked[i] || this.cost[i] > 3) return false;
    }
    return true;
  }

  findPath(from: V2, to: V2, maxIter = 40000): V2[] | null {
    const n = this.n;
    const start = this.nearestFree(this.idx(from));
    const goal = this.nearestFree(this.idx(to));
    if (start === goal) return [to];
    const g = new Float32Array(n * n).fill(Infinity);
    const came = new Int32Array(n * n).fill(-1);
    const closed = new Uint8Array(n * n);
    const heap: number[] = [];
    const f = new Float32Array(n * n).fill(Infinity);
    const gx = goal % n;
    const gy = Math.floor(goal / n);
    const h = (i: number) => {
      const dx = Math.abs((i % n) - gx);
      const dy = Math.abs(Math.floor(i / n) - gy);
      return (dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy)) * 0.85;
    };
    const push = (i: number) => {
      heap.push(i);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (f[heap[p]] <= f[heap[k]]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = (): number => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = k * 2 + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && f[heap[l]] < f[heap[m]]) m = l;
          if (r < heap.length && f[heap[r]] < f[heap[m]]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    g[start] = 0;
    f[start] = h(start);
    push(start);
    let iter = 0;
    const DIRS = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [-1, -1, Math.SQRT2],
    ];
    while (heap.length && iter++ < maxIter) {
      const cur = pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % n;
      const cy = Math.floor(cur / n);
      for (const [dx, dy, dc] of DIRS) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const j = y * n + x;
        if (this.blocked[j] || closed[j]) continue;
        if (dx && dy && (this.blocked[cy * n + x] || this.blocked[y * n + cx])) continue;
        const ng = g[cur] + dc * this.cost[j];
        if (ng < g[j]) {
          g[j] = ng;
          f[j] = ng + h(j);
          came[j] = cur;
          push(j);
        }
      }
    }
    if (came[goal] < 0) return null;
    const cells: number[] = [];
    for (let c = goal; c !== start && c >= 0; c = came[c]) cells.push(c);
    cells.reverse();
    const raw = cells.map((c) => this.center(c));
    raw[raw.length - 1] = this.free(to) ? to : raw[raw.length - 1];
    // string pulling
    const out: V2[] = [];
    let anchor = from;
    let i = 0;
    while (i < raw.length) {
      let j = raw.length - 1;
      while (j > i && !this.walkable(anchor, raw[j])) j--;
      out.push(raw[j]);
      anchor = raw[j];
      i = j + 1;
    }
    return out;
  }
}
