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
