/**
 * The physics step (passport §12). Runs once at the end of every wizard's turn,
 * which is what makes a projectile travel during the opponent's turn too, and
 * what makes leading a moving target and intercepting an incoming shot both
 * real tactics.
 *
 *   1. Advance objects along swept paths
 *   2. Resolve collisions in order of collision time
 *   3. Apply drag; settle anything slower than 1 cell/turn
 *   4. Settled objects write themselves into cells
 *   5. Heat decay on dirty cells
 *   6. Phase checks on dirty cells
 *   7. Concentration upkeep
 *   8. Mana regen
 *
 * Steps 7 and 8 live in round.ts, which owns the wizards' books.
 */
import type { MaterialId, Rules, Side } from '@spark/protocol';
import { MATERIALS } from '@spark/protocol';
import type { World } from './world.js';
import type { Wizard } from './wizard.js';
import type { SparkObject } from './objects.js';
import type { EngineEvent, Vec } from './events.js';
import {
  heatCapacityOf,
  impactDamageMilliHp,
  keMilliJ,
  speedForKeMilliJ,
  temperatureRiseMilliC,
  thermalEnergyMilliJ,
} from './pricing.js';
import { idivRound } from './fp.js';
import { pushWizard } from './movement.js';
import type { PathRecorder } from './paths.js';

export interface PhysicsContext {
  readonly world: World;
  readonly rules: Rules;
  readonly objects: SparkObject[];
  readonly wizards: Readonly<Record<Side, Wizard>>;
  readonly events: EngineEvent[];
  /** Called when a concentrated object is destroyed, so the link can be closed. */
  readonly onObjectLost: (obj: SparkObject, reason: string) => void;
  /** Collects swept paths for smooth playback (web plan §6). */
  readonly paths: PathRecorder;
}

export { temperatureRiseMilliC };

function heatCapacityOfCell(world: World, x: number, y: number): number {
  const i = world.idx(x, y);
  const mat = world.materialOfIndex(i);
  return heatCapacityOf(world.mass[i]!, MATERIALS[mat].specificHeatMilli);
}

/** How finely the turn is subdivided, so nothing tunnels through a 1-cell wall. */
function substepsFor(objects: readonly SparkObject[]): number {
  let maxSpeed = 0;
  for (const o of objects) {
    if (o.destroyed || o.settled) continue;
    maxSpeed = Math.max(maxSpeed, o.speedMilli);
  }
  // A quarter cell per substep at the fastest object's speed.
  const needed = Math.ceil((maxSpeed * 4) / 1000);
  return Math.min(2048, Math.max(64, needed));
}

interface Track {
  baseX: number;
  baseY: number;
  baseK: number;
}

/**
 * Applies the object's impact shape at a point: its declared ops, plus the
 * kinetic energy it was carrying, which physics deposits whether or not the
 * template bothered to say `transferKinetic`.
 */
function applyImpact(
  ctx: PhysicsContext,
  obj: SparkObject,
  atX: number,
  atY: number,
  energyMilliJ: number,
): void {
  const { world } = ctx;
  const cells = obj.impact ? obj.impact.cells : [[0, 0] as const];
  const ops = obj.impact ? obj.impact.ops : [];
  const inBounds = cells
    .map(([dx, dy]) => [atX + dx, atY + dy] as const)
    .filter(([x, y]) => world.inBounds(x, y));
  if (inBounds.length === 0) return;

  const objectC = MATERIALS[obj.material].specificHeatMilli;
  const objectShareG = Math.max(1, Math.trunc(obj.massG / inBounds.length));

  // Everything the object was carrying arrives here: the kinetic energy the
  // impulse paid for, and the thermal energy an addTemperature op bought. Both
  // land as a temperature change sized by what was actually struck, so hitting
  // 2.5 kg of stone warms it far less than hitting a litre of air.
  const carriedHeat = thermalEnergyMilliJ(
    obj.massG,
    objectC,
    obj.temperatureMilliC - ctx.rules.arena.ambientMilliC,
  );
  const totalEnergy = energyMilliJ + carriedHeat;
  const perCellEnergy = Math.trunc(totalEnergy / inBounds.length);

  for (const [x, y] of inBounds) {
    if (perCellEnergy !== 0) {
      const capacity = heatCapacityOfCell(world, x, y) + objectShareG * objectC;
      world.addTemperature(x, y, temperatureRiseMilliC(perCellEnergy, capacity));
    }
    for (const op of ops) {
      if (op.op === 'setBinding') {
        const i = world.idx(x, y);
        world.setBinding(x, y, world.binding[i]! + op.value);
      }
    }
  }
}

