// Basic 2D math helpers. World units are meters, x → right, y → down.
// Angles are radians, 0 = +x, positive = clockwise on screen (because y points down).

export interface V2 {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const v2 = (x = 0, y = 0): V2 => ({ x, y });
export const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: V2, s: number): V2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: V2, b: V2): number => a.x * b.x + a.y * b.y;
export const cross = (a: V2, b: V2): number => a.x * b.y - a.y * b.x;
export const len = (a: V2): number => Math.hypot(a.x, a.y);
export const len2 = (a: V2): number => a.x * a.x + a.y * a.y;
export const dist = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const dist2 = (a: V2, b: V2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};
export const norm = (a: V2): V2 => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};
export const fromAngle = (a: number, l = 1): V2 => ({ x: Math.cos(a) * l, y: Math.sin(a) * l });
export const angleOf = (a: V2): number => Math.atan2(a.y, a.x);
export const rot = (a: V2, ang: number): V2 => {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};
export const perp = (a: V2): V2 => ({ x: -a.y, y: a.x });
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpV = (a: V2, b: V2, t: number): V2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Normalize angle to (-PI, PI]. */
export function angNorm(a: number): number {
  a = a % TAU;
  if (a <= -Math.PI) a += TAU;
  else if (a > Math.PI) a -= TAU;
  return a;
}
/** Shortest signed difference to rotate from a to b. */
export const angDiff = (a: number, b: number): number => angNorm(b - a);
/** Rotate cur toward target by at most maxStep. */
export function approachAngle(cur: number, target: number, maxStep: number): number {
  const d = angDiff(cur, target);
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}
export function approach(cur: number, target: number, maxStep: number): number {
  if (cur < target) return Math.min(cur + maxStep, target);
  return Math.max(cur - maxStep, target);
}

/** Transform a point from local frame (pos, ang) into world. */
export function toWorld(local: V2, pos: V2, ang: number): V2 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: pos.x + local.x * c - local.y * s, y: pos.y + local.x * s + local.y * c };
}
/** Transform world point into local frame (pos, ang). */
export function toLocal(world: V2, pos: V2, ang: number): V2 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const dx = world.x - pos.x;
  const dy = world.y - pos.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}
/** Rotate a direction vector into local frame. */
export function dirToLocal(d: V2, ang: number): V2 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: d.x * c + d.y * s, y: -d.x * s + d.y * c };
}
export function dirToWorld(d: V2, ang: number): V2 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: d.x * c - d.y * s, y: d.x * s + d.y * c };
}

/**
 * Segment p→p2 vs segment q→q2. Returns t along p→p2 (0..1) and u along q→q2, or null.
 */
