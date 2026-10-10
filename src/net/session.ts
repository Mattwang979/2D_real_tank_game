// Multiplayer rooms. The host's device runs the authoritative Battle; clients run a replica
// that is driven by snapshots / effect events and send their inputs back.
//
//   HostRoom  – lobby on the host (room code, players, teams, map) → HostGame during a battle
//   ClientRoom – lobby on a client                                → ClientGame during a battle

import type { ImpactResult } from '../game/armor';
import { Battle, type BattleEvent, type NetFx, type PlayerSlot } from '../game/battle';
import { MAPS } from '../game/map';
import { isWeatherId, pickWeather } from '../game/weather';
import { type AILevel, isAILevel } from '../game/difficulty';
import { reconTotal } from '../game/support';
import { Tank } from '../game/tank';
import { audio } from '../core/audio';
import { VEHICLES, getVehicle } from '../data/vehicles';
import type { Controls } from '../ui/hud';
import { connectTo, type DataConnection, makeCode, NetError, openPeer, type Peer, PROTOCOL, ROOM_PREFIX } from './peer';
import { CARRIER_STATES, type Carrier } from '../game/carrier';
import type { CarrierState, ClientMsg, HostMsg, LobbyPlayer, MeState, NetEvent, Snapshot, TankInfo, TankState } from './protocol';
import { r2, r3 } from './protocol';

export const MAX_PLAYERS = 10;
export const TEAM_MAX = 5;
const SNAP_HZ = 12;

/** What the battle loop needs from a network session. */
export interface NetSession {
  isHost: boolean;
  controls?: Controls;
  beforeUpdate(dt: number): void;
  afterUpdate(dt: number, events: BattleEvent[]): void;
  info(): string | null;
  /** leave the running battle (host: ends it for everyone) */
  leave(): void;
}

function send(conn: DataConnection | undefined, m: HostMsg | ClientMsg) {
  if (!conn || !conn.open) return;
  try {
    conn.send(m);
  } catch {
    /* channel closing */
  }
}

function cleanName(s: unknown): string {
  const n = String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return n || 'Commander';
}

function cleanLineup(l: unknown): string[] {
  const ids = Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string' && VEHICLES.some((v) => v.id === x)) : [];
  const uniq = [...new Set(ids)].slice(0, 3);
  return uniq.length ? uniq : ['m4a2'];
}

function packRes(r: ImpactResult): ImpactResult {
  const p = (v: { x: number; y: number }) => ({ x: r2(v.x), y: r2(v.y) });
  return {
    ...r,
    entry: p(r.entry),
    dir: { x: r3(r.dir.x), y: r3(r.dir.y) },
    world: p(r.world),
    segs: r.segs.map((s) => ({ a: p(s.a), b: p(s.b), kind: s.kind })),
    blast: r.blast ? { c: p(r.blast.c), r: r2(r.blast.r) } : undefined,
    reflect: r.reflect ? { x: r3(r.reflect.x), y: r3(r.reflect.y) } : undefined,
    eff: r2(r.eff),
    pen: r2(r.pen),
    turretRel: r3(r.turretRel),
    gunRel: r3(r.gunRel),
    damage: Math.round(r.damage),
  };
}

// ====================================================================== host
export class HostRoom {
  peer: Peer;
  code: string;
  players: LobbyPlayer[];
  conns = new Map<string, DataConnection>();
  mapId: string;
  /** 'random' or a weather id */
  weather = 'random';
  /** empty places get AI tanks */
  fillAI = true;
  aiLevel: AILevel = 'normal';
  phase: 'lobby' | 'game' | 'closed' = 'lobby';
  game: HostGame | null = null;
  onChange: () => void = () => {};
  onPlayerLeft: (name: string) => void = () => {};
  private nextKey = 1;

  static async create(name: string, lineup: string[], mapId: string, weather = 'random', fillAI = true, aiLevel: AILevel = 'normal'): Promise<HostRoom> {
    let last: unknown = null;
    for (let i = 0; i < 5; i++) {
      const code = makeCode();
      try {
        const peer = await openPeer(ROOM_PREFIX + code);
        const room = new HostRoom(peer, code, name, lineup, mapId);
        room.weather = weather;
        room.fillAI = fillAI;
        room.aiLevel = isAILevel(aiLevel) ? aiLevel : 'normal';
        return room;
      } catch (e) {
        last = e;
        if (e instanceof NetError && e.kind === 'unavailable-id') continue;
        throw e;
      }
    }
    throw last;
  }

