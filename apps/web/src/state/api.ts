/**
 * Talking to the relay (web plan §3).
 *
 * The server never runs bot code — it stores finished replays and fans out live
 * turn packets. Access is a single shared secret carried in the URL, because
 * with no accounts there is nothing else to check against (web plan §2).
 */
import type { ReplayFile, ReplaySummary, ReplayTurn } from '@spark/replay';

export function accessToken(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('key');
  if (fromUrl) {
    try {
      window.sessionStorage.setItem('spark.key', fromUrl);
    } catch {
      // Private browsing: the token still works for this page load.
    }
    return fromUrl;
  }
  try {
    return window.sessionStorage.getItem('spark.key') ?? '';
  } catch {
    return '';
  }
}

function withKey(path: string): string {
  const key = accessToken();
  if (!key) return path;
  return path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(withKey(path));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const listReplays = (): Promise<ReplaySummary[]> => getJson('/api/replays');

export const fetchReplay = (id: string): Promise<ReplayFile> => getJson(`/api/replays/${id}`);

export interface LiveSummary {
  readonly id: string;
  readonly bots: { readonly A: string; readonly B: string };
  readonly seed: string;
  readonly turnCount: number;
  readonly startedAt: string;
}

export const listLive = (): Promise<LiveSummary[]> => getJson('/api/live');

/** A live match: the header, then turn packets as the CLI produces them. */
export interface LiveMessage {
  readonly type: 'header' | 'turn' | 'end';
  readonly replay?: ReplayFile;
  readonly turn?: ReplayTurn;
}

/**
 * Watches a live match.
 *
 * `onClosed` fires when the relay drops the socket, which happens both when a
 * match ends normally and when the link was opened a moment too late. The
 * caller decides what to do about it — a finished match is stored under the
 * same id, so falling back to the recorded replay is usually right.
 */
export function openLive(
  id: string,
  onMessage: (msg: LiveMessage) => void,
  onClosed?: (sawAnything: boolean) => void,
): () => void {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${window.location.host}${withKey('/live?watch=' + encodeURIComponent(id))}`;
  let socket: WebSocket | null = new WebSocket(url);
  let closedByUs = false;
  let sawAnything = false;

  socket.onmessage = (ev) => {
    try {
      sawAnything = true;
      onMessage(JSON.parse(String(ev.data)) as LiveMessage);
    } catch {
      // A malformed frame is the relay's problem, not the viewer's.
    }
  };
  socket.onclose = () => {
    if (!closedByUs) onClosed?.(sawAnything);
  };

  return () => {
    closedByUs = true;
    socket?.close();
    socket = null;
  };
}
