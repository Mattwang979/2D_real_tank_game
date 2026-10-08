// Vehicle database. Armor/penetration values are approximations of historical data
// (thickness in mm, slope in degrees from vertical; penetration in mm vs 0° plate at 0/500/1000 m).

export type Nation = 'usa' | 'germany' | 'ussr';
export type VClass = 'light' | 'medium' | 'heavy' | 'td' | 'ac';
export type ShellType = 'AP' | 'APHE' | 'APCR' | 'HE';
export type CrewRole = 'D' | 'R' | 'G' | 'C' | 'L';

export interface ShellSpec {
  name: string;
  type: ShellType;
  pen: [number, number, number];
  velocity: number; // m/s (real)
  explosive: number; // g TNT eq.
  caliber: number; // mm
  count: number; // rounds carried
}

export interface GunSpec {
  name: string;
  caliber: number;
  reload: number; // s
  dispersion: number; // deg (1 sigma) at rest
  shells: ShellSpec[];
}

export interface Plate {
  t: number;
  s: number;
}

export interface ArmorSpec {
  ufp: Plate;
  lfp: Plate;
  side: Plate;
  rear: Plate;
  tFront: Plate;
  tSide: Plate;
  tRear: Plate;
  mantlet: Plate;
  roof: number;
  skirts?: number; // spaced side skirts thickness (mm)
  openTop?: boolean;
}

export interface Palette {
  base: string;
  light: string;
  dark: string;
  line: string;
}

export type TurretShape = 'round' | 'box' | 'tiger' | 'panther' | 'hex' | 'pent' | 'dome' | 'small' | 'casemate';

export interface TurretLook {
  shape: TurretShape;
  x: number; // turret ring / casemate centre along hull (m, +forward)
  len: number;
  wid: number;
  ox?: number; // polygon centre offset from ring (m, +forward)
  frontW?: number; // front width fraction for trapezoid shapes
  bustle?: number; // rear bustle (m)
  cupola: { x: number; y: number; r: number };
  hatch?: { x: number; y: number; r: number };
  gunPivot?: number; // casemate: gun pivot x in turret frame
  extra?: Array<'schurzen' | 'vent' | 'counterweight' | 'bustleRack' | 'periscopes' | 'stowage' | 'smoke'>;
}

export interface Look {
  L: number;
  W: number;
  trackW: number;
  wheels?: number; // armoured car: wheels per side
  fender: number; // how much the deck overhangs the tracks
  nose: 'flat' | 'chamfer' | 'round' | 'sloped' | 'pike' | 'step';
  noseLen: number;
  chamfer: number;
  rearChamfer: number;
  engineDeck: number;
  grille: 'slats' | 'mesh' | 'twin' | 'louvre' | 'fans';
  turret: TurretLook;
  gunLen: number;
  gunW: number;
  brake: 'none' | 'double' | 'single' | 'is';
  mantlet: 'box' | 'round' | 'saukopf' | 'curved';
  mantletW: number;
  mantletL: number;
  colors: Palette;
  camo?: 'stripes' | 'blotch';
  skirts?: boolean;
  spareTracks?: 'glacis' | 'sides' | 'none';
  sandshields?: boolean;
  fuelDrums?: boolean;
  exhaust?: 'rear2' | 'rearBox' | 'side';
  fumeExtractor?: boolean;
}

export interface LayoutSpec {
  trans: 'front' | 'rear';
  fuel: 'sides' | 'rear' | 'front' | 'mid';
  ammo: Array<'sponson' | 'floor' | 'bustle' | 'front' | 'casemate' | 'rear' | 'turretSides'>;
  engineLen: number;
}

export interface VehicleSpec {
  id: string;
  name: string;
  nation: Nation;
  cls: VClass;
  br: number;
  tier: 1 | 2 | 3;
  row: number;
  prereq: string | null;
  rp: number;
  cr: number;
  starter?: boolean;
  weight: number; // t
  hp: number; // engine hp
  speed: number; // km/h
  reverse: number; // km/h
  traverse: number; // turret deg/s (casemate gun traverse)
  gunArc?: number; // casemate traverse limit ±deg
  gun: GunSpec;
  crew: CrewRole[];
  armor: ArmorSpec;
  look: Look;
  layout: LayoutSpec;
  year: number;
}

const P = (t: number, s = 0): Plate => ({ t, s });

const PAL = {
  usa: { base: '#5d6339', light: '#7b8251', dark: '#3c4024', line: '#23261a' },
  ussr: { base: '#53613b', light: '#6f7e50', dark: '#344026', line: '#1d2515' },
  gerY: { base: '#a69462', light: '#c6b482', dark: '#776940', line: '#3a3321' },
  gerG: { base: '#5c6164', light: '#7a7f82', dark: '#3e4244', line: '#222426' },
};

