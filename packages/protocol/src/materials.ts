/** Materials (passport §3.3). Every value here is a starting value, not a fixed truth. */

export const MATERIAL_IDS = ['air', 'water', 'ice', 'wood', 'plasma', 'stone', 'rubble'] as const;

export type MaterialId = (typeof MATERIAL_IDS)[number];

/** Numeric index used inside the engine grid. Order is part of the wire contract. */
export const MATERIAL_INDEX: Readonly<Record<MaterialId, number>> = {
  air: 0,
  water: 1,
  ice: 2,
  wood: 3,
  plasma: 4,
  stone: 5,
  rubble: 6,
};

export interface MaterialSpec {
  readonly id: MaterialId;
  /** Grams per cell. A cell is 1 litre, so g/L is numerically kg/m^3. */
  readonly densityGPerCell: number;
  /** Specific heat x1000 (water 1.0 -> 1000). */
  readonly specificHeatMilli: number;
  /** Structural cohesion a freshly written cell of this material gets. */
  readonly defaultBinding: number;
  /** Melting point in milli-Celsius, or null if the material does not melt in v1. */
  readonly meltMilliC: number | null;
  /** Boiling / burning point in milli-Celsius, or null. */
  readonly boilMilliC: number | null;
  /** Manifest cost in milli-mana per kilogram (numerically mana per kg x1000). */
  readonly manifestCostMilliManaPerKg: number;
  /** How tall one cell of settled matter of this material stands, in mm. */
  readonly settledHeightMm: number;
}

export const MATERIALS: Readonly<Record<MaterialId, MaterialSpec>> = {
  air: {
    id: 'air',
    densityGPerCell: 1,
    specificHeatMilli: 200,
    defaultBinding: 0,
    meltMilliC: null,
    boilMilliC: null,
    manifestCostMilliManaPerKg: 500,
    settledHeightMm: 0,
  },
  water: {
    id: 'water',
    densityGPerCell: 1000,
    specificHeatMilli: 1000,
    defaultBinding: 5,
    meltMilliC: 0,
    boilMilliC: 100_000,
    manifestCostMilliManaPerKg: 2000,
    settledHeightMm: 0,
  },
  ice: {
    id: 'ice',
    densityGPerCell: 900,
    specificHeatMilli: 500,
    defaultBinding: 30,
    meltMilliC: 0,
    boilMilliC: null,
    manifestCostMilliManaPerKg: 2000,
    settledHeightMm: 900,
  },
  wood: {
    id: 'wood',
    densityGPerCell: 600,
    specificHeatMilli: 600,
    defaultBinding: 45,
    meltMilliC: null,
    boilMilliC: 300_000,
    manifestCostMilliManaPerKg: 3000,
    settledHeightMm: 1200,
  },
  plasma: {
    id: 'plasma',
    densityGPerCell: 300,
    specificHeatMilli: 200,
    defaultBinding: 0,
    meltMilliC: null,
    boilMilliC: null,
    manifestCostMilliManaPerKg: 4000,
    settledHeightMm: 0,
  },
  stone: {
    id: 'stone',
    densityGPerCell: 2500,
    specificHeatMilli: 400,
    defaultBinding: 80,
    meltMilliC: 1_200_000,
    boilMilliC: null,
    manifestCostMilliManaPerKg: 6000,
    settledHeightMm: 1200,
  },
  rubble: {
    id: 'rubble',
    densityGPerCell: 1600,
    specificHeatMilli: 400,
    defaultBinding: 5,
    meltMilliC: 1_200_000,
    boilMilliC: null,
    manifestCostMilliManaPerKg: 5000,
    settledHeightMm: 400,
  },
};

export function isMaterialId(v: unknown): v is MaterialId {
  return typeof v === 'string' && (MATERIAL_IDS as readonly string[]).includes(v);
}
