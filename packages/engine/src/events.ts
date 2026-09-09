/**
 * The structured event log.
 *
 * Passport §19 names Satisfaction as the weakest link in v1: an ASCII replay
 * alone under-serves the players this game is for. The event log is the
 * mitigation, so it is not optional and it is not a debug afterthought — it is
 * the record a player reads to find out why they lost.
 */
import type { Side } from '@spark/protocol';

export type Vec = readonly [number, number];

export type EngineEvent =
  | { readonly t: 'round_start'; readonly round: number; readonly game: number; readonly firstMover: Side }
  | { readonly t: 'turn_start'; readonly side: Side; readonly turn: number }
  | { readonly t: 'move'; readonly side: Side; readonly from: Vec; readonly to: Vec; readonly facing: number; readonly mp: number; readonly note?: string }
  | { readonly t: 'cast'; readonly side: Side; readonly spellId: string; readonly costMilli: number; readonly at: Vec; readonly dir: Vec; readonly speed: number; readonly massG: number; readonly concentrate: boolean }
  | { readonly t: 'cast_failed'; readonly side: Side; readonly spellId: string; readonly reason: string }
  | { readonly t: 'channel'; readonly side: Side; readonly objectId: number; readonly kind: string; readonly costMilli: number }
  | { readonly t: 'impact_wizard'; readonly objectId: number; readonly target: Side; readonly damageMilli: number; readonly overlap: number; readonly impactCells: number; readonly at: Vec }
  | { readonly t: 'impact_cell'; readonly objectId: number; readonly at: Vec; readonly penetrated: boolean; readonly keMilliJ: number }
  | { readonly t: 'objects_collided'; readonly a: number; readonly b: number; readonly at: Vec; readonly keMilliJ: number }
  | { readonly t: 'settled'; readonly objectId: number; readonly at: Vec }
  | { readonly t: 'burn'; readonly side: Side; readonly damageMilli: number; readonly hottestMilliC: number }
  | { readonly t: 'push'; readonly side: Side; readonly cells: number; readonly hitWall: boolean; readonly damageMilli: number }
  | { readonly t: 'react_declared'; readonly side: Side; readonly trigger: string; readonly spellId: string; readonly reservedMilli: number }
  | { readonly t: 'react_fired'; readonly side: Side; readonly trigger: string; readonly spellId: string; readonly costMilli: number }
  | { readonly t: 'react_refund'; readonly side: Side; readonly refundMilli: number; readonly fired: boolean }
  | { readonly t: 'concentration_start'; readonly side: Side; readonly objectId: number }
  | { readonly t: 'concentration_upkeep'; readonly side: Side; readonly objectId: number; readonly upkeepMilli: number }
  | { readonly t: 'concentration_released'; readonly side: Side; readonly objectId: number; readonly reason: string }
  | { readonly t: 'phase_change'; readonly at: Vec; readonly from: string; readonly to: string }
  | { readonly t: 'regen'; readonly side: Side; readonly amountMilli: number }
  | { readonly t: 'death'; readonly side: Side }
  | { readonly t: 'rejected'; readonly side: Side; readonly detail: string }
  | { readonly t: 'timeout'; readonly side: Side }
  | { readonly t: 'round_end'; readonly round: number; readonly winner: Side | null; readonly reason: string };

const hp = (milli: number): string => (milli / 1000).toFixed(1);
const mana = (milli: number): string => (milli / 1000).toFixed(1);
const pos = (p: Vec): string => `[${p[0]},${p[1]}]`;

/** One line of plain English per event. This is what the replay viewer prints. */
export function describeEvent(e: EngineEvent): string {
  switch (e.t) {
    case 'round_start':
      return `-- round ${e.round} (game ${e.game}) begins, ${e.firstMover} moves first`;
    case 'turn_start':
      return `${e.side} turn ${e.turn}`;
    case 'move':
      return `${e.side} moved ${pos(e.from)} -> ${pos(e.to)} facing ${e.facing} (${e.mp} MP)${e.note ? ` [${e.note}]` : ''}`;
    case 'cast':
      return `${e.side} cast ${e.spellId} at ${pos(e.at)} dir ${pos(e.dir)} speed ${e.speed} mass ${e.massG}g for ${mana(e.costMilli)} mana${e.concentrate ? ' (concentrating)' : ''}`;
    case 'cast_failed':
      return `${e.side} failed to cast ${e.spellId}: ${e.reason}`;
    case 'channel':
      return `${e.side} channelled ${e.kind} to object ${e.objectId} for ${mana(e.costMilli)} mana`;
    case 'impact_wizard':
      return `object ${e.objectId} hit ${e.target} at ${pos(e.at)} for ${hp(e.damageMilli)} HP (${e.overlap}/${e.impactCells} cells covered)`;
    case 'impact_cell':
      return `object ${e.objectId} ${e.penetrated ? 'smashed through' : 'struck'} ${pos(e.at)} (${(e.keMilliJ / 1000).toFixed(1)} J)`;
    case 'objects_collided':
      return `objects ${e.a} and ${e.b} destroyed each other at ${pos(e.at)}`;
    case 'settled':
      return `object ${e.objectId} settled at ${pos(e.at)}`;
    case 'burn':
      return `${e.side} burned for ${hp(e.damageMilli)} HP standing in ${(e.hottestMilliC / 1000).toFixed(0)} C`;
    case 'push':
      return `${e.side} pushed ${e.cells} cells${e.hitWall ? `, hit a wall for ${hp(e.damageMilli)} HP` : ''}`;
    case 'react_declared':
      return `${e.side} armed ${e.spellId} on ${e.trigger}, reserving ${mana(e.reservedMilli)} mana`;
    case 'react_fired':
      return `${e.side} reaction ${e.spellId} fired on ${e.trigger} for ${mana(e.costMilli)} mana`;
    case 'react_refund':
      return e.fired
        ? `${e.side} reaction cost less than reserved, ${mana(e.refundMilli)} mana returned`
        : `${e.side} reaction did not fire, ${mana(e.refundMilli)} mana refunded`;
    case 'concentration_start':
      return `${e.side} opened a concentration link to object ${e.objectId}`;
    case 'concentration_upkeep':
      return `${e.side} paid ${mana(e.upkeepMilli)} upkeep on object ${e.objectId}`;
    case 'concentration_released':
      return `${e.side} released object ${e.objectId} (${e.reason})`;
    case 'phase_change':
      return `${pos(e.at)} ${e.from} -> ${e.to}`;
    case 'regen':
      return `${e.side} regenerated ${mana(e.amountMilli)} mana`;
    case 'death':
      return `${e.side} died`;
    case 'rejected':
      return `${e.side} action rejected: ${e.detail}`;
    case 'timeout':
      return `${e.side} timed out and forfeited the turn`;
    case 'round_end':
      return `-- round ${e.round} ended: ${e.winner ? `${e.winner} wins` : 'tie'} (${e.reason})`;
  }
}

/** Events a bot is shown. Anything the opponent could not observe is filtered out. */
export function isPublicEvent(e: EngineEvent): boolean {
  return e.t !== 'react_declared' && e.t !== 'react_refund';
}
