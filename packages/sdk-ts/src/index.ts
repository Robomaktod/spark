/**
 * TypeScript SDK for Spark bots.
 *
 * The protocol is the contract (passport §14.1) — a bot in any language that
 * can read a line and write a line can play. This library exists so that a
 * TypeScript author does not have to re-implement line framing, world-delta
 * bookkeeping and the cost model before writing any strategy.
 */
import { createInterface } from 'node:readline';
import type {
  ActionsMessage,
  ArenaInfo,
  CastArgs,
  CellView,
  EngineToBot,
  MatchEndMessage,
  MatchStartMessage,
  ObjectView,
  Rules,
  RoundEndMessage,
  RoundStartMessage,
  Side,
  SpellTemplate,
  TurnMessage,
  Vec2,
} from '@spark/protocol';
import { MATERIALS, type MaterialId } from '@spark/protocol';
import {
  costOfCast,
  facingDistance,
  facingFromVector,
  heatCapacityOf,
  ilen,
  nominalImpactMassG,
  shapeCellCount,
  pagesForSpell,
  temperatureRiseMilliC,
  thermalEnergyMilliJ,
  type CostBreakdown,
} from '@spark/engine';
import type { ShapeSpec } from '@spark/protocol';

export type { CostBreakdown };

/** A bot's local picture of the arena, kept current from the sparse deltas. */
export class WorldView {
  private readonly cells = new Map<number, CellView>();
  width = 0;
  height = 0;

  reset(arena: ArenaInfo): void {
    this.cells.clear();
    this.width = arena.width;
    this.height = arena.height;
    for (const c of arena.cells) this.cells.set(this.key(c.p[0], c.p[1]), c);
  }

  apply(deltas: readonly CellView[]): void {
    for (const c of deltas) this.cells.set(this.key(c.p[0], c.p[1]), c);
  }

  private key(x: number, y: number): number {
    return y * 100_000 + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Anything not in the delta map is still ambient air. */
  at(x: number, y: number): CellView {
    const found = this.cells.get(this.key(x, y));
    if (found) return found;
    return { p: [x, y], mat: 'air', m: MATERIALS.air.densityGPerCell, t: 20_000, b: 0, h: 0 };
  }

  blocksFlight(x: number, y: number, rules: Rules): boolean {
    if (!this.inBounds(x, y)) return true;
    return this.at(x, y).h > rules.arena.flightAltitudeMm;
  }

  blocksWizard(x: number, y: number, rules: Rules): boolean {
    if (!this.inBounds(x, y)) return true;
    return this.at(x, y).h > rules.wizard.blockedHeightMm;
  }

  /** True when a 5x5 footprint centred on (x, y) would be legal. */
  footprintLegal(x: number, y: number, rules: Rules): boolean {
    const r = rules.wizard.footprintRadius;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (this.blocksWizard(x + dx, y + dy, rules)) return false;
      }
    }
    return true;
  }

  /** True when nothing at flight altitude stands between two points. */
  lineOfFire(from: Vec2, to: Vec2, rules: Rules): boolean {
    for (const [x, y] of bresenham(from, to)) {
      if (x === from[0] && y === from[1]) continue;
      if (this.blocksFlight(x, y, rules)) return false;
    }
    return true;
  }
}

