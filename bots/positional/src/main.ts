/**
 * The positional bot: use cover, hold a working range, lead the target, and
 * keep a cheap interceptor armed.
 *
 * This is the "skilled" side of passport §21 scenario 3. Everything it does is
 * expressible through the public protocol — it has no engine access the naive
 * bot lacks, only better reasoning about the same numbers.
 */
import {
  declaredTemperatureFor,
  distance,
  facingFromVector,
  leadTarget,
  runBot,
  stepsToward,
  shapeCellCount,
  wandCell,
  type BotContext,
} from '@spark/sdk';
import type { ActionsMessage, SpellTemplate, TurnMessage, Vec2 } from '@spark/protocol';

/** Working range: close enough that a v40 knife lands in a turn or two. */
const PREFERRED_RANGE = 30;
const KNIFE_SPEED = 45;

const SPELLS: SpellTemplate[] = [
  {
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
  },
  {
    id: 'dart',
    body: { shape: 'cell', material: 'stone', mass: { param: 'm', min: 100, max: 2000 } },
    launch: { direction: { param: 'dir', type: 'vec2' }, speed: { param: 'v', min: 0, max: 60 } },
    onImpact: { shape: 'disc', radius: 1, ops: [{ op: 'transferKinetic' }] },
  },
  {
    // One cell deep, five wide: just enough to cover a 5x5 wizard, at stone's
    // full density so it actually stands above flight altitude. 12.5 kg of
    // stone is 75 mana, which is reachable; the passport's 50 kg slab is 300
    // and could never be cast against a 150 mana cap.
    id: 'wall',
    body: { shape: 'rect', length: 1, width: 5, material: 'stone', mass: 12_500 },
    launch: { direction: { param: 'dir', type: 'vec2' }, speed: 0 },
  },
];

interface Memory {
  lastOpponent?: Vec2;
  opponentVelocity: Vec2;
}

function memoryOf(ctx: BotContext): Memory {
  const m = ctx.memory as { positional?: Memory };
  if (!m.positional) m.positional = { opponentVelocity: [0, 0] };
  return m.positional;
}

runBot({
  spellbook: () => SPELLS,

  turn(msg: TurnMessage, ctx: BotContext): ActionsMessage {
    const mem = memoryOf(ctx);
    const me = msg.you.pos;
    const them = msg.opponent.pos;

    // Track the opponent so shots can be led rather than aimed at history.
    if (mem.lastOpponent) {
      mem.opponentVelocity = [them[0] - mem.lastOpponent[0], them[1] - mem.lastOpponent[1]];
    }
    mem.lastOpponent = them;

    const range = distance(me, them);

    // Everything is decided against where this wizard will be standing after
    // the move, not where it is now. Casting first and then walking forward is
    // how you eat your own projectile: the wand is only 5 cells ahead, and a
    // turn buys up to 15 MP of movement.
    const wantFacing = facingFromVector(them[0] - me[0], them[1] - me[1]);
    const mpLeft = msg.you.mp - turnMpCost(msg.you.facing, wantFacing);

    let path: Vec2[] = [];
    const clearShotNow = ctx.world.lineOfFire(wandCell(me, wantFacing, ctx.rules), them, ctx.rules);
    if (range > PREFERRED_RANGE + 8 || !clearShotNow) {
      path = walkable(ctx, me, them, Math.min(mpLeft, 6));
    } else if (range < PREFERRED_RANGE - 10) {
      const away: Vec2 = [me[0] * 2 - them[0], me[1] * 2 - them[1]];
      path = walkable(ctx, me, away, Math.min(mpLeft, 5));
    }
    const endPos: Vec2 = [
      me[0] + path.reduce((a, s) => a + s[0], 0),
      me[1] + path.reduce((a, s) => a + s[1], 0),
    ];
    const facing = facingFromVector(them[0] - endPos[0], them[1] - endPos[1]);
    const wand = wandCell(endPos, facing, ctx.rules);
    const aim = leadTarget(wand, them, mem.opponentVelocity, KNIFE_SPEED);
    const clearShot = ctx.world.lineOfFire(wand, them, ctx.rules);
    const endRange = distance(endPos, them);

    const actions: {
      move1?: ActionsMessage['move1'];
      cast?: ActionsMessage['cast'];
      move2?: ActionsMessage['move2'];
      react?: ActionsMessage['react'];
    } = {};

    // Move and turn first, then cast from where the wizard actually ends up.
    actions.move1 = path.length > 0 ? { turnTo: facing, path } : { turnTo: facing };

    // Cast slot: the knife when it can be afforded and a shot exists, a dart
    // otherwise. An underpowered cast falls short and drops as inert matter, so
    // there is no point firing something that cannot reach.
    if (clearShot) {
      const chill = declaredTemperatureFor(
        -200,
        7200,
        'ice',
        shapeCellCount({ shape: 'disc', radius: 2 }),
        ctx.rules,
      );
      const knifeArgs = { m: 7200, v: KNIFE_SPEED, chill, dir: aim };
      const knifeCost = ctx.cost('knife', knifeArgs);
      const affordable = knifeCost && knifeCost.total + reserveFor(ctx) <= msg.you.manaMilli;
      if (affordable && endRange <= 55) {
        actions.cast = { spellId: 'knife', args: knifeArgs };
      } else {
        const dartArgs = { m: 1200, v: 55, dir: aim };
        const dartCost = ctx.cost('dart', dartArgs);
        if (dartCost && dartCost.total + reserveFor(ctx) <= msg.you.manaMilli) {
          actions.cast = { spellId: 'dart', args: dartArgs };
        }
      }
    } else if (msg.you.hpMilli < 45_000 && msg.you.manaMilli > 90_000) {
      // Badly hurt and rich: buy cover instead of trading shots.
      actions.cast = { spellId: 'wall', args: { dir: aim } };
    }

    // React slot: intercept anything hostile that gets close. The reservation is
    // the worst case across the dart's declared ranges, refunded if it misses.
    actions.react = {
      trigger: { kind: 'objectEnteredRadius', r: 14 },
      spellId: 'dart',
      args: { m: 800, v: 50, dir: '$triggerObject' },
    };

    return { type: 'actions', ...actions };
  },
});

/** Worst-case reservation the react slot will take, so casts leave room for it. */
function reserveFor(ctx: BotContext): number {
  const worst = ctx.cost('dart', { m: 2000, v: 60 });
  return worst ? worst.total : 0;
}

function turnMpCost(from: number, to: number): number {
  const d = Math.abs(((to - from) % 8) + 8) % 8;
  return Math.min(d, 8 - d);
}

/** Steps toward a target that keep the whole 5x5 footprint legal. */
function walkable(ctx: BotContext, from: Vec2, to: Vec2, maxSteps: number): Vec2[] {
  if (maxSteps <= 0) return [];
  const wanted = stepsToward(from, to, maxSteps);
  const path: Vec2[] = [];
  let [x, y] = from;
  for (const [dx, dy] of wanted) {
    if (!ctx.world.footprintLegal(x + dx, y + dy, ctx.rules)) {
      // Try sliding along one axis before giving up on the whole path.
      const slides: Vec2[] = [
        [dx, 0],
        [0, dy],
      ];
      const slide = slides.find(
        ([sx, sy]) => (sx !== 0 || sy !== 0) && ctx.world.footprintLegal(x + sx, y + sy, ctx.rules),
      );
      if (!slide) break;
      path.push(slide);
      x += slide[0];
      y += slide[1];
      continue;
    }
    path.push([dx, dy]);
    x += dx;
    y += dy;
  }
  return path;
}
