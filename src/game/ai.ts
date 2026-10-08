// AI tank commander.

import { type V2, DEG, angDiff, clamp, dist, pointSegDist, toWorld } from '../core/math';
import { rand } from '../core/rng';
import { predictShot } from './armor';
import { bermCover, losBlocked } from './map';
import type { Battle } from './battle';
import type { Carrier } from './carrier';
import type { Tank } from './tank';
import { FLARE, flareLight } from './weather';

type Role = 'capper' | 'support' | 'flank';

export class AIController {
  tank: Tank;
  b: Battle;
  role: Role;
  skill: number;
  path: V2[] = [];
  goal: V2 | null = null;
  repath = 0;
  target: Tank | null = null;
  retarget = 0;
  aimLocal: V2 = { x: 0, y: 0 };
  aimErr = 0;
  stuck = 0;
  reverse = 0;
  reverseSteer = 0;
  holdUntil = 0;
  extinguishAt = -1;
  lastPos: V2;
  /** time when the AI may fire at its current target (reaction delay) */
  fireAfter = 0;
  private repairAt = -1;
  private smokeHandledHit = -1;
  /** next time to think about firing a flare (night) */
  private flareAt = 0;
  /** optional detour waypoint taken before heading to the goal (flanking routes) */
  via: V2 | null = null;
  private usedVia = false;

  constructor(tank: Tank, b: Battle, role: Role) {
    this.tank = tank;
    this.b = b;
    this.role = role;
    this.skill = rand.range(0.35, 0.8);
    this.lastPos = { ...tank.pos };
    this.repath = rand.range(0, 1);
  }

  private chooseGoal() {
    const b = this.b;
    const cap = b.map.capture;
    const t = this.tank;
    const ownCap = b.capture.owner === t.team && !b.capture.contested;
    const spawn = b.map.spawns[t.team][0];
    if (this.role === 'capper' && !ownCap) {
      const a = rand.range(0, Math.PI * 2);
      const r = rand.range(0, cap.r * 0.6);
      this.goal = { x: cap.x + Math.cos(a) * r, y: cap.y + Math.sin(a) * r };
    } else {
      // overwatch position: on our side of the capture point — a hull-down spot behind an earthwork if one is free
      const toSpawn = Math.atan2(spawn.y - cap.y, spawn.x - cap.x);
      const hd = rand.chance(0.7) ? this.hullDownSpot(toSpawn) : null;
      if (hd) {
        this.goal = hd;
        if (ownCap && this.role === 'capper' && rand.chance(0.5)) this.role = 'support';
        this.path = b.nav!.findPath(t.pos, hd) ?? [hd];
        return;
      }
      for (let i = 0; i < 12; i++) {
        const spread = this.role === 'flank' ? 1.5 : 0.9;
        const a = toSpawn + rand.range(-spread, spread);
        const r = this.role === 'flank' ? rand.range(60, 120) : rand.range(45, 100);
        const p = { x: cap.x + Math.cos(a) * r, y: cap.y + Math.sin(a) * r };
        if (b.nav!.free(p) && !losBlocked(b.map, p, cap)) {
          this.goal = p;
          break;
        }
        this.goal = p;
      }
      if (ownCap && this.role === 'capper' && rand.chance(0.5)) this.role = 'support';
    }
    // flanking detour: approach through a side lane instead of the direct line
    const far = dist(t.pos, cap) > 130;
    if (far && !this.usedVia && (this.role === 'flank' || (this.role === 'capper' && rand.chance(0.4)))) {
      const toSpawnA = Math.atan2(spawn.y - cap.y, spawn.x - cap.x);
      const side = rand.chance(0.5) ? 1 : -1;
      for (let i = 0; i < 10; i++) {
        const a = toSpawnA + side * rand.range(0.7, 1.15);
        const r = rand.range(75, 115);
        const p = { x: cap.x + Math.cos(a) * r, y: cap.y + Math.sin(a) * r };
        if (p.x > 15 && p.y > 15 && p.x < b.map.size - 15 && p.y < b.map.size - 15 && b.nav!.free(p)) {
          this.via = p;
          break;
        }
      }
      this.usedVia = true;
    }
    const target = this.via ?? this.goal;
    if (target) this.path = b.nav!.findPath(t.pos, target) ?? [target];
  }

