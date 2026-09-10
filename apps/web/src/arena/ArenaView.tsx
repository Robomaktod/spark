/**
 * React wrapper around the Pixi renderer.
 *
 * The renderer is a mutable object with its own frame loop; React only mounts
 * it, feeds it the current frame, and handles the pointer. Keeping the two
 * apart is what stops a re-render from rebuilding forty thousand pixels.
 */
import { useEffect, useRef, useState } from 'react';
import type { Rules } from '@spark/protocol';
import { ArenaRenderer } from './ArenaRenderer.js';
import { useViewer } from '../state/viewer.js';

interface Probe {
  x: number;
  y: number;
  mat: string;
  m: number;
  t: number;
  b: number;
  h: number;
}

export function ArenaView({ rules }: { rules: Rules }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ArenaRenderer | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const frame = useViewer((s) => s.frame);
  const overlays = useViewer((s) => s.overlays);
  const follow = useViewer((s) => s.follow);
  const advance = useViewer((s) => s.advance);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const renderer = new ArenaRenderer();
    void renderer.mount(host, rules).then(() => {
      if (cancelled) renderer.destroy();
      else rendererRef.current = renderer;
    });
    return () => {
      cancelled = true;
      rendererRef.current = null;
      renderer.destroy();
    };
  }, [rules]);

  // One animation loop drives both playback and drawing, so interpolation and
  // rendering can never disagree about where in the turn we are.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(80, now - last);
      last = now;
      advance(dt);
      const renderer = rendererRef.current;
      const state = useViewer.getState();
      if (renderer?.ready && state.frame) {
        renderer.draw(
          {
            index: state.frame.index,
            round: state.frame.round,
            paths: state.frame.paths,
            events: state.frame.events,
            dirtyBlocks: state.frame.dirtyBlocks,
          },
          Math.round(state.subTurn),
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [advance]);

  useEffect(() => {
    rendererRef.current?.setOverlays(overlays);
  }, [overlays]);

  useEffect(() => {
    rendererRef.current?.setFollow(follow);
  }, [follow]);

  const onWheel = (e: React.WheelEvent): void => {
    const renderer = rendererRef.current;
    const host = hostRef.current;
    if (!renderer || !host) return;
    const rect = host.getBoundingClientRect();
    renderer.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
    useViewer.getState().setFollow(false);
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    const renderer = rendererRef.current;
    const host = hostRef.current;
    if (!renderer || !host) return;
    if (e.buttons === 1) {
      renderer.panBy(e.movementX, e.movementY);
      useViewer.getState().setFollow(false);
    }
    const rect = host.getBoundingClientRect();
    const cell = renderer.cellAt(e.clientX - rect.left, e.clientY - rect.top);
    const round = useViewer.getState().frame?.round;
    if (!cell || !round) {
      setProbe(null);
      return;
    }
    const view = round.world.cellView(cell[0], cell[1]);
    setProbe({ x: cell[0], y: cell[1], mat: view.mat, m: view.m, t: view.t, b: view.b, h: view.h });
  };

  return (
    <div
      className="stage"
      ref={hostRef}
      onWheel={onWheel}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setProbe(null)}
    >
      {frame && (
        <div className="hud">
          round {frame.roundNumber} · turn {frame.turn} · {frame.side} acted · hash {frame.hash.slice(0, 8)}
        </div>
      )}
      {probe && (
        <div className="cellprobe">
          [{probe.x},{probe.y}] {probe.mat} · {probe.m} g · {(probe.t / 1000).toFixed(1)} C · binding{' '}
          {probe.b} · {probe.h} mm
        </div>
      )}
    </div>
  );
}
