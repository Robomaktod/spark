/**
 * Replay playback: reconstructing a match from its action packets.
 *
 * Web plan §4 — the browser downloads a few kB of action packets and runs the
 * same engine the CLI ran. Nothing streams world state, seeking is local
 * computation, and the viewer cannot drift from the engine because it *is* the
 * engine. A rendering bug stays a rendering bug.
 *
 * Live mode uses the same class: packets arrive over a socket instead of from a
 * file, and `append` feeds them in as they land. One rendering path, not two.
 */
import type { Side, SpellTemplate, Rules } from '@spark/protocol';
import { Round, Spellbook, generateMap, roundLayout, spawnsForRound } from '@spark/engine';
import type { EngineEvent, ObjectPath } from '@spark/engine';
import {
  KEYFRAME_INTERVAL,
  type ReplayFile,
  type ReplayKeyframe,
  type ReplayTurn,
} from './format.js';

/** Everything the viewer needs about one reconstructed turn. */
export interface Frame {
  readonly index: number;
  readonly round: Round;
  readonly roundNumber: number;
  readonly turn: number;
  readonly side: Side;
  readonly events: readonly EngineEvent[];
  readonly paths: readonly ObjectPath[];
  readonly dirtyBlocks: readonly number[];
  readonly hash: string;
}

export class ReplayMismatch extends Error {
  constructor(
    readonly turnIndex: number,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `replay diverged at turn ${turnIndex}: recorded hash ${expected}, reconstructed ${actual}`,
    );
  }
}

/**
 * The turns of a replay, reconstructed on demand.
 *
 * The player owns the round sequence itself rather than driving a Match: the
 * scoring is already recorded in the file, and owning the sequence is what
 * makes a keyframe restore a single construction rather than a replay of every
 * round before it. Round layout comes from the engine's own `roundLayout`, so
 * the two cannot disagree about who moves first or which spawn is whose.
 */
export class ReplayPlayer {
  private readonly rules: Rules;
  private readonly books: Readonly<Record<Side, Spellbook>>;
  private round: Round | null = null;
  private roundNumber = 0;
  /** Index of the next turn to apply. */
  private cursor = 0;
  private lastFrame: Frame | null = null;

  constructor(private replayFile: ReplayFile) {
    this.rules = replayFile.rules;
    this.books = {
      A: new Spellbook(replayFile.spellbooks.A as SpellTemplate[], this.rules),
      B: new Spellbook(replayFile.spellbooks.B as SpellTemplate[], this.rules),
    };
  }

  get replay(): ReplayFile {
    return this.replayFile;
  }

  /** Live mode: extend the replay with turns that have just arrived. */
  append(turns: readonly ReplayTurn[]): void {
    this.replayFile = { ...this.replayFile, turns: [...this.replayFile.turns, ...turns] };
  }

  get turnCount(): number {
    return this.replayFile.turns.length;
  }

  /** How far playback has advanced: -1 before the first turn has been applied. */
  get position(): number {
    return this.cursor - 1;
  }

  get current(): Frame | null {
    return this.lastFrame;
  }

  get finished(): boolean {
    return this.cursor >= this.replayFile.turns.length;
  }

  /** Builds the Round for a round number, on its own freshly generated map. */
  private buildRound(roundNumber: number): Round {
    const layout = roundLayout(this.rules, roundNumber);
    const map = generateMap(this.replayFile.seed, this.rules);
    return new Round({
      rules: this.rules,
      world: map.world,
      spawns: spawnsForRound(map.spawns, layout),
      spellbooks: this.books,
      firstMover: layout.firstMover,
      round: roundNumber,
      game: layout.game,
    });
  }

  private roundFor(roundNumber: number): Round {
    if (!this.round || this.roundNumber !== roundNumber) {
      this.round = this.buildRound(roundNumber);
      this.roundNumber = roundNumber;
    }
    return this.round;
  }

