// Battle maps: deterministic procedural layouts for three themes, plus spatial queries.

import { type V2, pointInPoly, pointSegDist, segSeg, satMTV, circlePolyMTV, clamp } from '../core/math';
import { Rng } from '../core/rng';

export type Theme = 'grass' | 'desert' | 'city';

export interface Building {
  id: number;
  poly: V2[];
  cx: number;
  cy: number;
  w: number;
  h: number;
  ang: number;
  height: number;
  roof: 'flat' | 'gable' | 'ruin';
  color: string;
  seed: number;
}
export interface Tree {
  id: number;
  x: number;
  y: number;
  r: number;
  alive: boolean;
  fall: number; // fall angle once knocked over
  variant: number;
  shrub: boolean;
}
export interface Rock {
  id: number;
  poly: V2[];
  x: number;
  y: number;
  r: number;
  color: string;
}
export interface Wall {
  id: number;
  poly: V2[];
  kind: 'stone' | 'sandbag' | 'fence';
  alive: boolean;
  a: V2;
  b: V2;
  w: number;
}
export interface Road {
  pts: V2[];
  w: number;
  kind: 'dirt' | 'asphalt' | 'sand';
}
export interface Patch {
  x: number;
  y: number;
  r: number;
  color: string;
  alpha: number;
}
export interface Field {
  poly: V2[];
  ang: number;
  color: string;
  row: string;
}
export interface Decor {
  kind: 'crater' | 'rubble' | 'crate' | 'barrel' | 'car' | 'manhole' | 'puddle';
  x: number;
  y: number;
  r: number;
  ang: number;
  seed: number;
}

export interface MapDef {
  id: string;
  name: string;
  theme: Theme;
  size: number;
}

export interface GameMap {
  def: MapDef;
  size: number;
  theme: Theme;
  seed: number;
  roads: Road[];
  buildings: Building[];
  trees: Tree[];
  rocks: Rock[];
  walls: Wall[];
  patches: Patch[];
  fields: Field[];
  decor: Decor[];
  capture: { x: number; y: number; r: number };
  spawns: [Array<{ x: number; y: number; ang: number }>, Array<{ x: number; y: number; ang: number }>];
  shadow: V2; // shadow offset direction per meter of height
  grid: SpatialGrid;
  occluders: Array<{ a: V2; b: V2 }>; // vision blocking segments
}

export const MAPS: MapDef[] = [
  { id: 'valley', name: 'Green Valley', theme: 'grass', size: 440 },
  { id: 'outpost', name: 'Desert Outpost', theme: 'desert', size: 440 },
  { id: 'city', name: 'Old Town', theme: 'city', size: 440 },
];

// ---------------------------------------------------------------------------
// Spatial grid

type Obs = { type: 'b'; o: Building } | { type: 'r'; o: Rock } | { type: 'w'; o: Wall } | { type: 't'; o: Tree };

export class SpatialGrid {
  cell = 24;
  n: number;
  cells: Obs[][];
  constructor(size: number) {
    this.n = Math.ceil(size / this.cell) + 1;
    this.cells = Array.from({ length: this.n * this.n }, () => []);
  }
  private idx(cx: number, cy: number) {
    return clamp(cy, 0, this.n - 1) * this.n + clamp(cx, 0, this.n - 1);
  }
  insert(o: Obs, x0: number, y0: number, x1: number, y1: number) {
    const c = this.cell;
    for (let cy = Math.floor(y0 / c); cy <= Math.floor(y1 / c); cy++)
      for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++) this.cells[this.idx(cx, cy)].push(o);
  }
  query(x0: number, y0: number, x1: number, y1: number, out: Set<Obs> = new Set()): Set<Obs> {
    const c = this.cell;
    for (let cy = Math.floor(y0 / c); cy <= Math.floor(y1 / c); cy++)
      for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++) for (const o of this.cells[this.idx(cx, cy)]) out.add(o);
    return out;
  }
}

function aabb(poly: V2[]) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

export function rectPoly(cx: number, cy: number, w: number, h: number, ang: number): V2[] {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const hw = w / 2;
  const hh = h / 2;
  return [
    { x: cx + -hw * c - -hh * s, y: cy + -hw * s + -hh * c },
    { x: cx + hw * c - -hh * s, y: cy + hw * s + -hh * c },
    { x: cx + hw * c - hh * s, y: cy + hw * s + hh * c },
    { x: cx + -hw * c - hh * s, y: cy + -hw * s + hh * c },
  ];
}