  private constructor(peer: Peer, code: string, name: string, lineup: string[], mapId: string) {
    this.peer = peer;
    this.code = code;
    this.mapId = mapId;
    this.players = [{ key: 'host', name: cleanName(name), team: 0, lineup: cleanLineup(lineup), host: true }];
    peer.on('connection', (c) => this.onConn(c));
    peer.on('disconnected', () => {
      // lost the signalling server: new players can't join until it's back (open games keep running)
      if (this.phase !== 'closed') setTimeout(() => !this.peer.destroyed && this.peer.disconnected && this.peer.reconnect(), 1500);
    });
    peer.on('error', () => {});
  }

  get count() {
    return this.players.length;
  }

  teamCount(team: 0 | 1) {
    return this.players.filter((p) => p.team === team).length;
  }

  private onConn(conn: DataConnection) {
    let key: string | null = null;
    conn.on('data', (d) => {
      const m = d as ClientMsg;
      if (!m || typeof m !== 'object') return;
      if (!key) {
        if (m.t !== 'hello') return;
        const reject = (reason: 'full' | 'started' | 'version') => {
          send(conn, { t: 'reject', reason });
          setTimeout(() => conn.close(), 500);
        };
        if (m.v !== PROTOCOL) return reject('version');
        if (this.phase !== 'lobby') return reject('started');
        if (this.players.length >= MAX_PLAYERS) return reject('full');
        key = `p${this.nextKey++}`;
        const team: 0 | 1 = this.teamCount(0) <= this.teamCount(1) ? 0 : 1;
        this.players.push({ key, name: cleanName(m.name), team, lineup: cleanLineup(m.lineup) });
        this.conns.set(key, conn);
        send(conn, { t: 'welcome', key });
        this.broadcastLobby();
        return;
      }
      this.onMsg(key, m);
    });
    const gone = () => {
      if (key) this.drop(key);
      key = null;
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  private onMsg(key: string, m: ClientMsg) {
    if (m.t === 'leave') {
      this.drop(key);
      return;
    }
    if (this.phase === 'lobby') {
      const p = this.players.find((x) => x.key === key);
      if (!p) return;
      if (m.t === 'team' && (m.team === 0 || m.team === 1) && p.team !== m.team && this.teamCount(m.team) < TEAM_MAX) {
        p.team = m.team;
        this.broadcastLobby();
      } else if (m.t === 'lineup') {
        p.lineup = cleanLineup(m.lineup);
        this.broadcastLobby();
      }
      return;
    }
    this.game?.onMsg(key, m);
  }

  drop(key: string) {
    const c = this.conns.get(key);
    if (!c) return;
    this.conns.delete(key);
    try {
      c.close();
    } catch {
      /* ignore */
    }
    const p = this.players.find((x) => x.key === key);
    this.players = this.players.filter((x) => x.key !== key);
    if (this.game) this.game.onDrop(key);
    if (p) this.onPlayerLeft(p.name);
    if (this.phase === 'lobby') this.broadcastLobby();
  }

  setMap(id: string) {
    this.mapId = id;
    this.broadcastLobby();
  }

  setWeather(id: string) {
    this.weather = isWeatherId(id) ? id : 'random';
    this.broadcastLobby();
  }

  setFillAI(on: boolean) {
    this.fillAI = on;
    this.broadcastLobby();
  }

  setAILevel(lv: AILevel) {
    this.aiLevel = isAILevel(lv) ? lv : 'normal';
    this.broadcastLobby();
  }

  /** Why the battle can't start yet (null = ready). Without AI both teams need a player. */
  startProblem(): 'teams' | null {
    if (!this.fillAI && (this.teamCount(0) === 0 || this.teamCount(1) === 0)) return 'teams';
    return null;
  }

  /** Host-side team switch (host itself or moving another player). */
  setTeam(key: string, team: 0 | 1) {
    const p = this.players.find((x) => x.key === key);
    if (!p || p.team === team || this.teamCount(team) >= TEAM_MAX) return;
    p.team = team;
    this.broadcastLobby();
  }

  setLineup(lineup: string[]) {
    this.players[0].lineup = cleanLineup(lineup);
    this.broadcastLobby();
  }

  broadcastLobby() {
    const msg: HostMsg = { t: 'lobby', players: this.players, mapId: this.mapId, code: this.code, weather: this.weather, ai: this.fillAI ? 1 : 0, lvl: this.aiLevel };
    for (const c of this.conns.values()) send(c, msg);
    this.onChange();
  }

  /** Start a battle with everyone in the lobby. */
  start(): Battle {
    this.phase = 'game';
    const mapId = this.mapId === 'random' ? MAPS[Math.floor(Math.random() * MAPS.length)].id : this.mapId;
    const seed = 1 + Math.floor(Math.random() * 1e6);
    const weather = pickWeather(this.weather);
    const slots = this.players.map((p) => ({ key: p.key, name: p.name, lineup: p.lineup, team: p.team }));
    const ai = this.fillAI ? 1 : 0;
    for (const c of this.conns.values()) send(c, { t: 'start', mapId, seed, weather, ai, lvl: this.aiLevel, slots });
    const b = new Battle({ mapId, seed, slots, localKey: 'host', mode: 'host', weather, fillAI: this.fillAI, aiLevel: this.aiLevel });
    this.game = new HostGame(this, b);
    return b;
  }

  /** Back to the lobby after a battle (players stay connected for a rematch). */
  backToLobby() {
    if (this.phase === 'closed') return;
    this.phase = 'lobby';
    this.game = null;
    this.broadcastLobby();
  }

  close() {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    for (const c of this.conns.values()) send(c, { t: 'closed' });
    const peer = this.peer;
    setTimeout(() => peer.destroy(), 400);
  }
}

class HostGame implements NetSession {
  isHost = true;
  room: HostRoom;
  b: Battle;
  private inputs = new Map<string, { th: number; st: number; hb: boolean; aim: number; at: number }>();
  private known = new Map<string, Set<number>>();
  private rwSent = new Map<string, number>();
  private statSent = new Map<string, string>();
  private evq = new Map<string, NetEvent[]>();
  private snapT = 0;
  private snapN = 0;
  private wreckSent = new Map<number, string>();
  private endSent = false;

  constructor(room: HostRoom, b: Battle) {
    this.room = room;
    this.b = b;
    b.netOut = [];
  }

  private slot(key: string): PlayerSlot | undefined {
    return this.b.slots.find((s) => s.key === key);
  }

  onMsg(key: string, m: ClientMsg) {
    const b = this.b;
    const s = this.slot(key);
    if (!s) return;
    const t = s.tank;
    switch (m.t) {
      case 'in': {
        const f = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
        this.inputs.set(key, { th: f(m.th, -1, 1), st: f(m.st, -1, 1), hb: !!m.hb, aim: typeof m.aim === 'number' && Number.isFinite(m.aim) ? m.aim : t?.aimAngle ?? 0, at: performance.now() });
        break;
      }
      case 'act': {
        if (m.a === 'spawn') {
          if (s.dead && b.time - s.deadAt > 2.3) b.respawnPlayer(String(m.id), s);
          break;
        }
        if (!t || !t.alive) break;
        if (m.a === 'fire') {
          const inp = this.inputs.get(key);
          if (inp && Number.isFinite(m.aim)) inp.aim = m.aim;
          b.requestFire(t, m.aim);
        } else if (m.a === 'cancel') t.fireReq = null;
        else if (m.a === 'shell') b.selectShell(t, Number(m.i) | 0);
        else if (m.a === 'smoke') b.useSmoke(t, Number(m.ang));
        else if (m.a === 'flare') b.useFlare(t, Number(m.ang));
        else if (m.a === 'cmd') b.radio(t, Number(m.c) | 0, m.x === undefined ? undefined : Number(m.x), m.y === undefined ? undefined : Number(m.y));
        else if (m.a === 'boost') b.useBoost(t);
        else if (m.a === 'repair') b.useRepair(t);
        else if (m.a === 'crew') b.useCrew(t);
        else if (m.a === 'recon') b.useRecon(t);
        else if (m.a === 'arty') b.useArty(t, Number(m.x), Number(m.y));
        break;
      }
      case 'ping':
        send(this.room.conns.get(key), { t: 'pong', c: m.c });
        break;
    }
  }

  onDrop(key: string) {
    const s = this.slot(key);
    if (!s || !s.connected) return;
    this.b.disconnect(key);
    this.b.emit({ type: 'notice', text: `${s.name} left the battle`, color: '#c8c8c0' });
  }

  beforeUpdate() {
    for (const s of this.b.slots) {
      if (s.key === this.b.localKey || !s.connected) continue;
      const t = s.tank;
      const inp = this.inputs.get(s.key);
      if (!t || !t.alive || !inp) continue;
      // inputs stopped arriving (app in the background, bad link): let go of the controls
      const stale = performance.now() - inp.at > 1000;
      t.throttle = stale ? 0 : inp.th;
      t.steer = stale ? 0 : inp.st;
      t.handbrake = stale ? false : inp.hb;
      t.aimAngle = inp.aim;
    }
  }

  private queue(key: string | undefined | null, e: NetEvent) {
    if (!key || key === this.b.localKey || !this.room.conns.has(key)) return;
    const q = this.evq.get(key) ?? [];
    q.push(e);
    this.evq.set(key, q);
  }
  private broadcast(e: NetEvent) {
    for (const k of this.room.conns.keys()) this.queue(k, e);
  }

  afterUpdate(dt: number, events: BattleEvent[]) {
    const b = this.b;
    for (const ev of events) {
      switch (ev.type) {
        case 'hit': {
          const ne: NetEvent = { e: 'hit', s: ev.shooter.id, tg: ev.target.id, r: packRes(ev.res) };
          const keys = new Set([ev.shooter.slot, ev.target.slot]);
          for (const k of keys) this.queue(k, ne);
          break;
        }
        case 'popup': {
          const ne: NetEvent = { e: 'pop', tx: ev.text, x: r2(ev.x), y: r2(ev.y), c: ev.color, b: ev.big ? 1 : undefined };
          if (ev.to) this.queue(ev.to, ne);
          else this.broadcast(ne);
          break;
        }
        case 'feed':
          this.broadcast({ e: 'feed', k: ev.killer?.id ?? null, v: ev.victim.id, h: ev.how });
          break;
        case 'notice': {
          const ne: NetEvent = { e: 'note', tx: ev.text, c: ev.color };
          if (ev.to) this.queue(ev.to, ne);
          else if (ev.team !== undefined) {
            for (const s of b.slots) if (s.team === ev.team) this.queue(s.key, ne);
          } else this.broadcast(ne);
          break;
        }
        case 'captured':
          this.broadcast({ e: 'cap', tm: ev.team });
          break;
        case 'playerDead':
          if (ev.to) this.queue(ev.to, { e: 'dead', k: ev.killer?.id ?? null, r: ev.res ? packRes(ev.res) : null });
          break;
        case 'radio': {
          const ne: NetEvent = { e: 'rad', f: ev.from?.id ?? null, n: ev.name, c: ev.cmd, x: ev.x === undefined ? undefined : r2(ev.x), y: ev.y === undefined ? undefined : r2(ev.y) };
          for (const s of b.slots) if (s.team === ev.team) this.queue(s.key, ne);
          break;
        }
      }
    }
    const fx: NetFx[] = b.netOut ? b.netOut.splice(0) : [];
    this.snapT -= dt;
    const ended = b.phase === 'ended';
    const snapDue = this.snapT <= 0 || (ended && !this.endSent);
    let common: Omit<Snapshot, 'me'> | null = null;
    if (snapDue) {
      this.snapT = 1 / SNAP_HZ;
      this.snapN++;
      common = this.common();
    }
    for (const [key, conn] of this.room.conns) {
      const msg: Extract<HostMsg, { t: 'u' }> = { t: 'u' };
      const n = this.newInfos(key);
      if (n.length) msg.n = n;
      if (fx.length) msg.fx = fx;
      const q = this.evq.get(key);
      if (q && q.length) {
        msg.ev = q;
        this.evq.set(key, []);
      }
      if (common) msg.s = { ...common, me: this.me(key) };
      if (msg.n || msg.fx || msg.ev || msg.s) send(conn, msg);
    }
    if (ended && !this.endSent && b.winner !== null) {
      this.endSent = true;
      for (const c of this.room.conns.values()) send(c, { t: 'end', winner: b.winner });
    }
  }

  private newInfos(key: string): TankInfo[] {
    let k = this.known.get(key);
    if (!k) {
      k = new Set();
      this.known.set(key, k);
    }
    const out: TankInfo[] = [];
    for (const t of this.b.tanks) {
      if (k.has(t.id)) continue;
      k.add(t.id);
      out.push({ id: t.id, s: t.spec.id, tm: t.team, nm: t.name, sl: t.slot, x: r2(t.pos.x), y: r2(t.pos.y), a: r3(t.ang) });
    }
    return out;
  }

  private common(): Omit<Snapshot, 'me'> {
    const b = this.b;
    const full = this.snapN % (SNAP_HZ * 2) === 0;
    const ts: TankState[] = [];
    for (const t of b.tanks) {
      if (!t.alive) {
        // wrecks only when they moved (or every couple of seconds)
        const k = `${r2(t.pos.x)},${r2(t.pos.y)},${r3(t.ang)}`;
        if (!full && this.wreckSent.get(t.id) === k) continue;
        this.wreckSent.set(t.id, k);
      }
      const flags = (t.alive ? 1 : 0) | (t.burning > 0 ? 2 : 0) | (t.boostT > 0 ? 4 : 0);
      ts.push([t.id, r2(t.pos.x), r2(t.pos.y), r3(t.ang), r3(t.turretRel), r3(t.gunRel), r2(t.speed), r2(t.vel.x), r2(t.vel.y), flags]);
    }
    const c = b.capture;
    const cv: CarrierState[] = b.carriers.map((k) => [k.id, k.team, k.forId, r2(k.pos.x), r2(k.pos.y), r3(k.ang), r2(k.speed), CARRIER_STATES.indexOf(k.state), r2(k.t), k.nation]);
    return {
      cv,
      csp: [[...b.spottedCarriers[0]], [...b.spottedCarriers[1]]],
      rc: b.recons.map((r) => [r.id, r.team, r.kind, r2(r.ex), r2(r.ey), r2(r.cx), r2(r.cy), r2(r.r), r3(r.a0), r.dir, r3(r.tin), r2(r.t)]),
      ar: b.artys.map((a) => [a.id, a.team, r2(a.x), r2(a.y), r2(a.t), ...a.times.map(r2)]),
      tm: r2(b.time),
      tk: [r2(b.tickets[0]), r2(b.tickets[1])],
      rf: [b.reinforcements[0], b.reinforcements[1]],
      cap: [c.owner, r3(c.progress), c.contested ? 1 : 0, c.inside[0], c.inside[1]],
      sp: [[...b.spotted[0]], [...b.spotted[1]]],
      t: ts,
    };
  }

  private me(key: string): MeState {
    const s = this.slot(key)!;
    const t = s.tank;
    const me: MeState = { id: t ? t.id : null, dead: s.dead ? 1 : 0, da: r2(s.deadAt), used: [...s.used] };
    if (t && t.alive) {
      me.rl = r2(t.reloadLeft);
      me.si = t.shellIdx;
      me.am = [...t.ammo];
      me.hp = t.mods.map((m) => Math.round(m.hp));
      me.ro = t.mods
        .filter((m) => m.def.kind === 'crew')
        .map((m) => m.role ?? '-')
        .join('');
      me.bn = r2(t.burning);
      me.ec = r2(t.extinguishCd);
      me.bt = r2(t.boostT);
      me.bc = r2(t.boostCd);
      me.rt = r2(t.repairT);
      me.rc = r2(t.repairCd);
      me.sc = t.smokeCharges;
      me.sd = r2(t.smokeCd);
      me.cs = r2(t.crewSwap);
      me.cr = t.pendingSwapRole;
      me.fq = t.fireReq ? 1 : 0;
      me.cc = r2(t.crewCd);
      if (this.b.weather.flares > 0) {
        me.fl = t.flareCharges;
        me.fd = r2(t.flareCd);
      }
    }
    // players keep their support in the slot
    me.su = [s.support.recon, s.support.arty, t ? t.streak : 0];
    const n = this.rwSent.get(key) ?? 0;
    if (s.rewards.length > n) {
      me.rw = s.rewards.slice(n);
      this.rwSent.set(key, s.rewards.length);
    }
    const sj = JSON.stringify(s.stats);
    if (sj !== this.statSent.get(key)) {
      me.st = { ...s.stats };
      this.statSent.set(key, sj);
    }
    return me;
  }

  info(): string | null {
    const n = this.room.conns.size;
    return `HOST · ${this.room.code} · ${n + 1}P`;
  }

  leave() {
    this.room.close();
  }
}

// ====================================================================== client
export type RejectReason = 'full' | 'started' | 'version' | 'closed' | 'lost';

export class ClientRoom {
  peer: Peer;
  conn: DataConnection;
  code: string;
  key: string | null = null;
  players: LobbyPlayer[] = [];
  mapId = 'random';
  weather = 'random';
  fillAI = true;
  aiLevel: AILevel = 'normal';
  phase: 'lobby' | 'game' | 'closed' = 'lobby';
  game: ClientGame | null = null;
  onChange: () => void = () => {};
  onStart: (g: ClientGame) => void = () => {};
  onClosed: (why: RejectReason) => void = () => {};
  private welcome: { ok: (k: string) => void; fail: (e: NetError) => void } | null = null;

  static async join(code: string, name: string, lineup: string[]): Promise<ClientRoom> {
    const peer = await openPeer();
    let conn: DataConnection;
    try {
      conn = await connectTo(peer, code);
    } catch (e) {
      peer.destroy();
      throw e;
    }
    const room = new ClientRoom(peer, conn, code);
    try {
      await room.hello(name, lineup);
    } catch (e) {
      room.dispose();
      throw e;
    }
    return room;
  }

  private constructor(peer: Peer, conn: DataConnection, code: string) {
    this.peer = peer;
    this.conn = conn;
    this.code = code;
    conn.on('data', (d) => this.onMsg(d as HostMsg));
    conn.on('close', () => this.lost());
    conn.on('error', () => this.lost());
    peer.on('error', () => {});
  }

  private hello(name: string, lineup: string[]): Promise<string> {
    return new Promise((ok, fail) => {
      const to = setTimeout(() => fail(new NetError('timeout', 'No answer from the room')), 10000);
      this.welcome = {
        ok: (k) => {
          clearTimeout(to);
          ok(k);
        },
        fail: (e) => {
          clearTimeout(to);
          fail(e);
        },
      };
      send(this.conn, { t: 'hello', v: PROTOCOL, name, lineup });
    });
  }

  private onMsg(m: HostMsg) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'welcome':
        this.key = m.key;
        this.welcome?.ok(m.key);
        this.welcome = null;
        break;
      case 'reject':
        this.welcome?.fail(new NetError(m.reason));
        this.welcome = null;
        break;
      case 'lobby':
        this.players = m.players;
        this.mapId = m.mapId;
        this.weather = isWeatherId(m.weather) ? m.weather : 'random';
        this.fillAI = m.ai !== 0;
        this.aiLevel = isAILevel(m.lvl) ? m.lvl : 'normal';
        this.onChange();
        break;
      case 'start':
        if (!this.key) return;
        this.phase = 'game';
        this.game = new ClientGame(this, new Battle({ mapId: m.mapId, seed: m.seed, slots: m.slots, localKey: this.key, mode: 'replica', weather: isWeatherId(m.weather) ? m.weather : 'clear', fillAI: m.ai !== 0, aiLevel: isAILevel(m.lvl) ? m.lvl : 'normal' }));
        this.onStart(this.game);
        break;
      case 'closed':
        this.close('closed');
        break;
      default:
        this.game?.onMsg(m);
    }
  }

