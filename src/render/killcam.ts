// Kill replay ("killcam"). A moment after the player is knocked out, the last few seconds are
// played back from the killer's side: the gun swinging onto the target, the fatal shell followed
// in slow motion, the hit and the burning wreck. Then the normal death screen takes over.
// The replay is drawn by the regular renderer from a stand-in battle whose tanks are "ghosts"
// (objects inheriting from the real tanks, with the recorded pose on top), so nothing in the live
// battle is touched while it keeps running underneath.

import { type V2, angDiff, clamp, dist } from '../core/math';
import { audio } from '../core/audio';
import type { Battle, Projectile } from '../game/battle';
import type { Carrier } from '../game/carrier';
import { Effects } from '../game/effects';
import type { Frame, ReplayRecorder, TankSample } from '../game/replay';
import type { Tank } from '../game/tank';
import { visibilityPolygon } from '../game/vision';
import type { BattleRenderer } from './battleRender';

/** replay seconds shown before the fatal shot */
const LEAD = 2.3;
/** replay seconds after the kill */
const AFTER = 1.7;
/** seconds after the kill before the replay starts (the wreck explodes in the live view first) */
export const KILLCAM_DELAY = 1.1;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ZERO: V2 = { x: 0, y: 0 };

export class KillCam {
  b: Battle;
  r: BattleRenderer;
  rec: ReplayRecorder;
  active = false;
  killer: Tank | null = null;
  victim: Tank | null = null;
  /** replay clock (recorder time) and the window being played */
  rt = 0;
  t0 = 0;
  t1 = 0;
  deathT = 0;
  /** slow-motion window and speed */
  slow0 = 0;
  slow1 = 0;
  slowK = 0.4;
  /** the shell that did it: projectile id, first and last time it was seen */
  fatal: { id: number; a: number; z: number } | null = null;
  /** real seconds played / expected, and where the kill falls (0..1) */
  elapsed = 0;
  duration = 0;
  killAt = 0.7;
  /** what the camera is doing (for the overlay and tests) */
  mode: 'lead' | 'shot' | 'hit' = 'lead';
  /** where the player's tank (while still alive in the replay) and the killer are on screen (CSS px) */
  victimMark: V2 | null = null;
  killerMark: V2 | null = null;
  onEnd: (() => void) | null = null;
  private pendingLeft = -1;
  private fx: Effects | null = null;
  private pi = 0;
  private fi = 0;
  private ghosts = new Map<Tank, Tank>();
  private cghosts = new Map<Carrier, Carrier>();
  private cam: V2 = { x: 0, y: 0 };
  private zoom = 5;
  private snap = true;
  private shake = 0;
  private poly: V2[] = [];
  private polyT = 0;
  private sounds: Array<{ t: number; kind: 'cannon' | 'hit' | 'boom'; x: number; y: number; c: number }> = [];

  constructor(b: Battle, r: BattleRenderer, rec: ReplayRecorder) {
    this.b = b;
    this.r = r;
    this.rec = rec;
  }

  get pending(): boolean {
    return this.pendingLeft >= 0;
  }
  /** 0 → 1 over the replay */
  get progress(): number {
    return this.duration > 0 ? clamp(this.elapsed / this.duration, 0, 1) : 0;
  }
  get slowmo(): boolean {
    return this.active && this.speedAt(this.rt) < 0.9;
  }
  /** the kill has happened in the replay */
  get afterKill(): boolean {
    return this.active && this.rt >= this.deathT;
  }

  /** The player was knocked out: queue a replay of it. */
  schedule(killer: Tank | null, victim: Tank) {
    this.stop(false);
    this.killer = killer;
    this.victim = victim;
    this.deathT = this.rec.clock;
    this.pendingLeft = KILLCAM_DELAY;
    this.rec.hold = true;
  }

  stop(notify = true) {
    const was = this.active || this.pendingLeft >= 0;
    this.active = false;
    this.pendingLeft = -1;
    this.rec.hold = false;
    this.rec.trim();
    if (this.fx) this.fx.parts.length = 0;
    this.ghosts.clear();
    this.cghosts.clear();
    this.sounds = [];
    if (was) {
      // popups from the live battle piled up while the replay ran
      this.r.popups = [];
      if (notify) this.onEnd?.();
    }
  }

  private speedAt(t: number): number {
    const ramp = 0.18;
    if (t < this.slow0 - ramp) return 1;
    if (t < this.slow0) return lerp(1, this.slowK, (t - (this.slow0 - ramp)) / ramp);
    if (t < this.slow1) return this.slowK;
    if (t < this.slow1 + 0.3) return lerp(this.slowK, 0.8, (t - this.slow1) / 0.3);
    return 0.8;
  }