/** Writes a settled object into the cells it covers (passport §12 step 4). */
function settleIntoCells(ctx: PhysicsContext, obj: SparkObject): void {
  const { world } = ctx;
  const perCell = obj.massPerCellG;
  const spec = MATERIALS[obj.material];
  for (const [x, y] of obj.occupiedCells()) {
    if (!world.inBounds(x, y)) continue;
    const heightMm = Math.min(
      3000,
      idivRound(spec.settledHeightMm * perCell, Math.max(1, spec.densityGPerCell)),
    );
    world.writeCell(x, y, obj.material, {
      massG: perCell,
      milliC: obj.temperatureMilliC,
      binding: spec.defaultBinding,
      heightMm,
    });
  }
  ctx.events.push({ t: 'settled', objectId: obj.id, at: [obj.cellX, obj.cellY] as Vec });
}

function destroyObject(ctx: PhysicsContext, obj: SparkObject, reason: string): void {
  obj.destroyed = true;
  if (obj.concentrated) ctx.onObjectLost(obj, reason);
}

/**
 * Steps 1 and 2: advance every object along its swept path and resolve
 * collisions in time order. The turn is walked in substeps fine enough that no
 * object can cross a cell without being tested in it.
 */
export function advanceObjects(ctx: PhysicsContext): void {
  const { world, rules, wizards, events, paths } = ctx;
  const moving = ctx.objects.filter((o) => !o.destroyed && !o.settled && o.speedMilli > 0);
  if (moving.length === 0) return;

  const N = substepsFor(moving);
  const tracks = new Map<number, Track>();
  for (const o of moving) {
    tracks.set(o.id, { baseX: o.xMilli, baseY: o.yMilli, baseK: 0 });
    paths.begin(
      o.id,
      { objectId: o.id, owner: o.owner, material: o.material, spellId: o.spellId, cells: o.cells },
      o.xMilli,
      o.yMilli,
      0,
    );
  }

  const sorted = [...moving].sort((a, b) => a.id - b.id);
  /** Where in the turn substep k falls, in milli-turns. */
  const at = (k: number): number => Math.round((k * 1000) / N);

  for (let k = 1; k <= N; k++) {
    for (const o of sorted) {
      if (o.destroyed || o.settled) continue;
      const tr = tracks.get(o.id)!;
      const dk = k - tr.baseK;
      o.xMilli = tr.baseX + idivRound(o.vxMilli * dk, N);
      o.yMilli = tr.baseY + idivRound(o.vyMilli * dk, N);
    }

    // Object vs object first: both are destroyed, so it settles the others.
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      if (a.destroyed || a.settled) continue;
      const aCells = new Set(a.occupiedCells().map(([x, y]) => y * 100000 + x));
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]!;
        if (b.destroyed || b.settled) continue;
        if (!b.occupiedCells().some(([x, y]) => aCells.has(y * 100000 + x))) continue;

        const midX = Math.floor((a.cellX + b.cellX) / 2);
        const midY = Math.floor((a.cellY + b.cellY) / 2);
        const combined = keMilliJ(a.massG, a.speedMilli) + keMilliJ(b.massG, b.speedMilli);
        events.push({
          t: 'objects_collided',
          a: a.id,
          b: b.id,
          at: [midX, midY] as Vec,
          keMilliJ: combined,
        });
        applyImpact(ctx, a, midX, midY, Math.trunc(combined / 2));
        applyImpact(ctx, b, midX, midY, Math.trunc(combined / 2));
        paths.cut(a.id, a.xMilli, a.yMilli, at(k), 'collision');
        paths.cut(b.id, b.xMilli, b.yMilli, at(k), 'collision');
        destroyObject(ctx, a, 'collided with another object');
        destroyObject(ctx, b, 'collided with another object');
        break;
      }
    }

    for (const o of sorted) {
      if (o.destroyed || o.settled) continue;

      // Object vs wizard.
      let hitSide: Side | null = null;
      let contact: readonly [number, number] | null = null;
      for (const side of ['A', 'B'] as const) {
        const w = wizards[side];
        if (!w.alive) continue;
        const touching = o.occupiedCells().find(([x, y]) => w.covers(x, y));
        if (touching) {
          hitSide = side;
          contact = touching;
          break;
        }
      }
      if (hitSide && contact) {
        const w = wizards[hitSide];
        const energy = keMilliJ(o.massG, o.speedMilli);
        const [hx, hy] = contact;
        const impactCells = o.impact ? o.impact.cells : [[0, 0] as const];
        const shapeCells = o.impact ? o.impact.canonicalCellCount : 1;
        const overlap = impactCells.filter(([dx, dy]) => w.covers(hx + dx, hy + dy)).length;
        const damage = impactDamageMilliHp(energy, overlap, shapeCells, rules);
        w.damage(damage);
        events.push({
          t: 'impact_wizard',
          objectId: o.id,
          target: hitSide,
          damageMilli: damage,
          overlap,
          impactCells: shapeCells,
          keMilliJ: energy,
          at: [hx, hy] as Vec,
          shape: impactCells.map(([dx, dy]) => [dx, dy] as Vec),
          footprint: w.footprintCells().map(([x, y]) => [x, y] as Vec),
        });
        applyImpact(ctx, o, hx, hy, energy);
        const push = pushWizard(
          world,
          w,
          idivRound(o.massG * o.vxMilli, 1000),
          idivRound(o.massG * o.vyMilli, 1000),
          rules,
        );
        if (push.cells > 0 || push.hitWall) {
          events.push({
            t: 'push',
            side: hitSide,
            cells: push.cells,
            hitWall: push.hitWall,
            damageMilli: push.damageMilliHp,
          });
        }
        if (!w.alive) events.push({ t: 'death', side: hitSide });
        paths.cut(o.id, o.xMilli, o.yMilli, at(k), 'wizard');
        destroyObject(ctx, o, 'hit a wizard');
        continue;
      }

      // Object vs cell.
      let blockedAt: readonly [number, number] | null = null;
      let hitBoundary = false;
      for (const [x, y] of o.occupiedCells()) {
        if (!world.inBounds(x, y)) {
          // Passport §3.5: the arena boundary is a hard wall. Objects that
          // reach the edge stop and settle; they never break through.
          blockedAt = [
            Math.max(0, Math.min(world.width - 1, x)),
            Math.max(0, Math.min(world.height - 1, y)),
          ];
          hitBoundary = true;
          break;
        }
        if (world.blocksFlight(x, y, rules.arena.flightAltitudeMm)) {
          blockedAt = [x, y];
          break;
        }
      }
      if (!blockedAt) continue;

      const [bx, by] = blockedAt;
      const energy = keMilliJ(o.massG, o.speedMilli);
      const i = world.idx(bx, by);
      const resistance = world.binding[i]! * world.mass[i]!;

      if (!hitBoundary && energy > resistance) {
        // Penetration: the cell gives way and the object carries on with what is left.
        const before = world.materialOfIndex(i);
        world.setBinding(bx, by, 0);
        world.setMaterial(bx, by, 'rubble');
        world.setHeight(bx, by, Math.min(world.heightMm[i]!, MATERIALS.rubble.settledHeightMm));
        events.push({
          t: 'impact_cell',
          objectId: o.id,
          at: [bx, by] as Vec,
          penetrated: true,
          keMilliJ: energy,
        });
        if (before !== 'rubble') {
          events.push({ t: 'phase_change', at: [bx, by] as Vec, from: before, to: 'rubble' });
        }
        applyImpact(ctx, o, bx, by, resistance);

        const remaining = energy - resistance;
        const newSpeed = speedForKeMilliJ(o.massG, remaining);
        const oldSpeed = o.speedMilli;
        if (newSpeed < rules.physics.settleSpeedMilliCells || oldSpeed === 0) {
          o.vxMilli = 0;
          o.vyMilli = 0;
          o.settled = true;
          paths.cut(o.id, o.xMilli, o.yMilli, at(k), 'stopped');
        } else {
          o.vxMilli = idivRound(o.vxMilli * newSpeed, oldSpeed);
          o.vyMilli = idivRound(o.vyMilli * newSpeed, oldSpeed);
          // The velocity changed, so this run ends and the next one begins here.
          paths.cut(o.id, o.xMilli, o.yMilli, at(k), 'penetrated');
          paths.begin(
            o.id,
            {
              objectId: o.id,
              owner: o.owner,
              material: o.material,
              spellId: o.spellId,
              cells: o.cells,
            },
            o.xMilli,
            o.yMilli,
            at(k),
          );
          const tr = tracks.get(o.id)!;
          tr.baseX = o.xMilli;
          tr.baseY = o.yMilli;
          tr.baseK = k;
        }
      } else {
        // The cell holds: the object stops and dumps its energy into what it struck.
        events.push({
          t: 'impact_cell',
          objectId: o.id,
          at: [bx, by] as Vec,
          penetrated: false,
          keMilliJ: energy,
        });
        applyImpact(ctx, o, bx, by, energy);
        o.vxMilli = 0;
        o.vyMilli = 0;
        o.settled = true;
        paths.cut(o.id, o.xMilli, o.yMilli, at(k), hitBoundary ? 'boundary' : 'stopped');
      }
    }
  }
}

