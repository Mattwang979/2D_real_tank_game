// Weather visuals: rain (streaks, splashes on the ground, lightning), fog banks and haze, and the
// night: darkness that only flares, fires, gun flashes and the crew's own sight push back.

import { clamp } from '../core/math';
import { audio } from '../core/audio';
import type { Battle } from '../game/battle';
import { FLARE, flareLight } from '../game/weather';
import type { BattleRenderer } from './battleRender';
import { makeCanvas } from './tankRender';

type Ctx = CanvasRenderingContext2D;

interface Drop {
  x: number;
  y: number;
  v: number;
  l: number;
}
interface Splash {
  x: number;
  y: number;
  t: number;
}
interface Wisp {
  x: number;
  y: number;
  r: number;
  a: number;
}

/** Fog-of-war tint outside the crew's sight, per weather. */
const FOG_OF_WAR: Record<string, string> = {
  clear: 'rgba(6,8,6,0.5)',
  rain: 'rgba(8,12,20,0.55)',
  fog: 'rgba(176,182,180,0.55)',
  night: 'rgba(6,8,6,0.5)',
};

const SLANT = 0.32; // rain streak slant (dx per dy)

export class WeatherFx {
  b: Battle;
  low: boolean;
  private drops: Drop[] = [];
  private splashes: Splash[] = [];
  private splashAcc = 0;
  private wisps: Wisp[] = [];
  private bolt = 0;
  private boltIn: number;
  private flickers: number[] = [];
  private light: HTMLCanvasElement;
  private lc: Ctx;
  private wispTex: HTMLCanvasElement;
  private glowTex: HTMLCanvasElement;
  private smokeAcc = 0;

  constructor(b: Battle, low: boolean) {
    this.b = b;
    this.low = low;
    this.boltIn = 6 + Math.random() * 10;
    this.light = makeCanvas(16, 16);
    this.lc = this.light.getContext('2d')!;
    this.wispTex = softDisc(128, [205, 210, 207]);
    this.glowTex = softDisc(64, [255, 236, 190]);
  }

  get id() {
    return this.b.weather.id;
  }

  fogColor(): string {
    return FOG_OF_WAR[this.id] ?? FOG_OF_WAR.clear;
  }

  /** Match the half-resolution light map to the screen. */
  resize(W: number, H: number) {
    this.light.width = Math.max(1, Math.ceil(W / 2));
    this.light.height = Math.max(1, Math.ceil(H / 2));
    this.drops = [];
  }

  update(dt: number, r: BattleRenderer) {
    const id = this.id;
    if (id === 'rain') this.updateRain(dt, r);
    else if (id === 'fog') this.updateWisps(dt, r);
    else if (id === 'night') {
      // burning flares trail a little smoke
      this.smokeAcc += dt;
      if (this.smokeAcc > 0.35) {
        this.smokeAcc = 0;
        for (const f of this.b.flares) {
          if (f.t < FLARE.FLIGHT) continue;
          const l = flareLight(f);
          if (l.k > 0.2) this.b.fx.smoke(l.x, l.y, false, 0.9);
        }
      }
    }
  }

  private updateRain(dt: number, r: BattleRenderer) {
    const W = r.W;
    const H = r.H;
    const want = Math.round(((W * H) / 2600) * (this.low ? 0.5 : 1));
    while (this.drops.length < want) this.drops.push({ x: Math.random() * (W + 80) - 80, y: Math.random() * H, v: 700 + Math.random() * 450, l: 10 + Math.random() * 12 });
    if (this.drops.length > want) this.drops.length = want;
    for (const d of this.drops) {
      d.y += d.v * dt;
      d.x += d.v * SLANT * dt;
      if (d.y > H + 24 || d.x > W + 24) {
        d.y = -24 - Math.random() * 60;
        d.x = Math.random() * (W + 120) - 120;
      }
    }
    // splashes on the ground around the camera
    const vw = W / r.zoom;
    const vh = H / r.zoom;
    this.splashAcc += dt * Math.min(70, vw * vh * 0.006) * (this.low ? 0.5 : 1);
    while (this.splashAcc >= 1) {
      this.splashAcc -= 1;
      this.splashes.push({ x: r.cam.x + (Math.random() - 0.5) * vw, y: r.cam.y + (Math.random() - 0.5) * vh, t: 0 });
    }
    for (const s of this.splashes) s.t += dt;
    this.splashes = this.splashes.filter((s) => s.t < 0.32);
    // lightning now and then, thunder a moment later
    this.boltIn -= dt;
    if (this.boltIn <= 0) {
      this.boltIn = 14 + Math.random() * 20;
      this.bolt = 1;
      this.flickers = [0.11, 0.27].filter(() => Math.random() < 0.8);
      audio.thunder(0.5 + Math.random() * 2.4, 0.8 + Math.random() * 0.3);
    }
    if (this.flickers.length) {
      this.flickers = this.flickers.map((t) => t - dt);
      if (this.flickers[0] <= 0) {
        this.flickers.shift();
        this.bolt = Math.max(this.bolt, 0.65);
      }
    }
    this.bolt = Math.max(0, this.bolt - dt * 7);
  }