// ---- Shell presets -------------------------------------------------------
const S = {
  m61: (n: number): ShellSpec => ({ name: 'M61 APCBC', type: 'APHE', pen: [104, 92, 81], velocity: 618, explosive: 63, caliber: 75, count: n }),
  m72: (n: number): ShellSpec => ({ name: 'M72 AP', type: 'AP', pen: [91, 77, 64], velocity: 619, explosive: 0, caliber: 75, count: n }),
  m48: (n: number): ShellSpec => ({ name: 'M48 HE', type: 'HE', pen: [10, 10, 10], velocity: 463, explosive: 680, caliber: 75, count: n }),
  m62: (n: number): ShellSpec => ({ name: 'M62 APCBC', type: 'APHE', pen: [127, 117, 106], velocity: 792, explosive: 63, caliber: 76, count: n }),
  m79: (n: number): ShellSpec => ({ name: 'M79 AP', type: 'AP', pen: [128, 109, 92], velocity: 792, explosive: 0, caliber: 76, count: n }),
  m93: (n: number): ShellSpec => ({ name: 'M93 HVAP', type: 'APCR', pen: [208, 177, 148], velocity: 1036, explosive: 0, caliber: 76, count: n }),
  m42: (n: number): ShellSpec => ({ name: 'M42A1 HE', type: 'HE', pen: [11, 11, 11], velocity: 800, explosive: 390, caliber: 76, count: n }),
  m82: (n: number): ShellSpec => ({ name: 'M82 APCBC', type: 'APHE', pen: [165, 153, 140], velocity: 853, explosive: 137, caliber: 90, count: n }),
  m304: (n: number): ShellSpec => ({ name: 'M304 HVAP', type: 'APCR', pen: [260, 221, 186], velocity: 1021, explosive: 0, caliber: 90, count: n }),
  m71: (n: number): ShellSpec => ({ name: 'M71 HE', type: 'HE', pen: [15, 15, 15], velocity: 823, explosive: 952, caliber: 90, count: n }),
  // German
  pzgr39_50: (n: number): ShellSpec => ({ name: 'PzGr 39', type: 'APHE', pen: [87, 72, 58], velocity: 835, explosive: 16, caliber: 50, count: n }),
  pzgr40_50: (n: number): ShellSpec => ({ name: 'PzGr 40/1', type: 'APCR', pen: [130, 90, 59], velocity: 1180, explosive: 0, caliber: 50, count: n }),
  sprgr50: (n: number): ShellSpec => ({ name: 'Sprgr 38', type: 'HE', pen: [6, 6, 6], velocity: 550, explosive: 180, caliber: 50, count: n }),
  pzgr39_75: (n: number): ShellSpec => ({ name: 'PzGr 39', type: 'APHE', pen: [135, 119, 103], velocity: 790, explosive: 29, caliber: 75, count: n }),
  pzgr40_75: (n: number): ShellSpec => ({ name: 'PzGr 40', type: 'APCR', pen: [171, 136, 103], velocity: 990, explosive: 0, caliber: 75, count: n }),
  sprgr75: (n: number): ShellSpec => ({ name: 'Sprgr 34', type: 'HE', pen: [10, 10, 10], velocity: 550, explosive: 686, caliber: 75, count: n }),
  pzgr3942: (n: number): ShellSpec => ({ name: 'PzGr 39/42', type: 'APHE', pen: [192, 175, 158], velocity: 925, explosive: 29, caliber: 75, count: n }),
  pzgr4042: (n: number): ShellSpec => ({ name: 'PzGr 40/42', type: 'APCR', pen: [257, 216, 172], velocity: 1120, explosive: 0, caliber: 75, count: n }),
  sprgr42: (n: number): ShellSpec => ({ name: 'Sprgr 42', type: 'HE', pen: [10, 10, 10], velocity: 700, explosive: 725, caliber: 75, count: n }),
  pzgr39_88: (n: number): ShellSpec => ({ name: 'PzGr 39', type: 'APHE', pen: [171, 157, 142], velocity: 773, explosive: 109, caliber: 88, count: n }),
  pzgr40_88: (n: number): ShellSpec => ({ name: 'PzGr 40', type: 'APCR', pen: [216, 180, 145], velocity: 930, explosive: 0, caliber: 88, count: n }),
  sprgr88: (n: number): ShellSpec => ({ name: 'Sprgr L/4.5', type: 'HE', pen: [13, 13, 13], velocity: 820, explosive: 900, caliber: 88, count: n }),
  // Soviet
  br350a: (n: number): ShellSpec => ({ name: 'BR-350A', type: 'APHE', pen: [79, 71, 62], velocity: 662, explosive: 155, caliber: 76, count: n }),
  br350p: (n: number): ShellSpec => ({ name: 'BR-350P', type: 'APCR', pen: [124, 82, 54], velocity: 950, explosive: 0, caliber: 76, count: n }),
  of350: (n: number): ShellSpec => ({ name: 'OF-350M', type: 'HE', pen: [11, 11, 11], velocity: 680, explosive: 621, caliber: 76, count: n }),
  br365: (n: number): ShellSpec => ({ name: 'BR-365', type: 'APHE', pen: [145, 128, 111], velocity: 792, explosive: 48, caliber: 85, count: n }),
  br365p: (n: number): ShellSpec => ({ name: 'BR-365P', type: 'APCR', pen: [194, 150, 115], velocity: 1050, explosive: 0, caliber: 85, count: n }),
  o365: (n: number): ShellSpec => ({ name: 'O-365K', type: 'HE', pen: [15, 15, 15], velocity: 793, explosive: 741, caliber: 85, count: n }),
  br471: (n: number): ShellSpec => ({ name: 'BR-471', type: 'APHE', pen: [175, 163, 151], velocity: 795, explosive: 156, caliber: 122, count: n }),
  br471b: (n: number): ShellSpec => ({ name: 'BR-471B', type: 'APHE', pen: [205, 192, 178], velocity: 795, explosive: 156, caliber: 122, count: n }),
  of471: (n: number): ShellSpec => ({ name: 'OF-471', type: 'HE', pen: [30, 30, 30], velocity: 800, explosive: 3600, caliber: 122, count: n }),
};

