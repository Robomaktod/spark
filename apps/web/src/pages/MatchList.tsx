/**
 * The match list (web plan §8): live matches at the top, recent replays below.
 * No ranking, no matchmaking, no upload form — the CLI is the match runner.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ReplaySummary } from '@spark/replay';
import { listLive, listReplays, type LiveSummary } from '../state/api.js';

function scoreLine(s: ReplaySummary): string {
  const r = s.result;
  const who = r.winner ? `${r.winner} wins` : 'draw';
  return `${r.scores.A} – ${r.scores.B}  ${who}${r.tiebreak === 'mana' ? ' (mana)' : ''}`;
}

export function MatchList(): React.JSX.Element {
  const [replays, setReplays] = useState<ReplaySummary[] | null>(null);
  const [live, setLive] = useState<LiveSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void listReplays()
        .then((r) => alive && setReplays(r))
        .catch((e: Error) => alive && setError(e.message));
      void listLive()
        .then((l) => alive && setLive(l))
        .catch(() => {
          /* the relay may not be running; replays still work */
        });
    };
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="page">
      <div className="page-narrow">
        <h1>Matches</h1>
        <p className="dim" style={{ marginTop: 0 }}>
          Matches run on the CLI. This page shows what it has published.
        </p>

        {live.length > 0 && (
          <>
            <h2>Live</h2>
            <div className="card">
              <table>
                <tbody>
                  {live.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <span className="pill live">LIVE</span>
                      </td>
                      <td>
                        <Link to={`/match/${m.id}?live=1`}>
                          <span className="sideA">{m.bots.A}</span> vs{' '}
                          <span className="sideB">{m.bots.B}</span>
                        </Link>
                      </td>
                      <td className="dim">seed {m.seed}</td>
                      <td className="num dim">{m.turnCount} turns</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <h2>Replays</h2>
        {error && (
          <div className="card" style={{ borderColor: '#7a2b2b' }}>
            <div className="dim">Could not reach the relay: {error}</div>
            <div className="faint" style={{ marginTop: 6 }}>
              Run <code>spark run --publish http://localhost:3000</code> to send it one.
            </div>
          </div>
        )}
        {!error && replays === null && <div className="empty">loading…</div>}
        {replays !== null && replays.length === 0 && (
          <div className="empty">
            Nothing published yet. Run a match with <code>--publish</code>.
          </div>
        )}
        {replays !== null && replays.length > 0 && (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>bots</th>
                  <th>score</th>
                  <th>seed</th>
                  <th className="num">turns</th>
                  <th>finished</th>
                </tr>
              </thead>
              <tbody>
                {replays.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/match/${s.id}`}>
                        <span className="sideA">{s.bots.A}</span> vs{' '}
                        <span className="sideB">{s.bots.B}</span>
                      </Link>
                    </td>
                    <td>{scoreLine(s)}</td>
                    <td className="dim">{s.seed}</td>
                    <td className="num">{s.turnCount}</td>
                    <td className="dim">{new Date(s.finishedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