  private lost() {
    if (this.phase === 'closed') return;
    this.close('lost');
  }

  private close(why: RejectReason) {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.game?.hostGone();
    this.onClosed(why);
    this.dispose();
  }

  setTeam(team: 0 | 1) {
    send(this.conn, { t: 'team', team });
  }
  setLineup(lineup: string[]) {
    send(this.conn, { t: 'lineup', lineup });
  }
  sendMsg(m: ClientMsg) {
    send(this.conn, m);
  }

  backToLobby() {
    if (this.phase === 'closed') return;
    this.phase = 'lobby';
    this.game = null;
    this.onChange();
  }

  leave() {
    if (this.phase === 'closed') return;
    send(this.conn, { t: 'leave' });
    this.phase = 'closed';
    setTimeout(() => this.dispose(), 300);
  }

  private dispose() {
    try {
      this.conn.close();
    } catch {
      /* ignore */
    }
    if (!this.peer.destroyed) this.peer.destroy();
  }
}

export class ClientGame implements NetSession {
  isHost = false;
  room: ClientRoom;
  b: Battle;
  controls: Controls;
  ready: Promise<void>;
  private readyOk: () => void = () => {};
  private byId = new Map<number, Tank>();
  private rtt = 120;
  private lat = 0.06;
  private inT = 0;
  private pingT = 0;
  private fireSentAt = 0;
  private lastMsg = performance.now();
  private planes = new Set<number>();
  gone = false;

