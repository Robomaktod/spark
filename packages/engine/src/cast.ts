/**
 * Turning a cast action into matter (passport §7).
 *
 * A spell template is blind: no logic, no conditionals, no world queries. The
 * bot reads the world in its own code and passes concrete numbers, which is
 * what makes every cast statically priceable and keeps the engine free of an
 * interpreter.
 */
import type {
  CastArgs,
  CastResult,
  DirectionSpec,
  NumberOrParam,
  Rules,
  ShapeSpec,
  SpellTemplate,
  Vec2,
} from '@spark/protocol';
import { isParamRef, isVec2Param } from '@spark/protocol';
import type { Cell } from './shapes.js';
import { shapeCellCount, shapeCellsInDirection, shapeRadius, unitVectorMilli } from './shapes.js';
import type { CostBreakdown } from './pricing.js';
import {
  costOfCast,
  heatCapacityOf,
  keMilliJ,
  nominalImpactMassG,
  temperatureRiseMilliC,
  thermalEnergyMilliJ,
} from './pricing.js';
import { MATERIALS } from '@spark/protocol';
import type { ResolvedImpact, ResolvedOp } from './objects.js';
import type { World } from './world.js';
import type { Wizard } from './wizard.js';
import { idivRound } from './fp.js';

export interface CastPlan {
  readonly template: SpellTemplate;
  readonly bodyMassG: number;
  readonly bodyCells: readonly Cell[];
  readonly dirX: number;
  readonly dirY: number;
  readonly speedMilli: number;
  readonly vxMilli: number;
  readonly vyMilli: number;
  readonly bodyTemperatureMilliC: number;
  readonly impact: ResolvedImpact | null;
  readonly cost: CostBreakdown;
  readonly manifest: Cell;
  readonly keMilliJoules: number;
  /** Thermal energy the body carries, milli-joules relative to ambient. */
  readonly thermalEnergyMilliJ: number;
}

export type CastPlanResult =
  | { readonly ok: true; readonly plan: CastPlan }
  | { readonly ok: false; readonly result: CastResult; readonly reason: string };

function resolveNumber(
  spec: NumberOrParam,
  args: CastArgs,
  what: string,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (!isParamRef(spec)) return { ok: true, value: spec };
  const raw = args[spec.param];
  if (raw === undefined) return { ok: false, reason: `${what}: missing argument "${spec.param}"` };
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
    return { ok: false, reason: `${what}: argument "${spec.param}" must be an integer` };
  }
  if (raw < spec.min || raw > spec.max) {
    return {
      ok: false,
      reason: `${what}: "${spec.param}"=${raw} is outside the registered range ${spec.min}..${spec.max}`,
    };
  }
  return { ok: true, value: raw };
}

function resolveDirection(
  spec: DirectionSpec,
  args: CastArgs,
): { ok: true; value: Vec2 } | { ok: false; reason: string } {
  if (!isVec2Param(spec)) {
    return { ok: true, value: spec };
  }
  const raw = args[spec.param];
  if (raw === undefined)
    return { ok: false, reason: `launch.direction: missing argument "${spec.param}"` };
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    !Number.isSafeInteger(raw[0]) ||
    !Number.isSafeInteger(raw[1])
  ) {
    return { ok: false, reason: `launch.direction: "${spec.param}" must be a pair of integers` };
  }
  if (raw[0] === 0 && raw[1] === 0) {
    return { ok: false, reason: `launch.direction: "${spec.param}" may not be the zero vector` };
  }
  return { ok: true, value: raw as unknown as Vec2 };
}

/**
 * Resolves a template plus arguments into a concrete plan and its price.
 * Does not touch the world; the caller decides whether the wizard can pay.
 */
