#!/usr/bin/env node
/**
 * The determinism gate, as one command.
 *
 * Runs a real four-round match through the CLI, then proves three things about
 * the replay it produced:
 *
 *   1. Every recorded state hash reproduces when the action packets are re-run.
 *   2. Seeking through keyframes lands on exactly the state a straight
 *      playthrough reaches, so scrubbing backwards in the viewer shows the same
 *      match as watching it forwards.
 *   3. Two runs of the same seed and the same bots produce the same hashes.
 *
 * Passport §13 is the whole reason this exists: "same seed plus same bot
 * outputs equals the same match, bit for bit, on any machine". A change that
 * quietly breaks that will pass the unit tests, because the unit tests all
 * agree with each other.
 *
 * The browser half of the same claim lives in apps/web/test/browser-parity.mjs,
 * which runs a replay in Node and in headless Chromium and compares every turn.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplayPlayer } from '@spark/replay';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seed = process.argv[2] ?? 'verify';
const workDir = mkdtempSync(join(tmpdir(), 'spark-verify-'));

let failed = false;
const check = (label, ok, detail) => {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failed = true;
};

function runMatch(outPath) {
  return new Promise((resolveRun, rejectRun) => {
    const cli = spawn(
      'node',
      [
        join(REPO, 'apps/cli/dist/src/main.js'),
        'run',
        '--seed',
        seed,
        '--quiet',
        '--replay',
        outPath,
      ],
      { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    cli.stderr.on('data', (d) => (err += d));
    cli.on('exit', (code) =>
      code === 0 ? resolveRun(outPath) : rejectRun(new Error(`cli exited ${code}: ${err}`)),
    );
  });
}

const hashesOf = (replay, verify) => {
  const player = new ReplayPlayer(replay);
  const hashes = [];
  while (!player.finished) {
    const frame = player.step(verify);
    if (!frame) break;
    hashes.push(frame.hash);
  }
  return hashes;
};

const first = JSON.parse(readFileSync(await runMatch(join(workDir, 'a.json')), 'utf8'));
check('a four-round match completed', first.turns.length > 20, `${first.turns.length} turns`);
check('keyframes were written', first.keyframes.length > 0, `${first.keyframes.length} keyframes`);

let straight = [];
try {
  // step(true) throws the moment a reconstructed hash disagrees with the record.
  straight = hashesOf(first, true);
  check('every recorded state hash reproduces', straight.length === first.turns.length);
} catch (err) {
  check('every recorded state hash reproduces', false, err.message);
}

const seeker = new ReplayPlayer(first);
let seeksAgree = true;
let firstBadSeek = '';
for (const probe of [
  straight.length - 1,
  2,
  Math.floor(straight.length / 2),
  0,
  straight.length - 3,
]) {
  if (probe < 0 || probe >= straight.length) continue;
  seeker.seek(probe);
  if (seeker.current?.hash !== straight[probe]) {
    seeksAgree = false;
    firstBadSeek = `turn ${probe}: ${seeker.current?.hash} vs ${straight[probe]}`;
    break;
  }
}
check('keyframe seeks land where a straight playthrough does', seeksAgree, firstBadSeek);

const second = JSON.parse(readFileSync(await runMatch(join(workDir, 'b.json')), 'utf8'));
const rerun = hashesOf(second, false);
const identical = rerun.length === straight.length && rerun.every((h, i) => h === straight[i]);
check('the same seed and the same bots produce the same match', identical);
check(
  'the recorded results agree',
  JSON.stringify(first.result) === JSON.stringify(second.result),
  identical ? '' : 'hashes already diverged',
);

process.stdout.write(failed ? '\ndeterminism is broken\n' : '\ndeterminism holds\n');
process.exitCode = failed ? 1 : 0;
