// Procedural top-down vehicle art. Everything is drawn in meters in the vehicle's local frame
// (+x forward, +y right). Sprites are cached as canvases per vehicle and scale.

import type { V2 } from '../core/math';
import { Rng, hashStr } from '../core/rng';
import type { VehicleSpec, Palette } from '../data/vehicles';
import { getBlueprint, type Blueprint, type ModuleDef } from '../game/blueprint';

type Ctx = CanvasRenderingContext2D;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function poly(ctx: Ctx, pts: V2[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function circle(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function shade(hex: string, amt: number): string {
  // amt -1..1 darken/lighten
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (amt >= 0) {
    r += (255 - r) * amt;
    g += (255 - g) * amt;
    b += (255 - b) * amt;
  } else {
    r *= 1 + amt;
    g *= 1 + amt;
    b *= 1 + amt;
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// ---------------------------------------------------------------------------
// Hull

function deckPolygon(spec: VehicleSpec): V2[] {
  const lk = spec.look;
  const hl = lk.L / 2;
  const dh = lk.W / 2 - lk.trackW + lk.fender;
  const c = Math.min(lk.chamfer, dh * 0.5);
  const rc = Math.min(lk.rearChamfer, dh * 0.4);
  switch (lk.nose) {
    case 'pike':
      return [
        { x: hl, y: -dh * 0.3 },
        { x: hl, y: dh * 0.3 },
        { x: hl - lk.chamfer * 1.6, y: dh },
        { x: -hl + rc, y: dh },
        { x: -hl, y: dh * 0.55 },
        { x: -hl, y: -dh * 0.55 },
        { x: -hl + rc, y: -dh },
        { x: hl - lk.chamfer * 1.6, y: -dh },
      ];
    case 'round': {
      const pts: V2[] = [];
      const r = Math.min(lk.noseLen * 0.55, 0.7);
      pts.push({ x: hl - r, y: -dh });
      for (let i = 0; i <= 8; i++) {
        const t = -Math.PI / 2 + (i / 8) * Math.PI;
        pts.push({ x: hl - r + Math.cos(t) * r, y: Math.sin(t) * dh * (1 - 0.15 * Math.cos(t)) });
      }
      pts.push({ x: -hl + rc, y: dh }, { x: -hl, y: dh - rc }, { x: -hl, y: -dh + rc }, { x: -hl + rc, y: -dh });
      return pts;
    }
    case 'step':
      return [
        { x: hl, y: -dh * 0.78 },
        { x: hl, y: dh * 0.78 },
        { x: hl - lk.noseLen, y: dh * 0.82 },
        { x: hl - lk.noseLen, y: dh },
        { x: -hl + rc, y: dh },
        { x: -hl, y: dh - rc },
        { x: -hl, y: -dh + rc },
        { x: -hl + rc, y: -dh },
        { x: hl - lk.noseLen, y: -dh },
        { x: hl - lk.noseLen, y: -dh * 0.82 },
      ];
    default:
      return [
        { x: hl, y: -dh + c },
        { x: hl, y: dh - c },
        { x: hl - c, y: dh },
        { x: -hl + rc, y: dh },
        { x: -hl, y: dh - rc },
        { x: -hl, y: -dh + rc },
        { x: -hl + rc, y: -dh },
        { x: hl - c, y: -dh },
      ];
  }
}

function drawTracks(ctx: Ctx, spec: VehicleSpec) {
  const lk = spec.look;
  const hl = lk.L / 2;
  const hw = lk.W / 2;
  const tw = lk.trackW;
  if (lk.wheels) {
    const n = lk.wheels;
    const span = lk.L * 0.78;
    const wl = Math.min(0.95, (span / n) * 0.8);
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const x = -span / 2 + (span / (n - 1)) * i;
        const y0 = sgn < 0 ? -hw : hw - tw;
        ctx.fillStyle = '#20201c';
        rrect(ctx, x - wl / 2, y0, wl, tw, 0.12);
        ctx.fill();
        ctx.fillStyle = '#34342e';
        for (let k = 0; k < 5; k++) {
          const xx = x - wl / 2 + 0.08 + (k * (wl - 0.16)) / 4;
          ctx.fillRect(xx - 0.025, y0 + 0.03, 0.05, tw - 0.06);
        }
        ctx.fillStyle = '#4a4a40';
        circle(ctx, x, sgn < 0 ? -hw + tw * 0.75 : hw - tw * 0.75, 0.09);
        ctx.fill();
      }
    }
    return;
  }
  for (const sgn of [-1, 1]) {
    const y0 = sgn < 0 ? -hw : hw - tw;
    ctx.fillStyle = '#23231f';
    rrect(ctx, -hl + 0.02, y0, lk.L - 0.04, tw, tw * 0.45);
    ctx.fill();
    // tread links
    const pitch = 0.17;
    ctx.save();
    rrect(ctx, -hl + 0.02, y0, lk.L - 0.04, tw, tw * 0.45);
    ctx.clip();
    for (let x = -hl; x < hl; x += pitch) {
      ctx.fillStyle = '#3b3a33';
      ctx.fillRect(x, y0 + 0.03, pitch * 0.55, tw - 0.06);
      ctx.fillStyle = '#4c4a41';
      ctx.fillRect(x + pitch * 0.12, y0 + tw * 0.18, pitch * 0.18, tw * 0.64);
    }
    // centre guide horns
    ctx.fillStyle = 'rgba(20,20,16,0.55)';
    ctx.fillRect(-hl, y0 + tw * 0.45, lk.L, tw * 0.1);
    ctx.restore();
    // outer edge highlight
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 0.035;
    rrect(ctx, -hl + 0.02, y0, lk.L - 0.04, tw, tw * 0.45);
    ctx.stroke();
  }
}

function grille(ctx: Ctx, x0: number, y0: number, w: number, h: number, dir: 'x' | 'y', pitch: number, pal: Palette) {
  ctx.fillStyle = shade(pal.dark, -0.35);
  ctx.fillRect(x0, y0, w, h);
  ctx.strokeStyle = shade(pal.base, 0.05);
  ctx.lineWidth = pitch * 0.42;
  ctx.beginPath();
  if (dir === 'x') {
    for (let x = x0 + pitch / 2; x < x0 + w; x += pitch) {
      ctx.moveTo(x, y0 + 0.02);
      ctx.lineTo(x, y0 + h - 0.02);
    }
  } else {
    for (let y = y0 + pitch / 2; y < y0 + h; y += pitch) {
      ctx.moveTo(x0 + 0.02, y);
      ctx.lineTo(x0 + w - 0.02, y);
    }
  }
  ctx.stroke();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 0.03;
  ctx.strokeRect(x0, y0, w, h);
}

function mesh(ctx: Ctx, x0: number, y0: number, w: number, h: number, pal: Palette) {
  ctx.fillStyle = shade(pal.dark, -0.45);
  ctx.fillRect(x0, y0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  ctx.strokeStyle = shade(pal.base, -0.1);
  ctx.lineWidth = 0.018;
  ctx.beginPath();
  for (let k = -h; k < w + h; k += 0.09) {
    ctx.moveTo(x0 + k, y0);
    ctx.lineTo(x0 + k + h, y0 + h);
    ctx.moveTo(x0 + k + h, y0);
    ctx.lineTo(x0 + k, y0 + h);
  }
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = shade(pal.light, -0.1);
  ctx.lineWidth = 0.045;
  ctx.strokeRect(x0, y0, w, h);
}

function hatch(ctx: Ctx, x: number, y: number, r: number, pal: Palette, square = false) {
  ctx.fillStyle = shade(pal.base, 0.06);
  if (square) rrect(ctx, x - r, y - r * 0.8, r * 2, r * 1.6, r * 0.25);
  else circle(ctx, x, y, r);
  ctx.fill();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 0.035;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 0.025;
  if (square) rrect(ctx, x - r + 0.05, y - r * 0.8 + 0.05, r * 2 - 0.1, r * 1.6 - 0.1, r * 0.2);
  else circle(ctx, x, y, r * 0.78);
  ctx.stroke();
  // hinge
  ctx.fillStyle = pal.dark;
  ctx.fillRect(x - r * 0.95, y - 0.03, r * 0.35, 0.06);
}

function bolts(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, n: number, color: string, r = 0.025) {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    circle(ctx, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r);
    ctx.fill();
  }
}

function camo(ctx: Ctx, rng: Rng, bx: number, by: number, w: number, h: number) {
  const cols = ['rgba(84,96,56,0.85)', 'rgba(104,74,52,0.82)'];
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = cols[i % 2];
    const x = bx + rng.range(-0.2, 1) * w;
    const y = by + rng.range(-0.1, 1.1) * h;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const ang = -0.9 + rng.range(-0.3, 0.3);
    const l = rng.range(1.2, 2.6);
    const wdt = rng.range(0.18, 0.35);
    const ex = x + Math.cos(ang) * l;
    const ey = y + Math.sin(ang) * l;
    ctx.quadraticCurveTo((x + ex) / 2 + 0.3, (y + ey) / 2 + 0.25, ex, ey);
    ctx.lineTo(ex + wdt, ey + wdt * 0.6);
    ctx.quadraticCurveTo((x + ex) / 2 + 0.3 + wdt, (y + ey) / 2 + 0.25 + wdt, x + wdt, y + wdt * 0.8);
    ctx.closePath();
    ctx.fill();
  }
}

function weather(ctx: Ctx, rng: Rng, x0: number, y0: number, w: number, h: number, n: number) {
  for (let i = 0; i < n; i++) {
    const x = x0 + rng.next() * w;
    const y = y0 + rng.next() * h;
    const r = rng.range(0.03, 0.16);
    ctx.fillStyle = rng.chance(0.7) ? `rgba(40,34,22,${rng.range(0.03, 0.08)})` : `rgba(255,250,220,${rng.range(0.02, 0.04)})`;
    circle(ctx, x, y, r);
    ctx.fill();
  }
}

export function drawHull(ctx: Ctx, spec: VehicleSpec) {
  const lk = spec.look;
  const pal = lk.colors;
  const hl = lk.L / 2;
  const hw = lk.W / 2;
  const dh = hw - lk.trackW + lk.fender;
  const rng = new Rng(hashStr(spec.id));

  // side skirts behind tracks shadow
  drawTracks(ctx, spec);

  const deck = deckPolygon(spec);
  // deck base
  poly(ctx, deck);
  const g = ctx.createLinearGradient(0, -dh, 0, dh);
  g.addColorStop(0, shade(pal.base, 0.06));
  g.addColorStop(0.5, pal.base);
  g.addColorStop(1, shade(pal.base, -0.1));
  ctx.fillStyle = g;
  ctx.fill();

  ctx.save();
  poly(ctx, deck);
  ctx.clip();

  // fenders (over tracks)
  if (lk.fender > 0.05 && !lk.wheels) {
    const fy = dh - lk.fender;
    for (const sgn of [-1, 1]) {
      const y0 = sgn < 0 ? -dh : fy;
      ctx.fillStyle = shade(pal.base, -0.06);
      ctx.fillRect(-hl, y0, lk.L, lk.fender);
      ctx.strokeStyle = 'rgba(0,0,0,0.28)';
      ctx.lineWidth = 0.025;
      for (let x = -hl + 1.1; x < hl - 0.4; x += 1.25) {
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y0 + lk.fender);
        ctx.stroke();
      }
      ctx.strokeStyle = shade(pal.light, -0.05);
      ctx.lineWidth = 0.03;
      ctx.beginPath();
      ctx.moveTo(-hl, sgn < 0 ? fy * -1 : fy);
      ctx.lineTo(hl, sgn < 0 ? fy * -1 : fy);
      ctx.stroke();
    }
  }

  // sloped side plates (superstructure sides angled) — darker inner band
  if (spec.armor.side.s >= 20) {
    const band = Math.min(0.32, lk.trackW * 0.55);
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    ctx.fillRect(-hl, -dh + (lk.fender > 0.05 ? lk.fender - 0.02 : 0), lk.L, band);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(-hl, dh - (lk.fender > 0.05 ? lk.fender - 0.02 : 0) - band, lk.L, band);
  }

  // camo / weathering
  if (lk.camo === 'stripes') camo(ctx, rng, -hl, -dh, lk.L, dh * 2);
  weather(ctx, rng, -hl, -dh, lk.L, dh * 2, 40);

  // glacis / nose
  const noseX = hl - lk.noseLen;
  if (lk.nose === 'sloped' || lk.nose === 'chamfer' || lk.nose === 'flat') {
    ctx.fillStyle = lk.nose === 'flat' ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,240,0.08)';
    ctx.fillRect(noseX, -dh, lk.noseLen, dh * 2);
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 0.035;
    ctx.beginPath();
    ctx.moveTo(noseX, -dh);
    ctx.lineTo(noseX, dh);
    ctx.stroke();
    bolts(ctx, noseX + 0.08, -dh + 0.25, noseX + 0.08, dh - 0.25, 7, 'rgba(0,0,0,0.3)');
    // lower plate edge
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(hl - 0.14, -dh, 0.14, dh * 2);
  } else if (lk.nose === 'round') {
    const r = Math.min(lk.noseLen * 0.55, 0.7);
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(hl - r, -dh, r, dh * 2);
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo(hl - r, -dh);
    ctx.lineTo(hl - r, dh);
    ctx.stroke();
    bolts(ctx, hl - r + 0.07, -dh + 0.15, hl - r + 0.07, dh - 0.15, 9, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = 'rgba(255,255,240,0.07)';
    ctx.fillRect(noseX, -dh, lk.noseLen - r, dh * 2);
    ctx.beginPath();
    ctx.moveTo(noseX, -dh);
    ctx.lineTo(noseX, dh);
    ctx.stroke();
  } else if (lk.nose === 'step') {
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.fillRect(noseX, -dh, lk.noseLen, dh * 2);
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 0.035;
    ctx.beginPath();
    ctx.moveTo(noseX, -dh);
    ctx.lineTo(noseX, dh);
    ctx.stroke();
    bolts(ctx, hl - 0.1, -dh * 0.6, hl - 0.1, dh * 0.6, 6, 'rgba(0,0,0,0.3)');
  } else if (lk.nose === 'pike') {
    ctx.fillStyle = 'rgba(255,255,240,0.07)';
    ctx.beginPath();
    ctx.moveTo(hl, -dh * 0.3);
    ctx.lineTo(hl, dh * 0.3);
    ctx.lineTo(noseX, dh);
    ctx.lineTo(noseX, -dh);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 0.03;
    ctx.stroke();
  }

  // spare tracks on glacis
  if (lk.spareTracks === 'glacis') {
    const x0 = noseX + 0.15;
    for (let i = 0; i < 5; i++) {
      const y = -dh * 0.75 + i * 0.17;
      ctx.fillStyle = '#3a3830';
      ctx.fillRect(x0, y, Math.min(0.55, lk.noseLen * 0.5), 0.13);
      ctx.fillStyle = '#4f4c42';
      ctx.fillRect(x0 + 0.05, y + 0.03, Math.min(0.45, lk.noseLen * 0.4), 0.04);
    }
  }
  if (lk.spareTracks === 'sides') {
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = '#3a3830';
        ctx.fillRect(-hl + 0.6 + i * 0.2, sgn * (dh - 0.18) - 0.09, 0.15, 0.18);
      }
    }
  }

  // driver / radio hatches
  const crewHasR = spec.crew.includes('R');
  const hx = lk.nose === 'sloped' ? noseX + lk.noseLen * 0.4 : noseX - 0.42;
  if (lk.turret.shape !== 'casemate' || lk.turret.x < hl - 2.2) {
    hatch(ctx, hx, -dh * 0.48, 0.28, pal, true);
    // periscopes
    ctx.fillStyle = '#1e211a';
    ctx.fillRect(hx + 0.32, -dh * 0.48 - 0.12, 0.06, 0.24);
    if (crewHasR && lk.nose !== 'pike') {
      hatch(ctx, hx, dh * 0.48, 0.28, pal, true);
      ctx.fillStyle = '#1e211a';
      ctx.fillRect(hx + 0.32, dh * 0.48 - 0.12, 0.06, 0.24);
      // bow MG ball
      if (spec.nation !== 'ussr' || lk.nose === 'sloped') {
        ctx.fillStyle = pal.dark;
        circle(ctx, hl - 0.25, dh * 0.45, 0.09);
        ctx.fill();
      }
    }
  }

  // headlights, tow hooks
  ctx.fillStyle = shade(pal.dark, -0.2);
  for (const sgn of [-1, 1]) {
    circle(ctx, hl - 0.18, sgn * (dh - 0.28), 0.08);
    ctx.fill();
    ctx.fillRect(hl - 0.08, sgn * (dh - 0.6) - 0.06, 0.08, 0.12);
    ctx.fillRect(-hl, sgn * (dh - 0.55) - 0.06, 0.1, 0.12);
  }

  // engine deck
  const ex0 = -hl;
  const ex1 = -hl + lk.engineDeck;
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 0.035;
  ctx.beginPath();
  ctx.moveTo(ex1, -dh + lk.fender);
  ctx.lineTo(ex1, dh - lk.fender);
  ctx.stroke();
  const iw = dh - lk.fender; // inner half width of deck
  switch (lk.grille) {
    case 'slats':
      grille(ctx, ex0 + 0.35, -iw * 0.82, lk.engineDeck * 0.42, iw * 1.64, 'y', 0.09, pal);
      rrect(ctx, ex0 + 0.35 + lk.engineDeck * 0.48, -iw * 0.55, lk.engineDeck * 0.4, iw * 1.1, 0.06);
      ctx.fillStyle = shade(pal.base, 0.04);
      ctx.fill();
      ctx.strokeStyle = pal.line;
      ctx.stroke();
      break;
    case 'mesh':
      mesh(ctx, ex0 + 0.2, -iw * 0.85, lk.engineDeck * 0.5, iw * 1.7, pal);
      mesh(ctx, ex0 + 0.3 + lk.engineDeck * 0.5, -iw * 0.4, lk.engineDeck * 0.35, iw * 0.8, pal);
      break;
    case 'twin':
      grille(ctx, ex0 + 0.25, -iw * 0.95, lk.engineDeck * 0.8, iw * 0.45, 'x', 0.11, pal);
      grille(ctx, ex0 + 0.25, iw * 0.5, lk.engineDeck * 0.8, iw * 0.45, 'x', 0.11, pal);
      for (const yy of [-0.32, 0.32]) {
        ctx.fillStyle = shade(pal.dark, -0.35);
        circle(ctx, ex0 + lk.engineDeck * 0.45, yy * iw, 0.33);
        ctx.fill();
        ctx.strokeStyle = shade(pal.base, 0.05);
        ctx.lineWidth = 0.03;
        for (let k = 0; k < 6; k++) {
          ctx.beginPath();
          ctx.arc(ex0 + lk.engineDeck * 0.45, yy * iw, 0.06 + k * 0.045, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      break;
    case 'fans':
      for (const yy of [-0.42, 0.42]) {
        ctx.fillStyle = shade(pal.dark, -0.4);
        circle(ctx, ex0 + lk.engineDeck * 0.5, yy * iw, 0.38);
        ctx.fill();
        ctx.strokeStyle = shade(pal.base, 0.0);
        ctx.lineWidth = 0.028;
        for (let k = 0; k < 7; k++) {
          ctx.beginPath();
          ctx.arc(ex0 + lk.engineDeck * 0.5, yy * iw, 0.06 + k * 0.045, 0, Math.PI * 2);
          ctx.stroke();
        }
        mesh(ctx, ex0 + 0.12, yy * iw - 0.32, 0.45, 0.64, pal);
        mesh(ctx, ex0 + lk.engineDeck - 0.6, yy * iw - 0.32, 0.45, 0.64, pal);
      }
      hatch(ctx, ex0 + lk.engineDeck * 0.5, 0, 0.32, pal, true);
      break;
    case 'louvre':
      grille(ctx, ex0 + 0.3, -iw * 0.28, lk.engineDeck * 0.85, iw * 0.56, 'y', 0.07, pal);
      grille(ctx, ex0 + 0.45, -iw * 0.9, lk.engineDeck * 0.6, iw * 0.38, 'x', 0.1, pal);
      grille(ctx, ex0 + 0.45, iw * 0.52, lk.engineDeck * 0.6, iw * 0.38, 'x', 0.1, pal);
      break;
  }
  // rear plate shading
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fillRect(-hl, -dh, 0.16, dh * 2);
  // exhausts
  ctx.fillStyle = '#2b2a25';
  if (lk.exhaust === 'rear2') {
    for (const sgn of [-1, 1]) {
      rrect(ctx, -hl - 0.02, sgn * iw * 0.45 - 0.14, 0.28, 0.28, 0.12);
      ctx.fill();
      ctx.fillStyle = '#121210';
      circle(ctx, -hl + 0.12, sgn * iw * 0.45, 0.07);
      ctx.fill();
      ctx.fillStyle = '#2b2a25';
    }
  } else if (lk.exhaust === 'rearBox') {
    rrect(ctx, -hl - 0.02, -iw * 0.55, 0.22, iw * 1.1, 0.06);
    ctx.fill();
  } else if (lk.exhaust === 'side') {
    for (const sgn of [-1, 1]) {
      ctx.fillRect(-hl + 0.3, sgn * (dh - 0.1) - 0.08, 0.5, 0.16);
    }
  }

  // tools along fender / deck
  ctx.strokeStyle = shade(pal.dark, -0.2);
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.moveTo(-hl + lk.engineDeck + 0.2, -dh + 0.12);
  ctx.lineTo(-hl + lk.engineDeck + 1.4, -dh + 0.12);
  ctx.moveTo(-hl + lk.engineDeck + 0.3, dh - 0.12);
  ctx.lineTo(-hl + lk.engineDeck + 1.6, dh - 0.12);
  ctx.stroke();
  ctx.fillStyle = '#6b5a3c';
  ctx.fillRect(-hl + lk.engineDeck + 0.2, -dh + 0.08, 0.9, 0.06);

  // fuel drums (Soviet)
  if (lk.fuelDrums) {
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const x = -hl + 0.35 + i * 0.75;
        const y = sgn * (dh - 0.2);
        const g2 = ctx.createLinearGradient(x, y - 0.2, x, y + 0.2);
        g2.addColorStop(0, shade(pal.base, -0.25));
        g2.addColorStop(0.5, shade(pal.base, 0.12));
        g2.addColorStop(1, shade(pal.base, -0.3));
        ctx.fillStyle = g2;
        rrect(ctx, x, y - 0.19, 0.65, 0.38, 0.08);
        ctx.fill();
        ctx.strokeStyle = pal.line;
        ctx.lineWidth = 0.025;
        ctx.stroke();
      }
    }
  }

  // panel lines
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 0.022;
  ctx.beginPath();
  ctx.moveTo(-hl + lk.engineDeck, 0);
  ctx.lineTo(noseX - 0.1, 0);
  ctx.stroke();
  ctx.restore();

  // deck outline
  poly(ctx, deck);
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 0.045;
  ctx.stroke();

  // side skirts (schürzen)
  if (lk.skirts) {
    for (const sgn of [-1, 1]) {
      const y = sgn * (hw + 0.03);
      const n = 5;
      const segL = (lk.L * 0.82) / n;
      for (let i = 0; i < n; i++) {
        const x0 = -lk.L * 0.41 + i * segL;
        ctx.fillStyle = shade(pal.base, -0.08 + (i % 2) * 0.04);
        ctx.fillRect(x0 + 0.03, y - 0.06, segL - 0.06, 0.12);
        ctx.strokeStyle = pal.line;
        ctx.lineWidth = 0.025;
        ctx.strokeRect(x0 + 0.03, y - 0.06, segL - 0.06, 0.12);
      }
    }
  }
  if (lk.sandshields) {
    for (const sgn of [-1, 1]) {
      ctx.fillStyle = shade(pal.base, -0.12);
      ctx.fillRect(-hl + 0.4, sgn * (hw + 0.01) - 0.035, lk.L - 0.8, 0.07);
    }
  }
}

