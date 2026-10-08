// Tank entity: movement physics, turret/gun traverse, reload, module & crew state.

import { type V2, DEG, angNorm, approach, approachAngle, clamp, fromAngle, toWorld, angDiff } from '../core/math';
import { rand } from '../core/rng';
import type { CrewRole, VehicleSpec } from '../data/vehicles';
import { getBlueprint, type Blueprint, type ModuleDef, type ModuleKind } from './blueprint';
import type { ModState } from '../render/tankRender';

export interface ModuleRT {
  def: ModuleDef;
  hp: number;
  role?: CrewRole; // runtime role (crew can be reassigned)
  repair: number; // seconds left on repair, 0 = none
}

export const SPEED_SCALE = 1.0;

let NEXT_ID = 1;

export class Tank {
  id = NEXT_ID++;
  spec: VehicleSpec;
  bp: Blueprint;
  team: 0 | 1;
  isPlayer = false;
  name: string;

  pos: V2;
  ang: number;
  speed = 0; // m/s along heading (+forward)
  angVel = 0;
  turretRel = 0;
  gunRel = 0;
  aimAngle: number; // desired world gun angle

  throttle = 0;
  steer = 0;
  wantFire = false;

  shellIdx = 0; // currently loaded / selected
  nextShellIdx = 0;
  ammo: number[];
  reloadLeft = 0;
  bloom = 0;
  recoil = 0;

  alive = true;
  cookedOff = false;
  deathTime = 0;
  wreckFire = 0;
  wreckSmoke = 0;

  mods: ModuleRT[];
  burning = 0;
  fireSource: V2 = { x: 0, y: 0 }; // hull-local
  extinguishCd = 0;
  crewSwap = 0;
  pendingSwapRole: CrewRole | null = null;

  /** damage dealt to this tank by other tanks (id → time) for assists */
  damagers = new Map<number, number>();
  lastHitBy: Tank | null = null;

  spottedUntil = 0; // spotted by enemy team until (time)
  revealedUntil = 0; // forced reveal (fired gun)
  lastSeenPos: V2 | null = null;

  trackAcc = 0;
  hitFlash = 0;
  turretOff: { pos: V2; ang: number; vel: V2; spin: number; h: number; vh: number } | null = null;

  // stats
  kills = 0;
  assists = 0;
  hitsDealt = 0;

  constructor(spec: VehicleSpec, team: 0 | 1, pos: V2, ang: number, name: string) {
    this.spec = spec;
    this.bp = getBlueprint(spec);
    this.team = team;
    this.pos = { ...pos };
    this.ang = ang;
    this.aimAngle = ang;
    this.name = name;
    this.mods = this.bp.modules.map((def) => ({ def, hp: def.maxHp, role: def.role, repair: 0 }));
    this.ammo = spec.gun.shells.map((s) => s.count);
    this.reloadLeft = 1.2;
  }

  // ---------------------------------------------------------------- geometry
  get turretWorldAng(): number {
    return this.ang + this.turretRel;
  }
  get gunWorldAng(): number {
    return this.ang + this.turretRel + this.gunRel;
  }
  turretPos(): V2 {
    return toWorld({ x: this.bp.turretX, y: 0 }, this.pos, this.ang);
  }
  gunPivot(): V2 {
    return toWorld(this.bp.gunPivot, this.turretPos(), this.turretWorldAng);
  }
  muzzle(): V2 {
    return toWorld({ x: this.bp.muzzle, y: 0 }, this.gunPivot(), this.gunWorldAng);
  }
  forward(): V2 {
    return fromAngle(this.ang);
  }

