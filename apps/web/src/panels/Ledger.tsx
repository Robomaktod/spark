/**
 * The right panel (web plan §5.3).
 *
 * Every number here matches a formula in passport §9, which is the point: a
 * player who thinks the engine mispriced their spell can check the arithmetic
 * against their own rather than taking the total on faith.
 */
import type { Side } from '@spark/protocol';
import type { EngineEvent } from '@spark/engine';
import { concentrationUpkeepMilliMana, describeEvent } from '@spark/engine';
import type { Frame, ReplayFile } from '@spark/replay';

const mana = (milli: number): string => (milli / 1000).toFixed(2);
const hp = (milli: number): string => (milli / 1000).toFixed(1);
const joules = (milli: number): string => (milli / 1000).toFixed(1);

interface TurnLedger {
  upkeep: { objectId: number; milli: number }[];
  casts: {
    spellId: string;
    total: number;
    manifest: number;
    impulse: number;
    heat: number;
    bind: number;
  }[];
  channels: { objectId: number; kind: string; milli: number }[];
  refunds: number;
  regen: number;
  spend: number;
}

function ledgerFor(events: readonly EngineEvent[], side: Side): TurnLedger {
  const l: TurnLedger = { upkeep: [], casts: [], channels: [], refunds: 0, regen: 0, spend: 0 };
  for (const e of events) {
    switch (e.t) {
      case 'concentration_upkeep':
        if (e.side !== side) break;
        l.upkeep.push({ objectId: e.objectId, milli: e.upkeepMilli });
        l.spend += e.upkeepMilli;
        break;
      case 'cast':
        if (e.side !== side) break;
        l.casts.push({
          spellId: e.spellId,
          total: e.costMilli,
          manifest: e.breakdown.manifest,
          impulse: e.breakdown.impulse,
          heat: e.breakdown.heat,
          bind: e.breakdown.bind,
        });
        l.spend += e.costMilli;
        break;
      case 'channel':
        if (e.side !== side) break;
        l.channels.push({ objectId: e.objectId, kind: e.kind, milli: e.costMilli });
        l.spend += e.costMilli;
        break;
      case 'react_refund':
        if (e.side !== side) break;
        l.refunds += e.refundMilli;
        break;
      case 'regen':
        if (e.side !== side) break;
        l.regen += e.amountMilli;
        break;
      default:
        break;
    }
  }
  return l;
}