// ---------------------------------------------------------------------------
// Turret

export function drawTurret(ctx: Ctx, spec: VehicleSpec, bp: Blueprint) {
  const lk = spec.look;
  const tl = lk.turret;
  const pal = lk.colors;
  const rng = new Rng(hashStr(spec.id + 't'));
  const tp = bp.turretPoly;
  const fx = bp.turretFrontX;
  const bx = bp.turretBackX;
  const cx = (fx + bx) / 2;
  const hwid = tl.wid / 2;

  // turret schürzen (outer shell)
  if (tl.extra?.includes('schurzen')) {
    ctx.save();
    ctx.strokeStyle = shade(pal.base, -0.1);
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    ctx.moveTo(fx - 0.6, -hwid - 0.18);
    ctx.lineTo(bx - 0.2, -hwid - 0.12);
    ctx.lineTo(bx - 0.2, hwid + 0.12);
    ctx.lineTo(fx - 0.6, hwid + 0.18);
    ctx.stroke();
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 0.025;
    ctx.stroke();
    ctx.restore();
  }

  // main body
  poly(ctx, tp);
  const cast = tl.shape === 'round' || tl.shape === 'dome';
  if (cast) {
    const g = ctx.createRadialGradient(cx + 0.2, -0.25, 0.1, cx, 0, Math.max(tl.len, tl.wid) * 0.62);
    g.addColorStop(0, shade(pal.base, 0.14));
    g.addColorStop(0.6, pal.base);
    g.addColorStop(1, shade(pal.base, -0.28));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = pal.base;
  }
  ctx.fill();

  ctx.save();
  poly(ctx, tp);
  ctx.clip();
  if (lk.camo === 'stripes') camo(ctx, rng, bx, -hwid, tl.len, tl.wid);
  weather(ctx, rng, bx, -hwid, tl.len, tl.wid, 16);

  // sloped side plates band for flat-plate turrets
  if (!cast) {
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = tl.shape === 'panther' || tl.shape === 'hex' || tl.shape === 'pent' || tl.shape === 'small' ? 0.42 : 0.18;
    poly(ctx, tp);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,240,0.08)';
    ctx.lineWidth = 0.05;
    ctx.save();
    ctx.translate(cx * 0.12, 0);
    ctx.scale(0.86, 0.84);
    poly(ctx, tp);
    ctx.restore();
    ctx.stroke();
  }

  // open-top interior
  if (spec.armor.openTop) {
    ctx.save();
    ctx.translate(cx * 0.1, 0);
    ctx.scale(0.8, 0.78);
    poly(ctx, tp);
    ctx.restore();
    ctx.fillStyle = '#2a2b22';
    ctx.fill();
    ctx.fillStyle = '#4b4a3e';
    ctx.fillRect(fx - 1.4, -0.22, 1.1, 0.44); // breech
    ctx.fillStyle = '#3a3a30';
    circle(ctx, fx - 1.3, -hwid * 0.5, 0.18);
    ctx.fill();
    circle(ctx, fx - 1.3, hwid * 0.5, 0.18);
    ctx.fill();
    // shells in rack
    ctx.fillStyle = '#9a7a3c';
    for (let i = 0; i < 6; i++) ctx.fillRect(bx + 0.25 + i * 0.12, hwid * 0.35, 0.07, 0.3);
  }
  ctx.restore();

  // outline
  poly(ctx, tp);
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 0.05;
  ctx.stroke();

  // bustle stowage / counterweight
  if (tl.extra?.includes('counterweight')) {
    for (const sgn of [-1, 1]) {
      ctx.fillStyle = shade(pal.base, -0.12);
      ctx.beginPath();
      ctx.moveTo(bx + 0.05, sgn * 0.15);
      ctx.lineTo(bx - 0.35, sgn * 0.25);
      ctx.lineTo(bx - 0.35, sgn * hwid * 0.8);
      ctx.lineTo(bx + 0.05, sgn * hwid * 0.85);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 0.03;
      ctx.stroke();
    }
  }
  if (tl.extra?.includes('stowage')) {
    ctx.strokeStyle = shade(pal.dark, -0.2);
    ctx.lineWidth = 0.035;
    rrect(ctx, bx - 0.32, -hwid * 0.6, 0.34, hwid * 1.2, 0.05);
    ctx.stroke();
    const cols = ['#6f6a4a', '#5b5a40', '#7a6c4b'];
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = cols[i];
      rrect(ctx, bx - 0.3, -hwid * 0.55 + i * hwid * 0.38, 0.28, hwid * 0.34, 0.08);
      ctx.fill();
    }
  }

  // cupola
  const cu = tl.cupola;
  if (cu.r > 0) {
    ctx.fillStyle = shade(pal.base, -0.05);
    circle(ctx, cu.x, cu.y, cu.r);
    ctx.fill();
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 0.04;
    ctx.stroke();
    // vision blocks
    ctx.fillStyle = '#1b1d17';
    const nb = spec.nation === 'germany' ? 7 : 6;
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2 + 0.3;
      ctx.save();
      ctx.translate(cu.x + Math.cos(a) * cu.r * 0.86, cu.y + Math.sin(a) * cu.r * 0.86);
      ctx.rotate(a);
      ctx.fillRect(-0.035, -0.07, 0.07, 0.14);
      ctx.restore();
    }
    hatch(ctx, cu.x, cu.y, cu.r * 0.62, pal);
  }
  if (tl.hatch) hatch(ctx, tl.hatch.x, tl.hatch.y, tl.hatch.r, pal);
  if (tl.extra?.includes('vent')) {
    ctx.fillStyle = shade(pal.base, 0.1);
    circle(ctx, fx - 0.75, 0.15, 0.14);
    ctx.fill();
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 0.025;
    ctx.stroke();
  }
  if (tl.extra?.includes('periscopes')) {
    ctx.fillStyle = '#1b1d17';
    ctx.fillRect(fx - 0.55, -hwid * 0.55, 0.14, 0.09);
    ctx.fillRect(fx - 0.55, hwid * 0.45, 0.14, 0.09);
  }
  if (tl.extra?.includes('smoke')) {
    ctx.fillStyle = shade(pal.dark, -0.2);
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        circle(ctx, fx - 0.25 - i * 0.12, sgn * (hwid * 0.72 + i * 0.05), 0.05);
        ctx.fill();
      }
    }
  }
  // antenna base
  ctx.fillStyle = '#1c1d18';
  circle(ctx, bx + 0.3, hwid * 0.55, 0.05);
  ctx.fill();

  // mantlet (turreted vehicles only — casemates carry it on the gun sprite)
  if (!bp.casemate) drawMantlet(ctx, spec, bp.barrelStart);
}

