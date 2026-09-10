/**
 * The match (passport §5.2): four rounds, structured as two games of two.
 * Each bot plays each spawn point twice and moves first twice, so terrain
 * advantage cancels without forcing symmetric map generation.
 *
 * Like Round, Match does no I/O. The caller pumps it: read `pending`, hand back
 * an action packet, deliver whatever piled up in `outbox`.
 */
import type {
  ArenaInfo,
  EngineToBot,
  MatchEndMessage,
  Rules,
  RoundEndMessage,
  RoundStartMessage,
  Side,
  TurnMessage,
  Vec2,
} from '@spark/protocol';
import type { ActionsMessage } from '@spark/protocol';
import type { Spellbook } from './spellbook.js';
import { Round } from './round.js';
import { generateMap, type MapGenOptions } from './mapgen.js';
import type { EngineEvent } from './events.js';

export interface MatchConfig {
  readonly rules: Rules;
  readonly seed: string;
  readonly spellbooks: Readonly<Record<Side, Spellbook>>;
  readonly mapOptions?: MapGenOptions;
}

export interface MatchResult {
  readonly winner: Side | null;
  readonly scores: Readonly<Record<Side, number>>;
  readonly manaSpentMilli: Readonly<Record<Side, number>>;
  readonly tiebreak: 'none' | 'mana' | 'draw';
  readonly rounds: readonly {
    readonly round: number;
    readonly game: number;
    readonly winner: Side | null;
    readonly reason: string;
    readonly turns: number;
  }[];
}

export interface OutboxItem {
  readonly side: Side;
  readonly message: EngineToBot;
}

export interface PendingTurn {
  readonly side: Side;
  readonly message: TurnMessage;
}

const SIDES: readonly Side[] = ['A', 'B'];

export interface RoundLayout {
  readonly game: number;
  readonly firstMover: Side;
  /** Game 2 swaps the spawns, so each bot plays each start twice. */
  readonly swap: boolean;
}

/**
 * Which game a round belongs to, who moves first, and whether the spawns are
 * swapped (passport §5.2). Exported because the replay player rebuilds rounds
 * without going through Match, and the two must agree exactly.
 */
export function roundLayout(rules: Rules, roundNumber: number): RoundLayout {
  const game = Math.ceil(roundNumber / rules.match.roundsPerGame);
  const inGame = ((roundNumber - 1) % rules.match.roundsPerGame) + 1;
  return { game, firstMover: inGame === 1 ? 'A' : 'B', swap: game > 1 };
}

/** The spawn pair for a round, after the game-2 swap. */
export function spawnsForRound(
  spawns: readonly [Vec2, Vec2],
  layout: RoundLayout,
): readonly [Vec2, Vec2] {
  return layout.swap ? [spawns[1], spawns[0]] : [spawns[0], spawns[1]];
}

export class Match {
  readonly rules: Rules;
  readonly seed: string;
  readonly spellbooks: Readonly<Record<Side, Spellbook>>;
  private readonly mapOptions: MapGenOptions;

  /** Score in halves internally, so a tie is an integer. */
  private readonly halfScores: Record<Side, number> = { A: 0, B: 0 };
  private readonly manaSpent: Record<Side, number> = { A: 0, B: 0 };
  private readonly roundLog: MatchResult['rounds'][number][] = [];

  readonly outbox: OutboxItem[] = [];
  readonly events: EngineEvent[] = [];

  private roundIndex = 0;
  private round: Round | null = null;
  finished = false;

  constructor(config: MatchConfig) {
    this.rules = config.rules;
    this.seed = config.seed;
    this.spellbooks = config.spellbooks;
    this.mapOptions = config.mapOptions ?? {};

    const arena = this.buildArena(1);
    for (const side of SIDES) {
      this.outbox.push({ side, message: { type: 'match_start', arena, youAre: side } });
    }
    this.startRound();
  }

  private layoutFor(roundNumber: number): RoundLayout {
    return roundLayout(this.rules, roundNumber);
  }

  private buildArena(roundNumber: number): ArenaInfo {
    const layout = this.layoutFor(roundNumber);
    const map = generateMap(this.seed, this.rules, this.mapOptions);
    const spawns = spawnsForRound(map.spawns, layout);
    return {
      width: map.world.width,
      height: map.world.height,
      seed: this.seed,
      cells: map.world.sparseCells(),
      spawns,
    };
  }

