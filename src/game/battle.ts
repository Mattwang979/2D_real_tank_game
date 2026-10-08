// Battle simulation: tanks, projectiles, capture point, spotting, scoring.
// Runs in three modes:
//   local   – single player vs AI, everything simulated here
//   host    – authoritative multiplayer simulation; effects are mirrored to clients via `netOut`
//   replica – client mirror of a host's battle; positions come from snapshots, effects from events

import { type V2, DEG, angDiff, clamp, dist, fromAngle, pointInPoly, satMTV, toLocal, toWorld, dirToLocal } from '../core/math';
import { rand } from '../core/rng';
import { audio } from '../core/audio';
import { VEHICLES, getVehicle, type ShellSpec, type VehicleSpec } from '../data/vehicles';
import { AIController } from './ai';
import { type ImpactResult, fireTick, intersectTank, resolveImpact, topHit } from './armor';
import { Effects } from './effects';
import { type Building, type GameMap, type Tree, bermCrossing, buildMap, collideStatic, damageBuilding, losBlocked, MAPS, onBerm, setBuildingState, shellObstacleHit, structDamage, type Contact } from './map';
import { CARRIER, type Carrier, carrierHit, driveCarrier } from './carrier';
import { NavGrid } from './nav';
import { ARTY, ARTY_EVERY, ARTY_SHELL, type ArtyStrike, RECON_EVERY, RECON_TIME, type ReconFlight, type SupportStock } from './support';
import { Tank } from './tank';
import { canSee, visibilityPolygon } from './vision';

export interface Projectile {
  id: number;
  /** where the shell started (or last bounced): earthworks right in front of the gun don't stop it */
  org: V2;
  x: number;
  y: number;
  dx: number;
  dy: number;
  speed: number;
  shell: ShellSpec;
  shooter: Tank;
  dist: number;
  age: number;
  height: number;
  penScale: number;
  ignoreTank: number;
  ignoreBarrel: number;
  ricochet: boolean;
}

/** Events for the HUD. `to` routes an event to one player slot (undefined = everyone). */
export type BattleEvent =
  | { type: 'hit'; res: ImpactResult; shooter: Tank; target: Tank }
  | { type: 'popup'; text: string; x: number; y: number; color: string; big?: boolean; to?: string }
  | { type: 'feed'; killer: Tank | null; victim: Tank; how: string }
  | { type: 'notice'; text: string; color?: string; to?: string; team?: 0 | 1 }
  | { type: 'captured'; team: 0 | 1 }
  | { type: 'playerDead'; killer: Tank | null; res: ImpactResult | null; to?: string }
  | { type: 'end' };

/** Compact effect events mirrored from host to clients. */
export type NetFx =
  | { k: 'fire'; id: number; s: number }
  | { k: 'shot'; pid: number; sid: number; x: number; y: number; dx: number; dy: number; v: number; s: number; r?: number; lo?: number }
  | { k: 'imp'; x: number; y: number; o: number; dx: number; dy: number; c: number; e: number; rx?: number; ry?: number; sp?: number; pid?: number; end?: number }
  | { k: 'obs'; x: number; y: number; dx: number; dy: number; c: number; e: number; pid?: number; so?: number }
  | { k: 'gren'; team: 0 | 1; g: number[][] }
  | { k: 'cloud'; id: number; x: number; y: number; rm: number; life: number; team: 0 | 1 }
  | { k: 'cdie'; id: number; x: number; y: number }
  | { k: 'bld'; id: number; st: number }
  | { k: 'aimp'; x: number; y: number }
  | { k: 'whis'; x: number; y: number }
  | { k: 'kill'; id: number; how: number; vx: number; vy: number; spin: number; vh: number; wf: number }
  | { k: 'tree'; id: number; dir: number }
  | { k: 'wall'; id: number }
  | { k: 'decal'; kind: 'scorch' | 'crater'; x: number; y: number; w: number; seed?: number };

const OUTCOMES = ['ricochet', 'nonpen', 'pen', 'barrel', 'wreck'] as const;

export interface RewardLine {
  label: string;
  rp: number;
  cr: number;
}

export interface SlotStats {
  kills: number;
  assists: number;
  hits: number;
  crits: number;
  caps: number;
  damage: number;
  shots: number;
}

export interface PlayerSlot {
  key: string;
  name: string;
  team: 0 | 1;
  lineup: string[];
  used: Set<string>;
  tank: Tank | null;
  dead: boolean;
  deadAt: number;
  stats: SlotStats;
  rewards: RewardLine[];
  lastHit: { res: ImpactResult; by: Tank } | null;
  connected: boolean;
  /** killstreak support earned and not used yet (kept across respawns) */
  support: SupportStock;
}

export interface BattleConfig {
  mapId: string;
  seed?: number;
  /** single player */
  lineup?: string[];
  playerName?: string;
  /** multiplayer: explicit human slots */
  slots?: Array<{ key: string; name: string; lineup: string[]; team: 0 | 1 }>;
  localKey?: string;
  mode?: 'local' | 'host' | 'replica';
}

export interface BattleHooks {
  stamp?: (d: { kind: 'track' | 'scorch' | 'crater' | 'fallen'; x: number; y: number; ang: number; w: number; h: number; seed?: number; a?: number }) => void;
  fellTree?: (t: Tree, dir: number) => void;
  /** a building's damage state changed (redraw it) */
  building?: (b: Building) => void;
}

const AI_NAMES = ['Anvil', 'Badger', 'Cobalt', 'Drake', 'Ember', 'Falcon', 'Granite', 'Hammer', 'Iron', 'Jackal', 'Kodiak', 'Lynx', 'Mason', 'Nomad', 'Onyx', 'Pike', 'Quarry', 'Raven', 'Sable', 'Talon', 'Ursa', 'Viper', 'Wolf', 'Yukon', 'Zephyr', 'Bishop', 'Cutter', 'Dusty', 'Flint', 'Gunner'];

export const TICKETS = 800;
export const KILL_TICKETS = 45;
export const BATTLE_TIME = 12 * 60;
export const TEAM_SIZE = 5;
/** shells with a height roll at or above this fly at hull height (earthworks stop them) */
export const LOW_SHOT = 0.45;
/** smoke screen duration (s) */
export const SMOKE_LIFE = 13;
/** a queued shot is released once the gun is within this angle of the aim */
const FIRE_TOL = 0.6 * DEG;

const newStats = (): SlotStats => ({ kills: 0, assists: 0, hits: 0, crits: 0, caps: 0, damage: 0, shots: 0 });

export class Battle {
  cfg: BattleConfig;
  mode: 'local' | 'host' | 'replica';
  map: GameMap;
  nav: NavGrid | null;
  fx: Effects;
  tanks: Tank[] = [];
  projectiles: Projectile[] = [];
  ais = new Map<number, AIController>();
  slots: PlayerSlot[] = [];
  localKey: string;
  playerTeam: 0 | 1 = 0;
  time = 0;
  shellSpeedScale = 0.4;
  events: BattleEvent[] = [];
  hooks: BattleHooks = {};
  /** host: effect events to mirror to clients (null when nobody listens) */
  netOut: NetFx[] | null = null;

  capture = { owner: -1 as -1 | 0 | 1, progress: 0, contested: false, inside: [0, 0] };
  tickets: [number, number] = [TICKETS, TICKETS];
  reinforcements: [number, number] = [8, 8];
  respawnQueue: Array<{ team: 0 | 1; at: number }> = [];
  phase: 'playing' | 'ended' = 'playing';
  winner: 0 | 1 | null = null;

  spotted: [Set<number>, Set<number>] = [new Set(), new Set()];
  private spotTimer = 0;
  visionPoly: V2[] = [];
  private visionTimer = 0;
  private fireTimer = 0;

  grenades: Array<{ x0: number; y0: number; x1: number; y1: number; t: number; T: number; team: 0 | 1 }> = [];
  /** crew carriers on the field */
  carriers: Carrier[] = [];
  private carrierId = 1;
  /** carriers each team can currently see */
  spottedCarriers: [Set<number>, Set<number>] = [new Set(), new Set()];
  /** killstreak support in action */
  recons: ReconFlight[] = [];
  artys: ArtyStrike[] = [];
  private supportId = 1;
  /** set while artillery resolves, so its kills don't feed the streak */
  private supportKill = false;
  private smokeId = 1;
  private projId = 1;
  battleBR: number;
  enemyPool: VehicleSpec[];

