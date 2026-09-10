/**
 * The W5 gate: a match running on the CLI is watchable live.
 *
 * Two halves. First a raw socket, which proves the relay streams turn packets
 * as the match produces them. Then a browser joining partway, which proves the
 * catch-up path: take the burst, simulate forward, render.
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE, PORT, REPO, fromRepo, launchBrowser, startServer } from './harness.mjs';

const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'spark-shots-'));
const server = await startServer();
let failed = false;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
};

function runLiveMatch(seed) {
  return spawn(
    'node',
    [fromRepo('apps/cli/dist/src/main.js'), 'run', '--seed', seed, '--quiet', '--publish', BASE, '--live'],
    { cwd: REPO, stdio: 'ignore' },
  );
}

async function waitForLive() {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const live = await (await fetch(BASE + '/api/live')).json();
    if (live.length > 0) return live[0];
  }
  return null;
}

try {
  /* ---- raw socket: turns stream as the match produces them ---- */
  {
    const cli = runLiveMatch('live-raw');
    const match = await waitForLive();
    check('the relay lists the match in progress', match !== null);
    if (match) {
      const ws = new WebSocket(`ws://localhost:${PORT}/live?watch=${match.id}`);
      let header = null;
      let turns = 0;
      ws.on('message', (d) => {
        const msg = JSON.parse(String(d));
        if (msg.type === 'header') header = msg.replay;
        if (msg.type === 'turn') turns++;
      });
      await new Promise((r) => setTimeout(r, 7000));
      ws.close();
      check('the header carries the locked spellbooks', (header?.spellbooks?.A?.length ?? 0) > 0);
      check('turn packets stream', turns > 20, `${turns} turns`);
    }
    cli.kill();
  }

  /* ---- browser: join partway and catch up ---- */
  {
    // The browser is launched before the match starts, because a four-round
    // match takes about five seconds and a cold browser takes longer than that.
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    let frames = 0;
    page.on('websocket', (ws) => ws.on('framereceived', () => frames++));

    const cli = runLiveMatch('live-browser');
    const match = await waitForLive();
    if (!match) {
      check('a live match to watch', false);
    } else {
      const joined = Date.now();
      await page.goto(`${BASE}/match/${match.id}?live=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.stage canvas', { timeout: 25000 });
      const elapsed = Date.now() - joined;
      await page.waitForTimeout(2500);
      await page.screenshot({ path: join(shots, 'live.png') });

      const hud = await page.textContent('.hud');
      check('the viewer received the stream', frames > 5, `${frames} frames`);
      check('it caught up and rendered', /turn \d+/.test(hud ?? ''), `${elapsed} ms, ${hud}`);
      check('no page errors', errors.length === 0, errors.join('; '));
    }
    cli.kill();
    await browser.close();
  }

  /* ---- a link opened after the match ends falls back to the recording ---- */
  {
    const cli = runLiveMatch('live-late');
    const match = await waitForLive();
    await new Promise((r) => setTimeout(r, 9000));
    cli.kill();
    if (match) {
      const browser = await launchBrowser();
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${BASE}/match/${match.id}?live=1`, { waitUntil: 'networkidle' });
      const landed = await page
        .waitForSelector('.stage canvas', { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      check('a late live link falls back to the recording', landed);
      await browser.close();
    }
  }

  console.log(`screenshots in ${shots}`);
} finally {
  server.proc.kill();
}

process.exit(failed ? 1 : 0);
