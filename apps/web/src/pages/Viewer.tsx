/**
 * The match viewer (web plan §5). One component for live and replay — a flag
 * switches where the packets come from, because live and replay differ only in
 * that and nothing else should fork.
 */
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { describeEvent } from '@spark/engine';
import { allEvents, type ReplayFile } from '@spark/replay';
import { ArenaView } from '../arena/ArenaView.js';
import { Ledger } from '../panels/Ledger.js';
import { OverlayRail } from '../panels/OverlayRail.js';
import { Scrubber } from '../panels/Scrubber.js';
import { fetchReplay, openLive } from '../state/api.js';
import { useViewer } from '../state/viewer.js';

function EventLog({ replay }: { replay: ReplayFile }): React.JSX.Element {
  const index = useViewer((s) => s.index);
  const seek = useViewer((s) => s.seek);
  const toggle = useViewer((s) => s.toggleOverlay);
  const overlays = useViewer((s) => s.overlays);
  const flat = allEvents(replay);

  // Clicking a line seeks to its turn and turns on the overlay that explains it.
  const onClick = (turnIndex: number, kind: string): void => {
    seek(turnIndex);
    if (kind === 'impact_wizard' && !overlays.coverage) toggle('coverage');
    if (kind === 'burn' && !overlays.heat) toggle('heat');
    if (kind === 'impact_cell' && !overlays.height) toggle('height');
  };

  return (
    <div className="eventlog" style={{ maxHeight: 150 }}>
      {flat.map((e, i) => (
        <div
          key={i}
          className={e.turnIndex === index ? 'now' : ''}
          onClick={() => onClick(e.turnIndex, e.event.t)}
          title={`round ${e.round} turn ${e.turn}`}
        >
          <span className="faint">t{String(e.turn).padStart(2, '0')} </span>
          {describeEvent(e.event)}
        </div>
      ))}
    </div>
  );
}

export function Viewer(): React.JSX.Element {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const isLive = params.get('live') === '1';
  const [status, setStatus] = useState<string>('loading…');
  const [notice, setNotice] = useState<string | null>(null);

  const replay = useViewer((s) => s.replay);
  const frame = useViewer((s) => s.frame);
  const error = useViewer((s) => s.error);
  const load = useViewer((s) => s.load);
  const appendLiveTurn = useViewer((s) => s.appendLiveTurn);

  useEffect(() => {
    let alive = true;

    const loadRecorded = (note?: string): void => {
      void fetchReplay(id)
        .then((r) => {
          if (!alive) return;
          load(r, false);
          setStatus('');
          const partial = r.partial
            ? 'this match was cut short; the turns it did play are below'
            : null;
          if (partial ?? note) setNotice(partial ?? note ?? null);
        })
        .catch((e: Error) => {
          if (!alive) return;
          // A 404 here is the ordinary case, not a crash: the id names a match
          // the relay has never stored. Say what that means instead of showing
          // the status line.
          setStatus(
            /\b404\b/.test(e.message)
              ? 'No match here. Either it was never published, or the relay was restarted — replays live on disk under SPARK_REPLAY_DIR.'
              : `Could not load the replay: ${e.message}`,
          );
        });
    };

    if (isLive) {
      setStatus('connecting to the live relay…');
      const close = openLive(
        id,
        (msg) => {
          if (msg.type === 'header' && msg.replay) {
            load(msg.replay, true);
            setStatus('');
          } else if (msg.type === 'turn' && msg.turn) {
            appendLiveTurn(msg.turn);
          } else if (msg.type === 'end') {
            useViewer.getState().setPlayState('paused');
            setNotice('the match has finished');
          }
        },
        (sawAnything) => {
          if (!alive) return;
          // A finished match is stored under the same id, so a link opened a
          // moment too late lands on the recording rather than on nothing.
          loadRecorded(
            sawAnything
              ? 'the match finished; showing the recording'
              : 'that match has already finished',
          );
        },
      );
      return () => {
        alive = false;
        close();
      };
    }

    loadRecorded();
    return () => {
      alive = false;
    };
  }, [id, isLive, load, appendLiveTurn]);

  if (!replay || !frame) {
    return (
      <div className="page">
        <div className="page-narrow">
          <div className="empty">{status || 'waiting for the first turn…'}</div>
          <a href="/">back to the match list</a>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer">
      <OverlayRail frame={frame} />
      <ArenaView rules={replay.rules} />
      <div className="ledger">
        {notice && (
          <div className="card" style={{ marginBottom: 12 }}>
            <span className="dim">{notice}</span>
          </div>
        )}
        {error && (
          <div className="card" style={{ marginBottom: 12, borderColor: '#7a2b2b' }}>
            {error}
          </div>
        )}
        <Ledger frame={frame} replay={replay} />
        <h3>event log</h3>
        <EventLog replay={replay} />
      </div>
      <Scrubber replay={replay} />
    </div>
  );
}
