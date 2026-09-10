/**
 * The cell grid (passport §3).
 *
 * Cells are stored as parallel typed arrays rather than objects: a 200x200 map
 * is 40k cells stepped many times per match, and typed arrays keep every read
 * an integer read with no allocation.
 *
 * Density and phase are derived, never stored (passport §3.1).
 */
import type { CellView, MaterialId, Rules } from '@spark/protocol';
import { MATERIALS, MATERIAL_IDS, MATERIAL_INDEX } from '@spark/protocol';
import { Hasher } from './hash.js';

export class World {
  readonly width: number;
  readonly height: number;
  readonly blockSize: number;
  readonly blocksX: number;
  readonly blocksY: number;
  readonly ambientMilliC: number;

  readonly material: Uint8Array;
  /** Grams. */
  readonly mass: Int32Array;
  /** Milli-Celsius. */
  readonly temperature: Int32Array;
  readonly binding: Int32Array;
  /** Millimetres. */
  readonly heightMm: Int32Array;

  /** Dirty flag per 5x5 block; only dirty blocks are stepped (passport §3.4). */
  private readonly blockDirty: Uint8Array;
  private dirtyBlocks: number[] = [];

  /** Cell indices written since the last drain, for the sparse turn packet. */
  private readonly changed = new Set<number>();

  constructor(rules: Rules) {
    this.width = rules.arena.width;
    this.height = rules.arena.height;
    this.blockSize = rules.arena.blockSize;
    this.blocksX = Math.ceil(this.width / this.blockSize);
    this.blocksY = Math.ceil(this.height / this.blockSize);
    this.ambientMilliC = rules.arena.ambientMilliC;

    const n = this.width * this.height;
    this.material = new Uint8Array(n);
    this.mass = new Int32Array(n);
    this.temperature = new Int32Array(n);
    this.binding = new Int32Array(n);
    this.heightMm = new Int32Array(n);
    this.blockDirty = new Uint8Array(this.blocksX * this.blocksY);

    const air = MATERIALS.air;
    this.mass.fill(air.densityGPerCell);
    this.temperature.fill(this.ambientMilliC);
  }

  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  materialAt(x: number, y: number): MaterialId {
    return MATERIAL_IDS[this.material[this.idx(x, y)]!]!;
  }

  materialOfIndex(i: number): MaterialId {
    return MATERIAL_IDS[this.material[i]!]!;
  }

  /* -------------------------------------------------------------- */
  /* Mutation. Every write dirties a block and records a cell delta.  */
  /* -------------------------------------------------------------- */

  markDirty(x: number, y: number): void {
    const b = Math.floor(y / this.blockSize) * this.blocksX + Math.floor(x / this.blockSize);
    if (this.blockDirty[b] === 0) {
      this.blockDirty[b] = 1;
      this.dirtyBlocks.push(b);
    }
  }

  private touch(i: number, x: number, y: number): void {
    this.changed.add(i);
    this.markDirty(x, y);
  }

  setMaterial(x: number, y: number, mat: MaterialId): void {
    const i = this.idx(x, y);
    this.material[i] = MATERIAL_INDEX[mat];
    this.touch(i, x, y);
  }

  setMass(x: number, y: number, grams: number): void {
    const i = this.idx(x, y);
    this.mass[i] = Math.max(0, Math.trunc(grams));
    this.touch(i, x, y);
  }

  setTemperature(x: number, y: number, milliC: number): void {
    const i = this.idx(x, y);
    this.temperature[i] = Math.trunc(milliC);
    this.touch(i, x, y);
  }

  addTemperature(x: number, y: number, deltaMilliC: number): void {
    const i = this.idx(x, y);
    this.temperature[i] = this.temperature[i]! + Math.trunc(deltaMilliC);
    this.touch(i, x, y);
  }

  setBinding(x: number, y: number, binding: number): void {
    const i = this.idx(x, y);
    this.binding[i] = Math.max(0, Math.trunc(binding));
    this.touch(i, x, y);
  }

  setHeight(x: number, y: number, mm: number): void {
    const i = this.idx(x, y);
    this.heightMm[i] = Math.max(0, Math.trunc(mm));
    this.touch(i, x, y);
  }

  /** Writes a whole cell at once, taking material defaults for anything omitted. */
  writeCell(
    x: number,
    y: number,
    mat: MaterialId,
    opts: { massG?: number; milliC?: number; binding?: number; heightMm?: number } = {},
  ): void {
    const spec = MATERIALS[mat];
    const i = this.idx(x, y);
    this.material[i] = MATERIAL_INDEX[mat];
    this.mass[i] = Math.max(0, Math.trunc(opts.massG ?? spec.densityGPerCell));
    this.temperature[i] = Math.trunc(opts.milliC ?? this.ambientMilliC);
    this.binding[i] = Math.max(0, Math.trunc(opts.binding ?? spec.defaultBinding));
    this.heightMm[i] = Math.max(0, Math.trunc(opts.heightMm ?? spec.settledHeightMm));
    this.touch(i, x, y);
  }

  clearToAir(x: number, y: number): void {
    this.writeCell(x, y, 'air');
  }

  /* -------------------------------------------------------------- */
  /* Queries                                                         */
  /* -------------------------------------------------------------- */

  /** A projectile at flight altitude is stopped by this cell (passport §3.2). */
  blocksFlight(x: number, y: number, flightAltitudeMm: number): boolean {
    if (!this.inBounds(x, y)) return true;
    return this.heightMm[this.idx(x, y)]! > flightAltitudeMm;
  }

  blocksWizard(x: number, y: number, blockedHeightMm: number): boolean {
    if (!this.inBounds(x, y)) return true;
    return this.heightMm[this.idx(x, y)]! > blockedHeightMm;
  }

