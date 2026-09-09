/**
 * The mana model (passport §9) and the damage model (passport §8).
 *
 * One currency, four cost terms, all derived from energy. No spell carries a
 * damage number and no player declares a cost: everything here is a function of
 * mass, velocity and temperature.
 *
 * The worked examples in passport §9 are the acceptance tests for this file and
 * are asserted in test/pricing.test.ts.
 */
import type { ImpactOp, MaterialId, Rules, ShapeSpec, SpellTemplate } from '@spark/protocol';
import { MATERIALS } from '@spark/protocol';
import { toSafeNumber } from './fp.js';
import { shapeCellCount } from './shapes.js';

/**
 * Kinetic energy in milli-joules.
 *
 * KE = 1/2 m v^2 with mass in kg and velocity in m/s. Mass arrives in grams and
 * speed in milli-cells per turn; a cell is 0.1 m and a turn is 1 s, so
 * v[m/s] = speed / 10000 and the whole thing collapses to m * v^2 / 2e8.
 */
export function keMilliJ(massG: number, speedMilliCellsPerTurn: number): number {
  const v = BigInt(Math.trunc(speedMilliCellsPerTurn));
  const n = BigInt(Math.trunc(massG)) * v * v;
  return toSafeNumber(n / 200_000_000n, 'keMilliJ');
}

/** Speed in milli-cells/turn that gives a mass this much kinetic energy. */
export function speedForKeMilliJ(massG: number, keMilliJoules: number): number {
  if (massG <= 0 || keMilliJoules <= 0) return 0;
  const n = BigInt(Math.trunc(keMilliJoules)) * 200_000_000n / BigInt(Math.trunc(massG));
  // Integer square root on BigInt keeps this exact.
  if (n <= 0n) return 0;
  let r = n;
  let prev = 0n;
  while (r !== prev) {
    prev = r;
    r = (r + n / r) >> 1n;
    if (r === 0n) break;
  }
  while (r * r > n) r -= 1n;
  while ((r + 1n) * (r + 1n) <= n) r += 1n;
  return toSafeNumber(r, 'speedForKeMilliJ');
}

/** Cost of manifesting matter: mass_kg x materialCost. Milli-mana. */
export function manifestCostMilliMana(massG: number, material: MaterialId): number {
  const spec = MATERIALS[material];
  const n = BigInt(Math.trunc(massG)) * BigInt(spec.manifestCostMilliManaPerKg);
  return toSafeNumber(n / 1000n, 'manifestCost');
}

/** Cost of granting velocity: k_impulse x KE. Milli-mana. */
export function impulseCostMilliMana(keMilliJoules: number, rules: Rules): number {
  const n = BigInt(Math.trunc(keMilliJoules)) * BigInt(rules.costs.kImpulseMilli);
  return toSafeNumber(n / 1000n, 'impulseCost');
}

/** Cost of a temperature change: k_heat x mass_kg x specificHeat x dT. Milli-mana. */
export function heatCostMilliMana(
  massG: number,
  specificHeatMilli: number,
  deltaMilliC: number,
  rules: Rules,
): number {
  const n =
    BigInt(rules.costs.kHeatMilli) *
    BigInt(Math.trunc(massG)) *
    BigInt(Math.trunc(specificHeatMilli)) *
    BigInt(Math.abs(Math.trunc(deltaMilliC)));
  return toSafeNumber(n / 1_000_000_000n, 'heatCost');
}

/** Cost of a binding change: k_bind x dBinding x mass_kg. Milli-mana. */
export function bindCostMilliMana(massG: number, deltaBinding: number, rules: Rules): number {
  const n =
    BigInt(rules.costs.kBindMilli) *
    BigInt(Math.abs(Math.trunc(deltaBinding))) *
    BigInt(Math.trunc(massG));
  return toSafeNumber(n / 1000n, 'bindCost');
}

/**
 * Thermal energy, in milli-joules, held by a mass at a temperature offset.
 *
 * E = m * c * dT. This is the exact inverse of temperatureRiseMilliC, which is
 * what lets heat be conserved: a spell buys a packet of energy, the body
 * carries it, and the impact delivers it into whatever it struck.
 */
export function thermalEnergyMilliJ(massG: number, specificHeatMilli: number, deltaMilliC: number): number {
  const n =
    BigInt(Math.trunc(massG)) *
    BigInt(Math.trunc(specificHeatMilli)) *
    BigInt(Math.trunc(deltaMilliC));
  return toSafeNumber(n / 1_000_000n, 'thermalEnergy');
}

/** Temperature swing, in milli-Celsius, from putting energy into a heat capacity. */
export function temperatureRiseMilliC(energyMilliJ: number, heatCapacity: number): number {
  if (heatCapacity <= 0) return 0;
  const n = BigInt(Math.trunc(energyMilliJ)) * 1_000_000n;
  const d = BigInt(Math.trunc(heatCapacity));
  let q = n / d;
  if (n % d !== 0n && n < 0n) q -= 1n;
  return toSafeNumber(q, 'temperatureRise');
}

/** Heat capacity of a mass of a material, in (grams x milli-specificHeat). */
export function heatCapacityOf(massG: number, specificHeatMilli: number): number {
  return Math.max(1, Math.trunc(massG) * Math.trunc(specificHeatMilli));
}

/**
 * The mass an impact op is priced against.
 *
 * Passport §7.4 wants a wider impact shape to cost more; passport §7.5 wants
 * every cast priceable before it is fired. The cells actually struck are not
 * known at cast time, so impact ops are priced against a published nominal cell
 * rather than against the real terrain. See docs/DECISIONS.md, D3.
 */