  constructor(cfg: BattleConfig, hooks: BattleHooks = {}) {
    this.cfg = cfg;
    this.hooks = hooks;
    this.mode = cfg.mode ?? 'local';
    const def = MAPS.find((m) => m.id === cfg.mapId) ?? MAPS[0];
    this.map = buildMap(def, cfg.seed ?? 1234);
    this.nav = this.mode === 'replica' ? null : new NavGrid(this.map);
    this.fx = new Effects(this.map.theme);
    this.localKey = cfg.localKey ?? 'local';

    // human slots
    const humans = cfg.slots ?? [{ key: 'local', name: cfg.playerName ?? 'Commander', lineup: cfg.lineup ?? ['m4a2'], team: (rand.chance(0.5) ? 0 : 1) as 0 | 1 }];
    for (const h of humans) {
      this.slots.push({ key: h.key, name: h.name, team: h.team, lineup: h.lineup.length ? h.lineup : ['m4a2'], used: new Set(), tank: null, dead: false, deadAt: 0, stats: newStats(), rewards: [], lastHit: null, connected: true, support: { recon: 0, arty: 0 } });
    }
    this.playerTeam = this.local?.team ?? 0;

    const brs = this.slots.map((s) => getVehicle(s.lineup[0]).br);
    this.battleBR = Math.max(...brs);
    let pool = VEHICLES.filter((v) => Math.abs(v.br - this.battleBR) <= 1.0);
    if (pool.length < 4) pool = VEHICLES.filter((v) => Math.abs(v.br - this.battleBR) <= 1.7);
    this.enemyPool = pool;

    if (this.mode === 'replica') return; // tanks arrive with snapshots

    // spawn teams: humans first on the middle spawn points, AI fills the rest
    const names = [...AI_NAMES].sort(() => rand.next() - 0.5);
    const order = [2, 1, 3, 0, 4];
    for (const team of [0, 1] as const) {
      const spawns = this.map.spawns[team];
      const teamHumans = this.slots.filter((s) => s.team === team);
      for (let i = 0; i < TEAM_SIZE; i++) {
        const s = spawns[order[i]];
        const h = teamHumans[i];
        if (h) this.spawnHuman(h, h.lineup[0], { x: s.x, y: s.y }, s.ang);
        else this.spawnAI(team, s, names.pop() ?? 'Tank', order[i]);
      }
    }
  }

  // ------------------------------------------------------------------ slots / local player
  get local(): PlayerSlot | undefined {
    return this.slots.find((s) => s.key === this.localKey);
  }
  get player(): Tank | null {
    return this.local?.tank ?? null;
  }
  /** Local player's perspective: playing / waiting to respawn / battle over. */
  get state(): 'playing' | 'dead' | 'ended' {
    if (this.phase === 'ended') return 'ended';
    return this.local?.dead ? 'dead' : 'playing';
  }
  get deadAt(): number {
    return this.local?.deadAt ?? 0;
  }
  get stats(): SlotStats {
    return this.local?.stats ?? newStats();
  }
  get rewards(): RewardLine[] {
    return this.local?.rewards ?? [];
  }
  get result(): 'victory' | 'defeat' | null {
    if (this.winner === null) return null;
    return this.winner === this.playerTeam ? 'victory' : 'defeat';
  }

  slotOf(t: Tank | null | undefined): PlayerSlot | undefined {
    if (!t || !t.slot) return undefined;
    return this.slots.find((s) => s.key === t.slot);
  }

  private spawnHuman(slot: PlayerSlot, vehicleId: string, pos: V2, ang: number) {
    const spec = getVehicle(vehicleId);
    const t = new Tank(spec, slot.team, pos, ang, slot.name);
    t.slot = slot.key;
    t.isPlayer = slot.key === this.localKey;
    slot.tank = t;
    slot.used.add(vehicleId);
    slot.dead = false;
    slot.lastHit = null;
    this.tanks.push(t);
    if (!slot.connected) this.ais.set(t.id, new AIController(t, this, 'capper'));
    return t;
  }

  private spawnAI(team: 0 | 1, s: { x: number; y: number; ang: number }, name: string, i: number) {
    const spec = this.enemyPool[Math.floor(rand.next() * this.enemyPool.length)];
    const t = new Tank(spec, team, { x: s.x + rand.range(-2, 2), y: s.y + rand.range(-2, 2) }, s.ang, name);
    const roles = ['capper', 'support', 'capper', 'flank', 'support'] as const;
    this.ais.set(t.id, new AIController(t, this, roles[i % roles.length]));
    this.tanks.push(t);
    return t;
  }

  /** A remote player left: their current tank continues as AI. */
  disconnect(key: string) {
    const s = this.slots.find((x) => x.key === key);
    if (!s) return;
    s.connected = false;
    if (s.tank && s.tank.alive && !this.ais.has(s.tank.id)) this.ais.set(s.tank.id, new AIController(s.tank, this, 'capper'));
  }

  emit(e: BattleEvent) {
    this.events.push(e);
  }

  isSpotted(team: 0 | 1, t: Tank): boolean {
    return this.spotted[team].has(t.id);
  }

  addReward(slot: PlayerSlot, label: string, rp: number, cr: number, at?: V2, color = '#f0b43c', big = false) {
    slot.rewards.push({ label, rp, cr });
    if (at) this.emit({ type: 'popup', text: big ? `${label} +${rp} RP +${cr.toLocaleString('en-US')} CR` : `${label} +${rp} RP`, x: at.x, y: at.y, color, big, to: slot.key });
  }

  // ------------------------------------------------------------------ player API
  playerFire() {
    if (this.player) this.player.wantFire = true;
  }

  /**
   * Fire as soon as the gun is loaded and laid on `aim` (world angle).
   * Returns false when the shot can't be queued (gun out of action or a long reload ahead).
   */
  requestFire(t: Tank, aim?: number): boolean {
    if (aim !== undefined && Number.isFinite(aim)) t.aimAngle = aim;
    if (!t.alive || !t.canFire()) return false;
    if (t.reloadLeft > 1.6) return false;
    const trav = t.aimError() / Math.max(0.05, t.traverseRate());
    t.fireReq = { until: this.time + Math.max(0, t.reloadLeft) + Math.min(trav, 8) + 0.6 };
    return true;
  }

  useBoost(t: Tank): boolean {
    return t.startBoost();
  }

  /** Repair button: puts out a fire first, otherwise starts field repairs. */
  useRepair(t: Tank): boolean {
    if (t.burning > 0) return this.extinguish(t);
    const ok = t.startRepair();
    if (ok && t.slot) this.emit({ type: 'notice', text: 'Repairing', color: '#9fd3ff', to: t.slot });
    return ok;
  }

  useSmoke(t: Tank, ang: number): boolean {
    if (!t.canSmoke() || !Number.isFinite(ang)) return false;
    t.wantSmoke = ang;
    return true;
  }

  selectShell(t: Tank, i: number) {
    if (t.alive) t.selectShell(i);
  }

  /** The carrier currently serving tank `t` (if any). */
  carrierFor(t: Tank | null | undefined): Carrier | undefined {
    if (!t) return undefined;
    return this.carriers.find((c) => c.forId === t.id && c.state !== 'dead');
  }

  /** Call a crew carrier: it drives up from behind our lines and replaces wounded / dead crew. */
  useCrew(t: Tank): boolean {
    if (this.mode === 'replica' || !t.alive || t.crewCd > 0 || this.carrierFor(t) || !t.needsCrew()) return false;
    const sps = this.map.spawns[t.team];
    let sp = sps[0];
    let bd = Infinity;
    for (const s of sps) {
      const d = dist(s, t.pos);
      if (d < bd) {
        bd = d;
        sp = s;
      }
    }
    // start a little further back than the spawn line (spawns face the battlefield)
    const S = this.map.size;
    let home = { x: clamp(sp.x - Math.cos(sp.ang) * 12, 8, S - 8), y: clamp(sp.y - Math.sin(sp.ang) * 12, 8, S - 8) };
    if (this.nav && !this.nav.free(home)) home = { x: sp.x, y: sp.y };
    const c: Carrier = {
      id: this.carrierId++,
      team: t.team,
      forId: t.id,
      nation: t.spec.nation,
      pos: { ...home },
      ang: Math.atan2(t.pos.y - home.y, t.pos.x - home.x),
      speed: 0,
      path: this.nav?.findPath(home, t.pos) ?? [{ ...t.pos }],
      state: 'drive',
      t: 0,
      home,
      repath: 1.5,
      age: 0,
    };
    this.carriers.push(c);
    if (t.slot) this.emit({ type: 'notice', text: 'Crew carrier on the way', color: '#9fd3ff', to: t.slot });
    return true;
  }

  /** Killstreak support stock of a tank (players: their slot, AI: the tank). */
  supportOf(t: Tank): SupportStock {
    return this.slotOf(t)?.support ?? t.support;
  }

  /** Recon plane: every enemy is revealed to our team while it circles overhead. */
  useRecon(t: Tank): boolean {
    const st = this.supportOf(t);
    if (this.mode === 'replica' || !t.alive || st.recon <= 0) return false;
    st.recon--;
    const S = this.map.size;
    const y = rand.range(S * 0.25, S * 0.75);
    const fromLeft = this.map.spawns[t.team][0].x < S / 2;
    const x0 = fromLeft ? -40 : S + 40;
    const x1 = fromLeft ? S + 40 : -40;
    this.recons.push({ id: this.supportId++, team: t.team, t: 0, T: RECON_TIME, x0, y0: y + rand.range(-40, 40), x1, y1: S - y + rand.range(-40, 40) });
    this.emit({ type: 'notice', text: 'Recon plane overhead — enemies revealed', color: '#9fd3ff', team: t.team });
    this.emit({ type: 'notice', text: 'Enemy recon plane!', color: '#ff8a5c', team: t.team === 0 ? 1 : 0 });
    audio.plane(RECON_TIME, 0.1);
    return true;
  }

