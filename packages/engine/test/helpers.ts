import {
  DEFAULT_RULES,
  type ActionsMessage,
  type Rules,
  type Side,
  type SpellTemplate,
} from '@spark/protocol';
import { Match, Round, Spellbook, World, generateMap } from '../src/index.js';

export const RULES = DEFAULT_RULES;

/** A flexible ice knife: the passport's own example template. */
export const ICE_KNIFE: SpellTemplate = {
  id: 'knife',
  body: { shape: 'line', length: 8, material: 'ice', mass: { param: 'm', min: 500, max: 8000 } },
  launch: { direction: { param: 'dir', type: 'vec2' }, speed: { param: 'v', min: 0, max: 60 } },
  onImpact: {
    shape: 'disc',
    radius: 2,
    ops: [
      { op: 'transferKinetic' },
      { op: 'addTemperature', value: { param: 'chill', min: -8000, max: 0 } },
    ],
  },
};

export const DART: SpellTemplate = {
  id: 'dart',
  body: { shape: 'cell', material: 'stone', mass: { param: 'm', min: 100, max: 2000 } },
  launch: { direction: { param: 'dir', type: 'vec2' }, speed: { param: 'v', min: 0, max: 60 } },
  onImpact: { shape: 'disc', radius: 1, ops: [{ op: 'transferKinetic' }] },
};

/**
 * A wall one cell deep and five wide: the narrowest slab that covers a 5x5
 * wizard. Height scales with density, so the mass has to be a full 2.5 kg per
 * cell or the wall settles as a low pile that stops nothing.
 */
export const WALL: SpellTemplate = {
  id: 'wall',
  body: {
    shape: 'rect',
    length: 1,
    width: 5,
    material: 'stone',
    mass: { param: 'm', min: 12_500, max: 12_500 },
  },
  launch: { direction: { param: 'dir', type: 'vec2' }, speed: 0 },
};

export function book(spells: readonly SpellTemplate[], rules: Rules = RULES): Spellbook {
  return new Spellbook(spells, rules);
}

/** A flat arena with no terrain, so a test measures one thing at a time. */
export function flatRound(
  options: {
    spells?: readonly SpellTemplate[];
    spawns?: readonly [[number, number], [number, number]];
    firstMover?: Side;
    rules?: Rules;
  } = {},
): Round {
  const rules = options.rules ?? RULES;
  const spells = options.spells ?? [ICE_KNIFE, DART, WALL];
  const spawns = options.spawns ?? [
    [40, 100],
    [140, 100],
  ];
  return new Round({
    rules,
    world: new World(rules),
    spawns: [
      [spawns[0][0], spawns[0][1]],
      [spawns[1][0], spawns[1][1]],
    ],
    spellbooks: { A: book(spells, rules), B: book(spells, rules) },
    firstMover: options.firstMover ?? 'A',
    round: 1,
    game: 1,
  });
}

export function generatedRound(seed: string, rules: Rules = RULES): Round {
  const map = generateMap(seed, rules);
  return new Round({
    rules,
    world: map.world,
    spawns: map.spawns,
    spellbooks: {
      A: book([ICE_KNIFE, DART, WALL], rules),
      B: book([ICE_KNIFE, DART, WALL], rules),
    },
    firstMover: 'A',
    round: 1,
    game: 1,
  });
}

export const PASS: ActionsMessage = { type: 'actions' };

/** Drives a match with a fixed decision function, returning the state hashes. */
export function playMatch(
  seed: string,
  decide: (side: Side, turn: number, round: number) => ActionsMessage | null,
  rules: Rules = RULES,
): { hashes: string[]; match: Match } {
  const match = new Match({
    rules,
    seed,
    spellbooks: {
      A: book([ICE_KNIFE, DART, WALL], rules),
      B: book([ICE_KNIFE, DART, WALL], rules),
    },
  });
  const hashes: string[] = [];
  let guard = 0;
  while (!match.finished && guard++ < 5000) {
    match.drainOutbox();
    const pending = match.pending;
    if (!pending) break;
    match.submit(decide(pending.side, pending.message.turn, pending.message.round));
    const round = match.currentRound;
    if (round) hashes.push(round.stateHash());
  }
  return { hashes, match };
}
