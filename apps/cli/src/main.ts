#!/usr/bin/env node
/**
 * spark — match runner and replay tool.
 *
 *   spark run [--seed S] [--a CMD] [--b CMD] [--replay FILE] [--quiet]
 *   spark verify FILE          re-run a replay and confirm it reproduces
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runMatch } from './runner.js';
import { LivePublisher, publishReplay } from './publish.js';
import type { Rules, Side, SpellTemplate } from '@spark/protocol';
import type { MatchResult } from '@spark/engine';
import { REPLAY_VERSION, ReplayPlayer, isReplayFile, type ReplayFile } from '@spark/replay';

/** Placeholder result on a live header; the real one arrives with the `end` frame. */
const EMPTY_RESULT: MatchResult = {
  winner: null,
  scores: { A: 0, B: 0 },
  manaSpentMilli: { A: 0, B: 0 },
  tiebreak: 'none',
  rounds: [],
};

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
  const relay = typeof args.flags['publish'] === 'string' ? args.flags['publish'] : null;
  const wantsLive = args.flags['live'] === true && relay !== null;
  const key = typeof args.flags['key'] === 'string' ? args.flags['key'] : undefined;

  // A live match needs an id before the first turn, and the replay's own id is
  // only minted at the end, so the stream gets one up front and the finished
  // file is stored under it.
  const liveId = randomUUID();
  let live: LivePublisher | null = null;
  if (wantsLive && relay) {
    try {
      live = new LivePublisher(relay, liveId, key);
      process.stdout.write(`streaming live to ${relay} as ${liveId}\n`);
    } catch (err) {
      process.stderr.write(`could not open the live socket: ${(err as Error).message}\n`);
    }
  }

  const bots = {
    A: { name: String(args.flags['a-name'] ?? nameOf(commandA)), command: commandA },
    B: { name: String(args.flags['b-name'] ?? nameOf(commandB)), command: commandB },
  };

  // The live header is a replay with no turns in it yet. The browser builds the
  // same engine from it and simulates each packet as it lands, which is why the
  // locked spellbooks have to be in there.
  let header: ReplayFile | null = null;
  const outcome = await runMatch({
    seed,
    bots,
    onEvent: quiet ? undefined : (line) => process.stdout.write(line + '\n'),
    onStart: live
      ? (info: {
          rules: Rules;
          spellbooks: Readonly<Record<Side, readonly SpellTemplate[]>>;
          pagesUsed: Readonly<Record<Side, number>>;
        }) => {
          header = {
            version: REPLAY_VERSION,
            id: liveId,
            seed,
            rules: info.rules,
            bots: {
              A: { ...bots.A, pagesUsed: info.pagesUsed.A },
              B: { ...bots.B, pagesUsed: info.pagesUsed.B },
            },
            spellbooks: info.spellbooks,
            rounds: [],
            turns: [],
            keyframes: [],
            result: EMPTY_RESULT,
            finishedAt: new Date().toISOString(),
          };
          void live?.header(header);
        }
      : undefined,
    onTurn: live ? (turn) => live?.turn(turn) : undefined,
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
    writeFileSync(resolve(replayPath), JSON.stringify(outcome.replay));
    process.stdout.write(`replay written to ${replayPath}\n`);
  }

  if (live) {
    live.end({ ...outcome.replay, id: liveId });
    process.stdout.write(`live stream closed\n`);
  } else if (relay) {
    // Publishing is a side effect of a finished match, never a precondition.
    try {
      const id = await publishReplay(relay, outcome.replay, key);
      process.stdout.write(`published to ${relay} as ${id}\n`);
    } catch (err) {
      process.stderr.write(`could not publish: ${(err as Error).message}\n`);
    }
  }
  return 0;
}

/**
 * Determinism check (passport §13): re-run the recorded action packets through
 * a fresh engine and confirm every turn reproduces the hash the match recorded.
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
  const player = new ReplayPlayer(replay);

  let steps = 0;
  try {
    while (!player.finished) {
      if (!player.step(true)) break;
      steps++;
    }
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  process.stdout.write(`replayed ${steps} turns, every state hash matched\n`);

  // Seeking must land on the same state as playing straight through, or
  // backward scrubbing in the viewer would show a different match.
  const probes = [0, Math.floor(steps / 3), Math.floor(steps / 2), steps - 2, steps - 1].filter(
    (i) => i >= 0 && i < steps,
  );
  for (const probe of probes) {
    const straight = new ReplayPlayer(replay);
    straight.seek(probe);
    player.seek(probe);
    const a = straight.current?.hash;
    const b = player.current?.hash;
    if (a !== b) {
      process.stdout.write(`seek to turn ${probe} DIVERGED: ${a} vs ${b}\n`);
      return 1;
    }
  }
  process.stdout.write(`keyframe seeks to ${probes.length} positions all reproduce\n`);
  process.stdout.write('reproduces exactly\n');
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let code: number;
  switch (args.command) {
    case 'run':
      code = await cmdRun(args);
      break;
    case 'verify':
      code = await cmdVerify(args);
      break;
    default:
      process.stderr.write(
        'usage:\n' +
          '  spark run [--seed S] [--a "CMD"] [--b "CMD"] [--replay FILE] [--quiet]\n' +
          '             [--publish URL] [--live] [--key SECRET]\n' +
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
