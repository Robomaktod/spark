/**
 * The wizard (passport §4). An HP entity, not a body of cells: damage arrives
 * from physics, never from a damage tag on a spell.
 */
import type { Rules, SelfView, Side, OpponentView, Vec2 } from '@spark/protocol';
import { MILLI_HP_PER_HP, MILLI_MANA_PER_MANA } from '@spark/protocol';
import type { Cell } from './shapes.js';
import { FACING_VECTORS } from './shapes.js';
import { Hasher } from './hash.js';
import { idivRound, isqrt } from './fp.js';

/** Unit vector of a facing, in milli-cells, so diagonals are not longer than cardinals. */
export function facingUnitMilli(facing: number): readonly [number, number] {
  const [dx, dy] = FACING_VECTORS[facing % 8]!;
  const lenMilli = isqrt((dx * dx + dy * dy) * 1_000_000);
  if (lenMilli === 0) return [0, 0];
  return [idivRound(dx * 1_000_000, lenMilli), idivRound(dy * 1_000_000, lenMilli)];
}

export class Wizard {
  hpMilli: number;
  manaMilli: number;
  mp: number;
  /** Mana held against this turn's declared reaction; refunded if it does not fire. */
  reservedMilli = 0;
  /** Cumulative spend, for the passport §5.3 mana tiebreak. */
  manaSpentMilli = 0;

  constructor(
    readonly side: Side,
    public x: number,
    public y: number,
    public facing: number,
    readonly rules: Rules,
  ) {
    this.hpMilli = rules.wizard.hpMilli;
    this.manaMilli = rules.wizard.manaStartMilli;
    this.mp = rules.wizard.mpPerTurn;
  }

  get alive(): boolean {
    return this.hpMilli > 0;
  }

  footprintCells(): Cell[] {
    const r = this.rules.wizard.footprintRadius;
    const out: Cell[] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) out.push([this.x + dx, this.y + dy]);
    }
    return out;
  }

  get footprintArea(): number {
    const r = this.rules.wizard.footprintRadius;
    return (r * 2 + 1) * (r * 2 + 1);
  }

  covers(cx: number, cy: number): boolean {
    const r = this.rules.wizard.footprintRadius;
    return Math.abs(cx - this.x) <= r && Math.abs(cy - this.y) <= r;
  }

  /**
   * Where a cast originates. The wand sits `wandOffsetCells` ahead of the
   * footprint edge along the facing vector and cannot be targeted or lost.
   */
  wandCell(extraOffset = 0): Cell {
    const [ux, uy] = facingUnitMilli(this.facing);
    const dist = this.rules.wizard.footprintRadius + this.rules.wizard.wandOffsetCells + extraOffset;
    return [this.x + idivRound(ux * dist, 1000), this.y + idivRound(uy * dist, 1000)];
  }

  /**
   * Manifest centre for a body of the given radius. Passport §4: the offset is
   * `max(wandOffset, bodyRadius + 1)` so a wide body never overlaps its caster.
   */
  manifestCell(bodyRadius: number): Cell {
    const [ux, uy] = facingUnitMilli(this.facing);
    const offset = Math.max(this.rules.wizard.wandOffsetCells, bodyRadius + 1);
    const dist = this.rules.wizard.footprintRadius + offset;
    return [this.x + idivRound(ux * dist, 1000), this.y + idivRound(uy * dist, 1000)];
  }

  spendMana(milli: number): void {
    this.manaMilli -= milli;
    this.manaSpentMilli += milli;
  }

  refundMana(milli: number): void {
    this.manaMilli += milli;
    this.manaSpentMilli -= milli;
  }

  /** Mana available after this turn's reaction reservation. */
  get spendableMilli(): number {
    return this.manaMilli - this.reservedMilli;
  }

  damage(milliHp: number): void {
    this.hpMilli = Math.max(0, this.hpMilli - Math.max(0, milliHp));
  }

  selfView(): SelfView {
    return {
      pos: [this.x, this.y],
      facing: this.facing,
      hp: Math.floor(this.hpMilli / MILLI_HP_PER_HP),
      hpMilli: this.hpMilli,
      mana: Math.floor(this.manaMilli / MILLI_MANA_PER_MANA),
      manaMilli: this.manaMilli,
      mp: this.mp,
      reservedMilli: this.reservedMilli,
      wand: this.wandCell() as unknown as Vec2,
    };
  }

  opponentView(): OpponentView {
    return {
      pos: [this.x, this.y],
      facing: this.facing,
      hp: Math.floor(this.hpMilli / MILLI_HP_PER_HP),
      hpMilli: this.hpMilli,
    };
  }

  hashInto(h: Hasher): void {
    h.str(this.side)
      .int(this.x)
      .int(this.y)
      .int(this.facing)
      .int(this.hpMilli)
      .int(this.manaMilli)
      .int(this.mp)
      .int(this.reservedMilli)
      .int(this.manaSpentMilli);
  }
}
