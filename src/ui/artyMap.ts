// Artillery target map: a big tactical map instead of the tiny minimap. Tap to place the strike,
// drag on the map — or inside the magnifier, which shows the real ground up close — to fine-tune
// it, see who is inside the impact zone, then FIRE. The battle keeps running underneath; the tank
// holds still while the map is open.

import { type V2, clamp, dist } from '../core/math';
import { Rng } from '../core/rng';
import type { Battle } from '../game/battle';
import type { GameMap } from '../game/map';
import { ARTY, reconPos } from '../game/support';
import { FLARE, flareLight } from '../game/weather';
import { TEAM_COL, type BattleRenderer } from '../render/battleRender';
import { THEME } from '../render/mapRender';
import { makeCanvas } from '../render/tankRender';
import { roundRect } from './hitcam';
import { t as tr } from './i18n';

type Ctx = CanvasRenderingContext2D;
type Rect = { x: number; y: number; w: number; h: number };

export interface ArtyHost {
  b: Battle;
  r: BattleRenderer;
}

export interface ArtyGeom {
  /** map square (CSS px) and its scale (px per meter) */
  mx: number;
  my: number;
  ms: number;
  k: number;
  /** side panel */
  px: number;
  py: number;
  pw: number;
  ph: number;
  /** magnifier: centre, radius (px) and scale (px per meter) */
  lx: number;
  ly: number;
  lr: number;
  lz: number;
  info: { x: number; y: number; w: number };
  fire: Rect;
  cancel: Rect;
  stacked: boolean;
}

const GRID = 8;
const COLS = 'ABCDEFGH';

const inRect = (p: V2, r: Rect) => p.x >= r.x - 4 && p.x <= r.x + r.w + 4 && p.y >= r.y - 4 && p.y <= r.y + r.h + 4;

export class ArtyMap {
  open = false;
  target: V2 | null = null;
  g: ArtyGeom | null = null;
  private host: ArtyHost;
  private drag: { id: number; mode: 'map' | 'loupe'; last: V2 } | null = null;
  private bg: HTMLCanvasElement | null = null;
  private bgKey = '';
  private openedAt = 0;

  constructor(host: ArtyHost) {
    this.host = host;
  }

  /** Can the local player call a strike right now? */
  available(): boolean {
    const b = this.host.b;
    const p = b.player;
    return !!p && p.alive && b.state === 'playing' && b.supportOf(p).arty > 0;
  }

  show() {
    if (!this.available()) return;
    this.open = true;
    this.drag = null;
    this.openedAt = performance.now();
  }

  close() {
    this.open = false;
    this.drag = null;
  }

  // ------------------------------------------------------------------ layout & input
  layout(W: number, H: number, s: { l: number; r: number; t: number; b: number }): ArtyGeom {
    const m = 10;
    const ms = Math.max(140, Math.min(H - s.t - s.b - m * 2, W * 0.56));
    const mx = s.l + m;
    const my = s.t + (H - s.t - s.b - ms) / 2;
    const px = mx + ms + 14;
    const pw = W - s.r - m - px;
    const py = s.t + m;
    const ph = H - s.t - s.b - m * 2;
    const stacked = pw < 380;
    const bh = clamp(H * 0.12, 38, 48);
    const lr = stacked ? Math.max(40, Math.min(66, pw * 0.3, (ph - bh - 130) / 2)) : Math.max(50, Math.min(86, (ph - bh - 70) / 2));
    const lx = stacked ? px + pw / 2 : px + lr + 6;
    const ly = py + 40 + lr;
    const lz = clamp(lr / 21, 2.3, 4.2);
    const info = stacked ? { x: px + 4, y: ly + lr + 20, w: pw - 8 } : { x: lx + lr + 20, y: py + 54, w: px + pw - (lx + lr + 20) };
    const fire = { x: px + pw - 150, y: py + ph - bh, w: 150, h: bh };
    const cancel = { x: fire.x - 112, y: fire.y + (bh - 34) / 2, w: 100, h: 34 };
    if (stacked) {
      fire.w = (pw - 8) * 0.58;
      fire.x = px + pw - fire.w;
      cancel.x = px;
      cancel.w = pw - fire.w - 8;
      cancel.y = fire.y;
      cancel.h = bh;
    }
    return { mx, my, ms, k: ms / this.host.b.map.size, px, py, pw, ph, lx, ly, lr, lz, info, fire, cancel, stacked };
  }

