/**
 * Round snapshots — the keyframes the web viewer seeks with (web plan §4, §10.3).
 *
 * The browser reconstructs a match by re-running the engine over the recorded
 * action packets. Seeking forward is just more simulation; seeking backwards
 * would mean restarting the round, so a snapshot is written every few turns and
 * a seek restores the nearest one and re-simulates from there. Worst case is a
 * handful of turns of resimulation.
 *
 * The world is stored as a diff against the round's generated terrain, which is
 * reproducible from the seed. That keeps a keyframe to the cells the match
 * actually changed — tens, not thousands.
 */
import type { MaterialId, Side } from '@spark/protocol';

export interface WizardSnapshot {
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  readonly hpMilli: number;
  readonly manaMilli: number;
  readonly mp: number;
  readonly reservedMilli: number;
  readonly manaSpentMilli: number;
}

export interface ObjectSnapshot {
  readonly id: number;
  readonly owner: Side;
  readonly spellId: string;
  readonly xMilli: number;
  readonly yMilli: number;
  readonly vxMilli: number;
  readonly vyMilli: number;
  readonly massG: number;
  readonly material: MaterialId;
  readonly temperatureMilliC: number;
  readonly concentrated: boolean;
  readonly settled: boolean;
  readonly cells: readonly (readonly [number, number])[];
  /** Impact shape and ops, so a restored object still knows what it does. */
  readonly impact: {
    readonly cells: readonly (readonly [number, number])[];
    readonly canonicalCellCount: number;
    readonly ops: readonly { readonly op: string; readonly value: number }[];
  } | null;
}

export interface SideSnapshot {
  readonly lastCastResult: string;
  readonly concentrations: readonly number[];
  readonly concentrationPriority: readonly number[];
  readonly opponentCastSinceDeclare: boolean;
  readonly pendingCells: readonly number[];
  readonly eventCursor: number;
  /** A reaction armed but not yet expired, if any. */
  readonly reaction: {
    readonly declaration: unknown;
    readonly reservedMilli: number;
    readonly declaredOnTurn: number;
    readonly fired: boolean;
  } | null;
}

export interface RoundSnapshot {
  readonly round: number;
  readonly game: number;
  readonly turn: number;
  readonly slot: number;
  readonly nextObjectId: number;
  readonly finished: boolean;
  readonly winner: Side | null;
  readonly reason: string;
  /** Cells differing from the round's generated terrain, flat [i, mat, m, t, b, h]. */
  readonly cells: readonly number[];
  readonly wizards: Readonly<Record<Side, WizardSnapshot>>;
  readonly objects: readonly ObjectSnapshot[];
  readonly sides: Readonly<Record<Side, SideSnapshot>>;
  readonly eventCount: number;
}
