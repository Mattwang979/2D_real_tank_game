// Tank entity: movement physics, turret/gun traverse, reload, module & crew state.

import { type V2, DEG, angNorm, approach, approachAngle, clamp, fromAngle, toWorld, angDiff } from '../core/math';
import { rand } from '../core/rng';
import type { CrewRole, VehicleSpec } from '../data/vehicles';
import { getBlueprint, type Blueprint, type ModuleDef, type ModuleKind } from './blueprint';
import type { ModState } from '../render/tankRender';
import { type WeatherDef, WEATHERS } from './weather';

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
  handbrake = false;
  /** world-space velocity (m/s); tracks pull it toward the hull direction, the handbrake lets it slide */
  vel: V2 = { x: 0, y: 0 };

  // special abilities
  boostT = 0;
  boostCd = 0;
  repairT = 0;
  repairCd = 0;
  smokeCharges = 2;
  smokeCd = 0;
  /** illumination flares (night battles) */
  flareCharges = 0;
  flareCd = 0;
  /** battle weather: sets how far the crew can see */
  env: WeatherDef = WEATHERS.clear;
  /** crew-carrier cooldown */
  crewCd = 0;
  /** ground speed factor (earthworks are slow going) */
  terrainMul = 1;
  /** kills in this life (killstreak) */
  streak = 0;
  /** killstreak support held by an AI tank (players keep theirs in the slot) */
  support = { recon: 0, arty: 0 };
  /** request from controls: launch smoke toward this world angle */
  wantSmoke: number | null = null;
  /** queued shot: fires as soon as the gun is loaded and on the aim angle (until `until`) */
  fireReq: { until: number } | null = null;
  lastHitTime = -99;
  /** human-controlled slot key (null = AI) */
  slot: string | null = null;
  /** latest network snapshot (replica battles only) */
  net: { x: number; y: number; ang: number; tRel: number; gRel: number; speed: number; vx: number; vy: number } | null = null;

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
  /** battle time when the enemy last saw this tank */
  lastSeenAt = -99;

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
    return { range: (cmd ? 230 : 165) * this.env.range, half: 26 * DEG, near: this.env.near };
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
      const k = Math.exp(-4 * dt);
      this.vel.x *= k;
      this.vel.y *= k;
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      return;
    }
    const sp = this.spec;
    const mobile = this.canMove();
    const pw = sp.hp / sp.weight;
    const boosting = this.boostT > 0;
    const accel = clamp(0.19 * pw, 0.9, 3.4) * this.enginePower() * (boosting ? 1.8 : 1);
    const vmax = this.maxSpeed() * (this.enginePower() < 1 ? 0.6 : 1) * (boosting ? 1.3 : 1) * this.terrainMul;
    const vrev = (sp.reverse / 3.6) * SPEED_SCALE;
    let target = 0;
    if (mobile && !this.handbrake) target = this.throttle >= 0 ? this.throttle * vmax : this.throttle * vrev;
    const braking = Math.sign(target) !== Math.sign(this.speed) && Math.abs(this.speed) > 0.1;
    const decel = this.handbrake ? 14 : braking || target === 0 ? 5.5 : accel;
    this.speed = approach(this.speed, target, decel * dt);

    // turning
    let turnRate: number;
    if (sp.look.wheels) {
      const minR = 6.5;
      const fwdV = Math.abs(this.speed) + (this.handbrake ? Math.hypot(this.vel.x, this.vel.y) * 0.7 : 0);
      turnRate = Math.min(fwdV / minR, this.handbrake ? 1.4 : 0.75) * Math.sign(this.speed || 1);
    } else {
      const base = clamp(16 + pw * 1.6, 22, 48) * DEG;
      turnRate = base * (1 - 0.4 * Math.min(1, Math.abs(this.speed) / Math.max(vmax, 1)));
      // handbrake while moving: lock one track and swing the hull round (drift)
      if (this.handbrake && Math.hypot(this.vel.x, this.vel.y) > 2) turnRate = base * 2.4;
    }
    const targetAV = mobile ? this.steer * turnRate * (this.enginePower() > 0 ? 1 : 0) : 0;
    this.angVel = approach(this.angVel, targetAV, (this.handbrake ? 7 : 3.5) * dt);
    this.ang = angNorm(this.ang + this.angVel * dt);

    // tracks grip: velocity follows the hull; with the handbrake + steering it slides (drift)
    const dvx = Math.cos(this.ang) * this.speed;
    const dvy = Math.sin(this.ang) * this.speed;
    const grip = this.handbrake ? (Math.abs(this.steer) > 0.3 ? 1.7 : 9) : 14;
    const kg = 1 - Math.exp(-grip * dt);
    this.vel.x += (dvx - this.vel.x) * kg;
    this.vel.y += (dvy - this.vel.y) * kg;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

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
    if (this.boostT > 0) this.boostT -= dt;
    if (this.boostCd > 0) this.boostCd -= dt;
    if (this.repairCd > 0) this.repairCd -= dt;
    if (this.smokeCd > 0) this.smokeCd -= dt;
    if (this.flareCd > 0) this.flareCd -= dt;
    if (this.crewCd > 0) this.crewCd -= dt;

    this.updateCrew(dt);
    this.updateRepair(dt);
    void now;
  }

  // ---------------------------------------------------------------- abilities
  static readonly BOOST_TIME = 8;
  static readonly BOOST_CD = 25;
  static readonly REPAIR_TIME = 6;
  static readonly REPAIR_CD = 35;

  /** Modules that a repair would fix. */
  needsRepair(): boolean {
    return this.mods.some((m) => (m.def.kind === 'track' || m.def.kind === 'engine' || m.def.kind === 'transmission' || m.def.kind === 'breech' || m.def.kind === 'barrel' || m.def.kind === 'fuel') && m.hp < m.def.maxHp * 0.7);
  }
  canBoost(): boolean {
    return this.alive && this.boostCd <= 0 && this.canMove();
  }
  startBoost(): boolean {
    if (!this.canBoost()) return false;
    this.boostT = Tank.BOOST_TIME;
    this.boostCd = Tank.BOOST_CD;
    return true;
  }
  canRepair(): boolean {
    return this.alive && this.repairCd <= 0 && this.repairT <= 0 && this.needsRepair() && this.crewAlive().length >= 2;
  }
  startRepair(): boolean {
    if (!this.canRepair()) return false;
    this.repairT = Tank.REPAIR_TIME;
    return true;
  }
  /** Any crew member hurt or dead (a crew carrier would replace them)? */
  needsCrew(): boolean {
    return this.mods.some((m) => m.def.kind === 'crew' && m.hp < m.def.maxHp * 0.9);
  }
  /** Worth calling the carrier for (AI): somebody dead or two badly wounded. */
  needsCrewBadly(): boolean {
    const crew = this.mods.filter((m) => m.def.kind === 'crew');
    return crew.some((m) => m.hp <= 0) || crew.filter((m) => m.hp < m.def.maxHp * 0.55).length >= 2;
  }
  canSmoke(): boolean {
    return this.alive && this.smokeCharges > 0 && this.smokeCd <= 0;
  }
  canFlare(): boolean {
    return this.alive && this.flareCharges > 0 && this.flareCd <= 0;
  }

  private updateRepair(dt: number) {
    if (this.repairT <= 0) return;
    if (this.burning > 0) return; // crew is busy with the fire
    this.repairT -= dt;
    if (this.repairT <= 0) {
      this.repairT = 0;
      this.repairCd = Tank.REPAIR_CD;
      for (const m of this.mods) {
        const k = m.def.kind;
        if (k === 'track' || k === 'engine' || k === 'transmission' || k === 'breech' || k === 'barrel' || k === 'fuel') m.hp = Math.max(m.hp, m.def.maxHp * 0.75);
      }
    }
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