  /** A free hull-down spot on our side of the capture point that faces the point. */
  private hullDownSpot(toSpawn: number): V2 | null {
    const b = this.b;
    const cap = b.map.capture;
    const t = this.tank;
    const cands = b.map.hullDown.filter((s) => {
      const d = dist(s, cap);
      if (d < 38 || d > (this.role === 'flank' ? 140 : 115)) return false;
      if (Math.abs(angDiff(Math.atan2(s.y - cap.y, s.x - cap.x), toSpawn)) > 1.25) return false;
      if (!Number.isNaN(s.face) && Math.abs(angDiff(s.face, Math.atan2(cap.y - s.y, cap.x - s.x))) > 1.0) return false;
      if (!b.nav!.free(s)) return false;
      for (const o of b.tanks) if (o !== t && o.alive && dist(o.pos, s) < 7) return false;
      for (const ai of b.ais.values()) if (ai !== this && ai.goal && dist(ai.goal, s) < 7) return false;
      return true;
    });
    if (!cands.length) return null;
    const s = cands[Math.floor(rand.next() * cands.length)];
    return { x: s.x, y: s.y };
  }

  private pickTarget(now: number) {
    const b = this.b;
    const t = this.tank;
    let best: Tank | null = null;
    let bestScore = Infinity;
    for (const e of b.tanks) {
      if (e.team === t.team || !e.alive) continue;
      if (!b.isSpotted(t.team, e)) continue;
      const d = dist(t.pos, e.pos);
      if (d > 420) continue;
      const los = !losBlocked(b.map, t.turretPos(), e.pos);
      const score = d * (los ? 1 : 2.5) * (e === this.target ? 0.7 : 1) * (e.slot ? 0.9 : 1);
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best !== this.target) {
      this.target = best;
      this.aimErr = rand.gauss() * (1.4 - this.skill) * 2.2 * DEG;
      this.fireAfter = now + rand.range(0.7, 1.6) * (1.3 - this.skill);
      if (best) this.chooseAimPoint(best);
    }
  }

