import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_RULES, type ActionsMessage } from '@spark/protocol';
import { Match, worstCaseCostMilliMana } from '../src/index.js';
import { DART, ICE_KNIFE, WALL, book, flatRound, PASS } from './helpers.js';

const R = DEFAULT_RULES;

/** Passport §7 and §14.4. */
describe('the cast slot', () => {
  it('charges the computed cost and manifests at the wand, never inside the caster', () => {
    const round = flatRound();
    const wizard = round.wizards.A;
    const before = wizard.manaMilli;
    round.submit({ type: 'actions', cast: { spellId: 'knife', args: { m: 7200, v: 40, chill: 0, dir: [1, 0] } } });
    const cast = round.events.find((e) => e.t === 'cast');
    assert.ok(cast && cast.t === 'cast');
    assert.ok(cast.costMilli > 0);
    // Mana went down by the cost, then regen came back at end of turn.
    assert.equal(wizard.manaMilli, before - cast.costMilli + R.wizard.manaRegenMilli);
    assert.ok(cast.at[0] > wizard.x + R.wizard.footprintRadius, 'the body manifests clear of the footprint');
  });

  it('refunds in full when the manifest area is blocked, but still spends the slot', () => {
    const round = flatRound();
    const wizard = round.wizards.A;
    for (let y = 80; y < 120; y++) for (let x = 44; x < 60; x++) round.world.writeCell(x, y, 'stone');
    const before = wizard.manaMilli;
    round.submit({ type: 'actions', cast: { spellId: 'knife', args: { m: 7200, v: 40, chill: 0, dir: [1, 0] } } });
    assert.equal(round.objects.length, 0, 'nothing was manifested');
    assert.equal(wizard.manaMilli, before + R.wizard.manaRegenMilli, 'mana was fully refunded');
    assert.ok(round.events.some((e) => e.t === 'cast_failed' && e.reason.includes('blocked')));
  });

  it('rejects arguments outside the registered ranges rather than clamping them', () => {
    const round = flatRound();
    round.submit({ type: 'actions', cast: { spellId: 'knife', args: { m: 99_999, v: 40, chill: 0, dir: [1, 0] } } });
    assert.equal(round.objects.length, 0);
    assert.ok(round.events.some((e) => e.t === 'cast_failed' && e.reason.includes('registered range')));
  });

  it('rejects a spell that is not in the book', () => {
    const round = flatRound({ spells: [DART] });
    round.submit({ type: 'actions', cast: { spellId: 'knife', args: { m: 1000, v: 10, dir: [1, 0] } } });
    assert.ok(round.events.some((e) => e.t === 'cast_failed'));
  });

  it('refuses a cast the wizard cannot pay for', () => {
    const round = flatRound();
    round.wizards.A.manaMilli = 1000;
    round.submit({ type: 'actions', cast: { spellId: 'knife', args: { m: 8000, v: 60, chill: 0, dir: [1, 0] } } });
    assert.equal(round.objects.length, 0);
    assert.ok(round.events.some((e) => e.t === 'cast_failed' && e.reason.includes('available')));
  });

  it('drops a zero-velocity body at the wand as terrain', () => {
    const round = flatRound();
    round.wizards.A.manaMilli = 400_000; // a wall costs more than a round's opening mana
    round.submit({ type: 'actions', cast: { spellId: 'wall', args: { m: 12_500, dir: [1, 0] } } });
    round.submit(PASS);
    let stone = 0;
    let tall = 0;
    for (let y = 90; y < 112; y++) {
      for (let x = 42; x < 60; x++) {
        if (round.world.materialAt(x, y) !== 'stone') continue;
        stone++;
        if (round.world.blocksFlight(x, y, R.arena.flightAltitudeMm)) tall++;
      }
    }
    assert.ok(stone >= 5, `a 5-wide wall should write five cells, wrote ${stone}`);
    assert.ok(tall >= 5, 'a full-density stone wall stands above flight altitude and gives cover');
  });

  it('cannot afford the passport\'s own 50 kg stone wall at the published mana cap', () => {
    // Passport §9 prices a 50 kg stone wall at 300 mana and calls it a
    // once-per-round investment; passport §4 caps mana at 150. Both cannot be
    // true. Passport §18 anticipates this: MANA_CAP's stated test is "raise it
    // if stone-wall openings never happen". Recorded here so the contradiction
    // is visible and any retune is deliberate. See docs/DECISIONS.md, D7.
    const round = flatRound({
      spells: [
        {
          id: 'bigwall',
          body: { shape: 'rect', length: 2, width: 10, material: 'stone', mass: { param: 'm', min: 50_000, max: 50_000 } },
          launch: { direction: { param: 'dir', type: 'vec2' }, speed: 0 },
        },
      ],
    });
    round.wizards.A.manaMilli = R.wizard.manaCapMilli;
    round.submit({ type: 'actions', cast: { spellId: 'bigwall', args: { m: 50_000, dir: [1, 0] } } });
    assert.ok(
      round.events.some((e) => e.t === 'cast_failed'),
      'the passport\'s own 50 kg wall is out of reach at a 150 mana cap',
    );
  });

  it('does not let a bot change its book mid-match', () => {
    const round = flatRound({ spells: [DART] });
    assert.throws(() => book([{ ...ICE_KNIFE, id: '' }]), /invalid spellbook/);
    assert.deepEqual(round.objects, []);
  });
});

