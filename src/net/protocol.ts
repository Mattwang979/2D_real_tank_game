// Wire format between the room host and clients (JSON over a reliable WebRTC data channel).

import type { ImpactResult } from '../game/armor';
import type { NetFx, RewardLine, SlotStats } from '../game/battle';

export interface LobbyPlayer {
  key: string;
  name: string;
  team: 0 | 1;
  lineup: string[];
  host?: boolean;
}

/** Tank creation info (sent once per tank to each client). */
export interface TankInfo {
  id: number;
  s: string; // vehicle id
  tm: 0 | 1;
  nm: string;
  sl: string | null; // player slot
  x: number;
  y: number;
  a: number;
}

/** [id, x, y, ang, turretRel, gunRel, speed, vx, vy, flags] — flags: 1 alive · 2 burning · 4 boosting */
export type TankState = [number, number, number, number, number, number, number, number, number, number];

/** Detailed state of the receiving player's own slot / tank. */
export interface MeState {
  id: number | null;
  dead: number;
  da: number; // deadAt
  used: string[];
  rl?: number; // reload left
  si?: number; // selected shell
  am?: number[]; // ammo
  hp?: number[]; // module hp
  ro?: string; // crew roles (crew modules in order)
  bn?: number; // burning
  ec?: number; // extinguisher cooldown
  bt?: number; // boost time
  bc?: number; // boost cooldown
  rt?: number; // repair time
  rc?: number; // repair cooldown
  sc?: number; // smoke charges
  sd?: number; // smoke cooldown
  cs?: number; // crew swap timer
  cr?: string | null; // pending swap role
  fq?: number; // queued shot
  rw?: RewardLine[]; // new reward lines since the last snapshot
  st?: SlotStats;
}

export interface Snapshot {
  tm: number; // battle time
  tk: [number, number];
  rf: [number, number];
  cap: [number, number, number, number, number]; // owner, progress, contested, inside0, inside1
  sp: [number[], number[]];
  t: TankState[];
  me: MeState;
}

export type NetEvent =
  | { e: 'hit'; s: number; tg: number; r: ImpactResult }
  | { e: 'pop'; tx: string; x: number; y: number; c: string; b?: number }
  | { e: 'feed'; k: number | null; v: number; h: string }
  | { e: 'note'; tx: string; c?: string }
  | { e: 'cap'; tm: 0 | 1 }
  | { e: 'dead'; k: number | null; r: ImpactResult | null };

export type HostMsg =
  | { t: 'welcome'; key: string }
  | { t: 'reject'; reason: 'full' | 'started' | 'version' }
  | { t: 'lobby'; players: LobbyPlayer[]; mapId: string; code: string }
  | { t: 'start'; mapId: string; seed: number; slots: Array<{ key: string; name: string; lineup: string[]; team: 0 | 1 }> }
  | { t: 'u'; n?: TankInfo[]; s?: Snapshot; fx?: NetFx[]; ev?: NetEvent[] }
  | { t: 'end'; winner: 0 | 1 }
  | { t: 'pong'; c: number }
  | { t: 'closed' };

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; lineup: string[] }
  | { t: 'team'; team: 0 | 1 }
  | { t: 'lineup'; lineup: string[] }
  | { t: 'in'; th: number; st: number; hb: number; aim: number }
  | { t: 'act'; a: 'fire'; aim: number }
  | { t: 'act'; a: 'cancel' | 'boost' | 'repair' }
  | { t: 'act'; a: 'shell'; i: number }
  | { t: 'act'; a: 'smoke'; ang: number }
  | { t: 'act'; a: 'spawn'; id: string }
  | { t: 'ping'; c: number }
  | { t: 'leave' };

export const r2 = (v: number) => Math.round(v * 100) / 100;
export const r3 = (v: number) => Math.round(v * 1000) / 1000;
