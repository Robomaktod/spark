/**
 * Structural validation of everything a bot sends. Semantic checks that need
 * the rules or the world (page budget, mana, legality of a path) live in the
 * engine; this module only proves a payload has the shape the types claim.
 *
 * Nothing here throws: a malformed packet costs a bot the turn, never the match
 * (passport §14.4).
 */
import type {
  ActionsMessage,
  CastArgs,
  ChannelCommand,
  MoveAction,
  ReactAction,
  SpellbookMessage,
  TriggerSpec,
} from './messages.js';
import { PLACEHOLDERS } from './messages.js';
import { isMaterialId } from './materials.js';
import type {
  ImpactOp,
  NumberOrParam,
  SpellBody,
  SpellLaunch,
  SpellTemplate,
  Vec2,
} from './spell.js';

export interface ValidationResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly errors: readonly string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** Coordinates and directions are bounded well below the safe-integer range. */
const VEC_LIMIT = 1_000_000_000;

function checkVec2(v: unknown, where: string, errors: string[]): v is Vec2 {
  if (!Array.isArray(v) || v.length !== 2 || !isInt(v[0]) || !isInt(v[1])) {
    errors.push(`${where}: expected a pair of integers`);
    return false;
  }
  if (Math.abs(v[0] as number) > VEC_LIMIT || Math.abs(v[1] as number) > VEC_LIMIT) {
    errors.push(`${where}: components must be within +/-${VEC_LIMIT}`);
    return false;
  }
  return true;
}

function checkNumberOrParam(v: unknown, where: string, errors: string[]): v is NumberOrParam {
  if (isInt(v)) return true;
  if (isObj(v)) {
    if (typeof v['param'] !== 'string' || v['param'].length === 0) {
      errors.push(`${where}: param must be a non-empty string`);
      return false;
    }
    if (!isInt(v['min']) || !isInt(v['max'])) {
      errors.push(`${where}: param range min/max must be integers`);
      return false;
    }
    if ((v['min'] as number) > (v['max'] as number)) {
      errors.push(`${where}: param range min exceeds max`);
      return false;
    }
    return true;
  }
  errors.push(`${where}: expected an integer or a {param,min,max} range`);
  return false;
}

function checkShape(v: Record<string, unknown>, where: string, errors: string[]): boolean {
  const kind = v['shape'];
  const positive = (field: string): boolean => {
    const n = v[field];
    if (!isInt(n) || (n as number) < 1) {
      errors.push(`${where}.${field}: expected a positive integer`);
      return false;
    }
    return true;
  };
  switch (kind) {
    case 'cell':
      return true;
    case 'line':
      return positive('length');
    case 'disc':
      return positive('radius');
    case 'cone': {
      let ok = positive('radius');
      const a = v['halfAngleDeg'];
      if (!isInt(a) || (a as number) < 1 || (a as number) > 90) {
        errors.push(`${where}.halfAngleDeg: expected an integer in 1..90`);
        ok = false;
      }
      return ok;
    }
    case 'rect':
      return positive('length') && positive('width');
    default:
      errors.push(`${where}.shape: unknown shape ${JSON.stringify(kind)}`);
      return false;
  }
}

function checkBody(v: unknown, where: string, errors: string[]): v is SpellBody {
  if (!isObj(v)) {
    errors.push(`${where}: expected an object`);
    return false;
  }
  let ok = checkShape(v, where, errors);
  if (!isMaterialId(v['material'])) {
    errors.push(`${where}.material: unknown material ${JSON.stringify(v['material'])}`);
    ok = false;
  }
  if (!checkNumberOrParam(v['mass'], `${where}.mass`, errors)) ok = false;
  return ok;
}

function checkLaunch(v: unknown, where: string, errors: string[]): v is SpellLaunch {
  if (!isObj(v)) {
    errors.push(`${where}: expected an object`);
    return false;
  }
  let ok = true;
  const dir = v['direction'];
  if (Array.isArray(dir)) {
    if (!checkVec2(dir, `${where}.direction`, errors)) ok = false;
    else if (dir[0] === 0 && dir[1] === 0) {
      errors.push(`${where}.direction: fixed direction may not be the zero vector`);
      ok = false;
    }
  } else if (isObj(dir)) {
    if (typeof dir['param'] !== 'string' || dir['type'] !== 'vec2') {
      errors.push(`${where}.direction: expected {param, type:"vec2"}`);
      ok = false;
    }
  } else {
    errors.push(`${where}.direction: expected a vector or a vec2 param`);
    ok = false;
  }
  if (!checkNumberOrParam(v['speed'], `${where}.speed`, errors)) ok = false;
  return ok;
}

