/**
 * Map generation (passport §15). Seeded and deliberately asymmetric: fairness
 * comes from the spawn swap in §5.2, not from mirroring the terrain.
 */
import type { MaterialId, Rules, Vec2 } from '@spark/protocol';
import { MATERIALS } from '@spark/protocol';
import { World } from './world.js';
import { Rng } from './rand.js';
import { ilen } from './fp.js';

export interface GeneratedMap {
  readonly world: World;
  readonly spawns: readonly [Vec2, Vec2];
  readonly seed: string;
}

export interface MapGenOptions {
  readonly stoneFormations?: readonly [number, number];
  readonly waterBodies?: readonly [number, number];
  readonly rubbleFields?: readonly [number, number];
  readonly minSpawnSeparation?: number;
  readonly spawnClearRadius?: number;
}

const DEFAULTS = {
  stoneFormations: [3, 6] as const,
  waterBodies: [1, 2] as const,
  rubbleFields: [1, 3] as const,
  minSpawnSeparation: 120,
  spawnClearRadius: 15,
};

/** An ellipse with a per-row wobble, so formations do not look machine-stamped. */
function stampBlob(
  world: World,
  rng: Rng,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  mat: MaterialId,
  heightMm: number,
  keepClear: (x: number, y: number) => boolean,
): void {
  const spec = MATERIALS[mat];
  for (let y = cy - ry; y <= cy + ry; y++) {
    if (y < 0 || y >= world.height) continue;
    const dy = y - cy;
    const wobble = rng.range(-1, 1);
    const span = Math.floor((rx * Math.max(0, ry * ry - dy * dy)) / Math.max(1, ry * ry)) + wobble;
    for (let x = cx - span; x <= cx + span; x++) {
      if (x < 0 || x >= world.width) continue;
      if (keepClear(x, y)) continue;
      world.writeCell(x, y, mat, {
        massG: spec.densityGPerCell,
        binding: spec.defaultBinding,
        heightMm,
      });
    }
  }
}

export function generateMap(seed: string, rules: Rules, options: MapGenOptions = {}): GeneratedMap {
  const opts = { ...DEFAULTS, ...options };
  const rng = new Rng(seed);
  const world = new World(rules);
  const { width, height } = world;
  const margin = opts.spawnClearRadius + rules.wizard.footprintRadius + 2;

  // Spawns first, so every formation can be told to keep away from them.
  const spawnA: Vec2 = [rng.range(margin, width - 1 - margin), rng.range(margin, height - 1 - margin)];
  let spawnB: Vec2 = spawnA;
  for (let attempt = 0; attempt < 4096; attempt++) {
    const candidate: Vec2 = [rng.range(margin, width - 1 - margin), rng.range(margin, height - 1 - margin)];
    if (ilen(candidate[0] - spawnA[0], candidate[1] - spawnA[1]) >= opts.minSpawnSeparation) {
      spawnB = candidate;
      break;
    }
  }
  if (spawnB === spawnA) {
    // Fall back to the far corner rather than emit an unplayable map.
    spawnB = [width - 1 - spawnA[0], height - 1 - spawnA[1]];
  }

  const clearRadius = opts.spawnClearRadius;
  const keepClear = (x: number, y: number): boolean =>
    ilen(x - spawnA[0], y - spawnA[1]) <= clearRadius || ilen(x - spawnB[0], y - spawnB[1]) <= clearRadius;

  const place = (
    count: number,
    mat: MaterialId,
    heightMm: number,
    minR: number,
    maxR: number,
  ): void => {
    for (let i = 0; i < count; i++) {
      const cx = rng.range(4, width - 5);
      const cy = rng.range(4, height - 5);
      const rx = rng.range(minR, maxR);
      const ry = rng.range(minR, maxR);
      stampBlob(world, rng, cx, cy, rx, ry, mat, heightMm, keepClear);
    }
  };

  // Stone breaks sightlines and stops projectiles: height above flight altitude.
  const stoneCount = rng.range(opts.stoneFormations[0], opts.stoneFormations[1]);
  for (let i = 0; i < stoneCount; i++) {
    const cx = rng.range(6, width - 7);
    const cy = rng.range(6, height - 7);
    stampBlob(world, rng, cx, cy, rng.range(4, 14), rng.range(4, 14), 'stone', rng.range(1200, 2000), keepClear);
  }

  // Water is flat: shots fly over it, wizards wade at double cost.
  place(rng.range(opts.waterBodies[0], opts.waterBodies[1]), 'water', 0, 8, 20);

  // Rubble at 400 mm blocks nothing in flight and slows movement.
  place(rng.range(opts.rubbleFields[0], opts.rubbleFields[1]), 'rubble', 400, 6, 16);

  // The spawn clear radius is guaranteed open ground.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (keepClear(x, y)) world.clearToAir(x, y);
    }
  }
  world.clearDirtyBlocks();

  return { world, spawns: [spawnA, spawnB], seed };
}
