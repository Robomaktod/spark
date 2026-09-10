/**
 * The W1 gate, and the mitigation for the web plan's first risk: "browser engine
 * diverges from CLI engine".
 *
 * Runs a real replay through the engine in Node and again in headless Chromium,
 * and compares the state hash of every single turn. Same package, same
 * fixed-point code — but that is a claim, and this is the check.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ReplayPlayer } from '@spark/replay';
import { fromRepo, launchBrowser, runMatchToFile } from './harness.mjs';

const port = Number(process.env.PARITY_PORT ?? 4178);

// Run a match if one was not handed over, so the check stands alone.
const replayPath =
  process.argv[2] ??
  (await runMatchToFile('parity', join(mkdtempSync(join(tmpdir(), 'spark-parity-')), 'match.json')));
const replay = JSON.parse(readFileSync(resolve(replayPath), 'utf8'));

console.log(`comparing ${replay.turns.length} turns of ${replayPath}`);

/* ---- Node side ---- */
const nodeHashes = [];
{
  const player = new ReplayPlayer(replay);
  while (!player.finished) {
    const frame = player.step(false);
    if (!frame) break;
    nodeHashes.push(frame.hash);
  }
}
console.log(`node: ${nodeHashes.length} hashes`);

/* ---- Browser side ---- */
const { createServer } = await import('node:http');
const { readFile } = await import('node:fs/promises');
const webRoot = fromRepo('apps/web/dist');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/replay.json') {
    res.setHeader('content-type', 'application/json');
    res.end(readFileSync(resolve(replayPath)));
    return;
  }
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const body = await readFile(join(webRoot, file));
    const ext = file.split('.').pop();
    res.setHeader(
      'content-type',
      ext === 'js' ? 'text/javascript' : ext === 'css' ? 'text/css' : 'text/html',
    );
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((r) => server.listen(port, r));

const browser = await launchBrowser();
let failed = false;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });

  // The engine is bundled into the page; import it from the same bundle the
  // viewer uses so this tests exactly what ships.
  await page.addScriptTag({ url: '/assets/parity.js', type: 'module' });
  await page.waitForFunction(() => typeof window.__sparkParity?.hashAll === 'function');
  const { hashes: browserHashes, ms } = await page.evaluate(async () => {
    const res = await fetch('/replay.json');
    const replay = await res.json();
    const started = performance.now();
    const hashes = window.__sparkParity.hashAll(replay);
    return { hashes, ms: performance.now() - started };
  });
  // This is the number behind the web plan's catch-up claim: a viewer joining
  // at the last turn re-simulates the whole match before rendering.
  console.log(`chromium simulated the whole match in ${ms.toFixed(0)} ms`);

  if (errors.length > 0) {
    console.error('page errors:', errors.join('\n'));
    failed = true;
  }
  console.log(`chromium: ${browserHashes.length} hashes`);

  if (browserHashes.length !== nodeHashes.length) {
    console.error(`length mismatch: node ${nodeHashes.length}, chromium ${browserHashes.length}`);
    failed = true;
  }
  for (let i = 0; i < Math.min(browserHashes.length, nodeHashes.length); i++) {
    if (browserHashes[i] !== nodeHashes[i]) {
      console.error(`turn ${i}: node ${nodeHashes[i]} !== chromium ${browserHashes[i]}`);
      failed = true;
      break;
    }
  }
  if (!failed) console.log('every turn hashes identically in Node and in Chromium');
} finally {
  await browser.close();
  server.close();
}

process.exit(failed ? 1 : 0);
