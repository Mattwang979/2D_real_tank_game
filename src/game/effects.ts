// Particle effects: muzzle flashes, dust, smoke, fire, sparks, debris, explosions.

import { rand } from '../core/rng';
import type { Theme } from './map';
import { makeCanvas } from '../render/tankRender';

type Ctx = CanvasRenderingContext2D;

export type PKind = 'dust' | 'smoke' | 'dark' | 'fire' | 'flash' | 'spark' | 'debris' | 'muzzle' | 'ring';

export interface Particle {
  kind: PKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  rot: number;
  vr: number;
  alpha: number;
  high: boolean;
  drag: number;
  brake?: number; // muzzle: brake type 0 none 1 brake
}

function puff(rgb: [number, number, number], soft = 0.55): HTMLCanvasElement {
  const c = makeCanvas(64, 64);
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  const [r, gg, b] = rgb;
  g.addColorStop(0, `rgba(${r},${gg},${b},1)`);
  g.addColorStop(soft, `rgba(${r},${gg},${b},0.55)`);
  g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  // a little lumpy texture
  for (let i = 0; i < 6; i++) {
    const x = 18 + Math.random() * 28;
    const y = 18 + Math.random() * 28;
    const g2 = ctx.createRadialGradient(x, y, 0, x, y, 12);
    g2.addColorStop(0, `rgba(${Math.min(255, r + 18)},${Math.min(255, gg + 18)},${Math.min(255, b + 18)},0.35)`);
    g2.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, 64, 64);
  }
  return c;
}

export class Effects {
  parts: Particle[] = [];
  theme: Theme;
  wind = { x: 0.9, y: -0.55 };
  private tex: Record<string, HTMLCanvasElement>;

  constructor(theme: Theme) {
    this.theme = theme;
    const dust: [number, number, number] = theme === 'desert' ? [196, 178, 140] : theme === 'city' ? [150, 146, 138] : [150, 140, 112];
    this.tex = {
      dust: puff(dust, 0.5),
      smoke: puff([120, 118, 112], 0.5),
      dark: puff([38, 36, 34], 0.5),
      fire: puff([255, 150, 50], 0.35),
      flame: puff([232, 96, 28], 0.4),
      white: puff([214, 214, 206], 0.6),
      flash: puff([255, 236, 180], 0.25),
    };
  }

  private add(p: Partial<Particle> & { kind: PKind; x: number; y: number }) {
    if (this.parts.length > 900) this.parts.splice(0, 100);
    this.parts.push({
      vx: 0,
      vy: 0,
      life: 1,
      max: 1,
      size: 1,
      grow: 0,
      rot: rand.range(0, 6.28),
      vr: rand.range(-0.6, 0.6),
      alpha: 1,
      high: false,
      drag: 1.5,
      ...p,
    } as Particle);
  }

