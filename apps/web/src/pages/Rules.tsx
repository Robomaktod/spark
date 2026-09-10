/**
 * The rules page (web plan §8).
 *
 * The tuning table is read out of the engine's actual constants rather than
 * copy-pasted from the passport, so it cannot drift from what the engine is
 * really doing. If a number here surprises you, the engine is the thing that
 * changed.
 */
import { DEFAULT_RULES, MATERIALS, MATERIAL_IDS } from '@spark/protocol';

const R = DEFAULT_RULES;
const per = (milli: number): string => (milli / 1000).toString();

interface Row {
  name: string;
  value: string;
  test: string;
}

const TUNING: Row[] = [
  { name: 'KE_TO_HP', value: per(R.damage.keToHpMilli), test: 'median time-to-kill of 8–15 turns' },
  {
    name: 'MANA_START',
    value: per(R.wizard.manaStartMilli),
    test: 'a bot can act meaningfully on turn 1',
  },
  {
    name: 'MANA_REGEN',
    value: per(R.wizard.manaRegenMilli),
    test: 'about one knife a turn is sustainable',
  },
  {
    name: 'MANA_CAP',
    value: per(R.wizard.manaCapMilli),
    test: 'discourages hoarding past three turns',
  },
  {
    name: 'MP_PER_TURN',
    value: String(R.wizard.mpPerTurn),
    test: 'crossing the arena takes about 13 turns',
  },
  { name: 'TURN_COST_45', value: String(R.wizard.turnCostPer45), test: 'flanking is meaningful' },
  { name: 'K_IMPULSE', value: per(R.costs.kImpulseMilli), test: 'long shots cost 3–4× short ones' },
  { name: 'K_HEAT', value: per(R.costs.kHeatMilli), test: 'the fireball is the anchor' },
  { name: 'K_BIND', value: per(R.costs.kBindMilli), test: 'wall-breaking takes 3–4 casts' },
  {
    name: 'CONC_MULT',
    value: per(R.costs.concentrationMultMilli),
    test: 'holding beats recasting',
  },
  {
    name: 'DRAG',
    value: `${R.physics.dragPermille / 10}% + ${R.physics.dragFlatMilliCells / 1000} cell`,
    test: 'slow casts visibly fall short',
  },
  {
    name: 'HEAT_DECAY',
    value: `${R.physics.heatDecayPermille / 10}%/turn`,
    test: 'burn zones last 3–4 turns',
  },
  { name: 'TURN_CAP', value: String(R.match.turnCap), test: 'under 15% of rounds reach it' },
  {
    name: 'BOOK_PAGES',
    value: String(R.spellbook.maxPages),
    test: '3 flexible ≈ 8 rigid in winrate',
  },
  {
    name: 'FLIGHT_ALT',
    value: `${R.arena.flightAltitudeMm} mm`,
    test: 'cover matters but is not absolute',
  },
];

export function Rules(): React.JSX.Element {
  return (
    <div className="page">
      <div className="page-narrow">
        <h1>Rules</h1>
        <p className="dim" style={{ marginTop: 0 }}>
          Every number on this page is read from the engine that runs matches, not transcribed from
          the design document. The engine publishes all of it to both bots in the <code>init</code>{' '}
          packet, so nothing here is hidden from a player willing to read.
        </p>

        <h2>Tuning table</h2>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>constant</th>
                <th className="num">value</th>
                <th>what it is tuned against</th>
              </tr>
            </thead>
            <tbody>
              {TUNING.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="num">{r.value}</td>
                  <td className="dim">{r.test}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2>Materials</h2>
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>material</th>
                <th className="num">density g/L</th>
                <th className="num">specific heat</th>
                <th className="num">binding</th>
                <th className="num">melt °C</th>
                <th className="num">mana/kg</th>
                <th className="num">settles at</th>
              </tr>
            </thead>
            <tbody>
              {MATERIAL_IDS.map((id) => {
                const m = MATERIALS[id];
                return (
                  <tr key={id}>
                    <td>{id}</td>
                    <td className="num">{m.densityGPerCell}</td>
                    <td className="num">{m.specificHeatMilli / 1000}</td>
                    <td className="num">{m.defaultBinding}</td>
                    <td className="num">{m.meltMilliC === null ? '—' : m.meltMilliC / 1000}</td>
                    <td className="num">{m.manifestCostMilliManaPerKg / 1000}</td>
                    <td className="num">{m.settledHeightMm} mm</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <h2>The cost model</h2>
        <div className="card">
          <table>
            <tbody>
              <tr>
                <td>manifest</td>
                <td className="mono">mass_kg × materialCost</td>
              </tr>
              <tr>
                <td>impulse</td>
                <td className="mono">{per(R.costs.kImpulseMilli)} × ½ × mass_kg × v²</td>
              </tr>
              <tr>
                <td>temperature</td>
                <td className="mono">{per(R.costs.kHeatMilli)} × mass_kg × specificHeat × ΔT</td>
              </tr>
              <tr>
                <td>binding</td>
                <td className="mono">{per(R.costs.kBindMilli)} × Δbinding × mass_kg</td>
              </tr>
            </tbody>
          </table>
          <p className="dim" style={{ fontSize: 12.5, marginBottom: 0 }}>
            There is no distance multiplier. A spell manifests at the wand and has to be thrown, and
            because impulse is quadratic in velocity, doubling the range you can reach quadruples
            the mana. An underpowered cast falls short and drops as inert matter.
          </p>
        </div>

        <h2>Damage</h2>
        <div className="card">
          <p className="mono" style={{ marginTop: 0 }}>
            HP loss = KE × {per(R.damage.keToHpMilli)} × (overlapCells / impactShapeCells)
          </p>
          <p className="dim" style={{ fontSize: 12.5 }}>
            The coverage term is what makes aiming a skill: a knife clipping 3 of the wizard's{' '}
            {(R.wizard.footprintRadius * 2 + 1) ** 2} cells does a fraction of a centre hit. Turn on
            the Coverage overlay in the viewer to see which cells landed.
          </p>
          <p className="mono" style={{ marginBottom: 0 }}>
            burn = (T − {R.damage.burnThresholdMilliC / 1000}) / {R.damage.burnDivisorMilliC / 1000}{' '}
            HP per turn
          </p>
        </div>

        <h2>Limits</h2>
        <div className="card">
          <table>
            <tbody>
              <tr>
                <td>turn wall-clock</td>
                <td className="num">{R.limits.turnMs} ms</td>
              </tr>
              <tr>
                <td>startup budget</td>
                <td className="num">{R.limits.startupMs} ms</td>
              </tr>
              <tr>
                <td>memory</td>
                <td className="num">{R.limits.memoryMb} MB</td>
              </tr>
              <tr>
                <td>arena</td>
                <td className="num">
                  {R.arena.width} × {R.arena.height} cells
                </td>
              </tr>
              <tr>
                <td>match</td>
                <td className="num">
                  {R.match.games} games × {R.match.roundsPerGame} rounds
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