export function nominalImpactMassG(impactCells: number, rules: Rules): number {
  return impactCells * rules.costs.nominalCellMassG;
}

export interface CostBreakdown {
  readonly manifest: number;
  readonly impulse: number;
  readonly heat: number;
  readonly bind: number;
  readonly total: number;
}

export const ZERO_COST: CostBreakdown = { manifest: 0, impulse: 0, heat: 0, bind: 0, total: 0 };

export function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  return {
    manifest: a.manifest + b.manifest,
    impulse: a.impulse + b.impulse,
    heat: a.heat + b.heat,
    bind: a.bind + b.bind,
    total: a.total + b.total,
  };
}

/** A cast with every parameter already resolved to a concrete number. */
export interface ResolvedCast {
  readonly bodyMassG: number;
  readonly bodyMaterial: MaterialId;
  readonly bodyCells: number;
  readonly speedMilliCellsPerTurn: number;
  readonly impactCells: number;
  readonly impactOps: readonly { op: ImpactOp['op']; value: number }[];
}

export function costOfCast(cast: ResolvedCast, rules: Rules): CostBreakdown {
  const manifest = manifestCostMilliMana(cast.bodyMassG, cast.bodyMaterial);
  const impulse = impulseCostMilliMana(
    keMilliJ(cast.bodyMassG, cast.speedMilliCellsPerTurn),
    rules,
  );
  const nominalMass = nominalImpactMassG(cast.impactCells, rules);
  let heat = 0;
  let bind = 0;
  for (const op of cast.impactOps) {
    if (op.op === 'addTemperature') {
      heat += heatCostMilliMana(
        nominalMass,
        rules.costs.nominalCellSpecificHeatMilli,
        op.value * 1000,
        rules,
      );
    } else if (op.op === 'setBinding') {
      bind += bindCostMilliMana(nominalMass, op.value, rules);
    }
  }
  return { manifest, impulse, heat, bind, total: manifest + impulse + heat + bind };
}

/**
 * Highest cost a template can reach across its declared parameter ranges.
 * Reactions reserve this at declaration (passport §11) and are refunded what
 * they did not spend, which is why ranges are mandatory in templates.
 */
export function worstCaseCostMilliMana(template: SpellTemplate, rules: Rules): number {
  const maxOf = (v: number | { min: number; max: number }): number =>
    typeof v === 'number' ? v : Math.max(Math.abs(v.min), Math.abs(v.max));
  const bodyMassG = Math.max(rules.physics.minBodyMassG, maxOf(template.body.mass));
  const speed = maxOf(template.launch.speed) * 1000;
  const impactCells = template.onImpact ? shapeCellCount(template.onImpact) : 1;
  const ops = (template.onImpact?.ops ?? []).map((op) => ({
    op: op.op,
    value: op.op === 'transferKinetic' ? 0 : maxOf(op.value),
  }));
  return costOfCast(
    {
      bodyMassG,
      bodyMaterial: template.body.material,
      bodyCells: shapeCellCount(template.body as unknown as ShapeSpec),
      speedMilliCellsPerTurn: speed,
      impactCells,
      impactOps: ops,
    },
    rules,
  ).total;
}

/* ------------------------------------------------------------------ */
/* Damage (passport §8)                                                */
/* ------------------------------------------------------------------ */

/**
 * HP loss = KE x KE_TO_HP x (overlapCells / impactShapeCells).
 *
 * The coverage term is what makes aiming a skill: a knife clipping 3 of the
 * wizard's 25 cells does a fraction of a centre hit.
 */
export function impactDamageMilliHp(
  keMilliJoules: number,
  overlapCells: number,
  impactShapeCells: number,
  rules: Rules,
): number {
  if (overlapCells <= 0 || impactShapeCells <= 0) return 0;
  const n =
    BigInt(Math.trunc(keMilliJoules)) *
    BigInt(rules.damage.keToHpMilli) *
    BigInt(Math.trunc(overlapCells));
  return toSafeNumber(n / (1000n * BigInt(Math.trunc(impactShapeCells))), 'impactDamage');
}

/** Burn: (T - 60) / 20 HP per turn, from the hottest cell under the footprint. */
export function burnDamageMilliHp(hottestMilliC: number, rules: Rules): number {
  const over = hottestMilliC - rules.damage.burnThresholdMilliC;
  if (over <= 0) return 0;
  return Math.floor((over * 1000) / rules.damage.burnDivisorMilliC);
}

/* ------------------------------------------------------------------ */
/* Concentration (passport §10)                                        */
/* ------------------------------------------------------------------ */

/**
 * Upkeep = CONC_MULT x (mana cost to undo one turn of natural decay).
 *
 * v1 holds one property: temperature. An object at -200 C in a 20 C world loses
 * 30% of its differential each turn, so the link pays for putting that back,
 * times 1.5. Holding is cheaper than recasting, never free.
 */
export function concentrationUpkeepMilliMana(
  massG: number,
  material: MaterialId,
  temperatureMilliC: number,
  rules: Rules,
): number {
  const spec = MATERIALS[material];
  const differential = temperatureMilliC - rules.arena.ambientMilliC;
  if (differential === 0) return 0;
  const decayMilliC = Math.trunc((Math.abs(differential) * rules.physics.heatDecayPermille) / 1000);
  const base = heatCostMilliMana(massG, spec.specificHeatMilli, decayMilliC, rules);
  return Math.trunc((base * rules.costs.concentrationMultMilli) / 1000);
}