function checkOp(v: unknown, where: string, errors: string[]): v is ImpactOp {
  if (!isObj(v)) {
    errors.push(`${where}: expected an object`);
    return false;
  }
  switch (v['op']) {
    case 'transferKinetic':
      return true;
    case 'addTemperature':
    case 'setBinding':
      return checkNumberOrParam(v['value'], `${where}.value`, errors);
    default:
      errors.push(`${where}.op: unknown operation ${JSON.stringify(v['op'])}`);
      return false;
  }
}

export function validateSpellTemplate(v: unknown, where: string): ValidationResult<SpellTemplate> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: [`${where}: expected an object`] };
  if (typeof v['id'] !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(v['id'])) {
    errors.push(`${where}.id: expected 1..48 chars of [A-Za-z0-9_-]`);
  }
  checkBody(v['body'], `${where}.body`, errors);
  checkLaunch(v['launch'], `${where}.launch`, errors);
  const impact = v['onImpact'];
  if (impact !== undefined) {
    if (!isObj(impact)) {
      errors.push(`${where}.onImpact: expected an object`);
    } else {
      checkShape(impact, `${where}.onImpact`, errors);
      const ops = impact['ops'];
      if (!Array.isArray(ops)) {
        errors.push(`${where}.onImpact.ops: expected an array`);
      } else {
        ops.forEach((op, i) => checkOp(op, `${where}.onImpact.ops[${i}]`, errors));
      }
    }
  }
  return errors.length === 0
    ? { ok: true, value: v as unknown as SpellTemplate, errors: [] }
    : { ok: false, errors };
}

export function validateSpellbook(v: unknown): ValidationResult<SpellbookMessage> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ['spellbook: expected an object'] };
  if (v['type'] !== 'spellbook') errors.push('spellbook.type: expected "spellbook"');
  const spells = v['spells'];
  if (!Array.isArray(spells)) {
    errors.push('spellbook.spells: expected an array');
    return { ok: false, errors };
  }
  const seen = new Set<string>();
  spells.forEach((s, i) => {
    const r = validateSpellTemplate(s, `spells[${i}]`);
    errors.push(...r.errors);
    if (r.ok && r.value) {
      if (seen.has(r.value.id)) errors.push(`spells[${i}].id: duplicate id ${r.value.id}`);
      seen.add(r.value.id);
    }
  });
  return errors.length === 0
    ? { ok: true, value: v as unknown as SpellbookMessage, errors: [] }
    : { ok: false, errors };
}

function checkArgs(
  v: unknown,
  where: string,
  errors: string[],
  allowPlaceholders: boolean,
): boolean {
  if (v === undefined) return true;
  if (!isObj(v)) {
    errors.push(`${where}: expected an object`);
    return false;
  }
  let ok = true;
  for (const [k, val] of Object.entries(v)) {
    if (isInt(val)) continue;
    if (Array.isArray(val)) {
      if (!checkVec2(val, `${where}.${k}`, errors)) ok = false;
      continue;
    }
    if (typeof val === 'string') {
      if (allowPlaceholders && (PLACEHOLDERS as readonly string[]).includes(val)) continue;
      errors.push(`${where}.${k}: ${JSON.stringify(val)} is not a legal placeholder here`);
      ok = false;
      continue;
    }
    errors.push(`${where}.${k}: expected an integer, an integer pair, or a placeholder`);
    ok = false;
  }
  return ok;
}

function checkMove(v: unknown, where: string, errors: string[]): v is MoveAction {
  if (!isObj(v)) {
    errors.push(`${where}: expected an object`);
    return false;
  }
  let ok = true;
  const path = v['path'];
  if (path !== undefined) {
    if (!Array.isArray(path)) {
      errors.push(`${where}.path: expected an array of unit steps`);
      ok = false;
    } else {
      path.forEach((step, i) => {
        if (!checkVec2(step, `${where}.path[${i}]`, errors)) {
          ok = false;
          return;
        }
        const [dx, dy] = step as Vec2;
        if (dx < -1 || dx > 1 || dy < -1 || dy > 1 || (dx === 0 && dy === 0)) {
          errors.push(`${where}.path[${i}]: expected a non-zero unit step`);
          ok = false;
        }
      });
    }
  }
  const turnTo = v['turnTo'];
  if (turnTo !== undefined && (!isInt(turnTo) || turnTo < 0 || turnTo > 7)) {
    errors.push(`${where}.turnTo: expected an integer facing in 0..7`);
    ok = false;
  }
  return ok;
}

