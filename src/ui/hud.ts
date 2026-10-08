// Battle HUD & touch controls (mobile landscape).

import { type V2, DEG, angDiff, clamp, dist, formatNum } from '../core/math';
import { audio } from '../core/audio';
import type { Battle, BattleEvent } from '../game/battle';
import { TICKETS } from '../game/battle';
import type { Tank } from '../game/tank';
import { TEAM_COL, predColor, type BattleRenderer } from '../render/battleRender';
import { drawXray, drawTankSprite, makeCanvas } from '../render/tankRender';
import { t as tr } from './i18n';
import { drawHitCam, hitTitle, roundRect, type HitCamEntry } from './hitcam';

type Ctx = CanvasRenderingContext2D;

interface Stick {
  id: number;
  base: V2;
  pos: V2;
  start: number;
  moved: boolean;
}

interface Btn {
  id: string;
  x: number;
  y: number;
  r?: number;
  w?: number;
  h?: number;
}

interface Feed {
  text: string;
  killerFriend: boolean;
  t: number;
}

interface Notice {
  text: string;
  color: string;
  t: number;
}

export class Hud {
  b: Battle;
  r: BattleRenderer;
  canvas: HTMLCanvasElement;
  move: Stick | null = null;
  aim: Stick | null = null;
  buttons: Btn[] = [];
  private pressed = new Map<number, string>();
  feed: Feed[] = [];
  notices: Notice[] = [];
  hitcams: HitCamEntry[] = [];
  reverseMode = false;
  trackTarget: Tank | null = null;
  aimAssistTarget: Tank | null = null;
  deathInfo: { killer: Tank | null; res: HitCamEntry | null; t: number } | null = null;
  /** test hook: when set, replaces touch movement input */
  autoInput: ((p: Tank) => void) | null = null;
  onPause: () => void = () => {};
  onLeave: () => void = () => {};
  safe = { l: 0, r: 0, t: 0, b: 0 };
  private minimapBg: HTMLCanvasElement | null = null;
  /** seconds left for the first-battle controls hint */
  tutorial = 0;
  /** incoming fire direction markers */
  private incoming: Array<{ ang: number; t: number; pen: boolean }> = [];
  private fireFlash = 0;