function drawMantlet(ctx: Ctx, spec: VehicleSpec, barrelStart: number) {
  const lk = spec.look;
  const pal = lk.colors;
  const mw = lk.mantletW / 2;
  const ml = lk.mantletL;
  const x1 = barrelStart + 0.02;
  const x0 = x1 - ml;
  ctx.save();
  const g = ctx.createLinearGradient(0, -mw, 0, mw);
  g.addColorStop(0, shade(pal.base, -0.2));
  g.addColorStop(0.45, shade(pal.base, 0.12));
  g.addColorStop(1, shade(pal.base, -0.25));
  ctx.fillStyle = g;
  switch (lk.mantlet) {
    case 'box':
      rrect(ctx, x0, -mw, ml, mw * 2, 0.06);
      break;
    case 'round':
      ctx.beginPath();
      ctx.moveTo(x0, -mw);
      ctx.lineTo(x1 - ml * 0.4, -mw);
      ctx.quadraticCurveTo(x1, -mw, x1, 0);
      ctx.quadraticCurveTo(x1, mw, x1 - ml * 0.4, mw);
      ctx.lineTo(x0, mw);
      ctx.closePath();
      break;
    case 'curved':
      ctx.beginPath();
      ctx.ellipse(x0 + ml * 0.5, 0, ml * 0.62, mw, 0, 0, Math.PI * 2);
      break;
    case 'saukopf':
      ctx.beginPath();
      ctx.moveTo(x0, -mw);
      ctx.lineTo(x1, -mw * 0.45);
      ctx.lineTo(x1, mw * 0.45);
      ctx.lineTo(x0, mw);
      ctx.closePath();
      break;
  }
  ctx.fill();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 0.04;
  ctx.stroke();
  // coaxial MG / sight port
  ctx.fillStyle = '#1a1b16';
  ctx.fillRect(x1 - 0.1, mw * 0.55, 0.1, 0.05);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Gun (gun frame: origin at pivot, +x along the barrel)

export function drawGun(ctx: Ctx, spec: VehicleSpec, bp: Blueprint) {
  const lk = spec.look;
  const pal = lk.colors;
  if (bp.casemate) drawMantlet(ctx, spec, bp.barrelStart);
  const x0 = bp.barrelStart - 0.05;
  const x1 = bp.muzzle;
  const w0 = lk.gunW / 2;
  const w1 = w0 * 0.82;
  const g = ctx.createLinearGradient(0, -w0, 0, w0);
  g.addColorStop(0, shade(pal.base, -0.35));
  g.addColorStop(0.42, shade(pal.base, 0.15));
  g.addColorStop(1, shade(pal.base, -0.42));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x0, -w0);
  ctx.lineTo(x1, -w1);
  ctx.lineTo(x1, w1);
  ctx.lineTo(x0, w0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 0.03;
  ctx.stroke();
  // barrel collar
  ctx.fillStyle = shade(pal.base, -0.15);
  ctx.fillRect(x0 + 0.25, -w0 * 1.15, 0.12, w0 * 2.3);
  if (lk.fumeExtractor) {
    ctx.fillRect(x0 + (x1 - x0) * 0.6, -w0 * 1.35, 0.5, w0 * 2.7);
  }
  // muzzle
  const bw = w1 * 1.75;
  switch (lk.brake) {
    case 'double':
      ctx.fillStyle = shade(pal.base, -0.2);
      rrect(ctx, x1 - 0.42, -bw, 0.42, bw * 2, 0.04);
      ctx.fill();
      ctx.strokeStyle = pal.line;
      ctx.stroke();
      ctx.fillStyle = '#16170f';
      ctx.fillRect(x1 - 0.3, -bw - 0.01, 0.07, bw * 2 + 0.02);
      ctx.fillRect(x1 - 0.16, -bw - 0.01, 0.06, bw * 2 + 0.02);
      break;
    case 'single':
      ctx.fillStyle = shade(pal.base, -0.2);
      rrect(ctx, x1 - 0.22, -bw * 0.9, 0.22, bw * 1.8, 0.03);
      ctx.fill();
      ctx.strokeStyle = pal.line;
      ctx.stroke();
      ctx.fillStyle = '#16170f';
      ctx.fillRect(x1 - 0.13, -bw, 0.05, bw * 2);
      break;
    case 'is':
      ctx.fillStyle = shade(pal.base, -0.2);
      rrect(ctx, x1 - 0.55, -bw * 1.1, 0.55, bw * 2.2, 0.05);
      ctx.fill();
      ctx.strokeStyle = pal.line;
      ctx.stroke();
      ctx.fillStyle = '#16170f';
      ctx.fillRect(x1 - 0.42, -bw * 1.12, 0.12, bw * 2.24);
      ctx.fillRect(x1 - 0.22, -bw * 1.12, 0.1, bw * 2.24);
      break;
    default:
      ctx.fillStyle = shade(pal.base, -0.25);
      ctx.fillRect(x1 - 0.1, -w1 * 1.12, 0.1, w1 * 2.24);
  }
}

// ---------------------------------------------------------------------------
// Sprite cache

export interface SpritePart {
  canvas: HTMLCanvasElement;
  /** local-frame coordinate (meters) of the canvas top-left */
  ox: number;
  oy: number;
  scale: number;
}

export interface TankSprites {
  hull: SpritePart;
  turret: SpritePart;
  gun: SpritePart;
  hullShadow: SpritePart;
  turretShadow: SpritePart;
  gunShadow: SpritePart;
  burnt?: { hull: SpritePart; turret: SpritePart; gun: SpritePart };
}

const spriteCache = new Map<string, TankSprites>();

function renderPart(bounds: { x0: number; y0: number; x1: number; y1: number }, scale: number, draw: (ctx: Ctx) => void): SpritePart {
  const pad = 0.3;
  const x0 = bounds.x0 - pad;
  const y0 = bounds.y0 - pad;
  const w = (bounds.x1 - bounds.x0 + pad * 2) * scale;
  const h = (bounds.y1 - bounds.y0 + pad * 2) * scale;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
  ctx.lineJoin = 'round';
  draw(ctx);
  return { canvas, ox: x0, oy: y0, scale };
}

function silhouette(p: SpritePart, color = '#000'): SpritePart {
  const c = makeCanvas(p.canvas.width, p.canvas.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(p.canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return { ...p, canvas: c };
}

function burnt(p: SpritePart, seed: number): SpritePart {
  const c = makeCanvas(p.canvas.width, p.canvas.height);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(p.canvas, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = 'rgba(28,24,20,0.72)';
  ctx.fillRect(0, 0, c.width, c.height);
  const rng = new Rng(seed);
  for (let i = 0; i < 26; i++) {
    const x = rng.next() * c.width;
    const y = rng.next() * c.height;
    const r = rng.range(0.05, 0.18) * Math.min(c.width, c.height);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const rust = rng.chance(0.5);
    g.addColorStop(0, rust ? 'rgba(110,62,34,0.45)' : 'rgba(5,5,5,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return { ...p, canvas: c };
}

export function getTankSprites(spec: VehicleSpec, scale: number): TankSprites {
  const key = `${spec.id}@${scale}`;
  let s = spriteCache.get(key);
  if (s) return s;
  const bp = getBlueprint(spec);
  const lk = spec.look;
  const hb = { x0: -lk.L / 2, y0: -lk.W / 2 - 0.15, x1: lk.L / 2, y1: lk.W / 2 + 0.15 };
  const hull = renderPart(hb, scale, (ctx) => drawHull(ctx, spec));
  const tb = {
    x0: bp.turretBackX - 0.5,
    y0: -lk.turret.wid / 2 - 0.3,
    x1: Math.max(bp.turretFrontX, bp.casemate ? bp.turretFrontX : bp.barrelStart) + 0.2,
    y1: lk.turret.wid / 2 + 0.3,
  };
  const turret = renderPart(tb, scale, (ctx) => drawTurret(ctx, spec, bp));
  const gb = { x0: bp.barrelStart - lk.mantletL - 0.1, y0: -Math.max(lk.mantletW / 2, lk.gunW * 1.4), x1: bp.muzzle + 0.05, y1: Math.max(lk.mantletW / 2, lk.gunW * 1.4) };
  const gun = renderPart(gb, scale, (ctx) => drawGun(ctx, spec, bp));
  s = {
    hull,
    turret,
    gun,
    hullShadow: silhouette(hull),
    turretShadow: silhouette(turret),
    gunShadow: silhouette(gun),
  };
  spriteCache.set(key, s);
  return s;
}

export function getBurnt(spec: VehicleSpec, scale: number) {
  const s = getTankSprites(spec, scale);
  if (!s.burnt) {
    const seed = hashStr(spec.id + 'burn');
    s.burnt = { hull: burnt(s.hull, seed), turret: burnt(s.turret, seed + 1), gun: burnt(s.gun, seed + 2) };
  }
  return s.burnt;
}

/** Draw a whole tank from cached sprites at the origin (ctx in meters, +x forward). */
export function drawTankSprite(ctx: Ctx, spec: VehicleSpec, scale: number, turretRel = 0) {
  const S = getTankSprites(spec, scale);
  const bp = getBlueprint(spec);
  ctx.save();
  blitPart(ctx, S.hull);
  ctx.translate(bp.turretX, 0);
  ctx.rotate(turretRel);
  if (bp.casemate) {
    blitPart(ctx, S.turret);
    ctx.translate(bp.gunPivot.x, bp.gunPivot.y);
    blitPart(ctx, S.gun);
  } else {
    blitPart(ctx, S.gun);
    blitPart(ctx, S.turret);
  }
  ctx.restore();
}

/** Draw a sprite part with the context already transformed into the part's local frame (meters). */
export function blitPart(ctx: Ctx, p: SpritePart, dx = 0, dy = 0) {
  ctx.drawImage(p.canvas, p.ox + dx, p.oy + dy, p.canvas.width / p.scale, p.canvas.height / p.scale);
}

// ---------------------------------------------------------------------------
// Full vector draw (hangar / cards) at arbitrary transform

export function drawTankVector(ctx: Ctx, spec: VehicleSpec, turretRel = 0, gunRel = 0) {
  const bp = getBlueprint(spec);
  ctx.save();
  ctx.lineJoin = 'round';
  drawHull(ctx, spec);
  ctx.translate(bp.turretX, 0);
  ctx.rotate(turretRel);
  if (bp.casemate) {
    drawTurret(ctx, spec, bp);
    ctx.translate(bp.gunPivot.x, bp.gunPivot.y);
    ctx.rotate(gunRel);
    drawGun(ctx, spec, bp);
  } else {
    // turret shadow on hull
    ctx.save();
    ctx.translate(-0.12, 0.14);
    ctx.globalAlpha = 0.35;
    poly(ctx, bp.turretPoly);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
    drawGun(ctx, spec, bp);
    drawTurret(ctx, spec, bp);
  }
  ctx.restore();
}

/** Tank drawn as a shadow silhouette (for hangar ground shadow) */
export function drawTankShadowVector(ctx: Ctx, spec: VehicleSpec, turretRel = 0) {
  const bp = getBlueprint(spec);
  ctx.save();
  ctx.fillStyle = '#000';
  poly(ctx, bp.hullPoly);
  ctx.fill();
  ctx.translate(bp.turretX, 0);
  ctx.rotate(turretRel);
  poly(ctx, bp.turretPoly);
  ctx.fill();
  ctx.fillRect(bp.barrelStart, -spec.look.gunW / 2, bp.muzzle - bp.barrelStart, spec.look.gunW);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// X-ray / armor views

export type ModState = 'ok' | 'damaged' | 'destroyed';
export interface XrayOpts {
  style: 'gold' | 'gray';
  states?: Record<string, ModState>;
  turretRel?: number;
  gunRel?: number;
  labels?: boolean;
  /** extra rotation applied to labels so they read upright on screen */
  labelRot?: number;
  highlight?: Set<string>;
}

function shapePath(ctx: Ctx, m: ModuleDef) {
  const s = m.shape;
  if (s.t === 'rect') {
    ctx.beginPath();
    ctx.rect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
  } else {
    circle(ctx, s.x, s.y, s.r);
  }
}

const XRAY = {
  gold: {
    body: 'rgba(214,170,30,0.62)',
    bodyLine: 'rgba(60,45,5,0.9)',
    mod: 'rgba(196,150,20,0.9)',
    modLine: 'rgba(55,40,5,0.95)',
    crew: '#1f6d52',
    crewLine: '#0d2e22',
    text: 'rgba(40,30,4,0.95)',
  },
  gray: {
    body: 'rgba(205,210,205,0.16)',
    bodyLine: 'rgba(225,230,225,0.55)',
    mod: 'rgba(215,220,215,0.32)',
    modLine: 'rgba(235,240,235,0.7)',
    crew: '#2f8a4e',
    crewLine: '#0f3a20',
    text: 'rgba(240,240,235,0.75)',
  },
};

const STATE_COL: Record<ModState, string> = { ok: '', damaged: 'rgba(232,140,40,0.92)', destroyed: 'rgba(206,46,38,0.95)' };

export function drawXray(ctx: Ctx, spec: VehicleSpec, o: XrayOpts) {
  const bp = getBlueprint(spec);
  const C = XRAY[o.style];
  const tr = o.turretRel ?? 0;
  const gr = o.gunRel ?? 0;
  ctx.save();
  ctx.lineJoin = 'round';
  // hull body
  poly(ctx, bp.hullPoly);
  ctx.fillStyle = C.body;
  ctx.fill();
  ctx.strokeStyle = C.bodyLine;
  ctx.lineWidth = 0.05;
  ctx.stroke();

  const drawMods = (frame: string) => {
    for (const m of bp.modules) {
      if (m.frame !== frame || m.kind === 'crew') continue;
      const st = o.states?.[m.id] ?? 'ok';
      shapePath(ctx, m);
      ctx.fillStyle = st === 'ok' ? C.mod : STATE_COL[st];
      ctx.fill();
      ctx.strokeStyle = o.highlight?.has(m.id) ? '#fff' : C.modLine;
      ctx.lineWidth = o.highlight?.has(m.id) ? 0.07 : 0.04;
      ctx.stroke();
      if (o.labels && m.shape.t === 'rect') {
        const s = m.shape;
        const w = s.x1 - s.x0;
        const h = s.y1 - s.y0;
        const lr = (o.labelRot ?? 0) - (frame === 'hull' ? 0 : tr) - (frame === 'gun' ? gr : 0);
        const horiz = Math.abs(Math.cos(lr)) * w + Math.abs(Math.sin(lr)) * h;
        const vert = Math.abs(Math.sin(lr)) * w + Math.abs(Math.cos(lr)) * h;
        let rot = lr;
        let avail = horiz;
        if (vert > horiz * 1.6) {
          rot = lr + Math.PI / 2;
          avail = vert;
        }
        const fs = Math.min(0.34, avail / (m.label.length * 0.6), Math.min(w, h) * 0.9);
        ctx.save();
        ctx.translate((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2);
        ctx.rotate(rot);
        ctx.fillStyle = C.text;
        ctx.font = `700 ${fs}px "Barlow Condensed", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(m.label, 0, 0);
        ctx.restore();
      }
    }
  };
  const drawCrew = (frame: string) => {
    for (const m of bp.modules) {
      if (m.frame !== frame || m.kind !== 'crew') continue;
      const st = o.states?.[m.id] ?? 'ok';
      const s = m.shape as { t: 'circle'; x: number; y: number; r: number };
      const r = o.style === 'gold' ? s.r * 1.25 : s.r;
      circle(ctx, s.x, s.y, r);
      ctx.fillStyle = st === 'ok' ? C.crew : st === 'damaged' ? STATE_COL.damaged : STATE_COL.destroyed;
      ctx.fill();
      ctx.strokeStyle = o.highlight?.has(m.id) ? '#fff' : C.crewLine;
      ctx.lineWidth = 0.05;
      ctx.stroke();
      if (o.labels) {
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate((o.labelRot ?? 0) - (frame === 'hull' ? 0 : tr));
        ctx.fillStyle = '#fff';
        ctx.font = `700 ${r * 1.3}px "Barlow Condensed", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(m.label, 0, r * 0.06);
        ctx.restore();
      }
    }
  };
  drawMods('hull');
  // gun barrel under the crew markers
  ctx.save();
  ctx.translate(bp.turretX, 0);
  ctx.rotate(tr);
  ctx.translate(bp.gunPivot.x, bp.gunPivot.y);
  ctx.rotate(gr);
  for (const m of bp.modules) {
    if (m.frame !== 'gun') continue;
    const st = o.states?.[m.id] ?? 'ok';
    shapePath(ctx, m);
    ctx.fillStyle = st === 'ok' ? C.mod : STATE_COL[st];
    ctx.fill();
    ctx.strokeStyle = C.modLine;
    ctx.lineWidth = 0.035;
    ctx.stroke();
  }
  ctx.restore();
  drawCrew('hull');

  ctx.translate(bp.turretX, 0);
  ctx.rotate(tr);
  poly(ctx, bp.turretPoly);
  ctx.fillStyle = C.body;
  ctx.fill();
  ctx.strokeStyle = C.bodyLine;
  ctx.lineWidth = 0.05;
  ctx.stroke();
  drawMods('turret');
  drawCrew('turret');
  ctx.restore();
}

export function armorColor(eff: number): string {
  if (eff < 40) return '#2e9b63';
  if (eff < 80) return '#33a86c';
  if (eff < 120) return '#55b45a';
  if (eff < 160) return '#b8b437';
  if (eff < 220) return '#d3a129';
  return '#d97a26';
}

/** Armor-thickness view: plates drawn as bands along the outline with mm labels. */
export function drawArmorView(ctx: Ctx, spec: VehicleSpec, turretRel = 0, labelRot = 0, fontM = 0.3) {
  const bp = getBlueprint(spec);
  const A = spec.armor;
  ctx.save();
  ctx.lineJoin = 'miter';
  const band = 0.36;
  const labels: Array<{ x: number; y: number; t: string }> = [];
  const drawEdges = (edges: typeof bp.hullEdges, polyPts: V2[], getPlate: (k: string) => { t: number; s: number }, xf: (p: V2) => V2) => {
    // body base
    poly(ctx, polyPts);
    ctx.fillStyle = 'rgba(30,110,70,0.35)';
    ctx.fill();
    const groups = new Map<string, { x: number; y: number; w: number; t: number }>();
    for (const e of edges) {
      const p = getPlate(e.key);
      const eff = p.t / Math.cos((p.s * Math.PI) / 180);
      const col = armorColor(eff);
      const a = e.a;
      const b = e.b;
      const ax = a.x - e.n.x * band;
      const ay = a.y - e.n.y * band;
      const bx = b.x - e.n.x * band;
      const by = b.y - e.n.y * band;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(bx, by);
      ctx.lineTo(ax, ay);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,40,25,0.55)';
      ctx.lineWidth = 0.025;
      ctx.stroke();
      // group label per plate key and side of the vehicle
      const mx = (a.x + b.x) / 2 - e.n.x * band * 1.9;
      const my = (a.y + b.y) / 2 - e.n.y * band * 1.9;
      const sideKey = e.zone === 'side' ? (e.n.y < 0 ? 'L' : 'R') : '';
      const gk = e.key + sideKey;
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      const g = groups.get(gk) ?? { x: 0, y: 0, w: 0, t: p.t };
      g.x += mx * l;
      g.y += my * l;
      g.w += l;
      groups.set(gk, g);
    }
    for (const [gk, g] of groups) {
      if (g.w < 0.4) continue;
      let gx = g.x / g.w;
      if (polyPts === bp.hullPoly && (gk === 'sideL' || gk === 'sideR')) gx = -spec.look.L * 0.3;
      const mid = xf({ x: gx, y: g.y / g.w });
      labels.push({ x: mid.x, y: mid.y, t: `${g.t}mm` });
    }
  };
  drawEdges(bp.hullEdges, bp.hullPoly, (k) => (k === 'ufp' ? A.ufp : k === 'side' ? A.side : A.rear), (p) => p);
  ctx.save();
  ctx.translate(bp.turretX, 0);
  ctx.rotate(turretRel);
  const c = Math.cos(turretRel);
  const s = Math.sin(turretRel);
  drawEdges(
    bp.turretEdges,
    bp.turretPoly,
    (k) => (k === 'mantlet' ? A.mantlet : k === 'tFront' ? A.tFront : k === 'tSide' ? A.tSide : A.tRear),
    (p) => ({ x: bp.turretX + p.x * c - p.y * s, y: p.x * s + p.y * c }),
  );
  // gun
  ctx.translate(bp.gunPivot.x, 0);
  ctx.fillStyle = 'rgba(30,110,70,0.5)';
  ctx.fillRect(bp.barrelStart, -spec.look.gunW / 2, bp.muzzle - bp.barrelStart, spec.look.gunW);
  ctx.restore();
  // de-duplicate labels that overlap
  const placed: Array<{ x: number; y: number }> = [];
  ctx.font = `700 ${fontM}px "Barlow Condensed", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const lb of labels) {
    if (placed.some((p) => Math.hypot(p.x - lb.x, p.y - lb.y) < fontM * 1.5)) continue;
    placed.push(lb);
    ctx.save();
    ctx.translate(lb.x, lb.y);
    ctx.rotate(labelRot);
    ctx.lineWidth = fontM * 0.22;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(lb.t, 0, 0);
    ctx.fillStyle = '#f4f6ee';
    ctx.fillText(lb.t, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}
