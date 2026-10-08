// Weather and time of day: how far crews can see, mud in the rain, and illumination flares
// for night battles.

import type { V2 } from '../core/math';

export type WeatherId = 'clear' | 'rain' | 'fog' | 'night';

export interface WeatherDef {
  id: WeatherId;
  /** display name (i18n key) */
  name: string;
  icon: string;
  /** one-line effect summary (i18n key) */
  info: string;
  /** spotting range multiplier for the long vision cone along the gun */
  range: number;
  /** all-round close awareness radius (m) */
  near: number;
  /** a tank that just fired can be seen this far away (muzzle flash) */
  reveal: number;
  /** tanks in foliage are hidden beyond this distance */
  foliage: number;
  /** off-road speed factor (mud) */
  mud: number;
  /** illumination flares per tank */
  flares: number;
}

export const WEATHERS: Record<WeatherId, WeatherDef> = {
  clear: { id: 'clear', name: 'Clear', icon: '☀', info: 'Full visibility', range: 1, near: 42, reveal: 320, foliage: 55, mud: 1, flares: 0 },
  rain: { id: 'rain', name: 'Rain', icon: '🌧', info: 'Shorter sight · muddy off-road', range: 0.78, near: 40, reveal: 260, foliage: 48, mud: 0.84, flares: 0 },
  fog: { id: 'fog', name: 'Fog', icon: '🌫', info: 'Very short sight · close-range fights', range: 0.52, near: 34, reveal: 170, foliage: 36, mud: 1, flares: 0 },
  night: { id: 'night', name: 'Night', icon: '🌙', info: 'Darkness · gun flashes give you away · flares', range: 0.46, near: 28, reveal: 320, foliage: 32, mud: 1, flares: 2 },
};

export const WEATHER_IDS: WeatherId[] = ['clear', 'rain', 'fog', 'night'];

export function isWeatherId(v: unknown): v is WeatherId {
  return typeof v === 'string' && v in WEATHERS;
}

/** Resolve a preference ('random' or an id) to a concrete weather. */
export function pickWeather(pref: string, rnd: () => number = Math.random): WeatherId {
  if (isWeatherId(pref)) return pref;
  const r = rnd();
  return r < 0.4 ? 'clear' : r < 0.6 ? 'rain' : r < 0.8 ? 'fog' : 'night';
}

// ------------------------------------------------------------------ flares
export const FLARE = {
  /** distance from the launcher to the burst point (m) */
  RANGE: 85,
  /** flight time to the burst (s) */
  FLIGHT: 1.3,
  /** burn time under the parachute (s) */
  BURN: 14,
  /** radius of the lit area (m) */
  RADIUS: 50,
  /** cooldown between two flares (s) */
  CD: 5,
};

/** parachute drift (m/s) */
const DRIFT: V2 = { x: 0.55, y: -0.32 };

export interface Flare {
  id: number;
  team: 0 | 1;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** time since launch */
  t: number;
}

export interface FlareLight {
  x: number;
  y: number;
  /** brightness 0..1 */
  k: number;
  /** remaining height 0..1 (rising: 0→1, then sinking) */
  h: number;
  /** radius of the lit area */
  r: number;
}

/** Where a flare is and how brightly it burns. */
export function flareLight(f: Flare): FlareLight {
  if (f.t < FLARE.FLIGHT) {
    const u = f.t / FLARE.FLIGHT;
    return { x: f.x0 + (f.x1 - f.x0) * u, y: f.y0 + (f.y1 - f.y0) * u, k: 0, h: Math.sin((u * Math.PI) / 2), r: 0 };
  }
  const b = f.t - FLARE.FLIGHT;
  const fadeIn = Math.min(1, b / 0.35);
  const fadeOut = Math.max(0, Math.min(1, (FLARE.BURN - b) / 2.5));
  const flicker = 0.92 + 0.08 * Math.sin(f.t * 23 + f.id * 3.1) * Math.sin(f.t * 7.3);
  const h = Math.max(0, 1 - b / FLARE.BURN);
  return { x: f.x1 + DRIFT.x * b, y: f.y1 + DRIFT.y * b, k: fadeIn * fadeOut * flicker, h, r: FLARE.RADIUS * (0.8 + 0.2 * h) };
}

export function flareDone(f: Flare): boolean {
  return f.t >= FLARE.FLIGHT + FLARE.BURN;
}

/** Is the point inside a flare's light? */
export function inFlareLight(flares: Flare[], p: V2, min = 0.3): boolean {
  for (const f of flares) {
    if (f.t < FLARE.FLIGHT) continue;
    const l = flareLight(f);
    if (l.k < min) continue;
    if (Math.hypot(p.x - l.x, p.y - l.y) < l.r) return true;
  }
  return false;
}