export const VEHICLES: VehicleSpec[] = [
  // ======================= USA =======================
  {
    id: 'm24', name: 'M24 Chaffee', nation: 'usa', cls: 'light', br: 2.7, tier: 1, row: 1, prereq: null, rp: 0, cr: 0, starter: true, year: 1944,
    weight: 18.4, hp: 220, speed: 56, reverse: 15, traverse: 24,
    gun: { name: '75 mm M6', caliber: 75, reload: 6.0, dispersion: 0.3, shells: [S.m61(32), S.m72(10), S.m48(14)] },
    crew: ['D', 'R', 'G', 'C', 'L'],
    armor: { ufp: P(25, 60), lfp: P(25, 45), side: P(19, 12), rear: P(19, 0), tFront: P(38, 20), tSide: P(25, 20), tRear: P(25, 0), mantlet: P(38, 0), roof: 13 },
    look: {
      L: 5.03, W: 2.95, trackW: 0.42, fender: 0.3, nose: 'sloped', noseLen: 1.0, chamfer: 0.15, rearChamfer: 0.1, engineDeck: 1.7, grille: 'mesh',
      turret: { shape: 'round', x: 0.35, len: 2.25, wid: 2.0, ox: -0.12, bustle: 0.25, cupola: { x: -0.55, y: 0.45, r: 0.32 }, hatch: { x: -0.45, y: -0.5, r: 0.28 }, extra: ['vent'] },
      gunLen: 2.5, gunW: 0.13, brake: 'none', mantlet: 'box', mantletW: 0.9, mantletL: 0.3, colors: PAL.usa, exhaust: 'rearBox',
    },
    layout: { trans: 'front', fuel: 'rear', ammo: ['sponson', 'floor'], engineLen: 1.5 },
  },
  {
    id: 'm4a2', name: 'M4A2 Sherman', nation: 'usa', cls: 'medium', br: 3.3, tier: 1, row: 0, prereq: null, rp: 0, cr: 0, starter: true, year: 1942,
    weight: 31.3, hp: 410, speed: 48, reverse: 12, traverse: 24,
    gun: { name: '75 mm M3', caliber: 75, reload: 6.5, dispersion: 0.28, shells: [S.m61(50), S.m72(15), S.m48(25)] },
    crew: ['D', 'R', 'G', 'C', 'L'],
    armor: { ufp: P(51, 56), lfp: P(63, 30), side: P(38, 0), rear: P(38, 10), tFront: P(76, 30), tSide: P(51, 5), tRear: P(51, 0), mantlet: P(89, 0), roof: 25 },
    look: {
      L: 5.9, W: 2.62, trackW: 0.42, fender: 0.12, nose: 'round', noseLen: 1.2, chamfer: 0.3, rearChamfer: 0.12, engineDeck: 1.9, grille: 'slats',
      turret: { shape: 'round', x: 0.15, len: 2.35, wid: 2.1, ox: -0.15, bustle: 0.35, cupola: { x: -0.4, y: 0.42, r: 0.36 }, hatch: { x: -0.35, y: -0.48, r: 0.26 }, extra: ['vent'] },
      gunLen: 2.6, gunW: 0.14, brake: 'none', mantlet: 'box', mantletW: 0.95, mantletL: 0.32, colors: PAL.usa, sandshields: true, spareTracks: 'glacis', exhaust: 'rear2',
    },
    layout: { trans: 'front', fuel: 'rear', ammo: ['sponson', 'turretSides'], engineLen: 1.7 },
  },
  {
    id: 'm10', name: 'M10 GMC', nation: 'usa', cls: 'td', br: 3.7, tier: 2, row: 1, prereq: 'm24', rp: 3600, cr: 14000, year: 1942,
    weight: 29.6, hp: 375, speed: 48, reverse: 12, traverse: 9,
    gun: { name: '3 in M7', caliber: 76, reload: 7.0, dispersion: 0.22, shells: [S.m62(36), S.m79(8), S.m42(10)] },
    crew: ['D', 'R', 'G', 'C', 'L'],
    armor: { ufp: P(38, 55), lfp: P(51, 30), side: P(25, 38), rear: P(19, 38), tFront: P(57, 45), tSide: P(25, 20), tRear: P(25, 0), mantlet: P(57, 0), roof: 0, openTop: true },
    look: {
      L: 5.97, W: 3.05, trackW: 0.42, fender: 0.0, nose: 'round', noseLen: 1.4, chamfer: 0.35, rearChamfer: 0.4, engineDeck: 1.9, grille: 'slats',
      turret: { shape: 'pent', x: -0.15, len: 2.6, wid: 2.45, ox: 0, cupola: { x: -0.4, y: 0.5, r: 0.0 }, extra: ['counterweight'] },
      gunLen: 3.4, gunW: 0.15, brake: 'none', mantlet: 'box', mantletW: 0.75, mantletL: 0.32, colors: PAL.usa, exhaust: 'rear2',
    },
    layout: { trans: 'front', fuel: 'rear', ammo: ['sponson', 'bustle'], engineLen: 1.7 },
  },
  {
    id: 'm4a3_76', name: 'M4A3 (76) W', nation: 'usa', cls: 'medium', br: 4.7, tier: 2, row: 0, prereq: 'm4a2', rp: 4800, cr: 22000, year: 1944,
    weight: 33.6, hp: 450, speed: 42, reverse: 12, traverse: 24,
    gun: { name: '76 mm M1A1', caliber: 76, reload: 6.7, dispersion: 0.22, shells: [S.m62(48), S.m93(6), S.m42(20)] },
    crew: ['D', 'R', 'G', 'C', 'L'],
    armor: { ufp: P(63, 47), lfp: P(63, 30), side: P(38, 0), rear: P(38, 10), tFront: P(64, 20), tSide: P(64, 5), tRear: P(64, 0), mantlet: P(89, 0), roof: 25 },
    look: {
      L: 5.9, W: 2.62, trackW: 0.42, fender: 0.12, nose: 'round', noseLen: 1.45, chamfer: 0.3, rearChamfer: 0.12, engineDeck: 1.9, grille: 'slats',
      turret: { shape: 'round', x: 0.1, len: 2.75, wid: 2.3, ox: -0.25, bustle: 0.6, cupola: { x: -0.55, y: 0.48, r: 0.38 }, hatch: { x: -0.45, y: -0.55, r: 0.28 }, extra: ['vent', 'stowage'] },
      gunLen: 3.5, gunW: 0.14, brake: 'double', mantlet: 'box', mantletW: 1.0, mantletL: 0.34, colors: PAL.usa, sandshields: true, spareTracks: 'glacis', exhaust: 'rear2',
    },
    layout: { trans: 'front', fuel: 'rear', ammo: ['floor', 'turretSides'], engineLen: 1.7 },
  },
  {
    id: 'm18', name: 'M18 Hellcat', nation: 'usa', cls: 'td', br: 5.0, tier: 3, row: 1, prereq: 'm10', rp: 7200, cr: 34000, year: 1944,
    weight: 17.7, hp: 400, speed: 72, reverse: 18, traverse: 24,
    gun: { name: '76 mm M1A1', caliber: 76, reload: 5.5, dispersion: 0.22, shells: [S.m62(30), S.m93(6), S.m42(9)] },
    crew: ['D', 'R', 'G', 'C', 'L'],
    armor: { ufp: P(13, 38), lfp: P(13, 30), side: P(13, 23), rear: P(13, 10), tFront: P(25, 23), tSide: P(13, 20), tRear: P(13, 0), mantlet: P(25, 0), roof: 0, openTop: true },
    look: {
      L: 5.44, W: 2.87, trackW: 0.38, fender: 0.0, nose: 'sloped', noseLen: 1.2, chamfer: 0.25, rearChamfer: 0.15, engineDeck: 1.6, grille: 'mesh',
      turret: { shape: 'pent', x: -0.1, len: 2.4, wid: 2.25, ox: -0.05, cupola: { x: -0.4, y: 0.5, r: 0.0 }, extra: ['stowage'] },
      gunLen: 3.5, gunW: 0.14, brake: 'double', mantlet: 'box', mantletW: 0.7, mantletL: 0.3, colors: PAL.usa, exhaust: 'rear2',
    },
    layout: { trans: 'front', fuel: 'rear', ammo: ['sponson', 'bustle'], engineLen: 1.5 },
  },
  {
    id: 'm26', name: 'M26 Pershing', nation: 'usa', cls: 'heavy', br: 6.0, tier: 3, row: 0, prereq: 'm4a3_76', rp: 9800, cr: 52000, year: 1945,
    weight: 41.9, hp: 500, speed: 40, reverse: 13, traverse: 24,
    gun: { name: '90 mm M3', caliber: 90, reload: 8.7, dispersion: 0.2, shells: [S.m82(40), S.m304(6), S.m71(24)] },
    crew: ['D', 'R', 'G', 'C', 'L'],
    armor: { ufp: P(102, 46), lfp: P(76, 53), side: P(76, 0), rear: P(51, 10), tFront: P(102, 10), tSide: P(76, 5), tRear: P(76, 0), mantlet: P(114, 0), roof: 25 },
    look: {
      L: 6.33, W: 3.51, trackW: 0.6, fender: 0.25, nose: 'chamfer', noseLen: 1.5, chamfer: 0.25, rearChamfer: 0.15, engineDeck: 2.1, grille: 'mesh',
      turret: { shape: 'round', x: 0.45, len: 2.95, wid: 2.55, ox: -0.3, bustle: 0.75, cupola: { x: -0.6, y: 0.55, r: 0.4 }, hatch: { x: -0.5, y: -0.6, r: 0.3 }, extra: ['vent', 'stowage'] },
      gunLen: 4.1, gunW: 0.19, brake: 'double', mantlet: 'box', mantletW: 1.25, mantletL: 0.36, colors: PAL.usa, exhaust: 'rearBox',
    },
    layout: { trans: 'rear', fuel: 'rear', ammo: ['floor', 'sponson'], engineLen: 1.8 },
  },
  // ===================== GERMANY =====================
  {
    id: 'puma', name: 'Sd.Kfz. 234/2 Puma', nation: 'germany', cls: 'ac', br: 3.0, tier: 1, row: 1, prereq: null, rp: 0, cr: 0, starter: true, year: 1944,
    weight: 11.7, hp: 210, speed: 85, reverse: 30, traverse: 16,
    gun: { name: '5 cm KwK 39/1', caliber: 50, reload: 4.0, dispersion: 0.24, shells: [S.pzgr39_50(35), S.pzgr40_50(10), S.sprgr50(10)] },
    crew: ['D', 'R', 'G', 'C'],
    armor: { ufp: P(30, 55), lfp: P(20, 55), side: P(10, 35), rear: P(10, 30), tFront: P(30, 20), tSide: P(10, 25), tRear: P(10, 20), mantlet: P(40, 0), roof: 10 },
    look: {
      L: 6.0, W: 2.36, trackW: 0.36, wheels: 4, fender: 0, nose: 'pike', noseLen: 1.3, chamfer: 0.55, rearChamfer: 0.45, engineDeck: 1.6, grille: 'louvre',
      turret: { shape: 'small', x: 0.05, len: 1.75, wid: 1.6, ox: -0.05, frontW: 0.65, cupola: { x: -0.35, y: 0.3, r: 0.24 }, hatch: { x: -0.35, y: -0.32, r: 0.22 } },
      gunLen: 2.6, gunW: 0.1, brake: 'single', mantlet: 'saukopf', mantletW: 0.55, mantletL: 0.45, colors: PAL.gerY, exhaust: 'side',
    },
    layout: { trans: 'rear', fuel: 'mid', ammo: ['sponson'], engineLen: 1.4 },
  },
  {
    id: 'pz4h', name: 'Pz.Kpfw. IV Ausf. H', nation: 'germany', cls: 'medium', br: 3.7, tier: 1, row: 0, prereq: null, rp: 0, cr: 0, starter: true, year: 1943,
    weight: 25, hp: 300, speed: 38, reverse: 9, traverse: 14,
    gun: { name: '7.5 cm KwK 40 L/48', caliber: 75, reload: 6.5, dispersion: 0.22, shells: [S.pzgr39_75(50), S.pzgr40_75(5), S.sprgr75(25)] },
    crew: ['D', 'R', 'G', 'C', 'L'],
    armor: { ufp: P(80, 12), lfp: P(80, 14), side: P(30, 0), rear: P(20, 10), tFront: P(50, 10), tSide: P(30, 25), tRear: P(30, 15), mantlet: P(50, 0), roof: 16, skirts: 5 },
    look: {
      L: 5.92, W: 2.88, trackW: 0.45, fender: 0.32, nose: 'step', noseLen: 0.9, chamfer: 0.1, rearChamfer: 0.1, engineDeck: 2.0, grille: 'louvre',
      turret: { shape: 'hex', x: 0.2, len: 2.2, wid: 1.85, ox: -0.1, frontW: 0.62, cupola: { x: -0.65, y: 0.0, r: 0.38 }, hatch: { x: 0.05, y: 0.55, r: 0.24 }, extra: ['schurzen', 'vent'] },
      gunLen: 3.2, gunW: 0.13, brake: 'double', mantlet: 'box', mantletW: 0.62, mantletL: 0.3, colors: PAL.gerY, skirts: true, spareTracks: 'glacis', exhaust: 'rearBox',
    },
    layout: { trans: 'front', fuel: 'mid', ammo: ['sponson', 'floor'], engineLen: 1.7 },
  },
  {
    id: 'stug3g', name: 'StuG III Ausf. G', nation: 'germany', cls: 'td', br: 3.7, tier: 2, row: 1, prereq: 'puma', rp: 3800, cr: 15000, year: 1943,
    weight: 23.9, hp: 300, speed: 40, reverse: 9, traverse: 6, gunArc: 11,
    gun: { name: '7.5 cm StuK 40 L/48', caliber: 75, reload: 6.0, dispersion: 0.22, shells: [S.pzgr39_75(34), S.pzgr40_75(5), S.sprgr75(15)] },
    crew: ['D', 'G', 'C', 'L'],
    armor: { ufp: P(80, 21), lfp: P(80, 21), side: P(30, 0), rear: P(30, 10), tFront: P(80, 10), tSide: P(30, 11), tRear: P(30, 0), mantlet: P(80, 0), roof: 17, skirts: 5 },
    look: {
      L: 5.38, W: 2.95, trackW: 0.42, fender: 0.3, nose: 'step', noseLen: 0.8, chamfer: 0.1, rearChamfer: 0.1, engineDeck: 1.9, grille: 'louvre',
      turret: { shape: 'casemate', x: 0.35, len: 2.55, wid: 2.25, frontW: 0.95, gunPivot: 0.95, cupola: { x: -0.7, y: -0.6, r: 0.36 }, hatch: { x: -0.65, y: 0.5, r: 0.3 }, extra: ['periscopes'] },
      gunLen: 3.0, gunW: 0.13, brake: 'double', mantlet: 'saukopf', mantletW: 0.62, mantletL: 0.5, colors: PAL.gerY, skirts: true, exhaust: 'rearBox',
    },
    layout: { trans: 'front', fuel: 'rear', ammo: ['casemate', 'sponson'], engineLen: 1.6 },
  },
  {
    id: 'pantherD', name: 'Panther Ausf. D', nation: 'germany', cls: 'medium', br: 5.3, tier: 2, row: 0, prereq: 'pz4h', rp: 5600, cr: 26000, year: 1943,
    weight: 43, hp: 650, speed: 46, reverse: 9, traverse: 15,
    gun: { name: '7.5 cm KwK 42 L/70', caliber: 75, reload: 7.5, dispersion: 0.17, shells: [S.pzgr3942(54), S.pzgr4042(6), S.sprgr42(19)] },
    crew: ['D', 'R', 'G', 'C', 'L'],
    armor: { ufp: P(80, 55), lfp: P(60, 55), side: P(40, 30), rear: P(40, 30), tFront: P(100, 12), tSide: P(45, 25), tRear: P(45, 25), mantlet: P(100, 0), roof: 16, skirts: 5 },
    look: {
      L: 6.87, W: 3.27, trackW: 0.66, fender: 0.45, nose: 'sloped', noseLen: 1.9, chamfer: 0.12, rearChamfer: 0.15, engineDeck: 2.2, grille: 'fans',
      turret: { shape: 'panther', x: 0.1, len: 2.95, wid: 2.3, ox: -0.2, frontW: 0.58, cupola: { x: -0.85, y: -0.55, r: 0.38 }, hatch: { x: -1.05, y: 0.35, r: 0.3 }, extra: ['vent'] },
      gunLen: 4.6, gunW: 0.13, brake: 'double', mantlet: 'round', mantletW: 1.15, mantletL: 0.42, colors: PAL.gerY, skirts: true, exhaust: 'rear2',
    },
    layout: { trans: 'front', fuel: 'rear', ammo: ['sponson', 'floor'], engineLen: 1.9 },
  },
  {
    id: 'pantherG', name: 'Panther Ausf. G', nation: 'germany', cls: 'medium', br: 5.7, tier: 3, row: 0, prereq: 'pantherD', rp: 8200, cr: 42000, year: 1944,
    weight: 44.8, hp: 700, speed: 46, reverse: 9, traverse: 19,
    gun: { name: '7.5 cm KwK 42 L/70', caliber: 75, reload: 7.0, dispersion: 0.16, shells: [S.pzgr3942(56), S.pzgr4042(6), S.sprgr42(20)] },
    crew: ['D', 'R', 'G', 'C', 'L'],
    armor: { ufp: P(80, 55), lfp: P(50, 55), side: P(50, 30), rear: P(40, 30), tFront: P(100, 12), tSide: P(45, 25), tRear: P(45, 25), mantlet: P(110, 0), roof: 16, skirts: 5 },
    look: {
      L: 6.87, W: 3.27, trackW: 0.66, fender: 0.45, nose: 'sloped', noseLen: 1.9, chamfer: 0.12, rearChamfer: 0.15, engineDeck: 2.2, grille: 'fans',
      turret: { shape: 'panther', x: 0.1, len: 2.95, wid: 2.3, ox: -0.2, frontW: 0.58, cupola: { x: -0.85, y: -0.55, r: 0.36 }, hatch: { x: -1.05, y: 0.35, r: 0.3 }, extra: ['vent', 'periscopes'] },
      gunLen: 4.6, gunW: 0.13, brake: 'double', mantlet: 'curved', mantletW: 1.2, mantletL: 0.44, colors: PAL.gerY, camo: 'stripes', skirts: true, exhaust: 'rear2',
    },
    layout: { trans: 'front', fuel: 'rear', ammo: ['sponson', 'floor'], engineLen: 1.9 },
  },
  {
    id: 'tiger1', name: 'Tiger I Ausf. H1', nation: 'germany', cls: 'heavy', br: 5.7, tier: 3, row: 1, prereq: 'stug3g', rp: 8600, cr: 45000, year: 1943,
    weight: 57, hp: 700, speed: 40, reverse: 10, traverse: 11,
    gun: { name: '8.8 cm KwK 36', caliber: 88, reload: 8.5, dispersion: 0.18, shells: [S.pzgr39_88(52), S.pzgr40_88(5), S.sprgr88(35)] },
    crew: ['D', 'R', 'G', 'C', 'L'],
    armor: { ufp: P(100, 9), lfp: P(100, 24), side: P(80, 0), rear: P(80, 9), tFront: P(100, 8), tSide: P(80, 0), tRear: P(80, 0), mantlet: P(120, 0), roof: 25 },
    look: {
      L: 6.32, W: 3.7, trackW: 0.72, fender: 0.62, nose: 'flat', noseLen: 0.7, chamfer: 0.1, rearChamfer: 0.08, engineDeck: 2.3, grille: 'twin',
      turret: { shape: 'tiger', x: 0.05, len: 2.75, wid: 2.75, ox: -0.05, cupola: { x: -0.7, y: -0.65, r: 0.42 }, hatch: { x: -0.55, y: 0.65, r: 0.3 }, extra: ['smoke', 'vent'] },
      gunLen: 4.2, gunW: 0.17, brake: 'double', mantlet: 'box', mantletW: 1.75, mantletL: 0.38, colors: PAL.gerG, exhaust: 'rear2',
    },
    layout: { trans: 'front', fuel: 'rear', ammo: ['sponson', 'floor'], engineLen: 2.0 },
  },
  // ======================= USSR =======================
  {
    id: 't34_41', name: 'T-34 (1941)', nation: 'ussr', cls: 'medium', br: 3.7, tier: 1, row: 0, prereq: null, rp: 0, cr: 0, starter: true, year: 1941,
    weight: 26.5, hp: 500, speed: 53, reverse: 9, traverse: 22,
    gun: { name: '76 mm F-34', caliber: 76, reload: 6.5, dispersion: 0.28, shells: [S.br350a(45), S.br350p(5), S.of350(27)] },
    crew: ['D', 'R', 'G', 'L'],
    armor: { ufp: P(45, 60), lfp: P(45, 53), side: P(45, 40), rear: P(40, 47), tFront: P(52, 30), tSide: P(52, 30), tRear: P(52, 30), mantlet: P(45, 0), roof: 20 },
    look: {
      L: 5.92, W: 3.0, trackW: 0.5, fender: 0.32, nose: 'sloped', noseLen: 1.4, chamfer: 0.12, rearChamfer: 0.12, engineDeck: 2.3, grille: 'louvre',
      turret: { shape: 'hex', x: 0.4, len: 2.2, wid: 1.95, ox: -0.05, frontW: 0.55, cupola: { x: -0.35, y: 0, r: 0.0 }, hatch: { x: -0.35, y: 0, r: 0.6 }, extra: ['periscopes'] },
      gunLen: 2.75, gunW: 0.14, brake: 'none', mantlet: 'curved', mantletW: 0.7, mantletL: 0.3, colors: PAL.ussr, exhaust: 'rear2', spareTracks: 'sides',
    },
    layout: { trans: 'rear', fuel: 'sides', ammo: ['floor'], engineLen: 1.5 },
  },
  {
    id: 'su85', name: 'SU-85', nation: 'ussr', cls: 'td', br: 4.3, tier: 2, row: 1, prereq: 't34_41', rp: 3500, cr: 14000, year: 1943,
    weight: 29.6, hp: 500, speed: 55, reverse: 9, traverse: 6, gunArc: 10,
    gun: { name: '85 mm D-5S', caliber: 85, reload: 7.8, dispersion: 0.2, shells: [S.br365(36), S.br365p(4), S.o365(8)] },
    crew: ['D', 'G', 'C', 'L'],
    armor: { ufp: P(45, 50), lfp: P(45, 53), side: P(45, 20), rear: P(45, 47), tFront: P(45, 50), tSide: P(45, 20), tRear: P(45, 10), mantlet: P(60, 0), roof: 20 },
    look: {
      L: 6.1, W: 3.0, trackW: 0.5, fender: 0.32, nose: 'sloped', noseLen: 1.0, chamfer: 0.12, rearChamfer: 0.12, engineDeck: 2.3, grille: 'louvre',
      turret: { shape: 'casemate', x: 0.6, len: 2.9, wid: 2.45, frontW: 0.88, gunPivot: 1.1, cupola: { x: -0.85, y: 0.6, r: 0.34 }, hatch: { x: -0.8, y: -0.55, r: 0.3 }, extra: ['periscopes'] },
      gunLen: 3.6, gunW: 0.15, brake: 'none', mantlet: 'curved', mantletW: 0.72, mantletL: 0.5, colors: PAL.ussr, exhaust: 'rear2', fuelDrums: true,
    },
    layout: { trans: 'rear', fuel: 'sides', ammo: ['casemate', 'floor'], engineLen: 1.5 },
  },
  {
    id: 't3485', name: 'T-34-85', nation: 'ussr', cls: 'medium', br: 5.3, tier: 2, row: 0, prereq: 't34_41', rp: 5200, cr: 24000, year: 1944,
    weight: 32, hp: 500, speed: 55, reverse: 9, traverse: 24,
    gun: { name: '85 mm ZiS-S-53', caliber: 85, reload: 7.5, dispersion: 0.2, shells: [S.br365(36), S.br365p(5), S.o365(14)] },
    crew: ['D', 'R', 'G', 'C', 'L'],
    armor: { ufp: P(45, 60), lfp: P(45, 53), side: P(45, 40), rear: P(45, 47), tFront: P(90, 20), tSide: P(75, 20), tRear: P(52, 10), mantlet: P(90, 0), roof: 20 },
    look: {
      L: 6.1, W: 3.0, trackW: 0.5, fender: 0.32, nose: 'sloped', noseLen: 1.4, chamfer: 0.12, rearChamfer: 0.12, engineDeck: 2.3, grille: 'louvre',
      turret: { shape: 'round', x: 0.25, len: 3.0, wid: 2.3, ox: -0.25, bustle: 0.55, cupola: { x: -0.8, y: -0.5, r: 0.38 }, hatch: { x: -0.75, y: 0.5, r: 0.28 }, extra: ['vent'] },
      gunLen: 4.0, gunW: 0.15, brake: 'none', mantlet: 'curved', mantletW: 0.72, mantletL: 0.34, colors: PAL.ussr, exhaust: 'rear2', fuelDrums: true,
    },
    layout: { trans: 'rear', fuel: 'sides', ammo: ['floor', 'bustle'], engineLen: 1.5 },
  },
  {
    id: 'is1', name: 'IS-1', nation: 'ussr', cls: 'heavy', br: 5.7, tier: 2, row: 2, prereq: 't34_41', rp: 6000, cr: 28000, year: 1943,
    weight: 44, hp: 520, speed: 37, reverse: 9, traverse: 14,
    gun: { name: '85 mm D-5T', caliber: 85, reload: 8.0, dispersion: 0.2, shells: [S.br365(42), S.br365p(5), S.o365(12)] },
    crew: ['D', 'G', 'C', 'L'],
    armor: { ufp: P(120, 30), lfp: P(100, 30), side: P(90, 15), rear: P(60, 49), tFront: P(100, 20), tSide: P(100, 20), tRear: P(100, 0), mantlet: P(100, 0), roof: 30 },
    look: {
      L: 6.77, W: 3.07, trackW: 0.65, fender: 0.42, nose: 'step', noseLen: 1.0, chamfer: 0.3, rearChamfer: 0.25, engineDeck: 2.6, grille: 'louvre',
      turret: { shape: 'dome', x: 0.25, len: 2.85, wid: 2.5, ox: -0.15, cupola: { x: -0.6, y: -0.6, r: 0.38 }, hatch: { x: -0.55, y: 0.6, r: 0.3 }, extra: ['vent'] },
      gunLen: 3.9, gunW: 0.15, brake: 'none', mantlet: 'curved', mantletW: 0.95, mantletL: 0.36, colors: PAL.ussr, exhaust: 'rear2', fuelDrums: true,
    },
    layout: { trans: 'rear', fuel: 'sides', ammo: ['floor', 'bustle'], engineLen: 1.8 },
  },
  {
    id: 't44', name: 'T-44', nation: 'ussr', cls: 'medium', br: 6.3, tier: 3, row: 0, prereq: 't3485', rp: 9500, cr: 50000, year: 1945,
    weight: 31.8, hp: 520, speed: 51, reverse: 9, traverse: 24,
    gun: { name: '85 mm ZiS-S-53', caliber: 85, reload: 7.0, dispersion: 0.19, shells: [S.br365(42), S.br365p(6), S.o365(10)] },
    crew: ['D', 'G', 'C', 'L'],
    armor: { ufp: P(90, 60), lfp: P(90, 45), side: P(75, 0), rear: P(45, 20), tFront: P(120, 20), tSide: P(90, 25), tRear: P(75, 20), mantlet: P(120, 0), roof: 20 },
    look: {
      L: 6.07, W: 3.18, trackW: 0.55, fender: 0.35, nose: 'sloped', noseLen: 1.7, chamfer: 0.1, rearChamfer: 0.1, engineDeck: 1.9, grille: 'mesh',
      turret: { shape: 'dome', x: -0.15, len: 3.05, wid: 2.6, ox: -0.1, cupola: { x: -0.65, y: -0.62, r: 0.38 }, hatch: { x: -0.6, y: 0.62, r: 0.3 }, extra: ['vent'] },
      gunLen: 4.0, gunW: 0.15, brake: 'none', mantlet: 'curved', mantletW: 0.8, mantletL: 0.36, colors: PAL.ussr, exhaust: 'side', fuelDrums: true,
    },
    layout: { trans: 'rear', fuel: 'front', ammo: ['front', 'floor'], engineLen: 1.3 },
  },
  {
    id: 'is2', name: 'IS-2 (1944)', nation: 'ussr', cls: 'heavy', br: 6.5, tier: 3, row: 2, prereq: 'is1', rp: 10200, cr: 56000, year: 1944,
    weight: 46, hp: 520, speed: 37, reverse: 9, traverse: 14,
    gun: { name: '122 mm D-25T', caliber: 122, reload: 18, dispersion: 0.22, shells: [S.br471(10), S.br471b(8), S.of471(10)] },
    crew: ['D', 'G', 'C', 'L'],
    armor: { ufp: P(100, 60), lfp: P(100, 30), side: P(90, 15), rear: P(60, 49), tFront: P(100, 20), tSide: P(90, 20), tRear: P(90, 0), mantlet: P(100, 0), roof: 30 },
    look: {
      L: 6.77, W: 3.07, trackW: 0.65, fender: 0.42, nose: 'sloped', noseLen: 1.3, chamfer: 0.3, rearChamfer: 0.25, engineDeck: 2.6, grille: 'louvre',
      turret: { shape: 'dome', x: 0.3, len: 3.0, wid: 2.6, ox: -0.2, cupola: { x: -0.65, y: -0.62, r: 0.4 }, hatch: { x: -0.6, y: 0.62, r: 0.3 }, extra: ['vent'] },
      gunLen: 4.6, gunW: 0.22, brake: 'is', mantlet: 'curved', mantletW: 1.15, mantletL: 0.42, colors: PAL.ussr, exhaust: 'rear2', fuelDrums: true,
    },
    layout: { trans: 'rear', fuel: 'sides', ammo: ['floor', 'bustle'], engineLen: 1.8 },
  },
  {
    id: 'isu122s', name: 'ISU-122S', nation: 'ussr', cls: 'td', br: 6.0, tier: 3, row: 1, prereq: 'su85', rp: 8800, cr: 46000, year: 1944,
    weight: 46, hp: 520, speed: 37, reverse: 9, traverse: 6, gunArc: 10,
    gun: { name: '122 mm D-25S', caliber: 122, reload: 14, dispersion: 0.22, shells: [S.br471(12), S.br471b(8), S.of471(10)] },
    crew: ['D', 'G', 'C', 'L', 'L'],
    armor: { ufp: P(90, 30), lfp: P(90, 30), side: P(90, 15), rear: P(60, 49), tFront: P(90, 30), tSide: P(75, 15), tRear: P(60, 0), mantlet: P(120, 0), roof: 30 },
    look: {
      L: 6.77, W: 3.07, trackW: 0.65, fender: 0.42, nose: 'step', noseLen: 0.8, chamfer: 0.3, rearChamfer: 0.25, engineDeck: 2.4, grille: 'louvre',
      turret: { shape: 'casemate', x: 0.85, len: 3.4, wid: 2.75, frontW: 0.9, gunPivot: 1.25, cupola: { x: -1.05, y: 0.7, r: 0.38 }, hatch: { x: -1.0, y: -0.65, r: 0.32 }, extra: ['periscopes'] },
      gunLen: 4.5, gunW: 0.21, brake: 'is', mantlet: 'curved', mantletW: 0.95, mantletL: 0.62, colors: PAL.ussr, exhaust: 'rear2', fuelDrums: true,
    },
    layout: { trans: 'rear', fuel: 'sides', ammo: ['casemate', 'floor'], engineLen: 1.8 },
  },
];

export const VEHICLE_MAP: Record<string, VehicleSpec> = Object.fromEntries(VEHICLES.map((v) => [v.id, v]));
export const getVehicle = (id: string): VehicleSpec => VEHICLE_MAP[id] ?? VEHICLES[0];

export const NATION_NAMES: Record<Nation, string> = { usa: 'USA', germany: 'GERMANY', ussr: 'USSR' };
export const CLASS_NAMES: Record<VClass, string> = { light: 'Light tank', medium: 'Medium tank', heavy: 'Heavy tank', td: 'Tank destroyer', ac: 'Armoured car' };

/** Penetration at distance d (m) — linear interpolation over the 0/500/1000 m table. */
export function penAt(sh: ShellSpec, d: number): number {
  const [p0, p5, p10] = sh.pen;
  if (d <= 500) return p0 + ((p5 - p0) * d) / 500;
  if (d <= 1000) return p5 + ((p10 - p5) * (d - 500)) / 500;
  return Math.max(p10 * 0.5, p10 - ((p5 - p10) * (d - 1000)) / 500);
}
