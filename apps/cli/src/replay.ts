/**
 * Replay files (passport §13, §16).
 *
 * A replay is the map seed, a snapshot of the rules, the locked spellbooks and
 * the ordered log of bot action packets. Because the engine is deterministic,
 * that is enough to reconstruct the match bit for bit — which is what makes a
 * tournament dispute resolvable. Bot stderr rides along so the author can see
 * what their bot was thinking when it lost.
 */
import type { ActionsMessage, Rules, Side, SpellTemplate } from '@spark/protocol';
import type { MatchResult } from '@spark/engine';

export const REPLAY_VERSION = '0.1.0';

export interface ReplayBotInfo {
  readonly name: string;
  readonly command: readonly string[];
  readonly pagesUsed: number;
}

export interface ReplayTurn {
  readonly round: number;
  readonly turn: number;
  readonly side: Side;
  /** null means the bot timed out or crashed and forfeited the turn. */
  readonly actions: ActionsMessage | null;
  readonly elapsedMs: number;
  readonly stderr: readonly string[];
}

export interface ReplayFile {
  readonly version: string;
  readonly seed: string;
  readonly rules: Rules;
  readonly bots: Readonly<Record<Side, ReplayBotInfo>>;
  readonly spellbooks: Readonly<Record<Side, readonly SpellTemplate[]>>;
  readonly turns: readonly ReplayTurn[];
  readonly events: readonly string[];
  readonly result: MatchResult;
  readonly finishedAt: string;
}

export function isReplayFile(v: unknown): v is ReplayFile {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['version'] === 'string' &&
    typeof r['seed'] === 'string' &&
    Array.isArray(r['turns']) &&
    typeof r['rules'] === 'object'
  );
}