  constructor(room: ClientRoom, b: Battle) {
    this.room = room;
    this.b = b;
    this.ready = new Promise((ok) => (this.readyOk = ok));
    const me = () => (b.player && b.player.alive ? b.player : null);
    const act = (m: ClientMsg) => room.sendMsg(m);
    this.controls = {
      fire: (aim) => {
        this.fireSentAt = performance.now();
        act({ t: 'act', a: 'fire', aim: Math.round(aim * 1e4) / 1e4 });
      },
      cancelFire: () => {
        const p = me();
        if (p) p.fireReq = null;
        act({ t: 'act', a: 'cancel' });
      },
      shell: (i) => {
        me()?.selectShell(i);
        act({ t: 'act', a: 'shell', i });
      },
      smoke: (ang) => act({ t: 'act', a: 'smoke', ang: r3(ang) }),
      flare: (ang) => act({ t: 'act', a: 'flare', ang: r3(ang) }),
      boost: () => act({ t: 'act', a: 'boost' }),
      repair: () => act({ t: 'act', a: 'repair' }),
      crew: () => act({ t: 'act', a: 'crew' }),
      radio: (c, x, y) => act({ t: 'act', a: 'cmd', c, x: x === undefined ? undefined : r2(x), y: y === undefined ? undefined : r2(y) }),
      recon: () => act({ t: 'act', a: 'recon' }),
      arty: (x, y) => act({ t: 'act', a: 'arty', x: r2(x), y: r2(y) }),
      respawn: (id) => act({ t: 'act', a: 'spawn', id }),
    };
  }

