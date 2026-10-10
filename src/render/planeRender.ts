// Recon aircraft, drawn top-down like the tanks: meters in the aircraft's own frame (+x nose,
// +y right wing). Three types by nation — Piper L-4 Grasshopper (USA), Fieseler Fi 156 Storch
// (Germany), Polikarpov Po-2 biplane (USSR). The body is cached as a sprite per type and scale;
// the spinning propeller and the banking are added when drawn.

import { makeCanvas } from './tankRender';

type Ctx = CanvasRenderingContext2D;

export type PlaneKind = 'l4' | 'storch' | 'po2';
export const PLANE_KINDS: PlaneKind[] = ['l4', 'storch', 'po2'];

export function planeForNation(nation: string): PlaneKind {
  return nation === 'germany' ? 'storch' : nation === 'ussr' ? 'po2' : 'l4';
}

interface PlaneDef {
  span: number;
  length: number;
  /** nose (prop) position along x */
  nose: number;
  prop: number;
}

export const PLANES: Record<PlaneKind, PlaneDef> = {
  l4: { span: 10.7, length: 6.8, nose: 3.05, prop: 0.95 },
  storch: { span: 14.3, length: 9.9, nose: 3.9, prop: 1.3 },
  po2: { span: 11.4, length: 8.2, nose: 3.35, prop: 1.2 },
};

function shade(hex: string, amt: number): string {
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

/** Wing planform: leading edge at x = le, chord c, half span s, tip rounding. */
function wingPath(ctx: Ctx, le: number, c: number, s: number, tip: number, taper = 0) {
  const te = le - c;
  ctx.beginPath();
  ctx.moveTo(le, 0);
  ctx.lineTo(le - taper * 0.3, -s + tip);
  ctx.quadraticCurveTo(le - taper * 0.3, -s, le - tip - taper * 0.3, -s);
  ctx.lineTo(te + tip + taper * 0.4, -s);
  ctx.quadraticCurveTo(te + taper * 0.4, -s, te + taper * 0.4, -s + tip);
  ctx.lineTo(te, 0);
  ctx.lineTo(te + taper * 0.4, s - tip);
  ctx.quadraticCurveTo(te + taper * 0.4, s, te + tip + taper * 0.4, s);
  ctx.lineTo(le - tip - taper * 0.3, s);
  ctx.quadraticCurveTo(le - taper * 0.3, s, le - taper * 0.3, s - tip);
  ctx.closePath();
}

/** Fabric-covered wing: base colour, chordwise light, rib tapes, control surfaces. */
function drawWing(ctx: Ctx, base: string, le: number, c: number, s: number, tip: number, opts: { taper?: number; ribs?: number; aileron?: number; flap?: number; slat?: boolean } = {}) {
  const taper = opts.taper ?? 0;
  const te = le - c;
  // drop shadow onto the fuselage below
  ctx.save();
  ctx.translate(-0.12, 0.14);
  wingPath(ctx, le, c, s, tip, taper);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fill();
  ctx.restore();
  wingPath(ctx, le, c, s, tip, taper);
  const g = ctx.createLinearGradient(le, 0, te, 0);
  g.addColorStop(0, shade(base, 0.22));
  g.addColorStop(0.25, shade(base, 0.06));
  g.addColorStop(1, shade(base, -0.16));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // rib tapes
  const n = opts.ribs ?? 12;
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 0.05;
  for (let i = 1; i < n; i++) {
    const y = -s + (2 * s * i) / n;
    ctx.beginPath();
    ctx.moveTo(le + 0.2, y);
    ctx.lineTo(te - 0.2, y);
    ctx.stroke();
  }
  // leading-edge highlight
  ctx.strokeStyle = 'rgba(255,255,240,0.25)';
  ctx.lineWidth = 0.09;
  ctx.beginPath();
  ctx.moveTo(le - 0.06, -s);
  ctx.lineTo(le - 0.06, s);
  ctx.stroke();
  // slats along the leading edge (Storch)
  if (opts.slat) {
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.moveTo(le - 0.32, -s + 0.4);
    ctx.lineTo(le - 0.32, -0.9);
    ctx.moveTo(le - 0.32, 0.9);
    ctx.lineTo(le - 0.32, s - 0.4);
    ctx.stroke();
  }
  // ailerons and flaps
  ctx.strokeStyle = 'rgba(0,0,0,0.38)';
  ctx.lineWidth = 0.05;
  const ail = opts.aileron ?? 0.32;
  const flap = opts.flap ?? 0;
  for (const sg of [-1, 1]) {
    const y0 = sg * s * (1 - 0.42);
    ctx.beginPath();
    ctx.moveTo(te - 0.05, y0);
    ctx.lineTo(te + ail, y0);
    ctx.lineTo(te + ail, sg * (s - 0.25));
    ctx.stroke();
    if (flap > 0) {
      ctx.beginPath();
      ctx.moveTo(te - 0.05, sg * 0.75);
      ctx.lineTo(te + flap, sg * 0.75);
      ctx.lineTo(te + flap, y0);
      ctx.stroke();
    }
  }
  ctx.restore();
  wingPath(ctx, le, c, s, tip, taper);
  ctx.strokeStyle = shade(base, -0.45);
  ctx.lineWidth = 0.06;
  ctx.stroke();
}

/** Slim fuselage outline from nose to tail (half widths along x). */
function fuselagePath(ctx: Ctx, pts: Array<[number, number]>) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], -pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], -pts[i][1]);
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

