// Title screen with an animated top-down tank column driving across sand.

import { VEHICLES } from '../data/vehicles';
import { drawTankShadowVector, drawTankVector } from '../render/tankRender';
import { h } from './common';
import { t } from './i18n';

export class Title {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  running = false;
  onStart: () => void = () => {};
  private x = 0;

  constructor(el: HTMLElement) {
    this.el = el;
    this.canvas = h('canvas');
    el.append(
      this.canvas,
      h(
        'div',
        { class: 'logo-wrap' },
        h('div', { class: 'logo' }, 'PENE', h('span', {}, 'TRATION')),
        h('div', { class: 'sub' }, 'Armor · Crew · Modules'),
        h('div', { class: 'tap', 'data-i18n': 'TAP TO START' }, t('TAP TO START')),
      ),
    );
    el.addEventListener('pointerup', () => this.onStart());
  }

  start() {
    this.running = true;
    let last = performance.now();
    const tanks = [VEHICLES.find((v) => v.id === 'tiger1')!, VEHICLES.find((v) => v.id === 'pantherG')!, VEHICLES.find((v) => v.id === 'is2')!];
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.x += dt * 3.2;
      const c = this.canvas;
      const r = c.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(r.width * dpr)) {
        c.width = Math.round(r.width * dpr);
        c.height = Math.round(r.height * dpr);
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = r.width;
      const H = r.height;
      ctx.fillStyle = '#7f7158';
      ctx.fillRect(0, 0, W, H);
      const sc = H / 26;
      // dusty ground blotches
      for (let i = 0; i < 18; i++) {
        const gx = ((i * 137.5 + this.x * sc * 0.5) % (W + 300)) - 150;
        const gy = ((i * 61.3) % H) + 10;
        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, 120);
        g.addColorStop(0, i % 2 ? 'rgba(160,140,105,0.45)' : 'rgba(90,78,58,0.4)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(gx - 120, gy - 120, 240, 240);
      }
      // track marks
      ctx.fillStyle = 'rgba(70,58,40,0.35)';
      for (let k = 0; k < 3; k++) {
        const y = H * (0.3 + k * 0.22);
        for (let x = -((this.x * sc) % 14); x < W; x += 14) {
          ctx.fillRect(x, y - 1.5 * sc, 7, 0.6 * sc);
          ctx.fillRect(x, y + 0.9 * sc, 7, 0.6 * sc);
        }
      }
      tanks.forEach((v, k) => {
        const y = H * (0.3 + k * 0.22);
        const x = ((this.x * sc * (1 + k * 0.08) + k * W * 0.4) % (W + 12 * sc)) - 6 * sc;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(sc, sc);
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.translate(-0.4, 0.5);
        drawTankShadowVector(ctx, v, Math.sin(now / 1500 + k) * 0.3);
        ctx.restore();
        drawTankVector(ctx, v, Math.sin(now / 1500 + k) * 0.3, 0);
        ctx.restore();
      });
      // darken & vignette for legibility
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, W * 0.7);
      g.addColorStop(0, 'rgba(10,12,10,0.55)');
      g.addColorStop(1, 'rgba(10,12,10,0.9)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }
}
