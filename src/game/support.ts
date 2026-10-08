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
  SPREAD: 14,
  /** time between first and last impact */
  SPAN: 3.4,
};

export const ARTY_SHELL: ShellSpec = { name: 'sFH 18 HE', type: 'HE', pen: [40, 40, 40], velocity: 350, explosive: 4400, caliber: 150, count: 0 };

export interface SupportStock {
  recon: number;
  arty: number;
}

export interface ReconFlight {
  id: number;
  team: 0 | 1;
  t: number;
  T: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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

/** Position of a recon plane along its flight (0..1). */
export function reconPos(r: ReconFlight): { x: number; y: number; ang: number } {
  const k = Math.min(1, r.t / r.T);
  return { x: r.x0 + (r.x1 - r.x0) * k, y: r.y0 + (r.y1 - r.y0) * k, ang: Math.atan2(r.y1 - r.y0, r.x1 - r.x0) };
}
