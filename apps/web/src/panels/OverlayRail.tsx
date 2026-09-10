/**
 * The overlay rail (web plan §5.2). Each overlay is a toggle and several can be
 * on at once; the defaults are the two that explain most deaths.
 */
import type { Frame } from '@spark/replay';
import { ArenaRenderer, type Overlays } from '../arena/ArenaRenderer.js';
import { useViewer } from '../state/viewer.js';

const OVERLAYS: { key: keyof Overlays; label: string; hint: string }[] = [
  { key: 'heat', label: 'Heat', hint: 'burn zones are invisible otherwise' },
  { key: 'height', label: 'Height', hint: 'what stops a shot vs a wizard' },
  { key: 'trails', label: 'Trails', hint: 'leading and interception' },
  { key: 'coverage', label: 'Coverage', hint: 'this is the damage multiplier' },
  { key: 'mana', label: 'Mana field', hint: 'cost to reach each cell' },
  { key: 'grid', label: 'Grid', hint: 'cell and block boundaries' },
];

export function OverlayRail({ frame }: { frame: Frame | null }): React.JSX.Element {
  const overlays = useViewer((s) => s.overlays);
  const toggle = useViewer((s) => s.toggleOverlay);
  const follow = useViewer((s) => s.follow);
  const setFollow = useViewer((s) => s.setFollow);

  return (
    <div className="rail">
      <h3>Overlays</h3>
      {OVERLAYS.map((o) => (
        <div key={o.key}>
          <label title={o.hint}>
            <input type="checkbox" checked={overlays[o.key]} onChange={() => toggle(o.key)} />
            {o.label}
          </label>
          {o.key === 'mana' && overlays.mana && (
            <div className="faint" style={{ fontSize: 11, marginLeft: 22, lineHeight: 1.45 }}>
              rings every {ArenaRenderer.manaProbe.bandMana} mana for a{' '}
              {ArenaRenderer.manaProbe.massG / 1000} kg {ArenaRenderer.manaProbe.material} shot from
              A's wand; red is out of reach at any speed
            </div>
          )}
        </div>
      ))}

      <h3 style={{ marginTop: 16 }}>Camera</h3>
      <label title="keep both wizards and everything in flight in frame">
        <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
        Follow the action
      </label>
      <div className="faint" style={{ fontSize: 11.5, marginTop: 6, lineHeight: 1.5 }}>
        drag to pan, wheel to zoom
      </div>

      {frame && (
        <>
          <h3 style={{ marginTop: 16 }}>Objects</h3>
          {frame.round.objects.filter((o) => !o.destroyed).length === 0 ? (
            <div className="empty" style={{ padding: '6px 0' }}>
              none in flight
            </div>
          ) : (
            <table>
              <tbody>
                {frame.round.objects
                  .filter((o) => !o.destroyed)
                  .map((o) => (
                    <tr key={o.id}>
                      <td className={o.owner === 'A' ? 'sideA' : 'sideB'}>#{o.id}</td>
                      <td>{o.material}</td>
                      <td className="num">{Math.round(o.speedMilli / 1000)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
