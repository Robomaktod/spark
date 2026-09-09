/**
 * The naive bot: point at the opponent and throw an ice knife, every turn,
 * forever. No movement, no cover, no leading.
 *
 * It exists as the control in passport §21 scenario 3 — a positional bot should
 * beat this one at least 70% of the time. If it does not, the tuning table is
 * wrong, not the bot.
 */
import { declaredTemperatureFor, runBot, shapeCellCount, type BotContext } from '@spark/sdk';
import type { ActionsMessage, SpellTemplate, TurnMessage } from '@spark/protocol';

const KNIFE: SpellTemplate = {
  id: 'knife',
  body: {
    shape: 'line',
    length: 8,
    material: 'ice',
    mass: { param: 'm', min: 500, max: 8000 },
  },
  launch: {
    direction: { param: 'dir', type: 'vec2' },
    speed: { param: 'v', min: 0, max: 60 },
  },
  onImpact: {
    shape: 'disc',
    radius: 2,
    ops: [
      { op: 'transferKinetic' },
      { op: 'addTemperature', value: { param: 'chill', min: -8000, max: 0 } },
    ],
  },
};

runBot({
  spellbook: () => [KNIFE],

  turn(msg: TurnMessage, ctx: BotContext): ActionsMessage {
    const me = msg.you.pos;
    const them = msg.opponent.pos;
    const dir: [number, number] = [them[0] - me[0], them[1] - me[1]];

    // Face the target, because the wand sits ahead of the footprint along the
    // facing vector: throwing backwards would put the knife through itself.
    const facing = facingToward(dir);

    // The chill parameter is energy priced against a nominal cell, so the SDK
    // converts "I want this knife at -200 C" into the number to declare.
    const chill = declaredTemperatureFor(-200, 7200, 'ice', shapeCellCount({ shape: 'disc', radius: 2 }), ctx.rules);
    const args = { m: 7200, v: 40, chill, dir };
    const cost = ctx.cost('knife', args);
    if (!cost || cost.total > msg.you.manaMilli) {
      return { type: 'actions', move1: { turnTo: facing } };
    }
    return {
      type: 'actions',
      move1: { turnTo: facing },
      cast: { spellId: 'knife', args },
    };
  },
});

/** Nearest of the 8 facings to a direction. Index 0 is east, then clockwise. */
function facingToward([dx, dy]: [number, number]): number {
  const table: [number, number][] = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  let best = 0;
  let bestDot = -Infinity;
  const len = Math.max(1, Math.hypot(dx, dy));
  for (let i = 0; i < table.length; i++) {
    const [fx, fy] = table[i]!;
    const dot = (dx * fx + dy * fy) / (len * Math.hypot(fx, fy));
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }
  return best;
}
