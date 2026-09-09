#!/usr/bin/env node
/**
 * spark — match runner and replay tool.
 *
 *   spark run [--seed S] [--a CMD] [--b CMD] [--replay FILE] [--quiet]
 *   spark verify FILE          re-run a replay and confirm it reproduces
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_RULES } from '@spark/protocol';
import { Match, Spellbook } from '@spark/engine';
import { runMatch } from './runner.js';
import { isReplayFile, type ReplayFile } from './replay.js';

interface Args {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

function parseArgs(argv: readonly string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command = 'run';
  let first = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (first) {
      command = arg;
      first = false;
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

const DEFAULT_BOT_A = ['node', resolve('bots/naive/dist/src/main.js')];
const DEFAULT_BOT_B = ['node', resolve('bots/positional/dist/src/main.js')];

/** "node bots/positional/dist/src/main.js" reads better as "positional". */
function nameOf(command: readonly string[]): string {
  const script = command.at(-1) ?? 'bot';
  const parts = script.split('/').filter((p) => p.length > 0);
  const i = parts.indexOf('bots');
  if (i >= 0 && parts[i + 1]) return parts[i + 1]!;
  return parts.at(-1)?.replace(/\.[jt]s$/, '') ?? 'bot';
}

async function cmdRun(args: Args): Promise<number> {
  const seed = String(args.flags['seed'] ?? 'spark');
  const quiet = args.flags['quiet'] === true;
  const commandA = args.flags['a'] ? String(args.flags['a']).split(' ') : DEFAULT_BOT_A;
  const commandB = args.flags['b'] ? String(args.flags['b']).split(' ') : DEFAULT_BOT_B;

  const outcome = await runMatch({
    seed,
    bots: {
      A: { name: String(args.flags['a-name'] ?? nameOf(commandA)), command: commandA },
      B: { name: String(args.flags['b-name'] ?? nameOf(commandB)), command: commandB },
    },
    onEvent: quiet ? undefined : (line) => process.stdout.write(line + '\n'),
  });

  const r = outcome.result;
  process.stdout.write('\n');
  for (const round of r.rounds) {
    process.stdout.write(
      `round ${round.round} (game ${round.game}): ${round.winner ? `${round.winner} wins` : 'tie'} ` +
        `after ${round.turns} turns (${round.reason})\n`,
    );
  }
  process.stdout.write(`\nscore  A ${r.scores.A} : ${r.scores.B} B\n`);
  process.stdout.write(
    `mana   A ${(r.manaSpentMilli.A / 1000).toFixed(1)} : ${(r.manaSpentMilli.B / 1000).toFixed(1)} B\n`,
  );
  process.stdout.write(
    `result ${r.winner ? `${r.winner} wins the match` : 'draw'}${r.tiebreak === 'mana' ? ' (on the mana tiebreak)' : ''}\n`,
  );

  const replayPath = args.flags['replay'];
  if (typeof replayPath === 'string') {
    mkdirSync(dirname(resolve(replayPath)), { recursive: true });
    writeFileSync(resolve(replayPath), JSON.stringify(outcome.replay, null, 1));
    process.stdout.write(`replay written to ${replayPath}\n`);
  }
  return 0;
}

/**
 * Determinism check (passport §13): re-run the recorded action packets through
 * a fresh engine and confirm the outcome is identical.
 */
async function cmdVerify(args: Args): Promise<number> {
  const path = args.positional[0];
  if (!path) {
    process.stderr.write('usage: spark verify <replay.json>\n');
    return 2;
  }
  const raw: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!isReplayFile(raw)) {
    process.stderr.write(`${path} is not a Spark replay\n`);
    return 2;
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

  let index = 0;
  const hashes: string[] = [];
  while (!match.finished && index < replay.turns.length) {
    match.drainOutbox();
    const pending = match.pending;
    if (!pending) break;
    const recorded = replay.turns[index++]!;
    if (recorded.side !== pending.side) {
      process.stderr.write(`turn ${index}: replay says ${recorded.side}, engine expects ${pending.side}\n`);
      return 1;
    }
    match.submit(recorded.actions);
    const round = match.currentRound;
    if (round) hashes.push(round.stateHash());
  }

  const same = JSON.stringify(match.result) === JSON.stringify(replay.result);
  process.stdout.write(`replayed ${index} turns, ${hashes.length} state hashes\n`);
  process.stdout.write(same ? 'reproduces exactly\n' : 'DIVERGED from the recorded result\n');
  if (!same) {
    process.stdout.write(`recorded: ${JSON.stringify(replay.result.scores)}\n`);
    process.stdout.write(`replayed: ${JSON.stringify(match.result.scores)}\n`);
  }
  return same ? 0 : 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let code = 0;
  switch (args.command) {
    case 'run':
      code = await cmdRun(args);
      break;
    case 'verify':
      code = await cmdVerify(args);
      break;
    default:
      process.stderr.write(
        'usage:\n  spark run [--seed S] [--a "CMD"] [--b "CMD"] [--replay FILE] [--quiet]\n' +
          '  spark verify <replay.json>\n',
      );
      code = 2;
  }
  process.exitCode = code;
}

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
