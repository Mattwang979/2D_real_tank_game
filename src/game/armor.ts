// Ballistics: shell vs vehicle intersection, armor penetration, ricochet,
// spall/fragment simulation inside the vehicle and the resulting damage.

import { type V2, DEG, clamp, dirToLocal, dirToWorld, pointSegDist, rayCircle, rayRect, segSeg, toLocal, toWorld } from '../core/math';
import { rand } from '../core/rng';
import { penAt, type Plate, type ShellSpec, type ShellType } from '../data/vehicles';
import type { ArmorEdge, PlateKey } from './blueprint';
import type { ModState } from '../render/tankRender';
import type { Tank } from './tank';

export interface ArmorHit {
  t: number; // param along the tested segment (0..1)
  part: 'hull' | 'turret' | 'barrel';
  edge?: ArmorEdge;
  world: V2;
}

export interface Seg {
  a: V2; // hull-local
  b: V2;
  kind: 'core' | 'frag' | 'blast';
}

export interface ImpactResult {
  outcome: 'pen' | 'nonpen' | 'ricochet' | 'barrel' | 'wreck';
  plateKey?: PlateKey;
  partLabel: string;
  armor: number;
  angle: number; // deg total impact angle
  eff: number;
  pen: number;
  entry: V2; // hull-local
  dir: V2; // hull-local unit
  world: V2;
  segs: Seg[];
  blast?: { c: V2; r: number };
  states: Record<string, ModState>; // after
  prevStates: Record<string, ModState>;
  changed: string[]; // module ids whose state changed
  messages: string[];
  fire: boolean;
  cookoff: boolean;
  killed: boolean;
  reflect?: V2; // world dir for ricochets
  turretRel: number;
  gunRel: number;
  damage: number; // total damage points dealt
}

const RIC: Record<ShellType, number> = { AP: 70, APHE: 68, APCR: 63, HE: 80 };
const NORM: Record<ShellType, number> = { AP: 5, APHE: 4, APCR: 2, HE: 0 };

const PART_LABEL: Record<PlateKey, string> = {
  ufp: 'Upper front plate',
  lfp: 'Lower front plate',
  side: 'Hull side',
  rear: 'Hull rear',
  tFront: 'Turret front',
  tSide: 'Turret side',
  tRear: 'Turret rear',
  mantlet: 'Gun mantlet',
};

function partLabel(t: Tank, key: PlateKey): string {
  if (t.bp.casemate) {
    if (key === 'tFront') return 'Superstructure front';
    if (key === 'tSide') return 'Superstructure side';
    if (key === 'tRear') return 'Superstructure rear';
  }
  return PART_LABEL[key];
}

/** First intersection of segment p0→p1 with the given polygon edges (entering only). */
function edgeHit(edges: ArmorEdge[], q0: V2, q1: V2): { t: number; edge: ArmorEdge } | null {
  const dx = q1.x - q0.x;
  const dy = q1.y - q0.y;
  let best: { t: number; edge: ArmorEdge } | null = null;
  for (const e of edges) {
    if (dx * e.n.x + dy * e.n.y >= 0) continue;
    const r = segSeg(q0, q1, e.a, e.b);
    if (r && (!best || r.t < best.t)) best = { t: r.t, edge: e };
  }
  return best;
}

export function reachOf(t: Tank): number {
  return Math.max(t.bp.radius, Math.abs(t.bp.turretX) + t.bp.gunPivot.x + t.bp.muzzle) + 0.4;
}

/**
 * Geometric test of a shell segment against a tank.
 * heightRoll in [0,1): <0.8 means a shot crossing the turret hits the turret (it flies at turret height).
 */
