/**
 * Publishing to the relay (web plan §3).
 *
 * The CLI is the match runner and stays the source of truth. The web layer can
 * be offline and matches still run — publishing is a side effect, so a failure
 * here is reported and ignored rather than aborting a finished match.
 */
import { WebSocket } from 'ws';
import type { ReplayFile, ReplayTurn } from '@spark/replay';

function withKey(url: string, key: string | undefined): string {
  if (!key) return url;
  return url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
}

/** POSTs a finished replay. Returns the id it was stored under, or null. */
export async function publishReplay(
  baseUrl: string,
  replay: ReplayFile,
  key?: string,
): Promise<string | null> {
  const url = withKey(new URL('/api/replays', baseUrl).toString(), key);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(replay),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return replay.id;
}

/**
 * A live producer socket. Streams the header, then each turn as it completes,
 * then the finished replay so the live link becomes a permanent one.
 */
export class LivePublisher {
  private socket: WebSocket | null = null;
  private ready: Promise<void>;

  constructor(
    baseUrl: string,
    private readonly matchId: string,
    key?: string,
  ) {
    const base = new URL(baseUrl);
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    base.pathname = '/live';
    const url = withKey(base.toString() + `?produce=${encodeURIComponent(matchId)}`, key);
    const socket = new WebSocket(url);
    this.socket = socket;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      socket.once('open', () => resolveReady());
      socket.once('error', (err) => rejectReady(err));
    });
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  async header(replay: ReplayFile): Promise<void> {
    await this.ready;
    this.send({ type: 'header', replay });
  }

  turn(turn: ReplayTurn): void {
    this.send({ type: 'turn', turn });
  }

  end(replay: ReplayFile): void {
    this.send({ type: 'end', replay });
    this.socket?.close();
    this.socket = null;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  get matchIdentifier(): string {
    return this.matchId;
  }
}
