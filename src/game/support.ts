// Killstreak support: a recon plane (2 kills in one life) that reveals every enemy for a while,
// and an artillery strike (3 kills) — a barrage of heavy HE on a chosen point. Kills made by
// the support itself do not extend the streak.

import type { ShellSpec } from '../data/vehicles';

export const RECON_TIME = 10;
export const RECON_EVERY = 2;
export const ARTY_EVERY = 3;

export const ARTY = {
  /** seconds from the call to the first impact */
  DELAY: 3.2,
  SHELLS: 8,
  /** impacts land within this radius of the aim point */
  SPREAD: 11,
  /** time between first and last impact */
  SPAN: 3.4,
};

export const ARTY_SHELL: ShellSpec = { name: 'sFH 18 HE', type: 'HE', pen: [40, 40, 40], velocity: 350, explosive: 4400, caliber: 150, count: 0 };

export interface SupportStock {
  recon: number;
  arty: number;
}

/** Recon flight: dives in from behind our lines, circles over the enemy half, then climbs away. */
export const RECON = {
  /** cruising speed while circling, and the speed of the diving entry (m/s) */
  SPEED: 40,
  ENTRY: 135,
  /** climb-out acceleration (m/s²) and how long it takes to leave (s) */
  CLIMB: 24,
  OUT: 4,
  /** altitude: entering, circling, leaving (m) */
  ALT_IN: 44,
  ALT: 23,
  ALT_OUT: 50,
  /** orbit radius (m) and bank angle while circling (rad) */
  R: 95,
  BANK: 0.42,
  /** the camera starts reporting this long before the plane joins its orbit (s) */
  LEAD: 1.4,
};

export interface ReconFlight {
  id: number;
  team: 0 | 1;
  /** time since the call */
  t: number;
  /** aircraft type (index in PLANE_KINDS: L-4 · Storch · Po-2) */
  kind: number;
  /** entry point, off the map */
  ex: number;
  ey: number;
  /** orbit centre and radius, the angle where it joins the orbit, direction (+1 / −1) */
  cx: number;
  cy: number;
  r: number;
  a0: number;
  dir: number;
  /** seconds from the entry point to the orbit */
  tin: number;
}

/** the plane circles until its camera stops reporting, then leaves */
const ORBIT = RECON_TIME - RECON.LEAD;

export function reconTotal(r: ReconFlight): number {
  return r.tin + ORBIT + RECON.OUT;
}

/** Seconds since the plane's camera started reporting (negative before). */
export function reconRevealT(r: ReconFlight): number {
  return r.t - (r.tin - RECON.LEAD);
}

/** Enemies are revealed to the plane's team now. */
export function reconRevealing(r: ReconFlight): boolean {
  const k = reconRevealT(r);
  return k >= 0 && k < RECON_TIME;
}

const smooth = (k: number) => {
  const x = Math.max(0, Math.min(1, k));
  return x * x * (3 - 2 * x);
};

/** Where the recon plane is: position, heading, altitude (m) and bank (rad). */
export function reconPos(r: ReconFlight): { x: number; y: number; ang: number; alt: number; bank: number } {
  const t = r.t;
  const px = r.cx + Math.cos(r.a0) * r.r;
  const py = r.cy + Math.sin(r.a0) * r.r;
  const orbitT = ORBIT;
  if (t < r.tin) {
    // straight dive toward the orbit, slowing down from the entry speed to cruising speed
    const L = Math.hypot(px - r.ex, py - r.ey) || 1;
    const s = RECON.ENTRY * t - ((RECON.ENTRY - RECON.SPEED) * t * t) / (2 * r.tin);
    const u = Math.min(1, s / L);
    return {
      x: r.ex + (px - r.ex) * u,
      y: r.ey + (py - r.ey) * u,
      ang: Math.atan2(py - r.ey, px - r.ex),
      alt: RECON.ALT_IN + (RECON.ALT - RECON.ALT_IN) * smooth(t / r.tin),
      bank: r.dir * RECON.BANK * smooth((t - (r.tin - 1)) / 1),
    };
  }
  const w = RECON.SPEED / r.r;
  if (t < r.tin + orbitT) {
    const th = r.a0 + r.dir * w * (t - r.tin);
    return { x: r.cx + Math.cos(th) * r.r, y: r.cy + Math.sin(th) * r.r, ang: th + (r.dir * Math.PI) / 2, alt: RECON.ALT, bank: r.dir * RECON.BANK };
  }
  // leave along the tangent, climbing away
  const tau = t - r.tin - orbitT;
  const th1 = r.a0 + r.dir * w * orbitT;
  const h = th1 + (r.dir * Math.PI) / 2;
  const s = RECON.SPEED * tau + (RECON.CLIMB * tau * tau) / 2;
  return {
    x: r.cx + Math.cos(th1) * r.r + Math.cos(h) * s,
    y: r.cy + Math.sin(th1) * r.r + Math.sin(h) * s,
    ang: h,
    alt: RECON.ALT + (RECON.ALT_OUT - RECON.ALT) * smooth(tau / RECON.OUT),
    bank: r.dir * RECON.BANK * (1 - smooth(tau / 0.8)),
  };
}

/**
 * Plan a flight for `team`: in from the map edge on our side, onto an orbit over the enemy half
 * (the straight run-in meets the circle on a tangent, so the turn into the orbit is smooth).
 */
export function planRecon(id: number, team: 0 | 1, kind: number, S: number, cap: { x: number; y: number }, ownSpawn: { x: number; y: number }, enemySpawn: { x: number; y: number }, rnd: () => number): ReconFlight {
  const rr = RECON.R * (0.9 + rnd() * 0.2);
  const m = rr * 0.7;
  const cx = Math.max(m, Math.min(S - m, cap.x + (enemySpawn.x - cap.x) * 0.42 + (rnd() - 0.5) * 40));
  const cy = Math.max(m, Math.min(S - m, cap.y + (enemySpawn.y - cap.y) * 0.42 + (rnd() - 0.5) * 60));
  // entry: just off the edge behind our own lines
  const fromLeft = ownSpawn.x < S / 2;
  const ex = fromLeft ? -45 : S + 45;
  const ey = Math.max(-20, Math.min(S + 20, ownSpawn.y + (rnd() - 0.5) * S * 0.6));
  const dir = rnd() < 0.5 ? 1 : -1;
  const d = Math.max(rr + 1, Math.hypot(ex - cx, ey - cy));
  const phi = Math.atan2(ey - cy, ex - cx);
  const off = Math.acos(rr / d);
  let a0 = phi + off;
  for (const cand of [phi + off, phi - off]) {
    const qx = cx + Math.cos(cand) * rr;
    const qy = cy + Math.sin(cand) * rr;
    // travel direction on the orbit at that point must continue the run-in
    const vx = -Math.sin(cand) * dir;
    const vy = Math.cos(cand) * dir;
    if ((qx - ex) * vx + (qy - ey) * vy > 0) a0 = cand;
  }
  const L = Math.hypot(cx + Math.cos(a0) * rr - ex, cy + Math.sin(a0) * rr - ey);
  const tin = (2 * L) / (RECON.ENTRY + RECON.SPEED);
  return { id, team, t: 0, kind, ex, ey, cx, cy, r: rr, a0, dir, tin };
}

export interface ArtyStrike {
  id: number;
  team: 0 | 1;
  /** caller (tank id) */
  by: number;
  x: number;
  y: number;
  /** time since the call */
  t: number;
  /** impact times (since the call), ascending */
  times: number[];
  fired: number;
  whistled: number;
}