/** Step 3: drag. `v -= v*0.10 + 1 cell`; below 1 cell/turn the object settles. */
export function applyDrag(ctx: PhysicsContext): void {
  const { rules } = ctx;
  for (const o of ctx.objects) {
    if (o.destroyed || o.settled) continue;
    const speed = o.speedMilli;
    if (speed === 0) {
      o.settled = true;
      continue;
    }
    const loss =
      idivRound(speed * rules.physics.dragPermille, 1000) + rules.physics.dragFlatMilliCells;
    const next = speed - loss;
    if (next < rules.physics.settleSpeedMilliCells) {
      o.vxMilli = 0;
      o.vyMilli = 0;
      o.settled = true;
    } else {
      o.vxMilli = idivRound(o.vxMilli * next, speed);
      o.vyMilli = idivRound(o.vyMilli * next, speed);
    }
  }
}

/**
 * Step 4. A settled object writes itself into the world and stops being an
 * object — unless a concentration link is holding it, in which case it stays an
 * object at rest so the bot can retrieve and re-fire it (passport §10).
 */
export function settleObjects(ctx: PhysicsContext): void {
  for (const o of ctx.objects) {
    if (o.destroyed || !o.settled) continue;
    if (o.concentrated) continue;
    settleIntoCells(ctx, o);
    o.destroyed = true;
  }
}

