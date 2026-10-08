// Battle HUD & touch controls (mobile landscape).
//
// Right thumb: the FIRE button is a joystick — drag it to swing the turret (the aim stays where
// you leave it), release to fire, slide back into the centre to cancel. Around it sit the
// handbrake (hold), boost, smoke (drag to throw, like the fire stick) and repair / extinguish.
// Left thumb: floating drive stick. Zoom with the +/− buttons or a pinch; zoomed in, dragging on
// the battlefield lays the gun exactly on the touched spot.

import { type V2, DEG, angDiff, clamp, dist, formatNum } from '../core/math';
import { audio } from '../core/audio';
import type { Battle, BattleEvent } from '../game/battle';
import { BATTLE_TIME, TICKETS } from '../game/battle';
import { CARRIER } from '../game/carrier';
import { ARTY } from '../game/support';
import { FLARE, flareLight } from '../game/weather';
import { bermCover } from '../game/map';
import { Tank } from '../game/tank';
import { TEAM_COL, predColor, type BattleRenderer } from '../render/battleRender';
import { drawXray, drawTankSprite, makeCanvas } from '../render/tankRender';
import { t as tr } from './i18n';
import { drawHitCam, hitTitle, roundRect, type HitCamEntry } from './hitcam';

type Ctx = CanvasRenderingContext2D;

/** Discrete player actions. Single player / host apply them directly; a network client sends them. */
export interface Controls {
  fire(aim: number): void;
  cancelFire(): void;
  shell(i: number): void;
  smoke(ang: number): void;
  flare(ang: number): void;
  boost(): void;
  repair(): void;
  crew(): void;
  recon(): void;
  arty(x: number, y: number): void;
  respawn(id: string): void;
}

export function localControls(b: Battle): Controls {
  const me = () => b.player;
  return {
    fire: (aim) => {
      const p = me();
      if (p) b.requestFire(p, aim);
    },
    cancelFire: () => {
      const p = me();
      if (p) p.fireReq = null;
    },
    shell: (i) => {
      const p = me();
      if (p) b.selectShell(p, i);
    },
    smoke: (a) => {
      const p = me();
      if (p) b.useSmoke(p, a);
    },
    flare: (a) => {
      const p = me();
      if (p) b.useFlare(p, a);
    },
    boost: () => {
      const p = me();
      if (p) b.useBoost(p);
    },
    repair: () => {
      const p = me();
      if (p) b.useRepair(p);
    },
    crew: () => {
      const p = me();
      if (p) b.useCrew(p);
    },
    recon: () => {
      const p = me();
      if (p) b.useRecon(p);
    },
    arty: (x, y) => {
      const p = me();
      if (p) b.useArty(p, x, y);
    },
    respawn: (id) => b.respawnPlayer(id),
  };
}

interface Stick {
  id: number;
  base: V2;
  pos: V2;
  start: number;
  /** has left the centre dead zone at least once */
  moved: boolean;
  /** filtered world angle of the stick */
  ang: number;
  hist: Array<{ t: number; a: number }>;
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

const ABILITY_IDS = ['brake', 'boost', 'smoke', 'repair', 'crew'] as const;

export class Hud {
  b: Battle;
  r: BattleRenderer;
  canvas: HTMLCanvasElement;
  controls: Controls;
  move: Stick | null = null;
  fireStick: Stick | null = null;
  /** smoke or flare button dragged like a joystick to pick the direction */
  throwStick: (Stick & { kind: 'smoke' | 'flare' }) | null = null;
  /** zoomed in: finger on the battlefield lays the gun on that spot */
  sight: { id: number; pos: V2 } | null = null;
  private free = new Map<number, V2>();
  private pinch: { d0: number; idx0: number } | null = null;
  brakeHeld = false;
  buttons: Btn[] = [];
  fireC = { x: 0, y: 0, r: 40 };
  private arcTop = 0;
  private pressed = new Map<number, string>();
  feed: Feed[] = [];
  notices: Notice[] = [];
  hitcams: HitCamEntry[] = [];
  reverseMode = false;
  aimAssistTarget: Tank | null = null;
  deathInfo: { killer: Tank | null; res: HitCamEntry | null; t: number } | null = null;
  /** test hook: when set, replaces touch movement input */
  autoInput: ((p: Tank) => void) | null = null;
  onPause: () => void = () => {};
  onLeave: () => void = () => {};
  /** multiplayer status line (ping etc.) */
  netInfo: string | null = null;
  safe = { l: 0, r: 0, t: 0, b: 0 };
  private minimapBg: HTMLCanvasElement | null = null;
  private minimapVer = -1;
  /** seconds left for the first-battle controls hint */
  tutorial = 0;
  /** incoming fire direction markers */
  private incoming: Array<{ ang: number; t: number; pen: boolean }> = [];
  private fireFlash = 0;
  private prevRepairT = 0;
  private prevRecoil = 0;
  /** our tank is hull-down against the nearest enemy */
  hullDown = false;
  /** choosing an artillery target */
  targeting = false;
  private aimPt: { id: number; pos: V2 } | null = null;
  /** targeting: a quick tap on the drive side also picks the target */
  private tapCand: { id: number; pos: V2; t: number } | null = null;
  private hullDownT = 0;

  constructor(b: Battle, r: BattleRenderer, canvas: HTMLCanvasElement, controls?: Controls) {
    this.b = b;
    this.r = r;
    this.canvas = canvas;
    this.controls = controls ?? localControls(b);
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
    this.r.camLock = null;
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
    const fr = clamp(H * 0.13, 40, 54);
    const fx = W - s.r - fr - 20;
    const fy = H - s.b - fr - 18;
    this.fireC = { x: fx, y: fy, r: fr };
    const btns: Btn[] = [];
    const p = this.b.player;
    this.arcTop = fy - fr - 10;
    if (p && p.alive && this.b.state === 'playing') {
      // ability buttons on an arc around the fire stick (left → up)
      const br = clamp(H * 0.058, 20, 24);
      const ar = fr + br + 21;
      const angs = [175, 205, 235, 265, 295];
      ABILITY_IDS.forEach((id, i) => {
        const a = angs[i] * DEG;
        btns.push({ id, x: fx + Math.cos(a) * ar, y: fy + Math.sin(a) * ar, r: br });
      });
      this.arcTop = fy - ar - br - 6;
      // situational buttons on an outer arc (killstreak support, flares at night)
      const outer = this.outerIds(p);
      const ro = ar + br * 2 + 14;
      const oangs = [212, 238, 264];
      outer.forEach((id, i) => {
        const a = oangs[i] * DEG;
        btns.push({ id, x: fx + Math.cos(a) * ro, y: fy + Math.sin(a) * ro, r: br });
      });
      if (outer.length) this.arcTop = Math.min(this.arcTop, fy + Math.sin(oangs[Math.min(outer.length, 3) - 1] * DEG) * ro - br - 6);
      // ammo row to the left of the arc
      const n = p.spec.gun.shells.length;
      const bw = 54;
      const bh = 30;
      const right = fx - ar - br - 10;
      for (let i = 0; i < n; i++) btns.push({ id: `ammo${i}`, x: right - (n - i) * (bw + 6) + 6, y: fy + fr - bh, w: bw, h: bh });
    }
    btns.push({ id: 'pause', x: W - s.r - 30, y: s.t + 26, r: 18 });
    btns.push({ id: 'zin', x: W - s.r - 72, y: s.t + 26, r: 18 });
    btns.push({ id: 'zout', x: W - s.r - 112, y: s.t + 26, r: 18 });
    if (this.b.state === 'dead') {
      const av = this.b.availableLineup();
      const cw = 150;
      const total = av.length * (cw + 12) - 12;
      av.forEach((v, i) => btns.push({ id: `spawn:${v.id}`, x: W / 2 - total / 2 + i * (cw + 12), y: H - s.b - 120, w: cw, h: 96 }));
      btns.push({ id: 'leave', x: W - s.r - 150, y: H - s.b - 44, w: 136, h: 30 });
    }
    this.buttons = btns;
  }