// ---------------------------------------------------------------------------
// Builder helpers

class Builder {
  rng: Rng;
  m: GameMap;
  nextId = 1;
  constructor(def: MapDef, seed: number) {
    this.rng = new Rng(seed);
    const sz = def.size;
    this.m = {
      def,
      size: sz,
      theme: def.theme,
      seed,
      roads: [],
      buildings: [],
      trees: [],
      rocks: [],
      walls: [],
      patches: [],
      fields: [],
      decor: [],
      capture: { x: sz / 2, y: sz / 2, r: 18 },
      spawns: [[], []],
      shadow: { x: -0.5, y: 0.62 },
      grid: new SpatialGrid(sz),
      occluders: [],
    };
  }
  roadDist(x: number, y: number): number {
    let best = Infinity;
    for (const r of this.m.roads) {
      for (let i = 0; i < r.pts.length - 1; i++) {
        const d = pointSegDist({ x, y }, r.pts[i], r.pts[i + 1]) - r.w / 2;
        if (d < best) best = d;
      }
    }
    return best;
  }
  /** keep-out zones: spawns, capture point */
  reserved(x: number, y: number, pad: number): boolean {
    const m = this.m;
    if (Math.hypot(x - m.capture.x, y - m.capture.y) < m.capture.r + pad) return true;
    for (const team of m.spawns) for (const s of team) if (Math.hypot(x - s.x, y - s.y) < 14 + pad) return true;
    if (x < 6 || y < 6 || x > m.size - 6 || y > m.size - 6) return true;
    return false;
  }
  overlapsSolid(poly: V2[], pad: number): boolean {
    const bb = aabb(poly);
    const near = this.m.grid.query(bb.x0 - pad, bb.y0 - pad, bb.x1 + pad, bb.y1 + pad);
    const grown = grow(poly, pad);
    for (const o of near) {
      if (o.type === 'b' && satMTV(grown, o.o.poly)) return true;
      if (o.type === 'r' && satMTV(grown, o.o.poly)) return true;
      if (o.type === 'w' && satMTV(grown, o.o.poly)) return true;
    }
    return false;
  }
  addBuilding(cx: number, cy: number, w: number, h: number, ang: number, height: number, roof: Building['roof'], color: string, force = false): Building | null {
    const poly = rectPoly(cx, cy, w, h, ang);
    if (!force) {
      for (const p of [...poly, { x: cx, y: cy }]) if (this.reserved(p.x, p.y, 4)) return null;
      if (this.overlapsSolid(poly, 3)) return null;
      for (const p of [...poly, { x: cx, y: cy }]) if (this.roadDist(p.x, p.y) < 2.5) return null;
    }
    const b: Building = { id: this.nextId++, poly, cx, cy, w, h, ang, height, roof, color, seed: this.rng.int(0, 1e9) };
    this.m.buildings.push(b);
    const bb = aabb(poly);
    this.m.grid.insert({ type: 'b', o: b }, bb.x0, bb.y0, bb.x1, bb.y1);
    if (roof !== 'ruin') for (let i = 0; i < 4; i++) this.m.occluders.push({ a: poly[i], b: poly[(i + 1) % 4] });
    return b;
  }
  addRock(x: number, y: number, r: number, color: string): Rock | null {
    if (this.reserved(x, y, r + 2)) return null;
    const n = this.rng.int(6, 9);
    const poly: V2[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + this.rng.range(-0.2, 0.2);
      const rr = r * this.rng.range(0.75, 1.05);
      poly.push({ x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr * this.rng.range(0.7, 1) });
    }
    if (this.overlapsSolid(poly, 2)) return null;
    if (this.roadDist(x, y) < r + 1) return null;
    const rock: Rock = { id: this.nextId++, poly, x, y, r, color };
    this.m.rocks.push(rock);
    const bb = aabb(poly);
    this.m.grid.insert({ type: 'r', o: rock }, bb.x0, bb.y0, bb.x1, bb.y1);
    if (r > 2.2) for (let i = 0; i < n; i++) this.m.occluders.push({ a: poly[i], b: poly[(i + 1) % n] });
    return rock;
  }
  addTree(x: number, y: number, r: number, shrub = false): Tree | null {
    if (this.reserved(x, y, 1)) return null;
    if (this.roadDist(x, y) < (shrub ? 0.5 : 1.5)) return null;
    const near = this.m.grid.query(x - r, y - r, x + r, y + r);
    for (const o of near) {
      if ((o.type === 'b' || o.type === 'r' || o.type === 'w') && (pointInPoly({ x, y }, o.o.poly) || polyCircleDist(o.o.poly, x, y) < 1.5)) return null;
    }
    const t: Tree = { id: this.nextId++, x, y, r, alive: true, fall: 0, variant: this.rng.int(0, 5), shrub };
    this.m.trees.push(t);
    this.m.grid.insert({ type: 't', o: t }, x - 0.8, y - 0.8, x + 0.8, y + 0.8);
    return t;
  }
  addWall(a: V2, b: V2, w: number, kind: Wall['kind']): Wall | null {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    const poly = rectPoly((a.x + b.x) / 2, (a.y + b.y) / 2, l, w, ang);
    for (const p of poly) if (this.reserved(p.x, p.y, 1)) return null;
    if (this.overlapsSolid(poly, 0.5)) return null;
    for (let t = 0; t <= 1; t += 0.1) if (this.roadDist(a.x + dx * t, a.y + dy * t) < 0.5) return null;
    const wall: Wall = { id: this.nextId++, poly, kind, alive: true, a, b, w };
    this.m.walls.push(wall);
    const bb = aabb(poly);
    this.m.grid.insert({ type: 'w', o: wall }, bb.x0, bb.y0, bb.x1, bb.y1);
    return wall;
  }
  forest(cx: number, cy: number, rad: number, n: number, rMin: number, rMax: number) {
    for (let i = 0; i < n * 3 && n > 0; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = Math.sqrt(this.rng.next()) * rad;
      const t = this.addTree(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, this.rng.range(rMin, rMax));
      if (t) n--;
    }
  }
  patch(x: number, y: number, r: number, color: string, alpha: number) {
    this.m.patches.push({ x, y, r, color, alpha });
  }
  spawnLine(team: 0 | 1, x: number, yc: number, ang: number) {
    const arr = this.m.spawns[team];
    for (let i = 0; i < 5; i++) arr.push({ x: x + (i % 2) * (team === 0 ? -8 : 8), y: yc + (i - 2) * 16, ang });
  }
}

