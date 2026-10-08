// Crew carrier (half-track) drawing, in world units (metres), plus the replacement crew walking over.

import type { V2 } from '../core/math';
import { CARRIER, type Carrier, carrierTailgate } from '../game/carrier';

type Ctx = CanvasRenderingContext2D;

const PAL: Record<string, [string, string, string]> = {
  usa: ['#5a5d3b', '#40432a', '#6f734a'],
  germany: ['#988c5c', '#6f6643', '#b1a46f'],
  ussr: ['#4f5c36', '#394327', '#66733f'],
};

export function drawCarrier(ctx: Ctx, c: Carrier, shadow: V2) {
  const L = CARRIER.L;
  const W = CARRIER.W;
  const dead = c.state === 'dead';
  const [body, dark, light] = dead ? ['#2c2a26', '#1c1b18', '#3a3732'] : PAL[c.nation] ?? PAL.usa;
  ctx.save();
  // shadow (world-space offset)
  ctx.save();
  ctx.translate(c.pos.x + shadow.x * 1.3, c.pos.y + shadow.y * 1.3);
  ctx.rotate(c.ang);
  ctx.fillStyle = 'rgba(0,0,0,0.33)';
  ctx.beginPath();
  ctx.roundRect(-L / 2, -W / 2, L, W, 0.4);
  ctx.fill();
  ctx.restore();

  ctx.translate(c.pos.x, c.pos.y);
  ctx.rotate(c.ang);
  // rear tracks + front wheels
  ctx.fillStyle = '#26251f';
  ctx.fillRect(-L / 2 + 0.1, -W / 2 - 0.05, L * 0.52, 0.5);
  ctx.fillRect(-L / 2 + 0.1, W / 2 - 0.45, L * 0.52, 0.5);
  ctx.fillRect(L * 0.22, -W / 2 - 0.08, 0.85, 0.42);
  ctx.fillRect(L * 0.22, W / 2 - 0.34, 0.85, 0.42);
  // track links
  ctx.strokeStyle = 'rgba(90,86,74,0.6)';
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  for (let x = -L / 2 + 0.25; x < -L / 2 + 0.1 + L * 0.52; x += 0.28) {
    ctx.moveTo(x, -W / 2 - 0.05);
    ctx.lineTo(x, -W / 2 + 0.45);
    ctx.moveTo(x, W / 2 - 0.45);
    ctx.lineTo(x, W / 2 + 0.05);
  }
  ctx.stroke();
  // troop compartment (open top)
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.roundRect(-L / 2 + 0.05, -W / 2 + 0.15, L * 0.62, W - 0.3, 0.15);
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.fillRect(-L / 2 + 0.3, -W / 2 + 0.38, L * 0.55, W - 0.76);
  // benches
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(-L / 2 + 0.35, -W / 2 + 0.42, L * 0.5, 0.22);
  ctx.fillRect(-L / 2 + 0.35, W / 2 - 0.64, L * 0.5, 0.22);
  // the replacement crew: helmets
  if (!dead) {
    for (let i = 0; i < 4; i++) {
      const x = -L / 2 + 0.7 + i * 0.62;
      for (const y of [-0.42, 0.42]) {
        if (c.state === 'leave' && i > 0) continue; // they got out
        ctx.fillStyle = '#3b3f2a';
        ctx.beginPath();
        ctx.arc(x, y, 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,230,0.18)';
        ctx.beginPath();
        ctx.arc(x - 0.05, y - 0.05, 0.08, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // armoured cab and bonnet
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.roundRect(L * 0.12 - 0.15, -W / 2 + 0.2, L * 0.38, W - 0.4, 0.3);
  ctx.fill();
  ctx.fillStyle = body;
  ctx.fillRect(L * 0.06 - 0.2, -W / 2 + 0.12, 0.55, W - 0.24);
  // visor slits / radiator grille
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(L * 0.06 + 0.12, -W / 2 + 0.35, 0.1, W - 0.7);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  for (let y = -W / 2 + 0.45; y < W / 2 - 0.4; y += 0.22) {
    ctx.moveTo(L / 2 - 0.45, y);
    ctx.lineTo(L / 2 - 0.2, y);
  }
  ctx.stroke();
  // front roller
  ctx.fillStyle = '#2a2924';
  ctx.fillRect(L / 2 - 0.15, -0.55, 0.3, 1.1);
  ctx.strokeStyle = 'rgba(10,10,8,0.65)';
  ctx.lineWidth = 0.08;
  ctx.beginPath();
  ctx.roundRect(-L / 2 + 0.05, -W / 2 + 0.15, L - 0.2, W - 0.3, 0.2);
  ctx.stroke();
  // red cross / white band so it reads as the support vehicle
  if (!dead) {
    ctx.fillStyle = 'rgba(235,235,225,0.85)';
    ctx.fillRect(-L / 2 + 0.05, -0.12, 0.25, 0.24);
  }
  ctx.restore();
}

/** Replacement crew trotting between the carrier and the tank while parked. */
export function drawCrewWalk(ctx: Ctx, c: Carrier, tankPos: V2, time: number) {
  const a = carrierTailgate(c);
  const n = 3;
  for (let i = 0; i < n; i++) {
    const ph = (time * 0.55 + i / n) % 1;
    const k = ph < 0.5 ? ph * 2 : 2 - ph * 2; // there and back
    const side = (i - 1) * 0.6;
    const dx = tankPos.x - a.x;
    const dy = tankPos.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l;
    const ny = dx / l;
    const x = a.x + dx * k * 0.82 + nx * side;
    const y = a.y + dy * k * 0.82 + ny * side;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.arc(x - 0.18, y + 0.24, 0.4, 0, Math.PI * 2);
    ctx.fill();
    // shoulders + helmet
    ctx.fillStyle = '#4f5438';
    ctx.beginPath();
    ctx.ellipse(x, y, 0.42, 0.3, Math.atan2(dy, dx) + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#353826';
    ctx.beginPath();
    ctx.arc(x, y, 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,230,0.2)';
    ctx.beginPath();
    ctx.arc(x - 0.06, y - 0.07, 0.09, 0, Math.PI * 2);
    ctx.fill();
  }
}