export function intersectTank(t: Tank, p0: V2, p1: V2, heightRoll: number, barrelRoll: number, ignoreBarrel: boolean): ArmorHit | null {
  if (pointSegDist(t.pos, p0, p1) > reachOf(t)) return null;
  // hull
  const h0 = toLocal(p0, t.pos, t.ang);
  const h1 = toLocal(p1, t.pos, t.ang);
  const hullHit = edgeHit(t.bp.hullEdges, h0, h1);
  // 2.5D: every shell flies at a random height. Below the hull roof it strikes the hull,
  // above it the shell passes over the hull and can only strike the turret / superstructure.
  const highShot = heightRoll < t.bp.turretShare;
  // turret (not present after a cook-off blew it away)
  let turHit: { t: number; edge: ArmorEdge } | null = null;
  if (!t.turretOff) {
    const tp = t.turretPos();
    const ta = t.turretWorldAng;
    turHit = edgeHit(t.bp.turretEdges, toLocal(p0, tp, ta), toLocal(p1, tp, ta));
    if (!turHit && hullHit && highShot) {
      // a high shell that is over the hull already may reach the turret just past the end of this step
      const L = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
      const k = 1 + (2 * reachOf(t)) / L;
      const pe = { x: p0.x + (p1.x - p0.x) * k, y: p0.y + (p1.y - p0.y) * k };
      const ext = edgeHit(t.bp.turretEdges, toLocal(p0, tp, ta), toLocal(pe, tp, ta));
      if (ext) turHit = { t: ext.t * k, edge: ext.edge };
    }
  }
  let chosen: ArmorHit | null = null;
  if (turHit && (highShot || !hullHit)) chosen = { t: turHit.t, part: 'turret', edge: turHit.edge, world: lerpP(p0, p1, turHit.t) };
  else if (hullHit) chosen = { t: hullHit.t, part: 'hull', edge: hullHit.edge, world: lerpP(p0, p1, hullHit.t) };

  if (!ignoreBarrel && !t.turretOff) {
    const gp = t.gunPivot();
    const ga = t.gunWorldAng;
    const g0 = toLocal(p0, gp, ga);
    const g1 = toLocal(p1, gp, ga);
    const bm = t.mods.find((m) => m.def.kind === 'barrel');
    if (bm && bm.def.shape.t === 'rect') {
      const s = bm.def.shape;
      const r = rayRect(g0.x, g0.y, g1.x - g0.x, g1.y - g0.y, s.x0, s.y0 - 0.05, s.x1, s.y1 + 0.05);
      if (r && r[0] >= 0 && r[0] <= 1 && barrelRoll < 0.25 && (!chosen || r[0] < chosen.t)) {
        chosen = { t: r[0], part: 'barrel', world: lerpP(p0, p1, r[0]) };
      }
    }
  }
  return chosen;
}

function lerpP(a: V2, b: V2, t: number): V2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function plateFor(t: Tank, key: PlateKey): Plate {
  return t.spec.armor[key];
}

/** Effective thickness / impact angle for a plate given horizontal cos. */
function effective(plate: Plate, cosH: number, shell: ShellSpec, extraNorm = 0) {
  const cosV = Math.cos(plate.s * DEG);
  const cosT = clamp(cosH * cosV, 0.02, 1);
  let ang = Math.acos(cosT) / DEG;
  let norm = NORM[shell.type] + extraNorm;
  const overmatch = shell.caliber > plate.t * 2.6;
  if (overmatch) norm += 6;
  const angN = Math.max(0, ang - norm);
  const eff = plate.t / Math.max(0.08, Math.cos(angN * DEG));
  ang = Math.round(ang);
  return { ang, angN, eff, overmatch };
}

export interface Prediction {
  /** 'cover': only the hull is in the line of fire and an earthwork shields it (hull-down) */
  outcome: 'pen' | 'maybe' | 'no' | 'ricochet' | 'none' | 'cover';
  eff: number;
  pen: number;
  label: string;
}

/** Outcome of a shell striking one armor edge at horizontal cosine `cosH` from `dist` metres. */
function judgeEdge(target: Tank, shell: ShellSpec, edge: ArmorEdge, part: 'hull' | 'turret', cosH: number, dist: number): Prediction {
  const plate = plateFor(target, edge.key);
  const e = effective(plate, cosH, shell);
  let pen = penAt(shell, dist);
  if (part === 'hull' && edge.zone === 'side') pen -= trackAbsorb(target, cosH, shell);
  const label = partLabel(target, edge.key);
  if (shell.type === 'HE') {
    const cbrtE = Math.cbrt(Math.max(1, shell.explosive));
    if (pen >= e.eff || target.spec.armor.openTop || plate.t < cbrtE * 1.15) return { outcome: 'pen', eff: e.eff, pen, label };
    return { outcome: 'no', eff: e.eff, pen, label };
  }
  if (!e.overmatch && e.angN > RIC[shell.type]) return { outcome: 'ricochet', eff: e.eff, pen, label };
  if (pen >= e.eff * 1.08) return { outcome: 'pen', eff: e.eff, pen, label };
  if (pen >= e.eff * 0.9) return { outcome: 'maybe', eff: e.eff, pen, label };
  return { outcome: 'no', eff: e.eff, pen, label };
}