  muzzle(x: number, y: number, ang: number, caliber: number, brake: boolean) {
    const s = 0.6 + caliber / 70;
    this.add({ kind: 'muzzle', x, y, rot: ang, life: 0.11, max: 0.11, size: s, high: true, brake: brake ? 1 : 0, vr: 0 });
    this.add({ kind: 'flash', x: x + Math.cos(ang) * s, y: y + Math.sin(ang) * s, life: 0.16, max: 0.16, size: s * 7, high: true, vr: 0 });
    // muzzle smoke
    for (let i = 0; i < 6; i++) {
      const a = ang + rand.range(-0.5, 0.5);
      const sp = rand.range(3, 12);
      this.add({ kind: 'smoke', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(0.7, 1.4), max: 1.4, size: s * rand.range(1.2, 2.2), grow: 2.2, alpha: 0.35, high: true, drag: 2.5 });
    }
    if (brake) {
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const a = ang + side * (Math.PI / 2 + rand.range(0.1, 0.5));
          const sp = rand.range(5, 12);
          this.add({ kind: 'smoke', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(0.5, 1.0), max: 1, size: s * 1.3, grow: 2.5, alpha: 0.35, high: true, drag: 3 });
        }
      }
    }
  }

  /** Overpressure dust thrown up around the gun when firing. */
  fireDust(x: number, y: number, ang: number, caliber: number) {
    const strength = this.theme === 'desert' ? 0.75 : this.theme === 'grass' ? 0.5 : 0.45;
    const n = Math.round((6 + caliber / 12) * strength);
    for (let i = 0; i < n; i++) {
      const a = ang + rand.range(-1.3, 1.3);
      const d = rand.range(0, 2.5);
      const sp = rand.range(1.5, 6);
      this.add({
        kind: 'dust',
        x: x - Math.cos(ang) * 1.5 + Math.cos(a) * d,
        y: y - Math.sin(ang) * 1.5 + Math.sin(a) * d,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: rand.range(1.2, 2.6),
        max: 2.6,
        size: rand.range(1.8, 3.4) * (0.6 + caliber / 150),
        grow: 2.0,
        alpha: 0.42 * strength + 0.1,
        drag: 2.2,
      });
    }
  }

  /** Dust kicked up by moving tracks. */
  trackDust(x: number, y: number, speed: number) {
    if (this.theme === 'city') return;
    const a = this.theme === 'desert' ? 0.32 : 0.14;
    this.add({ kind: 'dust', x: x + rand.range(-0.6, 0.6), y: y + rand.range(-0.6, 0.6), vx: rand.range(-0.5, 0.5), vy: rand.range(-0.5, 0.5), life: rand.range(0.8, 1.6), max: 1.6, size: 1.2 + speed * 0.08, grow: 1.6, alpha: a, drag: 1 });
  }

  impactDust(x: number, y: number, big = false) {
    const n = big ? 10 : 5;
    for (let i = 0; i < n; i++) {
      const a = rand.range(0, 6.28);
      const sp = rand.range(1, big ? 7 : 4);
      this.add({ kind: 'dust', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(0.8, 1.8), max: 1.8, size: rand.range(1, big ? 3.5 : 2), grow: 1.8, alpha: 0.6, drag: 2.5 });
    }
    for (let i = 0; i < 5; i++) {
      const a = rand.range(0, 6.28);
      const sp = rand.range(4, 12);
      this.add({ kind: 'debris', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(0.3, 0.7), max: 0.7, size: rand.range(0.12, 0.3), drag: 3 });
    }
  }

  sparks(x: number, y: number, dirAng: number, n: number, spread = 0.7, speed = 18) {
    for (let i = 0; i < n; i++) {
      const a = dirAng + rand.range(-spread, spread);
      const sp = rand.range(speed * 0.4, speed);
      this.add({ kind: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(0.12, 0.35), max: 0.35, size: rand.range(0.06, 0.12), high: true, drag: 2 });
    }
  }

  hitPuff(x: number, y: number, pen: boolean) {
    this.add({ kind: 'flash', x, y, life: 0.1, max: 0.1, size: pen ? 4 : 2.5, high: true });
    for (let i = 0; i < (pen ? 5 : 3); i++) {
      const a = rand.range(0, 6.28);
      this.add({ kind: pen ? 'dark' : 'smoke', x, y, vx: Math.cos(a) * 1.5, vy: Math.sin(a) * 1.5, life: rand.range(0.6, 1.2), max: 1.2, size: rand.range(0.8, 1.6), grow: 1.5, alpha: 0.6, high: true });
    }
  }

  explosion(x: number, y: number, scale: number) {
    this.add({ kind: 'flash', x, y, life: 0.25, max: 0.25, size: 14 * scale, high: true });
    this.add({ kind: 'ring', x, y, life: 0.35, max: 0.35, size: 2 * scale, grow: 30 * scale, high: true });
    for (let i = 0; i < 14 * scale; i++) {
      const a = rand.range(0, 6.28);
      const sp = rand.range(2, 9) * scale;
      this.add({ kind: 'fire', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(0.4, 0.9), max: 0.9, size: rand.range(1.5, 3.5) * scale, grow: 1.2, high: true, drag: 3 });
    }
    for (let i = 0; i < 12 * scale; i++) {
      const a = rand.range(0, 6.28);
      const sp = rand.range(1, 5) * scale;
      this.add({ kind: 'dark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(1.5, 3.5), max: 3.5, size: rand.range(2, 4) * scale, grow: 1.4, alpha: 0.8, high: true, drag: 1.8 });
    }
    for (let i = 0; i < 12 * scale; i++) {
      const a = rand.range(0, 6.28);
      const sp = rand.range(6, 20);
      this.add({ kind: 'debris', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(0.4, 1.1), max: 1.1, size: rand.range(0.15, 0.45), drag: 2.2 });
    }
    this.sparks(x, y, 0, Math.round(16 * scale), Math.PI, 24);
  }

  heBlast(x: number, y: number, explosive: number) {
    const s = Math.cbrt(explosive) / 9;
    this.add({ kind: 'flash', x, y, life: 0.15, max: 0.15, size: 8 * s + 2, high: true });
    for (let i = 0; i < 8; i++) {
      const a = rand.range(0, 6.28);
      const sp = rand.range(2, 7) * s;
      this.add({ kind: 'fire', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(0.2, 0.45), max: 0.45, size: rand.range(1, 2.2) * s, grow: 1, high: true, drag: 4 });
      this.add({ kind: 'dust', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(1, 2.2), max: 2.2, size: rand.range(1.5, 3) * s, grow: 1.6, alpha: 0.7, drag: 2 });
    }
  }

  /** A building coming down: a wall of dust over its footprint and a spray of debris. */
  collapse(cx: number, cy: number, w: number, h: number, ang: number) {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const n = Math.round(10 + (w * h) / 10);
    for (let i = 0; i < n; i++) {
      const lx = rand.range(-w / 2, w / 2);
      const ly = rand.range(-h / 2, h / 2);
      const x = cx + lx * c - ly * s;
      const y = cy + lx * s + ly * c;
      const a = rand.range(0, 6.28);
      const sp = rand.range(0.5, 3.5);
      this.add({ kind: 'dust', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(2.5, 5), max: 5, size: rand.range(2.5, 5), grow: 1.2, alpha: 0.75, high: true, drag: 1.2 });
    }
    for (let i = 0; i < n; i++) {
      const a = rand.range(0, 6.28);
      const sp = rand.range(5, 16);
      this.add({ kind: 'debris', x: cx + rand.range(-w / 3, w / 3), y: cy + rand.range(-h / 3, h / 3), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand.range(0.4, 1.0), max: 1, size: rand.range(0.2, 0.6), drag: 2.5 });
    }
  }

  fire(x: number, y: number, intensity = 1) {
    this.add({ kind: 'fire', x: x + rand.range(-0.6, 0.6), y: y + rand.range(-0.6, 0.6), vx: this.wind.x * 0.6 + rand.range(-0.4, 0.4), vy: this.wind.y * 0.6 + rand.range(-0.4, 0.4), life: rand.range(0.3, 0.7), max: 0.7, size: rand.range(0.8, 1.8) * intensity, grow: 0.6, high: true, drag: 0.5 });
  }

  smoke(x: number, y: number, dark: boolean, size = 1.5) {
    this.add({
      kind: dark ? 'dark' : 'smoke',
      x: x + rand.range(-0.5, 0.5),
      y: y + rand.range(-0.5, 0.5),
      vx: this.wind.x * rand.range(0.8, 1.6),
      vy: this.wind.y * rand.range(0.8, 1.6),
      life: rand.range(2.5, 5),
      max: 5,
      size: size * rand.range(0.8, 1.3),
      grow: 1.1,
      alpha: dark ? 0.55 : 0.4,
      high: true,
      drag: 0.2,
    });
  }

  /** Thick smoke-screen clouds. */
  drawSmokeClouds(ctx: Ctx, clouds: Array<{ id: number; x: number; y: number; r: number; age: number; life: number }>, x0: number, y0: number, x1: number, y1: number) {
    for (const c of clouds) {
      if (c.x + c.r * 1.6 < x0 || c.x - c.r * 1.6 > x1 || c.y + c.r * 1.6 < y0 || c.y - c.r * 1.6 > y1) continue;
      const fade = Math.min(1, c.age / 0.5) * Math.min(1, (c.life - c.age) / 4);
      const n = 10;
      for (let i = 0; i < n; i++) {
        const h = Math.sin(c.id * 12.9898 + i * 78.233) * 43758.5453;
        const f = h - Math.floor(h);
        const a = (i / n) * Math.PI * 2 + c.age * 0.06 * (i % 2 ? 1 : -1) + f;
        const d = c.r * (0.15 + 0.5 * f);
        const sz = c.r * (0.6 + 0.35 * ((f * 7) % 1));
        const x = c.x + Math.cos(a) * d + this.wind.x * c.age * 0.25;
        const y = c.y + Math.sin(a) * d + this.wind.y * c.age * 0.25;
        ctx.globalAlpha = 0.62 * fade;
        ctx.drawImage(this.tex.white, x - sz, y - sz, sz * 2, sz * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  update(dt: number) {
    const ps = this.parts;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy *= k;
      if (p.kind === 'smoke' || p.kind === 'dark' || p.kind === 'dust') {
        p.vx += this.wind.x * 0.25 * dt;
        p.vy += this.wind.y * 0.25 * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += p.grow * dt;
      p.rot += p.vr * dt;
      ps[w++] = p;
    }
    ps.length = w;
  }

  draw(ctx: Ctx, high: boolean, x0: number, y0: number, x1: number, y1: number) {
    for (const p of this.parts) {
      if (p.high !== high) continue;
      const r = p.size;
      if (p.x + r < x0 || p.x - r > x1 || p.y + r < y0 || p.y - r > y1) continue;
      const t = p.life / p.max; // 1 → 0
      switch (p.kind) {
        case 'dust':
        case 'smoke':
        case 'dark': {
          const fadeIn = Math.min(1, (1 - t) * 6);
          ctx.globalAlpha = p.alpha * t * fadeIn;
          ctx.drawImage(this.tex[p.kind], p.x - r, p.y - r, r * 2, r * 2);
          break;
        }
        case 'fire': {
          // flame body with normal blending (stays orange on bright sand), small additive core
          ctx.globalAlpha = Math.min(1, t * 1.6) * 0.85;
          ctx.drawImage(this.tex.flame, p.x - r, p.y - r, r * 2, r * 2);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = Math.min(1, t * 1.5) * 0.35;
          const rc = r * 0.55;
          ctx.drawImage(this.tex.fire, p.x - rc, p.y - rc, rc * 2, rc * 2);
          ctx.globalCompositeOperation = 'source-over';
          break;
        }
        case 'flash': {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = t * (this.theme === 'desert' ? 0.6 : 0.85);
          ctx.drawImage(this.tex.flash, p.x - r, p.y - r, r * 2, r * 2);
          ctx.globalCompositeOperation = 'source-over';
          break;
        }
        case 'ring':
          ctx.globalAlpha = t * 0.5;
          ctx.strokeStyle = 'rgba(255,240,210,1)';
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'spark': {
          ctx.globalAlpha = Math.min(1, t * 2);
          ctx.strokeStyle = '#ffd27a';
          ctx.lineWidth = p.size;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
          ctx.stroke();
          break;
        }
        case 'debris':
          ctx.globalAlpha = Math.min(1, t * 2);
          ctx.fillStyle = '#2a2722';
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot * 6);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
          ctx.restore();
          break;
        case 'muzzle':
          this.drawMuzzle(ctx, p, t);
          break;
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawMuzzle(ctx: Ctx, p: Particle, t: number) {
    const s = p.size;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, t * 1.6);
    const L = s * 4.2 * (0.7 + t * 0.6);
    const g = ctx.createLinearGradient(0, 0, L, 0);
    g.addColorStop(0, 'rgba(255,255,230,1)');
    g.addColorStop(0.35, 'rgba(255,214,120,0.95)');
    g.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.25);
    ctx.quadraticCurveTo(L * 0.4, -s * 0.9, L, 0);
    ctx.quadraticCurveTo(L * 0.4, s * 0.9, 0, s * 0.25);
    ctx.closePath();
    ctx.fill();
    if (p.brake) {
      for (const side of [-1, 1]) {
        const g2 = ctx.createLinearGradient(0, 0, -s * 0.5, side * s * 2.4);
        g2.addColorStop(0, 'rgba(255,240,190,0.95)');
        g2.addColorStop(1, 'rgba(255,150,50,0)');
        ctx.fillStyle = g2;
        ctx.beginPath();
        ctx.moveTo(-s * 0.1, 0);
        ctx.quadraticCurveTo(s * 0.4, side * s * 1.2, -s * 0.5, side * s * 2.6);
        ctx.quadraticCurveTo(-s * 0.7, side * s * 1.0, -s * 0.1, 0);
        ctx.fill();
      }
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }
}
