// X-ray "hit camera": shows the shell path, spall cone and module damage inside the target.

import type { ImpactResult } from '../game/armor';
import type { Tank } from '../game/tank';
import { drawXray, type ModState } from '../render/tankRender';

type Ctx = CanvasRenderingContext2D;

export interface HitCamEntry {
  res: ImpactResult;
  target: Tank;
  shooter: Tank;
  t: number;
  life: number;
  title: string;
  color: string;
}

export function hitTitle(res: ImpactResult, killed: boolean): { title: string; color: string } {
  if (res.cookoff) return { title: 'COOK-OFF', color: '#e8473b' };
  if (killed) return { title: 'TARGET DESTROYED', color: '#e8473b' };
  switch (res.outcome) {
    case 'pen':
      return res.damage > 0 ? { title: 'PENETRATION', color: '#7ee08a' } : { title: 'PENETRATION · NO DAMAGE', color: '#c9d6b0' };
    case 'ricochet':
      return { title: 'RICOCHET', color: '#f2c94c' };
    case 'barrel':
      return { title: 'GUN BARREL HIT', color: '#f2c94c' };
    default:
      return { title: 'NON-PENETRATION', color: '#b9b9b0' };
  }
}

/** Draw the hit cam panel. (x,y,w,h) in CSS px; ctx already scaled for DPR. */
export function drawHitCam(ctx: Ctx, e: HitCamEntry, x: number, y: number, w: number, h: number) {
  const res = e.res;
  const t = e.t;
  const fadeIn = Math.min(1, t / 0.15);
  const fadeOut = Math.min(1, (e.life - t) / 0.35);
  const a = Math.max(0, Math.min(fadeIn, fadeOut));
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  // panel
  ctx.fillStyle = 'rgba(16,18,16,0.82)';
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // title tag
  ctx.font = '700 13px "Barlow Condensed", sans-serif';
  const tw = ctx.measureText(e.title).width + 14;
  ctx.fillStyle = e.color;
  roundRect(ctx, x + 8, y + 7, tw, 19, 3);
  ctx.fill();
  ctx.fillStyle = '#121212';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(e.title, x + 15, y + 17);
  ctx.fillStyle = 'rgba(235,235,225,0.85)';
  ctx.font = '600 12px "Barlow Condensed", sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(e.target.spec.name, x + w - 9, y + 17);

  // x-ray area
  const spec = e.target.spec;
  const L = spec.look.L + spec.look.gunLen * 0.25;
  const areaW = w * 0.5;
  const areaH = h - 36;
  const sc = Math.min(areaH / (L + 0.6), areaW / (spec.look.W + 1.2));
  const cx = x + 10 + areaW / 2;
  const cy = y + 32 + areaH / 2 + spec.look.gunLen * 0.12 * sc;
  ctx.save();
  roundRect(ctx, x + 2, y + 28, areaW + 14, h - 30, 6);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.scale(sc, sc);
  ctx.rotate(-Math.PI / 2);
  const showAfter = t > 0.55;
  const states: Record<string, ModState> = showAfter ? res.states : res.prevStates;
  const hl = showAfter ? new Set(res.changed) : undefined;
  drawXray(ctx, spec, { style: 'gray', states, turretRel: res.turretRel, gunRel: res.gunRel, labels: true, labelRot: Math.PI / 2, highlight: hl });
  // shell path
  const pCore = Math.min(1, t / 0.3);
  const pFrag = Math.max(0, Math.min(1, (t - 0.25) / 0.3));
  const d = res.dir;
  const en = res.entry;
  // incoming trajectory
  ctx.strokeStyle = 'rgba(255,230,160,0.9)';
  ctx.lineWidth = 0.09;
  ctx.setLineDash([0.25, 0.2]);
  ctx.beginPath();
  ctx.moveTo(en.x - d.x * 3.2 * pCore, en.y - d.y * 3.2 * pCore);
  ctx.lineTo(en.x, en.y);
  ctx.stroke();
  ctx.setLineDash([]);
  if (res.outcome === 'ricochet' && res.reflect) {
    // reflect is world; approximate by mirroring local dir
    ctx.strokeStyle = 'rgba(255,220,90,0.95)';
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    ctx.moveTo(en.x, en.y);
    const rl = rotLocal(res, res.reflect, e.target);
    ctx.lineTo(en.x + rl.x * 2.6 * pFrag, en.y + rl.y * 2.6 * pFrag);
    ctx.stroke();
  }
  for (const s of res.segs) {
    const pr = s.kind === 'core' ? pCore : pFrag;
    if (pr <= 0) continue;
    ctx.strokeStyle = s.kind === 'core' ? 'rgba(255,214,90,1)' : s.kind === 'frag' ? 'rgba(255,150,50,0.85)' : 'rgba(255,96,48,0.75)';
    ctx.lineWidth = s.kind === 'core' ? 0.13 : 0.05;
    ctx.beginPath();
    ctx.moveTo(s.a.x, s.a.y);
    ctx.lineTo(s.a.x + (s.b.x - s.a.x) * pr, s.a.y + (s.b.y - s.a.y) * pr);
    ctx.stroke();
  }
  if (res.blast && pFrag > 0) {
    ctx.fillStyle = `rgba(255,120,40,${0.3 * (1 - Math.max(0, t - 0.6) / 1.5)})`;
    ctx.beginPath();
    ctx.arc(res.blast.c.x, res.blast.c.y, res.blast.r * pFrag, 0, Math.PI * 2);
    ctx.fill();
  }
  // entry mark
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(en.x, en.y, 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // info text
  const tx = x + 10 + areaW + 6;
  let ty = y + 40;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(240,240,232,0.95)';
  ctx.font = '700 12px "Barlow Condensed", sans-serif';
  if (res.partLabel) {
    ctx.fillText(res.partLabel, tx, ty);
    ty += 15;
  }
  ctx.font = '500 11px "Barlow Condensed", sans-serif';
  ctx.fillStyle = 'rgba(220,220,210,0.85)';
  if (res.armor) {
    ctx.fillText(`Armor ${res.armor}mm @ ${res.angle}°`, tx, ty);
    ty += 13;
    ctx.fillText(`Effective ${res.eff}mm`, tx, ty);
    ty += 13;
  }
  ctx.fillText(`Penetration ${res.pen}mm`, tx, ty);
  ty += 16;
  if (showAfter) {
    ctx.font = '600 11px "Barlow Condensed", sans-serif';
    for (const m of res.messages.slice(0, 5)) {
      ctx.fillStyle = m.includes('knocked') || m.includes('destroyed') || m.includes('detonation') ? '#ff8a6a' : m.includes('Fire') ? '#ffb05a' : '#f0d58a';
      ctx.fillText(m, tx, ty);
      ty += 13;
      if (ty > y + h - 12) break;
    }
  }
  ctx.restore();
}

function rotLocal(res: ImpactResult, w: { x: number; y: number }, t: Tank) {
  const c = Math.cos(-t.ang);
  const s = Math.sin(-t.ang);
  void res;
  return { x: w.x * c - w.y * s, y: w.x * s + w.y * c };
}

export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