function grow(poly: V2[], pad: number): V2[] {
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p.x;
    cy += p.y;
  }
  cx /= poly.length;
  cy /= poly.length;
  return poly.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const l = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / l) * pad, y: p.y + (dy / l) * pad };
  });
}

function polyCircleDist(poly: V2[], x: number, y: number): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, pointSegDist({ x, y }, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

function smoothRoad(pts: V2[], seg = 6): V2[] {
  // Catmull-Rom resample
  const out: V2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < seg; k++) {
      const t = k / seg;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// Map layouts

function buildValley(b: Builder) {
  const m = b.m;
  const S = m.size;
  const R = b.rng;
  m.capture = { x: 222, y: 222, r: 18 };
  b.spawnLine(0, 34, 230, 0);
  b.spawnLine(1, S - 34, 205, Math.PI);
  m.roads.push({ kind: 'dirt', w: 9, pts: smoothRoad([{ x: -10, y: 252 }, { x: 80, y: 238 }, { x: 160, y: 214 }, { x: 222, y: 222 }, { x: 290, y: 232 }, { x: 360, y: 205 }, { x: S + 10, y: 196 }]) });
  m.roads.push({ kind: 'dirt', w: 8, pts: smoothRoad([{ x: 205, y: -10 }, { x: 196, y: 80 }, { x: 214, y: 160 }, { x: 222, y: 222 }, { x: 238, y: 300 }, { x: 226, y: 380 }, { x: 232, y: S + 10 }]) });
  m.roads.push({ kind: 'dirt', w: 6, pts: smoothRoad([{ x: 80, y: 238 }, { x: 96, y: 160 }, { x: 128, y: 104 }, { x: 196, y: 82 }]) });
  m.roads.push({ kind: 'dirt', w: 6, pts: smoothRoad([{ x: 290, y: 232 }, { x: 318, y: 300 }, { x: 330, y: 352 }, { x: 238, y: 360 }]) });

  // ground variation
  for (let i = 0; i < 120; i++) b.patch(R.range(0, S), R.range(0, S), R.range(8, 34), R.pick(['#3f4c2f', '#55643c', '#4a5634', '#5d6a40']), R.range(0.25, 0.5));
  for (let i = 0; i < 25; i++) b.patch(R.range(0, S), R.range(0, S), R.range(5, 14), '#6b6447', R.range(0.18, 0.35));

  // fields
  const fieldSpots = [
    [110, 60, 70, 46, 0.1],
    [330, 90, 80, 52, -0.15],
    [100, 360, 76, 50, 0.05],
    [340, 370, 70, 44, 0.2],
    [70, 140, 50, 60, 0.0],
    [370, 290, 52, 50, -0.05],
  ];
  for (const [x, y, w, h, a] of fieldSpots) {
    const poly = rectPoly(x, y, w, h, a);
    const col = R.pick(['#6a7342', '#7a7c48', '#5f6d3c', '#87804e']);
    m.fields.push({ poly, ang: a + (R.chance(0.5) ? Math.PI / 2 : 0), color: col, row: 'rgba(40,46,24,0.22)' });
    // hedgerow along one or two edges
    for (let e = 0; e < 4; e++) {
      if (!R.chance(0.45)) continue;
      const p = poly[e];
      const q = poly[(e + 1) % 4];
      const L = Math.hypot(q.x - p.x, q.y - p.y);
      for (let d = 2; d < L - 2; d += R.range(2.6, 4)) {
        const t = d / L;
        b.addTree(p.x + (q.x - p.x) * t + R.range(-0.6, 0.6), p.y + (q.y - p.y) * t + R.range(-0.6, 0.6), R.range(1.5, 2.3), true);
      }
    }
  }

  // village around the capture point
  const village: Array<[number, number, number, number, number]> = [
    [190, 194, 13, 9, 0.1],
    [252, 190, 12, 10, -0.05],
    [195, 252, 11, 9, 0.05],
    [256, 254, 14, 9, 0.12],
    [166, 230, 10, 8, -0.1],
    [276, 212, 10, 12, 0.05],
    [228, 180, 9, 8, 0.0],
    [214, 268, 10, 8, 0.15],
    [182, 168, 10, 8, 0.3],
    [266, 280, 9, 9, -0.2],
  ];
  for (const [x, y, w, h, a] of village) b.addBuilding(x, y, w, h, a, R.range(6, 9), 'gable', R.pick(['#7c4a3c', '#86553f', '#6e4636', '#7a5a44']));
  // farms
  for (const [x, y] of [
    [128, 128],
    [320, 140],
    [130, 300],
    [312, 320],
    [64, 64],
    [380, 50],
    [60, 390],
  ]) {
    for (let i = 0; i < 3; i++) b.addBuilding(x + R.range(-18, 18), y + R.range(-14, 14), R.range(8, 14), R.range(7, 10), R.range(-0.4, 0.4), R.range(5, 8), R.chance(0.7) ? 'gable' : 'flat', R.pick(['#7c4a3c', '#6d5a46', '#5f5a50', '#86553f']));
  }
  // fences around village
  for (let i = 0; i < 14; i++) {
    const a = R.range(0, Math.PI * 2);
    const d = R.range(40, 70);
    const x = 222 + Math.cos(a) * d;
    const y = 222 + Math.sin(a) * d;
    const ang = a + Math.PI / 2 + R.range(-0.2, 0.2);
    const l = R.range(8, 18);
    b.addWall({ x, y }, { x: x + Math.cos(ang) * l, y: y + Math.sin(ang) * l }, 0.35, 'fence');
  }
  // stone walls
  for (let i = 0; i < 8; i++) {
    const x = R.range(60, S - 60);
    const y = R.range(40, S - 40);
    const ang = R.range(0, Math.PI);
    const l = R.range(12, 26);
    b.addWall({ x, y }, { x: x + Math.cos(ang) * l, y: y + Math.sin(ang) * l }, 0.9, 'stone');
  }
  // forests
  const forests = [
    [150, 40, 30, 28],
    [270, 60, 26, 22],
    [40, 300, 26, 22],
    [140, 400, 34, 30],
    [300, 410, 28, 24],
    [400, 120, 30, 26],
    [410, 330, 24, 20],
    [160, 330, 22, 16],
    [290, 150, 18, 12],
    [150, 270, 16, 10],
    [60, 200, 14, 8],
    [380, 250, 14, 8],
    [250, 340, 18, 12],
    [200, 120, 16, 10],
  ];
  for (const [x, y, r, n] of forests) b.forest(x, y, r, n, 2.6, 4.8);
  for (let i = 0; i < 70; i++) b.addTree(R.range(10, S - 10), R.range(10, S - 10), R.range(2.2, 4.2));
  for (let i = 0; i < 12; i++) b.addRock(R.range(20, S - 20), R.range(20, S - 20), R.range(1.2, 2.6), '#6c6a62');
  for (let i = 0; i < 16; i++) m.decor.push({ kind: 'crater', x: R.range(30, S - 30), y: R.range(30, S - 30), r: R.range(1.5, 3.5), ang: 0, seed: R.int(0, 1e9) });
  for (let i = 0; i < 10; i++) m.decor.push({ kind: 'puddle', x: R.range(30, S - 30), y: R.range(30, S - 30), r: R.range(2, 5), ang: R.range(0, 3), seed: R.int(0, 1e9) });
}

function buildOutpost(b: Builder) {
  const m = b.m;
  const S = m.size;
  const R = b.rng;
  m.capture = { x: 224, y: 220, r: 17 };
  b.spawnLine(0, 34, 220, 0);
  b.spawnLine(1, S - 34, 220, Math.PI);
  m.roads.push({ kind: 'sand', w: 10, pts: smoothRoad([{ x: -10, y: 222 }, { x: 110, y: 214 }, { x: 224, y: 220 }, { x: 330, y: 228 }, { x: S + 10, y: 220 }]) });
  m.roads.push({ kind: 'sand', w: 8, pts: smoothRoad([{ x: 60, y: -10 }, { x: 130, y: 110 }, { x: 224, y: 220 }, { x: 310, y: 330 }, { x: 380, y: S + 10 }]) });
  m.roads.push({ kind: 'sand', w: 7, pts: smoothRoad([{ x: 224, y: 220 }, { x: 236, y: 120 }, { x: 260, y: -10 }]) });

  for (let i = 0; i < 110; i++) b.patch(R.range(0, S), R.range(0, S), R.range(10, 40), R.pick(['#a8916a', '#bfa982', '#9f8a63', '#c6b28c', '#ad9670']), R.range(0.25, 0.55));
  for (let i = 0; i < 30; i++) b.patch(R.range(0, S), R.range(0, S), R.range(6, 16), '#8d7a58', R.range(0.18, 0.32));

  // town: compounds on a jittered grid
  const roofs = ['#8f7a5f', '#9d8566', '#7f6b52', '#a48c6a', '#86705a', '#94806a'];
  for (let gx = -3; gx <= 3; gx++) {
    for (let gy = -3; gy <= 3; gy++) {
      const x = 224 + gx * 26 + R.range(-4, 4);
      const y = 220 + gy * 24 + R.range(-4, 4);
      if (Math.hypot(gx, gy) > 3.4) continue;
      if (R.chance(0.15)) continue;
      const w = R.range(10, 17);
      const h = R.range(9, 15);
      const bld = b.addBuilding(x, y, w, h, R.range(-0.06, 0.06), R.range(4, 8), R.chance(0.12) ? 'ruin' : 'flat', R.pick(roofs));
      if (bld && R.chance(0.45)) {
        // compound wall
        const side = R.int(0, 3);
        const p = bld.poly[side];
        const q = bld.poly[(side + 1) % 4];
        const nx = -(q.y - p.y);
        const ny = q.x - p.x;
        const nl = Math.hypot(nx, ny);
        const off = 5;
        b.addWall({ x: p.x + (nx / nl) * off, y: p.y + (ny / nl) * off }, { x: q.x + (nx / nl) * off, y: q.y + (ny / nl) * off }, 0.7, 'stone');
      }
    }
  }
  // outer hamlets
  for (const [x, y] of [
    [90, 90],
    [350, 90],
    [90, 350],
    [360, 360],
    [130, 300],
    [320, 150],
  ]) {
    for (let i = 0; i < 4; i++) b.addBuilding(x + R.range(-22, 22), y + R.range(-18, 18), R.range(8, 14), R.range(8, 12), R.range(-0.3, 0.3), R.range(4, 7), R.chance(0.2) ? 'ruin' : 'flat', R.pick(roofs));
  }
  // rock outcrops
  const outcrops = [
    [150, 60],
    [300, 50],
    [60, 160],
    [380, 170],
    [60, 280],
    [390, 290],
    [160, 390],
    [290, 400],
    [140, 170],
    [310, 280],
    [200, 330],
    [250, 110],
  ];
  for (const [x, y] of outcrops) {
    for (let i = 0; i < 5; i++) b.addRock(x + R.range(-14, 14), y + R.range(-12, 12), R.range(1.6, 4.5), R.pick(['#8a7860', '#7d6d58', '#94826a']));
  }
  for (let i = 0; i < 90; i++) b.addTree(R.range(10, S - 10), R.range(10, S - 10), R.range(1.0, 1.8), true);
  for (let i = 0; i < 12; i++) b.addTree(R.range(150, 300), R.range(150, 300), R.range(2.2, 3.2));
  // sandbag positions
  for (let i = 0; i < 10; i++) {
    const a = R.range(0, Math.PI * 2);
    const d = R.range(30, 120);
    const x = 224 + Math.cos(a) * d;
    const y = 220 + Math.sin(a) * d;
    const ang = a + Math.PI / 2;
    b.addWall({ x, y }, { x: x + Math.cos(ang) * 7, y: y + Math.sin(ang) * 7 }, 1.0, 'sandbag');
  }
  for (let i = 0; i < 22; i++) m.decor.push({ kind: R.chance(0.6) ? 'crater' : 'barrel', x: R.range(30, S - 30), y: R.range(30, S - 30), r: R.range(1, 3), ang: R.range(0, 6), seed: R.int(0, 1e9) });
  for (let i = 0; i < 14; i++) m.decor.push({ kind: 'crate', x: R.range(150, 300), y: R.range(150, 300), r: R.range(0.6, 1.0), ang: R.range(0, 6), seed: R.int(0, 1e9) });
}

function buildCity(b: Builder) {
  const m = b.m;
  const S = m.size;
  const R = b.rng;
  m.capture = { x: 220, y: 220, r: 18 };
  b.spawnLine(0, 30, 220, 0);
  b.spawnLine(1, S - 30, 220, Math.PI);
  const lines = [100, 220, 340];
  for (const x of lines) m.roads.push({ kind: 'asphalt', w: 16, pts: [{ x, y: -10 }, { x, y: S + 10 }] });
  for (const y of lines) m.roads.push({ kind: 'asphalt', w: 16, pts: [{ x: -10, y }, { x: S + 10, y }] });
  m.roads.push({ kind: 'asphalt', w: 10, pts: [{ x: 160, y: 100 }, { x: 160, y: 220 }] });
  m.roads.push({ kind: 'asphalt', w: 10, pts: [{ x: 280, y: 220 }, { x: 280, y: 340 }] });

  for (let i = 0; i < 60; i++) b.patch(R.range(0, S), R.range(0, S), R.range(8, 30), R.pick(['#4e4b45', '#5d5953', '#55524c']), R.range(0.25, 0.5));

  const roofs = ['#5f5a54', '#6a5d50', '#4f4d4a', '#6b4c3e', '#5c5f5c', '#73665a', '#58524c'];
  // blocks
  const edges = [0, 100, 220, 340, S];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const x0 = edges[i] + 13;
      const x1 = edges[i + 1] - 13;
      const y0 = edges[j] + 13;
      const y1 = edges[j + 1] - 13;
      const park = (i === 1 && j === 2) || (i === 2 && j === 1) || R.chance(0.08);
      if (park) {
        b.patch((x0 + x1) / 2, (y0 + y1) / 2, Math.min(x1 - x0, y1 - y0) * 0.55, '#4b5a36', 0.85);
        b.forest((x0 + x1) / 2, (y0 + y1) / 2, Math.min(x1 - x0, y1 - y0) * 0.4, 16, 2.5, 4.2);
        continue;
      }
      // perimeter buildings
      const cw = x1 - x0;
      const ch = y1 - y0;
      const along = (ax: number, ay: number, bx: number, by: number, depth: number, inward: V2) => {
        const L = Math.hypot(bx - ax, by - ay);
        let d = 0;
        while (d < L - 6) {
          const w = Math.min(R.range(10, 22), L - d);
          if (w < 7) break;
          const t = (d + w / 2) / L;
          const cx = ax + (bx - ax) * t + inward.x * (depth / 2);
          const cy = ay + (by - ay) * t + inward.y * (depth / 2);
          const horiz = Math.abs(bx - ax) > Math.abs(by - ay);
          const height = R.range(9, 24);
          if (!R.chance(0.12)) b.addBuilding(cx, cy, horiz ? w - 1 : depth, horiz ? depth : w - 1, 0, height, R.chance(0.1) ? 'ruin' : 'flat', R.pick(roofs));
          d += w + R.range(0.5, 4);
        }
      };
      const dep = Math.min(14, cw * 0.3, ch * 0.3);
      along(x0, y0, x1, y0, dep, { x: 0, y: 1 });
      along(x0, y1, x1, y1, dep, { x: 0, y: -1 });
      along(x0, y0 + dep + 2, x0, y1 - dep - 2, dep, { x: 1, y: 0 });
      along(x1, y0 + dep + 2, x1, y1 - dep - 2, dep, { x: -1, y: 0 });
      // courtyard trees
      for (let k = 0; k < 3; k++) b.addTree(R.range(x0 + dep + 4, x1 - dep - 4), R.range(y0 + dep + 4, y1 - dep - 4), R.range(2.2, 3.6));
    }
  }
  // street trees
  for (const x of lines) for (let y = 20; y < S; y += 26) if (R.chance(0.5)) b.addTree(x + (R.chance(0.5) ? 1 : -1) * 9.5, y, R.range(2.0, 3.0));
  for (let i = 0; i < 14; i++) m.decor.push({ kind: 'car', x: R.pick(lines) + R.range(-5, 5), y: R.range(20, S - 20), r: 2.2, ang: R.chance(0.5) ? Math.PI / 2 : -Math.PI / 2, seed: R.int(0, 1e9) });
  for (let i = 0; i < 14; i++) m.decor.push({ kind: 'car', x: R.range(20, S - 20), y: R.pick(lines) + R.range(-5, 5), r: 2.2, ang: R.chance(0.5) ? 0 : Math.PI, seed: R.int(0, 1e9) });
  for (let i = 0; i < 20; i++) m.decor.push({ kind: 'rubble', x: R.range(20, S - 20), y: R.range(20, S - 20), r: R.range(1.5, 4), ang: R.range(0, 6), seed: R.int(0, 1e9) });
  for (let i = 0; i < 18; i++) m.decor.push({ kind: 'manhole', x: R.pick(lines) + R.range(-4, 4), y: R.range(10, S - 10), r: 0.45, ang: 0, seed: 0 });
  for (let i = 0; i < 10; i++) m.decor.push({ kind: 'crater', x: R.range(30, S - 30), y: R.range(30, S - 30), r: R.range(1.5, 3), ang: 0, seed: R.int(0, 1e9) });
  // barricades
  for (let i = 0; i < 8; i++) {
    const x = R.pick(lines) + R.range(-5, 5);
    const y = R.range(40, S - 40);
    b.addWall({ x: x - 3, y }, { x: x + 3, y: y + R.range(-1, 1) }, 1.0, 'sandbag');
  }
}

