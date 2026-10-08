// Renders a Battle: camera, map layers, tanks, projectiles, effects, fog of war, world overlays.

import { type V2, clamp, dist, toWorld } from '../core/math';
import { predictShot, type Prediction } from '../game/armor';
import type { Battle } from '../game/battle';
import { shellObstacleHit } from '../game/map';
import type { Tank } from '../game/tank';
import { MapRenderer } from './mapRender';
import { blitPart, getBurnt, getTankSprites, makeCanvas } from './tankRender';

type Ctx = CanvasRenderingContext2D;

interface Popup {
  text: string;
  x: number;
  y: number;
  t: number;
  color: string;
  big: boolean;
}

export const TEAM_COL = { friend: '#4d97ff', enemy: '#e5483b', neutral: '#d9d9d0' };

export class BattleRenderer {
  canvas: HTMLCanvasElement;
  ctx: Ctx;
  b: Battle;
  mapR: MapRenderer;
  dpr = 1;
  W = 0;
  H = 0;
  cam: V2;
  zoom = 5;
  baseZoom = 5;
  zoomOut = false;
  spriteScale = 12;
  popups: Popup[] = [];
  fog: HTMLCanvasElement;
  fogCtx: Ctx;
  quality: 'high' | 'low';
  spectate: Tank | null = null;
  aimPrediction: Prediction | null = null;
  aimEnd: V2 | null = null;
  shake = 0;
  private chunkBudget = { n: 2 };