  onMsg(m: HostMsg) {
    const b = this.b;
    this.lastMsg = performance.now();
    if (m.t === 'u') {
      if (m.n) for (const i of m.n) this.addTank(i);
      if (m.s) this.applySnap(m.s);
      if (m.fx) for (const f of m.fx) b.applyFx(f);
      if (m.ev) {
        for (const e of m.ev) {
          const ev = this.toEvent(e);
          if (ev) b.events.push(ev);
        }
      }
    } else if (m.t === 'end') {
      b.winner = m.winner;
      b.phase = 'ended';
      b.events.push({ type: 'end' });
    } else if (m.t === 'pong') {
      const rtt = performance.now() - m.c;
      this.rtt = this.rtt * 0.7 + rtt * 0.3;
      this.lat = Math.min(0.25, this.rtt / 2000);
    }
  }

  /** The host disappeared mid-battle. */
  hostGone() {
    this.gone = true;
    const b = this.b;
    if (b.phase !== 'ended') {
      b.events.push({ type: 'notice', text: 'Connection to the host lost', color: '#ff8a5c' });
      b.winner = b.playerTeam === 0 ? 1 : 0;
      b.phase = 'ended';
    }
  }

  private addTank(i: TankInfo) {
    if (this.byId.has(i.id)) return;
    const t = new Tank(getVehicle(i.s), i.tm, { x: i.x, y: i.y }, i.a, i.nm);
    t.id = i.id;
    this.b.equip(t);
    t.slot = i.sl;
    t.isPlayer = !!i.sl && i.sl === this.b.localKey;
    this.b.tanks.push(t);
    this.byId.set(t.id, t);
  }

