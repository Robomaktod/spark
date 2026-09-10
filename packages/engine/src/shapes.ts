/**
 * Shape rasterisation (passport §7.2).
 *
 * Shapes are authored in a local frame where +X is the launch direction, then
 * rotated onto the cast direction. Every step is integer maths, so the same
 * shape and the same direction rasterise to the same cells everywhere.
 *
 * Grid convention: +X is east, +Y is south, facing index 0 is east and each
 * step of 1 is 45 degrees clockwise on screen.
 */
import type { ShapeSpec } from '@spark/protocol';
import { FP_ONE } from '@spark/protocol';
import { cosMilli, idivRound, isqrt, isqrtBig, mulDivRound } from './fp.js';

export type Cell = readonly [number, number];

export const FACING_COUNT = 8;

/** Unit vector for each of the 8 facings. Index 0 is east. */
export const FACING_VECTORS: readonly Cell[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/** MP cost of turning between two facings: 1 per 45 degrees, the short way round. */
export function facingDistance(from: number, to: number): number {
  const d = Math.abs(((to - from) % FACING_COUNT) + FACING_COUNT) % FACING_COUNT;
  return Math.min(d, FACING_COUNT - d);
}

/**
 * Unit vector of an arbitrary integer direction, in milli-units (1000 = 1 cell).
 * Diagonals come out at 707, not 1000, so a diagonal cast is not secretly faster.
 */
export function unitVectorMilli(dx: number, dy: number): readonly [number, number] {
  const [ux, uy] = unitVectorMicro(dx, dy);
  return [idivRound(ux, 1000), idivRound(uy, 1000)];
}

/** One micro-unit is 1/1e6 of a cell. Precision the rasteriser needs; see below. */
export const MICRO = 1_000_000;

/**
 * Unit vector at micro precision.
 *
 * Milli precision is not enough to rasterise a rotated disc: a unit vector that
 * is off by 5e-4 inflates squared lengths by 1e-3, which is enough to push the
 * boundary ring of a radius-5 disc outside its own radius and quietly shrink
 * the shape by a dozen cells depending on the angle it was fired at.
 */
export function unitVectorMicro(dx: number, dy: number): readonly [number, number] {
  if (dx === 0 && dy === 0) return [0, 0];
  // A bot may legitimately hand over a huge vector — a lead computation that ran
  // away, say. Direction is scale-free, so reduce it before squaring rather than
  // letting the intermediate leave the safe integer range.
  const [rx, ry] = reduceDirection(dx, dy);
  const lenMicro = Number(isqrtBig(BigInt(rx * rx + ry * ry) * 1_000_000_000_000n));
  if (lenMicro === 0) return [0, 0];
  return [
    mulDivRound(rx, 1_000_000_000_000, lenMicro),
    mulDivRound(ry, 1_000_000_000_000, lenMicro),
  ];
}

/** Scales a direction down so its components fit in +/-10000, keeping the angle. */
export function reduceDirection(dx: number, dy: number): readonly [number, number] {
  const largest = Math.max(Math.abs(dx), Math.abs(dy));
  if (largest <= 10_000) return [dx, dy];
  const divisor = Math.ceil(largest / 10_000);
  const rx = Math.round(dx / divisor);
  const ry = Math.round(dy / divisor);
  return rx === 0 && ry === 0 ? [Math.sign(dx), Math.sign(dy)] : [rx, ry];
}

/**
 * Nearest facing index to an arbitrary integer vector. Ties resolve to the
 * lower index.
 *
 * The comparison uses each facing's milli-unit vector rather than its raw
 * integer form: `ilen(1, 1)` floors the square root of two to 1, which would
 * make every diagonal score as if it were a unit vector and quietly beat the
 * cardinal it is compared against.
 */
export function facingFromVector(rawX: number, rawY: number): number {
  if (rawX === 0 && rawY === 0) return 0;
  const [dx, dy] = reduceDirection(rawX, rawY);
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < FACING_COUNT; i++) {
    const [fx, fy] = FACING_VECTORS[i]!;
    const [ux, uy] = unitVectorMilli(fx, fy);
    // |dir| is the same for every candidate, so it drops out of the comparison.
    const score = dx * ux + dy * uy;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function centeredRange(n: number): { lo: number; hi: number } {
  const lo = -((n - 1) >> 1);
  return { lo, hi: lo + n - 1 };
}

/**
 * A shape as a continuous region in its local frame, in milli-cells.
 *
 * Shapes are rasterised by rotating each candidate world cell back into this
 * frame and testing it, rather than by rotating an already-rasterised shape.
 * Rotating rasterised cells collapses them: a diagonal 5-cell line lands three
 * of its cells on the same square and silently becomes a 3-cell line.
 */
interface Region {
  /** True when a point in the local frame is inside the shape. */
  contains(lxMilli: number, lyMilli: number): boolean;
  /** Largest distance from the origin the region reaches, in milli-cells. */
  extentMilli: number;
}

const HALF_CELL = FP_ONE / 2;

/**
 * Slack on squared-length tests, in milli-cells squared. Comfortably larger
 * than the residual error of a micro-precision rotation and comfortably smaller
 * than the gap between neighbouring lattice points, so boundary cells are
 * neither dropped nor invented.
 */
const ROUNDING_SLACK = 20_000;

function regionOf(spec: ShapeSpec): Region {
  switch (spec.shape) {
    case 'cell':
      return {
        extentMilli: HALF_CELL,
        contains: (lx, ly) => Math.abs(lx) <= HALF_CELL && Math.abs(ly) <= HALF_CELL,
      };
    case 'line': {
      const { lo, hi } = centeredRange(spec.length);
      const loM = lo * FP_ONE - HALF_CELL;
      const hiM = hi * FP_ONE + HALF_CELL;
      return {
        extentMilli: Math.max(Math.abs(loM), Math.abs(hiM)) + HALF_CELL,
        contains: (lx, ly) => lx >= loM && lx <= hiM && Math.abs(ly) <= HALF_CELL,
      };
    }
    case 'disc': {
      const r = spec.radius * FP_ONE;
      return {
        extentMilli: r + HALF_CELL,
        contains: (lx, ly) => lx * lx + ly * ly <= r * r + ROUNDING_SLACK,
      };
    }
    case 'cone': {
      const r = spec.radius * FP_ONE;
      const cosLimit = cosMilli(spec.halfAngleDeg);
      return {
        extentMilli: r + HALF_CELL,
        contains: (lx, ly) => {
          const d2 = lx * lx + ly * ly;
          if (d2 > r * r + ROUNDING_SLACK) return false;
          if (d2 <= HALF_CELL * HALF_CELL) return true;
          if (lx <= 0) return false;
          return lx * FP_ONE >= cosLimit * isqrt(d2);
        },
      };
    }
    case 'rect': {
      const xs = centeredRange(spec.length);
      const ys = centeredRange(spec.width);
      const x0 = xs.lo * FP_ONE - HALF_CELL;
      const x1 = xs.hi * FP_ONE + HALF_CELL;
      const y0 = ys.lo * FP_ONE - HALF_CELL;
      const y1 = ys.hi * FP_ONE + HALF_CELL;
      return {
        extentMilli:
          Math.max(Math.abs(x0), Math.abs(x1)) + Math.max(Math.abs(y0), Math.abs(y1)) + HALF_CELL,
        contains: (lx, ly) => lx >= x0 && lx <= x1 && ly >= y0 && ly <= y1,
      };
    }
  }
}

/**
 * Rasterises a shape into world-frame cell offsets for a launch direction.
 * Row-major, deduplicated, and stable for a given shape and direction.
 */
export function shapeCellsInDirection(spec: ShapeSpec, dirX: number, dirY: number): Cell[] {
  const region = regionOf(spec);
  const [cos, sin] = dirX === 0 && dirY === 0 ? ([MICRO, 0] as const) : unitVectorMicro(dirX, dirY);
  const bound = Math.ceil(region.extentMilli / FP_ONE) + 1;
  const out: Cell[] = [];
  for (let y = -bound; y <= bound; y++) {
    for (let x = -bound; x <= bound; x++) {
      // Inverse rotation: world offset back into the shape's own frame.
      const wx = x * FP_ONE;
      const wy = y * FP_ONE;
      const lx = idivRound(wx * cos + wy * sin, MICRO);
      const ly = idivRound(-wx * sin + wy * cos, MICRO);
      if (region.contains(lx, ly)) out.push([x, y]);
    }
  }
  return out;
}

/**
 * Cells of a shape in its local frame, +X forward. This is the canonical form:
 * pricing and the damage coverage term both use its cell count, so a cast costs
 * the same and lands the same fraction of its damage whatever angle it is fired
 * at (passport §7.5 — every cast is statically priceable).
 */
export function localShapeCells(spec: ShapeSpec): Cell[] {
  return shapeCellsInDirection(spec, 1, 0);
}

/** Number of cells a shape occupies in its canonical orientation. */
export function shapeCellCount(spec: ShapeSpec): number {
  return localShapeCells(spec).length;
}

/**
 * Largest Chebyshev extent of a shape from its centre. Feeds the wand offset
 * rule `max(wandOffsetCells, bodyRadius + 1)` from passport §4.
 */
export function shapeRadius(spec: ShapeSpec): number {
  let r = 0;
  for (const [x, y] of localShapeCells(spec)) r = Math.max(r, Math.abs(x), Math.abs(y));
  return r;
}
