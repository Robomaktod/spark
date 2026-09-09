#!/usr/bin/env node
/**
 * spark-view — the terminal replay player (passport §16).
 *
 * The replay carries only the seed, the rules, the books and the ordered action
 * packets. Everything you see here is reconstructed by re-running the engine on
 * them, which means watching a replay is also a determinism check.
 *
 *   spark-view <replay.json> [--speed MS] [--round N] [--dump] [--no-colour]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_RULES, type Side } from '@spark/protocol';
import { Match, Spellbook, describeEvent, type Round } from '@spark/engine';
import { isReplayFile, type ReplayFile } from '@spark/cli/replay';
import { LEGEND, renderMap, renderPanel, type RenderOptions } from './render.js';

const ESC = String.fromCharCode(27);

interface ViewerArgs {
  readonly path: string;
  readonly speedMs: number;
  readonly round: number | null;
  readonly dump: boolean;
  readonly colour: boolean;
}

function parseArgs(argv: readonly string[]): ViewerArgs | null {
  let path = '';
  let speedMs = 120;
  let round: number | null = null;
  let dump = false;
  let colour = process.stdout.isTTY === true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--speed') speedMs = Number(argv[++i] ?? 120);
    else if (a === '--round') round = Number(argv[++i] ?? 1);
    else if (a === '--dump') dump = true;
    else if (a === '--colour' || a === '--color') colour = true;
    else if (a === '--no-colour' || a === '--no-color') colour = false;
    else if (!a.startsWith('--')) path = a;
  }
  return path ? { path, speedMs, round, dump, colour } : null;
}

function frame(
  round: Round,
  replay: ReplayFile,
  header: string,
  events: readonly string[],
  options: RenderOptions,
): string {
  const names: Record<Side, string> = { A: replay.bots.A.name, B: replay.bots.B.name };
  const lines = [
    header,
    ...renderMap(round, options),
    '',
    ...renderPanel(round, names),
    '',
    ...events.slice(-8).map((e) => '  ' + e),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write('usage: spark-view <replay.json> [--speed MS] [--round N] [--dump] [--no-colour]\n');
    process.exitCode = 2;
    return;
  }

  const raw: unknown = JSON.parse(readFileSync(resolve(args.path), 'utf8'));
  if (!isReplayFile(raw)) {
    process.stderr.write(args.path + ' is not a Spark replay\n');
    process.exitCode = 2;
    return;
  }
  const replay: ReplayFile = raw;
  const rules = replay.rules ?? DEFAULT_RULES;

  const match = new Match({
    rules,
    seed: replay.seed,
    spellbooks: {
      A: new Spellbook(replay.spellbooks.A, rules),
      B: new Spellbook(replay.spellbooks.B, rules),
    },
  });

  const options: RenderOptions = {
    cols: Math.max(40, (process.stdout.columns ?? 100) - 2),
    rows: Math.max(16, (process.stdout.rows ?? 44) - 16),
    colour: args.colour,
  };

  const clear = (): void => {
    if (!args.dump && process.stdout.isTTY) process.stdout.write(ESC + '[2J' + ESC + '[H');
    else process.stdout.write('\n');
  };

  let index = 0;
  let eventCursor = 0;
  const eventLines: string[] = [];

  while (!match.finished && index < replay.turns.length) {
    match.drainOutbox();
    const pending = match.pending;
    if (!pending) break;
    const recorded = replay.turns[index++]!;
    match.submit(recorded.actions);

    const round = match.currentRound;
    if (!round) {
      eventCursor = 0;
      continue;
    }
    for (; eventCursor < round.events.length; eventCursor++) {
      eventLines.push(describeEvent(round.events[eventCursor]!));
    }

    if (args.round !== null && round.round !== args.round) continue;

    const header =
      'SPARK  seed ' + replay.seed +
      '   round ' + round.round + '/' + rules.match.games * rules.match.roundsPerGame +
      '   turn ' + round.turn + '/' + rules.match.turnCap +
      '   ' + recorded.side + ' acted (' + recorded.elapsedMs + ' ms)' +
      '   hash ' + round.stateHash();
    clear();
    process.stdout.write(frame(round, replay, header, eventLines, options) + '\n');
    if (!args.dump && args.speedMs > 0) await sleep(args.speedMs);
  }

  process.stdout.write('\n' + LEGEND + '\n\n');
  for (const r of replay.result.rounds) {
    process.stdout.write(
      'round ' + r.round + ' (game ' + r.game + '): ' +
        (r.winner ? r.winner + ' wins' : 'tie') + ' after ' + r.turns + ' turns (' + r.reason + ')\n',
    );
  }
  const res = replay.result;
  process.stdout.write(
    '\nfinal  A ' + res.scores.A + ' : ' + res.scores.B + ' B   ' +
      (res.winner ? res.winner + ' wins the match' : 'draw') +
      (res.tiebreak === 'mana' ? ' (mana tiebreak)' : '') + '\n',
  );

  const stderrLines = replay.turns.flatMap((t): readonly string[] => t.stderr);
  if (stderrLines.length > 0) {
    process.stdout.write('\nbot stderr (last 10 lines):\n');
    for (const line of stderrLines.slice(-10)) process.stdout.write('  ' + line + '\n');
  }
}

main().catch((err: unknown) => {
  process.stderr.write(((err as Error).stack ?? String(err)) + '\n');
  process.exitCode = 1;
});