/** Evaluate one part (hull or turret) for the predictor. */
function predictPart(target: Tank, shell: ShellSpec, from: V2, dir: V2, part: 'hull' | 'turret'): Prediction | null {
  const far = { x: from.x + dir.x * 2500, y: from.y + dir.y * 2500 };
  const hit = intersectTank(target, from, far, part === 'turret' ? 0 : 0.999, 1, true);
  if (!hit || !hit.edge || hit.part !== part) return null;
  const dist = hit.t * 2500;
  const frameAng = hit.part === 'turret' ? target.turretWorldAng : target.ang;
  const dl = dirToLocal(dir, frameAng);
  const cosH = -(dl.x * hit.edge.n.x + dl.y * hit.edge.n.y);
  return judgeEdge(target, shell, hit.edge, part, cosH, dist);
}

export interface PlateView {
  a: V2; // world
  b: V2;
  n: V2; // world outward normal
  outcome: Prediction['outcome'];
  part: 'hull' | 'turret';
}

/**
 * Weak-spot map: for every armor edge facing `from`, the expected result of a hit there with `shell`.
 * Used by the aim overlay (green = penetrates, yellow = maybe, red = bounces / stopped).
 */
export function plateMap(target: Tank, shell: ShellSpec, from: V2, hullCovered = false): PlateView[] {
  const out: PlateView[] = [];
  const frames: Array<{ edges: ArmorEdge[]; pos: V2; ang: number; part: 'hull' | 'turret' }> = [{ edges: target.bp.hullEdges, pos: target.pos, ang: target.ang, part: 'hull' }];
  if (!target.turretOff) frames.push({ edges: target.bp.turretEdges, pos: target.turretPos(), ang: target.turretWorldAng, part: 'turret' });
  for (const f of frames) {
    for (const e of f.edges) {
      const a = toWorld(e.a, f.pos, f.ang);
      const b = toWorld(e.b, f.pos, f.ang);
      const mx = (a.x + b.x) / 2 - from.x;
      const my = (a.y + b.y) / 2 - from.y;
      const d = Math.hypot(mx, my) || 1;
      const dl = dirToLocal({ x: mx / d, y: my / d }, f.ang);
      const cosH = -(dl.x * e.n.x + dl.y * e.n.y);
      if (cosH <= 0.03) continue; // facing away from the shooter
      const outcome = hullCovered && f.part === 'hull' ? 'cover' : judgeEdge(target, shell, e, f.part, cosH, d).outcome;
      out.push({ a, b, n: dirToWorld(e.n, f.ang), outcome, part: f.part });
    }
  }
  return out;
}

const RANK: Record<Prediction['outcome'], number> = { pen: 3, maybe: 2, no: 1, ricochet: 0, cover: -0.5, none: -1 };

/**
 * Deterministic prediction used for the aim reticle and AI weak-spot selection.
 * When the line crosses both hull and turret, the more likely hull result is reported
 * unless the turret result is worse (so a green reticle means both will penetrate).
 */
export function predictShot(shooter: Tank, target: Tank, shell: ShellSpec, from: V2, dir: V2, hullCovered = false): Prediction {
  void shooter;
  let hull = predictPart(target, shell, from, dir, 'hull');
  const tur = predictPart(target, shell, from, dir, 'turret');
  if (hull && hullCovered) {
    // hull-down: shells at hull height bury themselves in the earthwork
    if (!tur) return { outcome: 'cover', eff: 0, pen: hull.pen, label: 'Hull-down' };
    hull = null;
  }
  if (!hull && !tur) return { outcome: 'none', eff: 0, pen: 0, label: '' };
  if (!hull) return tur!;
  if (!tur) return hull;
  const hp = RANK[hull.outcome] >= 2;
  const tp = RANK[tur.outcome] >= 2;
  if (hp && tp) return RANK[tur.outcome] < RANK[hull.outcome] ? tur : hull;
  if (hp !== tp) return { ...(hp ? hull : tur), outcome: 'maybe' };
  return hull;
}