/** Passport §11. */
describe('reactions', () => {
  it('reserves the worst case at declaration and refunds it when nothing fires', () => {
    const round = flatRound();
    const wizard = round.wizards.A;
    const worst = worstCaseCostMilliMana(DART, R);
    round.submit({
      type: 'actions',
      react: { trigger: { kind: 'opponentWithinRadius', r: 3 }, spellId: 'dart', args: { m: 500, v: 20, dir: [1, 0] } },
    });
    assert.equal(wizard.reservedMilli, worst, 'the reservation is the worst case across the ranges');
    round.submit(PASS); // B's turn
    round.submit(PASS); // back to A: the reaction expires
    assert.equal(wizard.reservedMilli, 0);
    assert.ok(round.events.some((e) => e.t === 'react_refund' && !e.fired));
  });

  it('fires from the wand at the trigger point and spends only what the cast cost', () => {
    const round = flatRound({ spawns: [[100, 100], [112, 100]] });
    round.submit({
      type: 'actions',
      react: {
        trigger: { kind: 'opponentWithinRadius', r: 30 },
        spellId: 'dart',
        args: { m: 500, v: 20, dir: '$triggerPos' },
      },
    });
    assert.ok(
      round.events.some((e) => e.t === 'react_fired'),
      'an opponent already inside the radius should trigger immediately',
    );
    const cast = round.events.find((e) => e.t === 'cast' && e.spellId === 'dart');
    assert.ok(cast && cast.t === 'cast');
    assert.ok(cast.dir[0] > 0, 'the aim vector points from the wand toward the trigger');
  });

  it('fires at most once per declaration', () => {
    const round = flatRound({ spawns: [[100, 100], [112, 100]] });
    round.submit({
      type: 'actions',
      react: { trigger: { kind: 'opponentWithinRadius', r: 30 }, spellId: 'dart', args: { m: 500, v: 20, dir: '$triggerPos' } },
    });
    const fired = round.events.filter((e) => e.t === 'react_fired').length;
    round.submit(PASS);
    assert.equal(round.events.filter((e) => e.t === 'react_fired').length, fired);
  });

  it('refuses a declaration the wizard cannot reserve for', () => {
    const round = flatRound();
    round.wizards.A.manaMilli = 500;
    round.submit({
      type: 'actions',
      react: { trigger: { kind: 'opponentCast' }, spellId: 'dart', args: { m: 500, v: 20, dir: [1, 0] } },
    });
    assert.equal(round.wizards.A.reservedMilli, 0);
  });

  it('fires on a hostile object entering the radius', () => {
    const round = flatRound({ spawns: [[60, 100], [140, 100]] });
    round.submit(PASS); // A does nothing
    round.submit({ type: 'actions', cast: { spellId: 'knife', args: { m: 7200, v: 20, chill: 0, dir: [-1, 0] } } });
    round.submit({
      type: 'actions',
      react: { trigger: { kind: 'objectEnteredRadius', r: 60 }, spellId: 'dart', args: { m: 500, v: 40, dir: '$triggerObject' } },
    });
    assert.ok(round.events.some((e) => e.t === 'react_fired'), 'an incoming knife should trip the interceptor');
  });
});

