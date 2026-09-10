/**
 * Swept-path recording.
 *
 * Web plan §6 and §10.1: the physics step already resolves collisions at
 * fractional times within a turn, but the turn packet only reports where an
 * object ended up. For smooth playback the viewer needs the shape of the
 * journey — the straight runs and the moments the velocity changed — so it can
 * interpolate between them instead of teleporting objects once per turn.
 *
 * Units follow passport §13: positions in milli-cells, times in milli-turns
 * (0..1000). The web plan's example writes times as decimals; integers are
 * used here because no float may cross the replay boundary either. See
 * docs/DECISIONS.md, D11.
 */
import type { MaterialId } from '@spark/protocol';

/** Why a straight run ended. Absent means it was still going at the turn's end. */
export type SegmentEnd =
  | 'penetrated'
  | 'stopped'
  | 'wizard'
  | 'collision'
  | 'boundary'
  | 'channelled';

export interface PathSegment {
  /** Start position in milli-cells. */
  readonly from: readonly [number, number];
  /** End position in milli-cells. */
  readonly to: readonly [number, number];
  /** Fraction of the turn at which the run began, in milli-turns. */
  readonly t0: number;
  /** Fraction of the turn at which it ended, in milli-turns. */
  readonly t1: number;
  readonly end?: SegmentEnd;
}

export interface ObjectPath {
  readonly objectId: number;
  readonly owner: 'A' | 'B';
  readonly material: MaterialId;
  readonly spellId: string;
  /** Body footprint relative to the object centre, for drawing the swept shape. */
  readonly cells: readonly (readonly [number, number])[];
  readonly segments: readonly PathSegment[];
}

/**
 * Accumulates the segments of one physics step. One instance per turn; the
 * physics step opens a run for every moving object and closes it whenever the
 * object's velocity changes or its journey ends.
 */
export class PathRecorder {
  private readonly open = new Map<number, { fromX: number; fromY: number; t0: number }>();
  private readonly done = new Map<number, PathSegment[]>();
  private readonly meta = new Map<number, Omit<ObjectPath, 'segments'>>();

  begin(
    id: number,
    meta: Omit<ObjectPath, 'segments'>,
    x: number,
    y: number,
    tMilliTurns: number,
  ): void {
    this.meta.set(id, meta);
    this.open.set(id, { fromX: x, fromY: y, t0: tMilliTurns });
  }

  /** Closes the current run and, unless `end` is given, opens the next one. */
  cut(id: number, x: number, y: number, tMilliTurns: number, end?: SegmentEnd): void {
    const run = this.open.get(id);
    if (!run) return;
    const segments = this.done.get(id) ?? [];
    // A run that covered no ground and no time carries no information.
    if (run.fromX !== x || run.fromY !== y || run.t0 !== tMilliTurns) {
      segments.push({
        from: [run.fromX, run.fromY],
        to: [x, y],
        t0: run.t0,
        t1: tMilliTurns,
        ...(end ? { end } : {}),
      });
      this.done.set(id, segments);
    } else if (end) {
      segments.push({ from: [run.fromX, run.fromY], to: [x, y], t0: run.t0, t1: tMilliTurns, end });
      this.done.set(id, segments);
    }
    if (end) this.open.delete(id);
    else this.open.set(id, { fromX: x, fromY: y, t0: tMilliTurns });
  }

  /** Closes every run still open, at the end of the turn. */
  finish(positionOf: (id: number) => readonly [number, number] | null): ObjectPath[] {
    for (const id of [...this.open.keys()]) {
      const p = positionOf(id);
      if (p) this.cut(id, p[0], p[1], 1000, undefined);
      this.open.delete(id);
    }
    const out: ObjectPath[] = [];
    for (const [id, meta] of [...this.meta.entries()].sort((a, b) => a[0] - b[0])) {
      const segments = this.done.get(id);
      if (!segments || segments.length === 0) continue;
      out.push({ ...meta, segments });
    }
    return out;
  }
}

/** Position of an object at a fraction of a turn, in milli-cells. Linear within a run. */
export function positionAt(path: ObjectPath, tMilliTurns: number): readonly [number, number] | null {
  const segments = path.segments;
  if (segments.length === 0) return null;
  const first = segments[0]!;
  if (tMilliTurns <= first.t0) return first.from;
  for (const s of segments) {
    if (tMilliTurns > s.t1) continue;
    const span = s.t1 - s.t0;
    if (span <= 0) return s.to;
    const k = tMilliTurns - s.t0;
    return [
      s.from[0] + Math.round(((s.to[0] - s.from[0]) * k) / span),
      s.from[1] + Math.round(((s.to[1] - s.from[1]) * k) / span),
    ];
  }
  const last = segments[segments.length - 1]!;
  // An object whose last run ended before the turn did is gone from there on.
  return last.end === undefined ? last.to : null;
}
