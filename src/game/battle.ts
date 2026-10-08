// Battle simulation: tanks, projectiles, capture point, spotting, scoring.

import { type V2, DEG, clamp, dist, fromAngle, satMTV, toWorld, dirToLocal } from '../core/math';
import { rand } from '../core/rng';
import { audio } from '../core/audio';
import { VEHICLES, getVehicle, type ShellSpec, type VehicleSpec } from '../data/vehicles';
import { AIController } from './ai';
import { type ImpactResult, fireTick, intersectTank, resolveImpact } from './armor';
import { Effects } from './effects';
import { type GameMap, type Tree, buildMap, collideStatic, MAPS, shellObstacleHit, type Contact } from './map';
import { NavGrid } from './nav';
import { Tank } from './tank';
import { canSee, visibilityPolygon } from './vision';

export interface Projectile {
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

export type BattleEvent =
  | { type: 'hit'; res: ImpactResult; shooter: Tank; target: Tank }
  | { type: 'popup'; text: string; x: number; y: number; color: string; big?: boolean }
  | { type: 'feed'; killer: Tank | null; victim: Tank; how: string }
  | { type: 'notice'; text: string; color?: string }
  | { type: 'captured'; team: 0 | 1 }
  | { type: 'playerDead'; killer: Tank | null; res: ImpactResult | null }
  | { type: 'end' };

export interface RewardLine {
  label: string;
  rp: number;
  cr: number;
}

export interface BattleConfig {
  mapId: string;
  lineup: string[];
  playerName: string;
  seed?: number;
}

export interface BattleHooks {
  stamp?: (d: { kind: 'track' | 'scorch' | 'crater' | 'fallen'; x: number; y: number; ang: number; w: number; h: number; seed?: number }) => void;
  fellTree?: (t: Tree, dir: number) => void;
}

const AI_NAMES = ['Anvil', 'Badger', 'Cobalt', 'Drake', 'Ember', 'Falcon', 'Granite', 'Hammer', 'Iron', 'Jackal', 'Kodiak', 'Lynx', 'Mason', 'Nomad', 'Onyx', 'Pike', 'Quarry', 'Raven', 'Sable', 'Talon', 'Ursa', 'Viper', 'Wolf', 'Yukon', 'Zephyr', 'Bishop', 'Cutter', 'Dusty', 'Flint', 'Gunner'];

export const TICKETS = 650;
export const KILL_TICKETS = 45;
export const BATTLE_TIME = 12 * 60;

export class Battle {
  cfg: BattleConfig;
  map: GameMap;
  nav: NavGrid;
  fx: Effects;
  tanks: Tank[] = [];
  projectiles: Projectile[] = [];
  ais = new Map<number, AIController>();
  player: Tank | null = null;
  playerTeam: 0 | 1 = 0;
  time = 0;
  shellSpeedScale = 0.4;
  events: BattleEvent[] = [];
  hooks: BattleHooks = {};

  capture = { owner: -1 as -1 | 0 | 1, progress: 0, contested: false, inside: [0, 0] };
  tickets: [number, number] = [TICKETS, TICKETS];
  reinforcements: [number, number] = [6, 6];
  respawnQueue: Array<{ team: 0 | 1; at: number }> = [];
  usedLineup = new Set<string>();
  state: 'playing' | 'dead' | 'ended' = 'playing';
  result: 'victory' | 'defeat' | null = null;
  deadAt = 0;
  lastPlayerHit: { res: ImpactResult; by: Tank } | null = null;

  spotted: [Set<number>, Set<number>] = [new Set(), new Set()];
  private spotTimer = 0;
  visionPoly: V2[] = [];
  private visionTimer = 0;
  private fireTimer = 0;

  rewards: RewardLine[] = [];
  stats = { kills: 0, assists: 0, hits: 0, crits: 0, caps: 0, damage: 0, shots: 0 };
  battleBR: number;
  enemyPool: VehicleSpec[];

