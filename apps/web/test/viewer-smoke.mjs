/**
 * The W2/W3 gate: a replay is watchable end to end, and the panels that make it
 * legible are actually populated.
 *
 * Renders all four routes against a real relay and fails on any page error.
 * Screenshots land in a scratch directory for eyeballing.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE, launchBrowser, publishMatch, startServer } from './harness.mjs';

const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'spark-shots-'));
const server = await startServer();
let failed = false;

try {
  const id = await publishMatch('viewer-smoke');
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  const check = (label, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failed = true;
  };

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: join(shots, 'matches.png') });
  check('match list shows the published replay', (await page.locator('td a').count()) > 0);

  await page.goto(`${BASE}/match/${id}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.stage canvas', { timeout: 25000 });
  await page.getByRole('button', { name: 'play' }).click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(shots, 'viewer.png') });

  const hud = await page.textContent('.hud');
  check('arena renders with a state hash', /hash [0-9a-f]{8}/.test(hud ?? ''), hud ?? '');
  check('mana ledger is populated', (await page.locator('.ledger table tr').count()) > 8);
  check('event log has lines', (await page.locator('.eventlog div').count()) > 20);
  check('scrubber has sparklines', (await page.locator('.spark').count()) === 2);

  // Every overlay must survive being switched on.
  for (const label of ['Height', 'Mana field', 'Grid']) {
    await page.getByLabel(label).check();
  }
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(shots, 'overlays.png') });
  check('all overlays render', errors.length === 0, errors.join('; '));

  // Backward seeking must land somewhere real rather than an empty arena.
  await page.getByRole('button', { name: 'pause' }).click();
  await page.locator('input[type=range]').fill('4');
  await page.waitForTimeout(800);
  const seeked = await page.textContent('.hud');
  check('backward seek reconstructs a turn', /turn \d+/.test(seeked ?? ''), seeked ?? '');
  await page.screenshot({ path: join(shots, 'seek.png') });

  await page.goto(BASE + '/workbench', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(shots, 'workbench.png') });
  const workbench = (await page.textContent('.card table')) ?? '';
  check('workbench prices a cast', /total/.test(workbench), workbench.slice(0, 80).replace(/\s+/g, ' '));
  check('workbench runs the sandbox', (await page.locator('.eventlog div').count()) > 3);

  await page.goto(BASE + '/rules', { waitUntil: 'networkidle' });
  await page.screenshot({ path: join(shots, 'rules.png') });
  check('rules page lists the tuning table', (await page.locator('table tr').count()) > 20);

  check('no page errors anywhere', errors.length === 0, errors.join('; '));
  await browser.close();
  console.log(`screenshots in ${shots}`);
} finally {
  server.proc.kill();
}

process.exit(failed ? 1 : 0);
