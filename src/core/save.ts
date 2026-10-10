// Player progress persisted in localStorage.

import { VEHICLES, getVehicle } from '../data/vehicles';
import type { Lang } from '../ui/i18n';
import { type AILevel, isAILevel } from '../game/difficulty';

export interface Settings {
  lang: Lang;
  quality: 'high' | 'low';
  volume: number;
  map: string; // 'random' or map id
  weather: string; // 'random' or weather id
  /** spoken radio callouts */
  voice: boolean;
  /** vibration feedback */
  haptics: boolean;
  /** replay of how you were knocked out */
  killcam: boolean;
  /** AI difficulty (single player, and the default for rooms you host) */
  aiLevel: AILevel;
  /** rooms you host fill empty places with AI tanks */
  mpFillAI: boolean;
}

export interface SaveData {
  version: 1;
  playerName: string;
  credits: number;
  rpFree: number;
  research: Record<string, number>;
  researched: string[];
  owned: string[];
  lineup: string[];
  researching: string | null;
  selected: string;
  settings: Settings;
  stats: { battles: number; wins: number; kills: number };
}

const KEY = 'penetration.save.v1';

function fresh(): SaveData {
  const starters = VEHICLES.filter((v) => v.starter).map((v) => v.id);
  return {
    version: 1,
    playerName: 'Commander',
    credits: 25000,
    rpFree: 0,
    research: {},
    researched: [...starters],
    owned: [...starters],
    lineup: ['m4a2', 'pz4h', 't34_41'],
    researching: null,
    selected: 'm4a2',
    settings: { lang: navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en', quality: 'high', volume: 0.8, map: 'random', weather: 'random', voice: true, haptics: true, killcam: true, aiLevel: 'normal', mpFillAI: true },
    stats: { battles: 0, wins: 0, kills: 0 },
  };
}

let data: SaveData = load();

function load(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw) as SaveData;
      const f = fresh();
      const settings = { ...f.settings, ...d.settings };
      if (!isAILevel(settings.aiLevel)) settings.aiLevel = 'normal';
      return { ...f, ...d, settings, stats: { ...f.stats, ...d.stats } };
    }
  } catch {
    /* storage unavailable */
  }
  return fresh();
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

export function get(): SaveData {
  return data;
}

export function reset() {
  data = fresh();
  save();
}

export type VState = 'owned' | 'researched' | 'researchable' | 'locked';

export function vehicleState(id: string): VState {
  if (data.owned.includes(id)) return 'owned';
  if (data.researched.includes(id)) return 'researched';
  const v = getVehicle(id);
  if (!v.prereq || data.researched.includes(v.prereq)) return 'researchable';
  return 'locked';
}

export function setResearching(id: string) {
  if (vehicleState(id) !== 'researchable') return;
  data.researching = id;
  save();
}

/** Apply battle RP: goes into the vehicle being researched, overflow to free RP. Returns unlocked id. */
export function addRP(rp: number): string | null {
  let unlocked: string | null = null;
  const id = data.researching;
  if (id && vehicleState(id) === 'researchable') {
    const v = getVehicle(id);
    const cur = data.research[id] ?? 0;
    const need = v.rp - cur;
    if (rp >= need) {
      data.research[id] = v.rp;
      data.researched.push(id);
      data.researching = null;
      data.rpFree += rp - need;
      unlocked = id;
    } else data.research[id] = cur + rp;
  } else data.rpFree += rp;
  save();
  return unlocked;
}

export function spendFreeRP(id: string): boolean {
  if (vehicleState(id) !== 'researchable' || data.rpFree <= 0) return false;
  const v = getVehicle(id);
  const cur = data.research[id] ?? 0;
  const need = v.rp - cur;
  const use = Math.min(need, data.rpFree);
  data.rpFree -= use;
  data.research[id] = cur + use;
  if (data.research[id] >= v.rp) {
    data.researched.push(id);
    if (data.researching === id) data.researching = null;
  }
  save();
  return true;
}

export function buy(id: string): boolean {
  if (vehicleState(id) !== 'researched') return false;
  const v = getVehicle(id);
  if (data.credits < v.cr) return false;
  data.credits -= v.cr;
  data.owned.push(id);
  save();
  return true;
}

export function toggleLineup(id: string): 'added' | 'removed' | 'full' | 'no' {
  if (!data.owned.includes(id)) return 'no';
  const i = data.lineup.indexOf(id);
  if (i >= 0) {
    if (data.lineup.length <= 1) return 'no';
    data.lineup.splice(i, 1);
    save();
    return 'removed';
  }
  if (data.lineup.length >= 3) return 'full';
  data.lineup.push(id);
  save();
  return 'added';
}