  constructor(cfg: BattleConfig, hooks: BattleHooks = {}) {
    this.cfg = cfg;
    this.hooks = hooks;
    const def = MAPS.find((m) => m.id === cfg.mapId) ?? MAPS[0];
    this.map = buildMap(def, cfg.seed ?? 1234);
    this.nav = new NavGrid(this.map);
    this.fx = new Effects(this.map.theme);
    this.playerTeam = rand.chance(0.5) ? 0 : 1;

    const lineup = cfg.lineup.map(getVehicle);
    this.battleBR = Math.max(...lineup.map((v) => v.br));
    let pool = VEHICLES.filter((v) => Math.abs(v.br - this.battleBR) <= 1.0);
    if (pool.length < 4) pool = VEHICLES.filter((v) => Math.abs(v.br - this.battleBR) <= 1.7);
    this.enemyPool = pool;

    // spawn teams
    const names = [...AI_NAMES].sort(() => rand.next() - 0.5);
    for (const team of [0, 1] as const) {
      const spawns = this.map.spawns[team];
      for (let i = 0; i < 5; i++) {
        const s = spawns[i];
        if (team === this.playerTeam && i === 2) {
          const spec = lineup[0];
          const p = new Tank(spec, team, { x: s.x, y: s.y }, s.ang, cfg.playerName);
          p.isPlayer = true;
          this.player = p;
          this.usedLineup.add(spec.id);
          this.tanks.push(p);
        } else {
          this.spawnAI(team, s, names.pop() ?? 'Tank', i);
        }
      }
    }
  }

  private spawnAI(team: 0 | 1, s: { x: number; y: number; ang: number }, name: string, i: number) {
    const spec = this.enemyPool[Math.floor(rand.next() * this.enemyPool.length)];
    const t = new Tank(spec, team, { x: s.x + rand.range(-2, 2), y: s.y + rand.range(-2, 2) }, s.ang, name);
    const roles = ['capper', 'support', 'capper', 'flank', 'support'] as const;
    this.ais.set(t.id, new AIController(t, this, roles[i % roles.length]));
    this.tanks.push(t);
    return t;
  }

  emit(e: BattleEvent) {
    this.events.push(e);
  }

  isSpotted(team: 0 | 1, t: Tank): boolean {
    return this.spotted[team].has(t.id);
  }

  addReward(label: string, rp: number, cr: number, at?: V2, color = '#f0b43c', big = false) {
    this.rewards.push({ label, rp, cr });
    if (at) this.emit({ type: 'popup', text: `${label} +${rp} RP`, x: at.x, y: at.y, color, big });
  }

  // ------------------------------------------------------------------ player API
  playerFire() {
    if (this.player) this.player.wantFire = true;
  }

  extinguish(t: Tank) {
    if (t.burning <= 0 || t.extinguishCd > 0) return false;
    t.burning = 0;
    t.extinguishCd = 30;
    if (t.isPlayer) this.emit({ type: 'notice', text: 'Fire extinguished', color: '#9fd3ff' });
    return true;
  }

  availableLineup(): VehicleSpec[] {
    return this.cfg.lineup.filter((id) => !this.usedLineup.has(id)).map(getVehicle);
  }

  respawnPlayer(id: string) {
    if (this.usedLineup.has(id) || this.state !== 'dead') return;
    const spec = getVehicle(id);
    const sp = this.map.spawns[this.playerTeam][2];
    const pos = this.freeSpawn(sp);
    const p = new Tank(spec, this.playerTeam, pos, sp.ang, this.cfg.playerName);
    p.isPlayer = true;
    this.player = p;
    this.usedLineup.add(id);
    this.tanks.push(p);
    this.state = 'playing';
    this.lastPlayerHit = null;
  }

