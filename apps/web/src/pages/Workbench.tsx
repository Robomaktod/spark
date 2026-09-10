/**
 * The spell workbench (web plan §7).
 *
 * Because the engine and the cost model are already in the page, this is a form
 * plus a sandbox arena. Its gate is the passport's new-player test: someone
 * should be able to build a working attack spell here without reading §9. If
 * the cost breakdown is not legible enough for that, the breakdown is wrong.
 */
import { useMemo, useState } from 'react';
import {
  DEFAULT_RULES,
  MATERIAL_IDS,
  type MaterialId,
  type ShapeSpec,
  type SpellTemplate,
} from '@spark/protocol';
import {
  Round,
  Spellbook,
  World,
  checkSpellbook,
  costOfCast,
  describeEvent,
  impactDamageMilliHp,
  keMilliJ,
  pagesForSpell,
  shapeCellCount,
} from '@spark/engine';
import { reachOfSpeed } from '../arena/manaField.js';

const RULES = DEFAULT_RULES;
const SHAPES = ['cell', 'line', 'disc', 'cone', 'rect'] as const;

interface Draft {
  id: string;
  bodyShape: (typeof SHAPES)[number];
  bodyLength: number;
  bodyRadius: number;
  bodyWidth: number;
  bodyAngle: number;
  material: MaterialId;
  massMin: number;
  massMax: number;
  speedMin: number;
  speedMax: number;
  impactShape: (typeof SHAPES)[number];
  impactRadius: number;
  impactLength: number;
  impactWidth: number;
  impactAngle: number;
  transferKinetic: boolean;
  tempMin: number;
  tempMax: number;
  bindMin: number;
  bindMax: number;
  useTemp: boolean;
  useBind: boolean;
  /** What the sandbox actually fires. */
  testMass: number;
  testSpeed: number;
  testTemp: number;
  testBind: number;
}

const INITIAL: Draft = {
  id: 'ice_knife',
  bodyShape: 'line',
  bodyLength: 8,
  bodyRadius: 3,
  bodyWidth: 2,
  bodyAngle: 30,
  material: 'ice',
  massMin: 500,
  massMax: 8000,
  speedMin: 0,
  speedMax: 60,
  impactShape: 'disc',
  impactRadius: 2,
  impactLength: 3,
  impactWidth: 3,
  impactAngle: 30,
  transferKinetic: true,
  tempMin: -8000,
  tempMax: 0,
  bindMin: -80,
  bindMax: 0,
  useTemp: true,
  useBind: false,
  testMass: 7200,
  testSpeed: 40,
  testTemp: -5538,
  testBind: 0,
};

function shapeOf(
  kind: (typeof SHAPES)[number],
  d: { length: number; radius: number; width: number; angle: number },
): ShapeSpec {
  switch (kind) {
    case 'cell':
      return { shape: 'cell' };
    case 'line':
      return { shape: 'line', length: Math.max(1, d.length) };
    case 'disc':
      return { shape: 'disc', radius: Math.max(1, d.radius) };
    case 'cone':
      return {
        shape: 'cone',
        radius: Math.max(1, d.radius),
        halfAngleDeg: Math.max(1, Math.min(90, d.angle)),
      };
    case 'rect':
      return { shape: 'rect', length: Math.max(1, d.length), width: Math.max(1, d.width) };
  }
}

function templateOf(d: Draft): SpellTemplate {
  const body = shapeOf(d.bodyShape, {
    length: d.bodyLength,
    radius: d.bodyRadius,
    width: d.bodyWidth,
    angle: d.bodyAngle,
  });
  const impact = shapeOf(d.impactShape, {
    length: d.impactLength,
    radius: d.impactRadius,
    width: d.impactWidth,
    angle: d.impactAngle,
  });
  const ops: SpellTemplate['onImpact'] extends infer T
    ? T extends { ops: infer O }
      ? O
      : never
    : never = [] as never;
  const opList: { op: string; value?: unknown }[] = [];
  if (d.transferKinetic) opList.push({ op: 'transferKinetic' });
  if (d.useTemp)
    opList.push({ op: 'addTemperature', value: { param: 'heat', min: d.tempMin, max: d.tempMax } });
  if (d.useBind)
    opList.push({ op: 'setBinding', value: { param: 'bind', min: d.bindMin, max: d.bindMax } });
  void ops;

  return {
    id: d.id || 'spell',
    body: { ...body, material: d.material, mass: { param: 'm', min: d.massMin, max: d.massMax } },
    launch: {
      direction: { param: 'dir', type: 'vec2' },
      speed: { param: 'v', min: d.speedMin, max: d.speedMax },
    },
    onImpact: {
      ...impact,
      ops: opList as SpellTemplate['onImpact'] extends { ops: infer O } ? O : never,
    },
  } as SpellTemplate;
}