function drawFuselage(ctx: Ctx, base: string, pts: Array<[number, number]>) {
  fuselagePath(ctx, pts);
  const w = Math.max(...pts.map((p) => p[1]));
  const g = ctx.createLinearGradient(0, -w, 0, w);
  g.addColorStop(0, shade(base, -0.3));
  g.addColorStop(0.42, shade(base, 0.18));
  g.addColorStop(0.58, shade(base, 0.08));
  g.addColorStop(1, shade(base, -0.38));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = shade(base, -0.5);
  ctx.lineWidth = 0.05;
  ctx.stroke();
}

function drawTail(ctx: Ctx, base: string, x: number, span: number, chord: number) {
  ctx.beginPath();
  ctx.moveTo(x, -0.18);
  ctx.quadraticCurveTo(x + 0.05, -span * 0.85, x - chord * 0.35, -span);
  ctx.lineTo(x - chord, -span * 0.92);
  ctx.lineTo(x - chord, span * 0.92);
  ctx.lineTo(x - chord * 0.35, span);
  ctx.quadraticCurveTo(x + 0.05, span * 0.85, x, 0.18);
  ctx.closePath();
  const g = ctx.createLinearGradient(x, 0, x - chord, 0);
  g.addColorStop(0, shade(base, 0.12));
  g.addColorStop(1, shade(base, -0.2));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = shade(base, -0.5);
  ctx.lineWidth = 0.05;
  ctx.stroke();
  // elevator hinge line
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.moveTo(x - chord * 0.55, -span * 0.9);
  ctx.lineTo(x - chord * 0.55, span * 0.9);
  ctx.stroke();
  // fin + rudder seen edge-on
  ctx.fillStyle = shade(base, -0.25);
  ctx.beginPath();
  ctx.moveTo(x + chord * 0.6, -0.05);
  ctx.lineTo(x - chord * 1.08, -0.07);
  ctx.lineTo(x - chord * 1.08, 0.07);
  ctx.lineTo(x + chord * 0.6, 0.05);
  ctx.closePath();
  ctx.fill();
}

function glass(ctx: Ctx, path: () => void) {
  path();
  const g = ctx.createLinearGradient(0, -0.5, 0.3, 0.5);
  g.addColorStop(0, '#9fb7c4');
  g.addColorStop(0.45, '#3d5361');
  g.addColorStop(1, '#22313b');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,24,20,0.8)';
  ctx.lineWidth = 0.05;
  ctx.stroke();
}

