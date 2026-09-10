/**
 * The scrubber (web plan §5.4).
 *
 * HP and mana sparklines with red markers on the turns where damage landed, so
 * a player jumps straight to the turn that went wrong instead of watching the
 * whole match linearly.
 */
import { useMemo } from 'react';
import type { ReplayFile } from '@spark/replay';
import { useViewer } from '../state/viewer.js';

interface Series {
  hpA: number[];
  hpB: number[];
  manaA: number[];
  manaB: number[];
  damageAt: number[];
}

/**
 * Reconstructs the shape of the match from the event log alone, without
 * simulating: the log already records every hit, cast and regen.
 */
function seriesFor(replay: ReplayFile): Series {
  const rules = replay.rules;
  const hp = { A: rules.wizard.hpMilli, B: rules.wizard.hpMilli };
  const mana = { A: rules.wizard.manaStartMilli, B: rules.wizard.manaStartMilli };
  const out: Series = { hpA: [], hpB: [], manaA: [], manaB: [], damageAt: [] };
  let round = 0;

  replay.turns.forEach((t, i) => {
    if (t.round !== round) {
      round = t.round;
      hp.A = rules.wizard.hpMilli;
      hp.B = rules.wizard.hpMilli;
      mana.A = rules.wizard.manaStartMilli;
      mana.B = rules.wizard.manaStartMilli;
    }
    let hurt = false;
    for (const e of t.events) {
      switch (e.t) {
        case 'impact_wizard':
          hp[e.target] -= e.damageMilli;
          if (e.damageMilli > 0) hurt = true;
          break;
        case 'burn':
        case 'push':
          hp[e.side] -= e.damageMilli;
          if (e.damageMilli > 0) hurt = true;
          break;
        case 'cast':
          mana[e.side] -= e.costMilli;
          break;
        case 'channel':
          mana[e.side] -= e.costMilli;
          break;
        case 'concentration_upkeep':
          mana[e.side] -= e.upkeepMilli;
          break;
        case 'regen':
          mana[e.side] += e.amountMilli;
          break;
        default:
          break;
      }
    }
    out.hpA.push(Math.max(0, hp.A));
    out.hpB.push(Math.max(0, hp.B));
    out.manaA.push(Math.max(0, mana.A));
    out.manaB.push(Math.max(0, mana.B));
    if (hurt) out.damageAt.push(i);
  });
  return out;
}

function Spark({
  a,
  b,
  max,
  markers,
  count,
  index,
}: {
  a: number[];
  b: number[];
  max: number;
  markers: number[];
  count: number;
  index: number;
}): React.JSX.Element {
  const path = (values: number[]): string =>
    values
      .map((v, i) => `${(i / Math.max(1, count - 1)) * 100},${34 - (v / max) * 32}`)
      .map((p, i) => (i === 0 ? `M${p}` : `L${p}`))
      .join(' ');
  return (
    <svg className="spark" viewBox={`0 0 100 34`} preserveAspectRatio="none">
      {markers.map((m) => (
        <line
          key={m}
          x1={(m / Math.max(1, count - 1)) * 100}
          x2={(m / Math.max(1, count - 1)) * 100}
          y1={0}
          y2={34}
          stroke="#8e3535"
          strokeWidth={0.35}
          opacity={0.55}
        />
      ))}
      <path
        d={path(a)}
        fill="none"
        stroke="var(--a)"
        strokeWidth={0.9}
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={path(b)}
        fill="none"
        stroke="var(--b)"
        strokeWidth={0.9}
        vectorEffect="non-scaling-stroke"
      />
      {index >= 0 && (
        <line
          x1={(index / Math.max(1, count - 1)) * 100}
          x2={(index / Math.max(1, count - 1)) * 100}
          y1={0}
          y2={34}
          stroke="var(--ink)"
          strokeWidth={0.6}
        />
      )}
    </svg>
  );
}

export function Scrubber({ replay }: { replay: ReplayFile }): React.JSX.Element {
  const index = useViewer((s) => s.index);
  const playState = useViewer((s) => s.playState);
  const speed = useViewer((s) => s.speed);
  const live = useViewer((s) => s.live);
  const seek = useViewer((s) => s.seek);
  const stepTurn = useViewer((s) => s.stepTurn);
  const setPlayState = useViewer((s) => s.setPlayState);
  const setSpeed = useViewer((s) => s.setSpeed);
  const setSubTurn = useViewer((s) => s.setSubTurn);
  const subTurn = useViewer((s) => s.subTurn);

  const series = useMemo(() => seriesFor(replay), [replay]);
  const rules = replay.rules;
  const count = replay.turns.length;

  return (
    <div className="scrubber">
      <Spark
        a={series.hpA}
        b={series.hpB}
        max={rules.wizard.hpMilli}
        markers={series.damageAt}
        count={count}
        index={index}
      />
      <Spark
        a={series.manaA}
        b={series.manaB}
        max={rules.wizard.manaCapMilli}
        markers={[]}
        count={count}
        index={index}
      />
      <div className="controls" style={{ marginTop: 6 }}>
        <button onClick={() => setPlayState(playState === 'playing' ? 'paused' : 'playing')}>
          {playState === 'playing' ? 'pause' : 'play'}
        </button>
        <button onClick={() => stepTurn(-1)} disabled={index <= 0}>
          ◀ turn
        </button>
        <button onClick={() => stepTurn(1)} disabled={index >= count - 1}>
          turn ▶
        </button>
        {/* Segment stepping is the debugging mode: it walks a collision apart. */}
        <button onClick={() => setSubTurn(subTurn - 125)} title="step back within the turn">
          ◁
        </button>
        <button onClick={() => setSubTurn(subTurn + 125)} title="step forward within the turn">
          ▷
        </button>
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          style={{ width: 78 }}
          aria-label="playback speed"
        >
          {[0.25, 0.5, 1, 2, 4].map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <input
          type="range"
          min={0}
          max={Math.max(0, count - 1)}
          value={Math.max(0, index)}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="turn"
        />
        <span className="mono dim" style={{ minWidth: 92, textAlign: 'right' }}>
          {index + 1} / {count}
        </span>
        {live && <span className="pill live">LIVE</span>}
      </div>
    </div>
  );
}