  private start(): boolean {
    const F = this.rec.frames;
    const v = this.victim;
    if (F.length < 10 || !v) return false;
    const k = this.killer && this.killer !== v ? this.killer : null;
    // the fatal shell: the killer's last round that vanished just before the kill
    this.fatal = null;
    if (k) {
      const seen = new Map<number, { a: number; z: number }>();
      for (const f of F) {
        if (f.t < this.deathT - 4) continue;
        if (f.t > this.deathT + 0.05) break;
        for (const p of f.proj) {
          if (p.o !== k.id || p.r) continue;
          const s = seen.get(p.id);
          if (s) s.z = f.t;
          else seen.set(p.id, { a: f.t, z: f.t });
        }
      }
      for (const [id, s] of seen) if (this.deathT - s.z < 0.45 && (!this.fatal || s.z > this.fatal.z)) this.fatal = { id, a: s.a, z: s.z };
    }
    const tf = this.fatal ? this.fatal.a : this.deathT - 0.4;
    this.t0 = Math.max(F[0].t, tf - LEAD);
    this.t1 = this.deathT + AFTER;
    this.slow0 = this.fatal ? this.fatal.a - 0.12 : this.deathT - 0.3;
    this.slow1 = this.deathT + 0.45;
    this.slowK = clamp((this.slow1 - this.slow0) / 2.4, 0.3, 0.6);
    // expected real duration (progress bar)
    let n = 0;
    let nk = -1;
    for (let t = this.t0; t < this.t1 && n < 2000; n++) {
      if (nk < 0 && t >= this.deathT) nk = n;
      t += this.speedAt(t) / 60;
    }
    this.duration = n / 60;
    this.killAt = nk >= 0 && n > 0 ? nk / n : 0.7;
    this.elapsed = 0;
    this.rt = this.t0;
    this.fi = 0;
    // sounds worth replaying: guns going off, the fatal hit, the wreck going up
    this.sounds = [];
    const prev = new Map<Tank, number>();
    for (const f of F) {
      if (f.t > this.t1) break;
      for (const s of f.tanks) {
        const p = prev.get(s.k);
        if (p !== undefined && s.rc > p + 0.3 && f.t >= this.t0) this.sounds.push({ t: f.t, kind: 'cannon', x: s.x, y: s.y, c: s.k.spec.gun.caliber });
        prev.set(s.k, s.rc);
      }
    }
    if (this.fatal) this.sounds.push({ t: this.fatal.z + 0.01, kind: 'hit', x: 0, y: 0, c: 0 });
    this.sounds.push({ t: this.deathT, kind: 'boom', x: 0, y: 0, c: 0 });
    this.sounds.sort((a, b) => a.t - b.t);
    // effects: replay particles from a little earlier so smoke already hanging around is there
    if (!this.fx) this.fx = new Effects(this.b.map.theme);
    this.fx.parts.length = 0;
    this.fx.wind = { ...this.b.fx.wind };
    const parts = this.rec.parts;
    let pt = this.t0 - 3;
    this.pi = 0;
    while (this.pi < parts.length && parts[this.pi].t < pt) this.pi++;
    while (pt < this.t0) {
      const st = Math.min(1 / 30, this.t0 - pt);
      pt += st;
      this.spawnUntil(pt);
      this.fx.update(st);
    }
    this.snap = true;
    this.shake = 0;
    this.polyT = 0;
    this.poly = [];
    this.mode = 'lead';
    this.active = true;
    return true;
  }

  private spawnUntil(t: number) {
    const parts = this.rec.parts;
    const fx = this.fx!;
    while (this.pi < parts.length && parts[this.pi].t <= t) fx.restore(parts[this.pi++].p);
  }

  /** Advance the replay by `dt` real seconds (0 while the game is paused). */
  update(dt: number) {
    if (this.pendingLeft >= 0) {
      this.pendingLeft -= dt;
      if (this.pendingLeft < 0) {
        this.pendingLeft = -1;
        if (!this.start()) this.stop();
      }
      return;
    }
    if (!this.active) return;
    const F = this.rec.frames;
    const prev = this.rt;
    const lastT = F.length ? F[F.length - 1].t : this.t1;
    this.rt = Math.min(this.t1, lastT, this.rt + dt * this.speedAt(this.rt));
    this.elapsed += dt;
    for (const s of this.sounds) {
      if (s.t <= prev || s.t > this.rt) continue;
      if (s.kind === 'cannon') audio.cannon(s.c, dist(this.cam, s) * 0.6);
      else if (s.kind === 'hit') audio.clang(true, 8);
      else {
        audio.explosion(1.3, 12);
        this.shake = 1.2;
      }
    }
    if (this.rt > prev) {
      this.spawnUntil(this.rt);
      this.fx!.update(this.rt - prev);
    }
    this.shake = Math.max(0, this.shake - dt * 2.2);
    // done — or stuck because the recording stopped (battle over)
    if (this.rt >= this.t1 - 1e-6 || this.elapsed > this.duration + 3) this.stop();
  }

