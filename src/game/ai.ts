// AI tank commander.

import { type V2, DEG, angDiff, clamp, dist, pointSegDist, toWorld } from '../core/math';
import { rand } from '../core/rng';
import { predictShot } from './armor';
import { losBlocked } from './map';
import type { Battle } from './battle';
import type { Tank } from './tank';

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

  constructor(tank: Tank, b: Battle, role: Role) {
    this.tank = tank;
    this.b = b;
    this.role = role;
    this.skill = rand.range(0.45, 0.85);
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
      // overwatch position: on our side of the capture point
      const toSpawn = Math.atan2(spawn.y - cap.y, spawn.x - cap.x);
      for (let i = 0; i < 12; i++) {
        const spread = this.role === 'flank' ? 1.5 : 0.9;
        const a = toSpawn + rand.range(-spread, spread);
        const r = this.role === 'flank' ? rand.range(60, 120) : rand.range(45, 100);
        const p = { x: cap.x + Math.cos(a) * r, y: cap.y + Math.sin(a) * r };
        if (b.nav.free(p) && !losBlocked(b.map, p, cap)) {
          this.goal = p;
          break;
        }
        this.goal = p;
      }
      if (ownCap && this.role === 'capper' && rand.chance(0.5)) this.role = 'support';
    }
    if (this.goal) this.path = b.nav.findPath(t.pos, this.goal) ?? [this.goal];
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
      const score = d * (los ? 1 : 2.5) * (e === this.target ? 0.7 : 1) * (e.isPlayer ? 0.9 : 1);
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best !== this.target) {
      this.target = best;
      this.aimErr = rand.gauss() * (1.4 - this.skill) * 2.2 * DEG;
      if (best) this.chooseAimPoint(best);
    }
    void now;
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
    let best = cands[0];
    let bestScore = -Infinity;
    for (const c of cands) {
      const wp = toWorld(c, e.pos, e.ang);
      const ang = Math.atan2(wp.y - from.y, wp.x - from.x);
      const pr = predictShot(t, e, shell, from, { x: Math.cos(ang), y: Math.sin(ang) });
      let s = pr.outcome === 'pen' ? 3 + (pr.pen - pr.eff) / 100 : pr.outcome === 'maybe' ? 1.5 : pr.outcome === 'none' ? -2 : 0;
      if (c.x === 0 && c.y === 0) s += 0.3; // centre mass is easiest to hit
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
        const pr = predictShot(t, e, sh, from, { x: Math.cos(ang), y: Math.sin(ang) });
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

    this.retarget -= dt;
    if (this.retarget <= 0) {
      this.retarget = rand.range(0.4, 0.8);
      this.pickTarget(now);
      if (this.target && rand.chance(0.15)) this.chooseAimPoint(this.target);
    }
    this.repath -= dt;
    if (this.repath <= 0 || !this.goal) {
      this.repath = rand.range(5, 9);
      this.chooseGoal();
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
        if (ready && err < Math.max(0.5 * DEG, t.dispersion() * 1.4) && !this.friendlyInLine(e)) {
          t.wantFire = true;
          this.aimErr = rand.gauss() * (1.3 - this.skill) * 1.6 * DEG;
        }
      }
    } else {
      // look along movement direction / toward capture
      const cap = b.map.capture;
      const look = this.path.length ? this.path[0] : cap;
      t.aimAngle = Math.atan2(look.y - tp.y, look.x - tp.x);
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
    const stopToShoot = engaging && (heavy || eDist < 140 || this.role === 'support' || (this.goal && dist(t.pos, this.goal) < 8));
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

    // follow path
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