  /** Artillery strike on a map point: a barrage of heavy HE arrives a few seconds later. */
  useArty(t: Tank, x: number, y: number): boolean {
    const st = this.supportOf(t);
    if (this.mode === 'replica' || !t.alive || st.arty <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) return false;
    st.arty--;
    const S = this.map.size;
    const times: number[] = [];
    for (let i = 0; i < ARTY.SHELLS; i++) times.push(ARTY.DELAY + (i / (ARTY.SHELLS - 1)) * ARTY.SPAN + rand.range(-0.12, 0.12));
    times.sort((a, b) => a - b);
    this.artys.push({ id: this.supportId++, team: t.team, by: t.id, x: clamp(x, 5, S - 5), y: clamp(y, 5, S - 5), t: 0, times, fired: 0, whistled: 0 });
    this.emit({ type: 'notice', text: 'Artillery on the way', color: '#ffd27a', team: t.team });
    this.emit({ type: 'notice', text: 'Enemy artillery incoming!', color: '#ff6b5a', team: t.team === 0 ? 1 : 0 });
    return true;
  }

  private updateSupport(dt: number) {
    for (const r of this.recons) r.t += dt;
    this.recons = this.recons.filter((r) => r.t < r.T);
    for (const a of this.artys) {
      a.t += dt;
      while (a.whistled < a.times.length && a.t >= a.times[a.whistled] - 1.1) {
        a.whistled++;
        audio.whistle(this.listenerDist(a));
        this.netOut?.push({ k: 'whis', x: r2(a.x), y: r2(a.y) });
      }
      while (a.fired < a.times.length && a.t >= a.times[a.fired]) {
        a.fired++;
        const r = Math.sqrt(rand.next()) * ARTY.SPREAD;
        const ang = rand.range(0, Math.PI * 2);
        this.artyImpact(this.tanks.find((x) => x.id === a.by) ?? null, a.x + Math.cos(ang) * r, a.y + Math.sin(ang) * r);
      }
    }
    this.artys = this.artys.filter((a) => a.fired < a.times.length || a.t < a.times[a.times.length - 1] + 0.5);
  }

  /** One heavy HE shell landing: crater, blast, direct hits on roofs, splash, buildings, carriers. */
  private artyImpact(by: Tank | null, x: number, y: number) {
    this.fxArty(x, y);
    this.stampDecal('crater', x, y, 2.2, Math.floor(x * 17 + y * 3));
    const at = { x, y };
    const shooter = by ?? this.tanks[0];
    const fake: Projectile = { id: -1, org: at, x, y, dx: 0, dy: 1, speed: 0, shell: ARTY_SHELL, shooter, dist: 0, age: 1, height: 0.5, penScale: 1, ignoreTank: -1, ignoreBarrel: -1, ricochet: false };
    this.supportKill = true;
    const direct = new Set<number>();
    for (const t of this.tanks) {
      if (!t.alive || dist(t.pos, at) > t.bp.radius + 0.3) continue;
      if (!pointInPoly(toLocal(at, t.pos, t.ang), t.bp.hullPoly)) continue;
      direct.add(t.id);
      const res = topHit(by, t, at, ARTY_SHELL);
      this.onImpact(fake, t, res, true);
    }
    this.splash(fake, x, y, direct);
    this.supportKill = false;
    for (const bld of this.map.buildings) {
      if (bld.dmg >= 2 || Math.hypot(bld.cx - x, bld.cy - y) > Math.max(bld.w, bld.h) / 2 + 4) continue;
      this.hitBuilding(bld, 160, by, x, y);
    }
    for (const c of this.carriers) if (c.state !== 'dead' && dist(c.pos, at) < 7) this.killCarrier(c);
  }

  fxArty(x: number, y: number) {
    this.fx.heBlast(x, y, ARTY_SHELL.explosive);
    this.fx.explosion(x, y, 0.55);
    this.fx.impactDust(x, y, true);
    audio.explosion(1.5, this.listenerDist({ x, y }));
    this.netOut?.push({ k: 'aimp', x: r2(x), y: r2(y) });
  }

  private updateCarriers(dt: number) {
    const blockers = this.tanks.filter((x) => x.alive).map((x) => x.bp.hullPoly.map((q) => toWorld(q, x.pos, x.ang)));
    for (const c of this.carriers) {
      c.age += dt;
      if (c.state === 'dead') {
        c.t += dt;
        continue;
      }
      const t = this.tanks.find((x) => x.id === c.forId);
      if (c.state !== 'leave' && (!t || !t.alive)) {
        c.state = 'leave';
        c.t = 0;
        c.path = this.nav?.findPath(c.pos, c.home) ?? [c.home];
      }
      if (c.state === 'drive' && t) {
        c.repath -= dt;
        if (c.repath <= 0) {
          c.repath = 1.5;
          c.path = this.nav?.findPath(c.pos, t.pos) ?? [{ ...t.pos }];
        }
        if (dist(c.pos, t.pos) < CARRIER.REACH) {
          c.state = 'park';
          c.t = 0;
        } else driveCarrier(c, this.map, t.pos, CARRIER.REACH - 1, dt, blockers);
      } else if (c.state === 'park' && t) {
        c.speed = Math.max(0, c.speed - 20 * dt);
        if (dist(c.pos, t.pos) > CARRIER.REACH + 3.5) {
          // the tank drove off: follow it and start over
          c.state = 'drive';
          c.repath = 0;
          c.t = 0;
        } else {
          c.t += dt;
          if (c.t >= CARRIER.PARK) {
            this.replaceCrew(t);
            c.state = 'leave';
            c.t = 0;
            c.path = this.nav?.findPath(c.pos, c.home) ?? [c.home];
          }
        }
      } else if (c.state === 'leave') {
        c.t += dt;
        driveCarrier(c, this.map, c.home, 0, dt, blockers);
      }
    }
    // drive-offs reaching home and old wrecks disappear
    this.carriers = this.carriers.filter((c) => !(c.state === 'leave' && (dist(c.pos, c.home) < 5 || c.t > 30)) && !(c.state === 'dead' && c.t > 40));
  }

  /** Fresh crew for every wounded or dead seat. */
  private replaceCrew(t: Tank) {
    for (const m of t.mods) {
      if (m.def.kind !== 'crew') continue;
      m.hp = m.def.maxHp;
      m.role = m.def.role;
    }
    t.pendingSwapRole = null;
    t.crewSwap = 0;
    t.crewCd = CARRIER.CD;
    if (t.slot) this.emit({ type: 'notice', text: 'Crew replaced', color: '#9fd3ff', to: t.slot });
  }

  /** A carrier was hit: it burns out and the crew swap is lost (no score for the shooter). */
  killCarrier(c: Carrier) {
    if (c.state === 'dead') return;
    c.state = 'dead';
    c.t = 0;
    c.speed = 0;
    this.fxCarrierDeath(c);
    const t = this.tanks.find((x) => x.id === c.forId);
    if (t && t.alive) {
      t.crewCd = CARRIER.CD_LOST;
      if (t.slot) this.emit({ type: 'notice', text: 'Crew carrier destroyed!', color: '#ff8a5c', to: t.slot });
    }
  }

  fxCarrierDeath(c: Carrier) {
    this.fx.explosion(c.pos.x, c.pos.y, 0.75);
    audio.explosion(0.9, this.listenerDist(c.pos));
    this.stampDecal('scorch', c.pos.x, c.pos.y, 3.2);
    this.netOut?.push({ k: 'cdie', id: c.id, x: r2(c.pos.x), y: r2(c.pos.y) });
  }

  /** Shell or blast damage to a building; heavy guns bring them down and open new lines of fire. */
  hitBuilding(bld: Building, amount: number, by: Tank | null, x: number, y: number) {
    const st = damageBuilding(this.map, bld, amount);
    if (!st) return;
    this.fxBuilding(bld, st);
    if (st === 2 && by?.slot) this.emit({ type: 'popup', text: 'Building destroyed', x, y, color: '#d8c8a0', to: by.slot });
  }

  fxBuilding(bld: Building, st: number) {
    const ld = this.listenerDist({ x: bld.cx, y: bld.cy });
    if (st >= 2) {
      this.fx.collapse(bld.cx, bld.cy, bld.w, bld.h, bld.ang);
      audio.explosion(1.1, ld);
      audio.thud(ld);
    } else {
      this.fx.impactDust(bld.cx, bld.cy, true);
      audio.thud(ld);
    }
    this.hooks.building?.(bld);
    this.netOut?.push({ k: 'bld', id: bld.id, st });
  }

  /** Burning wrecks, dust behind fast carriers (local, host and replica). */
  private carrierFx(dt: number) {
    for (const c of this.carriers) {
      if (c.state === 'dead') {
        if (c.t < 18 && rand.chance(dt * 30)) this.fx.fire(c.pos.x + rand.range(-1.2, 1.2), c.pos.y + rand.range(-0.6, 0.6), 1);
        if (rand.chance(dt * (c.t < 18 ? 8 : 1.5))) this.fx.smoke(c.pos.x, c.pos.y, true, 1.6);
      } else if (c.speed > 4 && rand.chance(dt * 12)) {
        const p = toWorld({ x: -CARRIER.L / 2, y: rand.range(-0.8, 0.8) }, c.pos, c.ang);
        this.fx.trackDust(p.x, p.y, c.speed);
      }
    }
  }