  private updateWisps(dt: number, r: BattleRenderer) {
    const vw = r.W / r.zoom;
    const vh = r.H / r.zoom;
    const n = this.low ? 7 : 12;
    const wind = this.b.fx.wind;
    const spawn = (anywhere: boolean): Wisp => {
      const rr = 16 + Math.random() * 26;
      let x = r.cam.x + (Math.random() - 0.5) * (vw + rr * 2);
      let y = r.cam.y + (Math.random() - 0.5) * (vh + rr * 2);
      if (!anywhere) {
        // enter from the upwind edge
        if (Math.random() < Math.abs(wind.x) / (Math.abs(wind.x) + Math.abs(wind.y))) x = r.cam.x - Math.sign(wind.x) * (vw / 2 + rr);
        else y = r.cam.y - Math.sign(wind.y) * (vh / 2 + rr);
      }
      return { x, y, r: rr, a: 0.1 + Math.random() * 0.12 };
    };
    while (this.wisps.length < n) this.wisps.push(spawn(true));
    for (let i = 0; i < this.wisps.length; i++) {
      const w = this.wisps[i];
      w.x += wind.x * 1.6 * dt;
      w.y += wind.y * 1.6 * dt;
      if (Math.abs(w.x - r.cam.x) > vw / 2 + w.r + 30 || Math.abs(w.y - r.cam.y) > vh / 2 + w.r + 30) this.wisps[i] = spawn(false);
    }
  }