export function segSeg(p: V2, p2: V2, q: V2, q2: V2): { t: number; u: number } | null {
  const rx = p2.x - p.x;
  const ry = p2.y - p.y;
  const sx = q2.x - q.x;
  const sy = q2.y - q.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qpx = q.x - p.x;
  const qpy = q.y - p.y;
  const t = (qpx * sy - qpy * sx) / den;
  const u = (qpx * ry - qpy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** Ray o + d*t (t>=0) vs segment a→b. Returns t or -1. d need not be normalized. */
export function raySeg(ox: number, oy: number, dx: number, dy: number, ax: number, ay: number, bx: number, by: number): number {
  const sx = bx - ax;
  const sy = by - ay;
  const den = dx * sy - dy * sx;
  if (Math.abs(den) < 1e-12) return -1;
  const qpx = ax - ox;
  const qpy = ay - oy;
  const t = (qpx * sy - qpy * sx) / den;
  const u = (qpx * dy - qpy * dx) / den;
  if (t < 0 || u < 0 || u > 1) return -1;
  return t;
}

export function pointInPoly(p: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Ray vs axis aligned rect, returns [tEnter, tExit] or null. */
export function rayRect(ox: number, oy: number, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number): [number, number] | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  if (Math.abs(dx) < 1e-12) {
    if (ox < x0 || ox > x1) return null;
  } else {
    let t1 = (x0 - ox) / dx;
    let t2 = (x1 - ox) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (Math.abs(dy) < 1e-12) {
    if (oy < y0 || oy > y1) return null;
  } else {
    let t1 = (y0 - oy) / dy;
    let t2 = (y1 - oy) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
  }
  if (tmax < Math.max(tmin, 0)) return null;
  return [tmin, tmax];
}

/** Ray vs circle; returns [tEnter, tExit] or null (d normalized). */
export function rayCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): [number, number] | null {
  const fx = ox - cx;
  const fy = oy - cy;
  const b = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  const t1 = -b + s;
  if (t1 < 0) return null;
  return [t0, t1];
}

/** Distance from point to segment. */
export function pointSegDist(p: V2, a: V2, b: V2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  let t = l2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}

/** Corners of an oriented box (center, angle, half length, half width), clockwise. */
export function obb(pos: V2, ang: number, hl: number, hw: number): V2[] {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const fx = c * hl;
  const fy = s * hl;
  const rx = -s * hw;
  const ry = c * hw;
  return [
    { x: pos.x + fx - rx, y: pos.y + fy - ry },
    { x: pos.x + fx + rx, y: pos.y + fy + ry },
    { x: pos.x - fx + rx, y: pos.y - fy + ry },
    { x: pos.x - fx - rx, y: pos.y - fy - ry },
  ];
}

function projectPoly(poly: V2[], ax: number, ay: number): [number, number] {
  let mn = Infinity;
  let mx = -Infinity;
  for (const p of poly) {
    const d = p.x * ax + p.y * ay;
    if (d < mn) mn = d;
    if (d > mx) mx = d;
  }
  return [mn, mx];
}

/**
 * Separating axis test between two convex polygons.
 * Returns minimal translation vector to push A out of B, or null if not overlapping.
 */
export function satMTV(A: V2[], B: V2[]): { x: number; y: number; depth: number } | null {
  let best = Infinity;
  let bx = 0;
  let by = 0;
  const polys = [A, B];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      let ax = -(p2.y - p1.y);
      let ay = p2.x - p1.x;
      const l = Math.hypot(ax, ay);
      if (l < 1e-9) continue;
      ax /= l;
      ay /= l;
      const [a0, a1] = projectPoly(A, ax, ay);
      const [b0, b1] = projectPoly(B, ax, ay);
      const o = Math.min(a1, b1) - Math.max(a0, b0);
      if (o <= 0) return null;
      if (o < best) {
        best = o;
        // direction from B to A
        const ca = (a0 + a1) / 2;
        const cb = (b0 + b1) / 2;
        const sgn = ca < cb ? -1 : 1;
        bx = ax * sgn;
        by = ay * sgn;
      }
    }
  }
  return { x: bx, y: by, depth: best };
}

/** Circle vs convex polygon: push vector for circle out of polygon. */
export function circlePolyMTV(c: V2, r: number, poly: V2[]): { x: number; y: number; depth: number } | null {
  // find closest point on polygon boundary
  let minD = Infinity;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const l2 = abx * abx + aby * aby;
    let t = l2 > 0 ? ((c.x - a.x) * abx + (c.y - a.y) * aby) / l2 : 0;
    t = clamp(t, 0, 1);
    const px = a.x + abx * t;
    const py = a.y + aby * t;
    const d = Math.hypot(c.x - px, c.y - py);
    if (d < minD) {
      minD = d;
      cx = px;
      cy = py;
    }
  }
  const inside = pointInPoly(c, poly);
  if (!inside && minD >= r) return null;
  let nx = c.x - cx;
  let ny = c.y - cy;
  const l = Math.hypot(nx, ny) || 1;
  nx /= l;
  ny /= l;
  if (inside) {
    nx = -nx;
    ny = -ny;
    return { x: nx, y: ny, depth: r + minD };
  }
  return { x: nx, y: ny, depth: r - minD };
}

export function polyCentroid(poly: V2[]): V2 {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

export function formatNum(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