/** Integer line walk. Deterministic and allocation-light. */
export function bresenham(from: Vec2, to: Vec2): Vec2[] {
  const out: Vec2[] = [];
  let [x, y] = from;
  const [tx, ty] = to;
  const dx = Math.abs(tx - x);
  const dy = Math.abs(ty - y);
  const sx = x < tx ? 1 : -1;
  const sy = y < ty ? 1 : -1;
  let err = dx - dy;
  for (let guard = 0; guard < 4096; guard++) {
    out.push([x, y]);
    if (x === tx && y === ty) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

export function distance(a: Vec2, b: Vec2): number {
  return ilen(b[0] - a[0], b[1] - a[1]);
}

const FACING_VECTORS: readonly Vec2[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * Where the wand will be for a given position and facing.
 *
 * Worth computing before committing to a turn: the wand is the origin of every
 * cast, so moving after casting can walk you into your own projectile. Matches
 * the engine's rounding exactly.
 */
export function wandCell(pos: Vec2, facing: number, rules: Rules): Vec2 {
  const [dx, dy] = FACING_VECTORS[facing % 8]!;
  const lenMilli = Math.floor(Math.sqrt((dx * dx + dy * dy) * 1_000_000));
  if (lenMilli === 0) return pos;
  const ux = Math.round((dx * 1_000_000) / lenMilli);
  const uy = Math.round((dy * 1_000_000) / lenMilli);
  const dist = rules.wizard.footprintRadius + rules.wizard.wandOffsetCells;
  return [pos[0] + Math.round((ux * dist) / 1000), pos[1] + Math.round((uy * dist) / 1000)];
}

/** Unit steps from `from` toward `to`, at most `maxSteps` of them. */
export function stepsToward(from: Vec2, to: Vec2, maxSteps: number): Vec2[] {
  const path: Vec2[] = [];
  let [x, y] = from;
  for (let i = 0; i < maxSteps; i++) {
    if (x === to[0] && y === to[1]) break;
    const dx = Math.sign(to[0] - x);
    const dy = Math.sign(to[1] - y);
    if (dx === 0 && dy === 0) break;
    path.push([dx, dy]);
    x += dx;
    y += dy;
  }
  return path;
}

/**
 * Where to aim to hit a target that is still moving, given a projectile speed
 * in cells per turn. Iterated rather than solved, which is plenty for a bot and
 * keeps the maths integer.
 */
export function leadTarget(
  from: Vec2,
  target: Vec2,
  targetVelocity: Vec2,
  projectileSpeedCells: number,
): Vec2 {
  if (projectileSpeedCells <= 0) return [target[0] - from[0], target[1] - from[1]];
  // Fixed-point iteration on flight time. Each round trip feeds the previous
  // estimate back in, so the number of turns is clamped: an opponent who was
  // pushed 20 cells last turn would otherwise send the aim point off the map.
  let turns = 0;
  for (let i = 0; i < 4; i++) {
    const aimX = target[0] + targetVelocity[0] * turns;
    const aimY = target[1] + targetVelocity[1] * turns;
    turns = Math.min(8, Math.round(distance(from, [aimX, aimY]) / projectileSpeedCells));
  }
  return [
    target[0] + targetVelocity[0] * turns - from[0],
    target[1] + targetVelocity[1] * turns - from[1],
  ];
}

export { facingDistance, facingFromVector, shapeCellCount, pagesForSpell };

/**
 * The value to pass to an `addTemperature` op to put a body at a given
 * temperature offset.
 *
 * An addTemperature op buys a packet of thermal energy, priced against the
 * nominal cell the impact shape covers. The declared number is therefore the
 * swing that packet would produce in nominal matter, not the swing the body
 * itself ends up with — 7.2 kg of ice takes a lot more energy to chill than
 * thirteen nominal cells do. This converts between the two.
 *
 * Chilling a 7.2 kg ice knife to -200 C through a radius-2 impact disc, for
 * instance, means declaring about -5538 and paying 14.4 mana for it.
 */
export function declaredTemperatureFor(
  wantedDeltaC: number,
  bodyMassG: number,
  bodyMaterial: MaterialId,
  impactCells: number,
  rules: Rules,
): number {
  const energy = thermalEnergyMilliJ(
    bodyMassG,
    rules.materials[bodyMaterial].specificHeatMilli,
    wantedDeltaC * 1000,
  );
  const nominal = nominalImpactMassG(impactCells, rules) * rules.costs.nominalCellSpecificHeatMilli;
  if (nominal <= 0) return 0;
  return Math.round((energy * 1_000_000) / nominal / 1000);
}

/** The temperature a body will actually reach for a declared addTemperature value. */
export function bodyTemperatureDeltaC(
  declaredValue: number,
  bodyMassG: number,
  bodyMaterial: MaterialId,
  impactCells: number,
  rules: Rules,
): number {
  const energy = thermalEnergyMilliJ(
    nominalImpactMassG(impactCells, rules),
    rules.costs.nominalCellSpecificHeatMilli,
    declaredValue * 1000,
  );
  const capacity = heatCapacityOf(bodyMassG, rules.materials[bodyMaterial].specificHeatMilli);
  return Math.round(temperatureRiseMilliC(energy, capacity) / 1000);
}

export interface BotContext {
  readonly rules: Rules;
  side: Side;
  arena: ArenaInfo | null;
  readonly world: WorldView;
  readonly spells: Map<string, SpellTemplate>;
  /** Whatever the bot wants to remember. Survives all four rounds. */
  readonly memory: Record<string, unknown>;
  /** Exact cost of a cast, in milli-mana, before committing to it. */
  cost(spellId: string, args: CastArgs): CostBreakdown | null;
  /** Prints to stderr, which the engine captures into the replay. */
  log(...parts: unknown[]): void;
}

export interface BotHandlers {
  /** Called once, before the map is revealed. The book cannot change after this. */
  spellbook(rules: Rules): SpellTemplate[];
  matchStart?(msg: MatchStartMessage, ctx: BotContext): void;
  roundStart?(msg: RoundStartMessage, ctx: BotContext): void;
  turn(msg: TurnMessage, ctx: BotContext): ActionsMessage;
  roundEnd?(msg: RoundEndMessage, ctx: BotContext): void;
  matchEnd?(msg: MatchEndMessage, ctx: BotContext): void;
}

function buildContext(rules: Rules): BotContext {
  const world = new WorldView();
  const spells = new Map<string, SpellTemplate>();
  return {
    rules,
    side: 'A',
    arena: null,
    world,
    spells,
    memory: {},
    log: (...parts) => process.stderr.write(parts.map(String).join(' ') + '\n'),
    cost(spellId, args) {
      const t = spells.get(spellId);
      if (!t) return null;
      const num = (v: number | { param: string; min: number; max: number }): number =>
        typeof v === 'number' ? v : Number(args[v.param] ?? v.min);
      const impactCells = t.onImpact ? shapeCellCount(t.onImpact) : 1;
      return costOfCast(
        {
          bodyMassG: num(t.body.mass),
          bodyMaterial: t.body.material,
          bodyCells: shapeCellCount(t.body as unknown as ShapeSpec),
          speedMilliCellsPerTurn: num(t.launch.speed) * 1000,
          impactCells,
          impactOps: (t.onImpact?.ops ?? []).map((op) => ({
            op: op.op,
            value: op.op === 'transferKinetic' ? 0 : num(op.value),
          })),
        },
        rules,
      );
    },
  };
}

/**
 * Runs the bot's stdin/stdout loop. One JSON object per line in each direction;
 * stderr is the debug log and is surfaced in the replay (passport §14.1).
 */
export function runBot(handlers: BotHandlers): void {
  let ctx: BotContext | null = null;
  const send = (obj: unknown): void => {
    process.stdout.write(JSON.stringify(obj) + '\n');
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (text.length === 0) return;
    let msg: EngineToBot;
    try {
      msg = JSON.parse(text) as EngineToBot;
    } catch {
      process.stderr.write(`could not parse engine message: ${text.slice(0, 200)}\n`);
      return;
    }

    try {
      switch (msg.type) {
        case 'init': {
          ctx = buildContext(msg.rules);
          const spells = handlers.spellbook(msg.rules);
          for (const s of spells) ctx.spells.set(s.id, s);
          send({ type: 'spellbook', spells });
          break;
        }
        case 'spellbook_result': {
          if (!msg.accepted) {
            process.stderr.write(`spellbook rejected: ${(msg.errors ?? []).join('; ')}\n`);
          } else {
            process.stderr.write(`spellbook accepted, ${msg.pagesUsed}/${msg.maxPages} pages\n`);
          }
          break;
        }
        case 'match_start': {
          if (!ctx) break;
          ctx.side = msg.youAre;
          ctx.arena = msg.arena;
          ctx.world.reset(msg.arena);
          handlers.matchStart?.(msg, ctx);
          break;
        }
        case 'round_start': {
          if (!ctx) break;
          ctx.side = msg.youAre;
          ctx.arena = msg.arena;
          ctx.world.reset(msg.arena);
          handlers.roundStart?.(msg, ctx);
          break;
        }
        case 'turn': {
          if (!ctx) break;
          ctx.world.apply(msg.cells);
          send(handlers.turn(msg, ctx));
          break;
        }
        case 'round_end': {
          if (ctx) handlers.roundEnd?.(msg, ctx);
          break;
        }
        case 'match_end': {
          if (ctx) handlers.matchEnd?.(msg, ctx);
          rl.close();
          break;
        }
      }
    } catch (err) {
      process.stderr.write(`bot error on ${msg.type}: ${(err as Error).stack ?? String(err)}\n`);
      if (msg.type === 'turn') send({ type: 'actions' });
    }
  });
}

export type { ObjectView, TurnMessage, ActionsMessage, SpellTemplate, Rules, Side, Vec2 };