  constructor(b: Battle, r: BattleRenderer, canvas: HTMLCanvasElement) {
    this.b = b;
    this.r = r;
    this.canvas = canvas;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
    this.readSafe();
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onUp);
  }

  readSafe() {
    const cs = getComputedStyle(document.documentElement);
    const n = (v: string) => parseFloat(cs.getPropertyValue(v)) || 0;
    this.safe = { l: n('--sal'), r: n('--sar'), t: n('--sat'), b: n('--sab') };
  }

  // ------------------------------------------------------------------ layout
  private layout() {
    const W = this.r.W;
    const H = this.r.H;
    const s = this.safe;
    const fr = clamp(H * 0.115, 34, 46);
    const fx = W - s.r - fr - 18;
    const fy = H - s.b - fr - 16;
    const btns: Btn[] = [{ id: 'fire', x: fx, y: fy, r: fr }];
    const p = this.b.player;
    if (p && p.alive) {
      const n = p.spec.gun.shells.length;
      const bw = 54;
      const bh = 30;
      for (let i = 0; i < n; i++) {
        btns.push({ id: `ammo${i}`, x: fx - fr - 8 - (n - i) * (bw + 6) + 6, y: fy + fr - bh, w: bw, h: bh });
      }
      if (p.burning > 0) btns.push({ id: 'ext', x: fx - fr * 0.2, y: fy - fr - 44, r: 24 });
    }
    btns.push({ id: 'pause', x: W - s.r - 30, y: s.t + 26, r: 18 });
    btns.push({ id: 'zoom', x: W - s.r - 74, y: s.t + 26, r: 18 });
    if (this.b.state === 'dead') {
      const av = this.b.availableLineup();
      const cw = 150;
      const total = av.length * (cw + 12) - 12;
      av.forEach((v, i) => btns.push({ id: `spawn:${v.id}`, x: W / 2 - total / 2 + i * (cw + 12), y: H - s.b - 120, w: cw, h: 96 }));
      btns.push({ id: 'leave', x: W - s.r - 150, y: H - s.b - 44, w: 136, h: 30 });
    }
    this.buttons = btns;
  }

  private hitButton(x: number, y: number): Btn | null {
    for (const b of this.buttons) {
      if (b.r !== undefined) {
        if (Math.hypot(x - b.x, y - b.y) <= b.r + 8) return b;
      } else if (x >= b.x - 4 && x <= b.x + b.w! + 4 && y >= b.y - 4 && y <= b.y + b.h! + 4) return b;
    }
    return null;
  }

  // ------------------------------------------------------------------ input
  private pt(e: PointerEvent): V2 {
    const rc = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rc.left, y: e.clientY - rc.top };
  }

  private onDown = (e: PointerEvent) => {
    e.preventDefault();
    audio.unlock();
    const p = this.pt(e);
    this.layout();
    const btn = this.hitButton(p.x, p.y);
    if (btn) {
      this.pressed.set(e.pointerId, btn.id);
      this.press(btn.id);
      return;
    }
    if (this.b.state !== 'playing' || !this.b.player?.alive) return;
    const W = this.r.W;
    if (p.x < W * 0.45 && !this.move) {
      const R = this.stickR();
      const base = { x: clamp(p.x, R + 8 + this.safe.l, W * 0.45), y: clamp(p.y, R + 60, this.r.H - R - 8) };
      this.move = { id: e.pointerId, base, pos: p, start: performance.now(), moved: false };
    } else if (p.x >= W * 0.45 && !this.aim) {
      this.aim = { id: e.pointerId, base: p, pos: p, start: performance.now(), moved: false };
    }
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  private onMove = (e: PointerEvent) => {
    const p = this.pt(e);
    if (this.move && e.pointerId === this.move.id) {
      this.move.pos = p;
      if (dist(p, this.move.base) > 6) this.move.moved = true;
    } else if (this.aim && e.pointerId === this.aim.id) {
      this.aim.pos = p;
      if (dist(p, this.aim.base) > 14) {
        this.aim.moved = true;
        this.trackTarget = null;
      }
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.pressed.has(e.pointerId)) {
      this.pressed.delete(e.pointerId);
      return;
    }
    if (this.move && e.pointerId === this.move.id) {
      this.move = null;
    } else if (this.aim && e.pointerId === this.aim.id) {
      const a = this.aim;
      this.aim = null;
      const quick = performance.now() - a.start < 260 && !a.moved;
      const d = dist(a.pos, a.base);
      if (quick) this.fire();
      else if (a.moved && d > this.stickR() * 0.3) {
        this.trackTarget = this.aimAssistTarget;
        this.fire();
      }
    }
  };

  private press(id: string) {
    const b = this.b;
    const p = b.player;
    audio.click();
    if (id === 'fire') this.fire();
    else if (id.startsWith('ammo') && p) p.selectShell(parseInt(id.slice(4), 10));
    else if (id === 'ext' && p) b.extinguish(p);
    else if (id === 'zoom') this.r.zoomOut = !this.r.zoomOut;
    else if (id === 'pause') this.onPause();
    else if (id.startsWith('spawn:')) {
      if (b.time - b.deadAt > 2.5) {
        b.respawnPlayer(id.slice(6));
        this.deathInfo = null;
        this.trackTarget = null;
      }
    } else if (id === 'leave') this.onLeave();
  }

  private fire() {
    const p = this.b.player;
    if (!p || !p.alive) return;
    if (p.isReloaded() && p.canFire()) {
      this.b.playerFire();
      this.fireFlash = 0.15;
      this.r.shake = Math.min(1, 0.4 + p.spec.gun.caliber / 200);
    }
  }

  private stickR() {
    return clamp(this.r.H * 0.16, 46, 70);
  }

  // ------------------------------------------------------------------ per-frame control
  update(dt: number) {
    const b = this.b;
    const p = b.player;
    for (const n of this.notices) n.t += dt;
    this.notices = this.notices.filter((n) => n.t < 2.6);
    for (const f of this.feed) f.t += dt;
    this.feed = this.feed.filter((f) => f.t < 7);
    for (const h of this.hitcams) h.t += dt;
    for (const i of this.incoming) i.t += dt;
    this.incoming = this.incoming.filter((i) => i.t < 2.2);
    this.hitcams = this.hitcams.filter((h) => h.t < h.life);
    this.fireFlash = Math.max(0, this.fireFlash - dt);
    if (this.deathInfo) this.deathInfo.t += dt;
    if (this.tutorial > 0) this.tutorial -= dt;

    if (!p || !p.alive) {
      this.move = null;
      this.aim = null;
      return;
    }
    // movement
    if (this.autoInput) {
      this.autoInput(p);
      return;
    }
    if (this.move) {
      const R = this.stickR();
      const v = { x: this.move.pos.x - this.move.base.x, y: this.move.pos.y - this.move.base.y };
      const m = clamp(Math.hypot(v.x, v.y) / R, 0, 1);
      if (m < 0.12) {
        p.throttle = 0;
        p.steer = 0;
      } else {
        const want = Math.atan2(v.y, v.x);
        const diff = angDiff(p.ang, want);
        const ad = Math.abs(diff);
        if (!this.reverseMode && ad > 115 * DEG) this.reverseMode = true;
        else if (this.reverseMode && ad < 75 * DEG) this.reverseMode = false;
        if (!this.reverseMode) {
          p.throttle = m * (ad < 55 * DEG ? 1 : ad < 90 * DEG ? 0.45 : 0.15);
          p.steer = clamp(diff * 2.2, -1, 1);
        } else {
          const dr = angDiff(p.ang + Math.PI, want);
          p.throttle = -m * (Math.abs(dr) < 55 * DEG ? 1 : 0.4);
          p.steer = clamp(dr * 2.2, -1, 1);
          if (p.spec.look.wheels) p.steer = -p.steer;
        }
        if (p.spec.look.wheels && !this.reverseMode && Math.abs(p.speed) < 1) p.throttle = Math.max(p.throttle, 0.5 * m);
      }
    } else {
      p.throttle = 0;
      p.steer = 0;
      // casemates: rotate hull toward aim when outside the gun arc
      if (p.bp.casemate) {
        const arc = (p.spec.gunArc ?? 10) * DEG;
        const d = angDiff(p.ang, p.aimAngle);
        if (Math.abs(d) > arc * 0.95) p.steer = clamp(d * 2, -1, 1);
      }
    }
    // aiming
    const tp = p.turretPos();
    this.aimAssistTarget = null;
    if (this.aim && this.aim.moved) {
      const v = { x: this.aim.pos.x - this.aim.base.x, y: this.aim.pos.y - this.aim.base.y };
      let a = Math.atan2(v.y, v.x);
      // light aim assist toward spotted enemies near the stick direction
      let best: Tank | null = null;
      let bestD = 3.2 * DEG;
      for (const e of b.tanks) {
        if (!e.alive || e.team === p.team || !b.isSpotted(p.team, e)) continue;
        const ba = Math.atan2(e.pos.y - tp.y, e.pos.x - tp.x);
        const d = Math.abs(angDiff(a, ba));
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      if (best) {
        const ba = this.leadAngle(p, best);
        a = ba + angDiff(ba, a) * 0.35;
        this.aimAssistTarget = best;
      }
      p.aimAngle = a;
    } else if (this.trackTarget) {
      const e = this.trackTarget;
      if (!e.alive || !b.isSpotted(p.team, e)) this.trackTarget = null;
      else p.aimAngle = this.leadAngle(p, e);
    }
    audio.engineSet(Math.min(1, Math.abs(p.speed) / p.maxSpeed() + Math.abs(p.throttle) * 0.3), p.alive);
  }

  private leadAngle(p: Tank, e: Tank): number {
    const tp = p.turretPos();
    const d = dist(tp, e.pos);
    const v = p.spec.gun.shells[p.shellIdx].velocity * this.b.shellSpeedScale;
    const tof = d / v;
    const x = e.pos.x + Math.cos(e.ang) * e.speed * tof;
    const y = e.pos.y + Math.sin(e.ang) * e.speed * tof;
    return Math.atan2(y - tp.y, x - tp.x);
  }

  // ------------------------------------------------------------------ events
  handle(ev: BattleEvent) {
    const b = this.b;
    switch (ev.type) {
      case 'hit': {
        const involvesPlayer = ev.shooter.isPlayer || ev.target.isPlayer;
        if (ev.shooter.isPlayer && ev.target.team !== ev.shooter.team) {
          const { title, color } = hitTitle(ev.res, ev.res.killed);
          this.hitcams = [{ res: ev.res, target: ev.target, shooter: ev.shooter, t: 0, life: 3.2, title, color }];
          const label = ev.res.outcome === 'ricochet' ? tr('Ricochet') : ev.res.outcome === 'nonpen' ? tr('Non-penetration') : null;
          if (label) this.r.addPopup(label, ev.res.world.x, ev.res.world.y, ev.res.outcome === 'ricochet' ? '#f2c94c' : '#c8c8c0', false);
        }
        if (ev.target.isPlayer && ev.res.damage > 0) this.r.shake = Math.min(1.2, this.r.shake + 0.6);
        if (ev.target.isPlayer && ev.shooter !== ev.target) {
          const tp = ev.target.pos;
          this.incoming.push({ ang: Math.atan2(ev.shooter.pos.y - tp.y, ev.shooter.pos.x - tp.x), t: 0, pen: ev.res.outcome === 'pen' });
          if (this.incoming.length > 4) this.incoming.shift();
        }
        void involvesPlayer;
        break;
      }
      case 'popup':
        this.r.addPopup(ev.text.replace('Target destroyed', tr('Target destroyed')).replace('Critical hit', tr('Critical hit')).replace('Assist', tr('Assist')).replace('Point captured', tr('Point captured')).replace(/^Hit/, tr('Hit')), ev.x, ev.y, ev.color, !!ev.big);
        break;
      case 'feed': {
        const k = ev.killer;
        const kn = k ? `${k.isPlayer ? '★ ' : ''}${k.spec.name}` : '';
        const icon = ev.how === 'cookoff' ? ' ✸ ' : ' ▸ ';
        const text = k ? `${kn}${icon}${ev.victim.spec.name}` : `${ev.victim.spec.name} ✸`;
        this.feed.unshift({ text, killerFriend: k ? k.team === b.playerTeam : ev.victim.team !== b.playerTeam, t: 0 });
        this.feed = this.feed.slice(0, 5);
        break;
      }
      case 'notice':
        this.notices.unshift({ text: tr(ev.text), color: ev.color ?? '#ffd27a', t: 0 });
        this.notices = this.notices.slice(0, 3);
        break;
      case 'captured':
        this.notices.unshift({ text: ev.team === b.playerTeam ? tr('Point A captured') : tr('Point A lost'), color: ev.team === b.playerTeam ? TEAM_COL.friend : TEAM_COL.enemy, t: 0 });
        break;
      case 'playerDead': {
        let entry: HitCamEntry | null = null;
        if (ev.res && b.player) {
          const title = ev.res.cookoff ? 'COOK-OFF' : tr('KNOCKED OUT');
          const color = '#e8473b';
          entry = { res: ev.res, target: b.player, shooter: ev.killer ?? b.player, t: 1.0, life: 9999, title, color };
        }
        this.deathInfo = { killer: ev.killer, res: entry, t: 0 };
        this.trackTarget = null;
        break;
      }
    }
  }

  // ------------------------------------------------------------------ drawing
  draw(ctx: Ctx) {
    const r = this.r;
    const b = this.b;
    const W = r.W;
    const H = r.H;
    const s = this.safe;
    ctx.save();
    ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    ctx.textBaseline = 'middle';
    this.layout();

    this.drawScore(ctx, W, s);
    this.drawMinimap(ctx, s);
    const p = b.player;
    if (p && p.alive) this.drawDamage(ctx, p, s);
    this.drawFeed(ctx, W, s);
    this.drawNotices(ctx, W, s);
    if (this.hitcams.length && b.state === 'playing') {
      const hw = clamp(W * 0.32, 230, 320);
      const hh = clamp(H * 0.44, 140, 200);
      drawHitCam(ctx, this.hitcams[0], W - s.r - hw - 10, s.t + 54 + this.feed.length * 17, hw, hh);
    }

    if (p && p.alive && b.state === 'playing') {
      this.drawIncoming(ctx, p);
      this.drawPenInfo(ctx, W, H);
      this.drawSticks(ctx);
      this.drawButtons(ctx, p);
    } else {
      for (const bt of this.buttons) if (bt.id === 'pause' || bt.id === 'zoom') this.drawRoundBtn(ctx, bt, bt.id === 'pause' ? 'II' : '⌕', false);
    }
    if (b.state === 'dead') this.drawDeath(ctx, W, H, s);
    if (b.time < 4.5 && b.state === 'playing') this.drawBanner(ctx, W, H, tr('DOMINATION'), tr('Capture and hold point A'), '#f2b449', b.time < 0.4 ? b.time / 0.4 : b.time > 3.7 ? (4.5 - b.time) / 0.8 : 1);
    if (b.state === 'ended') {
      const win = b.result === 'victory';
      this.drawBanner(ctx, W, H, tr(win ? 'VICTORY' : 'DEFEAT'), win ? tr('The enemy has been defeated') : tr('Your team has been defeated'), win ? '#f2b449' : '#e8473b', 1);
    }
    if (this.tutorial > 0 && b.state === 'playing') this.drawTutorial(ctx, W, H);
    ctx.restore();
  }

  private drawScore(ctx: Ctx, W: number, s: typeof this.safe) {
    const b = this.b;
    const pt = b.playerTeam;
    const et = pt === 0 ? 1 : 0;
    const cx = W / 2;
    const y = s.t + 16;
    const bw = clamp(W * 0.16, 90, 150);
    // ticket bars
    const own = b.tickets[pt] / TICKETS;
    const enemy = b.tickets[et] / TICKETS;
    ctx.fillStyle = 'rgba(10,12,12,0.55)';
    roundRect(ctx, cx - bw - 30, y - 8, bw, 16, 3);
    ctx.fill();
    roundRect(ctx, cx + 30, y - 8, bw, 16, 3);
    ctx.fill();
    ctx.fillStyle = TEAM_COL.friend;
    roundRect(ctx, cx - 30 - bw * own, y - 6, bw * own - 2, 12, 2);
    ctx.fill();
    ctx.fillStyle = TEAM_COL.enemy;
    roundRect(ctx, cx + 32, y - 6, Math.max(0, bw * enemy - 2), 12, 2);
    ctx.fill();
    ctx.font = '700 12px "Barlow Condensed", sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.ceil(b.tickets[pt])), cx - 36, y + 0.5);
    ctx.textAlign = 'left';
    ctx.fillText(String(Math.ceil(b.tickets[et])), cx + 36, y + 0.5);
    // capture icon
    const cap = b.capture;
    const col = cap.owner === -1 ? TEAM_COL.neutral : cap.owner === pt ? TEAM_COL.friend : TEAM_COL.enemy;
    ctx.fillStyle = 'rgba(10,12,12,0.7)';
    ctx.beginPath();
    ctx.arc(cx, y + 2, 17, 0, Math.PI * 2);
    ctx.fill();
    const prog = pt === 0 ? cap.progress : -cap.progress;
    if (Math.abs(prog) > 0.001) {
      ctx.strokeStyle = prog > 0 ? TEAM_COL.friend : TEAM_COL.enemy;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(cx, y + 2, 15, -Math.PI / 2, -Math.PI / 2 + Math.abs(prog) * Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, y + 2, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.font = '700 15px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('A', cx, y + 3);
    if (cap.contested) {
      ctx.fillStyle = '#ffd27a';
      ctx.font = '600 10px "Barlow Condensed", sans-serif';
      ctx.fillText(tr('CONTESTED'), cx, y + 27);
    }
    // alive counters
    const aliveOwn = b.tanks.filter((t) => t.alive && t.team === pt).length;
    const aliveEn = b.tanks.filter((t) => t.alive && t.team === et).length;
    ctx.font = '600 11px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(160,200,255,0.95)';
    ctx.fillText(`${aliveOwn} ▮  +${b.reinforcements[pt]}`, cx - 36, y + 18);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,170,160,0.95)';
    ctx.fillText(`+${b.reinforcements[et]}  ▮ ${aliveEn}`, cx + 36, y + 18);
    // timer
    const left = Math.max(0, 12 * 60 - b.time);
    const mm = Math.floor(left / 60);
    const ss = Math.floor(left % 60);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(230,230,220,0.75)';
    ctx.font = '600 10px "Barlow Condensed", sans-serif';
    if (!cap.contested) ctx.fillText(`${mm}:${ss.toString().padStart(2, '0')}`, cx, y + 27);
  }

  private drawMinimap(ctx: Ctx, s: typeof this.safe) {
    const b = this.b;
    const size = clamp(this.r.H * 0.3, 96, 128);
    const x = s.l + 10;
    const y = s.t + 10;
    const sc = size / b.map.size;
    if (!this.minimapBg) {
      const c = makeCanvas(size * 2, size * 2);
      const g = c.getContext('2d')!;
      g.scale((size * 2) / b.map.size, (size * 2) / b.map.size);
      const th = b.map.theme;
      g.fillStyle = th === 'grass' ? '#3d4a2e' : th === 'desert' ? '#8e7c5a' : '#47443f';
      g.fillRect(0, 0, b.map.size, b.map.size);
      for (const f of b.map.fields) {
        g.fillStyle = 'rgba(120,120,70,0.35)';
        g.beginPath();
        g.moveTo(f.poly[0].x, f.poly[0].y);
        for (const p of f.poly) g.lineTo(p.x, p.y);
        g.fill();
      }
      for (const r of b.map.roads) {
        g.strokeStyle = r.kind === 'asphalt' ? '#2e2f30' : 'rgba(150,130,90,0.8)';
        g.lineWidth = r.w;
        g.beginPath();
        g.moveTo(r.pts[0].x, r.pts[0].y);
        for (const p of r.pts) g.lineTo(p.x, p.y);
        g.stroke();
      }
      g.fillStyle = 'rgba(30,45,25,0.8)';
      for (const t of b.map.trees) {
        g.beginPath();
        g.arc(t.x, t.y, t.r, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = '#9a9184';
      for (const bd of b.map.buildings) {
        g.beginPath();
        g.moveTo(bd.poly[0].x, bd.poly[0].y);
        for (const p of bd.poly) g.lineTo(p.x, p.y);
        g.fill();
      }
      g.fillStyle = '#6d665a';
      for (const rk of b.map.rocks) {
        g.beginPath();
        g.arc(rk.x, rk.y, rk.r, 0, Math.PI * 2);
        g.fill();
      }
      this.minimapBg = c;
    }
    ctx.save();
    ctx.globalAlpha = 0.92;
    roundRect(ctx, x - 2, y - 2, size + 4, size + 4, 5);
    ctx.fillStyle = 'rgba(10,12,10,0.6)';
    ctx.fill();
    ctx.drawImage(this.minimapBg, x, y, size, size);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.rect(x, y, size, size);
    ctx.clip();
    // view rect
    const r = this.r;
    const vw = (r.W / r.zoom) * sc;
    const vh = (r.H / r.zoom) * sc;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + r.cam.x * sc - vw / 2, y + r.cam.y * sc - vh / 2, vw, vh);
    // capture
    const c = b.map.capture;
    const cap = b.capture;
    ctx.strokeStyle = cap.owner === -1 ? TEAM_COL.neutral : cap.owner === b.playerTeam ? TEAM_COL.friend : TEAM_COL.enemy;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x + c.x * sc, y + c.y * sc, Math.max(4, c.r * sc), 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = '700 9px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = ctx.strokeStyle as string;
    ctx.fillText('A', x + c.x * sc, y + c.y * sc + 0.5);
    // tanks
    for (const t of b.tanks) {
      if (!t.alive) continue;
      const friend = t.team === b.playerTeam;
      if (!friend && !b.isSpotted(b.playerTeam, t)) continue;
      const px = x + t.pos.x * sc;
      const py = y + t.pos.y * sc;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(t.ang);
      ctx.fillStyle = t.isPlayer ? '#ffffff' : friend ? TEAM_COL.friend : TEAM_COL.enemy;
      ctx.beginPath();
      ctx.moveTo(4.5, 0);
      ctx.lineTo(-3, -3);
      ctx.lineTo(-3, 3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // player vision cone
    const p = b.player;
    if (p && p.alive) {
      const vc = p.visionCone();
      const tp = p.turretPos();
      ctx.fillStyle = 'rgba(255,255,230,0.12)';
      ctx.beginPath();
      ctx.moveTo(x + tp.x * sc, y + tp.y * sc);
      ctx.arc(x + tp.x * sc, y + tp.y * sc, vc.range * sc, p.gunWorldAng - vc.half, p.gunWorldAng + vc.half);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawDamage(ctx: Ctx, p: Tank, s: typeof this.safe) {
    const size = clamp(this.r.H * 0.3, 96, 128);
    const x = s.l + 10;
    const y = s.t + 10 + size + 10;
    const w = size;
    const h = clamp(this.r.H * 0.25, 78, 104);
    ctx.save();
    ctx.fillStyle = 'rgba(10,12,10,0.55)';
    roundRect(ctx, x - 2, y - 2, w + 4, h + 4, 5);
    ctx.fill();
    const spec = p.spec;
    const sc = Math.min((h - 16) / spec.look.L, (w * 0.62) / (spec.look.W + 0.6)) * 0.95;
    ctx.save();
    ctx.translate(x + w * 0.36, y + h / 2 + 2);
    ctx.scale(sc, sc);
    ctx.rotate(-Math.PI / 2);
    const states: Record<string, 'ok' | 'damaged' | 'destroyed'> = {};
    for (const m of p.mods) states[m.def.id] = p.modState(m);
    drawXray(ctx, spec, { style: 'gray', states, turretRel: p.turretRel, gunRel: p.gunRel, labels: false });
    ctx.restore();
    // right column: speed, fire, repairs
    ctx.textAlign = 'left';
    ctx.font = '700 13px "Barlow Condensed", sans-serif';
    ctx.fillStyle = '#eee';
    const kmh = Math.round(Math.abs(p.speed) * 3.6);
    ctx.fillText(`${kmh}`, x + w * 0.7, y + 14);
    ctx.font = '500 9px "Barlow Condensed", sans-serif';
    ctx.fillStyle = 'rgba(220,220,210,0.7)';
    ctx.fillText('km/h', x + w * 0.7, y + 26);
    let yy = y + 42;
    if (p.burning > 0) {
      ctx.fillStyle = '#ff7b4a';
      ctx.font = '700 10px "Barlow Condensed", sans-serif';
      ctx.fillText(tr('BURNING'), x + w * 0.7, yy);
      yy += 13;
    }
    const rep = p.mods.find((m) => m.repair > 0);
    if (rep) {
      ctx.fillStyle = '#ffd27a';
      ctx.font = '600 10px "Barlow Condensed", sans-serif';
      ctx.fillText(`🔧 ${Math.ceil(rep.repair)}s`, x + w * 0.7, yy);
      yy += 13;
    }
    const enemyTeam = p.team === 0 ? 1 : 0;
    if (this.b.isSpotted(enemyTeam, p)) {
      ctx.fillStyle = '#ff6b5a';
      ctx.font = '700 10px "Barlow Condensed", sans-serif';
      ctx.fillText(`👁 ${tr('SPOTTED')}`, x + w * 0.7, yy);
      yy += 13;
    }
    if (p.pendingSwapRole) {
      ctx.fillStyle = '#9fd3ff';
      ctx.font = '600 10px "Barlow Condensed", sans-serif';
      ctx.fillText(`⇄ ${Math.ceil(p.crewSwap)}s`, x + w * 0.7, yy);
    }
    ctx.restore();
  }

  private drawFeed(ctx: Ctx, W: number, s: typeof this.safe) {
    ctx.save();
    ctx.textAlign = 'right';
    ctx.font = '600 11px "Barlow Condensed", sans-serif';
    let y = s.t + 56;
    for (const f of this.feed) {
      const a = f.t > 6 ? 7 - f.t : 1;
      ctx.globalAlpha = a;
      const tw = ctx.measureText(f.text).width;
      ctx.fillStyle = 'rgba(10,12,10,0.5)';
      roundRect(ctx, W - s.r - 14 - tw - 8, y - 8, tw + 12, 16, 3);
      ctx.fill();
      ctx.fillStyle = f.killerFriend ? '#a9cbff' : '#ffb2a8';
      ctx.fillText(f.text, W - s.r - 16, y);
      y += 17;
    }
    ctx.restore();
  }

  private drawNotices(ctx: Ctx, W: number, s: typeof this.safe) {
    ctx.save();
    ctx.textAlign = 'center';
    let y = s.t + 62;
    for (const n of this.notices) {
      const a = n.t < 0.15 ? n.t / 0.15 : n.t > 2.1 ? (2.6 - n.t) / 0.5 : 1;
      ctx.globalAlpha = Math.max(0, a);
      ctx.font = '700 14px "Barlow Condensed", sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(n.text, W / 2, y);
      ctx.fillStyle = n.color;
      ctx.fillText(n.text, W / 2, y);
      y += 18;
    }
    ctx.restore();
  }

  private drawIncoming(ctx: Ctx, p: Tank) {
    if (!this.incoming.length) return;
    const c = this.r.toScreen(p.pos);
    const R = Math.min(this.r.W, this.r.H) * 0.2;
    ctx.save();
    for (const i of this.incoming) {
      const a = 1 - i.t / 2.2;
      ctx.strokeStyle = i.pen ? `rgba(235,60,45,${0.85 * a})` : `rgba(250,200,80,${0.75 * a})`;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(c.x, c.y, R, i.ang - 0.28, i.ang + 0.28);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(c.x + Math.cos(i.ang) * (R + 14), c.y + Math.sin(i.ang) * (R + 14));
      ctx.lineTo(c.x + Math.cos(i.ang - 0.1) * (R + 3), c.y + Math.sin(i.ang - 0.1) * (R + 3));
      ctx.lineTo(c.x + Math.cos(i.ang + 0.1) * (R + 3), c.y + Math.sin(i.ang + 0.1) * (R + 3));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawPenInfo(ctx: Ctx, W: number, H: number) {
    const pr = this.r.aimPrediction;
    if (!pr || pr.outcome === 'none') return;
    const txt =
      pr.outcome === 'ricochet'
        ? `${tr(pr.label)} · ${tr('RICOCHET LIKELY')}`
        : `${tr(pr.label)} · ${tr('EFF')} ${Math.round(pr.eff)}mm / ${tr('PEN')} ${Math.round(pr.pen)}mm`;
    ctx.save();
    ctx.font = '700 12px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center';
    const tw = ctx.measureText(txt).width;
    const y = H - this.safe.b - 18;
    ctx.fillStyle = 'rgba(10,12,10,0.55)';
    roundRect(ctx, W / 2 - tw / 2 - 10, y - 10, tw + 20, 20, 4);
    ctx.fill();
    ctx.fillStyle = predColor(pr.outcome);
    ctx.fillText(txt, W / 2, y);
    ctx.restore();
  }

  private drawSticks(ctx: Ctx) {
    const R = this.stickR();
    const draw = (st: Stick, aim: boolean) => {
      const v = { x: st.pos.x - st.base.x, y: st.pos.y - st.base.y };
      const l = Math.hypot(v.x, v.y);
      const k = l > R ? R / l : 1;
      const kx = st.base.x + v.x * k;
      const ky = st.base.y + v.y * k;
      ctx.save();
      ctx.fillStyle = 'rgba(20,22,20,0.28)';
      ctx.strokeStyle = aim ? 'rgba(255,215,140,0.55)' : 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(st.base.x, st.base.y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (aim) {
        ctx.strokeStyle = 'rgba(255,120,90,0.35)';
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.arc(st.base.x, st.base.y, R * 0.3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = aim ? 'rgba(255,210,130,0.75)' : 'rgba(240,240,235,0.65)';
      ctx.beginPath();
      ctx.arc(kx, ky, R * 0.38, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    if (this.move) draw(this.move, false);
    else {
      // hint ring where the move stick usually sits
      const R2 = R;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.safe.l + R2 + 28, this.r.H - this.safe.b - R2 - 22, R2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (this.aim && this.aim.moved) draw(this.aim, true);
  }

  private drawRoundBtn(ctx: Ctx, b: Btn, label: string, active: boolean, col = 'rgba(20,22,20,0.55)') {
    ctx.save();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r!, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = active ? 'rgba(255,210,130,0.9)' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#f2f2ea';
    ctx.font = `700 ${Math.round(b.r! * 0.8)}px "Barlow Condensed", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(label, b.x, b.y + 1);
    ctx.restore();
  }

  private drawButtons(ctx: Ctx, p: Tank) {
    for (const bt of this.buttons) {
      if (bt.id === 'fire') {
        const ready = p.isReloaded() && p.canFire();
        ctx.save();
        ctx.fillStyle = ready ? 'rgba(170,60,40,0.62)' : 'rgba(30,30,28,0.6)';
        if (this.fireFlash > 0) ctx.fillStyle = 'rgba(255,170,90,0.8)';
        ctx.beginPath();
        ctx.arc(bt.x, bt.y, bt.r!, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = ready ? 'rgba(255,200,150,0.9)' : 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 2;
        ctx.stroke();
        if (!p.isReloaded()) {
          const frac = 1 - p.reloadLeft / p.reloadTime();
          ctx.strokeStyle = 'rgba(255,220,150,0.95)';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(bt.x, bt.y, bt.r! - 3, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#f0f0e8';
          ctx.font = '700 15px "Barlow Condensed", sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(p.canFire() ? p.reloadLeft.toFixed(1) : '✕', bt.x, bt.y + 1);
        } else {
          ctx.fillStyle = '#fff';
          ctx.font = '700 14px "Barlow Condensed", sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(p.canFire() ? tr('FIRE') : '✕', bt.x, bt.y + 1);
        }
        ctx.restore();
      } else if (bt.id.startsWith('ammo')) {
        const i = parseInt(bt.id.slice(4), 10);
        const sh = p.spec.gun.shells[i];
        const sel = p.shellIdx === i;
        ctx.save();
        ctx.fillStyle = sel ? 'rgba(200,140,60,0.7)' : 'rgba(20,22,20,0.55)';
        roundRect(ctx, bt.x, bt.y, bt.w!, bt.h!, 5);
        ctx.fill();
        ctx.strokeStyle = sel ? 'rgba(255,220,160,0.95)' : 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.fillStyle = p.ammo[i] > 0 ? '#fff' : 'rgba(255,255,255,0.35)';
        ctx.font = '700 12px "Barlow Condensed", sans-serif';
        ctx.fillText(shellLabel(p, i), bt.x + bt.w! / 2, bt.y + 10);
        ctx.font = '500 10px "Barlow Condensed", sans-serif';
        ctx.fillText(`${p.ammo[i]}`, bt.x + bt.w! / 2, bt.y + 22);
        ctx.restore();
      } else if (bt.id === 'ext') {
        const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 120);
        this.drawRoundBtn(ctx, bt, '🧯', true, `rgba(200,60,30,${0.5 + pulse * 0.3})`);
        if (p.extinguishCd > 0) {
          ctx.fillStyle = '#fff';
          ctx.font = '600 10px "Barlow Condensed", sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(`${Math.ceil(p.extinguishCd)}`, bt.x, bt.y + bt.r! + 9);
        }
      } else if (bt.id === 'pause') this.drawRoundBtn(ctx, bt, 'II', false);
      else if (bt.id === 'zoom') this.drawRoundBtn(ctx, bt, this.r.zoomOut ? '−' : '⌕', this.r.zoomOut);
    }
  }

  private drawBanner(ctx: Ctx, W: number, H: number, title: string, sub: string, color: string, a: number) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, a));
    const y = H * 0.3;
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(10,12,10,0)');
    g.addColorStop(0.25, 'rgba(10,12,10,0.7)');
    g.addColorStop(0.75, 'rgba(10,12,10,0.7)');
    g.addColorStop(1, 'rgba(10,12,10,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 34, W, 68);
    ctx.textAlign = 'center';
    ctx.fillStyle = color;
    ctx.font = '700 34px "Barlow Condensed", sans-serif';
    ctx.fillText(title, W / 2, y - 6);
    ctx.fillStyle = '#e8e8de';
    ctx.font = '500 14px "Barlow Condensed", sans-serif';
    ctx.fillText(sub, W / 2, y + 20);
    ctx.restore();
  }

  private drawTutorial(ctx: Ctx, W: number, H: number) {
    const a = Math.min(1, this.tutorial / 0.6, (14 - this.tutorial) / 0.4);
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    const box = (x: number, y: number, title: string, sub: string) => {
      ctx.font = '700 16px "Barlow Condensed", sans-serif';
      const w = Math.max(ctx.measureText(title).width, (ctx.font = '500 12px "Barlow Condensed", sans-serif', ctx.measureText(sub).width)) + 24;
      ctx.fillStyle = 'rgba(12,14,12,0.72)';
      roundRect(ctx, x - w / 2, y - 22, w, 44, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(240,180,90,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f2b449';
      ctx.font = '700 16px "Barlow Condensed", sans-serif';
      ctx.fillText(title, x, y - 7);
      ctx.fillStyle = '#e6e6dc';
      ctx.font = '500 12px "Barlow Condensed", sans-serif';
      ctx.fillText(sub, x, y + 11);
    };
    box(W * 0.22, H * 0.62, tr('◀ DRAG TO DRIVE'), tr('Push where you want to go · pull back to reverse'));
    box(W * 0.66, H * 0.42, tr('DRAG TO AIM ▶'), tr('Release to fire · tap to fire'));
    box(W * 0.45, H * 0.74, tr('Capture point A'), tr('Green reticle = will penetrate'));
    ctx.restore();
  }

  private drawDeath(ctx: Ctx, W: number, H: number, s: typeof this.safe) {
    const b = this.b;
    const d = this.deathInfo;
    const t = d?.t ?? 0;
    ctx.save();
    ctx.fillStyle = `rgba(8,8,8,${Math.min(0.55, t * 0.5)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = Math.min(1, t * 2);
    ctx.textAlign = 'center';
    ctx.font = '700 30px "Barlow Condensed", sans-serif';
    ctx.fillStyle = '#e8473b';
    ctx.fillText(tr('DESTROYED'), W / 2, s.t + 72);
    if (d?.killer && d.killer !== b.player) {
      ctx.font = '500 14px "Barlow Condensed", sans-serif';
      ctx.fillStyle = '#ddd';
      ctx.fillText(`${tr('by')} ${d.killer.name} · ${d.killer.spec.name}`, W / 2, s.t + 96);
    }
    if (d?.res) {
      const hw = Math.min(320, W * 0.4);
      const hh = Math.min(150, H * 0.34);
      drawHitCam(ctx, d.res, W / 2 - hw / 2, s.t + 108, hw, hh);
    }
    const av = b.availableLineup();
    const ready = b.time - b.deadAt > 2.5;
    for (const bt of this.buttons) {
      if (bt.id.startsWith('spawn:')) {
        const spec = av.find((v) => v.id === bt.id.slice(6));
        if (!spec) continue;
        ctx.fillStyle = ready ? 'rgba(28,32,30,0.92)' : 'rgba(28,32,30,0.6)';
        roundRect(ctx, bt.x, bt.y, bt.w!, bt.h!, 6);
        ctx.fill();
        ctx.strokeStyle = ready ? 'rgba(240,180,90,0.9)' : 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.save();
        ctx.translate(bt.x + bt.w! / 2, bt.y + 38);
        ctx.scale(5.6, 5.6);
        ctx.rotate(-Math.PI / 2 + 0.6);
        drawTankSprite(ctx, spec, 12);
        ctx.restore();
        ctx.fillStyle = '#fff';
        ctx.font = '700 13px "Barlow Condensed", sans-serif';
        ctx.fillText(spec.name, bt.x + bt.w! / 2, bt.y + bt.h! - 22);
        ctx.font = '500 11px "Barlow Condensed", sans-serif';
        ctx.fillStyle = '#f0b43c';
        ctx.fillText(ready ? tr('TAP TO DEPLOY') : `${Math.ceil(2.5 - (b.time - b.deadAt))}s`, bt.x + bt.w! / 2, bt.y + bt.h! - 8);
      } else if (bt.id === 'leave') {
        ctx.fillStyle = 'rgba(60,30,26,0.85)';
        roundRect(ctx, bt.x, bt.y, bt.w!, bt.h!, 5);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '600 13px "Barlow Condensed", sans-serif';
        ctx.fillText(tr('Leave battle'), bt.x + bt.w! / 2, bt.y + bt.h! / 2 + 1);
      }
    }
    if (!av.length) {
      ctx.font = '500 13px "Barlow Condensed", sans-serif';
      ctx.fillStyle = '#ccc';
      ctx.fillText(tr('No vehicles left — spectating'), W / 2, H - s.b - 110);
    }
    ctx.restore();
  }
}

export { formatNum };

/** Short ammo label; disambiguates guns that carry two rounds of the same type. */
export function shellLabel(p: Tank, i: number): string {
  const shells = p.spec.gun.shells;
  const sh = shells[i];
  const dup = shells.filter((x) => x.type === sh.type).length > 1;
  if (!dup) return sh.type;
  return sh.name.replace(/^(PzGr|Sprgr)\s*/, '').slice(0, 8);
}