  private freeSpawn(sp: { x: number; y: number }): V2 {
    for (let i = 0; i < 20; i++) {
      const p = { x: sp.x + rand.range(-14, 14), y: sp.y + rand.range(-30, 30) };
      if (!this.nav.free(p)) continue;
      if (this.tanks.some((t) => dist(t.pos, p) < 9)) continue;
      return p;
    }
    return { x: sp.x, y: sp.y };
  }

  // ------------------------------------------------------------------ update
  update(dt: number) {
    if (this.state === 'ended') {
      this.fx.update(dt);
      return;
    }
    this.time += dt;
    const now = this.time;

    for (const ai of this.ais.values()) ai.update(dt, now);

    for (const t of this.tanks) {
      const prevReloaded = t.isReloaded();
      t.update(dt, now);
      if (t.isPlayer && !prevReloaded && t.isReloaded() && t.alive) audio.reloadDone();
    }
    this.collide();
    this.trackMarks(dt);

    // firing
    for (const t of this.tanks) {
      if (!t.wantFire) continue;
      t.wantFire = false;
      if (!t.alive) continue;
      const idx = t.fire();
      if (idx < 0) continue;
      this.spawnShell(t, t.spec.gun.shells[idx]);
    }

    this.updateProjectiles(dt);
    this.updateFires(dt);
    this.updateWrecks(dt);
    this.fx.update(dt);

    this.spotTimer -= dt;
    if (this.spotTimer <= 0) {
      this.spotTimer = 0.2;
      this.updateSpotting(now);
    }
    this.visionTimer -= dt;
    if (this.visionTimer <= 0 && this.player) {
      this.visionTimer = 1 / 30;
      const p = this.player;
      const vc = p.visionCone();
      this.visionPoly = visibilityPolygon(this.map, p.turretPos(), p.gunWorldAng, vc.half, vc.range, vc.near);
    }

    this.updateCapture(dt);
    this.updateRespawns(now);
    this.checkEnd();
  }

  private spawnShell(t: Tank, shell: ShellSpec) {
    const m = t.muzzle();
    const a = t.shotAngle();
    this.projectiles.push({
      x: m.x,
      y: m.y,
      dx: Math.cos(a),
      dy: Math.sin(a),
      speed: shell.velocity * this.shellSpeedScale,
      shell,
      shooter: t,
      dist: 0,
      age: 0,
      height: rand.next(),
      penScale: 1,
      ignoreTank: t.id,
      ignoreBarrel: t.id,
      ricochet: false,
    });
    const brake = t.spec.look.brake !== 'none';
    this.fx.muzzle(m.x, m.y, t.gunWorldAng, t.spec.gun.caliber, brake);
    this.fx.fireDust(m.x, m.y, t.gunWorldAng, t.spec.gun.caliber);
    t.revealedUntil = this.time + 2.5;
    // recoil nudges the tank backwards a little
    t.speed -= 0.25 * (t.spec.gun.caliber / 75) * (30 / t.spec.weight);
    if (t.isPlayer) this.stats.shots++;
    audio.cannon(t.spec.gun.caliber, this.listenerDist(m));
  }

  listenerDist(p: V2): number {
    const l = this.player?.pos ?? this.map.spawns[this.playerTeam][2];
    return dist(l, p);
  }

