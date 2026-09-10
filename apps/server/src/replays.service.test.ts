/**
 * Storage lookup tests.
 *
 * The index is built from whatever JSON sits in the replay directory, but the
 * CLI names those files itself (`spark run --replay replays/demo.json`), so a
 * file name is not an id. Anything the list advertises has to be fetchable.
 */
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReplayFile } from '@spark/replay';
import { ReplaysService } from './replays.service.js';

/** The smallest thing `isReplayFile` and `summarise` both accept. */
function fixture(id: string): ReplayFile {
  return {
    version: '0.2.0',
    id,
    seed: '7',
    rules: {},
    bots: { A: { name: 'naive' }, B: { name: 'positional' } },
    spellbooks: { A: [], B: [] },
    rounds: [],
    turns: [],
    keyframes: [],
    result: { winner: 'B', scores: { A: 0, B: 4 } },
    finishedAt: '2026-09-10T09:40:40.000Z',
  } as unknown as ReplayFile;
}

/** A service rooted at a fresh directory, seeded with the given files. */
function serviceWith(files: Record<string, ReplayFile>): ReplaysService {
  const dir = mkdtempSync(join(tmpdir(), 'spark-replays-'));
  for (const [name, replay] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(replay));
  }
  process.env['SPARK_REPLAY_DIR'] = dir;
  return new ReplaysService();
}

describe('replay storage', () => {
  it('fetches a replay whose file name differs from its id', () => {
    const replay = fixture('b94e0cbf-6002-4257-b9cf-73dc55d67fd6');
    const service = serviceWith({ 'demo.json': replay });

    const listed = service.list();
    assert.equal(listed.length, 1, 'the demo replay is indexed');
    assert.equal(listed[0]?.id, replay.id);

    // Every id the list hands out must resolve — the web app links straight to it.
    const fetched = service.get(replay.id);
    assert.equal(fetched.id, replay.id);
  });

  it('still fetches replays saved through the API', () => {
    const service = serviceWith({});
    const replay = fixture('published-1');
    service.save(replay);
    assert.equal(service.get('published-1').id, 'published-1');
    assert.equal(service.list().length, 1);
  });

  it('404s on an unknown id and on an id that could escape the directory', () => {
    const service = serviceWith({ 'demo.json': fixture('known') });
    assert.throws(() => service.get('nope'), /no replay nope/);
    assert.throws(() => service.get('../../etc/passwd'), /bad replay id/);
  });
});
