import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_RULES, type ActionsMessage } from '@spark/protocol';
import { flatRound, PASS } from './helpers.js';

const R = DEFAULT_RULES;

const castKnife = (
  dir: [number, number],
  over: Partial<Record<string, number>> = {},
): ActionsMessage => ({
  type: 'actions',
  cast: { spellId: 'knife', args: { m: 7200, v: 40, chill: 0, dir, ...over } },
});

/** Passport §12. */
describe('physics step', () => {
  it('carries a projectile across the arena over several turns', () => {
    const round = flatRound();
    round.submit(castKnife([1, 0]));
    const first = round.objects[0]!;
    const startX = first.cellX;
    round.submit(PASS);
    assert.ok(
      first.cellX > startX + 30,
      `travelled only ${first.cellX - startX} cells in one turn`,
    );
    const afterOne = first.cellX;
    round.submit(PASS);
    assert.ok(first.cellX > afterOne, 'objects move on both players turns');
  });

  it('bleeds speed to drag and settles a slow object as terrain', () => {
    const round = flatRound();
    round.submit({
      type: 'actions',
      cast: { spellId: 'knife', args: { m: 7200, v: 3, chill: -6000, dir: [1, 0] } },
    });
    const obj = round.objects[0]!;
    const at = [obj.cellX, obj.cellY] as const;
    for (let i = 0; i < 6 && round.objects.length > 0; i++) round.submit(PASS);
    assert.equal(round.objects.length, 0, 'a slow object should have settled');
    assert.equal(
      round.world.materialAt(at[0], at[1]),
      'ice',
      'settled matter writes itself into cells',
    );
  });

  it('settled ice melts once it warms past zero, leaving water behind', () => {
    const round = flatRound();
    round.submit({
      type: 'actions',
      cast: { spellId: 'knife', args: { m: 7200, v: 3, chill: 0, dir: [1, 0] } },
    });
    const at = [round.objects[0]!.cellX, round.objects[0]!.cellY] as const;
    for (let i = 0; i < 6 && round.objects.length > 0; i++) round.submit(PASS);
    assert.equal(
      round.world.materialAt(at[0], at[1]),
      'water',
      'ice manifested at ambient is already above its melting point',
    );
  });

  it('stops an object at the arena boundary instead of letting it escape', () => {
    const round = flatRound({
      spawns: [
        [20, 100],
        [180, 100],
      ],
    });
    // Turn west first: the wand sits ahead along the facing, so firing west
    // while facing east would put the knife straight back through the caster.
    round.submit({
      type: 'actions',
      move1: { turnTo: 4 },
      cast: { spellId: 'knife', args: { m: 7200, v: 40, chill: -6000, dir: [-1, 0] } },
    });
    for (let i = 0; i < 12 && round.objects.length > 0; i++) round.submit(PASS);
    assert.equal(round.objects.length, 0);
    let found = false;
    for (let y = 90; y < 110; y++) {
      for (let x = 0; x < 4; x++) if (round.world.materialAt(x, y) !== 'air') found = true;
    }
    assert.ok(found, 'the object should have settled against the west wall');
  });

  it('smashes through weak terrain and is stopped by strong terrain', () => {
    const soft = flatRound();
    for (let y = 90; y < 110; y++) soft.world.writeCell(60, y, 'rubble', { heightMm: 1400 });
    soft.submit(castKnife([1, 0]));
    soft.submit(PASS);
    assert.equal(soft.world.materialAt(60, 100), 'rubble');
    assert.equal(soft.world.binding[soft.world.idx(60, 100)], 0, 'binding is broken by the hit');

    const hard = flatRound();
    for (let y = 90; y < 110; y++) hard.world.writeCell(60, y, 'stone', { heightMm: 1400 });
    hard.submit(castKnife([1, 0]));
    hard.submit(PASS);
    assert.ok(
      hard.events.some((e) => e.t === 'impact_cell' && !e.penetrated),
      'a stone wall should stop a 57 J knife',
    );
  });

  it('flies over terrain that is below flight altitude', () => {
    const round = flatRound();
    for (let y = 90; y < 110; y++) round.world.writeCell(60, y, 'rubble', { heightMm: 400 });
    round.submit(castKnife([1, 0]));
    round.submit(PASS);
    assert.ok(
      round.objects[0] && round.objects[0].cellX > 70,
      'rubble at 400 mm blocks nothing in flight',
    );
  });

  it('destroys both objects when two collide', () => {
    const round = flatRound({
      spawns: [
        [40, 100],
        [160, 100],
      ],
    });
    round.submit(castKnife([1, 0], { v: 15 }));
    round.submit(castKnife([-1, 0], { v: 15 }));
    for (let i = 0; i < 10 && round.objects.length > 1; i++) round.submit(PASS);
    assert.ok(
      round.events.some((e) => e.t === 'objects_collided'),
      'head-on projectiles should annihilate, which is what makes interception possible',
    );
  });

  it('lets a careless caster shoot itself, because self-damage is enabled', () => {
    // Passport §8: the wand-origin rule prevents the worst self-inflicted
    // cases, but not carelessness. Firing backwards is carelessness.
    const round = flatRound({
      spawns: [
        [100, 100],
        [180, 100],
      ],
    });
    const before = round.wizards.A.hpMilli;
    round.submit(castKnife([-1, 0]));
    assert.ok(
      round.wizards.A.hpMilli < before,
      'a knife thrown backwards passes through its caster',
    );
    assert.ok(round.events.some((e) => e.t === 'impact_wizard' && e.target === 'A'));
  });

  it('damages a wizard in proportion to coverage', () => {
    const round = flatRound({
      spawns: [
        [80, 100],
        [120, 100],
      ],
    });
    const before = round.wizards.B.hpMilli;
    round.submit(castKnife([1, 0]));
    for (let i = 0; i < 4 && round.wizards.B.hpMilli === before; i++) round.submit(PASS);
    assert.ok(round.wizards.B.hpMilli < before, 'a knife down the middle should connect');
    const hit = round.events.find((e) => e.t === 'impact_wizard');
    assert.ok(hit && hit.t === 'impact_wizard' && hit.overlap > 0);
  });
});

