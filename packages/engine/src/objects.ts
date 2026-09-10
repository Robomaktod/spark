/**
 * Objects: discrete moving matter (passport §2). A projectile in flight, or the
 * same matter after it settles while a concentration link keeps it alive.
 *
 * Positions and velocities are milli-cells; a cell is 1000.
 */
import type { ImpactOp, MaterialId, ObjectView, Side, Vec2 } from '@spark/protocol';
import type { Cell } from './shapes.js';
import { MILLI_CELLS_PER_CELL } from '@spark/protocol';
import { ilen } from './fp.js';
import type { Hasher } from './hash.js';

export interface ResolvedOp {
  readonly op: ImpactOp['op'];
  /** Degrees Celsius for addTemperature, binding delta for setBinding. */
  readonly value: number;
}

export interface ResolvedImpact {
  /** Impact shape in world-frame offsets, rasterised for the launch direction. */
  readonly cells: readonly Cell[];
  /**
   * Cell count of the same shape in its canonical orientation. Damage coverage
   * divides by this rather than by the rasterised count, so the same shot does
   * the same damage whichever way it was aimed.
   */
  readonly canonicalCellCount: number;
  readonly ops: readonly ResolvedOp[];
}

export class SparkObject {
  destroyed = false;
  /** True while a concentration link holds this object (passport §10). */
  concentrated = false;
  /** Settled objects stop moving but stay objects while concentrated. */
  settled = false;

  constructor(
    readonly id: number,
    readonly owner: Side,
    readonly spellId: string,
    public xMilli: number,
    public yMilli: number,
    public vxMilli: number,
    public vyMilli: number,
    public massG: number,
    public material: MaterialId,
    public temperatureMilliC: number,
    /** Body cells relative to the object centre, already rotated. */
    readonly cells: readonly Cell[],
    readonly impact: ResolvedImpact | null,
  ) {}

  get cellX(): number {
    return Math.floor(this.xMilli / MILLI_CELLS_PER_CELL);
  }

  get cellY(): number {
    return Math.floor(this.yMilli / MILLI_CELLS_PER_CELL);
  }

  get speedMilli(): number {
    return ilen(this.vxMilli, this.vyMilli);
  }

  /** Mass carried by each cell of the body, in grams. */
  get massPerCellG(): number {
    return Math.max(1, Math.floor(this.massG / Math.max(1, this.cells.length)));
  }

  occupiedCells(): Cell[] {
    const cx = this.cellX;
    const cy = this.cellY;
    return this.cells.map(([dx, dy]) => [cx + dx, cy + dy] as Cell);
  }

  view(): ObjectView {
    return {
      id: this.id,
      p: [this.cellX, this.cellY],
      v: [
        Math.trunc(this.vxMilli / MILLI_CELLS_PER_CELL),
        Math.trunc(this.vyMilli / MILLI_CELLS_PER_CELL),
      ],
      vMilli: [this.vxMilli, this.vyMilli],
      m: this.massG,
      mat: this.material,
      t: this.temperatureMilliC,
      owner: this.owner,
      cells: this.cells.map(([x, y]) => [x, y] as Vec2),
    };
  }

  hashInto(h: Hasher): void {
    h.int(this.id)
      .str(this.owner)
      .int(this.xMilli)
      .int(this.yMilli)
      .int(this.vxMilli)
      .int(this.vyMilli)
      .int(this.massG)
      .int(this.temperatureMilliC)
      .str(this.material)
      .int(this.destroyed ? 1 : 0)
      .int(this.concentrated ? 1 : 0)
      .int(this.settled ? 1 : 0);
  }
}