  /** Is the point visible to this team's tanks (simplified spotting used for carriers)? */
  private teamSees(team: 0 | 1, p: V2): boolean {
    for (const v of this.tanks) {
      if (!v.alive || v.team !== team) continue;
      const vc = v.visionCone();
      const tp = v.turretPos();
      const d = dist(tp, p);
      if (d > vc.range) continue;
      const inCone = Math.abs(angDiff(v.gunWorldAng, Math.atan2(p.y - tp.y, p.x - tp.x))) <= vc.half;
      if (!inCone && d > vc.near) continue;
      if (!losBlocked(this.map, tp, p)) return true;
    }
    return false;
  }

  extinguish(t: Tank) {
    if (t.burning <= 0 || t.extinguishCd > 0) return false;
    t.burning = 0;
    t.extinguishCd = 30;
    if (t.slot) this.emit({ type: 'notice', text: 'Fire extinguished', color: '#9fd3ff', to: t.slot });
    return true;
  }

  availableLineup(slot: PlayerSlot | undefined = this.local): VehicleSpec[] {
    if (!slot) return [];
    return slot.lineup.filter((id) => !slot.used.has(id)).map(getVehicle);
  }

  respawnPlayer(id: string, slot: PlayerSlot | undefined = this.local) {
    if (!slot || slot.used.has(id) || !slot.dead || this.phase === 'ended') return;
    if (!slot.lineup.includes(id)) return;
    const sp = this.map.spawns[slot.team][2];
    const pos = this.freeSpawn(sp);
    this.spawnHuman(slot, id, pos, sp.ang);
  }

  private freeSpawn(sp: { x: number; y: number }): V2 {
    for (let i = 0; i < 20; i++) {
      const p = { x: sp.x + rand.range(-14, 14), y: sp.y + rand.range(-30, 30) };
      if (this.nav && !this.nav.free(p)) continue;
      if (this.tanks.some((t) => dist(t.pos, p) < 9)) continue;
      return p;
    }
    return { x: sp.x, y: sp.y };
  }

  // ------------------------------------------------------------------ update
  update(dt: number) {
    if (this.mode === 'replica') {
      this.replicaUpdate(dt);
      return;
    }
    if (this.phase === 'ended') {
      this.fx.update(dt);
      return;
    }
    this.time += dt;
    const now = this.time;

    for (const ai of this.ais.values()) ai.update(dt, now);

    for (const t of this.tanks) {
      const prevReloaded = t.isReloaded();
      t.terrainMul = t.alive && onBerm(this.map, t.pos) ? 0.5 : 1;
      t.update(dt, now);
      if (t.isPlayer && !prevReloaded && t.isReloaded() && t.alive) audio.reloadDone();
    }
    this.collide();
    this.trackMarks(dt);

    // smoke launches
    for (const t of this.tanks) {
      if (t.wantSmoke === null) continue;
      const a = t.wantSmoke;
      t.wantSmoke = null;
      this.launchSmoke(t, a);
    }
    this.updateSmoke(dt);
    this.updateCarriers(dt);
    this.updateSupport(dt);

    // queued shots (fire button released while reloading / turret still traversing)
    for (const t of this.tanks) {
      const fr = t.fireReq;
      if (!fr) continue;
      if (!t.alive || now > fr.until || !t.canFire()) {
        t.fireReq = null;
        continue;
      }
      if (t.isReloaded() && t.aimError() < FIRE_TOL) {
        t.fireReq = null;
        t.wantFire = true;
      }
    }
    // firing
    for (const t of this.tanks) {
      if (!t.wantFire) continue;
      t.wantFire = false;
      if (!t.alive) continue;
      const idx = t.fire();
      if (idx < 0) continue;
      this.spawnShell(t, idx);
    }

    this.updateProjectiles(dt);
    this.updateFires(dt);
    this.updateWrecks(dt);
    this.carrierFx(dt);
    this.fx.update(dt);

    this.spotTimer -= dt;
    if (this.spotTimer <= 0) {
      this.spotTimer = 0.2;
      this.updateSpotting(now);
    }
    this.updateVision(dt);
    this.updateCapture(dt);
    this.updateRespawns(now);
    this.checkEnd();
  }

  updateVision(dt: number) {
    this.visionTimer -= dt;
    if (this.visionTimer <= 0 && this.player && this.player.alive) {
      this.visionTimer = 1 / 30;
      const p = this.player;
      const vc = p.visionCone();
      this.visionPoly = visibilityPolygon(this.map, p.turretPos(), p.gunWorldAng, vc.half, vc.range, vc.near);
    }
  }

  // ------------------------------------------------------------------ effects (local + mirrored)
  /** Muzzle flash, dust, recoil and sound for a tank firing. */
  fxFire(t: Tank, shellIdx: number) {
    const m = t.muzzle();
    const brake = t.spec.look.brake !== 'none';
    this.fx.muzzle(m.x, m.y, t.gunWorldAng, t.spec.gun.caliber, brake);
    this.fx.fireDust(m.x, m.y, t.gunWorldAng, t.spec.gun.caliber);
    t.recoil = 1;
    audio.cannon(t.spec.gun.caliber, this.listenerDist(m));
    this.netOut?.push({ k: 'fire', id: t.id, s: shellIdx });
  }

  fxImpact(x: number, y: number, outcome: (typeof OUTCOMES)[number], dx: number, dy: number, caliber: number, explosive: number, reflect: V2 | undefined, splash: boolean, pid?: number, end = true) {
    const ld = this.listenerDist({ x, y });
    switch (outcome) {
      case 'ricochet':
        this.fx.sparks(x, y, Math.atan2(reflect?.y ?? -dy, reflect?.x ?? -dx), 10, 0.5, 22);
        audio.ricochet(ld);
        break;
      case 'nonpen':
        this.fx.sparks(x, y, Math.atan2(-dy, -dx), 8, 0.9, 14);
        this.fx.hitPuff(x, y, false);
        audio.clang(false, ld);
        break;
      case 'pen':
        this.fx.hitPuff(x, y, true);
        this.fx.sparks(x, y, Math.atan2(dy, dx), 8, 0.6, 16);
        audio.clang(true, ld);
        break;
      case 'barrel':
        this.fx.sparks(x, y, Math.atan2(-dy, -dx), 6, 1, 12);
        audio.clang(false, ld);
        break;
      case 'wreck':
        this.fx.impactDust(x, y);
        audio.thud(ld);
        break;
    }
    if (explosive > 0 && !splash) {
      this.fx.heBlast(x, y, explosive);
      audio.explosion(Math.cbrt(explosive) / 12, ld);
    }
    this.netOut?.push({ k: 'imp', x: r2(x), y: r2(y), o: OUTCOMES.indexOf(outcome), dx: r3(dx), dy: r3(dy), c: caliber, e: explosive, rx: reflect ? r3(reflect.x) : undefined, ry: reflect ? r3(reflect.y) : undefined, sp: splash ? 1 : undefined, pid, end: end ? 1 : 0 });
  }

  fxObstacle(x: number, y: number, dx: number, dy: number, caliber: number, explosive: number, pid?: number, soft = false) {
    const ld = this.listenerDist({ x, y });
    if (explosive > 0) {
      this.fx.heBlast(x, y, explosive);
      audio.explosion(Math.cbrt(explosive) / 10, ld);
    } else {
      // earth swallows the shell in a spray of dirt; stone and steel throw sparks
      this.fx.impactDust(x, y, soft || caliber > 80);
      if (soft) this.fx.impactDust(x - dx * 0.6, y - dy * 0.6, true);
      else this.fx.sparks(x, y, Math.atan2(-dy, -dx), 4, 0.9, 10);
      audio.thud(ld);
    }
    this.netOut?.push({ k: 'obs', x: r2(x), y: r2(y), dx: r3(dx), dy: r3(dy), c: caliber, e: explosive, pid, so: soft ? 1 : undefined });
  }

  /** Explosion, blown-off turret and wreck fire for a destroyed tank. */
  fxKill(t: Tank, how: 'cookoff' | 'crew' | 'fire', turretVel?: { vx: number; vy: number; spin: number; vh: number }, wreckFire?: number) {
    const tp = t.turretPos();
    const ld = this.listenerDist(t.pos);
    if (how === 'cookoff') {
      t.cookedOff = true;
      this.fx.explosion(tp.x, tp.y, 1.4);
      audio.explosion(1.5, ld);
      const a = rand.range(0, Math.PI * 2);
      const v = turretVel ?? { vx: Math.cos(a) * rand.range(2, 7), vy: Math.sin(a) * rand.range(2, 7), spin: rand.range(-4, 4), vh: rand.range(7, 12) };
      t.turretOff = { pos: { ...tp }, ang: t.turretWorldAng, vel: { x: v.vx, y: v.vy }, spin: v.spin, h: 0, vh: v.vh };
      t.wreckFire = wreckFire ?? rand.range(14, 22);
      this.netOut?.push({ k: 'kill', id: t.id, how: 0, vx: r2(v.vx), vy: r2(v.vy), spin: r2(v.spin), vh: r2(v.vh), wf: r2(t.wreckFire) });
    } else {
      this.fx.explosion(tp.x, tp.y, 0.6);
      audio.explosion(0.8, ld);
      t.wreckFire = wreckFire ?? (t.burning > 0 ? rand.range(8, 14) : rand.range(2, 5));
      this.netOut?.push({ k: 'kill', id: t.id, how: how === 'crew' ? 1 : 2, vx: 0, vy: 0, spin: 0, vh: 0, wf: r2(t.wreckFire) });
    }
    t.wreckSmoke = 90;
    t.burning = 0;
    this.stampDecal('scorch', t.pos.x, t.pos.y, t.bp.radius * 1.3);
  }