  /** Which situational buttons to show on the outer arc. */
  private outerIds(p: Tank): string[] {
    const ids: string[] = [];
    if (this.b.weather.flares > 0) ids.push('flare');
    const st = this.b.supportOf(p);
    if (st.recon > 0) ids.push('recon');
    if (st.arty > 0) ids.push('arty');
    return ids;
  }

  private minimapRect() {
    const size = clamp(this.r.H * 0.3, 96, 128);
    return { x: this.safe.l + 10, y: this.safe.t + 10, size };
  }

  private hitButton(x: number, y: number): Btn | null {
    for (const b of this.buttons) {
      if (b.r !== undefined) {
        if (Math.hypot(x - b.x, y - b.y) <= b.r + 5) return b;
      } else if (x >= b.x - 4 && x <= b.x + b.w! + 4 && y >= b.y - 4 && y <= b.y + b.h! + 4) return b;
    }
    return null;
  }

  private playing(): boolean {
    return this.b.state === 'playing' && !!this.b.player?.alive;
  }

  // ------------------------------------------------------------------ input
  private pt(e: PointerEvent): V2 {
    const rc = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rc.left, y: e.clientY - rc.top };
  }

  private newStick(e: PointerEvent, base: V2, p: V2): Stick {
    return { id: e.pointerId, base, pos: p, start: performance.now(), moved: false, ang: 0, hist: [] };
  }