  private applySnap(s: Snapshot) {
    const b = this.b;
    const lat = this.lat;
    b.time = s.tm + lat;
    b.tickets = s.tk;
    b.reinforcements = s.rf;
    b.capture.owner = s.cap[0] as -1 | 0 | 1;
    b.capture.progress = s.cap[1];
    b.capture.contested = !!s.cap[2];
    b.capture.inside = [s.cap[3], s.cap[4]];
    b.spotted[0] = new Set(s.sp[0]);
    b.spotted[1] = new Set(s.sp[1]);
    this.syncCarriers(s);
    const meTank = s.me.id !== null ? this.byId.get(s.me.id) : undefined;
    for (const st of s.t) {
      const t = this.byId.get(st[0]);
      if (!t) continue;
      const alive = (st[9] & 1) === 1;
      if (!alive && t.alive) {
        t.alive = false;
        t.deathTime = b.time;
      }
      if (t !== meTank) {
        t.burning = st[9] & 2 ? Math.max(t.burning, 0.5) : 0;
        t.boostT = st[9] & 4 ? Math.max(t.boostT, 0.3) : 0;
      }
      if (!alive) {
        t.pos.x = st[1];
        t.pos.y = st[2];
        t.ang = st[3];
        t.net = null;
        continue;
      }
      const n = t.net ?? (t.net = { x: 0, y: 0, ang: 0, tRel: 0, gRel: 0, speed: 0, vx: 0, vy: 0 });
      n.x = st[1] + st[7] * lat;
      n.y = st[2] + st[8] * lat;
      n.ang = st[3];
      n.tRel = st[4];
      n.gRel = st[5];
      n.speed = st[6];
      n.vx = st[7];
      n.vy = st[8];
    }
    // our own slot
    const me = s.me;
    const slot = b.local;
    if (!slot) return;
    slot.dead = !!me.dead;
    slot.deadAt = me.da;
    slot.used = new Set(me.used);
    if (meTank) {
      if (slot.tank !== meTank) {
        // freshly (re)spawned: start exactly at the host position
        meTank.isPlayer = true;
        slot.tank = meTank;
        const st = s.t.find((x) => x[0] === meTank.id);
        if (st) {
          meTank.pos = { x: st[1], y: st[2] };
          meTank.ang = st[3];
          meTank.aimAngle = st[3] + st[4] + st[5];
          meTank.turretRel = st[4];
        }
      }
      const t = meTank;
      if (t.alive && me.rl !== undefined) {
        t.reloadLeft = Math.max(0, me.rl - lat);
        t.shellIdx = me.si ?? t.shellIdx;
        if (me.am) t.ammo = me.am;
        if (me.hp) me.hp.forEach((hp, i) => t.mods[i] && (t.mods[i].hp = hp));
        if (me.ro) {
          let k = 0;
          for (const m of t.mods) {
            if (m.def.kind !== 'crew') continue;
            const r = me.ro[k++];
            if (r && r !== '-') m.role = r as typeof m.role;
          }
        }
        t.burning = me.bn ?? 0;
        t.extinguishCd = me.ec ?? 0;
        t.boostT = me.bt ?? 0;
        t.boostCd = me.bc ?? 0;
        t.repairT = me.rt ?? 0;
        t.repairCd = me.rc ?? 0;
        t.smokeCharges = me.sc ?? t.smokeCharges;
        t.smokeCd = me.sd ?? 0;
        t.crewSwap = me.cs ?? 0;
        t.pendingSwapRole = (me.cr ?? null) as typeof t.pendingSwapRole;
        if (!me.fq && t.fireReq && performance.now() - this.fireSentAt > this.rtt + 150) t.fireReq = null;
        t.crewCd = me.cc ?? 0;
        if (me.fl !== undefined) t.flareCharges = me.fl;
        t.flareCd = me.fd ?? 0;
      }
    }
    if (me.su) {
      slot.support.recon = me.su[0];
      slot.support.arty = me.su[1];
      if (slot.tank) slot.tank.streak = me.su[2];
    }
    b.recons = (s.rc ?? []).map((r) => ({ id: r[0], team: r[1] as 0 | 1, kind: r[2] | 0, ex: r[3], ey: r[4], cx: r[5], cy: r[6], r: r[7], a0: r[8], dir: r[9] < 0 ? -1 : 1, tin: r[10], t: r[11] + lat }));
    b.artys = (s.ar ?? []).map((a) => ({ id: a[0], team: a[1] as 0 | 1, by: -1, x: a[2], y: a[3], t: a[4] + lat, times: a.slice(5), fired: 0, whistled: 0 }));
    for (const r of b.recons) if (!this.planes.has(r.id)) {
      this.planes.add(r.id);
      audio.plane(Math.max(1, reconTotal(r) - r.t), 0.1);
    }
    if (me.rw) slot.rewards.push(...me.rw);
    if (me.st) slot.stats = me.st;
    if (slot.tank) this.readyOk();
  }