  stampDecal(kind: 'scorch' | 'crater', x: number, y: number, w: number, seed?: number) {
    this.hooks.stamp?.({ kind, x, y, ang: 0, w, h: 1, seed });
    this.netOut?.push({ k: 'decal', kind, x: r2(x), y: r2(y), w: r2(w), seed });
  }

  /** Client: apply a mirrored effect event. */
  applyFx(e: NetFx) {
    switch (e.k) {
      case 'fire': {
        const t = this.tanks.find((x) => x.id === e.id);
        if (t) {
          this.fxFire(t, e.s);
          if (t === this.player) t.fireReq = null;
        }
        break;
      }
      case 'shot': {
        const sh = this.tanks.find((x) => x.id === e.sid);
        const shell = sh?.spec.gun.shells[e.s];
        if (!sh || !shell) break;
        this.projectiles.push({ id: e.pid, org: { x: e.x, y: e.y }, x: e.x, y: e.y, dx: e.dx, dy: e.dy, speed: e.v, shell, shooter: sh, dist: e.r ? 3 : 0, age: 0, height: e.lo ? 0.9 : 0.1, penScale: 1, ignoreTank: e.r ? -1 : sh.id, ignoreBarrel: sh.id, ricochet: !!e.r });
        break;
      }
      case 'imp':
        if (e.pid !== undefined && e.end) this.projectiles = this.projectiles.filter((p) => p.id !== e.pid);
        this.fxImpact(e.x, e.y, OUTCOMES[e.o] ?? 'nonpen', e.dx, e.dy, e.c, e.e, e.rx !== undefined ? { x: e.rx, y: e.ry ?? 0 } : undefined, !!e.sp);
        break;
      case 'obs':
        if (e.pid !== undefined) this.projectiles = this.projectiles.filter((p) => p.id !== e.pid);
        this.fxObstacle(e.x, e.y, e.dx, e.dy, e.c, e.e, undefined, !!e.so);
        break;
      case 'gren':
        for (const g of e.g) this.grenades.push({ x0: g[0], y0: g[1], x1: g[2], y1: g[3], t: 0, T: g[4], team: e.team });
        break;
      case 'cloud':
        if (!this.map.smokes.some((s) => s.id === e.id)) this.map.smokes.push({ id: e.id, x: e.x, y: e.y, r: 1.5, rMax: e.rm, age: 0, life: e.life, team: e.team });
        break;
      case 'aimp':
        this.fxArty(e.x, e.y);
        break;
      case 'whis':
        audio.whistle(this.listenerDist({ x: e.x, y: e.y }));
        break;
      case 'bld': {
        const bld = this.map.buildings.find((x) => x.id === e.id);
        if (bld && e.st > bld.dmg) {
          setBuildingState(this.map, bld, e.st);
          this.fxBuilding(bld, e.st);
        }
        break;
      }
      case 'cdie': {
        const c = this.carriers.find((x) => x.id === e.id);
        if (c) {
          c.state = 'dead';
          c.t = 0;
          c.speed = 0;
          c.pos = { x: e.x, y: e.y };
        }
        this.fx.explosion(e.x, e.y, 0.75);
        audio.explosion(0.9, this.listenerDist({ x: e.x, y: e.y }));
        break;
      }
      case 'kill': {
        const t = this.tanks.find((x) => x.id === e.id);
        if (!t) break;
        t.alive = false;
        this.fxKill(t, e.how === 0 ? 'cookoff' : e.how === 1 ? 'crew' : 'fire', e.how === 0 ? { vx: e.vx, vy: e.vy, spin: e.spin, vh: e.vh } : undefined, e.wf);
        break;
      }
      case 'tree': {
        const tr = this.map.trees.find((x) => x.id === e.id);
        if (tr && tr.alive) {
          this.hooks.fellTree?.(tr, e.dir);
          tr.alive = false;
        }
        break;
      }
      case 'wall': {
        const w = this.map.walls.find((x) => x.id === e.id);
        if (w && w.alive) {
          w.alive = false;
          this.fx.impactDust((w.a.x + w.b.x) / 2, (w.a.y + w.b.y) / 2);
        }
        break;
      }
      case 'decal':
        this.hooks.stamp?.({ kind: e.kind, x: e.x, y: e.y, ang: 0, w: e.w, h: 1, seed: e.seed });
        break;
    }
  }

  // ------------------------------------------------------------------ simulation
  private spawnShell(t: Tank, idx: number) {
    const shell = t.spec.gun.shells[idx];
    const m = t.muzzle();
    const a = t.shotAngle();
    const id = this.projId++;
    const height = rand.next();
    this.projectiles.push({
      id,
      org: { x: m.x, y: m.y },
      x: m.x,
      y: m.y,
      dx: Math.cos(a),
      dy: Math.sin(a),
      speed: shell.velocity * this.shellSpeedScale,
      shell,
      shooter: t,
      dist: 0,
      age: 0,
      height,
      penScale: 1,
      ignoreTank: t.id,
      ignoreBarrel: t.id,
      ricochet: false,
    });
    this.fxFire(t, idx);
    this.netOut?.push({ k: 'shot', pid: id, sid: t.id, x: r2(m.x), y: r2(m.y), dx: r3(Math.cos(a)), dy: r3(Math.sin(a)), v: shell.velocity * this.shellSpeedScale, s: idx, lo: height >= LOW_SHOT ? 1 : undefined });
    t.revealedUntil = this.time + 2.5;
    // recoil nudges the tank backwards a little
    const kick = 0.25 * (t.spec.gun.caliber / 75) * (30 / t.spec.weight);
    t.speed -= kick;
    t.vel.x -= Math.cos(t.gunWorldAng) * kick;
    t.vel.y -= Math.sin(t.gunWorldAng) * kick;
    const s = this.slotOf(t);
    if (s) s.stats.shots++;
  }

  launchSmoke(t: Tank, ang: number): boolean {
    if (!t.canSmoke()) return false;
    t.smokeCharges--;
    t.smokeCd = 4;
    const tp = t.turretPos();
    const g: number[][] = [];
    for (const off of [-0.22, 0, 0.22]) {
      const a = ang + off;
      const d = 24 + rand.range(-2, 3);
      const gr = { x0: tp.x, y0: tp.y, x1: tp.x + Math.cos(a) * d, y1: tp.y + Math.sin(a) * d, t: 0, T: 0.7 + rand.range(0, 0.15), team: t.team };
      this.grenades.push(gr);
      g.push([r2(gr.x0), r2(gr.y0), r2(gr.x1), r2(gr.y1), r2(gr.T)]);
    }
    this.netOut?.push({ k: 'gren', team: t.team, g });
    audio.thud(this.listenerDist(tp));
    return true;
  }

  private updateSmoke(dt: number) {
    const keep = [];
    for (const g of this.grenades) {
      g.t += dt;
      if (g.t < g.T) {
        keep.push(g);
        continue;
      }
      if (this.mode !== 'replica') {
        const c = { id: this.smokeId++, x: g.x1, y: g.y1, r: 1.5, rMax: rand.range(7.5, 9), age: 0, life: SMOKE_LIFE, team: g.team };
        this.map.smokes.push(c);
        this.netOut?.push({ k: 'cloud', id: c.id, x: r2(c.x), y: r2(c.y), rm: r2(c.rMax), life: c.life, team: c.team });
      }
      this.fx.impactDust(g.x1, g.y1);
    }
    this.grenades = keep;
    const sm = this.map.smokes;
    for (const s of sm) {
      s.age += dt;
      s.r = s.rMax * Math.min(1, 0.25 + s.age / 2.5);
    }
    this.map.smokes = sm.filter((s) => s.age < s.life);
  }

  listenerDist(p: V2): number {
    const l = this.player?.pos ?? this.map.spawns[this.playerTeam][2];
    return dist(l, p);
  }

  private collideTank(t: Tank, contacts: Contact[]) {
    for (let pass = 0; pass < 2; pass++) {
      contacts.length = 0;
      const poly = t.bp.hullPoly.map((p) => toWorld(p, t.pos, t.ang));
      collideStatic(this.map, poly, t.pos, t.bp.radius, contacts);
      if (!contacts.length) break;
      const fwd = fromAngle(t.ang);
      for (const c of contacts) {
        if (c.tree) {
          if (Math.hypot(t.vel.x, t.vel.y) > 1.4 && t.spec.weight > 9 && t.alive) {
            if (this.mode === 'replica') continue; // the host decides; just don't get stuck
            const dir = t.ang + (t.speed < 0 ? Math.PI : 0) + rand.range(-0.4, 0.4);
            this.hooks.fellTree?.(c.tree, dir);
            c.tree.alive = false;
            this.netOut?.push({ k: 'tree', id: c.tree.id, dir: r3(dir) });
            t.speed *= 0.82;
            continue;
          }
        }
        if (c.wall && c.wall.kind === 'fence') {
          if (Math.hypot(t.vel.x, t.vel.y) > 0.5) {
            if (this.mode === 'replica') continue;
            c.wall.alive = false;
            this.fx.impactDust((c.wall.a.x + c.wall.b.x) / 2, (c.wall.a.y + c.wall.b.y) / 2);
            this.netOut?.push({ k: 'wall', id: c.wall.id });
            t.speed *= 0.9;
            continue;
          }
        }
        t.pos.x += c.nx * c.depth;
        t.pos.y += c.ny * c.depth;
        const into = (fwd.x * c.nx + fwd.y * c.ny) * Math.sign(t.speed);
        if (into < -0.2) t.speed *= 0.55;
        const vn = t.vel.x * c.nx + t.vel.y * c.ny;
        if (vn < 0) {
          t.vel.x -= c.nx * vn;
          t.vel.y -= c.ny * vn;
        }
      }
    }
  }

