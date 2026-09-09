import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_RULES } from '@spark/protocol';
import {
  burnDamageMilliHp,
  concentrationUpkeepMilliMana,
  costOfCast,
  impactDamageMilliHp,
  keMilliJ,
  shapeCellCount,
} from '../src/index.js';

const R = DEFAULT_RULES;
const mana = (milli: number): number => milli / 1000;

/**
 * Passport §9 publishes four worked examples. They are the acceptance test for
 * the mana model: M2's gate is "ice knife and fireball both work and cost
 * within 10% of §9".
 */
describe('mana model — passport §9 worked examples', () => {
  it('ice knife: line 8 ice, 7.2 kg, v40 costs about 26 mana', () => {
    const cost = costOfCast(
      {
        bodyMassG: 7200,
        bodyMaterial: 'ice',
        bodyCells: 8,
        speedMilliCellsPerTurn: 40_000,
        impactCells: shapeCellCount({ shape: 'disc', radius: 2 }),
        impactOps: [
          { op: 'transferKinetic', value: 0 },
          { op: 'addTemperature', value: -200 },
        ],
      },
      R,
    );
    assert.equal(mana(cost.manifest), 14.4, 'manifest = 7.2 kg x 2 mana/kg');
    assert.equal(mana(cost.impulse), 11.52, 'impulse = 0.2 x 57.6 J');
    assert.ok(Math.abs(mana(cost.total) - 26) <= 2.6, `total ${mana(cost.total)} within 10% of 26`);
  });

  it('fireball: disc r6 plasma, 5.6 kg, +1500 C over disc r6, v30 costs about 61 mana', () => {
    const impactCells = shapeCellCount({ shape: 'disc', radius: 6 });
    const cost = costOfCast(
      {
        bodyMassG: 5600,
        bodyMaterial: 'plasma',
        bodyCells: impactCells,
        speedMilliCellsPerTurn: 30_000,
        impactCells,
        impactOps: [
          { op: 'transferKinetic', value: 0 },
          { op: 'addTemperature', value: 1500 },
        ],
      },
      R,
    );
    assert.equal(mana(cost.manifest), 22.4, 'manifest = 5.6 kg x 4 mana/kg');
    assert.equal(mana(cost.impulse), 5.04, 'impulse = 0.2 x 25.2 J');
    assert.ok(Math.abs(mana(cost.total) - 61) <= 6.1, `total ${mana(cost.total)} within 10% of 61`);
  });

  it('stone wall: rect 10x2 stone, 50 kg, v0 costs about 300 mana', () => {
    const cost = costOfCast(
      {
        bodyMassG: 50_000,
        bodyMaterial: 'stone',
        bodyCells: 20,
        speedMilliCellsPerTurn: 0,
        impactCells: 1,
        impactOps: [],
      },
      R,
    );
    assert.equal(mana(cost.total), 300);
    assert.equal(cost.impulse, 0, 'a wall dropped at the wand pays no impulse');
  });

  it('a wide impact disc costs more than a narrow one for the same heat', () => {
    const make = (radius: number): number =>
      costOfCast(
        {
          bodyMassG: 300,
          bodyMaterial: 'plasma',
          bodyCells: 1,
          speedMilliCellsPerTurn: 50_000,
          impactCells: shapeCellCount({ shape: 'disc', radius }),
          impactOps: [{ op: 'addTemperature', value: 2000 }],
        },
        R,
      ).total;
    assert.ok(make(6) > make(2), 'passport §7.4: a large impact disc heats more cells, so it costs more');
  });
});

describe('range is paid as velocity — passport §9', () => {
  it('doubling speed roughly quadruples the impulse term', () => {
    const at = (speed: number): number =>
      costOfCast(
        {
          bodyMassG: 2000,
          bodyMaterial: 'ice',
          bodyCells: 1,
          speedMilliCellsPerTurn: speed * 1000,
          impactCells: 1,
          impactOps: [],
        },
        R,
      ).impulse;
    assert.equal(at(40), at(20) * 4);
  });
});

describe('damage model — passport §8', () => {
  it('ice knife at v40 does about 20 HP on a centre hit', () => {
    const ke = keMilliJ(7200, 40_000);
    assert.equal(ke, 57_600, 'KE = 1/2 * 7.2 kg * (4 m/s)^2 = 57.6 J');
    const damage = impactDamageMilliHp(ke, 13, 13, R);
    assert.ok(Math.abs(damage / 1000 - 20.16) < 0.01, `${damage / 1000} HP`);
  });

  it('coverage scaling makes a clipping hit a fraction of a centre hit', () => {
    const ke = keMilliJ(7200, 40_000);
    const centre = impactDamageMilliHp(ke, 25, 25, R);
    const clip = impactDamageMilliHp(ke, 3, 25, R);
    assert.equal(clip, Math.floor((centre * 3) / 25));
  });

  it('burn is (T - 60) / 20 HP per turn', () => {
    assert.equal(burnDamageMilliHp(60_000, R), 0);
    assert.equal(burnDamageMilliHp(100_000, R) / 1000, 2);
    assert.equal(burnDamageMilliHp(260_000, R) / 1000, 10);
  });
});

describe('concentration upkeep — passport §10', () => {
  it('an ice knife held at -200 C costs about 7 mana a turn', () => {
    const upkeep = concentrationUpkeepMilliMana(7200, 'ice', -200_000, R);
    assert.ok(Math.abs(upkeep / 1000 - 7) < 0.5, `${upkeep / 1000} mana/turn`);
  });

  it('holding is cheaper than recasting', () => {
    const upkeep = concentrationUpkeepMilliMana(7200, 'ice', -200_000, R);
    const recast = costOfCast(
      {
        bodyMassG: 7200,
        bodyMaterial: 'ice',
        bodyCells: 8,
        speedMilliCellsPerTurn: 40_000,
        impactCells: 13,
        impactOps: [{ op: 'addTemperature', value: -200 }],
      },
      R,
    ).total;
    assert.ok(upkeep < recast, `${upkeep} upkeep vs ${recast} recast`);
  });
});