  private startRound(): void {
    this.roundIndex++;
    const total = this.rules.match.games * this.rules.match.roundsPerGame;
    if (this.roundIndex > total) {
      this.endMatch();
      return;
    }

    const { game, firstMover } = this.layoutFor(this.roundIndex);
    const map = generateMap(this.seed, this.rules, this.mapOptions);
    const spawns = spawnsForRound(map.spawns, this.layoutFor(this.roundIndex));

    this.round = new Round({
      rules: this.rules,
      world: map.world,
      spawns,
      spellbooks: this.spellbooks,
      firstMover,
      round: this.roundIndex,
      game,
    });

    const arena: ArenaInfo = {
      width: map.world.width,
      height: map.world.height,
      seed: this.seed,
      cells: map.world.sparseCells(),
      spawns,
    };
    for (const side of SIDES) {
      const message: RoundStartMessage = {
        type: 'round_start',
        round: this.roundIndex,
        game,
        youAre: side,
        arena,
        firstMover,
      };
      this.outbox.push({ side, message });
    }
  }

  /** The turn packet awaiting an answer, or null once the match is over. */
  get pending(): PendingTurn | null {
    if (this.finished || !this.round) return null;
    const side = this.round.current;
    return { side, message: this.round.turnMessage(side) };
  }

  get currentRound(): Round | null {
    return this.round;
  }

  submit(actions: ActionsMessage | null): void {
    if (this.finished || !this.round) throw new Error('Match.submit: the match is over');
    const round = this.round;
    round.submit(actions);
    if (!round.finished) return;

    this.events.push(...round.events);
    for (const side of SIDES) this.manaSpent[side] += round.wizards[side].manaSpentMilli;

    if (round.winner === null) {
      this.halfScores.A += 1;
      this.halfScores.B += 1;
    } else {
      this.halfScores[round.winner] += 2;
    }

    this.roundLog.push({
      round: round.round,
      game: round.game,
      winner: round.winner,
      reason: round.reason,
      turns: round.turn,
    });

    const message: RoundEndMessage = {
      type: 'round_end',
      round: round.round,
      winner: round.winner,
      reason: round.reason,
      scores: this.scores,
      manaSpentMilli: { ...this.manaSpent },
    };
    for (const side of SIDES) this.outbox.push({ side, message });

    this.round = null;
    this.startRound();
  }

  get scores(): Record<Side, number> {
    return { A: this.halfScores.A / 2, B: this.halfScores.B / 2 };
  }

  /**
   * Passport §5.3: at 2-2 the tiebreak is total mana spent across all four
   * rounds, lower wins. If both spent zero, the match is a true draw.
   */
  private endMatch(): void {
    this.finished = true;
    const scores = this.scores;
    let winner: Side | null = null;
    let tiebreak: MatchResult['tiebreak'] = 'none';

    if (this.halfScores.A > this.halfScores.B) winner = 'A';
    else if (this.halfScores.B > this.halfScores.A) winner = 'B';
    else if (this.manaSpent.A === 0 && this.manaSpent.B === 0) tiebreak = 'draw';
    else {
      tiebreak = 'mana';
      winner =
        this.manaSpent.A < this.manaSpent.B ? 'A' : this.manaSpent.B < this.manaSpent.A ? 'B' : null;
      if (winner === null) tiebreak = 'draw';
    }

    const message: MatchEndMessage = {
      type: 'match_end',
      winner,
      scores,
      manaSpentMilli: { ...this.manaSpent },
      tiebreak,
    };
    for (const side of SIDES) this.outbox.push({ side, message });
  }

  get result(): MatchResult {
    const scores = this.scores;
    let winner: Side | null = null;
    let tiebreak: MatchResult['tiebreak'] = 'none';
    if (this.halfScores.A > this.halfScores.B) winner = 'A';
    else if (this.halfScores.B > this.halfScores.A) winner = 'B';
    else if (this.manaSpent.A === 0 && this.manaSpent.B === 0) tiebreak = 'draw';
    else {
      tiebreak = 'mana';
      winner = this.manaSpent.A < this.manaSpent.B ? 'A' : this.manaSpent.B < this.manaSpent.A ? 'B' : null;
      if (winner === null) tiebreak = 'draw';
    }
    return {
      winner,
      scores,
      manaSpentMilli: { ...this.manaSpent },
      tiebreak,
      rounds: [...this.roundLog],
    };
  }

  drainOutbox(): OutboxItem[] {
    return this.outbox.splice(0, this.outbox.length);
  }
}