  constructor(canvas: HTMLCanvasElement, b: Battle, quality: 'high' | 'low') {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.b = b;
    this.quality = quality;
    this.fog = makeCanvas(16, 16);
    this.fogCtx = this.fog.getContext('2d')!;
    this.resize();
    const p = b.player!;
    this.cam = { x: p.pos.x, y: p.pos.y };
    const chunkScale = clamp(Math.round(this.baseZoom * this.dpr * 1.05), 5, 11);
    this.mapR = new MapRenderer(b.map, chunkScale, quality === 'high' ? 40 : 28);
    b.hooks.stamp = (d) => this.mapR.stamp(d);
    b.hooks.fellTree = (t, dir) => this.mapR.fellTree(t, dir);
    this.mapR.warm(p.pos.x, p.pos.y, 110);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1.25);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.baseZoom = this.H / 64;
    this.zoom = this.zoomOut ? this.H / 115 : this.baseZoom;
    this.spriteScale = clamp(Math.ceil(this.baseZoom * this.dpr * 1.3), 6, 22);
    this.fog.width = Math.ceil(this.W / 2);
    this.fog.height = Math.ceil(this.H / 2);
  }

  toScreen(p: V2): V2 {
    return { x: (p.x - this.cam.x) * this.zoom + this.W / 2, y: (p.y - this.cam.y) * this.zoom + this.H / 2 };
  }
  toWorldPt(s: V2): V2 {
    return { x: (s.x - this.W / 2) / this.zoom + this.cam.x, y: (s.y - this.H / 2) / this.zoom + this.cam.y };
  }

  addPopup(text: string, x: number, y: number, color: string, big: boolean) {
    // stack popups so they don't overlap
    const recent = this.popups.filter((p) => p.t < 0.6 && Math.abs(p.x - x) < 25 && Math.abs(p.y - y) < 25).length;
    this.popups.push({ text, x, y: y - recent * (big ? 5 : 3.5), t: 0, color, big });
  }

  focus(): Tank | null {
    const b = this.b;
    if (b.player && (b.player.alive || b.state !== 'playing')) {
      if (b.player.alive || b.time - b.player.deathTime < 3 || !this.spectate) return b.player;
    }
    if (!this.spectate || !this.spectate.alive) {
      this.spectate = b.tanks.find((t) => t.alive && t.team === b.playerTeam) ?? null;
    }
    return this.spectate ?? b.player;
  }

  render(dt: number) {
    const b = this.b;
    const ctx = this.ctx;
    const f = this.focus();
    const tz = this.zoomOut ? this.H / 115 : this.baseZoom;
    this.zoom += (tz - this.zoom) * (1 - Math.exp(-dt * 6));
    if (f) {
      const look = f.alive ? (this.W / this.zoom) * 0.2 : 0;
      const tx = f.pos.x + Math.cos(f.gunWorldAng) * look;
      const ty = f.pos.y + Math.sin(f.gunWorldAng) * look;
      const k = 1 - Math.exp(-dt * 3.5);
      this.cam.x += (tx - this.cam.x) * k;
      this.cam.y += (ty - this.cam.y) * k;
      // keep the view mostly inside the map
      const S = b.map.size;
      const hw = this.W / this.zoom / 2;
      const hh = this.H / this.zoom / 2;
      const m = 12;
      this.cam.x = hw * 2 > S ? S / 2 : Math.min(Math.max(this.cam.x, hw - m), S - hw + m);
      this.cam.y = hh * 2 > S ? S / 2 : Math.min(Math.max(this.cam.y, hh - m), S - hh + m);
    }
    this.shake = Math.max(0, this.shake - dt * 3);
    const sx = (Math.random() - 0.5) * this.shake * 0.6;
    const sy = (Math.random() - 0.5) * this.shake * 0.6;

    const z = this.zoom;
    const dpr = this.dpr;
    const vw = this.W / z;
    const vh = this.H / z;
    const x0 = this.cam.x - vw / 2 - 4;
    const y0 = this.cam.y - vh / 2 - 4;
    const x1 = this.cam.x + vw / 2 + 4;
    const y1 = this.cam.y + vh / 2 + 4;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(z * dpr, 0, 0, z * dpr, (this.W / 2 - (this.cam.x + sx) * z) * dpr, (this.H / 2 - (this.cam.y + sy) * z) * dpr);

    this.chunkBudget.n = 2;
    this.mapR.drawGround(ctx, x0, y0, x1, y1, this.chunkBudget);
    this.drawCapture(ctx);
    this.mapR.drawWalls(ctx, x0, y0, x1, y1);
    this.mapR.drawTreeShadows(ctx, x0, y0, x1, y1);

    const visible = b.tanks.filter((t) => this.tankVisible(t) && t.pos.x > x0 - 10 && t.pos.x < x1 + 10 && t.pos.y > y0 - 10 && t.pos.y < y1 + 10);
    // subtle ground ring marking the player's own tank
    if (b.player && b.player.alive) {
      const p = b.player;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,240,200,0.28)';
      ctx.lineWidth = 0.22;
      ctx.setLineDash([1.1, 0.8]);
      ctx.beginPath();
      ctx.arc(p.pos.x, p.pos.y, p.bp.radius + 1.1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    for (const t of visible) this.drawTankShadow(ctx, t);
    // wrecks first, then live tanks
    for (const t of visible) if (!t.alive) this.drawTank(ctx, t);
    for (const t of visible) if (t.alive) this.drawTank(ctx, t);
    b.fx.draw(ctx, false, x0, y0, x1, y1);
    this.drawProjectiles(ctx);
    this.mapR.drawBuildings(ctx, x0, y0, x1, y1);
    // flying turrets above roofs
    for (const t of visible) if (t.turretOff && t.turretOff.h > 0) this.drawFlyingTurret(ctx, t);
    this.mapR.drawTrees(ctx, x0, y0, x1, y1, b.player && b.player.alive ? b.player.pos : null);
    b.fx.draw(ctx, true, x0, y0, x1, y1);

    // fog of war outside the player's vision polygon
    if (b.player && b.player.alive && b.visionPoly.length > 2) this.drawFog(ctx);

    this.drawOverlays(ctx, dt);
  }

  private tankVisible(t: Tank): boolean {
    const b = this.b;
    if (!t.alive) return true;
    if (t.team === b.playerTeam) return true;
    return b.isSpotted(b.playerTeam, t);
  }

  private drawCapture(ctx: Ctx) {
    const b = this.b;
    const c = b.map.capture;
    const cap = b.capture;
    const own = cap.owner === -1 ? 'neutral' : cap.owner === b.playerTeam ? 'friend' : 'enemy';
    const col = TEAM_COL[own];
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = col;
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.18;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r - 1.2, 0, Math.PI * 2);
    ctx.stroke();
    // progress arc
    const prog = b.playerTeam === 0 ? cap.progress : -cap.progress;
    if (Math.abs(prog) > 0.001 && Math.abs(prog) < 1) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = prog > 0 ? TEAM_COL.friend : TEAM_COL.enemy;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r + 0.8, -Math.PI / 2, -Math.PI / 2 + Math.abs(prog) * Math.PI * 2);
      ctx.stroke();
    }
    // centre letter
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(15,20,30,0.55)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 0.3;
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.font = '700 2.6px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('A', c.x, c.y + 0.15);
    ctx.restore();
  }

  private drawTankShadow(ctx: Ctx, t: Tank) {
    const sh = this.b.map.shadow;
    const S = getTankSprites(t.spec, this.spriteScale);
    ctx.save();
    ctx.globalAlpha = 0.38;
    ctx.translate(t.pos.x + sh.x * 1.6, t.pos.y + sh.y * 1.6);
    ctx.rotate(t.ang);
    blitPart(ctx, S.hullShadow);
    if (!t.turretOff) {
      ctx.translate(t.bp.turretX + sh.x * 0.3, sh.y * 0.3);
      ctx.rotate(t.turretRel);
      if (!t.bp.casemate) {
        ctx.save();
        ctx.translate(t.bp.gunPivot.x, t.bp.gunPivot.y);
        ctx.rotate(t.gunRel);
        blitPart(ctx, S.gunShadow);
        ctx.restore();
      }
      blitPart(ctx, S.turretShadow);
    }
    ctx.restore();
  }

  private drawTank(ctx: Ctx, t: Tank) {
    const S = getTankSprites(t.spec, this.spriteScale);
    const P = t.alive ? S : getBurnt(t.spec, this.spriteScale);
    ctx.save();
    ctx.translate(t.pos.x, t.pos.y);
    ctx.rotate(t.ang);
    blitPart(ctx, P.hull);
    if (!t.turretOff) {
      ctx.translate(t.bp.turretX, 0);
      ctx.rotate(t.turretRel);
      // turret shadow onto hull
      ctx.save();
      ctx.globalAlpha = 0.3;
      blitPart(ctx, S.turretShadow, -0.15, 0.18);
      ctx.restore();
      const recoil = -t.recoil * 0.45;
      if (t.bp.casemate) {
        blitPart(ctx, P.turret);
        ctx.translate(t.bp.gunPivot.x, t.bp.gunPivot.y);
        ctx.rotate(t.gunRel);
        blitPart(ctx, P.gun, recoil, 0);
      } else {
        ctx.save();
        ctx.translate(t.bp.gunPivot.x, t.bp.gunPivot.y);
        ctx.rotate(t.gunRel);
        blitPart(ctx, P.gun, recoil, 0);
        ctx.restore();
        blitPart(ctx, P.turret);
      }
    }
    ctx.restore();
    // landed blown-off turret
    if (t.turretOff && t.turretOff.h <= 0) this.drawFlyingTurret(ctx, t);
  }

  private drawFlyingTurret(ctx: Ctx, t: Tank) {
    const o = t.turretOff!;
    const P = getBurnt(t.spec, this.spriteScale);
    const S = getTankSprites(t.spec, this.spriteScale);
    const sc = 1 + o.h * 0.04;
    const sh = this.b.map.shadow;
    ctx.save();
    ctx.translate(o.pos.x + sh.x * (0.4 + o.h * 0.8), o.pos.y + sh.y * (0.4 + o.h * 0.8));
    ctx.rotate(o.ang);
    ctx.globalAlpha = 0.35;
    blitPart(ctx, S.turretShadow);
    ctx.restore();
    ctx.save();
    ctx.translate(o.pos.x, o.pos.y);
    ctx.rotate(o.ang);
    ctx.scale(sc, sc);
    if (!t.bp.casemate) blitPart(ctx, P.gun);
    blitPart(ctx, P.turret);
    ctx.restore();
  }

  private drawProjectiles(ctx: Ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of this.b.projectiles) {
      const len = Math.min(7, p.dist + 0.5);
      const tx = p.x - p.dx * len;
      const ty = p.y - p.dy * len;
      const g = ctx.createLinearGradient(tx, ty, p.x, p.y);
      g.addColorStop(0, 'rgba(255,140,40,0)');
      g.addColorStop(1, p.ricochet ? 'rgba(255,220,150,0.8)' : 'rgba(255,200,110,0.95)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 0.22 + p.shell.caliber / 900;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,245,220,0.95)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 0.16 + p.shell.caliber / 1200, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawFog(ctx: Ctx) {
    const fc = this.fogCtx;
    const fw = this.fog.width;
    const fh = this.fog.height;
    const k = fw / this.W;
    fc.setTransform(1, 0, 0, 1, 0, 0);
    fc.globalCompositeOperation = 'source-over';
    fc.clearRect(0, 0, fw, fh);
    fc.fillStyle = 'rgba(6,8,6,0.5)';
    fc.fillRect(0, 0, fw, fh);
    fc.globalCompositeOperation = 'destination-out';
    fc.setTransform(this.zoom * k, 0, 0, this.zoom * k, (this.W / 2 - this.cam.x * this.zoom) * k, (this.H / 2 - this.cam.y * this.zoom) * k);
    const poly = this.b.visionPoly;
    fc.beginPath();
    fc.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) fc.lineTo(poly[i].x, poly[i].y);
    fc.closePath();
    fc.fillStyle = '#000';
    fc.fill();
    fc.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fog, 0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
  }

  private drawOverlays(ctx: Ctx, dt: number) {
    const b = this.b;
    const z = this.zoom;
    const dpr = this.dpr;
    ctx.save();
    ctx.setTransform(z * dpr, 0, 0, z * dpr, (this.W / 2 - this.cam.x * z) * dpr, (this.H / 2 - this.cam.y * z) * dpr);
    const p = b.player;

    // aim line + reticle
    this.aimPrediction = null;
    this.aimEnd = null;
    if (p && p.alive) {
      const m = p.muzzle();
      const a = p.gunWorldAng;
      const d = { x: Math.cos(a), y: Math.sin(a) };
      const far = { x: m.x + d.x * 400, y: m.y + d.y * 400 };
      let end = far;
      const obs = shellObstacleHit(b.map, m, far);
      if (obs) end = { x: m.x + (far.x - m.x) * obs.t, y: m.y + (far.y - m.y) * obs.t };
      // first visible enemy along the line
      let tgt: Tank | null = null;
      let tgtD = dist(m, end);
      for (const e of b.tanks) {
        if (!e.alive || e.team === p.team || !b.isSpotted(p.team, e)) continue;
        const pr = predictShot(p, e, p.spec.gun.shells[p.shellIdx], m, d);
        if (pr.outcome === 'none') continue;
        const de = dist(m, e.pos) - e.bp.radius * 0.5;
        if (de < tgtD) {
          tgtD = de;
          tgt = e;
          this.aimPrediction = pr;
        }
      }
      end = { x: m.x + d.x * tgtD, y: m.y + d.y * tgtD };
      this.aimEnd = end;
      ctx.setLineDash([1.2, 1.4]);
      ctx.strokeStyle = 'rgba(255,255,240,0.32)';
      ctx.lineWidth = 0.16;
      ctx.beginPath();
      ctx.moveTo(m.x + d.x * 1.5, m.y + d.y * 1.5);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // desired aim (where the stick points) when turret lags behind
      const err = Math.abs(((p.aimAngle - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (err > 0.03) {
        const da = { x: Math.cos(p.aimAngle), y: Math.sin(p.aimAngle) };
        const tp = p.turretPos();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 0.12;
        ctx.beginPath();
        ctx.moveTo(tp.x + da.x * 6, tp.y + da.y * 6);
        ctx.lineTo(tp.x + da.x * 40, tp.y + da.y * 40);
        ctx.stroke();
      }
      // reticle
      const disp = p.dispersion();
      const rr = Math.max(0.8, tgtD * Math.tan(disp) * 2);
      const col = this.aimPrediction ? predColor(this.aimPrediction.outcome) : 'rgba(255,255,240,0.7)';
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.22;
      ctx.beginPath();
      ctx.arc(end.x, end.y, rr, 0, Math.PI * 2);
      ctx.stroke();
      // reload arc
      if (!p.isReloaded()) {
        const frac = 1 - p.reloadLeft / p.reloadTime();
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 0.35;
        ctx.beginPath();
        ctx.arc(end.x, end.y, rr + 0.7, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = col;
      for (let i = 0; i < 4; i++) {
        const aa = (i * Math.PI) / 2;
        ctx.fillRect(end.x + Math.cos(aa) * (rr + 0.2) - 0.12, end.y + Math.sin(aa) * (rr + 0.2) - 0.12, 0.24, 0.24);
      }
      void tgt;
    }

    // tank markers
    for (const t of b.tanks) {
      if (!t.alive || t.isPlayer) continue;
      const friend = t.team === b.playerTeam;
      if (!friend && !b.isSpotted(b.playerTeam, t)) continue;
      const col = friend ? TEAM_COL.friend : TEAM_COL.enemy;
      const y = t.pos.y - t.bp.radius - 2.2;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(t.pos.x - 0.9, y - 0.8);
      ctx.lineTo(t.pos.x + 0.9, y - 0.8);
      ctx.lineTo(t.pos.x, y + 0.4);
      ctx.closePath();
      ctx.fill();
      if (!friend && p && dist(p.pos, t.pos) < 260) {
        ctx.font = '600 1.7px "Barlow Condensed", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,190,180,0.85)';
        ctx.fillText(t.spec.name, t.pos.x, y - 1.3);
      }
    }

    // popups
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const keep: Popup[] = [];
    for (const pp of this.popups) {
      pp.t += dt;
      const life = pp.big ? 2.6 : 1.8;
      if (pp.t > life) continue;
      keep.push(pp);
      const a = pp.t < 0.15 ? pp.t / 0.15 : pp.t > life - 0.5 ? (life - pp.t) / 0.5 : 1;
      const yy = pp.y - 3 - pp.t * 2.2;
      const fs = (pp.big ? 2.7 : 2.0) * (this.baseZoom / this.zoom) ** 0.3;
      ctx.font = `italic 700 ${fs}px "Barlow Condensed", sans-serif`;
      ctx.globalAlpha = a;
      ctx.lineWidth = 0.45;
      ctx.strokeStyle = 'rgba(30,18,6,0.85)';
      ctx.strokeText(pp.text, pp.x, yy);
      ctx.fillStyle = pp.color;
      ctx.fillText(pp.text, pp.x, yy);
    }
    ctx.globalAlpha = 1;
    this.popups = keep;
    ctx.restore();
  }
}

export function predColor(o: Prediction['outcome']): string {
  switch (o) {
    case 'pen':
      return 'rgba(110,230,120,0.95)';
    case 'maybe':
      return 'rgba(250,210,80,0.95)';
    case 'no':
    case 'ricochet':
      return 'rgba(240,90,70,0.95)';
    default:
      return 'rgba(255,255,240,0.7)';
  }
}

export { toWorld };