  // ---------------------------------------------------------------- modules
  modState(m: ModuleRT): ModState {
    if (m.hp <= 0) return 'destroyed';
    if (m.hp < m.def.maxHp * 0.55) return 'damaged';
    return 'ok';
  }
  modsOf(kind: ModuleKind): ModuleRT[] {
    return this.mods.filter((m) => m.def.kind === kind);
  }
  crewAlive(): ModuleRT[] {
    return this.mods.filter((m) => m.def.kind === 'crew' && m.hp > 0);
  }
  hasRole(r: CrewRole): boolean {
    return this.mods.some((m) => m.def.kind === 'crew' && m.hp > 0 && m.role === r);
  }
  moduleOk(kind: ModuleKind): boolean {
    return this.modsOf(kind).every((m) => m.hp > 0);
  }
  enginePower(): number {
    const e = this.modsOf('engine')[0];
    if (!e || e.hp <= 0) return 0;
    return e.hp < e.def.maxHp * 0.55 ? 0.55 : 1;
  }
  canMove(): boolean {
    return this.alive && this.moduleOk('track') && this.moduleOk('transmission') && this.enginePower() > 0 && this.hasRole('D');
  }
  canFire(): boolean {
    return this.alive && this.moduleOk('breech') && this.moduleOk('barrel') && this.hasRole('G');
  }
  reloadTime(): number {
    let t = this.spec.gun.reload;
    const hasLoaderRole = this.spec.crew.includes('L');
    if (hasLoaderRole && !this.hasRole('L')) t *= 1.6;
    return t;
  }
  traverseRate(): number {
    let r = this.spec.traverse * DEG;
    if (!this.hasRole('G')) r *= 0.4;
    return r;
  }
  visionCone(): { range: number; half: number; near: number } {
    const cmd = this.hasRole('C') || !this.spec.crew.includes('C');
    return { range: cmd ? 230 : 165, half: 26 * DEG, near: 42 };
  }
  maxSpeed(): number {
    return (this.spec.speed / 3.6) * SPEED_SCALE;
  }

  dispersion(): number {
    const base = this.spec.gun.dispersion * DEG;
    const moving = Math.abs(this.speed) / Math.max(1, this.maxSpeed());
    const turning = Math.abs(this.angVel) * 0.6;
    return base * (1 + moving * 2.2 + turning + this.bloom);
  }

  // ---------------------------------------------------------------- update
  /** Integrate movement and turret. Collisions are resolved by the battle. */
  update(dt: number, now: number) {
    if (!this.alive) {
      this.speed = approach(this.speed, 0, 6 * dt);
      this.pos.x += Math.cos(this.ang) * this.speed * dt;
      this.pos.y += Math.sin(this.ang) * this.speed * dt;
      return;
    }
    const sp = this.spec;
    const mobile = this.canMove();
    const pw = sp.hp / sp.weight;
    const accel = clamp(0.19 * pw, 0.9, 3.4) * this.enginePower();
    const vmax = this.maxSpeed() * (this.enginePower() < 1 ? 0.6 : 1);
    const vrev = (sp.reverse / 3.6) * SPEED_SCALE;
    let target = 0;
    if (mobile) target = this.throttle >= 0 ? this.throttle * vmax : this.throttle * vrev;
    const braking = Math.sign(target) !== Math.sign(this.speed) && Math.abs(this.speed) > 0.1;
    this.speed = approach(this.speed, target, (braking || target === 0 ? 5.5 : accel) * dt);

    // turning
    let turnRate: number;
    if (sp.look.wheels) {
      const minR = 6.5;
      turnRate = Math.min(Math.abs(this.speed) / minR, 0.75) * Math.sign(this.speed || 1);
    } else {
      const base = clamp(16 + pw * 1.6, 22, 48) * DEG;
      turnRate = base * (1 - 0.4 * Math.min(1, Math.abs(this.speed) / Math.max(vmax, 1)));
      if (this.speed < -0.2) turnRate *= 1; // keep stick direction consistent while reversing
    }
    const targetAV = mobile ? this.steer * turnRate * (this.enginePower() > 0 ? 1 : 0) : 0;
    this.angVel = approach(this.angVel, targetAV, 3.5 * dt);
    this.ang = angNorm(this.ang + this.angVel * dt);
    this.pos.x += Math.cos(this.ang) * this.speed * dt;
    this.pos.y += Math.sin(this.ang) * this.speed * dt;

    // turret / gun traverse toward aim
    const rate = this.traverseRate() * dt;
    if (this.bp.casemate) {
      const arc = (sp.gunArc ?? 10) * DEG;
      const desiredRel = clamp(angDiff(this.ang, this.aimAngle), -arc, arc);
      this.gunRel = approach(this.gunRel, desiredRel, rate);
    } else {
      // turret follows hull rotation automatically (stabilised in world) then traverses
      const desiredRel = angDiff(this.ang, this.aimAngle);
      this.turretRel = angNorm(approachAngle(this.turretRel, desiredRel, rate));
    }

    // reload
    if (this.reloadLeft > 0 && this.canFire()) {
      this.reloadLeft -= dt;
    }
    this.bloom = Math.max(0, this.bloom - dt * 1.2);
    this.recoil = Math.max(0, this.recoil - dt * 3.5);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    if (this.extinguishCd > 0) this.extinguishCd -= dt;

    this.updateCrew(dt);
    this.updateRepairs(dt);
    void now;
  }