export function buildMap(def: MapDef, seed = 1234): GameMap {
  const b = new Builder(def, seed + def.id.length * 977);
  if (def.theme === 'grass') buildValley(b);
  else if (def.theme === 'desert') buildOutpost(b);
  else buildCity(b);
  return b.m;
}

// ---------------------------------------------------------------------------
// Queries

/** Is the straight line a→b blocked for vision / shells by buildings or big rocks? */
export function losBlocked(m: GameMap, a: V2, b: V2): boolean {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const near = m.grid.query(x0, y0, x1, y1);
  for (const o of near) {
    if (o.type === 'b' && o.o.roof !== 'ruin') {
      if (segPolyHit(a, b, o.o.poly)) return true;
    } else if (o.type === 'r' && o.o.r > 2.2) {
      if (segPolyHit(a, b, o.o.poly)) return true;
    }
  }
  return false;
}

function segPolyHit(a: V2, b: V2, poly: V2[]): boolean {
  for (let i = 0; i < poly.length; i++) if (segSeg(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  return false;
}

/** First obstacle hit by a shell segment: returns t along a→b. */
export function shellObstacleHit(m: GameMap, a: V2, b: V2): { t: number; kind: 'building' | 'rock' | 'wall' } | null {
  const near = m.grid.query(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
  let best: { t: number; kind: 'building' | 'rock' | 'wall' } | null = null;
  for (const o of near) {
    let poly: V2[] | null = null;
    let kind: 'building' | 'rock' | 'wall' = 'building';
    if (o.type === 'b') {
      poly = o.o.poly;
      if (o.o.roof === 'ruin') continue;
    } else if (o.type === 'r') {
      poly = o.o.poly;
      kind = 'rock';
    } else if (o.type === 'w' && o.o.alive && o.o.kind !== 'fence') {
      poly = o.o.poly;
      kind = 'wall';
    }
    if (!poly) continue;
    for (let i = 0; i < poly.length; i++) {
      const r = segSeg(a, b, poly[i], poly[(i + 1) % poly.length]);
      if (r && (!best || r.t < best.t)) best = { t: r.t, kind };
    }
  }
  return best;
}

export interface Contact {
  nx: number;
  ny: number;
  depth: number;
  tree?: Tree;
  wall?: Wall;
}

/** Collisions of a tank footprint polygon against static obstacles. */
export function collideStatic(m: GameMap, poly: V2[], center: V2, radius: number, out: Contact[]) {
  const near = m.grid.query(center.x - radius - 1, center.y - radius - 1, center.x + radius + 1, center.y + radius + 1);
  for (const o of near) {
    if (o.type === 'b' || o.type === 'r') {
      const mtv = satMTV(poly, o.o.poly);
      if (mtv) out.push({ nx: mtv.x, ny: mtv.y, depth: mtv.depth });
    } else if (o.type === 'w') {
      if (!o.o.alive) continue;
      const mtv = satMTV(poly, o.o.poly);
      if (mtv) out.push({ nx: mtv.x, ny: mtv.y, depth: mtv.depth, wall: o.o });
    } else if (o.type === 't') {
      if (!o.o.alive) continue;
      const trunk = o.o.shrub ? 0.5 : 0.7;
      const mtv = circlePolyMTV({ x: o.o.x, y: o.o.y }, trunk, poly);
      if (mtv) out.push({ nx: -mtv.x, ny: -mtv.y, depth: mtv.depth, tree: o.o });
    }
  }
  // map bounds
  for (const p of poly) {
    if (p.x < 0) out.push({ nx: 1, ny: 0, depth: -p.x });
    if (p.y < 0) out.push({ nx: 0, ny: 1, depth: -p.y });
    if (p.x > m.size) out.push({ nx: -1, ny: 0, depth: p.x - m.size });
    if (p.y > m.size) out.push({ nx: 0, ny: -1, depth: p.y - m.size });
  }
}

/** Is a point under tree canopy (concealment)? */
export function inFoliage(m: GameMap, p: V2): boolean {
  const near = m.grid.query(p.x - 6, p.y - 6, p.x + 6, p.y + 6);
  for (const o of near) {
    if (o.type === 't' && o.o.alive && Math.hypot(o.o.x - p.x, o.o.y - p.y) < o.o.r * 0.95) return true;
  }
  return false;
}

export function solidAt(m: GameMap, p: V2, pad: number): boolean {
  const near = m.grid.query(p.x - pad, p.y - pad, p.x + pad, p.y + pad);
  for (const o of near) {
    if (o.type === 'b' || o.type === 'r' || (o.type === 'w' && o.o.alive && o.o.kind !== 'fence')) {
      if (pointInPoly(p, o.o.poly) || polyCircleDist(o.o.poly, p.x, p.y) < pad) return true;
    }
  }
  return false;
}