const mana = (milli: number): string => (milli / 1000).toFixed(2);

interface SandboxResult {
  ok: boolean;
  reason?: string;
  turns: number;
  distance: number;
  hit: boolean;
  damageMilli: number;
  overlap: number;
  impactCells: number;
  keMilliJ: number;
  log: string[];
}

/**
 * Fires the spell at a dummy target on empty ground and reports what happened —
 * where drag stopped it, what it covered, what it took off.
 */
function runSandbox(template: SpellTemplate, d: Draft, targetDistance: number): SandboxResult {
  const log: string[] = [];
  const check = checkSpellbook([template], RULES);
  if (!check.ok)
    return {
      ok: false,
      reason: check.errors[0],
      turns: 0,
      distance: 0,
      hit: false,
      damageMilli: 0,
      overlap: 0,
      impactCells: 0,
      keMilliJ: 0,
      log,
    };

  const world = new World(RULES);
  const casterX = 20;
  const y = 100;
  const round = new Round({
    rules: RULES,
    world,
    spawns: [
      [casterX, y],
      [Math.min(RULES.arena.width - 6, casterX + targetDistance), y],
    ],
    spellbooks: { A: new Spellbook([template], RULES), B: new Spellbook([template], RULES) },
    firstMover: 'A',
    round: 1,
    game: 1,
  });

  const args: Record<string, number | [number, number]> = {
    m: d.testMass,
    v: d.testSpeed,
    dir: [1, 0],
  };
  if (d.useTemp) args['heat'] = d.testTemp;
  if (d.useBind) args['bind'] = d.testBind;

  const collect = (): void => {
    for (const e of round.lastEvents) {
      log.push(describeEvent(e));
      if (e.t === 'cast' && manifestX === null) manifestX = e.at[0];
      if (e.t === 'impact_wizard') {
        hit = true;
        damageMilli += e.damageMilli;
        overlap = e.overlap;
        impactCells = e.impactCells;
        energy = e.keMilliJ;
        landedX = e.at[0];
      }
      if (e.t === 'impact_cell' || e.t === 'settled') landedX = e.at[0];
    }
  };

  let manifestX: number | null = null;
  let landedX: number | null = null;
  let turns = 0;
  let hit = false;
  let damageMilli = 0;
  let overlap = 0;
  let impactCells = 0;
  let energy = 0;

  round.submit({ type: 'actions', cast: { spellId: template.id, args } });
  collect();

  // Step until the shot resolves: it hits, it settles, or it runs out of road.
  for (let i = 0; i < 40 && !round.finished; i++) {
    const live = round.objects.find((o) => !o.destroyed && o.owner === 'A');
    if (!live) break;
    landedX = live.cellX;
    round.submit({ type: 'actions' });
    turns++;
    collect();
  }

  return {
    ok: true,
    turns,
    distance: manifestX !== null && landedX !== null ? Math.max(0, landedX - manifestX) : 0,
    hit,
    damageMilli,
    overlap,
    impactCells,
    keMilliJ: energy,
    log: log.slice(0, 24),
  };
}

