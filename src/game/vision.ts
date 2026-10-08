// Vision: the player's visibility polygon (near circle + long cone along the gun,
// occluded by buildings), and team spotting rules.

import { type V2, angDiff, raySeg } from '../core/math';
import type { GameMap } from './map';
import { inFoliage, losBlocked, smokeRadius } from './map';
import type { Tank } from './tank';

export function visibilityPolygon(map: GameMap, o: V2, coneAng: number, half: number, range: number, near: number): V2[] {
  // candidate occluders
  const segs: Array<{ a: V2; b: V2 }> = [];
  const r2 = range + 4;
  for (const s of map.occluders) {
    const mx = (s.a.x + s.b.x) / 2;
    const my = (s.a.y + s.b.y) / 2;
    const d = Math.hypot(mx - o.x, my - o.y);
    if (d > r2 + 20) continue;
    if (d < near + 25) {
      segs.push(s);
      continue;
    }
    const aa = Math.abs(angDiff(coneAng, Math.atan2(s.a.y - o.y, s.a.x - o.x)));
    const ab = Math.abs(angDiff(coneAng, Math.atan2(s.b.y - o.y, s.b.x - o.x)));
    const am = Math.abs(angDiff(coneAng, Math.atan2(my - o.y, mx - o.x)));
    if (Math.min(aa, ab, am) < half + 0.3) segs.push(s);
  }
  // smoke screens act as round occluders
  for (const sm of map.smokes) {
    const re = smokeRadius(sm);
    if (re < 1.5) continue;
    if (Math.hypot(sm.x - o.x, sm.y - o.y) > r2 + re) continue;
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      segs.push({ a: { x: sm.x + Math.cos(a0) * re, y: sm.y + Math.sin(a0) * re }, b: { x: sm.x + Math.cos(a1) * re, y: sm.y + Math.sin(a1) * re } });
    }
  }
  const angles: number[] = [];
  const inCone = (a: number) => Math.abs(angDiff(coneAng, a)) <= half;
  // uniform samples
  for (let a = -Math.PI; a < Math.PI; a += 0.07) angles.push(a);
  for (let a = coneAng - half; a <= coneAng + half; a += 0.022) angles.push(a);
  // cone edges (both sides of each edge)
  const e1 = coneAng - half;
  const e2 = coneAng + half;
  angles.push(e1 - 1e-4, e1 + 1e-4, e2 - 1e-4, e2 + 1e-4);
  // occluder corners
  for (const s of segs) {
    for (const p of [s.a, s.b]) {
      const a = Math.atan2(p.y - o.y, p.x - o.x);
      const d = Math.hypot(p.x - o.x, p.y - o.y);
      if (d > (inCone(a) ? range : near) + 2) continue;
      angles.push(a - 2e-4, a + 2e-4);
    }
  }
  const norm = (a: number) => {
    a = (a + Math.PI) % (Math.PI * 2);
    if (a < 0) a += Math.PI * 2;
    return a - Math.PI;
  };
  const sorted = angles.map(norm).sort((x, y) => x - y);
  const pts: V2[] = [];
  let last = -999;
  for (const a of sorted) {
    if (a - last < 1e-5) continue;
    last = a;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let t = inCone(a) ? range : near;
    for (const s of segs) {
      const h = raySeg(o.x, o.y, dx, dy, s.a.x, s.a.y, s.b.x, s.b.y);
      if (h >= 0 && h < t) t = h;
    }
    pts.push({ x: o.x + dx * t, y: o.y + dy * t });
  }
  return pts;
}

/** Can `v` see `t` right now? */
export function canSee(map: GameMap, v: Tank, t: Tank, now: number): boolean {
  const vc = v.visionCone();
  const tp = v.turretPos();
  const dx = t.pos.x - tp.x;
  const dy = t.pos.y - tp.y;
  const d = Math.hypot(dx, dy);
  const revealed = t.revealedUntil > now;
  if (d > (revealed ? 320 : vc.range)) return false;
  const bearing = Math.atan2(dy, dx);
  const inCone = Math.abs(angDiff(v.gunWorldAng, bearing)) <= vc.half;
  if (!revealed && !inCone && d > vc.near) return false;
  if (!revealed && d > 55 && inFoliage(map, t.pos)) return false;
  if (!losBlocked(map, tp, t.pos)) return true;
  // try front & rear corners so partly exposed tanks are seen
  const f = { x: Math.cos(t.ang) * t.bp.L * 0.45, y: Math.sin(t.ang) * t.bp.L * 0.45 };
  if (!losBlocked(map, tp, { x: t.pos.x + f.x, y: t.pos.y + f.y })) return true;
  if (!losBlocked(map, tp, { x: t.pos.x - f.x, y: t.pos.y - f.y })) return true;
  return false;
}