  /** Remaining traverse error between gun and aim (radians). */
  aimError(): number {
    return Math.abs(angDiff(this.gunWorldAng, this.aimAngle));
  }

  isReloaded(): boolean {
    return this.reloadLeft <= 0;
  }

  selectShell(i: number) {
    if (i < 0 || i >= this.spec.gun.shells.length || this.ammo[i] <= 0) return;
    if (i === this.shellIdx) return;
    this.nextShellIdx = i;
    // switching ammo requires unloading the current round
    this.shellIdx = i;
    this.reloadLeft = this.reloadTime();
  }

  /** Consume a round. Returns shell index fired or -1. */
  fire(): number {
    if (!this.canFire() || !this.isReloaded()) return -1;
    let idx = this.shellIdx;
    if (this.ammo[idx] <= 0) {
      idx = this.ammo.findIndex((a) => a > 0);
      if (idx < 0) return -1;
      this.shellIdx = idx;
    }
    this.ammo[idx]--;
    if (this.ammo[idx] <= 0) {
      const n = this.ammo.findIndex((a) => a > 0);
      if (n >= 0) this.shellIdx = n;
    }
    this.reloadLeft = this.reloadTime();
    this.bloom = 1.2;
    this.recoil = 1;
    return idx;
  }

  private updateCrew(dt: number) {
    // crew substitution: fill critical empty seats from spare crew
    const need: CrewRole[] = [];
    for (const r of ['G', 'D', 'L'] as CrewRole[]) {
      if (this.spec.crew.includes(r) && !this.hasRole(r)) need.push(r);
    }
    if (need.length === 0) {
      this.pendingSwapRole = null;
      this.crewSwap = 0;
      return;
    }
    const role = need[0];
    // donors: R first, then extra loaders, then commander (when gunner/driver needed)
    const alive = this.crewAlive();
    const counts: Record<string, number> = {};
    for (const c of alive) counts[c.role!] = (counts[c.role!] ?? 0) + 1;
    const donor =
      alive.find((c) => c.role === 'R') ??
      (counts.L > 1 ? alive.find((c) => c.role === 'L') : undefined) ??
      (role !== 'L' ? alive.find((c) => c.role === 'L') : undefined) ??
      (role !== 'L' && alive.length > 2 ? alive.find((c) => c.role === 'C') : undefined);
    if (!donor) return;
    if (this.pendingSwapRole !== role) {
      this.pendingSwapRole = role;
      this.crewSwap = 5;
    }
    this.crewSwap -= dt;
    if (this.crewSwap <= 0) {
      donor.role = role;
      this.pendingSwapRole = null;
    }
  }

  private updateRepairs(dt: number) {
    if (this.burning > 0) return;
    if (this.crewAlive().length < 2) return;
    for (const m of this.mods) {
      const k = m.def.kind;
      if (k === 'crew' || k === 'ammo' || k === 'fuel') continue;
      if (m.hp <= 0) {
        if (m.repair <= 0) m.repair = k === 'track' ? 9 : k === 'engine' ? 16 : k === 'transmission' ? 14 : 10;
        m.repair -= dt;
        if (m.repair <= 0) {
          m.hp = m.def.maxHp * 0.5;
          m.repair = 0;
        }
      }
    }
  }

  /** Knocked out when fewer than two crew remain, or three or more are dead. */
  knockedOut(): boolean {
    const alive = this.crewAlive().length;
    const dead = this.spec.crew.length - alive;
    return alive < 2 || dead >= 3;
  }

  /** Random gaussian deviation for shot direction. */
  shotAngle(): number {
    return this.gunWorldAng + rand.gauss() * this.dispersion();
  }
}