  cellView(x: number, y: number): CellView {
    const i = this.idx(x, y);
    return {
      p: [x, y],
      mat: this.materialOfIndex(i),
      m: this.mass[i]!,
      t: this.temperature[i]!,
      b: this.binding[i]!,
      h: this.heightMm[i]!,
    };
  }

  /** True when a cell still looks like untouched ambient air. */
  isAmbientAir(i: number): boolean {
    return (
      this.material[i] === MATERIAL_INDEX.air &&
      this.mass[i] === MATERIALS.air.densityGPerCell &&
      this.temperature[i] === this.ambientMilliC &&
      this.binding[i] === 0 &&
      this.heightMm[i] === 0
    );
  }

  /** Every cell that differs from ambient air, row-major. Used at match start. */
  sparseCells(): CellView[] {
    const out: CellView[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (!this.isAmbientAir(this.idx(x, y))) out.push(this.cellView(x, y));
      }
    }
    return out;
  }

  /* -------------------------------------------------------------- */
  /* Dirty / delta bookkeeping                                       */
  /* -------------------------------------------------------------- */

  /** Block indices touched since the last clear, in the order they were touched. */
  get dirtyBlockList(): readonly number[] {
    return this.dirtyBlocks;
  }

  clearDirtyBlocks(): void {
    for (const b of this.dirtyBlocks) this.blockDirty[b] = 0;
    this.dirtyBlocks = [];
  }

  /** Iterates the cells of a dirty block in row-major order. */
  *blockCells(block: number): Generator<{ i: number; x: number; y: number }> {
    const bx = (block % this.blocksX) * this.blockSize;
    const by = Math.floor(block / this.blocksX) * this.blockSize;
    for (let y = by; y < Math.min(by + this.blockSize, this.height); y++) {
      for (let x = bx; x < Math.min(bx + this.blockSize, this.width); x++) {
        yield { i: this.idx(x, y), x, y };
      }
    }
  }

  /** Cell indices written since the last call, in ascending index order. */
  drainChanged(): number[] {
    const out = [...this.changed].sort((a, b) => a - b);
    this.changed.clear();
    return out;
  }

  peekChanged(): ReadonlySet<number> {
    return this.changed;
  }

  viewOfIndex(i: number): CellView {
    return this.cellView(i % this.width, Math.floor(i / this.width));
  }

  /**
   * Every non-ambient cell as a flat run of [index, material, mass, temperature,
   * binding, height]. Flat rather than objects because a keyframe holds
   * thousands of these and the replay file has to stay small.
   */
  snapshotSparse(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.material.length; i++) {
      if (this.isAmbientAir(i)) continue;
      out.push(i, this.material[i]!, this.mass[i]!, this.temperature[i]!, this.binding[i]!, this.heightMm[i]!);
    }
    return out;
  }

  /** Applies a flat sparse run, optionally resetting everything else to ambient air first. */
  applySparse(flat: readonly number[], clearFirst: boolean): void {
    if (clearFirst) {
      this.material.fill(MATERIAL_INDEX.air);
      this.mass.fill(MATERIALS.air.densityGPerCell);
      this.temperature.fill(this.ambientMilliC);
      this.binding.fill(0);
      this.heightMm.fill(0);
    }
    for (let k = 0; k + 5 < flat.length; k += 6) {
      const i = flat[k]!;
      this.material[i] = flat[k + 1]!;
      this.mass[i] = flat[k + 2]!;
      this.temperature[i] = flat[k + 3]!;
      this.binding[i] = flat[k + 4]!;
      this.heightMm[i] = flat[k + 5]!;
    }
  }

  /**
   * Cells whose contents differ from a baseline snapshot, in the same flat
   * form. A keyframe records this rather than the whole world: the round's
   * generated terrain is reproducible from the seed, so only what the match
   * changed needs storing, which is usually tens of cells rather than thousands.
   */
  diffFromSparse(baseline: readonly number[]): number[] {
    const before = new Map<number, [number, number, number, number, number]>();
    for (let k = 0; k + 5 < baseline.length; k += 6) {
      before.set(baseline[k]!, [baseline[k + 1]!, baseline[k + 2]!, baseline[k + 3]!, baseline[k + 4]!, baseline[k + 5]!]);
    }
    const out: number[] = [];
    const emit = (i: number): void => {
      out.push(i, this.material[i]!, this.mass[i]!, this.temperature[i]!, this.binding[i]!, this.heightMm[i]!);
    };
    const seen = new Set<number>();
    for (let i = 0; i < this.material.length; i++) {
      const was = before.get(i);
      if (!was) {
        if (!this.isAmbientAir(i)) {
          emit(i);
          seen.add(i);
        }
        continue;
      }
      seen.add(i);
      if (
        was[0] !== this.material[i] ||
        was[1] !== this.mass[i] ||
        was[2] !== this.temperature[i] ||
        was[3] !== this.binding[i] ||
        was[4] !== this.heightMm[i]
      ) {
        emit(i);
      }
    }
    // A baseline cell the match reverted to ambient air still has to be stated,
    // or restoring would leave the old terrain standing.
    for (const i of before.keys()) {
      if (!seen.has(i) && this.isAmbientAir(i)) emit(i);
    }
    return out;
  }

  hashInto(h: Hasher): void {
    h.str('world').int(this.width).int(this.height);
    for (let i = 0; i < this.material.length; i++) {
      // Skip untouched air so the common case stays cheap and the hash stays
      // a function of what actually differs from the base layer.
      if (this.isAmbientAir(i)) continue;
      h.int(i)
        .int(this.material[i]!)
        .int(this.mass[i]!)
        .int(this.temperature[i]!)
        .int(this.binding[i]!)
        .int(this.heightMm[i]!);
    }
    h.int(-1);
  }
}