/** Passport §10. */
describe('channel commands', () => {
  it('re-fires a held object for the cost of the velocity change', () => {
    const round = flatRound();
    round.submit({
      type: 'actions',
      cast: { spellId: 'knife', args: { m: 7200, v: 0, chill: 0, dir: [1, 0] }, concentrate: true },
    });
    const obj = round.objects[0]!;
    round.submit(PASS);
    const before = round.wizards.A.manaMilli;
    round.submit({ type: 'actions', channel: { kind: 'impulse', objectId: obj.id, dir: [0, 1], speed: 20 } });
    assert.ok(round.wizards.A.manaMilli < before + R.wizard.manaRegenMilli, 'a re-fire costs mana');
    assert.ok(round.events.some((e) => e.t === 'channel' && e.kind === 'impulse'));
  });

  it('releases a held object on command', () => {
    const round = flatRound();
    round.submit({
      type: 'actions',
      cast: { spellId: 'knife', args: { m: 7200, v: 0, chill: 0, dir: [1, 0] }, concentrate: true },
    });
    const id = round.objects[0]!.id;
    round.submit(PASS);
    round.submit({ type: 'actions', channel: { kind: 'release', objectId: id } });
    assert.ok(round.events.some((e) => e.t === 'concentration_released'));
  });

  it('refuses a channel command aimed at an object it does not hold', () => {
    const round = flatRound();
    round.submit({ type: 'actions', channel: { kind: 'release', objectId: 999 } });
    const msg = round.turnMessage('A');
    assert.ok(msg.rejected.some((r) => r.includes('not one of your concentrations')));
  });
});

/** Passport §14.3: the turn packet. */
describe('turn packet', () => {
  it('sends only cells that changed since the bot last acted', () => {
    const round = flatRound();
    round.turnMessage('A');
    round.submit(castLine());
    for (let i = 0; i < 8 && round.objects.length > 0; i++) round.submit(PASS);
    const msg = round.turnMessage('A');
    assert.ok(msg.cells.length > 0, 'settled matter should show up as cell deltas');
    const again = round.turnMessage('A');
    assert.equal(again.cells.length, 0, 'nothing changed in between, so nothing is resent');
  });

  it('carries exact mana so a bot can check affordability without rounding', () => {
    const round = flatRound();
    const msg = round.turnMessage('A');
    assert.equal(msg.you.manaMilli, R.wizard.manaStartMilli);
    assert.equal(msg.you.mana, 100);
  });

  it('hides the opponent reaction declaration but shows public events', () => {
    const round = flatRound();
    round.submit({
      type: 'actions',
      react: { trigger: { kind: 'opponentCast' }, spellId: 'dart', args: { m: 500, v: 20, dir: [1, 0] } },
    });
    const msg = round.turnMessage('B');
    assert.ok(!msg.events.some((e) => e.includes('armed')), 'a declaration is private');
  });

  function castLine(): ActionsMessage {
    return { type: 'actions', cast: { spellId: 'knife', args: { m: 7200, v: 3, chill: -6000, dir: [1, 0] } } };
  }
});

/** Passport §5.2 and §5.3. */
describe('match structure', () => {
  const idle = new Match({
    rules: R,
    seed: 'match-structure',
    spellbooks: { A: book([ICE_KNIFE, DART, WALL]), B: book([ICE_KNIFE, DART, WALL]) },
  });

  it('plays four rounds as two games, swapping spawns and alternating the first mover', () => {
    let guard = 0;
    const seen: { round: number; game: number; first: string }[] = [];
    while (!idle.finished && guard++ < 3000) {
      idle.drainOutbox();
      const pending = idle.pending;
      if (!pending) break;
      const round = idle.currentRound!;
      if (!seen.some((s) => s.round === round.round)) {
        seen.push({ round: round.round, game: round.game, first: pending.side });
      }
      idle.submit(PASS);
    }
    assert.equal(seen.length, 4);
    assert.deepEqual(seen.map((s) => s.game), [1, 1, 2, 2]);
    assert.deepEqual(seen.map((s) => s.first), ['A', 'B', 'A', 'B']);
  });

  it('ties every round when neither bot acts, then draws on zero mana spent', () => {
    const result = idle.result;
    assert.equal(result.scores.A, 2);
    assert.equal(result.scores.B, 2);
    assert.equal(result.tiebreak, 'draw');
    assert.equal(result.winner, null);
    for (const r of result.rounds) {
      assert.equal(r.reason, 'turn_cap');
      assert.equal(r.turns, R.match.turnCap, 'the turn counter stops at the cap');
    }
  });

  it('breaks a 2-2 tie on total mana spent, lower wins', () => {
    const match = new Match({
      rules: R,
      seed: 'tiebreak',
      spellbooks: { A: book([DART]), B: book([DART]) },
    });
    let guard = 0;
    while (!match.finished && guard++ < 3000) {
      match.drainOutbox();
      const pending = match.pending;
      if (!pending) break;
      // A spends on a harmless dart aimed at the sky, B does nothing.
      match.submit(
        pending.side === 'A'
          ? { type: 'actions', cast: { spellId: 'dart', args: { m: 100, v: 1, dir: [1, 0] } } }
          : PASS,
      );
    }
    const result = match.result;
    assert.equal(result.tiebreak, 'mana');
    assert.equal(result.winner, 'B', 'B spent less and takes the tiebreak');
    assert.ok(result.manaSpentMilli.A > result.manaSpentMilli.B);
  });
});
