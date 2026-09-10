import type { MaterialId } from './materials.js';
import type { Rules } from './rules.js';
import type { SpellTemplate, Vec2 } from './spell.js';

export const PROTOCOL_VERSION = '0.1.0';

export type Side = 'A' | 'B';

/* ------------------------------------------------------------------ */
/* Handshake (passport §14.2)                                          */
/* ------------------------------------------------------------------ */

export interface InitMessage {
  readonly type: 'init';
  readonly protocolVersion: string;
  readonly rules: Rules;
}

export interface SpellbookMessage {
  readonly type: 'spellbook';
  readonly spells: readonly SpellTemplate[];
}

export interface SpellbookResultMessage {
  readonly type: 'spellbook_result';
  readonly accepted: boolean;
  readonly pagesUsed: number;
  readonly maxPages: number;
  /** Per-spell page cost, so a bot can see what its book actually spent. */
  readonly pages: readonly { readonly spellId: string; readonly pages: number }[];
  readonly errors?: readonly string[];
}

/** A cell that differs from plain ambient air. */
export interface CellView {
  readonly p: Vec2;
  readonly mat: MaterialId;
  /** Mass in grams. */
  readonly m: number;
  /** Temperature in milli-Celsius. */
  readonly t: number;
  /** Binding. */
  readonly b: number;
  /** Height in mm. */
  readonly h: number;
}

export interface ArenaInfo {
  readonly width: number;
  readonly height: number;
  readonly seed: string;
  /**
   * The full sparse terrain at round start: every cell differing from ambient
   * air. Per-turn packets then carry only what changed, which is what keeps a
   * turn packet small on a 200x200 map. See docs/DECISIONS.md.
   */
  readonly cells: readonly CellView[];
  readonly spawns: readonly [Vec2, Vec2];
}

export interface MatchStartMessage {
  readonly type: 'match_start';
  readonly arena: ArenaInfo;
  readonly youAre: Side;
}

export interface RoundStartMessage {
  readonly type: 'round_start';
  readonly round: number;
  readonly game: number;
  readonly youAre: Side;
  readonly arena: ArenaInfo;
  readonly firstMover: Side;
}

/* ------------------------------------------------------------------ */
/* Turn packet (passport §14.3)                                        */
/* ------------------------------------------------------------------ */

export interface SelfView {
  readonly pos: Vec2;
  readonly facing: number;
  /** Whole HP, floored. */
  readonly hp: number;
  /** Exact HP in milli-HP. */
  readonly hpMilli: number;
  /** Whole mana, floored. */
  readonly mana: number;
  /** Exact mana in milli-mana; use this when checking affordability. */
  readonly manaMilli: number;
  readonly mp: number;
  /** Mana reserved by this turn's declared reaction, milli-mana. */
  readonly reservedMilli: number;
  /** Position of the wand, where every cast originates. */
  readonly wand: Vec2;
}

export interface OpponentView {
  readonly pos: Vec2;
  readonly facing: number;
  readonly hp: number;
  readonly hpMilli: number;
}

export interface ObjectView {
  readonly id: number;
  readonly p: Vec2;
  /** Velocity in cells per turn, truncated toward zero. */
  readonly v: Vec2;
  /** Velocity in milli-cells per turn; exact. */
  readonly vMilli: Vec2;
  readonly m: number;
  readonly mat: MaterialId;
  /** Temperature in milli-Celsius. */
  readonly t: number;
  readonly owner: Side;
  /** Cells the object occupies, relative to `p`. */
  readonly cells: readonly Vec2[];
}

export interface ConcentrationView {
  readonly objectId: number;
  /** Upkeep charged at the next upkeep step, milli-mana. */
  readonly upkeep: number;
}

export type CastResult =
  | 'ok'
  | 'none'
  | 'blocked'
  | 'unknown_spell'
  | 'bad_args'
  | 'insufficient_mana'
  | 'no_such_object'
  | 'already_concentrated';

export interface TurnMessage {
  readonly type: 'turn';
  readonly round: number;
  readonly turn: number;
  readonly youAre: Side;
  readonly you: SelfView;
  readonly opponent: OpponentView;
  /** Cells changed since this bot's previous packet. Empty on a quiet turn. */
  readonly cells: readonly CellView[];
  readonly objects: readonly ObjectView[];
  readonly concentrations: readonly ConcentrationView[];
  readonly lastCastResult: CastResult;
  /** Reasons the previous packet's actions were rejected, if any. */
  readonly rejected: readonly string[];
  /** Human-readable log of what happened since this bot last acted. */
  readonly events: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Action packet (passport §14.4)                                      */
/* ------------------------------------------------------------------ */

export interface MoveAction {
  /** Unit steps, each component in {-1, 0, 1}. */
  readonly path?: readonly Vec2[];
  /** Facing index 0..7 to end on. Charged at 1 MP per 45 degrees. */
  readonly turnTo?: number;
}

export type CastArgs = Readonly<Record<string, number | Vec2 | string>>;

export interface CastAction {
  readonly spellId: string;
  readonly args?: CastArgs;
  readonly concentrate?: boolean;
}

export type ChannelCommand =
  | {
      readonly kind: 'impulse';
      readonly objectId: number;
      readonly dir: Vec2;
      readonly speed: number;
    }
  | { readonly kind: 'addTemperature'; readonly objectId: number; readonly value: number }
  | { readonly kind: 'release'; readonly objectId: number };

export type TriggerSpec =
  | { readonly kind: 'objectEnteredRadius'; readonly r: number }
  | { readonly kind: 'opponentCast' }
  | { readonly kind: 'selfHpBelow'; readonly x: number }
  | { readonly kind: 'opponentWithinRadius'; readonly r: number }
  | {
      readonly kind: 'cellPropertyCrossed';
      readonly pos: Vec2;
      readonly prop: 'temperature' | 'binding' | 'height' | 'mass';
      readonly threshold: number;
      readonly dir: 'above' | 'below';
    };

export interface ReactAction {
  readonly trigger: TriggerSpec;
  readonly spellId: string;
  /** Late-bound placeholders `$triggerPos`, `$triggerObject`, `$selfPos` are allowed here. */
  readonly args?: CastArgs;
  readonly concentrate?: boolean;
}

export interface ActionsMessage {
  readonly type: 'actions';
  readonly move1?: MoveAction;
  readonly cast?: CastAction;
  readonly channel?: ChannelCommand;
  readonly move2?: MoveAction;
  readonly react?: ReactAction;
  readonly concentrationPriority?: readonly number[];
}

/* ------------------------------------------------------------------ */
/* Terminal messages                                                   */
/* ------------------------------------------------------------------ */

export interface RoundEndMessage {
  readonly type: 'round_end';
  readonly round: number;
  readonly winner: Side | null;
  readonly reason: 'hp' | 'turn_cap' | 'double_ko';
  readonly scores: Readonly<Record<Side, number>>;
  readonly manaSpentMilli: Readonly<Record<Side, number>>;
}

export interface MatchEndMessage {
  readonly type: 'match_end';
  readonly winner: Side | null;
  readonly scores: Readonly<Record<Side, number>>;
  readonly manaSpentMilli: Readonly<Record<Side, number>>;
  readonly tiebreak: 'none' | 'mana' | 'draw';
}

export type EngineToBot =
  | InitMessage
  | SpellbookResultMessage
  | MatchStartMessage
  | RoundStartMessage
  | TurnMessage
  | RoundEndMessage
  | MatchEndMessage;

export type BotToEngine = SpellbookMessage | ActionsMessage;

export const PLACEHOLDERS = ['$triggerPos', '$triggerObject', '$selfPos'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