function Num({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}): React.JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function Workbench(): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(INITIAL);
  const [targetDistance, setTargetDistance] = useState(30);
  const [pinned, setPinned] = useState<Draft | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }));

  const analysis = useMemo(() => analyse(draft, targetDistance), [draft, targetDistance]);
  const pinnedAnalysis = useMemo(
    () => (pinned ? analyse(pinned, targetDistance) : null),
    [pinned, targetDistance],
  );

  return (
    <div className="page">
      <h1>Spell workbench</h1>
      <p className="dim" style={{ marginTop: 0 }}>
        Everything below is computed by the same engine that runs matches. Cost is the engine's own
        arithmetic, not a copy of it.
      </p>

      <div className="workbench" style={{ marginTop: 18 }}>
        <div className="card">
          <h3>Identity</h3>
          <label className="field">
            <span>id</span>
            <input value={draft.id} onChange={(e) => set('id', e.target.value)} />
          </label>
          <label className="field">
            <span>material (fixed at registration)</span>
            <select
              value={draft.material}
              onChange={(e) => set('material', e.target.value as MaterialId)}
            >
              {MATERIAL_IDS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <h3 style={{ marginTop: 14 }}>Body</h3>
          <label className="field">
            <span>shape</span>
            <select
              value={draft.bodyShape}
              onChange={(e) => set('bodyShape', e.target.value as Draft['bodyShape'])}
            >
              {SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <div className="row2">
            {(draft.bodyShape === 'line' || draft.bodyShape === 'rect') && (
              <Num label="length" value={draft.bodyLength} onChange={(v) => set('bodyLength', v)} />
            )}
            {draft.bodyShape === 'rect' && (
              <Num label="width" value={draft.bodyWidth} onChange={(v) => set('bodyWidth', v)} />
            )}
            {(draft.bodyShape === 'disc' || draft.bodyShape === 'cone') && (
              <Num label="radius" value={draft.bodyRadius} onChange={(v) => set('bodyRadius', v)} />
            )}
            {draft.bodyShape === 'cone' && (
              <Num
                label="half angle"
                value={draft.bodyAngle}
                onChange={(v) => set('bodyAngle', v)}
              />
            )}
          </div>
          <div className="row2">
            <Num
              label="mass min (g)"
              value={draft.massMin}
              onChange={(v) => set('massMin', v)}
              step={100}
            />
            <Num
              label="mass max (g)"
              value={draft.massMax}
              onChange={(v) => set('massMax', v)}
              step={100}
            />
          </div>
          <div className="row2">
            <Num label="speed min" value={draft.speedMin} onChange={(v) => set('speedMin', v)} />
            <Num label="speed max" value={draft.speedMax} onChange={(v) => set('speedMax', v)} />
          </div>

          <h3 style={{ marginTop: 14 }}>Impact</h3>
          <label className="field">
            <span>shape</span>
            <select
              value={draft.impactShape}
              onChange={(e) => set('impactShape', e.target.value as Draft['impactShape'])}
            >
              {SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <div className="row2">
            {(draft.impactShape === 'disc' || draft.impactShape === 'cone') && (
              <Num
                label="radius"
                value={draft.impactRadius}
                onChange={(v) => set('impactRadius', v)}
              />
            )}
            {(draft.impactShape === 'line' || draft.impactShape === 'rect') && (
              <Num
                label="length"
                value={draft.impactLength}
                onChange={(v) => set('impactLength', v)}
              />
            )}
            {draft.impactShape === 'rect' && (
              <Num
                label="width"
                value={draft.impactWidth}
                onChange={(v) => set('impactWidth', v)}
              />
            )}
            {draft.impactShape === 'cone' && (
              <Num
                label="half angle"
                value={draft.impactAngle}
                onChange={(v) => set('impactAngle', v)}
              />
            )}
          </div>
          <label className="field">
            <input
              type="checkbox"
              style={{ width: 'auto', marginRight: 6 }}
              checked={draft.transferKinetic}
              onChange={(e) => set('transferKinetic', e.target.checked)}
            />
            transferKinetic
          </label>
          <label className="field">
            <input
              type="checkbox"
              style={{ width: 'auto', marginRight: 6 }}
              checked={draft.useTemp}
              onChange={(e) => set('useTemp', e.target.checked)}
            />
            addTemperature
          </label>
          {draft.useTemp && (
            <div className="row2">
              <Num
                label="min"
                value={draft.tempMin}
                onChange={(v) => set('tempMin', v)}
                step={100}
              />
              <Num
                label="max"
                value={draft.tempMax}
                onChange={(v) => set('tempMax', v)}
                step={100}
              />
            </div>
          )}
          <label className="field">
            <input
              type="checkbox"
              style={{ width: 'auto', marginRight: 6 }}
              checked={draft.useBind}
              onChange={(e) => set('useBind', e.target.checked)}
            />
            setBinding
          </label>
          {draft.useBind && (
            <div className="row2">
              <Num label="min" value={draft.bindMin} onChange={(v) => set('bindMin', v)} />
              <Num label="max" value={draft.bindMax} onChange={(v) => set('bindMax', v)} />
            </div>
          )}

          <h3 style={{ marginTop: 14 }}>Test cast</h3>
          <div className="row2">
            <Num
              label="mass (g)"
              value={draft.testMass}
              onChange={(v) => set('testMass', v)}
              step={100}
            />
            <Num label="speed" value={draft.testSpeed} onChange={(v) => set('testSpeed', v)} />
          </div>
          {draft.useTemp && (
            <Num
              label="addTemperature value"
              value={draft.testTemp}
              onChange={(v) => set('testTemp', v)}
              step={100}
            />
          )}
          {draft.useBind && (
            <Num
              label="setBinding value"
              value={draft.testBind}
              onChange={(v) => set('testBind', v)}
            />
          )}
          <Num
            label="target distance (cells)"
            value={targetDistance}
            onChange={setTargetDistance}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={() => setPinned(draft)}>pin for comparison</button>
            {pinned && <button onClick={() => setPinned(null)}>clear</button>}
          </div>
        </div>

        <div>
          <Analysis a={analysis} b={pinnedAnalysis} />
        </div>
      </div>
    </div>
  );
}

interface Analysed {
  draft: Draft;
  template: SpellTemplate;
  pages: number;
  errors: readonly string[];
  bodyCells: number;
  impactCells: number;
  cost: { min: number; typical: number; max: number };
  breakdown: { manifest: number; impulse: number; heat: number; bind: number; total: number };
  reach: number;
  centreDamageMilli: number;
  sandbox: SandboxResult;
}

function analyse(d: Draft, targetDistance: number): Analysed {
  const template = templateOf(d);
  const check = checkSpellbook([template], RULES);
  const bodyShape = shapeOf(d.bodyShape, {
    length: d.bodyLength,
    radius: d.bodyRadius,
    width: d.bodyWidth,
    angle: d.bodyAngle,
  });
  const impactShape = shapeOf(d.impactShape, {
    length: d.impactLength,
    radius: d.impactRadius,
    width: d.impactWidth,
    angle: d.impactAngle,
  });
  const bodyCells = shapeCellCount(bodyShape);
  const impactCells = shapeCellCount(impactShape);

  const at = (
    massG: number,
    speed: number,
    temp: number,
    bind: number,
  ): ReturnType<typeof costOfCast> =>
    costOfCast(
      {
        bodyMassG: massG,
        bodyMaterial: d.material,
        bodyCells,
        speedMilliCellsPerTurn: speed * 1000,
        impactCells,
        impactOps: [
          ...(d.transferKinetic ? [{ op: 'transferKinetic' as const, value: 0 }] : []),
          ...(d.useTemp ? [{ op: 'addTemperature' as const, value: temp }] : []),
          ...(d.useBind ? [{ op: 'setBinding' as const, value: bind }] : []),
        ],
      },
      RULES,
    );

  const worst = (lo: number, hi: number): number => (Math.abs(lo) > Math.abs(hi) ? lo : hi);
  const min = at(Math.max(RULES.physics.minBodyMassG, d.massMin), d.speedMin, 0, 0).total;
  const max = at(
    Math.max(RULES.physics.minBodyMassG, d.massMax),
    d.speedMax,
    worst(d.tempMin, d.tempMax),
    worst(d.bindMin, d.bindMax),
  ).total;
  const breakdown = at(d.testMass, d.testSpeed, d.testTemp, d.testBind);

  const energy = keMilliJ(d.testMass, d.testSpeed * 1000);

  return {
    draft: d,
    template,
    pages: check.ok ? check.pagesUsed : pagesForSpell(template, RULES).pages,
    errors: check.errors,
    bodyCells,
    impactCells,
    cost: { min, typical: breakdown.total, max },
    breakdown,
    reach: reachOfSpeed(d.testSpeed, RULES),
    centreDamageMilli: impactDamageMilliHp(energy, impactCells, impactCells, RULES),
    sandbox: runSandbox(template, d, targetDistance),
  };
}

function Analysis({ a, b }: { a: Analysed; b: Analysed | null }): React.JSX.Element {
  const budget = RULES.spellbook.maxPages;
  return (
    <>
      {a.errors.length > 0 && (
        <div className="card" style={{ borderColor: '#7a2b2b', marginBottom: 14 }}>
          <h3>this spell would be rejected</h3>
          {a.errors.map((e, i) => (
            <div key={i} className="mono" style={{ fontSize: 12 }}>
              {e}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>cost of the test cast</h3>
        <table>
          <tbody>
            <tr>
              <td className="dim">manifest — mass × materialCost</td>
              <td className="num">{mana(a.breakdown.manifest)}</td>
              {b && <td className="num faint">{mana(b.breakdown.manifest)}</td>}
            </tr>
            <tr>
              <td className="dim">impulse — k × ½mv²</td>
              <td className="num">{mana(a.breakdown.impulse)}</td>
              {b && <td className="num faint">{mana(b.breakdown.impulse)}</td>}
            </tr>
            <tr>
              <td className="dim">heat — k × m·c·ΔT</td>
              <td className="num">{mana(a.breakdown.heat)}</td>
              {b && <td className="num faint">{mana(b.breakdown.heat)}</td>}
            </tr>
            <tr>
              <td className="dim">binding — k × Δb × m</td>
              <td className="num">{mana(a.breakdown.bind)}</td>
              {b && <td className="num faint">{mana(b.breakdown.bind)}</td>}
            </tr>
            <tr>
              <td>total</td>
              <td className="num">{mana(a.breakdown.total)}</td>
              {b && <td className="num faint">{mana(b.breakdown.total)}</td>}
            </tr>
          </tbody>
        </table>
        <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
          across the declared ranges: {mana(a.cost.min)} at the cheapest, {mana(a.cost.max)} at the
          most expensive. A round starts with {RULES.wizard.manaStartMilli / 1000} mana and regains{' '}
          {RULES.wizard.manaRegenMilli / 1000} a turn.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>book space</h3>
        <div className="bar" style={{ height: 10 }}>
          <span
            style={{
              width: `${Math.min(100, (a.pages / budget) * 100)}%`,
              background: a.pages > budget ? 'var(--hot)' : 'var(--a)',
            }}
          />
        </div>
        <div className="mono" style={{ marginTop: 6, fontSize: 12 }}>
          {a.pages} of {budget} pages{b ? ` · pinned ${b.pages}` : ''} · body {a.bodyCells} cells ·
          impact {a.impactCells} cells
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>what it does</h3>
        <table>
          <tbody>
            <tr>
              <td className="dim">reach before drag settles it</td>
              <td className="num">{a.reach.toFixed(1)} cells</td>
              {b && <td className="num faint">{b.reach.toFixed(1)}</td>}
            </tr>
            <tr>
              <td className="dim">damage on a dead-centre hit</td>
              <td className="num">{(a.centreDamageMilli / 1000).toFixed(1)} hp</td>
              {b && <td className="num faint">{(b.centreDamageMilli / 1000).toFixed(1)}</td>}
            </tr>
            <tr>
              <td className="dim">sandbox: reached the dummy</td>
              <td className="num">{a.sandbox.hit ? 'yes' : 'no'}</td>
              {b && <td className="num faint">{b.sandbox.hit ? 'yes' : 'no'}</td>}
            </tr>
            <tr>
              <td className="dim">sandbox: coverage</td>
              <td className="num">
                {a.sandbox.overlap}/{a.sandbox.impactCells || a.impactCells}
              </td>
              {b && (
                <td className="num faint">
                  {b.sandbox.overlap}/{b.sandbox.impactCells || b.impactCells}
                </td>
              )}
            </tr>
            <tr>
              <td className="dim">sandbox: hp taken off</td>
              <td className="num">{(a.sandbox.damageMilli / 1000).toFixed(1)}</td>
              {b && <td className="num faint">{(b.sandbox.damageMilli / 1000).toFixed(1)}</td>}
            </tr>
            <tr>
              <td className="dim">sandbox: travelled</td>
              <td className="num">{a.sandbox.distance} cells</td>
              {b && <td className="num faint">{b.sandbox.distance}</td>}
            </tr>
          </tbody>
        </table>
        {!a.sandbox.hit && a.sandbox.ok && (
          <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
            It fell short or missed. Range is paid as velocity, and impulse is quadratic in it —
            doubling the reach quadruples the mana.
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>sandbox log</h3>
        <div className="eventlog" style={{ maxHeight: 160 }}>
          {a.sandbox.log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>template</h3>
        <pre
          className="mono"
          style={{ fontSize: 11.5, margin: 0, whiteSpace: 'pre-wrap', color: 'var(--ink-dim)' }}
        >
          {JSON.stringify(a.template, null, 2)}
        </pre>
        <button
          style={{ marginTop: 10 }}
          onClick={() => void navigator.clipboard?.writeText(JSON.stringify(a.template, null, 2))}
        >
          copy JSON
        </button>
      </div>
    </>
  );
}