  /**
   * Applies the next recorded turn.
   *
   * `verify` compares the reconstructed state hash against the one the CLI
   * recorded. That check is the whole point of shipping the engine to the
   * browser rather than writing a second renderer, so it is on by default.
   */
  step(verify = true): Frame | null {
    if (this.finished) return null;
    const record = this.replayFile.turns[this.cursor]!;
    const round = this.roundFor(record.round);
    if (round.finished) {
      // The recorded round ended early; nothing more can be applied to it.
      this.cursor++;
      return this.lastFrame;
    }
    round.submit(record.actions);

    const frame: Frame = {
      index: this.cursor,
      round,
      roundNumber: record.round,
      turn: record.turn,
      side: record.side,
      events: round.lastEvents,
      paths: round.lastPaths,
      dirtyBlocks: round.lastDirtyBlocks,
      hash: round.stateHash(),
    };
    if (verify && record.hash && record.hash !== frame.hash) {
      throw new ReplayMismatch(this.cursor, record.hash, frame.hash);
    }
    this.cursor++;
    this.lastFrame = frame;
    return frame;
  }

  /** Rewinds to before the first turn. */
  reset(): void {
    this.round = null;
    this.roundNumber = 0;
    this.cursor = 0;
    this.lastFrame = null;
  }

  /**
   * Moves playback so that `index` is the last turn applied. A backward seek
   * restores the nearest keyframe at or before the target, so it costs at most
   * `KEYFRAME_INTERVAL` turns of resimulation rather than a whole round.
   */
  seek(index: number, verify = false): Frame | null {
    const target = Math.max(-1, Math.min(index, this.replayFile.turns.length - 1));
    if (target < this.position) {
      const keyframe = nearestKeyframe(this.replayFile, target);
      if (keyframe) this.restoreKeyframe(keyframe);
      else this.reset();
    }
    while (this.position < target) {
      if (!this.step(verify)) break;
    }
    return this.lastFrame;
  }

  private restoreKeyframe(keyframe: ReplayKeyframe): void {
    const round = this.buildRound(keyframe.round);
    round.restore(keyframe.snapshot);
    this.round = round;
    this.roundNumber = keyframe.round;
    this.cursor = keyframe.afterTurnIndex + 1;
    this.lastFrame = {
      index: keyframe.afterTurnIndex,
      round,
      roundNumber: keyframe.round,
      turn: round.turn,
      side: round.current,
      events: [],
      paths: [],
      dirtyBlocks: [],
      hash: round.stateHash(),
    };
  }
}

/** The latest keyframe at or before a turn index, or null if there is none. */
export function nearestKeyframe(replay: ReplayFile, turnIndex: number): ReplayKeyframe | null {
  let best: ReplayKeyframe | null = null;
  for (const k of replay.keyframes) {
    if (k.afterTurnIndex > turnIndex) break;
    best = k;
  }
  return best;
}

/**
 * Whether a keyframe should be written after this many turns of a round.
 *
 * Each turn cycle is two entries in the log — one per wizard — so a keyframe
 * every `KEYFRAME_INTERVAL` turns is every 2N entries.
 */
export function shouldKeyframe(turnsInRound: number): boolean {
  return turnsInRound > 0 && turnsInRound % (KEYFRAME_INTERVAL * 2) === 0;
}

/** The map a round is played on, regenerated from the seed. */
export function arenaFor(
  replay: ReplayFile,
  roundNumber: number,
): {
  world: ReturnType<typeof generateMap>['world'];
  spawns: readonly [[number, number], [number, number]];
} {
  const layout = roundLayout(replay.rules, roundNumber);
  const map = generateMap(replay.seed, replay.rules);
  const spawns = spawnsForRound(map.spawns, layout);
  return {
    world: map.world,
    spawns: [
      [spawns[0][0], spawns[0][1]],
      [spawns[1][0], spawns[1][1]],
    ],
  };
}

export interface FlatEvent {
  readonly turnIndex: number;
  readonly round: number;
  readonly turn: number;
  readonly side: Side;
  readonly event: EngineEvent;
}

/** Every event in the replay, flattened with the turn it belongs to. */
export function allEvents(replay: ReplayFile): FlatEvent[] {
  const out: FlatEvent[] = [];
  replay.turns.forEach((t: ReplayTurn, turnIndex) => {
    for (const event of t.events) {
      out.push({ turnIndex, round: t.round, turn: t.turn, side: t.side, event });
    }
  });
  return out;
}