// ------------------------------------------------------------------ national markings
function usStar(ctx: Ctx, x: number, y: number, r: number) {
  // white bars with blue outline, blue disc, white star
  ctx.fillStyle = '#1d2f5c';
  ctx.fillRect(x - r * 0.42, y - r * 1.9, r * 0.84, r * 3.8);
  ctx.fillStyle = '#e8e8e2';
  ctx.fillRect(x - r * 0.3, y - r * 1.78, r * 0.6, r * 3.56);
  ctx.fillStyle = '#1d2f5c';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  star(ctx, x, y, r * 0.92, '#ecece6', 0);
}

function star(ctx: Ctx, x: number, y: number, r: number, fill: string, rot = 0) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = rot + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.4 : r;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function balkenkreuz(ctx: Ctx, x: number, y: number, r: number) {
  const arm = r * 0.3;
  ctx.fillStyle = '#f0f0ea';
  ctx.fillRect(x - r, y - arm - r * 0.12, r * 2, (arm + r * 0.12) * 2);
  ctx.fillRect(x - arm - r * 0.12, y - r, (arm + r * 0.12) * 2, r * 2);
  ctx.fillStyle = '#151515';
  ctx.fillRect(x - r * 0.88, y - arm, r * 1.76, arm * 2);
  ctx.fillRect(x - arm, y - r * 0.88, arm * 2, r * 1.76);
}

function redStar(ctx: Ctx, x: number, y: number, r: number) {
  star(ctx, x, y, r * 1.12, '#f4f0e8', 0);
  star(ctx, x, y, r, '#b8231c', 0);
}

// ------------------------------------------------------------------ aircraft
function drawL4(ctx: Ctx) {
  const od = '#5d5c3c';
  // fuselage: cowling, cabin, tapering tail cone
  drawFuselage(ctx, od, [
    [3.05, 0.22],
    [2.85, 0.37],
    [2.2, 0.4],
    [1.0, 0.39],
    [-0.4, 0.32],
    [-2.6, 0.16],
    [-3.6, 0.08],
  ]);
  // engine cylinders sticking out of the cowling
  ctx.fillStyle = '#3a3a30';
  for (const sg of [-1, 1]) {
    ctx.fillRect(2.45, sg * 0.36 - 0.07, 0.42, 0.14);
    ctx.fillRect(2.45, sg * 0.36 + (sg > 0 ? 0.04 : -0.11), 0.42, 0.07);
  }
  // windshield ahead of the wing
  glass(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(1.55, -0.32);
    ctx.quadraticCurveTo(2.0, 0, 1.55, 0.32);
    ctx.lineTo(1.25, 0.3);
    ctx.lineTo(1.25, -0.3);
    ctx.closePath();
  });
  drawTail(ctx, od, -2.75, 1.5, 0.85);
  // high wing over the cabin
  drawWing(ctx, od, 1.32, 1.62, 5.35, 0.45, { ribs: 16, aileron: 0.42 });
  // skylight in the wing root
  glass(ctx, () => {
    ctx.beginPath();
    ctx.rect(0.15, -0.36, 0.85, 0.72);
  });
  usStar(ctx, 0.5, -3.6, 0.55);
  usStar(ctx, 0.5, 3.6, 0.55);
  // walkway / fuel cap
  ctx.fillStyle = 'rgba(20,20,16,0.6)';
  ctx.beginPath();
  ctx.arc(0.75, -1.4, 0.07, 0, Math.PI * 2);
  ctx.arc(0.75, 1.4, 0.07, 0, Math.PI * 2);
  ctx.fill();
}

