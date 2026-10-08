// Crew carrier: a half-track that races up from behind the lines, parks next to a tank and,
// after a few seconds, swaps every wounded or dead crew member for a fresh one.
// It is thin-skinned — any hit destroys it (no score for the shooter) and the swap is lost.

import { type V2, angDiff, approach, clamp, dist, segSeg, toWorld } from '../core/math';
import { collideStatic, type Contact, type GameMap, rectPoly } from './map';

export const CARRIER = {
  L: 5.6,
  W: 2.3,
  SPEED: 15,
  /** parked seconds before the crew swap happens */
  PARK: 4,
  /** cooldown after a completed swap / after losing the carrier */
  CD: 45,
  CD_LOST: 25,
  /** distance from the tank at which it parks */
  REACH: 7.5,
};

export type CarrierState = 'drive' | 'park' | 'leave' | 'dead';
export const CARRIER_STATES: CarrierState[] = ['drive', 'park', 'leave', 'dead'];

export interface Carrier {
  id: number;
  team: 0 | 1;
  /** tank being resupplied */
  forId: number;
  nation: string;
  pos: V2;
  ang: number;
  speed: number;
  path: V2[];
  state: CarrierState;
  /** park timer (drive/park) or time since destruction (dead) */
  t: number;
  home: V2;
  repath: number;
  age: number;
  /** replica: latest snapshot target */
  net?: { x: number; y: number; ang: number };
}

export function carrierPoly(c: Carrier): V2[] {
  return rectPoly(c.pos.x, c.pos.y, CARRIER.L, CARRIER.W, c.ang);
}

/** First intersection of segment a→b with the carrier body (t along a→b), or null. */
export function carrierHit(c: Carrier, a: V2, b: V2): number | null {
  if (dist(c.pos, a) > dist(a, b) + CARRIER.L) return null;
  const poly = carrierPoly(c);
  let best: number | null = null;
  for (let i = 0; i < 4; i++) {
    const r = segSeg(a, b, poly[i], poly[(i + 1) % 4]);
    if (r && (best === null || r.t < best)) best = r.t;
  }
  return best;
}

/** Steer along the path toward `goal`, slowing down to stop `stopAt` metres short of it. */
export function driveCarrier(c: Carrier, m: GameMap, goal: V2, stopAt: number, dt: number, blockers: V2[][]) {
  while (c.path.length > 1 && dist(c.pos, c.path[0]) < 3.5) c.path.shift();
  const wp = c.path[0] ?? goal;
  const want = Math.atan2(wp.y - c.pos.y, wp.x - c.pos.x);
  const d = angDiff(c.ang, want);
  c.ang += clamp(d, -2.2 * dt, 2.2 * dt);
  const left = dist(c.pos, goal) - stopAt;
  const turnSlow = Math.abs(d) > 1 ? 0.35 : Math.abs(d) > 0.5 ? 0.65 : 1;
  const target = Math.max(0, Math.min(CARRIER.SPEED * turnSlow, left * 1.6 + 1.5));
  c.speed = approach(c.speed, target, (target > c.speed ? 7 : 14) * dt);
  c.pos.x += Math.cos(c.ang) * c.speed * dt;
  c.pos.y += Math.sin(c.ang) * c.speed * dt;
  // keep out of buildings, rocks and the tanks
  const contacts: Contact[] = [];
  const poly = carrierPoly(c);
  collideStatic(m, poly, c.pos, CARRIER.L / 2 + 0.5, contacts);
  for (const ct of contacts) {
    if (ct.tree || (ct.wall && ct.wall.kind === 'fence')) continue;
    c.pos.x += ct.nx * ct.depth;
    c.pos.y += ct.ny * ct.depth;
  }
  for (const bp of blockers) {
    // cheap circle push against tank hulls (blockers are hull polygons in world space)
    let cx = 0;
    let cy = 0;
    for (const p of bp) {
      cx += p.x;
      cy += p.y;
    }
    cx /= bp.length;
    cy /= bp.length;
    const dd = Math.hypot(c.pos.x - cx, c.pos.y - cy);
    const minD = 3.6;
    if (dd < minD && dd > 1e-3) {
      c.pos.x += ((c.pos.x - cx) / dd) * (minD - dd);
      c.pos.y += ((c.pos.y - cy) / dd) * (minD - dd);
    }
  }
}

/** Where the replacement crew walk between the carrier's tailgate and the tank. */
export function carrierTailgate(c: Carrier): V2 {
  return toWorld({ x: -CARRIER.L / 2 - 0.3, y: 0 }, c.pos, c.ang);
}