describe('heat, phase and burn', () => {
  it('decays a hot cell 30% toward ambient each turn', () => {
    const round = flatRound();
    round.world.setTemperature(70, 70, 120_000);
    round.world.markDirty(70, 70);
    round.submit(PASS);
    const t = round.world.temperature[round.world.idx(70, 70)]!;
    assert.equal(t, 120_000 - Math.round((120_000 - 20_000) * 0.3));
  });

  it('melts ice to water and freezes water to ice', () => {
    const round = flatRound();
    round.world.writeCell(70, 70, 'ice', { milliC: 5000 });
    // Cold enough to still be below zero after one turn of decay: heat decay
    // runs before the phase check, so a cell at -5 C is already above freezing
    // by the time the check looks at it.
    round.world.writeCell(72, 70, 'water', { milliC: -50_000 });
    round.submit(PASS);
    assert.equal(round.world.materialAt(70, 70), 'water');
    assert.equal(round.world.materialAt(72, 70), 'ice');
  });

  it('boils water away, removing the mass', () => {
    const round = flatRound();
    round.world.writeCell(70, 70, 'water', { milliC: 150_000 });
    round.submit(PASS);
    assert.equal(round.world.materialAt(70, 70), 'air');
  });

  it('turns stone to rubble once its binding is gone', () => {
    const round = flatRound();
    round.world.writeCell(70, 70, 'stone');
    round.world.setBinding(70, 70, 0);
    round.submit(PASS);
    assert.equal(round.world.materialAt(70, 70), 'rubble');
  });

  it('destroys cohesion at the melting point, which is what lets heat breach a wall', () => {
    const round = flatRound();
    // Above stone's 1200 C melting point even after a turn of heat decay.
    round.world.writeCell(70, 70, 'stone', { milliC: 2_000_000 });
    round.submit(PASS);
    assert.equal(
      round.world.materialAt(70, 70),
      'rubble',
      'molten stone loses its cohesion and crumbles',
    );
  });

  it('burns a wizard standing in a hot cell', () => {
    const round = flatRound();
    const w = round.wizards.A;
    round.world.setTemperature(w.x, w.y, 260_000);
    round.world.markDirty(w.x, w.y);
    const before = w.hpMilli;
    round.submit(PASS);
    assert.ok(w.hpMilli < before, 'standing in 260 C should hurt');
    assert.ok(round.events.some((e) => e.t === 'burn'));
  });
});

describe('mana upkeep and regen — passport §12 steps 7 and 8', () => {
  it('regenerates each turn, capped', () => {
    const round = flatRound();
    round.wizards.A.manaMilli = R.wizard.manaCapMilli - 5000;
    round.submit(PASS);
    assert.equal(round.wizards.A.manaMilli, R.wizard.manaCapMilli, 'regen is capped');
  });

  it('charges upkeep on a concentrated object and releases it on a shortfall', () => {
    const round = flatRound();
    round.submit({
      type: 'actions',
      cast: {
        spellId: 'knife',
        args: { m: 8000, v: 5, chill: -6000, dir: [1, 0] },
        concentrate: true,
      },
    });
    const obj = round.objects[0]!;
    assert.equal(obj.concentrated, true);
    assert.ok(
      round.events.some((e) => e.t === 'concentration_upkeep'),
      'a cold object costs upkeep every turn',
    );

    round.wizards.A.manaMilli = 0;
    round.submit(PASS);
    round.submit(PASS);
    assert.ok(
      round.events.some((e) => e.t === 'concentration_released' && e.reason === 'mana shortfall'),
      'an unfunded link is released',
    );
  });

  it('holds temperature against decay while concentrated', () => {
    const held = flatRound();
    held.submit({
      type: 'actions',
      cast: {
        spellId: 'knife',
        args: { m: 8000, v: 5, chill: -6000, dir: [1, 0] },
        concentrate: true,
      },
    });
    const heldTemp = held.objects[0]!.temperatureMilliC;
    held.submit(PASS);
    assert.equal(held.objects[0]!.temperatureMilliC, heldTemp, 'concentration holds the property');

    const loose = flatRound();
    loose.submit({
      type: 'actions',
      cast: { spellId: 'knife', args: { m: 8000, v: 5, chill: -6000, dir: [1, 0] } },
    });
    const looseTemp = loose.objects[0]!.temperatureMilliC;
    loose.submit(PASS);
    assert.ok(
      loose.objects[0]!.temperatureMilliC > looseTemp,
      'an unheld object decays toward ambient',
    );
  });
});
