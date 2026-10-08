// Builds the geometric "blueprint" of a vehicle from its spec:
// armor outline polygons (hull + turret/casemate), per-edge armor plates,
// internal modules (engine, fuel, ammo, breech...) and crew positions.
// Coordinates are local, in meters: +x forward, +y to the right side.

import type { V2 } from '../core/math';
import type { CrewRole, Plate, VehicleSpec } from '../data/vehicles';

export type PlateKey = 'ufp' | 'lfp' | 'side' | 'rear' | 'tFront' | 'tSide' | 'tRear' | 'mantlet';
export type Zone = 'front' | 'side' | 'rear';

export interface ArmorEdge {
  a: V2;
  b: V2;
  n: V2; // outward normal (unit)
  key: PlateKey;
  zone: Zone;
}

export type ModuleKind = 'engine' | 'transmission' | 'fuel' | 'ammo' | 'breech' | 'barrel' | 'track' | 'crew';
export type Frame = 'hull' | 'turret' | 'gun';

export type Shape = { t: 'rect'; x0: number; y0: number; x1: number; y1: number } | { t: 'circle'; x: number; y: number; r: number };

export interface ModuleDef {
  id: string;
  kind: ModuleKind;
  label: string;
  frame: Frame;
  shape: Shape;
  maxHp: number;
  role?: CrewRole;
  side?: -1 | 1;
}

export interface Blueprint {
  spec: VehicleSpec;
  L: number;
  W: number;
  hullPoly: V2[];
  hullEdges: ArmorEdge[];
  turretPoly: V2[];
  turretEdges: ArmorEdge[];
  turretX: number;
  casemate: boolean;
  /** Gun pivot in turret frame. */
  gunPivot: V2;
  /** Distance from gun pivot to the mantlet face (where the barrel starts). */
  barrelStart: number;
  muzzle: number; // distance pivot → muzzle
  modules: ModuleDef[];
  radius: number;
  turretFrontX: number;
  turretBackX: number;
}

const cache = new Map<string, Blueprint>();

export function getBlueprint(spec: VehicleSpec): Blueprint {
  let bp = cache.get(spec.id);
  if (!bp) {
    bp = build(spec);
    cache.set(spec.id, bp);
  }
  return bp;
}

export function plateOf(spec: VehicleSpec, key: PlateKey): Plate {
  return spec.armor[key];
}

// ---------------------------------------------------------------------------

function superellipse(a: number, b: number, n: number, steps: number, ox = 0, bRearScale = 1, frontClip = 1): V2[] {
  const pts: V2[] = [];
  for (let i = 0; i < steps; i++) {
    const th = (i / steps) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    let x = a * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const bb = c < 0 ? b * (1 - (1 - bRearScale) * Math.abs(c)) : b;
    const y = bb * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    if (x > a * frontClip) x = a * frontClip;
    pts.push({ x: x + ox, y });
  }
  return dedupe(pts);
}

function dedupe(pts: V2[]): V2[] {
  const out: V2[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 0.02) out.push(p);
  }
  if (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 0.02) out.pop();
  return out;
}

function roundedRearRect(a: number, frontHalf: number, rearHalf: number, r: number, ox: number, frontChamfer = 0.12): V2[] {
  // front (x=a) narrower, rear (x=-a) wider with rounded rear corners
  const pts: V2[] = [];
  pts.push({ x: a, y: -frontHalf + frontChamfer });
  pts.push({ x: a, y: frontHalf - frontChamfer });
  pts.push({ x: a - frontChamfer, y: frontHalf });
  pts.push({ x: -a + r, y: rearHalf });
  for (let i = 1; i < 5; i++) {
    const th = Math.PI / 2 + (i / 5) * (Math.PI / 2);
    pts.push({ x: -a + r + Math.cos(th) * r, y: rearHalf - r + Math.sin(th) * r });
  }
  pts.push({ x: -a, y: rearHalf - r });
  pts.push({ x: -a, y: -rearHalf + r });
  for (let i = 1; i < 5; i++) {
    const th = Math.PI + (i / 5) * (Math.PI / 2);
    pts.push({ x: -a + r + Math.cos(th) * r, y: -rearHalf + r + Math.sin(th) * r });
  }
  pts.push({ x: -a + r, y: -rearHalf });
  pts.push({ x: a - frontChamfer, y: -frontHalf });
  return pts.map((p) => ({ x: p.x + ox, y: p.y }));
}