function trackAbsorb(t: Tank, cosH: number, shell: ShellSpec): number {
  let a = 14 / Math.max(0.3, cosH);
  const sk = t.spec.armor.skirts ?? 0;
  if (sk > 0) a += shell.type === 'APCR' ? sk * 5 : shell.type === 'HE' ? 20 : sk * 1.5;
  if (t.spec.look.wheels) a = 4;
  return a;
}

// --------------------------------------------------------------------------
// Internal damage

function snapshotStates(t: Tank): Record<string, ModState> {
  const out: Record<string, ModState> = {};
  for (const m of t.mods) out[m.def.id] = t.modState(m);
  return out;
}

/** Transform a hull-local ray into the frame of a module. */
function rayToFrame(t: Tank, frame: 'hull' | 'turret' | 'gun', o: V2, d: V2): { o: V2; d: V2 } {
  if (frame === 'hull') return { o, d };
  const tpos = { x: t.bp.turretX, y: 0 };
  let ol = toLocal(o, tpos, t.turretRel);
  let dl = dirToLocal(d, t.turretRel);
  if (frame === 'gun') {
    ol = toLocal(ol, t.bp.gunPivot, t.gunRel);
    dl = dirToLocal(dl, t.gunRel);
  }
  return { o: ol, d: dl };
}

const ABSORB: Record<string, number> = { engine: 0.3, transmission: 0.35, breech: 0.3, crew: 0.5, ammo: 0.55, fuel: 0.55, track: 0.7, barrel: 1 };

function castDamage(t: Tank, o: V2, d: V2, len: number, dmg: number, acc: Map<number, number>, coreHits?: Set<number>, core = false) {
  // firewall between fighting compartment and engine bay stops fragments (the core punches through, weakened)
  const bx = t.bp.bulkheadX;
  let wall = Infinity;
  if (Math.abs(d.x) > 1e-6 && (o.x - bx) * d.x < 0) wall = (bx - o.x) / d.x;
  if (!core) len = Math.min(len, wall);
  const items: Array<{ t: number; i: number }> = [];
  for (let i = 0; i < t.mods.length; i++) {
    const m = t.mods[i];
    // tracks and barrel sit outside the armour: interior spall cannot reach them
    if (m.def.kind === 'barrel' || m.def.kind === 'track') continue;
    if (t.turretOff && m.def.frame !== 'hull') continue;
    const r = rayToFrame(t, m.def.frame, o, d);
    const s = m.def.shape;
    const hit = s.t === 'rect' ? rayRect(r.o.x, r.o.y, r.d.x, r.d.y, s.x0, s.y0, s.x1, s.y1) : rayCircle(r.o.x, r.o.y, r.d.x, r.d.y, s.x, s.y, s.r);
    if (!hit) continue;
    const t0 = Math.max(0, hit[0]);
    if (t0 > len) continue;
    items.push({ t: t0, i });
  }
  items.sort((a, b) => a.t - b.t);
  let cur = dmg;
  let walled = false;
  for (const it of items) {
    if (!walled && it.t > wall) {
      cur *= 0.5;
      walled = true;
    }
    if (cur < 3) break;
    acc.set(it.i, (acc.get(it.i) ?? 0) + cur);
    coreHits?.add(it.i);
    cur *= ABSORB[t.mods[it.i].def.kind] ?? 0.6;
  }
}