  private frameAt(t: number): [Frame, Frame, number] {
    const F = this.rec.frames;
    let i = clamp(this.fi, 0, F.length - 1);
    while (i > 0 && F[i].t > t) i--;
    while (i < F.length - 1 && F[i + 1].t <= t) i++;
    this.fi = i;
    const f0 = F[i];
    const f1 = F[Math.min(i + 1, F.length - 1)];
    return [f0, f1, f1.t > f0.t ? clamp((t - f0.t) / (f1.t - f0.t), 0, 1) : 0];
  }

  private ghost(s0: TankSample, s1: TankSample, k: number): Tank {
    let g = this.ghosts.get(s0.k);
    if (!g) {
      g = Object.create(s0.k) as Tank;
      g.pos = { x: 0, y: 0 };
      g.vel = { x: 0, y: 0 };
      g.isPlayer = false;
      g.hitFlash = 0;
      g.fireReq = null;
      this.ghosts.set(s0.k, g);
    }
    g.pos.x = lerp(s0.x, s1.x, k);
    g.pos.y = lerp(s0.y, s1.y, k);
    g.ang = s0.a + angDiff(s0.a, s1.a) * k;
    g.turretRel = s0.tr + angDiff(s0.tr, s1.tr) * k;
    g.gunRel = lerp(s0.gr, s1.gr, k);
    g.recoil = lerp(s0.rc, s1.rc, k);
    g.alive = k < 0.5 ? s0.al : s1.al;
    g.burning = s0.bu;
    g.wreckFire = s0.wf;
    g.aimAngle = s0.aim + angDiff(s0.aim, s1.aim) * k;
    g.reloadLeft = s0.rl;
    g.speed = s0.sp;
    g.angVel = s0.av;
    g.bloom = s0.bl;
    g.shellIdx = s0.si;
    const a = s0.to;
    const b = s1.to ?? a;
    g.turretOff = a && b ? { pos: { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) }, ang: a.a + angDiff(a.a, b.a) * k, vel: ZERO, spin: 0, h: lerp(a.h, b.h, k), vh: 0 } : null;
    return g;
  }

  /** Centre and zoom (× base) that keep both points in view, or null when that would zoom out too far. */
  private frameBoth(a: V2, b: V2): { c: V2; z: number } | null {
    const r = this.r;
    const dx = Math.abs(a.x - b.x) + 14;
    const dy = Math.abs(a.y - b.y) + 12;
    const fit = Math.min((r.W * 0.9) / dx, (r.H * 0.66) / dy) / r.baseZoom;
    if (fit < 0.5) return null;
    return { c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z: Math.min(1.1, fit) };
  }

  /** Camera centre that keeps `from` near the edge of the view, looking toward `to`. */
  private rideWith(from: V2, to: V2, zMul: number): V2 {
    const r = this.r;
    const d = Math.max(1e-3, dist(from, to));
    const ux = (to.x - from.x) / d;
    const uy = (to.y - from.y) / d;
    const z = r.baseZoom * zMul;
    const hx = r.W / z / 2;
    const hy = (r.H * 0.62) / z / 2;
    const reach = Math.min(Math.abs(ux) > 1e-3 ? hx / Math.abs(ux) : 1e9, Math.abs(uy) > 1e-3 ? hy / Math.abs(uy) : 1e9);
    return { x: from.x + ux * reach * 0.72, y: from.y + uy * reach * 0.72 };
  }

  /** Draw the current replay frame. */
  render(dt: number) {
    if (!this.active || !this.rec.frames.length) return;
    const b = this.b;
    const r = this.r;
    const [f0, f1, k] = this.frameAt(this.rt);
    // tanks
    const tanks: Tank[] = [];
    let kg: Tank | null = null;
    let vg: Tank | null = null;
    for (const s0 of f0.tanks) {
      const s1 = f1.tanks.find((s) => s.k === s0.k) ?? s0;
      const g = this.ghost(s0, s1, k);
      tanks.push(g);
      if (s0.k === this.killer) kg = g;
      if (s0.k === this.victim) vg = g;
    }
    // shells
    const projs: Projectile[] = [];
    let fatalPos: V2 | null = null;
    for (const p0 of f0.proj) {
      const p1 = f1 === f0 ? undefined : f1.proj.find((q) => q.id === p0.id);
      let x: number;
      let y: number;
      let d = p0.d;
      if (p1) {
        x = lerp(p0.x, p1.x, k);
        y = lerp(p0.y, p1.y, k);
        d = lerp(p0.d, p1.d, k);
      } else {
        // gone by the next sample (it hit something): carry it only part of the way
        const tt = (f1.t - f0.t) * Math.min(k, 0.5);
        x = p0.x + p0.dx * p0.v * tt;
        y = p0.y + p0.dy * p0.v * tt;
      }
      projs.push({ x, y, dx: p0.dx, dy: p0.dy, dist: d, ricochet: p0.r, shell: p0.s } as Projectile);
      if (this.fatal && p0.id === this.fatal.id) fatalPos = { x, y };
    }
    // crew carriers
    const carriers: Carrier[] = f0.carriers.map((s) => {
      let g = this.cghosts.get(s.k);
      if (!g) {
        g = Object.create(s.k) as Carrier;
        g.pos = { x: 0, y: 0 };
        this.cghosts.set(s.k, g);
      }
      g.pos.x = s.x;
      g.pos.y = s.y;
      g.ang = s.a;
      g.state = s.st;
      g.t = s.t;
      return g;
    });

    // camera: both tanks in the picture when they fit (between the letterbox bars); otherwise ride
    // with the killer, follow the shell across, then settle on the hit
    let target: V2 = vg ? vg.pos : this.cam;
    let zt = 1;
    const flying = !!fatalPos && this.rt >= this.fatal!.a;
    const beforeHit = this.rt < (this.fatal ? this.fatal.z + 0.04 : this.deathT - 0.35);
    const both = kg && vg ? this.frameBoth(kg.pos, vg.pos) : null;
    if (beforeHit && both) {
      this.mode = flying ? 'shot' : 'lead';
      target = both.c;
      zt = both.z;
    } else if (beforeHit && flying) {
      this.mode = 'shot';
      target = fatalPos!;
      zt = 1.05;
    } else if (beforeHit && kg && vg) {
      this.mode = 'lead';
      target = this.rideWith(kg.pos, vg.pos, 0.8);
      zt = 0.8;
    } else {
      this.mode = 'hit';
      zt = 1.3;
    }
    const tz = r.baseZoom * zt;
    if (this.snap) {
      this.snap = false;
      this.cam = { x: target.x, y: target.y };
      this.zoom = tz;
    } else {
      const kk = 1 - Math.exp(-dt * (this.mode === 'shot' ? 10 : 4));
      this.cam.x += (target.x - this.cam.x) * kk;
      this.cam.y += (target.y - this.cam.y) * kk;
      this.zoom += (tz - this.zoom) * (1 - Math.exp(-dt * 3));
    }
    const S = b.map.size;
    const hw = r.W / this.zoom / 2;
    const hh = r.H / this.zoom / 2;
    this.cam.x = hw * 2 > S ? S / 2 : clamp(this.cam.x, hw - 12, S - hw + 12);
    this.cam.y = hh * 2 > S ? S / 2 : clamp(this.cam.y, hh - 12, S - hh + 12);

    const scr = (p: V2): V2 => ({ x: (p.x - this.cam.x) * this.zoom + r.W / 2, y: (p.y - this.cam.y) * this.zoom + r.H / 2 });
    this.victimMark = vg && vg.alive ? scr(vg.pos) : null;
    this.killerMark = kg ? scr(kg.pos) : null;

    // seen from the killer's side; at night their crew sees by moonlight inside the sight cone
    const pov = kg ?? vg;
    const eye = kg && kg.alive ? kg : vg && vg.alive ? vg : null;
    if (b.weather.id === 'night' && eye) {
      this.polyT -= dt;
      if (this.polyT <= 0) {
        this.polyT = 1 / 20;
        const vc = eye.visionCone();
        this.poly = visibilityPolygon(b.map, eye.turretPos(), eye.gunWorldAng, vc.half, vc.range, vc.near);
      }
    } else this.poly = [];

    // the stand-in battle the renderer draws
    const view = Object.create(b) as Battle;
    const map = Object.create(b.map) as Battle['map'];
    map.smokes = f0.smokes;
    Object.defineProperty(view, 'player', { value: pov, configurable: true });
    Object.defineProperty(view, 'state', { value: 'playing', configurable: true });
    view.map = map;
    view.tanks = tanks;
    view.projectiles = projs;
    view.fx = this.fx!;
    view.grenades = f0.grenades;
    view.flares = f0.flares;
    view.carriers = carriers;
    view.artys = f0.artys;
    view.recons = f0.recons;
    view.visionPoly = this.poly;
    view.time = this.rt;
    const ids = new Set(carriers.map((c) => c.id));
    view.spottedCarriers = [ids, ids];
    view.isSpotted = () => true;
    r.renderReplay(dt, { b: view, cam: this.cam, zoom: this.zoom, focus: pov, shake: this.shake });
  }
}