  private collide() {
    const contacts: Contact[] = [];
    for (const t of this.tanks) this.collideTank(t, contacts);
    // tank vs tank
    const ts = this.tanks;
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) {
        const a = ts[i];
        const b = ts[j];
        if (dist(a.pos, b.pos) > a.bp.radius + b.bp.radius) continue;
        const pa = a.bp.hullPoly.map((p) => toWorld(p, a.pos, a.ang));
        const pb = b.bp.hullPoly.map((p) => toWorld(p, b.pos, b.ang));
        const mtv = satMTV(pa, pb);
        if (!mtv) continue;
        const ma = a.spec.weight * (a.alive ? 1 : 3);
        const mb = b.spec.weight * (b.alive ? 1 : 3);
        const ka = mb / (ma + mb);
        const kb = ma / (ma + mb);
        a.pos.x += mtv.x * mtv.depth * ka;
        a.pos.y += mtv.y * mtv.depth * ka;
        b.pos.x -= mtv.x * mtv.depth * kb;
        b.pos.y -= mtv.y * mtv.depth * kb;
        a.speed *= 0.9;
        b.speed *= 0.9;
        // exchange momentum along the contact normal
        const rel = (a.vel.x - b.vel.x) * mtv.x + (a.vel.y - b.vel.y) * mtv.y;
        if (rel < 0) {
          a.vel.x -= mtv.x * rel * ka;
          a.vel.y -= mtv.y * rel * ka;
          b.vel.x += mtv.x * rel * kb;
          b.vel.y += mtv.y * rel * kb;
        }
      }
    }
  }

  private trackMarks(dt: number) {
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const v = Math.hypot(t.vel.x, t.vel.y) + Math.abs(t.angVel) * 2;
      t.trackAcc += v * dt;
      if (t.trackAcc < 0.32) continue;
      t.trackAcc = 0;
      const lk = t.spec.look;
      const off = lk.W / 2 - lk.trackW / 2;
      // sideways slip (drifting) leaves wide skid marks
      const lat = Math.abs(-Math.sin(t.ang) * t.vel.x + Math.cos(t.ang) * t.vel.y);
      const skid = lat > 1.2;
      for (const s of [-1, 1]) {
        const p = toWorld({ x: -lk.L * 0.3, y: s * off }, t.pos, t.ang);
        this.hooks.stamp?.({ kind: 'track', x: p.x, y: p.y, ang: t.ang, w: skid ? 0.6 : 0.32, h: lk.wheels ? lk.trackW * 0.7 : lk.trackW, a: skid ? 2.2 : 1 });
      }
      if (skid) {
        const p = toWorld({ x: -lk.L * 0.3, y: 0 }, t.pos, t.ang);
        this.fx.trackDust(p.x, p.y, 8);
      }
      if (rand.chance(0.35)) {
        const p = toWorld({ x: -lk.L * 0.5, y: rand.range(-1, 1) }, t.pos, t.ang);
        this.fx.trackDust(p.x, p.y, Math.hypot(t.vel.x, t.vel.y));
      }
      if (t.boostT > 0 && rand.chance(0.6)) {
        const p = toWorld({ x: -lk.L * 0.5, y: rand.range(-0.8, 0.8) }, t.pos, t.ang);
        this.fx.smoke(p.x, p.y, true, 0.8);
      }
    }
  }

  private updateProjectiles(dt: number) {
    const keep: Projectile[] = [];
    for (const p of this.projectiles) {
      p.age += dt;
      const step = p.speed * dt;
      const a = { x: p.x, y: p.y };
      const b = { x: p.x + p.dx * step, y: p.y + p.dy * step };
      let best: { t: number; tank: Tank; hit: ReturnType<typeof intersectTank> } | null = null;
      for (const t of this.tanks) {
        if (t.id === p.ignoreTank && p.age < 0.12) continue;
        const h = intersectTank(t, a, b, p.height, rand.next(), t.id === p.ignoreBarrel);
        if (h && (!best || h.t < best.t)) best = { t: h.t, tank: t, hit: h };
      }
      const obs = shellObstacleHit(this.map, a, b);
      // earthworks stop shells flying at hull height (hull-down targets behind them)
      const bc = p.height >= LOW_SHOT && !p.ricochet ? bermCrossing(this.map, a, b, p.org) : null;
      const bT = bc ? bc.t : null;
      // a hull nosing onto the bank's slope (within half its width past the crest) is still covered
      const slope = bc && step > 0 ? (bc.w / 2 + 0.6) / step : 0;
      if (bT !== null && (!best || bT < best.t + (best.hit?.part === 'hull' ? slope : 0)) && (!obs || bT < obs.t)) {
        let carrierFirst = false;
        for (const c of this.carriers) {
          const ht = c.state === 'dead' ? null : carrierHit(c, a, b);
          if (ht !== null && ht < bT) carrierFirst = true;
        }
        if (!carrierFirst) {
          this.obstacleImpact(p, a.x + (b.x - a.x) * bT, a.y + (b.y - a.y) * bT, true);
          continue;
        }
      }
      // thin-skinned crew carriers
      let cHit: { t: number; c: Carrier } | null = null;
      for (const c of this.carriers) {
        if (c.state === 'dead' || (c.team === p.shooter.team && p.age < 0.25)) continue;
        const ht = carrierHit(c, a, b);
        if (ht !== null && (!cHit || ht < cHit.t)) cHit = { t: ht, c };
      }
      if (cHit && (!best || cHit.t < best.t) && (!obs || cHit.t < obs.t)) {
        const x = a.x + (b.x - a.x) * cHit.t;
        const y = a.y + (b.y - a.y) * cHit.t;
        this.fxObstacle(x, y, p.dx, p.dy, p.shell.caliber, p.shell.type === 'HE' ? p.shell.explosive : 0, p.id);
        this.killCarrier(cHit.c);
        continue;
      }
      if (obs && (!best || obs.t < best.t)) {
        const x = a.x + (b.x - a.x) * obs.t;
        const y = a.y + (b.y - a.y) * obs.t;
        this.obstacleImpact(p, x, y, false, obs.building);
        continue;
      }
      if (best && best.hit) {
        const d = p.dist + step * best.t;
        const res = resolveImpact(p.shooter, best.tank, p.shell, best.hit, d, { x: p.dx, y: p.dy }, p.penScale);
        this.onImpact(p, best.tank, res);
        if (res.outcome === 'ricochet' && res.reflect) {
          const w = res.world;
          const np = { ...p, id: this.projId++, org: { x: w.x, y: w.y }, x: w.x + res.reflect.x * 0.2, y: w.y + res.reflect.y * 0.2, dx: res.reflect.x, dy: res.reflect.y, speed: p.speed * 0.7, penScale: p.penScale * 0.55, ignoreTank: best.tank.id, age: 0, ricochet: true, dist: d };
          keep.push(np);
          const si = p.shooter.spec.gun.shells.indexOf(p.shell);
          this.netOut?.push({ k: 'shot', pid: np.id, sid: p.shooter.id, x: r2(np.x), y: r2(np.y), dx: r3(np.dx), dy: r3(np.dy), v: r2(np.speed), s: Math.max(0, si), r: 1, lo: np.height >= LOW_SHOT ? 1 : undefined });
        } else if (res.outcome === 'barrel') {
          const w = res.world;
          keep.push({ ...p, x: w.x + p.dx * 0.3, y: w.y + p.dy * 0.3, ignoreBarrel: best.tank.id, penScale: p.penScale * 0.92, dist: d });
        }
        continue;
      }
      p.x = b.x;
      p.y = b.y;
      p.dist += step;
      if (p.dist > 760 || p.x < -50 || p.y < -50 || p.x > this.map.size + 50 || p.y > this.map.size + 50) continue;
      keep.push(p);
    }
    this.projectiles = keep;
  }

  private obstacleImpact(p: Projectile, x: number, y: number, soft = false, bld?: Building) {
    const he = p.shell.type === 'HE';
    this.fxObstacle(x, y, p.dx, p.dy, p.shell.caliber, he ? p.shell.explosive : 0, p.id, soft);
    if (bld) this.hitBuilding(bld, structDamage(p.shell.caliber, p.shell.explosive, he), p.shooter, x, y);
    if (he) {
      this.stampDecal('crater', x, y, 0.6 + Math.cbrt(p.shell.explosive) * 0.12, Math.floor(x * 31 + y));
      this.splash(p, x, y);
    }
  }

  /** HE shells exploding near (not on) a tank can still damage tracks / open-top crews. */
  private splash(p: Projectile, x: number, y: number, exclude?: Set<number>) {
    const r = 1.5 + Math.cbrt(p.shell.explosive) * 0.15;
    for (const c of this.carriers) {
      if (c.state !== 'dead' && dist(c.pos, { x, y }) < r + CARRIER.L * 0.35) this.killCarrier(c);
    }
    for (const t of this.tanks) {
      if (!t.alive || exclude?.has(t.id)) continue;
      const d = dist(t.pos, { x, y }) - t.bp.radius * 0.7;
      if (d > r) continue;
      const dir = { x: t.pos.x - x, y: t.pos.y - y };
      const l = Math.hypot(dir.x, dir.y) || 1;
      const dw = { x: dir.x / l, y: dir.y / l };
      const hit = intersectTank(t, { x, y }, { x: x + dw.x * 10, y: y + dw.y * 10 }, 0.9, 1, true);
      if (!hit) continue;
      const res = resolveImpact(p.shooter, t, { ...p.shell, explosive: p.shell.explosive * 0.6 }, hit, 0, dw, 0.5);
      this.onImpact(p, t, res, true);
    }
  }

  private onImpact(p: Projectile, target: Tank, res: ImpactResult, splash = false) {
    const w = res.world;
    const shooter = p.shooter;
    target.hitFlash = 0.3;
    this.fxImpact(w.x, w.y, res.outcome, p.dx, p.dy, p.shell.caliber, p.shell.type === 'HE' ? p.shell.explosive : 0, res.reflect, splash, splash ? undefined : p.id, res.outcome !== 'barrel');
    if (res.outcome === 'wreck') return;
    if (!splash || res.damage > 0) this.emit({ type: 'hit', res, shooter, target });

    // rewards for human shooters
    const ss = this.slotOf(shooter);
    if (ss && target.team !== shooter.team && res.damage > 0) {
      const crit = res.changed.some((id) => res.states[id] === 'destroyed');
      if (crit) {
        ss.stats.crits++;
        this.addReward(ss, 'Critical hit', 30, 150, target.pos, '#e8c070');
      } else {
        ss.stats.hits++;
        this.addReward(ss, 'Hit', 15, 80, target.pos, '#d8c8a0');
      }
      ss.stats.damage += res.damage;
    }
    const ts = this.slotOf(target);
    if (ts) {
      ts.lastHit = { res, by: shooter };
      for (const m of res.messages.slice(0, 3)) this.emit({ type: 'notice', text: m, color: m.includes('Fire') || m.includes('detonation') ? '#ff8a5c' : '#ffd27a', to: ts.key });
    }
    if (res.killed && target.alive) this.kill(target, shooter, res.cookoff ? 'cookoff' : 'crew', res);
  }

  kill(target: Tank, killer: Tank | null, how: 'cookoff' | 'crew' | 'fire', res: ImpactResult | null) {
    target.alive = false;
    target.deathTime = this.time;
    target.throttle = 0;
    this.fxKill(target, how);
    this.tickets[target.team] = Math.max(0, this.tickets[target.team] - KILL_TICKETS);

    if (killer && killer.team !== target.team) {
      killer.kills++;
      if (!this.supportKill) this.addStreak(killer);
      const ks = this.slotOf(killer);
      if (ks) {
        ks.stats.kills++;
        const ratio = clamp(target.spec.br / Math.max(1, killer.spec.br), 0.6, 1.6);
        const rp = Math.round((300 * Math.sqrt(ratio)) / 5) * 5 + (how === 'cookoff' ? 50 : 0);
        this.addReward(ks, 'Target destroyed', rp, rp * 5, target.pos, '#f2a93b', true);
      }
    }
    const t0 = performance.now() / 1000;
    for (const [id, at] of target.damagers) {
      if (killer && id === killer.id) continue;
      if (t0 - at > 30) continue;
      const a = this.tanks.find((x) => x.id === id);
      if (!a || a.team === target.team) continue;
      a.assists++;
      const as = this.slotOf(a);
      if (as) {
        as.stats.assists++;
        this.addReward(as, 'Assist', 100, 400, target.pos, '#e0c070');
      }
    }
    this.emit({ type: 'feed', killer, victim: target, how });

    const vs = this.slotOf(target);
    if (vs) {
      vs.dead = true;
      vs.deadAt = this.time;
      this.ais.delete(target.id);
      this.emit({ type: 'playerDead', killer, res: res ?? vs.lastHit?.res ?? null, to: vs.key });
    } else if (this.ais.has(target.id)) {
      this.ais.delete(target.id);
      if (this.reinforcements[target.team] > 0) {
        this.reinforcements[target.team]--;
        this.respawnQueue.push({ team: target.team, at: this.time + 10 });
      }
    }
  }

  private addStreak(t: Tank) {
    t.streak++;
    const st = this.supportOf(t);
    if (t.streak % RECON_EVERY === 0 && st.recon < 1) {
      st.recon = 1;
      if (t.slot) this.emit({ type: 'notice', text: 'Recon plane ready', color: '#9fd3ff', to: t.slot });
    }
    if (t.streak % ARTY_EVERY === 0 && st.arty < 1) {
      st.arty = 1;
      if (t.slot) this.emit({ type: 'notice', text: 'Artillery strike ready', color: '#ffd27a', to: t.slot });
    }
  }

  private updateFires(dt: number) {
    this.fireTimer -= dt;
    const tick = this.fireTimer <= 0;
    if (tick) this.fireTimer = 1;
    for (const t of this.tanks) {
      if (!t.alive || t.burning <= 0) continue;
      t.burning -= dt;
      const fp = toWorld(t.fireSource, t.pos, t.ang);
      if (rand.chance(dt * 30)) this.fx.fire(fp.x, fp.y, 1);
      if (rand.chance(dt * 6)) this.fx.smoke(fp.x, fp.y, true, 1.6);
      if (tick && this.mode !== 'replica') {
        const r = fireTick(t);
        if (r.killed) {
          const killer = t.lastHitBy;
          this.kill(t, killer, r.cookoff ? 'cookoff' : 'fire', null);
        }
      }
      if (t.burning <= 0 && t.slot && this.mode !== 'replica') this.emit({ type: 'notice', text: 'Fire burned out', color: '#9fd3ff', to: t.slot });
    }
  }

  private updateWrecks(dt: number) {
    for (const t of this.tanks) {
      if (t.alive) {
        // engine smoke when damaged
        const e = t.mods.find((m) => m.def.kind === 'engine');
        if (e && e.hp < e.def.maxHp * 0.55 && rand.chance(dt * 4)) {
          const p = toWorld({ x: -t.bp.L * 0.35, y: 0 }, t.pos, t.ang);
          this.fx.smoke(p.x, p.y, e.hp <= 0, 1.2);
        }
        continue;
      }
      if (t.turretOff && (t.turretOff.h > 0 || t.turretOff.vh > 0)) {
        const o = t.turretOff;
        o.pos.x += o.vel.x * dt;
        o.pos.y += o.vel.y * dt;
        o.ang += o.spin * dt;
        o.h += o.vh * dt;
        o.vh -= 22 * dt;
        if (o.h <= 0) {
          o.h = 0;
          o.vh = 0;
          o.vel = { x: 0, y: 0 };
          o.spin = 0;
          this.fx.impactDust(o.pos.x, o.pos.y, true);
        }
      }
      const c = t.pos;
      if (t.wreckFire > 0) {
        t.wreckFire -= dt;
        if (rand.chance(dt * 40)) this.fx.fire(c.x + rand.range(-1.5, 1.5), c.y + rand.range(-1.2, 1.2), 1.4);
        if (rand.chance(dt * 10)) this.fx.smoke(c.x, c.y, true, 2.2);
      } else if (t.wreckSmoke > 0) {
        t.wreckSmoke -= dt;
        if (rand.chance(dt * 3)) this.fx.smoke(c.x, c.y, true, 1.8);
      } else if (rand.chance(dt * 0.6)) this.fx.smoke(c.x, c.y, false, 1.4);
    }
  }

  private updateSpotting(now: number) {
    for (const team of [0, 1] as const) {
      const recon = this.recons.some((r) => r.team === team);
      const sc = this.spottedCarriers[team];
      sc.clear();
      for (const c of this.carriers) if (c.team !== team && c.state !== 'dead' && (recon || this.teamSees(team, c.pos))) sc.add(c.id);
    }
    for (const team of [0, 1] as const) {
      const set = this.spotted[team];
      set.clear();
      const recon = this.recons.some((r) => r.team === team);
      for (const e of this.tanks) {
        if (!e.alive || e.team === team) continue;
        if (recon) {
          set.add(e.id);
          e.lastSeenPos = { ...e.pos };
          continue;
        }
        for (const v of this.tanks) {
          if (!v.alive || v.team !== team) continue;
          if (canSee(this.map, v, e, now)) {
            set.add(e.id);
            e.lastSeenPos = { ...e.pos };
            break;
          }
        }
      }
    }
  }

  private updateCapture(dt: number) {
    const c = this.map.capture;
    const n = [0, 0];
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (dist(t.pos, c) < c.r) n[t.team]++;
    }
    this.capture.inside = n;
    const cap = this.capture;
    cap.contested = n[0] > 0 && n[1] > 0;
    if (!cap.contested && (n[0] > 0 || n[1] > 0)) {
      const team = n[0] > 0 ? 0 : 1;
      const dir = team === 0 ? 1 : -1;
      const rate = (Math.min(3, n[team]) / 14) * dt;
      const before = cap.progress;
      cap.progress = clamp(cap.progress + dir * rate, -1, 1);
      // neutralize when crossing zero
      if (cap.owner !== -1 && cap.owner !== team && Math.sign(before) !== Math.sign(cap.progress) && before !== 0) {
        cap.owner = -1;
        this.emit({ type: 'notice', text: 'Point A neutralized', color: '#dddddd' });
      }
      if (Math.abs(cap.progress) >= 1 && cap.owner !== team) {
        cap.owner = team as 0 | 1;
        this.emit({ type: 'captured', team: team as 0 | 1 });
        for (const s of this.slots) {
          const p = s.tank;
          if (p && p.alive && p.team === team && dist(p.pos, c) < c.r) {
            s.stats.caps++;
            this.addReward(s, 'Point captured', 200, 800, p.pos, '#7fc3ff');
          }
        }
      }
    }
    if (cap.owner >= 0) {
      const enemy = cap.owner === 0 ? 1 : 0;
      this.tickets[enemy] = Math.max(0, this.tickets[enemy] - 1.8 * dt);
    }
  }

  private updateRespawns(now: number) {
    const keep = [];
    for (const r of this.respawnQueue) {
      if (now < r.at) {
        keep.push(r);
        continue;
      }
      const sp = this.map.spawns[r.team][Math.floor(rand.next() * 5)];
      const pos = this.freeSpawn(sp);
      this.spawnAI(r.team, { x: pos.x, y: pos.y, ang: sp.ang }, AI_NAMES[Math.floor(rand.next() * AI_NAMES.length)], Math.floor(rand.next() * 5));
    }
    this.respawnQueue = keep;
  }

  private checkEnd() {
    if (this.phase === 'ended') return;
    const pending = (team: 0 | 1) =>
      this.tanks.some((t) => t.alive && t.team === team) ||
      this.respawnQueue.some((r) => r.team === team) ||
      this.slots.some((s) => s.team === team && s.dead && s.connected && this.availableLineup(s).length > 0);
    let winner: 0 | 1 | null = null;
    if (this.tickets[1] <= 0 || !pending(1)) winner = 0;
    else if (this.tickets[0] <= 0 || !pending(0)) winner = 1;
    else if (this.time >= BATTLE_TIME) winner = this.tickets[0] >= this.tickets[1] ? 0 : 1;
    if (winner !== null) this.endWith(winner);
  }

  /** Finish the battle; `winner` is the winning team. */
  endWith(winner: 0 | 1) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.winner = winner;
    for (const s of this.slots) {
      if (s.team === winner) s.rewards.push({ label: 'Victory', rp: 500, cr: 3000 });
      else s.rewards.push({ label: 'Participation', rp: 150, cr: 1000 });
    }
    this.emit({ type: 'end' });
  }

  /** Local player gives up: count as a defeat for them. */
  end(res: 'victory' | 'defeat') {
    const pt = this.playerTeam;
    this.endWith(res === 'victory' ? pt : pt === 0 ? 1 : 0);
  }

  totals(slot: PlayerSlot | undefined = this.local): { rp: number; cr: number } {
    let rp = 0;
    let cr = 0;
    if (!slot) return { rp, cr };
    for (const r of slot.rewards) {
      rp += r.rp;
      cr += r.cr;
    }
    if (this.winner !== null && this.winner === slot.team) {
      rp = Math.round(rp * 1.2);
      cr = Math.round(cr * 1.2);
    }
    return { rp, cr };
  }

  // ------------------------------------------------------------------ replica (multiplayer client)
  /** Snapshot targets are written into `tank.net` by the client session. */
  private replicaUpdate(dt: number) {
    this.time += dt;
    const me = this.player;
    const contacts: Contact[] = [];
    for (const t of this.tanks) {
      const n = t.net;
      if (n) {
        // the snapshot target keeps moving along the reported velocity until the next one arrives
        n.x += n.vx * dt;
        n.y += n.vy * dt;
      }
      if (t === me && t.alive) {
        // client-side prediction for our own tank, gently corrected toward the host
        const prevReloaded = t.isReloaded();
        t.terrainMul = onBerm(this.map, t.pos) ? 0.5 : 1;
        t.update(dt, this.time);
        if (!prevReloaded && t.isReloaded()) audio.reloadDone();
        this.collideTank(t, contacts);
        // keep our predicted tank out of the others (the host resolves the real collision)
        const pa = t.bp.hullPoly.map((q) => toWorld(q, t.pos, t.ang));
        for (const o of this.tanks) {
          if (o === t || dist(o.pos, t.pos) > o.bp.radius + t.bp.radius) continue;
          const mtv = satMTV(pa, o.bp.hullPoly.map((q) => toWorld(q, o.pos, o.ang)));
          if (!mtv) continue;
          t.pos.x += mtv.x * mtv.depth;
          t.pos.y += mtv.y * mtv.depth;
          const vn = t.vel.x * mtv.x + t.vel.y * mtv.y;
          if (vn < 0) {
            t.vel.x -= mtv.x * vn;
            t.vel.y -= mtv.y * vn;
          }
        }
        if (n) {
          const ex = n.x - t.pos.x;
          const ey = n.y - t.pos.y;
          const err = Math.hypot(ex, ey);
          if (err > 6) {
            t.pos.x = n.x;
            t.pos.y = n.y;
          } else {
            const k = Math.min(1, dt * 3);
            t.pos.x += ex * k;
            t.pos.y += ey * k;
          }
          const ea = angDiff(t.ang, n.ang);
          if (Math.abs(ea) > 0.6) t.ang = n.ang;
          else t.ang += ea * Math.min(1, dt * 3);
        }
        continue;
      }
      if (!n) continue;
      // remote tanks: smooth toward the (extrapolated) snapshot
      const k = Math.min(1, dt * 10);
      const px = t.pos.x;
      const py = t.pos.y;
      t.pos.x += (n.x - t.pos.x) * k;
      t.pos.y += (n.y - t.pos.y) * k;
      t.vel.x = (t.pos.x - px) / Math.max(dt, 1e-3);
      t.vel.y = (t.pos.y - py) / Math.max(dt, 1e-3);
      t.ang += angDiff(t.ang, n.ang) * k;
      t.turretRel += angDiff(t.turretRel, n.tRel) * k;
      t.gunRel += (n.gRel - t.gunRel) * k;
      t.speed = n.speed;
      t.recoil = Math.max(0, t.recoil - dt * 3.5);
    }
    if (me && me.fireReq && this.time > me.fireReq.until) me.fireReq = null;
    // shells fly straight; they stop (visually) at the first tank or obstacle and the host's impact event plays the effects
    const keep: Projectile[] = [];
    for (const p of this.projectiles) {
      p.age += dt;
      const step = p.speed * dt;
      const a = { x: p.x, y: p.y };
      const b = { x: p.x + p.dx * step, y: p.y + p.dy * step };
      let stop = !!shellObstacleHit(this.map, a, b) || (p.height >= LOW_SHOT && !p.ricochet && bermCrossing(this.map, a, b, p.org) !== null);
      for (const t of this.tanks) {
        if (stop) break;
        if (t.id === p.ignoreTank && p.age < 0.12) continue;
        if (intersectTank(t, a, b, 0.5, 1, true)) stop = true;
      }
      if (stop) continue;
      p.x = b.x;
      p.y = b.y;
      p.dist += step;
      if (p.dist > 760 || p.x < -50 || p.y < -50 || p.x > this.map.size + 50 || p.y > this.map.size + 50) continue;
      keep.push(p);
    }
    this.projectiles = keep;
    // carriers glide toward their snapshot pose
    for (const c of this.carriers) {
      const n = c.net;
      if (n) {
        if (c.state !== 'dead') {
          n.x += Math.cos(n.ang) * c.speed * dt;
          n.y += Math.sin(n.ang) * c.speed * dt;
        }
        const k = Math.min(1, dt * 8);
        c.pos.x += (n.x - c.pos.x) * k;
        c.pos.y += (n.y - c.pos.y) * k;
        c.ang += angDiff(c.ang, n.ang) * k;
      }
      if (c.state === 'park' || c.state === 'dead') c.t += dt;
    }
    for (const r of this.recons) r.t += dt;
    for (const a of this.artys) a.t += dt;
    this.trackMarks(dt);
    this.updateSmoke(dt);
    this.updateFires(dt);
    this.updateWrecks(dt);
    this.carrierFx(dt);
    this.fx.update(dt);
    this.updateVision(dt);
  }

  /** Approx. local dir helper used by HUD. */
  localDir(t: Tank, d: V2): V2 {
    return dirToLocal(d, t.ang);
  }
}

function r2(v: number) {
  return Math.round(v * 100) / 100;
}
function r3(v: number) {
  return Math.round(v * 1000) / 1000;
}

export { DEG };