export function planCast(
  template: SpellTemplate,
  args: CastArgs,
  wizard: Wizard,
  world: World,
  rules: Rules,
): CastPlanResult {
  const mass = resolveNumber(template.body.mass, args, 'body.mass');
  if (!mass.ok) return { ok: false, result: 'bad_args', reason: mass.reason };
  if (mass.value < rules.physics.minBodyMassG) {
    return {
      ok: false,
      result: 'bad_args',
      reason: `body.mass: ${mass.value} g is below the ${rules.physics.minBodyMassG} g floor`,
    };
  }

  const speed = resolveNumber(template.launch.speed, args, 'launch.speed');
  if (!speed.ok) return { ok: false, result: 'bad_args', reason: speed.reason };

  const dir = resolveDirection(template.launch.direction, args);
  if (!dir.ok) return { ok: false, result: 'bad_args', reason: dir.reason };

  const [dirX, dirY] = dir.value;
  const bodyShape = template.body as unknown as ShapeSpec;
  const bodyCells = shapeCellsInDirection(bodyShape, dirX, dirY);
  const bodyRadius = shapeRadius(bodyShape);

  const ops: ResolvedOp[] = [];
  for (const op of template.onImpact?.ops ?? []) {
    if (op.op === 'transferKinetic') {
      ops.push({ op: op.op, value: 0 });
      continue;
    }
    const v = resolveNumber(op.value, args, `onImpact.${op.op}`);
    if (!v.ok) return { ok: false, result: 'bad_args', reason: v.reason };
    ops.push({ op: op.op, value: v.value });
  }

  // Pricing and the damage coverage term use the canonical cell count, not the
  // rasterised one, so a spell costs the same fired at any angle.
  const canonicalImpactCells = template.onImpact ? shapeCellCount(template.onImpact) : 1;
  const impactCells = template.onImpact
    ? shapeCellsInDirection(template.onImpact, dirX, dirY)
    : null;
  const impact: ResolvedImpact | null = impactCells
    ? { cells: impactCells, canonicalCellCount: canonicalImpactCells, ops }
    : null;

  const speedMilli = speed.value * 1000;
  const [ux, uy] = unitVectorMilli(dirX, dirY);
  const vxMilli = idivRound(ux * speedMilli, 1000);
  const vyMilli = idivRound(uy * speedMilli, 1000);

  const cost = costOfCast(
    {
      bodyMassG: mass.value,
      bodyMaterial: template.body.material,
      bodyCells: shapeCellCount(bodyShape),
      speedMilliCellsPerTurn: speedMilli,
      impactCells: canonicalImpactCells,
      impactOps: ops,
    },
    rules,
  );

  // An addTemperature op buys a packet of thermal energy, sized against the
  // nominal cell the op was priced on. That energy rides on the matter the
  // spell manifested, so an ice knife flies cold and a fireball flies hot, and
  // the impact delivers the same packet into whatever was struck. One purchase,
  // one packet, conserved end to end. See docs/DECISIONS.md, D4.
  let declaredMilliC = 0;
  for (const op of ops) if (op.op === 'addTemperature') declaredMilliC += op.value * 1000;
  const nominalMassG = nominalImpactMassG(canonicalImpactCells, rules);
  const boughtEnergyMilliJ = thermalEnergyMilliJ(
    nominalMassG,
    rules.costs.nominalCellSpecificHeatMilli,
    declaredMilliC,
  );
  const bodyDeltaMilliC = temperatureRiseMilliC(
    boughtEnergyMilliJ,
    heatCapacityOf(mass.value, MATERIALS[template.body.material].specificHeatMilli),
  );

  const manifest = wizard.manifestCell(bodyRadius);

  return {
    ok: true,
    plan: {
      template,
      bodyMassG: mass.value,
      bodyCells,
      dirX,
      dirY,
      speedMilli,
      vxMilli,
      vyMilli,
      bodyTemperatureMilliC: rules.arena.ambientMilliC + bodyDeltaMilliC,
      impact,
      cost,
      manifest,
      keMilliJoules: keMilliJ(mass.value, speedMilli),
      thermalEnergyMilliJ: boughtEnergyMilliJ,
    },
  };
}

/**
 * Passport §4: if the manifest area is blocked at flight altitude the cast
 * fails, mana is fully refunded, and the Cast slot is still consumed.
 */
export function manifestBlocked(world: World, plan: CastPlan, rules: Rules): boolean {
  const [mx, my] = plan.manifest;
  for (const [dx, dy] of plan.bodyCells) {
    const x = mx + dx;
    const y = my + dy;
    if (!world.inBounds(x, y)) return true;
    if (world.blocksFlight(x, y, rules.arena.flightAltitudeMm)) return true;
  }
  return false;
}