  private toWorld(p: V2): V2 {
    const g = this.g!;
    const S = this.host.b.map.size;
    return { x: clamp((p.x - g.mx) / g.k, 5, S - 5), y: clamp((p.y - g.my) / g.k, 5, S - 5) };
  }

  /** A touch went down while the map is open: what it hit. */
  down(id: number, p: V2): 'fire' | 'cancel' | 'used' {
    const g = this.g;
    if (!g) return 'used';
    if (inRect(p, g.fire)) return 'fire';
    if (inRect(p, g.cancel)) return 'cancel';
    if (p.x >= g.mx && p.x <= g.mx + g.ms && p.y >= g.my && p.y <= g.my + g.ms) {
      this.target = this.toWorld(p);
      this.drag = { id, mode: 'map', last: p };
    } else if (this.target && Math.hypot(p.x - g.lx, p.y - g.ly) <= g.lr + 6) {
      this.drag = { id, mode: 'loupe', last: p };
    }
    return 'used';
  }

  move(id: number, p: V2): boolean {
    const d = this.drag;
    if (!d || d.id !== id || !this.g) return false;
    if (d.mode === 'map') this.target = this.toWorld(p);
    else if (this.target) {
      // slide the ground under the fixed cross-hair (like a map app): fine adjustment
      const S = this.host.b.map.size;
      this.target = { x: clamp(this.target.x - (p.x - d.last.x) / this.g.lz, 5, S - 5), y: clamp(this.target.y - (p.y - d.last.y) / this.g.lz, 5, S - 5) };
    }
    d.last = p;
    return true;
  }

  up(id: number): boolean {
    if (!this.drag || this.drag.id !== id) return false;
    this.drag = null;
    return true;
  }

  // ------------------------------------------------------------------ what's in the zone
  zone(): { enemies: number; friends: number; me: boolean; d: number } | null {
    const b = this.host.b;
    const tg = this.target;
    const p = b.player;
    if (!tg || !p) return null;
    const R = ARTY.SPREAD + 3;
    let enemies = 0;
    let friends = 0;
    let me = false;
    for (const t of b.tanks) {
      if (!t.alive || dist(t.pos, tg) > R + t.bp.radius) continue;
      if (t.team === b.playerTeam) {
        if (t === p) me = true;
        else friends++;
      } else if (b.isSpotted(b.playerTeam, t)) enemies++;
    }
    return { enemies, friends, me, d: dist(p.pos, tg) };
  }

