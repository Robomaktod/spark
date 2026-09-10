/**
 * Shared setup for the web tests: a relay on a scratch port with one published
 * replay, and a browser pointed at the pre-installed Chromium.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * These tests drive the CLI and the relay, which live elsewhere in the repo, so
 * every path is resolved from here rather than from whatever directory the test
 * happened to be launched in.
 */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const fromRepo = (...parts) => join(REPO, ...parts);

export const PORT = Number(process.env.SPARK_TEST_PORT ?? 4179);
export const BASE = `http://localhost:${PORT}`;

/** Some environments ship a Chromium older than the installed Playwright expects. */
export function launchBrowser() {
  const executablePath = process.env.SPARK_CHROMIUM ?? '/opt/pw-browsers/chromium';
  return chromium.launch(existsSync(executablePath) ? { executablePath } : {});
}

export async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'spark-replays-'));
  const proc = spawn('node', [fromRepo('apps/server/dist/src/main.js')], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT),
      SPARK_REPLAY_DIR: dir,
      SPARK_WEB_DIR: fromRepo('apps/web/dist'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await fetch(BASE + '/api/replays');
      if (res.ok) return { proc, dir, log: () => log };
    } catch {
      // not up yet
    }
  }
  proc.kill();
  throw new Error('the relay never came up:\n' + log);
}

/** Runs a match on the CLI, writing the replay to a file. */
export function runMatchToFile(seed, outPath) {
  return new Promise((resolveRun, rejectRun) => {
    const cli = spawn(
      'node',
      [
        fromRepo('apps/cli/dist/src/main.js'),
        'run',
        '--seed',
        seed,
        '--quiet',
        '--replay',
        outPath,
      ],
      { cwd: REPO, stdio: 'ignore' },
    );
    cli.on('exit', (code) =>
      code === 0 ? resolveRun(outPath) : rejectRun(new Error(`cli exited ${code}`)),
    );
  });
}

/** Runs a match and publishes it, returning the stored replay id. */
export async function publishMatch(seed = 'webtest') {
  await new Promise((resolveRun, rejectRun) => {
    const cli = spawn(
      'node',
      [fromRepo('apps/cli/dist/src/main.js'), 'run', '--seed', seed, '--quiet', '--publish', BASE],
      { cwd: REPO, stdio: 'ignore' },
    );
    cli.on('exit', (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`cli exited ${code}`)),
    );
  });
  const list = await (await fetch(BASE + '/api/replays')).json();
  if (list.length === 0) throw new Error('nothing was published');
  return list[0].id;
}