function blastDamage(t: Tank, c: V2, r: number, dmg: number, acc: Map<number, number>) {
  const bx = t.bp.bulkheadX;
  for (let i = 0; i < t.mods.length; i++) {
    const m = t.mods[i];
    if (m.def.kind === 'barrel' || m.def.kind === 'track') continue;
    if (t.turretOff && m.def.frame !== 'hull') continue;
    const s = m.def.shape;
    // module centre in hull-local
    let cx: number;
    let cy: number;
    if (s.t === 'rect') {
      cx = (s.x0 + s.x1) / 2;
      cy = (s.y0 + s.y1) / 2;
    } else {
      cx = s.x;
      cy = s.y;
    }
    let p = { x: cx, y: cy };
    if (m.def.frame === 'turret') p = toWorld(p, { x: t.bp.turretX, y: 0 }, t.turretRel);
    const dd = Math.hypot(p.x - c.x, p.y - c.y);
    if (dd > r) continue;
    const across = (p.x - bx) * (c.x - bx) < 0 && m.def.frame === 'hull';
    const f = dd / r;
    acc.set(i, (acc.get(i) ?? 0) + dmg * (1 - f * f * 0.75) * (across ? 0.25 : 1));
  }
}

function hullExitDist(t: Tank, o: V2, d: V2): number {
  let best = 0;
  for (const e of t.bp.hullEdges) {
    if (d.x * e.n.x + d.y * e.n.y <= 0) continue;
    const far = { x: o.x + d.x * 20, y: o.y + d.y * 20 };
    const r = segSeg(o, far, e.a, e.b);
    if (r) best = Math.max(best, r.t * 20);
  }
  return best || 3;
}

const MOD_NAMES: Record<string, string> = {
  engine: 'Engine',
  transmission: 'Transmission',
  fuel: 'Fuel tank',
  ammo: 'Ammo rack',
  breech: 'Breech',
  barrel: 'Gun barrel',
  track: 'Track',
};
const CREW_NAMES: Record<string, string> = { D: 'Driver', R: 'Radio operator', G: 'Gunner', C: 'Commander', L: 'Loader' };

export function moduleName(t: Tank, idx: number): string {
  const m = t.mods[idx];
  if (m.def.kind === 'crew') return CREW_NAMES[m.role ?? m.def.label] ?? 'Crew';
  if (m.def.kind === 'track' && t.spec.look.wheels) return 'Wheels';
  return MOD_NAMES[m.def.kind] ?? m.def.label;
}

/**
 * Resolve a shell impact on a tank and apply the damage.
 */
