// Hangar screen: vehicle on a turntable, stats, view modes (exterior / armor / x-ray), lineup, map choice.

import { formatNum } from '../core/math';
import { get, save, toggleLineup } from '../core/save';
import { CLASS_NAMES, getVehicle, type VehicleSpec } from '../data/vehicles';
import { MAPS } from '../game/map';
import { drawArmorView, drawTankShadowVector, drawTankVector, drawXray, drawTankSprite } from '../render/tankRender';
import { NATION_FLAG, h, modal, toast, vehicleStats } from './common';
import { t } from './i18n';

type Mode = 'ext' | 'armor' | 'xray';

export class Hangar {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  mode: Mode = 'ext';
  rot = -Math.PI / 2 - 0.55;
  turret = 0;
  private drag: { x: number; rot: number } | null = null;
  private running = false;
  private last = 0;
  private idleT = 0;
  onBattle: () => void = () => {};
  onTree: () => void = () => {};
  onSettings: () => void = () => {};

  private info!: HTMLElement;
  private cur!: HTMLElement;
  private lineupEl!: HTMLElement;
  private modesEl!: HTMLElement;
  private mapsEl!: HTMLElement;
  private actionsEl!: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    this.canvas = h('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.build();
    this.canvas.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, rot: this.rot };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.drag) this.rot = this.drag.rot + (e.clientX - this.drag.x) * 0.012;
    });
    const up = () => {
      this.drag = null;
      this.idleT = 0;
    };
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  }

  build() {
    this.el.innerHTML = '';
    this.cur = h('div', { style: 'display:flex;gap:8px' });
    const top = h(
      'div',
      { class: 'topbar' },
      h('div', { class: 'logo' }, 'PENE', h('span', {}, 'TRATION')),
      this.cur,
      h('button', { class: 'icon-btn', onclick: () => this.onSettings(), 'aria-label': 'Settings' }, '⚙'),
    );
    this.info = h('div', { class: 'veh-info' });
    this.mapsEl = h('div', { class: 'map-pick' });
    this.actionsEl = h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => this.onBattle() }, t('BATTLE')),
      h('div', { class: 'label' }, t('Map')),
      this.mapsEl,
      h('div', { style: 'flex:1' }),
      h('button', { class: 'btn', onclick: () => this.onTree() }, t('TECH TREE')),
    );
    this.modesEl = h('div', { class: 'seg viewmodes' });
    this.lineupEl = h('div', { class: 'lineup-bar' });
    this.el.append(h('div', { class: 'tt' }, this.canvas), top, this.info, this.actionsEl, this.modesEl, this.lineupEl);
  }

  refresh() {
    this.build();
    const s = get();
    this.cur.innerHTML = '';
    this.cur.append(h('div', { class: 'cur cr' }, h('b', {}, 'CR'), h('i', {}, formatNum(s.credits))), h('div', { class: 'cur rp' }, h('b', {}, t('Free RP')), h('i', {}, formatNum(s.rpFree))));
    const v = getVehicle(s.selected);
    const st = vehicleStats(v);
    this.info.innerHTML = '';
    this.info.append(
      h('div', { class: 'name' }, v.name),
      h('div', { class: 'meta' }, h('span', { class: 'br' }, `BR ${v.br.toFixed(1)}`), h('span', {}, `${NATION_FLAG[v.nation]} · ${t(CLASS_NAMES[v.cls])} · ${t('Crew')} ${v.crew.length}`)),
      h(
        'div',
        { class: 'stat-group' },
        h('h4', {}, `${t('Firepower')} · `, h('em', {}, v.gun.name)),
        h('div', { class: 'stat' }, h('span', {}, t('Penetration')), h('b', {}, `${st.pen} mm`)),
        h('div', { class: 'stat' }, h('span', {}, t('Reload')), h('b', {}, `${st.reload.toFixed(1)} s`)),
      ),
      h(
        'div',
        { class: 'stat-group' },
        h('h4', {}, t('Survivability')),
        h('div', { class: 'stat' }, h('span', {}, t('Hull front')), h('b', {}, `${st.hullFront} mm`)),
        h('div', { class: 'stat' }, h('span', {}, t('Turret front')), h('b', {}, `${st.turretFront} mm`)),
      ),
      h(
        'div',
        { class: 'stat-group' },
        h('h4', {}, t('Mobility')),
        h('div', { class: 'stat' }, h('span', {}, t('Top speed')), h('b', {}, `${st.speed} km/h`)),
        h('div', { class: 'stat' }, h('span', {}, t('Power/weight')), h('b', {}, `${st.pw} hp/t`)),
      ),
    );
    // maps
    const maps: Array<[string, string]> = [['random', t('Random')], ...MAPS.map((m) => [m.id, t(m.name)] as [string, string])];
    for (const [id, name] of maps) {
      this.mapsEl.append(
        h('button', {
          class: s.settings.map === id ? 'on' : '',
          onclick: () => {
            s.settings.map = id;
            save();
            this.refresh();
          },
        }, name),
      );
    }
    // view modes
    for (const [m, label] of [
      ['ext', t('Exterior')],
      ['armor', t('Armor')],
      ['xray', t('X-Ray')],
    ] as Array<[Mode, string]>) {
      this.modesEl.append(
        h('button', {
          class: this.mode === m ? 'on' : '',
          onclick: () => {
            this.mode = m;
            [...this.modesEl.children].forEach((c, i) => c.classList.toggle('on', i === ['ext', 'armor', 'xray'].indexOf(m)));
          },
        }, label),
      );
    }
    // lineup
    this.lineupEl.append(h('div', { class: 'label' }, t('Lineup')));
    s.lineup.forEach((id, i) => {
      const lv = getVehicle(id);
      const c = h('canvas');
      const slot = h('div', { class: `slot ${id === s.selected ? 'sel' : ''}`, onclick: () => this.slotTap(id) }, c, h('span', { class: 'br' }, `BR ${lv.br.toFixed(1)}`), h('span', { class: 'num' }, `${i + 1}`), h('span', { class: 'sname' }, lv.name));
      this.lineupEl.append(slot);
      requestAnimationFrame(() => slotImage(c, lv));
    });
    if (s.lineup.length < 3) this.lineupEl.append(h('div', { class: 'slot empty', onclick: () => this.addPicker() }, `+ ${t('Add vehicle')}`));
    this.resize();
  }

  private slotTap(id: string) {
    const s = get();
    if (s.selected !== id) {
      s.selected = id;
      save();
      this.refresh();
      return;
    }
    // second tap: options
    let close = () => {};
    const c = h(
      'div',
      {},
      h('h2', {}, getVehicle(id).name),
      h(
        'div',
        { class: 'row' },
        h('button', {
          class: 'btn',
          onclick: () => {
            const r = toggleLineup(id);
            if (r === 'no') toast(t('Lineup'));
            close();
            const ss = get();
            if (!ss.lineup.includes(ss.selected)) ss.selected = ss.lineup[0];
            save();
            this.refresh();
          },
        }, t('Remove from lineup')),
        h('button', { class: 'btn', onclick: () => (close(), this.addPicker()) }, t('Add vehicle')),
        h('button', { class: 'btn', onclick: () => close() }, t('Close')),
      ),
    );
    close = modal(c);
  }

  addPicker() {
    const s = get();
    let close = () => {};
    const list = h('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px' });
    for (const id of s.owned) {
      if (s.lineup.includes(id)) continue;
      const v = getVehicle(id);
      const c = h('canvas');
      list.append(
        h('div', {
          class: 'slot',
          onclick: () => {
            const r = toggleLineup(id);
            if (r === 'full') toast(t('Lineup is full (3)'));
            else {
              s.selected = id;
              save();
            }
            close();
            this.refresh();
          },
        }, c, h('span', { class: 'br' }, `BR ${v.br.toFixed(1)}`), h('span', { class: 'sname' }, v.name)),
      );
      requestAnimationFrame(() => slotImage(c, v));
    }
    if (!list.children.length) list.append(h('div', { style: 'color:var(--dim)' }, t('TECH TREE')));
    close = modal(h('div', {}, h('h2', {}, t('Select a vehicle')), list));
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.resize();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.idleT += dt;
      if (!this.drag && this.idleT > 1.2) this.rot += dt * 0.18;
      this.turret = Math.sin(now / 2600) * 0.35;
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
  }

  draw() {
    const c = this.canvas;
    const ctx = this.ctx;
    const dpr = c.width / Math.max(1, c.getBoundingClientRect().width);
    const W = c.width / dpr;
    const H = c.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // garage floor
    const g = ctx.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H * 0.45, Math.max(W, H) * 0.75);
    g.addColorStop(0, '#3a3c37');
    g.addColorStop(1, '#141615');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // floor tiles
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = (W / 2) % 60; x < W; x += 60) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let y = (H * 0.45) % 60; y < H; y += 60) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
    const cx = W / 2;
    const cy = 44 + (H - 44 - 84) * 0.5;
    const R = Math.min((H - 44 - 84) * 0.5 - 6, W * 0.25);
    // turntable
    const g2 = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
    g2.addColorStop(0, '#45473f');
    g2.addColorStop(1, '#33352f');
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R - 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.rot * 0.25);
    ctx.setLineDash([R * 0.09, R * 0.07]);
    ctx.strokeStyle = 'rgba(214,168,58,0.85)';
    ctx.lineWidth = Math.max(2, R * 0.022);
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    const v = getVehicle(get().selected);
    const L = v.look.L + v.look.gunLen * 0.7;
    const sc = (R * 1.7) / L;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(sc, sc);
    ctx.rotate(this.rot);
    ctx.translate(-v.look.gunLen * 0.3, 0);
    if (this.mode === 'ext') {
      ctx.save();
      ctx.globalAlpha = 0.45;
      // light from the upper right: shadow offset fixed in screen space
      const ox = -0.3;
      const oy = 0.38;
      const c = Math.cos(-this.rot);
      const sn = Math.sin(-this.rot);
      ctx.translate(ox * c - oy * sn, ox * sn + oy * c);
      drawTankShadowVector(ctx, v, this.turret);
      ctx.restore();
      drawTankVector(ctx, v, this.turret, 0);
    } else if (this.mode === 'armor') {
      drawArmorView(ctx, v, this.turret, -this.rot);
    } else {
      ctx.save();
      ctx.globalAlpha = 0.18;
      drawTankVector(ctx, v, this.turret, 0);
      ctx.restore();
      drawXray(ctx, v, { style: 'gold', labels: true, turretRel: this.turret, labelRot: -this.rot });
    }
    ctx.restore();
  }
}

export function slotImage(c: HTMLCanvasElement, v: VehicleSpec, ang = -Math.PI / 2 + 0.95, scaleK = 1) {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(r.width * dpr));
  c.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width;
  const H = r.height;
  const g = ctx.createRadialGradient(W * 0.6, H * 0.45, 4, W * 0.6, H * 0.45, W * 0.6);
  g.addColorStop(0, 'rgba(255,255,255,0.06)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const sc = (Math.min(W * 0.85, H * 1.6) / (v.look.L + v.look.gunLen * 0.6)) * scaleK;
  ctx.save();
  ctx.translate(W * 0.6, H * 0.46);
  ctx.scale(sc, sc);
  ctx.rotate(ang);
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.translate(-0.3, 0.4);
  drawTankShadowVector(ctx, v, 0);
  ctx.restore();
  drawTankSprite(ctx, v, Math.max(8, Math.ceil(sc * dpr)), 0);
  ctx.restore();
}
