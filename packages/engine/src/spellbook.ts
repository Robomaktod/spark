/**
 * Spellbook registration and page budgeting (passport §7.6).
 *
 *   pages = opCount + sum(shapeCells / divisor) + sum(paramRangeWidth / granularity)
 *
 * The range term is the interesting one: a spell allowed 0-8000 g of mass is
 * more useful than one fixed at 2000 g and costs more book space for it. Six
 * narrow spells or two flexible ones.
 */
import type { ImpactOp, NumberOrParam, Rules, ShapeSpec, SpellTemplate } from '@spark/protocol';
import { isParamRef, isVec2Param, validateSpellTemplate } from '@spark/protocol';
import { shapeCellCount } from './shapes.js';

export interface SpellPages {
  readonly spellId: string;
  readonly pages: number;
  readonly detail: {
    readonly ops: number;
    readonly shapeMilli: number;
    readonly rangeMilli: number;
  };
}

type ParamKind = 'massG' | 'speedCellsPerTurn' | 'temperatureC' | 'binding';

function rangeMilliPages(v: NumberOrParam, kind: ParamKind, rules: Rules): number {
  if (!isParamRef(v)) return 0;
  const width = Math.abs(v.max - v.min);
  const granularity = rules.spellbook.granularity[kind];
  return Math.floor((width * 1000) / granularity);
}

function opParamKind(op: ImpactOp): ParamKind {
  return op.op === 'setBinding' ? 'binding' : 'temperatureC';
}

/** Page cost of a single template, rounded up to a whole page. */
export function pagesForSpell(template: SpellTemplate, rules: Rules): SpellPages {
  const impactOps = template.onImpact?.ops ?? [];
  // One op for the implicit manifest, one for the implicit impulse, plus impact ops.
  const ops = 2 + impactOps.length;

  const bodyCells = shapeCellCount(template.body as unknown as ShapeSpec);
  const impactCells = template.onImpact ? shapeCellCount(template.onImpact) : 0;
  const shapeMilli = Math.floor(
    ((bodyCells + impactCells) * 1000) / rules.spellbook.shapeCellsDivisor,
  );

  let rangeMilli = 0;
  rangeMilli += rangeMilliPages(template.body.mass, 'massG', rules);
  rangeMilli += rangeMilliPages(template.launch.speed, 'speedCellsPerTurn', rules);
  for (const op of impactOps) {
    if (op.op === 'transferKinetic') continue;
    rangeMilli += rangeMilliPages(op.value, opParamKind(op), rules);
  }
  if (isVec2Param(template.launch.direction)) {
    rangeMilli += rules.spellbook.directionParamPages * 1000;
  }

  const pages = Math.ceil(ops + (shapeMilli + rangeMilli) / 1000);
  return { spellId: template.id, pages, detail: { ops, shapeMilli, rangeMilli } };
}

export interface SpellbookCheck {
  readonly ok: boolean;
  readonly pagesUsed: number;
  readonly pages: readonly SpellPages[];
  readonly errors: readonly string[];
}

/**
 * Structural validation plus the semantic limits that need the rules: page
 * budget, shape size, op count, and the minimum body mass that closes the
 * zero-mass exploit in passport §20.
 */
export function checkSpellbook(spells: readonly unknown[], rules: Rules): SpellbookCheck {
  const errors: string[] = [];
  const pages: SpellPages[] = [];
  let pagesUsed = 0;

  if (spells.length > rules.spellbook.maxSpells) {
    errors.push(
      `spellbook: ${spells.length} spells exceeds the limit of ${rules.spellbook.maxSpells}`,
    );
  }

  const seen = new Set<string>();
  spells.forEach((raw, i) => {
    const structural = validateSpellTemplate(raw, `spells[${i}]`);
    if (!structural.ok || !structural.value) {
      errors.push(...structural.errors);
      return;
    }
    const t = structural.value;
    if (seen.has(t.id)) errors.push(`spells[${i}].id: duplicate id "${t.id}"`);
    seen.add(t.id);

    const bodyCells = shapeCellCount(t.body as unknown as ShapeSpec);
    const impactCells = t.onImpact ? shapeCellCount(t.onImpact) : 0;
    if (bodyCells > rules.spellbook.maxShapeCells) {
      errors.push(
        `spells[${i}] "${t.id}": body covers ${bodyCells} cells, limit ${rules.spellbook.maxShapeCells}`,
      );
    }
    if (impactCells > rules.spellbook.maxShapeCells) {
      errors.push(
        `spells[${i}] "${t.id}": impact covers ${impactCells} cells, limit ${rules.spellbook.maxShapeCells}`,
      );
    }
    if ((t.onImpact?.ops.length ?? 0) > rules.spellbook.maxOpsPerSpell) {
      errors.push(`spells[${i}] "${t.id}": more than ${rules.spellbook.maxOpsPerSpell} impact ops`);
    }

    const massMin = isParamRef(t.body.mass) ? t.body.mass.min : t.body.mass;
    if (massMin < rules.physics.minBodyMassG) {
      errors.push(
        `spells[${i}] "${t.id}": body mass may not go below ${rules.physics.minBodyMassG} g ` +
          `(the mass floor that keeps cheap high-velocity bodies honest)`,
      );
    }
    const speedMin = isParamRef(t.launch.speed) ? t.launch.speed.min : t.launch.speed;
    if (speedMin < 0) errors.push(`spells[${i}] "${t.id}": speed may not be negative`);

    const p = pagesForSpell(t, rules);
    pages.push(p);
    pagesUsed += p.pages;
  });

  if (pagesUsed > rules.spellbook.maxPages) {
    errors.push(`spellbook: ${pagesUsed} pages exceeds the budget of ${rules.spellbook.maxPages}`);
  }

  return { ok: errors.length === 0, pagesUsed, pages, errors };
}

/** A locked, validated spellbook. Cannot change once the match starts (passport §7.1). */
export class Spellbook {
  private readonly byId: Map<string, SpellTemplate>;
  readonly pagesUsed: number;
  readonly pages: readonly SpellPages[];

  constructor(spells: readonly SpellTemplate[], rules: Rules) {
    const check = checkSpellbook(spells, rules);
    if (!check.ok) throw new Error(`invalid spellbook: ${check.errors.join('; ')}`);
    this.byId = new Map(spells.map((s) => [s.id, s]));
    this.pagesUsed = check.pagesUsed;
    this.pages = check.pages;
  }

  get(id: string): SpellTemplate | undefined {
    return this.byId.get(id);
  }

  get ids(): string[] {
    return [...this.byId.keys()];
  }

  get all(): SpellTemplate[] {
    return [...this.byId.values()];
  }
}