export function resolveImpact(shooter: Tank | null, target: Tank, shell: ShellSpec, hit: ArmorHit, dist: number, dirW: V2, penScale = 1): ImpactResult {
  const prevStates = snapshotStates(target);
  const base: ImpactResult = {
    outcome: 'nonpen',
    partLabel: '',
    armor: 0,
    angle: 0,
    eff: 0,
    pen: 0,
    entry: toLocal(hit.world, target.pos, target.ang),
    dir: dirToLocal(dirW, target.ang),
    world: hit.world,
    segs: [],
    states: prevStates,
    prevStates,
    changed: [],
    messages: [],
    fire: false,
    cookoff: false,
    killed: false,
    turretRel: target.turretRel,
    gunRel: target.gunRel,
    damage: 0,
  };
  const acc = new Map<number, number>();
  let pen = penAt(shell, dist) * penScale * rand.range(0.95, 1.05);
  base.pen = Math.round(pen);

  if (!target.alive) {
    base.outcome = 'wreck';
    return base;
  }

  if (hit.part === 'barrel') {
    const bi = target.mods.findIndex((m) => m.def.kind === 'barrel');
    acc.set(bi, 25 + shell.caliber * 0.6);
    base.outcome = 'barrel';
    base.partLabel = 'Gun barrel';
    applyDamage(shooter, target, acc, base);
    return base;
  }

  const edge = hit.edge!;
  const frameAng = hit.part === 'turret' ? target.turretWorldAng : target.ang;
  const dl = dirToLocal(dirW, frameAng);
  const cosH = clamp(-(dl.x * edge.n.x + dl.y * edge.n.y), 0, 1);
  let key = edge.key;
  if (key === 'ufp' && rand.chance(0.25)) key = 'lfp';
  const plate = plateFor(target, key);
  const e = effective(plate, cosH, shell);
  base.plateKey = key;
  base.partLabel = partLabel(target, key);
  base.armor = plate.t;
  base.angle = e.ang;
  base.eff = Math.round(e.eff);

  // spaced: tracks/skirts on hull sides
  if (hit.part === 'hull' && edge.zone === 'side') {
    pen -= trackAbsorb(target, cosH, shell);
    const side = edge.n.y < 0 ? -1 : 1;
    const ti = target.mods.findIndex((m) => m.def.kind === 'track' && m.def.side === side);
    if (ti >= 0) acc.set(ti, 18 + shell.caliber * 0.45);
  }
  base.pen = Math.max(0, Math.round(pen));

  // ricochet?
  const ric = RIC[shell.type];
  if (!e.overmatch && shell.type !== 'HE') {
    const p = clamp((e.angN - (ric - 6)) / 12, 0, 1);
    if (rand.chance(p)) {
      base.outcome = 'ricochet';
      const nW = dirToWorld(edge.n, frameAng);
      const dot = dirW.x * nW.x + dirW.y * nW.y;
      base.reflect = { x: dirW.x - 2 * dot * nW.x, y: dirW.y - 2 * dot * nW.y };
      applyDamage(shooter, target, acc, base);
      return base;
    }
  }

  const entryH = base.entry;
  const dH = base.dir;
  const cbrtE = Math.cbrt(Math.max(1, shell.explosive));

  if (pen < e.eff) {
    base.outcome = 'nonpen';
    // HE overpressure on thin / open-topped vehicles
    if (shell.type === 'HE' && shell.explosive > 50) {
      const thin = plate.t < cbrtE * 1.15 || target.spec.armor.openTop;
      if (thin) {
        const c = { x: entryH.x + dH.x * 0.4, y: entryH.y + dH.y * 0.4 };
        const r = 0.6 + cbrtE * 0.16;
        blastDamage(target, c, r, (30 + cbrtE * 7) * (target.spec.armor.openTop ? 0.9 : 0.6), acc);
        base.blast = { c, r };
        base.outcome = 'pen';
        base.messages.push('Overpressure');
      }
      // external modules
      const extR = 0.8 + cbrtE * 0.12;
      for (let i = 0; i < target.mods.length; i++) {
        const m = target.mods[i];
        if (m.def.kind !== 'track') continue;
        const s = m.def.shape;
        if (s.t !== 'rect') continue;
        const cx = clamp(entryH.x, s.x0, s.x1);
        const cy = clamp(entryH.y, s.y0, s.y1);
        if (Math.hypot(cx - entryH.x, cy - entryH.y) < extR) acc.set(i, (acc.get(i) ?? 0) + 20 + cbrtE * 3.5);
      }
    }
    applyDamage(shooter, target, acc, base);
    return base;
  }

  // ---------------- penetration
  base.outcome = 'pen';
  const R = pen - e.eff;
  const cal = shell.caliber;
  const exitD = hullExitDist(target, entryH, dH);
  const coreDmg = 60 + cal * 1.2;
  const fragDmg = 16 + cal * 0.2;
  const coreHits = new Set<number>();

  let coreLen: number;
  if (shell.type === 'HE') coreLen = 0.25;
  else if (shell.type === 'APHE') coreLen = Math.min(exitD - 0.05, rand.range(0.8, 1.5) * (R > 10 ? 1 : 0.5));
  else coreLen = Math.min(exitD, 1.5 + R / 22);
  coreLen = Math.max(0.15, coreLen);
  castDamage(target, entryH, dH, coreLen, shell.type === 'HE' ? coreDmg * 0.4 : coreDmg, acc, coreHits, true);
  base.segs.push({ a: entryH, b: { x: entryH.x + dH.x * coreLen, y: entryH.y + dH.y * coreLen }, kind: 'core' });

  // spall cone
  let nFrag = 0;
  let half = 16 * DEG;
  let fl = 1.4 + R / 70;
  if (shell.type === 'AP') nFrag = Math.round(clamp(8 + cal / 10 + R / 10, 8, 28));
  else if (shell.type === 'APHE') nFrag = Math.round(clamp(5 + cal / 20, 5, 12));
  else if (shell.type === 'APCR') {
    nFrag = Math.round(clamp(4 + R / 18, 4, 12));
    half = 9 * DEG;
    fl = 1.0 + R / 90;
  }
  const baseAng = Math.atan2(dH.y, dH.x);
  for (let i = 0; i < nFrag; i++) {
    const a = baseAng + rand.gauss() * half * 0.55;
    const d = { x: Math.cos(a), y: Math.sin(a) };
    const l = Math.min(4.2, fl * rand.range(0.55, 1.15));
    castDamage(target, entryH, d, l, fragDmg, acc);
    base.segs.push({ a: entryH, b: { x: entryH.x + d.x * l, y: entryH.y + d.y * l }, kind: 'frag' });
  }

  // explosive filler — bigger shells throw more, heavier fragments over a larger radius
  if ((shell.type === 'APHE' || shell.type === 'HE') && shell.explosive > 0) {
    const c = { x: entryH.x + dH.x * coreLen, y: entryH.y + dH.y * coreLen };
    const n = Math.round(clamp(10 + shell.explosive / 5 + cal / 5, 14, 70));
    const len0 = 0.6 + cbrtE * 0.18 + cal / 250;
    const fd = 24 + cbrtE * 2 + cal * 0.08;
    for (let i = 0; i < n; i++) {
      const a = rand.range(0, Math.PI * 2);
      const d = { x: Math.cos(a) * 0.6 + dH.x * 0.4, y: Math.sin(a) * 0.6 + dH.y * 0.4 };
      const dl2 = Math.hypot(d.x, d.y);
      d.x /= dl2;
      d.y /= dl2;
      const l = len0 * rand.range(0.5, 1.15);
      castDamage(target, c, d, l, fd, acc);
      base.segs.push({ a: c, b: { x: c.x + d.x * l, y: c.y + d.y * l }, kind: 'blast' });
    }
    const r = 0.4 + cbrtE * 0.17 + cal / 220;
    blastDamage(target, c, r, 30 + cbrtE * 10 + cal * 0.25, acc);
    base.blast = { c, r };
  }

  applyDamage(shooter, target, acc, base);
  return base;
}

