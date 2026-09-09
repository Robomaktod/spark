import type { MaterialId } from './materials.js';

/** A numeric parameter the bot supplies at cast time, bounded at registration. */
export interface ParamRef {
  readonly param: string;
  readonly min: number;
  readonly max: number;
}

/** Either a constant fixed at registration, or a bounded cast-time parameter. */
export type NumberOrParam = number | ParamRef;

/** A direction supplied at cast time as an integer vector, or fixed in the template. */
export interface Vec2Param {
  readonly param: string;
  readonly type: 'vec2';
}

export type Vec2 = readonly [number, number];

export type DirectionSpec = Vec2Param | Vec2;

/**
 * Shapes are authored in a local frame where +X is the launch direction
 * (passport §7.2), so a line lies along the flight path and a cone opens
 * forward without the bot doing any trigonometry.
 */
export type ShapeSpec =
  | { readonly shape: 'cell' }
  | { readonly shape: 'line'; readonly length: number }
  | { readonly shape: 'disc'; readonly radius: number }
  | { readonly shape: 'cone'; readonly radius: number; readonly halfAngleDeg: number }
  | { readonly shape: 'rect'; readonly length: number; readonly width: number };

export type ShapeKind = ShapeSpec['shape'];

/** Matter to manifest. Material and shape are fixed at registration (passport §7.1). */
export type SpellBody = ShapeSpec & {
  readonly material: MaterialId;
  /** Total mass of the body in grams, spread evenly over its cells. */
  readonly mass: NumberOrParam;
};

export interface SpellLaunch {
  readonly direction: DirectionSpec;
  /** Speed in cells per turn. */
  readonly speed: NumberOrParam;
}

export type ImpactOp =
  | { readonly op: 'transferKinetic' }
  | { readonly op: 'addTemperature'; readonly value: NumberOrParam }
  | { readonly op: 'setBinding'; readonly value: NumberOrParam };

export type ImpactOpKind = ImpactOp['op'];

export type SpellImpact = ShapeSpec & {
  readonly ops: readonly ImpactOp[];
};

/** A registered spell template. Contains no logic and no world queries (passport §7.5). */
export interface SpellTemplate {
  readonly id: string;
  readonly body: SpellBody;
  readonly launch: SpellLaunch;
  readonly onImpact?: SpellImpact;
}

export function isParamRef(v: NumberOrParam): v is ParamRef {
  return typeof v === 'object' && v !== null && 'param' in v;
}

export function isVec2Param(v: DirectionSpec): v is Vec2Param {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