function drawStorch(ctx: Ctx) {
  const dark = '#3f4a35';
  const light = '#56624a';
  drawFuselage(ctx, light, [
    [3.9, 0.3],
    [3.55, 0.44],
    [2.6, 0.5],
    [1.0, 0.5],
    [-1.0, 0.36],
    [-3.6, 0.15],
    [-5.0, 0.09],
  ]);
  // long greenhouse canopy reaching ahead of the wing
  glass(ctx, () => {
    ctx.beginPath();
    ctx.moveTo(2.55, -0.42);
    ctx.quadraticCurveTo(3.0, 0, 2.55, 0.42);
    ctx.lineTo(1.2, 0.46);
    ctx.lineTo(1.2, -0.46);
    ctx.closePath();
  });
  ctx.strokeStyle = 'rgba(25,28,22,0.85)';
  ctx.lineWidth = 0.05;
  for (const x of [1.6, 2.05]) {
    ctx.beginPath();
    ctx.moveTo(x, -0.46);
    ctx.lineTo(x, 0.46);
    ctx.stroke();
  }
  // engine exhausts
  ctx.fillStyle = '#2b2620';
  for (const sg of [-1, 1]) ctx.fillRect(3.0, sg * 0.46 - 0.05, 0.5, 0.1);
  drawTail(ctx, light, -3.9, 2.25, 1.05);
  drawWing(ctx, light, 1.35, 2.05, 7.12, 0.4, { ribs: 18, aileron: 0.55, flap: 0.5, slat: true });
  // splinter camouflage over the wing
  ctx.save();
  wingPath(ctx, 1.35, 2.05, 7.12, 0.4);
  ctx.clip();
  ctx.fillStyle = dark;
  ctx.globalAlpha = 0.85;
  const splinters: Array<Array<[number, number]>> = [
    [
      [1.4, -7.2],
      [1.4, -5.2],
      [-0.8, -3.4],
      [-0.8, -6.0],
    ],
    [
      [1.4, -3.0],
      [1.4, -0.9],
      [-0.8, 0.6],
      [-0.8, -1.8],
    ],
    [
      [1.4, 1.6],
      [1.4, 3.8],
      [-0.8, 5.0],
      [-0.8, 2.7],
    ],
    [
      [1.4, 5.6],
      [1.4, 7.2],
      [-0.8, 7.2],
      [-0.8, 6.6],
    ],
  ];
  for (const sp of splinters) {
    ctx.beginPath();
    ctx.moveTo(sp[0][0], sp[0][1]);
    for (const q of sp) ctx.lineTo(q[0], q[1]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // yellow theatre bands near the tips
  ctx.fillStyle = 'rgba(214,176,46,0.85)';
  ctx.fillRect(-0.72, -6.55, 2.1, 0.45);
  ctx.fillRect(-0.72, 6.1, 2.1, 0.45);
  ctx.restore();
  balkenkreuz(ctx, 0.35, -4.4, 0.75);
  balkenkreuz(ctx, 0.35, 4.4, 0.75);
}

function drawPo2(ctx: Ctx) {
  const green = '#4c5a37';
  drawFuselage(ctx, green, [
    [3.35, 0.3],
    [3.1, 0.48],
    [2.2, 0.47],
    [0.2, 0.42],
    [-1.6, 0.3],
    [-3.6, 0.13],
    [-4.7, 0.08],
  ]);
  // radial engine: five cylinders around the nose
  ctx.fillStyle = '#353530';
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    ctx.save();
    ctx.translate(3.0, 0);
    ctx.rotate(a);
    ctx.fillRect(0.1, -0.08, 0.42, 0.16);
    ctx.restore();
  }
  // lower wing (set back, mostly hidden under the upper one)
  drawWing(ctx, '#414d2f', 0.75, 1.5, 5.3, 0.35, { ribs: 14, aileron: 0 });
  drawTail(ctx, green, -3.65, 1.65, 0.95);
  // two open cockpits in tandem
  for (const x of [-0.75, -1.85]) {
    ctx.fillStyle = '#1d1e18';
    ctx.beginPath();
    ctx.ellipse(x, 0, 0.42, 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5a4732';
    ctx.beginPath();
    ctx.arc(x - 0.06, 0, 0.17, 0, Math.PI * 2);
    ctx.fill();
    glass(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(x + 0.62, -0.26);
      ctx.quadraticCurveTo(x + 0.8, 0, x + 0.62, 0.26);
      ctx.lineTo(x + 0.45, 0.22);
      ctx.lineTo(x + 0.45, -0.22);
      ctx.closePath();
    });
  }
  // upper wing with a cut-out over the front cockpit
  drawWing(ctx, green, 1.55, 1.62, 5.7, 0.4, { ribs: 16, aileron: 0.45 });
  ctx.fillStyle = '#26281f';
  ctx.beginPath();
  ctx.ellipse(-0.06, 0, 0.32, 0.45, 0, -Math.PI / 2, Math.PI / 2);
  ctx.fill();
  // interplane struts showing at the tips
  ctx.strokeStyle = '#2c2f24';
  ctx.lineWidth = 0.08;
  for (const sg of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0.9, sg * 3.9);
    ctx.lineTo(0.1, sg * 3.9);
    ctx.stroke();
  }
  redStar(ctx, 0.75, -4.3, 0.6);
  redStar(ctx, 0.75, 4.3, 0.6);
}