function turretPolygon(spec: VehicleSpec): V2[] {
  const t = spec.look.turret;
  const a = t.len / 2;
  const b = t.wid / 2;
  const ox = t.ox ?? 0;
  const fw = (t.frontW ?? 0.6) * b;
  switch (t.shape) {
    case 'round':
      return superellipse(a, b, 2.6, 28, ox, 0.86, 0.9);
    case 'dome':
      return superellipse(a, b, 2.25, 28, ox, 0.72, 0.94);
    case 'box':
      return superellipse(a, b, 6, 28, ox, 1, 1);
    case 'tiger': {
      // flat front, straight sides, horseshoe rear
      const pts: V2[] = [];
      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        const th = Math.PI / 2 + (i / steps) * Math.PI; // rear half
        pts.push({ x: Math.cos(th) * a * 0.95 + ox - 0.05, y: Math.sin(th) * b });
      }
      // order so polygon goes: front-left → front-right → rear arc
      const front: V2[] = [
        { x: a + ox, y: -b * 0.6 },
        { x: a + ox, y: b * 0.6 },
        { x: a * 0.55 + ox, y: b },
      ];
      const rear = pts.slice().map((p) => ({ x: p.x, y: p.y }));
      return dedupe([...front, ...rear, { x: a * 0.55 + ox, y: -b }]);
    }
    case 'panther':
      return roundedRearRect(a, fw, b, 0.45, ox, 0.08);
    case 'hex':
      return [
        { x: a + ox, y: -fw },
        { x: a + ox, y: fw },
        { x: a * 0.1 + ox, y: b },
        { x: -a * 0.7 + ox, y: b },
        { x: -a + ox, y: b * 0.55 },
        { x: -a + ox, y: -b * 0.55 },
        { x: -a * 0.7 + ox, y: -b },
        { x: a * 0.1 + ox, y: -b },
      ];
    case 'pent':
      return [
        { x: a + ox, y: -b * 0.32 },
        { x: a + ox, y: b * 0.32 },
        { x: a * 0.15 + ox, y: b },
        { x: -a + ox, y: b * 0.9 },
        { x: -a + ox, y: -b * 0.9 },
        { x: a * 0.15 + ox, y: -b },
      ];
    case 'small':
      return [
        { x: a + ox, y: -fw },
        { x: a + ox, y: fw },
        { x: a * 0.1 + ox, y: b },
        { x: -a * 0.75 + ox, y: b },
        { x: -a + ox, y: b * 0.4 },
        { x: -a + ox, y: -b * 0.4 },
        { x: -a * 0.75 + ox, y: -b },
        { x: a * 0.1 + ox, y: -b },
      ];
    case 'casemate': {
      const f = (t.frontW ?? 0.9) * b;
      return [
        { x: a, y: -f + 0.1 },
        { x: a, y: f - 0.1 },
        { x: a - 0.45, y: b },
        { x: -a, y: b },
        { x: -a, y: -b },
        { x: a - 0.45, y: -b },
      ];
    }
  }
}

/** Insert vertices where front-half edges cross the given y values (used to isolate the mantlet). */
function splitAtY(poly: V2[], ys: number[], minX: number): V2[] {
  let pts = poly;
  for (const yc of ys) {
    const out: V2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      out.push(p);
      if ((p.y - yc) * (q.y - yc) < 0) {
        const t = (yc - p.y) / (q.y - p.y);
        const x = p.x + (q.x - p.x) * t;
        if (x > minX) out.push({ x, y: yc });
      }
    }
    pts = out;
  }
  return pts;
}

