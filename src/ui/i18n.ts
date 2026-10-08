// Minimal EN / 繁體中文 localisation. English is the default (matches the original look);
// Traditional Chinese can be selected in Settings.

export type Lang = 'en' | 'zh';
let lang: Lang = 'en';

export function setLang(l: Lang) {
  lang = l;
  document.documentElement.lang = l === 'zh' ? 'zh-Hant' : 'en';
}
export function getLang(): Lang {
  return lang;
}

const ZH: Record<string, string> = {
  // HUD / battle
  'Target destroyed': '擊毀目標',
  'Critical hit': '致命命中',
  Hit: '命中',
  Assist: '助攻',
  'Point captured': '佔領據點',
  Ricochet: '跳彈',
  'Non-penetration': '未擊穿',
  'Point A captured': '已佔領 A 點',
  'Point A lost': 'A 點失守',
  'Point A neutralized': 'A 點已中立',
  CONTESTED: '爭奪中',
  FIRE: '開火',
  BURNING: '起火中',
  SPOTTED: '被發現',
  DESTROYED: '已被擊毀',
  by: '擊毀者',
  'TAP TO DEPLOY': '點擊出擊',
  'Leave battle': '離開戰鬥',
  'No vehicles left — spectating': '沒有可用載具 — 觀戰中',
  'RICOCHET LIKELY': '可能跳彈',
  EFF: '等效',
  PEN: '穿深',
  'Fire extinguished': '火已撲滅',
  'Fire burned out': '火已熄滅',
  'Fire!': '起火！',
  'Ammo detonation': '彈藥殉爆',
  Overpressure: '超壓',
  'Upper front plate': '上首上',
  'Lower front plate': '下首下',
  'Hull side': '車體側面',
  'Hull rear': '車體後方',
  'Turret front': '砲塔正面',
  'Turret side': '砲塔側面',
  'Turret rear': '砲塔後方',
  'Gun mantlet': '砲盾',
  'Superstructure front': '戰鬥室正面',
  'Superstructure side': '戰鬥室側面',
  'Superstructure rear': '戰鬥室後方',
  // hangar
  BATTLE: '出擊',
  'TECH TREE': '科技樹',
  Exterior: '外觀',
  Armor: '裝甲',
  'X-Ray': 'X 光',
  Firepower: '火力',
  Mobility: '機動',
  Survivability: '防護',
  Penetration: '穿深',
  Reload: '裝填',
  'Hull front': '車體正面',
  'Top speed': '極速',
  'Power/weight': '推重比',
  Crew: '乘員',
  Lineup: '出戰陣容',
  'Add vehicle': '加入載具',
  Map: '地圖',
  Random: '隨機',
  'Green Valley': '綠色山谷',
  'Desert Outpost': '沙漠前哨',
  'Old Town': '舊城區',
  Settings: '設定',
  Language: '語言',
  Graphics: '畫質',
  High: '高',
  Low: '低',
  Volume: '音量',
  'Reset progress': '重置進度',
  Close: '關閉',
  Owned: '已擁有',
  'IN LINEUP': '出戰中',
  Research: '研發',
  Researching: '研發中',
  'Use free RP': '使用自由 RP',
  Buy: '購買',
  'Add to lineup': '加入陣容',
  'Remove from lineup': '移出陣容',
  'View in hangar': '在車庫查看',
  Locked: '未解鎖',
  'Research the previous vehicle first': '請先研發前一台載具',
  Researched: '已研發',
  'Not enough credits': '銀幣不足',
  'Lineup is full (3)': '陣容已滿（3 台）',
  TIER: '階級',
  Back: '返回',
  VICTORY: '勝利',
  DEFEAT: '戰敗',
  Continue: '繼續',
  Kills: '擊毀',
  Assists: '助攻',
  Hits: '命中',
  Captures: '佔領',
  Shots: '射擊',
  Total: '合計',
  'Research progress': '研發進度',
  'unlocked!': '已解鎖！',
  'TAP TO START': '點擊開始',
  'Rotate your device to landscape': '請將手機轉為橫向',
  Resume: '繼續',
  Sound: '音效',
  On: '開',
  Off: '關',
  Paused: '暫停',
  'Free RP': '自由 RP',
  'Light tank': '輕型坦克',
  'Medium tank': '中型坦克',
  'Heavy tank': '重型坦克',
  'Tank destroyer': '驅逐戰車',
  'Armoured car': '裝甲車',
  'Select a vehicle': '選擇載具',
  'Battle rating': '戰鬥等級',
  'Shells': '彈種',
  'Player name': '玩家名稱',
  'Are you sure?': '確定嗎？',
  'Loading': '載入中',
  'Deploy': '出擊',
  'KNOCKED OUT': '已被擊毀',
  '◀ DRAG TO DRIVE': '◀ 拖曳移動',
  'Push where you want to go · pull back to reverse': '往要去的方向推 · 往後拉倒車',
  'DRAG TO AIM ▶': '拖曳瞄準 ▶',
  'Release to fire · tap to fire': '放開開火 · 點一下也能開火',
  'Capture point A': '佔領 A 點',
  'Green reticle = will penetrate': '準星綠色＝打得穿',
};

export function t(s: string): string {
  if (lang === 'zh') {
    if (ZH[s]) return ZH[s];
    // composed module messages, e.g. "Engine destroyed"
    const m = s.match(/^(.*) (destroyed|damaged|knocked out|wounded)$/);
    if (m) {
      const part = MOD_ZH[m[1]] ?? m[1];
      const st = { destroyed: '損毀', damaged: '受損', 'knocked out': '陣亡', wounded: '受傷' }[m[2]];
      return `${part}${st}`;
    }
  }
  return s;
}

const MOD_ZH: Record<string, string> = {
  Engine: '引擎',
  Transmission: '變速箱',
  'Fuel tank': '油箱',
  'Ammo rack': '彈藥架',
  Breech: '砲閂',
  'Gun barrel': '砲管',
  Track: '履帶',
  Wheels: '車輪',
  Driver: '駕駛',
  'Radio operator': '無線電員',
  Gunner: '砲手',
  Commander: '車長',
  Loader: '裝填手',
};
