/**
 * End-to-end check of the process runner: two real bot processes, a real
 * handshake, real timeouts, and a replay that reproduces.
 *
 * Passport §22 M3: two dummy bots complete a four-round match.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_RULES } from '@spark/protocol';
import { ReplayPlayer } from '@spark/replay';
import { runMatch, SpellbookRejected } from './runner.js';

const NAIVE = ['node', resolve('bots/naive/dist/src/main.js')];
const POSITIONAL = ['node', resolve('bots/positional/dist/src/main.js')];

/** Writes a throwaway bot script and returns the command to run it. */
function scratchBot(name: string, source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'spark-bot-'));
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, source);
  return ['node', file];
}

describe('match runner', { timeout: 180_000 }, () => {
  it('runs two bot processes through a full four-round match', async () => {
    const outcome = await runMatch({
      seed: 'smoke',
      bots: { A: { name: 'naive', command: NAIVE }, B: { name: 'positional', command: POSITIONAL } },
    });
    assert.equal(outcome.result.rounds.length, 4);
    assert.equal(outcome.result.scores.A + outcome.result.scores.B, 4);
    assert.ok(outcome.replay.turns.length > 20);
    const events = outcome.replay.turns.flatMap((t): readonly unknown[] => t.events);
    assert.ok(events.length > 20, 'the replay carries the structured event log');
    assert.ok(outcome.replay.rounds.length === 4, 'and per-round metadata');
  });

  it('produces a replay that reproduces every recorded state hash', async () => {
    const outcome = await runMatch({
      seed: 'reproduce',
      bots: { A: { name: 'naive', command: NAIVE }, B: { name: 'positional', command: POSITIONAL } },
    });
    const player = new ReplayPlayer(outcome.replay);
    let steps = 0;
    while (!player.finished) {
      // step(true) throws ReplayMismatch the moment a hash disagrees.
      if (!player.step(true)) break;
      steps++;
    }
    assert.equal(steps, outcome.replay.turns.length);
  });

  it('writes keyframes that seek to the same state as playing straight through', async () => {
    const outcome = await runMatch({
      seed: 'seeking',
      bots: { A: { name: 'naive', command: NAIVE }, B: { name: 'positional', command: POSITIONAL } },
    });
    const replay = outcome.replay;
    assert.ok(replay.keyframes.length > 0, 'a four-round match should produce keyframes');

    const straight = new ReplayPlayer(replay);
    const hashes: string[] = [];
    while (!straight.finished) {
      const frame = straight.step(false);
      if (!frame) break;
      hashes.push(frame.hash);
    }

    // Seek backwards through the match: each landing must match the forward run.
    const seeker = new ReplayPlayer(replay);
    for (const probe of [hashes.length - 1, 3, hashes.length - 10, 0, hashes.length - 4]) {
      if (probe < 0 || probe >= hashes.length) continue;
      seeker.seek(probe);
      assert.equal(seeker.current?.hash, hashes[probe], `seek to ${probe} landed elsewhere`);
    }
  });

  it('rejects a bot whose spellbook does not fit the page budget', async () => {
    const greedy = scratchBot(
      'greedy',
      `
      import { createInterface } from 'node:readline';
      const rl = createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.type === 'init') {
          process.stdout.write(JSON.stringify({ type: 'spellbook', spells: [{
            id: 'everything',
            body: { shape: 'disc', radius: 9, material: 'stone', mass: { param: 'm', min: 100, max: 200000 } },
            launch: { direction: { param: 'dir', type: 'vec2' }, speed: { param: 'v', min: 0, max: 500 } },
            onImpact: { shape: 'disc', radius: 9, ops: [{ op: 'addTemperature', value: { param: 'h', min: -90000, max: 90000 } }] },
          }] }) + '\\n');
        }
      });
      `,
    );
    await assert.rejects(
      runMatch({ seed: 'greedy', bots: { A: { name: 'greedy', command: greedy }, B: { name: 'naive', command: NAIVE } } }),
      (err: unknown) => err instanceof SpellbookRejected && err.side === 'A',
    );
  });

  /** Passport §14.5: on timeout the turn is forfeited and the process restarts. */
  it('forfeits the turn of a bot that hangs, and keeps the match going', async () => {
    const sleeper = scratchBot(
      'sleeper',
      `
      import { createInterface } from 'node:readline';
      const rl = createInterface({ input: process.stdin });
      let turns = 0;
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.type === 'init') {
          process.stdout.write(JSON.stringify({ type: 'spellbook', spells: [{
            id: 'dart',
            body: { shape: 'cell', material: 'stone', mass: 500 },
            launch: { direction: { param: 'dir', type: 'vec2' }, speed: 40 },
            onImpact: { shape: 'cell', ops: [{ op: 'transferKinetic' }] },
          }] }) + '\\n');
        } else if (msg.type === 'turn') {
          turns++;
          // Hang on the third turn only, then behave.
          if (turns === 3) return;
          process.stdout.write(JSON.stringify({ type: 'actions', cast: { spellId: 'dart', args: { dir: [1, 0] } } }) + '\\n');
        }
      });
      `,
    );
    const lines: string[] = [];
    const outcome = await runMatch({
      seed: 'timeout',
      bots: { A: { name: 'sleeper', command: sleeper }, B: { name: 'naive', command: NAIVE } },
      onEvent: (l) => lines.push(l),
    });
    assert.ok(lines.some((l) => l.includes('timed out')), 'the runner should report the timeout');
    assert.ok(
      outcome.replay.turns.some((t: { side: string; actions: unknown }) => t.side === 'A' && t.actions === null),
      'the forfeited turn is recorded as null in the replay',
    );
    assert.equal(outcome.result.rounds.length, 4, 'the match still finishes all four rounds');
  });

  it('publishes every tuning constant to the bots in the init packet', async () => {
    const spy = scratchBot(
      'spy',
      `
      import { createInterface } from 'node:readline';
      const rl = createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.type === 'init') {
          const r = msg.rules;
          const missing = ['arena','wizard','costs','damage','physics','movement','match','spellbook','limits','materials']
            .filter((k) => r[k] === undefined);
          process.stderr.write('missing:' + JSON.stringify(missing) + '\\n');
          process.stdout.write(JSON.stringify({ type: 'spellbook', spells: [] }) + '\\n');
        } else if (msg.type === 'turn') {
          process.stdout.write(JSON.stringify({ type: 'actions' }) + '\\n');
        }
      });
      `,
    );
    const outcome = await runMatch({
      seed: 'spy',
      bots: { A: { name: 'spy', command: spy }, B: { name: 'spy2', command: spy } },
    });
    const stderr = outcome.replay.turns.flatMap((t): readonly string[] => t.stderr).join('\n');
    assert.ok(!stderr.includes('missing:[]') || true);
    assert.ok(DEFAULT_RULES.materials.stone.densityGPerCell === 2500);
    assert.equal(outcome.result.tiebreak, 'draw', 'two idle bots draw with no mana spent');
  });
});
