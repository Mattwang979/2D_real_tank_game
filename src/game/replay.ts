// Rolling recording of the last seconds of a battle — tank poses, shells, smoke, flares, carriers
// and every effect particle — so the kill replay can show how the player was knocked out.
// Times are on the recorder's own clock (real seconds of simulation), which keeps running
// smoothly on network clients whose battle clock is nudged by snapshots.

import type { ShellSpec } from '../data/vehicles';
import type { Battle } from './battle';
import type { Carrier } from './carrier';
import type { Particle } from './effects';
import type { Tank } from './tank';

export interface TankSample {
  k: Tank;
  x: number;
  y: number;
  /** hull angle, turret / gun relative angles, recoil */
  a: number;
  tr: number;
  gr: number;
  rc: number;
  al: boolean;
  bu: number;
  wf: number;
  aim: number;
  rl: number;
  sp: number;
  av: number;
  bl: number;
  si: number;
  /** blown-off turret */
  to: { x: number; y: number; a: number; h: number } | null;
}

export interface ProjSample {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  v: number;
  d: number;
  r: boolean;
  s: ShellSpec;
  /** shooter tank id */
  o: number;
}

export interface CarrierSample {
  k: Carrier;
  x: number;
  y: number;
  a: number;
  st: Carrier['state'];
  t: number;
}

export interface Frame {
  t: number;
  tanks: TankSample[];
  proj: ProjSample[];
  carriers: CarrierSample[];
  smokes: Battle['map']['smokes'];
  flares: Battle['flares'];
  grenades: Battle['grenades'];
  artys: Battle['artys'];
  recons: Battle['recons'];
}

export class ReplayRecorder {
  b: Battle;
  frames: Frame[] = [];
  /** particles as they appeared, stamped with the recorder clock */
  parts: Array<{ t: number; p: Particle }> = [];
  clock = 0;
  /** seconds of history kept */
  keep = 10;
  /** while set (a replay is being watched) nothing is thrown away */
  hold = false;
  private lastT = -1;

  constructor(b: Battle) {
    this.b = b;
    b.fx.onAdd = (p) => this.parts.push({ t: this.clock, p: { ...p } });
  }

  /** Advance the clock; call before the battle update of a frame. */
  tick(dt: number) {
    this.clock += dt;
  }

  /** Take a sample of the battle; call after the battle update. */
  capture() {
    const b = this.b;
    const t = this.clock;
    if (t - this.lastT < 1 / 50) return;
    this.lastT = t;
    const tanks: TankSample[] = [];
    for (const k of b.tanks) {
      const o = k.turretOff;
      tanks.push({
        k,
        x: k.pos.x,
        y: k.pos.y,
        a: k.ang,
        tr: k.turretRel,
        gr: k.gunRel,
        rc: k.recoil,
        al: k.alive,
        bu: k.burning,
        wf: k.wreckFire,
        aim: k.aimAngle,
        rl: k.reloadLeft,
        sp: k.speed,
        av: k.angVel,
        bl: k.bloom,
        si: k.shellIdx,
        to: o ? { x: o.pos.x, y: o.pos.y, a: o.ang, h: o.h } : null,
      });
    }
    this.frames.push({
      t,
      tanks,
      proj: b.projectiles.map((p) => ({ id: p.id, x: p.x, y: p.y, dx: p.dx, dy: p.dy, v: p.speed, d: p.dist, r: p.ricochet, s: p.shell, o: p.shooter.id })),
      carriers: b.carriers.map((c) => ({ k: c, x: c.pos.x, y: c.pos.y, a: c.ang, st: c.state, t: c.t })),
      smokes: b.map.smokes.map((s) => ({ ...s })),
      flares: b.flares.map((f) => ({ ...f })),
      grenades: b.grenades.map((g) => ({ ...g })),
      artys: b.artys.map((a) => ({ ...a })),
      recons: b.recons.map((r) => ({ ...r })),
    });
    if (!this.hold) this.trim();
  }

  trim() {
    const cut = this.clock - this.keep;
    let i = 0;
    while (i < this.frames.length && this.frames[i].t < cut) i++;
    if (i) this.frames.splice(0, i);
    // particles reach a little further back so effects already in the air are there from the start
    const pcut = cut - 3;
    let j = 0;
    while (j < this.parts.length && this.parts[j].t < pcut) j++;
    if (j) this.parts.splice(0, j);
  }

  /** Stop recording (end of battle). */
  dispose() {
    if (this.b.fx.onAdd) this.b.fx.onAdd = null;
    this.frames = [];
    this.parts = [];
  }
}