/**
 * Step 5: every dirty cell moves 30% of the way toward ambient, and so does
 * every object that no concentration link is holding. Objects decaying is what
 * gives concentration something to buy (passport §10).
 */
export function decayHeat(ctx: PhysicsContext): void {
  const { world, rules } = ctx;
  const ambient = rules.arena.ambientMilliC;

  for (const o of ctx.objects) {
    if (o.destroyed || o.concentrated) continue;
    const diff = o.temperatureMilliC - ambient;
    if (diff === 0) continue;
    const delta = idivRound(diff * rules.physics.heatDecayPermille, 1000);
    o.temperatureMilliC = delta === 0 ? ambient : o.temperatureMilliC - delta;
  }

  for (const block of [...world.dirtyBlockList]) {
    for (const { i, x, y } of world.blockCells(block)) {
      const t = world.temperature[i]!;
      if (t === ambient) continue;
      const delta = idivRound((t - ambient) * rules.physics.heatDecayPermille, 1000);
      if (delta === 0) {
        world.setTemperature(x, y, ambient);
      } else {
        world.setTemperature(x, y, t - delta);
      }
    }
  }
}

/**
 * Step 6: phase checks. v1 allows exactly three transitions (passport §3.3):
 * ice <-> water at 0 C, water -> air at 100 C with the mass removed, and
 * stone -> rubble when binding reaches 0.
 */
export function phaseChecks(ctx: PhysicsContext): void {
  const { world, events } = ctx;
  for (const block of [...world.dirtyBlockList]) {
    for (const { i, x, y } of world.blockCells(block)) {
      const mat: MaterialId = world.materialOfIndex(i);
      const t = world.temperature[i]!;
      const massG = world.mass[i]!;

      const melt = MATERIALS[mat].meltMilliC;
      if (melt !== null && t >= melt && world.binding[i]! > 0) {
        // Matter at its melting point has no structural cohesion left. This is
        // what makes passport §9's wall-melter possible: heat, not force.
        world.setBinding(x, y, 0);
      }

      if (mat === 'ice' && t > (MATERIALS.ice.meltMilliC ?? 0)) {
        world.writeCell(x, y, 'water', { massG, milliC: t });
        events.push({ t: 'phase_change', at: [x, y] as Vec, from: 'ice', to: 'water' });
      } else if (mat === 'water' && t < (MATERIALS.water.meltMilliC ?? 0)) {
        world.writeCell(x, y, 'ice', { massG, milliC: t });
        events.push({ t: 'phase_change', at: [x, y] as Vec, from: 'water', to: 'ice' });
      } else if (mat === 'water' && t >= (MATERIALS.water.boilMilliC ?? Infinity)) {
        world.writeCell(x, y, 'air', { milliC: t });
        events.push({ t: 'phase_change', at: [x, y] as Vec, from: 'water', to: 'air (steam)' });
      } else if (mat === 'stone' && world.binding[i] === 0) {
        world.writeCell(x, y, 'rubble', { massG, milliC: t });
        events.push({ t: 'phase_change', at: [x, y] as Vec, from: 'stone', to: 'rubble' });
      }
    }
  }
}

/** Burn damage: (T - 60) / 20 HP per turn from the hottest cell underfoot. */
export function hottestUnderFootMilliC(world: World, wizard: Wizard): number {
  let hottest = -Infinity;
  for (const [x, y] of wizard.footprintCells()) {
    if (!world.inBounds(x, y)) continue;
    const t = world.temperature[world.idx(x, y)]!;
    if (t > hottest) hottest = t;
  }
  return hottest === -Infinity ? 0 : hottest;
}