  // ------------------------------------------------------------------ drawing
  draw(ctx: Ctx, W: number, H: number, s: { l: number; r: number; t: number; b: number }) {
    const g = (this.g = this.layout(W, H, s));
    const b = this.host.b;
    const appear = Math.min(1, (performance.now() - this.openedAt) / 160);
    ctx.save();
    ctx.globalAlpha = appear;
    ctx.fillStyle = 'rgba(5,7,7,0.66)';
    ctx.fillRect(0, 0, W, H);
    // map
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, g.mx - 4, g.my - 4, g.ms + 8, g.ms + 8, 6);
    ctx.fill();
    ctx.drawImage(this.background(g.ms), g.mx, g.my, g.ms, g.ms);
    ctx.save();
    ctx.beginPath();
    ctx.rect(g.mx, g.my, g.ms, g.ms);
    ctx.clip();
    ctx.translate(g.mx, g.my);
    this.drawLive(ctx, g.k);
    this.drawTarget(ctx, g.k);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,200,110,0.85)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(g.mx - 0.5, g.my - 0.5, g.ms + 1, g.ms + 1);
    if (!this.target) {
      const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 260);
      ctx.font = '700 15px "Barlow Condensed", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      const msg = tr('Tap the map to aim');
      ctx.strokeText(msg, g.mx + g.ms / 2, g.my + g.ms - 22);
      ctx.fillStyle = `rgba(255,214,130,${pulse})`;
      ctx.fillText(msg, g.mx + g.ms / 2, g.my + g.ms - 22);
    }
    this.drawPanel(ctx, g, b);
    ctx.restore();
  }

  /** Units and live events on the map (ctx at the map's top-left, `k` px per meter). */
  private drawLive(ctx: Ctx, k: number) {
    const b = this.host.b;
    const pt = b.playerTeam;
    // smoke screens and flares
    ctx.fillStyle = 'rgba(235,235,230,0.45)';
    for (const sm of b.map.smokes) {
      ctx.beginPath();
      ctx.arc(sm.x * k, sm.y * k, Math.max(2, sm.r * k), 0, Math.PI * 2);
      ctx.fill();
    }
    for (const f of b.flares) {
      if (f.t < FLARE.FLIGHT) continue;
      const l = flareLight(f);
      if (l.k < 0.05) continue;
      ctx.fillStyle = `rgba(255,230,160,${0.2 * l.k})`;
      ctx.beginPath();
      ctx.arc(l.x * k, l.y * k, l.r * k, 0, Math.PI * 2);
      ctx.fill();
    }
    // capture point
    const c = b.map.capture;
    const col = b.capture.owner === -1 ? TEAM_COL.neutral : b.capture.owner === pt ? TEAM_COL.friend : TEAM_COL.enemy;
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c.x * k, c.y * k, c.r * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.font = '700 13px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('A', c.x * k, c.y * k + 0.5);
    // strikes already on the way
    for (const a of b.artys) {
      const first = a.times[0] - a.t;
      ctx.strokeStyle = 'rgba(255,100,70,0.95)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(a.x * k, a.y * k, (ARTY.SPREAD + 1.5) * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (first > 0) {
        ctx.fillStyle = 'rgba(255,170,150,0.95)';
        ctx.font = '700 10px "Barlow Condensed", sans-serif';
        ctx.fillText(`${first.toFixed(1)}s`, a.x * k, a.y * k - (ARTY.SPREAD + 4) * k);
      }
    }
    // where enemies were last seen (fading)
    for (const t of b.tanks) {
      if (!t.alive || t.team === pt || b.isSpotted(pt, t) || !t.lastSeenPos) continue;
      const age = b.time - t.lastSeenAt;
      if (age > 25) continue;
      const a = 0.75 * (1 - age / 25);
      const x = t.lastSeenPos.x * k;
      const y = t.lastSeenPos.y * k;
      ctx.strokeStyle = `rgba(255,110,95,${a})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(x - 3.5, y - 3.5);
      ctx.lineTo(x + 3.5, y + 3.5);
      ctx.moveTo(x + 3.5, y - 3.5);
      ctx.lineTo(x - 3.5, y + 3.5);
      ctx.stroke();
    }
    // crew carriers
    for (const cv of b.carriers) {
      if (cv.state === 'dead') continue;
      const friend = cv.team === pt;
      if (!friend && !b.spottedCarriers[pt].has(cv.id)) continue;
      ctx.fillStyle = friend ? '#bfe0ff' : '#ffb0a6';
      ctx.fillRect(cv.pos.x * k - 2.5, cv.pos.y * k - 2.5, 5, 5);
    }
    // tanks
    const p = b.player;
    if (p && p.alive) {
      const vc = p.visionCone();
      const tp = p.turretPos();
      ctx.fillStyle = 'rgba(255,255,230,0.1)';
      ctx.beginPath();
      ctx.moveTo(tp.x * k, tp.y * k);
      ctx.arc(tp.x * k, tp.y * k, vc.range * k, p.gunWorldAng - vc.half, p.gunWorldAng + vc.half);
      ctx.closePath();
      ctx.fill();
    }
    for (const t of b.tanks) {
      if (!t.alive) continue;
      const friend = t.team === pt;
      if (!friend && !b.isSpotted(pt, t)) continue;
      ctx.save();
      ctx.translate(t.pos.x * k, t.pos.y * k);
      ctx.rotate(t.ang);
      ctx.fillStyle = t === p ? '#ffffff' : friend ? (t.slot ? '#9cc4ff' : TEAM_COL.friend) : TEAM_COL.enemy;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(-4, -4.2);
      ctx.lineTo(-2.4, 0);
      ctx.lineTo(-4, 4.2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      if (t === p) {
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(t.pos.x * k, t.pos.y * k, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // recon planes
    for (const rc of b.recons) {
      const pp = reconPos(rc);
      ctx.save();
      ctx.translate(pp.x * k, pp.y * k);
      ctx.rotate(pp.ang);
      ctx.fillStyle = rc.team === pt ? '#cfe6ff' : '#ffc2b8';
      ctx.fillRect(-4, -1, 8, 2);
      ctx.fillRect(-0.5, -6, 2.4, 12);
      ctx.fillRect(-4.2, -2.6, 1.4, 5.2);
      ctx.restore();
    }
  }

  private drawTarget(ctx: Ctx, k: number) {
    const tg = this.target;
    const b = this.host.b;
    if (!tg) return;
    const z = this.zone();
    const danger = !!z && (z.me || z.friends > 0);
    const x = tg.x * k;
    const y = tg.y * k;
    const R = ARTY.SPREAD * k;
    const p = b.player;
    if (p && p.alive) {
      ctx.strokeStyle = 'rgba(255,240,210,0.45)';
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.pos.x * k, p.pos.y * k);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
    ctx.fillStyle = danger ? `rgba(255,160,40,${0.18 + 0.08 * pulse})` : `rgba(255,80,50,${0.16 + 0.08 * pulse})`;
    ctx.strokeStyle = danger ? 'rgba(255,190,80,1)' : 'rgba(255,110,80,1)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x - R - 6, y);
    ctx.lineTo(x - 3, y);
    ctx.moveTo(x + 3, y);
    ctx.lineTo(x + R + 6, y);
    ctx.moveTo(x, y - R - 6);
    ctx.lineTo(x, y - 3);
    ctx.moveTo(x, y + 3);
    ctx.lineTo(x, y + R + 6);
    ctx.stroke();
  }

  private drawPanel(ctx: Ctx, g: ArtyGeom, b: Battle) {
    const z = this.zone();
    ctx.textBaseline = 'middle';
    ctx.textAlign = g.stacked ? 'center' : 'left';
    const tx = g.stacked ? g.px + g.pw / 2 : g.px + 4;
    ctx.font = '700 19px "Barlow Condensed", sans-serif';
    ctx.fillStyle = '#ffc56b';
    ctx.fillText(tr('ARTILLERY STRIKE'), tx, g.py + 10);
    ctx.font = '500 12px "Barlow Condensed", sans-serif';
    ctx.fillStyle = 'rgba(225,220,205,0.8)';
    ctx.fillText(`${ARTY.SHELLS} × 150 mm HE · ${tr('lands within')} ${ARTY.SPREAD} m · ~${Math.round(ARTY.DELAY)} s`, tx, g.py + 27);
    this.drawLoupe(ctx, g, b);
    // info lines
    const lines: Array<[string, string]> = [];
    if (!z) {
      lines.push([tr('Tap the map to aim'), '#ffd27a']);
      lines.push([tr('Drag the magnifier to fine-tune'), 'rgba(220,220,210,0.75)']);
    } else {
      const cell = this.cellName(this.target!);
      lines.push([`${tr('Target')} ${cell} · ${Math.round(z.d)} m ${tr('away')}`, '#e8e4d8']);
      lines.push(z.enemies > 0 ? [`${z.enemies} ${tr(z.enemies > 1 ? 'enemies in the zone' : 'enemy in the zone')}`, '#8ee08e'] : [tr('No spotted enemies in the zone'), 'rgba(220,220,210,0.7)']);
      if (z.me) lines.push([`⚠ ${tr('You are inside the zone!')}`, '#ff7a5c']);
      else if (z.friends > 0) lines.push([`⚠ ${tr('Friendly tanks in the zone')}`, '#ffb44a']);
      if (!g.stacked) lines.push([tr('Drag the magnifier to fine-tune'), 'rgba(220,220,210,0.6)']);
    }
    ctx.font = '600 13px "Barlow Condensed", sans-serif';
    ctx.textAlign = g.stacked ? 'center' : 'left';
    let y = g.info.y;
    for (const [txt, color] of lines) {
      ctx.fillStyle = color;
      ctx.fillText(txt, g.stacked ? g.info.x + g.info.w / 2 : g.info.x, y, g.info.w);
      y += 18;
    }
    // buttons
    const ready = !!this.target;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(40,40,36,0.92)';
    roundRect(ctx, g.cancel.x, g.cancel.y, g.cancel.w, g.cancel.h, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#e8e6dc';
    ctx.font = '700 14px "Barlow Condensed", sans-serif';
    ctx.fillText(tr('Cancel'), g.cancel.x + g.cancel.w / 2, g.cancel.y + g.cancel.h / 2 + 1);
    const grd = ctx.createLinearGradient(0, g.fire.y, 0, g.fire.y + g.fire.h);
    grd.addColorStop(0, ready ? '#e0712f' : '#4a3a2c');
    grd.addColorStop(1, ready ? '#a5401c' : '#3a2e24');
    ctx.fillStyle = grd;
    roundRect(ctx, g.fire.x, g.fire.y, g.fire.w, g.fire.h, 7);
    ctx.fill();
    ctx.strokeStyle = ready ? 'rgba(255,210,150,0.95)' : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = ready ? '#fff4e2' : 'rgba(255,255,255,0.35)';
    ctx.font = '700 19px "Barlow Condensed", sans-serif';
    ctx.fillText(`${tr('FIRE')} ✸`, g.fire.x + g.fire.w / 2, g.fire.y + g.fire.h / 2 + 1);
  }

  /** Map grid reference of a point, e.g. "D5". */
  cellName(p: V2): string {
    const S = this.host.b.map.size;
    const c = clamp(Math.floor((p.x / S) * GRID), 0, GRID - 1);
    const r = clamp(Math.floor((p.y / S) * GRID), 0, GRID - 1);
    return `${COLS[c]}${r + 1}`;
  }

  /** The magnifier: the actual battlefield around the target, the zone and a cross-hair. */
  private drawLoupe(ctx: Ctx, g: ArtyGeom, b: Battle) {
    const { lx, ly, lr, lz } = g;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(lx + 2, ly + 3, lr + 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    ctx.fillStyle = '#20231f';
    ctx.fill();
    const tg = this.target;
    if (tg) {
      ctx.save();
      ctx.clip();
      const r = this.host.r;
      const dpr = r.dpr;
      const half = lr / lz;
      const x0 = tg.x - half;
      const y0 = tg.y - half;
      const x1 = tg.x + half;
      const y1 = tg.y + half;
      ctx.setTransform(dpr * lz, 0, 0, dpr * lz, dpr * (lx - tg.x * lz), dpr * (ly - tg.y * lz));
      r.mapR.drawGround(ctx, x0, y0, x1, y1, { n: 4 });
      r.mapR.drawWalls(ctx, x0, y0, x1, y1);
      r.mapR.drawTreeShadows(ctx, x0, y0, x1, y1);
      for (const t of b.tanks) {
        if (t.pos.x < x0 - 8 || t.pos.x > x1 + 8 || t.pos.y < y0 - 8 || t.pos.y > y1 + 8) continue;
        if (t.alive && t.team !== b.playerTeam && !b.isSpotted(b.playerTeam, t)) continue;
        r.drawTankAt(ctx, t);
      }
      r.mapR.drawBuildings(ctx, x0, y0, x1, y1);
      r.mapR.drawTrees(ctx, x0, y0, x1, y1, null);
      b.fx.drawSmokeClouds(ctx, b.map.smokes, x0, y0, x1, y1);
      // impact zone and cross-hair
      const z = this.zone();
      const danger = !!z && (z.me || z.friends > 0);
      ctx.setLineDash([1.6, 1.0]);
      ctx.lineWidth = 0.35;
      ctx.strokeStyle = danger ? 'rgba(255,190,80,0.95)' : 'rgba(255,110,80,0.95)';
      ctx.fillStyle = danger ? 'rgba(255,170,60,0.12)' : 'rgba(255,80,50,0.1)';
      ctx.beginPath();
      ctx.arc(tg.x, tg.y, ARTY.SPREAD, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      // cross-hair (screen space)
      ctx.strokeStyle = 'rgba(255,245,225,0.95)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(lx - lr, ly);
      ctx.lineTo(lx - 5, ly);
      ctx.moveTo(lx + 5, ly);
      ctx.lineTo(lx + lr, ly);
      ctx.moveTo(lx, ly - lr);
      ctx.lineTo(lx, ly - 5);
      ctx.moveTo(lx, ly + 5);
      ctx.lineTo(lx, ly + lr);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(lx, ly, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,90,60,1)';
      ctx.fill();
    } else {
      ctx.font = '600 12px "Barlow Condensed", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(220,220,210,0.55)';
      ctx.fillText('×' + (lz / g.k).toFixed(0), lx, ly);
    }
    ctx.beginPath();
    ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,200,110,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // ------------------------------------------------------------------ the map picture
  private background(ms: number): HTMLCanvasElement {
    const map = this.host.b.map;
    const px = Math.round(ms * Math.min(2, window.devicePixelRatio || 1));
    const key = `${map.version}:${px}`;
    if (!this.bg || this.bgKey !== key) {
      this.bg = renderTacticalMap(map, px);
      this.bgKey = key;
    }
    return this.bg;
  }
}

/** A clean military-map style picture of the whole battlefield, with a lettered grid. */
export function renderTacticalMap(map: GameMap, px: number): HTMLCanvasElement {
  const c = makeCanvas(px, px);
  const g = c.getContext('2d')!;
  const S = map.size;
  const k = px / S;
  g.setTransform(k, 0, 0, k, 0, 0);
  const th = map.theme;
  g.fillStyle = THEME[th].base;
  g.fillRect(0, 0, S, S);
  // ground tints
  for (const pa of map.patches) {
    g.globalAlpha = Math.min(0.4, pa.alpha * 0.7);
    g.fillStyle = pa.color;
    g.beginPath();
    g.arc(pa.x, pa.y, pa.r, 0, Math.PI * 2);
    g.fill();
  }
  const rng = new Rng(map.seed + 991);
  g.globalAlpha = 0.045;
  for (let i = 0; i < 220; i++) {
    g.fillStyle = rng.chance(0.5) ? '#000' : '#fff';
    g.beginPath();
    g.arc(rng.next() * S, rng.next() * S, 2 + rng.next() * 9, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  // fields with their furrows
  for (const f of map.fields) {
    g.save();
    g.beginPath();
    g.moveTo(f.poly[0].x, f.poly[0].y);
    for (const q of f.poly) g.lineTo(q.x, q.y);
    g.closePath();
    g.globalAlpha = 0.7;
    g.fillStyle = f.color;
    g.fill();
    g.clip();
    g.globalAlpha = 0.3;
    g.strokeStyle = f.row;
    g.lineWidth = 0.7;
    const cx = f.poly.reduce((a, q) => a + q.x, 0) / f.poly.length;
    const cy = f.poly.reduce((a, q) => a + q.y, 0) / f.poly.length;
    const ux = Math.cos(f.ang);
    const uy = Math.sin(f.ang);
    g.beginPath();
    for (let o = -80; o <= 80; o += 3) {
      g.moveTo(cx - ux * 90 - uy * o, cy - uy * 90 + ux * o);
      g.lineTo(cx + ux * 90 - uy * o, cy + uy * 90 + ux * o);
    }
    g.stroke();
    g.restore();
  }
  // craters, puddles
  for (const d of map.decor) {
    if (d.kind !== 'crater' && d.kind !== 'puddle') continue;
    g.fillStyle = d.kind === 'crater' ? 'rgba(30,26,18,0.35)' : 'rgba(80,100,110,0.45)';
    g.beginPath();
    g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    g.fill();
  }
  // roads: dark verge, then the surface
  const roadCol = { asphalt: '#3c3d3e', dirt: th === 'desert' ? '#c8b48c' : '#8f7d58', sand: '#cbb68c' } as const;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const pass of [0, 1]) {
    for (const r of map.roads) {
      g.strokeStyle = pass === 0 ? 'rgba(20,18,12,0.45)' : roadCol[r.kind];
      g.lineWidth = r.w + (pass === 0 ? 1.4 : 0);
      g.beginPath();
      g.moveTo(r.pts[0].x, r.pts[0].y);
      for (const q of r.pts) g.lineTo(q.x, q.y);
      g.stroke();
    }
  }
  // earthworks
  for (const pass of [0, 1]) {
    for (const bm of map.berms) {
      g.strokeStyle = pass === 0 ? 'rgba(55,40,20,0.55)' : th === 'desert' ? '#d2bb8e' : '#a8915f';
      g.lineWidth = bm.w + (pass === 0 ? 1.2 : 0);
      g.beginPath();
      g.moveTo(bm.pts[0].x, bm.pts[0].y);
      for (const q of bm.pts) g.lineTo(q.x, q.y);
      g.stroke();
    }
  }
  // rocks and walls
  for (const rk of map.rocks) {
    g.beginPath();
    g.moveTo(rk.poly[0].x, rk.poly[0].y);
    for (const q of rk.poly) g.lineTo(q.x, q.y);
    g.closePath();
    g.fillStyle = rk.color;
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.4)';
    g.lineWidth = 0.4;
    g.stroke();
  }
  for (const w of map.walls) {
    if (!w.alive) continue;
    g.strokeStyle = w.kind === 'fence' ? 'rgba(60,50,35,0.7)' : w.kind === 'sandbag' ? '#8d7c58' : '#77736a';
    g.lineWidth = w.kind === 'fence' ? 0.5 : Math.max(0.8, w.w);
    g.beginPath();
    g.moveTo(w.a.x, w.a.y);
    g.lineTo(w.b.x, w.b.y);
    g.stroke();
  }
  // buildings with a cast shadow
  for (const bd of map.buildings) {
    const sh = map.shadow;
    const hgt = bd.roof === 'ruin' ? 0.8 : Math.min(6, bd.height * 0.55);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.beginPath();
    g.moveTo(bd.poly[0].x + sh.x * hgt, bd.poly[0].y + sh.y * hgt);
    for (const q of bd.poly) g.lineTo(q.x + sh.x * hgt, q.y + sh.y * hgt);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(bd.poly[0].x, bd.poly[0].y);
    for (const q of bd.poly) g.lineTo(q.x, q.y);
    g.closePath();
    g.fillStyle = bd.roof === 'ruin' ? '#5e584f' : bd.color;
    g.fill();
    g.strokeStyle = 'rgba(20,18,15,0.75)';
    g.lineWidth = 0.5;
    g.stroke();
    if (bd.roof === 'ruin') {
      g.save();
      g.clip();
      g.strokeStyle = 'rgba(30,26,22,0.6)';
      g.lineWidth = 0.4;
      g.beginPath();
      for (let o = -30; o < 30; o += 1.6) {
        g.moveTo(bd.cx + o - 20, bd.cy - 20);
        g.lineTo(bd.cx + o + 20, bd.cy + 20);
      }
      g.stroke();
      g.restore();
    } else if (bd.roof === 'gable') {
      // ridge line
      const ux = Math.cos(bd.ang);
      const uy = Math.sin(bd.ang);
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.lineWidth = 0.35;
      g.beginPath();
      g.moveTo(bd.cx - ux * bd.w * 0.45, bd.cy - uy * bd.w * 0.45);
      g.lineTo(bd.cx + ux * bd.w * 0.45, bd.cy + uy * bd.w * 0.45);
      g.stroke();
    }
  }
  // trees: shadow, canopy, light side
  const leaf = th === 'desert' ? '#5a6338' : th === 'city' ? '#3b4a2d' : '#2c3a20';
  const leafHi = th === 'desert' ? '#78824c' : th === 'city' ? '#56683e' : '#46582f';
  g.fillStyle = 'rgba(0,0,0,0.25)';
  for (const t of map.trees) {
    if (!t.alive) continue;
    g.beginPath();
    g.arc(t.x - t.r * 0.35, t.y + t.r * 0.45, t.r * 0.95, 0, Math.PI * 2);
    g.fill();
  }
  for (const t of map.trees) {
    if (!t.alive) continue;
    g.fillStyle = leaf;
    g.beginPath();
    g.arc(t.x, t.y, t.r * (t.shrub ? 0.85 : 1), 0, Math.PI * 2);
    g.fill();
    g.fillStyle = leafHi;
    g.beginPath();
    g.arc(t.x + t.r * 0.2, t.y - t.r * 0.25, t.r * 0.5, 0, Math.PI * 2);
    g.fill();
  }
  // grid with letters and numbers
  g.setTransform(1, 0, 0, 1, 0, 0);
  const cell = px / GRID;
  g.strokeStyle = 'rgba(255,255,240,0.16)';
  g.lineWidth = Math.max(1, px / 700);
  g.beginPath();
  for (let i = 1; i < GRID; i++) {
    g.moveTo(Math.round(i * cell) + 0.5, 0);
    g.lineTo(Math.round(i * cell) + 0.5, px);
    g.moveTo(0, Math.round(i * cell) + 0.5);
    g.lineTo(px, Math.round(i * cell) + 0.5);
  }
  g.stroke();
  g.font = `700 ${Math.round(px * 0.028)}px "Barlow Condensed", sans-serif`;
  g.textBaseline = 'top';
  g.textAlign = 'left';
  g.fillStyle = 'rgba(255,250,235,0.5)';
  for (let i = 0; i < GRID; i++) {
    g.fillText(COLS[i], i * cell + px * 0.008, px * 0.006);
    if (i) g.fillText(String(i + 1), px * 0.008, i * cell + px * 0.006);
  }
  return c;
}