  private collide() {
    const contacts: Contact[] = [];
    for (const t of this.tanks) {
      if (t.turretOff && !t.alive) {
        /* wrecks still collide */
      }
      for (let pass = 0; pass < 2; pass++) {
        contacts.length = 0;
        const poly = t.bp.hullPoly.map((p) => toWorld(p, t.pos, t.ang));
        collideStatic(this.map, poly, t.pos, t.bp.radius, contacts);
        if (!contacts.length) break;
        const fwd = fromAngle(t.ang);
        for (const c of contacts) {
          if (c.tree) {
            if (Math.abs(t.speed) > 1.4 && t.spec.weight > 9 && t.alive) {
              const dir = t.ang + (t.speed < 0 ? Math.PI : 0) + rand.range(-0.4, 0.4);
              this.hooks.fellTree?.(c.tree, dir);
              c.tree.alive = false;
              t.speed *= 0.82;
              continue;
            }
          }
          if (c.wall && c.wall.kind === 'fence') {
            if (Math.abs(t.speed) > 0.5) {
              c.wall.alive = false;
              this.fx.impactDust((c.wall.a.x + c.wall.b.x) / 2, (c.wall.a.y + c.wall.b.y) / 2);
              t.speed *= 0.9;
              continue;
            }
          }
          t.pos.x += c.nx * c.depth;
          t.pos.y += c.ny * c.depth;
          const into = (fwd.x * c.nx + fwd.y * c.ny) * Math.sign(t.speed);
          if (into < -0.2) t.speed *= 0.55;
        }
      }
    }
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
      }
    }
  }

  private trackMarks(dt: number) {
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const v = Math.abs(t.speed) + Math.abs(t.angVel) * 2;
      t.trackAcc += v * dt;
      if (t.trackAcc < 0.32) continue;
      t.trackAcc = 0;
      const lk = t.spec.look;
      const off = lk.W / 2 - lk.trackW / 2;
      for (const s of [-1, 1]) {
        const p = toWorld({ x: -lk.L * 0.3, y: s * off }, t.pos, t.ang);
        this.hooks.stamp?.({ kind: 'track', x: p.x, y: p.y, ang: t.ang, w: 0.32, h: lk.wheels ? lk.trackW * 0.7 : lk.trackW });
      }
      if (rand.chance(0.35)) {
        const p = toWorld({ x: -lk.L * 0.5, y: rand.range(-1, 1) }, t.pos, t.ang);
        this.fx.trackDust(p.x, p.y, Math.abs(t.speed));
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
      if (obs && (!best || obs.t < best.t)) {
        const x = a.x + (b.x - a.x) * obs.t;
        const y = a.y + (b.y - a.y) * obs.t;
        this.obstacleImpact(p, x, y);
        continue;
      }
      if (best && best.hit) {
        const d = p.dist + step * best.t;
        const res = resolveImpact(p.shooter, best.tank, p.shell, best.hit, d, { x: p.dx, y: p.dy }, p.penScale);
        this.onImpact(p, best.tank, res);
        if (res.outcome === 'ricochet' && res.reflect) {
          const w = res.world;
          keep.push({ ...p, x: w.x + res.reflect.x * 0.2, y: w.y + res.reflect.y * 0.2, dx: res.reflect.x, dy: res.reflect.y, speed: p.speed * 0.7, penScale: p.penScale * 0.55, ignoreTank: best.tank.id, age: 0, ricochet: true, dist: d });
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

  private obstacleImpact(p: Projectile, x: number, y: number) {
    if (p.shell.type === 'HE') {
      this.fx.heBlast(x, y, p.shell.explosive);
      this.hooks.stamp?.({ kind: 'crater', x, y, ang: 0, w: 0.6 + Math.cbrt(p.shell.explosive) * 0.12, h: 1, seed: Math.floor(x * 31 + y) });
      audio.explosion(Math.cbrt(p.shell.explosive) / 10, this.listenerDist({ x, y }));
      // splash on nearby tanks
      this.splash(p, x, y);
    } else {
      this.fx.impactDust(x, y, p.shell.caliber > 80);
      this.fx.sparks(x, y, Math.atan2(-p.dy, -p.dx), 4, 0.9, 10);
      audio.thud(this.listenerDist({ x, y }));
    }
  }

  /** HE shells exploding near (not on) a tank can still damage tracks / open-top crews. */
  private splash(p: Projectile, x: number, y: number) {
    const r = 1.5 + Math.cbrt(p.shell.explosive) * 0.15;
    for (const t of this.tanks) {
      if (!t.alive) continue;
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
    const ld = this.listenerDist(w);
    target.hitFlash = 0.3;
    switch (res.outcome) {
      case 'ricochet':
        this.fx.sparks(w.x, w.y, Math.atan2(res.reflect!.y, res.reflect!.x), 10, 0.5, 22);
        audio.ricochet(ld);
        break;
      case 'nonpen':
        this.fx.sparks(w.x, w.y, Math.atan2(-p.dy, -p.dx), 8, 0.9, 14);
        this.fx.hitPuff(w.x, w.y, false);
        audio.clang(false, ld);
        break;
      case 'pen':
        this.fx.hitPuff(w.x, w.y, true);
        this.fx.sparks(w.x, w.y, Math.atan2(p.dy, p.dx), 8, 0.6, 16);
        audio.clang(true, ld);
        break;
      case 'barrel':
        this.fx.sparks(w.x, w.y, Math.atan2(-p.dy, -p.dx), 6, 1, 12);
        audio.clang(false, ld);
        break;
      case 'wreck':
        this.fx.impactDust(w.x, w.y);
        audio.thud(ld);
        break;
    }
    if (p.shell.type === 'HE' && !splash) {
      this.fx.heBlast(w.x, w.y, p.shell.explosive);
      audio.explosion(Math.cbrt(p.shell.explosive) / 12, ld);
    }
    if (res.outcome === 'wreck') return;
    if (!splash || res.damage > 0) this.emit({ type: 'hit', res, shooter, target });

    // player rewards
    if (shooter.isPlayer && target.team !== shooter.team && res.damage > 0) {
      const crit = res.changed.some((id) => res.states[id] === 'destroyed');
      if (crit) {
        this.stats.crits++;
        this.addReward('Critical hit', 30, 150, target.pos, '#e8c070');
      } else {
        this.stats.hits++;
        this.addReward('Hit', 15, 80, target.pos, '#d8c8a0');
      }
      this.stats.damage += res.damage;
    }
    if (target.isPlayer) {
      this.lastPlayerHit = { res, by: shooter };
      for (const m of res.messages.slice(0, 3)) this.emit({ type: 'notice', text: m, color: m.includes('Fire') || m.includes('detonation') ? '#ff8a5c' : '#ffd27a' });
    }
    if (res.killed && target.alive) this.kill(target, shooter, res.cookoff ? 'cookoff' : 'crew', res);
    else if (res.fire && target.burning > 0) {
      /* fire started — handled in updateFires */
    }
  }

  kill(target: Tank, killer: Tank | null, how: 'cookoff' | 'crew' | 'fire', res: ImpactResult | null) {
    target.alive = false;
    target.deathTime = this.time;
    target.throttle = 0;
    const tp = target.turretPos();
    const ld = this.listenerDist(target.pos);
    if (how === 'cookoff') {
      target.cookedOff = true;
      this.fx.explosion(tp.x, tp.y, 1.4);
      audio.explosion(1.5, ld);
      const a = rand.range(0, Math.PI * 2);
      target.turretOff = { pos: { ...tp }, ang: target.turretWorldAng, vel: fromAngle(a, rand.range(2, 7)), spin: rand.range(-4, 4), h: 0, vh: rand.range(7, 12) };
      target.wreckFire = rand.range(14, 22);
    } else {
      this.fx.explosion(tp.x, tp.y, 0.6);
      audio.explosion(0.8, ld);
      target.wreckFire = target.burning > 0 ? rand.range(8, 14) : rand.range(2, 5);
    }
    target.wreckSmoke = 90;
    target.burning = 0;
    this.hooks.stamp?.({ kind: 'scorch', x: target.pos.x, y: target.pos.y, ang: 0, w: target.bp.radius * 1.3, h: 1 });
    this.tickets[target.team] = Math.max(0, this.tickets[target.team] - KILL_TICKETS);

    if (killer && killer.team !== target.team) {
      killer.kills++;
      if (killer.isPlayer) {
        this.stats.kills++;
        const ratio = clamp(target.spec.br / Math.max(1, killer.spec.br), 0.6, 1.6);
        const rp = Math.round((300 * Math.sqrt(ratio)) / 5) * 5 + (how === 'cookoff' ? 50 : 0);
        this.addReward('Target destroyed', rp, rp * 5, target.pos, '#f2a93b', true);
      }
    }
    const t0 = performance.now() / 1000;
    for (const [id, at] of target.damagers) {
      if (killer && id === killer.id) continue;
      if (t0 - at > 30) continue;
      const a = this.tanks.find((x) => x.id === id);
      if (!a || a.team === target.team) continue;
      a.assists++;
      if (a.isPlayer) {
        this.stats.assists++;
        this.addReward('Assist', 100, 400, target.pos, '#e0c070');
      }
    }
    this.emit({ type: 'feed', killer, victim: target, how });

    if (target.isPlayer) {
      this.state = 'dead';
      this.deadAt = this.time;
      this.emit({ type: 'playerDead', killer, res: res ?? this.lastPlayerHit?.res ?? null });
    } else if (this.ais.has(target.id)) {
      this.ais.delete(target.id);
      if (this.reinforcements[target.team] > 0) {
        this.reinforcements[target.team]--;
        this.respawnQueue.push({ team: target.team, at: this.time + 10 });
      }
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
      if (tick) {
        const r = fireTick(t);
        if (r.killed) {
          const killer = t.lastHitBy;
          this.kill(t, killer, r.cookoff ? 'cookoff' : 'fire', null);
        }
      }
      if (t.burning <= 0 && t.isPlayer) this.emit({ type: 'notice', text: 'Fire burned out', color: '#9fd3ff' });
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
      const set = this.spotted[team];
      set.clear();
      for (const e of this.tanks) {
        if (!e.alive || e.team === team) continue;
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
        const p = this.player;
        if (p && p.alive && p.team === team && dist(p.pos, c) < c.r) {
          this.stats.caps++;
          this.addReward('Point captured', 200, 800, p.pos, '#7fc3ff');
        }
      }
    }
    if (cap.owner >= 0) {
      const enemy = cap.owner === 0 ? 1 : 0;
      this.tickets[enemy] = Math.max(0, this.tickets[enemy] - 2.2 * dt);
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
    if (this.state === 'ended') return;
    const pt = this.playerTeam;
    const et = pt === 0 ? 1 : 0;
    const aliveOrPending = (team: 0 | 1) =>
      this.tanks.some((t) => t.alive && t.team === team) || this.respawnQueue.some((r) => r.team === team) || (team === pt && this.state === 'dead' && this.availableLineup().length > 0);
    let res: 'victory' | 'defeat' | null = null;
    if (this.tickets[et] <= 0 || !aliveOrPending(et)) res = 'victory';
    else if (this.tickets[pt] <= 0 || !aliveOrPending(pt)) res = 'defeat';
    else if (this.time >= BATTLE_TIME) res = this.tickets[pt] >= this.tickets[et] ? 'victory' : 'defeat';
    if (res) this.end(res);
  }

  end(res: 'victory' | 'defeat') {
    if (this.state === 'ended') return;
    this.state = 'ended';
    this.result = res;
    if (res === 'victory') this.rewards.push({ label: 'Victory', rp: 500, cr: 3000 });
    else this.rewards.push({ label: 'Participation', rp: 150, cr: 1000 });
    this.emit({ type: 'end' });
  }

  totals(): { rp: number; cr: number } {
    let rp = 0;
    let cr = 0;
    for (const r of this.rewards) {
      rp += r.rp;
      cr += r.cr;
    }
    if (this.result === 'victory') {
      rp = Math.round(rp * 1.2);
      cr = Math.round(cr * 1.2);
    }
    return { rp, cr };
  }

  /** Approx. local dir helper used by HUD. */
  localDir(t: Tank, d: V2): V2 {
    return dirToLocal(d, t.ang);
  }
}

export { DEG };
