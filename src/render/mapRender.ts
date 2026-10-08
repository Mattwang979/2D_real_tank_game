// Map rendering: ground chunks (cached canvases), building roofs, trees, walls, decals.

import type { V2 } from '../core/math';
import { Rng } from '../core/rng';
import type { Berm, Building, GameMap, Theme, Tree, Wall } from '../game/map';
import { makeCanvas } from './tankRender';

type Ctx = CanvasRenderingContext2D;

export const CHUNK = 64;

const THEME: Record<Theme, { base: string; grain: [number, number, number]; grainA: number; track: string; trackA: number; scorch: string }> = {
  grass: { base: '#4c5a37', grain: [30, 40, 20], grainA: 0.22, track: '#2a2f1c', trackA: 0.2, scorch: '#1c1a12' },
  desert: { base: '#b19c74', grain: [90, 75, 50], grainA: 0.2, track: '#6e5c3e', trackA: 0.26, scorch: '#3a3022' },
  city: { base: '#56534d', grain: [30, 30, 30], grainA: 0.22, track: '#1e1e1e', trackA: 0.13, scorch: '#151412' },
};

export interface Decal {
  kind: 'track' | 'scorch' | 'crater' | 'fallen';
  x: number;
  y: number;
  ang: number;
  w: number;
  h: number;
  seed?: number;
  /** alpha multiplier */
  a?: number;
}

interface ChunkRec {
  canvas: HTMLCanvasElement;
  used: number;
}

