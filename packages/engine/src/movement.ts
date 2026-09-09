/**
 * Movement (passport §6).
 *
 * 15 MP a turn, 1 MP per cell in any of 8 directions, 1 MP per 45 degrees of
 * turning. The full 5x5 footprint must be legal, so a passable gap has to be at
 * least 5 cells wide.
 */
import type { MoveAction, Rules } from '@spark/protocol';
import type { World } from './world.js';
import type { Wizard } from './wizard.js';
import { facingDistance } from './shapes.js';
import { impactDamageMilliHp, keMilliJ } from './pricing.js';
import { clamp, ilen, sign } from './fp.js';

export interface MoveOutcome {
  readonly mpSpent: number;
  readonly cellsMoved: number;
  readonly stoppedEarly: boolean;
  readonly notes: readonly string[];
}

/** True when the wizard's whole footprint could stand centred on (x, y). */
export function footprintLegal(world: World, rules: Rules, x: number, y: number): boolean {
  const r = rules.wizard.footprintRadius;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (world.blocksWizard(x + dx, y + dy, rules.wizard.blockedHeightMm)) return false;
    }
  }
  return true;
}

/** MP multiplier for stepping to (nx, ny): the worst terrain newly entered. */
function stepCostMilli(world: World, rules: Rules, wizard: Wizard, nx: number, ny: number): number {
  const r = rules.wizard.footprintRadius;
  let worst = 1000;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const cx = nx + dx;
      const cy = ny + dy;
      // Only cells the wizard was not already standing on count as "entered".
      if (Math.abs(cx - wizard.x) <= r && Math.abs(cy - wizard.y) <= r) continue;
      if (!world.inBounds(cx, cy)) continue;
      const mult = rules.movement.terrainCostMilli[world.materialAt(cx, cy)];
      if (mult > worst) worst = mult;
    }
  }
  return worst;
}

function entersIce(world: World, rules: Rules, x: number, y: number): boolean {
  const r = rules.wizard.footprintRadius;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (world.inBounds(x + dx, y + dy) && world.materialAt(x + dx, y + dy) === 'ice') return true;
    }
  }
  return false;
}

/**
 * Applies one Move sub-action. Movement resolves atomically: a blocked path
 * stops at the last legal cell and keeps the unspent MP (passport §6).
 */
export function applyMove(
  world: World,
  wizard: Wizard,
  move: MoveAction,
  rules: Rules,
): MoveOutcome {
  const notes: string[] = [];
  let mpSpent = 0;
  let cellsMoved = 0;
  let stoppedEarly = false;

  if (move.turnTo !== undefined && move.turnTo !== wizard.facing) {
    const cost = facingDistance(wizard.facing, move.turnTo) * rules.wizard.turnCostPer45;
    if (cost > wizard.mp) {
      notes.push(`turn to ${move.turnTo} needs ${cost} MP, ${wizard.mp} left`);
      stoppedEarly = true;
    } else {
      wizard.mp -= cost;
      mpSpent += cost;
      wizard.facing = move.turnTo;
    }
  }

  for (const [dx, dy] of move.path ?? []) {
    const nx = wizard.x + dx;
    const ny = wizard.y + dy;
    if (!footprintLegal(world, rules, nx, ny)) {
      notes.push(`blocked entering [${nx},${ny}]`);
      stoppedEarly = true;
      break;
    }
    const costMilli = stepCostMilli(world, rules, wizard, nx, ny);
    const cost = Math.ceil(costMilli / 1000);
    if (cost > wizard.mp) {
      notes.push(`out of MP at [${wizard.x},${wizard.y}]`);
      stoppedEarly = true;
      break;
    }
    wizard.mp -= cost;
    mpSpent += cost;
    wizard.x = nx;
    wizard.y = ny;
    cellsMoved++;

    // Ice: free forced continuation in the direction of travel (passport §6).
    if (entersIce(world, rules, nx, ny)) {
      for (let s = 0; s < rules.movement.iceSlideCells; s++) {
        const sx = wizard.x + dx;
        const sy = wizard.y + dy;
        if (!footprintLegal(world, rules, sx, sy)) {
          notes.push(`slide stopped at [${wizard.x},${wizard.y}]`);
          break;
        }
        wizard.x = sx;
        wizard.y = sy;
        cellsMoved++;
        notes.push(`slid on ice to [${sx},${sy}]`);
      }
    }
  }

  return { mpSpent, cellsMoved, stoppedEarly, notes };
}

export interface PushOutcome {
  readonly cells: number;
  readonly hitWall: boolean;
  readonly damageMilliHp: number;
}

/**
 * An impulse pushing a wizard (passport §6). Displacement is
 * `min(impulse / wizardMass, 20)` cells along the impulse vector, halting on
 * the first blocked cell; a wizard stopped by a wall takes its own KE as damage.
 */
export function pushWizard(
  world: World,
  wizard: Wizard,
  impulseX: number,
  impulseY: number,
  rules: Rules,
): PushOutcome {
  const magnitude = ilen(impulseX, impulseY);
  if (magnitude === 0) return { cells: 0, hitWall: false, damageMilliHp: 0 };

  const distance = clamp(Math.floor(magnitude / rules.wizard.massG), 0, rules.physics.maxPushCells);
  if (distance === 0) return { cells: 0, hitWall: false, damageMilliHp: 0 };

  // Walk cell by cell along the dominant axis, Bresenham-style, all integers.
  const stepX = sign(impulseX);
  const stepY = sign(impulseY);
  const ax = Math.abs(impulseX);
  const ay = Math.abs(impulseY);
  let err = 0;
  let moved = 0;
  let hitWall = false;

  for (let i = 0; i < distance; i++) {
    let nx = wizard.x;
    let ny = wizard.y;
    if (ax >= ay) {
      nx += stepX;
      err += ay;
      if (err * 2 >= ax) {
        ny += stepY;
        err -= ax;
      }
    } else {
      ny += stepY;
      err += ax;
      if (err * 2 >= ay) {
        nx += stepX;
        err -= ay;
      }
    }
    if (!footprintLegal(world, rules, nx, ny)) {
      hitWall = true;
      break;
    }
    wizard.x = nx;
    wizard.y = ny;
    moved++;
  }

  let damageMilliHp = 0;
  if (hitWall) {
    const speedMilli = distance * 1000;
    const ke = keMilliJ(rules.wizard.massG, speedMilli);
    damageMilliHp = impactDamageMilliHp(ke, 1, 1, rules);
    wizard.damage(damageMilliHp);
  }
  return { cells: moved, hitWall, damageMilliHp };
}