/**
 * A heavy shell landing on top of a vehicle (artillery): the thin roof gives way and the
 * blast and fragments sweep the inside.
 */
export function topHit(shooter: Tank | null, target: Tank, at: V2, shell: ShellSpec): ImpactResult {
  const prevStates = snapshotStates(target);
  const entry = toLocal(at, target.pos, target.ang);
  const res: ImpactResult = {
    outcome: 'pen',
    partLabel: 'Roof',
    armor: Math.round(Math.max(12, target.spec.armor.rear.t * 0.5)),
    angle: 0,
    eff: Math.round(Math.max(12, target.spec.armor.rear.t * 0.5)),
    pen: Math.round(shell.pen[0]),
    entry,
    dir: { x: entry.x >= 0 ? -1 : 1, y: 0 },
    world: { ...at },
    segs: [],
    states: prevStates,
    prevStates,
    changed: [],
    messages: ['Direct artillery hit'],
    fire: false,
    cookoff: false,
    killed: false,
    turretRel: target.turretRel,
    gunRel: target.gunRel,
    damage: 0,
  };
  if (!target.alive) {
    res.outcome = 'wreck';
    return res;
  }
  const acc = new Map<number, number>();
  const cbrtE = Math.cbrt(Math.max(1, shell.explosive));
  const r = 1.1 + cbrtE * 0.11;
  blastDamage(target, entry, r, 55 + cbrtE * 8, acc);
  res.blast = { c: entry, r };
  const n = 28;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand.range(-0.1, 0.1);
    const d = { x: Math.cos(a), y: Math.sin(a) };
    const l = rand.range(1.0, 2.6);
    castDamage(target, entry, d, l, 26 + cbrtE * 1.4, acc);
    res.segs.push({ a: entry, b: { x: entry.x + d.x * l, y: entry.y + d.y * l }, kind: 'blast' });
  }
  // running gear under the blast
  for (let i = 0; i < target.mods.length; i++) {
    const m = target.mods[i];
    if (m.def.kind !== 'track' || m.def.shape.t !== 'rect') continue;
    const sh = m.def.shape;
    const cx = clamp(entry.x, sh.x0, sh.x1);
    const cy = clamp(entry.y, sh.y0, sh.y1);
    if (Math.hypot(cx - entry.x, cy - entry.y) < 1.8) acc.set(i, (acc.get(i) ?? 0) + 40 + cbrtE * 3);
  }
  applyDamage(shooter, target, acc, res);
  return res;
}