function edgesOf(poly: V2[], classify: (mid: V2, n: V2) => { key: PlateKey; zone: Zone }): ArmorEdge[] {
  let cx = 0;
  let cy = 0;
  for (const p of poly) {
    cx += p.x;
    cy += p.y;
  }
  cx /= poly.length;
  cy /= poly.length;
  const edges: ArmorEdge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    let nx = -(b.y - a.y);
    let ny = b.x - a.x;
    const l = Math.hypot(nx, ny);
    if (l < 1e-6) continue;
    nx /= l;
    ny /= l;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const n = { x: nx, y: ny };
    edges.push({ a, b, n, ...classify({ x: mx, y: my }, n) });
  }
  return edges;
}

function zoneOfNormal(n: V2, frontDeg = 55, rearDeg = 125): Zone {
  const ang = Math.abs(Math.atan2(n.y, n.x)) * (180 / Math.PI);
  if (ang <= frontDeg) return 'front';
  if (ang >= rearDeg) return 'rear';
  return 'side';
}

function rect(x0: number, y0: number, x1: number, y1: number): Shape {
  return { t: 'rect', x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

function build(spec: VehicleSpec): Blueprint {
  const lk = spec.look;
  const L = lk.L;
  const W = lk.W;
  const hl = L / 2;
  const hw = W / 2;
  const c = lk.chamfer;
  const rc = lk.rearChamfer;

  // ---- hull outline ---------------------------------------------------
  let hullPoly: V2[];
  if (lk.nose === 'pike') {
    hullPoly = [
      { x: hl, y: -hw * 0.3 },
      { x: hl, y: hw * 0.3 },
      { x: hl - c * 1.6, y: hw },
      { x: -hl + rc, y: hw },
      { x: -hl, y: hw * 0.55 },
      { x: -hl, y: -hw * 0.55 },
      { x: -hl + rc, y: -hw },
      { x: hl - c * 1.6, y: -hw },
    ];
  } else {
    hullPoly = [
      { x: hl, y: -(hw - c) },
      { x: hl, y: hw - c },
      { x: hl - c, y: hw },
      { x: -hl + rc, y: hw },
      { x: -hl, y: hw - rc },
      { x: -hl, y: -(hw - rc) },
      { x: -hl + rc, y: -hw },
      { x: hl - c, y: -hw },
    ];
  }
  hullPoly = dedupe(hullPoly);
  const hullEdges = edgesOf(hullPoly, (_m, n) => {
    const zone = zoneOfNormal(n);
    return { zone, key: zone === 'front' ? 'ufp' : zone === 'side' ? 'side' : 'rear' };
  });

  // ---- turret / casemate --------------------------------------------
  const tl = lk.turret;
  const casemate = tl.shape === 'casemate';
  let tp = turretPolygon(spec);
  const frontX = Math.max(...tp.map((p) => p.x));
  const backX = Math.min(...tp.map((p) => p.x));
  const mw = lk.mantletW / 2;
  tp = splitAtY(tp, [-mw, mw], (frontX + backX) / 2);
  const turretEdges = edgesOf(tp, (m, n) => {
    const zone = zoneOfNormal(n, 50, 130);
    let key: PlateKey = zone === 'front' ? 'tFront' : zone === 'side' ? 'tSide' : 'tRear';
    if (zone === 'front' && Math.abs(m.y) < mw + 0.01 && m.x > frontX - 0.6) key = 'mantlet';
    return { zone, key };
  });

  const gunPivot: V2 = casemate ? { x: tl.gunPivot ?? frontX - 0.3, y: 0 } : { x: 0, y: 0 };
  const barrelStart = casemate ? frontX - gunPivot.x + lk.mantletL * 0.4 : frontX + lk.mantletL * 0.4;
  const muzzle = barrelStart + lk.gunLen;

  // ---- modules ---------------------------------------------------------
  const lay = spec.layout;
  const hi = hw - lk.trackW; // inner half width
  const mods: ModuleDef[] = [];
  let idn = 0;
  const add = (m: Omit<ModuleDef, 'id'>) => mods.push({ ...m, id: `${m.kind}${idn++}` });

  // tracks / wheels
  const trackLabel = lk.wheels ? 'WHL' : 'TRK';
  add({ kind: 'track', label: trackLabel, frame: 'hull', shape: rect(-hl + 0.25, -hw, hl - 0.25, -hi), maxHp: 80, side: -1 });
  add({ kind: 'track', label: trackLabel, frame: 'hull', shape: rect(-hl + 0.25, hi, hl - 0.25, hw), maxHp: 80, side: 1 });

  // engine + transmission
  const eL = lay.engineLen;
  let engX0: number;
  if (lay.trans === 'rear') {
    add({ kind: 'transmission', label: 'TRANS', frame: 'hull', shape: rect(-hl + 0.22, -hi * 0.6, -hl + 0.82, hi * 0.6), maxHp: 100 });
    engX0 = -hl + 0.88;
  } else {
    add({ kind: 'transmission', label: 'TRANS', frame: 'hull', shape: rect(hl - 1.25, -hi * 0.3, hl - 0.28, hi * 0.3), maxHp: 100 });
    engX0 = -hl + 0.28;
  }
  const engX1 = engX0 + eL;
  add({ kind: 'engine', label: 'ENG', frame: 'hull', shape: rect(engX0, -hi * 0.58, engX1, hi * 0.58), maxHp: 120 });

  // fuel
  const fighting0 = engX1 + 0.12; // front of engine bay = rear of fighting compartment
  switch (lay.fuel) {
    case 'rear':
      add({ kind: 'fuel', label: 'FUEL', frame: 'hull', shape: rect(engX0 + 0.1, -hi * 0.95, engX1 - 0.1, -hi * 0.66), maxHp: 80 });
      add({ kind: 'fuel', label: 'FUEL', frame: 'hull', shape: rect(engX0 + 0.1, hi * 0.66, engX1 - 0.1, hi * 0.95), maxHp: 80 });
      break;
    case 'sides':
      add({ kind: 'fuel', label: 'FUEL', frame: 'hull', shape: rect(fighting0 + 0.1, -hi * 0.98, fighting0 + 1.6, -hi * 0.78), maxHp: 80 });
      add({ kind: 'fuel', label: 'FUEL', frame: 'hull', shape: rect(fighting0 + 0.1, hi * 0.78, fighting0 + 1.6, hi * 0.98), maxHp: 80 });
      add({ kind: 'fuel', label: 'FUEL', frame: 'hull', shape: rect(engX0 + 0.1, hi * 0.66, engX1 - 0.2, hi * 0.95), maxHp: 80 });
      break;
    case 'mid':
      add({ kind: 'fuel', label: 'FUEL', frame: 'hull', shape: rect(fighting0, -hi * 0.55, fighting0 + 0.65, hi * 0.55), maxHp: 80 });
      break;
    case 'front':
      add({ kind: 'fuel', label: 'FUEL', frame: 'hull', shape: rect(hl - 1.55, hi * 0.15, hl - 0.4, hi * 0.92), maxHp: 80 });
      add({ kind: 'fuel', label: 'FUEL', frame: 'hull', shape: rect(engX0 + 0.1, -hi * 0.95, engX1 - 0.15, -hi * 0.68), maxHp: 80 });
      break;
  }

  // ammo racks
  const tx = tl.x;
  for (const a of lay.ammo) {
    switch (a) {
      case 'sponson':
        add({ kind: 'ammo', label: 'AMMO', frame: 'hull', shape: rect(tx - 0.95, -hi * 0.98, tx + 0.45, -hi * 0.72), maxHp: 80 });
        add({ kind: 'ammo', label: 'AMMO', frame: 'hull', shape: rect(tx - 0.95, hi * 0.72, tx + 0.45, hi * 0.98), maxHp: 80 });
        break;
      case 'floor':
        add({ kind: 'ammo', label: 'AMMO', frame: 'hull', shape: rect(tx - 0.75, -0.42, tx + 0.15, 0.42), maxHp: 80 });
        break;
      case 'front':
        add({ kind: 'ammo', label: 'AMMO', frame: 'hull', shape: rect(hl - 1.35, -hi * 0.05, hl - 0.55, hi * 0.12), maxHp: 80 });
        break;
      case 'rear':
        add({ kind: 'ammo', label: 'AMMO', frame: 'hull', shape: rect(fighting0 + 0.05, -hi * 0.5, fighting0 + 0.45, hi * 0.5), maxHp: 80 });
        break;
      case 'casemate': {
        const r0 = tx - tl.len / 2 + 0.15;
        add({ kind: 'ammo', label: 'AMMO', frame: 'hull', shape: rect(r0, -hi * 0.95, r0 + 0.9, -hi * 0.6), maxHp: 80 });
        add({ kind: 'ammo', label: 'AMMO', frame: 'hull', shape: rect(r0, hi * 0.6, r0 + 0.9, hi * 0.95), maxHp: 80 });
        break;
      }
      case 'bustle':
        add({ kind: 'ammo', label: 'AMMO', frame: 'turret', shape: rect(backX + 0.12, -tl.wid * 0.28, backX + 0.55, tl.wid * 0.28), maxHp: 80 });
        break;
      case 'turretSides':
        add({ kind: 'ammo', label: 'AMMO', frame: 'turret', shape: rect(backX + 0.35, tl.wid * 0.22, backX + 0.9, tl.wid * 0.4), maxHp: 80 });
        break;
    }
  }

  // breech
  const cal = spec.gun.caliber;
  const bl = 0.7 + cal / 160;
  const bw = 0.2 + cal / 420;
  const brX1 = casemate ? gunPivot.x - 0.05 : frontX - lk.mantletL * 0.3;
  add({ kind: 'breech', label: 'BRCH', frame: 'turret', shape: rect(brX1 - bl, -bw, brX1, bw), maxHp: 110 });
  // barrel (gun frame — origin at gun pivot, x along barrel)
  add({ kind: 'barrel', label: 'GUN', frame: 'gun', shape: rect(barrelStart, -lk.gunW * 0.7, muzzle, lk.gunW * 0.7), maxHp: 60 });

  // crew
  const CR = 0.27;
  const roles = spec.crew;
  const hasR = roles.includes('R');
  let lCount = 0;
  for (const role of roles) {
    let frame: Frame = 'hull';
    let x = 0;
    let y = 0;
    if (role === 'D') {
      x = hl - (lay.trans === 'front' ? 1.15 : 1.0);
      y = hasR ? -hi * 0.55 : -hi * 0.18;
      if (lk.nose === 'pike') x = hl - 1.45;
    } else if (role === 'R') {
      x = hl - (lay.trans === 'front' ? 1.15 : 1.0);
      y = hi * 0.55;
      if (lk.nose === 'pike') {
        x = -hl + 1.0; // rear driver of the Puma
        y = 0;
      }
    } else if (casemate) {
      frame = 'turret';
      const gp = gunPivot.x;
      if (role === 'G') {
        x = gp - 0.65;
        y = -0.6;
      } else if (role === 'C') {
        x = tl.cupola.x;
        y = tl.cupola.y * 0.85;
      } else {
        x = gp - 1.05 - lCount * 0.62;
        y = 0.62 - lCount * 0.05;
        if (lCount === 0 && Math.abs(tl.cupola.y - y) < 0.4 && Math.abs(tl.cupola.x - x) < 0.5) y = -0.05;
        lCount++;
      }
    } else {
      frame = 'turret';
      const fx = frontX;
      const tw = tl.wid / 2;
      const cside = tl.cupola.r > 0 && Math.abs(tl.cupola.y) > 0.15 ? Math.sign(tl.cupola.y) : -1;
      if (role === 'G') {
        x = fx - 0.72;
        y = cside * tw * 0.5;
      } else if (role === 'C') {
        if (tl.cupola.r > 0) {
          x = tl.cupola.x * 0.92;
          y = tl.cupola.y * 0.85;
        } else {
          x = fx - 1.4;
          y = -tw * 0.45;
        }
      } else {
        x = fx - 0.95 - lCount * 0.6;
        y = -cside * tw * 0.48;
        lCount++;
      }
    }
    add({ kind: 'crew', label: role, frame, shape: { t: 'circle', x, y, r: CR }, maxHp: 100, role });
  }

  const radius = Math.hypot(hl, hw);
  return {
    spec,
    L,
    W,
    hullPoly,
    hullEdges,
    turretPoly: tp,
    turretEdges,
    turretX: tl.x,
    casemate,
    gunPivot,
    barrelStart,
    muzzle,
    modules: mods,
    radius,
    turretFrontX: frontX,
    turretBackX: backX,
  };
}
