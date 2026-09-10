/**
 * The parity entry point.
 *
 * Bundled alongside the app so the browser-versus-Node determinism test runs
 * the exact engine the viewer ships, not a separately built copy of it.
 */
import { ReplayPlayer, type ReplayFile } from '@spark/replay';

declare global {
  interface Window {
    __sparkParity?: { hashAll: (replay: ReplayFile) => string[] };
  }
}

export function hashAll(replay: ReplayFile): string[] {
  const player = new ReplayPlayer(replay);
  const hashes: string[] = [];
  while (!player.finished) {
    const frame = player.step(false);
    if (!frame) break;
    hashes.push(frame.hash);
  }
  return hashes;
}

// Hung off the window rather than exported: this chunk is an app entry, so the
// bundler is free to drop exports nothing imports.
window.__sparkParity = { hashAll };