function applyDamage(shooter: Tank | null, target: Tank, acc: Map<number, number>, res: ImpactResult) {
  let total = 0;
  const msgs = res.messages;
  let ammoDestroyed = 0;
  let ammoHeavy = false;
  let ammoTouched = false;
  for (const [i, dmg] of acc) {
    const m = target.mods[i];
    const before = m.hp;
    m.hp = Math.max(0, m.hp - dmg);
    total += before - m.hp;
    const k = m.def.kind;
    if (k === 'ammo') {
      ammoTouched = true;
      if (before > 0 && m.hp <= 0) ammoDestroyed++;
      else if (dmg >= 30) ammoHeavy = true;
    } else if (k === 'fuel') {
      const pFire = m.hp <= 0 ? 0.32 : 0.12;
      if (rand.chance(pFire)) {
        res.fire = true;
        setFireSource(target, m.def.shape);
      }
    } else if (k === 'engine') {
      if (rand.chance(m.hp <= 0 ? 0.16 : 0.05)) {
        res.fire = true;
        setFireSource(target, m.def.shape);
      }
    }
    if (before > 0 && m.hp <= 0) {
      msgs.push(k === 'crew' ? `${moduleName(target, i)} knocked out` : `${moduleName(target, i)} destroyed`);
    } else if (before >= m.def.maxHp * 0.55 && m.hp < m.def.maxHp * 0.55 && m.hp > 0) {
      msgs.push(k === 'crew' ? `${moduleName(target, i)} wounded` : `${moduleName(target, i)} damaged`);
    }
  }
  // one ammunition detonation roll per impact
  const pCook = ammoDestroyed > 0 ? Math.min(0.4, 0.2 + 0.08 * (ammoDestroyed - 1)) : ammoHeavy ? 0.08 : ammoTouched ? 0.02 : 0;
  if (pCook > 0 && rand.chance(pCook)) res.cookoff = true;
  res.damage = total;
  if (res.fire && target.burning <= 0) {
    target.burning = rand.range(9, 14);
    msgs.push('Fire!');
  }
  if (res.cookoff) msgs.unshift('Ammo detonation');
  if (shooter && total > 0) {
    target.damagers.set(shooter.id, performance.now() / 1000);
    target.lastHitBy = shooter;
  }
  if (total > 0) target.lastHitTime = performance.now() / 1000;
  if (res.cookoff || target.knockedOut()) res.killed = true;
  res.states = snapshotStates(target);
  res.changed = Object.keys(res.states).filter((k) => res.states[k] !== res.prevStates[k]);
}

function setFireSource(t: Tank, s: { t: 'rect'; x0: number; y0: number; x1: number; y1: number } | { t: 'circle'; x: number; y: number; r: number }) {
  if (s.t === 'rect') t.fireSource = { x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 };
  else t.fireSource = { x: s.x, y: s.y };
}

/** Fire damage tick (1 s). Returns true if it caused a cook-off. */
export function fireTick(t: Tank): { cookoff: boolean; killed: boolean } {
  for (const m of t.mods) {
    if (m.def.kind === 'crew' && m.hp > 0) m.hp = Math.max(0, m.hp - rand.range(2, 6));
  }
  const near = t.mods.filter((m) => {
    const s = m.def.shape;
    const c = s.t === 'rect' ? { x: (s.x0 + s.x1) / 2, y: (s.y0 + s.y1) / 2 } : { x: s.x, y: s.y };
    return m.def.frame === 'hull' && Math.hypot(c.x - t.fireSource.x, c.y - t.fireSource.y) < 1.6 && m.def.kind !== 'crew';
  });
  for (const m of near) m.hp = Math.max(0, m.hp - rand.range(4, 10));
  const ammoNear = near.some((m) => m.def.kind === 'ammo');
  const cookoff = rand.chance(ammoNear ? 0.06 : 0.012);
  return { cookoff, killed: cookoff || t.knockedOut() };
}