function drawBody(ctx: Ctx, kind: PlaneKind) {
  ctx.lineJoin = 'round';
  if (kind === 'storch') drawStorch(ctx);
  else if (kind === 'po2') drawPo2(ctx);
  else drawL4(ctx);
}

// ------------------------------------------------------------------ sprites
interface PlaneSprite {
  body: HTMLCanvasElement;
  shadow: HTMLCanvasElement;
  /** frame of the canvases in meters */
  x0: number;
  y0: number;
  w: number;
  h: number;
}

const cache = new Map<string, PlaneSprite>();

export function getPlaneSprite(kind: PlaneKind, scale: number): PlaneSprite {
  const key = `${kind}@${scale}`;
  let sp = cache.get(key);
  if (sp) return sp;
  const d = PLANES[kind];
  const x0 = -d.length / 2 - 1.6;
  const y0 = -d.span / 2 - 0.5;
  const w = d.length + 3.4;
  const h = d.span + 1;
  const body = makeCanvas(w * scale, h * scale);
  const g = body.getContext('2d')!;
  g.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
  drawBody(g, kind);
  // soft shadow: a silhouette rendered small and scaled back up blurs its edges
  const sh = makeCanvas(Math.max(8, w * scale * 0.25), Math.max(8, h * scale * 0.25));
  const sg = sh.getContext('2d')!;
  sg.drawImage(body, 0, 0, sh.width, sh.height);
  sg.globalCompositeOperation = 'source-in';
  sg.fillStyle = '#000';
  sg.fillRect(0, 0, sh.width, sh.height);
  sp = { body, shadow: sh, x0, y0, w, h };
  cache.set(key, sp);
  return sp;
}

/**
 * Draw a recon aircraft at the origin of the current transform (meters, +x along its heading).
 * `bank` rolls it (wings foreshortened), `prop` is the propeller angle.
 */
export function drawPlaneAt(ctx: Ctx, kind: PlaneKind, scale: number, bank: number, prop: number) {
  const sp = getPlaneSprite(kind, scale);
  const d = PLANES[kind];
  const cb = Math.cos(bank);
  ctx.save();
  ctx.scale(1, cb);
  ctx.drawImage(sp.body, sp.x0, sp.y0, sp.w, sp.h);
  // propeller: a blur disc seen edge-on and two flickering blades
  const R = d.prop;
  ctx.fillStyle = 'rgba(30,30,28,0.22)';
  ctx.beginPath();
  ctx.ellipse(d.nose + 0.08, 0, 0.11, R, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(25,25,22,0.75)';
  ctx.lineWidth = 0.09;
  ctx.lineCap = 'round';
  for (const off of [0, Math.PI / 2]) {
    const l = R * Math.cos(prop + off);
    ctx.beginPath();
    ctx.moveTo(d.nose + 0.08, -l);
    ctx.lineTo(d.nose + 0.08, l);
    ctx.stroke();
  }
  ctx.fillStyle = '#2a2a24';
  ctx.beginPath();
  ctx.ellipse(d.nose + 0.02, 0, 0.16, 0.13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The aircraft's soft shadow (call with the transform at the shadow's ground position). */
export function drawPlaneShadow(ctx: Ctx, kind: PlaneKind, scale: number, bank: number, alpha: number) {
  const sp = getPlaneSprite(kind, scale);
  ctx.save();
  ctx.scale(1, Math.cos(bank));
  ctx.globalAlpha = alpha;
  ctx.drawImage(sp.shadow, sp.x0, sp.y0, sp.w, sp.h);
  ctx.restore();
}
