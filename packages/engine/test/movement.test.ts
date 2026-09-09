import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_RULES } from '@spark/protocol';
import { World, Wizard, applyMove, footprintLegal, pushWizard } from '../src/index.js';

const R = DEFAULT_RULES;

function setup(): { world: World; wizard: Wizard } {
  const world = new World(R);
  const wizard = new Wizard('A', 50, 50, 0, R);
  return { world, wizard };
}

/** Passport §6. */
describe('movement', () => {
  it('spends 1 MP per cell in any of the eight directions', () => {
    const { world, wizard } = setup();
    const out = applyMove(world, wizard, { path: [[1, 0], [1, 1], [0, 1]] }, R);
    assert.equal(out.mpSpent, 3);
    assert.deepEqual([wizard.x, wizard.y], [52, 52]);
    assert.equal(wizard.mp, R.wizard.mpPerTurn - 3);
  });

  it('charges 1 MP per 45 degrees, so a reversal costs 4', () => {
    const { world, wizard } = setup();
    const out = applyMove(world, wizard, { turnTo: 4 }, R);
    assert.equal(out.mpSpent, 4);
    assert.equal(wizard.facing, 4);
  });

  it('stops at the last legal cell and keeps the unspent MP', () => {
    const { world, wizard } = setup();
    for (let dy = -3; dy <= 3; dy++) world.writeCell(55, 50 + dy, 'stone');
    const out = applyMove(world, wizard, { path: Array.from({ length: 8 }, () => [1, 0] as const) }, R);
    assert.ok(out.stoppedEarly, 'should have hit the wall');
    assert.ok(wizard.x < 53, `walked to ${wizard.x}, should have stopped short of the wall`);
    assert.ok(wizard.mp > 0, 'unspent MP is retained');
  });

  it('requires the whole 5x5 footprint to be legal, so a gap must be 5 wide', () => {
    const { world } = setup();
    for (let y = 0; y < 100; y++) {
      if (y >= 48 && y <= 51) continue; // a 4-cell gap
      world.writeCell(60, y, 'stone');
    }
    assert.equal(footprintLegal(world, R, 60, 50), false, 'a 4-cell gap must not admit a 5-cell wizard');
    world.clearToAir(60, 52);
    assert.equal(footprintLegal(world, R, 60, 50), true, 'a 5-cell gap must');
  });

  it('doubles the cost of entering water', () => {
    const { world, wizard } = setup();
    for (let y = 40; y < 60; y++) for (let x = 51; x < 60; x++) world.writeCell(x, y, 'water');
    const out = applyMove(world, wizard, { path: [[1, 0]] }, R);
    assert.equal(out.mpSpent, 2, 'water costs double');
  });

  it('slides one extra cell on ice, free', () => {
    const { world, wizard } = setup();
    for (let y = 40; y < 60; y++) for (let x = 51; x < 60; x++) world.writeCell(x, y, 'ice');
    const out = applyMove(world, wizard, { path: [[1, 0]] }, R);
    assert.equal(out.mpSpent, 1);
    assert.equal(wizard.x, 52, 'stepped one cell and slid one more');
    assert.ok(out.notes.some((n) => n.includes('slid')));
  });

  it('ignores a turn it cannot afford rather than going into MP debt', () => {
    const { world, wizard } = setup();
    wizard.mp = 2;
    const out = applyMove(world, wizard, { turnTo: 4 }, R);
    assert.equal(out.mpSpent, 0);
    assert.equal(wizard.facing, 0);
    assert.equal(wizard.mp, 2);
  });
});

/** Passport §6 and §8: pushes are capped, and a wall costs HP. */
describe('push', () => {
  it('displaces by impulse over wizard mass, capped at 20 cells', () => {
    const { world, wizard } = setup();
    const out = pushWizard(world, wizard, R.wizard.massG * 5, 0, R);
    assert.equal(out.cells, 5);
    assert.equal(wizard.x, 55);

    const far = pushWizard(world, wizard, R.wizard.massG * 500, 0, R);
    assert.equal(far.cells, R.physics.maxPushCells, 'displacement is capped');
  });

  it('damages a wizard driven into a wall', () => {
    const { world, wizard } = setup();
    for (let y = 40; y < 60; y++) world.writeCell(56, y, 'stone');
    const before = wizard.hpMilli;
    const out = pushWizard(world, wizard, R.wizard.massG * 8, 0, R);
    assert.ok(out.hitWall, 'should have hit the wall');
    assert.ok(out.damageMilliHp > 0, 'wall impact does damage');
    assert.equal(wizard.hpMilli, before - out.damageMilliHp);
  });

  it('ignores an impulse too small to move 70 kg', () => {
    const { world, wizard } = setup();
    const out = pushWizard(world, wizard, 100, 0, R);
    assert.equal(out.cells, 0);
    assert.equal(wizard.x, 50);
  });
});