  // ------------------------------------------------------------------ drawing
  /** Ground-level weather in world space (under the fog of war / darkness). */
  drawWorld(ctx: Ctx, x0: number, y0: number, x1: number, y1: number) {
    const id = this.id;
    if (id === 'rain') {
      ctx.save();
      ctx.strokeStyle = 'rgba(205,218,235,1)';
      ctx.lineWidth = 0.07;
      for (const s of this.splashes) {
        const k = s.t / 0.32;
        ctx.globalAlpha = 0.4 * (1 - k);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 0.12 + k * 0.55, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    } else if (id === 'fog') {
      ctx.save();
      for (const w of this.wisps) {
        if (w.x + w.r < x0 || w.x - w.r > x1 || w.y + w.r < y0 || w.y - w.r > y1) continue;
        ctx.globalAlpha = w.a;
        ctx.drawImage(this.wispTex, w.x - w.r, w.y - w.r * 0.7, w.r * 2, w.r * 1.4);
      }
      ctx.restore();
    }
  }

  /**
   * Night: darkness over everything, cut open by the crew's sight (moonlight), flares, fires and
   * flashes; then the glowing things are drawn again on top so they shine.
   */
  drawNight(ctx: Ctx, r: BattleRenderer, x0: number, y0: number, x1: number, y1: number) {
    const b = this.b;
    const lc = this.lc;
    const L = this.light;
    const k = L.width / r.W;
    const z = r.zoom;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, L.width, L.height);
    lc.fillStyle = 'rgba(4,8,20,0.9)';
    lc.fillRect(0, 0, L.width, L.height);
    lc.globalCompositeOperation = 'destination-out';
    lc.setTransform(z * k, 0, 0, z * k, (r.W / 2 - r.cam.x * z) * k, (r.H / 2 - r.cam.y * z) * k);
    const hole = (x: number, y: number, rad: number, a: number) => {
      if (rad <= 0 || a <= 0.01 || x + rad < x0 || x - rad > x1 || y + rad < y0 || y - rad > y1) return;
      const g = lc.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `rgba(0,0,0,${Math.min(1, a)})`);
      g.addColorStop(0.55, `rgba(0,0,0,${Math.min(1, a) * 0.75})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lc.fillStyle = g;
      lc.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    };
    // what the crew can make out by moonlight
    const p = b.player;
    if (p && p.alive && b.visionPoly.length > 2) {
      const poly = b.visionPoly;
      lc.fillStyle = 'rgba(0,0,0,0.47)';
      lc.beginPath();
      lc.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) lc.lineTo(poly[i].x, poly[i].y);
      lc.closePath();
      lc.fill();
    }
    const f = r.focus();
    if (f && f.alive) hole(f.pos.x, f.pos.y, 9, 0.42);
    const now = b.time;
    // flares
    for (const fl of b.flares) {
      if (fl.t < FLARE.FLIGHT) continue;
      const l = flareLight(fl);
      hole(l.x, l.y, l.r, 0.97 * l.k);
    }
    // fires: burning tanks, wrecks, carriers
    for (const t of b.tanks) {
      const fire = t.alive ? t.burning > 0 : t.wreckFire > 0;
      if (!fire) continue;
      const fl = 0.85 + 0.15 * Math.sin(now * 17 + t.id * 2.3);
      hole(t.pos.x, t.pos.y, t.alive ? 12 : 14, 0.75 * fl);
    }
    for (const c of b.carriers) if (c.state === 'dead' && c.t < 18) hole(c.pos.x, c.pos.y, 10, 0.6 * (0.85 + 0.15 * Math.sin(now * 15 + c.id)));
    // flashes: gun blasts, hits, explosions
    for (const q of b.fx.parts) {
      if (q.kind === 'flash') hole(q.x, q.y, q.size * 2.2, Math.min(0.95, (q.life / q.max) * 1.3));
      else if (q.kind === 'muzzle') hole(q.x, q.y, q.size * 9, q.life / q.max);
    }
    // warm tint inside the pools of light (painted behind the darkness, on the small light map)
    lc.globalCompositeOperation = 'destination-over';
    const tint = (x: number, y: number, rad: number, rgb: string, a: number) => {
      if (x + rad < x0 || x - rad > x1 || y + rad < y0 || y - rad > y1) return;
      const g = lc.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      lc.fillStyle = g;
      lc.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    };
    for (const fl of b.flares) {
      if (fl.t < FLARE.FLIGHT) continue;
      const l = flareLight(fl);
      tint(l.x, l.y, l.r, '255,214,150', 0.16 * l.k);
    }
    for (const t of b.tanks) {
      const fire = t.alive ? t.burning > 0 : t.wreckFire > 0;
      if (fire) tint(t.pos.x, t.pos.y, 11, '255,120,40', 0.22);
    }
    lc.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(L, 0, 0, r.canvas.width, r.canvas.height);
    ctx.restore();
    // glowing things on top of the dark
    b.fx.drawEmissive(ctx, x0, y0, x1, y1);
    r.drawProjectiles(ctx);
    this.drawFlares(ctx);
    // the objective stays readable
    ctx.save();
    ctx.globalAlpha = 0.55;
    r.drawCapture(ctx);
    ctx.restore();
  }

  /** The flares themselves: a streak going up, then a dazzling point of light drifting down. */
  private drawFlares(ctx: Ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of this.b.flares) {
      const l = flareLight(f);
      if (f.t < FLARE.FLIGHT) {
        const u = f.t / FLARE.FLIGHT;
        const tx = f.x0 + (f.x1 - f.x0) * Math.max(0, u - 0.15);
        const ty = f.y0 + (f.y1 - f.y0) * Math.max(0, u - 0.15);
        const g = ctx.createLinearGradient(tx, ty, l.x, l.y);
        g.addColorStop(0, 'rgba(255,200,120,0)');
        g.addColorStop(1, 'rgba(255,230,170,0.9)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 0.35;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(l.x, l.y);
        ctx.stroke();
        ctx.globalAlpha = 0.9;
        ctx.drawImage(this.glowTex, l.x - 1.5, l.y - 1.5, 3, 3);
        ctx.globalAlpha = 1;
        continue;
      }
      const s = 3 + 2.5 * l.k;
      ctx.globalAlpha = clamp(l.k, 0, 1);
      ctx.drawImage(this.glowTex, l.x - s, l.y - s, s * 2, s * 2);
      ctx.fillStyle = 'rgba(255,255,240,0.95)';
      ctx.beginPath();
      ctx.arc(l.x, l.y, 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Screen-space weather on top of the scene: haze, rain, lightning. */
  drawScreen(ctx: Ctx, r: BattleRenderer) {
    const id = this.id;
    if (id === 'clear' || id === 'night') return;
    const W = r.W;
    const H = r.H;
    ctx.save();
    ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    if (id === 'fog') {
      // haze thickens with distance from our tank
      const f = r.focus();
      const c = f ? r.toScreen(f.pos) : { x: W / 2, y: H / 2 };
      const range = f ? f.visionCone().range : 120;
      const z = r.zoom;
      const g = ctx.createRadialGradient(c.x, c.y, 12 * z, c.x, c.y, Math.max(13 * z, range * 1.05 * z));
      g.addColorStop(0, 'rgba(198,204,201,0)');
      g.addColorStop(0.45, 'rgba(198,204,201,0.22)');
      g.addColorStop(1, 'rgba(198,204,201,0.5)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    } else if (id === 'rain') {
      ctx.fillStyle = 'rgba(16,26,40,0.2)';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(196,210,230,0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const d of this.drops) {
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - d.l * SLANT, d.y - d.l);
      }
      ctx.stroke();
      if (this.bolt > 0) {
        ctx.fillStyle = `rgba(222,230,255,${this.bolt * 0.38})`;
        ctx.fillRect(0, 0, W, H);
      }
    }
    ctx.restore();
  }
}

function softDisc(size: number, rgb: [number, number, number]): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d')!;
  const h = size / 2;
  const grad = g.createRadialGradient(h, h, 0, h, h, h);
  const [r, gg, b] = rgb;
  grad.addColorStop(0, `rgba(${r},${gg},${b},1)`);
  grad.addColorStop(0.5, `rgba(${r},${gg},${b},0.6)`);
  grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}
