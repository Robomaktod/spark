import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  FACING_VECTORS,
  facingDistance,
  facingFromVector,
  localShapeCells,
  shapeCellsInDirection,
  shapeCellCount,
  shapeRadius,
  unitVectorMilli,
} from '../src/index.js';

/** Passport §7.2: shapes are authored with +X as the launch direction. */
describe('shape rasterisation', () => {
  it('rasterises each shape to the expected footprint', () => {
    assert.equal(shapeCellCount({ shape: 'cell' }), 1);
    assert.equal(shapeCellCount({ shape: 'line', length: 8 }), 8);
    assert.equal(shapeCellCount({ shape: 'rect', length: 10, width: 2 }), 20);
    assert.equal(shapeCellCount({ shape: 'disc', radius: 2 }), 13);
    assert.equal(shapeCellCount({ shape: 'disc', radius: 6 }), 113);
  });

  it('centres shapes on the origin so the wand offset can clear the caster', () => {
    const line = localShapeCells({ shape: 'line', length: 8 });
    const xs = line.map(([x]) => x);
    assert.ok(Math.min(...xs) < 0 && Math.max(...xs) > 0, 'a line should straddle its origin');
    assert.equal(shapeRadius({ shape: 'disc', radius: 6 }), 6);
  });

  it('opens a cone forward and never backward', () => {
    const cone = localShapeCells({ shape: 'cone', radius: 5, halfAngleDeg: 30 });
    assert.ok(cone.length > 1);
    for (const [x] of cone) assert.ok(x >= 0, 'a cone must not reach behind the caster');
    const wide = localShapeCells({ shape: 'cone', radius: 5, halfAngleDeg: 80 });
    assert.ok(wide.length > cone.length, 'a wider half-angle should cover more cells');
  });

  it('rasterises a line along the launch direction', () => {
    const east = shapeCellsInDirection({ shape: 'line', length: 5 }, 1, 0);
    assert.deepEqual(
      east.map(([x, y]) => [x, y]),
      [
        [-2, 0],
        [-1, 0],
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    );
    const south = shapeCellsInDirection({ shape: 'line', length: 5 }, 0, 1);
    for (const [x] of south) assert.equal(x, 0, 'a line fired south should lie along Y');
    assert.equal(south.length, 5);
  });

  it('does not collapse a diagonal line onto itself', () => {
    // Rotating already-rasterised cells lands several of them on one square.
    // Rasterising the region instead keeps a diagonal line a line.
    const diagonal = shapeCellsInDirection({ shape: 'line', length: 8 }, 1, 1);
    assert.ok(diagonal.length >= 5, `a diagonal 8-line collapsed to ${diagonal.length} cells`);
    const keys = new Set(diagonal.map(([x, y]) => `${x},${y}`));
    assert.equal(keys.size, diagonal.length, 'cells must be distinct');
  });

  it('rasterisation is stable and scale-free in the direction', () => {
    const disc = { shape: 'disc', radius: 4 } as const;
    assert.deepEqual(shapeCellsInDirection(disc, 3, -1), shapeCellsInDirection(disc, 3, -1));
    assert.deepEqual(shapeCellsInDirection(disc, 6, -2), shapeCellsInDirection(disc, 3, -1));
  });

  it('a disc is rotation invariant, so its cost cannot be gamed by angle', () => {
    const disc = { shape: 'disc', radius: 5 } as const;
    const base = shapeCellsInDirection(disc, 1, 0).length;
    for (const [dx, dy] of [[1, 1], [0, 1], [-3, 2], [7, -4]] as const) {
      assert.equal(shapeCellsInDirection(disc, dx, dy).length, base);
    }
  });

  it('normalises diagonals so they are not secretly longer', () => {
    const [ux, uy] = unitVectorMilli(1, 1);
    assert.equal(ux, 707);
    assert.equal(uy, 707);
    assert.deepEqual([...unitVectorMilli(5, 0)], [1000, 0]);
  });

  it('survives a direction vector far outside the map', () => {
    const [ux, uy] = unitVectorMilli(900_000_000, 0);
    assert.equal(ux, 1000);
    assert.equal(uy, 0);
  });
});

/** Passport §6: turning costs 1 MP per 45 degrees, a full reversal costs 4. */
describe('facing', () => {
  it('charges the short way round', () => {
    assert.equal(facingDistance(0, 0), 0);
    assert.equal(facingDistance(0, 1), 1);
    assert.equal(facingDistance(0, 4), 4);
    assert.equal(facingDistance(0, 7), 1);
    assert.equal(facingDistance(6, 1), 3);
  });

  it('maps a direction to the nearest of the eight facings', () => {
    for (let i = 0; i < 8; i++) {
      const [dx, dy] = FACING_VECTORS[i]!;
      assert.equal(facingFromVector(dx * 17, dy * 17), i);
    }
  });
});
