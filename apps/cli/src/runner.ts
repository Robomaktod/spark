/**
 * The match runner: handshake, turn loop, replay writing.
 *
 * Everything simulation-shaped lives in @spark/engine; this file is the I/O
 * shell around it.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_RULES,
  validateActions,
  type ActionsMessage,
  type Rules,
  type Side,
  type SpellTemplate,
} from '@spark/protocol';
import { Match, Spellbook, checkSpellbook, describeEvent, type MatchResult } from '@spark/engine';
import {
  REPLAY_VERSION,
  shouldKeyframe,
  type ReplayFile,
  type ReplayKeyframe,
  type ReplayRoundInfo,
  type ReplayTurn,
} from '@spark/replay';
import { BotProcess, type BotSpec } from './botProcess.js';

const SIDES: readonly Side[] = ['A', 'B'];

export interface RunOptions {
  readonly seed: string;
  readonly rules?: Rules;
  readonly bots: Readonly<Record<Side, BotSpec>>;
  readonly onEvent?: (line: string) => void;
  /**
   * Called once the handshake is done, before the first turn. A live viewer
   * needs the locked spellbooks to reconstruct the match, and they only exist
   * after both bots have registered.
   */
  readonly onStart?: (info: {
    readonly rules: Rules;
    readonly spellbooks: Readonly<Record<Side, readonly SpellTemplate[]>>;
    readonly pagesUsed: Readonly<Record<Side, number>>;
  }) => void;
  /** Called with each turn as it completes, for live streaming (web plan §3). */
  readonly onTurn?: (turn: ReplayTurn, roundInfo: ReplayRoundInfo) => void;
}

export interface RunOutcome {
  readonly result: MatchResult;
  readonly replay: ReplayFile;
}

class SpellbookRejected extends Error {
  constructor(
    readonly side: Side,
    readonly errors: readonly string[],
  ) {
    super(`bot ${side} submitted an invalid spellbook: ${errors.join('; ')}`);
  }
}

export async function runMatch(options: RunOptions): Promise<RunOutcome> {
  const rules = options.rules ?? DEFAULT_RULES;
  const emit = options.onEvent ?? ((): void => {});

  const procs: Record<Side, BotProcess> = {
    A: new BotProcess(options.bots.A, rules),
    B: new BotProcess(options.bots.B, rules),
  };

  const templates: Record<Side, SpellTemplate[]> = { A: [], B: [] };
  const books: Record<Side, Spellbook> = {} as Record<Side, Spellbook>;
  const pagesUsed: Record<Side, number> = { A: 0, B: 0 };

  try {
    /* ---- handshake (passport §14.2): the book is locked before the map ---- */
    for (const side of SIDES) {
      procs[side].start();
      const reply = await procs[side].requestSpellbook();
      const spells = reply && reply.type === 'spellbook' ? reply.spells : [];
      const check = checkSpellbook(spells, rules);

      procs[side].send({
        type: 'spellbook_result',
        accepted: check.ok,
        pagesUsed: check.pagesUsed,
        maxPages: rules.spellbook.maxPages,
        pages: check.pages.map((p) => ({ spellId: p.spellId, pages: p.pages })),
        ...(check.ok ? {} : { errors: check.errors }),
      });

      if (!check.ok) throw new SpellbookRejected(side, check.errors);

      templates[side] = [...spells];
      books[side] = new Spellbook(spells, rules);
      pagesUsed[side] = check.pagesUsed;
      procs[side].rememberInit();
      emit(
        `${side} (${options.bots[side].name}) registered ${spells.length} spells, ` +
          `${check.pagesUsed}/${rules.spellbook.maxPages} pages`,
      );
    }

    options.onStart?.({
      rules,
      spellbooks: { A: templates.A, B: templates.B },
      pagesUsed: { ...pagesUsed },
    });

    /* ---- the match ---- */
    const match = new Match({ rules, seed: options.seed, spellbooks: books });
    const turns: ReplayTurn[] = [];
    const keyframes: ReplayKeyframe[] = [];
    const roundInfos: ReplayRoundInfo[] = [];

    const deliverOutbox = (): void => {
      for (const item of match.drainOutbox()) {
        const remember = item.message.type === 'match_start' || item.message.type === 'round_start';
        procs[item.side].send(item.message, remember);
      }
    };

    deliverOutbox();

    let turnsThisRound = 0;

    while (!match.finished) {
      const pending = match.pending;
      if (!pending) break;
      const side = pending.side;
      const round = match.currentRound;
      if (!round) break;

      const started = Date.now();
      const reply = await procs[side].ask<ActionsMessage>(pending.message, rules.limits.turnMs);
      const elapsed = Date.now() - started;

      let actions: ActionsMessage | null = null;
      if (reply !== null) {
        const check = validateActions(reply);
        actions = check.ok ? check.value! : null;
        if (!check.ok) emit(`${side} sent a malformed action packet: ${check.errors.join('; ')}`);
      } else {
        emit(`${side} timed out after ${elapsed} ms; restarting the process`);
        await procs[side].restart();
      }

      const roundNumber = round.round;
      const game = round.game;
      const firstMover = roundNumber % 2 === 1 ? 'A' : 'B';
      if (!roundInfos.some((r) => r.round === roundNumber)) {
        turnsThisRound = 0;
        roundInfos.push({
          round: roundNumber,
          game,
          firstMover,
          firstTurnIndex: turns.length,
          turnCount: 0,
          winner: null,
          reason: '',
        });
      }

      match.submit(actions);
      turnsThisRound++;

      const record: ReplayTurn = {
        round: roundNumber,
        turn: pending.message.turn,
        side,
        actions,
        elapsedMs: elapsed,
        stderr: procs[side].drainStderr(),
        events: [...round.lastEvents],
        paths: [...round.lastPaths],
        hash: round.stateHash(),
      };
      turns.push(record);

      for (const e of record.events) emit(describeEvent(e));

      // Keyframes are written on the round that produced them, so a restore
      // never has to know what happened in any earlier round.
      if (!round.finished && shouldKeyframe(turnsThisRound)) {
        keyframes.push({
          afterTurnIndex: turns.length - 1,
          round: roundNumber,
          snapshot: round.snapshot(),
        });
      }

      const info = roundInfos[roundInfos.length - 1]!;
      roundInfos[roundInfos.length - 1] = {
        ...info,
        turnCount: turnsThisRound,
        winner: round.finished ? round.winner : info.winner,
        reason: round.finished ? round.reason : info.reason,
      };

      options.onTurn?.(record, roundInfos[roundInfos.length - 1]!);
      deliverOutbox();
    }

    const result = match.result;
    const replay: ReplayFile = {
      version: REPLAY_VERSION,
      id: randomUUID(),
      seed: options.seed,
      rules,
      bots: {
        A: { name: options.bots.A.name, command: options.bots.A.command, pagesUsed: pagesUsed.A },
        B: { name: options.bots.B.name, command: options.bots.B.command, pagesUsed: pagesUsed.B },
      },
      spellbooks: { A: templates.A, B: templates.B },
      rounds: roundInfos,
      turns,
      keyframes,
      result,
      finishedAt: new Date().toISOString(),
    };

    return { result, replay };
  } finally {
    await Promise.all(SIDES.map((s) => procs[s].close()));
  }
}

export { SpellbookRejected };