function SideLedger({ frame, side, name }: { frame: Frame; side: Side; name: string }): React.JSX.Element {
  const wizard = frame.round.wizards[side];
  const l = ledgerFor(frame.events, side);
  const closing = wizard.manaMilli;
  // Opening balance is reconstructed rather than stored: closing minus what
  // came in, plus what went out. If it disagrees with the player's own sum,
  // one of the two is wrong and that is worth knowing.
  const opening = closing - l.regen + l.spend;
  const held = frame.round.objects.filter((o) => !o.destroyed && o.concentrated && o.owner === side);

  return (
    <div style={{ marginBottom: 18 }}>
      <h3 className={side === 'A' ? 'sideA' : 'sideB'}>
        {side} · {name}
      </h3>
      <div className="bars" style={{ marginBottom: 8 }}>
        <div className="bar">
          <span
            style={{
              width: `${Math.max(0, (wizard.hpMilli / frame.round.rules.wizard.hpMilli) * 100)}%`,
              background: 'var(--good)',
            }}
          />
        </div>
        <div className="bar">
          <span
            style={{
              width: `${Math.max(0, (wizard.manaMilli / frame.round.rules.wizard.manaCapMilli) * 100)}%`,
              background: 'var(--a)',
            }}
          />
        </div>
      </div>
      <table>
        <tbody>
          <tr>
            <td className="dim">hp</td>
            <td className="num">{hp(wizard.hpMilli)}</td>
          </tr>
          <tr>
            <td className="dim">mp left</td>
            <td className="num">{wizard.mp}</td>
          </tr>
          <tr>
            <td className="dim">opening mana</td>
            <td className="num">{mana(opening)}</td>
          </tr>
          {l.upkeep.map((u) => (
            <tr key={`u${u.objectId}`}>
              <td className="faint">− upkeep #{u.objectId}</td>
              <td className="num">{mana(u.milli)}</td>
            </tr>
          ))}
          {l.casts.map((c, i) => (
            <tr key={`c${i}`}>
              <td className="faint">− cast {c.spellId}</td>
              <td className="num">{mana(c.total)}</td>
            </tr>
          ))}
          {l.channels.map((c, i) => (
            <tr key={`h${i}`}>
              <td className="faint">− channel {c.kind}</td>
              <td className="num">{mana(c.milli)}</td>
            </tr>
          ))}
          {l.refunds > 0 && (
            <tr>
              <td className="faint">+ reaction refund</td>
              <td className="num">{mana(l.refunds)}</td>
            </tr>
          )}
          <tr>
            <td className="faint">+ regen</td>
            <td className="num">{mana(l.regen)}</td>
          </tr>
          <tr>
            <td className="dim">closing mana</td>
            <td className="num">{mana(closing)}</td>
          </tr>
          {wizard.reservedMilli > 0 && (
            <tr>
              <td className="dim">reserved by react</td>
              <td className="num">{mana(wizard.reservedMilli)}</td>
            </tr>
          )}
        </tbody>
      </table>

      {l.casts.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>cost by term</h3>
          <table>
            <thead>
              <tr>
                <th>spell</th>
                <th className="num">manifest</th>
                <th className="num">impulse</th>
                <th className="num">heat</th>
                <th className="num">bind</th>
              </tr>
            </thead>
            <tbody>
              {l.casts.map((c, i) => (
                <tr key={i}>
                  <td>{c.spellId}</td>
                  <td className="num">{mana(c.manifest)}</td>
                  <td className="num">{mana(c.impulse)}</td>
                  <td className="num">{mana(c.heat)}</td>
                  <td className="num">{mana(c.bind)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {held.length > 0 && (
        <>
          <h3 style={{ marginTop: 12 }}>concentrations</h3>
          <table>
            <thead>
              <tr>
                <th>obj</th>
                <th>material</th>
                <th className="num">temp</th>
                <th className="num">upkeep</th>
              </tr>
            </thead>
            <tbody>
              {held.map((o) => (
                <tr key={o.id}>
                  <td>#{o.id}</td>
                  <td>{o.material}</td>
                  <td className="num">{(o.temperatureMilliC / 1000).toFixed(0)} C</td>
                  <td className="num">
                    {mana(
                      concentrationUpkeepMilliMana(
                        o.massG,
                        o.material,
                        o.temperatureMilliC,
                        frame.round.rules,
                      ),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export function Ledger({ frame, replay }: { frame: Frame; replay: ReplayFile }): React.JSX.Element {
  const damage = frame.events.filter((e) => e.t === 'impact_wizard');
  const stderr = replay.turns[frame.index]?.stderr ?? [];

  return (
    <div style={{ padding: 12 }}>
      <SideLedger frame={frame} side="A" name={replay.bots.A.name} />
      <SideLedger frame={frame} side="B" name={replay.bots.B.name} />

      <h3>damage this turn</h3>
      {damage.length === 0 ? (
        <div className="empty">no hits</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>obj</th>
              <th>target</th>
              <th className="num">KE</th>
              <th className="num">coverage</th>
              <th className="num">hp</th>
            </tr>
          </thead>
          <tbody>
            {damage.map((e, i) =>
              e.t === 'impact_wizard' ? (
                <tr key={i}>
                  <td>#{e.objectId}</td>
                  <td className={e.target === 'A' ? 'sideA' : 'sideB'}>{e.target}</td>
                  <td className="num">{joules(e.keMilliJ)} J</td>
                  <td className="num">
                    {e.overlap}/{e.impactCells}
                  </td>
                  <td className="num">−{hp(e.damageMilli)}</td>
                </tr>
              ) : null,
            )}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: 16 }}>bot stderr</h3>
      {stderr.length === 0 ? (
        <div className="empty">nothing logged</div>
      ) : (
        <div className="eventlog">
          {stderr.map((line, i) => (
            <div key={i} className="faint">
              {line}
            </div>
          ))}
        </div>
      )}

      <h3 style={{ marginTop: 16 }}>this turn</h3>
      <div className="eventlog">
        {frame.events.length === 0 ? (
          <div className="empty">quiet</div>
        ) : (
          frame.events.map((e, i) => <div key={i}>{describeEvent(e)}</div>)
        )}
      </div>
    </div>
  );
}