function checkTrigger(v: unknown, where: string, errors: string[]): v is TriggerSpec {
  if (!isObj(v)) {
    errors.push(`${where}: expected an object`);
    return false;
  }
  const nonNegative = (field: string): boolean => {
    const n = v[field];
    if (!isInt(n) || (n as number) < 0) {
      errors.push(`${where}.${field}: expected a non-negative integer`);
      return false;
    }
    return true;
  };
  switch (v['kind']) {
    case 'opponentCast':
      return true;
    case 'objectEnteredRadius':
    case 'opponentWithinRadius':
      return nonNegative('r');
    case 'selfHpBelow':
      return nonNegative('x');
    case 'cellPropertyCrossed': {
      let ok = checkVec2(v['pos'], `${where}.pos`, errors);
      if (!['temperature', 'binding', 'height', 'mass'].includes(v['prop'] as string)) {
        errors.push(`${where}.prop: expected temperature|binding|height|mass`);
        ok = false;
      }
      if (!isInt(v['threshold'])) {
        errors.push(`${where}.threshold: expected an integer`);
        ok = false;
      }
      if (v['dir'] !== 'above' && v['dir'] !== 'below') {
        errors.push(`${where}.dir: expected "above" or "below"`);
        ok = false;
      }
      return ok;
    }
    default:
      errors.push(`${where}.kind: unknown trigger ${JSON.stringify(v['kind'])}`);
      return false;
  }
}

function checkReact(v: unknown, where: string, errors: string[]): v is ReactAction {
  if (!isObj(v)) {
    errors.push(`${where}: expected an object`);
    return false;
  }
  let ok = checkTrigger(v['trigger'], `${where}.trigger`, errors);
  if (typeof v['spellId'] !== 'string') {
    errors.push(`${where}.spellId: expected a string`);
    ok = false;
  }
  if (!checkArgs(v['args'] as CastArgs | undefined, `${where}.args`, errors, true)) ok = false;
  return ok;
}

function checkChannel(v: unknown, where: string, errors: string[]): v is ChannelCommand {
  if (!isObj(v)) {
    errors.push(`${where}: expected an object`);
    return false;
  }
  if (!isInt(v['objectId'])) {
    errors.push(`${where}.objectId: expected an integer`);
    return false;
  }
  switch (v['kind']) {
    case 'release':
      return true;
    case 'addTemperature':
      if (!isInt(v['value'])) {
        errors.push(`${where}.value: expected an integer`);
        return false;
      }
      return true;
    case 'impulse': {
      let ok = checkVec2(v['dir'], `${where}.dir`, errors);
      if (!isInt(v['speed']) || (v['speed'] as number) < 0) {
        errors.push(`${where}.speed: expected a non-negative integer`);
        ok = false;
      }
      return ok;
    }
    default:
      errors.push(`${where}.kind: unknown channel command ${JSON.stringify(v['kind'])}`);
      return false;
  }
}

export function validateActions(v: unknown): ValidationResult<ActionsMessage> {
  const errors: string[] = [];
  if (!isObj(v)) return { ok: false, errors: ['actions: expected an object'] };
  if (v['type'] !== 'actions') errors.push('actions.type: expected "actions"');

  if (v['move1'] !== undefined) checkMove(v['move1'], 'actions.move1', errors);
  if (v['move2'] !== undefined) checkMove(v['move2'], 'actions.move2', errors);
  if (v['react'] !== undefined) checkReact(v['react'], 'actions.react', errors);
  if (v['channel'] !== undefined) checkChannel(v['channel'], 'actions.channel', errors);

  if (v['cast'] !== undefined) {
    const cast = v['cast'];
    if (!isObj(cast)) {
      errors.push('actions.cast: expected an object');
    } else {
      if (typeof cast['spellId'] !== 'string')
        errors.push('actions.cast.spellId: expected a string');
      checkArgs(cast['args'] as CastArgs | undefined, 'actions.cast.args', errors, false);
      if (cast['concentrate'] !== undefined && typeof cast['concentrate'] !== 'boolean') {
        errors.push('actions.cast.concentrate: expected a boolean');
      }
    }
  }

  if (v['cast'] !== undefined && v['channel'] !== undefined) {
    errors.push('actions: cast and channel both use the Cast slot; supply at most one');
  }

  const prio = v['concentrationPriority'];
  if (prio !== undefined) {
    if (!Array.isArray(prio) || !prio.every(isInt)) {
      errors.push('actions.concentrationPriority: expected an array of integers');
    }
  }

  return errors.length === 0
    ? { ok: true, value: v as unknown as ActionsMessage, errors: [] }
    : { ok: false, errors };
}
