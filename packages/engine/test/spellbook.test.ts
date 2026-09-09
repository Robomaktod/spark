import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_RULES, type SpellTemplate } from '@spark/protocol';
import { checkSpellbook, pagesForSpell } from '../src/index.js';
import { DART, ICE_KNIFE, WALL } from './helpers.js';

const R = DEFAULT_RULES;

/** Passport §7.6: a range costs book space, so flexibility is paid for. */
describe('spellbook paging', () => {
  it('charges more for a wide parameter range than a fixed value', () => {
    const flexible = pagesForSpell(ICE_KNIFE, R).pages;
    const rigid: SpellTemplate = {
      ...ICE_KNIFE,
      id: 'rigid',
      body: { ...ICE_KNIFE.body, mass: 7200 },
      launch: { direction: [1, 0], speed: 40 },
      onImpact: {
        shape: 'disc',
        radius: 2,
        ops: [{ op: 'transferKinetic' }, { op: 'addTemperature', value: -200 }],
      },
    };
    assert.ok(pagesForSpell(rigid, R).pages < flexible, 'a rigid spell must be cheaper');
  });

  it('fits roughly three flexible spells or a handful of rigid ones', () => {
    const flexible = checkSpellbook([ICE_KNIFE, DART, WALL], R);
    assert.ok(flexible.ok, flexible.errors.join('; '));
    assert.ok(
      flexible.pagesUsed > R.spellbook.maxPages / 2,
      `three flexible spells should fill much of the book, used ${flexible.pagesUsed}`,
    );

    const rigid = (i: number): SpellTemplate => ({
      id: `rigid${i}`,
      body: { shape: 'cell', material: 'ice', mass: 2000 },
      launch: { direction: [1, 0], speed: 30 + i },
      onImpact: { shape: 'disc', radius: 1, ops: [{ op: 'transferKinetic' }] },
    });
    const many = checkSpellbook([0, 1, 2, 3, 4, 5, 6].map(rigid), R);
    assert.ok(many.ok, `seven rigid spells should fit: ${many.errors.join('; ')}`);
  });

  it('rejects a book over the page budget', () => {
    const greedy: SpellTemplate = {
      id: 'greedy',
      body: { shape: 'disc', radius: 8, material: 'stone', mass: { param: 'm', min: 100, max: 100_000 } },
      launch: { direction: { param: 'dir', type: 'vec2' }, speed: { param: 'v', min: 0, max: 200 } },
      onImpact: {
        shape: 'disc',
        radius: 8,
        ops: [{ op: 'addTemperature', value: { param: 'h', min: -5000, max: 5000 } }],
      },
    };
    const check = checkSpellbook([greedy], R);
    assert.equal(check.ok, false);
    assert.ok(check.errors.some((e) => e.includes('page')), check.errors.join('; '));
  });
});

/** Passport §20: verify the mass floor closes the zero-mass exploit. */
describe('spellbook validation', () => {
  it('refuses a body lighter than the mass floor', () => {
    const feather: SpellTemplate = {
      id: 'feather',
      body: { shape: 'cell', material: 'stone', mass: { param: 'm', min: 1, max: 2000 } },
      launch: { direction: { param: 'dir', type: 'vec2' }, speed: { param: 'v', min: 0, max: 60 } },
    };
    const check = checkSpellbook([feather], R);
    assert.equal(check.ok, false);
    assert.ok(check.errors.some((e) => e.includes('mass floor') || e.includes('below')), check.errors.join('; '));
  });

  it('refuses duplicate ids and malformed templates', () => {
    assert.equal(checkSpellbook([ICE_KNIFE, ICE_KNIFE], R).ok, false);
    assert.equal(checkSpellbook([{ id: 'x' }], R).ok, false);
    assert.equal(checkSpellbook([{ ...ICE_KNIFE, body: { ...ICE_KNIFE.body, material: 'cheese' } }], R).ok, false);
  });

  it('reports per-spell page costs so a bot can see where the book went', () => {
    const check = checkSpellbook([ICE_KNIFE, DART], R);
    assert.equal(check.pages.length, 2);
    assert.equal(
      check.pagesUsed,
      check.pages.reduce((a, p) => a + p.pages, 0),
    );
  });
});