  private capture(e: PointerEvent) {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  private onDown = (e: PointerEvent) => {
    e.preventDefault();
    audio.unlock();
    // a reused pointer id means we missed its pointerup; drop stale state
    this.pressed.delete(e.pointerId);
    this.free.delete(e.pointerId);
    if (this.move?.id === e.pointerId) this.move = null;
    if (this.fireStick?.id === e.pointerId) this.fireStick = null;
    if (this.throwStick?.id === e.pointerId) this.throwStick = null;
    if (this.sight?.id === e.pointerId) this.endSight();
    const p = this.pt(e);
    this.layout();
    const btn = this.hitButton(p.x, p.y);
    if (btn) {
      if ((btn.id === 'smoke' || btn.id === 'flare') && this.playing()) {
        if (!this.throwStick) {
          this.throwStick = { ...this.newStick(e, { x: btn.x, y: btn.y }, p), kind: btn.id };
          this.capture(e);
        }
        return;
      }
      this.pressed.set(e.pointerId, btn.id);
      this.press(btn.id);
      this.capture(e);
      return;
    }
    if (!this.playing()) return;
    const W = this.r.W;
    if (this.targeting) {
      const mm = this.minimapRect();
      if (p.x >= mm.x && p.x <= mm.x + mm.size && p.y >= mm.y && p.y <= mm.y + mm.size) {
        const S = this.b.map.size;
        this.callArty({ x: ((p.x - mm.x) / mm.size) * S, y: ((p.y - mm.y) / mm.size) * S });
        return;
      }
      if (p.x >= W * 0.45 && Math.hypot(p.x - this.fireC.x, p.y - this.fireC.y) > this.fireC.r + 10) {
        this.aimPt = { id: e.pointerId, pos: p };
        this.capture(e);
        return;
      }
    }
    const fc = this.fireC;
    if (Math.hypot(p.x - fc.x, p.y - fc.y) <= fc.r + 10) {
      if (!this.fireStick) {
        this.fireStick = this.newStick(e, { x: fc.x, y: fc.y }, p);
        this.capture(e);
      }
      return;
    }
    if (p.x < W * 0.45 && !this.move) {
      if (this.targeting) this.tapCand = { id: e.pointerId, pos: p, t: performance.now() };
      const R = this.stickR();
      const base = { x: clamp(p.x, R + 8 + this.safe.l, W * 0.45), y: clamp(p.y, R + 60, this.r.H - R - 8) };
      this.move = this.newStick(e, base, p);
      this.capture(e);
      return;
    }
    if (p.x >= W * 0.45) {
      // free touch on the battlefield: pinch zoom, or precision aim when zoomed in
      this.free.set(e.pointerId, p);
      this.capture(e);
      if (this.free.size >= 2) {
        this.endSight();
        const [a, b] = [...this.free.values()];
        this.pinch = { d0: Math.max(30, dist(a, b)), idx0: this.r.zoomIdx };
      } else if (this.r.zoomMul > 1.05 && !this.sight) {
        this.sight = { id: e.pointerId, pos: p };
        this.r.camLock = { ...this.r.cam };
      }
    }
  };

  private endSight() {
    this.sight = null;
    this.r.camLock = null;
  }

  private stickMove(st: Stick, p: V2, dz: number) {
    st.pos = p;
    const vx = p.x - st.base.x;
    const vy = p.y - st.base.y;
    if (Math.hypot(vx, vy) < dz) return;
    const raw = Math.atan2(vy, vx);
    if (!st.moved) {
      st.moved = true;
      st.ang = raw;
    } else {
      // calm small finger jitter, follow big swings at once
      const d = angDiff(st.ang, raw);
      st.ang += Math.abs(d) > 0.06 ? d : d * 0.4;
    }
    const now = performance.now();
    st.hist.push({ t: now, a: st.ang });
    while (st.hist.length > 2 && now - st.hist[0].t > 400) st.hist.shift();
  }

  private onMove = (e: PointerEvent) => {
    const p = this.pt(e);
    if (this.aimPt && e.pointerId === this.aimPt.id) {
      this.aimPt.pos = p;
      return;
    }
    if (this.move && e.pointerId === this.move.id) {
      this.move.pos = p;
      if (dist(p, this.move.base) > 6) this.move.moved = true;
    } else if (this.fireStick && e.pointerId === this.fireStick.id) {
      const was = this.fireStick.moved;
      this.stickMove(this.fireStick, p, this.fireDZ());
      if (!was && this.fireStick.moved && this.b.player?.fireReq) this.controls.cancelFire();
    } else if (this.throwStick && e.pointerId === this.throwStick.id) {
      this.stickMove(this.throwStick, p, 16);
    } else if (this.free.has(e.pointerId)) {
      this.free.set(e.pointerId, p);
      if (this.sight && this.sight.id === e.pointerId) this.sight.pos = p;
      if (this.pinch && this.free.size >= 2) {
        const [a, b] = [...this.free.values()];
        const steps = Math.round(Math.log(dist(a, b) / this.pinch.d0) / Math.log(1.45));
        const want = clamp(this.pinch.idx0 + steps, 0, 3);
        if (want !== this.r.zoomIdx) this.r.zoomStep(want - this.r.zoomIdx);
      }
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.aimPt && e.pointerId === this.aimPt.id) {
      const w = this.r.toWorldPt(this.aimPt.pos);
      this.aimPt = null;
      this.callArty(w);
      return;
    }
    const id = this.pressed.get(e.pointerId);
    if (id !== undefined) {
      this.pressed.delete(e.pointerId);
      if (id === 'brake') this.brakeHeld = false;
      return;
    }
    if (this.move && e.pointerId === this.move.id) {
      this.move = null;
      const tc = this.tapCand;
      this.tapCand = null;
      if (tc && tc.id === e.pointerId && this.targeting && performance.now() - tc.t < 300 && dist(this.pt(e), tc.pos) < 14) this.callArty(this.r.toWorldPt(tc.pos));
    } else if (this.fireStick && e.pointerId === this.fireStick.id) {
      const st = this.fireStick;
      this.fireStick = null;
      this.releaseFire(st);
    } else if (this.throwStick && e.pointerId === this.throwStick.id) {
      const st = this.throwStick;
      this.throwStick = null;
      if (st.kind === 'flare') this.releaseFlare(st);
      else this.releaseSmoke(st);
    } else if (this.free.has(e.pointerId)) {
      this.free.delete(e.pointerId);
      if (this.sight?.id === e.pointerId) this.endSight();
      if (this.free.size < 2) this.pinch = null;
    }
  };

  /** Angle the stick pointed at a moment before release (fingers twitch as they lift). */
  private settledAngle(st: Stick): number {
    const now = performance.now();
    let a = st.ang;
    for (let i = st.hist.length - 1; i >= 0; i--) {
      a = st.hist[i].a;
      if (now - st.hist[i].t >= 60) break;
    }
    return a;
  }

  private releaseFire(st: Stick) {
    const p = this.b.player;
    if (!p || !p.alive || this.b.state !== 'playing') return;
    const inside = dist(st.pos, st.base) < this.fireDZ();
    if (st.moved && inside) {
      this.note(tr('Shot cancelled'), '#c8c8c0');
      return;
    }
    let aim = p.aimAngle;
    if (st.moved) {
      aim = this.assist(p, this.settledAngle(st));
      p.aimAngle = aim;
    }
    if (!p.canFire()) {
      this.note(tr('Gun out of action'), '#ff8a5c');
      return;
    }
    if (p.reloadLeft > 1.6) {
      this.note(`${tr('Reloading')} ${p.reloadLeft.toFixed(1)}s`, '#d8d0b8');
      return;
    }
    this.controls.fire(aim);
    // network client: show the queued state until the host's shot arrives
    if (this.b.mode === 'replica' && !p.fireReq) p.fireReq = { until: this.b.time + p.reloadLeft + 3 };
  }

  private releaseSmoke(st: Stick) {
    const p = this.b.player;
    if (!p || !p.alive || this.b.state !== 'playing') return;
    const inside = dist(st.pos, st.base) < 16;
    if (st.moved && inside) return;
    if (p.smokeCharges <= 0) {
      this.note(tr('No smoke left'), '#c8c8c0');
      return;
    }
    if (!p.canSmoke()) return;
    const a = st.moved ? this.settledAngle(st) : p.gunWorldAng;
    this.controls.smoke(a);
    audio.click();
  }

  private releaseFlare(st: Stick) {
    const p = this.b.player;
    if (!p || !p.alive || this.b.state !== 'playing') return;
    if (st.moved && dist(st.pos, st.base) < 16) return;
    if (p.flareCharges <= 0) {
      this.note(tr('No flares left'), '#c8c8c0');
      return;
    }
    if (!p.canFlare()) return;
    this.controls.flare(st.moved ? this.settledAngle(st) : p.gunWorldAng);
    audio.click();
  }

  private callArty(w: V2) {
    this.targeting = false;
    this.aimPt = null;
    const p = this.b.player;
    if (!p || !p.alive || this.b.supportOf(p).arty <= 0) return;
    this.controls.arty(w.x, w.y);
    audio.click();
  }

  private note(text: string, color = '#ffd27a') {
    if (this.notices[0]?.text === text && this.notices[0].t < 1) {
      this.notices[0].t = 0;
      return;
    }
    this.notices.unshift({ text, color, t: 0 });
    this.notices = this.notices.slice(0, 3);
  }

  private press(id: string) {
    const b = this.b;
    const p = b.player;
    audio.click();
    if (id.startsWith('ammo') && p) this.controls.shell(parseInt(id.slice(4), 10));
    else if (id === 'brake') this.brakeHeld = true;
    else if (id === 'boost' && p) {
      if (p.boostT > 0) return;
      if (!p.canMove()) this.note(tr('Cannot move'), '#ff8a5c');
      else if (p.boostCd > 0) this.note(`${tr('Boost')} ${Math.ceil(p.boostCd)}s`, '#d8d0b8');
      else {
        this.controls.boost();
        if (b.mode === 'replica') p.startBoost();
      }
    } else if (id === 'repair' && p) {
      if (p.burning > 0) {
        if (p.extinguishCd > 0) this.note(`${tr('Extinguisher')} ${Math.ceil(p.extinguishCd)}s`, '#d8d0b8');
        else this.controls.repair();
      } else if (p.repairT > 0) return;
      else if (!p.needsRepair()) this.note(tr('Nothing to repair'), '#c8c8c0');
      else if (p.repairCd > 0) this.note(`${tr('Repair')} ${Math.ceil(p.repairCd)}s`, '#d8d0b8');
      else if (p.crewAlive().length < 2) this.note(tr('Not enough crew'), '#ff8a5c');
      else this.controls.repair();
    } else if (id === 'crew' && p) {
      const cv = b.carrierFor(p);
      if (cv) this.note(tr('Carrier already on the way'), '#d8d0b8');
      else if (p.crewCd > 0) this.note(`${tr('Crew carrier')} ${Math.ceil(p.crewCd)}s`, '#d8d0b8');
      else if (!p.needsCrew()) this.note(tr('No wounded crew'), '#c8c8c0');
      else this.controls.crew();
    } else if (id === 'recon' && p) {
      this.controls.recon();
    } else if (id === 'arty' && p) {
      this.targeting = !this.targeting;
      this.aimPt = null;
      if (this.targeting) this.note(tr('Tap the battlefield or the minimap to call artillery'), '#ffd27a');
    } else if (id === 'zin') this.r.zoomStep(1);
    else if (id === 'zout') {
      this.r.zoomStep(-1);
      if (this.r.zoomMul <= 1.05) this.endSight();
    } else if (id === 'pause') this.onPause();
    else if (id.startsWith('spawn:')) {
      if (b.time - b.deadAt > 2.5) {
        this.controls.respawn(id.slice(6));
        this.deathInfo = null;
      }
    } else if (id === 'leave') this.onLeave();
  }

  private stickR() {
    return clamp(this.r.H * 0.16, 46, 70);
  }
  private fireDZ() {
    return this.fireC.r * 0.36;
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
    if (this.tutorial > 0 && b.time > 4.6) this.tutorial -= dt;

    if (!p || !p.alive || b.state !== 'playing') {
      this.move = null;
      this.fireStick = null;
      this.throwStick = null;
      this.brakeHeld = false;
      this.targeting = false;
      this.aimPt = null;
      if (this.sight) this.endSight();
      if (p) p.handbrake = false;
      return;
    }
    if (this.prevRepairT > 0 && p.repairT <= 0 && p.repairCd > 0) this.note(tr('Repairs complete'), '#9fd3ff');
    this.prevRepairT = p.repairT;
    // hull-down check against the nearest spotted enemy
    this.hullDownT -= dt;
    if (this.hullDownT <= 0) {
      this.hullDownT = 0.25;
      let near: Tank | null = null;
      let nd = 320;
      for (const e of b.tanks) {
        if (!e.alive || e.team === p.team || !b.isSpotted(p.team, e)) continue;
        const d = dist(e.pos, p.pos);
        if (d < nd) {
          nd = d;
          near = e;
        }
      }
      this.hullDown = !!near && bermCover(b.map, near.muzzle(), p.pos);
    }
    // our gun just fired: flash the button and kick the camera
    if (p.recoil > this.prevRecoil + 0.3) {
      this.fireFlash = 0.15;
      this.r.shake = Math.min(1, 0.4 + p.spec.gun.caliber / 200);
    }
    this.prevRecoil = p.recoil;

    // movement
    if (this.autoInput) {
      this.autoInput(p);
      return;
    }
    p.handbrake = this.brakeHeld;
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
    // aiming: the fire stick sets the gun direction; the aim then stays put (stabilised in the world)
    this.aimAssistTarget = null;
    const fs = this.fireStick;
    if (fs && fs.moved && dist(fs.pos, fs.base) >= this.fireDZ()) {
      p.aimAngle = this.assist(p, fs.ang);
    } else if (this.sight) {
      if (this.r.zoomMul <= 1.05) this.endSight();
      else {
        const w = this.r.toWorldPt(this.sight.pos);
        const tp = p.turretPos();
        if (dist(w, tp) > 2) p.aimAngle = Math.atan2(w.y - tp.y, w.x - tp.x);
      }
    }
    audio.engineSet(Math.min(1, Math.abs(p.speed) / p.maxSpeed() + Math.abs(p.throttle) * 0.3), p.alive);
  }

  /** Light aim assist toward spotted enemies close to the stick direction (off when zoomed in). */
  private assist(p: Tank, a: number): number {
    if (this.r.zoomMul > 1.05) return a;
    const tp = p.turretPos();
    let best: Tank | null = null;
    let bestD = 2.5 * DEG;
    for (const e of this.b.tanks) {
      if (!e.alive || e.team === p.team || !this.b.isSpotted(p.team, e)) continue;
      const ba = Math.atan2(e.pos.y - tp.y, e.pos.x - tp.x);
      const d = Math.abs(angDiff(a, ba));
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) return a;
    this.aimAssistTarget = best;
    const ba = this.leadAngle(p, best);
    return ba + angDiff(ba, a) * 0.5;
  }

  private leadAngle(p: Tank, e: Tank): number {
    const tp = p.turretPos();
    const d = dist(tp, e.pos);
    const v = p.spec.gun.shells[p.shellIdx].velocity * this.b.shellSpeedScale;
    const tof = d / v;
    const x = e.pos.x + e.vel.x * tof;
    const y = e.pos.y + e.vel.y * tof;
    return Math.atan2(y - tp.y, x - tp.x);
  }

  // ------------------------------------------------------------------ events
  handle(ev: BattleEvent) {
    const b = this.b;
    if ('to' in ev && ev.to !== undefined && ev.to !== b.localKey) return;
    if (ev.type === 'notice' && ev.team !== undefined && ev.team !== b.playerTeam) return;
    switch (ev.type) {
      case 'hit': {
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
        break;
      }
      case 'popup':
        this.r.addPopup(ev.text.replace('Building destroyed', tr('Building destroyed')).replace('Target destroyed', tr('Target destroyed')).replace('Critical hit', tr('Critical hit')).replace('Assist', tr('Assist')).replace('Point captured', tr('Point captured')).replace(/^Hit/, tr('Hit')), ev.x, ev.y, ev.color, !!ev.big);
        break;
      case 'feed': {
        const k = ev.killer;
        const nm = (t: Tank) => (t.slot && !t.isPlayer ? `${t.name} · ${t.spec.name}` : t.spec.name);
        const kn = k ? `${k.isPlayer ? '★ ' : ''}${nm(k)}` : '';
        const icon = ev.how === 'cookoff' ? ' ✸ ' : ' ▸ ';
        const text = k ? `${kn}${icon}${nm(ev.victim)}` : `${nm(ev.victim)} ✸`;
        this.feed.unshift({ text, killerFriend: k ? k.team === b.playerTeam : ev.victim.team !== b.playerTeam, t: 0 });
        this.feed = this.feed.slice(0, 5);
        break;
      }
      case 'notice':
        this.note(tr(ev.text), ev.color ?? '#ffd27a');
        break;
      case 'captured':
        this.note(ev.team === b.playerTeam ? tr('Point A captured') : tr('Point A lost'), ev.team === b.playerTeam ? TEAM_COL.friend : TEAM_COL.enemy);
        break;
      case 'playerDead': {
        let entry: HitCamEntry | null = null;
        if (ev.res && b.player) {
          const title = ev.res.cookoff ? 'COOK-OFF' : tr('KNOCKED OUT');
          const color = '#e8473b';
          entry = { res: ev.res, target: b.player, shooter: ev.killer ?? b.player, t: 1.0, life: 9999, title, color };
        }
        this.deathInfo = { killer: ev.killer, res: entry, t: 0 };
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
    const live = !!p && p.alive && b.state === 'playing';
    if (p && p.alive) this.drawDamage(ctx, p, s);
    this.drawFeed(ctx, W, s);
    this.drawNotices(ctx, W, s);
    if (this.hitcams.length && b.state === 'playing') {
      const hw = clamp(W * 0.32, 230, 320);
      const y = s.t + 54 + this.feed.length * 17;
      const hh = Math.min(clamp(H * 0.44, 140, 200), (live ? this.arcTop - 14 : H - s.b) - 8 - y);
      if (hh > 90) drawHitCam(ctx, this.hitcams[0], W - s.r - hw - 10, y, hw, hh);
    }

    if (live && p) {
      this.drawIncoming(ctx, p);
      this.drawOwnMarker(ctx, p);
      this.drawThrowPreview(ctx, p);
      this.drawPenInfo(ctx, W, s);
      this.drawDriveHint(ctx, p);
      this.drawMoveStick(ctx, p);
      this.drawButtons(ctx, p);
      this.drawFireStick(ctx, p);
      if (this.sight) this.drawSightTouch(ctx);
      if (this.targeting) this.drawTargeting(ctx, W);
    } else {
      for (const bt of this.buttons) this.drawTopBtn(ctx, bt);
    }
    if (this.netInfo) {
      const size = clamp(H * 0.3, 96, 128);
      ctx.save();
      ctx.textAlign = 'left';
      if (this.netInfo.startsWith('⚠')) {
        // connection trouble: make it obvious
        const msg = tr(this.netInfo.slice(2));
        ctx.font = '700 15px "Barlow Condensed", sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(`⚠ ${msg}`, W / 2, H * 0.62);
        ctx.fillStyle = '#ff8a5c';
        ctx.fillText(`⚠ ${msg}`, W / 2, H * 0.62);
      } else {
        ctx.font = '600 10px "Barlow Condensed", sans-serif';
        ctx.fillStyle = 'rgba(220,225,215,0.75)';
        ctx.fillText(this.netInfo, s.l + 12, s.t + 10 + size + 10 + clamp(H * 0.25, 78, 104) + 14);
      }
      ctx.restore();
    }
    if (b.state === 'dead') this.drawDeath(ctx, W, H, s);
    if (b.time < 4.5 && b.state === 'playing') {
      const w = b.weather;
      const sub2 = w.id === 'clear' ? undefined : `${w.icon} ${tr(w.name)} · ${tr(w.info)}`;
      this.drawBanner(ctx, W, H, tr('DOMINATION'), tr('Capture and hold point A'), '#f2b449', b.time < 0.4 ? b.time / 0.4 : b.time > 3.7 ? (4.5 - b.time) / 0.8 : 1, sub2);
    }
    if (b.state === 'ended') {
      const win = b.result === 'victory';
      this.drawBanner(ctx, W, H, tr(win ? 'VICTORY' : 'DEFEAT'), win ? tr('The enemy has been defeated') : tr('Your team has been defeated'), win ? '#f2b449' : '#e8473b', 1);
    }
    if (this.tutorial > 0 && live && b.time > 4.6) this.drawTutorial(ctx, W, H);
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
    roundRect(ctx, cx - 30 - bw * own, y - 6, Math.max(0, bw * own - 2), 12, 2);
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
    const left = Math.max(0, BATTLE_TIME - b.time);
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
    if (!this.minimapBg || this.minimapVer !== b.map.version) {
      this.minimapVer = b.map.version;
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
      for (const bd of b.map.buildings) {
        g.fillStyle = bd.dmg >= 2 ? '#5f5a52' : '#9a9184';
        g.beginPath();
        g.moveTo(bd.poly[0].x, bd.poly[0].y);
        for (const p of bd.poly) g.lineTo(p.x, p.y);
        g.fill();
      }
      g.strokeStyle = 'rgba(200,180,130,0.75)';
      g.lineWidth = 2.6;
      g.lineCap = 'round';
      for (const bm of b.map.berms) {
        g.beginPath();
        g.moveTo(bm.pts[0].x, bm.pts[0].y);
        for (const q of bm.pts) g.lineTo(q.x, q.y);
        g.stroke();
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
    // smoke screens
    ctx.fillStyle = 'rgba(230,230,225,0.45)';
    for (const sm of b.map.smokes) {
      ctx.beginPath();
      ctx.arc(x + sm.x * sc, y + sm.y * sc, Math.max(1.5, sm.r * sc), 0, Math.PI * 2);
      ctx.fill();
    }
    // flares burning in the night sky
    for (const f of b.flares) {
      if (f.t < FLARE.FLIGHT) continue;
      const l = flareLight(f);
      if (l.k < 0.05) continue;
      ctx.fillStyle = `rgba(255,230,160,${0.18 * l.k})`;
      ctx.beginPath();
      ctx.arc(x + l.x * sc, y + l.y * sc, l.r * sc, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,245,210,0.95)';
      ctx.beginPath();
      ctx.arc(x + l.x * sc, y + l.y * sc, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
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
      ctx.fillStyle = t.isPlayer ? '#ffffff' : friend ? (t.slot ? '#9cc4ff' : TEAM_COL.friend) : TEAM_COL.enemy;
      ctx.beginPath();
      ctx.moveTo(4.5, 0);
      ctx.lineTo(-3, -3);
      ctx.lineTo(-3, 3);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // crew carriers
    for (const c of b.carriers) {
      if (c.state === 'dead') continue;
      const friend = c.team === b.playerTeam;
      if (!friend && !b.spottedCarriers[b.playerTeam].has(c.id)) continue;
      ctx.fillStyle = friend ? '#bfe0ff' : '#ffb0a6';
      ctx.fillRect(x + c.pos.x * sc - 2, y + c.pos.y * sc - 2, 4, 4);
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
    ctx.fillStyle = p.boostT > 0 ? '#ffcf6e' : '#eee';
    const kmh = Math.round(Math.hypot(p.vel.x, p.vel.y) * 3.6);
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
    if (p.repairT > 0) {
      ctx.fillStyle = '#9fd3ff';
      ctx.font = '600 10px "Barlow Condensed", sans-serif';
      ctx.fillText(`${tr('REPAIRING')} ${Math.ceil(p.repairT)}s`, x + w * 0.7, yy);
      yy += 13;
    }
    const enemyTeam = p.team === 0 ? 1 : 0;
    if (this.b.isSpotted(enemyTeam, p)) {
      ctx.fillStyle = '#ff6b5a';
      ctx.font = '700 10px "Barlow Condensed", sans-serif';
      ctx.fillText(`👁 ${tr('SPOTTED')}`, x + w * 0.7, yy);
      yy += 13;
    }
    if (p.streak > 0) {
      ctx.fillStyle = '#ffb35c';
      ctx.font = '700 10px "Barlow Condensed", sans-serif';
      ctx.fillText(`${tr('STREAK')} ${p.streak}`, x + w * 0.7, yy);
      yy += 13;
    }
    if (this.hullDown) {
      ctx.fillStyle = '#a6e07c';
      ctx.font = '700 10px "Barlow Condensed", sans-serif';
      ctx.fillText(tr('HULL-DOWN'), x + w * 0.7, yy);
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
    let y = s.t + 86;
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

  /** When the sight view has slid away from our own tank, point back to it. */
  private drawOwnMarker(ctx: Ctx, p: Tank) {
    const sp = this.r.toScreen(p.pos);
    const W = this.r.W;
    const H = this.r.H;
    const m = 26;
    if (sp.x > m && sp.x < W - m && sp.y > m && sp.y < H - m) return;
    const cx = W / 2;
    const cy = H / 2;
    const a = Math.atan2(sp.y - cy, sp.x - cx);
    const kx = (W / 2 - m) / Math.max(1e-3, Math.abs(Math.cos(a)));
    const ky = (H / 2 - m) / Math.max(1e-3, Math.abs(Math.sin(a)));
    const k = Math.min(kx, ky);
    const x = cx + Math.cos(a) * k;
    const y = cy + Math.sin(a) * k;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-5, -7);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawThrowPreview(ctx: Ctx, p: Tank) {
    const st = this.throwStick;
    if (!st) return;
    const out = st.moved && dist(st.pos, st.base) >= 16;
    if (st.moved && !out) return;
    const a = out ? st.ang : p.gunWorldAng;
    const tp = p.turretPos();
    const z = this.r.zoom;
    ctx.save();
    ctx.setLineDash([4, 4]);
    if (st.kind === 'flare') {
      // where the flare will burst and the ground it will light up
      const c = this.r.toScreen({ x: tp.x + Math.cos(a) * FLARE.RANGE, y: tp.y + Math.sin(a) * FLARE.RANGE });
      const o = this.r.toScreen(tp);
      ctx.strokeStyle = 'rgba(255,226,160,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(o.x + Math.cos(a) * 30, o.y + Math.sin(a) * 30);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,226,160,0.1)';
      ctx.beginPath();
      ctx.arc(c.x, c.y, FLARE.RADIUS * z, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      return;
    }
    for (const off of [-0.22, 0, 0.22]) {
      const w = { x: tp.x + Math.cos(a + off) * 24.5, y: tp.y + Math.sin(a + off) * 24.5 };
      const sp = this.r.toScreen(w);
      ctx.fillStyle = 'rgba(235,235,230,0.16)';
      ctx.strokeStyle = 'rgba(245,245,240,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 8 * z, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTargeting(ctx: Ctx, W: number) {
    ctx.save();
    // banner
    ctx.font = '700 13px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center';
    const msg = tr('ARTILLERY: tap the battlefield or the minimap · ARTY again to cancel');
    const tw = ctx.measureText(msg).width;
    ctx.fillStyle = 'rgba(60,30,10,0.75)';
    roundRect(ctx, W / 2 - tw / 2 - 12, this.safe.t + 48, tw + 24, 22, 5);
    ctx.fill();
    ctx.fillStyle = '#ffd27a';
    ctx.fillText(msg, W / 2, this.safe.t + 59);
    // minimap frame highlight
    const mm = this.minimapRect();
    ctx.strokeStyle = 'rgba(255,200,110,0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(mm.x - 2, mm.y - 2, mm.size + 4, mm.size + 4);
    if (this.aimPt) {
      const R = ARTY.SPREAD * this.r.zoom;
      const c = this.aimPt.pos;
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = 'rgba(255,120,80,0.95)';
      ctx.fillStyle = 'rgba(255,90,60,0.12)';
      ctx.beginPath();
      ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(c.x - 10, c.y);
      ctx.lineTo(c.x + 10, c.y);
      ctx.moveTo(c.x, c.y - 10);
      ctx.lineTo(c.x, c.y + 10);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSightTouch(ctx: Ctx) {
    const s = this.sight!;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,240,200,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(s.pos.x, s.pos.y, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawPenInfo(ctx: Ctx, W: number, s: typeof this.safe) {
    const pr = this.r.aimPrediction;
    if (!pr || pr.outcome === 'none') return;
    const txt =
      pr.outcome === 'cover'
        ? tr('HULL-DOWN — only the turret can be hit')
        : pr.outcome === 'ricochet'
          ? `${tr(pr.label)} · ${tr('RICOCHET LIKELY')}`
          : `${tr(pr.label)} · ${tr('EFF')} ${Math.round(pr.eff)}mm / ${tr('PEN')} ${Math.round(pr.pen)}mm`;
    ctx.save();
    ctx.font = '700 12px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center';
    const tw = ctx.measureText(txt).width;
    const y = s.t + 60;
    ctx.fillStyle = 'rgba(10,12,10,0.55)';
    roundRect(ctx, W / 2 - tw / 2 - 10, y - 10, tw + 20, 20, 4);
    ctx.fill();
    ctx.fillStyle = predColor(pr.outcome);
    ctx.fillText(txt, W / 2, y);
    ctx.restore();
  }

  private drawMoveStick(ctx: Ctx, p: Tank) {
    const R = this.stickR();
    const st = this.move;
    const base = st ? st.base : { x: this.safe.l + R + 28, y: this.r.H - this.safe.b - R - 22 };
    const ha = p.ang; // hull heading (screen axes = world axes)
    ctx.save();
    // reverse zone: pushing into the shaded back part of the ring drives backwards
    const rev = 115 * DEG;
    ctx.fillStyle = st ? (this.reverseMode ? 'rgba(240,170,70,0.3)' : 'rgba(240,170,70,0.14)') : 'rgba(240,170,70,0.07)';
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.arc(base.x, base.y, R, ha + rev, ha + Math.PI * 2 - rev);
    ctx.closePath();
    ctx.fill();
    if (st) {
      ctx.fillStyle = 'rgba(20,22,20,0.28)';
      ctx.beginPath();
      ctx.arc(base.x, base.y, R, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = st ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(base.x, base.y, R, 0, Math.PI * 2);
    ctx.stroke();
    // "R" in the reverse zone, tank-front marker on the ring
    ctx.font = '700 12px "Barlow Condensed", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = st ? 'rgba(255,200,120,0.85)' : 'rgba(255,200,120,0.4)';
    ctx.fillText('R', base.x - Math.cos(ha) * R * 0.72, base.y - Math.sin(ha) * R * 0.72 + 1);
    const fx = base.x + Math.cos(ha) * (R + 1);
    const fy = base.y + Math.sin(ha) * (R + 1);
    ctx.fillStyle = st ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    ctx.moveTo(fx + Math.cos(ha) * 9, fy + Math.sin(ha) * 9);
    ctx.lineTo(fx + Math.cos(ha + 2.4) * 7, fy + Math.sin(ha + 2.4) * 7);
    ctx.lineTo(fx + Math.cos(ha - 2.4) * 7, fy + Math.sin(ha - 2.4) * 7);
    ctx.closePath();
    ctx.fill();
    if (st) {
      const v = { x: st.pos.x - st.base.x, y: st.pos.y - st.base.y };
      const l = Math.hypot(v.x, v.y);
      const k = l > R ? R / l : 1;
      ctx.fillStyle = this.reverseMode ? 'rgba(255,200,120,0.8)' : 'rgba(240,240,235,0.65)';
      ctx.beginPath();
      ctx.arc(base.x + v.x * k, base.y + v.y * k, R * 0.38, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Ground arrows around our tank: where the front is, where the stick is taking us and which way it turns. */
  private drawDriveHint(ctx: Ctx, p: Tank) {
    const r = this.r;
    const c = r.toScreen(p.pos);
    const z = r.zoom;
    const rad = p.bp.radius;
    const st = this.move;
    const R = this.stickR();
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // chevron at the hull front (amber at the rear while backing up)
    const backing = p.speed < -0.4 || (this.reverseMode && !!st);
    const fa = backing ? p.ang + Math.PI : p.ang;
    const chev = (dist0: number, a: number, size: number, col: string) => {
      const x = c.x + Math.cos(a) * dist0;
      const y = c.y + Math.sin(a) * dist0;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a + 2.5) * size, y + Math.sin(a + 2.5) * size);
      ctx.lineTo(x, y);
      ctx.lineTo(x + Math.cos(a - 2.5) * size, y + Math.sin(a - 2.5) * size);
      ctx.stroke();
    };
    const fcol = backing ? 'rgba(255,190,100,0.75)' : 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 2.5;
    chev((p.spec.look.L / 2 + 1.1) * z, fa, Math.max(5, 0.7 * z), fcol);
    if (Math.abs(p.speed) > 1) chev((p.spec.look.L / 2 + 2.1) * z, fa, Math.max(5, 0.7 * z), fcol);
    if (st) {
      const v = { x: st.pos.x - st.base.x, y: st.pos.y - st.base.y };
      const m = Math.min(1, Math.hypot(v.x, v.y) / R);
      if (m >= 0.12) {
        const want = Math.atan2(v.y, v.x);
        const rev = this.reverseMode;
        const col = rev ? 'rgba(255,190,100,0.9)' : 'rgba(170,230,255,0.9)';
        // travel direction arrow
        const r1 = (rad + 1.2) * z;
        const r2 = (rad + 4 + 3 * m) * z;
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(c.x + Math.cos(want) * r1, c.y + Math.sin(want) * r1);
        ctx.lineTo(c.x + Math.cos(want) * r2, c.y + Math.sin(want) * r2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        const tx = c.x + Math.cos(want) * r2;
        const ty = c.y + Math.sin(want) * r2;
        ctx.beginPath();
        ctx.moveTo(tx + Math.cos(want) * 10, ty + Math.sin(want) * 10);
        ctx.lineTo(tx + Math.cos(want + 2.5) * 8, ty + Math.sin(want + 2.5) * 8);
        ctx.lineTo(tx + Math.cos(want - 2.5) * 8, ty + Math.sin(want - 2.5) * 8);
        ctx.closePath();
        ctx.fill();
        if (rev) {
          ctx.font = '700 13px "Barlow Condensed", sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.strokeText('R', tx + Math.cos(want) * 20, ty + Math.sin(want) * 20 + 1);
          ctx.fillText('R', tx + Math.cos(want) * 20, ty + Math.sin(want) * 20 + 1);
        }
        // turn arc from the current travel direction toward the stick direction
        const cur = rev ? p.ang + Math.PI : p.ang;
        const d = angDiff(cur, want);
        if (Math.abs(d) > 6 * DEG) {
          const ra = (rad + 2.3) * z;
          ctx.strokeStyle = col;
          ctx.lineWidth = 2.5;
          ctx.globalAlpha = 0.8;
          ctx.beginPath();
          ctx.arc(c.x, c.y, ra, cur, cur + d, d < 0);
          ctx.stroke();
          const ea = cur + d;
          const ex = c.x + Math.cos(ea) * ra;
          const ey = c.y + Math.sin(ea) * ra;
          const ta = ea + (d > 0 ? Math.PI / 2 : -Math.PI / 2); // tangent along the turn
          ctx.beginPath();
          ctx.moveTo(ex + Math.cos(ta) * 8, ey + Math.sin(ta) * 8);
          ctx.lineTo(ex + Math.cos(ta + 2.5) * 7, ey + Math.sin(ta + 2.5) * 7);
          ctx.lineTo(ex + Math.cos(ta - 2.5) * 7, ey + Math.sin(ta - 2.5) * 7);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
    }
    ctx.restore();
  }

  private drawFireStick(ctx: Ctx, p: Tank) {
    const { x, y, r } = this.fireC;
    const st = this.fireStick;
    const ready = p.isReloaded() && p.canFire();
    const dz = this.fireDZ();
    const dragging = !!st && st.moved;
    const off = st ? dist(st.pos, st.base) : 0;
    const cancel = dragging && off < dz;
    const queued = !!p.fireReq;
    ctx.save();
    // base
    ctx.fillStyle = cancel ? 'rgba(40,40,38,0.75)' : ready ? 'rgba(170,60,40,0.62)' : 'rgba(30,30,28,0.6)';
    if (this.fireFlash > 0) ctx.fillStyle = 'rgba(255,170,90,0.8)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = ready ? 'rgba(255,200,150,0.9)' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // reload ring
    if (!p.isReloaded()) {
      const frac = 1 - p.reloadLeft / p.reloadTime();
      ctx.strokeStyle = 'rgba(255,220,150,0.95)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, y, r - 3, -Math.PI / 2, -Math.PI / 2 + clamp(frac, 0, 1) * Math.PI * 2);
      ctx.stroke();
    }
    // queued shot: pulsing outline
    if (queued) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 90);
      ctx.strokeStyle = `rgba(255,236,170,${0.45 + pulse * 0.5})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (dragging && st) {
      // dead zone ring = cancel area
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = cancel ? 'rgba(255,120,100,0.95)' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, dz, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!cancel) {
        // knob along the aim direction
        const kl = Math.min(off, r * 0.92);
        const kx = x + Math.cos(st.ang) * kl;
        const ky = y + Math.sin(st.ang) * kl;
        ctx.strokeStyle = 'rgba(255,225,170,0.55)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(kx, ky);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,215,140,0.9)';
        ctx.beginPath();
        ctx.arc(kx, ky, r * 0.34, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#ffb0a0';
        ctx.font = '700 14px "Barlow Condensed", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('✕', x, y + 1);
      }
      // hint label above the button
      ctx.font = '700 11px "Barlow Condensed", sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      const label = cancel ? tr('Release to cancel') : ready ? tr('Release to fire') : `${tr('Release to fire')} · ${p.reloadLeft.toFixed(1)}s`;
      ctx.textAlign = 'right';
      ctx.strokeText(label, x + r, this.arcTop - 4);
      ctx.fillStyle = cancel ? '#ffb0a0' : '#ffe2b0';
      ctx.fillText(label, x + r, this.arcTop - 4);
    } else {
      ctx.fillStyle = '#f0f0e8';
      ctx.font = '700 15px "Barlow Condensed", sans-serif';
      ctx.textAlign = 'center';
      const txt = !p.canFire() ? '✕' : !p.isReloaded() ? p.reloadLeft.toFixed(1) : tr('FIRE');
      ctx.fillText(txt, x, y + 1);
    }
    ctx.restore();
  }

  private drawTopBtn(ctx: Ctx, bt: Btn) {
    if (bt.id === 'pause') this.drawRoundBtn(ctx, bt, 'II', false);
    else if (bt.id === 'zin') this.drawRoundBtn(ctx, bt, '+', this.r.zoomMul > 1.05, undefined, this.r.zoomIdx >= 3);
    else if (bt.id === 'zout') this.drawRoundBtn(ctx, bt, '−', this.r.zoomMul < 0.95, undefined, this.r.zoomIdx <= 0);
    if (bt.id === 'zout' && this.r.zoomIdx !== 1) {
      ctx.save();
      ctx.font = '700 12px "Barlow Condensed", sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,226,170,0.95)';
      ctx.fillText(`${this.r.zoomMul}×`, bt.x - bt.r! - 6, bt.y + 1);
      ctx.restore();
    }
  }

  private drawRoundBtn(ctx: Ctx, b: Btn, label: string, active: boolean, col = 'rgba(20,22,20,0.55)', dim = false) {
    ctx.save();
    ctx.globalAlpha = dim ? 0.45 : 1;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r!, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = active ? 'rgba(255,210,130,0.9)' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#f2f2ea';
    ctx.font = `700 ${Math.round(b.r! * 0.95)}px "Barlow Condensed", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(label, b.x, b.y + 1);
    ctx.restore();
  }

  /** Round ability button with label, cooldown sweep and optional progress ring / badge. */
  private drawAbility(ctx: Ctx, bt: Btn, label: string, o: { active?: boolean; cd?: number; prog?: number; dim?: boolean; pulse?: string; badge?: string; fill?: string; sub?: string }) {
    const r = bt.r!;
    ctx.save();
    ctx.globalAlpha = o.dim ? 0.45 : 1;
    ctx.fillStyle = o.fill ?? (o.active ? 'rgba(200,140,60,0.75)' : 'rgba(20,22,20,0.58)');
    ctx.beginPath();
    ctx.arc(bt.x, bt.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (o.pulse) {
      const k = 0.5 + 0.5 * Math.sin(performance.now() / 160);
      ctx.strokeStyle = o.pulse;
      ctx.globalAlpha = (o.dim ? 0.45 : 1) * (0.4 + 0.6 * k);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(bt.x, bt.y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = o.dim ? 0.45 : 1;
    }
    ctx.strokeStyle = o.active ? 'rgba(255,220,160,0.95)' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(bt.x, bt.y, r, 0, Math.PI * 2);
    ctx.stroke();
    if (o.cd !== undefined && o.cd > 0) {
      // remaining cooldown as a dark sweep
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.moveTo(bt.x, bt.y);
      ctx.arc(bt.x, bt.y, r, -Math.PI / 2, -Math.PI / 2 + clamp(o.cd, 0, 1) * Math.PI * 2);
      ctx.closePath();
      ctx.fill();
    }
    if (o.prog !== undefined) {
      ctx.strokeStyle = 'rgba(160,215,255,0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(bt.x, bt.y, r - 2, -Math.PI / 2, -Math.PI / 2 + clamp(o.prog, 0, 1) * Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#f4f2ea';
    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.round(clamp(r * 0.46, 10, 12))}px "Barlow Condensed", sans-serif`;
    ctx.fillText(label, bt.x, bt.y + (o.sub ? -4 : 1));
    if (o.sub) {
      ctx.font = `600 ${Math.round(clamp(r * 0.42, 9, 11))}px "Barlow Condensed", sans-serif`;
      ctx.fillStyle = 'rgba(255,236,190,0.95)';
      ctx.fillText(o.sub, bt.x, bt.y + 8);
    }
    if (o.badge) {
      const bx = bt.x + r * 0.72;
      const by = bt.y - r * 0.72;
      ctx.fillStyle = 'rgba(230,180,80,0.95)';
      ctx.beginPath();
      ctx.arc(bx, by, 7.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1b1a16';
      ctx.font = '700 10px "Barlow Condensed", sans-serif';
      ctx.fillText(o.badge, bx, by + 0.5);
    }
    ctx.restore();
  }

  private drawButtons(ctx: Ctx, p: Tank) {
    for (const bt of this.buttons) {
      if (bt.id.startsWith('ammo')) {
        const i = parseInt(bt.id.slice(4), 10);
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
      } else if (bt.id === 'brake') {
        this.drawAbility(ctx, bt, tr('BRAKE'), { active: this.brakeHeld, dim: !p.canMove() });
      } else if (bt.id === 'boost') {
        const on = p.boostT > 0;
        this.drawAbility(ctx, bt, tr('BOOST'), { active: on, cd: on ? 0 : p.boostCd / Tank.BOOST_CD, dim: !p.canMove() && !on, sub: on ? `${p.boostT.toFixed(1)}` : p.boostCd > 0 ? `${Math.ceil(p.boostCd)}` : undefined });
      } else if (bt.id === 'smoke') {
        const st = this.throwStick?.kind === 'smoke' ? this.throwStick : null;
        this.drawAbility(ctx, bt, tr('SMOKE'), { active: !!st, cd: p.smokeCd / 4, dim: p.smokeCharges <= 0, badge: String(p.smokeCharges) });
        if (st && st.moved && dist(st.pos, st.base) >= 16) this.drawThrowKnob(ctx, bt, st);
      } else if (bt.id === 'flare') {
        const st = this.throwStick?.kind === 'flare' ? this.throwStick : null;
        this.drawAbility(ctx, bt, tr('FLARE'), { active: !!st, fill: 'rgba(90,70,30,0.8)', cd: p.flareCd / FLARE.CD, dim: p.flareCharges <= 0, badge: String(p.flareCharges), sub: p.flareCd > 0 ? `${Math.ceil(p.flareCd)}` : undefined });
        if (st && st.moved && dist(st.pos, st.base) >= 16) this.drawThrowKnob(ctx, bt, st);
      } else if (bt.id === 'recon') {
        this.drawAbility(ctx, bt, tr('RECON'), { fill: 'rgba(40,70,110,0.8)', pulse: 'rgba(160,215,255,1)' });
      } else if (bt.id === 'arty') {
        this.drawAbility(ctx, bt, tr('ARTY'), { fill: this.targeting ? 'rgba(200,140,60,0.9)' : 'rgba(110,60,30,0.85)', active: this.targeting, pulse: this.targeting ? undefined : 'rgba(255,200,110,1)' });
      } else if (bt.id === 'crew') {
        const cv = this.b.carrierFor(p);
        if (cv && cv.state === 'park') {
          this.drawAbility(ctx, bt, tr('CREW'), { active: true, prog: cv.t / CARRIER.PARK, sub: `${Math.max(0, Math.ceil(CARRIER.PARK - cv.t))}s` });
        } else if (cv && cv.state === 'drive') {
          this.drawAbility(ctx, bt, tr('CREW'), { active: true, sub: `${Math.round(dist(cv.pos, p.pos))}m` });
        } else {
          const need = p.needsCrew();
          this.drawAbility(ctx, bt, tr('CREW'), { cd: p.crewCd / CARRIER.CD, dim: !need, pulse: need && p.crewCd <= 0 ? 'rgba(160,215,255,1)' : undefined, sub: p.crewCd > 0 ? `${Math.ceil(p.crewCd)}` : undefined });
        }
      } else if (bt.id === 'repair') {
        if (p.burning > 0) {
          this.drawAbility(ctx, bt, tr('PUT OUT'), { fill: 'rgba(190,60,30,0.8)', pulse: p.extinguishCd > 0 ? undefined : 'rgba(255,140,90,1)', cd: p.extinguishCd / 30, sub: p.extinguishCd > 0 ? `${Math.ceil(p.extinguishCd)}` : undefined });
        } else if (p.repairT > 0) {
          this.drawAbility(ctx, bt, tr('REPAIR'), { active: true, prog: 1 - p.repairT / Tank.REPAIR_TIME, sub: `${Math.ceil(p.repairT)}` });
        } else {
          const need = p.needsRepair();
          this.drawAbility(ctx, bt, tr('REPAIR'), { cd: p.repairCd / Tank.REPAIR_CD, dim: !need, pulse: need && p.repairCd <= 0 ? 'rgba(255,210,110,1)' : undefined, sub: p.repairCd > 0 ? `${Math.ceil(p.repairCd)}` : undefined });
        }
      } else this.drawTopBtn(ctx, bt);
    }
  }

  /** Knob of a smoke / flare button being dragged to pick the direction. */
  private drawThrowKnob(ctx: Ctx, bt: Btn, st: Stick) {
    const kl = Math.min(dist(st.pos, st.base), this.fireC.r);
    ctx.save();
    ctx.strokeStyle = 'rgba(240,240,235,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(bt.x, bt.y, this.fireC.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(240,240,235,0.75)';
    ctx.beginPath();
    ctx.arc(bt.x + Math.cos(st.ang) * kl, bt.y + Math.sin(st.ang) * kl, bt.r! * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawBanner(ctx: Ctx, W: number, H: number, title: string, sub: string, color: string, a: number, sub2?: string) {
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
    if (sub2) {
      ctx.fillStyle = '#b9d4f0';
      ctx.font = '600 13px "Barlow Condensed", sans-serif';
      ctx.fillText(sub2, W / 2, y + 44);
    }
    ctx.restore();
  }

  private drawTutorial(ctx: Ctx, W: number, H: number) {
    const a = Math.min(1, this.tutorial / 0.6, (14 - this.tutorial) / 0.4);
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    const box = (x: number, y: number, title: string, sub: string) => {
      ctx.font = '700 15px "Barlow Condensed", sans-serif';
      const w = Math.max(ctx.measureText(title).width, (ctx.font = '500 12px "Barlow Condensed", sans-serif', ctx.measureText(sub).width)) + 24;
      x = clamp(x, w / 2 + 8, W - w / 2 - 8);
      ctx.fillStyle = 'rgba(12,14,12,0.74)';
      roundRect(ctx, x - w / 2, y - 22, w, 44, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(240,180,90,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f2b449';
      ctx.font = '700 15px "Barlow Condensed", sans-serif';
      ctx.fillText(title, x, y - 7);
      ctx.fillStyle = '#e6e6dc';
      ctx.font = '500 12px "Barlow Condensed", sans-serif';
      ctx.fillText(sub, x, y + 11);
    };
    box(W * 0.24, H * 0.6, tr('◀ DRAG TO DRIVE'), tr('Push where you want to go · pull back to reverse'));
    const fc = this.fireC;
    box(fc.x - fc.r * 3.2, this.arcTop - 34, tr('DRAG THE FIRE BUTTON TO AIM'), tr('Release to fire · slide back to the centre to cancel'));
    box(fc.x - fc.r * 3.2, this.arcTop - 86, tr('BRAKE: hold to drift · SMOKE: drag to throw'), tr('+ / − zoom · zoomed in, touch the battlefield to aim precisely'));
    ctx.restore();
  }

  private drawDeath(ctx: Ctx, W: number, H: number, s: typeof this.safe) {
    const b = this.b;
    const d = this.deathInfo;
    const t = d?.t ?? 0;
    const spectating = b.availableLineup().length === 0 && t > 4;
    if (spectating) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = '600 14px "Barlow Condensed", sans-serif';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      const msg = tr('No vehicles left — spectating');
      ctx.strokeText(msg, W / 2, H - s.b - 70);
      ctx.fillStyle = '#e6e6dc';
      ctx.fillText(msg, W / 2, H - s.b - 70);
      for (const bt of this.buttons) {
        if (bt.id !== 'leave') continue;
        ctx.fillStyle = 'rgba(60,30,26,0.85)';
        roundRect(ctx, bt.x, bt.y, bt.w!, bt.h!, 5);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '600 13px "Barlow Condensed", sans-serif';
        ctx.fillText(tr('Leave battle'), bt.x + bt.w! / 2, bt.y + bt.h! / 2 + 1);
      }
      ctx.restore();
      return;
    }
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