function shadowPoly(poly: V2[], sx: number, sy: number): V2[] {
  // convex hull of poly ∪ shifted poly
  const pts = [...poly, ...poly.map((p) => ({ x: p.x + sx, y: p.y + sy }))];
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cr = (o: V2, a: V2, b: V2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: V2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: V2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function pathPoly(ctx: Ctx, pts: V2[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (amt >= 0) {
    r += (255 - r) * amt;
    g += (255 - g) * amt;
    b += (255 - b) * amt;
  } else {
    r *= 1 + amt;
    g *= 1 + amt;
    b *= 1 + amt;
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export class MapRenderer {
  map: GameMap;
  scale: number;
  chunks = new Map<string, ChunkRec>();
  maxChunks: number;
  decals: Decal[] = [];
  frame = 0;
  private grain: HTMLCanvasElement;
  private bSprites = new Map<number, { c: HTMLCanvasElement; w: number; h: number }>();
  private treeSprites = new Map<string, HTMLCanvasElement>();
  private pad = 2;

  constructor(map: GameMap, scale: number, maxChunks = 36) {
    this.map = map;
    this.scale = scale;
    this.maxChunks = maxChunks;
    this.grain = this.makeGrain();
  }

  private makeGrain(): HTMLCanvasElement {
    const t = THEME[this.map.theme];
    const c = makeCanvas(128, 128);
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(128, 128);
    const rng = new Rng(77);
    for (let i = 0; i < 128 * 128; i++) {
      const v = rng.next();
      img.data[i * 4] = v > 0.5 ? 255 : t.grain[0];
      img.data[i * 4 + 1] = v > 0.5 ? 250 : t.grain[1];
      img.data[i * 4 + 2] = v > 0.5 ? 230 : t.grain[2];
      img.data[i * 4 + 3] = Math.floor(Math.abs(v - 0.5) * 2 * 255 * t.grainA * (rng.next() > 0.4 ? 1 : 0.3));
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // ------------------------------------------------------------------ chunks
  private key(cx: number, cy: number) {
    return `${cx},${cy}`;
  }

  getChunk(cx: number, cy: number): HTMLCanvasElement {
    const k = this.key(cx, cy);
    let rec = this.chunks.get(k);
    if (!rec) {
      rec = { canvas: this.renderChunk(cx, cy), used: this.frame };
      this.chunks.set(k, rec);
      this.evict();
    }
    rec.used = this.frame;
    return rec.canvas;
  }

  private evict() {
    if (this.chunks.size <= this.maxChunks) return;
    const arr = [...this.chunks.entries()].sort((a, b) => a[1].used - b[1].used);
    while (this.chunks.size > this.maxChunks) {
      const e = arr.shift();
      if (!e) break;
      this.chunks.delete(e[0]);
    }
  }

  private renderChunk(cx: number, cy: number): HTMLCanvasElement {
    const s = this.scale;
    const pad = this.pad;
    const size = CHUNK * s + pad * 2;
    const c = makeCanvas(size, size);
    const ctx = c.getContext('2d')!;
    const x0 = cx * CHUNK - pad / s;
    const y0 = cy * CHUNK - pad / s;
    const wx0 = cx * CHUNK - 2;
    const wy0 = cy * CHUNK - 2;
    const wx1 = (cx + 1) * CHUNK + 2;
    const wy1 = (cy + 1) * CHUNK + 2;
    const m = this.map;
    const th = THEME[m.theme];

    ctx.fillStyle = th.base;
    ctx.fillRect(0, 0, size, size);
    ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);

    // patches
    for (const p of m.patches) {
      if (p.x + p.r < wx0 || p.x - p.r > wx1 || p.y + p.r < wy0 || p.y - p.r > wy1) continue;
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      g.addColorStop(0, p.color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = g;
      ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    }
    ctx.globalAlpha = 1;
    this.groundDetail(ctx, cx, cy);

    // fields
    for (const f of m.fields) {
      pathPoly(ctx, f.poly);
      ctx.fillStyle = f.color;
      ctx.globalAlpha = 0.75;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.save();
      pathPoly(ctx, f.poly);
      ctx.clip();
      ctx.strokeStyle = f.row;
      ctx.lineWidth = 0.35;
      const cxp = f.poly.reduce((a, p) => a + p.x, 0) / 4;
      const cyp = f.poly.reduce((a, p) => a + p.y, 0) / 4;
      ctx.translate(cxp, cyp);
      ctx.rotate(f.ang);
      ctx.beginPath();
      for (let k = -80; k < 80; k += 1.4) {
        ctx.moveTo(-80, k);
        ctx.lineTo(80, k);
      }
      ctx.stroke();
      ctx.restore();
      pathPoly(ctx, f.poly);
      ctx.strokeStyle = 'rgba(30,34,18,0.25)';
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    // roads
    for (const r of m.roads) this.drawRoad(ctx, r.pts, r.w, r.kind, 'base');
    for (const r of m.roads) this.drawRoad(ctx, r.pts, r.w, r.kind, 'top');

    // decor (ground level)
    for (const d of m.decor) {
      if (d.x + 6 < wx0 || d.x - 6 > wx1 || d.y + 6 < wy0 || d.y - 6 > wy1) continue;
      this.drawDecor(ctx, d.kind, d.x, d.y, d.r, d.ang, d.seed);
    }

    // decals stamped so far
    for (const d of this.decals) {
      if (d.x < wx0 - 4 || d.x > wx1 + 4 || d.y < wy0 - 4 || d.y > wy1 + 4) continue;
      this.drawDecal(ctx, d);
    }

    // earthworks
    for (const bm of m.berms) {
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const p of bm.pts) {
        bx0 = Math.min(bx0, p.x);
        by0 = Math.min(by0, p.y);
        bx1 = Math.max(bx1, p.x);
        by1 = Math.max(by1, p.y);
      }
      const pad = bm.w + 4;
      if (bx1 + pad < wx0 || bx0 - pad > wx1 || by1 + pad < wy0 || by0 - pad > wy1) continue;
      this.drawBerm(ctx, bm);
    }

    // building shadows
    const sh = m.shadow;
    ctx.fillStyle = 'rgba(8,8,6,0.42)';
    for (const b of m.buildings) {
      const hgt = b.roof === 'ruin' ? b.height * 0.25 : b.height;
      const reach = Math.max(b.w, b.h) + hgt;
      if (b.cx + reach < wx0 || b.cx - reach > wx1 || b.cy + reach < wy0 || b.cy - reach > wy1) continue;
      pathPoly(ctx, shadowPoly(b.poly, sh.x * hgt, sh.y * hgt));
      ctx.fill();
    }
    // rocks
    for (const r of m.rocks) {
      if (r.x + 8 < wx0 || r.x - 8 > wx1 || r.y + 8 < wy0 || r.y - 8 > wy1) continue;
      ctx.fillStyle = 'rgba(8,8,6,0.35)';
      pathPoly(ctx, shadowPoly(r.poly, sh.x * r.r * 0.9, sh.y * r.r * 0.9));
      ctx.fill();
      pathPoly(ctx, r.poly);
      const g = ctx.createLinearGradient(r.x + r.r, r.y - r.r, r.x - r.r, r.y + r.r);
      g.addColorStop(0, shade(r.color, 0.25));
      g.addColorStop(1, shade(r.color, -0.3));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,18,14,0.6)';
      ctx.lineWidth = 0.12;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,240,0.15)';
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(r.x - r.r * 0.3, r.y - r.r * 0.2);
      ctx.lineTo(r.x + r.r * 0.35, r.y - r.r * 0.45);
      ctx.stroke();
    }

    // grain overlay (pixel space)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    const pat = ctx.createPattern(this.grain, 'repeat')!;
    const ox = ((x0 * s) % 128 + 128) % 128;
    const oy = ((y0 * s) % 128 + 128) % 128;
    ctx.translate(-ox, -oy);
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, size + 128, size + 128);
    ctx.restore();
    return c;
  }

  /** Raised earth bank: cast shadow, dug-out apron, body, sunlit flank, tufts / stones on the crest. */
  private drawBerm(ctx: Ctx, bm: Berm) {
    const th = this.map.theme;
    const [body, lit, dark] = th === 'desert' ? ['#a68f64', '#cdb98f', '#7a6644'] : th === 'city' ? ['#66625a', '#88837a', '#3e3c37'] : ['#5f5b39', '#808051', '#3b3925'];
    const sh = this.map.shadow;
    const pts = bm.pts;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    };
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // scraped / excavated floor inside revetments and craters
    if (bm.kind !== 'ridge') {
      path();
      ctx.closePath();
      ctx.fillStyle = dark;
      ctx.globalAlpha = 0.3;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // apron of loose earth
    path();
    ctx.strokeStyle = dark;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = bm.w + 2.4;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // cast shadow
    ctx.save();
    ctx.translate(sh.x * 0.9, sh.y * 0.9);
    path();
    ctx.strokeStyle = 'rgba(12,12,6,0.36)';
    ctx.lineWidth = bm.w + 0.4;
    ctx.stroke();
    ctx.restore();
    // body
    path();
    ctx.strokeStyle = body;
    ctx.lineWidth = bm.w;
    ctx.stroke();
    // sunlit flank
    ctx.save();
    ctx.translate(-sh.x * 0.32, -sh.y * 0.32);
    path();
    ctx.strokeStyle = lit;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = bm.w * 0.45;
    ctx.stroke();
    ctx.restore();
    // crest
    path();
    ctx.strokeStyle = 'rgba(255,255,230,0.14)';
    ctx.lineWidth = 0.16;
    ctx.stroke();
    // tufts and stones
    const rng = new Rng(bm.id * 7919);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      for (let d = 0; d < L; d += 0.9) {
        const k = d / L;
        const off = rng.range(-bm.w * 0.4, bm.w * 0.4);
        const nx = -(b.y - a.y) / L;
        const ny = (b.x - a.x) / L;
        const x = a.x + (b.x - a.x) * k + nx * off;
        const y = a.y + (b.y - a.y) * k + ny * off;
        ctx.fillStyle = rng.chance(0.5) ? 'rgba(20,24,10,0.22)' : th === 'grass' ? 'rgba(110,130,70,0.3)' : 'rgba(230,215,180,0.2)';
        ctx.beginPath();
        ctx.arc(x, y, rng.range(0.12, 0.38), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Small-scale texture: grass clumps, tufts, sand ripples, pebbles, concrete slabs. */
  private groundDetail(ctx: Ctx, cx: number, cy: number) {
    const rng = new Rng(((cx * 73856093) ^ (cy * 19349663) ^ this.map.seed) >>> 0);
    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const theme = this.map.theme;
    if (theme === 'grass') {
      for (let i = 0; i < 140; i++) {
        const x = x0 + rng.next() * CHUNK;
        const y = y0 + rng.next() * CHUNK;
        const r = rng.range(0.6, 3.2);
        ctx.fillStyle = rng.chance(0.55) ? `rgba(28,38,18,${rng.range(0.08, 0.2)})` : `rgba(120,135,80,${rng.range(0.05, 0.12)})`;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * rng.range(0.6, 1), rng.range(0, 3), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(30,42,20,0.35)';
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      for (let i = 0; i < 260; i++) {
        const x = x0 + rng.next() * CHUNK;
        const y = y0 + rng.next() * CHUNK;
        const a = -1.2 + rng.range(-0.5, 0.5);
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * 0.5, y + Math.sin(a) * 0.5);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(150,165,100,0.22)';
      ctx.beginPath();
      for (let i = 0; i < 140; i++) {
        const x = x0 + rng.next() * CHUNK;
        const y = y0 + rng.next() * CHUNK;
        ctx.moveTo(x, y);
        ctx.lineTo(x + 0.25, y - 0.45);
      }
      ctx.stroke();
    } else if (theme === 'desert') {
      ctx.lineWidth = 0.18;
      for (let i = 0; i < 28; i++) {
        const x = x0 + rng.next() * CHUNK;
        const y = y0 + rng.next() * CHUNK;
        const L = rng.range(4, 12);
        ctx.strokeStyle = rng.chance(0.5) ? 'rgba(230,214,176,0.22)' : 'rgba(120,98,66,0.18)';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + L / 2, y - rng.range(-1.5, 1.5), x + L, y + rng.range(-0.8, 0.8));
        ctx.stroke();
      }
      for (let i = 0; i < 90; i++) {
        const x = x0 + rng.next() * CHUNK;
        const y = y0 + rng.next() * CHUNK;
        const r = rng.range(0.6, 2.6);
        ctx.fillStyle = rng.chance(0.5) ? `rgba(130,108,72,${rng.range(0.06, 0.16)})` : `rgba(225,210,170,${rng.range(0.05, 0.12)})`;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.7, rng.range(0, 3), 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 0; i < 70; i++) {
        ctx.fillStyle = rng.chance(0.5) ? 'rgba(90,76,56,0.55)' : 'rgba(160,145,115,0.6)';
        ctx.beginPath();
        ctx.arc(x0 + rng.next() * CHUNK, y0 + rng.next() * CHUNK, rng.range(0.08, 0.22), 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.strokeStyle = 'rgba(20,20,20,0.12)';
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      for (let k = 0; k <= CHUNK; k += 4) {
        ctx.moveTo(x0 + k, y0);
        ctx.lineTo(x0 + k, y0 + CHUNK);
        ctx.moveTo(x0, y0 + k);
        ctx.lineTo(x0 + CHUNK, y0 + k);
      }
      ctx.stroke();
      for (let i = 0; i < 70; i++) {
        const x = x0 + rng.next() * CHUNK;
        const y = y0 + rng.next() * CHUNK;
        const r = rng.range(0.5, 2.5);
        ctx.fillStyle = rng.chance(0.6) ? `rgba(20,20,18,${rng.range(0.06, 0.16)})` : `rgba(140,135,125,${rng.range(0.05, 0.1)})`;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.7, rng.range(0, 3), 0, Math.PI * 2);
        ctx.fill();
      }
      // weeds in cracks
      ctx.fillStyle = 'rgba(70,82,48,0.35)';
      for (let i = 0; i < 25; i++) {
        ctx.beginPath();
        ctx.arc(x0 + rng.next() * CHUNK, y0 + rng.next() * CHUNK, rng.range(0.15, 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawRoad(ctx: Ctx, pts: V2[], w: number, kind: 'dirt' | 'asphalt' | 'sand', pass: 'base' | 'top') {
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (kind === 'asphalt') {
      if (pass === 'base') {
        path();
        ctx.strokeStyle = '#6f6c65';
        ctx.lineWidth = w + 6;
        ctx.stroke();
        path();
        ctx.strokeStyle = '#8a867c';
        ctx.lineWidth = w + 1.2;
        ctx.stroke();
      } else {
        path();
        ctx.strokeStyle = '#3c3d3d';
        ctx.lineWidth = w;
        ctx.stroke();
        ctx.setLineDash([3, 4]);
        path();
        ctx.strokeStyle = 'rgba(190,185,160,0.45)';
        ctx.lineWidth = 0.25;
        ctx.stroke();
        ctx.setLineDash([]);
        // cracks / patches
        const rng = new Rng(Math.floor(pts[0].x * 13 + pts[0].y * 7));
        for (let i = 0; i < 30; i++) {
          const k = rng.int(0, pts.length - 2);
          const t = rng.next();
          const x = pts[k].x + (pts[k + 1].x - pts[k].x) * t + rng.range(-w / 2.5, w / 2.5);
          const y = pts[k].y + (pts[k + 1].y - pts[k].y) * t + rng.range(-w / 2.5, w / 2.5);
          ctx.fillStyle = rng.chance(0.5) ? 'rgba(20,20,20,0.18)' : 'rgba(120,118,110,0.12)';
          ctx.fillRect(x, y, rng.range(1, 4), rng.range(0.6, 2.5));
        }
      }
      return;
    }
    const col = kind === 'dirt' ? '#7a6d4c' : '#9f8961';
    if (pass === 'base') {
      path();
      ctx.strokeStyle = kind === 'dirt' ? 'rgba(110,98,66,0.45)' : 'rgba(150,130,96,0.4)';
      ctx.lineWidth = w + 3;
      ctx.stroke();
    } else {
      path();
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.stroke();
      // ruts
      for (const off of [-0.24, 0.24]) {
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const a = pts[Math.max(0, i - 1)];
          const b = pts[Math.min(pts.length - 1, i + 1)];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const l = Math.hypot(dx, dy) || 1;
          const x = pts[i].x - (dy / l) * w * off;
          const y = pts[i].y + (dx / l) * w * off;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = kind === 'dirt' ? 'rgba(60,50,32,0.35)' : 'rgba(110,90,60,0.32)';
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }
    }
  }

  private drawDecor(ctx: Ctx, kind: string, x: number, y: number, r: number, ang: number, seed: number) {
    const rng = new Rng(seed || 1);
    switch (kind) {
      case 'crater': {
        const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 1.4);
        g.addColorStop(0, 'rgba(30,26,18,0.55)');
        g.addColorStop(0.6, 'rgba(50,42,28,0.35)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r * 1.5, y - r * 1.5, r * 3, r * 3);
        ctx.strokeStyle = 'rgba(160,140,110,0.18)';
        ctx.lineWidth = r * 0.18;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'puddle':
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        ctx.fillStyle = 'rgba(40,52,52,0.55)';
        ctx.beginPath();
        ctx.ellipse(0, 0, r, r * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(160,180,170,0.2)';
        ctx.lineWidth = 0.15;
        ctx.stroke();
        ctx.restore();
        break;
      case 'manhole':
        ctx.fillStyle = 'rgba(30,30,30,0.6)';
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'rubble':
        for (let i = 0; i < 14; i++) {
          ctx.fillStyle = rng.pick(['#6d6860', '#5a564f', '#7c766b', '#4a4640']);
          const a = rng.range(0, Math.PI * 2);
          const d = rng.range(0, r);
          ctx.save();
          ctx.translate(x + Math.cos(a) * d, y + Math.sin(a) * d);
          ctx.rotate(rng.range(0, 3));
          ctx.fillRect(-0.35, -0.25, rng.range(0.4, 1.1), rng.range(0.3, 0.8));
          ctx.restore();
        }
        break;
      case 'crate':
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(-r + -0.3, -r + 0.35, r * 2, r * 2);
        ctx.fillStyle = '#7a6440';
        ctx.fillRect(-r, -r, r * 2, r * 2);
        ctx.strokeStyle = '#4a3a22';
        ctx.lineWidth = 0.08;
        ctx.strokeRect(-r, -r, r * 2, r * 2);
        ctx.beginPath();
        ctx.moveTo(-r, -r);
        ctx.lineTo(r, r);
        ctx.stroke();
        ctx.restore();
        break;
      case 'barrel':
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.arc(x - 0.25, y + 0.3, 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = rng.pick(['#5c5a3a', '#6a3c2c', '#45503a']);
        ctx.beginPath();
        ctx.arc(x, y, 0.42, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 0.06;
        ctx.stroke();
        break;
      case 'car': {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ang);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(-2.1 - 0.4, -0.9 + 0.5, 4.2, 1.8);
        const col = rng.pick(['#3d3a33', '#4a3c30', '#2f3a3a', '#5a4a32', '#3b2f2a']);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.roundRect(-2.1, -0.9, 4.2, 1.8, 0.5);
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(-0.9, -0.75, 1.9, 1.5);
        ctx.fillStyle = shade(col.length === 7 ? col : '#3d3a33', 0.12);
        ctx.fillRect(-0.6, -0.65, 1.2, 1.3);
        ctx.strokeStyle = 'rgba(10,10,10,0.6)';
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        ctx.roundRect(-2.1, -0.9, 4.2, 1.8, 0.5);
        ctx.stroke();
        ctx.restore();
        break;
      }
    }
  }

  private drawDecal(ctx: Ctx, d: Decal) {
    const th = THEME[this.map.theme];
    switch (d.kind) {
      case 'track':
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.rotate(d.ang);
        ctx.globalAlpha = Math.min(0.9, th.trackA * (d.a ?? 1));
        ctx.fillStyle = th.track;
        ctx.fillRect(-d.w / 2, -d.h / 2, d.w, d.h);
        ctx.restore();
        ctx.globalAlpha = 1;
        break;
      case 'scorch': {
        const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.w);
        g.addColorStop(0, 'rgba(20,16,10,0.6)');
        g.addColorStop(0.7, 'rgba(20,16,10,0.25)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(d.x - d.w, d.y - d.w, d.w * 2, d.w * 2);
        break;
      }
      case 'crater':
        this.drawDecor(ctx, 'crater', d.x, d.y, d.w, 0, d.seed ?? 1);
        break;
      case 'fallen': {
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.rotate(d.ang);
        ctx.fillStyle = '#4a3a26';
        ctx.fillRect(0, -0.28, d.w * 1.6, 0.56);
        const rng = new Rng(d.seed ?? 3);
        const leaf = this.map.theme === 'desert' ? '#5c5a36' : '#34472a';
        for (let i = 0; i < 9; i++) {
          ctx.fillStyle = leaf;
          ctx.globalAlpha = 0.85;
          ctx.beginPath();
          ctx.ellipse(d.w * rng.range(0.9, 2.1), rng.range(-d.w * 0.5, d.w * 0.5), d.w * rng.range(0.25, 0.45), d.w * rng.range(0.2, 0.35), 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.restore();
        break;
      }
    }
  }

  /** Add a decal and paint it onto any cached chunk it overlaps. */
  stamp(d: Decal) {
    this.decals.push(d);
    if (this.decals.length > 9000) this.decals.splice(0, 1500);
    const r = Math.max(d.w, d.h) * 2 + 1;
    const cx0 = Math.floor((d.x - r) / CHUNK);
    const cx1 = Math.floor((d.x + r) / CHUNK);
    const cy0 = Math.floor((d.y - r) / CHUNK);
    const cy1 = Math.floor((d.y + r) / CHUNK);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const rec = this.chunks.get(this.key(cx, cy));
        if (!rec) continue;
        const ctx = rec.canvas.getContext('2d')!;
        const s = this.scale;
        const x0 = cx * CHUNK - this.pad / s;
        const y0 = cy * CHUNK - this.pad / s;
        ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
        this.drawDecal(ctx, d);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
  }

  /** Draw ground chunks covering the world rect. ctx is in world (meter) transform. */
  drawGround(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, budget = { n: 3 }) {
    this.frame++;
    const s = this.scale;
    const pad = this.pad / s;
    const cx0 = Math.max(0, Math.floor(x0 / CHUNK));
    const cy0 = Math.max(0, Math.floor(y0 / CHUNK));
    const maxC = Math.ceil(this.map.size / CHUNK) - 1;
    const cx1 = Math.min(maxC, Math.floor(x1 / CHUNK));
    const cy1 = Math.min(maxC, Math.floor(y1 / CHUNK));
    // outside-map backdrop
    ctx.fillStyle = shade(THEME[this.map.theme].base, -0.35);
    ctx.fillRect(x0 - 5, y0 - 5, x1 - x0 + 10, y1 - y0 + 10);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = this.key(cx, cy);
        if (!this.chunks.has(k) && budget.n <= 0) {
          ctx.fillStyle = THEME[this.map.theme].base;
          ctx.fillRect(cx * CHUNK, cy * CHUNK, CHUNK, CHUNK);
          continue;
        }
        if (!this.chunks.has(k)) budget.n--;
        const c = this.getChunk(cx, cy);
        ctx.drawImage(c, cx * CHUNK - pad, cy * CHUNK - pad, CHUNK + pad * 2, CHUNK + pad * 2);
      }
    }
  }

  /** Pre-render chunks around a point (call during loading). */
  warm(x: number, y: number, r: number) {
    const cx0 = Math.max(0, Math.floor((x - r) / CHUNK));
    const cy0 = Math.max(0, Math.floor((y - r) / CHUNK));
    const maxC = Math.ceil(this.map.size / CHUNK) - 1;
    for (let cy = cy0; cy <= Math.min(maxC, Math.floor((y + r) / CHUNK)); cy++) for (let cx = cx0; cx <= Math.min(maxC, Math.floor((x + r) / CHUNK)); cx++) this.getChunk(cx, cy);
  }

  // ------------------------------------------------------------------ buildings
  private buildingSprite(b: Building) {
    let sp = this.bSprites.get(b.id);
    if (sp) return sp;
    const s = this.scale;
    const pad = 0.6;
    const w = b.w + pad * 2;
    const h = b.h + pad * 2;
    const c = makeCanvas(w * s, h * s);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(s, 0, 0, s, (w / 2) * s, (h / 2) * s);
    drawRoof(ctx, b);
    sp = { c, w, h };
    this.bSprites.set(b.id, sp);
    return sp;
  }

  drawBuildings(ctx: Ctx, x0: number, y0: number, x1: number, y1: number) {
    for (const b of this.map.buildings) {
      const r = Math.max(b.w, b.h);
      if (b.cx + r < x0 || b.cx - r > x1 || b.cy + r < y0 || b.cy - r > y1) continue;
      const sp = this.buildingSprite(b);
      ctx.save();
      ctx.translate(b.cx, b.cy);
      ctx.rotate(b.ang);
      ctx.drawImage(sp.c, -sp.w / 2, -sp.h / 2, sp.w, sp.h);
      ctx.restore();
    }
  }

  drawWalls(ctx: Ctx, x0: number, y0: number, x1: number, y1: number) {
    const sh = this.map.shadow;
    for (const w of this.map.walls) {
      if (!w.alive) continue;
      const cx = (w.a.x + w.b.x) / 2;
      const cy = (w.a.y + w.b.y) / 2;
      if (cx < x0 - 20 || cx > x1 + 20 || cy < y0 - 20 || cy > y1 + 20) continue;
      drawWall(ctx, w, sh);
    }
  }

  // ------------------------------------------------------------------ trees
  private treeSprite(t: Tree): HTMLCanvasElement {
    const rb = Math.round(t.r * 2) / 2;
    const key = `${t.variant}:${rb}:${t.shrub ? 1 : 0}`;
    let c = this.treeSprites.get(key);
    if (c) return c;
    const s = this.scale;
    const size = (rb * 2 + 1) * s;
    c = makeCanvas(size, size);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(s, 0, 0, s, size / 2, size / 2);
    drawCanopy(ctx, rb, t.variant, t.shrub, this.map.theme);
    this.treeSprites.set(key, c);
    return c;
  }

  drawTreeShadows(ctx: Ctx, x0: number, y0: number, x1: number, y1: number) {
    const sh = this.map.shadow;
    ctx.fillStyle = 'rgba(6,8,4,0.32)';
    ctx.beginPath();
    for (const t of this.map.trees) {
      if (!t.alive) continue;
      if (t.x + t.r + 6 < x0 || t.x - t.r - 6 > x1 || t.y + t.r + 6 < y0 || t.y - t.r - 6 > y1) continue;
      const h = t.shrub ? 1.2 : 4.5;
      ctx.moveTo(t.x + sh.x * h + t.r * 0.9, t.y + sh.y * h);
      ctx.arc(t.x + sh.x * h, t.y + sh.y * h, t.r * 0.9, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  drawTrees(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, fadeAt: V2 | null) {
    for (const t of this.map.trees) {
      if (!t.alive) continue;
      if (t.x + t.r < x0 || t.x - t.r > x1 || t.y + t.r < y0 || t.y - t.r > y1) continue;
      const c = this.treeSprite(t);
      const size = c.width / this.scale;
      let a = 1;
      if (fadeAt) {
        const d = Math.hypot(fadeAt.x - t.x, fadeAt.y - t.y);
        if (d < t.r + 3) a = 0.45 + 0.55 * Math.min(1, Math.max(0, (d - t.r * 0.5) / (t.r * 0.5 + 3)));
      }
      ctx.globalAlpha = a;
      ctx.drawImage(c, t.x - size / 2, t.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  /** Knock a tree over, leaving a fallen-tree decal. */
  fellTree(t: Tree, dir: number) {
    if (!t.alive) return;
    t.alive = false;
    t.fall = dir;
    this.stamp({ kind: 'fallen', x: t.x, y: t.y, ang: dir, w: t.r, h: t.r, seed: t.id });
  }

  invalidateAll() {
    this.chunks.clear();
  }
}

// ---------------------------------------------------------------------------

export function drawRoof(ctx: Ctx, b: Building) {
  const rng = new Rng(b.seed);
  const w = b.w;
  const h = b.h;
  const x = -w / 2;
  const y = -h / 2;
  if (b.roof === 'ruin') {
    ctx.fillStyle = 'rgba(70,64,56,0.9)';
    ctx.fillRect(x, y, w, h);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = rng.pick(['#7a7369', '#5f5a52', '#8a8275', '#4c4842', shade(b.color, -0.1)]);
      ctx.save();
      ctx.translate(x + rng.next() * w, y + rng.next() * h);
      ctx.rotate(rng.range(0, 3));
      ctx.fillRect(-0.4, -0.3, rng.range(0.5, 1.6), rng.range(0.4, 1.1));
      ctx.restore();
    }
    // broken walls
    ctx.strokeStyle = shade(b.color, 0.1);
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y + h * rng.range(0.3, 0.7));
    ctx.lineTo(x, y);
    ctx.lineTo(x + w * rng.range(0.4, 0.8), y);
    ctx.moveTo(x + w, y + h * rng.range(0.2, 0.5));
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w * rng.range(0.3, 0.6), y + h);
    ctx.stroke();
    return;
  }
  if (b.roof === 'gable') {
    const alongX = w >= h;
    // two roof halves
    ctx.fillStyle = shade(b.color, 0.1);
    if (alongX) ctx.fillRect(x, y, w, h / 2);
    else ctx.fillRect(x + w / 2, y, w / 2, h);
    ctx.fillStyle = shade(b.color, -0.18);
    if (alongX) ctx.fillRect(x, y + h / 2, w, h / 2);
    else ctx.fillRect(x, y, w / 2, h);
    // tiles
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    if (alongX) {
      for (let k = y + 0.35; k < y + h; k += 0.42) {
        ctx.moveTo(x, k);
        ctx.lineTo(x + w, k);
      }
    } else {
      for (let k = x + 0.35; k < x + w; k += 0.42) {
        ctx.moveTo(k, y);
        ctx.lineTo(k, y + h);
      }
    }
    ctx.stroke();
    // ridge
    ctx.strokeStyle = shade(b.color, -0.35);
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    if (alongX) {
      ctx.moveTo(x + 0.2, 0);
      ctx.lineTo(x + w - 0.2, 0);
    } else {
      ctx.moveTo(0, y + 0.2);
      ctx.lineTo(0, y + h - 0.2);
    }
    ctx.stroke();
    // chimney
    const cx = x + w * rng.range(0.2, 0.8);
    const cy = y + h * rng.range(0.2, 0.8);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(cx - 0.9, cy + 0.2, 1.1, 1.1);
    ctx.fillStyle = '#6a5a4c';
    ctx.fillRect(cx - 0.55, cy - 0.55, 1.1, 1.1);
    ctx.fillStyle = '#1e1a16';
    ctx.fillRect(cx - 0.3, cy - 0.3, 0.6, 0.6);
    ctx.strokeStyle = 'rgba(20,14,10,0.7)';
    ctx.lineWidth = 0.15;
    ctx.strokeRect(x, y, w, h);
    return;
  }
  // flat roof with parapet
  ctx.fillStyle = b.color;
  ctx.fillRect(x, y, w, h);
  // roof texture
  for (let i = 0; i < 20; i++) {
    ctx.fillStyle = rng.chance(0.5) ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,240,0.05)';
    ctx.fillRect(x + rng.next() * w, y + rng.next() * h, rng.range(1, 4), rng.range(1, 4));
  }
  // inner shadow under parapet
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
  // parapet with alternating segments (crenellated look)
  const pw = 0.5;
  const light = shade(b.color, 0.32);
  const dark = shade(b.color, -0.1);
  const seg = 0.9;
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const L = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(2, Math.round(L / seg));
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const t1 = (i + 1) / n;
      ctx.strokeStyle = i % 2 === 0 ? light : dark;
      ctx.lineWidth = pw;
      ctx.beginPath();
      ctx.moveTo(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0);
      ctx.lineTo(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
      ctx.stroke();
    }
  };
  ctx.lineCap = 'butt';
  edge(x + pw / 2, y + pw / 2, x + w - pw / 2, y + pw / 2);
  edge(x + w - pw / 2, y + pw / 2, x + w - pw / 2, y + h - pw / 2);
  edge(x + w - pw / 2, y + h - pw / 2, x + pw / 2, y + h - pw / 2);
  edge(x + pw / 2, y + h - pw / 2, x + pw / 2, y + pw / 2);
  // roof details
  const nd = rng.int(1, 4);
  for (let i = 0; i < nd; i++) {
    const dw = rng.range(1.2, Math.min(3.5, w * 0.3));
    const dh = rng.range(1.2, Math.min(3, h * 0.3));
    const dx = x + 1.2 + rng.next() * (w - 2.4 - dw);
    const dy = y + 1.2 + rng.next() * (h - 2.4 - dh);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(dx - 0.35, dy + 0.4, dw, dh);
    const kind = rng.int(0, 3);
    ctx.fillStyle = kind === 0 ? shade(b.color, 0.18) : kind === 1 ? '#4c4a46' : shade(b.color, -0.15);
    ctx.fillRect(dx, dy, dw, dh);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 0.1;
    ctx.strokeRect(dx, dy, dw, dh);
    if (kind === 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      for (let k = dx + 0.25; k < dx + dw; k += 0.3) {
        ctx.moveTo(k, dy + 0.1);
        ctx.lineTo(k, dy + dh - 0.1);
      }
      ctx.stroke();
    }
  }
  if (rng.chance(0.4)) {
    const r = rng.range(0.8, 1.4);
    const cx = x + 1.5 + r + rng.next() * (w - 3 - 2 * r);
    const cy = y + 1.5 + r + rng.next() * (h - 3 - 2 * r);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.arc(cx - 0.3, cy + 0.35, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5a5650';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 0.1;
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(15,12,10,0.75)';
  ctx.lineWidth = 0.14;
  ctx.strokeRect(x, y, w, h);
}

function drawCanopy(ctx: Ctx, r: number, variant: number, shrub: boolean, theme: Theme) {
  const rng = new Rng(variant * 977 + Math.round(r * 10));
  const pal =
    theme === 'desert'
      ? shrub
        ? ['#4f5232', '#5f6238', '#737547', '#3b3e24']
        : ['#3c4a2a', '#4a5a32', '#61733f', '#2c361f']
      : shrub
        ? ['#34452a', '#405533', '#557043', '#26331d']
        : ['#2b3f26', '#36502e', '#4f6c3e', '#1e2c1a'];
  const n = shrub ? 5 : 8;
  // outline / dark base
  ctx.fillStyle = pal[3];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const d = r * rng.range(0.35, 0.55);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r * rng.range(0.42, 0.55), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
  ctx.fill();
  // mid tones
  ctx.fillStyle = pal[0];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const d = r * rng.range(0.3, 0.48);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r * rng.range(0.34, 0.46), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = pal[1];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const d = r * rng.range(0.15, 0.4);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d + r * 0.08, Math.sin(a) * d - r * 0.08, r * rng.range(0.22, 0.32), 0, Math.PI * 2);
    ctx.fill();
  }
  // highlights (light from upper right)
  ctx.fillStyle = pal[2];
  for (let i = 0; i < (shrub ? 3 : 6); i++) {
    const a = -Math.PI / 4 + rng.range(-1, 1);
    const d = r * rng.range(0.15, 0.45);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d + r * 0.1, Math.sin(a) * d - r * 0.1, r * rng.range(0.1, 0.2), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // inner ring detail (concentric leaves look)
  ctx.strokeStyle = 'rgba(10,20,8,0.35)';
  ctx.lineWidth = r * 0.04;
  ctx.beginPath();
  ctx.arc(r * 0.05, -r * 0.05, r * 0.3, 0, Math.PI * 2);
  ctx.stroke();
}

function drawWall(ctx: Ctx, w: Wall, sh: V2) {
  const dx = w.b.x - w.a.x;
  const dy = w.b.y - w.a.y;
  const L = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  ctx.save();
  ctx.translate(w.a.x, w.a.y);
  ctx.rotate(ang);
  const hgt = w.kind === 'fence' ? 1.2 : w.kind === 'sandbag' ? 0.9 : 1.6;
  // shadow (in local frame: rotate shadow vector)
  const c = Math.cos(-ang);
  const s = Math.sin(-ang);
  const sx = (sh.x * c - sh.y * s) * hgt;
  const sy = (sh.x * s + sh.y * c) * hgt;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.moveTo(0, -w.w / 2);
  ctx.lineTo(L, -w.w / 2);
  ctx.lineTo(L + sx, -w.w / 2 + sy);
  ctx.lineTo(L + sx, w.w / 2 + sy);
  ctx.lineTo(sx, w.w / 2 + sy);
  ctx.lineTo(0, w.w / 2);
  ctx.closePath();
  ctx.fill();
  if (w.kind === 'fence') {
    ctx.strokeStyle = '#6b5a40';
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.moveTo(0, -0.06);
    ctx.lineTo(L, -0.06);
    ctx.moveTo(0, 0.08);
    ctx.lineTo(L, 0.08);
    ctx.stroke();
    ctx.fillStyle = '#4e4030';
    for (let x = 0; x <= L; x += 2) ctx.fillRect(x - 0.12, -0.15, 0.24, 0.3);
  } else if (w.kind === 'sandbag') {
    for (let x = 0; x < L; x += 0.75) {
      for (const yy of [-0.25, 0.25]) {
        ctx.fillStyle = (Math.floor(x / 0.75) + (yy > 0 ? 1 : 0)) % 2 ? '#8c7b58' : '#7b6c4c';
        ctx.beginPath();
        ctx.roundRect(x + (yy > 0 ? 0.35 : 0), yy - 0.22, 0.72, 0.44, 0.18);
        ctx.fill();
        ctx.strokeStyle = 'rgba(40,30,15,0.5)';
        ctx.lineWidth = 0.05;
        ctx.stroke();
      }
    }
  } else {
    ctx.fillStyle = '#7a7266';
    ctx.fillRect(0, -w.w / 2, L, w.w);
    ctx.strokeStyle = 'rgba(30,26,20,0.5)';
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    for (let x = 0.6; x < L; x += 0.6) {
      ctx.moveTo(x, -w.w / 2);
      ctx.lineTo(x, w.w / 2);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,240,0.12)';
    ctx.fillRect(0, -w.w / 2, L, w.w * 0.3);
    ctx.strokeStyle = 'rgba(20,18,14,0.7)';
    ctx.lineWidth = 0.08;
    ctx.strokeRect(0, -w.w / 2, L, w.w);
  }
  ctx.restore();
}