  private syncCarriers(s: Snapshot) {
    const b = this.b;
    const lat = this.lat;
    const keep: Carrier[] = [];
    for (const v of s.cv ?? []) {
      const [id, team, forId, x, y, ang, speed, st, t, nation] = v;
      let c = b.carriers.find((k) => k.id === id);
      const state = CARRIER_STATES[st] ?? 'drive';
      if (!c) {
        c = { id, team: team as 0 | 1, forId, nation, pos: { x, y }, ang, speed, path: [], state, t, home: { x, y }, repath: 0, age: 0 };
      }
      c.state = state;
      c.t = t;
      c.speed = state === 'dead' ? 0 : speed;
      c.net = { x: x + Math.cos(ang) * c.speed * lat, y: y + Math.sin(ang) * c.speed * lat, ang };
      if (state === 'dead') c.pos = { x, y };
      keep.push(c);
    }
    b.carriers = keep;
    b.spottedCarriers[0] = new Set(s.csp?.[0] ?? []);
    b.spottedCarriers[1] = new Set(s.csp?.[1] ?? []);
  }

  private tank(id: number | null): Tank | null {
    return id === null ? null : this.byId.get(id) ?? null;
  }

  private toEvent(e: NetEvent): BattleEvent | null {
    switch (e.e) {
      case 'hit': {
        const s = this.tank(e.s);
        const tg = this.tank(e.tg);
        return s && tg ? { type: 'hit', res: e.r, shooter: s, target: tg } : null;
      }
      case 'pop':
        return { type: 'popup', text: e.tx, x: e.x, y: e.y, color: e.c, big: !!e.b };
      case 'feed': {
        const v = this.tank(e.v);
        return v ? { type: 'feed', killer: this.tank(e.k), victim: v, how: e.h } : null;
      }
      case 'note':
        return { type: 'notice', text: e.tx, color: e.c };
      case 'cap':
        return { type: 'captured', team: e.tm };
      case 'dead':
        return { type: 'playerDead', killer: this.tank(e.k), res: e.r };
      case 'rad':
        return { type: 'radio', from: this.tank(e.f), name: String(e.n ?? ''), team: this.b.playerTeam, cmd: Number(e.c) | 0, x: e.x, y: e.y };
    }
    return null;
  }

  beforeUpdate(dt: number) {
    if (this.gone) return;
    this.inT -= dt;
    this.pingT -= dt;
    const p = this.b.player;
    if (this.inT <= 0 && p && p.alive) {
      this.inT = 0.05;
      this.room.sendMsg({ t: 'in', th: r3(p.throttle), st: r3(p.steer), hb: p.handbrake ? 1 : 0, aim: Math.round(p.aimAngle * 1e4) / 1e4 });
    }
    if (this.pingT <= 0) {
      this.pingT = 1;
      this.room.sendMsg({ t: 'ping', c: performance.now() });
    }
  }

  afterUpdate() {}

  info(): string | null {
    if (this.gone) return '⚠ OFFLINE';
    if (performance.now() - this.lastMsg > 2500) return '⚠ HOST NOT RESPONDING';
    return `${Math.round(this.rtt)} ms`;
  }

  leave() {
    this.room.leave();
  }
}
