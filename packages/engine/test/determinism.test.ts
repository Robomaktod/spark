import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ActionsMessage, Side } from '@spark/protocol';
import { DEFAULT_RULES, MATERIALS } from '@spark/protocol';
import { Hasher, Rng, generateMap, isqrt, ilen, mulDiv, mulDivRound, idiv } from '../src/index.js';
import { flatRound, playMatch } from './helpers.js';

/**
 * Passport §22, the M1 gate: same input produces an identical state hash across
 * 1000 turns. Passport §13: replay is seed plus the ordered action packets, and
 * a match reruns bit-exact on any machine.
 */
describe('determinism', () => {
  const script = (side: Side, turn: number): ActionsMessage => {
    const dir: [number, number] = side === 'A' ? [1, 0] : [-1, 0];
    return {
      type: 'actions',
      move1: { path: side === 'A' ? [[1, 0]] : [[-1, 0]], turnTo: side === 'A' ? 0 : 4 },
      cast:
        turn % 2 === 0
          ? { spellId: 'knife', args: { m: 3000 + turn * 10, v: 30, chill: -50, dir } }
          : { spellId: 'dart', args: { m: 500, v: 50, dir } },
      react: { trigger: { kind: 'objectEnteredRadius', r: 10 }, spellId: 'dart', args: { m: 200, v: 40, dir: '$triggerObject' } },
    };
  };

  it('two runs of the same seed and the same actions hash identically', () => {
    const first = playMatch('determinism-seed', script);
    const second = playMatch('determinism-seed', script);
    assert.ok(first.hashes.length > 100, `expected a long match, got ${first.hashes.length} turns`);
    assert.deepEqual(first.hashes, second.hashes);
    assert.deepEqual(first.match.result, second.match.result);
  });

  it('a different seed produces a different world', () => {
    const a = playMatch('seed-one', script);
    const b = playMatch('seed-two', script);
    assert.notDeepEqual(a.hashes, b.hashes);
  });

  it('state stays reproducible over 1000 stepped turns', () => {
    // A long round with wizards too tough to die, so the hash comparison
    // actually covers 1000 turns of physics rather than ending at a knockout.
    const rules = {
      ...DEFAULT_RULES,
      match: { ...DEFAULT_RULES.match, turnCap: 600 },
      wizard: { ...DEFAULT_RULES.wizard, hpMilli: 100_000_000, manaCapMilli: 10_000_000, manaRegenMilli: 500_000 },
    };
    const run = (): string[] => {
      const round = flatRound({ rules });
      const hashes: string[] = [];
      for (let i = 0; i < 1000 && !round.finished; i++) {
        const side = round.current;
        round.submit(script(side, round.turn));
        hashes.push(round.stateHash());
      }
      return hashes;
    };
    const a = run();
    const b = run();
    assert.equal(a.length, 1000);
    assert.deepEqual(a, b);
  });

  it('map generation is a pure function of the seed', () => {
    const a = generateMap('map-seed', DEFAULT_RULES);
    const b = generateMap('map-seed', DEFAULT_RULES);
    const hashOf = (w: typeof a.world): string => {
      const h = new Hasher();
      w.hashInto(h);
      return h.hex();
    };
    assert.equal(hashOf(a.world), hashOf(b.world));
    assert.deepEqual(a.spawns, b.spawns);
  });
});

describe('fixed point', () => {
  it('isqrt is exact at and around perfect squares', () => {
    for (const n of [0, 1, 2, 3, 4, 8, 9, 10, 99, 100, 101, 999_999, 1_000_000, 1_000_001]) {
      const r = isqrt(n);
      assert.ok(r * r <= n && (r + 1) * (r + 1) > n, `isqrt(${n}) = ${r}`);
    }
  });

  it('ilen survives vectors that would overflow a squared double', () => {
    assert.equal(ilen(3, 4), 5);
    assert.equal(ilen(-3, -4), 5);
    assert.equal(ilen(1_000_000_000, 0), 1_000_000_000);
  });

  it('idiv floors toward negative infinity for every sign', () => {
    assert.equal(idiv(7, 2), 3);
    assert.equal(idiv(-7, 2), -4);
    assert.equal(idiv(7, -2), -4);
    assert.equal(idiv(-7, -2), 3);
  });

  it('mulDiv is exact past the safe-integer range of a plain product', () => {
    assert.equal(mulDiv(9_007_199_254_740_991, 4, 8), 4_503_599_627_370_495);
    assert.equal(mulDivRound(1, 1, 2), 1);
    assert.equal(mulDivRound(-1, 1, 2), -1);
  });
});

describe('seeded prng', () => {
  it('is reproducible and unbiased over its range', () => {
    const a = new Rng('abc');
    const b = new Rng('abc');
    const counts = new Array(7).fill(0) as number[];
    for (let i = 0; i < 7000; i++) {
      const v = a.int(7);
      assert.equal(v, b.int(7));
      counts[v]!++;
    }
    for (const c of counts) assert.ok(c > 800 && c < 1200, `bucket count ${c} looks skewed`);
  });
});

describe('map generation — passport §15', () => {
  it('places two spawns at least 120 cells apart on open ground', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const map = generateMap(seed, DEFAULT_RULES);
      const [pa, pb] = map.spawns;
      assert.ok(ilen(pb[0] - pa[0], pb[1] - pa[1]) >= 120, `seed ${seed}: spawns too close`);
      for (const [cx, cy] of [pa, pb]) {
        for (let dy = -15; dy <= 15; dy++) {
          for (let dx = -15; dx <= 15; dx++) {
            if (ilen(dx, dy) > 15) continue;
            const x = cx + dx;
            const y = cy + dy;
            if (!map.world.inBounds(x, y)) continue;
            assert.equal(map.world.materialAt(x, y), 'air', `seed ${seed}: spawn radius not clear at ${x},${y}`);
          }
        }
      }
    }
  });

  it('produces terrain that actually blocks flight', () => {
    const map = generateMap('terrain', DEFAULT_RULES);
    let tall = 0;
    for (let y = 0; y < map.world.height; y++) {
      for (let x = 0; x < map.world.width; x++) {
        if (map.world.blocksFlight(x, y, DEFAULT_RULES.arena.flightAltitudeMm)) tall++;
      }
    }
    assert.ok(tall > 200, `only ${tall} cells break sightlines`);
  });

  it('uses every material band the generator promises', () => {
    const seen = new Set<string>();
    for (const seed of ['m1', 'm2', 'm3', 'm4']) {
      const map = generateMap(seed, DEFAULT_RULES);
      for (let i = 0; i < map.world.material.length; i++) seen.add(map.world.materialOfIndex(i));
    }
    for (const mat of ['stone', 'water', 'rubble']) {
      assert.ok(seen.has(mat), `generator never produced ${mat}`);
      assert.ok(MATERIALS[mat as 'stone'] !== undefined);
    }
  });
});
