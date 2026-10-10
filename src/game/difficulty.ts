// AI difficulty. "Hard" is the AI as it was first tuned; "normal" (the default) and "easy" aim
// worse, react later, pause between shots, rarely pick weak spots and use their tricks less.
// It applies to every AI tank in the battle (both teams), so a battle stays fair.

export type AILevel = 'easy' | 'normal' | 'hard';
export const AI_LEVEL_IDS: AILevel[] = ['easy', 'normal', 'hard'];

export function isAILevel(v: unknown): v is AILevel {
  return v === 'easy' || v === 'normal' || v === 'hard';
}

export interface AILevelDef {
  id: AILevel;
  /** display name / one-line description (i18n keys) */
  name: string;
  info: string;
  /** crew skill range (0..1): aim settling, leading, weak-spot reading */
  skill: [number, number];
  /** σ (deg) of the aim error when a new target is picked (× (1.4 − skill)) */
  aimErr: number;
  /** how fast that error settles (× the skill-based rate) */
  settle: number;
  /** σ (deg) of a fresh error drawn for every shot that never settles away (× (1.2 − skill)) */
  floor: number;
  /** delay before the first shot at a new target (s, × (1.3 − skill)) */
  react: [number, number];
  /** extra pause after each shot (s) */
  pause: [number, number];
  /** how well moving targets are led (× skill-based lead) */
  lead: number;
  /** chance that a skilled crew aims at a weak spot instead of the middle */
  weakSpot: number;
  /** target choice multiplier for human players (< 1 = goes for players first) */
  humanBias: number;
  /** delay multiplier for repairs and putting out fires */
  slow: number;
  /** killstreak support: chance multiplier, artillery aim error (m) */
  support: number;
  artyErr: number;
  /** chance to pop smoke when badly hurt */
  smoke: number;
  /** heavies keep the hull angled toward the enemy */
  angling: boolean;
}

export const AI_LEVELS: Record<AILevel, AILevelDef> = {
  easy: {
    id: 'easy',
    name: 'Easy',
    info: 'Slow to react, misses a lot, never aims for weak spots',
    skill: [0.12, 0.4],
    aimErr: 3.6,
    settle: 0.45,
    floor: 3.4,
    react: [2.0, 3.6],
    pause: [1.4, 3.0],
    lead: 0.5,
    weakSpot: 0,
    humanBias: 1.25,
    slow: 2.2,
    support: 0.35,
    artyErr: 11,
    smoke: 0.25,
    angling: false,
  },
  normal: {
    id: 'normal',
    name: 'Normal',
    info: 'A fair fight: decent aim, sometimes goes for weak spots',
    skill: [0.25, 0.6],
    aimErr: 3.0,
    settle: 0.6,
    floor: 2.2,
    react: [1.4, 2.6],
    pause: [0.8, 1.8],
    lead: 0.75,
    weakSpot: 0.2,
    humanBias: 1.08,
    slow: 1.5,
    support: 0.7,
    artyErr: 7,
    smoke: 0.4,
    angling: true,
  },
  hard: {
    id: 'hard',
    name: 'Hard',
    info: 'Sharp shooters: quick, accurate, aim for your weak spots',
    skill: [0.35, 0.8],
    aimErr: 2.2,
    settle: 1,
    floor: 0,
    react: [0.7, 1.6],
    pause: [0, 0],
    lead: 1,
    weakSpot: 1,
    humanBias: 0.9,
    slow: 1,
    support: 1,
    artyErr: 4,
    smoke: 0.55,
    angling: true,
  },
};
