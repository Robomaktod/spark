/**
 * The mana field overlay (web plan §5.2): what it costs to land a shot at each
 * position on the map.
 *
 * Passport §9 has no distance multiplier — range is paid as velocity, and
 * impulse is quadratic in it, so doubling the reach quadruples the mana. That
 * relationship is the single most important thing a bot author has to feel, and
 * it is completely invisible in a list of numbers.
 */
import type { MaterialId, Rules } from '@spark/protocol';
import { impulseCostMilliMana, keMilliJ, manifestCostMilliMana } from '@spark/engine';

/** How far a body launched at this speed travels before drag settles it. */
export function reachOfSpeed(speedCellsPerTurn: number, rules: Rules): number {
  let v = speedCellsPerTurn * 1000;
  let travelled = 0;
  for (let turn = 0; turn < 64; turn++) {
    if (v < rules.physics.settleSpeedMilliCells) break;
    travelled += v;
    v = v - Math.round((v * rules.physics.dragPermille) / 1000) - rules.physics.dragFlatMilliCells;
  }
  return travelled / 1000;
}

/** The slowest launch that still reaches a distance, or null if none does. */
export function speedToReach(distanceCells: number, rules: Rules): number | null {
  let lo = 0;
  let hi = 400;
  if (reachOfSpeed(hi, rules) < distanceCells) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (reachOfSpeed(mid, rules) >= distanceCells) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Total mana to put `massG` of `material` at a distance, in milli-mana. */
export function manaToReach(
  distanceCells: number,
  massG: number,
  material: MaterialId,
  rules: Rules,
): number | null {
  const speed = speedToReach(distanceCells, rules);
  if (speed === null) return null;
  return (
    manifestCostMilliMana(massG, material) +
    impulseCostMilliMana(keMilliJ(massG, speed * 1000), rules)
  );
}

/** A lookup of cost by distance, so the overlay is one pass over the grid. */
export function manaByDistance(
  maxDistance: number,
  massG: number,
  material: MaterialId,
  rules: Rules,
): (number | null)[] {
  const out: (number | null)[] = [];
  for (let d = 0; d <= maxDistance; d++) out.push(manaToReach(d, massG, material, rules));
  return out;
}