  /** Pick the weakest-looking spot on the target using the penetration predictor. */
  private chooseAimPoint(e: Tank) {
    const t = this.tank;
    const lk = e.spec.look;
    const cands: V2[] = [
      { x: 0, y: 0 },
      { x: e.bp.turretX, y: 0 },
      { x: lk.L * 0.42, y: lk.W * 0.32 },
      { x: lk.L * 0.42, y: -lk.W * 0.32 },
      { x: -lk.L * 0.2, y: lk.W * 0.4 },
      { x: -lk.L * 0.2, y: -lk.W * 0.4 },
      { x: -lk.L * 0.4, y: 0 },
    ];
    if (this.skill < 0.55) {
      this.aimLocal = cands[0];
      return;
    }
    const shell = t.spec.gun.shells[t.shellIdx];
    const from = t.muzzle();
    const covered = bermCover(this.b.map, from, e.pos);
    let best = cands[0];
    let bestScore = -Infinity;
    for (const c of cands) {
      const wp = toWorld(c, e.pos, e.ang);
      const ang = Math.atan2(wp.y - from.y, wp.x - from.x);
      const pr = predictShot(t, e, shell, from, { x: Math.cos(ang), y: Math.sin(ang) }, covered);
      let s = pr.outcome === 'pen' ? 3 + (pr.pen - pr.eff) / 100 : pr.outcome === 'maybe' ? 1.5 : pr.outcome === 'none' || pr.outcome === 'cover' ? -2 : 0;
      if (c.x === 0 && c.y === 0 && !covered) s += 0.3; // centre mass is easiest to hit
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    this.aimLocal = best;
    // ammo choice: if no pen with current shell try others
    if (bestScore < 1) {
      for (let i = 0; i < t.spec.gun.shells.length; i++) {
        if (i === t.shellIdx || t.ammo[i] <= 0) continue;
        const sh = t.spec.gun.shells[i];
        const wp = toWorld(best, e.pos, e.ang);
        const ang = Math.atan2(wp.y - from.y, wp.x - from.x);
        const pr = predictShot(t, e, sh, from, { x: Math.cos(ang), y: Math.sin(ang) }, covered);
        if (pr.outcome === 'pen' && t.isReloaded()) {
          t.selectShell(i);
          break;
        }
      }
    }
  }

  update(dt: number, now: number) {
    const t = this.tank;
    const b = this.b;
    if (!t.alive) return;
    t.wantFire = false;

    // fires
    if (t.burning > 0 && t.extinguishCd <= 0) {
      if (this.extinguishAt < 0) this.extinguishAt = now + rand.range(1.5, 4);
      if (now >= this.extinguishAt) {
        b.extinguish(t);
        this.extinguishAt = -1;
      }
    }

    // repairs
    if (t.canRepair()) {
      if (this.repairAt < 0) this.repairAt = now + rand.range(1, 2.5);
      if (now >= this.repairAt) {
        t.startRepair();
        this.repairAt = -1;
      }
    } else this.repairAt = -1;
    // killstreak support
    const sup = b.supportOf(t);
    if (sup.recon > 0 && !this.target && rand.chance(dt * 0.25)) b.useRecon(t);
    if (sup.arty > 0 && rand.chance(dt * 0.5)) {
      const aim = this.artyAim();
      if (aim) b.useArty(t, aim.x, aim.y);
    }
    // call a crew carrier when crew are down and the fight is not right on top of us
    if (t.crewCd <= 0 && t.needsCrewBadly() && !b.carrierFor(t) && rand.chance(dt * 0.6)) {
      if (!this.target || dist(t.pos, this.target.pos) > 140) b.useCrew(t);
    }
    // night: light up the ground ahead, or toward an unseen shooter
    if (t.flareCharges > 0 && now >= this.flareAt) this.considerFlare(now);
    // smoke when badly hurt
    const wall = performance.now() / 1000;
    if (t.canSmoke() && wall - t.lastHitTime < 0.6 && this.smokeHandledHit !== t.lastHitTime) {
      this.smokeHandledHit = t.lastHitTime;
      const crippled = !t.canMove() || t.crewAlive().length < t.spec.crew.length || t.burning > 0;
      if (crippled && rand.chance(0.55)) {
        const src = t.lastHitBy?.pos ?? this.target?.pos;
        if (src) t.wantSmoke = Math.atan2(src.y - t.pos.y, src.x - t.pos.x) + rand.range(-0.15, 0.15);
      }
    }

    this.retarget -= dt;
    if (this.retarget <= 0) {
      this.retarget = rand.range(0.4, 0.8);
      this.pickTarget(now);
      if (this.target && rand.chance(0.15)) this.chooseAimPoint(this.target);
    }
    this.repath -= dt;
    if (this.repath <= 0 || !this.goal) {
      this.repath = rand.range(5, 9);
      if (this.via) {
        this.path = b.nav!.findPath(t.pos, this.via) ?? [this.via];
      } else this.chooseGoal();
    }

    const e = this.target;
    const tp = t.turretPos();
    let engaging = false;
    let eDist = 0;
    if (e && e.alive) {
      eDist = dist(t.pos, e.pos);
      const hasLos = !losBlocked(b.map, tp, e.pos);
      // aim with lead
      const aimW = toWorld(this.aimLocal, e.pos, e.ang);
      const shell = t.spec.gun.shells[t.shellIdx];
      const v = shell.velocity * b.shellSpeedScale;
      const tof = eDist / v;
      const lead = this.skill * 0.9 + 0.1;
      const px = aimW.x + Math.cos(e.ang) * e.speed * tof * lead;
      const py = aimW.y + Math.sin(e.ang) * e.speed * tof * lead;
      // aim error settles over time
      this.aimErr *= Math.exp(-dt * (0.6 + this.skill));
      t.aimAngle = Math.atan2(py - tp.y, px - tp.x) + this.aimErr;
      if (hasLos && eDist < 420) {
        engaging = true;
        const err = t.aimError();
        const ready = t.isReloaded() && t.canFire();
        if (ready && now >= this.fireAfter && err < Math.max(0.5 * DEG, t.dispersion() * 1.4) && !this.friendlyInLine(e)) {
          t.wantFire = true;
          this.aimErr = rand.gauss() * (1.3 - this.skill) * 1.6 * DEG;
        }
      }
    } else {
      const cv = this.carrierTarget(tp);
      if (cv) {
        // no tank to fight: shoot up the enemy's crew carrier
        const v = t.spec.gun.shells[t.shellIdx].velocity * b.shellSpeedScale;
        const tof = dist(tp, cv.pos) / v;
        const px = cv.pos.x + Math.cos(cv.ang) * cv.speed * tof;
        const py = cv.pos.y + Math.sin(cv.ang) * cv.speed * tof;
        t.aimAngle = Math.atan2(py - tp.y, px - tp.x) + this.aimErr * 0.5;
        if (t.isReloaded() && t.canFire() && now >= this.fireAfter && t.aimError() < Math.max(0.6 * DEG, t.dispersion() * 1.4)) {
          t.wantFire = true;
          this.fireAfter = now + rand.range(0.3, 1.0);
        }
      } else {
        // look along movement direction / toward capture
        const cap = b.map.capture;
        const look = this.path.length ? this.path[0] : cap;
        t.aimAngle = Math.atan2(look.y - tp.y, look.x - tp.x);
      }
    }

    // ---------------- movement
    if (this.reverse > 0) {
      this.reverse -= dt;
      t.throttle = -0.8;
      t.steer = this.reverseSteer;
      if (this.reverse <= 0) this.chooseGoal();
      return;
    }

    const heavy = t.spec.cls === 'heavy' || t.spec.cls === 'td';
    const cap = b.map.capture;
    const inCap = dist(t.pos, cap) < cap.r * 0.8;
    const capping = this.role === 'capper' && !(b.capture.owner === t.team && !b.capture.contested);
    const stopToShoot = engaging && (capping ? inCap || eDist < 45 : heavy || eDist < 140 || this.role === 'support' || (this.goal && dist(t.pos, this.goal) < 8));
    if (stopToShoot && e) {
      // angle the hull: heavies keep ~28° off-angle, casemates point the gun
      const bearing = Math.atan2(e.pos.y - t.pos.y, e.pos.x - t.pos.x);
      let desired = bearing;
      if (t.bp.casemate) desired = bearing;
      else if (t.spec.armor.ufp.s < 45 && t.spec.cls !== 'light') desired = bearing + (angDiff(bearing, t.ang) > 0 ? 1 : -1) * 28 * DEG;
      else desired = bearing;
      const diff = angDiff(t.ang, desired);
      t.throttle = 0;
      t.steer = Math.abs(diff) > 4 * DEG ? clamp(diff * 2.5, -1, 1) : 0;
      this.stuck = 0;
      return;
    }

    if (capping && inCap && !engaging) {
      t.throttle = 0;
      t.steer = 0;
      return;
    }
    // follow path
    if (this.via && dist(t.pos, this.via) < 12) {
      this.via = null;
      if (this.goal) this.path = b.nav!.findPath(t.pos, this.goal) ?? [this.goal];
    }
    while (this.path.length && dist(t.pos, this.path[0]) < 5) this.path.shift();
    const wp = this.path[0] ?? this.goal;
    if (!wp || dist(t.pos, wp) < 4) {
      t.throttle = 0;
      t.steer = 0;
      if (this.goal && dist(t.pos, this.goal) < 6) this.goal = null;
      return;
    }
    const want = Math.atan2(wp.y - t.pos.y, wp.x - t.pos.x);
    let diff = angDiff(t.ang, want);
    // avoid nearby tanks ahead
    for (const o of b.tanks) {
      if (o === t) continue;
      const d = dist(o.pos, t.pos);
      if (d > 14) continue;
      const ba = angDiff(t.ang, Math.atan2(o.pos.y - t.pos.y, o.pos.x - t.pos.x));
      if (Math.abs(ba) < 0.6) diff += (ba > 0 ? -1 : 1) * 0.6 * (1 - d / 14);
    }
    t.steer = clamp(diff * 2.2, -1, 1);
    const ad = Math.abs(diff);
    t.throttle = ad > 1.6 ? 0.1 : ad > 0.8 ? 0.4 : 1;
    if (engaging) t.throttle *= 0.75;
    // sprint on long, straight drives
    if (!engaging && ad < 0.3 && this.goal && dist(t.pos, this.goal) > 110 && t.canBoost() && rand.chance(dt * 0.15)) t.startBoost();

    // stuck detection
    const moved = dist(t.pos, this.lastPos);
    this.lastPos = { ...t.pos };
    if (t.throttle > 0.3 && moved < 0.4 * dt && t.canMove()) {
      this.stuck += dt;
      if (this.stuck > 1.6) {
        this.stuck = 0;
        this.reverse = rand.range(0.8, 1.6);
        this.reverseSteer = rand.chance(0.5) ? 1 : -1;
      }
    } else this.stuck = Math.max(0, this.stuck - dt);
  }

  /** Fire an illumination flare when the dark hides the enemy: toward whoever just hit us unseen,
   * the last place an enemy was seen nearby, or the capture point while closing in on it. */
  private considerFlare(now: number) {
    const b = this.b;
    const t = this.tank;
    this.flareAt = now + rand.range(1.5, 3);
    // one flare at a time per team is plenty
    if (!t.canFlare() || b.flares.some((f) => f.team === t.team && f.t < 9)) return;
    let aim: V2 | null = null;
    const sh = t.lastHitBy;
    if (sh && sh.alive && sh.team !== t.team && performance.now() / 1000 - t.lastHitTime < 4 && !b.isSpotted(t.team, sh)) {
      // only a rough idea of where the shot came from
      aim = { x: sh.pos.x + rand.range(-18, 18), y: sh.pos.y + rand.range(-18, 18) };
    } else if (!this.target) {
      let bd = 150;
      for (const e of b.tanks) {
        if (!e.alive || e.team === t.team || !e.lastSeenPos || now - e.lastSeenAt > 25) continue;
        const d = dist(t.pos, e.lastSeenPos);
        if (d > 45 && d < bd) {
          bd = d;
          aim = e.lastSeenPos;
        }
      }
      if (!aim) {
        const cap = b.map.capture;
        const d = dist(t.pos, cap);
        if (d > 55 && d < 150 && rand.chance(0.3)) aim = { x: cap.x, y: cap.y };
      }
    }
    if (!aim) return;
    const at = aim;
    // a friendly flare already lights it up
    if (b.flares.some((f) => f.team === t.team && f.t < FLARE.FLIGHT + FLARE.BURN - 4 && dist(f.t < FLARE.FLIGHT ? { x: f.x1, y: f.y1 } : flareLight(f), at) < FLARE.RADIUS * 0.8)) return;
    const tp = t.turretPos();
    if (b.useFlare(t, Math.atan2(at.y - tp.y, at.x - tp.x) + rand.range(-0.1, 0.1))) this.flareAt = now + rand.range(25, 45);
  }

  /** Where to drop artillery: on a slow or bunched-up spotted enemy, well clear of our own tanks. */
  private artyAim(): V2 | null {
    const b = this.b;
    const t = this.tank;
    let best: V2 | null = null;
    let bestScore = 0;
    for (const e of b.tanks) {
      if (!e.alive || e.team === t.team || !b.isSpotted(t.team, e)) continue;
      let score = 1 + (Math.abs(e.speed) < 1 ? 1.2 : 0);
      for (const o of b.tanks) if (o !== e && o.alive && o.team !== t.team && dist(o.pos, e.pos) < 18) score += 1;
      if (b.tanks.some((o) => o.alive && o.team === t.team && dist(o.pos, e.pos) < 22)) continue;
      if (score > bestScore) {
        bestScore = score;
        best = { x: e.pos.x + rand.range(-4, 4), y: e.pos.y + rand.range(-4, 4) };
      }
    }
    return bestScore >= 2 ? best : null;
  }

  private carrierTarget(tp: V2): Carrier | null {
    const b = this.b;
    const seen = b.spottedCarriers[this.tank.team];
    let best: Carrier | null = null;
    let bd = 240;
    for (const c of b.carriers) {
      if (c.state === 'dead' || c.team === this.tank.team || !seen.has(c.id)) continue;
      const d = dist(tp, c.pos);
      if (d < bd && !losBlocked(b.map, tp, c.pos)) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  private friendlyInLine(e: Tank): boolean {
    const t = this.tank;
    const m = t.muzzle();
    for (const o of this.b.tanks) {
      if (o === t || o.team !== t.team || !o.alive) continue;
      if (dist(o.pos, m) > dist(e.pos, m)) continue;
      if (pointSegDist(o.pos, m, e.pos) < o.bp.radius * 0.9) return true;
    }
    return false;
  }
}
