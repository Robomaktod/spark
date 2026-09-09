/**
 * The match runner: handshake, turn loop, replay writing.
 *
 * Everything simulation-shaped lives in @spark/engine; this file is the I/O
 * shell around it.
 */
import { DEFAULT_RULES, validateActions, type ActionsMessage, type Rules, type Side, type SpellTemplate } from '@spark/protocol';
import { Match, Spellbook, checkSpellbook, type MatchResult } from '@spark/engine';
import { describeEvent } from '@spark/engine';
import { BotProcess, type BotSpec } from './botProcess.js';
import type { ReplayFile, ReplayTurn } from './replay.js';
import { REPLAY_VERSION } from './replay.js';

const SIDES: readonly Side[] = ['A', 'B'];

export interface RunOptions {
  readonly seed: string;
  readonly rules?: Rules;
  readonly bots: Readonly<Record<Side, BotSpec>>;
  readonly onEvent?: (line: string) => void;
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
      emit(`${side} (${options.bots[side].name}) registered ${spells.length} spells, ${check.pagesUsed}/${rules.spellbook.maxPages} pages`);
    }

    /* ---- the match ---- */
    const match = new Match({ rules, seed: options.seed, spellbooks: books });
    const turns: ReplayTurn[] = [];
    const eventLines: string[] = [];
    let eventCursor = 0;

    const deliverOutbox = (): void => {
      for (const item of match.drainOutbox()) {
        procs[item.side].send(item.message, item.message.type === 'match_start' || item.message.type === 'round_start');
      }
    };

    deliverOutbox();

    while (!match.finished) {
      const pending = match.pending;
      if (!pending) break;
      const side = pending.side;

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

      turns.push({
        round: pending.message.round,
        turn: pending.message.turn,
        side,
        actions,
        elapsedMs: elapsed,
        stderr: procs[side].drainStderr(),
      });

      match.submit(actions);

      const round = match.currentRound;
      if (round) {
        for (; eventCursor < round.events.length; eventCursor++) {
          const line = describeEvent(round.events[eventCursor]!);
          eventLines.push(line);
          emit(line);
        }
      } else {
        eventCursor = 0;
      }
      deliverOutbox();
    }

    const result = match.result;
    const replay: ReplayFile = {
      version: REPLAY_VERSION,
      seed: options.seed,
      rules,
      bots: {
        A: { name: options.bots.A.name, command: options.bots.A.command, pagesUsed: pagesUsed.A },
        B: { name: options.bots.B.name, command: options.bots.B.command, pagesUsed: pagesUsed.B },
      },
      spellbooks: { A: templates.A, B: templates.B },
      turns,
      events: eventLines,
      result,
      finishedAt: new Date().toISOString(),
    };

    return { result, replay };
  } finally {
    await Promise.all(SIDES.map((s) => procs[s].close()));
  }
}

export { SpellbookRejected };
