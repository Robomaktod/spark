import { MATERIALS, type MaterialId, type MaterialSpec } from './materials.js';

/**
 * The complete rule set. The engine ships this to both bots in the `init`
 * packet (passport §14.2), so nothing about pricing or physics is hidden from a
 * player willing to read (passport §19, Clarity).
 *
 * Every field is an integer. Coefficients are stored x1000.
 */
export interface Rules {
  readonly rulesVersion: string;

  readonly arena: {
    /** Cells across. */
    readonly width: number;
    /** Cells down. */
    readonly height: number;
    /** Engine dirty-tracking unit; never meaningful to a bot, published for completeness. */
    readonly blockSize: number;
    /** Cells with height above this stop a projectile (passport §3.2). */
    readonly flightAltitudeMm: number;
    /** Ambient temperature everything decays toward, milli-Celsius. */
    readonly ambientMilliC: number;
  };

  readonly wizard: {
    /** Footprint is footprintRadius*2+1 cells on a side. 2 -> 5x5. */
    readonly footprintRadius: number;
    readonly hpMilli: number;
    readonly mpPerTurn: number;
    readonly manaStartMilli: number;
    readonly manaRegenMilli: number;
    readonly manaCapMilli: number;
    /** Used for push displacement (passport §23 open question, 70 kg). */
    readonly massG: number;
    /** MP charged per 45 degrees of turning. */
    readonly turnCostPer45: number;
    /** Minimum clearance the wand keeps ahead of the footprint edge. */
    readonly wandOffsetCells: number;
    /** Cells above this height block the wizard. */
    readonly blockedHeightMm: number;
  };

  readonly costs: {
    /** K_IMPULSE x1000. Mana per joule of kinetic energy granted. */
    readonly kImpulseMilli: number;
    /** K_HEAT x1000. Mana per (kg * specificHeat * degreeC). */
    readonly kHeatMilli: number;
    /** K_BIND x1000. Mana per (binding delta * kg). */
    readonly kBindMilli: number;
    /** CONC_MULT x1000. Concentration upkeep multiplier over one turn of decay. */
    readonly concentrationMultMilli: number;
    /**
     * Impact ops are priced against a nominal cell, not the cells actually
     * struck, so a cast is priceable before it is fired (passport §7.5) while
     * still scaling with the impact area (passport §7.4). See docs/DECISIONS.md.
     */
    readonly nominalCellMassG: number;
    readonly nominalCellSpecificHeatMilli: number;
  };

  readonly damage: {
    /** KE_TO_HP x1000. Passport §18 says tune this before any other number. */
    readonly keToHpMilli: number;
    /** Cells hotter than this burn a wizard standing in them, milli-Celsius. */
    readonly burnThresholdMilliC: number;
    /** HP lost per turn is (T - threshold) / this, both in milli-Celsius. */
    readonly burnDivisorMilliC: number;
  };

  readonly physics: {
    /** Proportional drag per turn, x1000 (10% -> 100). */
    readonly dragPermille: number;
    /** Flat drag per turn in milli-cells (1 cell -> 1000). */
    readonly dragFlatMilliCells: number;
    /** Objects slower than this settle as terrain. */
    readonly settleSpeedMilliCells: number;
    /** Fraction of the gap to ambient a dirty cell closes per turn, x1000. */
    readonly heatDecayPermille: number;
    /** Bodies below this mass are rejected (passport §20, zero-mass exploit). */
    readonly minBodyMassG: number;
    /** Cap on push displacement in cells. */
    readonly maxPushCells: number;
    /** Safety bound on the collision event loop. */
    readonly maxCollisionIterations: number;
  };

  readonly movement: {
    /** MP multiplier x1000 for entering a cell of each material. */
    readonly terrainCostMilli: Readonly<Record<MaterialId, number>>;
    /** Cells of forced slide after entering ice. */
    readonly iceSlideCells: number;
  };

  readonly match: {
    /** Games per match; each game is played over `roundsPerGame` rounds. */
    readonly games: number;
    readonly roundsPerGame: number;
    /** Turn cycles per round. Each cycle gives every wizard one turn. */
    readonly turnCap: number;
  };

  readonly spellbook: {
    readonly maxPages: number;
    /** Divisor applied to total shape cells in the page formula. */
    readonly shapeCellsDivisor: number;
    /** Range width that costs one page, per parameter kind. */
    readonly granularity: {
      readonly massG: number;
      readonly speedCellsPerTurn: number;
      readonly temperatureC: number;
      readonly binding: number;
    };
    /** Flat page cost of a free direction parameter. */
    readonly directionParamPages: number;
    readonly maxSpells: number;
    readonly maxShapeCells: number;
    readonly maxOpsPerSpell: number;
  };

  readonly limits: {
    readonly turnMs: number;
    readonly startupMs: number;
    readonly memoryMb: number;
  };

  readonly materials: Readonly<Record<MaterialId, MaterialSpec>>;
}

/**
 * Passport §18. Every number is a starting value with a stated test; none are
 * claimed correct. Tune KE_TO_HP before anything else.
 */
export const DEFAULT_RULES: Rules = {
  rulesVersion: '0.1.0',

  arena: {
    width: 200,
    height: 200,
    blockSize: 5,
    flightAltitudeMm: 1000,
    ambientMilliC: 20_000,
  },

  wizard: {
    footprintRadius: 2,
    hpMilli: 100_000,
    mpPerTurn: 15,
    manaStartMilli: 100_000,
    manaRegenMilli: 20_000,
    manaCapMilli: 150_000,
    massG: 70_000,
    turnCostPer45: 1,
    wandOffsetCells: 3,
    blockedHeightMm: 1000,
  },

  costs: {
    kImpulseMilli: 200,
    kHeatMilli: 20,
    kBindMilli: 500,
    concentrationMultMilli: 1500,
    nominalCellMassG: 10,
    nominalCellSpecificHeatMilli: 1000,
  },

  damage: {
    keToHpMilli: 350,
    burnThresholdMilliC: 60_000,
    burnDivisorMilliC: 20_000,
  },

  physics: {
    dragPermille: 100,
    dragFlatMilliCells: 1000,
    settleSpeedMilliCells: 1000,
    heatDecayPermille: 300,
    minBodyMassG: 100,
    maxPushCells: 20,
    maxCollisionIterations: 64,
  },

  movement: {
    terrainCostMilli: {
      air: 1000,
      water: 2000,
      ice: 1000,
      wood: 1000,
      plasma: 1000,
      stone: 1000,
      rubble: 2000,
    },
    iceSlideCells: 1,
  },

  match: {
    games: 2,
    roundsPerGame: 2,
    turnCap: 30,
  },

  spellbook: {
    maxPages: 40,
    shapeCellsDivisor: 10,
    granularity: {
      massG: 2000,
      speedCellsPerTurn: 20,
      temperatureC: 2000,
      binding: 40,
    },
    directionParamPages: 1,
    maxSpells: 12,
    maxShapeCells: 400,
    maxOpsPerSpell: 6,
  },

  limits: {
    turnMs: 200,
    startupMs: 2000,
    memoryMb: 256,
  },

  materials: MATERIALS,
};

/** Deep-freeze helper so a bot adapter cannot mutate the shared rules object. */
export function freezeRules(rules: Rules): Rules {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object' || seen.has(v as object)) return;
    seen.add(v as object);
    Object.freeze(v);
    for (const child of Object.values(v as Record<string, unknown>)) walk(child);
  };
  walk(rules);
  return rules;
}
